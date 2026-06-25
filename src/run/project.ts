import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import type {
  GateResult,
  GateReviewOutput,
  RunArtifact,
} from "../artifacts/types.js";
import type { OrchestratorDecisionEvent } from "../policy/decide.js";
import type { PlanningApprovalStatus } from "../work-items/planning.js";

export type ProjectedRunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type ProjectedStageStatus =
  | "pending"
  | "started"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted";

export type ProjectedAttemptStatus =
  | ProjectedStageStatus
  | "unavailable"
  | "skipped";

export interface ProjectedRunBlocker {
  reason: string;
  stageId?: string;
  runtime?: string;
  message?: string;
  retryAfter?: string;
}

export interface ProjectedContextUsage {
  promptBytes: number;
  approxTokens: number;
  inputBytesInlined: number;
  inputBytesSaved: number;
  inputCount: number;
}

export interface ProjectedRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  estimatedCostUsd?: number;
  raw?: unknown;
}

export interface ProjectedRuntimeUsageTotal {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  knownAttempts: number;
  unknownAttempts: number;
}

export interface ProjectedKnowledgeGeneration {
  runtime: string;
  model?: string;
  fingerprint: string;
  generatedAt: string;
  contentPath: string;
  generator?: string;
  eventCreatedAt: string;
}

export interface ProjectedTaskScope {
  inputId: string;
  expression: string;
  kind?: string;
  selectedTaskIds: string[];
  completedTaskIds?: string[];
  pendingTaskIds?: string[];
  sourceTaskCount?: number;
  selectedAt?: string;
  completedAt?: string;
}

export interface ProjectedRepoIndexQueryMatch {
  path: string;
  reasons: string[];
}

export interface ProjectedRepoIndexQuery {
  query: string;
  indexPath?: string;
  stageId?: string;
  attempt?: number;
  createdAt: string;
  stale?: boolean;
  staleReasons?: string[];
  matchCount?: number;
  matches: ProjectedRepoIndexQueryMatch[];
}

/**
 * Sum context-usage fields across the supplied entries, skipping undefined.
 * Returns undefined when no entry carries usage, so callers can omit the field
 * entirely for runs/stages that predate context-usage tracking.
 */
export function sumContextUsage(
  usages: Iterable<ProjectedContextUsage | undefined>,
): ProjectedContextUsage | undefined {
  let total: ProjectedContextUsage | undefined;
  for (const usage of usages) {
    if (!usage) continue;
    total ??= {
      promptBytes: 0,
      approxTokens: 0,
      inputBytesInlined: 0,
      inputBytesSaved: 0,
      inputCount: 0,
    };
    total.promptBytes += usage.promptBytes;
    total.approxTokens += usage.approxTokens;
    total.inputBytesInlined += usage.inputBytesInlined;
    total.inputBytesSaved += usage.inputBytesSaved;
    total.inputCount += usage.inputCount;
  }
  return total;
}

export function sumRuntimeUsage(
  usages: Iterable<ProjectedRuntimeUsage | undefined>,
  unknownAttempts = 0,
): ProjectedRuntimeUsageTotal | undefined {
  let total: ProjectedRuntimeUsageTotal | undefined;
  const add = (
    key: "inputTokens" | "outputTokens" | "totalTokens" | "estimatedCostUsd",
    value: number | undefined,
  ) => {
    if (value === undefined || !total) return;
    total[key] = (total[key] ?? 0) + value;
  };
  for (const usage of usages) {
    if (!usage) continue;
    total ??= { knownAttempts: 0, unknownAttempts: 0 };
    total.knownAttempts += 1;
    add("inputTokens", usage.inputTokens);
    add("outputTokens", usage.outputTokens);
    add("totalTokens", usage.totalTokens);
    add("estimatedCostUsd", usage.estimatedCostUsd);
  }
  if (unknownAttempts > 0) {
    total ??= { knownAttempts: 0, unknownAttempts: 0 };
    total.unknownAttempts += unknownAttempts;
  }
  return total;
}

export interface ProjectedAttemptBudget {
  status: "trimmed" | "exceeded";
  budget: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  trimmedInputIds?: string[];
}

export type ProjectedBudgetConsumerKind =
  | "context"
  | "runtime"
  | "tool-output"
  | "budget-exceeded";

export interface ProjectedBudgetConsumer {
  stageId: string;
  attempt: number;
  kind: ProjectedBudgetConsumerKind;
  approxTokens: number;
  budget?: number;
  approxTokensAfter?: number;
}

export interface ProjectedBudgetSummary {
  contextApproxTokens: number;
  runtimeTokens: number;
  trimmedEvents: number;
  exceededEvents: number;
  trimmedTokensBefore: number;
  trimmedTokensAfter: number;
  topConsumers: ProjectedBudgetConsumer[];
}

export interface ProjectedAttempt {
  attempt: number;
  status: ProjectedAttemptStatus;
  attemptDirectory?: string;
  outputPath?: string;
  artifactManifestPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  generatedArtifactPaths?: string[];
  runtime?: string;
  model?: string;
  runtimeCandidateIndex?: number;
  runtimeCandidateCount?: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  blockedAt?: string;
  error?: string;
  blocker?: ProjectedRunBlocker;
  reason?: string;
  missingConfig?: string[];
  contextUsage?: ProjectedContextUsage;
  runtimeUsage?: ProjectedRuntimeUsage;
  budget?: ProjectedAttemptBudget;
}

export interface ProjectedStage {
  stageId: string;
  status: ProjectedStageStatus;
  stageType?: string;
  gate?: GateResult;
  markers?: Record<string, string | boolean>;
  blocker?: ProjectedRunBlocker;
  attempts: ProjectedAttempt[];
}

export interface ProjectedLog {
  stageId: string;
  attempt: number;
  source: "command" | "attempt";
  command?: string;
  stdout?: string;
  stderr?: string;
}

export interface ProjectedRun {
  runId: string;
  status: ProjectedRunStatus;
  ownerId?: string;
  organizationId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  flowName?: string;
  flowPath?: string;
  flowDocument?: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  worktreePath?: string;
  inputs?: Record<string, unknown>;
  completedStages: string[];
  stages: ProjectedStage[];
  logs: ProjectedLog[];
  artifacts: RunArtifact[];
  gates: GateResult[];
  orchestratorDecisions: OrchestratorDecisionEvent[];
  changeRequestUrl?: string;
  changeRequest?: unknown;
  changeRequestTarget?: unknown;
  sync?: unknown;
  trigger?: unknown;
  priorRunId?: string;
  blocker?: ProjectedRunBlocker;
  contextUsage?: ProjectedContextUsage;
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  budgetSummary?: ProjectedBudgetSummary;
  knowledgeGenerations?: ProjectedKnowledgeGeneration[];
  taskScope?: ProjectedTaskScope;
  repoIndexQueries?: ProjectedRepoIndexQuery[];
}

interface ProjectedBudgetSignal {
  stageId: string;
  attempt: number;
  budget: ProjectedAttemptBudget;
}

function runtimeUsageTokenCount(
  usage: ProjectedRuntimeUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const ioTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return ioTokens > 0 ? ioTokens : undefined;
}

function buildBudgetSummary(
  stages: Iterable<ProjectedStage>,
  budgetSignals: Iterable<ProjectedBudgetSignal>,
): ProjectedBudgetSummary | undefined {
  const consumers: ProjectedBudgetConsumer[] = [];
  const summary: ProjectedBudgetSummary = {
    contextApproxTokens: 0,
    runtimeTokens: 0,
    trimmedEvents: 0,
    exceededEvents: 0,
    trimmedTokensBefore: 0,
    trimmedTokensAfter: 0,
    topConsumers: [],
  };

  for (const stage of stages) {
    for (const attempt of stage.attempts) {
      const consumerBase = { stageId: stage.stageId, attempt: attempt.attempt };
      const contextTokens = attempt.contextUsage?.approxTokens;
      if (typeof contextTokens === "number" && contextTokens > 0) {
        summary.contextApproxTokens += contextTokens;
        consumers.push({
          ...consumerBase,
          kind: "context",
          approxTokens: contextTokens,
        });
      }

      const runtimeTokens = runtimeUsageTokenCount(attempt.runtimeUsage);
      if (typeof runtimeTokens === "number" && runtimeTokens > 0) {
        summary.runtimeTokens += runtimeTokens;
        consumers.push({
          ...consumerBase,
          kind: "runtime",
          approxTokens: runtimeTokens,
        });
      }

    }
  }

  for (const signal of budgetSignals) {
    if (signal.budget.status === "trimmed") {
      summary.trimmedEvents += 1;
      const before = signal.budget.approxTokensBefore;
      const after = signal.budget.approxTokensAfter;
      if (typeof before === "number") {
        summary.trimmedTokensBefore += before;
        consumers.push({
          stageId: signal.stageId,
          attempt: signal.attempt,
          kind: "tool-output",
          approxTokens: before,
          budget: signal.budget.budget,
          ...(typeof after === "number" ? { approxTokensAfter: after } : {}),
        });
      }
      if (typeof after === "number") {
        summary.trimmedTokensAfter += after;
      }
    }

    if (signal.budget.status === "exceeded") {
      summary.exceededEvents += 1;
      const approxTokens = signal.budget.approxTokens;
      if (typeof approxTokens === "number") {
        consumers.push({
          stageId: signal.stageId,
          attempt: signal.attempt,
          kind: "budget-exceeded",
          approxTokens,
          budget: signal.budget.budget,
        });
      }
    }
  }

  const hasSummary =
    summary.contextApproxTokens > 0 ||
    summary.runtimeTokens > 0 ||
    summary.trimmedEvents > 0 ||
    summary.exceededEvents > 0;
  if (!hasSummary) return undefined;

  summary.topConsumers = consumers
    .sort(
      (left, right) =>
        right.approxTokens - left.approxTokens ||
        left.stageId.localeCompare(right.stageId) ||
        left.attempt - right.attempt ||
        left.kind.localeCompare(right.kind),
    )
    .slice(0, 5);
  return summary;
}

export function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRunBlocker(value: unknown): ProjectedRunBlocker | undefined {
  const record = asRecord(value);
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function asRuntimeUsage(value: unknown): ProjectedRuntimeUsage | undefined {
  const payload = asRecord(value);
  const usage: ProjectedRuntimeUsage = {
    inputTokens: asNonNegativeNumber(payload.inputTokens),
    outputTokens: asNonNegativeNumber(payload.outputTokens),
    totalTokens: asNonNegativeNumber(payload.totalTokens),
    contextWindow: asNonNegativeNumber(payload.contextWindow),
    estimatedCostUsd: asNonNegativeNumber(payload.estimatedCostUsd),
    raw: payload.raw,
  };
  return usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.contextWindow !== undefined ||
    usage.estimatedCostUsd !== undefined ||
    usage.raw !== undefined
    ? usage
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function asRepoIndexQueryMatch(value: unknown): ProjectedRepoIndexQueryMatch | undefined {
  const match = asRecord(value);
  const path = asString(match.path);
  if (!path) return undefined;
  return {
    path,
    reasons: asStringArray(match.reasons) ?? [],
  };
}

function asRunArtifact(value: unknown, createdAt: string): RunArtifact | undefined {
  const artifact = asRecord(value);
  const id = asString(artifact.id);
  const producer = asString(artifact.producer);
  const mediaType = asString(artifact.mediaType);
  if (!id || !producer || !mediaType) return undefined;
  return {
    id,
    name: asString(artifact.name),
    type: asString(artifact.type),
    description: asString(artifact.description),
    producer,
    mediaType,
    schema: artifact.schema,
    version: asString(artifact.version),
    path: asString(artifact.path),
    sourceUri: asString(artifact.sourceUri),
    filename: asString(artifact.filename),
    manifestSource:
      artifact.manifestSource === "declared-manifest" ||
      artifact.manifestSource === "discovered"
        ? artifact.manifestSource
        : undefined,
    createdAt: asString(artifact.createdAt) ?? createdAt,
    gateResult: asGateResult(artifact.gateResult, createdAt),
  };
}

function asGateResult(value: unknown, createdAt: string): GateResult | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  const stageId = asString(record.stageId);
  const mode = asString(record.mode);
  const status = asString(record.status);
  if (
    !id ||
    !stageId ||
    (mode !== "deterministic" && mode !== "review" && mode !== "analysis") ||
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
    createdAt: asString(record.createdAt) ?? createdAt,
  };
}

function asOrchestratorDecisionEvent(
  value: unknown,
): OrchestratorDecisionEvent | undefined {
  const record = asRecord(value);
  const stageId = asString(record.stageId);
  const stageType = asString(record.stageType);
  const action = asString(record.action);
  const reason = asString(record.reason);
  if (
    !stageId ||
    !stageType ||
    typeof record.attempt !== "number" ||
    typeof record.maxAttempts !== "number" ||
    !reason ||
    (action !== "complete" &&
      action !== "retry" &&
      action !== "rework" &&
      action !== "escalate" &&
      action !== "fail")
  ) {
    return undefined;
  }
  return {
    stageId,
    stageType: stageType as OrchestratorDecisionEvent["stageType"],
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    action,
    reason,
    error: asString(record.error),
    targetArtifact: asString(record.targetArtifact),
  };
}

function stageMarkers(payload: Record<string, unknown>): Record<string, string | boolean> | undefined {
  const markers: Record<string, string | boolean> = {};
  const resumedFrom = asString(payload.resumedFrom);
  if (resumedFrom) {
    markers.resumedFrom = resumedFrom;
  }
  return Object.keys(markers).length > 0 ? markers : undefined;
}

function ensureStage(
  stages: Map<string, ProjectedStage>,
  stageId: string,
): ProjectedStage {
  const existing = stages.get(stageId);
  if (existing) return existing;
  const stage: ProjectedStage = {
    stageId,
    status: "pending",
    attempts: [],
  };
  stages.set(stageId, stage);
  return stage;
}

function ensureAttempt(
  stage: ProjectedStage,
  attemptNumber: number,
): ProjectedAttempt {
  let attempt = stage.attempts.find(
    (candidate) => candidate.attempt === attemptNumber,
  );
  if (!attempt) {
    attempt = { attempt: attemptNumber, status: "started" };
    stage.attempts.push(attempt);
    stage.attempts.sort((left, right) => left.attempt - right.attempt);
  }
  return attempt;
}

function latestAttempt(stage: ProjectedStage): ProjectedAttempt | undefined {
  return stage.attempts.at(-1);
}

function projectAttemptStatus(stage: ProjectedStage): void {
  const attempt = latestAttempt(stage);
  if (!attempt) return;
  if (attempt.status === "unavailable" || attempt.status === "skipped") {
    stage.status = "failed";
    return;
  }
  stage.status = attempt.status;
}

export function projectRun(events: StoredRunEvent[]): ProjectedRun {
  if (events.length === 0) {
    throw new Error("cannot project a run without events");
  }

  const runId = events[0]?.runId ?? "";
  const stages = new Map<string, ProjectedStage>();
  const completedStages = new Set<string>();
  const logs: ProjectedLog[] = [];
  const artifacts: RunArtifact[] = [];
  const gates: GateResult[] = [];
  const orchestratorDecisions: OrchestratorDecisionEvent[] = [];
  const knowledgeGenerations: ProjectedKnowledgeGeneration[] = [];
  const budgetSignals: ProjectedBudgetSignal[] = [];
  const repoIndexQueries: ProjectedRepoIndexQuery[] = [];
  const artifactIndexes = new Map<string, number>();
  const projection: ProjectedRun = {
    runId,
    status: "created",
    completedStages: [],
    stages: [],
    logs,
    artifacts,
    gates,
    orchestratorDecisions,
  };

  for (const event of events) {
    const payload = asRecord(event.payload);

    if (event.type === "run.created") {
      projection.flowName = asString(payload.flowName);
      projection.ownerId = asString(payload.ownerId);
      projection.organizationId = asString(payload.organizationId);
      projection.workItemId = asString(payload.workItemId);
      projection.workItemType = asString(payload.workItemType);
      if (
        typeof payload.planningApproval === "object" &&
        payload.planningApproval !== null
      ) {
        projection.planningApproval =
          payload.planningApproval as PlanningApprovalStatus;
      }
      projection.flowPath = asString(payload.flowPath);
      projection.flowDocument = asString(payload.flowDocument);
      projection.repoId = asString(payload.repoId);
      projection.repoName = asString(payload.repoName);
      projection.repoPath = asString(payload.repoPath);
      projection.branchName = asString(payload.branchName);
      projection.baseBranch = asString(payload.baseBranch);
      projection.changeRequestTarget = payload.changeRequestTarget;
      projection.trigger = payload.trigger;
      projection.priorRunId = asString(payload.priorRunId);
      if (typeof payload.inputs === "object" && payload.inputs !== null) {
        projection.inputs = payload.inputs as Record<string, unknown>;
      }
      projection.status = "running";
      continue;
    }

    if (event.type === "workspace.created") {
      projection.worktreePath = asString(payload.worktreePath);
      continue;
    }

    if (event.type === "knowledge.generated") {
      const runtime = asString(payload.runtime);
      const fingerprint = asString(payload.fingerprint);
      const generatedAt = asString(payload.generatedAt);
      const contentPath = asString(payload.contentPath);
      if (runtime && fingerprint && generatedAt && contentPath) {
        knowledgeGenerations.push({
          runtime,
          model: asString(payload.model),
          fingerprint,
          generatedAt,
          contentPath,
          generator: asString(payload.generator),
          eventCreatedAt: event.createdAt,
        });
      }
      continue;
    }

    if (event.type === "task.scope.selected") {
      const inputId = asString(payload.inputId);
      const expression = asString(payload.expression);
      const selectedTaskIds = asStringArray(payload.selectedTaskIds);
      if (inputId && expression && selectedTaskIds) {
        projection.taskScope = {
          inputId,
          expression,
          kind: asString(payload.kind),
          selectedTaskIds,
          completedTaskIds: asStringArray(payload.completedTaskIds),
          pendingTaskIds: asStringArray(payload.pendingTaskIds),
          sourceTaskCount: asNumber(payload.sourceTaskCount),
          selectedAt: event.createdAt,
        };
      }
      continue;
    }

    if (event.type === "task.scope.completed") {
      if (projection.taskScope) {
        projection.taskScope = {
          ...projection.taskScope,
          completedTaskIds:
            asStringArray(payload.completedTaskIds) ?? projection.taskScope.completedTaskIds,
          completedAt: event.createdAt,
        };
      }
      continue;
    }

    if (event.type === "repo.index.queried") {
      const stale = asRecord(payload.stale);
      const matches = Array.isArray(payload.matches)
        ? payload.matches
            .map(asRepoIndexQueryMatch)
            .filter((match): match is ProjectedRepoIndexQueryMatch => match !== undefined)
        : [];
      const query = asString(payload.query);
      if (query) {
        repoIndexQueries.push({
          query,
          indexPath: asString(payload.indexPath),
          stageId: event.stageId,
          attempt: event.attempt,
          createdAt: event.createdAt,
          stale: typeof stale.stale === "boolean" ? stale.stale : undefined,
          staleReasons: asStringArray(stale.reasons),
          matchCount: asNumber(payload.matchCount),
          matches,
        });
      }
      continue;
    }

    if (event.type === "stage.ready" && event.stageId) {
      const stage = ensureStage(stages, event.stageId);
      stage.status = "pending";
      stage.stageType = asString(payload.type) ?? stage.stageType;
      if (projection.status === "created") {
        projection.status = "running";
      }
      continue;
    }

    if (event.type === "stage.started" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      stage.stageType = asString(payload.type) ?? stage.stageType;
      stage.markers = stageMarkers(payload) ?? stage.markers;
      attempt.status = "started";
      attempt.startedAt = event.createdAt;
      attempt.attemptDirectory = asString(payload.attemptDirectory);
      attempt.runtime = asString(payload.runtime) ?? attempt.runtime;
      attempt.model = asString(payload.model) ?? attempt.model;
      attempt.runtimeCandidateIndex =
        asNumber(payload.runtimeCandidateIndex) ?? attempt.runtimeCandidateIndex;
      attempt.runtimeCandidateCount =
        asNumber(payload.runtimeCandidateCount) ?? attempt.runtimeCandidateCount;
      if (attempt.attemptDirectory) {
        attempt.outputPath = join(attempt.attemptDirectory, "output.md");
        attempt.artifactManifestPath = join(attempt.attemptDirectory, "artifact.json");
        attempt.stdoutPath = join(attempt.attemptDirectory, "stdout.log");
        attempt.stderrPath = join(attempt.attemptDirectory, "stderr.log");
      }
      projectAttemptStatus(stage);
      if (projection.status === "created") {
        projection.status = "running";
      }
      continue;
    }

    if (event.type === "stage.runtime.selected" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.runtime = asString(payload.runtime) ?? attempt.runtime;
      attempt.model = asString(payload.model) ?? attempt.model;
      attempt.runtimeCandidateIndex =
        asNumber(payload.runtimeCandidateIndex) ?? attempt.runtimeCandidateIndex;
      attempt.runtimeCandidateCount =
        asNumber(payload.runtimeCandidateCount) ?? attempt.runtimeCandidateCount;
      continue;
    }

    if (event.type === "stage.runtime.unavailable" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      const status = asString(payload.status);
      attempt.status = status === "skipped" ? "skipped" : "unavailable";
      attempt.runtime = asString(payload.runtime) ?? attempt.runtime;
      attempt.model = asString(payload.model) ?? attempt.model;
      attempt.runtimeCandidateIndex =
        asNumber(payload.runtimeCandidateIndex) ?? attempt.runtimeCandidateIndex;
      attempt.runtimeCandidateCount =
        asNumber(payload.runtimeCandidateCount) ?? attempt.runtimeCandidateCount;
      attempt.reason = asString(payload.reason);
      attempt.error = attempt.reason;
      attempt.missingConfig = asStringArray(payload.missingConfig);
      projectAttemptStatus(stage);
      continue;
    }

    if (event.type === "stage.context.usage" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.contextUsage = {
        promptBytes: asNumber(payload.promptBytes) ?? 0,
        approxTokens: asNumber(payload.approxTokens) ?? 0,
        inputBytesInlined: asNumber(payload.inputBytesInlined) ?? 0,
        inputBytesSaved: asNumber(payload.inputBytesSaved) ?? 0,
        inputCount: asNumber(payload.inputCount) ?? 0,
      };
      continue;
    }

    if (event.type === "stage.runtime.usage" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      const usage = asRuntimeUsage(payload);
      if (usage) {
        attempt.runtimeUsage = usage;
      }
      continue;
    }

    if (event.type === "budget.trimmed" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      const budget: ProjectedAttemptBudget = {
        status: "trimmed",
        budget: asNumber(payload.budget) ?? 0,
        approxTokensBefore: asNumber(payload.approxTokensBefore),
        approxTokensAfter: asNumber(payload.approxTokensAfter),
        trimmedInputIds: Array.isArray(payload.trimmedInputIds)
          ? payload.trimmedInputIds.filter((id): id is string => typeof id === "string")
          : undefined,
      };
      attempt.budget = budget;
      budgetSignals.push({
        stageId: event.stageId,
        attempt: event.attempt,
        budget,
      });
      continue;
    }

    if (event.type === "budget.exceeded" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      const budget: ProjectedAttemptBudget = {
        status: "exceeded",
        budget: asNumber(payload.budget) ?? 0,
        approxTokens: asNumber(payload.approxTokens),
      };
      attempt.budget = budget;
      budgetSignals.push({
        stageId: event.stageId,
        attempt: event.attempt,
        budget,
      });
      continue;
    }

    if (event.type === "command.completed" && event.stageId && event.attempt) {
      logs.push({
        stageId: event.stageId,
        attempt: event.attempt,
        source: "command",
        command: asString(payload.command),
        stdout: asString(payload.stdout),
        stderr: asString(payload.stderr),
      });
      continue;
    }

    if (event.type === "gate.completed") {
      const gate = asGateResult(payload.gate ?? payload, event.createdAt);
      if (!gate) continue;
      gates.push(gate);
      const stage = ensureStage(stages, gate.stageId);
      stage.gate = gate;
      stage.stageType = stage.stageType ?? "gate";
      continue;
    }

    if (event.type === "orchestrator.decision") {
      const decision = asOrchestratorDecisionEvent(payload);
      if (decision) {
        orchestratorDecisions.push(decision);
      }
      continue;
    }

    if (event.type === "artifact.published") {
      const artifact = asRunArtifact(payload.artifact, event.createdAt);
      if (!artifact) continue;
      if (event.stageId && artifact.path) {
        const stage = ensureStage(stages, event.stageId);
        const attempt = latestAttempt(stage);
        if (attempt) {
          attempt.generatedArtifactPaths = [
            ...(attempt.generatedArtifactPaths ?? []),
            artifact.path,
          ];
        }
      }
      const key = `${artifact.producer}\0${artifact.id}`;
      const existing = artifactIndexes.get(key);
      if (existing === undefined) {
        artifactIndexes.set(key, artifacts.length);
        artifacts.push(artifact);
      } else {
        artifacts[existing] = { ...artifacts[existing], ...artifact };
      }
      continue;
    }

    if (event.type === "stage.completed" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.status = "completed";
      attempt.completedAt = event.createdAt;
      stage.status = "completed";
      stage.blocker = undefined;
      completedStages.add(event.stageId);
      continue;
    }

    if (event.type === "stage.failed" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.status = "failed";
      attempt.failedAt = event.createdAt;
      attempt.error = asString(payload.error);
      stage.status = "failed";
      stage.blocker = undefined;
      completedStages.delete(event.stageId);
      continue;
    }

    if (event.type === "stage.blocked" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      const blocker = asRunBlocker(payload);
      attempt.status = "blocked";
      attempt.blockedAt = event.createdAt;
      attempt.blocker = blocker;
      attempt.error = blocker?.message;
      stage.status = "blocked";
      stage.blocker = blocker;
      completedStages.delete(event.stageId);
      continue;
    }

    if (event.type === "change.published") {
      projection.changeRequestUrl = asString(payload.url);
      projection.changeRequest = payload.changeRequest;
      continue;
    }

    if (event.type === "change.target.resolved") {
      projection.changeRequestTarget = payload;
      continue;
    }

    if (
      event.type === "change.sync.completed" ||
      event.type === "change.sync.conflicted"
    ) {
      projection.sync = payload;
      continue;
    }

    if (event.type === "change.updated") {
      projection.changeRequestUrl = asString(payload.url);
      projection.changeRequest = payload.changeRequest;
      projection.changeRequestTarget = payload;
      continue;
    }

    if (event.type === "run.completed") {
      projection.status = "completed";
      projection.blocker = undefined;
      projection.changeRequestUrl =
        asString(payload.changeRequestUrl) ?? asString(payload.url) ?? projection.changeRequestUrl;
      projection.changeRequest = payload.changeRequest ?? projection.changeRequest;
      projection.changeRequestTarget =
        payload.changeRequestTarget ?? projection.changeRequestTarget;
      projection.sync = payload.sync ?? projection.sync;
      projection.trigger = payload.trigger ?? projection.trigger;
      projection.priorRunId = asString(payload.priorRunId) ?? projection.priorRunId;
      continue;
    }

    if (event.type === "run.failed") {
      projection.status = "failed";
      projection.blocker = undefined;
      continue;
    }

    if (event.type === "run.blocked") {
      projection.status = "blocked";
      projection.blocker = asRunBlocker(payload);
      continue;
    }

    if (event.type === "run.cancelled") {
      projection.status = "cancelled";
      projection.blocker = undefined;
    }
  }

  for (const stage of stages.values()) {
    const attempt = latestAttempt(stage);
    if (attempt?.status === "started") {
      attempt.status = "interrupted";
      stage.status = "interrupted";
    }
  }

  if (
    [...stages.values()].some((stage) => stage.status === "interrupted") &&
    projection.status !== "completed" &&
    projection.status !== "blocked" &&
    projection.status !== "cancelled"
  ) {
    projection.status = "interrupted";
  }

  const usageTotal = sumContextUsage(
    [...stages.values()].flatMap((stage) =>
      stage.attempts.map((attempt) => attempt.contextUsage),
    ),
  );
  if (usageTotal) {
    projection.contextUsage = usageTotal;
  }
  const allAttempts = [...stages.values()].flatMap((stage) =>
    stage.attempts.map((attempt) => ({ stage, attempt })),
  );
  const unknownRuntimeAttempts = allAttempts.filter(({ stage, attempt }) => {
    const isRuntimeAttempt =
      attempt.runtime !== undefined || stage.stageType === "agent";
    return isRuntimeAttempt && !attempt.runtimeUsage;
  }).length;
  const runtimeUsageTotal = sumRuntimeUsage(
    allAttempts.map(({ attempt }) => attempt.runtimeUsage),
    unknownRuntimeAttempts,
  );
  if (runtimeUsageTotal) {
    projection.runtimeUsage = runtimeUsageTotal;
  }
  const budgetSummary = buildBudgetSummary(stages.values(), budgetSignals);
  if (budgetSummary) {
    projection.budgetSummary = budgetSummary;
  }
  if (knowledgeGenerations.length > 0) {
    projection.knowledgeGenerations = knowledgeGenerations;
  }
  if (repoIndexQueries.length > 0) {
    projection.repoIndexQueries = repoIndexQueries;
  }

  projection.completedStages = [...completedStages];
  projection.stages = [...stages.values()];
  return projection;
}

export function eventStorePath(repoPath: string): string {
  return join(repoPath, ".nitely", "events.db");
}

export function runDirectoryPath(repoPath: string, runId: string): string {
  validateRunId(runId);
  return join(repoPath, ".nitely", "runs", runId);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolveAttemptDirectory(
  repoPath: string,
  runId: string,
  attemptDirectory: string,
): string {
  const runDirectory = resolve(runDirectoryPath(repoPath, runId));
  const resolvedAttemptDirectory = resolve(repoPath, attemptDirectory);
  if (!isPathInside(runDirectory, resolvedAttemptDirectory)) {
    throw new Error(
      `attempt directory escapes run directory for run ${runId}: ${attemptDirectory}`,
    );
  }
  return resolvedAttemptDirectory;
}

function openStore(repoPath: string): EventStore {
  return new EventStore(eventStorePath(repoPath));
}

export async function listProjectedRuns(repoPath: string): Promise<ProjectedRun[]> {
  const store = openStore(repoPath);
  try {
    return store.listRunIds().map((runId) => projectRun(store.list(runId)));
  } finally {
    store.close();
  }
}

export async function getProjectedRun(
  repoPath: string,
  runId: string,
): Promise<ProjectedRun> {
  validateRunId(runId);
  const store = openStore(repoPath);
  try {
    const events = store.list(runId);
    if (events.length === 0) {
      throw new Error(`run not found: ${runId}`);
    }
    return projectRun(events);
  } finally {
    store.close();
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

export async function getProjectedRunLogs(
  repoPath: string,
  runId: string,
  options: { stageId?: string } = {},
): Promise<ProjectedLog[]> {
  validateRunId(runId);
  const projection = await getProjectedRun(repoPath, runId);
  const logs = [...projection.logs];
  const commandLogKeys = new Set(
    projection.logs.map((log) => `${log.stageId}:${log.attempt}`),
  );
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      if (!attempt.attemptDirectory) continue;
      if (commandLogKeys.has(`${stage.stageId}:${attempt.attempt}`)) continue;
      const attemptDirectory = resolveAttemptDirectory(
        repoPath,
        runId,
        attempt.attemptDirectory,
      );
      const [stdout, stderr] = await Promise.all([
        readOptionalFile(join(attemptDirectory, "stdout.log")),
        readOptionalFile(join(attemptDirectory, "stderr.log")),
      ]);
      if (stdout !== undefined || stderr !== undefined) {
        logs.push({
          stageId: stage.stageId,
          attempt: attempt.attempt,
          source: "attempt",
          stdout,
          stderr,
        });
      }
    }
  }
  return logs.filter(
    (log) => options.stageId === undefined || log.stageId === options.stageId,
  );
}
