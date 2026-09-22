import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  ciRepairIdempotencyKey,
  ciRepairSourceIdentity,
  classifyCiFailure,
  evaluateCiRepairAdmission,
  executeCiRepairCycle,
  MAX_CI_REPAIR_REMOTE_OBSERVATIONS,
  redactCiFailureObservation,
  type CiFailureObservation,
  type CiRepairCycleDependencies,
  type CiRepairCycleResult,
} from "../ci-repair.js";
import { redactText } from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import { eventStorePath } from "../run/project.js";
import { runFlow, type RunFlowInput } from "../run/run-flow.js";
import type { ResourceReference } from "../connectors/types.js";
import {
  CiRepairStore,
  ciRepairEventStorePath,
  ciRepairStorePath,
  initialCiRepairEvidence,
  type StoredCiRepairEvidence,
} from "./store.js";

const execFileAsync = promisify(execFile);

function safeError(error: unknown): string {
  return (redactText(error instanceof Error ? error.message : String(error)) ?? "CI repair failed")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

function requiredString(record: Record<string, unknown>, key: string, maxLength = 1_000): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`observation requires ${key}`);
  if (value.length > maxLength) throw new Error(`observation ${key} is too long`);
  return value.trim();
}

export function parseCiFailureObservation(value: unknown): CiFailureObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CI failure observation must be an object");
  }
  const record = value as Record<string, unknown>;
  const pullRequest = record.pullRequest;
  if (!Number.isSafeInteger(pullRequest) || (pullRequest as number) < 1) {
    throw new Error("observation pullRequest must be a positive integer");
  }
  const pullRequestNumber = pullRequest as number;
  const observedAt = requiredString(record, "observedAt");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("observation observedAt must be an ISO timestamp");
  const repository = requiredString(record, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error("observation repository must be owner/name");
  const headSha = requiredString(record, "headSha");
  if (!/^[0-9a-f]{7,64}$/iu.test(headSha)) throw new Error("observation headSha must be a SHA");
  const status = requiredString(record, "status");
  if (status !== "completed") throw new Error("observation status must be completed");
  const conclusion = requiredString(record, "conclusion").toLowerCase();
  if (!["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(conclusion)) {
    throw new Error("observation conclusion must indicate a failure");
  }
  return {
    provider: requiredString(record, "provider"),
    repository,
    pullRequest: pullRequestNumber,
    ...(typeof record.checkSuiteId === "string" && record.checkSuiteId ? { checkSuiteId: record.checkSuiteId.slice(0, 1_000) } : {}),
    ...(typeof record.workflowRunId === "string" && record.workflowRunId ? { workflowRunId: record.workflowRunId.slice(0, 1_000) } : {}),
    checkRunId: requiredString(record, "checkRunId"),
    checkName: requiredString(record, "checkName"),
    headSha,
    conclusion,
    status,
    ...(typeof record.attemptUrl === "string" && record.attemptUrl ? { attemptUrl: record.attemptUrl.slice(0, 2_000) } : {}),
    failureOutput: requiredString(record, "failureOutput", 64 * 1024),
    observedAt: new Date(observedAt).toISOString(),
  };
}

function eventRunId(idempotencyKey: string): string {
  return `ci-repair-${idempotencyKey}`;
}

function appendEvent(
  eventStore: EventStore,
  idempotencyKey: string,
  type: Parameters<EventStore["append"]>[0]["type"],
  payload: unknown,
): void {
  eventStore.append({ runId: eventRunId(idempotencyKey), type, payload });
}

async function openStore(repoPath: string): Promise<CiRepairStore> {
  const path = ciRepairStorePath(repoPath);
  await mkdir(dirname(path), { recursive: true });
  return new CiRepairStore(path);
}

async function declaredCheckNames(repoPath: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return ["check", "test:run"].filter(
      (name) => typeof packageJson.scripts?.[name] === "string",
    );
  } catch {
    return [];
  }
}

async function declaredCheckCommands(repoPath: string): Promise<string[]> {
  return (await declaredCheckNames(repoPath)).map((name) => `pnpm run ${name}`);
}

function currentEvidenceResult(evidence: StoredCiRepairEvidence): CiRepairCycleResult {
  return evidence.result ?? {
    outcome: "needs-human",
    sourceIdentity: evidence.sourceIdentity,
    idempotencyKey: evidence.idempotencyKey,
    remoteObservationCount: evidence.remoteObservationCount,
    reason: "repair is already in progress",
  };
}

export async function submitCiRepair(input: {
  repoPath: string;
  observation: CiFailureObservation;
  currentHeadSha: string;
  secrets?: readonly string[];
  resume?: boolean;
  dependencies: CiRepairCycleDependencies;
  eventStore?: EventStore;
}): Promise<{ result: CiRepairCycleResult; evidence: StoredCiRepairEvidence; reused: boolean }> {
  const sourceIdentity = ciRepairSourceIdentity(input.observation);
  const idempotencyKey = ciRepairIdempotencyKey(input.observation);
  const redacted = redactCiFailureObservation(input.observation, input.secrets ?? []);
  const localCheckCommands = await declaredCheckCommands(input.repoPath);
  const store = await openStore(input.repoPath);
  const ownEventStore = input.eventStore ? undefined : new EventStore(ciRepairEventStorePath(input.repoPath));
  const eventStore = input.eventStore ?? ownEventStore!;
  try {
    const claim = store.claim(initialCiRepairEvidence({ idempotencyKey, sourceIdentity, observation: redacted }));
    const claimed = claim.evidence;
    const resumableTerminal = claimed.state === "completed" &&
      input.resume === true &&
      claimed.outcome === "needs-human" &&
      claimed.remoteObservationCount < MAX_CI_REPAIR_REMOTE_OBSERVATIONS &&
      claimed.samePullRequestUpdate !== undefined;
    const resumableInterrupted = claimed.state === "running" &&
      input.resume === true &&
      Date.now() - Date.parse(claimed.updatedAt) >= 60_000;
    if (!claim.inserted && (!resumableTerminal && !resumableInterrupted)) {
      return { result: currentEvidenceResult(claimed), evidence: claimed, reused: true };
    }
    if (claim.inserted) {
      appendEvent(eventStore, idempotencyKey, "ci-repair.submitted", {
        sourceIdentity,
        idempotencyKey,
        observation: redacted,
      });
    }
    const admissionCurrentHeadSha = claimed.samePullRequestUpdate?.updatedHeadSha ?? input.currentHeadSha;
    const admission = evaluateCiRepairAdmission({
      observation: input.observation,
      currentHeadSha: admissionCurrentHeadSha,
      remoteObservationCount: claimed.remoteObservationCount,
    });
    const diagnosis = classifyCiFailure(redacted.failureOutput);
    let evidence: StoredCiRepairEvidence = {
      ...claimed,
      ...(admission.allowed ? {
        classification: admission.classification,
        confidence: admission.confidence,
      } : {
        classification: admission.classification,
      }),
      diagnosis: {
        classification: admission.classification ?? diagnosis.classification,
        confidence: admission.allowed ? admission.confidence : diagnosis.confidence,
        evidence: diagnosis.reason,
        excerpt: redacted.failureOutput.slice(0, 500),
      },
      updatedAt: new Date().toISOString(),
    };
    store.save(evidence);
    appendEvent(eventStore, idempotencyKey, "ci-repair.diagnosed", {
      ...admission,
      ...(claim.inserted ? {} : { resumed: true }),
    });
    let localChecks: boolean | undefined = claimed.localChecks?.passed;
    let review: boolean | undefined = claimed.structuredReview?.passed;
    let samePullRequestUpdate: StoredCiRepairEvidence["samePullRequestUpdate"] = claimed.samePullRequestUpdate;
    const remoteObservations: StoredCiRepairEvidence["remoteObservations"] = [...claimed.remoteObservations];
    const dependencies: CiRepairCycleDependencies = {
      applySamePullRequestRepair: async (repairInput) => {
        if (samePullRequestUpdate) return { updatedHeadSha: samePullRequestUpdate.updatedHeadSha };
        const updated = await input.dependencies.applySamePullRequestRepair(repairInput);
        samePullRequestUpdate = {
          updatedHeadSha: updated.updatedHeadSha,
          receipt: `${sourceIdentity}:${updated.updatedHeadSha}`,
        };
        evidence = {
          ...evidence,
          samePullRequestUpdate,
          ...(updated.runId ? { repairRunId: updated.runId } : {}),
          ...(updated.worktreePath ? { repairWorktreePath: updated.worktreePath } : {}),
          updatedAt: new Date().toISOString(),
        };
        store.save(evidence);
        return updated;
      },
      runLocalChecks: async () => {
        if (localChecks !== undefined) return localChecks;
        localChecks = await input.dependencies.runLocalChecks();
        evidence = { ...evidence, localChecks: { passed: localChecks, commands: localCheckCommands }, updatedAt: new Date().toISOString() };
        store.save(evidence);
        appendEvent(eventStore, idempotencyKey, "ci-repair.local-verified", { passed: localChecks });
        return localChecks;
      },
      runStructuredReview: async () => {
        if (review !== undefined) return review;
        review = await input.dependencies.runStructuredReview();
        evidence = { ...evidence, structuredReview: { passed: review }, updatedAt: new Date().toISOString() };
        store.save(evidence);
        appendEvent(eventStore, idempotencyKey, "ci-repair.reviewed", { passed: review });
        return review;
      },
      observeRemoteResult: async () => {
        const result = await input.dependencies.observeRemoteResult();
        remoteObservations.push({
          headSha: result.headSha,
          passed: result.passed,
          ...(result.failureOutput ? { failureOutput: redactCiFailureObservation({ ...input.observation, failureOutput: result.failureOutput }, input.secrets ?? []).failureOutput } : {}),
        });
        evidence = {
          ...evidence,
          remoteObservationCount: remoteObservations.length,
          remoteObservationBudget: {
            used: remoteObservations.length,
            remaining: Math.max(0, MAX_CI_REPAIR_REMOTE_OBSERVATIONS - remoteObservations.length),
          },
          remoteObservations: [...remoteObservations],
          updatedAt: new Date().toISOString(),
        };
        store.save(evidence);
        appendEvent(eventStore, idempotencyKey, "ci-repair.remote-observed", remoteObservations.at(-1));
        return result;
      },
    };
    let result: CiRepairCycleResult;
    try {
      if (!claim.inserted && claimed.samePullRequestUpdate && input.dependencies.restoreRepairContext) {
        await input.dependencies.restoreRepairContext({
          updatedHeadSha: claimed.samePullRequestUpdate.updatedHeadSha,
        });
      }
      result = await executeCiRepairCycle({
        observation: input.observation,
        currentHeadSha: admissionCurrentHeadSha,
        remoteObservationCount: claimed.remoteObservationCount,
        secrets: input.secrets,
      }, dependencies);
    } catch (error) {
      result = {
        outcome: "needs-human",
        sourceIdentity,
        idempotencyKey,
        remoteObservationCount: remoteObservations.length,
        reason: safeError(error),
      };
    }
    evidence = {
      ...evidence,
      ...(localChecks !== undefined ? { localChecks: { passed: localChecks, commands: localCheckCommands } } : {}),
      ...(review !== undefined ? { structuredReview: { passed: review } } : {}),
      ...(samePullRequestUpdate ? { samePullRequestUpdate } : {}),
      remoteObservationCount: result.remoteObservationCount,
      remoteObservationBudget: {
        used: result.remoteObservationCount,
        remaining: Math.max(0, MAX_CI_REPAIR_REMOTE_OBSERVATIONS - result.remoteObservationCount),
      },
      remoteObservations,
      outcome: result.outcome,
      terminal: true,
      state: "completed",
      result,
      updatedAt: new Date().toISOString(),
    };
    store.save(evidence);
    await mkdir(join(resolve(input.repoPath), ".nitely", "ci-repair"), { recursive: true });
    await writeFile(
      join(resolve(input.repoPath), ".nitely", "ci-repair", `${idempotencyKey}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    appendEvent(eventStore, idempotencyKey, "ci-repair.completed", result);
    return { result, evidence, reused: false };
  } finally {
    store.close();
    ownEventStore?.close();
  }
}

export async function recordCiRepairDecision(input: {
  repoPath: string;
  idempotencyKey: string;
  decision: "accept" | "reject";
  actor?: string;
  reason?: string;
}): Promise<StoredCiRepairEvidence> {
  const store = await openStore(input.repoPath);
  const eventStore = new EventStore(ciRepairEventStorePath(input.repoPath));
  try {
    const evidence = store.get(input.idempotencyKey);
    if (!evidence) throw new Error(`CI repair not found: ${input.idempotencyKey}`);
    const decision = {
      decision: input.decision,
      ...(input.actor ? { actor: redactText(input.actor)?.slice(0, 200) } : {}),
      ...(input.reason ? { reason: redactText(input.reason)?.slice(0, 2_000) } : {}),
    };
    const updated = {
      ...evidence,
      humanDecision: decision,
      updatedAt: new Date().toISOString(),
    };
    store.save(updated);
    appendEvent(eventStore, input.idempotencyKey, "ci-repair.decision", decision);
    return updated;
  } finally {
    store.close();
    eventStore.close();
  }
}

async function runDeclaredChecks(repoPath: string): Promise<boolean> {
  const names = await declaredCheckNames(repoPath);
  if (names.length === 0) return false;
  for (const name of names) {
    try {
      await execFileAsync("pnpm", ["run", name], { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 });
    } catch {
      return false;
    }
  }
  return true;
}

async function findWorktreeForHead(repoPath: string, headSha: string): Promise<string> {
  const result = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  const blocks = result.stdout.split(/\n\n+/u);
  for (const block of blocks) {
    const worktree = block.match(/^worktree (.+)$/mu)?.[1];
    const head = block.match(/^HEAD ([0-9a-f]+)$/imu)?.[1];
    if (worktree && head === headSha) return worktree;
  }
  throw new Error("repaired worktree is no longer available; operator must inspect the pull request");
}

export async function readGitHubPullRequestHead(repoPath: string, target: string): Promise<string> {
  const head = await execFileAsync("gh", ["pr", "view", target, "--json", "headRefOid", "--jq", ".headRefOid"], { cwd: repoPath });
  const headSha = head.stdout.trim();
  if (!headSha) throw new Error("GitHub pull request has no head SHA");
  return headSha;
}

async function observeGitHubChecks(repoPath: string, target: string): Promise<{ headSha: string; passed: boolean; failureOutput?: string }> {
  const headSha = await readGitHubPullRequestHead(repoPath, target);
  const checks = await execFileAsync("gh", ["pr", "checks", target, "--json", "name,state,bucket"], { cwd: repoPath, maxBuffer: 2 * 1024 * 1024 });
  const entries = JSON.parse(checks.stdout) as Array<{ name?: string; state?: string; bucket?: string }>;
  const passed = entries.length > 0 && entries.every((entry) => entry.bucket === "pass" || entry.bucket === "skipping");
  return {
    headSha,
    passed,
    ...(!passed ? { failureOutput: entries.map((entry) => `${entry.name ?? "unknown"}: ${entry.state ?? "unknown"}`).join("\n") } : {}),
  };
}

export function defaultCiRepairDependencies(input: {
  repoPath: string;
  flowPath: string;
  inputs: Record<string, ResourceReference>;
  pullRequestTarget: string;
}): CiRepairCycleDependencies {
  let repairWorktreePath = input.repoPath;
  let reviewGatePassed = false;
  return {
    applySamePullRequestRepair: async (repairInput) => {
      const failurePath = join(
        resolve(input.repoPath),
        ".nitely",
        "ci-repair",
        "inputs",
        `${ciRepairIdempotencyKey(repairInput.observation)}.json`,
      );
      await mkdir(dirname(failurePath), { recursive: true });
      await writeFile(failurePath, `${JSON.stringify(repairInput.observation, null, 2)}\n`, "utf8");
      const flowDocument = JSON.parse(await readFile(input.flowPath, "utf8")) as {
        spec?: { stages?: Array<{ type?: string; inputs?: string[] }> };
      };
      for (const stage of flowDocument.spec?.stages ?? []) {
        if (stage.type !== "agent" && stage.type !== "judge" && stage.type !== "gate") continue;
        stage.inputs = [...new Set([...(stage.inputs ?? []), "ci-failure"])];
      }
      const result = await runFlow({
        flowPath: input.flowPath,
        repoPath: input.repoPath,
        flowDocument: JSON.stringify(flowDocument),
        inputs: {
          ...input.inputs,
          "ci-failure": { connector: "local-file", uri: failurePath },
        },
        changeRequestTarget: { provider: "github", target: input.pullRequestTarget },
      } satisfies RunFlowInput);
      if (!result.updatedHeadSha) throw new Error("repair flow did not update the existing pull request");
      repairWorktreePath = result.worktreePath;
      const events = new EventStore(eventStorePath(input.repoPath));
      try {
        reviewGatePassed = events.list(result.runId).some((event) => {
          if (event.type !== "gate.completed" || event.stageId === undefined) return false;
          const payload = event.payload as { gate?: { mode?: string; status?: string } };
          return payload.gate?.mode === "review" && payload.gate.status === "passed";
        });
      } finally {
        events.close();
      }
      if (!reviewGatePassed) throw new Error("repair flow did not produce a passing structured review gate");
      return {
        updatedHeadSha: result.updatedHeadSha,
        runId: result.runId,
        worktreePath: result.worktreePath,
      };
    },
    runLocalChecks: () => runDeclaredChecks(repairWorktreePath),
    runStructuredReview: async () => reviewGatePassed,
    restoreRepairContext: async ({ updatedHeadSha }) => {
      repairWorktreePath = await findWorktreeForHead(input.repoPath, updatedHeadSha);
    },
    observeRemoteResult: () => observeGitHubChecks(input.repoPath, input.pullRequestTarget),
  };
}
