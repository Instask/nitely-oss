import {
  parseTaskArtifact,
  type ParsedTask,
  type ParsedTaskArtifact,
  type TaskArtifactDiagnostic,
} from "./parse.js";

export interface TaskScopeInput {
  inputId: string;
  expression: string;
}

export type TaskScopeKind =
  | "ids"
  | "range"
  | "phase"
  | "story"
  | "next-unchecked";

export interface TaskScopeSelection {
  inputId: string;
  expression: string;
  kind: TaskScopeKind;
  selectedTaskIds: string[];
  selectedTasks: ParsedTask[];
  sourceTaskCount: number;
  completedTaskIds: string[];
  pendingTaskIds: string[];
}

export interface TaskScopeDiagnostic {
  code:
    | "invalid-task-artifact"
    | "invalid-scope-expression"
    | "unknown-task-id"
    | "empty-scope";
  message: string;
  taskId?: string;
  artifactDiagnostics?: TaskArtifactDiagnostic[];
}

export interface TaskScopeResult {
  selection?: TaskScopeSelection;
  diagnostics: TaskScopeDiagnostic[];
}

const TASK_ID_PATTERN = /^T\d{3}$/;
const STORY_ID_PATTERN = /^US-\d{3}$/i;
const RANGE_PATTERN = /^(T\d{3})\s*-\s*(T\d{3})$/i;
const NEXT_PATTERN = /^next(?:[-_\s:]*(?:unchecked|open))?(?:[-_\s:]*(\d+))?$/i;

function normalizeTaskId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeStoryId(value: string): string {
  return value.trim().toUpperCase();
}

function taskById(parsed: ParsedTaskArtifact): Map<string, ParsedTask> {
  return new Map(parsed.tasks.map((task) => [task.id, task]));
}

function uniqueTasks(tasks: ParsedTask[]): ParsedTask[] {
  const seen = new Set<string>();
  const selected: ParsedTask[] = [];
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    selected.push(task);
  }
  return selected;
}

function phaseMatches(phase: string | undefined, expression: string): boolean {
  if (!phase) return false;
  const normalizedPhase = phase.toLowerCase();
  const normalizedExpression = expression.toLowerCase();
  if (normalizedPhase === normalizedExpression) return true;
  const shortName = phase.split(":").slice(1).join(":").trim().toLowerCase();
  return shortName === normalizedExpression;
}

function selectionForTasks(input: {
  inputId: string;
  expression: string;
  kind: TaskScopeKind;
  parsed: ParsedTaskArtifact;
  selectedTasks: ParsedTask[];
}): TaskScopeSelection {
  const selectedTasks = uniqueTasks(input.selectedTasks);
  return {
    inputId: input.inputId,
    expression: input.expression,
    kind: input.kind,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    selectedTasks,
    sourceTaskCount: input.parsed.tasks.length,
    completedTaskIds: selectedTasks
      .filter((task) => task.completed)
      .map((task) => task.id),
    pendingTaskIds: selectedTasks
      .filter((task) => !task.completed)
      .map((task) => task.id),
  };
}

export function selectTaskScope(input: {
  inputId: string;
  markdown: string;
  expression: string;
}): TaskScopeResult {
  const expression = input.expression.trim();
  if (!expression) {
    return {
      diagnostics: [
        {
          code: "invalid-scope-expression",
          message: "task scope expression cannot be empty",
        },
      ],
    };
  }

  const parsed = parseTaskArtifact(input.markdown);
  if (!parsed.valid) {
    return {
      diagnostics: [
        {
          code: "invalid-task-artifact",
          message: "task scope input is not a valid Nitely task artifact",
          artifactDiagnostics: parsed.diagnostics,
        },
      ],
    };
  }
  const byId = taskById(parsed);

  const range = RANGE_PATTERN.exec(expression);
  if (range) {
    const startId = normalizeTaskId(range[1]!);
    const endId = normalizeTaskId(range[2]!);
    const startIndex = parsed.tasks.findIndex((task) => task.id === startId);
    const endIndex = parsed.tasks.findIndex((task) => task.id === endId);
    if (startIndex < 0) {
      return {
        diagnostics: [
          { code: "unknown-task-id", taskId: startId, message: `unknown task id ${startId}` },
        ],
      };
    }
    if (endIndex < 0) {
      return {
        diagnostics: [
          { code: "unknown-task-id", taskId: endId, message: `unknown task id ${endId}` },
        ],
      };
    }
    const [from, to] =
      startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "range",
        parsed,
        selectedTasks: parsed.tasks.slice(from, to + 1),
      }),
      diagnostics: [],
    };
  }

  if (expression.includes(",")) {
    const ids = expression.split(",").map(normalizeTaskId).filter(Boolean);
    if (ids.length === 0 || ids.some((id) => !TASK_ID_PATTERN.test(id))) {
      return {
        diagnostics: [
          {
            code: "invalid-scope-expression",
            message: "explicit task scope must be a comma-separated list of task ids",
          },
        ],
      };
    }
    const missing = ids.find((id) => !byId.has(id));
    if (missing) {
      return {
        diagnostics: [
          { code: "unknown-task-id", taskId: missing, message: `unknown task id ${missing}` },
        ],
      };
    }
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "ids",
        parsed,
        selectedTasks: ids.map((id) => byId.get(id)!),
      }),
      diagnostics: [],
    };
  }

  const singleId = normalizeTaskId(expression);
  if (TASK_ID_PATTERN.test(singleId)) {
    const task = byId.get(singleId);
    if (!task) {
      return {
        diagnostics: [
          { code: "unknown-task-id", taskId: singleId, message: `unknown task id ${singleId}` },
        ],
      };
    }
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "ids",
        parsed,
        selectedTasks: [task],
      }),
      diagnostics: [],
    };
  }

  const next = NEXT_PATTERN.exec(expression);
  if (next) {
    const count = next[1] ? Number.parseInt(next[1], 10) : 1;
    if (!Number.isInteger(count) || count <= 0) {
      return {
        diagnostics: [
          {
            code: "invalid-scope-expression",
            message: "next unchecked task scope count must be a positive integer",
          },
        ],
      };
    }
    const selectedTasks = parsed.tasks.filter((task) => !task.completed).slice(0, count);
    if (selectedTasks.length === 0) {
      return {
        diagnostics: [
          {
            code: "empty-scope",
            message: "task scope selected no unchecked tasks",
          },
        ],
      };
    }
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "next-unchecked",
        parsed,
        selectedTasks,
      }),
      diagnostics: [],
    };
  }

  const storyId = normalizeStoryId(expression);
  if (STORY_ID_PATTERN.test(storyId)) {
    const selectedTasks = parsed.tasks.filter(
      (task) => task.storyId?.toUpperCase() === storyId,
    );
    if (selectedTasks.length === 0) {
      return {
        diagnostics: [
          { code: "empty-scope", message: `task scope selected no tasks for story ${storyId}` },
        ],
      };
    }
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "story",
        parsed,
        selectedTasks,
      }),
      diagnostics: [],
    };
  }

  const phaseName = expression.toLowerCase();
  const selectedTasks = parsed.tasks.filter(
    (task) => task.phase?.toLowerCase() === phaseName || phaseMatches(task.phase, expression),
  );
  if (selectedTasks.length > 0) {
    return {
      selection: selectionForTasks({
        inputId: input.inputId,
        expression,
        kind: "phase",
        parsed,
        selectedTasks,
      }),
      diagnostics: [],
    };
  }

  return {
    diagnostics: [
      {
        code: "empty-scope",
        message: `task scope selected no tasks for "${expression}"`,
      },
    ],
  };
}

export function renderScopedTaskArtifact(selection: TaskScopeSelection): string {
  const lines = [
    "# Scoped Tasks",
    "",
    `Source input: ${selection.inputId}`,
    `Scope: ${selection.expression}`,
    `Scope kind: ${selection.kind}`,
    `Selected tasks: ${selection.selectedTaskIds.join(", ")}`,
    `Source task count: ${selection.sourceTaskCount}`,
    `Completion state source: selected task checkboxes at run start`,
    "",
  ];
  let currentPhase: string | undefined;
  for (const task of selection.selectedTasks) {
    if (task.phase && task.phase !== currentPhase) {
      currentPhase = task.phase;
      lines.push(`## ${task.phase}`, "");
    }
    lines.push(task.raw);
  }
  lines.push("");
  return lines.join("\n");
}
