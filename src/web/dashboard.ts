import type { WebRepository } from "./repositories.js";
import type { WebRunSummary, WebRunStatus } from "./runs.js";
import type { WorkItemView } from "./work-item-views.js";

type DashboardWorkItem = WorkItemView & {
  repoName?: string;
  repoPath?: string;
};

export interface DashboardCount {
  label: string;
  count: number;
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
  outcomes: DashboardOutcomeQuality;
  repositories: DashboardRepoBreakdown[];
}

const taskStatuses = ["draft", "ready", "running", "completed", "failed"];
const runStatuses: WebRunStatus[] = [
  "running",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "incomplete",
];

function countBy<T>(items: T[], labels: string[], read: (item: T) => string | undefined): DashboardCount[] {
  return labels.map((label) => ({
    label,
    count: items.filter((item) => read(item) === label).length,
  }));
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

function completionTime(run: WebRunSummary): string | undefined {
  return run.completedAt ?? run.startedAt;
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

function repoKey(record: { repoId?: string; repoName?: string; repoPath?: string }): string {
  return record.repoId ?? record.repoName ?? record.repoPath ?? "default";
}

function repoName(record: { repoId?: string; repoName?: string; repoPath?: string }): string {
  return record.repoName ?? record.repoId ?? record.repoPath ?? "Default repository";
}

export function buildManagerDashboard(input: {
  tasks: DashboardWorkItem[];
  runs: WebRunSummary[];
  repositories: WebRepository[];
  now?: Date;
}): ManagerDashboard {
  const now = input.now ?? new Date();
  const repoBreakdowns = new Map<string, DashboardRepoBreakdown>();
  for (const repository of input.repositories) {
    repoBreakdowns.set(repository.id, {
      repoId: repository.id,
      repoName: repository.name,
      taskCount: 0,
      runCount: 0,
      blockedCount: 0,
      completedRuns: 0,
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
      };
      repoBreakdowns.set(key, breakdown);
    }
    return breakdown;
  };

  for (const task of input.tasks) {
    const breakdown = ensureRepo(task);
    breakdown.taskCount += 1;
    if (isBlockedTask(task)) breakdown.blockedCount += 1;
  }

  const blocked: DashboardBlockedItem[] = [];
  for (const task of input.tasks.filter(isBlockedTask)) {
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
  };
  for (const run of input.runs) {
    const breakdown = ensureRepo(run);
    breakdown.runCount += 1;
    if (run.status === "blocked") {
      breakdown.blockedCount += 1;
    }
    if (run.status === "completed") {
      breakdown.completedRuns += 1;
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
  const completedRuns = input.runs.filter((run) => run.status === "completed").length;
  const failedRuns = input.runs.filter((run) => run.status === "failed").length;
  const blockedRuns = input.runs.filter((run) => run.status === "blocked").length;
  const reworkRuns = input.runs.filter((run) => run.priorRunId || run.trigger).length;
  const gates = reviewGateCounts(input.runs);

  return {
    generatedAt: now.toISOString(),
    taskCount: input.tasks.length,
    runCount: input.runs.length,
    repositoryCount: input.repositories.length,
    throughput: {
      tasks: countBy(input.tasks, taskStatuses, taskDisplayStatus),
      runs: countBy(input.runs, runStatuses, (run) => run.status),
      activeTasks: input.tasks.filter((task) => taskDisplayStatus(task) === "running").length,
      activeRuns: input.runs.filter((run) => run.status === "running").length,
      queuedTasks: input.tasks.filter((task) => taskDisplayStatus(task) === "ready").length,
      blockedItems: blocked.length,
    },
    blocked,
    cost,
    outcomes: {
      completedRuns,
      failedRuns,
      blockedRuns,
      reworkRuns,
      reviewGatesPassed: gates.passed,
      reviewGatesFailed: gates.failed,
      completionRate: ratio(completedRuns, input.runs.length),
      reworkRatio: ratio(reworkRuns, input.runs.length),
      reviewGatePassRate: ratio(gates.passed, gates.passed + gates.failed),
    },
    repositories: [...repoBreakdowns.values()].sort((left, right) =>
      right.blockedCount - left.blockedCount ||
      right.runCount - left.runCount ||
      left.repoName.localeCompare(right.repoName),
    ),
  };
}
