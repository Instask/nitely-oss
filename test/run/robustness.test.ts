import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { StoredRunEvent } from "../../src/events/types.js";
import type {
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
} from "../../src/providers/types.js";
import { resolveApproval } from "../../src/run/approvals.js";
import type { ExecutionBackend, WorkspaceHandle } from "../../src/run/execution/types.js";
import { eventStorePath, projectRun } from "../../src/run/project.js";
import { resumeRun, runFlow } from "../../src/run/run-flow.js";
import { buildRunTrace } from "../../src/run/trace.js";
import type { ChangeRequest, ScmProvider } from "../../src/scm/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-robustness-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Robustness fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function providerStoreWithStatuses(
  statuses: ProviderConnectionStatus[],
): ProviderConnectionStore {
  return {
    getConnection: async (providerId: ProviderId) => ({
      providerId,
      getAccessToken: async () => "token",
    }),
    resolveEnv: async () => ({}),
    listStatuses: async () => statuses,
  };
}

function backendWithAgent(
  repo: string,
  runAgent: ExecutionBackend["runAgent"],
): ExecutionBackend {
  return {
    async createWorkspace({ runId, branchName, worktreePath }) {
      await git(repo, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
      return { runId, path: worktreePath };
    },
    runAgent,
    async runCommand() {
      throw new Error("command should not run");
    },
    async commitAll(ws: WorkspaceHandle, message: string) {
      if (!ws.path) return { committed: false };
      const status = await git(ws.path, ["status", "--short"]);
      if (!status.trim()) return { committed: false };
      await git(ws.path, ["add", "."]);
      await git(ws.path, ["commit", "-m", message]);
      return { committed: true };
    },
  };
}

function readEvents(repo: string, runId: string): StoredRunEvent[] {
  const store = new EventStore(eventStorePath(repo));
  try {
    return store.list(runId);
  } finally {
    store.close();
  }
}

function eventTypes(events: StoredRunEvent[]): string[] {
  return events.map((event) => event.type);
}

function publishFailingScmProvider(errorMessage: string): ScmProvider {
  return {
    type: "github",
    publishChange: async () => {
      throw new Error(errorMessage);
    },
  };
}

describe("flow robustness failure-injection suite", () => {
  it("records failed stage and run state when an agent runtime exits non-zero", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "agent-exit.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "agent-exit" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-agent-exit",
          executeAgent: async () => {
            throw new Error("agent process exited with code 2");
          },
        },
      ),
    ).rejects.toThrow(/agent process exited with code 2/);

    const events = readEvents(repo, "run-agent-exit");
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(["stage.failed", "run.failed"]),
    );
    expect(projectRun(events)).toMatchObject({
      status: "failed",
      stages: [
        expect.objectContaining({
          stageId: "implement",
          status: "failed",
          attempts: [
            expect.objectContaining({
              attempt: 1,
              status: "failed",
              error: expect.stringContaining("agent process exited with code 2"),
            }),
          ],
        }),
      ],
    });
    await expect(
      readFile(join(repo, ".nitely", "runs", "run-agent-exit", "evidence.md"), "utf8"),
    ).resolves.toContain("Status: failed");
  });

  it("blocks on agent usage limits without retrying or marking the attempt failed", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "usage-limit.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "usage-limit" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-usage-limit",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error("codex exited with code 1"), {
              stdout: "",
              stderr: "You hit your usage limit. Please try again at 10:00 UTC.\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit/);

    const events = readEvents(repo, "run-usage-limit");
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(["stage.blocked", "run.blocked"]),
    );
    expect(eventTypes(events)).not.toContain("stage.retrying");
    expect(eventTypes(events)).not.toContain("stage.failed");
    expect(projectRun(events)).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_usage_limit",
        stageId: "implement",
        retryAfter: "10:00 UTC",
      },
    });
  });

  it("fails before agent spawn when a required provider credential is missing", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "missing-provider.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "missing-provider" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Use Drive context.",
            inputs: [],
            outputs: ["implementation"],
            required_connectors: ["google-drive"],
          },
        ],
      },
    });
    let agentCalled = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-missing-provider",
          executeAgent: async () => {
            agentCalled = true;
          },
          providerStore: providerStoreWithStatuses([
            {
              id: "google-drive",
              name: "Google Drive",
              configured: false,
              message: "Missing Google Drive token",
              hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
              reconnectRequired: false,
              authMethods: [],
            },
          ]),
        },
      ),
    ).rejects.toThrow(/requires missing provider\(s\): google-drive/);

    expect(agentCalled).toBe(false);
    const events = readEvents(repo, "run-missing-provider");
    expect(projectRun(events)).toMatchObject({ status: "failed" });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.requirements.failed",
          stageId: "implement",
          payload: expect.objectContaining({
            missingProviders: ["google-drive"],
            hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
          }),
        }),
      ]),
    );
  });

  it("retries a command failure and preserves explicit retry evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "command-retry.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-retry" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "verify",
            type: "command",
            command:
              "if test -f marker; then printf second-pass; else printf first-fail >&2; touch marker; exit 7; fi",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-command-retry" },
    );

    const events = readEvents(repo, "run-command-retry");
    expect(eventTypes(events)).toContain("stage.retrying");
    expect(projectRun(events)).toMatchObject({
      status: "completed",
      stages: [
        expect.objectContaining({
          stageId: "verify",
          status: "completed",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "completed" }),
          ],
        }),
      ],
    });
    await expect(
      readFile(
        join(repo, ".nitely", "runs", "run-command-retry", "evidence.md"),
        "utf8",
      ),
    ).resolves.toContain("- verify attempt 1/2: retry - command failed");
  });

  it("fails missing required artifacts with output-contract events and no false completion", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "missing-artifact.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "missing-artifact" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-missing-artifact", executeAgent: async () => {} },
      ),
    ).rejects.toThrow(/missing required output implementation/);

    const events = readEvents(repo, "run-missing-artifact");
    expect(eventTypes(events)).not.toContain("stage.completed");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.failed",
          stageId: "implement",
          payload: expect.objectContaining({
            error: expect.stringContaining("missing required output implementation"),
          }),
        }),
      ]),
    );
    expect(projectRun(events).status).toBe("failed");
  });

  it("keeps downstream stages stopped when an approval is denied", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "approval-denied.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "approval-denied" },
      spec: {
        stages: [
          {
            id: "approve-release",
            type: "approval",
            prompt: "Approve release",
            inputs: [],
            outputs: [],
          },
          {
            id: "after-approval",
            type: "command",
            command: "printf should-not-run",
            inputs: [],
            outputs: ["after"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-approval-denied" },
    );
    await resolveApproval({
      repoPath: repo,
      runId: "run-approval-denied",
      approvalId: "approve-release-1",
      decision: "denied",
      actor: "human:test",
    });

    await expect(
      resumeRun({ repoPath: repo, runId: "run-approval-denied" }),
    ).rejects.toThrow(/approval approve-release-1 denied/i);

    const events = readEvents(repo, "run-approval-denied");
    expect(projectRun(events)).toMatchObject({
      status: "failed",
      approvals: [
        expect.objectContaining({
          id: "approve-release-1",
          status: "denied",
          actor: "human:test",
        }),
      ],
    });
    expect(
      events.some(
        (event) =>
          event.type === "stage.started" && event.stageId === "after-approval",
      ),
    ).toBe(false);
  });

  it("projects an open attempt as interrupted and resumable after process loss", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repo));
    try {
      store.append({
        runId: "run-interrupted",
        type: "run.created",
        payload: {
          flowName: "interrupted",
          branchName: "nitely/run-interrupted",
          baseBranch: "master",
        },
      });
      store.append({
        runId: "run-interrupted",
        type: "workspace.created",
        payload: {
          worktreePath: join(repo, ".nitely", "runs", "run-interrupted", "worktree"),
        },
      });
      store.append({
        runId: "run-interrupted",
        type: "stage.started",
        stageId: "implement",
        attempt: 1,
        payload: { type: "agent", attemptDirectory: "/tmp/attempt" },
      });
    } finally {
      store.close();
    }

    const events = readEvents(repo, "run-interrupted");
    expect(projectRun(events, { openAttemptStatus: "interrupted" })).toMatchObject({
      status: "interrupted",
      stages: [
        expect.objectContaining({
          stageId: "implement",
          status: "interrupted",
          attempts: [expect.objectContaining({ status: "interrupted" })],
        }),
      ],
    });
    expect(buildRunTrace(events).resumableCheckpoints).toEqual([
      expect.objectContaining({
        kind: "stage-attempt",
        action: "resume-run",
        stageId: "implement",
        attempt: 1,
      }),
    ]);
  });

  it("records publish provider failures as failed runs without change events", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "publish-failure.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "publish-failure" },
      spec: {
        stages: [
          {
            id: "prepare",
            type: "command",
            command: "printf ready",
            inputs: [],
            outputs: ["implementation"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-publish-failure",
          scmProvider: publishFailingScmProvider("GitHub publish failed"),
        },
      ),
    ).rejects.toThrow(/GitHub publish failed/);

    const events = readEvents(repo, "run-publish-failure");
    expect(projectRun(events).status).toBe("failed");
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(["stage.failed", "run.failed"]),
    );
    expect(eventTypes(events)).not.toContain("change.published");
  });

  it("records workspace creation failures such as branch collisions", async () => {
    const repo = await createRepo();
    await git(repo, ["branch", "nitely/run-branch-collision"]);
    const flowPath = join(repo, "flows", "branch-collision.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "branch-collision" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf unreachable",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-branch-collision" },
      ),
    ).rejects.toThrow(/already exists|worktree add/i);

    const events = readEvents(repo, "run-branch-collision");
    expect(projectRun(events).status).toBe("failed");
    expect(eventTypes(events)).toContain("run.failed");
    expect(eventTypes(events)).not.toContain("workspace.created");
    await expect(
      stat(join(repo, ".nitely", "runs", "run-branch-collision", "worktree")),
    ).rejects.toThrow();
  });

  it("omits context-policy excluded inputs and records the exclusion without leaking bytes", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".env"), "OPENAI_API_KEY=sk-robustness-secret", "utf8");
    const flowPath = join(repo, "flows", "context-excluded.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "context-excluded" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf unreachable",
            inputs: ["secret"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { secret: { connector: "local-file", uri: ".env" } },
        },
        { createRunId: () => "run-context-excluded" },
      ),
    ).rejects.toThrow(/context policy excluded local input: \.env/);

    const runDirectory = join(repo, ".nitely", "runs", "run-context-excluded");
    await expect(readFile(join(runDirectory, "inputs", "secret", "content"), "utf8"))
      .rejects.toThrow();
    const events = readEvents(repo, "run-context-excluded");
    expect(eventTypes(events)).toContain("context.excluded");
    expect(JSON.stringify(events)).not.toContain("sk-robustness-secret");
    expect(projectRun(events).status).toBe("failed");
  });

  it("records update-change provider failures while preserving target lineage", async () => {
    const repo = await createRepo();
    await git(repo, ["checkout", "-b", "nitely/pr-283"]);
    await writeFile(join(repo, "feature.txt"), "before\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["checkout", "master"]);
    const target = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      number: 283,
      url: "https://github.com/Instask/nitely/pull/283",
      baseBranch: "master",
      headBranch: "nitely/pr-283",
      headSha,
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    const changeRequest: ChangeRequest = {
      provider: "github",
      url: target.url,
      number: target.number,
      owner: target.owner,
      repository: target.repository,
      baseBranch: target.baseBranch,
      headBranch: target.headBranch,
      draft: true,
    };
    const flowPath = join(repo, "flows", "update-failure.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "update-failure" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Update the PR branch.",
            inputs: [],
            outputs: ["implementation"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
          changeRequestTarget: { provider: "github", target: "283" },
        },
        {
          createRunId: () => "run-update-failure",
          executeAgent: async ({ attemptDirectory, worktreePath }) => {
            await writeFile(join(worktreePath, "feature.txt"), "after\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "after\n", "utf8");
          },
          scmProvider: {
            type: "github",
            resolveChangeRequestTarget: async () => target,
            checkoutChangeRequest: async ({ worktreePath }) => {
              await git(repo, ["worktree", "add", worktreePath, target.headBranch]);
              return { previousHeadSha: target.headSha };
            },
            updateChangeRequest: async () => {
              throw new Error("GitHub update failed");
            },
            publishChange: async () => changeRequest,
          },
        },
      ),
    ).rejects.toThrow(/GitHub update failed/);

    const events = readEvents(repo, "run-update-failure");
    expect(projectRun(events)).toMatchObject({
      status: "failed",
      changeRequestTarget: {
        target: "283",
        resolved: target,
      },
    });
    expect(eventTypes(events)).toContain("change.target.resolved");
    expect(eventTypes(events)).not.toContain("change.updated");
  });
});
