import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ScmRepository } from "../../src/scm/types.js";
import {
  parseTaskIssueRegistry,
  readTaskIssueRegistry,
  taskIssueScope,
  writeTaskIssueRegistry,
  type TaskIssueBinding,
} from "../../src/task-issues/registry.js";

const repository: ScmRepository = {
  provider: "github",
  owner: "Instask",
  repository: "nitely",
  url: "https://github.com/Instask/nitely",
};
const commit = "a".repeat(40);

function binding(taskId: string, issueNumber: number): TaskIssueBinding {
  return {
    taskId,
    issueNumber,
    issueUrl: `https://github.com/Instask/nitely/issues/${issueNumber}`,
    issueTitle: `${taskId}: Task`,
    issueState: issueNumber % 2 === 0 ? "closed" : "open",
    source: {
      commit,
      tasksPath: "docs/tasks.md",
      specPath: "docs/spec.md",
      planPath: "docs/plan.md",
    },
    syncedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("task issue registry", () => {
  it("atomically merges bindings and replaces current task IDs", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-task-issue-registry-"));
    await writeTaskIssueRegistry({
      repoPath,
      repository,
      bindings: [binding("T001", 1), binding("T002", 2)],
    });
    await writeTaskIssueRegistry({
      repoPath,
      repository,
      bindings: [binding("T002", 20), binding("T003", 3)],
    });

    await expect(readTaskIssueRegistry(repoPath)).resolves.toMatchObject({
      schemaVersion: "nitely.task-issues.v1",
      repository,
      bindings: [
        { taskId: "T001", issueNumber: 1 },
        { taskId: "T002", issueNumber: 20 },
        { taskId: "T003", issueNumber: 3 },
      ],
    });

    await writeTaskIssueRegistry({
      repoPath,
      repository,
      bindings: [
        {
          ...binding("T004", 30),
          issueTitle: "T004: Grouped issue before rename",
        },
        {
          ...binding("T005", 30),
          issueTitle: "T004: Grouped issue before rename",
        },
      ],
    });
    await writeTaskIssueRegistry({
      repoPath,
      repository,
      bindings: [
        {
          ...binding("T004", 30),
          issueTitle: "T004: Grouped issue after rename",
        },
      ],
    });
    const renamed = await readTaskIssueRegistry(repoPath);
    expect(renamed?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "T004",
          issueTitle: "T004: Grouped issue after rename",
        }),
        expect.objectContaining({
          taskId: "T005",
          issueTitle: "T004: Grouped issue after rename",
        }),
      ]),
    );
  });

  it("resolves one scoped issue for grouped tasks and reports missing IDs", () => {
    const registry = parseTaskIssueRegistry({
      schemaVersion: "nitely.task-issues.v1",
      repository,
      bindings: [
        binding("T001", 10),
        { ...binding("T002", 10), issueTitle: "T001: Task" },
      ],
    });

    expect(
      taskIssueScope({
        registry,
        repository,
        taskIds: ["T002", "T001", "T999", "T002"],
      }),
    ).toEqual({
      issues: [
        {
          issueNumber: 10,
          issueUrl: "https://github.com/Instask/nitely/issues/10",
          issueTitle: "T001: Task",
          issueState: "closed",
          taskIds: ["T002", "T001"],
        },
      ],
      missingTaskIds: ["T999"],
    });
  });

  it("rejects repository mismatches, unsafe source paths, and forged issue URLs", () => {
    const base = {
      schemaVersion: "nitely.task-issues.v1",
      repository,
      bindings: [binding("T001", 1)],
    };
    const registry = parseTaskIssueRegistry(base);
    expect(() =>
      taskIssueScope({
        registry,
        repository: { ...repository, owner: "Other", url: "https://github.com/Other/nitely" },
        taskIds: ["T001"],
      }),
    ).toThrow("does not match configured repository");
    expect(() =>
      parseTaskIssueRegistry({
        ...base,
        bindings: [{ ...binding("T001", 1), source: { ...binding("T001", 1).source, tasksPath: "../outside.md" } }],
      }),
    ).toThrow("must stay inside the repository");
    expect(() =>
      parseTaskIssueRegistry({
        ...base,
        bindings: [{ ...binding("T001", 1), issueUrl: "https://github.com/Other/nitely/issues/1" }],
      }),
    ).toThrow("does not match its configured repository");
    expect(() =>
      parseTaskIssueRegistry({
        ...base,
        bindings: [
          binding("T001", 1),
          { ...binding("T002", 1), issueTitle: "T002: Conflicting metadata" },
        ],
      }),
    ).toThrow("inconsistent metadata for issue #1");
  });
});
