import { randomUUID } from "node:crypto";

export const RUNNER_CONTROL_PLANE_SCHEMA_VERSION =
  "runner-control-plane.v1" as const;

export type RunnerControlPlaneRedactionStatus =
  | "metadata_only"
  | "sanitized"
  | "explicit_raw_upload";

export type ControlPlaneToRunnerEventKind =
  | "runner.register.accepted"
  | "task.assigned"
  | "task.cancel_requested"
  | "policy.updated"
  | "evidence.upload_requested";

export type RunnerToControlPlaneEventKind =
  | "runner.heartbeat"
  | "task.accepted"
  | "task.rejected"
  | "run.preparing"
  | "run.started"
  | "stage.updated"
  | "run.blocked"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "evidence.reported"
  | "runner.error";

export interface RunnerProtocolEvent<
  Kind extends string = string,
  Payload extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: string;
  schemaVersion: typeof RUNNER_CONTROL_PLANE_SCHEMA_VERSION;
  tenantId: string;
  runnerId: string;
  taskId?: string;
  runId?: string;
  sequence?: number;
  createdAt: string;
  kind: Kind;
  payload: Payload;
  redactionStatus: RunnerControlPlaneRedactionStatus;
  policyVersion: string;
}

export type RunnerToControlPlaneEvent = RunnerProtocolEvent<
  RunnerToControlPlaneEventKind
>;

export type ControlPlaneToRunnerEvent = RunnerProtocolEvent<
  ControlPlaneToRunnerEventKind
>;

export interface RunnerPolicySnapshot {
  tenantId: string;
  runnerId: string;
  policyVersion: string;
  allowedRepositories: string[];
  allowedUploadRedactionStatuses?: RunnerControlPlaneRedactionStatus[];
}

export interface RunnerRepositoryRef {
  repoId: string;
  name?: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

export interface RunnerTaskAssignment {
  taskId: string;
  repoId: string;
  repository?: RunnerRepositoryRef;
  sourceRevision?: string;
  flowId: string;
  flowPath?: string;
  policyVersion: string;
  title?: string;
  inputs?: Record<string, unknown>;
}

export interface RunnerEvidenceArtifactMetadata {
  [key: string]: unknown;
  artifactId?: string;
  id?: string;
  kind?: string;
  name?: string;
  uri?: string;
  mediaType?: string;
  bytes?: number;
  redactionStatus?: RunnerControlPlaneRedactionStatus;
}

export interface RunnerEvidenceReportedPayload {
  runId: string;
  artifacts: RunnerEvidenceArtifactMetadata[];
  redactionStatus?: RunnerControlPlaneRedactionStatus;
}

export type AssignmentRejectionReason =
  | "policy_version_mismatch"
  | "repository_not_allowed";

export type AssignmentDecision =
  | { status: "accepted" }
  | {
      status: "rejected";
      reason: AssignmentRejectionReason;
      safeMessage: string;
    };

export class MetadataBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataBoundaryError";
  }
}

export class RunnerProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerProtocolValidationError";
  }
}

export interface CreateRunnerProtocolEventInput<
  Kind extends RunnerToControlPlaneEventKind | ControlPlaneToRunnerEventKind,
> {
  kind: Kind;
  tenantId: string;
  runnerId: string;
  policyVersion: string;
  payload: Record<string, unknown>;
  taskId?: string;
  runId?: string;
  sequence?: number;
  redactionStatus?: RunnerControlPlaneRedactionStatus;
  now?: () => Date;
  createId?: () => string;
}

export function createRunnerProtocolEvent<
  Kind extends RunnerToControlPlaneEventKind | ControlPlaneToRunnerEventKind,
>(input: CreateRunnerProtocolEventInput<Kind>): RunnerProtocolEvent<Kind> {
  validateProtocolSegment("tenant id", input.tenantId);
  validateProtocolSegment("runner id", input.runnerId);
  validatePolicyVersion(input.policyVersion);
  if (input.taskId !== undefined) {
    validateProtocolSegment("task id", input.taskId);
  }
  if (input.runId !== undefined) {
    validateProtocolSegment("run id", input.runId);
  }
  if (
    input.sequence !== undefined &&
    (!Number.isInteger(input.sequence) || input.sequence < 0)
  ) {
    throw new RunnerProtocolValidationError(
      "runner protocol sequence must be a non-negative integer",
    );
  }

  return {
    eventId: input.createId?.() ?? randomUUID(),
    schemaVersion: RUNNER_CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: input.tenantId,
    runnerId: input.runnerId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    kind: input.kind,
    payload: input.payload,
    redactionStatus: input.redactionStatus ?? "metadata_only",
    policyVersion: input.policyVersion,
  };
}

export function createControlPlaneEvent(
  input: CreateRunnerProtocolEventInput<ControlPlaneToRunnerEventKind>,
): ControlPlaneToRunnerEvent {
  return createRunnerProtocolEvent(input) as ControlPlaneToRunnerEvent;
}

export function createRunnerEvent(
  input: CreateRunnerProtocolEventInput<RunnerToControlPlaneEventKind>,
): RunnerToControlPlaneEvent {
  return createRunnerProtocolEvent(input) as RunnerToControlPlaneEvent;
}

export function decideRunnerAssignment(input: {
  policy: RunnerPolicySnapshot;
  assignment: RunnerTaskAssignment;
}): AssignmentDecision {
  if (input.assignment.policyVersion !== input.policy.policyVersion) {
    return {
      status: "rejected",
      reason: "policy_version_mismatch",
      safeMessage: `assignment policy ${input.assignment.policyVersion} does not match runner policy ${input.policy.policyVersion}`,
    };
  }
  if (!input.policy.allowedRepositories.includes(input.assignment.repoId)) {
    return {
      status: "rejected",
      reason: "repository_not_allowed",
      safeMessage: `repository ${input.assignment.repoId} is not allowed for runner ${input.policy.runnerId}`,
    };
  }
  return { status: "accepted" };
}

export function runnerEventForAssignmentDecision(input: {
  policy: RunnerPolicySnapshot;
  assignment: RunnerTaskAssignment;
  now?: () => Date;
  createId?: () => string;
}): RunnerToControlPlaneEvent {
  const decision = decideRunnerAssignment(input);
  if (decision.status === "accepted") {
    return createRunnerEvent({
      kind: "task.accepted",
      tenantId: input.policy.tenantId,
      runnerId: input.policy.runnerId,
      taskId: input.assignment.taskId,
      policyVersion: input.policy.policyVersion,
      now: input.now,
      createId: input.createId,
      payload: {
        taskId: input.assignment.taskId,
        repoId: input.assignment.repoId,
        ...(input.assignment.sourceRevision
          ? { sourceRevision: input.assignment.sourceRevision }
          : {}),
        flowId: input.assignment.flowId,
        ...(input.assignment.flowPath
          ? { flowPath: input.assignment.flowPath }
          : {}),
        policyVersion: input.policy.policyVersion,
      },
    });
  }

  return createRunnerEvent({
    kind: "task.rejected",
    tenantId: input.policy.tenantId,
    runnerId: input.policy.runnerId,
    taskId: input.assignment.taskId,
    policyVersion: input.policy.policyVersion,
    now: input.now,
    createId: input.createId,
    payload: {
      taskId: input.assignment.taskId,
      reason: decision.reason,
      safeMessage: decision.safeMessage,
    },
  });
}

export function assertMetadataBoundary(input: {
  event: RunnerToControlPlaneEvent;
  policy: RunnerPolicySnapshot;
}): void {
  const allowed =
    input.policy.allowedUploadRedactionStatuses ?? ["metadata_only", "sanitized"];
  if (!allowed.includes(input.event.redactionStatus)) {
    throw new MetadataBoundaryError(
      `redaction status ${input.event.redactionStatus} is not allowed by policy ${input.policy.policyVersion}`,
    );
  }
  if (input.event.redactionStatus === "explicit_raw_upload") {
    return;
  }

  const violations = findSensitivePayloadPaths(input.event.payload);
  if (violations.length > 0) {
    throw new MetadataBoundaryError(
      `metadata-only runner event contains disallowed raw fields: ${violations.join(", ")}`,
    );
  }
}

export function assertRunnerEventEnvelope(input: {
  event: RunnerToControlPlaneEvent;
  policy: RunnerPolicySnapshot;
}): void {
  if (input.event.schemaVersion !== RUNNER_CONTROL_PLANE_SCHEMA_VERSION) {
    throw new RunnerProtocolValidationError(
      `unsupported runner protocol schema ${input.event.schemaVersion}`,
    );
  }
  if (input.event.tenantId !== input.policy.tenantId) {
    throw new RunnerProtocolValidationError("runner event tenant mismatch");
  }
  if (input.event.runnerId !== input.policy.runnerId) {
    throw new RunnerProtocolValidationError("runner event identity mismatch");
  }
  if (input.event.policyVersion !== input.policy.policyVersion) {
    throw new RunnerProtocolValidationError("runner event policy mismatch");
  }
}

function validateProtocolSegment(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(value)) {
    throw new RunnerProtocolValidationError(`invalid ${kind}: ${value}`);
  }
}

function validatePolicyVersion(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(value)) {
    throw new RunnerProtocolValidationError(`invalid policy version: ${value}`);
  }
}

const sensitivePayloadKeys = new Set([
  "accessToken",
  "adminToken",
  "apiKey",
  "artifactContent",
  "auth",
  "authorization",
  "bearerToken",
  "content",
  "cookie",
  "credential",
  "credentials",
  "diff",
  "fileContent",
  "fullLog",
  "log",
  "logs",
  "patch",
  "password",
  "prompt",
  "privateKey",
  "rawArtifact",
  "rawLog",
  "rawPrompt",
  "rawSource",
  "refreshToken",
  "registrationSecret",
  "runnerToken",
  "secret",
  "sessionCookie",
  "sessionToken",
  "sourceCode",
  "stderr",
  "stdout",
  "token",
]);

function findSensitivePayloadPaths(
  value: unknown,
  path = "payload",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSensitivePayloadPaths(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "string") {
    return looksLikeSecret(value) ? [path] : [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const violations: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (sensitivePayloadKeys.has(key)) {
      violations.push(childPath);
      continue;
    }
    violations.push(...findSensitivePayloadPaths(child, childPath));
  }
  return violations;
}

function looksLikeSecret(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
  );
}
