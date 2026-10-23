import type { TaskRecord } from "../work-items/adapters/dev-pr-store.js";

function dependenciesOf(task: TaskRecord): string[] {
  return [...new Set(task.dependsOn ?? [])].filter((id) => id && id !== task.id);
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
