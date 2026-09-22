import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFORMANCE_REPORT_MEDIA_TYPE } from "../../src/conformance/report.js";
import { createContextKnowledgeEntry } from "../../src/context-kg/store.js";
import { EventStore } from "../../src/events/store.js";
import { feedbackMemoryEntryId } from "../../src/review-feedback/memory.js";
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

  function recentIso(offsetMs = 0): string {
    return new Date(Date.now() + offsetMs).toISOString();
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
      runEligibilityOverride: {
        actor: "operator",
        reason: "accepted dependency risk",
        acceptedReasonCodes: ["dependency.incomplete:upstream"],
      },
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
        feedback: {
          schemaVersion: 1,
          id: "github:Instask/nitely#15:comment:100",
          source: "github-pr-discussion",
          action: "rework",
          instruction: "fix auth",
          raw: {
            provider: "github",
            kind: "issue-comment",
            commentId: "100",
            commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-100",
            body: "@nitely rework fix auth",
            authorLogin: "alice",
            createdAt: "2026-06-20T00:00:00Z",
          },
          route: {
            target: "implementation",
            confidence: "inferred",
            reason: "Default route for code, tests, or localized PR review feedback.",
            requiresOperatorApproval: false,
          },
          lineage: {
            provider: "github",
            owner: "Instask",
            repository: "nitely",
            prNumber: 15,
            prUrl: "https://github.com/Instask/nitely/pull/15",
            priorRunId: "run-prev",
            ingestedAt: "2026-06-20T00:01:00.000Z",
          },
          memoryProposals: [],
        },
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
    await writeJson(join(runDirectory, "reproducibility.json"), {
      version: 1,
      runId: "run-1",
      generatedAt: "2026-07-08T00:00:00.000Z",
      replayability: "diagnostic-only",
      repo: { path: repoPath, headCommit: "abc123" },
      flow: { name: "implement-spec-bootstrap" },
      inputs: [],
      context: {
        policySha256: "sha256:policy",
        constitution: { loaded: false, path: ".nitely/constitution.md" },
        projectInstructions: {
          loaded: false,
          path: ".nitely/instructions.json",
        },
      },
      runtimes: [],
      commands: [],
      skills: [],
      providers: [],
      environment: {
        nodeVersion: "v24.0.0",
        platform: "darwin",
        arch: "arm64",
      },
      nonDeterministicFactors: [],
      missingReplayPrerequisites: ["repo head commit could not be resolved"],
    });
    await writeJson(join(runDirectory, "toolchain-preflight.json"), {
      version: 1,
      runId: "run-1",
      generatedAt: "2026-07-08T00:00:00.000Z",
      repoPath,
      worktreePath: `${runDirectory}/worktree`,
      executionBackend: "local",
      commandEnvironment: {
        envSource: "execution-backend-env",
        shellMode: "non-login sh -c",
        pathEntryCount: 2,
        repairs: [],
      },
      toolchainFiles: [{ path: "package.json", kind: "node-package" }],
      executables: [
        { name: "git", available: true, path: "/usr/bin/git" },
        { name: "pnpm", available: false },
      ],
    });

    await expect(listRuns(repoPath)).resolves.toMatchObject([
      {
        runId: "run-1",
        status: "completed",
        branchName: "nitely/run-1",
        ownerId: "usr_owner",
        runEligibilityOverride: {
          actor: "operator",
          reason: "accepted dependency risk",
          acceptedReasonCodes: ["dependency.incomplete:upstream"],
        },
        completedStages: ["implement"],
        trigger: {
          type: "github-pr-comment",
          commentId: "100",
          authorLogin: "alice",
        },
        reviewFeedback: {
          id: "github:Instask/nitely#15:comment:100",
          route: {
            target: "implementation",
          },
        },
      },
    ]);
    await expect(getRunDetail(repoPath, "run-1")).resolves.toMatchObject({
      runId: "run-1",
      status: "completed",
      flowName: "implement-spec-bootstrap",
      branchName: "nitely/run-1",
      ownerId: "usr_owner",
      runEligibilityOverride: {
        actor: "operator",
        reason: "accepted dependency risk",
        acceptedReasonCodes: ["dependency.incomplete:upstream"],
      },
      worktreePath: `${runDirectory}/worktree`,
      completedStages: ["implement"],
      trigger: {
        type: "github-pr-comment",
        commentId: "100",
        commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-100",
      },
      reviewFeedback: {
        action: "rework",
        instruction: "fix auth",
        route: {
          target: "implementation",
          confidence: "inferred",
        },
        lineage: {
          priorRunId: "run-prev",
        },
      },
      evidence: "Evidence body",
      reproducibility: {
        replayability: "diagnostic-only",
        manifestPath: join(runDirectory, "reproducibility.json"),
        summary: "missing prerequisites prevent replay",
        missingReplayPrerequisites: ["repo head commit could not be resolved"],
        nonDeterministicFactors: [],
      },
      toolchainPreflight: {
        runId: "run-1",
        executionBackend: "local",
        commandEnvironment: {
          envSource: "execution-backend-env",
          shellMode: "non-login sh -c",
          repairs: [],
        },
        toolchainFiles: [{ path: "package.json", kind: "node-package" }],
      },
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

  it("enriches review feedback memory proposals with context-kg entry state", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-memory");
    const feedbackId = "github:Instask/nitely#15:comment:memory";
    await mkdir(runDirectory, { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-memory",
      flowName: "rework-pr-bootstrap",
      completedStages: ["implement"],
      inputs: {},
      trigger: {
        type: "github-pr-comment",
        feedback: {
          schemaVersion: 1,
          id: feedbackId,
          source: "github-pr-discussion",
          action: "rework",
          instruction: "memory: prefer local preflight",
          raw: {
            provider: "github",
            kind: "issue-comment",
            commentId: "memory",
            commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-memory",
            body: "@nitely rework memory: prefer local preflight",
            authorLogin: "alice",
            createdAt: "2026-06-20T00:00:00Z",
          },
          route: {
            target: "memory",
            confidence: "explicit",
            reason: "Instruction explicitly targets reusable project memory.",
            requiresOperatorApproval: true,
          },
          lineage: {
            provider: "github",
            owner: "Instask",
            repository: "nitely",
            prNumber: 15,
            prUrl: "https://github.com/Instask/nitely/pull/15",
            ingestedAt: "2026-06-20T00:01:00.000Z",
          },
          memoryProposals: [
            {
              category: "feedback",
              title: "Original reviewer guidance",
              body: "Original body",
              status: "proposed",
              tags: ["review-feedback", "memory"],
              keywords: ["memory"],
              source: {
                type: "review",
                uri: "https://github.com/Instask/nitely/pull/15#issuecomment-memory",
              },
            },
          ],
        },
      },
    });
    const entryId = feedbackMemoryEntryId({ id: feedbackId }, 0);
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "feedback",
        title: "Approved reviewer guidance",
        body: "Prefer local preflight checks before publishing.",
        status: "approved",
        tags: ["review-feedback"],
        keywords: ["preflight"],
        source: {
          type: "review",
          uri: "https://github.com/Instask/nitely/pull/15#issuecomment-memory",
          runId: "run-memory",
        },
      },
      { createId: () => entryId, now: () => "2026-06-20T00:02:00.000Z" },
    );

    await expect(getRunDetail(repoPath, "run-memory")).resolves.toMatchObject({
      reviewFeedback: {
        memoryProposals: [
          {
            contextKnowledgeEntryId: entryId,
            contextKnowledgeStatus: "approved",
            contextKnowledgeVersion: 1,
            title: "Approved reviewer guidance",
            body: "Prefer local preflight checks before publishing.",
            tags: ["review-feedback"],
            keywords: ["preflight"],
          },
        ],
      },
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
      createdAt: recentIso(),
      payload: {
        flowName: "implement-spec-bootstrap",
        flowPath: "flows/implement-spec-bootstrap.json",
        ownerId: "usr_events",
        runEligibilityOverride: {
          actor: "operator",
          reason: "accepted dependency risk",
          acceptedReasonCodes: ["dependency.incomplete:upstream"],
        },
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
      createdAt: recentIso(1_000),
      payload: { worktreePath: join(runDirectory, "worktree") },
    });
    store.append({
      runId: "run-events",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: recentIso(2_000),
      payload: { attemptDirectory: join(runDirectory, "stages/implement/1") },
    });
    store.append({
      runId: "run-events",
      type: "command.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: recentIso(3_000),
      payload: {
        command: "pnpm test",
        stdout: "event stdout",
        stderr: "",
        environmentRepairs: [
          {
            id: "python-to-python3-compatibility-shim",
            description:
              "Added a python compatibility shim that delegates to python3 because python was unavailable.",
            scope: "outside-worktree",
            path: "/tmp/nitely-python-compat-test",
          },
        ],
      },
    });
    store.append({
      runId: "run-events",
      type: "gate.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: recentIso(4_000),
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
      createdAt: recentIso(5_000),
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
        status: "running",
        ownerId: "usr_events",
        runEligibilityOverride: {
          actor: "operator",
          reason: "accepted dependency risk",
          acceptedReasonCodes: ["dependency.incomplete:upstream"],
        },
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
      status: "running",
      runEligibilityOverride: {
        actor: "operator",
        reason: "accepted dependency risk",
        acceptedReasonCodes: ["dependency.incomplete:upstream"],
      },
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
          status: "started",
          state: "gate-checking",
          gate: {
            id: "implement-gate",
            status: "passed",
            mode: "deterministic",
          },
          attempts: 1,
          startedAt: expect.any(String),
          attemptDirectory: join(runDirectory, "stages/implement/1"),
          outputPath: join(runDirectory, "stages/implement/1/output.md"),
          artifactManifestPath: join(
            runDirectory,
            "stages/implement/1/artifact.json",
          ),
          stdoutPath: join(runDirectory, "stages/implement/1/stdout.log"),
          stderrPath: join(runDirectory, "stages/implement/1/stderr.log"),
          generatedArtifactPaths: ["stages/implement/1/implementation.md"],
          details: {
            fields: expect.arrayContaining([
              expect.objectContaining({
                label: "Environment repairs",
                value: expect.stringContaining("Added a python compatibility shim"),
              }),
            ]),
            events: expect.arrayContaining([
              expect.objectContaining({
                type: "command.completed",
                summary: expect.stringContaining("repairs 1"),
              }),
            ]),
          },
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

  it("returns declared workflow progress including pending future stages", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-workflow-progress");
    await mkdir(join(runDirectory, "stages/spec/1"), { recursive: true });
    await mkdir(join(runDirectory, "stages/approve/1"), { recursive: true });
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-workflow-progress",
      type: "run.created",
      createdAt: "2026-06-24T00:00:00.000Z",
      payload: {
        flowName: "issue-to-pr",
        workflowStages: [
          {
            id: "spec",
            type: "agent",
            inputs: ["issue"],
            outputs: ["spec"],
            maxAttempts: 2,
          },
          {
            id: "approve",
            type: "approval",
            inputs: ["spec"],
            outputs: [],
            maxAttempts: 1,
          },
          {
            id: "implement",
            type: "agent",
            inputs: ["spec"],
            outputs: ["change"],
            maxAttempts: 3,
          },
        ],
      },
    });
    store.append({
      runId: "run-workflow-progress",
      type: "stage.started",
      stageId: "spec",
      attempt: 1,
      createdAt: "2026-06-24T00:00:01.000Z",
      payload: {
        type: "agent",
        attemptDirectory: join(runDirectory, "stages/spec/1"),
      },
    });
    store.append({
      runId: "run-workflow-progress",
      type: "artifact.published",
      stageId: "spec",
      createdAt: "2026-06-24T00:00:02.000Z",
      payload: {
        artifact: {
          id: "spec",
          producer: "spec",
          path: "stages/spec/1/spec.md",
          mediaType: "text/markdown",
        },
      },
    });
    store.append({
      runId: "run-workflow-progress",
      type: "stage.completed",
      stageId: "spec",
      attempt: 1,
      createdAt: "2026-06-24T00:00:03.000Z",
      payload: {},
    });
    store.append({
      runId: "run-workflow-progress",
      type: "stage.started",
      stageId: "approve",
      attempt: 1,
      createdAt: "2026-06-24T00:00:04.000Z",
      payload: {
        type: "approval",
        attemptDirectory: join(runDirectory, "stages/approve/1"),
      },
    });
    store.append({
      runId: "run-workflow-progress",
      type: "approval.requested",
      stageId: "approve",
      attempt: 1,
      createdAt: "2026-06-24T00:00:05.000Z",
      payload: {
        approvalId: "approve-1",
        prompt: "Approve the generated spec.",
      },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-workflow-progress")).resolves.toMatchObject({
      currentStage: "approve",
      currentStageState: "awaiting-approval",
      workflowProgress: [
        {
          stageId: "spec",
          label: "spec",
          stageType: "agent",
          state: "completed",
          status: "completed",
          attempts: 1,
          current: false,
          maxAttempts: 2,
          inputs: ["issue"],
          outputs: ["spec"],
          artifacts: [
            {
              id: "spec",
              path: "stages/spec/1/spec.md",
            },
          ],
        },
        {
          stageId: "approve",
          label: "approve",
          stageType: "approval",
          state: "awaiting-approval",
          status: "awaiting-approval",
          attempts: 1,
          current: true,
          maxAttempts: 1,
          inputs: ["spec"],
          outputs: [],
          approval: {
            id: "approve-1",
            status: "pending",
            prompt: "Approve the generated spec.",
          },
          nextAction: "Approve or reject the pending gate.",
        },
        {
          stageId: "implement",
          label: "implement",
          stageType: "agent",
          state: "pending",
          status: "pending",
          attempts: 0,
          current: false,
          maxAttempts: 3,
          inputs: ["spec"],
          outputs: ["change"],
          nextAction: "Waiting for upstream stages.",
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
          blocker: expect.objectContaining(blocker),
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
        createdAt: recentIso(),
        payload: { flowName: "implement-spec-bootstrap" },
      });
      store.append({
        runId: "run-live",
        type: "stage.started",
        stageId: "implement",
        attempt: 2,
        createdAt: recentIso(1_000),
        payload: { attemptDirectory, type: "agent" },
      });
      store.close();

      await expect(listRuns(repoPath)).resolves.toEqual([
        expect.objectContaining({
          runId: "run-live",
          status: "running",
          currentStage: "implement",
          currentAttempt: 2,
          currentStageState: "running",
          latestOutputSummary: "last line with [REDACTED]",
        }),
      ]);
      await expect(getRunDetail(repoPath, "run-live")).resolves.toMatchObject({
        status: "running",
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

  it("projects a stale open attempt as interrupted for run summaries and details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-stale",
      type: "run.created",
      createdAt: "2000-01-01T00:00:00.000Z",
      payload: { flowName: "implement-spec-bootstrap" },
    });
    store.append({
      runId: "run-stale",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2000-01-01T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-stale",
      type: "stage.context.usage",
      stageId: "implement",
      attempt: 1,
      createdAt: "2000-01-01T00:00:02.000Z",
      payload: {
        promptBytes: 1200,
        approxTokens: 300,
        inputBytesInlined: 800,
        inputBytesSaved: 5000,
        inputCount: 2,
      },
    });
    store.append({
      runId: "run-stale",
      type: "change.evidence.refresh_failed",
      createdAt: recentIso(),
      payload: { reason: "unrelated run-level activity" },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-stale",
        status: "interrupted",
        currentStage: "implement",
        currentAttempt: 1,
        currentStageState: "interrupted",
        recovery: expect.objectContaining({
          needsRecovery: true,
          state: "stale",
          stale: true,
          reason: "open attempt exceeded stale threshold",
          stageId: "implement",
          attempt: 1,
          latestEventAt: "2000-01-01T00:00:02.000Z",
        }),
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-stale")).resolves.toMatchObject({
      runId: "run-stale",
      status: "interrupted",
      currentStage: "implement",
      currentAttempt: 1,
      currentStageState: "interrupted",
      recovery: expect.objectContaining({
        needsRecovery: true,
        state: "stale",
        stale: true,
        reason: "open attempt exceeded stale threshold",
        stageId: "implement",
        attempt: 1,
        latestEventAt: "2000-01-01T00:00:02.000Z",
      }),
      timeline: [
        expect.objectContaining({
          stageId: "implement",
          state: "interrupted",
          currentAttempt: 1,
        }),
      ],
    });
  });

  it("replaces numeric output with a live process and artifact-readiness summary", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-operator-live");
    const attemptDirectory = join(runDirectory, "stages/test/1");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(join(attemptDirectory, "stdout.log"), "stdout not captured\n79,337\n", "utf8");
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-operator-live",
      type: "run.created",
      createdAt: recentIso(),
      payload: {
        flowName: "operator-live",
        branchName: "nitely/run-operator-live",
        workflowStages: [
          {
            id: "test",
            type: "command",
            command: "pnpm test --runInBand",
            inputs: [],
            outputs: ["junit", "coverage"],
          },
        ],
      },
    });
    store.append({
      runId: "run-operator-live",
      type: "stage.started",
      stageId: "test",
      attempt: 1,
      createdAt: recentIso(1_000),
      payload: { type: "command", attemptDirectory },
    });
    store.append({
      runId: "run-operator-live",
      type: "stage.heartbeat",
      stageId: "test",
      attempt: 1,
      createdAt: recentIso(2_000),
      payload: { count: 1 },
    });
    store.append({
      runId: "run-operator-live",
      type: "artifact.published",
      stageId: "test",
      attempt: 1,
      createdAt: recentIso(3_000),
      payload: {
        artifact: {
          id: "junit",
          producer: "test",
          mediaType: "application/xml",
          path: "stages/test/1/junit.xml",
        },
      },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-operator-live",
        status: "running",
        statusSummary: expect.stringMatching(
          /Running test attempt 1.*pnpm test --runInBand.*process active.*artifacts 1\/2 ready/i,
        ),
        latestOutputSummary: expect.not.stringMatching(/^79,337$/),
        currentProcess: expect.objectContaining({
          kind: "command",
          command: "pnpm test --runInBand",
          state: "running",
          alive: true,
        }),
        currentArtifactReadiness: {
          status: "partial",
          declaredIds: ["junit", "coverage"],
          readyIds: ["junit"],
          missingIds: ["coverage"],
        },
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-operator-live")).resolves.toMatchObject({
      timeline: [
        expect.objectContaining({
          stageId: "test",
          process: expect.objectContaining({
            command: "pnpm test --runInBand",
            state: "running",
            alive: true,
          }),
          artifactReadiness: {
            status: "partial",
            declaredIds: ["junit", "coverage"],
            readyIds: ["junit"],
            missingIds: ["coverage"],
          },
        }),
      ],
    });
  });

  it("distinguishes pending, ready, and missing declared artifacts", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    const appendCreated = (runId: string, createdAt: string): void => {
      store.append({
        runId,
        type: "run.created",
        createdAt,
        payload: {
          flowName: "artifact-readiness",
          workflowStages: [
            {
              id: "build",
              type: "command",
              command: "pnpm build",
              inputs: [],
              outputs: ["bundle"],
            },
          ],
        },
      });
    };

    appendCreated("run-artifact-pending", recentIso());
    store.append({
      runId: "run-artifact-pending",
      type: "stage.ready",
      stageId: "build",
      createdAt: recentIso(1_000),
      payload: { type: "command" },
    });

    for (const [runId, publishArtifact] of [
      ["run-artifact-ready", true],
      ["run-artifact-missing", false],
    ] as const) {
      appendCreated(runId, recentIso());
      store.append({
        runId,
        type: "stage.started",
        stageId: "build",
        attempt: 1,
        createdAt: recentIso(1_000),
        payload: { type: "command" },
      });
      if (publishArtifact) {
        store.append({
          runId,
          type: "artifact.published",
          stageId: "build",
          attempt: 1,
          createdAt: recentIso(2_000),
          payload: {
            artifact: {
              id: "bundle",
              producer: "build",
              mediaType: "application/octet-stream",
              path: "stages/build/1/bundle.tgz",
            },
          },
        });
      }
      store.append({
        runId,
        type: "stage.completed",
        stageId: "build",
        attempt: 1,
        createdAt: recentIso(3_000),
        payload: {},
      });
      store.append({
        runId,
        type: "run.completed",
        createdAt: recentIso(4_000),
        payload: {},
      });
    }
    store.close();

    for (const [runId, status, readyIds, missingIds] of [
      ["run-artifact-pending", "pending", [], ["bundle"]],
      ["run-artifact-ready", "ready", ["bundle"], []],
      ["run-artifact-missing", "missing", [], ["bundle"]],
    ] as const) {
      await expect(getRunDetail(repoPath, runId)).resolves.toMatchObject({
        currentArtifactReadiness: {
          status,
          declaredIds: ["bundle"],
          readyIds,
          missingIds,
        },
        timeline: [
          expect.objectContaining({
            stageId: "build",
            artifactReadiness: {
              status,
              declaredIds: ["bundle"],
              readyIds,
              missingIds,
            },
          }),
        ],
      });
    }
  });

  it("explains runtime fallback in the operator status summary", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-fallback-summary",
      type: "run.created",
      createdAt: recentIso(),
      payload: {
        flowName: "fallback",
        workflowStages: [
          { id: "implement", type: "agent", inputs: [], outputs: ["implementation"] },
        ],
      },
    });
    store.append({
      runId: "run-fallback-summary",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: recentIso(1_000),
      payload: { type: "agent", runtime: "claude", runtimeCandidateIndex: 0, runtimeCandidateCount: 2 },
    });
    store.append({
      runId: "run-fallback-summary",
      type: "stage.runtime.fallback",
      stageId: "implement",
      attempt: 1,
      createdAt: recentIso(2_000),
      payload: {
        failedRuntime: "claude",
        nextRuntime: "codex",
        blocker: { reason: "agent_usage_limit", message: "usage limit reached" },
      },
    });
    store.append({
      runId: "run-fallback-summary",
      type: "stage.started",
      stageId: "implement",
      attempt: 2,
      createdAt: recentIso(3_000),
      payload: { type: "agent", runtime: "codex", runtimeCandidateIndex: 1, runtimeCandidateCount: 2 },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-fallback-summary",
        statusSummary: expect.stringMatching(
          /Fell back from claude to codex.*usage limit reached.*Running implement attempt 2/i,
        ),
        currentProcess: expect.objectContaining({
          kind: "agent",
          runtime: "codex",
          state: "running",
          alive: true,
        }),
      }),
    ]);
  });

  it("surfaces a persisted recovery patch for a stale interrupted attempt", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-recovery-summary");
    await writeJson(join(runDirectory, "recovery.json"), {
      version: 1,
      runId: "run-recovery-summary",
      stageId: "implement",
      attempt: 1,
      capturedAt: "2026-07-14T00:00:30.000Z",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      status: "partial",
      patchPath: "recovery.patch",
      patchBytes: 33,
      patchSha256: "c".repeat(64),
      changedPaths: ["src/a.ts", "src/b.ts"],
      untrackedPaths: ["src/b.ts"],
      omitted: [{ path: "large.bin", reason: "file exceeds limit" }],
    });
    await writeFile(join(runDirectory, "recovery.patch"), "diff --git a/src/a.ts b/src/a.ts\n", "utf8");
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-recovery-summary",
      type: "run.created",
      createdAt: "2000-01-01T00:00:00.000Z",
      payload: {
        flowName: "recovery",
        workflowStages: [
          { id: "implement", type: "agent", inputs: [], outputs: ["implementation"] },
        ],
      },
    });
    store.append({
      runId: "run-recovery-summary",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2000-01-01T00:00:01.000Z",
      payload: { type: "agent", runtime: "codex" },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-recovery-summary")).resolves.toMatchObject({
      status: "interrupted",
      statusSummary: expect.stringMatching(
        /Interrupted implement attempt 1.*recovery patch partial.*2 changed files/i,
      ),
      currentProcess: expect.objectContaining({
        kind: "agent",
        runtime: "codex",
        state: "interrupted",
        alive: false,
      }),
      recoveryArtifact: {
        status: "partial",
        path: "recovery.patch",
        metadataPath: "recovery.json",
        capturedAt: "2026-07-14T00:00:30.000Z",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        patchBytes: 33,
        patchSha256: "c".repeat(64),
        changedPaths: ["src/a.ts", "src/b.ts"],
        untrackedPaths: ["src/b.ts"],
        omittedCount: 1,
      },
    });
  });

  it("groups branch, commit, and PR in a published run summary", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-published-summary",
      type: "run.created",
      createdAt: recentIso(),
      payload: {
        flowName: "publish",
        branchName: "nitely/run-published-summary",
        workflowStages: [
          { id: "publish", type: "publish-change", inputs: [], outputs: [] },
        ],
      },
    });
    store.append({
      runId: "run-published-summary",
      type: "stage.started",
      stageId: "publish",
      attempt: 1,
      createdAt: recentIso(1_000),
      payload: { type: "publish-change" },
    });
    store.append({
      runId: "run-published-summary",
      type: "change.published",
      stageId: "publish",
      attempt: 1,
      createdAt: recentIso(2_000),
      payload: {
        url: "https://github.com/Instask/nitely/pull/500",
        branchName: "nitely/run-published-summary",
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        changeRequest: {
          provider: "github",
          url: "https://github.com/Instask/nitely/pull/500",
          number: 500,
          owner: "Instask",
          repository: "nitely",
          baseBranch: "main",
          headBranch: "nitely/run-published-summary",
          draft: false,
        },
      },
    });
    store.append({
      runId: "run-published-summary",
      type: "stage.completed",
      stageId: "publish",
      attempt: 1,
      createdAt: recentIso(3_000),
      payload: {},
    });
    store.append({
      runId: "run-published-summary",
      type: "run.completed",
      createdAt: recentIso(4_000),
      payload: { changeRequestUrl: "https://github.com/Instask/nitely/pull/500" },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-published-summary",
        status: "completed",
        statusSummary:
          "Published PR #500 from nitely/run-published-summary at 0123456.",
        publication: {
          state: "published",
          branchName: "nitely/run-published-summary",
          headCommit: "0123456789abcdef0123456789abcdef01234567",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/500",
          prNumber: 500,
        },
        currentProcess: expect.objectContaining({
          kind: "publish-change",
          state: "finished",
          alive: false,
        }),
      }),
    ]);
  });

  it("projects a stale open review gate attempt as interrupted", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-stale-review",
      type: "run.created",
      createdAt: "2000-01-01T00:00:00.000Z",
      payload: { flowName: "review-flow" },
    });
    store.append({
      runId: "run-stale-review",
      type: "stage.started",
      stageId: "review",
      attempt: 2,
      createdAt: "2000-01-01T00:00:01.000Z",
      payload: { type: "gate" },
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-stale-review",
        status: "interrupted",
        currentStage: "review",
        currentAttempt: 2,
        currentStageState: "interrupted",
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-stale-review")).resolves.toMatchObject({
      runId: "run-stale-review",
      status: "interrupted",
      currentStage: "review",
      currentAttempt: 2,
      currentStageState: "interrupted",
      timeline: [
        expect.objectContaining({
          stageId: "review",
          state: "interrupted",
          currentAttempt: 2,
        }),
      ],
    });
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

  it("keeps the terminal workflow stage current when reflection finalizers run later", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-finalizer-status",
      type: "run.created",
      createdAt: "2026-06-26T14:13:59.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-finalizer-status",
      type: "stage.started",
      stageId: "publish",
      attempt: 1,
      createdAt: "2026-06-26T14:14:00.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-finalizer-status",
      type: "stage.failed",
      stageId: "publish",
      attempt: 1,
      createdAt: "2026-06-26T14:14:01.000Z",
      payload: { error: "gh pr create failed" },
    });
    store.append({
      runId: "run-finalizer-status",
      type: "run.failed",
      createdAt: "2026-06-26T14:14:02.000Z",
      payload: { error: "publish failed" },
    });
    store.append({
      runId: "run-finalizer-status",
      type: "stage.started",
      stageId: "reflect",
      attempt: 1,
      createdAt: "2026-06-26T14:14:03.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-finalizer-status",
      type: "stage.completed",
      stageId: "reflect",
      attempt: 1,
      createdAt: "2026-06-26T14:14:04.000Z",
      payload: {},
    });
    store.close();

    await expect(listRuns(repoPath)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-finalizer-status",
        status: "failed",
        currentStage: "publish",
        currentAttempt: 1,
        currentStageState: "failed",
        finalizerStage: "reflect",
        finalizerStageState: "completed",
      }),
    ]);
    await expect(getRunDetail(repoPath, "run-finalizer-status")).resolves.toMatchObject({
      status: "failed",
      currentStage: "publish",
      currentAttempt: 1,
      currentStageState: "failed",
      finalizerStage: "reflect",
      finalizerStageState: "completed",
      timeline: [
        expect.objectContaining({
          stageId: "publish",
          state: "failed",
        }),
        expect.objectContaining({
          stageId: "reflect",
          state: "completed",
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
      createdAt: recentIso(),
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-gate",
      type: "stage.started",
      stageId: "review-gate",
      attempt: 1,
      createdAt: recentIso(1_000),
      payload: { type: "gate" },
    });
    store.append({
      runId: "run-gate",
      type: "gate.completed",
      stageId: "review-gate",
      attempt: 1,
      createdAt: recentIso(2_000),
      payload: {
        gate: {
          id: "review-gate",
          stageId: "review-gate",
          mode: "review",
          status: "failed",
          createdAt: recentIso(2_000),
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
          ...(action === "rework"
            ? {
                targetStage: "implement",
                targetArtifact: "implementation",
                reworkRequest: {
                  targetStage: "implement",
                  targetArtifact: "implementation",
                  reason: "rework requested",
                  sourceStage: "review",
                  sourceAttempt: 1,
                },
              }
            : {}),
        },
      });
      store.close();

      const detail = await getRunDetail(repoPath, `run-${action}`);
      expect(detail).toMatchObject({
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
      if (action === "rework") {
        expect(detail.latestDecision).toMatchObject({
          targetStage: "implement",
          targetArtifact: "implementation",
          reworkRequest: expect.objectContaining({
            targetStage: "implement",
          }),
        });
        expect(detail.timeline[0]?.details?.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "orchestrator.decision",
              summary: expect.stringContaining("target stage implement"),
            }),
          ]),
        );
      }
    },
  );

  it("summarizes review verdict routing in stage event timelines", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-review-verdict",
      type: "run.created",
      createdAt: "2026-06-20T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-review-verdict",
      type: "stage.started",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:01.000Z",
      payload: { type: "gate" },
    });
    store.append({
      runId: "run-review-verdict",
      type: "gate.completed",
      stageId: "review",
      attempt: 1,
      createdAt: "2026-06-20T00:00:02.000Z",
      payload: {
        gate: {
          id: "review",
          stageId: "review",
          mode: "review",
          status: "failed",
          reason: "implementation misses behavior",
          createdAt: "2026-06-20T00:00:02.000Z",
          reviewOutput: {
            id: "review",
            path: "stages/review/1/review.md",
            filename: "review.md",
            mediaType: "text/markdown",
            content: "Review verdict: needs_fix\n",
            truncated: false,
            verdict: {
              verdict: "needs_fix",
              targetStage: "implement",
              targetArtifact: "implementation",
            },
          },
        },
      },
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-review-verdict");
    expect(detail.timeline[0]?.details?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "gate.completed",
          summary: expect.stringContaining("verdict needs_fix"),
        }),
        expect.objectContaining({
          type: "gate.completed",
          summary: expect.stringContaining("target stage implement"),
        }),
      ]),
    );
  });

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

  it("ignores an unsafe Artifact registry and falls back to the context manifest", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-unsafe-registry");
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-unsafe-registry",
      status: "completed",
      completedStages: ["implement"],
      inputs: {},
    });
    await writeJson(join(runDirectory, "context-manifest.json"), {
      version: 1,
      runId: "run-unsafe-registry",
      generatedAt: "2026-06-20T00:00:00.000Z",
      entries: [{
        id: "implementation",
        kind: "generated-artifact",
        connector: "generated",
        sourceUri: "stages/implement/1/implementation.md",
        mediaType: "text/markdown",
        filename: "implementation.md",
        runRelativePath: "stages/implement/1/implementation.md",
        policy: { decision: "allowed" },
      }],
    });
    const outsideMarker = "outside-registry-must-not-be-read";
    const outsideRegistry = join(repoPath, "outside-artifacts.json");
    await writeJson(outsideRegistry, {
      runId: "run-unsafe-registry",
      artifacts: [{
        id: outsideMarker,
        producer: "outside",
        mediaType: "text/plain",
      }],
    });
    await symlink(outsideRegistry, join(runDirectory, "artifacts.json"));

    const detail = await getRunDetail(repoPath, "run-unsafe-registry");

    expect(detail.artifacts).toEqual([
      expect.objectContaining({
        id: "implementation",
        producer: "generated",
        path: "stages/implement/1/implementation.md",
      }),
    ]);
    expect(JSON.stringify(detail)).not.toContain(outsideMarker);
  });

  it("reconciles Artifact registry enrichment with canonical event metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-reconciled-artifacts");
    await mkdir(runDirectory, { recursive: true });
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-reconciled-artifacts",
      artifacts: [
        {
          id: "implementation",
          name: "Registry enrichment",
          producer: "implement",
          mediaType: "text/plain",
          path: "stale/output.md",
          sha256: "a".repeat(64),
          size: 17,
        },
        {
          id: "registry-only",
          producer: "review",
          mediaType: "application/json",
        },
      ],
    });
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-reconciled-artifacts",
      type: "run.created",
      payload: { flowName: "artifact-reconciliation", repoPath, inputs: {} },
    });
    store.append({
      runId: "run-reconciled-artifacts",
      type: "artifact.published",
      stageId: "implement",
      attempt: 1,
      payload: {
        artifact: {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
          sha256: "b".repeat(64),
        },
      },
    });
    store.append({
      runId: "run-reconciled-artifacts",
      type: "artifact.published",
      stageId: "publish",
      attempt: 1,
      payload: {
        artifact: {
          id: "event-only",
          producer: "publish",
          mediaType: "application/vnd.nitely.change+json",
        },
      },
    });
    store.close();

    const detail = await getRunDetail(repoPath, "run-reconciled-artifacts");

    expect(detail.artifacts).toEqual([
      expect.objectContaining({
        id: "implementation",
        name: "Registry enrichment",
        producer: "implement",
        mediaType: "text/markdown",
        path: "stages/implement/1/output.md",
        sha256: "b".repeat(64),
        size: 17,
      }),
      expect.objectContaining({
        id: "registry-only",
        producer: "review",
      }),
      expect.objectContaining({
        id: "event-only",
        producer: "publish",
      }),
    ]);
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

  it("exposes conformance report findings in run details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-conformance");
    const attemptDirectory = join(runDirectory, "stages/implement/1");
    await mkdir(attemptDirectory, { recursive: true });
    const reportContent = JSON.stringify({
      version: 1,
      summary: "FR covered; SC requires manual verification.",
      items: [
        {
          id: "FR-001",
          status: "satisfied",
          evidence: ["parser updated"],
          files: ["src/parser.ts"],
          tests: ["pnpm test"],
          artifacts: ["implementation"],
        },
        {
          id: "SC-001",
          status: "not_verified",
          rationale: "Manual browser check pending.",
        },
      ],
      scopeDrift: [
        {
          severity: "blocking",
          description: "Touched an adjacent helper.",
          files: ["src/helper.ts"],
        },
      ],
    });
    await writeFile(
      join(attemptDirectory, "conformance-report.json"),
      reportContent,
      "utf8",
    );
    const reportSha256 = createHash("sha256")
      .update(reportContent)
      .digest("hex");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-conformance",
      artifacts: [
        {
          id: "conformance-report",
          type: "conformance.report",
          producer: "implement",
          path: "stages/implement/1/conformance-report.json",
          mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
          sha256: reportSha256,
          size: Buffer.byteLength(reportContent),
        },
      ],
    });
    const store = await createEventStore(repoPath);
    store.append({
      runId: "run-conformance",
      type: "run.created",
      createdAt: "2026-06-24T00:00:00.000Z",
      payload: {
        flowName: "conformance-flow",
        flowDocument: JSON.stringify({
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: { name: "conformance-flow" },
          spec: {
            stages: [
              {
                id: "implement",
                type: "agent",
                runtime: "mock",
                prompt: "Implement.",
                inputs: [],
                outputs: [
                  {
                    id: "conformance-report",
                    type: "conformance.report",
                    mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
                  },
                ],
              },
              {
                id: "publish",
                type: "publish-change",
                provider: "github",
                inputs: ["conformance-report"],
                outputs: ["change-request"],
                conformance: {
                  mode: "advisory",
                  report: "conformance-report",
                  required: ["FR-001", "SC-001", "PD-001"],
                },
              },
            ],
          },
        }),
        inputs: {},
      },
    });
    store.append({
      runId: "run-conformance",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-24T00:00:01.000Z",
      payload: {
        type: "agent",
        attemptDirectory,
      },
    });
    store.append({
      runId: "run-conformance",
      type: "artifact.published",
      stageId: "implement",
      createdAt: "2026-06-24T00:00:02.000Z",
      payload: {
        artifact: {
          id: "conformance-report",
          type: "conformance.report",
          producer: "implement",
          path: "stages/implement/1/conformance-report.json",
          mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
        },
      },
    });
    store.append({
      runId: "run-conformance",
      type: "stage.completed",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-06-24T00:00:03.000Z",
      payload: {},
    });
    store.close();

    const previousSecret = process.env.TEST_SECRET_TOKEN;
    process.env.TEST_SECRET_TOKEN = "implement";
    const detail = await (async () => {
      try {
        return await getRunDetail(repoPath, "run-conformance", {
          redactionSecrets: [reportSha256.slice(0, 8)],
        });
      } finally {
        if (previousSecret === undefined) {
          delete process.env.TEST_SECRET_TOKEN;
        } else {
          process.env.TEST_SECRET_TOKEN = previousSecret;
        }
      }
    })();

    expect(detail.conformance).toEqual([
      expect.objectContaining({
        reportId: "conformance-report",
        stageId: "publish",
        policy: {
          mode: "advisory",
          reportId: "conformance-report",
          requiredIds: ["FR-001", "SC-001", "PD-001"],
        },
        artifact: expect.objectContaining({
          id: "conformance-report",
          path: "stages/[REDACTED]/1/conformance-report.json",
        }),
        report: expect.objectContaining({
          summary: "FR covered; SC requires manual verification.",
          items: [
            expect.objectContaining({ id: "FR-001", status: "satisfied" }),
            expect.objectContaining({ id: "SC-001", status: "not_verified" }),
          ],
        }),
      }),
    ]);
    expect(detail.conformance[0]?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "missing-required-id",
          itemId: "PD-001",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "unsatisfied-item",
          itemId: "SC-001",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "scope-drift",
        }),
      ]),
    );
    expect(detail.conformance[0]?.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-report" }),
      ]),
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "conformance-report",
          sha256: reportSha256,
        }),
      ]),
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

  it("returns projected trace checkpoints in run details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    store.append({
      runId: "run-checkpoints",
      type: "run.created",
      createdAt: "2026-07-08T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "workspace.created",
      createdAt: "2026-07-08T00:00:01.000Z",
      payload: { worktreePath: "/tmp/worktree" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:02.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "stage.blocked",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:03.000Z",
      payload: { reason: "usage-limit" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "run.blocked",
      createdAt: "2026-07-08T00:00:04.000Z",
      payload: { reason: "usage-limit" },
    });
    store.close();

    await expect(getRunDetail(repoPath, "run-checkpoints")).resolves.toMatchObject({
      trace: {
        checkpoints: [
          expect.objectContaining({ kind: "run-created" }),
          expect.objectContaining({ kind: "workspace-created" }),
          expect.objectContaining({
            kind: "stage-attempt",
            status: "candidate",
            action: "resume-run",
          }),
          expect.objectContaining({ kind: "terminal" }),
        ],
        resumableCheckpoints: [
          expect.objectContaining({
            kind: "stage-attempt",
            stageId: "implement",
          }),
        ],
      },
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

  it("counts review severities only from findings, not pass or prose mentions", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-runs-"));
    const runDirectory = join(repoPath, ".nitely/runs/run-review-severities");
    await mkdir(join(runDirectory, "stages/review/1"), { recursive: true });
    await mkdir(join(runDirectory, "stages/review/2"), { recursive: true });
    await mkdir(join(runDirectory, "stages/review/3"), { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      runId: "run-review-severities",
      status: "completed",
      completedStages: ["review"],
      inputs: {},
    });
    await writeFile(
      join(runDirectory, "stages/review/1/review.md"),
      "Review verdict: pass\n\nNo P0/P1/blocking findings.\n",
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/review/2/review.md"),
      "## Findings\n\n### P1 - Missing regression test\n\n### P0 - Data loss risk\n",
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/review/3/review.md"),
      "This review considered P0/P1 labels and blocking risk, but does not report findings.\n",
      "utf8",
    );

    const detail = await getRunDetail(repoPath, "run-review-severities");

    expect(detail.reviewFindings).toMatchObject([
      {
        attempt: "1",
        severities: { none: 1 },
      },
      {
        attempt: "2",
        severities: { P0: 1, P1: 1 },
      },
      {
        attempt: "3",
        severities: {},
      },
    ]);
  });
});
