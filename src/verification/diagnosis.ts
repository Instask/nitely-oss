import type { FlowGraph } from "../flow/load.js";
import { outputContract, type Stage } from "../flow/schema.js";
import type { OrchestratorRecommendation } from "../policy/decide.js";

export type VerificationFailureClassification =
  | "implementation"
  | "spec"
  | "environment"
  | "unclear";

export type VerificationFailureConfidence = "high" | "medium" | "low";

export interface VerificationFailureDiagnosis {
  stageId: string;
  stageType: Stage["type"];
  attempt: number;
  maxAttempts: number;
  classification: VerificationFailureClassification;
  confidence: VerificationFailureConfidence;
  reason: string;
  evidence: string[];
  targetStage?: string;
  targetArtifact?: string;
  recommendedAction: "rework" | "retry" | "escalate";
  recommendation?: OrchestratorRecommendation;
}

interface ReworkCandidate {
  targetArtifact: string;
  targetStage: string;
  label: string;
}

export interface DiagnoseVerificationFailureInput {
  stage: Stage;
  stages: Stage[];
  graph: FlowGraph;
  attempt: number;
  maxAttempts: number;
  error: string;
  validReworkTargets: ReadonlySet<string>;
  validReworkStages: ReadonlySet<string>;
}

const VERIFICATION_PATTERN =
  /\b(verify|verification|verified|test|tests|testing|e2e|end[-_ ]?to[-_ ]?end|playwright|cypress|vitest|jest|pytest|rspec|check|typecheck|tsc|lint|build|conformance|acceptance|qa|smoke)\b/i;

const ENVIRONMENT_PATTERN =
  /\b(timeout|timed out|etimedout|econnreset|econnrefused|eaddrinuse|enotfound|eai_again|network|rate limit|429|5\d\d|service unavailable|registry|npm err|pnpm fetch|command not found|executable doesn't exist|no such file or directory|permission denied|browser executable)\b/i;

const SPEC_FAILURE_PATTERN =
  /\b(spec mismatch|requirement mismatch|acceptance criteria|acceptance mismatch|expected behavior|ambiguous requirement|missing requirement|requirements changed|planning mismatch|design mismatch|contradictory requirement|out of scope)\b/i;

const SPEC_TARGET_PATTERN =
  /\b(spec|plan|planning|design|requirement|brief|ticket|issue)\b/i;
const IMPLEMENTATION_TARGET_PATTERN =
  /\b(implement|implementation|code|patch|diff|fix|solution|source|worktree)\b/i;

// Lines that open a failing-test block in common runners: vitest/jest/mocha
// FAIL or ×/✗/✖ markers, jest ●, pytest FAILED, and tsc diagnostics.
const STRUCTURED_FAILURE_LINE =
  /^\s*(FAIL\b|FAILED\b|●\s|[×✗✖]\s)|\berror TS\d+:/;
const ERROR_LINE = /^\s*(Error:|[A-Z]\w*Error\b:)/;
// Lines that end a block: a passing marker, a runner's console-output header,
// a horizontal separator, or the run summary.
const BLOCK_END_LINE =
  /^\s*(✓|√|PASS\b|ok\b|stdout \||stderr \||[⎯─]{3,}|Test Files\b|Tests\b)/;
const MAX_BLOCK_LINES = 12;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Splits test-runner output into the blocks that describe failures, so a
 * passing test whose name or console output happens to contain "network",
 * "registry", "timeout" or a 5xx-looking number cannot decide how the failure
 * is classified. Returns no blocks when the output has no recognizable
 * failure markers; callers then fall back to the whole text.
 */
function failureBlocks(error: string): string[][] {
  const lines = error.split(/\r?\n/);
  const opener = lines.some((line) => STRUCTURED_FAILURE_LINE.test(line))
    ? STRUCTURED_FAILURE_LINE
    : ERROR_LINE;
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (opener.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current && (BLOCK_END_LINE.test(line) || current.length >= MAX_BLOCK_LINES)) {
      current = undefined;
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

function boundedText(value: string, limit = 700): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= limit) return compacted;
  return `${compacted.slice(0, limit - 1)}...`;
}

function stageDiagnosticText(stage: Stage, stages: Stage[]): string {
  const parts = [
    stage.id,
    "name" in stage ? stage.name : undefined,
    "command" in stage ? stage.command : undefined,
    ...stage.inputs,
    ...stage.outputs.flatMap((output) => {
      const contract = outputContract(output);
      return [
        contract.id,
        contract.name,
        contract.type,
        contract.description,
        contract.mediaType,
      ];
    }),
    ...stage.inputs.flatMap((artifact) => {
      const producer = stages.find((candidate) =>
        candidate.outputs.some((output) => outputContract(output).id === artifact),
      );
      return producer ? [producer.id] : [];
    }),
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function isDiagnosableVerificationStage(stage: Stage, stages: Stage[]): boolean {
  if (stage.type === "gate" && stage.mode === "review") return false;
  if (stage.type !== "command" && stage.type !== "gate") return false;
  return VERIFICATION_PATTERN.test(stageDiagnosticText(stage, stages));
}

function reworkCandidates(input: DiagnoseVerificationFailureInput): ReworkCandidate[] {
  return input.stage.inputs
    .map((artifact) => {
      const targetStage = input.graph.producerByArtifact.get(artifact);
      if (!targetStage) return undefined;
      if (!input.validReworkTargets.has(artifact)) return undefined;
      if (!input.validReworkStages.has(targetStage)) return undefined;
      const producer = input.stages.find((stage) => stage.id === targetStage);
      const output = producer?.outputs
        .map(outputContract)
        .find((contract) => contract.id === artifact);
      return {
        targetArtifact: artifact,
        targetStage,
        label: [
          artifact,
          targetStage,
          output?.name,
          output?.type,
          output?.description,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" "),
      };
    })
    .filter((candidate): candidate is ReworkCandidate => candidate !== undefined);
}

function preferredCandidate(
  candidates: ReworkCandidate[],
  kind: "implementation" | "spec",
): ReworkCandidate | undefined {
  if (kind === "spec") {
    return candidates.find((candidate) => SPEC_TARGET_PATTERN.test(candidate.label));
  }
  return (
    candidates.find((candidate) =>
      IMPLEMENTATION_TARGET_PATTERN.test(candidate.label),
    ) ??
    candidates.find((candidate) => !SPEC_TARGET_PATTERN.test(candidate.label))
  );
}

function evidenceFor(
  input: DiagnoseVerificationFailureInput,
  blocks: string[][],
): string[] {
  const failureLines = blocks.length > 0 ? blocks.flat() : input.error.split(/\r?\n/);
  const evidence = [
    `${input.stage.type} stage ${input.stage.id} failed on attempt ${input.attempt}/${input.maxAttempts}.`,
    "command" in input.stage ? `Command: ${input.stage.command}` : undefined,
    ...failureLines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, blocks.length > 0 ? 12 : 6)
      .map((line) => `Failure: ${boundedText(line, 300)}`),
  ];
  return evidence.filter((line): line is string => line !== undefined);
}

function reworkRecommendation(input: {
  diagnosis: Omit<VerificationFailureDiagnosis, "recommendedAction" | "recommendation">;
  target: ReworkCandidate;
  kind: "implementation" | "spec";
}): OrchestratorRecommendation {
  const targetLabel = input.target.targetArtifact;
  const fixVerb =
    input.kind === "spec"
      ? "Revise planning/spec artifact"
      : "Fix implementation artifact";
  return {
    action: "rework",
    targetStage: input.target.targetStage,
    targetArtifact: input.target.targetArtifact,
    reason: input.diagnosis.reason,
    instructions: `${fixVerb} ${targetLabel} so downstream verification stage ${input.diagnosis.stageId} can pass.`,
    context: [
      `Verification diagnosis classified this as ${input.diagnosis.classification} with ${input.diagnosis.confidence} confidence.`,
      ...input.diagnosis.evidence,
    ].join("\n"),
  };
}

function repeatedFailure(input: DiagnoseVerificationFailureInput): boolean {
  return input.attempt > 1;
}

export function diagnoseVerificationFailure(
  input: DiagnoseVerificationFailureInput,
): VerificationFailureDiagnosis | undefined {
  if (!isDiagnosableVerificationStage(input.stage, input.stages)) {
    return undefined;
  }

  // Test runners color their output, so a FAIL marker arrives as
  // "\x1b[41m\x1b[1m FAIL"; strip escape sequences before reading lines.
  const plainError = input.error.replaceAll(ANSI_ESCAPE, "");
  const blocks = failureBlocks(plainError);
  const evidence = evidenceFor({ ...input, error: plainError }, blocks);
  const candidates = reworkCandidates(input);
  // With recognizable failure blocks, the failure is environmental only when
  // every failing block is; one code failure among them still needs rework.
  const environmental = blocks.length > 0
    ? blocks.every((block) => ENVIRONMENT_PATTERN.test(block.join("\n")))
    : ENVIRONMENT_PATTERN.test(plainError);
  const error = blocks.length > 0
    ? blocks.map((block) => block.join("\n")).join("\n")
    : plainError;

  if (environmental) {
    const repeated = repeatedFailure(input);
    const reason = repeated
      ? `verification failure appears environmental or flaky and repeated on ${input.stage.id}; escalate instead of reworking artifacts`
      : `verification failure appears environmental or flaky on ${input.stage.id}; retry the same stage before rework`;
    const recommendation: OrchestratorRecommendation | undefined = repeated
      ? { action: "escalate", reason }
      : undefined;
    return {
      stageId: input.stage.id,
      stageType: input.stage.type,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      classification: "environment",
      confidence: "medium",
      reason,
      evidence,
      recommendedAction: repeated ? "escalate" : "retry",
      recommendation,
    };
  }

  if (SPEC_FAILURE_PATTERN.test(error)) {
    const target = preferredCandidate(candidates, "spec");
    if (target) {
      const base = {
        stageId: input.stage.id,
        stageType: input.stage.type,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        classification: "spec" as const,
        confidence: "high" as const,
        reason: `verification failure on ${input.stage.id} points to spec or planning rework`,
        evidence,
        targetStage: target.targetStage,
        targetArtifact: target.targetArtifact,
      };
      return {
        ...base,
        recommendedAction: "rework",
        recommendation: reworkRecommendation({
          diagnosis: base,
          target,
          kind: "spec",
        }),
      };
    }
  }

  const implementationTarget = preferredCandidate(candidates, "implementation");
  if (implementationTarget) {
    const base = {
      stageId: input.stage.id,
      stageType: input.stage.type,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      classification: "implementation" as const,
      confidence: "high" as const,
      reason: `verification failure on ${input.stage.id} points to implementation rework`,
      evidence,
      targetStage: implementationTarget.targetStage,
      targetArtifact: implementationTarget.targetArtifact,
    };
    return {
      ...base,
      recommendedAction: "rework",
      recommendation: reworkRecommendation({
        diagnosis: base,
        target: implementationTarget,
        kind: "implementation",
      }),
    };
  }

  const repeated = repeatedFailure(input);
  const reason = repeated
    ? `verification failure on ${input.stage.id} is still unclear after repeated attempts; escalate instead of looping`
    : `verification failure on ${input.stage.id} has no high-confidence upstream target yet`;
  const recommendation: OrchestratorRecommendation | undefined = repeated
    ? { action: "escalate", reason }
    : undefined;
  return {
    stageId: input.stage.id,
    stageType: input.stage.type,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    classification: "unclear",
    confidence: "low",
    reason,
    evidence,
    recommendedAction: repeated ? "escalate" : "retry",
    recommendation,
  };
}
