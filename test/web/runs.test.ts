import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { getRunDetail, listRuns } from "../../src/web/runs.js";

async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("web run projection", () => {
  async function createEventStore(repoPath: string): Promise<EventStore> {
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    return new EventStore(join(repoPath, ".nitely/events.db"));
  }

  it("lists run metadata and projects evidence and logs for details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-1");
    await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-1",
      flowName: "implement-spec-bootstrap",
      branchName: "nitely/run-1",
      ownerId: "usr_owner",
      worktreePath: `${runDirectory}/worktree`,
      completedStages: ["implement"],
      inputs: {
        spec: { sourceUri: ".nitely/tasks/task-1/spec.md" },
      },
      trigger: {
        type: "github-pr-comment",
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        prNumber: 15,
        prUrl: "https://github.com/Instask/nitely/pull/15",
        commentId: "100",
        commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-100",
        authorLogin: "alice",
        action: "rework",
        priorRunId: "run-prev",
      },
      changeRequestUrl: "https://github.com/example/repo/pull/1",
    });
    await writeFile(join(runDirectory, "evidence.md"), "Evidence body", "utf8");
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      "stdout text",
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/implement/1/stderr.log"),
      "stderr text",
      "utf8",
    );

    await expect(listRuns(repoPath)).resolves.toMatchObject([
      {
        runId: "run-1",
        status: "completed",
        branchName: "nitely/run-1",
        ownerId: "usr_owner",
        completedStages: ["implement"],
        trigger: {
          type: "github-pr-comment",
          commentId: "100",
          authorLogin: "alice",
        },
      },
    ]);
    await expect(getRunDetail(repoPath, "run-1")).resolves.toMatchObject({
      runId: "run-1",
      status: "completed",
      flowName: "implement-spec-bootstrap",
      branchName: "nitely/run-1",
      ownerId: "usr_owner",
      worktreePath: `${runDirectory}/worktree`,
      completedStages: ["implement"],
      trigger: {
        type: "github-pr-comment",
        commentId: "100",
        commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-100",
      },
      evidence: "Evidence body",
      logs: [
        {
          stageId: "implement",
          attempt: "1",
          stdout: "stdout text",
          stderr: "stderr text",
        },
      ],
    });
  });

  it("lists incomplete and failed run directories without run metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const incompleteDirectory = join(repoPath, ".nitely/runs/run-incomplete");
    const failedDirectory = join(repoPath, ".nitely/runs/run-failed");
    await mkdir(join(incompleteDirectory, "stages/implement/1"), {
      recursive: true,
    });
    await mkdir(join(failedDirectory, "stages/test/1"), { recursive: true });
    await writeFile(
      join(incompleteDirectory, "stages/implement/1/stdout.log"),
      "partial output",
      "utf8",
    );
    await writeFile(
      join(failedDirectory, "stages/test/1/stderr.log"),
      "command failed",
      "utf8",
    );
    await writeFile(join(failedDirectory, "evidence.md"), "Failure evidence", "utf8");

    await expect(listRuns(repoPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-incomplete",
          status: "incomplete",
          completedStages: ["implement"],
        }),
        expect.objectContaining({
          runId: "run-failed",
          status: "failed",
          completedStages: ["test"],
        }),
      ]),
    );
    await expect(getRunDetail(repoPath, "run-failed")).resolves.toMatchObject({
      runId: "run-failed",
      status: "failed",
      completedStages: ["test"],
      evidence: "Failure evidence",
      logs: [
        {
          stageId: "test",
          attempt: "1",
          stderr: "command failed",
        },
      ],
    });
  });

  it("returns event-projected sessions with timelines, context manifest, and PR metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const runDirectory = join(repoPath, ".nitely/runs/run-events");
    await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      "partial event stdout",
      "utf8",
    );
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-events",
      type: "run.created",
      createdAt: "2026-06-19T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap",
        flowPath: "flows/implement-spec-bootstrap.json",
        ownerId: "usr_events",
        branchName: "nitely/run-events",
        baseBranch: "main",
        inputs: {
          spec: {
            sourceUri: ".nitely/tasks/task-123/spec.md",
            mediaType: "text/markdown",
            filename: "spec.md",
          },
        },
        trigger: {
          type: "github-pr-comment",
          priorRunId: "run-parent",
          prNumber: 41,
          prUrl: "https://github.com/Instask/nitely/pull/41",
        },
      },
    });
    store.append({
      runId: "run-events",
      type: "workspace.created",
      createdAt: "2026-06-19T00:00:01.000Z",
      payload: { worktreePath: join(runDirectory, "worktree") },
    });
    store.append({
      runId: "run-events",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-19T00:00:02.000Z",
      payload: { attemptDirectory: join(runDirectory, "stages/implement/1") },
    });
    store.append({
      runId: "run-events",
      type: "command.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-19T00:00:03.000Z",
      payload: {
        command: "pnpm test",
        stdout: "event stdout",
        stderr: "",
      },
    });
    store.append({
      runId: "run-events",
      type: "gate.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-19T00:00:04.000Z",
      payload: {
        gate: {
          id: "implement-gate",
          stageId: "implement",
          mode: "deterministic",
          status: "passed",
          command: "pnpm test",
          stdout: "event stdout",
          stderr: "",
          createdAt: "2026-06-19T00:00:04.000Z",
        },
      },
    });
    store.append({
      runId: "run-events",
      type: "artifact.published",
      stageId: "implement",
      createdAt: "2026-06-19T00:00:05.000Z",
      payload: {
        artifact: {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/implementation.md",
          manifestSource: "declared-manifest",
        },
      },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-events",
        sessionId: "run-events",
        status: "interrupted",
        ownerId: "usr_events",
        flowName: "implement-spec-bootstrap",
        flowPath: "flows/implement-spec-bootstrap.json",
        branchName: "nitely/run-events",
        baseBranch: "main",
        taskId: "task-123",
        prNumber: 41,
        prUrl: "https://github.com/Instask/nitely/pull/41",
      }),
    ]);

    await expect(getRunDetail(repoPath, "run-events")).resolves.toMatchObject({
      runId: "run-events",
      sessionId: "run-events",
      status: "interrupted",
      contextManifest: [
        {
          id: "spec",
          sourceUri: ".nitely/tasks/task-123/spec.md",
          mediaType: "text/markdown",
          filename: "spec.md",
          kind: "local",
        },
      ],
      timeline: [
        {
          stageId: "implement",
          status: "interrupted",
          gate: {
            id: "implement-gate",
            status: "passed",
            mode: "deterministic",
          },
          attempts: 1,
          startedAt: "2026-06-19T00:00:02.000Z",
          attemptDirectory: join(runDirectory, "stages/implement/1"),
          outputPath: join(runDirectory, "stages/implement/1/output.md"),
          artifactManifestPath: join(
            runDirectory,
            "stages/implement/1/artifact.json",
          ),
          stdoutPath: join(runDirectory, "stages/implement/1/stdout.log"),
          stderrPath: join(runDirectory, "stages/implement/1/stderr.log"),
          generatedArtifactPaths: ["stages/implement/1/implementation.md"],
        },
      ],
      gates: [
        {
          id: "implement-gate",
          stageId: "implement",
          mode: "deterministic",
          status: "passed",
          command: "pnpm test",
        },
      ],
      logs: [
        {
          stageId: "implement",
          attempt: "1",
          command: "pnpm test",
          stdout: "event stdout",
          stderr: "",
        },
      ],
    });
  });

  it("returns expandable details for an agent stage without stdout or stderr", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-agent-detail");
    const attemptDirectory = join(runDirectory, "stages/implement/1");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      join(attemptDirectory, "prompt.md"),
      "Rendered agent prompt",
      "utf8",
    );
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-agent-detail",
      type: "run.created",
      createdAt: "2026-06-22T00:00:00.000Z",
      payload: {
        flowName: "flow",
        flowPath: "flow-db-agent-detail",
        flowDocument: JSON.stringify({
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: { name: "flow" },
          spec: {
            stages: [
              {
                id: "implement",
                type: "agent",
                runtime: "codex",
                prompt: "Implement.",
                inputs: ["spec"],
                outputs: ["implementation"],
                maxAttempts: 2,
              },
            ],
          },
        }),
        inputs: {
          spec: { sourceUri: "spec.md" },
        },
      },
    });
    store.append({
      runId: "run-agent-detail",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-22T00:00:01.000Z",
      payload: {
        type: "agent",
        runtime: "codex",
        model: "gpt-5.3-codex",
        attemptDirectory,
      },
    });
    store.append({
      runId: "run-agent-detail",
      type: "artifact.published",
      stageId: "implement",
      createdAt: "2026-06-22T00:00:02.000Z",
      payload: {
        artifact: {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/implementation.md",
        },
      },
    });
    store.append({
      runId: "run-agent-detail",
      type: "stage.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-22T00:00:03.000Z",
      payload: {},
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-agent-detail");
    expect(detail.logs).toEqual([]);
    expect(detail.timeline).toEqual([
      expect.objectContaining({
        stageId: "implement",
        stageType: "agent",
        hasLogs: false,
        hasDetails: true,
        details: expect.objectContaining({
          prompt: "Rendered agent prompt",
          artifacts: [
            {
              id: "implementation",
              label: "implementation",
              path: "stages/implement/1/implementation.md",
            },
          ],
          fields: expect.arrayContaining([
            { label: "Runtime", value: "codex" },
            { label: "Model", value: "gpt-5.3-codex" },
            { label: "Declared inputs", value: "spec" },
            { label: "Declared outputs", value: "implementation" },
            { label: "Max attempts", value: "2" },
            { label: "Attempt directory", value: attemptDirectory, mono: true },
          ]),
        }),
      }),
    ]);
  });

  it("returns blocked event-projected sessions with blocker details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-blocked");
    const attemptDirectory = join(runDirectory, "stages/review/1");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      join(attemptDirectory, "stderr.log"),
      "ERROR: You've hit your usage limit. try again at Jun 21st, 2026 12:37 AM.\n",
      "utf8",
    );
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "ERROR: You've hit your usage limit.",
      retryAfter: "Jun 21st, 2026 12:37 AM",
    };
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-blocked",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap",
        branchName: "nitely/run-blocked",
      },
    });
    store.append({
      runId: "run-blocked",
      type: "workspace.created",
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { worktreePath: join(runDirectory, "worktree") },
    });
    store.append({
      runId: "run-blocked",
      type: "stage.started",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: { attemptDirectory, type: "gate" },
    });
    store.append({
      runId: "run-blocked",
      type: "stage.blocked",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: blocker,
    });
    store.append({
      runId: "run-blocked",
      type: "run.blocked",
      createdAt: "2026-06-20T00:00:04.000Z",
      payload: blocker,
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-blocked",
        status: "blocked",
        currentStage: "review",
        currentAttempt: 1,
        currentStageState: "blocked",
        blocker,
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-blocked")).resolves.toMatchObject({
      runId: "run-blocked",
      status: "blocked",
      blocker,
      timeline: [
        expect.objectContaining({
          stageId: "review",
          status: "blocked",
          state: "blocked",
          blocker,
          latestOutput: expect.stringContaining("usage limit"),
        }),
      ],
    });
  });

  it("does not expose active blocker fields after a blocked run later completes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-completed-after-blocked");
    const firstAttemptDirectory = join(runDirectory, "stages/review/1");
    const secondAttemptDirectory = join(runDirectory, "stages/review/2");
    await mkdir(firstAttemptDirectory, { recursive: true });
    await mkdir(secondAttemptDirectory, { recursive: true });
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "ERROR: You've hit your usage limit.",
      retryAfter: "Jun 21st, 2026 12:37 AM",
    };
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-completed-after-blocked",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap",
        branchName: "nitely/run-completed-after-blocked",
      },
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "stage.started",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { attemptDirectory: firstAttemptDirectory, type: "gate" },
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "stage.blocked",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: blocker,
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "run.blocked",
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: blocker,
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "stage.started",
      stageId: "review",
      attempt: 2,
      createdAt: "2026-06-20T00:00:04.000Z",
      payload: { attemptDirectory: secondAttemptDirectory, type: "gate" },
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "stage.completed",
      stageId: "review",
      attempt: 2,
      createdAt: "2026-06-20T00:00:05.000Z",
      payload: {},
    });
    store.append({
      runId: "run-completed-after-blocked",
      type: "run.completed",
      createdAt: "2026-06-20T00:00:06.000Z",
      payload: {},
    });
    store.close();

    const summaries = await listRuns(repoPath);
    expect(summaries).toEqual([
      expect.objectContaining({
        runId: "run-completed-after-blocked",
        status: "completed",
        currentStage: "review",
        currentAttempt: 2,
        currentStageState: "completed",
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty("blocker");

    const detail = await getRunDetail(repoPath, "run-completed-after-blocked");
    expect(detail).toMatchObject({
      runId: "run-completed-after-blocked",
      status: "completed",
      timeline: [
        expect.objectContaining({
          stageId: "review",
          status: "completed",
          state: "completed",
          currentAttempt: 2,
          attempts: 2,
        }),
      ],
    });
    expect(detail).not.toHaveProperty("blocker");
    expect(detail.timeline[0]).not.toHaveProperty("blocker");
  });

  it("does not expose stale failed-attempt errors after a fallback stage completes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-completed-after-unavailable");
    const firstAttemptDirectory = join(runDirectory, "stages/implement/1");
    const secondAttemptDirectory = join(runDirectory, "stages/implement/2");
    await mkdir(firstAttemptDirectory, { recursive: true });
    await mkdir(secondAttemptDirectory, { recursive: true });
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-completed-after-unavailable",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "implement-spec-bootstrap" },
    });
    store.append({
      runId: "run-completed-after-unavailable",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: {
        attemptDirectory: firstAttemptDirectory,
        type: "agent",
        runtime: "claude",
        runtimeCandidateIndex: 0,
        runtimeCandidateCount: 2,
      },
    });
    store.append({
      runId: "run-completed-after-unavailable",
      type: "stage.runtime.unavailable",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        runtime: "claude",
        status: "unavailable",
        reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
        missingConfig: ["ANTHROPIC_API_KEY"],
      },
    });
    store.append({
      runId: "run-completed-after-unavailable",
      type: "stage.started",
      stageId: "implement",
      attempt: 2,
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: {
        attemptDirectory: secondAttemptDirectory,
        type: "agent",
        runtime: "codex",
        runtimeCandidateIndex: 1,
        runtimeCandidateCount: 2,
      },
    });
    store.append({
      runId: "run-completed-after-unavailable",
      type: "stage.completed",
      stageId: "implement",
      attempt: 2,
      createdAt: "2026-06-20T00:00:04.000Z",
      payload: {},
    });
    store.append({
      runId: "run-completed-after-unavailable",
      type: "run.completed",
      createdAt: "2026-06-20T00:00:05.000Z",
      payload: {},
    });
    store.close();

    const summaries = await listRuns(repoPath);
    expect(summaries[0]).toMatchObject({
      runId: "run-completed-after-unavailable",
      status: "completed",
      currentStageState: "completed",
    });
    expect(summaries[0]?.latestOutputSummary).toBeUndefined();

    const detail = await getRunDetail(repoPath, "run-completed-after-unavailable");
    const stage = detail.timeline[0];
    expect(stage).toMatchObject({
      stageId: "implement",
      status: "completed",
      state: "completed",
      attempts: 2,
    });
    expect(stage?.error).toBeUndefined();
    expect(stage?.latestOutput).toBeUndefined();
    expect(stage?.details?.fields.some((field) => field.label === "Error")).toBe(false);
    expect(stage?.details?.events).toEqual([
      expect.objectContaining({
        type: "stage.runtime.unavailable",
        attempt: 1,
        summary: expect.stringContaining("ANTHROPIC_API_KEY"),
      }),
    ]);
  });

  it("exposes current stage state and latest output for a running projected stage", async () => {
    const previousToken = process.env.NITELY_WEB_OUTPUT_TOKEN;
    process.env.NITELY_WEB_OUTPUT_TOKEN = "secret-output-token";
    try {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
      const runDirectory = join(repoPath, ".nitely/runs/run-live");
      const attemptDirectory = join(runDirectory, "stages/implement/2");
      await mkdir(attemptDirectory, { recursive: true });
      await writeFile(
        join(attemptDirectory, "stdout.log"),
        "booting\nlast line with secret-output-token",
        "utf8",
      );
      const store = await createEventStore(repoPath);
      store.append({
        runId: "run-live",
        type: "run.created",
        createdAt: "2026-06-20T00:00:00.000Z",
        payload: { flowName: "implement-spec-bootstrap" },
      });
      store.append({
        runId: "run-live",
        type: "stage.started",
        stageId: "implement",
        attempt: 2,
        createdAt: "2026-06-20T00:00:01.000Z",
        payload: { attemptDirectory, type: "agent" },
      });
      store.close();

      await expect(listRuns(repoPath)).resolves.toEqual([
        expect.objectContaining({
          runId: "run-live",
          currentStage: "implement",
          currentAttempt: 2,
          currentStageState: "running",
          latestOutputSummary: "last line with [REDACTED]",
        }),
      ]);
      await expect(getRunDetail(repoPath, "run-live")).resolves.toMatchObject({
        currentStage: "implement",
        currentAttempt: 2,
        currentStageState: "running",
        latestOutputSummary: "last line with [REDACTED]",
        timeline: [
          expect.objectContaining({
            stageId: "implement",
            state: "running",
            currentAttempt: 2,
            latestOutput: "last line with [REDACTED]",
          }),
        ],
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.NITELY_WEB_OUTPUT_TOKEN;
      } else {
        process.env.NITELY_WEB_OUTPUT_TOKEN = previousToken;
      }
    }
  });

  it("exposes ready projected stages as pending current stage state", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-pending-ready",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-pending-ready",
      type: "stage.ready",
      stageId: "implement",
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-pending-ready",
        status: "running",
        currentStage: "implement",
        currentStageState: "pending",
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-pending-ready")).resolves.toMatchObject({
      currentStage: "implement",
      currentStageState: "pending",
      timeline: [
        expect.objectContaining({
          stageId: "implement",
          stageType: "agent",
          status: "started",
          state: "pending",
          attempts: 0,
        }),
      ],
    });
  });

  it("prefers a later failed-attempt error over older stage output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-failed-output");
    const attemptDirectory = join(runDirectory, "stages/implement/1");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      join(attemptDirectory, "stdout.log"),
      "older stdout line\n",
      "utf8",
    );
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-failed-output",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-failed-output",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "agent", attemptDirectory },
    });
    store.append({
      runId: "run-failed-output",
      type: "command.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: { command: "pnpm test", stdout: "older event stdout\n", stderr: "" },
    });
    store.append({
      runId: "run-failed-output",
      type: "stage.failed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: { error: "later failure error" },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-failed-output",
        currentStage: "implement",
        currentStageState: "awaiting-orchestrator",
        latestOutputSummary: "later failure error",
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-failed-output")).resolves.toMatchObject({
      latestOutputSummary: "later failure error",
      timeline: [
        expect.objectContaining({
          stageId: "implement",
          state: "awaiting-orchestrator",
          latestOutput: "later failure error",
        }),
      ],
    });
  });

  it("projects gate stages as gate-checking while gate data is latest", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-gate",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-gate",
      type: "stage.started",
      stageId: "review-gate",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "gate" },
    });
    store.append({
      runId: "run-gate",
      type: "gate.completed",
      stageId: "review-gate",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        gate: {
          id: "review-gate",
          stageId: "review-gate",
          mode: "review",
          status: "failed",
          createdAt: "2026-06-20T00:00:02.000Z",
        },
      },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-gate")).resolves.toMatchObject({
      currentStage: "review-gate",
      currentAttempt: 1,
      currentStageState: "gate-checking",
      timeline: [
        expect.objectContaining({
          stageId: "review-gate",
          state: "gate-checking",
        }),
      ],
    });
  });

  it.each([
    ["retry", "retrying"],
    ["rework", "reworking"],
    ["escalate", "escalated"],
  ] as const)(
    "projects %s orchestrator decisions as %s",
    async (action, expectedState) => {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
      const store = await createEventStore(repoPath);
      store.append({
        runId: `run-${action}`,
        type: "run.created",
        createdAt: "2026-06-20T00:00:00.000Z",
        payload: { flowName: "flow" },
      });
      store.append({
        runId: `run-${action}`,
        type: "stage.started",
        stageId: "implement",
        attempt: 1,
        createdAt: "2026-06-20T00:00:01.000Z",
        payload: { type: "agent" },
      });
      store.append({
        runId: `run-${action}`,
        type: "stage.failed",
        stageId: "implement",
        attempt: 1,
        createdAt: "2026-06-20T00:00:02.000Z",
        payload: { error: "missing artifact" },
      });
      store.append({
        runId: `run-${action}`,
        type: "orchestrator.decision",
        stageId: "implement",
        attempt: 1,
        createdAt: "2026-06-20T00:00:03.000Z",
        payload: {
          stageId: "implement",
          stageType: "agent",
          attempt: 1,
          maxAttempts: 3,
          action,
          reason: `${action} requested`,
          ...(action === "rework" ? { targetArtifact: "implementation" } : {}),
        },
      });
      store.close();

      await expect(getRunDetail(repoPath, `run-${action}`)).resolves.toMatchObject({
        currentStage: "implement",
        currentAttempt: 1,
        currentStageState: expectedState,
        latestDecision: expect.objectContaining({ action }),
        timeline: [
          expect.objectContaining({
            stageId: "implement",
            state: expectedState,
            latestDecision: expect.objectContaining({ action }),
          }),
        ],
      });
    },
  );

  it("keeps persisted latest output visible after projected run completion", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-complete-output");
    const attemptDirectory = join(runDirectory, "stages/test/1");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      join(attemptDirectory, "stderr.log"),
      "\nfirst warning\nfinal persisted output\n",
      "utf8",
    );
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-complete-output",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-complete-output",
      type: "stage.started",
      stageId: "test",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "command", attemptDirectory },
    });
    store.append({
      runId: "run-complete-output",
      type: "stage.completed",
      stageId: "test",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {},
    });
    store.append({
      runId: "run-complete-output",
      type: "run.completed",
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: {},
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-complete-output",
        status: "completed",
        currentStage: "test",
        currentAttempt: 1,
        currentStageState: "completed",
        latestOutputSummary: "final persisted output",
      }),
    ]);
  });

  it("prefers input snapshot metadata over raw connector references in event sessions", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const runDirectory = join(repoPath, ".nitely/runs/run-snapshot");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-snapshot",
      status: "completed",
      completedStages: ["implement"],
      inputs: {
        spec: {
          sourceUri: "github://Instask/nitely/issues/16",
          mediaType: "text/plain",
        },
      },
    });
    await writeJson(join(runDirectory, "inputs/spec/metadata.json"), {
      sourceUri: "specs/issues/016-first-class-agent-sessions-web-console-rework-1-spec.md",
      mediaType: "text/markdown",
      metadata: { filename: "016-first-class-agent-sessions-web-console-rework-1-spec.md" },
    });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-snapshot",
      type: "run.created",
      createdAt: "2026-06-19T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap",
        inputs: {
          spec: {
            connector: "local-file",
            uri: "specs/foo.md",
          },
        },
      },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-snapshot")).resolves.toMatchObject({
      contextManifest: [
        {
          id: "spec",
          sourceUri: "specs/issues/016-first-class-agent-sessions-web-console-rework-1-spec.md",
          mediaType: "text/markdown",
          filename: "016-first-class-agent-sessions-web-console-rework-1-spec.md",
          kind: "local",
        },
      ],
    });
  });

  it("prefers the durable context manifest when present", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-manifest");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-manifest",
      status: "completed",
      completedStages: ["implement"],
      inputs: {
        spec: {
          sourceUri: "raw-secret-token=should-not-win",
          mediaType: "text/plain",
        },
      },
    });
    await writeJson(join(runDirectory, "context-manifest.json"), {
      version: 1,
      runId: "run-manifest",
      generatedAt: "2026-06-20T00:00:00.000Z",
      entries: [
        {
          id: "spec",
          kind: "external-input",
          connector: "local-file",
          sourceUri: "specs/safe.md",
          mediaType: "text/markdown",
          filename: "safe.md",
          runRelativePath: "inputs/spec/content",
          policy: { decision: "allowed" },
        },
        {
          id: "implementation",
          kind: "generated-artifact",
          connector: "generated",
          sourceUri: "stages/implement/1/implementation.md",
          mediaType: "text/markdown",
          filename: "implementation.md",
          runRelativePath: "stages/implement/1/implementation.md",
          policy: { decision: "allowed" },
        },
      ],
    });

    await expect(getRunDetail(repoPath, "run-manifest")).resolves.toMatchObject({
      contextManifest: [
        {
          id: "spec",
          sourceUri: "specs/safe.md",
          mediaType: "text/markdown",
          filename: "safe.md",
          kind: "local",
          path: "inputs/spec/content",
        },
        {
          id: "implementation",
          sourceUri: "stages/implement/1/implementation.md",
          mediaType: "text/markdown",
          filename: "implementation.md",
          kind: "generated",
          path: "stages/implement/1/implementation.md",
        },
      ],
    });
  });

  it("returns durable artifact registry metadata in run details with redaction", async () => {
    const previousSecret = process.env.NITELY_ARTIFACT_SECRET_TOKEN;
    process.env.NITELY_ARTIFACT_SECRET_TOKEN = "artifact-secret-value";
    try {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
      const runDirectory = join(repoPath, ".nitely/runs/run-artifacts");
      await writeJson(join(runDirectory, "run.json"), {
        runId: "run-artifacts",
        status: "completed",
        completedStages: ["implement"],
        inputs: {},
      });
      await writeJson(join(runDirectory, "artifacts.json"), {
        runId: "run-artifacts",
        artifacts: [
          {
            id: "implementation",
            name: "Implementation summary",
            type: "implementation",
            description: "Summary with artifact-secret-value",
            producer: "implement",
            mediaType: "text/markdown",
            schema: { path: "artifact-secret-value/schema.json" },
            version: "1",
            path: "stages/implement/1/implementation.md",
            filename: "implementation.md",
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        ],
      });

      const detail = await getRunDetail(repoPath, "run-artifacts");

      expect(detail.artifacts).toEqual([
        expect.objectContaining({
          id: "implementation",
          name: "Implementation summary",
          type: "implementation",
          description: "Summary with [REDACTED]",
          producer: "implement",
          mediaType: "text/markdown",
          schema: { path: "[REDACTED]/schema.json" },
          version: "1",
          path: "stages/implement/1/implementation.md",
          filename: "implementation.md",
          createdAt: "2026-06-20T00:00:00.000Z",
        }),
      ]);
      expect(JSON.stringify(detail.artifacts)).not.toContain(
        "artifact-secret-value",
      );
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_ARTIFACT_SECRET_TOKEN;
      } else {
        process.env.NITELY_ARTIFACT_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("assembles an evidence timeline from inputs, artifacts, gates, and external effects", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-evidence");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-evidence",
      status: "completed",
      completedStages: ["plan", "approve-plan"],
      changeRequestUrl: "https://github.com/example/repo/pull/7",
      branchName: "nitely/run-evidence",
      inputs: {},
    });
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-evidence",
      artifacts: [
        {
          id: "seed",
          producer: "external",
          mediaType: "application/json",
          sha256: "abc123",
          size: 42,
          sourceUri: "seeds/k.json",
        },
        {
          id: "site-plan",
          type: "autofarm.site-plan",
          producer: "plan",
          mediaType: "application/json",
          sha256: "def456",
          size: 99,
        },
        {
          id: "approve-plan",
          type: "gate.approval",
          producer: "approve-plan",
          mediaType: "application/vnd.nitely.gate+json",
          gate: {
            gateId: "approve-plan",
            state: "approved",
            actor: "system:auto",
            reason: "looks good",
          },
        },
      ],
    });

    const detail = await getRunDetail(repoPath, "run-evidence");
    const kinds = detail.evidenceTimeline.map((item) => item.kind);
    expect(kinds).toContain("input");
    expect(kinds).toContain("artifact");
    expect(kinds).toContain("gate");
    expect(kinds).toContain("external-effect");

    const input = detail.evidenceTimeline.find((item) => item.kind === "input");
    expect(input?.detail.sha256).toBe("abc123");
    const gate = detail.evidenceTimeline.find((item) => item.kind === "gate");
    expect(gate?.detail.actor).toBe("system:auto");
    expect(gate?.detail.reason).toBe("looks good");
    const effect = detail.evidenceTimeline.find(
      (item) => item.kind === "external-effect",
    );
    expect(effect?.detail.changeRequestUrl).toBe(
      "https://github.com/example/repo/pull/7",
    );
  });

  it("redacts caller-provided secrets from durable artifact registry metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-artifact-secret");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-artifact-secret",
      status: "completed",
      completedStages: ["implement"],
      inputs: {},
    });
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-artifact-secret",
      artifacts: [
        {
          id: "implementation-provider-artifact-secret",
          name: "provider-artifact-secret name",
          type: "provider-artifact-secret type",
          description: "provider-artifact-secret description",
          producer: "implement-provider-artifact-secret",
          mediaType: "text/provider-artifact-secret",
          schema: { marker: "provider-artifact-secret" },
          version: "provider-artifact-secret version",
          path: "stages/provider-artifact-secret/implementation.md",
          sourceUri: "generated://provider-artifact-secret",
          filename: "provider-artifact-secret.md",
          createdAt: "2026-06-20T00:00:00.000Z provider-artifact-secret",
        },
      ],
    });

    const detail = await getRunDetail(repoPath, "run-artifact-secret", {
      redactionSecrets: ["provider-artifact-secret"],
    });
    const serialized = JSON.stringify(detail.artifacts);

    expect(serialized).not.toContain("provider-artifact-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts caller-provided secrets from projected artifact metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-projected-artifact-secret",
      type: "run.created",
      payload: {
        flowName: "projected-artifact-secret",
        inputs: {},
      },
    });
    store.append({
      runId: "run-projected-artifact-secret",
      type: "artifact.published",
      payload: {
        artifact: {
          id: "implementation-provider-artifact-secret",
          name: "provider-artifact-secret name",
          type: "provider-artifact-secret type",
          description: "provider-artifact-secret description",
          producer: "implement-provider-artifact-secret",
          mediaType: "text/provider-artifact-secret",
          schema: { marker: "provider-artifact-secret" },
          version: "provider-artifact-secret version",
          path: "stages/provider-artifact-secret/implementation.md",
          sourceUri: "generated://provider-artifact-secret",
          filename: "provider-artifact-secret.md",
          createdAt: "2026-06-20T00:00:00.000Z provider-artifact-secret",
        },
      },
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-projected-artifact-secret", {
      redactionSecrets: ["provider-artifact-secret"],
    });
    const serialized = JSON.stringify(detail.artifacts);

    expect(serialized).not.toContain("provider-artifact-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts caller-provided secrets from context-manifest artifact fallback metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-fallback-artifact-secret");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-fallback-artifact-secret",
      status: "completed",
      completedStages: ["implement"],
      inputs: {},
    });
    await writeJson(join(runDirectory, "context-manifest.json"), {
      version: 1,
      runId: "run-fallback-artifact-secret",
      generatedAt: "2026-06-20T00:00:00.000Z",
      entries: [
        {
          id: "implementation-provider-artifact-secret",
          kind: "generated-artifact",
          connector: "generated",
          sourceUri: "stages/provider-artifact-secret/implementation.md",
          mediaType: "text/provider-artifact-secret",
          filename: "provider-artifact-secret.md",
          runRelativePath: "stages/provider-artifact-secret/implementation.md",
          policy: { decision: "allowed" },
        },
      ],
    });

    const detail = await getRunDetail(repoPath, "run-fallback-artifact-secret", {
      redactionSecrets: ["provider-artifact-secret"],
    });
    const serialized = JSON.stringify(detail.artifacts);

    expect(serialized).not.toContain("provider-artifact-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts secret-bearing durable context manifest metadata in run details", async () => {
    const previousSecret = process.env.NITELY_MANIFEST_SECRET_TOKEN;
    process.env.NITELY_MANIFEST_SECRET_TOKEN = "manifest-secret-value";
    try {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
      const runDirectory = join(repoPath, ".nitely/runs/run-manifest-redaction");
      await writeJson(join(runDirectory, "run.json"), {
        runId: "run-manifest-redaction",
        status: "completed",
        completedStages: ["implement"],
        inputs: {},
      });
      await writeJson(join(runDirectory, "context-manifest.json"), {
        version: 1,
        runId: "run-manifest-redaction",
        generatedAt: "2026-06-20T00:00:00.000Z",
        entries: [
          {
            id: "secret",
            kind: "external-input",
            connector: "local-file",
            sourceUri: "secrets/manifest-secret-value.txt",
            mediaType: "text/plain",
            filename: "manifest-secret-value.txt",
            policy: {
              decision: "warned",
              reason: "matched exclude pattern secrets/*manifest-secret-value*",
              matchedPattern: "secrets/*manifest-secret-value*",
            },
          },
        ],
      });

      const detail = await getRunDetail(repoPath, "run-manifest-redaction");
      const serialized = JSON.stringify(detail.contextManifest);
      expect(serialized).not.toContain("manifest-secret-value");
      expect(serialized).toContain("[REDACTED]");
      expect(detail.contextManifest).toEqual([
        expect.objectContaining({
          id: "secret",
          sourceUri: "secrets/[REDACTED].txt",
          filename: "[REDACTED].txt",
          kind: "local",
        }),
      ]);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_MANIFEST_SECRET_TOKEN;
      } else {
        process.env.NITELY_MANIFEST_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("preserves stage type and resumed markers in projected timelines", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-timeline",
      type: "run.created",
      createdAt: "2026-06-19T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-timeline",
      type: "stage.started",
      stageId: "sync",
      attempt: 1,
      createdAt: "2026-06-19T00:00:01.000Z",
      payload: { type: "command", resumedFrom: "run-parent" },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-timeline")).resolves.toMatchObject({
      timeline: [
        {
          stageId: "sync",
          stageType: "command",
          resumedFrom: "run-parent",
        },
      ],
    });
  });

  it("redacts session logs, evidence, and review artifacts returned to the web", async () => {
    const previousEnv = process.env.NITELY_GITHUB_TOKEN;
    const previousAuthEnv = process.env.NITELY_AUTH_STATE;
    const previousKeyEnv = process.env.PROVIDER_PRIVATE_KEY;
    process.env.NITELY_GITHUB_TOKEN = "env-token-value-12345";
    process.env.NITELY_AUTH_STATE = "auth-state-secret-123";
    process.env.PROVIDER_PRIVATE_KEY = "private-key-secret-123";
    try {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
      const runDirectory = join(repoPath, ".nitely/runs/run-secret");
      await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
      await mkdir(join(runDirectory, "stages/review/1"), { recursive: true });
      await writeJson(join(runDirectory, "run.json"), {
        runId: "run-secret",
        status: "failed",
        completedStages: ["implement"],
        inputs: {
          spec: {
            sourceUri: ".nitely/tasks/task-secret/spec.md",
            preview: "password=hunter2",
          },
        },
      });
      await writeFile(
        join(runDirectory, "stages/implement/1/stdout.log"),
        "TOKEN=secret-value\nAuthorization: Bearer abc123\nghp_abcdefghijklmnopqrstuvwxyz123456\nauth-state-secret-123\n",
        "utf8",
      );
      await writeFile(
        join(runDirectory, "stages/implement/1/stderr.log"),
        "OPENAI_API_KEY=sk-secretkey1234567890\nenv-token-value-12345\nprivate-key-secret-123\n",
        "utf8",
      );
      await writeFile(
        join(runDirectory, "evidence.md"),
        "Evidence includes cookie=session-secret and auth-state-secret-123",
        "utf8",
      );
      await writeFile(
        join(runDirectory, "stages/review/1/review.md"),
        "# Findings\n\nP1 token=review-secret and private-key-secret-123\n\nP2 Noisy issue\n",
        "utf8",
      );

      const detail = await getRunDetail(repoPath, "run-secret");
      const serialized = JSON.stringify(detail);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("secret-value");
      expect(serialized).not.toContain("Bearer abc123");
      expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(serialized).not.toContain("sk-secretkey1234567890");
      expect(serialized).not.toContain("env-token-value-12345");
      expect(serialized).not.toContain("auth-state-secret-123");
      expect(serialized).not.toContain("private-key-secret-123");
      expect(serialized).not.toContain("review-secret");
      expect(detail.reviewFindings).toMatchObject([
        {
          stageId: "review",
          attempt: "1",
          path: "stages/review/1/review.md",
          severities: { P1: 1, P2: 1 },
          content: expect.stringContaining("[REDACTED]"),
        },
      ]);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.NITELY_GITHUB_TOKEN;
      } else {
        process.env.NITELY_GITHUB_TOKEN = previousEnv;
      }
      if (previousAuthEnv === undefined) {
        delete process.env.NITELY_AUTH_STATE;
      } else {
        process.env.NITELY_AUTH_STATE = previousAuthEnv;
      }
      if (previousKeyEnv === undefined) {
        delete process.env.PROVIDER_PRIVATE_KEY;
      } else {
        process.env.PROVIDER_PRIVATE_KEY = previousKeyEnv;
      }
    }
  });

  it("links parent and child sessions for rework chains", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    for (const runId of ["run-parent", "run-child", "run-sibling"]) {
      await mkdir(join(repoPath, ".nitely/runs", runId), { recursive: true });
    }
    await writeJson(join(repoPath, ".nitely/runs/run-parent/run.json"), {
      runId: "run-parent",
      status: "completed",
      completedStages: ["implement"],
      inputs: {},
      changeRequestUrl: "https://github.com/example/repo/pull/7",
    });
    await writeJson(join(repoPath, ".nitely/runs/run-child/run.json"), {
      runId: "run-child",
      status: "incomplete",
      completedStages: [],
      inputs: {},
      priorRunId: "run-parent",
      trigger: {
        type: "github-pr-comment",
        prNumber: 7,
        prUrl: "https://github.com/example/repo/pull/7",
        commentUrl: "https://github.com/example/repo/pull/7#issuecomment-1",
      },
    });
    await writeJson(join(repoPath, ".nitely/runs/run-sibling/run.json"), {
      runId: "run-sibling",
      status: "failed",
      completedStages: [],
      inputs: {},
      trigger: { priorRunId: "run-parent" },
    });

    await expect(getRunDetail(repoPath, "run-child")).resolves.toMatchObject({
      runId: "run-child",
      priorRunId: "run-parent",
      parentRun: {
        runId: "run-parent",
        sessionId: "run-parent",
        changeRequestUrl: "https://github.com/example/repo/pull/7",
      },
      childRuns: [],
    });
    await expect(getRunDetail(repoPath, "run-parent")).resolves.toMatchObject({
      runId: "run-parent",
      childRuns: expect.arrayContaining([
        expect.objectContaining({ runId: "run-child", sessionId: "run-child" }),
        expect.objectContaining({ runId: "run-sibling", sessionId: "run-sibling" }),
      ]),
    });
  });

  it("surfaces per-stage and run-total context usage in the detail view", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-context-usage",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "implement-spec-bootstrap" },
    });
    store.append({
      runId: "run-context-usage",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-context-usage",
      type: "stage.context.usage",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        promptBytes: 1200,
        approxTokens: 300,
        inputBytesInlined: 800,
        inputBytesSaved: 5000,
        inputCount: 2,
      },
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-context-usage");
    expect(detail.contextUsage?.inputBytesSaved).toBeGreaterThan(0);
    const stage = detail.timeline.find((item) => item.stageId === "implement");
    expect(stage?.contextUsage?.promptBytes).toBeGreaterThan(0);
  });

  it("surfaces per-stage and run-total runtime usage in the detail view", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-runtime-usage",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "implement-spec-bootstrap" },
    });
    store.append({
      runId: "run-runtime-usage",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "agent", runtime: "codex" },
    });
    store.append({
      runId: "run-runtime-usage",
      type: "stage.runtime.usage",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        contextWindow: 200000,
        estimatedCostUsd: 0.02,
        raw: { provider: "mock" },
      },
    });
    store.append({
      runId: "run-runtime-usage",
      type: "stage.started",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:03.000Z",
      payload: { type: "gate", runtime: "codex" },
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-runtime-usage");
    expect(detail.runtimeUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      knownAttempts: 1,
      unknownAttempts: 1,
    });
    const implement = detail.timeline.find((item) => item.stageId === "implement");
    expect(implement?.runtimeUsage?.totalTokens).toBe(150);
    const review = detail.timeline.find((item) => item.stageId === "review");
    expect(review?.runtimeUsage).toMatchObject({
      knownAttempts: 0,
      unknownAttempts: 1,
    });
  });

  it("surfaces per-stage budget status in the timeline", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-budget-trimmed",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "implement-spec-bootstrap" },
    });
    store.append({
      runId: "run-budget-trimmed",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-budget-trimmed",
      type: "budget.trimmed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        budget: 200,
        approxTokensBefore: 250,
        approxTokensAfter: 180,
        trimmedInputIds: ["spec"],
      },
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-budget-trimmed");
    const stage = detail.timeline.find((item) => item.stageId === "implement");
    expect(stage?.budget?.status).toBe("trimmed");
    expect(stage?.budget?.approxTokensAfter).toBe(180);
    expect(detail.budgetSummary).toMatchObject({
      trimmedEvents: 1,
      exceededEvents: 0,
      trimmedTokensBefore: 250,
      trimmedTokensAfter: 180,
      topConsumers: [
        {
          stageId: "implement",
          attempt: 1,
          kind: "tool-output",
          approxTokens: 250,
          budget: 200,
          approxTokensAfter: 180,
        },
      ],
    });
  });
});
