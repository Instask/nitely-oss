import { describe, expect, it } from "vitest";

import { buildManagerDashboard } from "../../src/web/dashboard.js";
import type { WebRunSummary } from "../../src/web/runs.js";
import type { WorkItemView } from "../../src/web/work-item-views.js";

describe("manager dashboard projection", () => {
  it("aggregates workflow health without ranking people", () => {
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-23T12:00:00.000Z"),
      repositories: [
        {
          id: "repo-a",
          name: "Repo A",
          path: "/repos/a",
          defaultBranch: "main",
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Blocked checkout",
          status: "failed",
          displayStatus: "blocked",
          workItemType: "dev.pr",
          flowPath: "flows/implement-spec-bootstrap.json",
          inputs: {},
          repoId: "repo-a",
          repoName: "Repo A",
          ownerId: "user-a",
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-22T12:00:00.000Z",
          updatedAt: "2026-06-22T12:00:00.000Z",
        } as WorkItemView & { repoName: string },
        {
          id: "task-2",
          title: "Ready work",
          status: "ready",
          workItemType: "dev.pr",
          flowPath: "flows/implement-spec-bootstrap.json",
          inputs: {},
          repoId: "repo-a",
          repoName: "Repo A",
          runCount: 0,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-23T11:00:00.000Z",
          updatedAt: "2026-06-23T11:00:00.000Z",
        } as WorkItemView & { repoName: string },
      ],
      runs: [
        {
          runId: "run-1",
          sessionId: "run-1",
          status: "completed",
          repoId: "repo-a",
          repoName: "Repo A",
          flowName: "implement",
          completedStages: ["implement", "review"],
          inputs: {},
          startedAt: "2026-06-23T10:00:00.000Z",
          completedAt: "2026-06-23T10:10:00.000Z",
          runtimeUsage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCostUsd: 0.03,
            knownAttempts: 1,
            unknownAttempts: 0,
          },
          contextUsage: {
            promptBytes: 1200,
            approxTokens: 300,
            inputBytesInlined: 800,
            inputBytesSaved: 400,
            inputCount: 2,
          },
        } as WebRunSummary,
        {
          runId: "run-2",
          sessionId: "run-2",
          status: "blocked",
          repoId: "repo-a",
          repoName: "Repo A",
          flowName: "implement",
          completedStages: [],
          inputs: {},
          startedAt: "2026-06-23T08:00:00.000Z",
          blocker: { reason: "usage-limit", message: "provider limit" },
        } as WebRunSummary,
      ],
    });

    expect(dashboard.throughput.queuedTasks).toBe(1);
    expect(dashboard.throughput.blockedItems).toBe(2);
    expect(dashboard.cost).toMatchObject({
      runtimeTokens: 150,
      contextTokens: 300,
      estimatedCostUsd: 0.03,
      knownRuntimeAttempts: 1,
      unknownRuntimeAttempts: 0,
    });
    expect(dashboard.outcomes.completionRate).toBe(0.5);
    expect(dashboard.outcomes.reviewGatePassRate).toBe(1);
    expect(dashboard.repositories[0]).toMatchObject({
      repoId: "repo-a",
      taskCount: 2,
      runCount: 2,
      blockedCount: 2,
      runtimeTokens: 150,
    });
    expect(dashboard.blocked.map((item) => item.ownerId)).toContain("user-a");
    expect(JSON.stringify(dashboard)).not.toMatch(/ranking|leaderboard|productivity/i);
  });
});
