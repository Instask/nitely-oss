import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import type { StageCostClass } from "../flow/schema.js";
import type {
  GateResult,
  GateReviewOutput,
  ReviewGateSpecificIssue,
  ReviewGateVerdict,
  ReviewGateVerdictRouting,
  RunArtifact,
} from "../artifacts/types.js";
import type {
  OrchestratorDecisionEvent,
  ReworkEdge,
  ReworkOscillationDiagnostics,
  ReworkRequest,
  ReworkSpecificIssue,
} from "../policy/decide.js";
import type { VerificationFailureDiagnosis } from "../verification/diagnosis.js";
import type { PlanningApprovalStatus } from "../work-items/planning.js";
import type { ResolvedTaskIssueScope } from "../task-issues/bridge.js";
import type { OperatorQuestion, OperatorQuestionOption } from "./questions.js";
import type { RunEligibilityOverrideEvidence } from "./eligibility.js";
import {
  RISK_CLASSES,
  type RiskClass,
  type RiskSignal,
} from "../policy/risk.js";
import type { ReviewRequirement } from "../policy/review-policy.js";
import {
  isCodexSandboxMode,
  type RunSandboxPolicy,
} from "./execution/sandbox.js";

export type ProjectedRunStatus =
  | "created"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type ProjectedStageStatus =
  | "pending"
  | "started"
  | "awaiting-approval"
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
  questionId?: string;
}

export interface ProjectedOperatorAnswer {
  optionId?: string;
  text?: string;
  actor: string;
  answeredAt: string;
}

export interface ProjectedOperatorQuestion extends OperatorQuestion {
  id: string;
  stageId: string;
  attempt: number;
  artifactPath?: string;
  askedAt: string;
  status: "pending" | "answered";
  answer?: ProjectedOperatorAnswer;
}

export interface ProjectRunOptions {
  openAttemptStatus?: "started" | "interrupted";
}

export interface ProjectedContextUsage {
  promptBytes: number;
  approxTokens: number;
  inputBytesInlined: number;
  inputBytesSaved: number;
  inputCount: number;
  knowledgeChunkCount?: number;
  knowledgeBytesInlined?: number;
  knowledgeApproxTokens?: number;
}

export interface ProjectedRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  contextWindow?: number;
  estimatedCostUsd?: number;
  cost?:
    | { classification: "actual"; usd: number }
    | { classification: "estimated"; usd: number; method: string }
    | { classification: "unknown" };
  provenance?: {
    provider: string;
    model?: string;
    observedAt: string;
    source: {
      kind: "provider-reported" | "calculated";
      reference: string;
    };
  };
  raw?: unknown;
}

export interface ProjectedRuntimeUsageTotal {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  actualCostUsd?: number;
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

export interface ProjectedContextKnowledgeEntry {
  id: string;
  category: string;
  title: string;
  version: number;
  tags: string[];
  keywords: string[];
  linkedTaskId?: string;
  injectedAt: string;
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

export interface ProjectedTaskPlanTask {
  id: string;
  title: string;
  status?: string;
  dependencies?: string[];
  paths?: string[];
  notes?: string;
}

export interface ProjectedTaskPlanHistoryEntry {
  taskId: string;
  status: string;
  stageId?: string;
  attempt?: number;
  message?: string;
  createdAt?: string;
}

export interface ProjectedTaskPlanLoop {
  inputId: string;
  version?: string;
  currentTask?: ProjectedTaskPlanTask;
  currentTaskId?: string;
  completedTaskIds: string[];
  remainingTaskIds: string[];
  completedCount: number;
  remainingCount: number;
  totalTaskCount: number;
  iteration?: number;
  maxIterations?: number;
  history: ProjectedTaskPlanHistoryEntry[];
  selectedAt?: string;
  completedAt?: string;
  targetStage?: string;
  deferredAt?: string;
}

export type ProjectedVerificationFailureDiagnosis =
  Omit<VerificationFailureDiagnosis, "recommendation">;

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

export interface ProjectedKnowledgeRetrievalMatch {
  attachmentId: string;
  snapshotId?: string;
  commitSha: string;
  indexDigest?: string;
  chunkId: string;
  citation: string;
  rank: number;
  lexicalScore?: number;
  semanticScore?: number;
  combinedScore?: number;
  providerId?: string;
  model?: string;
}

export interface ProjectedKnowledgeRetrieval {
  stageId?: string;
  attempt?: number;
  createdAt: string;
  queryFingerprint?: string;
  status: "ready" | "degraded";
  candidateCount?: number;
  selectedCount?: number;
  trimmedCount?: number;
  promptTokens?: number;
  degradedAttachmentIds: string[];
  reasonCodes: string[];
  matches: ProjectedKnowledgeRetrievalMatch[];
}

export type ProjectedApprovalStatus = "pending" | "approved" | "denied";

export interface ProjectedApproval {
  id: string;
  stageId: string;
  attempt: number;
  prompt: string;
  status: ProjectedApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  actor?: string;
  decision?: "approved" | "denied";
  reviewedArtifactIds?: string[];
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
    if (usage.knowledgeChunkCount !== undefined) {
      total.knowledgeChunkCount =
        (total.knowledgeChunkCount ?? 0) + usage.knowledgeChunkCount;
    }
    if (usage.knowledgeBytesInlined !== undefined) {
      total.knowledgeBytesInlined =
        (total.knowledgeBytesInlined ?? 0) + usage.knowledgeBytesInlined;
    }
    if (usage.knowledgeApproxTokens !== undefined) {
      total.knowledgeApproxTokens =
        (total.knowledgeApproxTokens ?? 0) + usage.knowledgeApproxTokens;
    }
  }
  return total;
}

export function sumRuntimeUsage(
  usages: Iterable<ProjectedRuntimeUsage | undefined>,
  unknownAttempts = 0,
): ProjectedRuntimeUsageTotal | undefined {
  let total: ProjectedRuntimeUsageTotal | undefined;
  let costClassification: "actual" | "estimated" | undefined;
  let classifiedCostAttempts = 0;
  let mixedCostClassifications = false;
  const add = (
    key:
      | "inputTokens"
      | "outputTokens"
      | "totalTokens"
      | "cachedInputTokens"
      | "actualCostUsd"
      | "estimatedCostUsd",
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
    add("cachedInputTokens", usage.cachedInputTokens);
    const provenance = usage.provenance;
    const hasProvenance = provenance !== undefined &&
      provenance.provider.trim().length > 0 &&
      Number.isFinite(Date.parse(provenance.observedAt)) &&
      provenance.source.reference.trim().length > 0;
    if (
      usage.cost?.classification === "actual" &&
      hasProvenance &&
      provenance.source.kind === "provider-reported"
    ) {
      classifiedCostAttempts += 1;
      mixedCostClassifications ||= costClassification === "estimated";
      costClassification ??= "actual";
      add("actualCostUsd", usage.cost.usd);
    } else if (
      usage.cost?.classification === "estimated" &&
      hasProvenance &&
      provenance.source.kind === "calculated"
    ) {
      classifiedCostAttempts += 1;
      mixedCostClassifications ||= costClassification === "actual";
      costClassification ??= "estimated";
      add("estimatedCostUsd", usage.cost.usd);
    }
  }
  if (unknownAttempts > 0) {
    total ??= { knownAttempts: 0, unknownAttempts: 0 };
    total.unknownAttempts += unknownAttempts;
  }
  const incompleteCostCoverage = total !== undefined &&
    classifiedCostAttempts !== total.knownAttempts;
  if (
    total &&
    (mixedCostClassifications || incompleteCostCoverage || unknownAttempts > 0)
  ) {
    delete total.actualCostUsd;
    delete total.estimatedCostUsd;
  }
  return total;
}

export interface ProjectedAttemptBudget {
  status: "trimmed" | "exceeded";
  budgetKind?: string;
  scope?: string;
  phase?: string;
  budget: number;
  consumed?: number;
  remaining?: number;
  minimum?: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  actualCostUsd?: number;
  estimatedCostUsd?: number;
  unknownRuntimeAttempts?: number;
  unknownCostAttempts?: number;
  message?: string;
  trimmedExternalKnowledgeCount?: number;
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
  /** Enforced against budgets; excludes cache reads. */
  runtimeTokens: number;
  /** The cache reads `runtimeTokens` left out. */
  cachedRuntimeTokens: number;
  trimmedEvents: number;
  exceededEvents: number;
  trimmedTokensBefore: number;
  trimmedTokensAfter: number;
  topConsumers: ProjectedBudgetConsumer[];
}

export interface ProjectedVerificationBudget {
  maxAgentAttempts?: number;
  maxJudgeAttempts?: number;
  maxCiRuns?: number;
  maxRuntimeCostUsd?: number;
  agentAttempts: number;
  judgeAttempts: number;
  ciRuns: number;
  runtimeCostUsd?: number;
  actualCostUsd?: number;
  estimatedCostUsd?: number;
  unknownCostAttempts: number;
  remainingAgentAttempts?: number;
  remainingJudgeAttempts?: number;
  remainingCiRuns?: number;
  remainingRuntimeCostUsd?: number;
  skippedExpensiveStageIds: string[];
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

export interface ProjectedWorkflowStage {
  id: string;
  type?: string;
  command?: string;
  inputs: string[];
  outputs: string[];
  maxAttempts?: number;
  costClass?: StageCostClass;
}

export interface ProjectedLog {
  stageId: string;
  attempt: number;
  source: "command" | "attempt";
  command?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * The effective risk of what a run actually changed, projected from the
 * `run.risk.classified` event so it survives resume and is recomputed, not
 * inherited, whenever rework changes the diff.
 */
export interface ProjectedRiskClassification {
  stageId: string;
  declared: RiskClass;
  effective: RiskClass;
  escalated: boolean;
  explanation: string;
  signals: RiskSignal[];
  requiredOwners: string[];
  requirement: ReviewRequirement;
  diffDigest: string;
  changedFileCount: number;
  changedLines?: number;
  policyConfigured: boolean;
  codeOwnersPath?: string;
  createdAt: string;
}

export interface ProjectedRun {
  runId: string;
  status: ProjectedRunStatus;
  terminalStatus?: Extract<
    ProjectedRunStatus,
    "completed" | "failed" | "blocked" | "cancelled"
  >;
  terminalStageId?: string;
  terminalEventAt?: string;
  finalizerStageIds?: string[];
  ownerId?: string;
  organizationId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  runEligibilityOverride?: RunEligibilityOverrideEvidence;
  flowName?: string;
  flowPath?: string;
  flowDocument?: string;
  flowDocumentSha256?: string;
  configurationSnapshotPath?: string;
  configurationSha256?: string;
  contextPolicySha256?: string;
  promptContext?: unknown;
  expectedSkillContentHashes?: unknown;
  knowledgeSnapshots?: unknown;
  executionBackend?: string;
  sandboxPolicy?: RunSandboxPolicy;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  worktreePath?: string;
  inputs?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  budgets?: unknown;
  verificationBudget?: ProjectedVerificationBudget;
  workflowStages?: ProjectedWorkflowStage[];
  completedStages: string[];
  stages: ProjectedStage[];
  approvals: ProjectedApproval[];
  logs: ProjectedLog[];
  artifacts: RunArtifact[];
  gates: GateResult[];
  orchestratorDecisions: OrchestratorDecisionEvent[];
  verificationDiagnoses: ProjectedVerificationFailureDiagnosis[];
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
  contextKnowledge?: ProjectedContextKnowledgeEntry[];
  taskScope?: ProjectedTaskScope;
  taskIssues?: ResolvedTaskIssueScope;
  taskPlan?: ProjectedTaskPlanLoop;
  repoIndexQueries?: ProjectedRepoIndexQuery[];
  knowledgeRetrievals?: ProjectedKnowledgeRetrieval[];
  questions?: ProjectedOperatorQuestion[];
  pendingQuestion?: ProjectedOperatorQuestion;
  activeQuestion?: ProjectedOperatorQuestion;
  riskClassification?: ProjectedRiskClassification;
}

interface ProjectedBudgetSignal {
  stageId: string;
  attempt: number;
  budget: ProjectedAttemptBudget;
}

/**
 * The token count budgets are enforced against.
 *
 * Cache reads are excluded. A provider serves them from its prompt cache at a
 * fraction of the price of fresh input, so counting them at parity measures
 * how much context a stage re-sent rather than how much work it bought. Run
 * 2026-08-30T142227983Z-022c3249 tripped a 2M cap on 2,239,828 tokens of which
 * 2,062,336 — 93% of its input — were cache reads; the work it actually bought
 * was 177,492 tokens. Usage that reports no cache split keeps its original
 * meaning, so events written before this distinction existed still read the
 * way they were written.
 */
export function billableRuntimeTokens(
  usage:
    | Pick<
        ProjectedRuntimeUsage,
        "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens"
      >
    | undefined,
): number | undefined {
  const total = runtimeUsageTokenCount(usage);
  if (total === undefined) return undefined;
  const cached = usage?.cachedInputTokens;
  if (typeof cached !== "number") return total;
  return Math.max(0, total - cached);
}

function runtimeUsageTokenCount(
  usage:
    | Pick<ProjectedRuntimeUsage, "inputTokens" | "outputTokens" | "totalTokens">
    | undefined,
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
    cachedRuntimeTokens: 0,
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

      const cachedTokens = attempt.runtimeUsage?.cachedInputTokens;
      if (typeof cachedTokens === "number" && cachedTokens > 0) {
        summary.cachedRuntimeTokens += cachedTokens;
      }
      const runtimeTokens = billableRuntimeTokens(attempt.runtimeUsage);
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
    questionId: asString(record.questionId),
  };
}

function asQuestionOptions(value: unknown): OperatorQuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const option = asRecord(entry);
      const id = asString(option.id);
      const label = asString(option.label);
      if (!id || !label) return undefined;
      return {
        id,
        label,
        ...(option.recommended === true ? { recommended: true } : {}),
      };
    })
    .filter((option): option is OperatorQuestionOption => option !== undefined);
}

function asProjectedQuestion(
  event: StoredRunEvent,
  payload: Record<string, unknown>,
): ProjectedOperatorQuestion | undefined {
  const value = asRecord(payload.question);
  const id = asString(payload.questionId);
  const question = asString(value.question);
  if (!id || !event.stageId || !event.attempt || !question || value.version !== 1) {
    return undefined;
  }
  return {
    id,
    stageId: event.stageId,
    attempt: event.attempt,
    version: 1,
    question,
    options: asQuestionOptions(value.options),
    ...(asString(value.context) ? { context: asString(value.context) } : {}),
    ...(asString(payload.artifactPath)
      ? { artifactPath: asString(payload.artifactPath) }
      : {}),
    askedAt: event.createdAt,
    status: "pending",
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
  const costRecord = asRecord(payload.cost);
  const parsedCost = costRecord.classification === "actual" &&
      asNonNegativeNumber(costRecord.usd) !== undefined
    ? {
        classification: "actual" as const,
        usd: asNonNegativeNumber(costRecord.usd) as number,
      }
    : costRecord.classification === "estimated" &&
        asNonNegativeNumber(costRecord.usd) !== undefined &&
        asString(costRecord.method)
      ? {
          classification: "estimated" as const,
          usd: asNonNegativeNumber(costRecord.usd) as number,
          method: asString(costRecord.method) as string,
        }
      : costRecord.classification === "unknown"
        ? { classification: "unknown" as const }
        : undefined;
  const provenanceRecord = asRecord(payload.provenance);
  const sourceRecord = asRecord(provenanceRecord.source);
  const provider = asString(provenanceRecord.provider);
  const observedAt = asString(provenanceRecord.observedAt);
  const sourceReference = asString(sourceRecord.reference);
  const sourceKind = sourceRecord.kind;
  const parsedSourceKind = sourceKind === "provider-reported" ||
      sourceKind === "calculated"
    ? sourceKind
    : undefined;
  const provenance: ProjectedRuntimeUsage["provenance"] = provider && observedAt &&
      Number.isFinite(Date.parse(observedAt)) && sourceReference &&
      parsedSourceKind
    ? {
        provider,
        ...(asString(provenanceRecord.model)
          ? { model: asString(provenanceRecord.model) }
          : {}),
        observedAt,
        source: { kind: parsedSourceKind, reference: sourceReference },
    }
    : undefined;
  const cost = parsedCost?.classification === "unknown" ||
      (parsedCost?.classification === "actual" &&
        provenance?.source.kind === "provider-reported") ||
      (parsedCost?.classification === "estimated" &&
        provenance?.source.kind === "calculated")
    ? parsedCost
    : undefined;
  const usage: ProjectedRuntimeUsage = {
    inputTokens: asNonNegativeNumber(payload.inputTokens),
    outputTokens: asNonNegativeNumber(payload.outputTokens),
    totalTokens: asNonNegativeNumber(payload.totalTokens),
    cachedInputTokens: asNonNegativeNumber(payload.cachedInputTokens),
    contextWindow: asNonNegativeNumber(payload.contextWindow),
    estimatedCostUsd: asNonNegativeNumber(payload.estimatedCostUsd),
    cost,
    provenance,
    raw: payload.raw,
  };
  return usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.contextWindow !== undefined ||
    usage.estimatedCostUsd !== undefined ||
    usage.cost !== undefined ||
    usage.provenance !== undefined ||
    usage.raw !== undefined
    ? usage
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function asResolvedTaskIssueScope(value: unknown): ResolvedTaskIssueScope | undefined {
  const payload = asRecord(value);
  if (payload.schemaVersion !== "nitely.task-issue-scope.v1") return undefined;

  let repository: ResolvedTaskIssueScope["repository"];
  if (payload.repository !== undefined) {
    const record = asRecord(payload.repository);
    const owner = asString(record.owner);
    const repositoryName = asString(record.repository);
    const url = asString(record.url);
    if (
      record.provider !== "github" ||
      !owner ||
      !repositoryName ||
      !url ||
      url.toLowerCase() !==
        `https://github.com/${owner}/${repositoryName}`.toLowerCase()
    ) {
      return undefined;
    }
    repository = {
      provider: "github",
      owner,
      repository: repositoryName,
      url,
    };
  }

  if (!Array.isArray(payload.issues) || !Array.isArray(payload.missingTaskIds)) {
    return undefined;
  }
  const seenIssueNumbers = new Set<number>();
  const seenTaskIds = new Set<string>();
  const issues: ResolvedTaskIssueScope["issues"] = [];
  for (const value of payload.issues) {
    const record = asRecord(value);
    const issueNumber = asNumber(record.issueNumber);
    const issueUrl = asString(record.issueUrl);
    const issueTitle = asString(record.issueTitle);
    const issueState = record.issueState;
    if (
      !repository ||
      !Number.isInteger(issueNumber) ||
      issueNumber === undefined ||
      issueNumber <= 0 ||
      !issueUrl ||
      !issueTitle ||
      (issueState !== "open" && issueState !== "closed") ||
      issueUrl.toLowerCase() !==
        `${repository.url}/issues/${issueNumber}`.toLowerCase() ||
      !Array.isArray(record.taskIds) ||
      record.taskIds.length === 0 ||
      seenIssueNumbers.has(issueNumber)
    ) {
      return undefined;
    }
    const taskIds: string[] = [];
    for (const taskId of record.taskIds) {
      if (
        typeof taskId !== "string" ||
        !/^T\d{3}$/.test(taskId) ||
        seenTaskIds.has(taskId)
      ) {
        return undefined;
      }
      seenTaskIds.add(taskId);
      taskIds.push(taskId);
    }
    seenIssueNumbers.add(issueNumber);
    issues.push({ issueNumber, issueUrl, issueTitle, issueState, taskIds });
  }

  const missingTaskIds: string[] = [];
  for (const taskId of payload.missingTaskIds) {
    if (
      typeof taskId !== "string" ||
      !/^T\d{3}$/.test(taskId) ||
      seenTaskIds.has(taskId)
    ) {
      return undefined;
    }
    seenTaskIds.add(taskId);
    missingTaskIds.push(taskId);
  }
  const registryError = asString(payload.registryError);
  return {
    ...(repository ? { repository } : {}),
    issues,
    missingTaskIds,
    ...(registryError ? { registryError } : {}),
  };
}

function asReworkSpecificIssue(value: unknown): ReworkSpecificIssue | undefined {
  const record = asRecord(value);
  const problem = asString(record.problem);
  if (!problem) return undefined;
  return {
    problem,
    ...(asString(record.file) ? { file: asString(record.file) } : {}),
    ...(asNumber(record.line) !== undefined ? { line: asNumber(record.line) } : {}),
  };
}

function asReworkEdge(value: unknown): ReworkEdge | undefined {
  const record = asRecord(value);
  const from = asString(record.from);
  const to = asString(record.to);
  if (!from || !to) return undefined;
  return { from, to };
}

function asOscillationDiagnostics(
  value: unknown,
): ReworkOscillationDiagnostics | undefined {
  const record = asRecord(value);
  const from = asString(record.from);
  const to = asString(record.to);
  const count = asNumber(record.count);
  const window = asNumber(record.window);
  if (!from || !to || count === undefined || window === undefined) {
    return undefined;
  }
  const edges = Array.isArray(record.edges)
    ? record.edges
        .map(asReworkEdge)
        .filter((edge): edge is ReworkEdge => edge !== undefined)
    : [];
  return { from, to, count, window, edges };
}

function asReworkRequest(value: unknown): ReworkRequest | undefined {
  const record = asRecord(value);
  const targetStage = asString(record.targetStage);
  const reason = asString(record.reason);
  if (!targetStage || !reason) return undefined;
  const specificIssues = Array.isArray(record.specificIssues)
    ? record.specificIssues
        .map(asReworkSpecificIssue)
        .filter((issue): issue is ReworkSpecificIssue => issue !== undefined)
    : undefined;
  return {
    targetStage,
    reason,
    ...(asString(record.targetArtifact)
      ? { targetArtifact: asString(record.targetArtifact) }
      : {}),
    ...(asString(record.instructions)
      ? { instructions: asString(record.instructions) }
      : {}),
    ...(asString(record.context) ? { context: asString(record.context) } : {}),
    ...(specificIssues && specificIssues.length > 0 ? { specificIssues } : {}),
    ...(asString(record.sourceStage)
      ? { sourceStage: asString(record.sourceStage) }
      : {}),
    ...(asNumber(record.sourceAttempt) !== undefined
      ? { sourceAttempt: asNumber(record.sourceAttempt) }
      : {}),
  };
}

function asContextKnowledgeEntry(
  value: unknown,
  injectedAt: string,
  linkedTaskId?: string,
): ProjectedContextKnowledgeEntry | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  const category = asString(record.category);
  const title = asString(record.title);
  const version = asNumber(record.version);
  if (!id || !category || !title || version === undefined) return undefined;
  return {
    id,
    category,
    title,
    version,
    tags: asStringArray(record.tags) ?? [],
    keywords: asStringArray(record.keywords) ?? [],
    linkedTaskId,
    injectedAt,
  };
}

function asTaskPlanTask(value: unknown): ProjectedTaskPlanTask | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    status: asString(record.status),
    dependencies: asStringArray(record.dependencies),
    paths: asStringArray(record.paths),
    notes: asString(record.notes),
  };
}

function asTaskPlanHistoryEntry(
  value: unknown,
): ProjectedTaskPlanHistoryEntry | undefined {
  const record = asRecord(value);
  const taskId = asString(record.taskId);
  const status = asString(record.status);
  if (!taskId || !status) return undefined;
  return {
    taskId,
    status,
    stageId: asString(record.stageId),
    attempt: asNumber(record.attempt),
    message: asString(record.message),
    createdAt: asString(record.createdAt),
  };
}

function asTaskPlanHistory(value: unknown): ProjectedTaskPlanHistoryEntry[] {
  return Array.isArray(value)
    ? value
        .map(asTaskPlanHistoryEntry)
        .filter((entry): entry is ProjectedTaskPlanHistoryEntry => entry !== undefined)
    : [];
}

function taskPlanProjectionFromPayload(
  payload: Record<string, unknown>,
  createdAt: string,
  previous?: ProjectedTaskPlanLoop,
): ProjectedTaskPlanLoop | undefined {
  const inputId = asString(payload.inputId) ?? previous?.inputId;
  if (!inputId) return undefined;
  const currentTask = asTaskPlanTask(payload.currentTask) ?? previous?.currentTask;
  return {
    inputId,
    version: asString(payload.version) ?? previous?.version,
    currentTask,
    currentTaskId:
      asString(payload.currentTaskId) ?? currentTask?.id ?? previous?.currentTaskId,
    completedTaskIds:
      asStringArray(payload.completedTaskIds) ?? previous?.completedTaskIds ?? [],
    remainingTaskIds:
      asStringArray(payload.remainingTaskIds) ?? previous?.remainingTaskIds ?? [],
    completedCount: asNumber(payload.completedCount) ?? previous?.completedCount ?? 0,
    remainingCount: asNumber(payload.remainingCount) ?? previous?.remainingCount ?? 0,
    totalTaskCount:
      asNumber(payload.totalTaskCount) ?? previous?.totalTaskCount ?? 0,
    iteration: asNumber(payload.iteration) ?? previous?.iteration,
    maxIterations: asNumber(payload.maxIterations) ?? previous?.maxIterations,
    history: asTaskPlanHistory(payload.history),
    selectedAt: previous?.selectedAt ?? createdAt,
    targetStage: asString(payload.targetStage) ?? previous?.targetStage,
    deferredAt: previous?.deferredAt,
    completedAt: previous?.completedAt,
  };
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
  const sha256 = artifact.sha256;
  if (
    sha256 !== undefined &&
    (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256))
  ) {
    throw new Error(`artifact ${id} has invalid sha256 event metadata`);
  }
  const size = artifact.size;
  if (
    size !== undefined &&
    (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
  ) {
    throw new Error(`artifact ${id} has invalid size event metadata`);
  }
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
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(size !== undefined ? { size } : {}),
    createdByRunId: asString(artifact.createdByRunId),
    stageId: asString(artifact.stageId),
    attempt:
      typeof artifact.attempt === "number" &&
        Number.isSafeInteger(artifact.attempt) &&
        artifact.attempt >= 0
        ? artifact.attempt
        : undefined,
  };
}

function asReviewGateVerdict(value: unknown): ReviewGateVerdict | undefined {
  const verdict = asString(value);
  return verdict === "approved" ||
    verdict === "pass" ||
    verdict === "fail" ||
    verdict === "needs_fix" ||
    verdict === "needs_rework_spec" ||
    verdict === "escalate"
    ? verdict
    : undefined;
}

function asReviewGateVerdictRouting(
  value: unknown,
): ReviewGateVerdictRouting | undefined {
  const record = asRecord(value);
  const verdict = asReviewGateVerdict(record.verdict);
  if (!verdict) return undefined;
  const specificIssues = Array.isArray(record.specificIssues)
    ? record.specificIssues
        .map(asReworkSpecificIssue)
        .filter(
          (issue): issue is ReviewGateSpecificIssue => issue !== undefined,
        )
    : undefined;
  return {
    verdict,
    ...(asString(record.reason) ? { reason: asString(record.reason) } : {}),
    ...(asString(record.targetStage)
      ? { targetStage: asString(record.targetStage) }
      : {}),
    ...(asString(record.targetArtifact)
      ? { targetArtifact: asString(record.targetArtifact) }
      : {}),
    ...(asString(record.reworkTarget)
      ? { reworkTarget: asString(record.reworkTarget) }
      : {}),
    ...(asString(record.instructions)
      ? { instructions: asString(record.instructions) }
      : {}),
    ...(specificIssues && specificIssues.length > 0 ? { specificIssues } : {}),
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
          ...(asReviewGateVerdictRouting(reviewOutputRecord.verdict)
            ? { verdict: asReviewGateVerdictRouting(reviewOutputRecord.verdict) }
            : {}),
        }
      : undefined;
  const operatorReviewRecord = asRecord(record.operatorReview);
  const operatorReviewActor = asString(operatorReviewRecord.actor);
  const operatorReviewSubmittedAt = asString(operatorReviewRecord.submittedAt);
  const operatorReviewArtifactIds = asStringArray(
    operatorReviewRecord.reviewedArtifactIds,
  );
  const operatorReviewBlockerRecord = asRecord(operatorReviewRecord.blocker);
  const operatorReviewBlockerReason = asString(operatorReviewBlockerRecord.reason);
  const operatorReviewBlockerStageId = asString(
    operatorReviewBlockerRecord.stageId,
  );
  const operatorReview =
    operatorReviewActor &&
    operatorReviewSubmittedAt &&
    operatorReviewArtifactIds &&
    operatorReviewBlockerReason &&
    operatorReviewBlockerStageId
      ? {
          actor: operatorReviewActor,
          submittedAt: operatorReviewSubmittedAt,
          reviewedArtifactIds: operatorReviewArtifactIds,
          blocker: {
            reason: operatorReviewBlockerReason,
            stageId: operatorReviewBlockerStageId,
            ...(asString(operatorReviewBlockerRecord.runtime)
              ? { runtime: asString(operatorReviewBlockerRecord.runtime) }
              : {}),
            ...(asString(operatorReviewBlockerRecord.message)
              ? { message: asString(operatorReviewBlockerRecord.message) }
              : {}),
            ...(asString(operatorReviewBlockerRecord.retryAfter)
              ? { retryAfter: asString(operatorReviewBlockerRecord.retryAfter) }
              : {}),
          },
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
    operatorReview,
    reason: asString(record.reason),
    advisoryReason: asString(record.advisoryReason),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    attempt: asNumber(record.attempt),
    createdAt: asString(record.createdAt) ?? createdAt,
  };
}

function asRiskClass(value: unknown): RiskClass | undefined {
  return typeof value === "string" &&
    (RISK_CLASSES as readonly string[]).includes(value)
    ? (value as RiskClass)
    : undefined;
}

function asRiskSignals(value: unknown): RiskSignal[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const id = asString(record.id);
      const riskClass = asRiskClass(record.riskClass);
      const detail = asString(record.detail);
      if (!id || !riskClass || !detail) return undefined;
      const owners = asStringArray(record.owners);
      return {
        id: id as RiskSignal["id"],
        riskClass,
        detail,
        paths: asStringArray(record.paths) ?? [],
        ...(asString(record.domain) ? { domain: asString(record.domain)! } : {}),
        ...(owners ? { owners } : {}),
      } satisfies RiskSignal;
    })
    .filter((signal): signal is RiskSignal => signal !== undefined);
}

function asReviewRequirement(
  value: unknown,
  effective: RiskClass,
): ReviewRequirement | undefined {
  const record = asRecord(value);
  const requiredApprovals = asNumber(record.requiredApprovals);
  if (requiredApprovals === undefined) return undefined;
  return {
    riskClass: asRiskClass(record.riskClass) ?? effective,
    requiredApprovals,
    requireCodeOwner: record.requireCodeOwner === true,
    draftOnly: record.draftOnly === true,
    autoMergeEligible: record.autoMergeEligible === true,
    allowUnattendedMerge: record.allowUnattendedMerge === true,
    requireRunApproval: record.requireRunApproval === true,
  };
}

function asRiskClassification(
  payload: Record<string, unknown>,
  event: StoredRunEvent,
): ProjectedRiskClassification | undefined {
  const classification = asRecord(payload.classification);
  const declared = asRiskClass(classification.declared);
  const effective = asRiskClass(classification.effective);
  if (!declared || !effective) return undefined;
  const requirement = asReviewRequirement(payload.requirement, effective);
  if (!requirement) return undefined;
  const changedLines = asNumber(classification.changedLines);
  return {
    stageId: event.stageId ?? "",
    declared,
    effective,
    escalated: classification.escalated === true,
    explanation: asString(classification.explanation) ?? "",
    signals: asRiskSignals(classification.signals),
    requiredOwners: asStringArray(classification.requiredOwners) ?? [],
    requirement,
    diffDigest: asString(classification.diffDigest) ?? "",
    changedFileCount: asNumber(classification.changedFileCount) ?? 0,
    ...(changedLines !== undefined ? { changedLines } : {}),
    policyConfigured: payload.policyConfigured === true,
    ...(asString(payload.codeOwnersPath)
      ? { codeOwnersPath: asString(payload.codeOwnersPath)! }
      : {}),
    createdAt: event.createdAt,
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
  const oscillation = asOscillationDiagnostics(record.oscillation);
  return {
    stageId,
    stageType: stageType as OrchestratorDecisionEvent["stageType"],
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    action,
    reason,
    error: asString(record.error),
    targetStage: asString(record.targetStage),
    targetArtifact: asString(record.targetArtifact),
    reworkRequest: asReworkRequest(record.reworkRequest),
    ...(oscillation ? { oscillation } : {}),
  };
}

function asVerificationFailureDiagnosis(
  value: unknown,
): ProjectedVerificationFailureDiagnosis | undefined {
  const record = asRecord(value);
  const stageId = asString(record.stageId);
  const stageType = asString(record.stageType);
  const classification = asString(record.classification);
  const confidence = asString(record.confidence);
  const reason = asString(record.reason);
  const recommendedAction = asString(record.recommendedAction);
  if (
    !stageId ||
    !stageType ||
    typeof record.attempt !== "number" ||
    typeof record.maxAttempts !== "number" ||
    !reason ||
    (classification !== "implementation" &&
      classification !== "spec" &&
      classification !== "environment" &&
      classification !== "unclear") ||
    (confidence !== "high" && confidence !== "medium" && confidence !== "low") ||
    (recommendedAction !== "rework" &&
      recommendedAction !== "retry" &&
      recommendedAction !== "escalate")
  ) {
    return undefined;
  }
  return {
    stageId,
    stageType: stageType as ProjectedVerificationFailureDiagnosis["stageType"],
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    classification,
    confidence,
    reason,
    evidence: asStringArray(record.evidence) ?? [],
    targetStage: asString(record.targetStage),
    targetArtifact: asString(record.targetArtifact),
    recommendedAction,
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

function asWorkflowStage(value: unknown): ProjectedWorkflowStage | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) return undefined;
  return {
    id,
    type: asString(record.type),
    command: asString(record.command),
    inputs: asStringArray(record.inputs) ?? [],
    outputs: asStringArray(record.outputs) ?? [],
    maxAttempts: asNumber(record.maxAttempts),
    ...(record.costClass === "cheap" ||
    record.costClass === "moderate" ||
    record.costClass === "expensive" ||
    record.costClass === "human"
      ? { costClass: record.costClass }
      : {}),
  };
}

function asVerificationBudget(value: unknown): {
  maxAgentAttempts?: number;
  maxJudgeAttempts?: number;
  maxCiRuns?: number;
  maxRuntimeCostUsd?: number;
} | undefined {
  const record = asRecord(value);
  const budget = {
    maxAgentAttempts: asNumber(record.maxAgentAttempts),
    maxJudgeAttempts: asNumber(record.maxJudgeAttempts),
    maxCiRuns: asNumber(record.maxCiRuns),
    maxRuntimeCostUsd: asNumber(record.maxRuntimeCostUsd),
  };
  return Object.values(budget).some((entry) => entry !== undefined)
    ? budget
    : undefined;
}

function buildVerificationBudget(
  stages: Iterable<ProjectedStage>,
  workflowStages: ProjectedWorkflowStage[] | undefined,
  declared: ReturnType<typeof asVerificationBudget>,
  terminalStatus: ProjectedRun["terminalStatus"],
): ProjectedVerificationBudget | undefined {
  const allStages = [...stages];
  const agentAttempts = allStages
    .filter((stage) => stage.stageType === "agent")
    .reduce((total, stage) => total + stage.attempts.length, 0);
  const judgeAttempts = allStages
    .filter((stage) => stage.stageType === "judge")
    .reduce((total, stage) => total + stage.attempts.length, 0);
  const declaredStages = new Map(
    (workflowStages ?? []).map((stage) => [stage.id, stage]),
  );
  const ciRuns = allStages
    .filter((stage) => {
      if (stage.stageType !== "command") return false;
      const costClass = declaredStages.get(stage.stageId)?.costClass;
      return costClass === undefined || costClass === "expensive";
    })
    .reduce((total, stage) => total + stage.attempts.length, 0);
  let runtimeCostUsd = 0;
  let actualCostUsd = 0;
  let estimatedCostUsd = 0;
  let hasActualCost = false;
  let hasEstimatedCost = false;
  let unknownCostAttempts = 0;
  for (const stage of allStages) {
    for (const attempt of stage.attempts) {
      if (attempt.status === "unavailable" || attempt.status === "skipped") continue;
      const runtimeAttempt =
        stage.stageType === "agent" ||
        stage.stageType === "judge" ||
        attempt.runtime !== undefined;
      if (!runtimeAttempt) continue;
      const usage = attempt.runtimeUsage;
      const provenance = usage?.provenance;
      const validProvenance = provenance !== undefined &&
        provenance.provider.trim().length > 0 &&
        Number.isFinite(Date.parse(provenance.observedAt)) &&
        provenance.source.reference.trim().length > 0;
      if (
        usage?.cost?.classification === "actual" &&
        validProvenance &&
        provenance.source.kind === "provider-reported"
      ) {
        actualCostUsd += usage.cost.usd;
        runtimeCostUsd += usage.cost.usd;
        hasActualCost = true;
      } else if (
        usage?.cost?.classification === "estimated" &&
        validProvenance &&
        provenance.source.kind === "calculated"
      ) {
        estimatedCostUsd += usage.cost.usd;
        runtimeCostUsd += usage.cost.usd;
        hasEstimatedCost = true;
      } else {
        unknownCostAttempts += 1;
      }
    }
  }
  const attemptedStageIds = new Set(allStages.filter((stage) => stage.attempts.length > 0).map((stage) => stage.stageId));
  const skippedExpensiveStageIds = terminalStatus && terminalStatus !== "completed"
    ? (workflowStages ?? [])
        .filter((stage) => stage.costClass === "expensive" && !attemptedStageIds.has(stage.id))
        .map((stage) => stage.id)
    : [];
  if (!declared && skippedExpensiveStageIds.length === 0) return undefined;
  return {
    ...declared,
    agentAttempts,
    judgeAttempts,
    ciRuns,
    ...(hasActualCost ? { actualCostUsd } : {}),
    ...(hasEstimatedCost ? { estimatedCostUsd } : {}),
    ...(hasActualCost || hasEstimatedCost ? { runtimeCostUsd } : {}),
    unknownCostAttempts,
    ...(declared?.maxAgentAttempts !== undefined
      ? { remainingAgentAttempts: Math.max(0, declared.maxAgentAttempts - agentAttempts) }
      : {}),
    ...(declared?.maxJudgeAttempts !== undefined
      ? { remainingJudgeAttempts: Math.max(0, declared.maxJudgeAttempts - judgeAttempts) }
      : {}),
    ...(declared?.maxCiRuns !== undefined
      ? { remainingCiRuns: Math.max(0, declared.maxCiRuns - ciRuns) }
      : {}),
    ...(declared?.maxRuntimeCostUsd !== undefined && unknownCostAttempts === 0
      ? { remainingRuntimeCostUsd: Math.max(0, declared.maxRuntimeCostUsd - runtimeCostUsd) }
      : {}),
    skippedExpensiveStageIds,
  };
}

function asWorkflowStages(value: unknown): ProjectedWorkflowStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stages = value
    .map(asWorkflowStage)
    .filter((stage): stage is ProjectedWorkflowStage => stage !== undefined);
  return stages.length > 0 ? stages : undefined;
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

function approvalIdForEvent(event: StoredRunEvent, payload: Record<string, unknown>): string | undefined {
  const approvalId = asString(payload.approvalId);
  if (approvalId) return approvalId;
  if (!event.stageId || !event.attempt) return undefined;
  return `${event.stageId}-${event.attempt}`;
}

export function projectRun(
  events: StoredRunEvent[],
  options: ProjectRunOptions = {},
): ProjectedRun {
  if (events.length === 0) {
    throw new Error("cannot project a run without events");
  }

  const runId = events[0]?.runId ?? "";
  const stages = new Map<string, ProjectedStage>();
  const completedStages = new Set<string>();
  const logs: ProjectedLog[] = [];
  const approvals: ProjectedApproval[] = [];
  const artifacts: RunArtifact[] = [];
  const gates: GateResult[] = [];
  const orchestratorDecisions: OrchestratorDecisionEvent[] = [];
  const verificationDiagnoses: ProjectedVerificationFailureDiagnosis[] = [];
  const knowledgeGenerations: ProjectedKnowledgeGeneration[] = [];
  const contextKnowledge: ProjectedContextKnowledgeEntry[] = [];
  const budgetSignals: ProjectedBudgetSignal[] = [];
  const repoIndexQueries: ProjectedRepoIndexQuery[] = [];
  const knowledgeRetrievals: ProjectedKnowledgeRetrieval[] = [];
  const questions: ProjectedOperatorQuestion[] = [];
  const artifactIndexes = new Map<string, number>();
  let finalizerStageIds = new Set<string>();
  const projection: ProjectedRun = {
    runId,
    status: "created",
    completedStages: [],
    stages: [],
    approvals,
    logs,
    artifacts,
    gates,
    orchestratorDecisions,
    verificationDiagnoses,
    questions,
  };

  function finalizerStageIdsFromMarkers(): string[] {
    return [...stages.values()]
      .filter((stage) => typeof stage.markers?.resumedFrom === "string")
      .map((stage) => stage.stageId);
  }

  function latestProjectedStageId(excludingStageIds: Set<string> = new Set()): string | undefined {
    return [...stages.values()]
      .filter((stage) => !excludingStageIds.has(stage.stageId))
      .at(-1)?.stageId;
  }

  function setRunTerminal(
    status: NonNullable<ProjectedRun["terminalStatus"]>,
    createdAt: string,
  ): void {
    finalizerStageIds = new Set(finalizerStageIdsFromMarkers());
    projection.status = status;
    projection.terminalStatus = status;
    projection.terminalStageId = latestProjectedStageId(finalizerStageIds);
    projection.terminalEventAt = createdAt;
    projection.finalizerStageIds =
      finalizerStageIds.size > 0 ? [...finalizerStageIds] : undefined;
  }

  function setNonTerminalRunStatus(status: ProjectedRunStatus): void {
    if (!projection.terminalStatus) {
      projection.status = status;
    }
  }

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (projection.terminalStatus && event.stageId) {
      finalizerStageIds.add(event.stageId);
      projection.finalizerStageIds = [...finalizerStageIds];
    }

    if (event.type === "run.admitted" || event.type === "run.created") {
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
      if (
        typeof payload.runEligibilityOverride === "object" &&
        payload.runEligibilityOverride !== null
      ) {
        projection.runEligibilityOverride =
          payload.runEligibilityOverride as RunEligibilityOverrideEvidence;
      }
      projection.flowPath = asString(payload.flowPath);
      projection.flowDocument = asString(payload.flowDocument);
      projection.flowDocumentSha256 = asString(payload.flowDocumentSha256);
      projection.configurationSnapshotPath = asString(
        payload.configurationSnapshotPath,
      );
      projection.configurationSha256 = asString(payload.configurationSha256);
      projection.contextPolicySha256 = asString(payload.contextPolicySha256);
      projection.promptContext = payload.promptContext;
      projection.expectedSkillContentHashes = payload.expectedSkillContentHashes;
      projection.knowledgeSnapshots = payload.knowledgeSnapshots;
      projection.executionBackend = asString(payload.executionBackend);
      const sandboxPolicy = asRecord(payload.sandboxPolicy);
      if (isCodexSandboxMode(sandboxPolicy.codex)) {
        projection.sandboxPolicy = { codex: sandboxPolicy.codex };
      }
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
      if (
        typeof payload.configuration === "object" &&
        payload.configuration !== null
      ) {
        projection.configuration = payload.configuration as Record<string, unknown>;
      }
      if (typeof payload.budgets === "object" && payload.budgets !== null) {
        projection.budgets = payload.budgets;
      }
      const declaredVerificationBudget = asVerificationBudget(
        payload.verificationBudget,
      );
      if (declaredVerificationBudget) {
        projection.verificationBudget = buildVerificationBudget(
          [],
          undefined,
          declaredVerificationBudget,
          undefined,
        );
      }
      projection.workflowStages = asWorkflowStages(payload.workflowStages);
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

    if (event.type === "context-kg.injected") {
      const linkedTaskId = asString(payload.linkedTaskId);
      const entries = Array.isArray(payload.entries)
        ? payload.entries
            .map((entry) =>
              asContextKnowledgeEntry(entry, event.createdAt, linkedTaskId),
            )
            .filter(
              (entry): entry is ProjectedContextKnowledgeEntry =>
                entry !== undefined,
            )
        : [];
      contextKnowledge.push(...entries);
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

    if (event.type === "task.issue.scope_resolved") {
      const taskIssues = asResolvedTaskIssueScope(payload);
      if (taskIssues) projection.taskIssues = taskIssues;
      continue;
    }

    if (
      event.type === "task.plan.iteration.started" ||
      event.type === "task.plan.task.completed" ||
      event.type === "task.plan.loop.continues" ||
      event.type === "task.plan.final.ready"
    ) {
      const taskPlan = taskPlanProjectionFromPayload(
        payload,
        event.createdAt,
        projection.taskPlan,
      );
      if (taskPlan) {
        projection.taskPlan =
          event.type === "task.plan.loop.continues" &&
          asString(payload.reopenedTaskId)
            ? {
                ...taskPlan,
                completedAt: undefined,
                deferredAt: undefined,
              }
            : taskPlan;
      }
      continue;
    }

    if (event.type === "task.plan.final.deferred") {
      const taskPlan = taskPlanProjectionFromPayload(
        payload,
        event.createdAt,
        projection.taskPlan,
      );
      if (taskPlan) {
        projection.taskPlan = {
          ...taskPlan,
          deferredAt: event.createdAt,
        };
      }
      continue;
    }

    if (event.type === "task.plan.completed") {
      const taskPlan = taskPlanProjectionFromPayload(
        payload,
        event.createdAt,
        projection.taskPlan,
      );
      if (taskPlan) {
        projection.taskPlan = {
          ...taskPlan,
          currentTask: undefined,
          currentTaskId: undefined,
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

    if (event.type === "knowledge.retrieved") {
      const matches = Array.isArray(payload.matches)
        ? payload.matches
            .map((value): ProjectedKnowledgeRetrievalMatch | undefined => {
              const match = asRecord(value);
              const attachmentId = asString(match.attachmentId);
              const commitSha = asString(match.commitSha);
              const chunkId = asString(match.chunkId);
              const citation = asString(match.citation);
              const rank = asNumber(match.rank);
              if (
                !attachmentId ||
                !commitSha ||
                !chunkId ||
                !citation ||
                rank === undefined
              ) {
                return undefined;
              }
              return {
                attachmentId,
                snapshotId: asString(match.snapshotId),
                commitSha,
                indexDigest: asString(match.indexDigest),
                chunkId,
                citation,
                rank,
                lexicalScore: asNumber(match.lexicalScore),
                semanticScore: asNumber(match.semanticScore),
                combinedScore: asNumber(match.combinedScore),
                providerId: asString(match.providerId),
                model: asString(match.model),
              };
            })
            .filter(
              (match): match is ProjectedKnowledgeRetrievalMatch =>
                match !== undefined,
            )
        : [];
      knowledgeRetrievals.push({
        stageId: event.stageId,
        attempt: event.attempt,
        createdAt: event.createdAt,
        queryFingerprint: asString(payload.queryFingerprint),
        status: payload.status === "degraded" ? "degraded" : "ready",
        candidateCount: asNumber(payload.candidateCount),
        selectedCount: asNumber(payload.selectedCount),
        trimmedCount: asNumber(payload.trimmedCount),
        promptTokens: asNumber(payload.promptTokens),
        degradedAttachmentIds:
          asStringArray(payload.degradedAttachmentIds) ?? [],
        reasonCodes: asStringArray(payload.reasonCodes) ?? [],
        matches,
      });
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
        ...(asNumber(payload.knowledgeChunkCount) !== undefined
          ? { knowledgeChunkCount: asNumber(payload.knowledgeChunkCount) }
          : {}),
        ...(asNumber(payload.knowledgeBytesInlined) !== undefined
          ? { knowledgeBytesInlined: asNumber(payload.knowledgeBytesInlined) }
          : {}),
        ...(asNumber(payload.knowledgeApproxTokens) !== undefined
          ? { knowledgeApproxTokens: asNumber(payload.knowledgeApproxTokens) }
          : {}),
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
        trimmedExternalKnowledgeCount: asNumber(
          payload.trimmedExternalKnowledgeCount,
        ),
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
        budgetKind: asString(payload.budgetKind),
        scope: asString(payload.scope),
        phase: asString(payload.phase),
        budget: asNumber(payload.budget) ?? 0,
        consumed: asNumber(payload.consumed),
        remaining: asNumber(payload.remaining),
        minimum: asNumber(payload.minimum),
        approxTokens: asNumber(payload.approxTokens),
        actualCostUsd: asNumber(payload.actualCostUsd),
        estimatedCostUsd: asNumber(payload.estimatedCostUsd),
        unknownRuntimeAttempts: asNumber(payload.unknownRuntimeAttempts),
        unknownCostAttempts: asNumber(payload.unknownCostAttempts),
        message: asString(payload.message),
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

    if (event.type === "approval.requested" && event.stageId && event.attempt) {
      const approvalId = approvalIdForEvent(event, payload);
      if (!approvalId) continue;
      const existing = approvals.find((approval) => approval.id === approvalId);
      const approval: ProjectedApproval = {
        id: approvalId,
        stageId: event.stageId,
        attempt: event.attempt,
        prompt: asString(payload.prompt) ?? "",
        status: existing?.status ?? "pending",
        requestedAt: existing?.requestedAt ?? event.createdAt,
        resolvedAt: existing?.resolvedAt,
        actor: existing?.actor,
        decision: existing?.decision,
        reviewedArtifactIds:
          existing?.reviewedArtifactIds ?? asStringArray(payload.reviewedArtifactIds),
      };
      if (existing) {
        approvals[approvals.indexOf(existing)] = approval;
      } else {
        approvals.push(approval);
      }
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.status = "awaiting-approval";
      stage.status = "awaiting-approval";
      setNonTerminalRunStatus("awaiting-approval");
      continue;
    }

    if (event.type === "approval.resolved" && event.stageId && event.attempt) {
      const approvalId = approvalIdForEvent(event, payload);
      if (!approvalId) continue;
      const approved = payload.approved === true || asString(payload.decision) === "approved";
      const status: ProjectedApprovalStatus = approved ? "approved" : "denied";
      const existing = approvals.find((approval) => approval.id === approvalId);
      const approval: ProjectedApproval = {
        id: approvalId,
        stageId: event.stageId,
        attempt: event.attempt,
        prompt: existing?.prompt ?? asString(payload.prompt) ?? "",
        status,
        requestedAt: existing?.requestedAt ?? event.createdAt,
        resolvedAt: event.createdAt,
        actor: asString(payload.actor),
        decision: status,
        reviewedArtifactIds:
          asStringArray(payload.reviewedArtifactIds) ?? existing?.reviewedArtifactIds,
      };
      if (existing) {
        approvals[approvals.indexOf(existing)] = approval;
      } else {
        approvals.push(approval);
      }
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.status = "awaiting-approval";
      stage.status = "awaiting-approval";
      setNonTerminalRunStatus("awaiting-approval");
      continue;
    }

    if (event.type === "orchestrator.decision") {
      const decision = asOrchestratorDecisionEvent(payload);
      if (decision) {
        orchestratorDecisions.push(decision);
      }
      continue;
    }

    if (event.type === "verification.failure.diagnosed") {
      const diagnosis = asVerificationFailureDiagnosis(payload);
      if (diagnosis) {
        verificationDiagnoses.push(diagnosis);
      }
      continue;
    }

    if (event.type === "stage.question") {
      const question = asProjectedQuestion(event, payload);
      if (question) {
        const existing = questions.findIndex((candidate) => candidate.id === question.id);
        if (existing >= 0) questions[existing] = question;
        else questions.push(question);
      }
      continue;
    }

    if (event.type === "operator.answer") {
      const questionId = asString(payload.questionId);
      const question = questions.find((candidate) => candidate.id === questionId);
      const actor = asString(payload.actor);
      if (question && actor) {
        question.status = "answered";
        question.answer = {
          ...(asString(payload.optionId) ? { optionId: asString(payload.optionId) } : {}),
          ...(asString(payload.text) ? { text: asString(payload.text) } : {}),
          actor,
          answeredAt: event.createdAt,
        };
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

    if (event.type === "run.risk.classified") {
      const classified = asRiskClassification(payload, event);
      if (classified) {
        projection.riskClassification = classified;
      }
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
      setRunTerminal("completed", event.createdAt);
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
      setRunTerminal("failed", event.createdAt);
      projection.blocker = undefined;
      continue;
    }

    if (event.type === "run.resumed") {
      projection.terminalStatus = undefined;
      projection.terminalStageId = undefined;
      projection.terminalEventAt = undefined;
      projection.finalizerStageIds = undefined;
      finalizerStageIds = new Set();
      projection.status = "running";
      projection.blocker = undefined;
      if (typeof payload.budgets === "object" && payload.budgets !== null) {
        projection.budgets = payload.budgets;
      }
      continue;
    }

    if (event.type === "run.blocked") {
      setRunTerminal("blocked", event.createdAt);
      projection.blocker = asRunBlocker(payload);
      continue;
    }

    if (event.type === "run.cancelled") {
      setRunTerminal("cancelled", event.createdAt);
      projection.blocker = undefined;
    }
  }

  for (const stage of stages.values()) {
    const attempt = latestAttempt(stage);
    if (attempt?.status === "started" && options.openAttemptStatus === "interrupted") {
      attempt.status = "interrupted";
      stage.status = "interrupted";
    }
  }

  if (
    [...stages.values()].some((stage) => stage.status === "interrupted") &&
    projection.status !== "completed" &&
    projection.status !== "awaiting-approval" &&
    projection.status !== "blocked" &&
    projection.status !== "failed" &&
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
  const declaredVerificationBudget = asVerificationBudget(
    projection.verificationBudget,
  );
  const verificationBudget = buildVerificationBudget(
    stages.values(),
    projection.workflowStages,
    declaredVerificationBudget,
    projection.terminalStatus,
  );
  if (verificationBudget) {
    projection.verificationBudget = verificationBudget;
  }
  if (knowledgeGenerations.length > 0) {
    projection.knowledgeGenerations = knowledgeGenerations;
  }
  if (contextKnowledge.length > 0) {
    projection.contextKnowledge = contextKnowledge;
  }
  if (repoIndexQueries.length > 0) {
    projection.repoIndexQueries = repoIndexQueries;
  }
  if (knowledgeRetrievals.length > 0) {
    projection.knowledgeRetrievals = knowledgeRetrievals;
  }
  projection.pendingQuestion = questions.findLast(
    (question) => question.status === "pending",
  );
  projection.activeQuestion = projection.blocker?.questionId
    ? questions.find((question) => question.id === projection.blocker?.questionId)
    : undefined;

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

/**
 * Lists stored events for several Runs against one open event store.
 *
 * A listing needs each Run's events for stale-aware projection and its status
 * summary. Asking for them one Run at a time is what made a listing open the
 * store twice per Run and project every Run a second time (#518).
 */
export function listRunEvents(
  repoPath: string,
  runIds: Iterable<string>,
): Map<string, StoredRunEvent[]> {
  const store = openStore(repoPath);
  try {
    const byRun = new Map<string, StoredRunEvent[]>();
    for (const runId of runIds) {
      byRun.set(runId, store.list(runId));
    }
    return byRun;
  } finally {
    store.close();
  }
}

/**
 * How long a `running` Run may go without any event on its open attempt before
 * the runner is presumed dead. A SIGKILLed runner writes no terminal event, so
 * a projection that trusted the last event forever would report `running`
 * indefinitely.
 */
export const DEFAULT_STALE_RUNNING_RUN_MS = 5 * 60 * 1000;

export function staleRunningRunMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.NITELY_STALE_RUNNING_RUN_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_STALE_RUNNING_RUN_MS;
}

function latestOpenStartedAttemptEventTimeMs(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): number | undefined {
  const stage = projection.stages.at(-1);
  const attempt = stage?.attempts.at(-1);
  if (!stage || attempt?.status !== "started") return undefined;
  return events
    .filter(
      (event) =>
        event.stageId === stage.stageId && event.attempt === attempt.attempt,
    )
    .map((event) => Date.parse(event.createdAt))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => right - left)
    .at(0);
}

/**
 * Projects a Run, and downgrades a `running` status whose open attempt has gone
 * quiet past the stale threshold to `interrupted`. A killed runner leaves the
 * attempt open forever; reporting `running` for it is a lie that hides a run an
 * operator has to recover.
 */
export function projectRunStaleAware(
  events: StoredRunEvent[],
  options: { now?: number; staleAfterMs?: number } = {},
): { projection: ProjectedRun; stale: boolean; latestEventAt?: string } {
  const projection = projectRun(events);
  if (projection.status !== "running") return { projection, stale: false };
  const latest = latestOpenStartedAttemptEventTimeMs(projection, events);
  if (latest === undefined) return { projection, stale: false };
  const staleAfterMs = options.staleAfterMs ?? staleRunningRunMs();
  if ((options.now ?? Date.now()) - latest < staleAfterMs) {
    return { projection, stale: false };
  }
  return {
    projection: projectRun(events, { openAttemptStatus: "interrupted" }),
    stale: true,
    latestEventAt: new Date(latest).toISOString(),
  };
}

export async function getProjectedRun(
  repoPath: string,
  runId: string,
  options: { staleAware?: boolean } = {},
): Promise<ProjectedRun> {
  validateRunId(runId);
  const store = openStore(repoPath);
  try {
    const events = store.list(runId);
    if (events.length === 0) {
      throw new Error(
        `run not found: ${runId}; retry with --repo <path used for run>`,
      );
    }
    return options.staleAware
      ? projectRunStaleAware(events).projection
      : projectRun(events);
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

/** Where one projected log entry's content lives, before anything is read. */
export interface ProjectedRunLogSource {
  stageId: string;
  attempt: number;
  source: "command" | "attempt";
  command?: string;
  /** Inline content, for a command log the event stream already carries. */
  stdout?: string;
  stderr?: string;
  /** Absolute directory holding `stdout.log`/`stderr.log`, for an attempt log. */
  attemptDirectory?: string;
}

/**
 * Lists a Run's log entries without reading any of them.
 *
 * A Run detail view reads every entry in full. A Run listing only needs the
 * newest meaningful line, so it walks these sources backwards and reads a
 * bounded tail of each (#518). Both go through this function, so the two views
 * agree on ordering and on which attempt directories a command log already
 * covers.
 */
export function projectedRunLogSources(
  repoPath: string,
  runId: string,
  projection: ProjectedRun,
): ProjectedRunLogSource[] {
  const sources: ProjectedRunLogSource[] = projection.logs.map((log) => ({
    ...log,
  }));
  const commandLogKeys = new Set(
    projection.logs.map((log) => `${log.stageId}:${log.attempt}`),
  );
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      if (!attempt.attemptDirectory) continue;
      if (commandLogKeys.has(`${stage.stageId}:${attempt.attempt}`)) continue;
      sources.push({
        stageId: stage.stageId,
        attempt: attempt.attempt,
        source: "attempt",
        attemptDirectory: resolveAttemptDirectory(
          repoPath,
          runId,
          attempt.attemptDirectory,
        ),
      });
    }
  }
  return sources;
}

export async function getProjectedRunLogs(
  repoPath: string,
  runId: string,
  options: { stageId?: string } = {},
): Promise<ProjectedLog[]> {
  validateRunId(runId);
  const projection = await getProjectedRun(repoPath, runId);
  const logs: ProjectedLog[] = [];
  for (const source of projectedRunLogSources(repoPath, runId, projection)) {
    if (source.attemptDirectory === undefined) {
      logs.push({
        stageId: source.stageId,
        attempt: source.attempt,
        source: source.source,
        ...(source.command !== undefined ? { command: source.command } : {}),
        ...(source.stdout !== undefined ? { stdout: source.stdout } : {}),
        ...(source.stderr !== undefined ? { stderr: source.stderr } : {}),
      });
      continue;
    }
    const [stdout, stderr] = await Promise.all([
      readOptionalFile(join(source.attemptDirectory, "stdout.log")),
      readOptionalFile(join(source.attemptDirectory, "stderr.log")),
    ]);
    if (stdout !== undefined || stderr !== undefined) {
      logs.push({
        stageId: source.stageId,
        attempt: source.attempt,
        source: "attempt",
        stdout,
        stderr,
      });
    }
  }
  return logs.filter(
    (log) => options.stageId === undefined || log.stageId === options.stageId,
  );
}
