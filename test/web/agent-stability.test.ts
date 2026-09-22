import { describe, expect, it } from "vitest";

import {
  AGENT_STABILITY_OSS_CANDIDATES,
  buildAgentStabilityProjection,
  type AgentStabilityRunInput,
} from "../../src/web/agent-stability.js";

function baseRun(
  overrides: Partial<AgentStabilityRunInput> & Pick<AgentStabilityRunInput, "runId" | "status">,
): AgentStabilityRunInput {
  return {
    sessionId: overrides.runId,
    completedStages: [],
    inputs: {},
    ...overrides,
  };
}

describe("agent stability projection", () => {
  it("returns zero counts and static OSS candidates for empty state", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T00:00:00.000Z"),
      runs: [],
      tasks: [],
      repositories: [],
    });

    expect(projection).toMatchObject({
      generatedAt: "2026-08-02T00:00:00.000Z",
      summary: {
        active: 0,
        blocked: 0,
        failed: 0,
        incomplete: 0,
        completed: 0,
        total: 0,
      },
      attention: [],
      failureClusters: [],
      runnerReadiness: [],
      changeRecords: [],
      verification: {
        totalStages: 0,
        passed: 0,
        failed: 0,
        missing: 0,
        partial: 0,
        unknown: 0,
        evidenceReadyRunIds: [],
        selfTestCandidates: [],
      },
    });
    expect(projection.ossExtraction).toEqual(AGENT_STABILITY_OSS_CANDIDATES);
    expect(projection.ossExtraction.length).toBe(5);
    expect(projection.ossExtraction.map((item) => item.id)).toEqual([
      "protocol",
      "runner-lifecycle",
      "evidence-metadata",
      "connector-interface",
      "doctor",
    ]);
    expect(projection.ossExtraction.every((item) => item.status === "candidate")).toBe(true);
  });

  it("counts statuses and builds attention for blocked, failed, and incomplete runs", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      tasks: [
        { id: "task-1", title: "Fix checkout" },
        { id: "task-2", title: "Ship feature" },
      ],
      runs: [
        baseRun({
          runId: "run-active",
          status: "running",
          currentStage: "implement",
          startedAt: "2026-08-02T11:50:00.000Z",
        }),
        baseRun({
          runId: "run-approval",
          status: "awaiting-approval",
          currentStage: "review",
        }),
        baseRun({
          runId: "run-blocked",
          status: "blocked",
          taskId: "task-1",
          repoName: "nitely",
          currentStage: "implement",
          startedAt: "2026-08-02T10:00:00.000Z",
          blocker: {
            reason: "missing-tool",
            message: "codex CLI not found",
          },
        }),
        baseRun({
          runId: "run-failed",
          status: "failed",
          taskId: "task-2",
          currentStage: "test",
          startedAt: "2026-08-02T11:00:00.000Z",
          blocker: { reason: "stage-failed", message: "tests failed" },
        }),
        baseRun({
          runId: "run-interrupted",
          status: "interrupted",
          startedAt: "2026-08-02T11:30:00.000Z",
        }),
        baseRun({
          runId: "run-cancelled",
          status: "cancelled",
        }),
        baseRun({
          runId: "run-incomplete",
          status: "incomplete",
        }),
        baseRun({
          runId: "run-done",
          status: "completed",
          completedStages: ["implement", "review"],
        }),
      ],
    });

    expect(projection.summary).toEqual({
      active: 2,
      blocked: 1,
      failed: 1,
      incomplete: 3,
      completed: 1,
      total: 8,
    });

    expect(projection.attention.map((item) => item.runId)).toEqual([
      "run-blocked",
      "run-failed",
      "run-interrupted",
      "run-incomplete",
      "run-cancelled",
    ]);
    expect(projection.attention[0]).toMatchObject({
      runId: "run-blocked",
      taskId: "task-1",
      taskTitle: "Fix checkout",
      repoName: "nitely",
      status: "blocked",
      currentStage: "implement",
      blockerReason: "codex CLI not found",
      ageLabel: "2h",
      link: "/runs/run-blocked",
    });
    expect(projection.attention.find((item) => item.runId === "run-interrupted")).toMatchObject({
      status: "interrupted",
      currentStage: "unknown-stage",
    });
  });

  it("groups failures by status, stage, runtime, flow, and repository with unknown keys", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      runs: [
        baseRun({
          runId: "fail-1",
          status: "failed",
          currentStage: "implement",
          flowName: "implement-spec",
          repoName: "nitely",
          currentProcess: {
            kind: "agent",
            label: "grok",
            runtime: "grok",
            state: "finished",
          },
        }),
        baseRun({
          runId: "fail-2",
          status: "failed",
          // no stage / runtime / flow / repo
        }),
        baseRun({
          runId: "blocked-1",
          status: "blocked",
          currentStage: "review",
          flowName: "implement-spec",
          repoName: "nitely",
          blocker: { reason: "waiting", runtime: "codex" },
        }),
        baseRun({
          runId: "ok",
          status: "completed",
          currentStage: "review",
        }),
      ],
    });

    const keys = projection.failureClusters.map((cluster) => cluster.key).sort();
    expect(keys).toEqual(
      expect.arrayContaining([
        "status:failed",
        "status:blocked",
        "stage:implement",
        "stage:review",
        "stage:unknown-stage",
        "runtime:grok",
        "runtime:codex",
        "runtime:unknown",
        "flow:implement-spec",
        "flow:unknown",
        "repository:nitely",
        "repository:unknown",
      ]),
    );

    const failedStatus = projection.failureClusters.find((c) => c.key === "status:failed");
    expect(failedStatus).toMatchObject({
      dimension: "status",
      value: "failed",
      count: 2,
    });
    expect(failedStatus?.runIds.sort()).toEqual(["fail-1", "fail-2"]);

    const unknownStage = projection.failureClusters.find(
      (c) => c.key === "stage:unknown-stage",
    );
    expect(unknownStage?.runIds).toEqual(["fail-2"]);
  });

  it("derives runner readiness from preflight without leaking secrets", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      runs: [
        baseRun({
          runId: "run-ready",
          status: "completed",
          startedAt: "2026-08-02T11:00:00.000Z",
          completedAt: "2026-08-02T11:05:00.000Z",
          currentProcess: {
            kind: "agent",
            label: "codex",
            runtime: "codex",
            model: "gpt-5",
            state: "finished",
          },
          toolchainPreflight: {
            version: 1,
            runId: "run-ready",
            generatedAt: "2026-08-02T11:00:00.000Z",
            repoPath: "/repos/nitely",
            commandEnvironment: {
              envSource: "process",
              shellMode: "login",
              pathEntryCount: 12,
              repairs: [],
            },
            toolchainFiles: [{ path: "package.json", kind: "node-package" }],
            executables: [
              { name: "git", available: true, path: "/usr/bin/git" },
              { name: "node", available: true, path: "/usr/bin/node" },
              { name: "pnpm", available: true, path: "/usr/bin/pnpm" },
            ],
          },
        }),
        baseRun({
          runId: "run-degraded",
          status: "failed",
          startedAt: "2026-08-02T11:30:00.000Z",
          currentProcess: {
            kind: "agent",
            label: "grok",
            runtime: "grok",
            model: "grok-4",
            state: "finished",
          },
          toolchainPreflight: {
            version: 1,
            runId: "run-degraded",
            generatedAt: "2026-08-02T11:30:00.000Z",
            repoPath: "/repos/nitely",
            commandEnvironment: {
              envSource: "process",
              shellMode: "login",
              pathEntryCount: 12,
              repairs: [
                {
                  kind: "path-prepend",
                  target: "PATH",
                  value: "/secret/token/path",
                } as never,
              ],
            },
            toolchainFiles: [],
            executables: [
              { name: "git", available: true, path: "/usr/bin/git" },
              { name: "node", available: false },
              { name: "pnpm", available: false },
            ],
          },
        }),
        baseRun({
          runId: "run-unknown",
          status: "running",
          currentProcess: {
            kind: "agent",
            label: "glm",
            runtime: "glm",
            state: "running",
          },
        }),
      ],
    });

    expect(projection.runnerReadiness).toHaveLength(3);

    const codex = projection.runnerReadiness.find((r) => r.runtime === "codex");
    expect(codex).toMatchObject({
      runtime: "codex",
      model: "gpt-5",
      readiness: "ready",
      lastRunId: "run-ready",
      lastObservedAt: "2026-08-02T11:05:00.000Z",
      missingTools: [],
    });

    const grok = projection.runnerReadiness.find((r) => r.runtime === "grok");
    expect(grok).toMatchObject({
      runtime: "grok",
      readiness: "degraded",
      missingTools: ["node", "pnpm"],
      lastRunId: "run-degraded",
    });

    const glm = projection.runnerReadiness.find((r) => r.runtime === "glm");
    expect(glm).toMatchObject({
      runtime: "glm",
      readiness: "unknown",
      lastRunId: "run-unknown",
    });

    const serialized = JSON.stringify(projection.runnerReadiness);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/\/usr\/bin\//);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toContain("PATH");
  });

  it("reports change records from publication and local-only branch metadata", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      runs: [
        baseRun({
          runId: "run-pr",
          status: "completed",
          taskId: "task-pr",
          branchName: "feature/x",
          publication: {
            state: "published",
            branchName: "feature/x",
            headCommit: "abcdef1234567890",
            changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
            prNumber: 42,
          },
          changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
          prNumber: 42,
        }),
        baseRun({
          runId: "run-updated",
          status: "completed",
          taskId: "task-updated",
          publication: {
            state: "updated",
            branchName: "feature/y",
            changeRequestUrl: "https://github.com/Instask/nitely/pull/43",
            prNumber: 43,
          },
        }),
        baseRun({
          runId: "run-local",
          status: "completed",
          taskId: "task-local",
          branchName: "local-only-branch",
          publication: {
            state: "published",
            branchName: "local-only-branch",
            headCommit: "deadbeefcafebabe",
          },
        }),
        baseRun({
          runId: "run-none",
          status: "running",
        }),
      ],
    });

    expect(projection.changeRecords).toHaveLength(3);
    expect(projection.changeRecords[0]).toMatchObject({
      runId: "run-pr",
      taskId: "task-pr",
      branchName: "feature/x",
      headCommit: "abcdef1234567890",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
      prNumber: 42,
      publicationState: "published",
    });
    expect(projection.changeRecords.find((r) => r.runId === "run-updated")).toMatchObject({
      publicationState: "updated",
      prNumber: 43,
    });
    const localOnly = projection.changeRecords.find((r) => r.runId === "run-local");
    expect(localOnly).toMatchObject({
      publicationState: "local-only",
      branchName: "local-only-branch",
      headCommit: "deadbeefcafebabe",
    });
    expect(localOnly?.changeRequestUrl).toBeUndefined();
  });

  it("summarizes verification and self-test evidence metadata", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      runs: [
        baseRun({
          runId: "run-verify-pass",
          status: "completed",
          flowName: "self-test-suite",
          completedStages: ["implement", "verify", "doctor"],
          currentArtifactReadiness: {
            status: "ready",
            declaredIds: ["report"],
            readyIds: ["report"],
            missingIds: [],
          },
          timeline: [
            {
              stageId: "verify",
              status: "completed",
              hasEvidence: true,
              artifactReadiness: {
                status: "ready",
                declaredIds: ["report"],
                readyIds: ["report"],
                missingIds: [],
              },
            },
            {
              stageId: "doctor",
              status: "completed",
              hasEvidence: true,
              artifactReadiness: {
                status: "ready",
                declaredIds: ["doctor-log"],
                readyIds: ["doctor-log"],
                missingIds: [],
              },
            },
          ],
        }),
        baseRun({
          runId: "run-verify-fail",
          status: "failed",
          currentStage: "test",
          completedStages: ["implement"],
          timeline: [
            {
              stageId: "test",
              status: "failed",
              hasEvidence: false,
              artifactReadiness: {
                status: "missing",
                declaredIds: ["junit"],
                readyIds: [],
                missingIds: ["junit"],
              },
            },
          ],
        }),
        baseRun({
          runId: "run-partial",
          status: "completed",
          currentStage: "verify-report",
          currentArtifactReadiness: {
            status: "partial",
            declaredIds: ["a", "b"],
            readyIds: ["a"],
            missingIds: ["b"],
          },
        }),
        baseRun({
          runId: "run-missing-evidence",
          status: "completed",
          currentStage: "verify",
          currentArtifactReadiness: {
            status: "missing",
            declaredIds: ["proof"],
            readyIds: [],
            missingIds: ["proof"],
          },
        }),
      ],
    });

    expect(projection.verification.totalStages).toBeGreaterThan(0);
    expect(projection.verification.passed).toBeGreaterThanOrEqual(1);
    expect(projection.verification.failed).toBeGreaterThanOrEqual(1);
    expect(projection.verification.missing).toBeGreaterThanOrEqual(1);
    expect(projection.verification.partial).toBeGreaterThanOrEqual(1);
    expect(projection.verification.evidenceReadyRunIds).toContain("run-verify-pass");
    expect(
      projection.verification.selfTestCandidates.map((item) => item.runId).sort(),
    ).toEqual([
      "run-missing-evidence",
      "run-partial",
      "run-verify-fail",
      "run-verify-pass",
    ]);
    expect(
      projection.verification.selfTestCandidates.find((c) => c.runId === "run-verify-pass"),
    ).toMatchObject({
      kind: "self-test",
      stages: expect.arrayContaining(["verify", "doctor"]),
    });

    const serialized = JSON.stringify(projection.verification);
    expect(serialized).not.toMatch(/stdout|stderr/i);
  });

  it("ignores synthetic demo runs and keeps projection usable with sparse metadata", () => {
    const projection = buildAgentStabilityProjection({
      now: new Date("2026-08-02T12:00:00.000Z"),
      repositories: [
        { id: "live", name: "Live", path: "/repos/live" },
        { id: "demo", name: "Demo", path: "/repos/demo", synthetic: true },
      ],
      runs: [
        baseRun({
          runId: "demo-run",
          status: "failed",
          repoId: "demo",
          repoSynthetic: true,
        }),
        baseRun({
          runId: "live-run",
          status: "failed",
          repoId: "live",
          repoName: "Live",
        }),
      ],
    });

    expect(projection.summary.total).toBe(1);
    expect(projection.summary.failed).toBe(1);
    expect(projection.attention.map((item) => item.runId)).toEqual(["live-run"]);
    expect(
      projection.failureClusters.find((c) => c.key === "stage:unknown-stage")?.runIds,
    ).toEqual(["live-run"]);
  });
});
