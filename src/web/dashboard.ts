import type { WebRepository } from "./repositories.js";
import type { WebRunSummary, WebRunStatus } from "./runs.js";
import {
  buildOutcomeUnitEconomics,
  type OutcomeUnitEconomics,
} from "./unit-economics.js";
import type { NotificationRecord, NotificationSeverity, NotificationType } from "./notifications.js";
import type { WorkItemView } from "./work-item-views.js";
import {
  canonicalChangeRequestTarget,
  changeRequestIdentity,
  localChangeRequestIdentity,
} from "./change-requests.js";

type DashboardWorkItem = WorkItemView & {
  repoName?: string;
  repoPath?: string;
  repoSynthetic?: boolean;
};

export interface DashboardCount {
  label: string;
  count: number;
  taskIds: string[];
  runIds: string[];
}

export interface DashboardBlockedItem {
  id: string;
  title: string;
  kind: "task" | "run";
  repoId?: string;
  repoName?: string;
  status: string;
  ageMs?: number;
  ageLabel: string;
  ownerId?: string;
  currentStage?: string;
  blockerReason?: string;
}

export interface DashboardRepoBreakdown {
  repoId: string;
  repoName: string;
  taskCount: number;
  runCount: number;
  blockedCount: number;
  completedRuns: number;
  taskIds: string[];
  runIds: string[];
  blockedTaskIds: string[];
  blockedRunIds: string[];
  completedRunIds: string[];
  runtimeTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
}

export interface DashboardCostAttribution {
  runtimeTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
  knownRuntimeAttempts: number;
  unknownRuntimeAttempts: number;
  runtimeRunIds: string[];
  contextRunIds: string[];
  costRunIds: string[];
}

export interface DashboardOutcomeQuality {
  completedRuns: number;
  failedRuns: number;
  blockedRuns: number;
  reworkRuns: number;
  reviewGatesPassed: number;
  reviewGatesFailed: number;
  completionRate: number;
  reworkRatio: number;
  reviewGatePassRate: number;
  completedRunIds: string[];
  failedRunIds: string[];
  blockedRunIds: string[];
  reworkRunIds: string[];
  reviewGatePassedRunIds: string[];
  reviewGateFailedRunIds: string[];
}

export interface DashboardPilotRoi {
  reviewablePrsCreated: number;
  acceptedPrs: number;
  acceptanceRate: number;
  mergedPrs: number;
  mergeStatusKnownPrs: number;
  mergeRate?: number;
  mergeStatusCoverage: number;
  averageCycleTimeMs?: number;
  recoverableFailures: number;
  evidenceCompletePrs: number;
  evidenceCompletenessRate: number;
  repeatedFlowCount: number;
  estimatedCleanupMinutesAvoided: number;
  reviewableRunIds: string[];
  acceptedRunIds: string[];
  mergedRunIds: string[];
  mergeStatusKnownRunIds: string[];
  recoverableFailureRunIds: string[];
  evidenceCompleteRunIds: string[];
}

export type DashboardOutcomeBreakdownKey =
  | "reviewable-prs"
  | "accepted-prs"
  | "merged-prs"
  | "stopped-work"
  | "follow-up-rework";

export interface DashboardOutcomeBreakdown {
  key: DashboardOutcomeBreakdownKey;
  label: string;
  tracking: "tracked" | "partial" | "not-tracked";
  count?: number;
  description: string;
  taskIds: string[];
  runIds: string[];
}

export interface DashboardFlowTemplateBreakdown {
  flowKey: string;
  flowName: string;
  flowPath?: string;
  runCount: number;
  completedRuns: number;
  blockedRuns: number;
  failedRuns: number;
  runIds: string[];
  completedRunIds: string[];
  blockedRunIds: string[];
  failedRunIds: string[];
  reviewablePrsCreated: number;
  acceptedPrs: number;
  acceptanceRate: number;
  averageCycleTimeMs?: number;
  evidenceCompletePrs: number;
  evidenceCompletenessRate: number;
  reviewableRunIds: string[];
  acceptedRunIds: string[];
  evidenceCompleteRunIds: string[];
}

export interface DashboardLifecycleStage {
  key: string;
  label: string;
  count: number;
  taskIds: string[];
  runIds: string[];
}

export interface DashboardPhaseDuration {
  key: "planning" | "execution" | "review" | "rework";
  label: string;
  count: number;
  totalMs?: number;
  averageMs?: number;
  taskIds: string[];
  runIds: string[];
}

export interface FactoryMetricCoverage {
  status: "tracked" | "partial" | "unknown";
  observed: number;
  total: number;
  note?: string;
}

export interface FactoryMetrics {
  funnel: {
    candidate: number;
    eligible: number;
    queued: number;
    runStarted: number;
    prsCreated: number;
    reviewRequested: number;
    merged: number;
    candidateToEligibleRate?: number;
    eligibleToPrRate?: number;
    prToMergeRate?: number;
    automationYield?: number;
  };
  humanAttention: {
    approvalEvents: number;
    humanTouchRate?: number;
    approvalWaitMs?: number;
    approvalWaitCoverage: FactoryMetricCoverage;
  };
  latency: {
    candidateToQueuedMs?: number;
    queuedToRunStartMs?: number;
    runStartToPrMs?: number;
    prToMergeMs?: number;
    candidateToMergeMs?: number;
    blockedMs?: number;
    coverage: Record<string, FactoryMetricCoverage>;
  };
  rework: {
    agentAttempts: number;
    judgeAttempts: number;
    judgeReworkLoops: number;
    ciRuns: number;
    humanEscalations: number;
    postPublishReworkRuns: number;
  };
  cost: {
    runtimeCostUsd?: number;
    runtimeCostPerMergedPr?: number;
    contextTokens?: number;
    coverage: FactoryMetricCoverage;
  };
  coverage: {
    candidates: FactoryMetricCoverage;
    mergeStatus: FactoryMetricCoverage;
    cost: FactoryMetricCoverage;
  };
}

export interface DashboardFilterSelection {
  repo?: string;
  flow?: string;
  status?: string;
  priority?: string;
  owner?: string;
  window?: string;
  start?: string;
  end?: string;
}

export interface DashboardFilterOption {
  value: string;
  label: string;
  count: number;
}

export interface DashboardFilterSet {
  selected: DashboardFilterSelection;
  repositories: DashboardFilterOption[];
  flows: DashboardFilterOption[];
  statuses: DashboardFilterOption[];
  priorities: DashboardFilterOption[];
  owners: DashboardFilterOption[];
  windows: DashboardFilterOption[];
  activeCount: number;
}

export interface MyWorkDashboardItem {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  link: string;
  taskId?: string;
  runId?: string;
  repoId?: string;
  repoName?: string;
  status: string;
  actionLabel: string;
  ageMs?: number;
  ageLabel: string;
  overdue: boolean;
  targetUserId?: string;
  assigneeUserId?: string;
  reviewerUserId?: string;
  organizationId?: string;
  teamId?: string;
}

export interface MyWorkDashboardGroup {
  actionLabel: string;
  count: number;
  items: MyWorkDashboardItem[];
}

export interface MyWorkDashboard {
  generatedAt: string;
  pendingCount: number;
  blockerCount: number;
  reviewCount: number;
  overdueCount: number;
  groups: MyWorkDashboardGroup[];
  items: MyWorkDashboardItem[];
}

export interface ManagerDashboard {
  generatedAt: string;
  taskCount: number;
  runCount: number;
  repositoryCount: number;
  throughput: {
    tasks: DashboardCount[];
    runs: DashboardCount[];
    activeTasks: number;
    activeRuns: number;
    queuedTasks: number;
    blockedItems: number;
  };
  blocked: DashboardBlockedItem[];
  cost: DashboardCostAttribution;
  unitEconomics: OutcomeUnitEconomics;
  outcomes: DashboardOutcomeQuality;
  pilotRoi: DashboardPilotRoi;
  outcomeBreakdown: DashboardOutcomeBreakdown[];
  repositories: DashboardRepoBreakdown[];
  flowTemplates: DashboardFlowTemplateBreakdown[];
  lifecycle: DashboardLifecycleStage[];
  phaseDurations: DashboardPhaseDuration[];
  factoryMetrics: FactoryMetrics;
  filters: DashboardFilterSet;
}

const taskStatuses = ["draft", "ready", "running", "completed", "failed"];
const runStatuses: WebRunStatus[] = [
  "running",
  "awaiting-approval",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "incomplete",
];
const dashboardWindows = [
  { value: "all", label: "All time" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];
const lifecycleStages = [
  { key: "planning-needed", label: "Planning needed" },
  { key: "awaiting-spec-approval", label: "Awaiting spec approval" },
  { key: "awaiting-tech-design-approval", label: "Awaiting tech design approval" },
  { key: "ready-for-implementation", label: "Ready for implementation" },
  { key: "running", label: "Running" },
  { key: "blocked", label: "Blocked" },
  { key: "draft-pr-created", label: "Draft PR created" },
  { key: "awaiting-human-review", label: "Awaiting human review" },
  { key: "rework-requested", label: "Rework requested" },
  { key: "rework-running", label: "Rework running" },
  { key: "completed", label: "Completed" },
  { key: "stopped", label: "Stopped" },
];
const phaseDurationDefinitions = [
  { key: "planning", label: "Planning" },
  { key: "execution", label: "Execution" },
  { key: "review", label: "Review wait" },
  { key: "rework", label: "Rework" },
] as const;

function countBy<T>(
  items: T[],
  labels: string[],
  read: (item: T) => string | undefined,
  readEvidence: (item: T) => { taskId?: string; runId?: string },
): DashboardCount[] {
  return labels.map((label) => {
    const matched = items.filter((item) => read(item) === label);
    const evidence = matched.map(readEvidence);
    return {
      label,
      count: matched.length,
      taskIds: evidence
        .map((item) => item.taskId)
        .filter((id): id is string => Boolean(id)),
      runIds: evidence
        .map((item) => item.runId)
        .filter((id): id is string => Boolean(id)),
    };
  });
}

function incrementCount(map: Map<string, number>, value: string | undefined): void {
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + 1);
}

function optionList(
  counts: Map<string, number>,
  labelFor: (value: string) => string = (value) => value,
): DashboardFilterOption[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: labelFor(value), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) return left;
  return (left ?? 0) + right;
}

function itemAgeMs(now: Date, timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, now.getTime() - time);
}

export function formatAge(ms: number | undefined): string {
  if (ms === undefined) return "unknown age";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function taskDisplayStatus(task: DashboardWorkItem): string {
  return String(task.displayStatus ?? task.latestRunStatus ?? task.status);
}

function isBlockedTask(task: DashboardWorkItem): boolean {
  return taskDisplayStatus(task) === "blocked" || taskDisplayStatus(task) === "failed";
}

function taskSpecStatus(task: DashboardWorkItem): "draft" | "approved" {
  return task.specStatus ?? (task.status === "draft" ? "draft" : "approved");
}

function taskTechDesignStatus(task: DashboardWorkItem): "draft" | "approved" {
  return task.techDesignStatus ?? (task.status === "draft" ? "draft" : "approved");
}

function addLifecycleTask(
  stages: Map<string, { taskIds: string[]; runIds: string[] }>,
  key: string,
  taskId: string,
): void {
  const stage = stages.get(key);
  if (!stage) return;
  stage.taskIds.push(taskId);
}

function addLifecycleRun(
  stages: Map<string, { taskIds: string[]; runIds: string[] }>,
  key: string,
  runId: string,
): void {
  const stage = stages.get(key);
  if (!stage) return;
  stage.runIds.push(runId);
}

function buildLifecycleStages(
  tasks: DashboardWorkItem[],
  runs: WebRunSummary[],
): DashboardLifecycleStage[] {
  const stages = new Map(
    lifecycleStages.map((stage) => [stage.key, { taskIds: [] as string[], runIds: [] as string[] }]),
  );

  for (const task of tasks) {
    const displayStatus = taskDisplayStatus(task);
    const specStatus = taskSpecStatus(task);
    const techDesignStatus = taskTechDesignStatus(task);
    if (displayStatus === "failed") {
      addLifecycleTask(stages, "stopped", task.id);
    }
    if (isBlockedTask(task)) {
      addLifecycleTask(stages, "blocked", task.id);
    }
    if (displayStatus === "running") {
      addLifecycleTask(stages, "running", task.id);
    }
    if (displayStatus === "completed") {
      addLifecycleTask(stages, "completed", task.id);
    }
    if (specStatus === "draft") {
      addLifecycleTask(stages, "awaiting-spec-approval", task.id);
    } else if (techDesignStatus === "draft") {
      addLifecycleTask(stages, "awaiting-tech-design-approval", task.id);
    } else if (displayStatus === "ready") {
      addLifecycleTask(stages, "ready-for-implementation", task.id);
    } else if (displayStatus === "draft") {
      addLifecycleTask(stages, "planning-needed", task.id);
    }
  }

  for (const run of runs) {
    const isRework = Boolean(run.priorRunId || run.trigger || run.reviewFeedback);
    if (run.status === "running") {
      addLifecycleRun(stages, "running", run.runId);
    }
    if (run.status === "awaiting-approval") {
      addLifecycleRun(stages, "awaiting-human-review", run.runId);
    }
    if (run.status === "blocked") {
      addLifecycleRun(stages, "blocked", run.runId);
    }
    if (run.status === "completed") {
      addLifecycleRun(stages, "completed", run.runId);
    }
    if (isStoppedRun(run)) {
      addLifecycleRun(stages, "stopped", run.runId);
    }
    if (runHasChangeRequest(run)) {
      addLifecycleRun(stages, "draft-pr-created", run.runId);
      addLifecycleRun(stages, "awaiting-human-review", run.runId);
    }
    if (isRework) {
      addLifecycleRun(stages, "rework-requested", run.runId);
      if (run.status === "running" || run.status === "awaiting-approval" || run.status === "blocked") {
        addLifecycleRun(stages, "rework-running", run.runId);
      }
    }
  }

  return lifecycleStages.map((stage) => {
    const evidence = stages.get(stage.key) ?? { taskIds: [], runIds: [] };
    return {
      key: stage.key,
      label: stage.label,
      count: evidence.taskIds.length + evidence.runIds.length,
      taskIds: evidence.taskIds,
      runIds: evidence.runIds,
    };
  });
}

function boundedDurationMs(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) {
    return undefined;
  }
  return end - start;
}

function latestPlanningApprovalTime(task: DashboardWorkItem): number | undefined {
  const approvalTimes = (task.planning?.events ?? [])
    .filter((event) => event.decision === "approve")
    .map((event) => validTimestamp(event.at))
    .filter((time): time is number => time !== undefined);
  return approvalTimes.length > 0 ? Math.max(...approvalTimes) : undefined;
}

function taskPlanningDurationMs(task: DashboardWorkItem): number | undefined {
  const started = validTimestamp(task.createdAt);
  const completed = latestPlanningApprovalTime(task) ??
    (taskSpecStatus(task) === "approved" &&
    taskTechDesignStatus(task) === "approved" &&
    task.status !== "draft"
      ? validTimestamp(task.updatedAt)
      : undefined);
  return boundedDurationMs(started, completed);
}

function isReworkRun(run: WebRunSummary): boolean {
  return Boolean(run.priorRunId || run.trigger || run.reviewFeedback);
}

function runDurationMs(run: WebRunSummary, now: Date): number | undefined {
  const started = validTimestamp(run.startedAt);
  const completed = validTimestamp(run.completedAt) ?? now.getTime();
  return boundedDurationMs(started, completed);
}

function buildPhaseDurations(
  tasks: DashboardWorkItem[],
  runs: WebRunSummary[],
  now: Date,
): DashboardPhaseDuration[] {
  const samples = new Map<
    DashboardPhaseDuration["key"],
    { durationMs: number; taskId?: string; runId?: string }[]
  >();
  for (const definition of phaseDurationDefinitions) {
    samples.set(definition.key, []);
  }
  const addSample = (
    key: DashboardPhaseDuration["key"],
    durationMs: number | undefined,
    evidence: { taskId?: string; runId?: string },
  ) => {
    if (durationMs === undefined) return;
    samples.get(key)?.push({ durationMs, ...evidence });
  };

  for (const task of tasks) {
    addSample("planning", taskPlanningDurationMs(task), { taskId: task.id });
  }
  for (const run of runs) {
    if (isReworkRun(run)) {
      addSample("rework", runDurationMs(run, now), { runId: run.runId });
    } else if (run.status === "awaiting-approval") {
      addSample("review", runDurationMs(run, now), { runId: run.runId });
    } else {
      addSample("execution", runDurationMs(run, now), { runId: run.runId });
    }
  }

  return phaseDurationDefinitions.map((definition) => {
    const phaseSamples = samples.get(definition.key) ?? [];
    const totalMs = phaseSamples.reduce((sum, sample) => sum + sample.durationMs, 0);
    return {
      key: definition.key,
      label: definition.label,
      count: phaseSamples.length,
      ...(phaseSamples.length > 0
        ? {
            totalMs,
            averageMs: totalMs / phaseSamples.length,
          }
        : {}),
      taskIds: phaseSamples
        .map((sample) => sample.taskId)
        .filter((id): id is string => Boolean(id)),
      runIds: phaseSamples
        .map((sample) => sample.runId)
        .filter((id): id is string => Boolean(id)),
    };
  });
}

function notificationActionLabel(type: NotificationType): string {
  switch (type) {
    case "review-spec":
      return "Review spec";
    case "review-tech-design":
      return "Review technical design";
    case "review-pr":
      return "Review draft PR";
    case "resolve-blocker":
      return "Resolve blocker";
    case "review-rework":
      return "Review rework route";
    case "review-memory":
      return "Review memory proposal";
  }
}

function reviewGateCounts(runs: WebRunSummary[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.status === "completed" && run.completedStages.some((stage) => stage.includes("review"))) {
      passed += 1;
    }
    if (run.status === "failed" && (run.currentStage ?? "").includes("review")) {
      failed += 1;
    }
  }
  return { passed, failed };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function validTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function runHasChangeRequest(run: WebRunSummary): boolean {
  return Boolean(run.changeRequestUrl || run.prUrl || run.prNumber);
}

interface ReviewableChangeRequestGroup {
  key: string;
  runs: WebRunSummary[];
}

function runChangeRequestKey(run: WebRunSummary): string | undefined {
  return changeRequestIdentity(run);
}

function groupReviewableRuns(runs: WebRunSummary[]): ReviewableChangeRequestGroup[] {
  const canonicalKeysByLocalIdentity = new Map<string, Set<string>>();
  for (const run of runs) {
    const canonical = canonicalChangeRequestTarget(
      run.changeRequestUrl ?? run.prUrl,
    );
    const localIdentity = localChangeRequestIdentity(run);
    if (!canonical || !localIdentity) continue;
    const keys = canonicalKeysByLocalIdentity.get(localIdentity) ?? new Set<string>();
    keys.add(canonical.key);
    canonicalKeysByLocalIdentity.set(localIdentity, keys);
  }
  const groups = new Map<string, WebRunSummary[]>();
  for (const run of runs) {
    let key = runChangeRequestKey(run);
    if (!(run.changeRequestUrl ?? run.prUrl)) {
      const localIdentity = localChangeRequestIdentity(run);
      const canonicalKeys = localIdentity
        ? canonicalKeysByLocalIdentity.get(localIdentity)
        : undefined;
      if (canonicalKeys?.size === 1) {
        key = canonicalKeys.values().next().value;
      }
    }
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, groupedRuns]) => ({
    key,
    runs: groupedRuns,
  }));
}

function runHasKnownMergeStatus(run: WebRunSummary): boolean {
  const state = run.changeRequestStatus?.state.trim().toLowerCase();
  return Boolean(
    run.changeRequestStatus?.provider === "github" &&
      state &&
      state !== "unknown",
  );
}

function groupHasKnownMergeStatus(group: ReviewableChangeRequestGroup): boolean {
  return group.runs.some(runHasKnownMergeStatus);
}

function groupIsMerged(group: ReviewableChangeRequestGroup): boolean {
  return group.runs.some(
    (run) => runHasKnownMergeStatus(run) && run.changeRequestStatus?.merged === true,
  );
}

function groupCycleTimeMs(group: ReviewableChangeRequestGroup): number | undefined {
  const starts = group.runs
    .map((run) => validTimestamp(run.startedAt))
    .filter((value): value is number => value !== undefined);
  const completions = group.runs
    .map((run) => validTimestamp(run.completedAt))
    .filter((value): value is number => value !== undefined);
  if (starts.length === 0 || completions.length === 0) return undefined;
  const started = Math.min(...starts);
  const completed = Math.max(...completions);
  return completed >= started ? completed - started : undefined;
}

function average(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

function runHasEvidenceSignal(run: WebRunSummary): boolean {
  const stageEvidence = run.completedStages.length > 0;
  const reviewOrVerification = run.completedStages.some((stage) =>
    /review|verify|verification|test|gate/i.test(stage),
  );
  return Boolean(
    stageEvidence &&
      (reviewOrVerification ||
        run.contextUsage ||
        run.runtimeUsage ||
        run.budgetSummary),
  );
}

function buildPilotRoi(runs: WebRunSummary[]): DashboardPilotRoi {
  const reviewableGroups = groupReviewableRuns(runs);
  const reviewableRuns = reviewableGroups.flatMap((group) => group.runs);
  const acceptedGroups = reviewableGroups.filter((group) =>
    group.runs.some((run) => run.status === "completed"),
  );
  const acceptedRuns = acceptedGroups.flatMap((group) =>
    group.runs.filter((run) => run.status === "completed"),
  );
  const evidenceCompleteGroups = reviewableGroups.filter((group) =>
    group.runs.some(runHasEvidenceSignal),
  );
  const evidenceCompleteRuns = evidenceCompleteGroups.flatMap((group) =>
    group.runs.filter(runHasEvidenceSignal),
  );
  const mergeStatusKnownGroups = reviewableGroups.filter(groupHasKnownMergeStatus);
  const mergedGroups = mergeStatusKnownGroups.filter(groupIsMerged);
  const mergedRunIds = mergedGroups.flatMap((group) =>
    group.runs.map((run) => run.runId),
  );
  const mergeStatusKnownRunIds = mergeStatusKnownGroups.flatMap((group) =>
    group.runs.filter(runHasKnownMergeStatus).map((run) => run.runId),
  );
  const recoverableFailureIds = new Set(
    runs
      .filter(
        (run) =>
          run.status === "blocked" ||
          run.status === "interrupted" ||
          isReworkRun(run),
      )
      .map((run) => run.runId),
  );
  const flowCounts = new Map<string, number>();
  for (const run of runs) {
    if (run.flowName) {
      flowCounts.set(run.flowName, (flowCounts.get(run.flowName) ?? 0) + 1);
    }
  }
  const cycleTimes = reviewableGroups
    .map(groupCycleTimeMs)
    .filter((value): value is number => value !== undefined);
  return {
    reviewablePrsCreated: reviewableGroups.length,
    acceptedPrs: acceptedGroups.length,
    acceptanceRate: ratio(acceptedGroups.length, reviewableGroups.length),
    mergedPrs: mergedGroups.length,
    mergeStatusKnownPrs: mergeStatusKnownGroups.length,
    ...(mergeStatusKnownGroups.length > 0
      ? { mergeRate: ratio(mergedGroups.length, mergeStatusKnownGroups.length) }
      : {}),
    mergeStatusCoverage: ratio(
      mergeStatusKnownGroups.length,
      reviewableGroups.length,
    ),
    ...(average(cycleTimes) !== undefined
      ? { averageCycleTimeMs: average(cycleTimes) }
      : {}),
    recoverableFailures: recoverableFailureIds.size,
    evidenceCompletePrs: evidenceCompleteGroups.length,
    evidenceCompletenessRate: ratio(
      evidenceCompleteGroups.length,
      reviewableGroups.length,
    ),
    repeatedFlowCount: [...flowCounts.values()].filter((count) => count >= 3).length,
    estimatedCleanupMinutesAvoided: acceptedGroups.length * 45,
    reviewableRunIds: reviewableRuns.map((run) => run.runId),
    acceptedRunIds: acceptedRuns.map((run) => run.runId),
    mergedRunIds,
    mergeStatusKnownRunIds,
    recoverableFailureRunIds: [...recoverableFailureIds],
    evidenceCompleteRunIds: evidenceCompleteRuns.map((run) => run.runId),
  };
}

function isStoppedRun(run: WebRunSummary): boolean {
  return run.status === "failed" ||
    run.status === "interrupted" ||
    run.status === "cancelled" ||
    run.status === "incomplete";
}

function buildOutcomeBreakdown(
  tasks: DashboardWorkItem[],
  runs: WebRunSummary[],
): DashboardOutcomeBreakdown[] {
  const reviewableGroups = groupReviewableRuns(runs);
  const reviewableRuns = reviewableGroups.flatMap((group) => group.runs);
  const acceptedGroups = reviewableGroups.filter((group) =>
    group.runs.some((run) => run.status === "completed"),
  );
  const acceptedRuns = acceptedGroups.flatMap((group) =>
    group.runs.filter((run) => run.status === "completed"),
  );
  const mergeStatusKnownGroups = reviewableGroups.filter(groupHasKnownMergeStatus);
  const mergedGroups = mergeStatusKnownGroups.filter(groupIsMerged);
  const mergeTracking =
    mergeStatusKnownGroups.length === 0
      ? "not-tracked"
      : mergeStatusKnownGroups.length === reviewableGroups.length
        ? "tracked"
        : "partial";
  const mergeDescription =
    reviewableGroups.length === 0
      ? "No reviewable PRs are available for live merge-status lookup."
      : mergeStatusKnownGroups.length === 0
        ? `Live merge status is unavailable for all ${reviewableGroups.length} reviewable PRs.`
        : `Live merge status is known for ${mergeStatusKnownGroups.length}/${reviewableGroups.length} reviewable PRs; ` +
          `merge rate uses only status-known PRs (${mergedGroups.length}/${mergeStatusKnownGroups.length}).`;
  const stoppedTasks = tasks.filter((task) => taskDisplayStatus(task) === "failed");
  const stoppedRuns = runs.filter(isStoppedRun);
  const reworkRuns = runs.filter(isReworkRun);

  return [
    {
      key: "reviewable-prs",
      label: "Reviewable PRs",
      tracking: "tracked",
      count: reviewableGroups.length,
      description:
        "Deduplicated change requests linked from runs with a recorded URL or PR number.",
      taskIds: [],
      runIds: reviewableRuns.map((run) => run.runId),
    },
    {
      key: "accepted-prs",
      label: "Accepted PRs",
      tracking: "tracked",
      count: acceptedGroups.length,
      description:
        "PRs with at least one completed linked run; this is an acceptance signal, not merge state.",
      taskIds: [],
      runIds: acceptedRuns.map((run) => run.runId),
    },
    {
      key: "merged-prs",
      label: "Merged PRs",
      tracking: mergeTracking,
      count: mergedGroups.length,
      description: mergeDescription,
      taskIds: [],
      runIds: mergedGroups.flatMap((group) =>
        group.runs.map((run) => run.runId),
      ),
    },
    {
      key: "stopped-work",
      label: "Stopped work",
      tracking: "tracked",
      count: stoppedTasks.length + stoppedRuns.length,
      description: "Failed tasks and failed, interrupted, cancelled, or incomplete runs.",
      taskIds: stoppedTasks.map((task) => task.id),
      runIds: stoppedRuns.map((run) => run.runId),
    },
    {
      key: "follow-up-rework",
      label: "Follow-up rework",
      tracking: "tracked",
      count: reworkRuns.length,
      description: "Runs linked to a prior run, trigger, or review feedback.",
      taskIds: [],
      runIds: reworkRuns.map((run) => run.runId),
    },
  ];
}

function flowTemplateKey(run: WebRunSummary): string {
  return run.flowPath ?? run.flowName ?? "unknown";
}

function flowTemplateName(run: WebRunSummary): string {
  return run.flowName ?? run.flowPath ?? "Unknown flow";
}

function buildFlowTemplateBreakdowns(runs: WebRunSummary[]): DashboardFlowTemplateBreakdown[] {
  const byFlow = new Map<string, WebRunSummary[]>();
  for (const run of runs) {
    const key = flowTemplateKey(run);
    const group = byFlow.get(key) ?? [];
    group.push(run);
    byFlow.set(key, group);
  }

  return [...byFlow.entries()]
    .map(([flowKey, flowRuns]) => {
      const first = flowRuns[0];
      const reviewableGroups = groupReviewableRuns(flowRuns);
      const reviewableRuns = reviewableGroups.flatMap((group) => group.runs);
      const acceptedGroups = reviewableGroups.filter((group) =>
        group.runs.some((run) => run.status === "completed"),
      );
      const acceptedRuns = acceptedGroups.flatMap((group) =>
        group.runs.filter((run) => run.status === "completed"),
      );
      const evidenceCompleteGroups = reviewableGroups.filter((group) =>
        group.runs.some(runHasEvidenceSignal),
      );
      const evidenceCompleteRuns = evidenceCompleteGroups.flatMap((group) =>
        group.runs.filter(runHasEvidenceSignal),
      );
      const cycleTimes = reviewableGroups
        .map(groupCycleTimeMs)
        .filter((value): value is number => value !== undefined);
      return {
        flowKey,
        flowName: first ? flowTemplateName(first) : flowKey,
        ...(first?.flowPath ? { flowPath: first.flowPath } : {}),
        runCount: flowRuns.length,
        completedRuns: flowRuns.filter((run) => run.status === "completed").length,
        blockedRuns: flowRuns.filter((run) => run.status === "blocked").length,
        failedRuns: flowRuns.filter((run) => run.status === "failed").length,
        runIds: flowRuns.map((run) => run.runId),
        completedRunIds: flowRuns
          .filter((run) => run.status === "completed")
          .map((run) => run.runId),
        blockedRunIds: flowRuns
          .filter((run) => run.status === "blocked")
          .map((run) => run.runId),
        failedRunIds: flowRuns
          .filter((run) => run.status === "failed")
          .map((run) => run.runId),
        reviewablePrsCreated: reviewableGroups.length,
        acceptedPrs: acceptedGroups.length,
        acceptanceRate: ratio(acceptedGroups.length, reviewableGroups.length),
        ...(average(cycleTimes) !== undefined
          ? { averageCycleTimeMs: average(cycleTimes) }
          : {}),
        evidenceCompletePrs: evidenceCompleteGroups.length,
        evidenceCompletenessRate: ratio(
          evidenceCompleteGroups.length,
          reviewableGroups.length,
        ),
        reviewableRunIds: reviewableRuns.map((run) => run.runId),
        acceptedRunIds: acceptedRuns.map((run) => run.runId),
        evidenceCompleteRunIds: evidenceCompleteRuns.map((run) => run.runId),
      };
    })
    .sort((left, right) =>
      right.runCount - left.runCount ||
      right.reviewablePrsCreated - left.reviewablePrsCreated ||
      left.flowName.localeCompare(right.flowName),
    );
}

function taskFlowKey(task: DashboardWorkItem): string {
  return task.flowPath || task.template?.sourceFlowPath || task.flowId || "unknown";
}

function taskTimestampCandidates(task: DashboardWorkItem): string[] {
  return [task.updatedAt, task.createdAt].filter((value): value is string => Boolean(value));
}

function runTimestampCandidates(run: WebRunSummary): string[] {
  return [run.completedAt, run.startedAt].filter((value): value is string => Boolean(value));
}

function ownerKey(record: { ownerId?: string }): string {
  return record.ownerId ?? "unassigned";
}

function ownerLabel(value: string): string {
  return value === "unassigned" ? "Unassigned" : value;
}

function normalizedWindow(value: string | undefined): string | undefined {
  return value === "24h" || value === "7d" || value === "30d" ? value : undefined;
}

function windowStart(now: Date, window: string | undefined): number | undefined {
  switch (normalizedWindow(window)) {
    case "24h":
      return now.getTime() - 24 * 60 * 60 * 1000;
    case "7d":
      return now.getTime() - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now.getTime() - 30 * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

function normalizedDateBoundary(value: string | undefined, boundary: "start" | "end"): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const time = Date.parse(
    dateOnly
      ? `${trimmed}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
      : trimmed,
  );
  return Number.isFinite(time) ? time : undefined;
}

function matchesDateRange(
  timestamps: string[],
  filters: DashboardFilterSelection | undefined,
  now: Date,
): boolean {
  const selectedWindowStart = windowStart(now, filters?.window);
  const start = Math.max(
    normalizedDateBoundary(filters?.start, "start") ?? Number.NEGATIVE_INFINITY,
    selectedWindowStart ?? Number.NEGATIVE_INFINITY,
  );
  const end = normalizedDateBoundary(filters?.end, "end");
  if (start === Number.NEGATIVE_INFINITY && end === undefined) return true;
  return timestamps.some((timestamp) => {
    const time = Date.parse(timestamp);
    return Number.isFinite(time) &&
      time >= start &&
      (end === undefined || time <= end);
  });
}

function selectedFilters(input: DashboardFilterSelection | undefined): DashboardFilterSelection {
  const selected: DashboardFilterSelection = {};
  for (const key of ["repo", "flow", "status", "priority", "owner", "start", "end"] as const) {
    const value = input?.[key]?.trim();
    if (value) selected[key] = value;
  }
  const window = normalizedWindow(input?.window?.trim());
  if (window) {
    selected.window = window;
  }
  return selected;
}

function buildDashboardFilters(input: {
  tasks: DashboardWorkItem[];
  runs: WebRunSummary[];
  repositories: WebRepository[];
  selected: DashboardFilterSelection;
  now: Date;
}): DashboardFilterSet {
  const repos = new Map<string, number>();
  const repoLabels = new Map<string, string>();
  for (const repository of input.repositories) {
    repoLabels.set(repository.id, repository.name);
    repos.set(repository.id, repos.get(repository.id) ?? 0);
  }
  const flows = new Map<string, number>();
  const flowLabels = new Map<string, string>();
  const statuses = new Map<string, number>();
  const priorities = new Map<string, number>();
  const owners = new Map<string, number>();
  const allRecords = [
    ...input.tasks.map((task) => ({ timestamps: taskTimestampCandidates(task) })),
    ...input.runs.map((run) => ({ timestamps: runTimestampCandidates(run) })),
  ];

  for (const task of input.tasks) {
    const repo = repoKey(task);
    incrementCount(repos, repo);
    repoLabels.set(repo, repoName(task));
    const flow = taskFlowKey(task);
    incrementCount(flows, flow);
    flowLabels.set(flow, task.template?.templateId ?? task.flowPath ?? task.flowId ?? flow);
    incrementCount(statuses, taskDisplayStatus(task));
    incrementCount(priorities, task.priority ?? "P2");
    incrementCount(owners, ownerKey(task));
  }
  for (const run of input.runs) {
    const repo = repoKey(run);
    incrementCount(repos, repo);
    repoLabels.set(repo, repoName(run));
    const flow = flowTemplateKey(run);
    incrementCount(flows, flow);
    flowLabels.set(flow, flowTemplateName(run));
    incrementCount(statuses, run.status);
    incrementCount(owners, ownerKey(run));
  }

  return {
    selected: input.selected,
    repositories: optionList(repos, (value) => repoLabels.get(value) ?? value),
    flows: optionList(flows, (value) => flowLabels.get(value) ?? value),
    statuses: optionList(statuses),
    priorities: optionList(priorities),
    owners: optionList(owners, ownerLabel),
    windows: dashboardWindows.map((window) => ({
      value: window.value,
      label: window.label,
      count: window.value === "all"
        ? allRecords.length
        : allRecords.filter((record) =>
            matchesDateRange(record.timestamps, { window: window.value }, input.now),
          ).length,
    })),
    activeCount: Object.keys(input.selected).length,
  };
}

function filteredDashboardInput(input: {
  tasks: DashboardWorkItem[];
  runs: WebRunSummary[];
  filters?: DashboardFilterSelection;
  now: Date;
}): { tasks: DashboardWorkItem[]; runs: WebRunSummary[]; selected: DashboardFilterSelection } {
  const selected = selectedFilters(input.filters);
  const priorityByWorkItem = new Map<string, string>();
  for (const task of input.tasks) {
    priorityByWorkItem.set(
      `${repoKey(task)}\u0000${task.id}`,
      task.priority ?? "P2",
    );
  }
  const tasks = input.tasks.filter((task) =>
    (!selected.repo || repoKey(task) === selected.repo) &&
    (!selected.flow || taskFlowKey(task) === selected.flow) &&
    (!selected.status || taskDisplayStatus(task) === selected.status) &&
    (!selected.priority || (task.priority ?? "P2") === selected.priority) &&
    (!selected.owner || ownerKey(task) === selected.owner) &&
    matchesDateRange(taskTimestampCandidates(task), selected, input.now),
  );
  const runs = input.runs.filter((run) => {
    const workItemId = run.workItemId ?? run.taskId;
    const runPriority = workItemId
      ? priorityByWorkItem.get(`${repoKey(run)}\u0000${workItemId}`)
      : undefined;
    return (!selected.repo || repoKey(run) === selected.repo) &&
      (!selected.flow || flowTemplateKey(run) === selected.flow) &&
      (!selected.status || run.status === selected.status) &&
      (!selected.priority || runPriority === selected.priority) &&
      (!selected.owner || ownerKey(run) === selected.owner) &&
      matchesDateRange(runTimestampCandidates(run), selected, input.now);
  });
  return { tasks, runs, selected };
}

function repoKey(record: { repoId?: string; repoName?: string; repoPath?: string }): string {
  return record.repoId ?? record.repoName ?? record.repoPath ?? "default";
}

function repoName(record: { repoId?: string; repoName?: string; repoPath?: string }): string {
  return record.repoName ?? record.repoId ?? record.repoPath ?? "Default repository";
}

export interface ManagerDashboardInput {
  tasks: DashboardWorkItem[];
  runs: WebRunSummary[];
  repositories: WebRepository[];
  now?: Date;
  filters?: DashboardFilterSelection;
}

function managerDashboardScope(input: ManagerDashboardInput) {
  const now = input.now ?? new Date();
  const repositories = input.repositories.filter(
    (repository) => repository.synthetic !== true,
  );
  const syntheticRepoIds = new Set(
    input.repositories
      .filter((repository) => repository.synthetic === true)
      .map((repository) => repository.id),
  );
  const syntheticRepoPaths = new Set(
    input.repositories
      .filter((repository) => repository.synthetic === true)
      .map((repository) => repository.path),
  );
  const isSyntheticRecord = (record: {
    repoId?: string;
    repoPath?: string;
    repoSynthetic?: boolean;
  }) =>
    record.repoSynthetic === true ||
    (record.repoId !== undefined && syntheticRepoIds.has(record.repoId)) ||
    (record.repoPath !== undefined && syntheticRepoPaths.has(record.repoPath));
  const metricTasks = input.tasks.filter((task) => !isSyntheticRecord(task));
  const metricRuns = input.runs.filter((run) => !isSyntheticRecord(run));
  const filterState = filteredDashboardInput({
    tasks: metricTasks,
    runs: metricRuns,
    filters: input.filters,
    now,
  });
  return {
    now,
    repositories,
    metricTasks,
    metricRuns,
    filterState,
  };
}

export function filterManagerDashboardRuns(
  input: ManagerDashboardInput,
): WebRunSummary[] {
  return managerDashboardScope(input).filterState.runs;
}

function metricCoverage(
  observed: number,
  total: number,
  note?: string,
): FactoryMetricCoverage {
  return {
    status: total === 0 ? "unknown" : observed === total ? "tracked" : observed > 0 ? "partial" : "unknown",
    observed,
    total,
    ...(note ? { note } : {}),
  };
}

export function buildFactoryMetrics(
  tasks: Array<{ status: string }>,
  runs: WebRunSummary[],
): FactoryMetrics {
  const reviewableGroups = groupReviewableRuns(runs);
  const mergeStatusKnownGroups = reviewableGroups.filter(groupHasKnownMergeStatus);
  const mergedGroups = mergeStatusKnownGroups.filter(groupIsMerged);
  const runStarted = runs.filter((run) => run.startedAt).length;
  const reviewRequested = new Set(
    runs
      .filter((run) =>
        run.status === "awaiting-approval" ||
        run.reviewFeedback ||
        run.completedStages.some((stage) => /review|judge/i.test(stage)),
      )
      .map((run) => run.changeRequestUrl ?? run.prUrl ?? `run:${run.runId}`),
  ).size;
  const eligible = tasks.filter((task) => task.status !== "draft").length;
  const queued = tasks.filter((task) => task.status === "ready").length;
  const completedChanges = runs.filter((run) => run.status === "completed");
  const approvalEvents = runs.reduce(
    (total, run) => total + (run.factorySignals?.humanApprovalEvents ?? 0),
    0,
  );
  const approvalWaitMs = runs.reduce(
    (total, run) => total + (run.factorySignals?.humanApprovalWaitMs ?? 0),
    0,
  );
  const knownApprovalWaitRuns = runs.filter(
    (run) => run.factorySignals?.humanApprovalWaitMs !== undefined,
  ).length;
  const runtimeCostUsd = runs.reduce((total, run) =>
    total + (run.runtimeUsage?.actualCostUsd ?? 0) + (run.runtimeUsage?.estimatedCostUsd ?? 0), 0);
  const knownCostRuns = runs.filter(
    (run) => run.runtimeUsage && run.runtimeUsage.unknownAttempts === 0 &&
      (run.runtimeUsage.actualCostUsd !== undefined || run.runtimeUsage.estimatedCostUsd !== undefined),
  ).length;
  const mergedRuns = mergedGroups.flatMap((group) => group.runs);
  const mergedCostComplete = mergedRuns.length > 0 && mergedRuns.every(
    (run) => run.runtimeUsage && run.runtimeUsage.unknownAttempts === 0 &&
      (run.runtimeUsage.actualCostUsd !== undefined || run.runtimeUsage.estimatedCostUsd !== undefined),
  );
  const mergedRuntimeCostUsd = mergedRuns.reduce(
    (total, run) => total + (run.runtimeUsage?.actualCostUsd ?? 0) + (run.runtimeUsage?.estimatedCostUsd ?? 0),
    0,
  );
  const contextTokens = runs.reduce(
    (total, run) => total + (run.contextUsage?.approxTokens ?? 0),
    0,
  );
  const agentAttempts = runs.reduce(
    (total, run) => total + (run.factorySignals?.agentAttempts ?? 0),
    0,
  );
  const judgeAttempts = runs.reduce(
    (total, run) => total + (run.factorySignals?.judgeAttempts ?? 0),
    0,
  );
  const ciRuns = runs.reduce(
    (total, run) => total + (run.factorySignals?.ciRuns ?? 0),
    0,
  );
  const humanEscalations = runs.filter((run) =>
    /human|operator|approval|escalat/i.test(run.blocker?.reason ?? run.blocker?.message ?? ""),
  ).length;
  const postPublishReworkRuns = runs.filter(
    (run) => Boolean(run.priorRunId && (run.changeRequestUrl || run.prUrl)),
  ).length;
  return {
    funnel: {
      candidate: tasks.length,
      eligible,
      queued,
      runStarted,
      prsCreated: reviewableGroups.length,
      reviewRequested,
      merged: mergedGroups.length,
      ...(tasks.length > 0
        ? { candidateToEligibleRate: ratio(eligible, tasks.length) }
        : {}),
      ...(eligible > 0
        ? { eligibleToPrRate: ratio(reviewableGroups.length, eligible) }
        : {}),
      ...(mergeStatusKnownGroups.length > 0
        ? { prToMergeRate: ratio(mergedGroups.length, mergeStatusKnownGroups.length) }
        : {}),
    },
    humanAttention: {
      approvalEvents,
      ...(completedChanges.length > 0
        ? { humanTouchRate: ratio(runs.filter((run) => (run.factorySignals?.humanApprovalEvents ?? 0) > 0).length, completedChanges.length) }
        : {}),
      ...(approvalWaitMs > 0 ? { approvalWaitMs } : {}),
      approvalWaitCoverage: metricCoverage(
        knownApprovalWaitRuns,
        runs.length,
        "Approval timing is measured only from persisted approval.requested/resolved events.",
      ),
    },
    latency: {
      coverage: {
        candidateToQueued: metricCoverage(0, tasks.length, "Queue timestamps are not persisted for legacy task records."),
        queuedToRunStart: metricCoverage(0, queued, "Queue admission timestamps are unavailable for legacy records."),
        runStartToPr: metricCoverage(0, reviewableGroups.length, "PR creation timestamps are not persisted in run summaries."),
        prToMerge: metricCoverage(0, mergeStatusKnownGroups.length, "Merge timestamps require provider history."),
        candidateToMerge: metricCoverage(0, mergedGroups.length, "Candidate/merge timestamps are unavailable."),
        blocked: metricCoverage(0, runs.filter((run) => run.status === "blocked").length, "Blocked interval boundaries are not persisted as a complete interval."),
      },
    },
    rework: {
      agentAttempts,
      judgeAttempts,
      judgeReworkLoops: runs.reduce(
        (total, run) => total + Math.max(0, (run.factorySignals?.judgeAttempts ?? 0) - 1),
        0,
      ),
      ciRuns,
      humanEscalations,
      postPublishReworkRuns,
    },
    cost: {
      ...(knownCostRuns > 0 ? { runtimeCostUsd } : {}),
      ...(mergedCostComplete
        ? { runtimeCostPerMergedPr: mergedRuntimeCostUsd / mergedGroups.length }
        : {}),
      ...(contextTokens > 0 ? { contextTokens } : {}),
      coverage: metricCoverage(
        knownCostRuns,
        runs.length,
        "Missing provider cost is unknown and is never treated as zero.",
      ),
    },
    coverage: {
      candidates: metricCoverage(tasks.length, tasks.length),
      mergeStatus: metricCoverage(mergeStatusKnownGroups.length, reviewableGroups.length),
      cost: metricCoverage(knownCostRuns, runs.length),
    },
  };
}

export function buildManagerDashboard(
  input: ManagerDashboardInput,
): ManagerDashboard {
  const {
    now,
    repositories,
    metricTasks,
    metricRuns,
    filterState,
  } = managerDashboardScope(input);
  const tasks = filterState.tasks;
  const runs = filterState.runs;
  const filters = buildDashboardFilters({
    tasks: metricTasks,
    runs: metricRuns,
    repositories,
    selected: filterState.selected,
    now,
  });
  const repoBreakdowns = new Map<string, DashboardRepoBreakdown>();
  for (const repository of repositories) {
    repoBreakdowns.set(repository.id, {
      repoId: repository.id,
      repoName: repository.name,
      taskCount: 0,
      runCount: 0,
      blockedCount: 0,
      completedRuns: 0,
      taskIds: [],
      runIds: [],
      blockedTaskIds: [],
      blockedRunIds: [],
      completedRunIds: [],
    });
  }

  const ensureRepo = (record: { repoId?: string; repoName?: string; repoPath?: string }) => {
    const key = repoKey(record);
    let breakdown = repoBreakdowns.get(key);
    if (!breakdown) {
      breakdown = {
        repoId: key,
        repoName: repoName(record),
        taskCount: 0,
        runCount: 0,
        blockedCount: 0,
        completedRuns: 0,
        taskIds: [],
        runIds: [],
        blockedTaskIds: [],
        blockedRunIds: [],
        completedRunIds: [],
      };
      repoBreakdowns.set(key, breakdown);
    }
    return breakdown;
  };

  for (const task of tasks) {
    const breakdown = ensureRepo(task);
    breakdown.taskCount += 1;
    breakdown.taskIds.push(task.id);
    if (isBlockedTask(task)) {
      breakdown.blockedCount += 1;
      breakdown.blockedTaskIds.push(task.id);
    }
  }

  const blocked: DashboardBlockedItem[] = [];
  for (const task of tasks.filter(isBlockedTask)) {
    const ageMs = itemAgeMs(now, task.updatedAt ?? task.createdAt);
    blocked.push({
      id: task.id,
      title: task.title,
      kind: "task",
      repoId: task.repoId,
      repoName: task.repoName,
      status: taskDisplayStatus(task),
      ageMs,
      ageLabel: formatAge(ageMs),
      ownerId: task.ownerId,
      currentStage: task.currentStage,
    });
  }

  const cost: DashboardCostAttribution = {
    knownRuntimeAttempts: 0,
    unknownRuntimeAttempts: 0,
    runtimeRunIds: [],
    contextRunIds: [],
    costRunIds: [],
  };
  for (const run of runs) {
    const breakdown = ensureRepo(run);
    breakdown.runCount += 1;
    breakdown.runIds.push(run.runId);
    if (run.status === "blocked") {
      breakdown.blockedCount += 1;
      breakdown.blockedRunIds.push(run.runId);
    }
    if (run.status === "completed") {
      breakdown.completedRuns += 1;
      breakdown.completedRunIds.push(run.runId);
    }
    const runtimeTokens = positiveNumber(run.runtimeUsage?.totalTokens);
    const contextTokens = positiveNumber(run.contextUsage?.approxTokens);
    const estimatedCost = positiveNumber(run.runtimeUsage?.estimatedCostUsd);
    breakdown.runtimeTokens = addOptional(breakdown.runtimeTokens, runtimeTokens);
    breakdown.contextTokens = addOptional(breakdown.contextTokens, contextTokens);
    breakdown.estimatedCostUsd = addOptional(breakdown.estimatedCostUsd, estimatedCost);
    cost.runtimeTokens = addOptional(cost.runtimeTokens, runtimeTokens);
    cost.contextTokens = addOptional(cost.contextTokens, contextTokens);
    cost.estimatedCostUsd = addOptional(cost.estimatedCostUsd, estimatedCost);
    if (runtimeTokens !== undefined) cost.runtimeRunIds.push(run.runId);
    if (contextTokens !== undefined) cost.contextRunIds.push(run.runId);
    if (estimatedCost !== undefined) cost.costRunIds.push(run.runId);
    cost.knownRuntimeAttempts += run.runtimeUsage?.knownAttempts ?? 0;
    cost.unknownRuntimeAttempts += run.runtimeUsage?.unknownAttempts ?? 0;
    if (run.status === "blocked") {
      const ageMs = itemAgeMs(now, run.startedAt);
      blocked.push({
        id: run.runId,
        title: run.flowName ?? run.runId,
        kind: "run",
        repoId: run.repoId,
        repoName: run.repoName,
        status: run.status,
        ageMs,
        ageLabel: formatAge(ageMs),
        ownerId: run.ownerId,
        currentStage: run.currentStage,
        blockerReason: run.blocker?.reason ?? run.blocker?.message,
      });
    }
  }

  blocked.sort((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1));
  const completedRuns = runs.filter((run) => run.status === "completed").length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;
  const blockedRuns = runs.filter((run) => run.status === "blocked").length;
  const reworkRuns = runs.filter(isReworkRun).length;
  const gates = reviewGateCounts(runs);
  const pilotRoi = buildPilotRoi(runs);
  const outcomeBreakdown = buildOutcomeBreakdown(tasks, runs);
  const flowTemplates = buildFlowTemplateBreakdowns(runs);
  const lifecycle = buildLifecycleStages(tasks, runs);
  const phaseDurations = buildPhaseDurations(tasks, runs, now);
  const factoryMetrics = buildFactoryMetrics(tasks, runs);
  const completedRunIds = runs
    .filter((run) => run.status === "completed")
    .map((run) => run.runId);
  const failedRunIds = runs
    .filter((run) => run.status === "failed")
    .map((run) => run.runId);
  const blockedRunIds = runs
    .filter((run) => run.status === "blocked")
    .map((run) => run.runId);
  const reworkRunIds = runs
    .filter(isReworkRun)
    .map((run) => run.runId);
  const reviewGatePassedRunIds = runs
    .filter((run) => run.status === "completed" && run.completedStages.some((stage) => stage.includes("review")))
    .map((run) => run.runId);
  const reviewGateFailedRunIds = runs
    .filter((run) => run.status === "failed" && (run.currentStage ?? "").includes("review"))
    .map((run) => run.runId);

  return {
    generatedAt: now.toISOString(),
    taskCount: tasks.length,
    runCount: runs.length,
    repositoryCount: repositories.length,
    throughput: {
      tasks: countBy(tasks, taskStatuses, taskDisplayStatus, (task) => ({ taskId: task.id })),
      runs: countBy(runs, runStatuses, (run) => run.status, (run) => ({ runId: run.runId })),
      activeTasks: tasks.filter((task) => taskDisplayStatus(task) === "running").length,
      activeRuns: runs.filter((run) => run.status === "running").length,
      queuedTasks: tasks.filter((task) => taskDisplayStatus(task) === "ready").length,
      blockedItems: blocked.length,
    },
    blocked,
    cost,
    unitEconomics: buildOutcomeUnitEconomics(runs),
    outcomes: {
      completedRuns,
      failedRuns,
      blockedRuns,
      reworkRuns,
      reviewGatesPassed: gates.passed,
      reviewGatesFailed: gates.failed,
      completionRate: ratio(completedRuns, runs.length),
      reworkRatio: ratio(reworkRuns, runs.length),
      reviewGatePassRate: ratio(gates.passed, gates.passed + gates.failed),
      completedRunIds,
      failedRunIds,
      blockedRunIds,
      reworkRunIds,
      reviewGatePassedRunIds,
      reviewGateFailedRunIds,
    },
    pilotRoi,
    outcomeBreakdown,
    repositories: [...repoBreakdowns.values()].sort((left, right) =>
      right.blockedCount - left.blockedCount ||
      right.runCount - left.runCount ||
      left.repoName.localeCompare(right.repoName),
    ),
    flowTemplates,
    lifecycle,
    phaseDurations,
    factoryMetrics,
    filters,
  };
}

export function buildMyWorkDashboard(input: {
  notifications: Array<NotificationRecord & { repoId?: string; repoName?: string }>;
  now?: Date;
  overdueAfterMs?: number;
}): MyWorkDashboard {
  const now = input.now ?? new Date();
  const overdueAfterMs = input.overdueAfterMs ?? 24 * 60 * 60 * 1000;
  const items = input.notifications
    .filter((notification) => notification.status === "pending")
    .map((notification) => {
      const ageMs = itemAgeMs(now, notification.createdAt ?? notification.updatedAt);
      const actionLabel = notification.type === "review-pr"
        ? notification.title || notificationActionLabel(notification.type)
        : notificationActionLabel(notification.type);
      const overdue = ageMs !== undefined && ageMs >= overdueAfterMs;
      return {
        id: notification.id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        ...(notification.body ? { body: notification.body } : {}),
        link: notification.link,
        ...(notification.taskId ? { taskId: notification.taskId } : {}),
        ...(notification.runId ? { runId: notification.runId } : {}),
        ...(notification.repoId ? { repoId: notification.repoId } : {}),
        ...(notification.repoName ? { repoName: notification.repoName } : {}),
        status: notification.status,
        actionLabel,
        ageMs,
        ageLabel: formatAge(ageMs),
        overdue,
        ...(notification.targetUserId ? { targetUserId: notification.targetUserId } : {}),
        ...(notification.assigneeUserId ? { assigneeUserId: notification.assigneeUserId } : {}),
        ...(notification.reviewerUserId ? { reviewerUserId: notification.reviewerUserId } : {}),
        ...(notification.organizationId ? { organizationId: notification.organizationId } : {}),
        ...(notification.teamId ? { teamId: notification.teamId } : {}),
      };
    })
    .sort((left, right) => {
      const severityRank: Record<NotificationSeverity, number> = {
        blocker: 0,
        warning: 1,
        info: 2,
      };
      return (
        Number(right.overdue) - Number(left.overdue) ||
        severityRank[left.severity] - severityRank[right.severity] ||
        (right.ageMs ?? -1) - (left.ageMs ?? -1)
      );
    });

  const groups = new Map<string, MyWorkDashboardGroup>();
  for (const item of items) {
    const group = groups.get(item.actionLabel) ?? {
      actionLabel: item.actionLabel,
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push(item);
    groups.set(item.actionLabel, group);
  }

  return {
    generatedAt: now.toISOString(),
    pendingCount: items.length,
    blockerCount: items.filter((item) => item.severity === "blocker").length,
    reviewCount: items.filter((item) => item.type.startsWith("review-")).length,
    overdueCount: items.filter((item) => item.overdue).length,
    groups: [...groups.values()],
    items,
  };
}
