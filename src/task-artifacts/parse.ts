export interface ParsedTask {
  id: string;
  line: number;
  title: string;
  completed: boolean;
  parallel: boolean;
  storyId?: string;
  phase?: string;
  dependencies: string[];
  paths: string[];
  raw: string;
}

export interface ParsedTaskPhase {
  name: string;
  line: number;
  storyId?: string;
}

export type TaskArtifactDiagnosticCode =
  | "duplicate-task-id"
  | "missing-task-id"
  | "malformed-task-line";

export interface TaskArtifactDiagnostic {
  code: TaskArtifactDiagnosticCode;
  line: number;
  message: string;
  taskId?: string;
}

export interface ParsedTaskArtifact {
  valid: boolean;
  tasks: ParsedTask[];
  phases: ParsedTaskPhase[];
  diagnostics: TaskArtifactDiagnostic[];
}

const TASK_ID_PATTERN = /\bT\d{3}\b/;
const TASK_ID_GLOBAL_PATTERN = /\bT\d{3}\b/g;
const STORY_ID_PATTERN = /\bUS-\d{3}\b/;
const CHECKBOX_TASK_PATTERN = /^-\s+\[( |x|X)\]\s+(.*)$/;
const HEADING_PATTERN = /^(#{2,4})\s+(.+?)\s*$/;
const PHASE_HEADING_NAME_PATTERN = /^Phase(?:\s+\d+)?(?:\b|:)/i;
const DEPENDENCY_PATTERN = /\((?:depends|dependencies|after):\s*([^)]+)\)/i;
const MARKER_PATTERN = /^\[[^\]]+\]\s*/;
const BACKTICK_PATTERN = /`([^`]+)`/g;

export const taskArtifactTemplate = `# Tasks

## Canonical Inputs

- Spec: \`path/to/spec.md\` (trace: US-001, FR-001, SC-001)
- Technical design: \`path/to/tech-design.md\` (trace: PD-001)

## Phase 1: Setup

- [ ] T001 FR-001 SC-001 Create or update tests in \`test/path/to/file.test.ts\`
- [ ] T002 [P] FR-001 PD-001 Add supporting types in \`src/path/to/module.ts\` (depends: T001)

## Phase 2: User Story US-001 - Primary workflow

- [ ] T003 [US-001] FR-001 PD-001 Implement the workflow in \`src/path/to/module.ts\` (depends: T002)
- [ ] T004 [P] [US-001] SC-001 Add focused verification in \`test/path/to/file.test.ts\` (depends: T003)

## Phase 3: Verification

- [ ] T005 Run full checks and update task completion state (depends: T003,T004)

## Downstream Evidence

- Run evidence should cite consumed artifact paths plus relevant US-001,
  FR-001, SC-001, PD-001, and T001-style task IDs.
- PR evidence should cite the same IDs when summarizing scope, verification, and
  follow-up review findings.
`;

function headingPhase(line: string, lineNumber: number): ParsedTaskPhase | undefined {
  const match = HEADING_PATTERN.exec(line);
  if (!match) return undefined;
  const name = match[2]?.trim();
  if (!name) return undefined;
  if (!PHASE_HEADING_NAME_PATTERN.test(name)) return undefined;
  return {
    name,
    line: lineNumber,
    storyId: STORY_ID_PATTERN.exec(name)?.[0],
  };
}

function parseDependencies(text: string): string[] {
  const match = DEPENDENCY_PATTERN.exec(text);
  if (!match) return [];
  return [...match[1]!.matchAll(TASK_ID_GLOBAL_PATTERN)].map((entry) => entry[0]);
}

function parsePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(BACKTICK_PATTERN)) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (value.includes("/") || /\.[A-Za-z0-9]+$/.test(value)) {
      paths.push(value);
    }
  }
  return [...new Set(paths)];
}

function stripKnownMarkers(text: string): {
  title: string;
  parallel: boolean;
  storyId?: string;
} {
  let remaining = text.trim();
  let parallel = false;
  let storyId: string | undefined;
  while (true) {
    const marker = MARKER_PATTERN.exec(remaining);
    if (!marker) break;
    const value = marker[0].trim();
    if (value === "[P]") {
      parallel = true;
    } else {
      const story = STORY_ID_PATTERN.exec(value)?.[0];
      if (story) storyId = story;
    }
    remaining = remaining.slice(marker[0].length).trim();
  }
  return { title: remaining, parallel, storyId };
}

function parseTaskLine(input: {
  line: string;
  lineNumber: number;
  phase?: ParsedTaskPhase;
}): { task?: ParsedTask; diagnostic?: TaskArtifactDiagnostic } | undefined {
  const checkbox = CHECKBOX_TASK_PATTERN.exec(input.line);
  if (!checkbox) {
    if (input.line.startsWith("- ") && TASK_ID_PATTERN.test(input.line)) {
      return {
        diagnostic: {
          code: "malformed-task-line",
          line: input.lineNumber,
          message: "task line must use a Markdown checkbox such as '- [ ] T001 ...'",
        },
      };
    }
    return undefined;
  }

  const body = checkbox[2]!.trim();
  const id = TASK_ID_PATTERN.exec(body)?.[0];
  if (!id) {
    return {
      diagnostic: {
        code: "missing-task-id",
        line: input.lineNumber,
        message: "task line is missing a stable task id such as T001",
      },
    };
  }

  const afterId = body.slice(body.indexOf(id) + id.length).trim();
  const markers = stripKnownMarkers(afterId);
  return {
    task: {
      id,
      line: input.lineNumber,
      title: markers.title,
      completed: checkbox[1]?.toLowerCase() === "x",
      parallel: markers.parallel,
      storyId: markers.storyId ?? input.phase?.storyId,
      phase: input.phase?.name,
      dependencies: parseDependencies(body),
      paths: parsePaths(body),
      raw: input.line,
    },
  };
}

export function parseTaskArtifact(markdown: string): ParsedTaskArtifact {
  const tasks: ParsedTask[] = [];
  const phases: ParsedTaskPhase[] = [];
  const diagnostics: TaskArtifactDiagnostic[] = [];
  const seen = new Map<string, number>();
  let currentPhase: ParsedTaskPhase | undefined;

  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const phase = headingPhase(line, lineNumber);
    if (phase) {
      currentPhase = phase;
      phases.push(phase);
      return;
    }
    if (HEADING_PATTERN.test(line)) {
      currentPhase = undefined;
      return;
    }

    const parsed = parseTaskLine({ line, lineNumber, phase: currentPhase });
    if (!parsed) return;
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      return;
    }
    const task = parsed.task!;
    const firstSeen = seen.get(task.id);
    if (firstSeen !== undefined) {
      diagnostics.push({
        code: "duplicate-task-id",
        line: task.line,
        taskId: task.id,
        message: `duplicate task id ${task.id}; first seen on line ${firstSeen}`,
      });
    } else {
      seen.set(task.id, task.line);
    }
    tasks.push(task);
  });

  return {
    valid: diagnostics.length === 0,
    tasks,
    phases,
    diagnostics,
  };
}

export function validateTaskArtifact(markdown: string): ParsedTaskArtifact {
  return parseTaskArtifact(markdown);
}
