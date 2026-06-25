import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "../../src/events/store.js";
import { getProjectedRunLogs, projectRun } from "../../src/run/project.js";
import type { StoredRunEvent } from "../../src/events/types.js";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  payload: unknown,
  options: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence,
    runId: options.runId ?? "run-1",
    type,
    payload,
    createdAt: options.createdAt ?? `2026-06-19T00:00:0${sequence}.000Z`,
    stageId: options.stageId,
    attempt: options.attempt,
  };
}

describe("run projection", () => {
  it("projects completed run and stage state from events", () => {
    const projection = projectRun([
      event(1, "run.created", {
        flowName: "implement-spec-bootstrap",
        flowPath: "flows/implement-spec-bootstrap.json",
        branchName: "nitely/run-1",
      }),
      event(2, "workspace.created", {
        worktreePath: "/repo/.nitely/runs/run-1/worktree",
      }),
      event(3, "stage.started", { attemptDirectory: "/run/stages/implement/1" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(4, "stage.completed", { outputs: ["implementation"] }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(5, "run.completed", { changeRequestUrl: "https://example.test/pr/1" }),
    ]);

    expect(projection).toMatchObject({
      runId: "run-1",
      status: "completed",
      flowName: "implement-spec-bootstrap",
      branchName: "nitely/run-1",
      worktreePath: "/repo/.nitely/runs/run-1/worktree",
      completedStages: ["implement"],
      changeRequestUrl: "https://example.test/pr/1",
      stages: [
        {
          stageId: "implement",
          status: "completed",
          attempts: [
            {
              attempt: 1,
              status: "completed",
              attemptDirectory: "/run/stages/implement/1",
            },
          ],
        },
      ],
    });
  });

  it("marks a non-terminal started stage as interrupted deterministically", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
    ]);

    expect(projection.status).toBe("interrupted");
    expect(projection.stages).toEqual([
      expect.objectContaining({
        stageId: "implement",
        status: "interrupted",
        attempts: [
          expect.objectContaining({
            attempt: 1,
            status: "interrupted",
          }),
        ],
      }),
    ]);
  });

  it("projects blocked run, stage, attempt, and blocker details", () => {
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "ERROR: You've hit your usage limit.",
      retryAfter: "Jun 21st, 2026 12:37 AM",
    };
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", { type: "gate", attemptDirectory: "/run/stages/review/1" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(3, "stage.blocked", blocker, {
        stageId: "review",
        attempt: 1,
      }),
      event(4, "run.blocked", blocker),
    ]);

    expect(projection.status).toBe("blocked");
    expect(projection.blocker).toEqual(blocker);
    expect(projection.stages).toEqual([
      expect.objectContaining({
        stageId: "review",
        status: "blocked",
        blocker,
        attempts: [
          expect.objectContaining({
            attempt: 1,
            status: "blocked",
            blocker,
            blockedAt: "2026-06-19T00:00:03.000Z",
          }),
        ],
      }),
    ]);
  });

  it("allows later completion to override a previous blocked run status", () => {
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "usage limit",
    };
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {}, { stageId: "review", attempt: 1 }),
      event(3, "stage.blocked", blocker, { stageId: "review", attempt: 1 }),
      event(4, "run.blocked", blocker),
      event(5, "stage.started", {}, { stageId: "review", attempt: 2 }),
      event(6, "stage.completed", {}, { stageId: "review", attempt: 2 }),
      event(7, "run.completed", {}),
    ]);

    expect(projection.status).toBe("completed");
    expect(projection.blocker).toBeUndefined();
    expect(projection.stages[0]).toMatchObject({
      stageId: "review",
      status: "completed",
      attempts: [
        {
          attempt: 1,
          status: "blocked",
          blocker,
          blockedAt: "2026-06-19T00:00:03.000Z",
        },
        { attempt: 2, status: "completed" },
      ],
    });
    expect(projection.stages[0]?.blocker).toBeUndefined();
  });

  it("keeps unavailable attempt diagnostics while projecting later fallback success", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {
        type: "agent",
        runtime: "claude",
        runtimeCandidateIndex: 0,
        runtimeCandidateCount: 2,
      }, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.unavailable", {
        runtime: "claude",
        status: "unavailable",
        reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
        missingConfig: ["ANTHROPIC_API_KEY"],
      }, { stageId: "implement", attempt: 1 }),
      event(4, "stage.started", {
        type: "agent",
        runtime: "codex",
        runtimeCandidateIndex: 1,
        runtimeCandidateCount: 2,
      }, { stageId: "implement", attempt: 2 }),
      event(5, "stage.completed", {}, { stageId: "implement", attempt: 2 }),
      event(6, "run.completed", {}),
    ]);

    expect(projection.status).toBe("completed");
    expect(projection.stages[0]).toMatchObject({
      stageId: "implement",
      status: "completed",
      attempts: [
        {
          attempt: 1,
          status: "unavailable",
          runtime: "claude",
          reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
          missingConfig: ["ANTHROPIC_API_KEY"],
        },
        {
          attempt: 2,
          status: "completed",
          runtime: "codex",
        },
      ],
    });
    expect(projection.stages[0]?.blocker).toBeUndefined();
  });

  it("clears active run blocker metadata when a previously blocked run fails", () => {
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "usage limit",
    };
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {}, { stageId: "review", attempt: 1 }),
      event(3, "stage.blocked", blocker, { stageId: "review", attempt: 1 }),
      event(4, "run.blocked", blocker),
      event(5, "run.failed", { error: "manual failure after blocked resume" }),
    ]);

    expect(projection.status).toBe("failed");
    expect(projection.blocker).toBeUndefined();
    expect(projection.stages[0]?.attempts[0]).toMatchObject({
      attempt: 1,
      status: "blocked",
      blocker,
      blockedAt: "2026-06-19T00:00:03.000Z",
    });
  });

  it("projects ready stages with no attempts as pending", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.ready", { type: "agent" }, { stageId: "implement" }),
    ]);

    expect(projection.status).toBe("running");
    expect(projection.stages).toEqual([
      {
        stageId: "implement",
        stageType: "agent",
        status: "pending",
        attempts: [],
      },
    ]);
  });

  it("projects command logs from command completion events", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", { attemptDirectory: "/run/stages/test/1" }, {
        stageId: "test",
        attempt: 1,
      }),
      event(3, "command.completed", {
        command: "pnpm test",
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
      }, {
        stageId: "test",
        attempt: 1,
      }),
      event(4, "stage.completed", {}, { stageId: "test", attempt: 1 }),
    ]);

    expect(projection.logs).toEqual([
      {
        stageId: "test",
        attempt: 1,
        source: "command",
        command: "pnpm test",
        stdout: "ok\n",
        stderr: "",
      },
    ]);
  });

  it("projects gate results and attaches the latest result to its stage", () => {
    const gate = {
      id: "verify-1",
      stageId: "verify",
      name: "Verification",
      mode: "deterministic",
      status: "failed",
      command: "pnpm test",
      reason: "command failed with exit code 1",
      stdout: "ok\n",
      stderr: "not ok\n",
      createdAt: "2026-06-19T00:00:03.000Z",
    };
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {
        type: "gate",
        attemptDirectory: "/run/stages/verify/1",
      }, {
        stageId: "verify",
        attempt: 1,
      }),
      event(3, "gate.completed", { gate }, {
        stageId: "verify",
        attempt: 1,
      }),
      event(4, "stage.failed", { error: gate.reason }, {
        stageId: "verify",
        attempt: 1,
      }),
    ]);

    expect(projection.gates).toEqual([gate]);
    expect(projection.stages).toEqual([
      expect.objectContaining({
        stageId: "verify",
        stageType: "gate",
        gate,
      }),
    ]);
  });

  it("projects produced artifacts from artifact publication events", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "artifact.published", {
        artifact: {
          id: "implementation",
          name: "Implementation summary",
          type: "implementation",
          description: "Markdown summary",
          producer: "implement",
          mediaType: "text/markdown",
          schema: { kind: "markdown" },
          version: "1",
          path: "stages/implement/1/implementation.md",
          filename: "implementation.md",
        },
      }, {
        stageId: "implement",
        attempt: 1,
        createdAt: "2026-06-19T00:00:02.000Z",
      }),
    ]);

    expect(projection.artifacts).toEqual([
      {
        id: "implementation",
        name: "Implementation summary",
        type: "implementation",
        description: "Markdown summary",
        producer: "implement",
        mediaType: "text/markdown",
        schema: { kind: "markdown" },
        version: "1",
        path: "stages/implement/1/implementation.md",
        filename: "implementation.md",
        createdAt: "2026-06-19T00:00:02.000Z",
      },
    ]);
  });

  it("projects attempt output, manifest, log, and generated artifact paths", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {
        attemptDirectory: "/run/stages/implement/1",
      }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(3, "artifact.published", {
        artifact: {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/implementation.md",
          manifestSource: "declared-manifest",
        },
      }, {
        stageId: "implement",
      }),
      event(4, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
    ]);

    expect(projection.stages[0]?.attempts[0]).toEqual(
      expect.objectContaining({
        attemptDirectory: "/run/stages/implement/1",
        outputPath: "/run/stages/implement/1/output.md",
        artifactManifestPath: "/run/stages/implement/1/artifact.json",
        stdoutPath: "/run/stages/implement/1/stdout.log",
        stderrPath: "/run/stages/implement/1/stderr.log",
        generatedArtifactPaths: ["stages/implement/1/implementation.md"],
      }),
    );
    expect(projection.artifacts[0]).toEqual(
      expect.objectContaining({
        id: "implementation",
        manifestSource: "declared-manifest",
      }),
    );
  });

  it("ignores malformed artifact publication events", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "artifact.published", { artifact: { id: 1 } }),
    ]);

    expect(projection.artifacts).toEqual([]);
  });

  it("projects stage type and resumed marker from stage starts", () => {
    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "stage.started", {
        type: "command",
        resumedFrom: "run-original",
        attemptDirectory: "/run/stages/sync/1",
      }, {
        stageId: "sync",
        attempt: 1,
      }),
    ]);

    expect(projection.stages).toEqual([
      expect.objectContaining({
        stageId: "sync",
        stageType: "command",
        markers: { resumedFrom: "run-original" },
      }),
    ]);
  });

  it("projects the latest sync metadata from sync events", () => {
    const cleanSync = {
      prUrl: "https://github.com/Instask/nitely/pull/23",
      prNumber: 23,
      baseBranch: "master",
      strategy: "merge",
      baseSha: "a".repeat(40),
      headShaBefore: "b".repeat(40),
      headShaAfter: "c".repeat(40),
      result: "clean",
      conflictFiles: [],
      reportPath: "/run/stages/sync/1/sync-report.md",
    };
    const conflictedSync = {
      ...cleanSync,
      headShaAfter: undefined,
      result: "conflicted",
      conflictFiles: ["feature.txt"],
      reportPath: "/run/stages/sync/2/sync-report.md",
    };

    const projection = projectRun([
      event(1, "run.created", { flowName: "flow" }),
      event(2, "change.sync.completed", cleanSync, {
        stageId: "sync",
        attempt: 1,
      }),
      event(3, "change.sync.conflicted", conflictedSync, {
        stageId: "sync",
        attempt: 2,
      }),
    ]);

    expect(projection.sync).toEqual(conflictedSync);
  });

  it("folds stage.context.usage onto attempts and a run total", () => {
    const events: StoredRunEvent[] = [
      event(1, "stage.started", { type: "agent", attemptDirectory: "/d" }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-20T00:00:00Z" }),
      event(2, "stage.context.usage", { promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-20T00:00:01Z" }),
    ];
    const run = projectRun(events);
    const attempt = run.stages[0].attempts[0];
    expect(attempt.contextUsage).toEqual({ promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 });
    expect(run.contextUsage).toEqual({ promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 });
  });

  it("folds stage.runtime.usage onto attempts and counts unknown runtime attempts", () => {
    const events: StoredRunEvent[] = [
      event(1, "stage.started", { type: "agent", runtime: "codex", attemptDirectory: "/d/1" }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-20T00:00:00Z" }),
      event(2, "stage.runtime.usage", { inputTokens: 100, outputTokens: 40, totalTokens: 140, contextWindow: 200000, estimatedCostUsd: 0.01, raw: { provider: "mock" } }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-20T00:00:01Z" }),
      event(3, "stage.started", { type: "agent", runtime: "codex", attemptDirectory: "/d/2" }, { runId: "r1", stageId: "implement", attempt: 2, createdAt: "2026-06-20T00:00:02Z" }),
    ];
    const run = projectRun(events);
    const knownAttempt = run.stages[0].attempts[0];
    expect(knownAttempt.runtimeUsage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      contextWindow: 200000,
      estimatedCostUsd: 0.01,
      raw: { provider: "mock" },
    });
    expect(run.runtimeUsage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      estimatedCostUsd: 0.01,
      knownAttempts: 1,
      unknownAttempts: 1,
    });
  });

  it("projects knowledge.generated events for audit views", () => {
    const run = projectRun([
      event(1, "run.created", { flowName: "flow" }, { runId: "r1" }),
      event(2, "knowledge.generated", {
        runtime: "codex",
        model: "gpt-5",
        fingerprint: "abc123",
        generatedAt: "2026-06-21T00:00:00.000Z",
        contentPath: ".nitely/knowledge/agent-memory.md",
        generator: "deterministic-skeleton",
      }, { runId: "r1", createdAt: "2026-06-21T00:00:01.000Z" }),
      event(3, "run.completed", {}, { runId: "r1" }),
    ]);

    expect(run.knowledgeGenerations).toEqual([
      {
        runtime: "codex",
        model: "gpt-5",
        fingerprint: "abc123",
        generatedAt: "2026-06-21T00:00:00.000Z",
        contentPath: ".nitely/knowledge/agent-memory.md",
        generator: "deterministic-skeleton",
        eventCreatedAt: "2026-06-21T00:00:01.000Z",
      },
    ]);
  });

  it("folds budget.trimmed and budget.exceeded onto attempts", () => {
    const trimmedRun = projectRun([
      event(1, "stage.started", { type: "agent", attemptDirectory: "/d" }, { runId: "r1", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:00Z" }),
      event(2, "budget.trimmed", { budget: 200, approxTokensBefore: 900, approxTokensAfter: 180, trimmedInputIds: ["big"] }, { runId: "r1", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:01Z" }),
    ]);
    expect(trimmedRun.stages[0].attempts[0].budget).toEqual({ status: "trimmed", budget: 200, approxTokensBefore: 900, approxTokensAfter: 180, trimmedInputIds: ["big"] });
    expect(trimmedRun.budgetSummary).toMatchObject({
      trimmedEvents: 1,
      exceededEvents: 0,
      trimmedTokensBefore: 900,
      trimmedTokensAfter: 180,
    });

    const exceededRun = projectRun([
      event(1, "stage.started", { type: "agent", attemptDirectory: "/d" }, { runId: "r2", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:00Z" }),
      event(2, "budget.exceeded", { budget: 1, approxTokens: 120 }, { runId: "r2", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:01Z" }),
    ]);
    expect(exceededRun.stages[0].attempts[0].budget).toEqual({ status: "exceeded", budget: 1, approxTokens: 120 });
  });

  it("summarizes token budget consumers across context, runtime, and budget events", () => {
    const run = projectRun([
      event(1, "stage.started", { type: "agent", runtime: "codex", attemptDirectory: "/d/1" }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-21T00:00:00Z" }),
      event(2, "stage.context.usage", { promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-21T00:00:01Z" }),
      event(3, "stage.runtime.usage", { inputTokens: 100, outputTokens: 40, totalTokens: 140 }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-21T00:00:02Z" }),
      event(4, "budget.trimmed", { budget: 200, approxTokensBefore: 900, approxTokensAfter: 180, trimmedInputIds: ["big"] }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-21T00:00:03Z" }),
      event(5, "budget.trimmed", { budget: 50, approxTokensBefore: 50, approxTokensAfter: 10, trimmedInputIds: ["small"] }, { runId: "r1", stageId: "implement", attempt: 1, createdAt: "2026-06-21T00:00:04Z" }),
      event(6, "stage.started", { type: "agent", runtime: "codex", attemptDirectory: "/d/2" }, { runId: "r1", stageId: "review", attempt: 1, createdAt: "2026-06-21T00:00:05Z" }),
      event(7, "stage.runtime.usage", { inputTokens: 700, outputTokens: 300, totalTokens: 1000 }, { runId: "r1", stageId: "review", attempt: 1, createdAt: "2026-06-21T00:00:06Z" }),
      event(8, "budget.exceeded", { budget: 800, approxTokens: 1200 }, { runId: "r1", stageId: "review", attempt: 1, createdAt: "2026-06-21T00:00:07Z" }),
    ]);

    expect(run.budgetSummary).toMatchObject({
      contextApproxTokens: 300,
      runtimeTokens: 1140,
      trimmedEvents: 2,
      exceededEvents: 1,
      trimmedTokensBefore: 950,
      trimmedTokensAfter: 190,
    });
    expect(run.budgetSummary?.topConsumers.slice(0, 3)).toEqual([
      { stageId: "review", attempt: 1, kind: "budget-exceeded", approxTokens: 1200, budget: 800 },
      { stageId: "review", attempt: 1, kind: "runtime", approxTokens: 1000 },
      { stageId: "implement", attempt: 1, kind: "tool-output", approxTokens: 900, budget: 200, approxTokensAfter: 180 },
    ]);
  });

  it("rejects attempt log directories outside the run directory", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-project-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-logs",
      type: "run.created",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-logs",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(repoPath, "outside-attempt"),
      },
    });
    store.close();

    await expect(getProjectedRunLogs(repoPath, "run-logs")).rejects.toThrow(
      "attempt directory escapes run directory",
    );
  });
});
