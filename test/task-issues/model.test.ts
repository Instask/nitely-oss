import { describe, expect, it } from "vitest";

import type { RepositoryIssue } from "../../src/scm/types.js";
import { parseTaskArtifact } from "../../src/task-artifacts/parse.js";
import {
  TaskIssueConflictError,
  buildTaskIssueGroups,
  claimedTaskIds,
  planTaskIssues,
  type TaskIssueGrouping,
} from "../../src/task-issues/model.js";

const markdown = `# Tasks

## Phase 1: Foundation

- [x] T001 [P] Create parser in \`src/parser.ts\`
- [ ] T002 [US-001] Verify parser in \`test/parser.test.ts\` (depends: T001)

## Phase 2: Release

- [ ] T003 Ship parser
`;

const sources = {
  commit: "abc123",
  commitUrl: "https://github.com/Instask/nitely/commit/abc123",
  tasks: {
    path: "docs/tasks.md",
    url: "https://github.com/Instask/nitely/blob/abc123/docs/tasks.md",
  },
  spec: {
    path: "docs/spec.md",
    url: "https://github.com/Instask/nitely/blob/abc123/docs/spec.md",
  },
  plan: {
    path: "docs/plan.md",
    url: "https://github.com/Instask/nitely/blob/abc123/docs/plan.md",
  },
};

function groups(grouping: TaskIssueGrouping) {
  return buildTaskIssueGroups({
    parsed: parseTaskArtifact(markdown),
    grouping,
    sources,
  });
}

function issue(input: {
  number: number;
  title: string;
  body?: string;
  state?: "open" | "closed";
}): RepositoryIssue {
  return {
    provider: "github",
    owner: "Instask",
    repository: "nitely",
    number: input.number,
    url: `https://github.com/Instask/nitely/issues/${input.number}`,
    title: input.title,
    body: input.body ?? "",
    state: input.state ?? "open",
  };
}

describe("task issue model", () => {
  it("builds canonical per-task issues with source and task metadata", () => {
    const result = groups("task");

    expect(result.map((group) => group.title)).toEqual([
      "T001: Create parser in `src/parser.ts`",
      "T002: Verify parser in `test/parser.test.ts` (depends: T001)",
      "T003: Ship parser",
    ]);
    expect(result[0]?.body).toContain("<!-- nitely-task-ids:v1 T001 -->");
    expect(result[0]?.body).toContain("[`T001`](https://github.com/Instask/nitely/blob/abc123/docs/tasks.md#L5)");
    expect(result[0]?.body).toContain("- Parallel: yes");
    expect(result[1]?.body).toContain("- Story: US-001");
    expect(result[1]?.body).toContain("- Dependencies: T001");
    expect(result[1]?.body).toContain("`test/parser.test.ts`");
    expect(result[1]?.body).toContain("[`docs/spec.md`](https://github.com/Instask/nitely/blob/abc123/docs/spec.md)");
  });

  it("groups tasks by phase with one stable marker per group", () => {
    const result = groups("phase");

    expect(result.map((group) => ({ title: group.title, taskIds: group.taskIds }))).toEqual([
      {
        title: "T001: Phase 1: Foundation (2 tasks)",
        taskIds: ["T001", "T002"],
      },
      { title: "T003: Phase 2: Release (1 task)", taskIds: ["T003"] },
    ]);
    expect(result[0]?.body).toContain("<!-- nitely-task-ids:v1 T001,T002 -->");
    expect(result[0]?.body).toContain("- Grouping: phase");
  });

  it("reuses open or closed canonical issues and ignores incidental task mentions", () => {
    const existing = [
      issue({ number: 10, title: "T001: Existing parser", state: "closed" }),
      issue({
        number: 11,
        title: "General discussion",
        body: "T002 is mentioned, but this issue does not claim it.",
      }),
    ];
    const plan = planTaskIssues({ groups: groups("task"), existingIssues: existing });

    expect(plan.entries.map((entry) => [entry.group.taskIds, entry.outcome, entry.issue?.number])).toEqual([
      [["T001"], "reuse", 10],
      [["T002"], "create", undefined],
      [["T003"], "create", undefined],
    ]);
  });

  it("reuses one grouped issue for each covered task in task mode", () => {
    const grouped = issue({
      number: 20,
      title: "T001: Foundation (2 tasks)",
      body: "<!-- nitely-task-ids:v1 T001,T002 -->",
    });
    const plan = planTaskIssues({ groups: groups("task"), existingIssues: [grouped] });

    expect(plan.entries.slice(0, 2).map((entry) => entry.issue?.number)).toEqual([20, 20]);
    expect(claimedTaskIds(grouped)).toEqual(["T001", "T002"]);
  });

  it("aborts the complete plan for partial, split, or duplicate claims", () => {
    const phaseGroups = groups("phase");
    for (const existingIssues of [
      [issue({ number: 30, title: "T001: Only one task" })],
      [
        issue({ number: 31, title: "T001: First task" }),
        issue({ number: 32, title: "T002: Second task" }),
      ],
      [
        issue({ number: 33, title: "T001: First claim" }),
        issue({ number: 34, title: "T001: Duplicate claim" }),
      ],
    ]) {
      expect(() =>
        planTaskIssues({ groups: phaseGroups, existingIssues }),
      ).toThrow(TaskIssueConflictError);
    }
  });

  it("rejects malformed machine markers instead of silently creating duplicates", () => {
    expect(() =>
      claimedTaskIds(
        issue({
          number: 40,
          title: "Task tracking",
          body: "<!-- nitely-task-ids:v1 T001, T002 -->",
        }),
      ),
    ).toThrow("malformed Nitely task ID marker");
    expect(() =>
      claimedTaskIds(
        issue({
          number: 41,
          title: "Task tracking",
          body: [
            "<!-- nitely-task-ids:v1 T001 -->",
            "<!-- nitely-task-ids:v1 T002 -->",
          ].join("\n"),
        }),
      ),
    ).toThrow("malformed Nitely task ID marker");
  });
});
