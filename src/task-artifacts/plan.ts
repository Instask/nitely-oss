export type TaskPlanTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

export interface TaskPlanTask {
  id: string;
  title: string;
  status: TaskPlanTaskStatus;
  dependencies: string[];
  paths: string[];
  notes?: string;
  raw: unknown;
}

export interface TaskPlanHistoryEntry {
  taskId: string;
  status: TaskPlanTaskStatus;
  stageId?: string;
  attempt?: number;
  message?: string;
  createdAt?: string;
}

export type TaskPlanDiagnosticCode =
  | "invalid-json"
  | "invalid-root"
  | "invalid-max-iterations"
  | "missing-tasks"
  | "invalid-task"
  | "missing-task-id"
  | "duplicate-task-id"
  | "missing-task-title"
  | "invalid-task-status"
  | "invalid-task-dependencies"
  | "invalid-task-paths"
  | "invalid-history";

export interface TaskPlanDiagnostic {
  code: TaskPlanDiagnosticCode;
  path: string;
  message: string;
  taskId?: string;
}

export interface ParsedTaskPlan {
  valid: boolean;
  version?: string;
  maxIterations?: number;
  tasks: TaskPlanTask[];
  history: TaskPlanHistoryEntry[];
  diagnostics: TaskPlanDiagnostic[];
}

export interface TaskPlanProgress {
  completedTaskIds: string[];
  remainingTaskIds: string[];
  completedCount: number;
  remainingCount: number;
  totalTaskCount: number;
  currentTask?: TaskPlanTask;
}

const VALID_STATUSES = new Set<TaskPlanTaskStatus>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function taskStatus(value: unknown): TaskPlanTaskStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_STATUSES.has(normalized as TaskPlanTaskStatus)
    ? (normalized as TaskPlanTaskStatus)
    : undefined;
}

function maxIterationsFromRoot(
  record: Record<string, unknown>,
  diagnostics: TaskPlanDiagnostic[],
): number | undefined {
  const raw = record.max_iterations ?? record.maxIterations;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    diagnostics.push({
      code: "invalid-max-iterations",
      path: record.max_iterations !== undefined ? "$.max_iterations" : "$.maxIterations",
      message: "task-plan max_iterations must be a positive integer",
    });
    return undefined;
  }
  return raw;
}

function parseTask(
  value: unknown,
  index: number,
): { task?: TaskPlanTask; diagnostics: TaskPlanDiagnostic[] } {
  const path = `$.tasks[${index}]`;
  const diagnostics: TaskPlanDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      diagnostics: [
        {
          code: "invalid-task",
          path,
          message: "task-plan task must be an object",
        },
      ],
    };
  }

  const id = optionalString(value.id);
  if (!id) {
    diagnostics.push({
      code: "missing-task-id",
      path: `${path}.id`,
      message: "task-plan task is missing a stable id",
    });
  }
  const title = optionalString(value.title);
  if (!title) {
    diagnostics.push({
      code: "missing-task-title",
      path: `${path}.title`,
      message: "task-plan task is missing a title",
      ...(id ? { taskId: id } : {}),
    });
  }
  const status =
    value.status === undefined && value.completed === true
      ? "completed"
      : taskStatus(value.status ?? "pending");
  if (!status) {
    diagnostics.push({
      code: "invalid-task-status",
      path: `${path}.status`,
      message:
        "task-plan task status must be pending, in_progress, completed, or blocked",
      ...(id ? { taskId: id } : {}),
    });
  }
  const dependencies = stringArray(value.dependencies ?? []);
  if (!dependencies) {
    diagnostics.push({
      code: "invalid-task-dependencies",
      path: `${path}.dependencies`,
      message: "task-plan task dependencies must be an array of strings",
      ...(id ? { taskId: id } : {}),
    });
  }
  const paths = stringArray(value.paths ?? []);
  if (!paths) {
    diagnostics.push({
      code: "invalid-task-paths",
      path: `${path}.paths`,
      message: "task-plan task paths must be an array of strings",
      ...(id ? { taskId: id } : {}),
    });
  }

  if (!id || !title || !status || !dependencies || !paths) {
    return { diagnostics };
  }
  return {
    task: {
      id,
      title,
      status,
      dependencies,
      paths,
      ...(optionalString(value.notes) ? { notes: optionalString(value.notes) } : {}),
      raw: value,
    },
    diagnostics,
  };
}

function parseHistoryEntry(
  value: unknown,
  index: number,
): { entry?: TaskPlanHistoryEntry; diagnostic?: TaskPlanDiagnostic } {
  const path = `$.history[${index}]`;
  if (!isRecord(value)) {
    return {
      diagnostic: {
        code: "invalid-history",
        path,
        message: "task-plan history entry must be an object",
      },
    };
  }
  const taskId = optionalString(value.taskId ?? value.task_id);
  const status = taskStatus(value.status);
  if (!taskId || !status) {
    return {
      diagnostic: {
        code: "invalid-history",
        path,
        message: "task-plan history entry must include taskId and valid status",
      },
    };
  }
  const attempt =
    typeof value.attempt === "number" && Number.isInteger(value.attempt)
      ? value.attempt
      : undefined;
  return {
    entry: {
      taskId,
      status,
      ...(optionalString(value.stageId ?? value.stage_id)
        ? { stageId: optionalString(value.stageId ?? value.stage_id) }
        : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(optionalString(value.message) ? { message: optionalString(value.message) } : {}),
      ...(optionalString(value.createdAt ?? value.created_at)
        ? { createdAt: optionalString(value.createdAt ?? value.created_at) }
        : {}),
    },
  };
}

export function parseTaskPlanJson(content: string): ParsedTaskPlan {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return {
      valid: false,
      tasks: [],
      history: [],
      diagnostics: [
        {
          code: "invalid-json",
          path: "$",
          message: `task-plan.json is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  if (!isRecord(value)) {
    return {
      valid: false,
      tasks: [],
      history: [],
      diagnostics: [
        {
          code: "invalid-root",
          path: "$",
          message: "task-plan.json root must be an object",
        },
      ],
    };
  }

  const diagnostics: TaskPlanDiagnostic[] = [];
  const maxIterations = maxIterationsFromRoot(value, diagnostics);
  const tasksValue = value.tasks;
  if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
    diagnostics.push({
      code: "missing-tasks",
      path: "$.tasks",
      message: "task-plan.json must include a non-empty tasks array",
    });
  }

  const tasks: TaskPlanTask[] = [];
  const seen = new Set<string>();
  if (Array.isArray(tasksValue)) {
    tasksValue.forEach((entry, index) => {
      const parsed = parseTask(entry, index);
      diagnostics.push(...parsed.diagnostics);
      if (!parsed.task) return;
      if (seen.has(parsed.task.id)) {
        diagnostics.push({
          code: "duplicate-task-id",
          path: `$.tasks[${index}].id`,
          taskId: parsed.task.id,
          message: `duplicate task id ${parsed.task.id}`,
        });
        return;
      }
      seen.add(parsed.task.id);
      tasks.push(parsed.task);
    });
  }

  const history: TaskPlanHistoryEntry[] = [];
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) {
      diagnostics.push({
        code: "invalid-history",
        path: "$.history",
        message: "task-plan history must be an array",
      });
    } else {
      value.history.forEach((entry, index) => {
        const parsed = parseHistoryEntry(entry, index);
        if (parsed.diagnostic) {
          diagnostics.push(parsed.diagnostic);
        } else if (parsed.entry) {
          history.push(parsed.entry);
        }
      });
    }
  }

  return {
    valid: diagnostics.length === 0,
    ...(optionalString(value.version) ? { version: optionalString(value.version) } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    tasks,
    history,
    diagnostics,
  };
}

export function completedTaskIdsFromPlan(plan: ParsedTaskPlan): string[] {
  return plan.tasks
    .filter((task) => task.status === "completed")
    .map((task) => task.id);
}

export function taskPlanProgress(
  plan: ParsedTaskPlan,
  completedTaskIds: Iterable<string>,
  currentTaskId?: string,
): TaskPlanProgress {
  const completed = new Set(completedTaskIds);
  const remainingTasks = plan.tasks.filter((task) => !completed.has(task.id));
  const currentTask =
    (currentTaskId ? plan.tasks.find((task) => task.id === currentTaskId) : undefined) ??
    nextPendingTask(plan, completed);
  return {
    completedTaskIds: plan.tasks
      .filter((task) => completed.has(task.id))
      .map((task) => task.id),
    remainingTaskIds: remainingTasks.map((task) => task.id),
    completedCount: plan.tasks.length - remainingTasks.length,
    remainingCount: remainingTasks.length,
    totalTaskCount: plan.tasks.length,
    ...(currentTask ? { currentTask } : {}),
  };
}

export function nextPendingTask(
  plan: ParsedTaskPlan,
  completedTaskIds: Iterable<string>,
): TaskPlanTask | undefined {
  const completed = new Set(completedTaskIds);
  const remaining = plan.tasks.filter((task) => !completed.has(task.id));
  const ready = remaining.find(
    (task) =>
      task.status !== "blocked" &&
      task.dependencies.every((dependency) => completed.has(dependency)),
  );
  return ready ?? remaining.find((task) => task.status !== "blocked") ?? remaining[0];
}

export function renderCurrentTaskPlan(input: {
  inputId: string;
  plan: ParsedTaskPlan;
  completedTaskIds: Iterable<string>;
  currentTask: TaskPlanTask;
  iteration: number;
  maxIterations: number;
  history?: TaskPlanHistoryEntry[];
}): string {
  const progress = taskPlanProgress(
    input.plan,
    input.completedTaskIds,
    input.currentTask.id,
  );
  const lines = [
    "# Current Task Plan",
    "",
    `Source input: ${input.inputId}`,
    `Iteration: ${input.iteration}/${input.maxIterations}`,
    `Current task: ${input.currentTask.id} ${input.currentTask.title}`,
    `Completed tasks: ${progress.completedTaskIds.join(", ") || "none"}`,
    `Remaining tasks: ${progress.remainingTaskIds.join(", ") || "none"}`,
    "",
    "## Current Task",
    "",
    `- ID: ${input.currentTask.id}`,
    `- Title: ${input.currentTask.title}`,
    `- Status: ${input.currentTask.status}`,
    `- Dependencies: ${input.currentTask.dependencies.join(", ") || "none"}`,
    `- Paths: ${input.currentTask.paths.join(", ") || "none"}`,
    input.currentTask.notes ? `- Notes: ${input.currentTask.notes}` : undefined,
    "",
    "## Current Task JSON",
    "",
    "```json",
    JSON.stringify(
      {
        id: input.currentTask.id,
        title: input.currentTask.title,
        status: input.currentTask.status,
        dependencies: input.currentTask.dependencies,
        paths: input.currentTask.paths,
        ...(input.currentTask.notes ? { notes: input.currentTask.notes } : {}),
      },
      null,
      2,
    ),
    "```",
  ].filter((line): line is string => line !== undefined);

  const history = input.history ?? [];
  lines.push("", "## Loop History", "");
  if (history.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      ...history.map((entry) =>
        [
          `- ${entry.taskId}: ${entry.status}`,
          entry.stageId ? `stage ${entry.stageId}` : undefined,
          entry.attempt !== undefined ? `attempt ${entry.attempt}` : undefined,
          entry.message,
        ]
          .filter((part): part is string => part !== undefined)
          .join(", "),
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}
