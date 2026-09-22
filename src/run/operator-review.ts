import { basename, join, relative, resolve } from "node:path";

import { withProvenance } from "../artifacts/integrity.js";
import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../artifacts/registry.js";
import type { GateResult, RunArtifact } from "../artifacts/types.js";
import {
  readContextManifest,
  writeContextManifest,
  type ContextManifestEntry,
} from "../context/manifest.js";
import { loadContextPolicy } from "../context/policy.js";
import {
  collectContextRedactionSecrets,
  redactText,
  redactUnknown,
} from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import { outputContract, outputId } from "../flow/schema.js";
import {
  eventStorePath,
  projectRun,
  runDirectoryPath,
  validateRunId,
  type ProjectedRun,
} from "./project.js";
import {
  blockingReviewReason,
  hasManualReviewDecision,
  parseReviewGateVerdict,
} from "./review-verdict.js";
import {
  ensureRunOwnedDirectory,
  writeRunOwnedFileAtomically,
} from "./owned-file.js";

const MAX_OPERATOR_REVIEW_CONTENT_LENGTH = 64 * 1024;

export interface SubmitOperatorReviewInput {
  repoPath: string;
  runId: string;
  actor: string;
  content: string;
  mediaType?: "text/markdown" | "text/plain";
  reviewedArtifactIds: string[];
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

function mergeManifestEntry(
  entries: ContextManifestEntry[],
  entry: ContextManifestEntry,
): ContextManifestEntry[] {
  const key = `${entry.kind}\0${entry.id}`;
  const index = entries.findIndex(
    (candidate) => `${candidate.kind}\0${candidate.id}` === key,
  );
  if (index < 0) return [...entries, entry];
  const merged = [...entries];
  merged[index] = { ...merged[index], ...entry };
  return merged;
}

function latestBlockedAttempt(
  projection: ProjectedRun,
  stageId: string,
): number | undefined {
  return projection.stages
    .find((stage) => stage.stageId === stageId)
    ?.attempts.filter((attempt) => attempt.status === "blocked")
    .at(-1)?.attempt;
}

export function operatorReviewForActiveBlocker(
  projection: ProjectedRun,
): GateResult | undefined {
  const blocker = projection.blocker;
  if (!blocker?.stageId) return undefined;
  const attempt = latestBlockedAttempt(projection, blocker.stageId);
  if (attempt === undefined) return undefined;
  return [...projection.gates].reverse().find(
    (gate) =>
      gate.stageId === blocker.stageId &&
      gate.attempt === attempt &&
      gate.operatorReview?.blocker.stageId === blocker.stageId &&
      gate.operatorReview.blocker.reason === blocker.reason,
  );
}

export async function submitOperatorReview(
  input: SubmitOperatorReviewInput,
): Promise<GateResult> {
  const repoPath = resolve(input.repoPath);
  validateRunId(input.runId);
  const actorInput = input.actor.trim();
  if (!actorInput) throw new Error("operator review actor is required");
  if (actorInput.length > 500 || /[\r\n\0]/.test(actorInput)) {
    throw new Error("operator review actor must be a single line of 500 characters or less");
  }
  const content = input.content.trim();
  if (!content) throw new Error("operator review content is required");
  if (content.length > MAX_OPERATOR_REVIEW_CONTENT_LENGTH) {
    throw new Error(
      `operator review content exceeds ${MAX_OPERATOR_REVIEW_CONTENT_LENGTH} characters`,
    );
  }
  if (!hasManualReviewDecision(content)) {
    throw new Error(
      "operator review must include a recognized pass/fail verdict or P0/P1 finding",
    );
  }
  const reviewedArtifactIds = input.reviewedArtifactIds
    .map((artifactId) => artifactId.trim())
    .filter(Boolean);
  if (reviewedArtifactIds.length === 0) {
    throw new Error("operator review must identify reviewed artifacts");
  }
  if (new Set(reviewedArtifactIds).size !== reviewedArtifactIds.length) {
    throw new Error("operator review contains duplicate reviewed artifact ids");
  }
  const mediaType = input.mediaType ?? "text/markdown";
  if (mediaType !== "text/markdown" && mediaType !== "text/plain") {
    throw new Error(
      "operator review mediaType must be text/markdown or text/plain",
    );
  }

  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(input.runId);
    if (events.length === 0) throw new Error(`run not found: ${input.runId}`);
    const projection = projectRun(events);
    const blocker = projection.blocker;
    if (
      projection.status !== "blocked" ||
      !blocker?.stageId ||
      (blocker.reason !== "agent_usage_limit" &&
        blocker.reason !== "agent_runtime_unavailable")
    ) {
      throw new Error(
        "operator review requires an active agent runtime blocker on a review gate",
      );
    }
    if (operatorReviewForActiveBlocker(projection)) {
      throw new Error(
        `operator review already submitted for blocked stage ${blocker.stageId}`,
      );
    }

    const loaded =
      projection.flowDocument !== undefined
        ? parseFlowDocument(projection.flowDocument, {
            externalInputs: Object.keys(projection.inputs ?? {}),
          })
        : projection.flowPath
          ? await loadFlow(projection.flowPath, {
              externalInputs: Object.keys(projection.inputs ?? {}),
            })
          : undefined;
    if (!loaded) throw new Error(`run is missing flow document: ${input.runId}`);
    const stage = loaded.flow.spec.stages.find(
      (candidate) => candidate.id === blocker.stageId,
    );
    if (!stage || stage.type !== "gate" || stage.mode !== "review") {
      throw new Error(`blocked stage is not a review gate: ${blocker.stageId}`);
    }
    if (!sameStringSet(reviewedArtifactIds, stage.inputs)) {
      throw new Error(
        `reviewed artifacts must exactly match review gate inputs: ${stage.inputs.join(", ")}`,
      );
    }
    const attempt = latestBlockedAttempt(projection, stage.id);
    if (attempt === undefined) {
      throw new Error(`review gate has no blocked attempt: ${stage.id}`);
    }

    const policy = await loadContextPolicy(repoPath);
    const redactionSecrets = collectContextRedactionSecrets({ policy });
    const actor = redactText(actorInput, redactionSecrets) ?? "";
    const redactedContent = redactText(content, redactionSecrets) ?? "";
    const submittedAt = new Date().toISOString();
    const runDirectory = runDirectoryPath(repoPath, input.runId);
    const attemptDirectory = join(
      runDirectory,
      "stages",
      stage.id,
      String(attempt),
    );
    await ensureRunOwnedDirectory({
      runDirectory: repoPath,
      path: relative(repoPath, attemptDirectory),
      subject: "operator review attempt directory",
    });
    const extension = mediaType === "text/plain" ? "txt" : "md";
    const reviewPath = join(attemptDirectory, `operator-review.${extension}`);
    const reviewRelativePath = relative(runDirectory, reviewPath).replaceAll(
      "\\",
      "/",
    );
    await writeRunOwnedFileAtomically({
      runDirectory: repoPath,
      path: relative(repoPath, reviewPath),
      subject: "operator review path",
      content: `${redactedContent}\n`,
    });

    const output = stage.outputs[0];
    if (!output) {
      throw new Error(`review gate has no declared output: ${stage.id}`);
    }
    const gateId = outputId(output);
    const blockingReason = blockingReviewReason(redactedContent);
    const verdict = parseReviewGateVerdict(redactedContent);
    const blockerSnapshot = redactUnknown(
      {
        reason: blocker.reason,
        stageId: blocker.stageId,
        ...(blocker.runtime ? { runtime: blocker.runtime } : {}),
        ...(blocker.message ? { message: blocker.message } : {}),
        ...(blocker.retryAfter ? { retryAfter: blocker.retryAfter } : {}),
      },
      redactionSecrets,
    ) as NonNullable<GateResult["operatorReview"]>["blocker"];
    const gateResult: GateResult = {
      id: gateId,
      stageId: stage.id,
      name: stage.name,
      mode: "review",
      status: blockingReason ? "failed" : "passed",
      runtime: "operator",
      reviewedArtifacts: [...stage.inputs],
      reviewOutput: {
        id: gateId,
        path: reviewRelativePath,
        filename: basename(reviewPath),
        mediaType,
        content: redactedContent,
        truncated: false,
        ...(verdict ? { verdict } : {}),
      },
      operatorReview: {
        actor,
        submittedAt,
        reviewedArtifactIds: [...stage.inputs],
        blocker: blockerSnapshot,
      },
      ...(blockingReason
        ? {
            reason: `operator review reported ${blockingReason} in ${reviewRelativePath}`,
          }
        : {}),
      attempt,
      createdAt: submittedAt,
    };

    const gateResultPath = join(attemptDirectory, `${gateId}.json`);
    const gateResultRelativePath = relative(
      runDirectory,
      gateResultPath,
    ).replaceAll("\\", "/");
    const gateResultContent = `${JSON.stringify(gateResult, null, 2)}\n`;
    await writeRunOwnedFileAtomically({
      runDirectory: repoPath,
      path: relative(repoPath, gateResultPath),
      subject: `operator review gate ${gateId} path`,
      content: gateResultContent,
    });
    const artifact = withProvenance(
      {
        ...outputContract(output),
        id: gateId,
        type: "gate.result",
        producer: stage.id,
        mediaType: "application/json",
        path: gateResultRelativePath,
        sourceUri: gateResultRelativePath,
        filename: basename(gateResultPath),
        createdAt: submittedAt,
        gateResult,
      } satisfies RunArtifact,
      gateResultContent,
      { runId: input.runId, stageId: stage.id, attempt },
    );
    const registry = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: input.runId,
    });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: input.runId,
      artifacts: [...(registry?.artifacts ?? []), artifact],
      redactionSecrets,
    });
    const manifest = await readContextManifest({ runDirectory });
    await writeContextManifest({
      runDirectory,
      runId: input.runId,
      entries: mergeManifestEntry(manifest?.entries ?? [], {
        id: gateId,
        kind: "generated-artifact",
        connector: "generated",
        sourceUri: gateResultRelativePath,
        mediaType: "application/json",
        filename: basename(gateResultPath),
        runRelativePath: gateResultRelativePath,
        policy: { decision: "allowed" },
      }),
      redactionSecrets,
    });

    store.append({
      runId: input.runId,
      stageId: stage.id,
      attempt,
      type: "operator.review.submitted",
      createdAt: submittedAt,
      payload: {
        gateResultId: gateId,
        actor,
        submittedAt,
        reviewedArtifactIds: [...stage.inputs],
        blocker: blockerSnapshot,
        status: gateResult.status,
      },
    });
    store.append({
      runId: input.runId,
      stageId: stage.id,
      attempt,
      type: "artifact.published",
      createdAt: submittedAt,
      payload: { artifact },
    });
    store.append({
      runId: input.runId,
      stageId: stage.id,
      attempt,
      type: "gate.completed",
      createdAt: submittedAt,
      payload: { gate: gateResult },
    });
    return gateResult;
  } finally {
    store.close();
  }
}
