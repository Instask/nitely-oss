import { describe, expect, it } from "vitest";

import {
  nextPendingTask,
  parseTaskPlanJson,
  taskPlanProgress,
} from "../../src/task-artifacts/plan.js";

describe("task plan artifacts", () => {
  it("parses ordered JSON task plans and selects the next dependency-ready task", () => {
    const plan = parseTaskPlanJson(
      JSON.stringify({
        version: "nitely.task-plan.v1",
        max_iterations: 3,
        tasks: [
          { id: "T001", title: "Done", status: "completed" },
          {
            id: "T002",
            title: "Next",
            status: "pending",
            dependencies: ["T001"],
            paths: ["src/next.ts"],
          },
          {
            id: "T003",
            title: "Later",
            status: "pending",
            dependencies: ["T002"],
          },
        ],
      }),
    );

    expect(plan.valid).toBe(true);
    expect(plan.maxIterations).toBe(3);
    expect(nextPendingTask(plan, ["T001"])).toMatchObject({
      id: "T002",
      title: "Next",
    });
    expect(taskPlanProgress(plan, ["T001"], "T002")).toMatchObject({
      completedTaskIds: ["T001"],
      remainingTaskIds: ["T002", "T003"],
      completedCount: 1,
      remainingCount: 2,
      totalTaskCount: 3,
    });
  });

  it("reports invalid task-plan JSON with actionable diagnostics", () => {
    const plan = parseTaskPlanJson(
      JSON.stringify({
        max_iterations: 0,
        tasks: [
          { id: "T001", title: "One" },
          { id: "T001", title: "Duplicate" },
          { title: "Missing id" },
        ],
      }),
    );

    expect(plan.valid).toBe(false);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid-max-iterations",
      "duplicate-task-id",
      "missing-task-id",
    ]);
  });
});
