import { describe, expect, it } from "vitest";

import {
  renderScopedTaskArtifact,
  selectTaskScope,
} from "../../src/task-artifacts/scope.js";

const markdown = `# Tasks

## Phase 1: Foundation

- [x] T001 Create failing tests in \`test/foundation.test.ts\`
- [ ] T002 Implement foundation in \`src/foundation.ts\` (depends: T001)

## Phase 2: User Story US-001 - Primary workflow

- [ ] T003 [US-001] Implement primary workflow in \`src/workflow.ts\` (depends: T002)
- [ ] T004 [US-001] Verify primary workflow in \`test/workflow.test.ts\` (depends: T003)

## Phase 3: Verification

- [ ] T005 Run full checks (depends: T003,T004)
`;

describe("task scope selection", () => {
  it("selects task ranges by artifact order", () => {
    const result = selectTaskScope({
      inputId: "tasks",
      markdown,
      expression: "T002-T004",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.selection?.kind).toBe("range");
    expect(result.selection?.selectedTaskIds).toEqual(["T002", "T003", "T004"]);
  });

  it("selects explicit task IDs and preserves requested order", () => {
    const result = selectTaskScope({
      inputId: "tasks",
      markdown,
      expression: "T004,T002",
    });

    expect(result.selection?.kind).toBe("ids");
    expect(result.selection?.selectedTaskIds).toEqual(["T004", "T002"]);
  });

  it("selects by phase and story", () => {
    expect(
      selectTaskScope({
        inputId: "tasks",
        markdown,
        expression: "Foundation",
      }).selection?.selectedTaskIds,
    ).toEqual(["T001", "T002"]);
    expect(
      selectTaskScope({
        inputId: "tasks",
        markdown,
        expression: "US-001",
      }).selection?.selectedTaskIds,
    ).toEqual(["T003", "T004"]);
  });

  it("selects the next unchecked window", () => {
    const result = selectTaskScope({
      inputId: "tasks",
      markdown,
      expression: "next:2",
    });

    expect(result.selection?.kind).toBe("next-unchecked");
    expect(result.selection?.selectedTaskIds).toEqual(["T002", "T003"]);
  });

  it("fails unknown or empty scopes before producing a selection", () => {
    expect(
      selectTaskScope({
        inputId: "tasks",
        markdown,
        expression: "T999",
      }).diagnostics,
    ).toEqual([expect.objectContaining({ code: "unknown-task-id" })]);
    expect(
      selectTaskScope({
        inputId: "tasks",
        markdown,
        expression: "Missing Phase",
      }).diagnostics,
    ).toEqual([expect.objectContaining({ code: "empty-scope" })]);
  });

  it("renders a scoped Markdown artifact for the agent prompt", () => {
    const selection = selectTaskScope({
      inputId: "tasks",
      markdown,
      expression: "T003-T004",
    }).selection!;

    const rendered = renderScopedTaskArtifact(selection);
    expect(rendered).toContain("Selected tasks: T003, T004");
    expect(rendered).toContain("- [ ] T003");
    expect(rendered).toContain("- [ ] T004");
    expect(rendered).not.toContain("- [x] T001");
    expect(rendered).not.toContain("- [ ] T005");
  });
});
