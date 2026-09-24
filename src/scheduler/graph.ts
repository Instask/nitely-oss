import type { TaskPriority, TaskRecord } from "../web/tasks.js";

export type BlockedReasonKind =
  | "missing"
  | "failed"
  | "incomplete";

export interface BlockedReason {
  kind: BlockedReasonKind;
  upstreamId?: string;
  changedFields?: string[];
  message?: string;
}

export interface GraphNode {
  task: TaskRecord;
  blockedReasons: BlockedReason[];
}

export interface EvaluateTaskGraphInput {
  isTaskComplete: (taskId: string) => boolean;
}

const priorityRank: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function dependenciesOf(task: TaskRecord): string[] {
  return [...new Set(task.dependsOn ?? [])].filter((id) => id && id !== task.id);
}

function priorityOf(task: TaskRecord): TaskPriority {
  return task.priority ?? "P2";
}

function taskMap(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((task) => [task.id, task]));
}

export function detectCycle(tasks: TaskRecord[]): string[] | undefined {
  const byId = taskMap(tasks);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(task: TaskRecord): string[] | undefined {
    if (visited.has(task.id)) return undefined;
    if (visiting.has(task.id)) {
      const start = stack.indexOf(task.id);
      return [...stack.slice(start), task.id];
    }
    visiting.add(task.id);
    stack.push(task.id);
    for (const upstreamId of dependenciesOf(task)) {
      const upstream = byId.get(upstreamId);
      if (!upstream) continue;
      const cycle = visit(upstream);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(task.id);
    visited.add(task.id);
    return undefined;
  }

  for (const task of tasks) {
    const cycle = visit(task);
    if (cycle) return cycle;
  }
  return undefined;
}

export function wouldCreateCycle(
  tasks: TaskRecord[],
  downstreamId: string,
  upstreamId: string,
): boolean {
  const byId = taskMap(tasks);
  const downstream = byId.get(downstreamId);
  if (!downstream || !byId.has(upstreamId)) return false;
  const updated = tasks.map((task) =>
    task.id === downstreamId
      ? { ...task, dependsOn: [...dependenciesOf(task), upstreamId] }
      : task,
  );
  return detectCycle(updated) !== undefined;
}

export function evaluateTaskGraph(
  tasks: TaskRecord[],
  input: EvaluateTaskGraphInput,
): Map<string, GraphNode> {
  const byId = taskMap(tasks);
  const graph = new Map<string, GraphNode>();
  for (const task of tasks) {
    const blockedReasons: BlockedReason[] = [];
    for (const upstreamId of dependenciesOf(task)) {
      const upstream = byId.get(upstreamId);
      if (!upstream) {
        blockedReasons.push({ kind: "missing", upstreamId });
        continue;
      }
      if (upstream.status === "failed") {
        blockedReasons.push({ kind: "failed", upstreamId });
        continue;
      }
      if (!input.isTaskComplete(upstreamId)) {
        blockedReasons.push({ kind: "incomplete", upstreamId });
      }
    }
    graph.set(task.id, { task, blockedReasons });
  }
  return graph;
}

export function selectRunnableTasks(
  tasks: TaskRecord[],
  input: EvaluateTaskGraphInput,
): GraphNode[] {
  return [...evaluateTaskGraph(tasks, input).values()]
    .filter((node) => node.task.status === "ready" && node.blockedReasons.length === 0)
    .sort((left, right) => {
      const priorityDelta =
        priorityRank[priorityOf(left.task)] - priorityRank[priorityOf(right.task)];
      if (priorityDelta !== 0) return priorityDelta;
      return left.task.createdAt.localeCompare(right.task.createdAt);
    });
}
