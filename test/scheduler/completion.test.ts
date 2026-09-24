import { describe, expect, it } from "vitest";

import { createCompletionPredicate } from "../../src/scheduler/completion.js";
import type { ChangeRequestStatus } from "../../src/scm/types.js";
import type { TaskRecord } from "../../src/web/tasks.js";

function task(
  id: string,
  patch: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    title: id,
    status: "ready",
    flowPath: "flows/implement-spec-bootstrap.json",
    specPath: `.nitely/tasks/${id}/spec.md`,
    techDesignPath: `.nitely/tasks/${id}/tech-design.md`,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...patch,
  };
}

describe("completion predicate", () => {
  it("treats completed tasks as complete only when their change request is merged", async () => {
    const calls: string[] = [];
    const predicate = await createCompletionPredicate(
      [
        task("merged", {
          status: "completed",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/10",
        }),
        task("closed", {
          status: "completed",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/11",
        }),
        task("running", {
          status: "running",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/12",
        }),
      ],
      async (url): Promise<ChangeRequestStatus> => {
        calls.push(url);
        return { provider: "github", state: "closed", merged: url.endsWith("/10") };
      },
    );

    expect(predicate("merged")).toBe(true);
    expect(predicate("closed")).toBe(false);
    expect(predicate("running")).toBe(false);
    expect(calls).toEqual([
      "https://github.com/Instask/nitely/pull/10",
      "https://github.com/Instask/nitely/pull/11",
    ]);
  });

  it("degrades safely when GitHub status cannot be reached", async () => {
    const predicate = await createCompletionPredicate(
      [
        task("done", {
          status: "completed",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/10",
        }),
      ],
      async () => {
        throw new Error("network unavailable");
      },
    );

    expect(predicate("done")).toBe(false);
  });
});
