import { describe, expect, it } from "vitest";

import {
  detectCycle,
  wouldCreateCycle,
} from "../../src/scheduler/graph.js";
import type { TaskRecord } from "../../src/work-items/adapters/dev-pr-store.js";

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

describe("task dependency cycles", () => {
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
});
