import { describe, expect, it } from "vitest";

import {
  SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE,
  generateDependencySuggestions,
  mergeDependencySuggestions,
  type DependencySuggestionRecord,
} from "../../src/scheduler/suggestions.js";
import type { SuggestedDependency } from "../../src/web/tasks.js";

function item(
  id: string,
  patch: Partial<DependencySuggestionRecord> = {},
): DependencySuggestionRecord {
  return {
    id,
    title: id,
    status: "ready",
    dependsOn: [],
    suggestedDependencies: [],
    createdAt: `2026-07-08T00:00:0${id.length}.000Z`,
    updatedAt: `2026-07-08T00:00:0${id.length}.000Z`,
    ...patch,
  };
}

function source(labels: string[], milestone?: string) {
  return {
    type: "github-issue" as const,
    uri: "https://github.com/Instask/nitely/issues/1",
    title: "Scheduler dependency work",
    snapshot: {
      uri: "https://github.com/Instask/nitely/issues/1",
      title: "Scheduler dependency work",
      body: "Body",
      fetchedAt: "2026-07-08T00:00:00.000Z",
      labels,
      ...(milestone ? { milestone } : {}),
    },
  };
}

describe("dependency suggestion generation", () => {
  it("suggests earlier related work and ignores future or confirmed candidates", () => {
    const suggestions = generateDependencySuggestions({
      subjectId: "rollout",
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      workItems: [
        item("foundation", {
          title: "Scheduler dependency foundation",
          status: "completed",
          source: source(["scheduler", "dependencies"], "M1"),
          createdAt: "2026-07-08T00:00:00.000Z",
        }),
        item("confirmed", {
          title: "Scheduler dependency confirmed",
          source: source(["scheduler", "dependencies"], "M1"),
          createdAt: "2026-07-08T00:00:10.000Z",
        }),
        item("future", {
          title: "Scheduler dependency future",
          source: source(["scheduler", "dependencies"], "M1"),
          createdAt: "2026-07-08T00:03:00.000Z",
        }),
        item("rollout", {
          title: "Scheduler dependency rollout",
          dependsOn: ["confirmed"],
          source: source(["scheduler", "dependencies"], "M1"),
          createdAt: "2026-07-08T00:02:00.000Z",
        }),
      ],
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        dependsOn: "foundation",
        source: SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE,
        suggestedAt: "2026-07-08T01:00:00.000Z",
      }),
    ]);
    expect(suggestions[0]?.confidence).toBeGreaterThan(0.5);
    expect(suggestions[0]?.reason).toContain("shares the same source issue");
  });

  it("drops suggestions that would create a cycle", () => {
    const suggestions = generateDependencySuggestions({
      subjectId: "c",
      workItems: [
        item("a", {
          dependsOn: ["b"],
          source: source(["scheduler"], "M1"),
          createdAt: "2026-07-08T00:00:00.000Z",
        }),
        item("b", {
          dependsOn: ["c"],
          source: source(["scheduler"], "M1"),
          createdAt: "2026-07-08T00:00:10.000Z",
        }),
        item("c", {
          source: source(["scheduler"], "M1"),
          createdAt: "2026-07-08T00:00:20.000Z",
        }),
      ],
    });

    expect(suggestions.map((suggestion) => suggestion.dependsOn)).not.toContain("a");
  });

  it("preserves manual suggestions while replacing stale generated ones", () => {
    const manual: SuggestedDependency = {
      dependsOn: "manual",
      reason: "operator suggestion",
      confidence: 0.9,
      source: "planner",
      suggestedAt: "2026-07-08T00:00:00.000Z",
    };
    const stale: SuggestedDependency = {
      dependsOn: "stale",
      reason: "old generated suggestion",
      confidence: 0.5,
      source: SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE,
      suggestedAt: "2026-07-08T00:00:00.000Z",
    };
    const generated: SuggestedDependency = {
      dependsOn: "fresh",
      reason: "new generated suggestion",
      confidence: 0.8,
      source: SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE,
      suggestedAt: "2026-07-08T01:00:00.000Z",
    };

    expect(mergeDependencySuggestions([manual, stale], [generated])).toEqual([
      manual,
      generated,
    ]);
  });
});
