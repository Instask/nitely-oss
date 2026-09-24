import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { LocalFileConnector } from "../connectors/local-file.js";
import { loadContextPolicy } from "../context/policy.js";
import { redactText } from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import { parseFlowDocument } from "../flow/load.js";
import { stageRuntimeCandidates } from "../flow/schema.js";
import { validateSkillDirectory } from "../skills/load.js";
import {
  FlowConfigurationError,
  normalizeFlowConfiguration,
  type FlowConfiguration,
} from "../flows/configurables.js";
import {
  normalizeExecutionBackendName,
  type ExecutionBackendName,
} from "../run/execution/backend.js";
import { sha256Text, type ReproducibilityManifest } from "../run/reproducibility.js";
import { eventStorePath, validateRunId } from "../run/project.js";
import { loadConstitution } from "../run/constitution.js";
import { loadProjectInstructions } from "../run/project-instructions.js";
import {
  runFlow,
  type ExpectedPromptContext,
  type ExpectedPromptSourceIdentity,
  type ExpectedSkillContentHashes,
  type RunFlowInput,
  type RunFlowResult,
} from "../run/run-flow.js";
import {
  evalManifestSha256,
  parseEvalCohortManifest,
  type EvalCohortManifest,
} from "./manifest.js";
import { parseBaselineReproducibilityManifest } from "./reproducibility-schema.js";

const execFileAsync = promisify(execFile);
const MAX_BASELINE_REPRODUCIBILITY_BYTES = 1024 * 1024;
const ORDINARY_MODEL_NONDETERMINISM =
  "agent runtime output depends on external model/provider behavior";
const ORDINARY_NONDETERMINISM_IDS = new Map<string, string>([
  [ORDINARY_MODEL_NONDETERMINISM, "model-output"],
  [
    "external connector inputs may change outside the repository",
    "external-input",
  ],
]);

export interface EvalReplayFinding {
  code: string;
  message: string;
  path?: string;
  expected?: string;
  actual?: string;
}

export type EvalReplayPlan =
  | {
      status: "ready";
      cohortId: string;
      caseId: string;
      manifestSha256: string;
      manifest: EvalCohortManifest;
      baselineCohortId?: string;
      baselineRunId: string;
      sourceRevision: string;
      allowedNondeterminism: string[];
      findings: [];
      runInput: RunFlowInput;
    }
  | {
      status: "incompatible";
      cohortId: string;
      caseId: string;
      manifestSha256: string;
      manifest: EvalCohortManifest;
      baselineCohortId?: string;
      baselineRunId: string;
      sourceRevision: string;
      allowedNondeterminism: string[];
      findings: EvalReplayFinding[];
      runInput?: undefined;
    };

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function samePinnedIdentity(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalPinnedIdentity(value: string): string {
  return value.toLowerCase();
}

async function readPinnedRepoFile(
  repoPath: string,
  path: string,
  expectedSha256: string,
): Promise<Buffer> {
  const resource = await new LocalFileConnector(repoPath).fetch({
    connector: "local-file",
    uri: path,
    options: { expectedSha256: canonicalPinnedIdentity(expectedSha256) },
  });
  return resource.content;
}

function pinnedReadFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "pinned_content_missing";
  if (error.message.includes("outside local-file base directory")) {
    return "pinned_path_escape";
  }
  if (error.message.includes("-byte read limit")) {
    return "pinned_content_too_large";
  }
  if (error.message.includes("sha256 does not match expected sha256")) {
    return "content_digest_mismatch";
  }
  return "pinned_content_missing";
}

async function readBaselineReproducibilityManifest(input: {
  repoPath: string;
  runId: string;
}): Promise<ReproducibilityManifest | undefined> {
  let content: Buffer;
  try {
    ({ content } = await new LocalFileConnector(input.repoPath, {
      maximumBytes: MAX_BASELINE_REPRODUCIBILITY_BYTES,
      requireSingleLink: true,
    }).fetch({
      connector: "local-file",
      uri: `.nitely/runs/${input.runId}/reproducibility.json`,
    }));
  } catch (error) {
    if (errorChainHasCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `baseline reproducibility manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseBaselineReproducibilityManifest(value);
}

function errorChainHasCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

function baselineManifestFailureCode(error: unknown): string {
  if (error instanceof Error && (
    error.message.includes("outside local-file base directory") ||
    error.message.includes("exactly one directory entry") ||
    error.message.includes("symbolic link") ||
    error.message.includes("changed while it was being read")
  )) {
    return "baseline_manifest_unsafe";
  }
  return "baseline_manifest_invalid";
}

function repoRelativeIdentity(
  repoPath: string,
  candidatePath: string | undefined,
): string | undefined {
  if (!candidatePath || candidatePath.includes("\0")) return undefined;
  const portablePath = candidatePath.replaceAll("\\", "/");
  const absolutePath = isAbsolute(portablePath)
    ? resolve(portablePath)
    : resolve(repoPath, portablePath);
  const identity = relative(repoPath, absolutePath).replaceAll("\\", "/");
  if (
    identity === "" ||
    identity === ".." ||
    identity.startsWith("../") ||
    isAbsolute(identity)
  ) {
    return undefined;
  }
  return identity;
}

function baselineNondeterminismDeclared(
  factor: string,
  declarations: readonly { id: string; description: string }[],
): boolean {
  const knownId = ORDINARY_NONDETERMINISM_IDS.get(factor);
  return declarations.some(
    (declaration) =>
      declaration.description === factor ||
      declaration.id === factor ||
      (knownId !== undefined && declaration.id === knownId),
  );
}

function sameRuntime(
  left: { runtime: string; model?: string } | undefined,
  right: { runtime: string; model?: string } | undefined,
): boolean {
  return left?.runtime === right?.runtime && left?.model === right?.model;
}

function promptSourceIdentity(
  source:
    | Awaited<ReturnType<typeof loadConstitution>>
    | Awaited<ReturnType<typeof loadProjectInstructions>>,
): ExpectedPromptSourceIdentity {
  return {
    loaded: source.loaded,
    path: source.path,
    ...(source.loaded ? { hash: source.hash } : {}),
  };
}

function samePromptSourceIdentity(
  left: ExpectedPromptSourceIdentity,
  right: ExpectedPromptSourceIdentity,
): boolean {
  return left.loaded === right.loaded && left.path === right.path &&
    samePinnedIdentity(left.hash, right.hash);
}

function canonicalPromptSourceIdentity(
  source: ExpectedPromptSourceIdentity,
): ExpectedPromptSourceIdentity {
  return {
    loaded: source.loaded,
    path: source.path,
    ...(source.hash
      ? { hash: canonicalPinnedIdentity(source.hash) }
      : {}),
  };
}

function addMismatch(
  findings: EvalReplayFinding[],
  input: {
    code: string;
    message: string;
    path?: string;
    expected?: string;
    actual?: string;
  },
): void {
  findings.push({
    code: input.code,
    message: redactText(input.message) ?? "eval compatibility check failed",
    ...(input.path ? { path: redactText(input.path) } : {}),
    ...(input.expected ? { expected: redactText(input.expected) } : {}),
    ...(input.actual ? { actual: redactText(input.actual) } : {}),
  });
}

export async function planEvalReplay(input: {
  repoPath: string;
  manifest: EvalCohortManifest;
  manifestSha256: string;
  caseId: string;
}): Promise<EvalReplayPlan> {
  const repoPath = resolve(input.repoPath);
  const manifest = parseEvalCohortManifest(input.manifest);
  const evalCase = manifest.cases.find((candidate) => candidate.id === input.caseId);
  if (!evalCase) {
    throw new Error(`eval case not found: ${input.caseId}`);
  }
  const findings: EvalReplayFinding[] = [];
  const actualManifestSha256 = evalManifestSha256(manifest);
  if (!samePinnedIdentity(input.manifestSha256, actualManifestSha256)) {
    addMismatch(findings, {
      code: "manifest_digest_mismatch",
      message: "supplied manifest digest does not match the canonical manifest",
      expected: actualManifestSha256,
      actual: input.manifestSha256,
    });
  }

  let executionBackend: ExecutionBackendName | undefined;
  try {
    executionBackend = normalizeExecutionBackendName(
      evalCase.runtime.executionBackend,
    );
  } catch (error) {
    addMismatch(findings, {
      code: "execution_backend_unsupported",
      message: error instanceof Error ? error.message : String(error),
      actual: evalCase.runtime.executionBackend,
    });
  }

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
    });
    const actualRevision = stdout.trim();
    if (!samePinnedIdentity(actualRevision, evalCase.source.revision)) {
      addMismatch(findings, {
        code: "source_revision_mismatch",
        message: "repository HEAD does not match the pinned eval source revision",
        expected: evalCase.source.revision,
        actual: actualRevision,
      });
    }
  } catch (error) {
    addMismatch(findings, {
      code: "source_revision_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: repoPath },
    );
    if (stdout.trim().length > 0) {
      addMismatch(findings, {
        code: "source_worktree_dirty",
        message: "repository worktree contains tracked or untracked changes",
      });
    }
  } catch {
    addMismatch(findings, {
      code: "source_worktree_status_unavailable",
      message: "repository worktree status could not be verified",
    });
  }

  const flowPath = resolve(repoPath, evalCase.flow.path);
  let flowDocument: string | undefined;
  try {
    flowDocument = (
      await readPinnedRepoFile(
        repoPath,
        evalCase.flow.path,
        evalCase.flow.sha256,
      )
    ).toString("utf8");
    const actual = sha256(flowDocument);
    if (!samePinnedIdentity(actual, evalCase.flow.sha256)) {
      addMismatch(findings, {
        code: "content_digest_mismatch",
        message: "Flow document does not match its pinned digest",
        path: evalCase.flow.path,
        expected: evalCase.flow.sha256,
        actual,
      });
    }
  } catch (error) {
    addMismatch(findings, {
      code: pinnedReadFailureCode(error),
      message: error instanceof Error ? error.message : String(error),
      path: evalCase.flow.path,
    });
  }

  for (const entry of evalCase.inputs) {
    try {
      const actual = sha256(
        await readPinnedRepoFile(repoPath, entry.path, entry.sha256),
      );
      if (!samePinnedIdentity(actual, entry.sha256)) {
        addMismatch(findings, {
          code: "content_digest_mismatch",
          message: `input ${entry.id} does not match its pinned digest`,
          path: entry.path,
          expected: entry.sha256,
          actual,
        });
      }
    } catch (error) {
      addMismatch(findings, {
        code: pinnedReadFailureCode(error),
        message: error instanceof Error ? error.message : String(error),
        path: entry.path,
      });
    }
  }

  if (evalCase.reviewEvaluation) {
    const inputIds = new Set(evalCase.inputs.map((entry) => entry.id));
    const reviewInputs = [
      evalCase.reviewEvaluation.candidateDiff,
      evalCase.reviewEvaluation.approvedSpec,
      evalCase.reviewEvaluation.technicalDesign,
      ...evalCase.reviewEvaluation.deterministicEvidence,
    ].filter((entry): entry is { inputId: string } => entry !== undefined);
    for (const entry of reviewInputs) {
      if (!inputIds.has(entry.inputId)) {
        addMismatch(findings, {
          code: "review_input_missing",
          message: `review evaluation input is not pinned in the case: ${entry.inputId}`,
          actual: entry.inputId,
        });
      }
    }
  }

  try {
    const actual = sha256Text(JSON.stringify(await loadContextPolicy(repoPath)));
    if (!samePinnedIdentity(actual, evalCase.contextPolicy.sha256)) {
      addMismatch(findings, {
        code: "context_policy_mismatch",
        message: "effective context policy does not match its pinned digest",
        expected: evalCase.contextPolicy.sha256,
        actual,
      });
    }
  } catch (error) {
    addMismatch(findings, {
      code: "context_policy_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let actualPromptContext: ExpectedPromptContext | undefined;
  try {
    actualPromptContext = {
      constitution: promptSourceIdentity(await loadConstitution(repoPath)),
      projectInstructions: promptSourceIdentity(
        await loadProjectInstructions(repoPath),
      ),
    };
  } catch (error) {
    addMismatch(findings, {
      code: "prompt_context_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let baseline: ReproducibilityManifest | undefined;
  let expectedPromptContext: ExpectedPromptContext | undefined;
  let expectedSkillContentHashes: ExpectedSkillContentHashes | undefined;
  let baselineLoadFailed = false;
  try {
    baseline = await readBaselineReproducibilityManifest({
      repoPath,
      runId: evalCase.baselineRunId,
    });
  } catch (error) {
    baselineLoadFailed = true;
    addMismatch(findings, {
      code: baselineManifestFailureCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!baseline && !baselineLoadFailed) {
    addMismatch(findings, {
      code: "baseline_manifest_missing",
      message: `baseline reproducibility manifest is missing for ${evalCase.baselineRunId}`,
    });
  } else if (baseline) {
    if (!baseline.context.projectInstructions) {
      addMismatch(findings, {
        code: "baseline_prompt_context_missing",
        message: "baseline is missing pinned project instructions context",
      });
    } else {
      expectedPromptContext = {
        constitution: canonicalPromptSourceIdentity(
          baseline.context.constitution,
        ),
        projectInstructions: canonicalPromptSourceIdentity(
          baseline.context.projectInstructions,
        ),
      };
      if (
        !actualPromptContext ||
        !samePromptSourceIdentity(
          expectedPromptContext.constitution,
          actualPromptContext.constitution,
        ) ||
        !samePromptSourceIdentity(
          expectedPromptContext.projectInstructions,
          actualPromptContext.projectInstructions,
        )
      ) {
        addMismatch(findings, {
          code: "prompt_context_mismatch",
          message: "effective prompt context differs from the baseline run",
        });
      }
    }
    if (baseline.runId !== evalCase.baselineRunId) {
      addMismatch(findings, {
        code: "baseline_manifest_identity_mismatch",
        message: "baseline reproducibility manifest belongs to a different run",
        expected: evalCase.baselineRunId,
        actual: baseline.runId,
      });
    }
    const baselineFlowIdentity = repoRelativeIdentity(repoPath, baseline.flow.path);
    const expectedFlowIdentity = repoRelativeIdentity(repoPath, evalCase.flow.path);
    if (
      baselineFlowIdentity === undefined ||
      baselineFlowIdentity !== expectedFlowIdentity
    ) {
      addMismatch(findings, {
        code: "baseline_manifest_identity_mismatch",
        message: "baseline Flow path differs from the eval case",
        expected: expectedFlowIdentity ?? evalCase.flow.path,
        actual: baselineFlowIdentity ?? baseline.flow.path,
      });
    }
    if (baseline.replayability === "diagnostic-only") {
      addMismatch(findings, {
        code: "baseline_not_replayable",
        message: `baseline replayability is ${baseline.replayability}`,
        expected: "replayable or declared partially-replayable",
        actual: baseline.replayability,
      });
    } else if (baseline.replayability === "partially-replayable") {
      for (const factor of baseline.nonDeterministicFactors) {
        if (
          !baselineNondeterminismDeclared(
            factor,
            evalCase.allowedNondeterminism,
          )
        ) {
          addMismatch(findings, {
            code: "baseline_nondeterminism_undeclared",
            message: "baseline contains an undeclared nondeterministic factor",
            expected: "an exact declaration in allowedNondeterminism",
            actual: factor,
          });
        }
      }
    }
    const baselineRevision = baseline.repo.baseCommit;
    if (!samePinnedIdentity(baselineRevision, evalCase.source.revision)) {
      addMismatch(findings, {
        code: "baseline_source_mismatch",
        message: "baseline source revision differs from the eval case",
        expected: evalCase.source.revision,
        actual: baselineRevision,
      });
    }
    if (
      !samePinnedIdentity(
        baseline.flow.documentSha256,
        evalCase.flow.sha256,
      )
    ) {
      addMismatch(findings, {
        code: "baseline_flow_mismatch",
        message: "baseline Flow digest differs from the eval case",
        expected: evalCase.flow.sha256,
        actual: baseline.flow.documentSha256,
      });
    }
    if (
      !samePinnedIdentity(
        baseline.context.policySha256,
        evalCase.contextPolicy.sha256,
      )
    ) {
      addMismatch(findings, {
        code: "context_policy_mismatch",
        message: "baseline context policy digest differs from the eval case",
        expected: evalCase.contextPolicy.sha256,
        actual: baseline.context.policySha256,
      });
    }
    if (baseline.environment.executionBackend !== evalCase.runtime.executionBackend) {
      addMismatch(findings, {
        code: "execution_backend_mismatch",
        message: "baseline execution backend differs from the eval case",
        expected: evalCase.runtime.executionBackend,
        actual: baseline.environment.executionBackend,
      });
    }
    if (
      baseline.environment.sandboxPolicy?.codex !==
        evalCase.runtime.sandboxPolicy.codex
    ) {
      addMismatch(findings, {
        code: "sandbox_policy_mismatch",
        message: "baseline Codex sandbox policy differs from the eval case",
        expected: evalCase.runtime.sandboxPolicy.codex,
        actual: baseline.environment.sandboxPolicy?.codex,
      });
    }
    for (const entry of evalCase.inputs) {
      const prior = baseline.inputs.find((candidate) => candidate.id === entry.id);
      if (
        !prior ||
        !samePinnedIdentity(prior.sha256, entry.sha256)
      ) {
        addMismatch(findings, {
          code: "baseline_input_mismatch",
          message: `baseline input ${entry.id} differs from the eval case`,
          path: entry.path,
        });
      }
      const expectedSourceIdentity = repoRelativeIdentity(repoPath, entry.path);
      const baselineSourceIdentity = repoRelativeIdentity(repoPath, prior?.sourceUri);
      if (
        !prior ||
        prior.connector !== "local-file" ||
        expectedSourceIdentity === undefined ||
        baselineSourceIdentity !== expectedSourceIdentity
      ) {
        addMismatch(findings, {
          code: "baseline_manifest_identity_mismatch",
          message: `baseline input source differs for ${entry.id}`,
          path: entry.path,
          expected: expectedSourceIdentity ?? entry.path,
          actual: baselineSourceIdentity ?? prior?.sourceUri,
        });
      }
    }
    const expectedInputIds = new Set(evalCase.inputs.map((entry) => entry.id));
    for (const prior of baseline.inputs) {
      if (!expectedInputIds.has(prior.id)) {
        addMismatch(findings, {
          code: "baseline_input_mismatch",
          message: `baseline contains an input absent from the eval case: ${prior.id}`,
        });
      }
    }
    for (const selection of evalCase.runtime.stages) {
      const prior = baseline.runtimes.find(
        (candidate) => candidate.stageId === selection.stageId,
      );
      if (!sameRuntime(prior?.selected, selection)) {
        addMismatch(findings, {
          code: "runtime_selection_mismatch",
          message: `baseline runtime selection differs for stage ${selection.stageId}`,
          expected: JSON.stringify(selection),
          actual: JSON.stringify(prior?.selected),
        });
      }
    }
    const expectedRuntimeStageIds = new Set(
      evalCase.runtime.stages.map((selection) => selection.stageId),
    );
    for (const prior of baseline.runtimes) {
      if (!expectedRuntimeStageIds.has(prior.stageId)) {
        addMismatch(findings, {
          code: "runtime_selection_mismatch",
          message: `baseline contains a runtime selection absent from the eval case: ${prior.stageId}`,
        });
      }
    }
  }

  let normalizedConfiguration: FlowConfiguration | undefined;
  if (
    flowDocument &&
    samePinnedIdentity(sha256(flowDocument), evalCase.flow.sha256)
  ) {
    try {
      const loaded = parseFlowDocument(flowDocument, {
        externalInputs: evalCase.inputs.map((entry) => entry.id),
      });
      try {
        normalizedConfiguration = normalizeFlowConfiguration(
          loaded.flow,
          evalCase.configuration ?? {},
        );
      } catch (error) {
        addMismatch(findings, {
          code: "configuration_invalid",
          message: error instanceof FlowConfigurationError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        });
      }
      if (normalizedConfiguration && baseline) {
        const configurationSha256 = sha256Text(
          JSON.stringify(normalizedConfiguration),
        );
        if (
          !samePinnedIdentity(
            baseline.flow.configurationSha256,
            configurationSha256,
          )
        ) {
          addMismatch(findings, {
            code: "baseline_configuration_mismatch",
            message: "baseline Flow configuration differs from the eval case",
            expected: configurationSha256,
            actual: baseline.flow.configurationSha256,
          });
        }
      }
      const runtimeStages = loaded.flow.spec.stages.filter(
        (stage) =>
          stage.type === "agent" ||
          stage.type === "judge" ||
          (stage.type === "gate" && stage.mode === "review"),
      );
      for (const stage of runtimeStages) {
        const selection = evalCase.runtime.stages.find(
          (candidate) => candidate.stageId === stage.id,
        );
        const candidates = stageRuntimeCandidates(stage);
        if (
          !selection ||
          candidates.length !== 1 ||
          !sameRuntime(candidates[0], selection)
        ) {
          addMismatch(findings, {
            code: "runtime_selection_mismatch",
            message: `Flow runtime selection is not exactly pinned for stage ${stage.id}`,
            expected: JSON.stringify(selection),
            actual: JSON.stringify(candidates),
          });
        }
      }
      const runtimeStageIds = new Set(runtimeStages.map((stage) => stage.id));
      for (const selection of evalCase.runtime.stages) {
        if (!runtimeStageIds.has(selection.stageId)) {
          addMismatch(findings, {
            code: "runtime_selection_mismatch",
            message: `eval runtime selection references a non-runtime Flow stage: ${selection.stageId}`,
          });
        }
      }
      if (evalCase.reviewEvaluation) {
        const stages = new Map(
          loaded.flow.spec.stages.map((stage) => [stage.id, stage]),
        );
        for (const stageId of evalCase.reviewEvaluation.reviewerStageIds) {
          const stage = stages.get(stageId);
          if (
            !stage ||
            !(stage.type === "judge" ||
              (stage.type === "gate" && stage.mode === "review"))
          ) {
            addMismatch(findings, {
              code: "reviewer_stage_invalid",
              message: `reviewer stage must be a Judge or review gate: ${stageId}`,
              actual: stage?.type ?? "missing",
            });
          }
        }
      }
      for (const expectedGate of evalCase.expectedGates) {
        const gate = loaded.flow.spec.stages.find(
          (stage) => stage.id === expectedGate && stage.type === "gate",
        );
        if (!gate) {
          addMismatch(findings, {
            code: "expected_gate_missing",
            message: `expected gate is not declared by the pinned Flow: ${expectedGate}`,
          });
        }
      }
      if (baseline) {
        expectedSkillContentHashes = {};
        const currentSkillHashes = new Map<string, string>();
        const declaredSkills = loaded.flow.spec.stages.flatMap((stage) =>
          (stage.skills ?? []).map((id) => ({ stageId: stage.id, id }))
        );
        for (const declared of declaredSkills) {
          const prior = baseline.skills.find(
            (skill) =>
              skill.stageId === declared.stageId && skill.id === declared.id,
          );
          if (!prior) {
            addMismatch(findings, {
              code: "baseline_skill_mismatch",
              message:
                `baseline is missing skill ${declared.id} for stage ${declared.stageId}`,
            });
            continue;
          }
          (expectedSkillContentHashes[declared.stageId] ??= {})[declared.id] =
            canonicalPinnedIdentity(prior.contentHash);
          try {
            let currentHash = currentSkillHashes.get(declared.id);
            if (!currentHash) {
              const current = await validateSkillDirectory({
                skillDirectory: join(repoPath, ".nitely", "skills", declared.id),
                skillId: declared.id,
                stageId: declared.stageId,
                errorRoot: repoPath,
              });
              currentHash = `sha256:${current.contentHash}`;
              currentSkillHashes.set(declared.id, currentHash);
            }
            if (!samePinnedIdentity(currentHash, prior.contentHash)) {
              addMismatch(findings, {
                code: "skill_content_mismatch",
                message:
                  `effective skill ${declared.id} differs from the baseline run`,
              });
            }
          } catch (error) {
            addMismatch(findings, {
              code: "skill_content_mismatch",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const declaredIdentities = new Set(
          declaredSkills.map(({ stageId, id }) => `${stageId}\0${id}`),
        );
        for (const prior of baseline.skills) {
          if (!declaredIdentities.has(`${prior.stageId}\0${prior.id}`)) {
            addMismatch(findings, {
              code: "baseline_skill_mismatch",
              message:
                `baseline contains undeclared skill ${prior.id} for stage ${prior.stageId}`,
            });
          }
        }
      }
    } catch (error) {
      addMismatch(findings, {
        code: "flow_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: evalCase.flow.path,
      });
    }
  }

  if (
    findings.length > 0 ||
    flowDocument === undefined ||
    expectedPromptContext === undefined ||
    expectedSkillContentHashes === undefined
  ) {
    return {
      status: "incompatible",
      cohortId: manifest.cohort.id,
      caseId: evalCase.id,
      manifestSha256: actualManifestSha256,
      manifest,
      ...(manifest.cohort.baselineCohortId
        ? { baselineCohortId: manifest.cohort.baselineCohortId }
        : {}),
      baselineRunId: evalCase.baselineRunId,
      sourceRevision: evalCase.source.revision,
      allowedNondeterminism: evalCase.allowedNondeterminism.map((entry) => entry.id),
      findings,
    };
  }

  const inputs = Object.fromEntries(
    evalCase.inputs.map((entry) => [
      entry.id,
      {
        connector: "local-file",
        uri: entry.path,
        options: {
          expectedSha256: canonicalPinnedIdentity(entry.sha256),
        },
      },
    ]),
  );
  return {
    status: "ready",
    cohortId: manifest.cohort.id,
    caseId: evalCase.id,
    manifestSha256: actualManifestSha256,
    manifest,
    ...(manifest.cohort.baselineCohortId
      ? { baselineCohortId: manifest.cohort.baselineCohortId }
      : {}),
    baselineRunId: evalCase.baselineRunId,
    sourceRevision: evalCase.source.revision,
    allowedNondeterminism: evalCase.allowedNondeterminism.map((entry) => entry.id),
    findings: [],
    runInput: {
      repoPath,
      flowPath,
      flowDocument,
      expectedSourceRevision: evalCase.source.revision,
      expectedContextPolicySha256: canonicalPinnedIdentity(
        evalCase.contextPolicy.sha256,
      ),
      expectedPromptContext,
      expectedSkillContentHashes,
      executionBackend,
      sandboxPolicy: evalCase.runtime.sandboxPolicy,
      ...(normalizedConfiguration &&
          Object.keys(normalizedConfiguration).length > 0
        ? { configuration: normalizedConfiguration }
        : {}),
      inputs,
    },
  };
}

export interface ExecuteEvalReplayDependencies {
  createRunId?: () => string;
  openEventStore?: (path: string) => EventStore;
  runOrdinaryFlow?: (
    input: RunFlowInput,
    runId: string,
  ) => Promise<RunFlowResult>;
}

function assertValidReplayLinkPlan(plan: Extract<EvalReplayPlan, { status: "ready" }>): void {
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/;
  if (!/^sha256:[0-9a-f]{64}$/i.test(plan.manifestSha256)) {
    throw new Error("invalid eval manifest digest");
  }
  if (!/^[0-9a-f]{40}$/i.test(plan.sourceRevision)) {
    throw new Error("invalid eval source revision");
  }
  for (const [name, value] of [
    ["cohort", plan.cohortId],
    ["case", plan.caseId],
    ["baseline run", plan.baselineRunId],
    ...(plan.baselineCohortId
      ? [["baseline cohort", plan.baselineCohortId] as const]
      : []),
    ...plan.allowedNondeterminism.map(
      (value) => ["allowed nondeterminism", value] as const,
    ),
  ] as const) {
    if (!idPattern.test(value)) throw new Error(`invalid eval ${name} id`);
  }
  if (plan.manifest.cohort.id !== plan.cohortId) {
    throw new Error("eval link cohort does not match manifest");
  }
  const evalCase = plan.manifest.cases.find((candidate) => candidate.id === plan.caseId);
  if (
    !evalCase ||
    evalCase.baselineRunId !== plan.baselineRunId ||
    !samePinnedIdentity(evalCase.source.revision, plan.sourceRevision)
  ) {
    throw new Error("eval link case provenance does not match manifest");
  }
}

type EvalReplayOutcome = "completed" | "awaiting-approval" | "failed";

function ordinaryEvidenceExists(store: EventStore, runId: string): boolean {
  return store.list(runId).some((event) => event.type !== "eval.replay.linked");
}

function appendEvalReplayLink(input: {
  store: EventStore;
  runId: string;
  plan: Extract<EvalReplayPlan, { status: "ready" }>;
  invocationId: string;
  outcome: EvalReplayOutcome;
}): void {
  const events = input.store.list(input.runId);
  const ordinaryEvents = events.filter(
    (event) => event.type !== "eval.replay.linked",
  );
  if (ordinaryEvents.length === 0) {
    throw new Error(
      `ordinary runner returned without ordinary event evidence for ${input.runId}`,
    );
  }
  if (events.some((event) => event.type === "eval.replay.linked")) {
    throw new Error(
      `ordinary evidence for ${input.runId} was linked outside this eval invocation`,
    );
  }
  const creationEvents = ordinaryEvents.filter(
    (event) => event.type === "run.created",
  );
  if (
    creationEvents.length !== 1 ||
    (creationEvents[0]?.payload as { evalReplayInvocationId?: unknown } | undefined)
        ?.evalReplayInvocationId !== input.invocationId
  ) {
    throw new Error(
      `ordinary runner returned without matching invocation evidence for ${input.runId}`,
    );
  }
  if (
    input.outcome === "completed" &&
    !ordinaryEvents.some((event) => event.type === "run.completed")
  ) {
    throw new Error(
      `ordinary runner returned without completed terminal evidence for ${input.runId}`,
    );
  }
  if (
    input.outcome === "failed" &&
    !ordinaryEvents.some(
      (event) =>
        event.type === "run.failed" ||
        event.type === "run.blocked" ||
        event.type === "run.cancelled",
    )
  ) {
    throw new Error(
      `ordinary runner failed without failed terminal evidence for ${input.runId}`,
    );
  }
  input.store.append({
    runId: input.runId,
    type: "eval.replay.linked",
    payload: {
      schemaVersion: "nitely.eval-replay-link.v1",
      cohortId: input.plan.cohortId,
      caseId: input.plan.caseId,
      ...(input.plan.baselineCohortId
        ? { baselineCohortId: input.plan.baselineCohortId }
        : {}),
      baselineRunId: input.plan.baselineRunId,
      manifestSha256: input.plan.manifestSha256,
      sourceRevision: input.plan.sourceRevision,
      allowedNondeterminism: input.plan.allowedNondeterminism,
      invocationId: input.invocationId,
      outcome: input.outcome,
    },
  });
}

export async function executeEvalReplay(
  plan: EvalReplayPlan,
  dependencies: ExecuteEvalReplayDependencies = {},
): Promise<{ runId: string; result: RunFlowResult }> {
  if (plan.status !== "ready") {
    throw new Error(
      `eval replay is incompatible: ${plan.findings.map((finding) => finding.code).join(", ")}`,
    );
  }
  assertValidReplayLinkPlan(plan);
  const refreshed = await planEvalReplay({
    repoPath: plan.runInput.repoPath,
    manifest: plan.manifest,
    manifestSha256: plan.manifestSha256,
    caseId: plan.caseId,
  });
  if (refreshed.status !== "ready") {
    throw new Error(
      `eval replay became incompatible: ${refreshed.findings.map((finding) => finding.code).join(", ")}`,
    );
  }
  const runId = (dependencies.createRunId ?? (() => `eval-${randomUUID()}`))();
  validateRunId(runId);
  const invocationId = randomUUID();
  const path = eventStorePath(refreshed.runInput.repoPath);
  const openEventStore = dependencies.openEventStore ??
    ((storePath: string) => new EventStore(storePath));
  await mkdir(dirname(path), { recursive: true });
  const admissionStore = openEventStore(path);
  try {
    if (admissionStore.list(runId).length > 0) {
      throw new Error(`run id ${runId} already has events`);
    }
  } finally {
    admissionStore.close();
  }

  let outcome: EvalReplayOutcome = "failed";
  let result: RunFlowResult | undefined;
  let operationFailed = false;
  let operationError: unknown;
  let linkAllowed = true;
  try {
    result = await (
      dependencies.runOrdinaryFlow ??
      (async (runInput, chosenRunId) =>
        await runFlow(runInput, { createRunId: () => chosenRunId }))
    )(
      { ...refreshed.runInput, evalReplayInvocationId: invocationId },
      runId,
    );
    if (result.runId !== runId) {
      linkAllowed = false;
      throw new Error(
        `ordinary runner returned run id ${result.runId}, expected ${runId}`,
      );
    }
    outcome = result.status === "awaiting-approval"
      ? "awaiting-approval"
      : "completed";
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let linkFailed = false;
  let linkError: unknown;
  if (linkAllowed) {
    let linkStore: EventStore | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      linkStore = openEventStore(path);
      if (ordinaryEvidenceExists(linkStore, runId)) {
        appendEvalReplayLink({
          store: linkStore,
          runId,
          plan: refreshed,
          invocationId,
          outcome,
        });
      } else if (!operationFailed) {
        throw new Error(
          `ordinary runner returned without ordinary event evidence for ${runId}`,
        );
      }
    } catch (error) {
      linkFailed = true;
      linkError = error;
    } finally {
      if (linkStore) {
        try {
          linkStore.close();
        } catch (error) {
          if (!linkFailed) {
            linkFailed = true;
            linkError = error;
          }
        }
      }
    }
  }

  if (operationFailed && linkFailed) {
    throw new AggregateError(
      [operationError, linkError],
      `eval replay operation and link persistence both failed for ${runId}`,
    );
  }
  if (operationFailed) throw operationError;
  if (linkFailed) throw linkError;
  if (!result) {
    throw new Error(`ordinary runner did not return a result for ${runId}`);
  }
  return { runId, result };
}
