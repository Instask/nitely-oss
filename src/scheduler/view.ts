import type { WorkItemRecord, WorkItemStatus } from "../work-items/types.js";
import type { TaskPriority } from "../web/tasks.js";
import type {
  RunEligibilityDecision,
  RunEligibilityReason,
  RunEligibilityReasonKind,
} from "../run/eligibility.js";

export type SchedulerNodeStatus =
  | "draft"
  | "runnable"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

type TaskStatusProjection = WorkItemRecord & {
  displayStatus?: string;
  latestRunStatus?: string;
  latestRun?: { status?: string };
};

export interface SchedulerQueueItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  displayStatus: SchedulerNodeStatus;
  priority: TaskPriority;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  issueUrl?: string;
  changeRequestUrl?: string;
  latestRunId?: string;
  blockedReasons: SchedulerBlockedReason[];
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerNode extends SchedulerQueueItem {
  dependsOn: string[];
  suggestedDependencies: Array<{
    dependsOn: string;
    reason: string;
    confidence: number;
    source: string;
    suggestedAt: string;
  }>;
}

export interface SchedulerEdge {
  from: string;
  to: string;
  kind: "confirmed" | "suggested";
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  reason?: string;
  confidence?: number;
  source?: string;
}

export interface SchedulerView {
  summary: {
    total: number;
    running: number;
    runnable: number;
    blocked: number;
    failed: number;
    completed: number;
    draft: number;
    suggestedEdges: number;
  };
  queue: {
    running: SchedulerQueueItem[];
    runnable: SchedulerQueueItem[];
    blocked: SchedulerQueueItem[];
    failed: SchedulerQueueItem[];
    completed: SchedulerQueueItem[];
    draft: SchedulerQueueItem[];
  };
  nodes: SchedulerNode[];
  edges: SchedulerEdge[];
  cooldowns: {
    runtimes: Array<{
      runtime: string;
      until: string;
      waitingRunCount: number;
      repoId?: string;
      repoName?: string;
      repoPath?: string;
    }>;
    nextWakeUp?: string;
  };
}

export interface SchedulerBlockedReason {
  kind: RunEligibilityReasonKind;
  upstreamId?: string;
  changedFields?: string[];
  message?: string;
}

export interface SchedulerViewInput {
  eligibility: Record<string, RunEligibilityDecision>;
  cooldowns?: SchedulerView["cooldowns"];
}

const priorityRank: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function taskPriority(task: WorkItemRecord): TaskPriority {
  return task.priority ?? "P2";
}

function uniqueTaskIds(ids: string[] | undefined, ownId: string): string[] {
  return [...new Set(ids ?? [])].filter((id) => id && id !== ownId);
}

function queueSort(left: SchedulerQueueItem, right: SchedulerQueueItem): number {
  const priorityDelta = priorityRank[left.priority] - priorityRank[right.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return left.createdAt.localeCompare(right.createdAt);
}

export function sortSchedulerQueue(queue: SchedulerView["queue"]): SchedulerView["queue"] {
  return {
    running: [...queue.running].sort(queueSort),
    runnable: [...queue.runnable].sort(queueSort),
    blocked: [...queue.blocked].sort(queueSort),
    failed: [...queue.failed].sort(queueSort),
    completed: [...queue.completed].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
    draft: [...queue.draft].sort(queueSort),
  };
}

function projectedRunStatus(task: TaskStatusProjection): SchedulerNodeStatus | undefined {
  const status = task.latestRunStatus ?? task.latestRun?.status ?? task.displayStatus;
  if (
    status === "running" ||
    status === "blocked" ||
    status === "failed" ||
    status === "completed" ||
    status === "draft"
  ) {
    return status;
  }
  if (status === "interrupted" || status === "cancelled") {
    return "blocked";
  }
  return undefined;
}

function displayStatusFor(input: {
  task: TaskStatusProjection;
  isRunnable: boolean;
  blockedReasons: SchedulerBlockedReason[];
}): SchedulerNodeStatus {
  const runStatus = projectedRunStatus(input.task);
  if (runStatus) return runStatus;
  if (input.task.status === "running") return "running";
  if (input.task.status === "failed") return "failed";
  if (input.task.status === "completed") return "completed";
  if (input.task.status === "draft") return "draft";
  if (input.blockedReasons.length > 0) return "blocked";
  if (input.isRunnable) return "runnable";
  return "blocked";
}

function queueItemFor(input: {
  task: WorkItemRecord;
  displayStatus: SchedulerNodeStatus;
  blockedReasons: SchedulerBlockedReason[];
}): SchedulerQueueItem {
  const taskWithRepository = input.task as WorkItemRecord & {
    repoName?: string;
    repoPath?: string;
  };
  return {
    id: input.task.id,
    title: input.task.title,
    status: input.task.status,
    displayStatus: input.displayStatus,
    priority: taskPriority(input.task),
    ...(input.task.repoId ? { repoId: input.task.repoId } : {}),
    ...(taskWithRepository.repoName ? { repoName: taskWithRepository.repoName } : {}),
    ...(taskWithRepository.repoPath ? { repoPath: taskWithRepository.repoPath } : {}),
    ...(input.task.issueUrl ? { issueUrl: input.task.issueUrl } : {}),
    ...(input.task.changeRequestUrl
      ? { changeRequestUrl: input.task.changeRequestUrl }
      : {}),
    ...(input.task.latestRunId ? { latestRunId: input.task.latestRunId } : {}),
    blockedReasons: input.blockedReasons,
    createdAt: input.task.createdAt,
    updatedAt: input.task.updatedAt,
  };
}

export function buildSchedulerView(
  tasks: TaskStatusProjection[],
  input: SchedulerViewInput,
): SchedulerView {
  const runnableIds = new Set(
    tasks
      .filter((task) => input.eligibility[task.id]?.decision === "eligible")
      .map((task) => task.id),
  );
  const queue: SchedulerView["queue"] = {
    running: [],
    runnable: [],
    blocked: [],
    failed: [],
    completed: [],
    draft: [],
  };
  const nodes: SchedulerNode[] = [];
  const edges: SchedulerEdge[] = [];

  for (const task of tasks) {
    const taskWithRepository = task as WorkItemRecord & {
      repoName?: string;
      repoPath?: string;
    };
    const edgeRepository = {
      ...(task.repoId ? { repoId: task.repoId } : {}),
      ...(taskWithRepository.repoName ? { repoName: taskWithRepository.repoName } : {}),
      ...(taskWithRepository.repoPath ? { repoPath: taskWithRepository.repoPath } : {}),
    };
    const blockedReasons = (
      input.eligibility[task.id]?.blockers ?? []
    ).map(schedulerBlockedReason);
    const displayStatus = displayStatusFor({
      task,
      isRunnable: runnableIds.has(task.id),
      blockedReasons,
    });
    const item = queueItemFor({ task, displayStatus, blockedReasons });
    const dependsOn = uniqueTaskIds(task.dependsOn, task.id);
    const suggestedDependencies = (task.suggestedDependencies ?? []).filter(
      (suggestion) => suggestion.dependsOn && suggestion.dependsOn !== task.id,
    );

    nodes.push({
      ...item,
      dependsOn,
      suggestedDependencies,
    });

    for (const upstreamId of dependsOn) {
      edges.push({
        from: upstreamId,
        to: task.id,
        kind: "confirmed",
        ...edgeRepository,
      });
    }
    for (const suggestion of suggestedDependencies) {
      edges.push({
        from: suggestion.dependsOn,
        to: task.id,
        kind: "suggested",
        ...edgeRepository,
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        source: suggestion.source,
      });
    }

    if (displayStatus === "running") queue.running.push(item);
    else if (displayStatus === "runnable") queue.runnable.push(item);
    else if (displayStatus === "blocked") queue.blocked.push(item);
    else if (displayStatus === "failed") queue.failed.push(item);
    else if (displayStatus === "completed") queue.completed.push(item);
    else queue.draft.push(item);
  }

  const sortedQueue = sortSchedulerQueue(queue);

  return {
    summary: {
      total: tasks.length,
      running: sortedQueue.running.length,
      runnable: sortedQueue.runnable.length,
      blocked: sortedQueue.blocked.length,
      failed: sortedQueue.failed.length,
      completed: sortedQueue.completed.length,
      draft: sortedQueue.draft.length,
      suggestedEdges: edges.filter((edge) => edge.kind === "suggested").length,
    },
    queue: sortedQueue,
    nodes,
    edges,
    cooldowns: input.cooldowns ?? { runtimes: [] },
  };
}

function schedulerBlockedReason(
  reason: RunEligibilityReason,
): SchedulerBlockedReason {
  const carriesMessage =
    reason.kind === "status" ||
    reason.kind === "planning" ||
    reason.kind === "governance" ||
    reason.kind === "spec-readiness" ||
    reason.kind === "preflight";
  return {
    kind: reason.kind,
    ...(reason.upstreamId ? { upstreamId: reason.upstreamId } : {}),
    ...(reason.changedFields ? { changedFields: reason.changedFields } : {}),
    ...(carriesMessage && reason.message ? { message: reason.message } : {}),
  };
}
