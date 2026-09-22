import { describe, expect, it } from "vitest";

import {
  detectCycle,
  evaluateTaskGraph,
  selectRunnableTasks,
  wouldCreateCycle,
} from "../../src/scheduler/graph.js";
import type { TaskRecord } from "../../src/web/tasks.js";

function task(
  id: string,
  patch: Partial<TaskRecord> = {},
): TaskRecord {
  const createdAt = patch.createdAt ?? `2026-06-26T00:00:0${id.length}.000Z`;
  return {
    id,
    title: id,
    status: "ready",
    flowPath: "flows/implement-spec-bootstrap.json",
    specPath: `.nitely/tasks/${id}/spec.md`,
    techDesignPath: `.nitely/tasks/${id}/tech-design.md`,
    createdAt,
    updatedAt: patch.updatedAt ?? createdAt,
    ...patch,
  };
}

describe("task graph scheduler", () => {
  it("blocks tasks on missing, failed, and incomplete upstream dependencies", () => {
    const tasks = [
      task("spec", { status: "completed" }),
      task("design", { dependsOn: ["spec", "missing"] }),
      task("impl", { dependsOn: ["design"] }),
      task("qa", { dependsOn: ["failed"] }),
      task("failed", { status: "failed" }),
    ];

    const graph = evaluateTaskGraph(tasks, {
      isTaskComplete: (id) => id === "spec",
    });

    expect(graph.get("design")?.blockedReasons).toEqual([
      { kind: "missing", upstreamId: "missing" },
    ]);
    expect(graph.get("impl")?.blockedReasons).toEqual([
      { kind: "incomplete", upstreamId: "design" },
    ]);
    expect(graph.get("qa")?.blockedReasons).toEqual([
      { kind: "failed", upstreamId: "failed" },
    ]);
  });

  it("excludes suggested dependencies from scheduling decisions", () => {
    const graph = evaluateTaskGraph(
      [
        task("upstream", { status: "failed" }),
        task("downstream", {
          suggestedDependencies: [
            {
              dependsOn: "upstream",
              reason: "looks related",
              confidence: 0.8,
              source: "agent",
              suggestedAt: "2026-06-26T00:00:00.000Z",
            },
          ],
        }),
      ],
      { isTaskComplete: () => false },
    );

    expect(graph.get("downstream")?.blockedReasons).toEqual([]);
  });

  it("detects real dependency cycles and ignores missing upstream phantom edges", () => {
    expect(
      detectCycle([
        task("a", { dependsOn: ["b"] }),
        task("b", { dependsOn: ["c"] }),
        task("c", { dependsOn: ["a"] }),
      ]),
    ).toEqual(["a", "b", "c", "a"]);

    expect(
      detectCycle([
        task("a", { dependsOn: ["missing"] }),
        task("b", { dependsOn: ["a"] }),
      ]),
    ).toBeUndefined();
  });

  it("checks whether confirming a suggestion would create a cycle", () => {
    const tasks = [
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["c"] }),
      task("c"),
    ];

    expect(wouldCreateCycle(tasks, "c", "a")).toBe(true);
    expect(wouldCreateCycle(tasks, "c", "missing")).toBe(false);
  });

  it("selects ready runnable tasks by priority and creation time", () => {
    const tasks = [
      task("p2-old", { priority: "P2", createdAt: "2026-06-26T00:00:00.000Z" }),
      task("p0", { priority: "P0", createdAt: "2026-06-26T00:03:00.000Z" }),
      task("draft", { status: "draft", priority: "P0" }),
      task("blocked", { priority: "P0", dependsOn: ["p2-old"] }),
      task("p1", { priority: "P1", createdAt: "2026-06-26T00:01:00.000Z" }),
      task("p2-new", { priority: "P2", createdAt: "2026-06-26T00:02:00.000Z" }),
    ];

    const runnable = selectRunnableTasks(tasks, {
      isTaskComplete: () => false,
    });

    expect(runnable.map((item) => item.task.id)).toEqual([
      "p0",
      "p1",
      "p2-old",
      "p2-new",
    ]);
  });
});
