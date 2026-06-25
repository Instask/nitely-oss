import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseTaskArtifact,
  taskArtifactTemplate,
  validateTaskArtifact,
} from "../../src/task-artifacts/parse.js";

describe("task breakdown artifacts", () => {
  it("parses phase headings, task metadata, dependencies, paths, and completion state", () => {
    const parsed = parseTaskArtifact(`# Tasks

## Phase 1: Setup

- [x] T001 [P] Create parser tests in \`test/task-artifacts/parse.test.ts\`
- [ ] T002 Add parser in \`src/task-artifacts/parse.ts\` (depends: T001)

## Phase 2: User Story US-001 - Scoped runs

- [ ] T003 [US-001] Parse explicit story marker in \`src/task-artifacts/parse.ts\` (depends: T002)
- [ ] T004 [P] Use inherited story phase in \`src/run/run-flow.ts\` (depends: T002,T003)
`);

    expect(parsed.valid).toBe(true);
    expect(parsed.tasks).toHaveLength(4);
    expect(parsed.tasks[0]).toMatchObject({
      id: "T001",
      completed: true,
      parallel: true,
      phase: "Phase 1: Setup",
      storyId: undefined,
      paths: ["test/task-artifacts/parse.test.ts"],
    });
    expect(parsed.tasks[2]).toMatchObject({
      id: "T003",
      completed: false,
      parallel: false,
      phase: "Phase 2: User Story US-001 - Scoped runs",
      storyId: "US-001",
      dependencies: ["T002"],
      paths: ["src/task-artifacts/parse.ts"],
    });
    expect(parsed.tasks[3]).toMatchObject({
      id: "T004",
      storyId: "US-001",
      dependencies: ["T002", "T003"],
    });
    expect(parsed.phases.map((phase) => phase.name)).toEqual([
      "Phase 1: Setup",
      "Phase 2: User Story US-001 - Scoped runs",
    ]);
  });

  it("reports duplicate, missing, and malformed task IDs", () => {
    const parsed = validateTaskArtifact(`# Tasks

## Phase 1: Setup

- [ ] T001 First task
- [ ] Missing stable id
- T002 Missing checkbox
- [x] T001 Duplicate task
`);

    expect(parsed.valid).toBe(false);
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-task-id", line: 6 }),
        expect.objectContaining({ code: "malformed-task-line", line: 7 }),
        expect.objectContaining({ code: "duplicate-task-id", taskId: "T001" }),
      ]),
    );
  });

  it("exports a Markdown-first task artifact template", () => {
    expect(taskArtifactTemplate).toContain("T001");
    expect(taskArtifactTemplate).toContain("[P]");
    expect(taskArtifactTemplate).toContain("[US-001]");
    expect(taskArtifactTemplate).toContain("depends:");
  });

  it("ships a docs template with parseable task metadata", async () => {
    const template = await readFile(
      join(process.cwd(), "docs/templates/nitely-tasks.md"),
      "utf8",
    );
    const parsed = parseTaskArtifact(template);
    expect(parsed.valid).toBe(true);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(parsed.tasks.some((task) => task.parallel)).toBe(true);
    expect(parsed.tasks.some((task) => task.storyId === "US-001")).toBe(true);
  });
});
