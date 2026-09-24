import type { RepositoryIssue } from "../scm/types.js";
import type { ParsedTask, ParsedTaskArtifact } from "../task-artifacts/parse.js";

export type TaskIssueGrouping = "task" | "phase";

export interface TaskIssueSourceLink {
  path: string;
  url: string;
}

export interface TaskIssueSources {
  commit: string;
  commitUrl: string;
  tasks: TaskIssueSourceLink;
  spec: TaskIssueSourceLink;
  plan: TaskIssueSourceLink;
}

export interface TaskIssueGroup {
  key: string;
  grouping: TaskIssueGrouping;
  title: string;
  body: string;
  tasks: ParsedTask[];
  taskIds: string[];
}

export interface PlannedTaskIssue {
  group: TaskIssueGroup;
  outcome: "create" | "reuse";
  issue?: RepositoryIssue;
}

export interface TaskIssuePlan {
  entries: PlannedTaskIssue[];
}

export class TaskIssueConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`task issue sync has conflicts: ${conflicts.join("; ")}`);
    this.name = "TaskIssueConflictError";
    this.conflicts = conflicts;
  }
}

const TASK_ID_MARKER_PREFIX = "<!-- nitely-task-ids:";
const TASK_ID_MARKER_PATTERN =
  /<!-- nitely-task-ids:v1 (T\d{3}(?:,T\d{3})*) -->/g;
const CANONICAL_TITLE_PATTERN = /^\s*(T\d{3})\s*:/;
const GITHUB_TITLE_MAX_LENGTH = 256;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function boundedTitle(value: string): string {
  const characters = Array.from(value.trim());
  if (characters.length <= GITHUB_TITLE_MAX_LENGTH) return characters.join("");
  return characters.slice(0, GITHUB_TITLE_MAX_LENGTH - 1).join("").trimEnd() + "…";
}

function taskTitle(task: ParsedTask): string {
  return task.title.trim() || "Untitled task";
}

function issueTitle(input: {
  grouping: TaskIssueGrouping;
  groupName: string;
  tasks: ParsedTask[];
}): string {
  const first = input.tasks[0]!;
  if (input.grouping === "task") {
    return boundedTitle(`${first.id}: ${taskTitle(first)}`);
  }
  const count = input.tasks.length;
  return boundedTitle(
    `${first.id}: ${input.groupName} (${count} ${count === 1 ? "task" : "tasks"})`,
  );
}

function metadataLine(label: string, values: string[]): string {
  return `  - ${label}: ${values.length > 0 ? values.join(", ") : "none"}`;
}

function renderTaskLines(tasks: ParsedTask[], sources: TaskIssueSources): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(
      `- [${task.completed ? "x" : " "}] [\`${task.id}\`](${sources.tasks.url}#L${task.line}) — ${taskTitle(task)}`,
      `  - Phase: ${task.phase ?? "none"}`,
      `  - Story: ${task.storyId ?? "none"}`,
      `  - Parallel: ${task.parallel ? "yes" : "no"}`,
      metadataLine("Dependencies", task.dependencies),
      metadataLine("Paths", task.paths.map((path) => `\`${path}\``)),
    );
  }
  return lines;
}

export function taskIssueMarker(taskIds: string[]): string {
  return `<!-- nitely-task-ids:v1 ${unique(taskIds).join(",")} -->`;
}

export function renderTaskIssueBody(input: {
  grouping: TaskIssueGrouping;
  tasks: ParsedTask[];
  sources: TaskIssueSources;
}): string {
  const taskIds = input.tasks.map((task) => task.id);
  return [
    taskIssueMarker(taskIds),
    "",
    "Generated from a Nitely task artifact.",
    "",
    "## Tasks",
    "",
    ...renderTaskLines(input.tasks, input.sources),
    "",
    "## Source artifacts",
    "",
    `- Tasks: [\`${input.sources.tasks.path}\`](${input.sources.tasks.url})`,
    `- Spec: [\`${input.sources.spec.path}\`](${input.sources.spec.url})`,
    `- Plan: [\`${input.sources.plan.path}\`](${input.sources.plan.url})`,
    `- Commit: [\`${input.sources.commit}\`](${input.sources.commitUrl})`,
    "",
    "## Nitely metadata",
    "",
    `- Grouping: ${input.grouping}`,
    `- Task IDs: ${taskIds.join(", ")}`,
    "",
  ].join("\n");
}

export function buildTaskIssueGroups(input: {
  parsed: ParsedTaskArtifact;
  grouping: TaskIssueGrouping;
  sources: TaskIssueSources;
}): TaskIssueGroup[] {
  if (!input.parsed.valid) {
    const diagnostics = input.parsed.diagnostics
      .map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(`invalid task artifact: ${diagnostics}`);
  }
  if (input.parsed.tasks.length === 0) {
    throw new Error("task artifact contains no tasks");
  }

  const grouped = new Map<string, ParsedTask[]>();
  if (input.grouping === "task") {
    for (const task of input.parsed.tasks) grouped.set(task.id, [task]);
  } else {
    for (const task of input.parsed.tasks) {
      const name = task.phase ?? "Ungrouped";
      const tasks = grouped.get(name) ?? [];
      tasks.push(task);
      grouped.set(name, tasks);
    }
  }

  return [...grouped].map(([groupName, tasks]) => ({
    key: input.grouping === "task" ? tasks[0]!.id : groupName,
    grouping: input.grouping,
    title: issueTitle({ grouping: input.grouping, groupName, tasks }),
    body: renderTaskIssueBody({
      grouping: input.grouping,
      tasks,
      sources: input.sources,
    }),
    tasks,
    taskIds: tasks.map((task) => task.id),
  }));
}

export function claimedTaskIds(issue: RepositoryIssue): string[] {
  const markerPrefixes = issue.body.split(TASK_ID_MARKER_PREFIX).length - 1;
  const markers = [...issue.body.matchAll(TASK_ID_MARKER_PATTERN)];
  if (markerPrefixes > 0) {
    if (markerPrefixes !== 1 || markers.length !== 1) {
      throw new Error(`GitHub issue #${issue.number} has a malformed Nitely task ID marker`);
    }
    const taskIds = markers[0]![1]!.split(",");
    if (unique(taskIds).length !== taskIds.length) {
      throw new Error(`GitHub issue #${issue.number} has duplicate task IDs in its Nitely marker`);
    }
    return taskIds;
  }
  const title = CANONICAL_TITLE_PATTERN.exec(issue.title);
  return title?.[1] ? [title[1]] : [];
}

export function planTaskIssues(input: {
  groups: TaskIssueGroup[];
  existingIssues: RepositoryIssue[];
}): TaskIssuePlan {
  const claims = new Map<string, RepositoryIssue[]>();
  for (const issue of input.existingIssues) {
    for (const taskId of claimedTaskIds(issue)) {
      const issues = claims.get(taskId) ?? [];
      issues.push(issue);
      claims.set(taskId, issues);
    }
  }

  const entries: PlannedTaskIssue[] = [];
  const conflicts: string[] = [];
  for (const group of input.groups) {
    const issues = new Map<number, RepositoryIssue>();
    const missing: string[] = [];
    for (const taskId of group.taskIds) {
      const claimed = claims.get(taskId) ?? [];
      if (claimed.length === 0) missing.push(taskId);
      for (const issue of claimed) issues.set(issue.number, issue);
    }
    if (issues.size === 0) {
      entries.push({ group, outcome: "create" });
      continue;
    }
    if (issues.size === 1 && missing.length === 0) {
      entries.push({
        group,
        outcome: "reuse",
        issue: [...issues.values()][0],
      });
      continue;
    }
    const issueNumbers = [...issues.keys()].sort((left, right) => left - right);
    conflicts.push(
      `${group.taskIds.join(",")}: ${
        missing.length > 0 ? `missing ${missing.join(",")}; ` : ""
      }claimed by ${issueNumbers.map((number) => `#${number}`).join(",")}`,
    );
  }
  if (conflicts.length > 0) throw new TaskIssueConflictError(conflicts);
  return { entries };
}
