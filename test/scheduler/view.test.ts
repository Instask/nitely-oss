import { describe, expect, it } from "vitest";

import type {
  RunEligibilityDecision,
  RunEligibilityReason,
} from "../../src/run/eligibility.js";
import { buildSchedulerView } from "../../src/scheduler/view.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

function task(
  id: string,
  patch: Partial<WorkItemRecord> = {},
): WorkItemRecord {
  const createdAt = patch.createdAt ?? `2026-06-26T00:00:0${id.length}.000Z`;
  return {
    id,
    title: id,
    status: "ready",
    workItemType: "dev.pr",
    flowPath: "flows/implement-spec-bootstrap.json",
    inputs: {},
    specPath: `.nitely/tasks/${id}/spec.md`,
    techDesignPath: `.nitely/tasks/${id}/tech-design.md`,
    priority: "P2",
    dependsOn: [],
    suggestedDependencies: [],
    createdAt,
    updatedAt: patch.updatedAt ?? createdAt,
    ...patch,
  };
}

function reason(
  kind: RunEligibilityReason["kind"],
  patch: Partial<RunEligibilityReason> = {},
): RunEligibilityReason {
  return {
    code: patch.code ?? `test.${kind}`,
    kind,
    message: patch.message ?? kind,
    overridePolicy: patch.overridePolicy ?? "manual",
    ...patch,
  };
}

function decision(
  workItemId: string,
  blockers: RunEligibilityReason[] = [],
): RunEligibilityDecision {
  return {
    workItemId,
    decision: blockers.length === 0 ? "eligible" : "blocked",
    blockers,
    warnings: [],
    overridden: [],
    checks: {},
  };
}

describe("scheduler view projection", () => {
  it("projects queue sections and DAG edges from the same dependency graph", () => {
    const view = buildSchedulerView(
      [
        task("foundation", {
          status: "completed",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
        }),
        task("ready-p0", {
          title: "Ready P0",
          priority: "P0",
          createdAt: "2026-06-26T00:01:00.000Z",
          dependsOn: ["foundation"],
        }),
        task("running", {
          status: "running",
          dependsOn: ["foundation"],
        }),
        task("blocked", {
          priority: "P1",
          dependsOn: ["unmerged"],
          suggestedDependencies: [
            {
              dependsOn: "ready-p0",
              reason: "shares the same scheduler UI surface",
              confidence: 0.73,
              source: "analysis",
              suggestedAt: "2026-06-26T00:02:00.000Z",
            },
          ],
        }),
        task("unmerged", {
          status: "completed",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/2",
        }),
        task("failed", { status: "failed" }),
      ],
      {
        eligibility: {
          "ready-p0": decision("ready-p0"),
          blocked: decision("blocked", [
            reason("incomplete", { upstreamId: "unmerged" }),
          ]),
        },
      },
    );

    expect(view.summary).toMatchObject({
      total: 6,
      running: 1,
      runnable: 1,
      blocked: 1,
      failed: 1,
      completed: 2,
    });
    expect(view.queue.running.map((item) => item.id)).toEqual(["running"]);
    expect(view.queue.runnable.map((item) => item.id)).toEqual(["ready-p0"]);
    expect(view.queue.blocked).toEqual([
      expect.objectContaining({
        id: "blocked",
        displayStatus: "blocked",
        blockedReasons: [{ kind: "incomplete", upstreamId: "unmerged" }],
      }),
    ]);
    expect(view.nodes.find((node) => node.id === "ready-p0")).toMatchObject({
      displayStatus: "runnable",
      priority: "P0",
    });
    expect(view.nodes.find((node) => node.id === "blocked")).toMatchObject({
      displayStatus: "blocked",
      blockedReasons: [{ kind: "incomplete", upstreamId: "unmerged" }],
    });
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "foundation",
          to: "ready-p0",
          kind: "confirmed",
        }),
        expect.objectContaining({
          from: "ready-p0",
          to: "blocked",
          kind: "suggested",
          reason: "shares the same scheduler UI surface",
        }),
      ]),
    );
  });

  it("uses latest run status when the persisted task status is stale", () => {
    const staleRunningTask = task("stale-running", {
      status: "running",
      latestRunId: "run-blocked",
      latestRunStatus: "blocked",
    } as Partial<WorkItemRecord> & { latestRunStatus: string });

    const view = buildSchedulerView([staleRunningTask], { eligibility: {} });

    expect(view.summary).toMatchObject({
      running: 0,
      blocked: 1,
    });
    expect(view.queue.running).toEqual([]);
    expect(view.queue.blocked).toEqual([
      expect.objectContaining({
        id: "stale-running",
        status: "running",
        displayStatus: "blocked",
        latestRunId: "run-blocked",
      }),
    ]);
    expect(view.nodes.find((node) => node.id === "stale-running")).toMatchObject({
      displayStatus: "blocked",
    });
  });

  it("surfaces changed source snapshots as blocked scheduler reasons", () => {
    const view = buildSchedulerView(
      [
        task("source-drifted", {
          planningSource: {
            type: "github-issue",
            uri: "https://github.com/Instask/nitely/issues/308",
            title: "Source drift",
            snapshot: {
              uri: "https://github.com/Instask/nitely/issues/308",
              title: "Source drift",
              body: "Old body",
              fetchedAt: "2026-06-28T00:00:00.000Z",
            },
            drift: {
              status: "changed",
              checkedAt: "2026-06-28T01:00:00.000Z",
              changedFields: ["body"],
              latestSnapshot: {
                uri: "https://github.com/Instask/nitely/issues/308",
                title: "Source drift",
                body: "New body",
                fetchedAt: "2026-06-28T01:00:00.000Z",
              },
            },
          },
        }),
      ],
      {
        eligibility: {
          "source-drifted": decision("source-drifted", [
            reason("source-drift", { changedFields: ["body"] }),
          ]),
        },
      },
    );

    expect(view.summary).toMatchObject({
      runnable: 0,
      blocked: 1,
    });
    expect(view.queue.blocked).toEqual([
      expect.objectContaining({
        id: "source-drifted",
        displayStatus: "blocked",
        blockedReasons: [{ kind: "source-drift", changedFields: ["body"] }],
      }),
    ]);
  });

  it("surfaces spec readiness blockers in the scheduler queue", () => {
    const view = buildSchedulerView(
      [task("needs-spec-refinement")],
      {
        eligibility: {
          "needs-spec-refinement": decision("needs-spec-refinement", [
            reason("spec-readiness", {
              message: "at least one source-specific FR is required before approval",
            }),
          ]),
        },
      },
    );

    expect(view.summary).toMatchObject({
      runnable: 0,
      blocked: 1,
    });
    expect(view.queue.blocked).toEqual([
      expect.objectContaining({
        id: "needs-spec-refinement",
        displayStatus: "blocked",
        blockedReasons: [
          {
            kind: "spec-readiness",
            message: "at least one source-specific FR is required before approval",
          },
        ],
      }),
    ]);
  });
});
