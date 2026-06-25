import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  redactContextManifestEntry,
  type ContextManifestEntry,
} from "../context/manifest.js";
import { readArtifactRegistry } from "../artifacts/registry.js";
import type {
  GateResult,
  GateReviewOutput,
  GateStateValue,
  RunArtifact,
} from "../artifacts/types.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import type { Stage } from "../flow/schema.js";
import {
  eventStorePath,
  getProjectedRun,
  getProjectedRunLogs,
  listProjectedRuns,
  type ProjectedAttempt,
  type ProjectedAttemptBudget,
  type ProjectedBudgetSummary,
  type ProjectedContextUsage,
  type ProjectedRun,
  type ProjectedRunBlocker,
  type ProjectedRunStatus,
  type ProjectedRuntimeUsageTotal,
  type ProjectedStage,
  sumContextUsage,
  sumRuntimeUsage,
} from "../run/project.js";
import type { OrchestratorDecisionEvent } from "../policy/decide.js";
import type { PlanningApprovalStatus } from "../work-items/planning.js";
import { WebInputError, WebNotFoundError } from "./errors.js";
import { redactForWeb, redactUnknownForWeb } from "./redaction.js";

export type WebRunStatus =
  | "completed"
  | "running"
  | "failed"
  | "blocked"
  | "incomplete"
  | "interrupted"
  | "cancelled";

export type WebStageState =
  | "pending"
  | "running"
  | "gate-checking"
  | "awaiting-orchestrator"
  | "retrying"
  | "reworking"
  | "escalated"
  | "failed"
  | "blocked"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface WebSessionContextItem {
  id: string;
  sourceUri?: string;
  mediaType?: string;
  filename?: string;
  kind?: "input" | "generated" | "local" | "external";
  path?: string;
}

export interface WebSessionTimelineItem {
  stageId: string;
  stageType?: string;
  gate?: GateResult;
  resumedFrom?: string;
  status: WebRunStatus | "started";
  state: WebStageState;
  latestOutput?: string;
  latestDecision?: OrchestratorDecisionEvent;
  currentAttempt?: number;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  durationMs?: number;
  error?: string;
  blocker?: ProjectedRunBlocker;
  attemptDirectory?: string;
  outputPath?: string;
  artifactManifestPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  generatedArtifactPaths?: string[];
  contextUsage?: ProjectedContextUsage;
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  budget?: ProjectedAttemptBudget;
  hasLogs: boolean;
  hasEvidence: boolean;
  hasDetails: boolean;
  details?: WebStageDetails;
}

export type RunEvidenceKind =
  | "input"
  | "stage"
  | "artifact"
  | "gate"
  | "external-effect";

export interface RunEvidenceItem {
  kind: RunEvidenceKind;
  label: string;
  at?: string;
  detail: Record<string, unknown>;
}

export interface WebRedactedLog {
  stageId: string;
  attempt: string;
  command?: string;
  stdout?: string;
  stderr?: string;
}

export interface WebStageDetailField {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}

export interface WebStageDetailArtifact {
  id: string;
  label: string;
  path?: string;
}

export interface WebStageDetailEvent {
  type: string;
  at: string;
  attempt?: number;
  summary?: string;
}

export interface WebStageDetails {
  fields: WebStageDetailField[];
  prompt?: string;
  stdout?: string;
  stderr?: string;
  artifacts: WebStageDetailArtifact[];
  events: WebStageDetailEvent[];
}

export interface WebReviewArtifact {
  stageId: string;
  attempt: string;
  path: string;
  content: string;
  severities: Record<string, number>;
}

export interface WebRunSummary {
  runId: string;
  sessionId: string;
  status: WebRunStatus;
  ownerId?: string;
  organizationId?: string;
  flowName?: string;
  flowPath?: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  worktreePath?: string;
  completedStages: string[];
  currentStage?: string;
  currentAttempt?: number;
  currentStageState?: WebStageState;
  latestOutputSummary?: string;
  latestDecision?: OrchestratorDecisionEvent;
  blocker?: ProjectedRunBlocker;
  inputs: Record<string, unknown>;
  changeRequestUrl?: string;
  prNumber?: number;
  prUrl?: string;
  taskId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  startedAt?: string;
  completedAt?: string;
  trigger?: unknown;
  priorRunId?: string;
  contextUsage?: ProjectedContextUsage;
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  budgetSummary?: ProjectedBudgetSummary;
}

export interface WebRunDetail extends WebRunSummary {
  evidence?: string;
  logs: WebRedactedLog[];
  artifacts: RunArtifact[];
  gates: GateResult[];
  contextManifest: WebSessionContextItem[];
  timeline: WebSessionTimelineItem[];
  evidenceTimeline: RunEvidenceItem[];
  reviewFindings: WebReviewArtifact[];
  parentRun?: WebRunSummary;
  childRuns: WebRunSummary[];
  budgetSummary?: ProjectedBudgetSummary;
}

function runsRoot(repoPath: string): string {
  return join(repoPath, ".nitely", "runs");
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/.test(runId)) {
    throw new WebInputError("invalid run id");
  }
}

function asRunStatus(value: unknown, fallback: WebRunStatus): WebRunStatus {
  return value === "completed" ||
    value === "running" ||
    value === "failed" ||
    value === "blocked" ||
    value === "incomplete" ||
    value === "interrupted" ||
    value === "cancelled"
    ? value
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function webBlocker(value: unknown): ProjectedRunBlocker | undefined {
  const record = asRecord(redactUnknownForWeb(value));
  const reason = asString(record.reason);
  if (!reason) return undefined;
  return {
    reason,
    stageId: asString(record.stageId),
    runtime: asString(record.runtime),
    message: asString(record.message),
    retryAfter: asString(record.retryAfter),
  };
}

function webGateResult(value: unknown): GateResult | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  const stageId = asString(record.stageId);
  const mode = asString(record.mode);
  const status = asString(record.status);
  if (
    !id ||
    !stageId ||
    (mode !== "deterministic" && mode !== "review") ||
    (status !== "passed" && status !== "failed")
  ) {
    return undefined;
  }
  const reviewedArtifacts = Array.isArray(record.reviewedArtifacts)
    ? record.reviewedArtifacts.filter(
        (artifact): artifact is string => typeof artifact === "string",
      )
    : undefined;
  const reviewOutputRecord = asRecord(record.reviewOutput);
  const reviewOutputId = asString(reviewOutputRecord.id);
  const reviewOutputPath = asString(reviewOutputRecord.path);
  const reviewOutputFilename = asString(reviewOutputRecord.filename);
  const reviewOutputMediaType = asString(reviewOutputRecord.mediaType);
  const reviewOutputContent = asString(reviewOutputRecord.content);
  const reviewOutput: GateReviewOutput | undefined =
    reviewOutputId &&
    reviewOutputPath &&
    reviewOutputFilename &&
    (reviewOutputMediaType === "text/markdown" ||
      reviewOutputMediaType === "text/plain") &&
    reviewOutputContent !== undefined &&
    typeof reviewOutputRecord.truncated === "boolean"
      ? {
          id: reviewOutputId,
          path: reviewOutputPath,
          filename: reviewOutputFilename,
          mediaType:
            reviewOutputMediaType === "text/markdown"
              ? "text/markdown"
              : "text/plain",
          content: reviewOutputContent,
          truncated: reviewOutputRecord.truncated,
        }
      : undefined;
  return {
    id,
    stageId,
    name: asString(record.name),
    mode,
    status,
    command: asString(record.command),
    runtime: asString(record.runtime),
    reviewedArtifacts,
    reviewOutput,
    reason: asString(record.reason),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    createdAt: asString(record.createdAt) ?? "",
  };
}

function parsePrNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = /\/pull\/(\d+)(?:\b|$|[/?#])/.exec(url);
  return match ? Number(match[1]) : undefined;
}

function triggerPriorRunId(trigger: unknown): string | undefined {
  return asString(asRecord(trigger).priorRunId);
}

function prMetadata(
  input: { changeRequestUrl?: string; trigger?: unknown; prNumber?: unknown; prUrl?: unknown },
): { prNumber?: number; prUrl?: string } {
  const trigger = asRecord(input.trigger);
  const prUrl =
    asString(input.prUrl) ??
    asString(trigger.prUrl) ??
    asString(trigger.pullRequestUrl) ??
    input.changeRequestUrl;
  const rawPrNumber =
    typeof input.prNumber === "number"
      ? input.prNumber
      : typeof trigger.prNumber === "number"
        ? trigger.prNumber
        : undefined;
  return {
    prUrl,
    prNumber: rawPrNumber ?? parsePrNumber(prUrl),
  };
}

function taskIdFromInputs(inputs: Record<string, unknown>): string | undefined {
  for (const value of Object.values(inputs)) {
    const record = asRecord(value);
    const sourceUri = asString(record.sourceUri) ?? asString(record.uri);
    const match = sourceUri?.match(/(?:^|\/)\.nitely\/tasks\/([^/]+)/);
    if (match) return match[1];
  }
  return undefined;
}

function asRunSummary(value: unknown, fallbackRunId: string): WebRunSummary {
  const record = asRecord(value);
  const runId = typeof record.runId === "string" ? record.runId : fallbackRunId;
  const inputs =
    typeof record.inputs === "object" &&
    record.inputs !== null &&
    !Array.isArray(record.inputs)
      ? (redactUnknownForWeb(record.inputs) as Record<string, unknown>)
      : {};
  const changeRequestUrl =
    typeof record.changeRequestUrl === "string"
      ? record.changeRequestUrl
      : undefined;
  const trigger = redactUnknownForWeb(record.trigger);
  const pr = prMetadata({
    changeRequestUrl,
    trigger,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
  });
  const priorRunId =
    typeof record.priorRunId === "string"
      ? record.priorRunId
      : triggerPriorRunId(trigger);
  return {
    runId,
    sessionId: runId,
    status: asRunStatus(record.status, "completed"),
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
    organizationId:
      typeof record.organizationId === "string" ? record.organizationId : undefined,
    flowName: typeof record.flowName === "string" ? record.flowName : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    repoName: typeof record.repoName === "string" ? record.repoName : undefined,
    repoPath: typeof record.repoPath === "string" ? record.repoPath : undefined,
    branchName:
      typeof record.branchName === "string" ? record.branchName : undefined,
    baseBranch:
      typeof record.baseBranch === "string" ? record.baseBranch : undefined,
    worktreePath:
      typeof record.worktreePath === "string" ? record.worktreePath : undefined,
    completedStages: Array.isArray(record.completedStages)
      ? record.completedStages.filter((stage): stage is string => typeof stage === "string")
      : [],
    inputs,
    changeRequestUrl,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    taskId:
      typeof record.taskId === "string" ? record.taskId : taskIdFromInputs(inputs),
    workItemId:
      typeof record.workItemId === "string" ? record.workItemId : undefined,
    workItemType:
      typeof record.workItemType === "string" ? record.workItemType : undefined,
    planningApproval:
      typeof record.planningApproval === "object" && record.planningApproval !== null
        ? (record.planningApproval as PlanningApprovalStatus)
        : undefined,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
    completedAt:
      typeof record.completedAt === "string" ? record.completedAt : undefined,
    trigger,
    priorRunId,
    ...(webBlocker(record.blocker) ? { blocker: webBlocker(record.blocker) } : {}),
  };
}

function webStatusFromProjection(status: ProjectedRunStatus): WebRunStatus {
  if (status === "created") return "running";
  return status;
}

function latestAttempt(stage: ProjectedStage): ProjectedAttempt | undefined {
  return stage.attempts.at(-1);
}

function latestStage(projection: ProjectedRun): ProjectedStage | undefined {
  return projection.stages.at(-1);
}

function latestDecision(
  projection: ProjectedRun,
): OrchestratorDecisionEvent | undefined {
  return projection.orchestratorDecisions.at(-1);
}

function latestStageDecision(
  projection: ProjectedRun,
  stageId: string,
): OrchestratorDecisionEvent | undefined {
  return projection.orchestratorDecisions
    .filter((decision) => decision.stageId === stageId)
    .at(-1);
}

function stateFromDecision(
  decision: OrchestratorDecisionEvent | undefined,
): WebStageState | undefined {
  if (decision?.action === "retry") return "retrying";
  if (decision?.action === "rework") return "reworking";
  if (decision?.action === "escalate") return "escalated";
  if (decision?.action === "fail") return "failed";
  if (decision?.action === "complete") return "completed";
  return undefined;
}

function hasOpenAttempt(stage: ProjectedStage): boolean {
  return stage.attempts.some(
    (attempt) =>
      attempt.startedAt !== undefined &&
      attempt.completedAt === undefined &&
      attempt.failedAt === undefined,
  );
}

function projectedStageState(
  projection: ProjectedRun,
  stage: ProjectedStage,
): WebStageState {
  if (projection.status === "cancelled") return "cancelled";
  if (stage.status === "blocked") return "blocked";
  const decision = latestStageDecision(projection, stage.stageId);
  const decisionState = stateFromDecision(decision);
  if (decisionState && stage.status === "failed") return decisionState;
  if (projection.status === "failed" && stage.status === "failed") return "failed";
  if (stage.status === "completed") return "completed";
  if (stage.status === "failed") return "awaiting-orchestrator";
  if (stage.stageType === "gate" || stage.gate) return "gate-checking";
  if (hasOpenAttempt(stage)) return "running";
  if (stage.status === "pending") return "pending";
  if (stage.status === "interrupted") return "interrupted";
  return "pending";
}

function attemptStart(attempts: ProjectedAttempt[]): string | undefined {
  return attempts.map((attempt) => attempt.startedAt).find(Boolean);
}

function attemptEnd(attempts: ProjectedAttempt[]): string | undefined {
  return attempts
    .map((attempt) => attempt.completedAt ?? attempt.failedAt ?? attempt.blockedAt)
    .filter((value): value is string => value !== undefined)
    .at(-1);
}

function outputLines(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function compactOutput(value: string | undefined): string | undefined {
  const redacted = redactForWeb(value)?.trim();
  if (!redacted) return undefined;
  return redacted.length > 240 ? `...${redacted.slice(-237)}` : redacted;
}

function latestOutputSummary(logs: WebRedactedLog[]): string | undefined {
  const lines: string[] = [];
  for (const log of logs) {
    lines.push(...outputLines(log.stdout), ...outputLines(log.stderr));
  }
  return compactOutput(lines.at(-1));
}

function prefersAttemptError(state: WebStageState): boolean {
  return (
    state === "failed" ||
    state === "blocked" ||
    state === "awaiting-orchestrator" ||
    state === "retrying" ||
    state === "reworking" ||
    state === "escalated"
  );
}

function latestStageOutput(input: {
  state: WebStageState;
  stageOutput: string | undefined;
  attemptError: string | undefined;
  fallbackOutput?: string;
}): string | undefined {
  if (prefersAttemptError(input.state)) {
    return input.attemptError ?? input.stageOutput ?? input.fallbackOutput;
  }
  return input.stageOutput ?? input.fallbackOutput;
}

function latestOutputByStage(logs: WebRedactedLog[]): Map<string, string> {
  const byStage = new Map<string, string>();
  for (const log of logs) {
    for (const line of [...outputLines(log.stdout), ...outputLines(log.stderr)]) {
      byStage.set(log.stageId, line);
    }
  }
  for (const [stageId, line] of byStage) {
    const compact = compactOutput(line);
    if (compact) byStage.set(stageId, compact);
  }
  return byStage;
}

function webStateFieldsFromProjection(
  projection: ProjectedRun,
  logs: WebRedactedLog[],
): Pick<
  WebRunSummary,
  | "currentStage"
  | "currentAttempt"
  | "currentStageState"
  | "latestOutputSummary"
  | "latestDecision"
> {
  const stage = latestStage(projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  const byStage = latestOutputByStage(logs);
  const stageOutput = stage ? byStage.get(stage.stageId) : undefined;
  const attemptError = stage ? compactOutput(latestAttemptError(stage.attempts)) : undefined;
  const state = stage ? projectedStageState(projection, stage) : undefined;
  const latestOutput = state
    ? latestStageOutput({
        state,
        stageOutput,
        attemptError,
        fallbackOutput: latestOutputSummary(logs),
      })
    : latestOutputSummary(logs);
  return {
    ...(stage ? { currentStage: stage.stageId } : {}),
    ...(attempt ? { currentAttempt: attempt.attempt } : {}),
    ...(state ? { currentStageState: state } : {}),
    ...(latestOutput ? { latestOutputSummary: latestOutput } : {}),
    ...(latestDecision(projection) ? { latestDecision: latestDecision(projection) } : {}),
  };
}

function stageIdFromLogs(logs: WebRedactedLog[]): string | undefined {
  return logs.at(-1)?.stageId;
}

function attemptFromLogs(logs: WebRedactedLog[]): number | undefined {
  const parsed = Number(logs.at(-1)?.attempt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function webStateFieldsFromLogs(
  summary: Pick<WebRunSummary, "status" | "completedStages">,
  logs: WebRedactedLog[],
): Pick<WebRunSummary, "currentStage" | "currentAttempt" | "currentStageState" | "latestOutputSummary"> {
  const currentStage = stageIdFromLogs(logs) ?? summary.completedStages.at(-1);
  const terminalState =
    summary.status === "completed" ||
    summary.status === "failed" ||
    summary.status === "cancelled" ||
    summary.status === "interrupted"
      ? summary.status
      : undefined;
  return {
    ...(currentStage ? { currentStage } : {}),
    ...(attemptFromLogs(logs) ? { currentAttempt: attemptFromLogs(logs) } : {}),
    currentStageState: terminalState ?? (currentStage ? "running" : "pending"),
    ...(latestOutputSummary(logs) ? { latestOutputSummary: latestOutputSummary(logs) } : {}),
  };
}

function projectedRunSummary(
  projection: ProjectedRun,
  logs: WebRedactedLog[] = [],
): WebRunSummary {
  const inputs = (redactUnknownForWeb(projection.inputs ?? {}) ?? {}) as Record<string, unknown>;
  const trigger = redactUnknownForWeb(projection.trigger);
  const pr = prMetadata({
    changeRequestUrl: projection.changeRequestUrl,
    trigger,
  });
  const startedAt = projection.stages
    .flatMap((stage) => stage.attempts)
    .map((attempt) => attempt.startedAt)
    .find(Boolean);
  const completedAt = projection.stages
    .flatMap((stage) => stage.attempts)
    .map((attempt) => attempt.completedAt ?? attempt.failedAt)
    .filter((value): value is string => value !== undefined)
    .at(-1);
  return {
    runId: projection.runId,
    sessionId: projection.runId,
    status: webStatusFromProjection(projection.status),
    ownerId: projection.ownerId,
    organizationId: projection.organizationId,
    flowName: projection.flowName,
    flowPath: projection.flowPath,
    repoId: projection.repoId,
    repoName: projection.repoName,
    repoPath: projection.repoPath,
    branchName: projection.branchName,
    baseBranch: projection.baseBranch,
    worktreePath: projection.worktreePath,
    completedStages: projection.completedStages,
    ...webStateFieldsFromProjection(projection, logs),
    ...(webBlocker(projection.blocker)
      ? { blocker: webBlocker(projection.blocker) }
      : {}),
    inputs,
    changeRequestUrl: projection.changeRequestUrl,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    taskId: projection.workItemId ?? taskIdFromInputs(inputs),
    workItemId: projection.workItemId,
    workItemType: projection.workItemType,
    planningApproval: projection.planningApproval,
    startedAt,
    completedAt,
    trigger,
    priorRunId: projection.priorRunId ?? triggerPriorRunId(trigger),
    ...(projection.contextUsage ? { contextUsage: projection.contextUsage } : {}),
    ...(projection.runtimeUsage ? { runtimeUsage: projection.runtimeUsage } : {}),
    ...(projection.budgetSummary
      ? { budgetSummary: projection.budgetSummary }
      : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readRunSummary(
  repoPath: string,
  runId: string,
): Promise<WebRunSummary> {
  validateRunId(runId);
  const path = join(runsRoot(repoPath), runId, "run.json");
  try {
    const summary = asRunSummary(JSON.parse(await readFile(path, "utf8")), runId);
    const logs = await readStageLogs(join(runsRoot(repoPath), runId));
    return {
      ...summary,
      ...webStateFieldsFromLogs(summary, logs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return await readFallbackRunSummary(repoPath, runId);
    }
    throw error;
  }
}

async function readStageLogs(runDirectory: string): Promise<WebRunDetail["logs"]> {
  const logs: WebRunDetail["logs"] = [];
  const stagesDirectory = join(runDirectory, "stages");
  let stageIds: string[] = [];
  try {
    stageIds = await readdir(stagesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  for (const stageId of stageIds.sort()) {
    const attemptsDirectory = join(stagesDirectory, stageId);
    let attempts: string[] = [];
    try {
      attempts = await readdir(attemptsDirectory);
    } catch {
      continue;
    }
    for (const attempt of attempts.sort()) {
      const attemptDirectory = join(attemptsDirectory, attempt);
      const stdout = await readOptionalFile(join(attemptDirectory, "stdout.log"));
      const stderr = await readOptionalFile(join(attemptDirectory, "stderr.log"));
      if (stdout !== undefined || stderr !== undefined) {
        logs.push({
          stageId,
          attempt,
          stdout: redactForWeb(stdout),
          stderr: redactForWeb(stderr),
        });
      }
    }
  }
  return logs;
}

async function readStageIdsWithAttempts(runDirectory: string): Promise<string[]> {
  const stagesDirectory = join(runDirectory, "stages");
  let stageIds: string[] = [];
  try {
    stageIds = await readdir(stagesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const completedStages: string[] = [];
  for (const stageId of stageIds.sort()) {
    const attemptsDirectory = join(stagesDirectory, stageId);
    let attempts: string[] = [];
    try {
      attempts = await readdir(attemptsDirectory);
    } catch {
      continue;
    }
    if (attempts.length > 0) {
      completedStages.push(stageId);
    }
  }
  return completedStages;
}

async function inferFallbackStatus(
  runDirectory: string,
  logs: WebRunDetail["logs"],
): Promise<WebRunStatus> {
  // Without run.json or event projections, terminal state is approximate.
  // Prefer "failed" only for stable failure signals; otherwise preserve the
  // run as "incomplete" so users can still inspect available logs.
  for (const marker of ["failed", "failed.json", "run.failed"]) {
    if (await fileExists(join(runDirectory, marker))) {
      return "failed";
    }
  }
  if (
    logs.some(
      (log) =>
        log.stderr !== undefined &&
        log.stderr.length > 0 &&
        (log.stdout === undefined || log.stdout.length === 0),
    )
  ) {
    return "failed";
  }
  return "incomplete";
}

async function readFallbackRunSummary(
  repoPath: string,
  runId: string,
): Promise<WebRunSummary> {
  const runDirectory = join(runsRoot(repoPath), runId);
  const [logs, completedStages] = await Promise.all([
    readStageLogs(runDirectory),
    readStageIdsWithAttempts(runDirectory),
  ]);
  if (logs.length === 0 && completedStages.length === 0) {
    throw new WebNotFoundError("run not found");
  }
  const status = await inferFallbackStatus(runDirectory, logs);
  return {
    runId,
    sessionId: runId,
    status,
    completedStages,
    ...webStateFieldsFromLogs({ status, completedStages }, logs),
    inputs: {},
  };
}

async function tryListProjectedRuns(repoPath: string): Promise<ProjectedRun[]> {
  try {
    return await listProjectedRuns(repoPath);
  } catch {
    return [];
  }
}

async function tryProjectedRun(
  repoPath: string,
  runId: string,
): Promise<ProjectedRun | undefined> {
  try {
    return await getProjectedRun(repoPath, runId);
  } catch {
    return undefined;
  }
}

function tryRunEvents(repoPath: string, runId: string): StoredRunEvent[] {
  try {
    const store = new EventStore(eventStorePath(repoPath));
    try {
      return store.list(runId);
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

async function tryFlowStages(
  repoPath: string,
  projection: ProjectedRun,
): Promise<Map<string, Stage>> {
  try {
    const externalInputs = Object.keys(projection.inputs ?? {});
    const loaded = projection.flowDocument !== undefined
      ? parseFlowDocument(projection.flowDocument, { externalInputs })
      : projection.flowPath
        ? await loadFlow(
            isAbsolute(projection.flowPath)
              ? projection.flowPath
              : join(repoPath, projection.flowPath),
            { externalInputs },
          )
        : undefined;
    return new Map(
      (loaded?.flow.spec.stages ?? []).map((stage) => [stage.id, stage]),
    );
  } catch {
    return new Map();
  }
}

export async function listRuns(repoPath: string): Promise<WebRunSummary[]> {
  const projected = await tryListProjectedRuns(repoPath);
  const byRunId = new Map<string, WebRunSummary>();
  for (const projection of projected) {
    const logs = await projectedLogs(repoPath, projection.runId);
    byRunId.set(projection.runId, projectedRunSummary(projection, logs));
  }

  let entries: string[];
  try {
    entries = await readdir(runsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [...byRunId.values()]
        .sort((left, right) => right.runId.localeCompare(left.runId));
    }
    throw error;
  }
  const runs = await Promise.all(
    entries.filter((entry) => !byRunId.has(entry)).map(async (entry) => {
      try {
        return await readRunSummary(repoPath, entry);
      } catch {
        return undefined;
      }
    }),
  );
  for (const run of runs) {
    if (run) byRunId.set(run.runId, run);
  }
  return [...byRunId.values()]
    .sort((left, right) => right.runId.localeCompare(left.runId));
}

function latestAttemptError(attempts: ProjectedAttempt[]): string | undefined {
  return attempts
    .map((attempt) => attempt.error)
    .filter((value): value is string => value !== undefined)
    .at(-1);
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function timelineStatus(stage: ProjectedStage): WebSessionTimelineItem["status"] {
  return stage.status === "pending" || stage.status === "started"
    ? "started"
    : stage.status;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addDetailField(
  fields: WebStageDetailField[],
  label: string,
  value: unknown,
  options: { href?: string; mono?: boolean } = {},
): void {
  if (value === undefined || value === null || value === "") return;
  const stringValue = typeof value === "string" ? value : String(value);
  fields.push({
    label,
    value: stringValue,
    ...(options.href ? { href: options.href } : {}),
    ...(options.mono ? { mono: true } : {}),
  });
}

function compactJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function contextUsageDetail(usage: ProjectedContextUsage | undefined): string | undefined {
  if (!usage) return undefined;
  return [
    `${usage.approxTokens} approx tokens`,
    `${usage.promptBytes} prompt bytes`,
    `${usage.inputCount} inputs`,
    `${usage.inputBytesSaved} bytes saved`,
  ].join(" · ");
}

function runtimeUsageDetail(usage: ProjectedRuntimeUsageTotal | undefined): string | undefined {
  if (!usage) return undefined;
  const parts = [
    usage.totalTokens !== undefined ? `${usage.totalTokens} total tokens` : undefined,
    usage.inputTokens !== undefined ? `${usage.inputTokens} input` : undefined,
    usage.outputTokens !== undefined ? `${usage.outputTokens} output` : undefined,
    usage.estimatedCostUsd !== undefined ? `$${usage.estimatedCostUsd.toFixed(4)}` : undefined,
    `${usage.knownAttempts} known attempt${usage.knownAttempts === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== undefined);
  if (usage.unknownAttempts > 0) {
    parts.push(`${usage.unknownAttempts} unknown attempt${usage.unknownAttempts === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function budgetDetail(budget: ProjectedAttemptBudget | undefined): string | undefined {
  if (!budget) return undefined;
  if (budget.status === "trimmed") {
    return [
      `trimmed to ${budget.budget}`,
      budget.approxTokensBefore !== undefined ? `before ${budget.approxTokensBefore}` : undefined,
      budget.approxTokensAfter !== undefined ? `after ${budget.approxTokensAfter}` : undefined,
      budget.trimmedInputIds?.length ? `inputs ${budget.trimmedInputIds.join(", ")}` : undefined,
    ].filter((part): part is string => part !== undefined).join(" · ");
  }
  return [
    `exceeded ${budget.budget}`,
    budget.approxTokens !== undefined ? `${budget.approxTokens} approx tokens` : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

function stageOutputId(output: Stage["outputs"][number]): string {
  return typeof output === "string" ? output : output.id;
}

function logsForStage(logs: WebRedactedLog[], stageId: string): {
  command?: string;
  stdout?: string;
  stderr?: string;
} {
  const stageLogs = logs.filter((log) => log.stageId === stageId);
  return {
    command: stageLogs.map((log) => log.command).filter(Boolean).at(-1),
    stdout: stageLogs.map((log) => log.stdout).filter(Boolean).join("\n"),
    stderr: stageLogs.map((log) => log.stderr).filter(Boolean).join("\n"),
  };
}

async function readAttemptPrompt(attempt: ProjectedAttempt | undefined): Promise<string | undefined> {
  const directory = attempt?.attemptDirectory;
  if (!directory) return undefined;
  return redactForWeb(await readOptionalFile(join(directory, "prompt.md")));
}

function artifactsForStage(
  artifacts: RunArtifact[],
  stageId: string,
): WebStageDetailArtifact[] {
  return artifacts
    .filter((artifact) => artifact.producer === stageId)
    .map((artifact) => ({
      id: artifact.id,
      label: artifact.name ?? artifact.id,
      ...(artifact.path ? { path: artifact.path } : {}),
    }));
}

function eventSummary(event: StoredRunEvent): string | undefined {
  const payload = asRecord(redactUnknownForWeb(event.payload));
  const parts: string[] = [];
  if (event.type === "command.completed") {
    addSummaryPart(parts, "command", asString(payload.command));
    addSummaryPart(parts, "exit", asNumber(payload.exitCode));
  } else if (event.type === "gate.completed") {
    const gate = asRecord(payload.gate ?? payload);
    addSummaryPart(parts, "gate", asString(gate.id));
    addSummaryPart(parts, "status", asString(gate.status));
    addSummaryPart(parts, "mode", asString(gate.mode));
    addSummaryPart(parts, "reason", asString(gate.reason));
  } else if (event.type === "orchestrator.decision") {
    addSummaryPart(parts, "decision", asString(payload.decision));
    addSummaryPart(parts, "action", asString(payload.action));
    addSummaryPart(parts, "reason", asString(payload.reason));
    addSummaryPart(parts, "target", asString(payload.reworkTarget));
  } else if (event.type === "change.published" || event.type === "change.updated") {
    addSummaryPart(parts, "url", asString(payload.url));
    addSummaryPart(parts, "title", asString(payload.title));
    addSummaryPart(parts, "provider", asString(payload.provider));
    addSummaryPart(parts, "target", asString(payload.target));
    addSummaryPart(parts, "evidence", asString(payload.evidencePath));
  } else if (
    event.type === "stage.failed" ||
    event.type === "stage.blocked" ||
    event.type === "stage.runtime.unavailable" ||
    event.type === "stage.rework.requested" ||
    event.type === "stage.retrying"
  ) {
    addSummaryPart(parts, "reason", asString(payload.reason));
    addSummaryPart(parts, "message", asString(payload.message));
    addSummaryPart(parts, "error", asString(payload.error));
    addSummaryPart(parts, "missing", asStringArray(payload.missingConfig)?.join(", "));
    addSummaryPart(parts, "target", asString(payload.targetStageId));
  }
  return parts.join(" · ") || compactJson(redactUnknownForWeb(event.payload));
}

function addSummaryPart(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  parts.push(`${label} ${String(value)}`);
}

function eventsForStage(events: StoredRunEvent[], stageId: string): WebStageDetailEvent[] {
  const usefulTypes = new Set([
    "command.completed",
    "gate.completed",
    "orchestrator.decision",
    "change.published",
    "change.updated",
    "stage.failed",
    "stage.blocked",
    "stage.runtime.unavailable",
    "stage.rework.requested",
    "stage.retrying",
  ]);
  return events
    .filter((event) => event.stageId === stageId && usefulTypes.has(event.type))
    .map((event) => {
      const summary = eventSummary(event);
      return {
        type: event.type,
        at: event.createdAt,
        ...(typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
        ...(summary ? { summary } : {}),
      };
    });
}

async function projectedStageDetails(input: {
  stage: ProjectedStage;
  declaration: Stage | undefined;
  attempt: ProjectedAttempt | undefined;
  logs: WebRedactedLog[];
  artifacts: RunArtifact[];
  events: StoredRunEvent[];
  startedAt: string | undefined;
  endedAt: string | undefined;
  stageUsage: ProjectedContextUsage | undefined;
  stageRuntimeUsage: ProjectedRuntimeUsageTotal | undefined;
  state: WebStageState;
}): Promise<WebStageDetails> {
  const fields: WebStageDetailField[] = [];
  const stage = input.stage;
  const attempt = input.attempt;
  const declaration = input.declaration;
  const stageLogs = logsForStage(input.logs, stage.stageId);
  addDetailField(fields, "Stage", stage.stageId, { mono: true });
  addDetailField(fields, "Type", stage.stageType ?? "stage");
  addDetailField(fields, "Status", stage.status);
  addDetailField(fields, "Declared inputs", declaration?.inputs.join(", "));
  addDetailField(fields, "Declared outputs", declaration?.outputs.map(stageOutputId).join(", "));
  addDetailField(fields, "Max attempts", declaration?.maxAttempts);
  addDetailField(fields, "Attempts", stage.attempts.length);
  addDetailField(fields, "Current attempt", attempt?.attempt);
  addDetailField(fields, "Started", input.startedAt);
  addDetailField(fields, "Ended", input.endedAt);
  addDetailField(fields, "Duration", durationMs(input.startedAt, input.endedAt));
  addDetailField(fields, "Runtime", attempt?.runtime);
  addDetailField(fields, "Model", attempt?.model);
  if (
    attempt?.runtimeCandidateIndex !== undefined &&
    attempt.runtimeCandidateCount !== undefined
  ) {
    addDetailField(
      fields,
      "Runtime candidate",
      `${attempt.runtimeCandidateIndex + 1}/${attempt.runtimeCandidateCount}`,
    );
  }
  addDetailField(fields, "Command", stageLogs.command, { mono: true });
  addDetailField(fields, "Attempt directory", redactForWeb(attempt?.attemptDirectory), { mono: true });
  addDetailField(fields, "Output path", redactForWeb(attempt?.outputPath), { mono: true });
  addDetailField(fields, "Artifact manifest", redactForWeb(attempt?.artifactManifestPath), { mono: true });
  addDetailField(fields, "Stdout path", redactForWeb(attempt?.stdoutPath), { mono: true });
  addDetailField(fields, "Stderr path", redactForWeb(attempt?.stderrPath), { mono: true });
  addDetailField(fields, "Context usage", contextUsageDetail(input.stageUsage));
  addDetailField(fields, "Runtime usage", runtimeUsageDetail(input.stageRuntimeUsage));
  addDetailField(fields, "Budget", budgetDetail(attempt?.budget));
  addDetailField(
    fields,
    "Error",
    prefersAttemptError(input.state)
      ? redactForWeb(latestAttemptError(stage.attempts))
      : undefined,
  );
  addDetailField(fields, "Blocker", stage.blocker ? compactJson(redactUnknownForWeb(stage.blocker)) : undefined);
  const prompt = await readAttemptPrompt(attempt);
  return {
    fields,
    ...(prompt ? { prompt } : {}),
    ...(stageLogs.stdout ? { stdout: stageLogs.stdout } : {}),
    ...(stageLogs.stderr ? { stderr: stageLogs.stderr } : {}),
    artifacts: artifactsForStage(input.artifacts, stage.stageId),
    events: eventsForStage(input.events, stage.stageId),
  };
}

async function projectedTimeline(
  projection: ProjectedRun,
  logs: WebRedactedLog[],
  artifacts: RunArtifact[],
  events: StoredRunEvent[],
  declarations: Map<string, Stage>,
  hasEvidence: boolean,
): Promise<WebSessionTimelineItem[]> {
  const outputByStage = latestOutputByStage(logs);
  return await Promise.all(projection.stages.map(async (stage) => {
    const startedAt = attemptStart(stage.attempts);
    const endedAt = attemptEnd(stage.attempts);
    const decision = latestStageDecision(projection, stage.stageId);
    const attempt = latestAttempt(stage);
    const state = projectedStageState(projection, stage);
    const attemptError = prefersAttemptError(state)
      ? compactOutput(latestAttemptError(stage.attempts))
      : undefined;
    const stageUsage = sumContextUsage(
      stage.attempts.map((attempt) => attempt.contextUsage),
    );
    const unknownRuntimeAttempts = stage.attempts.filter((attempt) => {
      const isRuntimeAttempt =
        attempt.runtime !== undefined || stage.stageType === "agent";
      return isRuntimeAttempt && !attempt.runtimeUsage;
    }).length;
    const stageRuntimeUsage = sumRuntimeUsage(
      stage.attempts.map((attempt) => attempt.runtimeUsage),
      unknownRuntimeAttempts,
    );
    const details = await projectedStageDetails({
      stage,
      declaration: declarations.get(stage.stageId),
      attempt,
      logs,
      artifacts,
      events,
      startedAt,
      endedAt,
      stageUsage,
      stageRuntimeUsage,
      state,
    });
    return {
      stageId: stage.stageId,
      stageType: stage.stageType ?? "stage",
      gate: stage.gate,
      resumedFrom:
        typeof stage.markers?.resumedFrom === "string"
          ? stage.markers.resumedFrom
          : undefined,
      status: timelineStatus(stage),
      state,
      latestOutput: latestStageOutput({
        state,
        stageOutput: outputByStage.get(stage.stageId),
        attemptError,
      }),
      latestDecision: decision,
      currentAttempt: attempt?.attempt,
      attempts: stage.attempts.length,
      startedAt,
      completedAt: stage.status === "completed" ? endedAt : undefined,
      failedAt: stage.status === "failed" ? endedAt : undefined,
      durationMs: durationMs(startedAt, endedAt),
      error: prefersAttemptError(state)
        ? redactForWeb(latestAttemptError(stage.attempts))
        : undefined,
      ...(webBlocker(stage.blocker) ? { blocker: webBlocker(stage.blocker) } : {}),
      attemptDirectory: redactForWeb(attempt?.attemptDirectory),
      outputPath: redactForWeb(attempt?.outputPath),
      artifactManifestPath: redactForWeb(attempt?.artifactManifestPath),
      stdoutPath: redactForWeb(attempt?.stdoutPath),
      stderrPath: redactForWeb(attempt?.stderrPath),
      generatedArtifactPaths: attempt?.generatedArtifactPaths?.map((path) =>
        redactForWeb(path) ?? "",
      ),
      ...(stageUsage ? { contextUsage: stageUsage } : {}),
      ...(stageRuntimeUsage ? { runtimeUsage: stageRuntimeUsage } : {}),
      ...(attempt?.budget ? { budget: attempt.budget } : {}),
      hasLogs: logs.some((log) => log.stageId === stage.stageId),
      hasEvidence,
      hasDetails: true,
      details,
    };
  }));
}

function buildEvidenceTimeline(input: {
  summary: WebRunSummary;
  artifacts: RunArtifact[];
  timeline: WebSessionTimelineItem[];
  logs: WebRedactedLog[];
}): RunEvidenceItem[] {
  const items: RunEvidenceItem[] = [];

  for (const artifact of input.artifacts) {
    if (artifact.producer === "external") {
      items.push({
        kind: "input",
        label: artifact.id,
        at: artifact.createdAt,
        detail: {
          sha256: artifact.sha256,
          size: artifact.size,
          sourceUri: artifact.sourceUri,
          mediaType: artifact.mediaType,
        },
      });
    }
  }

  for (const stage of input.timeline) {
    const log = input.logs.find((entry) => entry.stageId === stage.stageId);
    items.push({
      kind: "stage",
      label: stage.stageId,
      at: stage.startedAt,
      detail: {
        stageType: stage.stageType,
        status: stage.status,
        attempts: stage.attempts,
        durationMs: stage.durationMs,
        ...(log?.command !== undefined ? { command: log.command } : {}),
      },
    });
  }

  for (const artifact of input.artifacts) {
    if (artifact.producer === "external") {
      continue;
    }
    if (artifact.type === "gate.approval") {
      items.push({
        kind: "gate",
        label: artifact.id,
        at: artifact.gate?.decidedAt ?? artifact.createdAt,
        detail: {
          state: artifact.gate?.state,
          actor: artifact.gate?.actor,
          reason: artifact.gate?.reason,
        },
      });
      continue;
    }
    items.push({
      kind: "artifact",
      label: artifact.id,
      at: artifact.createdAt,
      detail: {
        type: artifact.type,
        producer: artifact.producer,
        sha256: artifact.sha256,
        size: artifact.size,
        mediaType: artifact.mediaType,
      },
    });
  }

  if (input.summary.changeRequestUrl || input.summary.branchName) {
    items.push({
      kind: "external-effect",
      label: input.summary.prUrl ? "Pull request" : "Change",
      at: input.summary.completedAt,
      detail: {
        changeRequestUrl: input.summary.changeRequestUrl,
        prUrl: input.summary.prUrl,
        prNumber: input.summary.prNumber,
        branchName: input.summary.branchName,
      },
    });
  }

  return items;
}

function fallbackTimeline(
  summary: WebRunSummary,
  logs: WebRedactedLog[],
  hasEvidence: boolean,
): WebSessionTimelineItem[] {
  const stageIds = new Set([
    ...summary.completedStages,
    ...logs.map((log) => log.stageId),
  ]);
  return [...stageIds].sort().map((stageId) => {
    const stageLogs = logs.filter((log) => log.stageId === stageId);
    const combinedLogs = logsForStage(logs, stageId);
    const failed = stageLogs.some((log) => (log.stderr ?? "").length > 0);
    const fields: WebStageDetailField[] = [];
    addDetailField(fields, "Stage", stageId, { mono: true });
    addDetailField(fields, "Type", "agent");
    addDetailField(
      fields,
      "Status",
      summary.completedStages.includes(stageId)
        ? "completed"
        : failed
          ? "failed"
          : summary.status,
    );
    addDetailField(fields, "Attempts", Math.max(stageLogs.length, 1));
    addDetailField(fields, "Command", combinedLogs.command, { mono: true });
    return {
      stageId,
      stageType: "agent",
      status: summary.completedStages.includes(stageId)
        ? "completed"
        : failed
          ? "failed"
          : summary.status,
      state: summary.completedStages.includes(stageId)
        ? "completed"
        : failed
          ? "failed"
          : webStateFieldsFromLogs(summary, stageLogs).currentStageState ?? "pending",
      latestOutput: latestOutputSummary(stageLogs),
      currentAttempt: attemptFromLogs(stageLogs),
      attempts: Math.max(stageLogs.length, 1),
      hasLogs: stageLogs.length > 0,
      hasEvidence,
      hasDetails: true,
      details: {
        fields,
        ...(combinedLogs.stdout ? { stdout: combinedLogs.stdout } : {}),
        ...(combinedLogs.stderr ? { stderr: combinedLogs.stderr } : {}),
        artifacts: [],
        events: [],
      },
    };
  });
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function safeRunRelativePath(
  runDirectory: string,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return undefined;
  const resolved = resolve(runDirectory, candidate);
  if (!isPathInside(resolve(runDirectory), resolved)) return undefined;
  return relative(runDirectory, resolved);
}

function safeSourceUri(
  runDirectory: string,
  sourceUri: string | undefined,
): string | undefined {
  if (!sourceUri) return undefined;
  if (!isAbsolute(sourceUri)) return sourceUri;
  return safeRunRelativePath(runDirectory, sourceUri);
}

function contextKind(sourceUri: string | undefined): WebSessionContextItem["kind"] {
  if (!sourceUri) return "input";
  if (/^https?:\/\//i.test(sourceUri)) return "external";
  if (sourceUri.includes("/.nitely/runs/") || sourceUri.startsWith(".nitely/runs/")) {
    return "generated";
  }
  return "local";
}

function manifestContextKind(
  kind: unknown,
  sourceUri: string | undefined,
): WebSessionContextItem["kind"] {
  if (kind === "generated-artifact") return "generated";
  if (kind === "connector-context") return "external";
  return contextKind(sourceUri);
}

function isSafeInputId(inputId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,160}$/.test(inputId);
}

function contextRecord(value: unknown): Partial<WebSessionContextItem> {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  const sourceUri = asString(record.sourceUri) ?? asString(record.uri);
  return {
    sourceUri,
    mediaType: asString(record.mediaType),
    filename: asString(record.filename) ?? asString(metadata.filename),
    path: asString(record.path),
  };
}

function mergeContextRecords(values: unknown[]): Partial<WebSessionContextItem> {
  const merged: Partial<WebSessionContextItem> = {};
  for (const value of values) {
    const record = contextRecord(value);
    for (const key of ["sourceUri", "mediaType", "filename", "path"] as const) {
      if (record[key] !== undefined) {
        merged[key] = record[key];
      }
    }
  }
  return merged;
}

async function readInputSnapshotMetadata(
  runDirectory: string,
  inputId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!isSafeInputId(inputId)) return undefined;
  const inputsDirectory = resolve(runDirectory, "inputs");
  const metadataPath = resolve(inputsDirectory, inputId, "metadata.json");
  if (!isPathInside(inputsDirectory, metadataPath)) return undefined;
  const content = await readOptionalFile(metadataPath);
  return content === undefined ? undefined : asRecord(JSON.parse(content));
}

async function readRunJsonInputs(
  runDirectory: string,
): Promise<Record<string, unknown> | undefined> {
  const content = await readOptionalFile(join(runDirectory, "run.json"));
  if (content === undefined) return undefined;
  const record = asRecord(JSON.parse(content));
  return asRecord(record.inputs);
}

async function contextManifest(input: {
  runDirectory: string;
  projectedInputs: Record<string, unknown>;
  runJsonInputs?: Record<string, unknown>;
  redactionSecrets?: Iterable<string>;
}): Promise<WebSessionContextItem[]> {
  const durable = await readOptionalFile(join(input.runDirectory, "context-manifest.json"));
  if (durable !== undefined) {
    const record = asRecord(JSON.parse(durable));
    const entries = Array.isArray(record.entries) ? record.entries : [];
    return entries.map((value): WebSessionContextItem => {
      const entry = asRecord(
        redactContextManifestEntry(
          asRecord(value) as unknown as ContextManifestEntry,
          input.redactionSecrets,
        ),
      );
      const sourceUri = safeSourceUri(input.runDirectory, asString(entry.sourceUri));
      const runRelative = asString(entry.runRelativePath);
      const path = runRelative
        ? safeRunRelativePath(input.runDirectory, runRelative)
        : undefined;
      const filename =
        asString(entry.filename) ?? (sourceUri ? basename(sourceUri) : undefined);
      return {
        id: asString(entry.id) ?? "",
        sourceUri,
        mediaType: asString(entry.mediaType),
        filename,
        kind: manifestContextKind(entry.kind, sourceUri),
        path,
      };
    }).filter((item) => item.id.length > 0);
  }
  const inputIds = new Set([
    ...Object.keys(input.projectedInputs),
    ...Object.keys(input.runJsonInputs ?? {}),
  ]);
  const items: WebSessionContextItem[] = [];
  for (const id of inputIds) {
    const snapshotMetadata = await readInputSnapshotMetadata(input.runDirectory, id);
    const merged = mergeContextRecords([
      input.projectedInputs[id],
      input.runJsonInputs?.[id],
      snapshotMetadata,
    ]);
    const sourceUri = safeSourceUri(input.runDirectory, merged.sourceUri);
    const filename =
      merged.filename ?? (sourceUri ? basename(sourceUri) : undefined);
    items.push({
      id,
      sourceUri,
      mediaType: merged.mediaType,
      filename,
      kind: contextKind(sourceUri),
      path: safeRunRelativePath(input.runDirectory, merged.path),
    });
  }
  return items;
}

function webArtifact(
  value: unknown,
  redactionSecrets: Iterable<string> = [],
): RunArtifact | undefined {
  const record = asRecord(redactUnknownForWeb(value, redactionSecrets));
  const id = asString(record.id);
  const producer = asString(record.producer);
  const mediaType = asString(record.mediaType);
  if (!id || !producer || !mediaType) return undefined;
  const artifact: RunArtifact = {
    id,
    name: asString(record.name),
    type: asString(record.type),
    description: asString(record.description),
    producer,
    mediaType,
    schema: record.schema,
    version: asString(record.version),
    path: asString(record.path),
    sourceUri: asString(record.sourceUri),
    filename: asString(record.filename),
    createdAt: asString(record.createdAt),
    gateResult: webGateResult(record.gateResult),
    sha256: asString(record.sha256),
    size: typeof record.size === "number" ? record.size : undefined,
    createdByRunId: asString(record.createdByRunId),
    stageId: asString(record.stageId),
    attempt: typeof record.attempt === "number" ? record.attempt : undefined,
  };
  const gate = asRecord(record.gate);
  const gateId = asString(gate.gateId);
  const gateState = asString(gate.state);
  if (gateId && gateState) {
    artifact.gate = {
      gateId,
      state: gateState as GateStateValue,
      ...(asString(gate.actor) ? { actor: asString(gate.actor) } : {}),
      ...(asString(gate.reason) ? { reason: asString(gate.reason) } : {}),
      ...(asString(gate.decidedAt)
        ? { decidedAt: asString(gate.decidedAt) }
        : {}),
    };
  }
  return artifact;
}

async function artifactRegistryItems(input: {
  runDirectory: string;
  projection?: ProjectedRun;
  manifest: WebSessionContextItem[];
  redactionSecrets?: Iterable<string>;
}): Promise<RunArtifact[]> {
  const registry = await readArtifactRegistry({
    runDirectory: input.runDirectory,
  });
  const registryArtifacts = registry?.artifacts
    .map((artifact) => webArtifact(artifact, input.redactionSecrets))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  if (registryArtifacts && registryArtifacts.length > 0) {
    return registryArtifacts;
  }

  const projectedArtifacts = input.projection?.artifacts
    .map((artifact) => webArtifact(artifact, input.redactionSecrets))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  if (projectedArtifacts && projectedArtifacts.length > 0) {
    return projectedArtifacts;
  }

  return input.manifest
    .filter((item) => item.kind === "generated")
    .map((item) =>
      webArtifact(
        {
          id: item.id,
          producer: "generated",
          mediaType: item.mediaType ?? "text/markdown",
          path: item.path,
          sourceUri: item.sourceUri,
          filename: item.filename,
        },
        input.redactionSecrets,
      ),
    )
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
}

function countSeverity(content: string): Record<string, number> {
  const severities: Record<string, number> = {};
  for (const line of content.split(/\r?\n/)) {
    for (const match of line.matchAll(/\b(P[0-3])\b/g)) {
      severities[match[1]] = (severities[match[1]] ?? 0) + 1;
    }
    if (/\bNo issues\b/i.test(line)) {
      severities.none = (severities.none ?? 0) + 1;
    }
  }
  return severities;
}

async function readReviewArtifacts(runDirectory: string): Promise<WebReviewArtifact[]> {
  const reviewDirectory = join(runDirectory, "stages", "review");
  let attempts: string[] = [];
  try {
    attempts = await readdir(reviewDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const artifacts: WebReviewArtifact[] = [];
  for (const attempt of attempts.sort()) {
    for (const filename of ["review.md", "review.txt"]) {
      const path = join(reviewDirectory, attempt, filename);
      const content = await readOptionalFile(path);
      if (content === undefined) continue;
      const redactedContent = redactForWeb(content) ?? "";
      artifacts.push({
        stageId: "review",
        attempt,
        path: join("stages", "review", attempt, filename),
        content: redactedContent,
        severities: countSeverity(redactedContent),
      });
    }
  }
  return artifacts;
}

async function projectedLogs(repoPath: string, runId: string): Promise<WebRedactedLog[]> {
  const logs = await getProjectedRunLogs(repoPath, runId);
  return logs.map((log) => ({
    stageId: log.stageId,
    attempt: String(log.attempt),
    command: redactForWeb(log.command),
    stdout: redactForWeb(log.stdout),
    stderr: redactForWeb(log.stderr),
  }));
}

function chainPriorRunId(run: WebRunSummary): string | undefined {
  return run.priorRunId ?? triggerPriorRunId(run.trigger);
}

export async function getRunDetail(
  repoPath: string,
  runId: string,
  options: { redactionSecrets?: Iterable<string> } = {},
): Promise<WebRunDetail> {
  validateRunId(runId);
  const projection = await tryProjectedRun(repoPath, runId);
  const runDirectory = join(runsRoot(repoPath), runId);
  const rawEvidence = await readOptionalFile(join(runDirectory, "evidence.md"));
  const evidence = redactForWeb(rawEvidence);
  const logs = projection ? await projectedLogs(repoPath, runId) : await readStageLogs(runDirectory);
  let summary: WebRunSummary;
  if (projection) {
    summary = projectedRunSummary(projection, logs);
  } else {
    const fallbackSummary = await readRunSummary(repoPath, runId);
    summary = {
      ...fallbackSummary,
      ...webStateFieldsFromLogs(fallbackSummary, logs),
    };
  }
  const summaries = await listRuns(repoPath);
  const priorRunId = chainPriorRunId(summary);
  const parentRun = priorRunId
    ? summaries.find((candidate) => candidate.runId === priorRunId)
    : undefined;
  const childRuns = summaries.filter(
    (candidate) => chainPriorRunId(candidate) === runId,
  );
  const runJsonInputs = await readRunJsonInputs(runDirectory);
  const manifest = await contextManifest({
    runDirectory,
    projectedInputs: projection?.inputs ?? summary.inputs,
    runJsonInputs,
    redactionSecrets: options.redactionSecrets,
  });
  const artifacts = await artifactRegistryItems({
    runDirectory,
    projection,
    manifest,
    redactionSecrets: options.redactionSecrets,
  });
  const timeline = projection
    ? await projectedTimeline(
        projection,
        logs,
        artifacts,
        tryRunEvents(repoPath, runId),
        await tryFlowStages(repoPath, projection),
        evidence !== undefined,
      )
    : fallbackTimeline(summary, logs, evidence !== undefined);
  return {
    ...summary,
    evidence,
    logs,
    artifacts,
    gates: projection?.gates ?? [],
    contextManifest: manifest,
    timeline,
    evidenceTimeline: buildEvidenceTimeline({ summary, artifacts, timeline, logs }),
    reviewFindings: await readReviewArtifacts(runDirectory),
    parentRun,
    childRuns,
    ...(projection?.contextUsage ? { contextUsage: projection.contextUsage } : {}),
    ...(projection?.runtimeUsage ? { runtimeUsage: projection.runtimeUsage } : {}),
    ...(projection?.budgetSummary
      ? { budgetSummary: projection.budgetSummary }
      : {}),
  };
}
