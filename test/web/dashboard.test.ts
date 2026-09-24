import { describe, expect, it } from "vitest";

import { buildFactoryMetrics, buildManagerDashboard, buildMyWorkDashboard } from "../../src/web/dashboard.js";
import type { WebRunSummary } from "../../src/web/runs.js";
import type { WorkItemView } from "../../src/web/work-item-views.js";

describe("manager dashboard projection", () => {
  it("exposes durable factory funnel, attention, rework, and cost metrics with coverage", () => {
    const metrics = buildFactoryMetrics(
      [{ status: "ready" }, { status: "completed" }],
      [
        {
          runId: "run-1",
          sessionId: "run-1",
          status: "completed",
          completedStages: ["implement", "judge"],
          inputs: {},
          startedAt: "2026-09-18T00:00:00.000Z",
          completedAt: "2026-09-18T00:05:00.000Z",
          changeRequestUrl: "https://github.com/example/repo/pull/1",
          changeRequestStatus: {
            provider: "github",
            url: "https://github.com/example/repo/pull/1",
            state: "merged",
            merged: true,
          },
          runtimeUsage: {
            actualCostUsd: 1,
            knownAttempts: 1,
            unknownAttempts: 0,
          },
          factorySignals: {
            agentAttempts: 2,
            judgeAttempts: 2,
            ciRuns: 1,
            humanApprovalEvents: 1,
            humanApprovalWaitMs: 60_000,
          },
        } as WebRunSummary,
      ],
    );

    expect(metrics).toMatchObject({
      funnel: {
        candidate: 2,
        eligible: 2,
        queued: 1,
        runStarted: 1,
        prsCreated: 1,
        merged: 1,
        prToMergeRate: 1,
      },
      humanAttention: { approvalEvents: 1, approvalWaitMs: 60_000, humanTouchRate: 1 },
      rework: { agentAttempts: 2, judgeAttempts: 2, judgeReworkLoops: 1, ciRuns: 1 },
      cost: { runtimeCostUsd: 1, runtimeCostPerMergedPr: 1 },
      coverage: { mergeStatus: { status: "tracked" }, cost: { status: "tracked" } },
    });
  });

  it("excludes synthetic demo records from live management metrics", () => {
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-23T12:00:00.000Z"),
      repositories: [
        { id: "live", name: "Live repo", path: "/repos/live" },
        {
          id: "demo-golden-path",
          name: "Mocked golden path demo",
          path: "/repos/demo",
          synthetic: true,
        } as Parameters<typeof buildManagerDashboard>[0]["repositories"][number],
      ],
      tasks: [
        {
          id: "demo-task",
          title: "Mocked task",
          status: "ready",
          workItemType: "dev.pr",
          flowPath: "flows/golden-path.json",
          inputs: {},
          repoId: "demo-golden-path",
          repoName: "Mocked golden path demo",
          repoSynthetic: true,
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-23T10:00:00.000Z",
          updatedAt: "2026-06-23T10:01:00.000Z",
        } as WorkItemView & { repoSynthetic: boolean },
      ],
      runs: [
        {
          runId: "demo-run",
          sessionId: "demo-run",
          status: "completed",
          repoId: "demo-golden-path",
          repoName: "Mocked golden path demo",
          repoSynthetic: true,
          flowName: "golden-path",
          completedStages: ["review"],
          inputs: {},
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
          changeRequestStatus: {
            provider: "github",
            url: "https://github.com/Instask/nitely/pull/1",
            state: "closed",
            merged: true,
          },
        } as WebRunSummary & { repoSynthetic: boolean },
      ],
    });

    expect(dashboard).toMatchObject({
      taskCount: 0,
      runCount: 0,
      repositoryCount: 1,
      pilotRoi: {
        reviewablePrsCreated: 0,
        acceptedPrs: 0,
        mergedPrs: 0,
        estimatedCleanupMinutesAvoided: 0,
      },
    });
    expect(dashboard.repositories.map((repository) => repository.repoId)).toEqual([
      "live",
    ]);
    expect(dashboard.filters.repositories.map((repository) => repository.value)).toEqual([
      "live",
    ]);
  });

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
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
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
          changeRequestUrl: "https://github.com/Instask/nitely/pull/2",
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
      runtimeRunIds: ["run-1"],
      contextRunIds: ["run-1"],
      costRunIds: ["run-1"],
    });
    expect(dashboard.unitEconomics.costPerCompletedRun).toMatchObject({
      denominator: 1,
      coverage: { classification: "estimated" },
      evidenceRunIds: ["run-1"],
    });
    expect(JSON.stringify(dashboard.unitEconomics)).not.toContain("user-a");
    expect(dashboard.outcomes.completionRate).toBe(0.5);
    expect(dashboard.outcomes.reviewGatePassRate).toBe(1);
    expect(dashboard.outcomes).toMatchObject({
      completedRunIds: ["run-1"],
      blockedRunIds: ["run-2"],
      reviewGatePassedRunIds: ["run-1"],
    });
    expect(dashboard.pilotRoi).toMatchObject({
      reviewablePrsCreated: 2,
      acceptedPrs: 1,
      acceptanceRate: 0.5,
      averageCycleTimeMs: 10 * 60 * 1000,
      recoverableFailures: 1,
      evidenceCompletePrs: 1,
      evidenceCompletenessRate: 0.5,
      repeatedFlowCount: 0,
      estimatedCleanupMinutesAvoided: 45,
      reviewableRunIds: ["run-1", "run-2"],
      acceptedRunIds: ["run-1"],
      recoverableFailureRunIds: ["run-2"],
      evidenceCompleteRunIds: ["run-1"],
    });
    expect(dashboard.outcomeBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "reviewable-prs",
          tracking: "tracked",
          count: 2,
          runIds: ["run-1", "run-2"],
        }),
        expect.objectContaining({
          key: "accepted-prs",
          tracking: "tracked",
          count: 1,
          runIds: ["run-1"],
          description: expect.stringContaining("not merge state"),
        }),
        expect.objectContaining({
          key: "merged-prs",
          tracking: "not-tracked",
          runIds: [],
        }),
      ]),
    );
    expect(dashboard.repositories[0]).toMatchObject({
      repoId: "repo-a",
      taskCount: 2,
      runCount: 2,
      blockedCount: 2,
      runtimeTokens: 150,
      taskIds: ["task-1", "task-2"],
      runIds: ["run-1", "run-2"],
      blockedTaskIds: ["task-1"],
      blockedRunIds: ["run-2"],
      completedRunIds: ["run-1"],
    });
    expect(dashboard.flowTemplates).toEqual([
      expect.objectContaining({
        flowKey: "implement",
        flowName: "implement",
        runCount: 2,
        completedRuns: 1,
        blockedRuns: 1,
        reviewablePrsCreated: 2,
        acceptedPrs: 1,
        acceptanceRate: 0.5,
        evidenceCompletePrs: 1,
        evidenceCompletenessRate: 0.5,
        runIds: ["run-1", "run-2"],
        completedRunIds: ["run-1"],
        blockedRunIds: ["run-2"],
        reviewableRunIds: ["run-1", "run-2"],
        acceptedRunIds: ["run-1"],
        evidenceCompleteRunIds: ["run-1"],
      }),
    ]);
    expect(dashboard.throughput.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "ready", count: 1, taskIds: ["task-2"] }),
      ]),
    );
    expect(dashboard.throughput.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "completed", count: 1, runIds: ["run-1"] }),
        expect.objectContaining({ label: "blocked", count: 1, runIds: ["run-2"] }),
      ]),
    );
    expect(dashboard.lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ready-for-implementation", count: 1, taskIds: ["task-2"] }),
        expect.objectContaining({ key: "blocked", count: 2, taskIds: ["task-1"], runIds: ["run-2"] }),
        expect.objectContaining({ key: "draft-pr-created", count: 2, runIds: ["run-1", "run-2"] }),
        expect.objectContaining({ key: "completed", count: 1, runIds: ["run-1"] }),
      ]),
    );
    expect(dashboard.blocked.map((item) => item.ownerId)).toContain("user-a");
    expect(JSON.stringify(dashboard)).not.toMatch(/ranking|leaderboard|productivity/i);
  });

  it("separates stopped work and follow-up rework from PR merge state", () => {
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-24T12:00:00.000Z"),
      repositories: [],
      tasks: [
        {
          id: "task-stopped",
          title: "Stopped task",
          status: "failed",
          workItemType: "dev.pr",
          flowPath: "flows/implement.json",
          inputs: {},
          runCount: 0,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-24T09:00:00.000Z",
          updatedAt: "2026-06-24T09:30:00.000Z",
        } as WorkItemView,
      ],
      runs: [
        {
          runId: "run-accepted",
          sessionId: "run-accepted",
          status: "completed",
          completedStages: ["implement", "review"],
          inputs: {},
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
          startedAt: "2026-06-24T10:00:00.000Z",
          completedAt: "2026-06-24T10:10:00.000Z",
        } as WebRunSummary,
        {
          runId: "run-stopped",
          sessionId: "run-stopped",
          status: "failed",
          completedStages: [],
          inputs: {},
        } as WebRunSummary,
        {
          runId: "run-follow-up",
          sessionId: "run-follow-up",
          status: "blocked",
          completedStages: [],
          inputs: {},
          priorRunId: "run-accepted",
        } as WebRunSummary,
      ],
    });

    expect(dashboard.outcomeBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "accepted-prs",
          count: 1,
          runIds: ["run-accepted"],
        }),
        expect.objectContaining({
          key: "merged-prs",
          tracking: "not-tracked",
        }),
        expect.objectContaining({
          key: "stopped-work",
          count: 2,
          taskIds: ["task-stopped"],
          runIds: ["run-stopped"],
        }),
        expect.objectContaining({
          key: "follow-up-rework",
          count: 1,
          runIds: ["run-follow-up"],
        }),
      ]),
    );
  });

  it("deduplicates pull requests and reports merge rate with lookup coverage", () => {
    const mergedUrl = "https://github.com/Instask/nitely/pull/41";
    const openUrl = "https://github.com/Instask/nitely/pull/42";
    const unknownUrl = "https://github.com/Instask/nitely/pull/43";
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-24T12:00:00.000Z"),
      repositories: [],
      tasks: [],
      runs: [
        {
          runId: "run-original",
          sessionId: "run-original",
          status: "completed",
          repoId: "nitely",
          prNumber: 41,
          completedStages: ["implement", "review"],
          inputs: {},
          changeRequestUrl: mergedUrl,
          changeRequestStatus: {
            provider: "github",
            url: mergedUrl,
            state: "closed",
            merged: true,
          },
        } as WebRunSummary,
        {
          runId: "run-rework",
          sessionId: "run-rework",
          status: "completed",
          repoId: "nitely",
          prNumber: 41,
          completedStages: ["rework", "review"],
          inputs: {},
          priorRunId: "run-original",
          changeRequestUrl: `${mergedUrl}/files?diff=split#discussion_r1`,
          changeRequestStatus: {
            provider: "github",
            url: `${mergedUrl}/files?diff=split#discussion_r1`,
            state: "closed",
            merged: true,
          },
        } as WebRunSummary,
        {
          runId: "run-metadata-only",
          sessionId: "run-metadata-only",
          status: "completed",
          repoId: "nitely",
          prNumber: 41,
          completedStages: ["review"],
          inputs: {},
        } as WebRunSummary,
        {
          runId: "run-open",
          sessionId: "run-open",
          status: "completed",
          completedStages: ["implement", "review"],
          inputs: {},
          changeRequestUrl: openUrl,
          changeRequestStatus: {
            provider: "github",
            url: openUrl,
            state: "open",
            merged: false,
          },
        } as WebRunSummary,
        {
          runId: "run-unknown",
          sessionId: "run-unknown",
          status: "completed",
          completedStages: ["implement", "review"],
          inputs: {},
          changeRequestUrl: unknownUrl,
        } as WebRunSummary,
      ],
    });

    expect(dashboard.pilotRoi).toMatchObject({
      reviewablePrsCreated: 3,
      acceptedPrs: 3,
      acceptanceRate: 1,
      mergedPrs: 1,
      mergeStatusKnownPrs: 2,
      mergeRate: 0.5,
      mergeStatusCoverage: 2 / 3,
      reviewableRunIds: [
        "run-original",
        "run-rework",
        "run-metadata-only",
        "run-open",
        "run-unknown",
      ],
      mergedRunIds: ["run-original", "run-rework", "run-metadata-only"],
      mergeStatusKnownRunIds: ["run-original", "run-rework", "run-open"],
    });
    expect(dashboard.outcomeBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "merged-prs",
          tracking: "partial",
          count: 1,
          runIds: ["run-original", "run-rework", "run-metadata-only"],
          description: expect.stringContaining("2/3"),
        }),
      ]),
    );
  });

  it("keeps same-number pull requests from different GitHub repositories distinct", () => {
    const dashboard = buildManagerDashboard({
      repositories: [],
      tasks: [],
      runs: [
        {
          runId: "run-acme-one",
          sessionId: "run-acme-one",
          status: "completed",
          repoId: "local-monorepo",
          prNumber: 7,
          completedStages: ["review"],
          inputs: {},
          changeRequestUrl: "https://github.com/acme/one/pull/7",
          changeRequestStatus: {
            provider: "github",
            url: "https://github.com/acme/one/pull/7",
            state: "closed",
            merged: true,
          },
        } as WebRunSummary,
        {
          runId: "run-acme-two",
          sessionId: "run-acme-two",
          status: "completed",
          repoId: "local-monorepo",
          prNumber: 7,
          completedStages: ["review"],
          inputs: {},
          changeRequestUrl: "https://github.com/acme/two/pull/7",
          changeRequestStatus: {
            provider: "github",
            url: "https://github.com/acme/two/pull/7",
            state: "open",
            merged: false,
          },
        } as WebRunSummary,
      ],
    });

    expect(dashboard.pilotRoi).toMatchObject({
      reviewablePrsCreated: 2,
      acceptedPrs: 2,
      mergedPrs: 1,
      mergeStatusKnownPrs: 2,
      mergeRate: 0.5,
      mergeStatusCoverage: 1,
    });
  });

  it("filters dashboard scope while keeping filter options traceable to the full set", () => {
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-24T12:00:00.000Z"),
      repositories: [
        { id: "repo-a", name: "Repo A", path: "/repos/a", defaultBranch: "main" },
        { id: "repo-b", name: "Repo B", path: "/repos/b", defaultBranch: "main" },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Alpha",
          status: "ready",
          priority: "P1",
          workItemType: "dev.pr",
          flowPath: "flows/alpha.json",
          inputs: {},
          repoId: "repo-a",
          repoName: "Repo A",
          ownerId: "user-a",
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-23T09:00:00.000Z",
          updatedAt: "2026-06-23T09:00:00.000Z",
        } as WorkItemView & { repoName: string },
        {
          id: "task-b",
          title: "Beta",
          status: "failed",
          priority: "P2",
          workItemType: "dev.pr",
          flowPath: "flows/beta.json",
          inputs: {},
          repoId: "repo-b",
          repoName: "Repo B",
          ownerId: "user-b",
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-20T09:00:00.000Z",
          updatedAt: "2026-06-20T09:00:00.000Z",
        } as WorkItemView & { repoName: string },
      ],
      runs: [
        {
          runId: "run-a",
          sessionId: "run-a",
          status: "completed",
          repoId: "repo-a",
          repoName: "Repo A",
          ownerId: "user-a",
          flowName: "Alpha flow",
          flowPath: "flows/alpha.json",
          workItemId: "task-a",
          completedStages: ["implement", "review"],
          inputs: {},
          changeRequestUrl: "https://github.com/Instask/nitely/pull/10",
          startedAt: "2026-06-23T10:00:00.000Z",
          completedAt: "2026-06-23T10:30:00.000Z",
        } as WebRunSummary,
        {
          runId: "run-b",
          sessionId: "run-b",
          status: "blocked",
          repoId: "repo-b",
          repoName: "Repo B",
          ownerId: "user-b",
          flowName: "Beta flow",
          flowPath: "flows/beta.json",
          workItemId: "task-b",
          completedStages: [],
          inputs: {},
          startedAt: "2026-06-20T10:00:00.000Z",
          blocker: { reason: "usage-limit", message: "provider limit" },
        } as WebRunSummary,
      ],
      filters: {
        repo: "repo-a",
        flow: "flows/alpha.json",
        status: "completed",
        priority: "P1",
        owner: "user-a",
        window: "7d",
        start: "2026-06-23",
        end: "2026-06-23",
      },
    });

    expect(dashboard.taskCount).toBe(0);
    expect(dashboard.runCount).toBe(1);
    expect(dashboard.outcomes.completedRuns).toBe(1);
    expect(dashboard.outcomes.completionRate).toBe(1);
    expect(dashboard.pilotRoi.reviewableRunIds).toEqual(["run-a"]);
    expect(dashboard.flowTemplates).toEqual([
      expect.objectContaining({
        flowKey: "flows/alpha.json",
        runCount: 1,
        acceptedRunIds: ["run-a"],
      }),
    ]);
    expect(dashboard.filters.activeCount).toBe(8);
    expect(dashboard.filters.selected).toMatchObject({
      repo: "repo-a",
      flow: "flows/alpha.json",
      status: "completed",
      priority: "P1",
      owner: "user-a",
      window: "7d",
      start: "2026-06-23",
      end: "2026-06-23",
    });
    expect(dashboard.filters.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "repo-a", count: 2 }),
        expect.objectContaining({ value: "repo-b", count: 2 }),
      ]),
    );
    expect(dashboard.filters.flows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "flows/alpha.json", count: 2 }),
        expect.objectContaining({ value: "flows/beta.json", count: 2 }),
      ]),
    );
    expect(dashboard.filters.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "user-a", count: 2 }),
        expect.objectContaining({ value: "user-b", count: 2 }),
      ]),
    );
    expect(dashboard.filters.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "all", count: 4 }),
        expect.objectContaining({ value: "7d", count: 4 }),
      ]),
    );
  });

  it("scopes run priority by repository when work item ids match", () => {
    const dashboard = buildManagerDashboard({
      repositories: [
        { id: "repo-a", name: "Repo A", path: "/repos/a" },
        { id: "repo-b", name: "Repo B", path: "/repos/b" },
      ],
      tasks: [
        {
          id: "same-task",
          title: "Repo B task",
          status: "ready",
          priority: "P2",
          workItemType: "dev.pr",
          flowPath: "flows/implement.json",
          inputs: {},
          repoId: "repo-b",
          repoName: "Repo B",
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        } as WorkItemView & { repoName: string },
        {
          id: "same-task",
          title: "Repo A task",
          status: "ready",
          priority: "P1",
          workItemType: "dev.pr",
          flowPath: "flows/implement.json",
          inputs: {},
          repoId: "repo-a",
          repoName: "Repo A",
          runCount: 1,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        } as WorkItemView & { repoName: string },
      ],
      runs: [
        {
          runId: "repo-b-run",
          sessionId: "repo-b-run",
          status: "completed",
          repoId: "repo-b",
          repoName: "Repo B",
          workItemId: "same-task",
          completedStages: ["review"],
          inputs: {},
          changeRequestUrl: "https://github.com/acme/repo-b/pull/2",
        } as WebRunSummary,
      ],
      filters: { repo: "repo-b", priority: "P2" },
    });

    expect(dashboard.runCount).toBe(1);
    expect(dashboard.pilotRoi.reviewableRunIds).toEqual(["repo-b-run"]);
  });

  it("projects phase duration samples with traceable task and run evidence", () => {
    const dashboard = buildManagerDashboard({
      now: new Date("2026-06-24T12:00:00.000Z"),
      repositories: [
        { id: "repo-a", name: "Repo A", path: "/repos/a", defaultBranch: "main" },
      ],
      tasks: [
        {
          id: "task-plan",
          title: "Planning measured",
          status: "ready",
          workItemType: "dev.pr",
          flowPath: "flows/alpha.json",
          inputs: {},
          repoId: "repo-a",
          repoName: "Repo A",
          runCount: 0,
          artifacts: [],
          artifactsByType: [],
          createdAt: "2026-06-24T08:00:00.000Z",
          updatedAt: "2026-06-24T10:15:00.000Z",
          planning: {
            artifacts: {},
            events: [
              {
                artifact: "spec",
                artifactPath: "spec.md",
                decision: "approve",
                at: "2026-06-24T09:00:00.000Z",
                previousState: "draft_spec",
                nextState: "spec_approved",
              },
              {
                artifact: "tech-design",
                artifactPath: "tech.md",
                decision: "approve",
                at: "2026-06-24T10:00:00.000Z",
                previousState: "draft_tech_design",
                nextState: "tech_design_approved",
              },
            ],
          },
        } as WorkItemView & { repoName: string },
      ],
      runs: [
        {
          runId: "run-exec",
          sessionId: "run-exec",
          status: "completed",
          repoId: "repo-a",
          repoName: "Repo A",
          flowName: "Alpha flow",
          completedStages: ["implement"],
          inputs: {},
          startedAt: "2026-06-24T10:00:00.000Z",
          completedAt: "2026-06-24T10:30:00.000Z",
        } as WebRunSummary,
        {
          runId: "run-review",
          sessionId: "run-review",
          status: "awaiting-approval",
          repoId: "repo-a",
          repoName: "Repo A",
          flowName: "Alpha flow",
          completedStages: ["implement"],
          inputs: {},
          startedAt: "2026-06-24T11:00:00.000Z",
          currentStage: "review",
        } as WebRunSummary,
        {
          runId: "run-rework",
          sessionId: "run-rework",
          status: "completed",
          repoId: "repo-a",
          repoName: "Repo A",
          flowName: "Alpha flow",
          completedStages: ["implement"],
          inputs: {},
          priorRunId: "run-exec",
          startedAt: "2026-06-24T09:00:00.000Z",
          completedAt: "2026-06-24T09:45:00.000Z",
        } as WebRunSummary,
      ],
    });

    expect(dashboard.phaseDurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "planning",
          count: 1,
          averageMs: 2 * 60 * 60 * 1000,
          totalMs: 2 * 60 * 60 * 1000,
          taskIds: ["task-plan"],
        }),
        expect.objectContaining({
          key: "execution",
          count: 1,
          averageMs: 30 * 60 * 1000,
          runIds: ["run-exec"],
        }),
        expect.objectContaining({
          key: "review",
          count: 1,
          averageMs: 60 * 60 * 1000,
          runIds: ["run-review"],
        }),
        expect.objectContaining({
          key: "rework",
          count: 1,
          averageMs: 45 * 60 * 1000,
          runIds: ["run-rework"],
        }),
      ]),
    );
  });

  it("groups personal action items by required review work", () => {
    const dashboard = buildMyWorkDashboard({
      now: new Date("2026-06-24T12:00:00.000Z"),
      overdueAfterMs: 60 * 60 * 1000,
      notifications: [
        {
          id: "notification-spec",
          sourceKey: "task:1:draft-spec",
          type: "review-spec",
          severity: "info",
          status: "pending",
          title: "Review draft spec",
          link: "/tasks/task-1",
          taskId: "task-1",
          targetUserId: "user-a",
          assigneeUserId: "user-a",
          supportedActions: ["approve", "deny", "request-changes", "assign"],
          requiredReasonActions: ["request-changes"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
          repoId: "repo-a",
          repoName: "Repo A",
        },
        {
          id: "notification-blocker",
          sourceKey: "task:2:blocker",
          type: "resolve-blocker",
          severity: "blocker",
          status: "pending",
          title: "Run needs human input",
          link: "/tasks/task-2",
          taskId: "task-2",
          supportedActions: ["resolve", "override", "cancel-run", "assign"],
          requiredReasonActions: ["override", "cancel-run"],
          createdAt: "2026-06-24T11:30:00.000Z",
          updatedAt: "2026-06-24T11:30:00.000Z",
          repoId: "repo-a",
          repoName: "Repo A",
        },
        {
          id: "notification-resolved",
          sourceKey: "task:3:draft-pr",
          type: "review-pr",
          severity: "info",
          status: "resolved",
          title: "Review draft PR",
          link: "https://github.com/Instask/nitely/pull/1",
          supportedActions: ["request-changes", "resolve", "assign"],
          requiredReasonActions: ["request-changes"],
          createdAt: "2026-06-24T09:00:00.000Z",
          updatedAt: "2026-06-24T09:00:00.000Z",
        },
      ],
    });

    expect(dashboard.pendingCount).toBe(2);
    expect(dashboard.blockerCount).toBe(1);
    expect(dashboard.reviewCount).toBe(1);
    expect(dashboard.overdueCount).toBe(1);
    expect(dashboard.items.map((item) => item.type)).toEqual([
      "review-spec",
      "resolve-blocker",
    ]);
    expect(dashboard.groups.map((group) => group.actionLabel)).toEqual([
      "Review spec",
      "Resolve blocker",
    ]);
  });

  it("uses the PR notification title for draft versus ready review labels", () => {
    const dashboard = buildMyWorkDashboard({
      now: new Date("2026-06-25T12:00:00.000Z"),
      notifications: [
        {
          id: "notification-ready-pr",
          sourceKey: "task:1:ready-pr",
          type: "review-pr",
          severity: "info",
          status: "pending",
          title: "Review PR",
          body: "A ready PR has been published and can be reviewed before merge.",
          link: "https://github.com/Instask/nitely/pull/2",
          taskId: "task-1",
          runId: "run-1",
          supportedActions: ["request-changes", "resolve", "assign"],
          requiredReasonActions: ["request-changes"],
          createdAt: "2026-06-25T11:00:00.000Z",
          updatedAt: "2026-06-25T11:00:00.000Z",
        },
      ],
    });

    expect(dashboard.items[0]).toMatchObject({
      type: "review-pr",
      actionLabel: "Review PR",
      title: "Review PR",
    });
    expect(dashboard.groups[0]).toMatchObject({
      actionLabel: "Review PR",
      count: 1,
    });
  });
});
