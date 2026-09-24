import { createHash } from "node:crypto";

import { redactText } from "./context/redaction.js";

export type CiFailureClassification =
  | "code/configuration"
  | "test-expectation"
  | "environment/infrastructure"
  | "flaky/non-reproducible"
  | "spec/requirements"
  | "unsupported/unclear";

export type CiRepairOutcome =
  | "repaired"
  | "needs-human"
  | "infra-or-flaky"
  | "stale"
  | "unsupported";

export interface CiFailureObservation {
  provider: "github" | string;
  repository: string;
  pullRequest: number;
  checkSuiteId?: string;
  workflowRunId?: string;
  checkRunId: string;
  checkName: string;
  headSha: string;
  conclusion: string;
  status: string;
  attemptUrl?: string;
  failureOutput: string;
  observedAt: string;
}

export interface RedactedCiFailureObservation
  extends Omit<CiFailureObservation, "failureOutput"> {
  failureOutput: string;
  outputTruncated: boolean;
}

export interface CiRepairAdmissionInput {
  observation: CiFailureObservation;
  currentHeadSha: string;
  remoteObservationCount: number;
  localChecksPassed?: boolean;
  reviewPassed?: boolean;
}

export type CiRepairAdmission =
  | { allowed: true; classification: CiFailureClassification; confidence: "high" | "medium" | "low" }
  | { allowed: false; outcome: CiRepairOutcome; reason: string; classification?: CiFailureClassification };

export interface CiRepairCycleDependencies {
  applySamePullRequestRepair(input: {
    observation: RedactedCiFailureObservation;
    diagnosis: CiRepairAdmission & { allowed: true };
  }): Promise<{ updatedHeadSha: string; runId?: string; worktreePath?: string }>;
  runLocalChecks(): Promise<boolean>;
  runStructuredReview(): Promise<boolean>;
  restoreRepairContext?(input: { updatedHeadSha: string }): Promise<void>;
  observeRemoteResult(): Promise<{
    headSha: string;
    passed: boolean;
    failureOutput?: string;
  }>;
}

export interface CiRepairCycleResult {
  outcome: CiRepairOutcome;
  sourceIdentity: string;
  idempotencyKey: string;
  remoteObservationCount: number;
  reason?: string;
}

export const MAX_CI_REPAIR_REMOTE_OBSERVATIONS = 2;
export const MAX_CI_FAILURE_OUTPUT_BYTES = 8_192;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function ciRepairSourceIdentity(observation: Pick<CiFailureObservation, "provider" | "repository" | "pullRequest" | "checkRunId" | "headSha">): string {
  return [
    observation.provider,
    observation.repository,
    observation.pullRequest,
    observation.checkRunId,
    observation.headSha,
  ].join(":");
}

export function ciRepairIdempotencyKey(
  observation: Pick<CiFailureObservation, "provider" | "repository" | "pullRequest" | "checkRunId" | "headSha">,
): string {
  return sha256(`nitely-ci-repair\0${ciRepairSourceIdentity(observation)}`);
}

export function redactCiFailureOutput(
  value: string,
  secrets: readonly string[] = [],
  maxBytes = MAX_CI_FAILURE_OUTPUT_BYTES,
): RedactedCiFailureObservation["failureOutput"] {
  return redactCiFailureOutputWithStatus(value, secrets, maxBytes).value;
}

function redactCiFailureOutputWithStatus(
  value: string,
  secrets: readonly string[],
  maxBytes: number,
): { value: string; truncated: boolean } {
  let output = (redactText(value, secrets) ?? "").replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const bytes = Buffer.from(output, "utf8");
  return bytes.byteLength <= maxBytes
    ? { value: output, truncated: false }
    : { value: `${utf8Prefix(bytes, maxBytes)}\n[TRUNCATED]`, truncated: true };
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.max(0, Math.min(maxBytes, bytes.byteLength));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function redactCiFailureObservation(
  observation: CiFailureObservation,
  secrets: readonly string[] = [],
  maxBytes = MAX_CI_FAILURE_OUTPUT_BYTES,
): RedactedCiFailureObservation {
  const redacted = redactCiFailureOutputWithStatus(
    observation.failureOutput,
    secrets,
    maxBytes,
  );
  return {
    ...observation,
    failureOutput: redacted.value,
    outputTruncated: redacted.truncated,
  };
}

export function classifyCiFailure(output: string): {
  classification: CiFailureClassification;
  confidence: "high" | "medium" | "low";
  reason: string;
} {
  const text = output.toLowerCase();
  if (/(runner unavailable|out of disk|no space left|network timeout|service unavailable|infrastructure)/u.test(text)) {
    return {
      classification: "environment/infrastructure",
      confidence: "high",
      reason: "failure output identifies runner or service infrastructure",
    };
  }
  if (/(?:ci|runner|harness).{0,80}(?:flaky|flake|intermittent|non-determin|race condition)|(?:flaky|flake|intermittent|non-determin|race condition).{0,80}(?:ci|runner|harness)/u.test(text)) {
    return {
      classification: "flaky/non-reproducible",
      confidence: "high",
      reason: "failure output identifies non-deterministic behavior",
    };
  }
  if (/(assert|expected .* received|snapshot|test failed|tests? failed)/u.test(text)) {
    return {
      classification: "test-expectation",
      confidence: "medium",
      reason: "failure output points to a deterministic test expectation",
    };
  }
  if (/(type error|syntax error|compile|build failed|lint|configuration|cannot find module)/u.test(text)) {
    return {
      classification: "code/configuration",
      confidence: "medium",
      reason: "failure output points to code, build, lint, or configuration",
    };
  }
  if (/(requirement|specification|acceptance criteria|expected behavior)/u.test(text)) {
    return {
      classification: "spec/requirements",
      confidence: "low",
      reason: "failure output points to an intent or requirement mismatch",
    };
  }
  return {
    classification: "unsupported/unclear",
    confidence: "low",
    reason: "failure output does not support a safe repair classification",
  };
}

export function evaluateCiRepairAdmission(
  input: CiRepairAdmissionInput,
): CiRepairAdmission {
  if (input.observation.provider !== "github") {
    return { allowed: false, outcome: "unsupported", reason: "only GitHub checks are supported" };
  }
  if (input.observation.headSha !== input.currentHeadSha) {
    return { allowed: false, outcome: "stale", reason: "pull request head changed after the check was observed" };
  }
  if (input.remoteObservationCount >= MAX_CI_REPAIR_REMOTE_OBSERVATIONS) {
    return { allowed: false, outcome: "needs-human", reason: "remote CI observation budget is exhausted" };
  }
  const diagnosis = classifyCiFailure(input.observation.failureOutput);
  if (diagnosis.classification === "environment/infrastructure" || diagnosis.classification === "flaky/non-reproducible") {
    return { allowed: false, outcome: "infra-or-flaky", ...diagnosis };
  }
  if (diagnosis.classification === "unsupported/unclear" || diagnosis.classification === "spec/requirements") {
    return { allowed: false, outcome: "unsupported", ...diagnosis };
  }
  if (input.localChecksPassed === false) {
    return { allowed: false, outcome: "needs-human", reason: "deterministic local checks failed", classification: diagnosis.classification };
  }
  if (input.reviewPassed === false) {
    return { allowed: false, outcome: "needs-human", reason: "structured review verdict did not pass", classification: diagnosis.classification };
  }
  return { allowed: true, classification: diagnosis.classification, confidence: diagnosis.confidence };
}

export async function executeCiRepairCycle(
  input: CiRepairAdmissionInput & { secrets?: readonly string[] },
  dependencies: CiRepairCycleDependencies,
): Promise<CiRepairCycleResult> {
  const sourceIdentity = ciRepairSourceIdentity(input.observation);
  const idempotencyKey = ciRepairIdempotencyKey(input.observation);
  const admission = evaluateCiRepairAdmission(input);
  if (!admission.allowed) {
    return {
      outcome: admission.outcome,
      sourceIdentity,
      idempotencyKey,
      remoteObservationCount: input.remoteObservationCount,
      reason: admission.reason,
    };
  }
  const observation = redactCiFailureObservation(
    input.observation,
    input.secrets ?? [],
  );
  const repair = await dependencies.applySamePullRequestRepair({
    observation,
    diagnosis: admission,
  });
  if (!(await dependencies.runLocalChecks())) {
    return {
      outcome: "needs-human",
      sourceIdentity,
      idempotencyKey,
      remoteObservationCount: input.remoteObservationCount,
      reason: "deterministic local checks failed after repair",
    };
  }
  if (!(await dependencies.runStructuredReview())) {
    return {
      outcome: "needs-human",
      sourceIdentity,
      idempotencyKey,
      remoteObservationCount: input.remoteObservationCount,
      reason: "structured review verdict did not pass",
    };
  }
  const remote = await dependencies.observeRemoteResult();
  const remoteObservationCount = input.remoteObservationCount + 1;
  if (remote.headSha !== repair.updatedHeadSha) {
    return {
      outcome: "stale",
      sourceIdentity,
      idempotencyKey,
      remoteObservationCount,
      reason: "post-repair CI result belongs to a different pull request head",
    };
  }
  return {
    outcome: remote.passed ? "repaired" : "needs-human",
    sourceIdentity,
    idempotencyKey,
    remoteObservationCount,
    ...(remote.passed
      ? {}
      : { reason: "remote CI still fails after the bounded repair" }),
  };
}
