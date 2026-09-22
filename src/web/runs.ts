import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  redactContextManifestEntry,
  type ContextManifestEntry,
} from "../context/manifest.js";
import {
  listContextKnowledgeEntries,
  type ContextKnowledgeEntry,
} from "../context-kg/store.js";
import {
  readArtifactRegistry,
  readMaterializedArtifact,
  reconcileArtifactSources,
} from "../artifacts/registry.js";
import type {
  GateResult,
  GateReviewOutput,
  GateStateValue,
  RunArtifact,
} from "../artifacts/types.js";
import {
  CONFORMANCE_REPORT_MEDIA_TYPE,
  DEFAULT_CONFORMANCE_REPORT_ID,
  evaluateConformanceReport,
  parseConformanceReportText,
  type ConformanceFinding,
  type ConformancePolicy,
  type ConformanceReport,
} from "../conformance/report.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import type { Stage } from "../flow/schema.js";
import {
  eventStorePath,
  getProjectedRun,
  getProjectedRunLogs,
  listProjectedRuns,
  listRunEvents,
  projectedRunLogSources,
  projectRun,
  type ProjectedAttempt,
  type ProjectedAttemptBudget,
  type ProjectedRiskClassification,
  type ProjectedBudgetSummary,
  type ProjectedContextUsage,
  type ProjectedContextKnowledgeEntry,
  type ProjectedKnowledgeRetrieval,
  type ProjectedOperatorQuestion,
  type ProjectedRun,
  type ProjectedRunBlocker,
  type ProjectedRunLogSource,
  type ProjectedRunStatus,
  type ProjectedRuntimeUsageTotal,
  type ProjectedVerificationBudget,
  type ProjectedStage,
  type ProjectedTaskPlanLoop,
  type ProjectedWorkflowStage,
  staleRunningRunMs,
  sumContextUsage,
  sumRuntimeUsage,
} from "../run/project.js";
import type { RunEligibilityOverrideEvidence } from "../run/eligibility.js";
import {
  buildRunTrace,
  type RunTraceProjection,
} from "../run/trace.js";
import {
  diagnosticForManifest,
  readReproducibilityManifest,
  reproducibilityManifestPath,
  type ReproducibilityDiagnostic,
} from "../run/reproducibility.js";
import {
  RECOVERY_METADATA_FILENAME,
  RECOVERY_PATCH_FILENAME,
  readRecoverySnapshot,
  type RecoverySnapshot,
} from "../run/recovery.js";
import {
  readToolchainPreflight,
  type ToolchainPreflight,
} from "../run/toolchain-preflight.js";
import type { NormalizedReviewFeedback } from "../review-feedback/model.js";
import { feedbackMemoryEntryId } from "../review-feedback/memory.js";
import type { OrchestratorDecisionEvent } from "../policy/decide.js";
import type { ChangeRequestStatus } from "../scm/types.js";
import type { PlanningApprovalStatus } from "../work-items/planning.js";
import { WebInputError, WebNotFoundError } from "./errors.js";
import { redactForWeb, redactUnknownForWeb } from "./redaction.js";

export const WEB_RUN_STATUSES = [
  "completed",
  "running",
  "awaiting-approval",
  "failed",
  "blocked",
  "incomplete",
  "interrupted",
  "cancelled",
] as const;

export type WebRunStatus = (typeof WEB_RUN_STATUSES)[number];

export type WebRunRecoveryState = "stale" | "interrupted" | "blocked";

export interface WebRunRecovery {
  needsRecovery: boolean;
  state: WebRunRecoveryState;
  stale: boolean;
  reason: string;
  stageId?: string;
  attempt?: number;
  latestEventAt?: string;
  staleAfterMs?: number;
}

export type WebStageProcessState =
  | "waiting"
  | "running"
  | "finished"
  | "interrupted";

export interface WebStageProcess {
  kind: string;
  label: string;
  command?: string;
  runtime?: string;
  model?: string;
  state: WebStageProcessState;
  alive?: boolean;
  lastActivityAt?: string;
}

export type WebArtifactReadinessStatus =
  | "not-applicable"
  | "pending"
  | "partial"
  | "ready"
  | "missing";

export interface WebArtifactReadiness {
  status: WebArtifactReadinessStatus;
  declaredIds: string[];
  readyIds: string[];
  missingIds: string[];
}

export interface WebRunPublication {
  state: "published" | "updated";
  branchName?: string;
  headCommit?: string;
  changeRequestUrl?: string;
  prNumber?: number;
}

export interface WebRecoveryArtifact {
  status: RecoverySnapshot["status"];
  path?: typeof RECOVERY_PATCH_FILENAME;
  metadataPath: typeof RECOVERY_METADATA_FILENAME;
  capturedAt: string;
  baseSha: string;
  headSha?: string;
  patchBytes?: number;
  patchSha256?: string;
  changedPaths: string[];
  untrackedPaths: string[];
  omittedCount: number;
  message?: string;
}

export type WebStageState =
  | "pending"
  | "running"
  | "gate-checking"
  | "awaiting-approval"
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
  process?: WebStageProcess;
  artifactReadiness?: WebArtifactReadiness;
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
  taskPlan?: ProjectedTaskPlanLoop;
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

export interface WebWorkflowProgressItem {
  stageId: string;
  label: string;
  stageType?: string;
  status: WebSessionTimelineItem["status"] | "pending";
  state: WebStageState;
  current: boolean;
  attempts: number;
  currentAttempt?: number;
  maxAttempts?: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  durationMs?: number;
  inputs: string[];
  outputs: string[];
  latestOutput?: string;
  process?: WebStageProcess;
  artifactReadiness?: WebArtifactReadiness;
  latestDecision?: OrchestratorDecisionEvent;
  blocker?: ProjectedRunBlocker;
  approval?: Pick<
    ProjectedRun["approvals"][number],
    "id" | "status" | "prompt" | "requestedAt" | "resolvedAt" | "actor" | "decision"
  >;
  artifacts: WebStageDetailArtifact[];
  nextAction?: string;
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

export interface WebConformanceArtifact {
  id: string;
  producer?: string;
  type?: string;
  mediaType?: string;
  path?: string;
}

export interface WebConformanceReport {
  reportId: string;
  stageId?: string;
  policy?: ConformancePolicy;
  artifact?: WebConformanceArtifact;
  report?: ConformanceReport;
  findings: ConformanceFinding[];
  errors: string[];
}

export interface WebRunRuntimeSlice {
  runtime?: string;
  model?: string;
}

export interface WebRunFactorySignals {
  agentAttempts: number;
  judgeAttempts: number;
  ciRuns: number;
  humanApprovalEvents: number;
  humanApprovalWaitMs?: number;
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
  repoSynthetic?: boolean;
  branchName?: string;
  baseBranch?: string;
  worktreePath?: string;
  completedStages: string[];
  currentStage?: string;
  currentAttempt?: number;
  currentStageState?: WebStageState;
  finalizerStage?: string;
  finalizerAttempt?: number;
  finalizerStageState?: WebStageState;
  latestOutputSummary?: string;
  statusSummary?: string;
  currentProcess?: WebStageProcess;
  currentArtifactReadiness?: WebArtifactReadiness;
  publication?: WebRunPublication;
  recoveryArtifact?: WebRecoveryArtifact;
  latestDecision?: OrchestratorDecisionEvent;
  blocker?: ProjectedRunBlocker;
  questions?: ProjectedOperatorQuestion[];
  pendingQuestion?: ProjectedOperatorQuestion;
  activeQuestion?: ProjectedOperatorQuestion;
  inputs: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  changeRequestUrl?: string;
  changeRequestStatus?: ChangeRequestStatus;
  prNumber?: number;
  prUrl?: string;
  taskId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  runEligibilityOverride?: RunEligibilityOverrideEvidence;
  startedAt?: string;
  completedAt?: string;
  trigger?: unknown;
  reviewFeedback?: NormalizedReviewFeedback;
  priorRunId?: string;
  contextKnowledge?: ProjectedContextKnowledgeEntry[];
  knowledgeRetrievals?: ProjectedKnowledgeRetrieval[];
  contextUsage?: ProjectedContextUsage;
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  runtimeSlices?: WebRunRuntimeSlice[];
  factorySignals?: WebRunFactorySignals;
  budgetSummary?: ProjectedBudgetSummary;
  verificationBudget?: ProjectedVerificationBudget;
  taskPlan?: ProjectedTaskPlanLoop;
  recovery?: WebRunRecovery;
}

export interface WebRunDetail extends WebRunSummary {
  evidence?: string;
  logs: WebRedactedLog[];
  artifacts: RunArtifact[];
  gates: GateResult[];
  trace?: RunTraceProjection;
  contextManifest: WebSessionContextItem[];
  timeline: WebSessionTimelineItem[];
  workflowProgress: WebWorkflowProgressItem[];
  evidenceTimeline: RunEvidenceItem[];
  reviewFindings: WebReviewArtifact[];
  conformance: WebConformanceReport[];
  parentRun?: WebRunSummary;
  childRuns: WebRunSummary[];
  budgetSummary?: ProjectedBudgetSummary;
  verificationBudget?: ProjectedVerificationBudget;
  reproducibility?: ReproducibilityDiagnostic;
  toolchainPreflight?: ToolchainPreflight;
  /**
   * Effective risk of what the run changed, and the review it therefore
   * needs. Present once a publication decision has been classified; it is
   * what the approval inbox shows to explain why a human is required.
   */
  riskClassification?: ProjectedRiskClassification;
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
  return typeof value === "string" &&
    (WEB_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as WebRunStatus)
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
    questionId: asString(record.questionId),
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
    (mode !== "deterministic" &&
      mode !== "review" &&
      mode !== "review-aggregate" &&
      mode !== "analysis" &&
      mode !== "security") ||
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
  const operatorReviewRecord = asRecord(record.operatorReview);
  const operatorReviewBlocker = asRecord(operatorReviewRecord.blocker);
  const operatorReviewActor = asString(operatorReviewRecord.actor);
  const operatorReviewSubmittedAt = asString(operatorReviewRecord.submittedAt);
  const operatorReviewArtifactIds = asStringArray(
    operatorReviewRecord.reviewedArtifactIds,
  );
  const operatorReviewBlockerReason = asString(operatorReviewBlocker.reason);
  const operatorReviewBlockerStageId = asString(operatorReviewBlocker.stageId);
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
    ...(operatorReviewActor &&
    operatorReviewSubmittedAt &&
    operatorReviewArtifactIds &&
    operatorReviewBlockerReason &&
    operatorReviewBlockerStageId
      ? {
          operatorReview: {
            actor: operatorReviewActor,
            submittedAt: operatorReviewSubmittedAt,
            reviewedArtifactIds: operatorReviewArtifactIds,
            blocker: {
              reason: operatorReviewBlockerReason,
              stageId: operatorReviewBlockerStageId,
              ...(asString(operatorReviewBlocker.runtime)
                ? { runtime: asString(operatorReviewBlocker.runtime) }
                : {}),
              ...(asString(operatorReviewBlocker.message)
                ? { message: asString(operatorReviewBlocker.message) }
                : {}),
              ...(asString(operatorReviewBlocker.retryAfter)
                ? { retryAfter: asString(operatorReviewBlocker.retryAfter) }
                : {}),
            },
          },
        }
      : {}),
    reason: asString(record.reason),
    advisoryReason: asString(record.advisoryReason),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    attempt:
      typeof record.attempt === "number" && Number.isFinite(record.attempt)
        ? record.attempt
        : undefined,
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

function reviewFeedbackFromTrigger(
  trigger: unknown,
): NormalizedReviewFeedback | undefined {
  const feedback = asRecord(asRecord(trigger).feedback);
  if (feedback.schemaVersion !== 1) return undefined;
  const id = asString(feedback.id);
  const action = asString(feedback.action);
  const instruction = asString(feedback.instruction);
  const route = asRecord(feedback.route);
  const routeTarget = asString(route.target);
  if (!id || !action || !instruction || !routeTarget) return undefined;
  return redactUnknownForWeb(feedback) as NormalizedReviewFeedback;
}

async function enrichReviewFeedbackMemoryProposals(
  repoPath: string,
  feedback: NormalizedReviewFeedback | undefined,
): Promise<NormalizedReviewFeedback | undefined> {
  if (!feedback || feedback.memoryProposals.length === 0) return feedback;
  let entries: ContextKnowledgeEntry[];
  try {
    entries = await listContextKnowledgeEntries(repoPath);
  } catch {
    return feedback;
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    ...feedback,
    memoryProposals: feedback.memoryProposals.map((proposal, index) => {
      const entryId =
        proposal.contextKnowledgeEntryId ?? feedbackMemoryEntryId(feedback, index);
      const entry = entriesById.get(entryId);
      if (!entry) return proposal;
      return {
        ...proposal,
        contextKnowledgeEntryId: entry.id,
        contextKnowledgeStatus: entry.status,
        contextKnowledgeVersion: entry.version,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        keywords: entry.keywords,
      };
    }),
  };
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
  const reviewFeedback = reviewFeedbackFromTrigger(trigger);
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
    runEligibilityOverride:
      typeof record.runEligibilityOverride === "object" &&
      record.runEligibilityOverride !== null
        ? (record.runEligibilityOverride as RunEligibilityOverrideEvidence)
        : undefined,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
    completedAt:
      typeof record.completedAt === "string" ? record.completedAt : undefined,
    trigger,
    ...(reviewFeedback ? { reviewFeedback } : {}),
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

function currentWorkflowStage(projection: ProjectedRun): ProjectedStage | undefined {
  if (projection.terminalStageId) {
    return (
      projection.stages.find((stage) => stage.stageId === projection.terminalStageId) ??
      latestStage(projection)
    );
  }
  return latestStage(projection);
}

function latestFinalizerStage(projection: ProjectedRun): ProjectedStage | undefined {
  const finalizerStageId = projection.finalizerStageIds?.at(-1);
  if (!finalizerStageId) return undefined;
  return projection.stages.find((stage) => stage.stageId === finalizerStageId);
}

function latestOpenAttemptEventTimeMs(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): number | undefined {
  const stage = latestStage(projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  if (!stage || !attempt) return undefined;
  const latest = events
    .filter(
      (event) =>
        event.stageId === stage.stageId && event.attempt === attempt.attempt,
    )
    .map((event) => Date.parse(event.createdAt))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => right - left)
    .at(0);
  return latest;
}

function hasOpenStartedAttempt(projection: ProjectedRun): boolean {
  const stage = latestStage(projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  return attempt?.status === "started";
}

function recoveryStage(projection: ProjectedRun): {
  stageId?: string;
  attempt?: number;
} {
  const stage = currentWorkflowStage(projection) ?? latestStage(projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  return {
    stageId: stage?.stageId,
    attempt: attempt?.attempt,
  };
}

function recoveryForProjection(
  projection: ProjectedRun,
): WebRunRecovery | undefined {
  if (projection.status === "blocked") {
    return {
      needsRecovery: true,
      state: "blocked",
      stale: false,
      reason: projection.blocker?.reason ?? "run is blocked",
      ...recoveryStage(projection),
    };
  }
  if (projection.status === "interrupted") {
    return {
      needsRecovery: true,
      state: "interrupted",
      stale: false,
      reason: "run has an interrupted attempt",
      ...recoveryStage(projection),
    };
  }
  return undefined;
}

function staleAwareProjectionWithRecovery(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): { projection: ProjectedRun; recovery?: WebRunRecovery } {
  const recovery = recoveryForProjection(projection);
  if (projection.status !== "running" || !hasOpenStartedAttempt(projection)) {
    return { projection, recovery };
  }
  const latest = latestOpenAttemptEventTimeMs(projection, events);
  if (latest === undefined) {
    return { projection, recovery };
  }
  const staleAfterMs = staleRunningRunMs();
  if (Date.now() - latest < staleAfterMs) {
    return { projection, recovery };
  }
  const staleProjection = projectRun(events, { openAttemptStatus: "interrupted" });
  return {
    projection: staleProjection,
    recovery: {
      needsRecovery: true,
      state: "stale",
      stale: true,
      reason: "open attempt exceeded stale threshold",
      latestEventAt: new Date(latest).toISOString(),
      staleAfterMs,
      ...recoveryStage(staleProjection),
    },
  };
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
  if (stage.status === "awaiting-approval") return "awaiting-approval";
  if (stage.status === "failed") return "awaiting-orchestrator";
  if (stage.status === "interrupted") return "interrupted";
  if (stage.stageType === "gate" || stage.gate) return "gate-checking";
  if (hasOpenAttempt(stage)) return "running";
  if (stage.status === "pending") return "pending";
  return "pending";
}

type StageOperatorDeclaration = Stage | ProjectedWorkflowStage;

function stageDeclaration(
  projection: ProjectedRun,
  stageId: string,
): ProjectedWorkflowStage | undefined {
  return projection.workflowStages?.find((stage) => stage.id === stageId);
}

function declarationCommand(
  declaration: StageOperatorDeclaration | undefined,
): string | undefined {
  if (!declaration) return undefined;
  const command = (declaration as { command?: unknown }).command;
  return typeof command === "string" ? redactForWeb(command) : undefined;
}

function declarationOutputs(
  declaration: StageOperatorDeclaration | undefined,
): string[] {
  if (!declaration) return [];
  return declaration.outputs.map((output) =>
    typeof output === "string" ? output : output.id,
  );
}

function latestAttemptActivityAt(
  events: StoredRunEvent[],
  stageId: string,
  attempt: number,
): string | undefined {
  return events
    .filter((event) => event.stageId === stageId && event.attempt === attempt)
    .map((event) => event.createdAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
}

function processForStage(input: {
  stage: ProjectedStage;
  declaration?: StageOperatorDeclaration;
  state: WebStageState;
  events: StoredRunEvent[];
}): WebStageProcess | undefined {
  const attempt = latestAttempt(input.stage);
  if (!attempt && input.state === "pending") {
    const kind = input.stage.stageType ?? input.declaration?.type ?? "stage";
    return { kind, label: declarationCommand(input.declaration) ?? kind, state: "waiting" };
  }
  if (!attempt) return undefined;
  const kind = input.stage.stageType ?? input.declaration?.type ?? "stage";
  const command = declarationCommand(input.declaration);
  const runtime = redactForWeb(attempt.runtime);
  const model = redactForWeb(attempt.model);
  const runtimeLabel = [runtime, model]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const label = command ?? (runtimeLabel || kind);
  const lastActivityAt = latestAttemptActivityAt(
    input.events,
    input.stage.stageId,
    attempt.attempt,
  );
  const open = attempt.status === "started";
  const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
  const alive =
    open &&
    Number.isFinite(lastActivityMs) &&
    Date.now() - lastActivityMs < staleRunningRunMs();
  const state: WebStageProcessState =
    input.state === "pending"
      ? "waiting"
      : input.state === "interrupted" || (open && !alive)
        ? "interrupted"
        : open
          ? "running"
          : "finished";
  return {
    kind,
    label: label || kind,
    ...(command ? { command } : {}),
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    state,
    ...(state !== "waiting" ? { alive: state === "running" && alive } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function artifactReadinessForStage(input: {
  stageId: string;
  declaration?: StageOperatorDeclaration;
  artifacts: RunArtifact[];
  state: WebStageState;
}): WebArtifactReadiness {
  const declaredIds = declarationOutputs(input.declaration);
  const publishedIds = new Set(
    input.artifacts
      .filter((artifact) => artifact.producer === input.stageId)
      .map((artifact) => artifact.id),
  );
  const readyIds = declaredIds.filter((id) => publishedIds.has(id));
  const missingIds = declaredIds.filter((id) => !publishedIds.has(id));
  const active =
    input.state === "pending" ||
    input.state === "running" ||
    input.state === "gate-checking" ||
    input.state === "awaiting-approval";
  const status: WebArtifactReadinessStatus =
    declaredIds.length === 0
      ? "not-applicable"
      : missingIds.length === 0
        ? "ready"
        : readyIds.length > 0
          ? "partial"
          : active
            ? "pending"
            : "missing";
  return { status, declaredIds, readyIds, missingIds };
}

function publicationForEvents(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): WebRunPublication | undefined {
  const event = events
    .filter(
      (candidate) =>
        candidate.type === "change.published" || candidate.type === "change.updated",
    )
    .at(-1);
  if (!event) return undefined;
  const payload = asRecord(redactUnknownForWeb(event.payload));
  const changeRequest = asRecord(payload.changeRequest);
  const changeRequestUrl =
    asString(payload.url) ??
    asString(changeRequest.url) ??
    projection.changeRequestUrl;
  const prNumber =
    asNumber(changeRequest.number) ?? prMetadata({ changeRequestUrl }).prNumber;
  return {
    state: event.type === "change.updated" ? "updated" : "published",
    branchName:
      asString(payload.branchName) ??
      asString(changeRequest.headBranch) ??
      projection.branchName,
    headCommit:
      asString(payload.headCommit) ??
      asString(payload.updatedHeadSha),
    changeRequestUrl,
    ...(prNumber !== undefined ? { prNumber } : {}),
  };
}

function webRecoveryArtifact(
  snapshot: RecoverySnapshot | undefined,
): WebRecoveryArtifact | undefined {
  if (!snapshot) return undefined;
  return {
    status: snapshot.status,
    ...(snapshot.patchPath === RECOVERY_PATCH_FILENAME
      ? { path: RECOVERY_PATCH_FILENAME }
      : {}),
    metadataPath: RECOVERY_METADATA_FILENAME,
    capturedAt: snapshot.capturedAt,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    patchBytes: snapshot.patchBytes,
    patchSha256: snapshot.patchSha256,
    changedPaths: snapshot.changedPaths.map((path) => redactForWeb(path) ?? ""),
    untrackedPaths: snapshot.untrackedPaths.map((path) => redactForWeb(path) ?? ""),
    omittedCount: snapshot.omitted.length,
    message: redactForWeb(snapshot.message),
  };
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

function meaningfulOutputLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  if (/^(?:stdout|stderr)(?:\s+(?:was\s+)?(?:not\s+captured|unavailable|empty))?[.:]?$/i.test(normalized)) {
    return false;
  }
  if (/^[\d\s,._:/+%#=-]+$/.test(normalized)) return false;
  return /[\p{L}]/u.test(normalized);
}

function compactOutput(value: string | undefined): string | undefined {
  const redacted = redactForWeb(value)?.trim();
  if (!redacted) return undefined;
  return redacted.length > 240 ? `...${redacted.slice(-237)}` : redacted;
}

/**
 * How much of one attempt log a Run summary reads.
 *
 * A summary needs the newest meaningful line of a Run, not its logs, so the
 * cost of listing a Run must not grow with how much that Run wrote (#518).
 * Only when a tail holds no meaningful line does the walk fall back to the
 * attempt before it, so a line older than this window is reachable but never
 * paid for by default.
 */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Everything a Run summary needs from a Run's logs: the newest meaningful
 * line, the newest meaningful line of the stage the summary points at, and
 * whether the Run wrote any output at all.
 */
interface RunOutputDigest {
  hadOutput: boolean;
  latest?: string;
  currentStage?: string;
}

/** A digest plus the stage and attempt the newest log on disk belongs to. */
interface RunDirectoryDigest extends RunOutputDigest {
  lastStageId?: string;
  lastAttempt?: string;
}

const EMPTY_RUN_OUTPUT_DIGEST: RunOutputDigest = { hadOutput: false };

interface OutputChunk {
  stdout?: string;
  stderr?: string;
}

/** One log entry, with its content still unread. */
interface OutputEntry {
  stageId: string;
  read: () => Promise<OutputChunk> | OutputChunk;
}

/**
 * Walks log entries newest-first and stops as soon as the summary fields are
 * settled. Reading forwards would mean reading every entry of every Run in a
 * listing, which is the whole cost this avoids.
 *
 * Entry content is raw here rather than pre-redacted: the lines that reach a
 * summary go through `compactOutput`, which redacts, and redaction masks
 * values inside a line rather than removing lines.
 */
async function outputDigest(
  entries: OutputEntry[],
  currentStageId: string | undefined,
): Promise<RunOutputDigest> {
  let hadOutput = false;
  let latest: string | undefined;
  let latestResolved = false;
  let currentStage: string | undefined;
  let currentStageResolved = currentStageId === undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const wantsStage = !currentStageResolved && entry.stageId === currentStageId;
    // A settled latest line already proves the Run produced output, so an
    // entry that can no longer settle either field is never read.
    if (latestResolved && !wantsStage) continue;
    const chunk = await entry.read();
    const lines = [...outputLines(chunk.stdout), ...outputLines(chunk.stderr)];
    if (lines.length > 0) hadOutput = true;
    const meaningful = lines.filter(meaningfulOutputLine).at(-1);
    if (meaningful !== undefined) {
      if (!latestResolved) {
        latestResolved = true;
        latest = compactOutput(meaningful);
      }
      if (wantsStage) {
        currentStageResolved = true;
        currentStage = compactOutput(meaningful);
      }
    }
    if (latestResolved && currentStageResolved) break;
  }
  return {
    hadOutput,
    ...(latest !== undefined ? { latest } : {}),
    ...(currentStage !== undefined ? { currentStage } : {}),
  };
}

/**
 * Reads the last `OUTPUT_TAIL_BYTES` of a log. A tail can start mid-line and
 * mid-character, so a truncated head is dropped rather than reported as
 * output.
 */
async function readOutputTail(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, OUTPUT_TAIL_BYTES);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

function attemptOutputEntry(
  stageId: string,
  attemptDirectory: string,
): OutputEntry {
  return {
    stageId,
    read: async () => {
      const [stdout, stderr] = await Promise.all([
        readOutputTail(join(attemptDirectory, "stdout.log")),
        readOutputTail(join(attemptDirectory, "stderr.log")),
      ]);
      return { stdout, stderr };
    },
  };
}

function projectedOutputEntry(source: ProjectedRunLogSource): OutputEntry {
  return source.attemptDirectory === undefined
    ? {
        stageId: source.stageId,
        read: () => ({ stdout: source.stdout, stderr: source.stderr }),
      }
    : attemptOutputEntry(source.stageId, source.attemptDirectory);
}

function outputDigestFromLogs(
  logs: WebRedactedLog[],
  currentStageId: string | undefined,
): Promise<RunOutputDigest> {
  return outputDigest(
    logs.map((log) => ({
      stageId: log.stageId,
      read: () => ({ stdout: log.stdout, stderr: log.stderr }),
    })),
    currentStageId,
  );
}

function projectedOutputDigest(
  repoPath: string,
  projection: ProjectedRun,
  currentStageId: string | undefined,
): Promise<RunOutputDigest> {
  return outputDigest(
    projectedRunLogSources(repoPath, projection.runId, projection).map(
      projectedOutputEntry,
    ),
    currentStageId,
  );
}

interface AttemptLogDirectory {
  stageId: string;
  attempt: string;
  attemptDirectory: string;
}

/**
 * Lists the attempt directories that hold a log, without reading one. Stage
 * and attempt come from the directory names, which is what a summary needs
 * them for; only the newest line still costs a read.
 */
async function listAttemptLogDirectories(
  runDirectory: string,
): Promise<AttemptLogDirectory[]> {
  const stagesDirectory = join(runDirectory, "stages");
  let stageIds: string[] = [];
  try {
    stageIds = await readdir(stagesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const directories: AttemptLogDirectory[] = [];
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
      let entries: string[] = [];
      try {
        entries = await readdir(attemptDirectory);
      } catch {
        continue;
      }
      if (!entries.includes("stdout.log") && !entries.includes("stderr.log")) {
        continue;
      }
      directories.push({ stageId, attempt, attemptDirectory });
    }
  }
  return directories;
}

async function readRunDirectoryDigest(
  runDirectory: string,
): Promise<RunDirectoryDigest> {
  const attempts = await listAttemptLogDirectories(runDirectory);
  const digest = await outputDigest(
    attempts.map((attempt) =>
      attemptOutputEntry(attempt.stageId, attempt.attemptDirectory),
    ),
    undefined,
  );
  const last = attempts.at(-1);
  return {
    ...digest,
    ...(last
      ? { lastStageId: last.stageId, lastAttempt: last.attempt }
      : {}),
  };
}

function artifactReadinessSummary(
  readiness: WebArtifactReadiness | undefined,
): string | undefined {
  if (!readiness || readiness.status === "not-applicable") return undefined;
  return `artifacts ${readiness.readyIds.length}/${readiness.declaredIds.length} ready`;
}

function latestRuntimeFallbackSummary(
  events: StoredRunEvent[],
  stageId: string | undefined,
): string | undefined {
  const event = events
    .filter(
      (candidate) =>
        candidate.type === "stage.runtime.fallback" &&
        (stageId === undefined || candidate.stageId === stageId),
    )
    .at(-1);
  if (!event) return undefined;
  const payload = asRecord(redactUnknownForWeb(event.payload));
  const blocker = asRecord(payload.blocker);
  const failed = asString(payload.failedRuntime) ?? "previous runtime";
  const next = asString(payload.nextRuntime) ?? "fallback runtime";
  const reason = asString(blocker.message) ?? asString(blocker.reason);
  return `Fell back from ${failed} to ${next}${reason ? ` (${reason})` : ""}.`;
}

function operatorStatusSummary(input: {
  projection: ProjectedRun;
  process?: WebStageProcess;
  readiness?: WebArtifactReadiness;
  publication?: WebRunPublication;
  recoveryArtifact?: WebRecoveryArtifact;
  events: StoredRunEvent[];
}): string {
  const stage = currentWorkflowStage(input.projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  const state = stage ? projectedStageState(input.projection, stage) : undefined;
  const stageAttempt = stage
    ? `${stage.stageId}${attempt ? ` attempt ${attempt.attempt}` : ""}`
    : "run";
  if (input.publication && input.projection.status === "completed") {
    const pr = input.publication.prNumber
      ? `PR #${input.publication.prNumber}`
      : "change request";
    const branch = input.publication.branchName
      ? ` from ${input.publication.branchName}`
      : "";
    const commit = input.publication.headCommit
      ? ` at ${input.publication.headCommit.slice(0, 7)}`
      : "";
    return `${input.publication.state === "updated" ? "Updated" : "Published"} ${pr}${branch}${commit}.`;
  }

  const readiness = artifactReadinessSummary(input.readiness);
  const process = input.process?.label ? ` · ${input.process.label}` : "";
  const fallback = latestRuntimeFallbackSummary(input.events, stage?.stageId);
  let summary: string;
  if (
    input.projection.status === "interrupted" ||
    state === "interrupted" ||
    input.process?.state === "interrupted"
  ) {
    const recovery = input.recoveryArtifact
      ? ` · recovery patch ${input.recoveryArtifact.status} · ${input.recoveryArtifact.changedPaths.length} changed file${input.recoveryArtifact.changedPaths.length === 1 ? "" : "s"}`
      : " · no recovery patch available";
    summary = `Interrupted ${stageAttempt}${process}${recovery}.`;
  } else if (input.projection.status === "blocked" || state === "blocked") {
    const reason =
      input.projection.blocker?.message ??
      input.projection.blocker?.reason ??
      "operator action required";
    const recovery = input.recoveryArtifact?.path
      ? ` · recovery patch ${input.recoveryArtifact.status}`
      : "";
    summary = `Blocked at ${stageAttempt}: ${reason}${recovery}.`;
  } else if (input.projection.status === "failed" || state === "failed") {
    const error = stage
      ? compactOutput(
          stage.attempts
            .map((candidate) => candidate.error)
            .filter((value): value is string => value !== undefined)
            .at(-1),
        )
      : undefined;
    summary = `Failed at ${stageAttempt}${error ? `: ${error}` : "."}`;
  } else if (input.projection.status === "awaiting-approval" || state === "awaiting-approval") {
    summary = `Awaiting approval at ${stageAttempt}${readiness ? ` · ${readiness}` : ""}.`;
  } else if (state === "running" || state === "gate-checking") {
    summary = `Running ${stageAttempt}${process} · process ${input.process?.alive ? "active" : "activity unknown"}${readiness ? ` · ${readiness}` : ""}.`;
  } else if (input.projection.status === "completed") {
    summary = `Completed ${stageAttempt}${readiness ? ` · ${readiness}` : ""}.`;
  } else {
    summary = `${stageAttempt} is ${state ?? input.projection.status}.`;
  }
  return fallback ? `${fallback} ${summary}` : summary;
}

function latestOutputSummary(logs: WebRedactedLog[]): string | undefined {
  const lines: string[] = [];
  for (const log of logs) {
    lines.push(...outputLines(log.stdout), ...outputLines(log.stderr));
  }
  return compactOutput(lines.filter(meaningfulOutputLine).at(-1));
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
      if (meaningfulOutputLine(line)) byStage.set(log.stageId, line);
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
  digest: RunOutputDigest,
): Pick<
  WebRunSummary,
  | "currentStage"
  | "currentAttempt"
  | "currentStageState"
  | "finalizerStage"
  | "finalizerAttempt"
  | "finalizerStageState"
  | "latestOutputSummary"
  | "latestDecision"
> {
  const stage = currentWorkflowStage(projection);
  const attempt = stage ? latestAttempt(stage) : undefined;
  const finalizerStage = latestFinalizerStage(projection);
  const finalizerAttempt = finalizerStage
    ? latestAttempt(finalizerStage)
    : undefined;
  const finalizerState = finalizerStage
    ? projectedStageState(projection, finalizerStage)
    : undefined;
  const attemptError = stage ? compactOutput(latestAttemptError(stage.attempts)) : undefined;
  const state = stage ? projectedStageState(projection, stage) : undefined;
  const latestOutput = state
    ? latestStageOutput({
        state,
        stageOutput: digest.currentStage,
        attemptError,
        fallbackOutput: digest.latest,
      })
    : digest.latest;
  return {
    ...(stage ? { currentStage: stage.stageId } : {}),
    ...(attempt ? { currentAttempt: attempt.attempt } : {}),
    ...(state ? { currentStageState: state } : {}),
    ...(finalizerStage ? { finalizerStage: finalizerStage.stageId } : {}),
    ...(finalizerAttempt ? { finalizerAttempt: finalizerAttempt.attempt } : {}),
    ...(finalizerState ? { finalizerStageState: finalizerState } : {}),
    ...(latestOutput ? { latestOutputSummary: latestOutput } : {}),
    ...(latestDecision(projection) ? { latestDecision: latestDecision(projection) } : {}),
  };
}

function attemptNumber(attempt: string | undefined): number | undefined {
  const parsed = Number(attempt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function attemptFromLogs(logs: WebRedactedLog[]): number | undefined {
  return attemptNumber(logs.at(-1)?.attempt);
}

function webStateFieldsFromDigest(
  summary: Pick<WebRunSummary, "status" | "completedStages">,
  digest: Pick<RunDirectoryDigest, "latest" | "lastStageId" | "lastAttempt">,
): Pick<WebRunSummary, "currentStage" | "currentAttempt" | "currentStageState" | "latestOutputSummary"> {
  const currentStage = digest.lastStageId ?? summary.completedStages.at(-1);
  const currentAttempt = attemptNumber(digest.lastAttempt);
  const terminalState =
    summary.status === "completed" ||
    summary.status === "failed" ||
    summary.status === "cancelled" ||
    summary.status === "interrupted"
      ? summary.status
      : undefined;
  return {
    ...(currentStage ? { currentStage } : {}),
    ...(currentAttempt ? { currentAttempt } : {}),
    currentStageState: terminalState ?? (currentStage ? "running" : "pending"),
    ...(digest.latest ? { latestOutputSummary: digest.latest } : {}),
  };
}

/**
 * The same fields for a caller that already holds the logs, so a Run detail
 * view and a Run listing cannot drift apart on what a Run's current stage is.
 */
function webStateFieldsFromLogs(
  summary: Pick<WebRunSummary, "status" | "completedStages">,
  logs: WebRedactedLog[],
): Pick<WebRunSummary, "currentStage" | "currentAttempt" | "currentStageState" | "latestOutputSummary"> {
  const last = logs.at(-1);
  return webStateFieldsFromDigest(summary, {
    ...(latestOutputSummary(logs) !== undefined
      ? { latest: latestOutputSummary(logs) }
      : {}),
    ...(last ? { lastStageId: last.stageId, lastAttempt: last.attempt } : {}),
  });
}

function runtimeSlicesFromProjection(projection: ProjectedRun): WebRunRuntimeSlice[] {
  const slices: WebRunRuntimeSlice[] = [];
  const seen = new Set<string>();
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      const runtime = attempt.runtime;
      const model = attempt.model ?? attempt.runtimeUsage?.provenance?.model;
      if (!runtime && !model) continue;
      const key = `${runtime ?? ""}\u0000${model ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slices.push({
        ...(runtime ? { runtime } : {}),
        ...(model ? { model } : {}),
      });
    }
  }
  return slices;
}

function projectedRunSummary(
  projection: ProjectedRun,
  digest: RunOutputDigest = EMPTY_RUN_OUTPUT_DIGEST,
  recovery = recoveryForProjection(projection),
  events: StoredRunEvent[] = [],
  recoveryArtifact?: WebRecoveryArtifact,
): WebRunSummary {
  const inputs = (redactUnknownForWeb(projection.inputs ?? {}) ?? {}) as Record<string, unknown>;
  const trigger = redactUnknownForWeb(projection.trigger);
  const reviewFeedback = reviewFeedbackFromTrigger(trigger);
  const pr = prMetadata({
    changeRequestUrl: projection.changeRequestUrl,
    trigger,
  });
  const current = currentWorkflowStage(projection);
  const currentState = current ? projectedStageState(projection, current) : undefined;
  const currentDeclaration = current
    ? stageDeclaration(projection, current.stageId)
    : undefined;
  const currentProcess = current && currentState
    ? processForStage({
        stage: current,
        declaration: currentDeclaration,
        state: currentState,
        events,
      })
    : undefined;
  const currentArtifactReadiness = current && currentState
    ? artifactReadinessForStage({
        stageId: current.stageId,
        declaration: currentDeclaration,
        artifacts: projection.artifacts,
        state: currentState,
      })
    : undefined;
  const publication = publicationForEvents(projection, events);
  const statusSummary = operatorStatusSummary({
    projection,
    process: currentProcess,
    readiness: currentArtifactReadiness,
    publication,
    recoveryArtifact,
    events,
  });
  const stateFields = webStateFieldsFromProjection(projection, digest);
  const startedAt = projection.stages
    .flatMap((stage) => stage.attempts)
    .map((attempt) => attempt.startedAt)
    .find(Boolean);
  const completedAt = projection.stages
    .flatMap((stage) => stage.attempts)
    .map((attempt) => attempt.completedAt ?? attempt.failedAt)
    .filter((value): value is string => value !== undefined)
    .at(-1);
  const factorySignals: WebRunFactorySignals = {
    agentAttempts: projection.stages
      .filter((stage) => stage.stageType === "agent")
      .reduce((total, stage) => total + stage.attempts.length, 0),
    judgeAttempts: projection.stages
      .filter((stage) => stage.stageType === "judge")
      .reduce((total, stage) => total + stage.attempts.length, 0),
    ciRuns: projection.stages
      .filter((stage) => stage.stageType === "command")
      .reduce((total, stage) => total + stage.attempts.length, 0),
    humanApprovalEvents: projection.approvals.length,
  };
  const approvalWaitMs = projection.approvals.reduce((total, approval) => {
    if (!approval.resolvedAt) return total;
    const started = Date.parse(approval.requestedAt);
    const resolved = Date.parse(approval.resolvedAt);
    return Number.isFinite(started) && Number.isFinite(resolved) && resolved >= started
      ? total + resolved - started
      : total;
  }, 0);
  if (approvalWaitMs > 0) factorySignals.humanApprovalWaitMs = approvalWaitMs;
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
    ...stateFields,
    ...(stateFields.latestOutputSummary || digest.hadOutput
      ? { latestOutputSummary: stateFields.latestOutputSummary ?? statusSummary }
      : {}),
    statusSummary,
    ...(currentProcess ? { currentProcess } : {}),
    ...(currentArtifactReadiness ? { currentArtifactReadiness } : {}),
    ...(publication ? { publication } : {}),
    ...(recoveryArtifact ? { recoveryArtifact } : {}),
    ...(webBlocker(projection.blocker)
      ? { blocker: webBlocker(projection.blocker) }
      : {}),
    ...((projection.questions ?? []).length > 0
      ? {
          questions: redactUnknownForWeb(
            projection.questions ?? [],
          ) as ProjectedOperatorQuestion[],
        }
      : {}),
    ...(projection.pendingQuestion
      ? {
          pendingQuestion: redactUnknownForWeb(
            projection.pendingQuestion,
          ) as ProjectedOperatorQuestion,
        }
      : {}),
    ...(projection.activeQuestion
      ? {
          activeQuestion: redactUnknownForWeb(
            projection.activeQuestion,
          ) as ProjectedOperatorQuestion,
        }
      : {}),
    inputs,
    ...(projection.configuration ? { configuration: projection.configuration } : {}),
    changeRequestUrl: projection.changeRequestUrl,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    taskId: projection.workItemId ?? taskIdFromInputs(inputs),
    workItemId: projection.workItemId,
    workItemType: projection.workItemType,
    planningApproval: projection.planningApproval,
    runEligibilityOverride: projection.runEligibilityOverride,
    startedAt,
    completedAt,
    trigger,
    ...(reviewFeedback ? { reviewFeedback } : {}),
    priorRunId: projection.priorRunId ?? triggerPriorRunId(trigger),
    ...(projection.contextKnowledge
      ? { contextKnowledge: projection.contextKnowledge }
      : {}),
    ...(projection.knowledgeRetrievals
      ? { knowledgeRetrievals: projection.knowledgeRetrievals }
      : {}),
    ...(projection.contextUsage ? { contextUsage: projection.contextUsage } : {}),
    ...(projection.runtimeUsage ? { runtimeUsage: projection.runtimeUsage } : {}),
    ...(runtimeSlicesFromProjection(projection).length > 0
      ? { runtimeSlices: runtimeSlicesFromProjection(projection) }
      : {}),
    factorySignals,
    ...(projection.budgetSummary
      ? { budgetSummary: projection.budgetSummary }
      : {}),
    ...(projection.verificationBudget
      ? { verificationBudget: projection.verificationBudget }
      : {}),
    ...(projection.taskPlan ? { taskPlan: projection.taskPlan } : {}),
    ...(recovery ? { recovery } : {}),
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

async function tryWebRecoveryArtifact(
  runDirectory: string,
): Promise<WebRecoveryArtifact | undefined> {
  try {
    const artifact = webRecoveryArtifact(
      await readRecoverySnapshot({ runDirectory }),
    );
    if (!artifact?.path) return artifact;
    try {
      const metadata = await lstat(join(runDirectory, artifact.path));
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (artifact.patchBytes !== undefined && metadata.size !== artifact.patchBytes)
      ) {
        return {
          ...artifact,
          status: "unavailable",
          path: undefined,
          message: "recovery patch is missing, unsafe, or does not match metadata",
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        ...artifact,
        status: "unavailable",
        path: undefined,
        message: "recovery patch is missing",
      };
    }
    return artifact;
  } catch {
    return undefined;
  }
}

async function readRunSummary(
  repoPath: string,
  runId: string,
): Promise<WebRunSummary> {
  validateRunId(runId);
  const runDirectory = join(runsRoot(repoPath), runId);
  try {
    const summary = asRunSummary(
      JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")),
      runId,
    );
    return {
      ...summary,
      ...webStateFieldsFromDigest(
        summary,
        await readRunDirectoryDigest(runDirectory),
      ),
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

/**
 * The one summary path that still reads a Run's logs in full (#518).
 *
 * It is reached only by a Run directory with neither `run.json` nor events,
 * so a listing of a real instance does not pay for it, and `inferFallbackStatus`
 * asks a question about the whole history — whether any attempt wrote to
 * stderr and nothing to stdout — that a bounded tail cannot answer exactly.
 */
async function readFallbackRunSummary(
  repoPath: string,
  runId: string,
): Promise<WebRunSummary> {
  const runDirectory = join(runsRoot(repoPath), runId);
  const recoveryArtifact = await tryWebRecoveryArtifact(runDirectory);
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
    ...(recoveryArtifact ? { recoveryArtifact } : {}),
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

async function tryProjectedRunWithRecovery(
  repoPath: string,
  runId: string,
): Promise<
  { projection: ProjectedRun; recovery?: WebRunRecovery; events: StoredRunEvent[] } | undefined
> {
  try {
    const projection = await getProjectedRun(repoPath, runId);
    const events = tryRunEvents(repoPath, runId);
    return {
      ...staleAwareProjectionWithRecovery(projection, events),
      events,
    };
  } catch {
    return undefined;
  }
}

function tryRunEventsForRuns(
  repoPath: string,
  runIds: string[],
): Map<string, StoredRunEvent[]> {
  try {
    return listRunEvents(repoPath, runIds);
  } catch {
    return new Map();
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

/**
 * Collapses concurrent scans of one repository's runs into a single scan.
 *
 * A console load asks four endpoints (`/api/runs`, `/api/dashboard`,
 * `/api/agent-stability`, `/api/tasks`) for the same listing at the same
 * moment, and each scan walks run directories. Sharing the in-flight scan
 * turns that burst into one walk. Default listings hydrate only the newest
 * page; callers that truly need the full history pass `{ limit: Infinity }`.
 *
 * Deliberately not a time-based cache. Run state is written outside this
 * process — by the run engine as a Run progresses, and by anything else that
 * touches `.nitely/runs` — so reusing a settled result for any window would
 * hide writes this layer never sees. An entry lives only while its scan is in
 * flight, which keeps every caller as fresh as scanning itself.
 */
const runScansInFlight = new Map<string, Promise<WebRunSummary[]>>();

/**
 * Newest-first page size for `/api/runs`, the one endpoint whose list view is
 * genuinely paged.
 *
 * It is not a default on `listRuns`. Most callers filter the global listing
 * down to one entity — a work item's runs, a flow's runs, a run's parent and
 * children — so a default page silently drops every entity whose runs are not
 * among the newest in the repository. Bounding what each run costs to hydrate
 * is the part that makes those callers cheap, and that is tracked separately
 * on #518; capping how many they see is not a substitute for it.
 */
export const DEFAULT_RUN_LIST_LIMIT = 50;

export interface ListRunsOptions {
  /**
   * Maximum number of newest-first runs to hydrate. Omit for the full listing;
   * pass a limit only where the caller renders a page rather than deriving
   * something from the whole history.
   */
  limit?: number;
}

function resolvedRunListLimit(limit: number | undefined): number {
  return limit ?? Number.POSITIVE_INFINITY;
}

function runScanKey(repoPath: string, limit: number): string {
  return `${resolve(repoPath)}\0${Number.isFinite(limit) ? String(limit) : "all"}`;
}

export function listRuns(
  repoPath: string,
  options: ListRunsOptions = {},
): Promise<WebRunSummary[]> {
  const limit = resolvedRunListLimit(options.limit);
  const key = runScanKey(repoPath, limit);
  const inFlight = runScansInFlight.get(key);
  if (inFlight) return inFlight;
  const scan = scanRuns(repoPath, limit);
  runScansInFlight.set(key, scan);
  const clear = () => {
    if (runScansInFlight.get(key) === scan) runScansInFlight.delete(key);
  };
  scan.then(clear, clear);
  return scan;
}

async function scanRuns(
  repoPath: string,
  limit: number,
): Promise<WebRunSummary[]> {
  const projected = await tryListProjectedRuns(repoPath);
  let entries: string[] = [];
  try {
    entries = await readdir(runsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const ids = new Set<string>([
    ...projected.map((run) => run.runId),
    ...entries,
  ]);
  const sortedIds = [...ids].sort((left, right) => right.localeCompare(left));
  const selectedIds = Number.isFinite(limit)
    ? sortedIds.slice(0, Math.max(0, limit))
    : sortedIds;
  const projectedById = new Map(
    projected.map((run) => [run.runId, run] as const),
  );
  const eventsByRun = tryRunEventsForRuns(
    repoPath,
    selectedIds.filter((runId) => projectedById.has(runId)),
  );
  const summaries = await Promise.all(
    selectedIds.map(async (runId) => {
      const rawProjection = projectedById.get(runId);
      if (rawProjection) {
        return await summaryFromProjectedRun(
          repoPath,
          rawProjection,
          eventsByRun.get(runId) ?? [],
        );
      }
      try {
        return await readRunSummary(repoPath, runId);
      } catch {
        return undefined;
      }
    }),
  );
  return summaries
    .filter((run): run is WebRunSummary => run !== undefined)
    .sort((left, right) => right.runId.localeCompare(left.runId));
}

async function summaryFromProjectedRun(
  repoPath: string,
  rawProjection: ProjectedRun,
  events: StoredRunEvent[],
): Promise<WebRunSummary> {
  const { projection, recovery } = rawProjection.status === "running"
    ? staleAwareProjectionWithRecovery(rawProjection, events)
    : {
        projection: rawProjection,
        recovery: recoveryForProjection(rawProjection),
      };
  const digest = await projectedOutputDigest(
    repoPath,
    projection,
    currentWorkflowStage(projection)?.stageId,
  );
  const recoveryArtifact = await tryWebRecoveryArtifact(
    join(runsRoot(repoPath), projection.runId),
  );
  return projectedRunSummary(
    projection,
    digest,
    recovery,
    events,
    recoveryArtifact,
  );
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

function environmentRepairRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((entry) => asRecord(entry))
        .filter((entry) => asString(entry.description) !== undefined)
    : [];
}

function environmentRepairSummary(value: unknown): string | undefined {
  const repairs = environmentRepairRecords(value);
  if (repairs.length === 0) return undefined;
  return repairs
    .map((repair) =>
      [
        asString(repair.description),
        asString(repair.scope) ? `scope ${asString(repair.scope)}` : undefined,
        asString(repair.path) ? `path ${asString(repair.path)}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
    )
    .join("; ");
}

function environmentRepairsForStage(
  events: StoredRunEvent[],
  stageId: string,
): string | undefined {
  const summaries = events
    .filter((event) => event.stageId === stageId && event.type === "command.completed")
    .map((event) =>
      environmentRepairSummary(
        asRecord(redactUnknownForWeb(event.payload)).environmentRepairs,
      ),
    )
    .filter((summary): summary is string => summary !== undefined);
  return summaries.length > 0 ? summaries.join("; ") : undefined;
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
    addSummaryPart(
      parts,
      "repairs",
      environmentRepairRecords(payload.environmentRepairs).length || undefined,
    );
  } else if (event.type === "gate.completed") {
    const gate = asRecord(payload.gate ?? payload);
    const reviewOutput = asRecord(gate.reviewOutput);
    const verdict = asRecord(reviewOutput.verdict);
    addSummaryPart(parts, "gate", asString(gate.id));
    addSummaryPart(parts, "status", asString(gate.status));
    addSummaryPart(parts, "mode", asString(gate.mode));
    addSummaryPart(parts, "verdict", asString(verdict.verdict));
    addSummaryPart(parts, "target stage", asString(verdict.targetStage));
    addSummaryPart(parts, "target artifact", asString(verdict.targetArtifact));
    addSummaryPart(parts, "reason", asString(gate.reason));
  } else if (event.type === "judge.completed") {
    addSummaryPart(parts, "verdict", asString(payload.verdict));
    addSummaryPart(parts, "target", asString(payload.reworkTarget));
    addSummaryPart(parts, "instructions", asString(payload.reworkInstructions));
    addSummaryPart(parts, "reason", asString(payload.humanReviewReason));
    addSummaryPart(parts, "findings", asStringArray(payload.findings)?.join("; "));
  } else if (event.type === "orchestrator.decision") {
    const request = asRecord(payload.reworkRequest);
    const oscillation = asRecord(payload.oscillation);
    addSummaryPart(parts, "decision", asString(payload.decision));
    addSummaryPart(parts, "action", asString(payload.action));
    addSummaryPart(parts, "reason", asString(payload.reason));
    addSummaryPart(
      parts,
      "target stage",
      asString(payload.targetStage) ?? asString(request.targetStage),
    );
    addSummaryPart(
      parts,
      "target artifact",
      asString(payload.targetArtifact) ?? asString(request.targetArtifact),
    );
    addSummaryPart(parts, "from", asString(oscillation.from));
    addSummaryPart(parts, "to", asString(oscillation.to));
    addSummaryPart(parts, "count", oscillation.count);
    addSummaryPart(parts, "window", oscillation.window);
  } else if (event.type === "verification.failure.diagnosed") {
    addSummaryPart(parts, "classification", asString(payload.classification));
    addSummaryPart(parts, "confidence", asString(payload.confidence));
    addSummaryPart(parts, "action", asString(payload.recommendedAction));
    addSummaryPart(parts, "reason", asString(payload.reason));
    addSummaryPart(parts, "target stage", asString(payload.targetStage));
    addSummaryPart(parts, "target artifact", asString(payload.targetArtifact));
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
    const request = asRecord(payload.reworkRequest);
    addSummaryPart(
      parts,
      "target stage",
      asString(payload.targetStage) ??
        asString(payload.targetStageId) ??
        asString(request.targetStage),
    );
    addSummaryPart(
      parts,
      "target artifact",
      asString(payload.targetArtifact) ?? asString(request.targetArtifact),
    );
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
    "judge.completed",
    "verification.failure.diagnosed",
    "orchestrator.decision",
    "change.published",
    "change.updated",
    "stage.failed",
    "stage.blocked",
    "stage.runtime.unavailable",
    "stage.rework.requested",
    "stage.retrying",
    "task.plan.iteration.started",
    "task.plan.task.completed",
    "task.plan.loop.continues",
    "task.plan.completed",
    "task.plan.final.deferred",
    "task.plan.final.ready",
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
  taskPlan: ProjectedTaskPlanLoop | undefined;
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
  addDetailField(
    fields,
    "Environment repairs",
    environmentRepairsForStage(input.events, stage.stageId),
  );
  addDetailField(fields, "Attempt directory", redactForWeb(attempt?.attemptDirectory), { mono: true });
  addDetailField(fields, "Output path", redactForWeb(attempt?.outputPath), { mono: true });
  addDetailField(fields, "Artifact manifest", redactForWeb(attempt?.artifactManifestPath), { mono: true });
  addDetailField(fields, "Stdout path", redactForWeb(attempt?.stdoutPath), { mono: true });
  addDetailField(fields, "Stderr path", redactForWeb(attempt?.stderrPath), { mono: true });
  addDetailField(fields, "Context usage", contextUsageDetail(input.stageUsage));
  addDetailField(fields, "Runtime usage", runtimeUsageDetail(input.stageRuntimeUsage));
  addDetailField(fields, "Budget", budgetDetail(attempt?.budget));
  addDetailField(fields, "Task plan input", input.taskPlan?.inputId, { mono: true });
  addDetailField(fields, "Current task", input.taskPlan?.currentTaskId, { mono: true });
  addDetailField(
    fields,
    "Task plan progress",
    input.taskPlan
      ? `${input.taskPlan.completedCount}/${input.taskPlan.totalTaskCount} completed, ${input.taskPlan.remainingCount} remaining`
      : undefined,
  );
  addDetailField(
    fields,
    "Task plan iteration",
    input.taskPlan?.iteration && input.taskPlan.maxIterations
      ? `${input.taskPlan.iteration}/${input.taskPlan.maxIterations}`
      : undefined,
  );
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
    const declaration = declarations.get(stage.stageId) ?? stageDeclaration(projection, stage.stageId);
    const process = processForStage({ stage, declaration, state, events });
    const artifactReadiness = artifactReadinessForStage({
      stageId: stage.stageId,
      declaration,
      artifacts,
      state,
    });
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
      taskPlan: projection.taskPlan,
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
      ...(process ? { process } : {}),
      artifactReadiness,
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
      ...(projection.taskPlan ? { taskPlan: projection.taskPlan } : {}),
      hasLogs: logs.some((log) => log.stageId === stage.stageId),
      hasEvidence,
      hasDetails: true,
      details,
    };
  }));
}

function workflowStageFromDeclaration(stage: Stage): ProjectedWorkflowStage {
  return {
    id: stage.id,
    type: stage.type,
    ...(declarationCommand(stage) ? { command: declarationCommand(stage) } : {}),
    inputs: stage.inputs,
    outputs: stage.outputs.map(stageOutputId),
    maxAttempts: stage.maxAttempts,
    ...(stage.costClass ? { costClass: stage.costClass } : {}),
  };
}

function workflowStagesForProgress(
  projection: ProjectedRun,
  declarations: Map<string, Stage>,
  timeline: WebSessionTimelineItem[],
): ProjectedWorkflowStage[] {
  const stages = new Map<string, ProjectedWorkflowStage>();
  const declared = projection.workflowStages ?? [...declarations.values()].map(workflowStageFromDeclaration);
  for (const stage of declared) {
    stages.set(stage.id, stage);
  }
  for (const item of timeline) {
    if (stages.has(item.stageId)) continue;
    const declaration = declarations.get(item.stageId);
    stages.set(
      item.stageId,
      declaration
        ? workflowStageFromDeclaration(declaration)
        : {
            id: item.stageId,
            type: item.stageType,
            inputs: [],
            outputs: [],
          },
    );
  }
  return [...stages.values()];
}

function workflowNextAction(input: {
  item: WebSessionTimelineItem | undefined;
  state: WebStageState;
  blocker: ProjectedRunBlocker | undefined;
  approval: WebWorkflowProgressItem["approval"];
}): string | undefined {
  if (input.approval?.status === "pending") {
    return "Approve or reject the pending gate.";
  }
  if (input.state === "pending") {
    return "Waiting for upstream stages.";
  }
  if (input.state === "blocked") {
    return input.blocker?.message ?? input.blocker?.reason ?? "Resolve the blocker.";
  }
  if (input.state === "awaiting-orchestrator") {
    return "Waiting for retry, rework, or escalation decision.";
  }
  if (input.state === "retrying") return "Retry is queued.";
  if (input.state === "reworking") return "Rework is queued.";
  if (input.state === "escalated") return "Human intervention required.";
  if (input.state === "failed") return "Inspect failure evidence.";
  if (input.state === "running" || input.state === "gate-checking") {
    return "Stage is currently executing.";
  }
  return undefined;
}

function buildWorkflowProgress(input: {
  projection: ProjectedRun | undefined;
  declarations: Map<string, Stage>;
  timeline: WebSessionTimelineItem[];
  artifacts: RunArtifact[];
}): WebWorkflowProgressItem[] {
  if (!input.projection) {
    return input.timeline.map((item) => ({
      stageId: item.stageId,
      label: item.stageId,
      stageType: item.stageType,
      status: item.status,
      state: item.state,
      current: false,
      attempts: item.attempts,
      currentAttempt: item.currentAttempt,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      failedAt: item.failedAt,
      durationMs: item.durationMs,
      inputs: [],
      outputs: [],
      latestOutput: item.latestOutput,
      process: item.process,
      artifactReadiness: item.artifactReadiness,
      latestDecision: item.latestDecision,
      blocker: item.blocker,
      artifacts: artifactsForStage(input.artifacts, item.stageId),
      nextAction: workflowNextAction({
        item,
        state: item.state,
        blocker: item.blocker,
        approval: undefined,
      }),
    }));
  }

  const timelineByStage = new Map(input.timeline.map((item) => [item.stageId, item]));
  const currentStageId = currentWorkflowStage(input.projection)?.stageId;
  return workflowStagesForProgress(input.projection, input.declarations, input.timeline)
    .map((stage) => {
      const item = timelineByStage.get(stage.id);
      const projectedStage = input.projection?.stages.find(
        (candidate) => candidate.stageId === stage.id,
      );
      const approval = input.projection?.approvals
        .filter((candidate) => candidate.stageId === stage.id)
        .at(-1);
      const state = item?.state ?? "pending";
      const blocker = item?.blocker ?? projectedStage?.blocker;
      const workflowApproval = approval
        ? {
            id: approval.id,
            status: approval.status,
            prompt: approval.prompt,
            requestedAt: approval.requestedAt,
            resolvedAt: approval.resolvedAt,
            actor: approval.actor,
            decision: approval.decision,
          }
        : undefined;
      return {
        stageId: stage.id,
        label: stage.id,
        stageType: item?.stageType ?? stage.type,
        status: item?.status ?? "pending",
        state,
        current: currentStageId === stage.id,
        attempts: item?.attempts ?? 0,
        currentAttempt: item?.currentAttempt,
        maxAttempts: stage.maxAttempts,
        startedAt: item?.startedAt,
        completedAt: item?.completedAt,
        failedAt: item?.failedAt,
        durationMs: item?.durationMs,
        inputs: stage.inputs,
        outputs: stage.outputs,
        latestOutput: item?.latestOutput,
        process: item?.process,
        artifactReadiness: item?.artifactReadiness,
        latestDecision: item?.latestDecision,
        blocker,
        approval: workflowApproval,
        artifacts: artifactsForStage(input.artifacts, stage.id),
        nextAction: workflowNextAction({
          item,
          state,
          blocker,
          approval: workflowApproval,
        }),
      };
    });
}

function buildEvidenceTimeline(input: {
  summary: WebRunSummary;
  artifacts: RunArtifact[];
  timeline: WebSessionTimelineItem[];
  logs: WebRedactedLog[];
  questions?: ProjectedOperatorQuestion[];
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
    const gate = artifact.gateResult;
    const operatorReview = gate?.operatorReview;
    if (gate && operatorReview) {
      items.push({
        kind: "gate",
        label: `Operator review: ${gate.stageId}`,
        at: operatorReview.submittedAt,
        detail: {
          source: "operator",
          actor: operatorReview.actor,
          stageId: gate.stageId,
          attempt: gate.attempt,
          status: gate.status,
          reviewedArtifactIds: operatorReview.reviewedArtifactIds,
          blocker: operatorReview.blocker,
          reviewOutputPath: gate.reviewOutput?.path,
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

  for (const question of input.questions ?? []) {
    items.push({
      kind: "gate",
      label: `Question: ${question.id}`,
      at: question.askedAt,
      detail: {
        stageId: question.stageId,
        attempt: question.attempt,
        question: question.question,
        context: question.context,
        options: question.options,
        status: question.status,
      },
    });
    if (question.answer) {
      items.push({
        kind: "gate",
        label: `Answer: ${question.id}`,
        at: question.answer.answeredAt,
        detail: {
          actor: question.answer.actor,
          optionId: question.answer.optionId,
          text: question.answer.text,
        },
      });
    }
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

function normalizedArtifact(value: unknown): RunArtifact | undefined {
  const record = asRecord(value);
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

function webArtifact(
  value: unknown,
  redactionSecrets: Iterable<string> = [],
): RunArtifact | undefined {
  const raw = normalizedArtifact(value);
  const redacted = normalizedArtifact(
    redactUnknownForWeb(value, redactionSecrets),
  );
  if (!redacted) return undefined;
  return {
    ...redacted,
    // Integrity metadata is structural, not user-authored display content.
    // Redacting a digest can make an otherwise valid Artifact unreadable.
    ...(raw?.sha256 !== undefined ? { sha256: raw.sha256 } : {}),
    ...(raw?.size !== undefined ? { size: raw.size } : {}),
  };
}

async function artifactRegistryItems(input: {
  boundaryRoot: string;
  runDirectory: string;
  projection?: ProjectedRun;
  manifest: WebSessionContextItem[];
}): Promise<RunArtifact[]> {
  let registryArtifacts: RunArtifact[] | undefined;
  try {
    const registry = await readArtifactRegistry({
      runDirectory: input.runDirectory,
      boundaryRoot: input.boundaryRoot,
    });
    registryArtifacts = registry?.artifacts
      .map((artifact) => normalizedArtifact(artifact))
      .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  } catch {
    // Run detail is best-effort; unsafe or malformed registry data must not
    // prevent projection and manifest fallbacks from rendering.
    registryArtifacts = undefined;
  }
  const projectedArtifacts = input.projection?.artifacts
    .map((artifact) => normalizedArtifact(artifact))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  if (
    (registryArtifacts?.length ?? 0) > 0 ||
    (projectedArtifacts?.length ?? 0) > 0
  ) {
    return reconcileArtifactSources({
      registry: registryArtifacts ?? [],
      eventProjection: projectedArtifacts ?? [],
    });
  }

  return input.manifest
    .filter((item) => item.kind === "generated")
    .map((item) =>
      normalizedArtifact(
        {
          id: item.id,
          producer: "generated",
          mediaType: item.mediaType ?? "text/markdown",
          path: item.path,
          sourceUri: item.sourceUri,
          filename: item.filename,
        },
      ),
    )
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
}

function isConformanceArtifact(artifact: RunArtifact): boolean {
  return (
    artifact.id === DEFAULT_CONFORMANCE_REPORT_ID ||
    artifact.type === "conformance.report" ||
    artifact.mediaType === CONFORMANCE_REPORT_MEDIA_TYPE
  );
}

function conformancePolicyForStage(
  stage: Stage,
): { stageId: string; policy: ConformancePolicy } | undefined {
  if (stage.type !== "publish-change" && stage.type !== "update-change") {
    return undefined;
  }
  if (!stage.conformance) {
    return undefined;
  }
  return {
    stageId: stage.id,
    policy: {
      mode: stage.conformance.mode,
      reportId: stage.conformance.report ?? DEFAULT_CONFORMANCE_REPORT_ID,
      requiredIds: stage.conformance.required ?? [],
    },
  };
}

function conformancePolicies(
  declarations: Map<string, Stage>,
): Array<{ stageId: string; policy: ConformancePolicy }> {
  return [...declarations.values()]
    .map(conformancePolicyForStage)
    .filter(
      (entry): entry is { stageId: string; policy: ConformancePolicy } =>
        entry !== undefined,
    );
}

function conformanceArtifactSummary(
  artifact: RunArtifact | undefined,
  redactionSecrets: Iterable<string> = [],
): WebConformanceArtifact | undefined {
  const redacted = artifact
    ? webArtifact(artifact, redactionSecrets)
    : undefined;
  if (!redacted) return undefined;
  return {
    id: redacted.id,
    producer: redacted.producer,
    type: redacted.type,
    mediaType: redacted.mediaType,
    path: redacted.path,
  };
}

function redactedConformanceFindings(
  findings: ConformanceFinding[],
  redactionSecrets: Iterable<string>,
): ConformanceFinding[] {
  return findings.map((finding) => ({
    ...finding,
    message: String(
      redactUnknownForWeb(finding.message, redactionSecrets) ?? "",
    ),
    ...(finding.itemId
      ? {
          itemId: String(
            redactUnknownForWeb(finding.itemId, redactionSecrets) ?? "",
          ),
        }
      : {}),
  }));
}

async function readConformanceArtifact(input: {
  boundaryRoot: string;
  runDirectory: string;
  artifact: RunArtifact | undefined;
  reportId: string;
}): Promise<{ report?: ConformanceReport; errors: string[] }> {
  if (!input.artifact) {
    return { errors: [] };
  }
  if (!input.artifact.path) {
    return {
      errors: [`conformance report "${input.reportId}" has no artifact path`],
    };
  }
  try {
    const { content } = await readMaterializedArtifact({
      runDirectory: input.runDirectory,
      boundaryRoot: input.boundaryRoot,
      artifact: input.artifact,
    });
    return parseConformanceReportText(content.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        errors: [`conformance report "${input.reportId}" was not found`],
      };
    }
    return {
      errors: [
        `conformance report "${input.reportId}" is not a Run-owned regular file`,
      ],
    };
  }
}

async function conformanceReports(input: {
  boundaryRoot: string;
  runDirectory: string;
  artifacts: RunArtifact[];
  declarations: Map<string, Stage>;
  redactionSecrets?: Iterable<string>;
}): Promise<WebConformanceReport[]> {
  const redactionSecrets = [...(input.redactionSecrets ?? [])];
  const reports: WebConformanceReport[] = [];
  const processedReportIds = new Set<string>();

  for (const entry of conformancePolicies(input.declarations)) {
    processedReportIds.add(entry.policy.reportId);
    const artifact = input.artifacts.find(
      (candidate) => candidate.id === entry.policy.reportId,
    );
    const loaded = await readConformanceArtifact({
      boundaryRoot: input.boundaryRoot,
      runDirectory: input.runDirectory,
      artifact,
      reportId: entry.policy.reportId,
    });
    const findings = evaluateConformanceReport(
      loaded.report,
      entry.policy,
      loaded.errors,
    );
    reports.push({
      reportId: entry.policy.reportId,
      stageId: entry.stageId,
      policy: entry.policy,
      artifact: conformanceArtifactSummary(artifact, redactionSecrets),
      report: redactUnknownForWeb(
        loaded.report,
        redactionSecrets,
      ) as ConformanceReport | undefined,
      findings: redactedConformanceFindings(findings, redactionSecrets),
      errors: (redactUnknownForWeb(
        loaded.errors,
        redactionSecrets,
      ) ?? []) as string[],
    });
  }

  for (const artifact of input.artifacts.filter(
    (candidate) =>
      isConformanceArtifact(candidate) && !processedReportIds.has(candidate.id),
  )) {
    const loaded = await readConformanceArtifact({
      boundaryRoot: input.boundaryRoot,
      runDirectory: input.runDirectory,
      artifact,
      reportId: artifact.id,
    });
    const findings: ConformanceFinding[] =
      loaded.errors.length > 0
        ? [
            {
              severity: "warning",
              code: "invalid-report",
              message: loaded.errors.join("; "),
            },
          ]
        : [];
    reports.push({
      reportId: artifact.id,
      artifact: conformanceArtifactSummary(artifact, redactionSecrets),
      report: redactUnknownForWeb(
        loaded.report,
        redactionSecrets,
      ) as ConformanceReport | undefined,
      findings: redactedConformanceFindings(findings, redactionSecrets),
      errors: (redactUnknownForWeb(
        loaded.errors,
        redactionSecrets,
      ) ?? []) as string[],
    });
  }

  return reports;
}

function findingSeverity(line: string): string | undefined {
  let candidate = line.trim();
  candidate = candidate.replace(/^#{1,6}\s+/, "");
  candidate = candidate.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  candidate = candidate.replace(/^\[[ xX]\]\s+/, "");

  const bracketed = candidate.match(/^\[(P[0-3])\]\b/i);
  if (bracketed) return bracketed[1].toUpperCase();

  const prefixed = candidate.match(/^(P[0-3])\b(?:\s*[-:]|\s+|$)/i);
  return prefixed ? prefixed[1].toUpperCase() : undefined;
}

function isNoIssueReviewLine(line: string): boolean {
  return (
    /\bno\s+issues\b/i.test(line) ||
    /\bno\s+(?:P[0-3]|blocking)(?:\s*\/\s*(?:P[0-3]|blocking))*\s+findings\b/i.test(
      line,
    ) ||
    /^\s*(?:review\s+verdict|verdict)\s*:\s*pass(?:ed)?\b/i.test(line)
  );
}

function countSeverity(content: string): Record<string, number> {
  const severities: Record<string, number> = {};
  let hasNoIssueLine = false;
  for (const line of content.split(/\r?\n/)) {
    const severity = findingSeverity(line);
    if (severity) {
      severities[severity] = (severities[severity] ?? 0) + 1;
    } else if (isNoIssueReviewLine(line)) {
      hasNoIssueLine = true;
    }
  }
  if (Object.keys(severities).length === 0 && hasNoIssueLine) {
    severities.none = 1;
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

export function isTerminalWebRunStatus(status: WebRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "incomplete"
  );
}

export interface RunLogStreamSnapshot {
  runId: string;
  status: WebRunStatus;
  logs: WebRedactedLog[];
  terminal: boolean;
}

/**
 * Lightweight status + log snapshot for the live log SSE endpoint.
 * Avoids the full getRunDetail work (artifacts, chain runs, etc.).
 */
export async function getRunLogStreamSnapshot(
  repoPath: string,
  runId: string,
): Promise<RunLogStreamSnapshot> {
  validateRunId(runId);
  const projected = await tryProjectedRunWithRecovery(repoPath, runId);
  const runDirectory = join(runsRoot(repoPath), runId);
  if (projected?.projection) {
    const logs = await projectedLogs(repoPath, runId);
    const status = webStatusFromProjection(projected.projection.status);
    return {
      runId,
      status,
      logs,
      terminal: isTerminalWebRunStatus(status),
    };
  }
  try {
    const summary = await readRunSummary(repoPath, runId);
    const logs = await readStageLogs(runDirectory);
    return {
      runId,
      status: summary.status,
      logs,
      terminal: isTerminalWebRunStatus(summary.status),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("run not found");
    }
    throw error;
  }
}

export async function getRunDetail(
  repoPath: string,
  runId: string,
  options: { redactionSecrets?: Iterable<string> } = {},
): Promise<WebRunDetail> {
  validateRunId(runId);
  const projected = await tryProjectedRunWithRecovery(repoPath, runId);
  const projection = projected?.projection;
  const runDirectory = join(runsRoot(repoPath), runId);
  const recoveryArtifact = await tryWebRecoveryArtifact(runDirectory);
  const rawEvidence = await readOptionalFile(join(runDirectory, "evidence.md"));
  const evidence = redactForWeb(rawEvidence);
  const reproducibilityManifest = await readReproducibilityManifest({
    runDirectory,
  });
  const toolchainPreflight = await readToolchainPreflight({ runDirectory });
  const logs = projection ? await projectedLogs(repoPath, runId) : await readStageLogs(runDirectory);
  const runEvents = projected?.events ?? [];
  let summary: WebRunSummary;
  if (projection) {
    summary = projectedRunSummary(
      projection,
      await outputDigestFromLogs(
        logs,
        currentWorkflowStage(projection)?.stageId,
      ),
      projected.recovery,
      runEvents,
      recoveryArtifact,
    );
  } else {
    const fallbackSummary = await readRunSummary(repoPath, runId);
    summary = {
      ...fallbackSummary,
      ...webStateFieldsFromLogs(fallbackSummary, logs),
      ...(recoveryArtifact ? { recoveryArtifact } : {}),
    };
  }
  if (
    projection &&
    summary.publication &&
    !summary.publication.headCommit &&
    reproducibilityManifest?.repo.headCommit
  ) {
    const publication = {
      ...summary.publication,
      headCommit: reproducibilityManifest.repo.headCommit,
    };
    summary = {
      ...summary,
      publication,
      statusSummary: operatorStatusSummary({
        projection,
        process: summary.currentProcess,
        readiness: summary.currentArtifactReadiness,
        publication,
        recoveryArtifact,
        events: runEvents,
      }),
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
  const rawArtifacts = await artifactRegistryItems({
    boundaryRoot: repoPath,
    runDirectory,
    projection,
    manifest,
  });
  const artifacts = rawArtifacts
    .map((artifact) => webArtifact(artifact, options.redactionSecrets))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  const declarations = projection ? await tryFlowStages(repoPath, projection) : new Map<string, Stage>();
  const conformance = await conformanceReports({
    boundaryRoot: repoPath,
    runDirectory,
    artifacts: rawArtifacts,
    declarations,
    redactionSecrets: options.redactionSecrets,
  });
  const timeline = projection
    ? await projectedTimeline(
        projection,
        logs,
        artifacts,
        runEvents,
        declarations,
        evidence !== undefined,
      )
    : fallbackTimeline(summary, logs, evidence !== undefined);
  const workflowProgress = buildWorkflowProgress({
    projection,
    declarations,
    timeline,
    artifacts,
  });
  const reviewFeedback = await enrichReviewFeedbackMemoryProposals(
    repoPath,
    summary.reviewFeedback,
  );
  return {
    ...summary,
    ...(reviewFeedback ? { reviewFeedback } : {}),
    evidence,
    logs,
    artifacts,
    gates: projection?.gates ?? [],
    ...(runEvents.length > 0 ? { trace: buildRunTrace(runEvents) } : {}),
    contextManifest: manifest,
    timeline,
    workflowProgress,
    evidenceTimeline: buildEvidenceTimeline({
      summary,
      artifacts,
      timeline,
      logs,
      questions: projection?.questions,
    }),
    reviewFindings: await readReviewArtifacts(runDirectory),
    conformance,
    parentRun,
    childRuns,
    ...(reproducibilityManifest
      ? {
          reproducibility: diagnosticForManifest(
            reproducibilityManifest,
            reproducibilityManifestPath(runDirectory),
          ),
        }
      : {}),
    ...(toolchainPreflight ? { toolchainPreflight } : {}),
    ...(projection?.riskClassification
      ? { riskClassification: projection.riskClassification }
      : {}),
    ...(projection?.contextUsage ? { contextUsage: projection.contextUsage } : {}),
    ...(projection?.runtimeUsage ? { runtimeUsage: projection.runtimeUsage } : {}),
    ...(projection?.budgetSummary
      ? { budgetSummary: projection.budgetSummary }
      : {}),
    ...(projection?.verificationBudget
      ? { verificationBudget: projection.verificationBudget }
      : {}),
  };
}
