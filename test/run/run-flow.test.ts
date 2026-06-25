import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { projectRun } from "../../src/run/project.js";
import {
  buildRepoIndex,
  queryRepoIndex,
  recordRepoIndexQuery,
} from "../../src/repo-index/index.js";
import { createCodexExecArgs, resumeRun, runFlow, resolveMaxInputTokens, fitPromptToBudget } from "../../src/run/run-flow.js";
import type { ExecutionBackend } from "../../src/run/execution/types.js";
import type {
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
} from "../../src/providers/types.js";
import type {
  ChangeRequest,
  ChangeRequestTarget,
  ScmProvider,
} from "../../src/scm/types.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "..", "..");

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-run-repo-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function createRepoWithOrigin() {
  const repo = await createRepo();
  const remote = await mkdtemp(join(tmpdir(), "nitely-run-origin-"));
  await git(remote, ["init", "--bare"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "master"]);
  return { repo, remote };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function writeSkill(
  repo: string,
  id: string,
  content: string,
): Promise<void> {
  const directory = join(repo, ".nitely", "skills", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
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
    async commitAll() {
      return { committed: false };
    },
  };
}

function localReworkProvider(input: {
  repo: string;
  target: ChangeRequestTarget;
  onUpdate?: (worktreePath: string) => Promise<void>;
}): ScmProvider {
  return {
    type: "github",
    resolveChangeRequestTarget: async ({ target }) => {
      expect(target).toBe(String(input.target.number));
      return input.target;
    },
    checkoutChangeRequest: async ({ worktreePath, target }) => {
      expect(target).toEqual(input.target);
      await git(input.repo, ["worktree", "add", worktreePath, target.headBranch]);
      return { previousHeadSha: target.headSha };
    },
    updateChangeRequest: async ({ worktreePath, target }) => {
      expect(target).toEqual(input.target);
      await input.onUpdate?.(worktreePath);
      const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
      return {
        url: target.url,
        number: target.number,
        previousHeadSha: target.headSha,
        updatedHeadSha: stdout.trim(),
        changeRequest: {
          provider: "github",
          url: target.url,
          number: target.number,
          owner: target.owner,
          repository: target.repository,
          baseBranch: target.baseBranch,
          headBranch: target.headBranch,
          draft: true,
        },
      };
    },
    publishChange: async () => {
      throw new Error("publishChange must not be called during rework");
    },
  };
}

describe("runFlow", () => {
  it("uses danger-full-access for Codex by default to avoid Linux bubblewrap blockers", () => {
    expect(createCodexExecArgs("/repo/worktree")).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "--cd",
      "/repo/worktree",
      "-",
    ]);
  });

  it("allows the Codex sandbox to be overridden with NITELY_CODEX_SANDBOX", () => {
    process.env.NITELY_CODEX_SANDBOX = "read-only";
    try {
      expect(createCodexExecArgs("/repo/worktree")).toContain("read-only");
    } finally {
      delete process.env.NITELY_CODEX_SANDBOX;
    }
  });

  it("accepts the legacy NIGHTLY_CODEX_SANDBOX override", () => {
    process.env.NIGHTLY_CODEX_SANDBOX = "read-only";
    try {
      expect(createCodexExecArgs("/repo/worktree")).toContain("read-only");
    } finally {
      delete process.env.NIGHTLY_CODEX_SANDBOX;
    }
  });

  it("runs a sequential flow in an isolated worktree and publishes a change request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "self-improve.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "self-improve" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            model: "gpt-5.3-codex-spark",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "test",
            type: "command",
            command: "test -f feature.txt",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "test-report"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-test",
        executeAgent: async ({ worktreePath, attemptDirectory }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "implemented\n",
            "utf8",
          );
        },
        publishChange: async ({ baseBranch, branchName, evidencePath }) => {
          expect(baseBranch).toBe("master");
          return {
          url: `https://example.test/pr/${branchName}`,
          evidencePath,
          };
        },
      },
    );

    await expect(readFile(join(repo, "feature.txt"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(result.worktreePath, "feature.txt"), "utf8"),
    ).resolves.toBe("implemented\n");
    expect(result.changeRequestUrl).toBe(
      "https://example.test/pr/nitely/run-test",
    );

    const { stdout } = await git(result.worktreePath, ["status", "--short"]);
    expect(stdout.trim()).toBe("");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-test", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Agent Runtimes");
    expect(evidence).toContain(
      "- implement: runtime codex, model gpt-5.3-codex-spark",
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-test"));
    store.close();
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          stageType: "agent",
          action: "complete",
        }),
        expect.objectContaining({
          stageId: "test",
          stageType: "command",
          action: "complete",
        }),
        expect.objectContaining({
          stageId: "publish",
          stageType: "publish-change",
          action: "complete",
        }),
      ]),
    );
  });

  it("runs reflection after publishing and records the reflection artifact", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "publish-reflect.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "publish-reflect" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            prompt: "Reflect on the finished issue execution.",
            inputs: ["implementation", "change-request"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    const changeRequest: ChangeRequest = {
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/157",
      number: 157,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-publish-reflect",
      draft: true,
    };
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-publish-reflect",
        executeAgent: async ({ stage, worktreePath, attemptDirectory, prompt }) => {
          if (stage.id === "implement") {
            await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
            return;
          }
          reflectionPrompt = prompt;
          await writeFile(
            join(attemptDirectory, "reflection.md"),
            "No follow-up issues needed.\n",
            "utf8",
          );
        },
        publishChange: async ({ evidencePath }) => ({
          url: changeRequest.url,
          evidencePath,
          changeRequest,
        }),
      },
    );

    expect(result.changeRequestUrl).toBe(changeRequest.url);
    expect(reflectionPrompt).toContain("Artifact: change-request");
    expect(reflectionPrompt).toContain(changeRequest.url);

    const runDirectory = join(repo, ".nitely", "runs", "run-publish-reflect");
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("- change-request: producer publish");
    expect(evidence).toContain("Path: stages/publish/1/change-request.md");
    expect(evidence).toContain("- reflection: producer reflect");
    expect(evidence).toContain("Path: stages/reflect/1/reflection.md");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-publish-reflect"));
    store.close();
    expect(projection.completedStages).toEqual(["implement", "publish", "reflect"]);
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "change-request",
          producer: "publish",
          path: "stages/publish/1/change-request.md",
        }),
        expect.objectContaining({
          id: "reflection",
          producer: "reflect",
          path: "stages/reflect/1/reflection.md",
        }),
      ]),
    );
  });

  it("renders only the selected task scope into agent prompts and evidence", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "tasks.md"),
      `# Tasks

## Phase 1: Foundation

- [x] T001 Create baseline tests
- [ ] T002 Implement foundation

## Phase 2: User Story US-001 - Primary workflow

- [ ] T003 [US-001] Implement primary workflow
- [ ] T004 [US-001] Verify primary workflow

## Phase 3: Verification

- [ ] T005 Run full verification
`,
      "utf8",
    );
    await writeFile(join(repo, "docs", "spec.md"), "Keep this spec context\n", "utf8");
    const flowPath = join(repo, "flows", "scoped.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "scoped" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement selected tasks.",
            inputs: ["tasks", "spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let prompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          tasks: { connector: "local-file", uri: "docs/tasks.md" },
          spec: { connector: "local-file", uri: "docs/spec.md" },
        },
        taskScope: { inputId: "tasks", expression: "US-001" },
      },
      {
        createRunId: () => "run-task-scope",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(prompt).toContain("Selected tasks: T003, T004");
    expect(prompt).toContain("- [ ] T003");
    expect(prompt).toContain("- [ ] T004");
    expect(prompt).toContain("Keep this spec context");
    expect(prompt).not.toContain("- [x] T001");
    expect(prompt).not.toContain("- [ ] T005");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-task-scope", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Task Scope");
    expect(evidence).toContain("- Scope: US-001");
    expect(evidence).toContain("- Selected tasks: T003, T004");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-task-scope");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["task.scope.selected", "task.scope.completed"]),
    );
    expect(projection.taskScope).toMatchObject({
      inputId: "tasks",
      expression: "US-001",
      selectedTaskIds: ["T003", "T004"],
      completedTaskIds: ["T003", "T004"],
    });
  });

  it("fails invalid task scopes before spawning an agent", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "tasks.md"),
      `# Tasks

## Phase 1: Foundation

- [ ] T001 Implement foundation
`,
      "utf8",
    );
    const flowPath = join(repo, "flows", "scoped.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "scoped" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement selected tasks.",
            inputs: ["tasks"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let agentSpawned = false;
    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            tasks: { connector: "local-file", uri: "docs/tasks.md" },
          },
          taskScope: { inputId: "tasks", expression: "T999" },
        },
        {
          createRunId: () => "run-task-scope-invalid",
          executeAgent: async () => {
            agentSpawned = true;
          },
        },
      ),
    ).rejects.toThrow('invalid task scope "T999"');

    expect(agentSpawned).toBe(false);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-task-scope-invalid"));
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.worktreePath).toBeUndefined();
  });

  it("fails an agent stage before completion when a declared output is missing", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "missing-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "missing-output" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
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
          createRunId: () => "run-missing-output",
          executeAgent: async () => {},
        },
      ),
    ).rejects.toThrow(/missing required output implementation/);

    const runDirectory = join(repo, ".nitely", "runs", "run-missing-output");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "prompt.md"), "utf8"),
    ).resolves.toContain("# Nitely Stage: implement");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "stdout.log"), "utf8"),
    ).resolves.toContain("stdout was not captured");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "stderr.log"), "utf8"),
    ).resolves.toContain("stderr was not captured");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-missing-output");
    store.close();
    expect(events.some((event) => event.type === "stage.completed")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          type: "stage.failed",
          payload: expect.objectContaining({
            error: expect.stringContaining("missing required output implementation"),
          }),
        }),
      ]),
    );
  });

  it("fails an agent stage before spawning the agent when a required provider is missing", async () => {
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
            runtime: "mock",
            required_mcp_servers: ["google-drive"],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
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
          providerStore: providerStoreWithStatuses([
            {
              id: "google-drive",
              name: "Google Drive",
              configured: false,
              message: "missing token",
              hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
            },
          ]),
          executeAgent: async () => {
            agentCalled = true;
          },
        },
      ),
    ).rejects.toThrow(
      /stage implement requires missing provider\(s\): google-drive\. Hints: NITELY_GOOGLE_ACCESS_TOKEN/,
    );

    expect(agentCalled).toBe(false);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-missing-provider");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          type: "stage.requirements.failed",
          payload: expect.objectContaining({
            providerIds: ["google-drive"],
            missingProviders: ["google-drive"],
            hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
          }),
        }),
        expect.objectContaining({
          stageId: "implement",
          type: "stage.failed",
          payload: expect.objectContaining({
            error: expect.stringContaining("stage implement requires missing provider(s): google-drive"),
          }),
        }),
      ]),
    );
  });

  it("continues past the requirement check when a required provider is configured", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "configured-provider.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "configured-provider" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            required_connectors: ["google-drive"],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    let agentCalled = false;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-configured-provider",
        providerStore: providerStoreWithStatuses([
          {
            id: "google-drive",
            name: "Google Drive",
            configured: true,
            message: "configured",
            hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
          },
        ]),
        executeAgent: async ({ attemptDirectory }) => {
          agentCalled = true;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(agentCalled).toBe(true);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-configured-provider");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          type: "stage.requirements.checked",
          payload: expect.objectContaining({
            connectors: ["google-drive"],
            providerIds: ["google-drive"],
          }),
        }),
      ]),
    );
  });

  it("blocks an agent stage on provider usage-limit output without retrying", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "usage-limit-agent.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "usage-limit-agent" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            maxAttempts: 3,
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const stderr =
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 21st, 2026 12:37 AM.\n";

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-agent-usage-limit",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error("codex exited with code 1"), {
              stdout: "",
              stderr,
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-agent-usage-limit");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).toContain("stage.blocked");
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(events.map((event) => event.type)).not.toContain("stage.failed");
    expect(events.map((event) => event.type)).not.toContain("orchestrator.decision");
    expect(projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_usage_limit",
        stageId: "implement",
        runtime: "codex",
        retryAfter: "Jun 21st, 2026 12:37 AM",
      },
      stages: [
        {
          stageId: "implement",
          status: "blocked",
          attempts: [{ attempt: 1, status: "blocked" }],
        },
      ],
    });
    await expect(
      readFile(
        join(repo, ".nitely", "runs", "run-agent-usage-limit", "stages", "implement", "1", "stderr.log"),
        "utf8",
      ),
    ).resolves.toContain("hit your usage limit");
  });

  it("falls back to the next agent runtime candidate after a usage-limit blocker", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-fallback-agent.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-fallback-agent" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const runtimes: string[] = [];

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-agent-runtime-fallback",
        backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
          runtimes.push(stage.runtime ?? "");
          if (stage.runtime === "claude") {
            throw Object.assign(new Error("claude exited with code 1"), {
              stderr: "usage limit reached; try again in 10 minutes\n",
            });
          }
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
          return { stdout: "ok\n", stderr: "" };
        }),
      },
    );

    expect(runtimes).toEqual(["claude", "codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-agent-runtime-fallback");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toContain("stage.runtime.fallback");
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "blocked",
        runtime: "claude",
        runtimeCandidateIndex: 0,
        runtimeCandidateCount: 2,
      }),
      expect.objectContaining({
        attempt: 2,
        status: "completed",
        runtime: "codex",
        runtimeCandidateIndex: 1,
        runtimeCandidateCount: 2,
      }),
    ]);
  });

  it("records output-contract failures on the selected agent runtime candidate after fallback", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-fallback-agent-output-failure.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-fallback-agent-output-failure" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const runtimes: string[] = [];

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-agent-runtime-fallback-output-failure",
          backend: backendWithAgent(repo, async (_workspace, { stage }) => {
            runtimes.push(stage.runtime ?? "");
            if (stage.runtime === "claude") {
              throw Object.assign(new Error("claude exited with code 1"), {
                stderr: "usage limit reached; try again in 10 minutes\n",
              });
            }
            return { stdout: "done\n", stderr: "" };
          }),
        },
      ),
    ).rejects.toThrow(/missing required output implementation/);

    expect(runtimes).toEqual(["claude", "codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-agent-runtime-fallback-output-failure"));
    store.close();
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "blocked",
        runtime: "claude",
      }),
      expect.objectContaining({
        attempt: 2,
        status: "failed",
        runtime: "codex",
      }),
    ]);
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "implement",
      attempt: 2,
      action: "fail",
    });
  });

  it("falls back to the next agent runtime candidate after a setup blocker", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-setup-fallback-agent.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-setup-fallback-agent" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    let calls = 0;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-agent-runtime-setup-fallback",
        backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
          calls += 1;
          if (stage.runtime === "claude") {
            throw Object.assign(new Error("spawn claude ENOENT"), {
              code: "ENOENT",
              stderr: "command claude was not found\n",
            });
          }
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
          return { stdout: "ok\n", stderr: "" };
        }),
      },
    );

    expect(calls).toBe(2);
  });

  it("skips an unavailable agent runtime candidate before spawning and falls back", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-preflight-fallback-agent.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-preflight-fallback-agent" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const spawnedRuntimes: string[] = [];
    const backend = {
      ...backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
        spawnedRuntimes.push(stage.runtime ?? "");
        await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        return { stdout: "ok\n", stderr: "" };
      }),
      preflightAgentRuntime: async (_workspace, { stage }) =>
        stage.runtime === "claude"
          ? {
              available: false as const,
              reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
              missingConfig: ["ANTHROPIC_API_KEY"],
            }
          : { available: true as const },
    } satisfies ExecutionBackend;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-agent-runtime-preflight-fallback",
        backend,
      },
    );

    expect(spawnedRuntimes).toEqual(["codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-agent-runtime-preflight-fallback");
    const projection = projectRun(events);
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.runtime.unavailable",
          stageId: "implement",
          attempt: 1,
          payload: expect.objectContaining({
            runtime: "claude",
            status: "unavailable",
            reason: expect.stringContaining("ANTHROPIC_API_KEY"),
            missingConfig: ["ANTHROPIC_API_KEY"],
          }),
        }),
      ]),
    );
    expect(projection).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "implement",
          status: "completed",
          attempts: [
            {
              attempt: 1,
              status: "unavailable",
              runtime: "claude",
              missingConfig: ["ANTHROPIC_API_KEY"],
            },
            { attempt: 2, status: "completed", runtime: "codex" },
          ],
        },
      ],
    });
    expect(projection.stages[0]?.blocker).toBeUndefined();
  });

  it("fails with actionable diagnostics when all agent runtime candidates are unavailable before spawn", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-preflight-all-unavailable.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-preflight-all-unavailable" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "glm" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const spawnedRuntimes: string[] = [];
    const backend = {
      ...backendWithAgent(repo, async (_workspace, { stage }) => {
        spawnedRuntimes.push(stage.runtime ?? "");
        throw new Error("agent should not spawn for unavailable runtimes");
      }),
      preflightAgentRuntime: async (_workspace, { stage }) => ({
        available: false as const,
        reason:
          stage.runtime === "claude"
            ? "agent runtime claude is not configured. Set ANTHROPIC_API_KEY."
            : "agent runtime glm is not configured. Set one of NITELY_GLM_API_KEY, GLM_API_KEY, ZHIPUAI_API_KEY.",
        missingConfig:
          stage.runtime === "claude"
            ? ["ANTHROPIC_API_KEY"]
            : ["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
      }),
    } satisfies ExecutionBackend;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-agent-runtime-preflight-all-unavailable",
          backend,
        },
      ),
    ).rejects.toThrow(/all agent runtime candidates unavailable.*ANTHROPIC_API_KEY.*NITELY_GLM_API_KEY/s);

    expect(spawnedRuntimes).toEqual([]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-agent-runtime-preflight-all-unavailable"));
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "unavailable",
        runtime: "claude",
        missingConfig: ["ANTHROPIC_API_KEY"],
      }),
      expect.objectContaining({
        attempt: 2,
        status: "failed",
        runtime: "glm",
        missingConfig: ["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
        error: expect.stringContaining("all agent runtime candidates unavailable"),
      }),
    ]);
  });

  it("does not fall back after an agent output-contract failure", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-no-output-fallback.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-no-output-fallback" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    let calls = 0;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-agent-runtime-no-output-fallback",
          backend: backendWithAgent(repo, async () => {
            calls += 1;
            return { stdout: "done\n", stderr: "" };
          }),
        },
      ),
    ).rejects.toThrow(/missing required output implementation/);

    expect(calls).toBe(1);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-agent-runtime-no-output-fallback");
    store.close();
    expect(events.map((event) => event.type)).not.toContain("stage.runtime.fallback");
  });

  it("blocks the run when all agent runtime candidates are externally blocked", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-all-blocked.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-all-blocked" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
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
          createRunId: () => "run-agent-runtime-all-blocked",
          backend: backendWithAgent(repo, async (_workspace, { stage }) => {
            throw Object.assign(new Error(`${stage.runtime} exited with code 1`), {
              stderr: "usage limit reached; try again in 10 minutes\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-agent-runtime-all-blocked"));
    store.close();
    expect(projection).toMatchObject({
      status: "blocked",
      stages: [
        {
          attempts: [
            { attempt: 1, status: "blocked", runtime: "claude" },
            { attempt: 2, status: "blocked", runtime: "codex" },
          ],
        },
      ],
    });
  });

  it("uses the same requirement check for review gates", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-provider.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-provider" },
      spec: {
        stages: [
          {
            id: "review",
            name: "Review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            required_connectors: ["google-drive"],
            prompt: "Review.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });
    let agentCalled = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-provider",
          providerStore: providerStoreWithStatuses([
            {
              id: "google-drive",
              name: "Google Drive",
              configured: false,
              message: "missing token",
              hints: ["NITELY_GOOGLE_ACCESS_TOKEN"],
            },
          ]),
          executeAgent: async () => {
            agentCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/stage review requires missing provider\(s\): google-drive/);

    expect(agentCalled).toBe(false);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-provider");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "review",
          type: "stage.requirements.failed",
          payload: expect.objectContaining({
            providerIds: ["google-drive"],
            missingProviders: ["google-drive"],
          }),
        }),
      ]),
    );
  });

  it("publishes all declared agent outputs from artifact.json and persists backend logs", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "manifest-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "manifest-output" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation", "pr-title"],
          },
        ],
      },
    });

    const backend: ExecutionBackend = {
      async createWorkspace({ runId, worktreePath }) {
        await git(repo, ["worktree", "add", "-b", `nitely/${runId}`, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      async runAgent(_workspace, input) {
        await mkdir(join(input.attemptDirectory, "notes"), { recursive: true });
        await writeFile(
          join(input.attemptDirectory, "notes", "implementation.md"),
          "Implemented from manifest\n",
          "utf8",
        );
        await writeFile(
          join(input.attemptDirectory, "pr-title.txt"),
          "Manifest title\n",
          "utf8",
        );
        await writeJson(join(input.attemptDirectory, "artifact.json"), {
          version: 1,
          stageId: "implement",
          attempt: 1,
          outputs: [
            {
              id: "implementation",
              path: "notes/implementation.md",
              mediaType: "text/markdown",
            },
            { id: "pr-title", path: "pr-title.txt", mediaType: "text/plain" },
          ],
        });
        return {
          stdout: "agent stdout\n",
          stderr: "agent stderr\n",
        };
      },
      async runCommand() {
        throw new Error("command should not run");
      },
      async commitAll() {
        return { committed: false };
      },
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-manifest-output", backend },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-manifest-output");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "stdout.log"), "utf8"),
    ).resolves.toBe("agent stdout\n");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "stderr.log"), "utf8"),
    ).resolves.toBe("agent stderr\n");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "output.md"), "utf8"),
    ).resolves.toContain("- implementation: notes/implementation.md (text/markdown)");

    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "implementation",
          producer: "implement",
          path: "stages/implement/1/notes/implementation.md",
          mediaType: "text/markdown",
        }),
        expect.objectContaining({
          id: "pr-title",
          producer: "implement",
          path: "stages/implement/1/pr-title.txt",
          mediaType: "text/plain",
        }),
      ]),
    );
  });

  it("does not render a skills section for agent stages without skills", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "no-skills.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "no-skills" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let prompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
      },
      {
        createRunId: () => "run-no-skills",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(prompt).not.toContain("## Skills");
    expect(prompt).toContain("## Instructions\n\nImplement the change.");
    expect(prompt).toContain("## Required Outputs");
  });

  it("persists artifact registry metadata, renders prompts, and writes artifact evidence", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "artifact-contracts.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "artifact-contracts" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: [
              {
                id: "implementation",
                name: "Implementation summary",
                type: "implementation",
                description: "Markdown summary of code changes and verification",
                mediaType: "text/markdown",
                schema: { kind: "markdown" },
                version: "1",
              },
            ],
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

    let prompt = "";
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-artifact-registry",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "Implemented feature.\n",
            "utf8",
          );
        },
        publishChange: async ({ evidencePath }) => ({
          url: "https://example.test/pr/artifact-contracts",
          evidencePath,
        }),
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", result.runId);
    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as {
      runId: string;
      artifacts: Array<Record<string, unknown>>;
    };
    expect(registry).toMatchObject({
      runId: "run-artifact-registry",
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          id: "spec",
          producer: "external",
          mediaType: "text/markdown",
          path: "inputs/spec/content",
          sourceUri: "specs/change.md",
          filename: "change.md",
        }),
        expect.objectContaining({
          id: "implementation",
          name: "Implementation summary",
          type: "implementation",
          description: "Markdown summary of code changes and verification",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/implementation.md",
          filename: "implementation.md",
          schema: { kind: "markdown" },
          version: "1",
        }),
      ]),
    });

    expect(prompt).toContain("- implementation");
    expect(prompt).toContain("Type: implementation");
    expect(prompt).toContain(
      "Description: Markdown summary of code changes and verification",
    );
    expect(prompt).toContain("Media type: text/markdown");
    expect(prompt).toContain("Version: 1");
    expect(prompt).toContain("Artifact: spec");
    expect(prompt).toContain("Producer: external");
    expect(prompt).toContain("Path: inputs/spec/content");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Artifacts");
    expect(evidence).toContain(
      "- implementation: producer implement, type implementation, media text/markdown",
    );
    expect(evidence).toContain("Path: stages/implement/1/implementation.md");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-artifact-registry"));
    store.close();
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "implementation",
          producer: "implement",
          path: "stages/implement/1/implementation.md",
        }),
      ]),
    );
  });

  it("renders only declared input artifacts in agent prompts", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "scoped-agent-inputs.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "scoped-agent-inputs" },
      spec: {
        stages: [
          {
            id: "produce",
            type: "agent",
            runtime: "mock",
            prompt: "Produce artifacts.",
            inputs: [],
            outputs: ["allowed-output", "secret-output"],
          },
          {
            id: "consume",
            type: "agent",
            runtime: "mock",
            prompt: "Consume the allowed artifact.",
            inputs: ["allowed-output"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let consumePrompt = "";
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-scoped-agent-inputs",
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          if (stage.id === "produce") {
            await writeFile(
              join(attemptDirectory, "allowed-output.md"),
              "allowed preview\n",
              "utf8",
            );
            await writeFile(
              join(attemptDirectory, "secret-output.md"),
              "secret preview\n",
              "utf8",
            );
            return;
          }
          consumePrompt = prompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(consumePrompt).toContain("Artifact: allowed-output");
    expect(consumePrompt).toContain("allowed preview");
    expect(consumePrompt).not.toContain("secret-output");
    expect(consumePrompt).not.toContain("secret preview");
  });

  it("renders only declared input artifacts in review-gate prompts", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "scoped-review-inputs.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "scoped-review-inputs" },
      spec: {
        stages: [
          {
            id: "produce",
            type: "agent",
            runtime: "mock",
            prompt: "Produce artifacts.",
            inputs: [],
            outputs: ["allowed-output", "secret-output"],
          },
          {
            id: "review",
            name: "Scoped Review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            prompt: "Review the allowed artifact.",
            inputs: ["allowed-output"],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    let reviewPrompt = "";
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-scoped-review-inputs",
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          if (stage.id === "produce") {
            await writeFile(
              join(attemptDirectory, "allowed-output.md"),
              "allowed review preview\n",
              "utf8",
            );
            await writeFile(
              join(attemptDirectory, "secret-output.md"),
              "secret review preview\n",
              "utf8",
            );
            return;
          }
          reviewPrompt = prompt;
          await writeFile(join(attemptDirectory, "review-gate.md"), "No issues\n", "utf8");
        },
      },
    );

    expect(reviewPrompt).toContain("Artifact: allowed-output");
    expect(reviewPrompt).toContain("allowed review preview");
    expect(reviewPrompt).not.toContain("secret-output");
    expect(reviewPrompt).not.toContain("secret review preview");
  });

  it("injects declared skills and bundled resources into prompts and evidence", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "tdd",
      "---\nname: tdd\ndescription: Write tests before implementation\n---\nFollow red-green-refactor.\n",
    );
    await mkdir(join(repo, ".nitely", "skills", "tdd", "docs"), { recursive: true });
    await writeFile(
      join(repo, ".nitely", "skills", "tdd", "docs", "checklist.md"),
      "Check tests\n",
      "utf8",
    );
    const flowPath = join(repo, "flows", "skill-prompt.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "skill-prompt" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            skills: ["tdd"],
            prompt: "Implement the change.",
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

    let prompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
      },
      {
        createRunId: () => "run-skill-prompt",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory, worktreePath }) => {
          prompt = renderedPrompt;
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
        publishChange: async ({ evidencePath }) => ({
          url: "https://example.test/pr/skill-prompt",
          evidencePath,
        }),
      },
    );

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("### Skill: tdd");
    expect(prompt).toContain("Description: Write tests before implementation");
    expect(prompt).toContain("Source: .nitely/skills/tdd/SKILL.md");
    expect(prompt).toMatch(/Version: sha256:[a-f0-9]{64}/);
    expect(prompt).toContain("Follow red-green-refactor.");
    expect(prompt).toContain(
      "- .nitely/skills/tdd/docs/checklist.md -> .nitely/runs/run-skill-prompt/skills/tdd/docs/checklist.md",
    );
    await expect(
      readFile(
        join(repo, ".nitely", "runs", "run-skill-prompt", "skills", "tdd", "docs", "checklist.md"),
        "utf8",
      ),
    ).resolves.toBe("Check tests\n");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-skill-prompt", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Loaded Skills");
    expect(evidence).toMatch(
      /- implement \/ tdd: \.nitely\/skills\/tdd\/SKILL\.md \(sha256:[a-f0-9]{64}\)/,
    );
    expect(evidence).toContain("Description: Write tests before implementation");
    expect(evidence).toContain(
      "Resources: .nitely/runs/run-skill-prompt/skills/tdd/docs/checklist.md",
    );
  });

  it("fails unknown skills before executing the agent", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "unknown-skill.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "unknown-skill" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            skills: ["missing"],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let called = false;
    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
        },
        {
          createRunId: () => "run-unknown-skill",
          executeAgent: async () => {
            called = true;
          },
        },
      ),
    ).rejects.toThrow(
      /stage "implement" skill "missing": unknown skill "missing": expected \.nitely\/skills\/missing\/SKILL\.md/,
    );
    expect(called).toBe(false);
  });

  it("redacts skill content and resource metadata in prompts and evidence", async () => {
    const previous = process.env.NITELY_SKILL_SECRET_TOKEN;
    process.env.NITELY_SKILL_SECRET_TOKEN = "skill-secret-value";
    try {
      const repo = await createRepo();
      await writeSkill(
        repo,
        "secure",
        "---\nname: secure\ndescription: Keep secrets out\n---\nUse token=skill-secret-value.\n",
      );
      await writeFile(
        join(repo, ".nitely", "skills", "secure", "skill-secret-value.md"),
        "secret resource\n",
        "utf8",
      );
      const flowPath = join(repo, "flows", "skill-redaction.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "skill-redaction" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              skills: ["secure"],
              prompt: "Implement the change.",
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

      let prompt = "";
      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
        },
        {
          createRunId: () => "run-skill-redaction",
          executeAgent: async ({ prompt: renderedPrompt, attemptDirectory, worktreePath }) => {
            prompt = renderedPrompt;
            await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          },
          publishChange: async ({ evidencePath }) => ({
            url: "https://example.test/pr/skill-redaction",
            evidencePath,
          }),
        },
      );

      const evidence = await readFile(
        join(repo, ".nitely", "runs", "run-skill-redaction", "evidence.md"),
        "utf8",
      );
      for (const text of [prompt, evidence]) {
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain("skill-secret-value");
      }
    } finally {
      if (previous === undefined) {
        delete process.env.NITELY_SKILL_SECRET_TOKEN;
      } else {
        process.env.NITELY_SKILL_SECRET_TOKEN = previous;
      }
    }
  });

  it("runs a flow supplied as a document without a flow file and records it for resume", async () => {
    const repo = await createRepo();
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "from-db", workItemType: "report.generation" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "printf ok", inputs: [], outputs: ["out"] },
        ],
      },
    });

    await runFlow(
      {
        flowPath: "flow-db-1",
        flowDocument,
        repoPath: repo,
        inputs: {},
      },
      { createRunId: () => "run-from-db" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-from-db");
    store.close();
    const created = events.find((event) => event.type === "run.created");
    const payload = created?.payload as Record<string, unknown>;
    expect(payload.flowName).toBe("from-db");
    expect(payload.flowDocument).toBe(flowDocument);

    const record = await readFile(
      join(repo, ".nitely", "runs", "run-from-db", "run.json"),
      "utf8",
    );
    expect(record).toContain('"flowName": "from-db"');
  });

  it("enforces declared inputs for a flow supplied as a document", async () => {
    const repo = await createRepo();
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "from-db-input-contract",
        inputs: [{ id: "seed", type: "keyword-seed" }],
      },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    });

    await expect(
      runFlow(
        {
          flowPath: "flow-db-input-contract",
          flowDocument,
          repoPath: repo,
          inputs: {},
        },
        { createRunId: () => "run-db-missing-input" },
      ),
    ).rejects.toThrow(/seed/);
  });

  it("enforces high-risk governance for a flow supplied as a document", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Change", "utf8");
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "from-db-ungated", workItemType: "autofarm.site" },
      spec: {
        stages: [
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["spec"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let published = false;
    await expect(
      runFlow(
        {
          flowPath: "flow-db-ungated",
          flowDocument,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        },
        {
          createRunId: () => "run-db-ungated",
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/1", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/gate|approv/i);
    expect(published).toBe(false);
  });

  it("records run, workspace, stage, command, and completion events", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "events.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "events" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf command-output",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        ownerId: "usr_run_owner",
        organizationId: "org_run_team",
      },
      {
        createRunId: () => "run-events",
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-events");
    store.close();

    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "workspace.created",
      "stage.started",
      "command.completed",
      "orchestrator.decision",
      "stage.completed",
      "run.completed",
    ]);
    expect(projectRun(events)).toMatchObject({
      runId: "run-events",
      ownerId: "usr_run_owner",
      organizationId: "org_run_team",
      status: "completed",
      logs: [
        {
          stageId: "test",
          attempt: 1,
          source: "command",
          command: "printf command-output",
          stdout: "command-output",
          stderr: "",
        },
      ],
    });
    await expect(
      readFile(join(repo, ".nitely", "runs", "run-events", "run.json"), "utf8"),
    ).resolves.toContain('"ownerId": "usr_run_owner"');
    await expect(
      readFile(join(repo, ".nitely", "runs", "run-events", "run.json"), "utf8"),
    ).resolves.toContain('"organizationId": "org_run_team"');
  });

  it("fails an agent stage that does not produce a declared required output", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "required-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "required-output" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: [
              {
                id: "implementation",
                type: "implementation",
                mediaType: "text/markdown",
              },
            ],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-missing-output",
          // agent writes nothing -> declared output "implementation" is missing
          executeAgent: async () => {},
        },
      ),
    ).rejects.toThrow(/implementation/);
  });

  it("fails an agent stage whose JSON output violates its declared schema", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "schema-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "schema-output" },
      spec: {
        stages: [
          {
            id: "plan",
            type: "agent",
            runtime: "mock",
            prompt: "Produce the plan.",
            inputs: [],
            outputs: [
              {
                id: "site-plan",
                type: "autofarm.site-plan",
                mediaType: "application/json",
                schema: { type: "object", required: ["name"] },
              },
            ],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-bad-schema",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(
              join(attemptDirectory, "site-plan.md"),
              JSON.stringify({ notName: 1 }),
              "utf8",
            );
          },
        },
      ),
    ).rejects.toThrow(/schema/i);
  });

  it("fails a run that does not supply a declared required flow input", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "input-contract.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "input-contract",
        inputs: [{ id: "seed", type: "keyword-seed" }],
      },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-missing-input" },
      ),
    ).rejects.toThrow(/seed/);
  });

  it("blocks a protected stage for a high-risk work item type without an approved gate", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Change", "utf8");
    const flowPath = join(repo, "flows", "ungated-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "ungated-publish", workItemType: "autofarm.site" },
      spec: {
        stages: [
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["spec"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let published = false;
    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
          workItemType: "autofarm.site",
        },
        {
          createRunId: () => "run-ungated",
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/1", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/gate|approv/i);
    expect(published).toBe(false);
  });

  it("records command execution evidence: duration, cwd, and timeout", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cmd-evidence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cmd-evidence" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf ok",
            timeoutMs: 30000,
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-cmd-evidence" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cmd-evidence");
    store.close();
    const completed = events.find((event) => event.type === "command.completed");
    const payload = completed?.payload as Record<string, unknown>;
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof payload.cwd).toBe("string");
    expect(payload.timeoutMs).toBe(30000);
    expect(payload.exitCode).toBe(0);
  });

  it("caps command output in events and summaries while preserving full log files", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cmd-output-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cmd-output-budget" },
      spec: {
        maxToolOutputTokens: 100,
        stages: [
          {
            id: "test",
            type: "command",
            command: "npm test",
            maxToolOutputTokens: 40,
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const stdout = "stdout-" + "x".repeat(1000);
    const stderr = "stderr-" + "y".repeat(1000);
    const backend: ExecutionBackend = {
      async createWorkspace({ runId, branchName, worktreePath }) {
        await git(repo, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async runCommand() {
        return { stdout, stderr, exitCode: 0 };
      },
      async commitAll() {
        return { committed: false };
      },
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-cmd-output-budget", backend },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cmd-output-budget");
    store.close();
    const completed = events.find((event) => event.type === "command.completed");
    const trimmed = events.find((event) => event.type === "budget.trimmed");
    const payload = completed?.payload as Record<string, unknown>;
    expect(payload.stdout).not.toContain("x".repeat(500));
    expect(payload.stderr).not.toContain("y".repeat(500));
    expect(payload.stdout).toContain("truncated");
    expect(payload.stderr).toContain("truncated");
    expect(trimmed?.stageId).toBe("test");
    expect(trimmed?.payload).toMatchObject({
      budgetKind: "tool-output",
      budget: 40,
    });
    expect(
      (trimmed?.payload as { approxTokensAfter: number } | undefined)?.approxTokensAfter,
    ).toBeLessThanOrEqual(40);

    const stdoutPath = payload.stdoutPath as string;
    const stderrPath = payload.stderrPath as string;
    const outputPath = payload.outputPath as string;
    expect(await readFile(stdoutPath, "utf8")).toBe(stdout);
    expect(await readFile(stderrPath, "utf8")).toBe(stderr);
    const output = await readFile(outputPath, "utf8");
    expect(output).toContain("Output truncated");
    expect(output).not.toContain("x".repeat(500));
  });

  it("uses the flow-level maxToolOutputTokens default for command stages", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cmd-output-flow-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cmd-output-flow-budget" },
      spec: {
        maxToolOutputTokens: 20,
        stages: [
          {
            id: "test",
            type: "command",
            command: "npm test",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const backend: ExecutionBackend = {
      async createWorkspace({ runId, branchName, worktreePath }) {
        await git(repo, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async runCommand() {
        return { stdout: "z".repeat(1000), stderr: "", exitCode: 0 };
      },
      async commitAll() {
        return { committed: false };
      },
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-cmd-output-flow-budget", backend },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cmd-output-flow-budget");
    store.close();
    const trimmed = events.find((event) => event.type === "budget.trimmed");
    expect(trimmed?.payload).toMatchObject({
      budgetKind: "tool-output",
      budget: 20,
    });
    expect(
      (trimmed?.payload as { approxTokensAfter: number } | undefined)?.approxTokensAfter,
    ).toBeLessThanOrEqual(20);
  });

  it("records approval evidence: actor, decision, and reviewed artifacts", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "approval-evidence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "approval-evidence" },
      spec: {
        stages: [
          {
            id: "build",
            type: "command",
            command: "printf plan",
            inputs: [],
            outputs: ["site-plan"],
          },
          {
            id: "approve-plan",
            type: "approval",
            prompt: "Approve the plan",
            inputs: ["site-plan"],
            outputs: [],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-approval-evidence" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-approval-evidence");
    store.close();
    const resolved = events.find((event) => event.type === "approval.resolved");
    const payload = resolved?.payload as Record<string, unknown>;
    expect(payload.actor).toBe("system:auto");
    expect(payload.decision).toBe("approved");
    expect(payload.reviewedArtifactIds).toEqual(["site-plan"]);
  });

  it("records repository index query evidence in the run evidence file", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(
      join(repo, "src", "main.ts"),
      "export class MainService {}\n",
      "utf8",
    );
    await writeFile(join(repo, "specs", "change.md"), "Update MainService", "utf8");
    await buildRepoIndex(repo);
    const flowPath = join(repo, "flows", "repo-index-evidence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "repo-index-evidence" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-repo-index-evidence",
        executeAgent: async ({ attemptDirectory }) => {
          const queryResult = await queryRepoIndex({
            repoPath: repo,
            query: "MainService",
          });
          recordRepoIndexQuery({
            repoPath: repo,
            runId: "run-repo-index-evidence",
            stageId: "implement",
            attempt: 1,
            result: queryResult,
          });
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "Implemented MainService change.\n",
            "utf8",
          );
        },
      },
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", result.runId, "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Repository Index Queries");
    expect(evidence).toContain("MainService");
    expect(evidence).toContain("src/main.ts");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-repo-index-evidence"));
    store.close();
    expect(projection.repoIndexQueries?.[0]).toMatchObject({
      query: "MainService",
      matches: [{ path: "src/main.ts", reasons: ["symbol"] }],
    });
  });

  it("records integrity and provenance for generated and external artifacts", async () => {
    const { createHash } = await import("node:crypto");
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "integrity.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "integrity" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-integrity",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "Implemented feature.\n",
            "utf8",
          );
        },
      },
    );

    const registry = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", result.runId, "artifacts.json"),
        "utf8",
      ),
    ) as { artifacts: Array<Record<string, unknown>> };

    const implementation = registry.artifacts.find((a) => a.id === "implementation");
    expect(implementation).toMatchObject({
      sha256: createHash("sha256").update("Implemented feature.\n", "utf8").digest("hex"),
      size: Buffer.byteLength("Implemented feature.\n", "utf8"),
      createdByRunId: "run-integrity",
      stageId: "implement",
    });

    const spec = registry.artifacts.find((a) => a.id === "spec");
    expect(spec).toMatchObject({
      sha256: createHash("sha256").update("Create feature.txt", "utf8").digest("hex"),
      size: Buffer.byteLength("Create feature.txt", "utf8"),
      createdByRunId: "run-integrity",
    });
  });

  it("records an approval gate as a first-class artifact", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "gated.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "gated" },
      spec: {
        stages: [
          {
            id: "approve-plan",
            type: "approval",
            prompt: "Approve the plan",
            inputs: [],
            outputs: [],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-gate" },
    );

    const registry = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-gate", "artifacts.json"),
        "utf8",
      ),
    );
    const gate = registry.artifacts.find(
      (artifact: { type?: string }) => artifact.type === "gate.approval",
    );
    expect(gate).toMatchObject({
      id: "approve-plan",
      type: "gate.approval",
      producer: "approve-plan",
      mediaType: "application/vnd.nitely.gate+json",
      gate: { gateId: "approve-plan", state: "approved" },
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-gate"));
    store.close();
    expect(projection.orchestratorDecisions).toEqual([
      expect.objectContaining({
        stageId: "approve-plan",
        stageType: "approval",
        attempt: 1,
        maxAttempts: 1,
        action: "complete",
      }),
    ]);
  });

  it("runs a deterministic gate and publishes a passed gate result", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "deterministic-gate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "deterministic-gate" },
      spec: {
        stages: [
          {
            id: "verify",
            name: "Verification",
            type: "gate",
            mode: "deterministic",
            command: "printf gate-ok",
            inputs: [],
            outputs: ["verify-gate"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["verify-gate"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-deterministic-gate",
        publishChange: async ({ evidencePath }) => ({
          url: "https://example.test/pr/deterministic-gate",
          evidencePath,
        }),
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-deterministic-gate");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-deterministic-gate");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).toContain("gate.completed");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "verify-gate",
        stageId: "verify",
        name: "Verification",
        mode: "deterministic",
        status: "passed",
        command: "printf gate-ok",
        stdout: "gate-ok",
        stderr: "",
      }),
    ]);

    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    );
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "verify-gate",
          type: "gate.result",
          producer: "verify",
          mediaType: "application/json",
          path: "stages/verify/1/verify-gate.json",
        }),
      ]),
    );
    await expect(
      readFile(join(runDirectory, "stages", "verify", "1", "verify-gate.json"), "utf8"),
    ).resolves.toContain('"status": "passed"');

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Gates");
    expect(evidence).toContain("- verify (Verification): deterministic, passed");
    expect(evidence).toContain("Command: printf gate-ok");
  });

  it("blocks downstream agents when an analysis gate has critical findings", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "spec.md"), "FR-001 Import repos\n", "utf8");
    await writeFile(
      join(repo, "docs", "tasks.md"),
      `# Tasks

## Phase 1

- [ ] T001 [US-001] Implement unrelated work
`,
      "utf8",
    );
    const flowPath = join(repo, "flows", "analysis-gate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "analysis-gate" },
      spec: {
        stages: [
          {
            id: "analyze",
            type: "gate",
            mode: "analysis",
            inputs: ["spec", "tasks"],
            outputs: ["analysis-report"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
            inputs: ["analysis-report"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let agentRan = false;
    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            spec: { connector: "local-file", uri: "docs/spec.md" },
            tasks: { connector: "local-file", uri: "docs/tasks.md" },
          },
        },
        {
          createRunId: () => "run-analysis-blocking",
          executeAgent: async () => {
            agentRan = true;
          },
        },
      ),
    ).rejects.toThrow(/analysis found 1 critical finding/);

    expect(agentRan).toBe(false);
    const runDirectory = join(repo, ".nitely", "runs", "run-analysis-blocking");
    const report = await readFile(
      join(runDirectory, "stages", "analyze", "1", "analysis-report.md"),
      "utf8",
    );
    expect(report).toContain("missing-requirement-coverage");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-analysis-blocking"));
    store.close();
    expect(projection.gates).toEqual([
      expect.objectContaining({
        mode: "analysis",
        status: "failed",
        reason: "analysis found 1 critical finding",
      }),
    ]);
    expect(projection.status).toBe("failed");
  });

  it("records advisory analysis findings without failing the run", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "spec.md"), "FR-001 Import repos\n", "utf8");
    await writeFile(
      join(repo, "docs", "tasks.md"),
      `# Tasks

## Phase 1

- [ ] T001 [US-001] Implement unrelated work
`,
      "utf8",
    );
    const flowPath = join(repo, "flows", "analysis-advisory.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "analysis-advisory" },
      spec: {
        stages: [
          {
            id: "analyze",
            type: "gate",
            mode: "analysis",
            blocking: false,
            inputs: ["spec", "tasks"],
            outputs: ["analysis-report"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
            inputs: ["analysis-report"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "docs/spec.md" },
          tasks: { connector: "local-file", uri: "docs/tasks.md" },
        },
      },
      {
        createRunId: () => "run-analysis-advisory",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-analysis-advisory"));
    store.close();
    expect(projection.status).toBe("completed");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        mode: "analysis",
        status: "passed",
        stdout: expect.stringContaining("missing-requirement-coverage"),
      }),
    ]);
  });

  it("fails a deterministic gate with a structured failed gate result", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "deterministic-gate-fail.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "deterministic-gate-fail" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "gate",
            mode: "deterministic",
            command: "printf nope >&2; exit 4",
            maxAttempts: 1,
            inputs: [],
            outputs: ["verify-gate"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-deterministic-gate-fail" },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-deterministic-gate-fail"));
    store.close();

    expect(projection.status).toBe("failed");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "verify-gate",
        stageId: "verify",
        mode: "deterministic",
        status: "failed",
        command: "printf nope >&2; exit 4",
        reason: expect.stringContaining("command failed with exit code 4"),
        stderr: "nope",
      }),
    ]);
    expect(projection.stages[0]).toMatchObject({
      stageId: "verify",
      status: "failed",
      gate: expect.objectContaining({ status: "failed" }),
    });
  });

  it("runs a review gate through the agent runtime and records reviewed artifacts", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Review this change", "utf8");
    const flowPath = join(repo, "flows", "review-gate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate" },
      spec: {
        stages: [
          {
            id: "review",
            name: "Implementation Review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: ["spec"],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    let prompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-review-gate",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "review-gate.md"), "No issues\n", "utf8");
        },
      },
    );

    expect(prompt).toContain("# Nitely Stage: review");
    expect(prompt).toContain("Review the implementation.");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-gate"));
    store.close();
    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "review-gate",
        stageId: "review",
        name: "Implementation Review",
        mode: "review",
        status: "passed",
        runtime: "codex",
        reviewedArtifacts: ["spec"],
        reviewOutput: expect.objectContaining({
          id: "review-gate",
          path: "stages/review/1/review-gate.md",
          mediaType: "text/markdown",
          content: "No issues\n",
          truncated: false,
        }),
      }),
    ]);

    const runDirectory = join(repo, ".nitely", "runs", "run-review-gate");
    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    );
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review-gate",
          type: "gate.result",
          gateResult: expect.objectContaining({
            reviewOutput: expect.objectContaining({
              content: "No issues\n",
            }),
          }),
        }),
      ]),
    );
  });

  it("blocks a review gate on agent usage-limit output", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-usage-limit.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-usage-limit" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            maxAttempts: 2,
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-usage-limit",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error("codex exited with code 1"), {
              stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage review/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-usage-limit");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).toContain("stage.blocked");
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).not.toContain("gate.completed");
    expect(events.map((event) => event.type)).not.toContain("stage.failed");
    expect(projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_usage_limit",
        stageId: "review",
        runtime: "codex",
        retryAfter: "10 minutes",
      },
      gates: [],
    });
  });

  it("falls back to the next review gate runtime candidate after a usage-limit blocker", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-runtime-fallback.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-runtime-fallback" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });
    const runtimes: string[] = [];

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-review-runtime-fallback",
        backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
          runtimes.push(stage.runtime ?? "");
          if (stage.runtime === "claude") {
            throw Object.assign(new Error("claude exited with code 1"), {
              stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
            });
          }
          await writeFile(join(attemptDirectory, "review-gate.md"), "Approved\n", "utf8");
          return { stdout: "ok\n", stderr: "" };
        }),
      },
    );

    expect(runtimes).toEqual(["claude", "codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-runtime-fallback");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toContain("stage.runtime.fallback");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        stageId: "review",
        status: "passed",
        runtime: "codex",
      }),
    ]);
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: "blocked", runtime: "claude" }),
      expect.objectContaining({ attempt: 2, status: "completed", runtime: "codex" }),
    ]);
  });

  it("skips an unavailable review gate runtime candidate before spawning and falls back", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-runtime-preflight-fallback.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-runtime-preflight-fallback" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });
    const runtimes: string[] = [];
    const backend = {
      ...backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
        runtimes.push(stage.runtime ?? "");
        await writeFile(join(attemptDirectory, "review-gate.md"), "Approved\n", "utf8");
        return { stdout: "ok\n", stderr: "" };
      }),
      preflightAgentRuntime: async (_workspace, { stage }) =>
        stage.runtime === "claude"
          ? {
              available: false as const,
              reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
              missingConfig: ["ANTHROPIC_API_KEY"],
            }
          : { available: true as const },
    } satisfies ExecutionBackend;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-review-runtime-preflight-fallback",
        backend,
      },
    );

    expect(runtimes).toEqual(["codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-runtime-preflight-fallback");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toContain("stage.runtime.unavailable");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        stageId: "review",
        status: "passed",
        runtime: "codex",
      }),
    ]);
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "unavailable",
        runtime: "claude",
        missingConfig: ["ANTHROPIC_API_KEY"],
      }),
      expect.objectContaining({ attempt: 2, status: "completed", runtime: "codex" }),
    ]);
  });

  it("records review output failures on the selected review runtime candidate after fallback", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-runtime-fallback-output-failure.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-runtime-fallback-output-failure" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });
    const runtimes: string[] = [];

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-runtime-fallback-output-failure",
          backend: backendWithAgent(repo, async (_workspace, { stage }) => {
            runtimes.push(stage.runtime ?? "");
            if (stage.runtime === "claude") {
              throw Object.assign(new Error("claude exited with code 1"), {
                stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
              });
            }
            return { stdout: "done\n", stderr: "" };
          }),
        },
      ),
    ).rejects.toThrow(/gate failed after 2 of 1 attempts/);

    expect(runtimes).toEqual(["claude", "codex"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-runtime-fallback-output-failure");
    const projection = projectRun(events);
    store.close();
    expect(
      events.find(
        (event) => event.type === "gate.completed" && event.stageId === "review",
      ),
    ).toMatchObject({
      attempt: 2,
    });
    expect(projection.stages[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "blocked",
        runtime: "claude",
      }),
      expect.objectContaining({
        attempt: 2,
        status: "failed",
        runtime: "codex",
      }),
    ]);
    expect(projection.gates).toEqual([
      expect.objectContaining({
        stageId: "review",
        status: "failed",
        runtime: "codex",
        reason: expect.stringContaining("missing required output review-gate"),
      }),
    ]);
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "review",
      attempt: 2,
      action: "fail",
    });
  });

  it("fails a review gate when the agent writes no declared output", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-missing-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-missing-output" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            maxAttempts: 1,
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-gate-missing-output",
          executeAgent: async () => {},
        },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-gate-missing-output"));
    store.close();

    expect(projection.status).toBe("failed");
    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "review-gate",
        stageId: "review",
        mode: "review",
        status: "failed",
        reason: expect.stringContaining("missing required output review-gate"),
      }),
    ]);
  });

  it("blocks publish when review gate output contains a P1 finding", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-p1-blocks-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-p1-blocks-publish" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            maxAttempts: 1,
            inputs: [],
            outputs: ["review"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["review"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let publishCalled = false;
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-gate-p1-blocks-publish",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(
              join(attemptDirectory, "review.md"),
              "### P1 - Publish would ship a broken gate\n",
              "utf8",
            );
          },
          publishChange: async ({ evidencePath }) => {
            publishCalled = true;
            return { url: "https://example.test/pr/blocked", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    expect(publishCalled).toBe(false);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-gate-p1-blocks-publish"));
    store.close();

    expect(projection.status).toBe("failed");
    expect(projection.changeRequestUrl).toBeUndefined();
    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "review",
        stageId: "review",
        mode: "review",
        status: "failed",
        reason: expect.stringContaining("stages/review/1/review.md"),
        reviewOutput: expect.objectContaining({
          path: "stages/review/1/review.md",
          content: "### P1 - Publish would ship a broken gate\n",
        }),
      }),
    ]);
    expect(projection.stages.find((stage) => stage.stageId === "publish")).toBeUndefined();
  });

  it("blocks publish when review gate output contains an explicit fail verdict", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-verdict-fail-blocks-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-verdict-fail-blocks-publish" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            maxAttempts: 1,
            inputs: [],
            outputs: ["review"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["review"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let publishCalled = false;
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-gate-verdict-fail-blocks-publish",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(
              join(attemptDirectory, "review.md"),
              "Review verdict: fail\n\nA blocking issue remains.\n",
              "utf8",
            );
          },
          publishChange: async ({ evidencePath }) => {
            publishCalled = true;
            return { url: "https://example.test/pr/blocked", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    expect(publishCalled).toBe(false);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-gate-verdict-fail-blocks-publish"));
    store.close();

    expect(projection.status).toBe("failed");
    expect(projection.changeRequestUrl).toBeUndefined();
    expect(projection.gates[0]).toEqual(
      expect.objectContaining({
        stageId: "review",
        status: "failed",
        reason: expect.stringContaining("stages/review/1/review.md"),
      }),
    );
  });

  it("allows publish when review gate output contains only a P2 finding", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-p2-allows-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-p2-allows-publish" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["review"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let publishCalled = false;
    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-review-gate-p2-allows-publish",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(
            join(attemptDirectory, "review.md"),
            "### P2 - Consider adding a narrower helper\n",
            "utf8",
          );
        },
        publishChange: async ({ evidencePath }) => {
          publishCalled = true;
          return { url: "https://example.test/pr/published", evidencePath };
        },
      },
    );

    expect(publishCalled).toBe(true);
    expect(result.changeRequestUrl).toBe("https://example.test/pr/published");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-gate-p2-allows-publish"));
    store.close();

    expect(projection.status).toBe("completed");
    expect(projection.gates[0]).toEqual(
      expect.objectContaining({
        stageId: "review",
        status: "passed",
        reason: undefined,
      }),
    );
  });

  it("fails a deterministic gate when timeoutMs expires", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "deterministic-gate-timeout.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "deterministic-gate-timeout" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "gate",
            mode: "deterministic",
            command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`,
            timeoutMs: 25,
            maxAttempts: 1,
            inputs: [],
            outputs: ["verify-gate"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-deterministic-gate-timeout" },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-deterministic-gate-timeout"));
    store.close();

    expect(projection.gates).toEqual([
      expect.objectContaining({
        id: "verify-gate",
        stageId: "verify",
        mode: "deterministic",
        status: "failed",
        reason: expect.stringContaining("timed out after 25ms"),
        stderr: expect.stringContaining("timed out after 25ms"),
      }),
    ]);
  });

  it("persists the originating work item id and type in run metadata", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "work-item.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "work-item", workItemType: "autofarm.site" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf ok",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        workItemId: "wi-42",
        workItemType: "autofarm.site",
      },
      {
        createRunId: () => "run-work-item",
      },
    );

    const record = await readFile(
      join(repo, ".nitely", "runs", "run-work-item", "run.json"),
      "utf8",
    );
    expect(record).toContain('"workItemId": "wi-42"');
    expect(record).toContain('"workItemType": "autofarm.site"');
  });

  it("persists planning approval snapshots in run metadata and evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "planning.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "planning" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf ok",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        workItemId: "wi-approval",
        planningApproval: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
            techDesign: {
              path: "tech-design.md",
              state: "tech_design_approved",
            },
          },
          events: [
            {
              artifact: "spec",
              artifactPath: "spec.md",
              decision: "approve",
              at: "2026-06-22T00:00:00.000Z",
              previousState: "draft_spec",
              nextState: "spec_approved",
            },
          ],
        },
      },
      {
        createRunId: () => "run-planning-approval",
      },
    );

    const runRecord = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-planning-approval", "run.json"),
        "utf8",
      ),
    ) as { planningApproval?: unknown };
    expect(runRecord.planningApproval).toMatchObject({
      artifacts: {
        spec: { state: "spec_approved" },
        techDesign: { state: "tech_design_approved" },
      },
    });

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-planning-approval", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Planning Approval");
    expect(evidence).toContain("spec: spec_approved");
    expect(evidence).toContain("tech-design: tech_design_approved");
  });

  it("blocks direct runs when planning has an approved spec without a technical design", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "planning.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "planning" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf ok",
            inputs: [],
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
          inputs: {},
          workItemId: "wi-missing-tech-design",
          planningApproval: {
            artifacts: {
              spec: { path: "spec.md", state: "spec_approved" },
            },
            events: [],
          },
        },
        {
          backend: backendWithAgent(repo, async () => {
            throw new Error("agent should not run");
          }),
        },
      ),
    ).rejects.toThrow("draft technical design is required before starting a run");
  });

  it("persists GitHub PR comment trigger metadata in events and run metadata", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "triggered.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "triggered" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const trigger = {
      type: "github-pr-comment" as const,
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      prNumber: 15,
      prUrl: "https://github.com/Instask/nitely/pull/15",
      commentId: "100",
      commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-100",
      authorLogin: "alice",
      action: "rework" as const,
      priorRunId: "run-prev",
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        trigger,
      },
      {
        createRunId: () => "run-triggered",
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-triggered");
    store.close();

    expect(projectRun(events).trigger).toEqual(trigger);
    await expect(
      readFile(join(repo, ".nitely", "runs", "run-triggered", "run.json"), "utf8"),
    ).resolves.toContain('"type": "github-pr-comment"');
  });

  it("uses a provider store env overlay when constructing the default local backend", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "stored-glm.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "stored-glm" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "glm",
            prompt: "Implement with GLM.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const runtimeCommand = join(repo, "write-output-runtime.sh");
    await writeFile(
      runtimeCommand,
      "#!/bin/sh\nprintf 'done\\n' > \"$NITELY_ATTEMPT_DIR/implementation.md\"\n",
      "utf8",
    );
    await chmod(runtimeCommand, 0o755);
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({
        NITELY_GLM_API_KEY: "stored-glm-token",
        NITELY_GLM_COMMAND: runtimeCommand,
      }),
      listStatuses: async () => [],
    };
    const saved = {
      NITELY_GLM_API_KEY: process.env.NITELY_GLM_API_KEY,
      GLM_API_KEY: process.env.GLM_API_KEY,
      ZHIPUAI_API_KEY: process.env.ZHIPUAI_API_KEY,
      NITELY_GLM_COMMAND: process.env.NITELY_GLM_COMMAND,
    };
    delete process.env.NITELY_GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPUAI_API_KEY;
    delete process.env.NITELY_GLM_COMMAND;
    try {
      const result = await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
        },
        {
          createRunId: () => "run-stored-glm",
          providerStore,
        },
      );

      expect(result.runId).toBe("run-stored-glm");
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const projection = projectRun(store.list("run-stored-glm"));
      store.close();
      expect(projection).toMatchObject({
        status: "completed",
        completedStages: ["implement"],
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("does not resolve a provider store when an explicit backend is supplied", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "explicit-backend.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "explicit-backend" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf explicit",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const backend: ExecutionBackend = {
      createWorkspace: async ({ runId, worktreePath }) => ({ runId, path: worktreePath }),
      runAgent: async () => {
        throw new Error("unused");
      },
      runCommand: async () => ({ stdout: "explicit", stderr: "", exitCode: 0 }),
      commitAll: async () => ({ committed: false }),
    };
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("provider store should not be used");
      },
      resolveEnv: async () => {
        throw new Error("provider store should not be used");
      },
      listStatuses: async () => {
        throw new Error("provider store should not be used");
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
      },
      {
        createRunId: () => "run-explicit-backend",
        backend,
        providerStore,
      },
    );

    const stdout = await readFile(
      join(repo, ".nitely", "runs", "run-explicit-backend", "stages", "test", "1", "stdout.log"),
      "utf8",
    );
    expect(stdout).toBe("explicit");
  });

  it(
    "retries a failed command stage while budget remains and preserves each attempt directory",
    async () => {
      const repo = await createRepo();
      const flowPath = join(repo, "flows", "retry-command.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "retry-command" },
        spec: {
          maxAttempts: 2,
          stages: [
            {
              id: "test",
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
        {
          flowPath,
          repoPath: repo,
          inputs: {},
        },
        {
          createRunId: () => "run-retry-command",
        },
      );

      const runDirectory = join(repo, ".nitely", "runs", "run-retry-command");
      await expect(
        readFile(join(runDirectory, "stages", "test", "1", "stderr.log"), "utf8"),
      ).resolves.toBe("first-fail");
      await expect(
        readFile(join(runDirectory, "stages", "test", "2", "stdout.log"), "utf8"),
      ).resolves.toBe("second-pass");
      await expect(
        readFile(join(runDirectory, "stages", "test", "1", "output.md"), "utf8"),
      ).resolves.toContain("Exit code: 7");
      const firstAttemptBefore = await stat(join(runDirectory, "stages", "test", "1"));
      const firstStderrBefore = await readFile(
        join(runDirectory, "stages", "test", "1", "stderr.log"),
        "utf8",
      );
      const firstAttemptAfter = await stat(join(runDirectory, "stages", "test", "1"));
      const firstStderrAfter = await readFile(
        join(runDirectory, "stages", "test", "1", "stderr.log"),
        "utf8",
      );
      expect(firstAttemptAfter.mtimeMs).toBe(firstAttemptBefore.mtimeMs);
      expect(firstStderrAfter).toBe(firstStderrBefore);

      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list("run-retry-command");
      const projection = projectRun(events);
      store.close();
      const retryDecisionIndex = events.findIndex(
        (event) =>
          event.type === "orchestrator.decision" &&
          event.stageId === "test" &&
          event.attempt === 1,
      );
      const retryingIndex = events.findIndex(
        (event) => event.type === "stage.retrying",
      );

      expect(retryDecisionIndex).toBeGreaterThan(-1);
      expect(retryingIndex).toBeGreaterThan(retryDecisionIndex);
      expect(events[retryDecisionIndex]?.payload).toMatchObject({
        stageId: "test",
        stageType: "command",
        attempt: 1,
        maxAttempts: 2,
        action: "retry",
        reason:
          "command failed on attempt 1 of 2: command failed with exit code 7: if test -f marker; then printf second-pass; else printf first-fail >&2; touch marker; exit 7; fi\nfirst-fail",
        error:
          "command failed with exit code 7: if test -f marker; then printf second-pass; else printf first-fail >&2; touch marker; exit 7; fi\nfirst-fail",
      });
      expect(projection.orchestratorDecisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stageId: "test",
            stageType: "command",
            attempt: 1,
            maxAttempts: 2,
            action: "retry",
          }),
          expect.objectContaining({
            stageId: "test",
            stageType: "command",
            attempt: 2,
            maxAttempts: 2,
            action: "complete",
          }),
        ]),
      );
      const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
      expect(evidence).toContain("## Orchestrator Decisions");
      expect(evidence).toContain("- test attempt 1/2: retry - command failed");
      expect(evidence).toContain("- test attempt 2/2: complete - command completed on attempt 2");

      expect(projection).toMatchObject({
        status: "completed",
        stages: [
          {
            stageId: "test",
            status: "completed",
            attempts: [
              { attempt: 1, status: "failed" },
              { attempt: 2, status: "completed" },
            ],
          },
        ],
      });
    },
    10_000,
  );

  it("stops a repeatedly failing command stage after its attempt limit", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "retry-exhausted.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "retry-exhausted" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf always-fails >&2; exit 9",
            maxAttempts: 2,
            inputs: [],
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
          inputs: {},
        },
        {
          createRunId: () => "run-retry-exhausted",
        },
      ),
    ).rejects.toThrow(/command failed after 2 of 2 attempts/);

    const runDirectory = join(repo, ".nitely", "runs", "run-retry-exhausted");
    await expect(
      readFile(join(runDirectory, "stages", "test", "1", "stderr.log"), "utf8"),
    ).resolves.toBe("always-fails");
    await expect(
      readFile(join(runDirectory, "stages", "test", "2", "stderr.log"), "utf8"),
    ).resolves.toBe("always-fails");
    await expect(
      readFile(join(runDirectory, "stages", "test", "3", "stderr.log"), "utf8"),
    ).rejects.toThrow();

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-retry-exhausted"));
    store.close();

    expect(projection).toMatchObject({
      status: "failed",
      stages: [
        {
          stageId: "test",
          status: "failed",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "failed" },
          ],
        },
      ],
    });
  });

  it("includes previous failure context in an agent retry prompt", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "retry-agent.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "retry-agent" },
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
    const prompts: string[] = [];

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
      },
      {
        createRunId: () => "run-retry-agent",
        executeAgent: async ({ prompt, attemptDirectory, worktreePath }) => {
          prompts.push(prompt);
          if (prompts.length === 1) {
            throw new Error("agent chose the wrong approach");
          }
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        },
      },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Previous Failure Context");
    expect(prompts[1]).toContain("attempt 1 failed");
    expect(prompts[1]).toContain("agent chose the wrong approach");
    expect(prompts[1]).toContain("Do not repeat the failed approach");
  });

  it("fails deterministically before retrying when policy requests invalid rework", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "invalid-rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "invalid-rework" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf missing >&2; exit 5",
            inputs: [],
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
          inputs: {},
        },
        {
          createRunId: () => "run-invalid-rework",
          recommendRework: () => "unknown-artifact",
        },
      ),
    ).rejects.toThrow(/invalid rework target: unknown-artifact/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-invalid-rework");
    const projection = projectRun(events);
    store.close();

    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "test",
      stageType: "command",
      attempt: 1,
      maxAttempts: 2,
      action: "fail",
      reason: "invalid rework target: unknown-artifact",
    });
    expect(projection).toMatchObject({
      status: "failed",
      stages: [
        {
          stageId: "test",
          status: "failed",
          attempts: [{ attempt: 1, status: "failed" }],
        },
      ],
    });
  });

  it("records an escalation decision and fails without retrying", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "escalate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "escalate" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf needs-human >&2; exit 5",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-escalate",
          recommendOrchestration: () => ({
            action: "escalate",
            reason: "manual review requested",
          }),
        },
      ),
    ).rejects.toThrow(/^escalated: manual review requested/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-escalate");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "verify",
      stageType: "command",
      attempt: 1,
      maxAttempts: 2,
      action: "escalate",
      reason: "manual review requested",
      error:
        "command failed with exit code 5: printf needs-human >&2; exit 5\nneeds-human",
    });
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-escalate", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Orchestrator Decisions");
    expect(evidence).toContain(
      "- verify attempt 1/2: escalate - manual review requested",
    );
  });

  it("reruns the upstream producer when policy requests valid rework", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "valid-rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "valid-rework" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
            maxAttempts: 2,
          },
          {
            id: "test",
            type: "command",
            command: "grep fixed feature.txt",
            inputs: ["implementation"],
            outputs: ["test-report"],
            maxAttempts: 2,
          },
        ],
      },
    });
    const prompts: string[] = [];

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
      },
      {
        createRunId: () => "run-valid-rework",
        executeAgent: async ({ prompt, attemptDirectory, worktreePath }) => {
          prompts.push(prompt);
          await writeFile(
            join(worktreePath, "feature.txt"),
            prompts.length === 1 ? "broken\n" : "fixed\n",
            "utf8",
          );
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            prompts.length === 1 ? "broken\n" : "fixed\n",
            "utf8",
          );
        },
        recommendRework: ({ stage }) =>
          stage.id === "test" ? "implementation" : undefined,
      },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Previous Failure Context");
    expect(prompts[1]).toContain("downstream stage test requested rework");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-valid-rework");
    const projection = projectRun(events);
    store.close();

    const reworkDecisionIndex = events.findIndex(
      (event) =>
        event.type === "orchestrator.decision" &&
        (event.payload as { action?: string }).action === "rework",
    );
    const reworkRequestedIndex = events.findIndex(
      (event) => event.type === "stage.rework.requested",
    );
    expect(reworkDecisionIndex).toBeGreaterThan(-1);
    expect(reworkRequestedIndex).toBeGreaterThan(reworkDecisionIndex);
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "test",
          stageType: "command",
          attempt: 1,
          maxAttempts: 2,
          action: "rework",
          targetArtifact: "implementation",
        }),
      ]),
    );
    expect(projection).toMatchObject({
      status: "completed",
      completedStages: ["implement", "test"],
      stages: [
        {
          stageId: "implement",
          status: "completed",
          attempts: [
            { attempt: 1, status: "completed" },
            { attempt: 2, status: "completed" },
          ],
        },
        {
          stageId: "test",
          status: "completed",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "completed" },
          ],
        },
      ],
    });
  });

  it("records a final fail decision when a legal rework target has exhausted attempts", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "rework-target-exhausted.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework-target-exhausted" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
            maxAttempts: 1,
          },
          {
            id: "test",
            type: "command",
            command: "grep fixed feature.txt",
            inputs: ["implementation"],
            outputs: ["test-report"],
            maxAttempts: 2,
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-rework-target-exhausted",
          executeAgent: async ({ attemptDirectory, worktreePath }) => {
            await writeFile(join(worktreePath, "feature.txt"), "broken\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "broken\n", "utf8");
          },
          recommendRework: ({ stage }) =>
            stage.id === "test" ? "implementation" : undefined,
        },
      ),
    ).rejects.toThrow(/rework target implementation has exhausted attempts/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-rework-target-exhausted");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).not.toContain(
      "stage.rework.requested",
    );
    expect(projection.orchestratorDecisions.at(-2)).toMatchObject({
      stageId: "test",
      action: "rework",
      targetArtifact: "implementation",
    });
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "test",
      stageType: "command",
      attempt: 1,
      maxAttempts: 2,
      action: "fail",
      reason: "rework target implementation has exhausted attempts",
    });
  });

  it("rejects unsafe external input artifact IDs before snapshotting", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "unsafe-input.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "unsafe-input" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
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
          inputs: {
            "../escape": { connector: "local-file", uri: "specs/change.md" },
          },
        },
        {
          createRunId: () => "run-unsafe-input",
        },
      ),
    ).rejects.toThrow(/invalid input artifact id/);
  });

  it("fails excluded local inputs before snapshotting their contents", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".env"), "OPENAI_API_KEY=sk-secret-from-env-file", "utf8");
    const flowPath = join(repo, "flows", "excluded-input.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "excluded-input" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
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
          inputs: {
            secret: { connector: "local-file", uri: ".env" },
          },
        },
        {
          createRunId: () => "run-excluded-context",
        },
      ),
    ).rejects.toThrow(/context policy excluded local input: \.env/);

    const runDirectory = join(repo, ".nitely", "runs", "run-excluded-context");
    await expect(readFile(join(runDirectory, "inputs", "secret", "content"), "utf8"))
      .rejects.toThrow();
    const manifest = JSON.parse(
      await readFile(join(runDirectory, "context-manifest.json"), "utf8"),
    );
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        id: "secret",
        connector: "local-file",
        sourceUri: ".env",
        policy: expect.objectContaining({
          decision: "excluded",
          matchedPattern: ".env",
        }),
      }),
    ]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-excluded-context");
    store.close();
    expect(events.map((event) => event.type)).toContain("context.excluded");
    expect(JSON.stringify(events)).not.toContain("sk-secret-from-env-file");
  });

  it("omits warn-only excluded local inputs from snapshots and prompts", async () => {
    const repo = await createRepo();
    await writeJson(join(repo, "nitely.context.json"), {
      version: 1,
      warnOnly: true,
    });
    await writeFile(join(repo, ".env"), "OPENAI_API_KEY=sk-warned-file-secret", "utf8");
    const flowPath = join(repo, "flows", "warned-input.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "warned-input" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Use the available input.",
            inputs: ["secret"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let prompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          secret: { connector: "local-file", uri: ".env" },
        },
      },
      {
        createRunId: () => "run-warned-context",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-warned-context");
    await expect(readFile(join(runDirectory, "inputs", "secret", "content"), "utf8"))
      .rejects.toThrow();
    expect(prompt).toContain("## Input: secret");
    expect(prompt).toContain("Omitted by context policy");
    expect(prompt).toContain("matched exclude pattern .env");
    expect(prompt).not.toContain("sk-warned-file-secret");
    expect(prompt).not.toContain("OPENAI_API_KEY");

    const manifest = JSON.parse(
      await readFile(join(runDirectory, "context-manifest.json"), "utf8"),
    );
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "secret",
          connector: "local-file",
          sourceUri: ".env",
          policy: expect.objectContaining({
            decision: "warned",
            matchedPattern: ".env",
          }),
        }),
      ]),
    );
    const warnedEntry = manifest.entries.find(
      (entry: { id?: string }) => entry.id === "secret",
    );
    expect(warnedEntry).not.toHaveProperty("runRelativePath");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-warned-context");
    store.close();
    expect(events.map((event) => event.type)).toContain("context.warned");
    expect(JSON.stringify(events)).not.toContain("sk-warned-file-secret");
  });

  it("redacts secret-bearing warn-only manifest metadata before persistence", async () => {
    const previousSecret = process.env.NITELY_MANIFEST_SECRET_TOKEN;
    process.env.NITELY_MANIFEST_SECRET_TOKEN = "manifest-secret-value";
    try {
      const repo = await createRepo();
      await mkdir(join(repo, "secrets"), { recursive: true });
      await writeJson(join(repo, "nitely.context.json"), {
        version: 1,
        exclude: ["secrets/*manifest-secret-value*"],
        warnOnly: true,
      });
      await writeFile(
        join(repo, "secrets", "manifest-secret-value.txt"),
        "OPENAI_API_KEY=sk-warned-manifest-secret",
        "utf8",
      );
      const flowPath = join(repo, "flows", "warned-manifest-redaction.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "warned-manifest-redaction" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Use the available input.",
              inputs: ["secret"],
              outputs: ["implementation"],
            },
          ],
        },
      });

      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            secret: {
              connector: "local-file",
              uri: "secrets/manifest-secret-value.txt",
            },
          },
        },
        {
          createRunId: () => "run-warned-manifest-redaction",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          },
        },
      );

      const runDirectory = join(repo, ".nitely", "runs", "run-warned-manifest-redaction");
      await expect(readFile(join(runDirectory, "inputs", "secret", "content"), "utf8"))
        .rejects.toThrow();
      const manifestText = await readFile(
        join(runDirectory, "context-manifest.json"),
        "utf8",
      );
      expect(manifestText).not.toContain("manifest-secret-value");
      expect(manifestText).toContain("[REDACTED]");

      const manifest = JSON.parse(manifestText);
      expect(manifest.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "secret",
            connector: "local-file",
            sourceUri: "secrets/[REDACTED].txt",
            filename: "[REDACTED].txt",
            policy: expect.objectContaining({
              decision: "warned",
              reason: "matched exclude pattern secrets/*[REDACTED]*",
              matchedPattern: "secrets/*[REDACTED]*",
            }),
          }),
        ]),
      );
      const warnedEntry = manifest.entries.find(
        (entry: { id?: string }) => entry.id === "secret",
      );
      expect(warnedEntry).not.toHaveProperty("runRelativePath");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_MANIFEST_SECRET_TOKEN;
      } else {
        process.env.NITELY_MANIFEST_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("writes context manifest entries for allowed inputs and generated artifacts", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "manifest.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "manifest" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-context-manifest",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        },
      },
    );

    const manifest = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-context-manifest", "context-manifest.json"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      version: 1,
      runId: "run-context-manifest",
      entries: expect.arrayContaining([
        expect.objectContaining({
          id: "spec",
          kind: "external-input",
          connector: "local-file",
          sourceUri: "specs/change.md",
          runRelativePath: "inputs/spec/content",
          policy: { decision: "allowed" },
        }),
        expect.objectContaining({
          id: "implementation",
          kind: "generated-artifact",
          connector: "generated",
          runRelativePath: "stages/implement/1/implementation.md",
          policy: { decision: "allowed" },
        }),
      ]),
    });
  });

  it("keeps distinct manifest entries whose raw ids redact to the same display id", async () => {
    const previousA = process.env.NITELY_FIRST_MANIFEST_SECRET;
    const previousB = process.env.NITELY_SECOND_MANIFEST_SECRET;
    process.env.NITELY_FIRST_MANIFEST_SECRET = "secretvaluea";
    process.env.NITELY_SECOND_MANIFEST_SECRET = "secretvalueb";
    try {
      const repo = await createRepo();
      await mkdir(join(repo, "specs"), { recursive: true });
      await writeFile(join(repo, "specs", "a.md"), "A", "utf8");
      await writeFile(join(repo, "specs", "b.md"), "B", "utf8");
      const flowPath = join(repo, "flows", "manifest-collision.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "manifest-collision" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Use the inputs.",
              inputs: ["input-secretvaluea", "input-secretvalueb"],
              outputs: ["implementation"],
            },
          ],
        },
      });

      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            "input-secretvaluea": { connector: "local-file", uri: "specs/a.md" },
            "input-secretvalueb": { connector: "local-file", uri: "specs/b.md" },
          },
        },
        {
          createRunId: () => "run-manifest-collision",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          },
        },
      );

      const manifestText = await readFile(
        join(repo, ".nitely", "runs", "run-manifest-collision", "context-manifest.json"),
        "utf8",
      );
      expect(manifestText).not.toContain("secretvaluea");
      expect(manifestText).not.toContain("secretvalueb");
      expect(manifestText).toContain("[REDACTED]");

      const manifest = JSON.parse(manifestText);
      const externalInputs = manifest.entries.filter(
        (entry: { kind?: string }) => entry.kind === "external-input",
      );
      expect(externalInputs).toHaveLength(2);
      expect(externalInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "input-[REDACTED]",
            connector: "local-file",
            sourceUri: "specs/a.md",
            policy: { decision: "allowed" },
          }),
          expect.objectContaining({
            id: "input-[REDACTED]",
            connector: "local-file",
            sourceUri: "specs/b.md",
            policy: { decision: "allowed" },
          }),
        ]),
      );
    } finally {
      if (previousA === undefined) {
        delete process.env.NITELY_FIRST_MANIFEST_SECRET;
      } else {
        process.env.NITELY_FIRST_MANIFEST_SECRET = previousA;
      }
      if (previousB === undefined) {
        delete process.env.NITELY_SECOND_MANIFEST_SECRET;
      } else {
        process.env.NITELY_SECOND_MANIFEST_SECRET = previousB;
      }
    }
  });

  it("redacts secrets from prompts, command logs, events, evidence, and publish bodies", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(
      join(repo, "specs", "change.md"),
      "Use token=runtime-secret-value and OPENAI_API_KEY=sk-runtime-secret-value",
      "utf8",
    );
    const flowPath = join(repo, "flows", "redacted-runtime.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "redacted-runtime" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement with Authorization: Bearer prompt-secret-value",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "test",
            type: "command",
            command: "echo api_key=command-secret-value",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "test-report", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    let publishedBody = "";
    const backend: ExecutionBackend = {
      createWorkspace: async ({ repoPath, branchName, runId, worktreePath }) => {
        await git(repoPath, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      runAgent: async (workspace, input) => {
        await writeFile(join(workspace.path ?? "", "feature.txt"), "implemented\n", "utf8");
        await writeFile(
          join(input.attemptDirectory, "implementation.md"),
          "Generated password=artifact-secret-value",
          "utf8",
        );
        await writeFile(
          join(input.attemptDirectory, "pr-title.md"),
          "Publish password=artifact-secret-value",
          "utf8",
        );
        return { stdout: "", stderr: "" };
      },
      runCommand: async () => ({
        stdout: "stdout has ghp_1234567890abcdefghijklmnopqrstuv",
        stderr: "stderr has sk-abcdefghijklmnopqrstuvwxyz",
        exitCode: 0,
      }),
      commitAll: async (workspace, message) => {
        await git(workspace.path ?? "", ["add", "."]);
        await git(workspace.path ?? "", ["commit", "-m", message]);
        return { committed: true };
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-redacted-runtime",
        backend,
        publishChange: async (input) => {
          publishedBody = input.body;
          return {
            url: "https://example.test/pr/redacted-runtime",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-redacted-runtime");
    const prompt = await readFile(
      join(runDirectory, "stages", "implement", "1", "prompt.md"),
      "utf8",
    );
    const stdout = await readFile(
      join(runDirectory, "stages", "test", "1", "stdout.log"),
      "utf8",
    );
    const stderr = await readFile(
      join(runDirectory, "stages", "test", "1", "stderr.log"),
      "utf8",
    );
    const output = await readFile(
      join(runDirectory, "stages", "test", "1", "output.md"),
      "utf8",
    );
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-redacted-runtime");
    store.close();

    for (const surface of [prompt, stdout, stderr, output, evidence, publishedBody, JSON.stringify(events)]) {
      expect(surface).toContain("[REDACTED]");
      expect(surface).not.toContain("runtime-secret-value");
      expect(surface).not.toContain("sk-runtime-secret-value");
      expect(surface).not.toContain("prompt-secret-value");
      expect(surface).not.toContain("ghp_1234567890");
      expect(surface).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(surface).not.toContain("artifact-secret-value");
    }
  });

  it("resumes an interrupted stage with a new attempt", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, ["worktree", "add", "-b", "nitely/run-resume", worktreePath, "HEAD"]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume",
      type: "run.created",
      payload: {
        flowName: "resume",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    const interrupted = projectRun(seedStore.list("run-resume"));
    seedStore.close();
    expect(interrupted.status).toBe("interrupted");

    const result = await resumeRun(
      {
        repoPath: repo,
        runId: "run-resume",
      },
      {
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          expect(attemptDirectory).toBe(
            join(repo, ".nitely", "runs", "run-resume", "stages", "implement", "2"),
          );
          await writeFile(join(worktreePath, "feature.txt"), "resumed\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "resumed\n", "utf8");
        },
      },
    );

    expect(result.runId).toBe("run-resume");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-resume"));
    store.close();

    expect(projection).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "implement",
          status: "completed",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "completed" },
          ],
        },
      ],
    });
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "implement",
      stageType: "agent",
      attempt: 2,
      maxAttempts: 1,
      action: "complete",
    });
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Orchestrator Decisions");
    expect(evidence).toContain(
      "- implement attempt 2/1: complete - agent completed on attempt 2",
    );
  });

  it("selects a concrete runtime candidate when resuming an interrupted runtimes agent stage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-runtime-candidates.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-runtime-candidates");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-runtime-candidates" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-runtime-candidates",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-runtime-candidates",
      type: "run.created",
      payload: {
        flowName: "resume-runtime-candidates",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-runtime-candidates",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-runtime-candidates",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-runtime-candidates",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.close();

    const runtimes: string[] = [];
    await resumeRun(
      { repoPath: repo, runId: "run-resume-runtime-candidates" },
      {
        backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
          runtimes.push(stage.runtime ?? "");
          await writeFile(join(attemptDirectory, "implementation.md"), "resumed\n", "utf8");
          return { stdout: "resumed\n", stderr: "" };
        }),
      },
    );

    expect(runtimes).toEqual(["claude"]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-runtime-candidates");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toContain("stage.runtime.selected");
    expect(projection).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "implement",
          status: "completed",
          attempts: [
            { attempt: 1, status: "failed" },
            {
              attempt: 2,
              status: "completed",
              runtime: "claude",
              runtimeCandidateIndex: 0,
              runtimeCandidateCount: 2,
            },
          ],
        },
      ],
    });
  });

  it("resumes a blocked stage with a fresh attempt and reuses upstream artifacts", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-blocked.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-blocked" },
      spec: {
        stages: [
          {
            id: "prepare",
            type: "agent",
            runtime: "mock",
            prompt: "Prepare context.",
            inputs: [],
            outputs: ["prep"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement using prep.",
            inputs: ["prep"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    let initialPrepareCalls = 0;
    let initialImplementCalls = 0;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-resume-blocked",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            if (input.stage.id === "prepare") {
              initialPrepareCalls += 1;
              await writeFile(join(input.attemptDirectory, "prep.md"), "prepared context\n", "utf8");
              return { stdout: "prepared\n", stderr: "" };
            }
            initialImplementCalls += 1;
            throw Object.assign(new Error("codex exited with code 1"), {
              stderr: "usage limit reached; try again in 10 minutes\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    expect(initialPrepareCalls).toBe(1);
    expect(initialImplementCalls).toBe(1);

    let resumedPrompt = "";
    let resumedPrepareCalls = 0;
    await resumeRun(
      { repoPath: repo, runId: "run-resume-blocked" },
      {
        backend: {
          async createWorkspace() {
            throw new Error("resume should reuse the existing workspace");
          },
          async runAgent(_workspace, input) {
            if (input.stage.id === "prepare") {
              resumedPrepareCalls += 1;
              throw new Error("resume should not rerun completed upstream stages");
            }
            resumedPrompt = input.prompt;
            expect(input.attemptDirectory).toBe(
              join(repo, ".nitely", "runs", "run-resume-blocked", "stages", "implement", "2"),
            );
            await writeFile(join(input.attemptDirectory, "implementation.md"), "resumed\n", "utf8");
            return { stdout: "resumed\n", stderr: "" };
          },
          async runCommand() {
            throw new Error("command should not run");
          },
          async commitAll() {
            return { committed: false };
          },
        },
      },
    );

    expect(resumedPrepareCalls).toBe(0);
    expect(resumedPrompt).toContain("Artifact: prep");
    expect(resumedPrompt).toContain("prepared context");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-resume-blocked"));
    store.close();
    expect(projection.status).toBe("completed");
    expect(projection.completedStages).toEqual(["prepare", "implement"]);
    expect(projection.stages.find((stage) => stage.stageId === "implement")).toMatchObject({
      status: "completed",
      attempts: [
        { attempt: 1, status: "blocked" },
        { attempt: 2, status: "completed" },
      ],
    });
  });

  it("records an orchestrator fail decision before a resumed stage fails the run", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-command-fail.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-command-fail");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-command-fail" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "exit 4",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-command-fail",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "test", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-command-fail",
      type: "run.created",
      payload: {
        flowName: "resume-command-fail",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-command-fail",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-command-fail",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-command-fail",
      stageId: "test",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "test", "1"),
      },
    });
    seedStore.close();

    await expect(
      resumeRun(
        { repoPath: repo, runId: "run-resume-command-fail" },
        {
          backend: {
            async createWorkspace() {
              throw new Error("resume should reuse the existing workspace");
            },
            async runAgent() {
              throw new Error("command resume should not run an agent");
            },
            async runCommand() {
              return { stdout: "", stderr: "still broken", exitCode: 4 };
            },
            async commitAll() {
              return { committed: false };
            },
          },
        },
      ),
    ).rejects.toThrow(/command failed with exit code 4/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-command-fail");
    const projection = projectRun(events);
    store.close();
    const decisionIndex = events.findIndex(
      (event) =>
        event.type === "orchestrator.decision" &&
        event.stageId === "test" &&
        event.attempt === 2,
    );
    const runFailedIndex = events.findIndex((event) => event.type === "run.failed");

    expect(decisionIndex).toBeGreaterThan(-1);
    expect(runFailedIndex).toBeGreaterThan(decisionIndex);
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "test",
      stageType: "command",
      attempt: 2,
      maxAttempts: 1,
      action: "fail",
    });
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(
      "command failed after 2 of 1 attempts: command failed with exit code 4: exit 4",
    );
    expect(evidence).toContain("still broken");
  });

  it("loads skills when resuming an interrupted agent stage", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "tdd",
      "---\nname: tdd\ndescription: Resume with TDD\n---\nKeep tests first.\n",
    );
    const flowPath = join(repo, "flows", "resume-skills.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-skills");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-skills" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            skills: ["tdd"],
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, ["worktree", "add", "-b", "nitely/run-resume-skills", worktreePath, "HEAD"]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-skills",
      type: "run.created",
      payload: {
        flowName: "resume-skills",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-skills",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-skills",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-skills",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.close();

    let prompt = "";
    await resumeRun(
      {
        repoPath: repo,
        runId: "run-resume-skills",
      },
      {
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("### Skill: tdd");
    expect(prompt).toContain("Keep tests first.");
  });

  it("redacts resumed completion metadata in run files and events", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-redaction.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-redaction");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-redaction" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-redaction",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-redaction",
      type: "run.created",
      payload: {
        flowName: "resume-redaction",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-redaction",
        baseBranch: "master",
        trigger: {
          type: "github-pr-comment",
          provider: "github",
          owner: "Instask",
          repository: "nitely",
          prNumber: 58,
          prUrl: "https://github.com/Instask/nitely/pull/58?token=resume-secret-value",
          commentId: "comment-token=resume-secret-value",
          commentUrl:
            "https://github.com/Instask/nitely/pull/58#issuecomment-token=resume-secret-value",
          authorLogin: "reviewer",
          action: "rework",
        },
      },
    });
    seedStore.append({
      runId: "run-resume-redaction",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-redaction",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.close();

    await resumeRun(
      { repoPath: repo, runId: "run-resume-redaction" },
      {
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const runJson = await readFile(join(runDirectory, "run.json"), "utf8");
    expect(runJson).toContain("[REDACTED]");
    expect(runJson).not.toContain("resume-secret-value");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-redaction");
    store.close();
    const completed = events.find((event) => event.type === "run.completed");
    expect(JSON.stringify(completed?.payload)).toContain("[REDACTED]");
    expect(JSON.stringify(completed?.payload)).not.toContain("resume-secret-value");
  });

  it("does not consume an interrupted stage when resume preparation fails", async () => {
    const repo = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-missing-flow");
    const worktreePath = join(runDirectory, "worktree");
    const missingFlowPath = join(repo, "flows", "missing.json");
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-missing-flow",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-missing-flow",
      type: "run.created",
      payload: {
        flowName: "missing",
        flowPath: missingFlowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-missing-flow",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-missing-flow",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-missing-flow",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.close();

    await expect(
      resumeRun({ repoPath: repo, runId: "run-resume-missing-flow" }),
    ).rejects.toThrow();

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-resume-missing-flow"));
    store.close();

    expect(projection).toMatchObject({
      status: "interrupted",
      stages: [
        {
          stageId: "implement",
          status: "interrupted",
          attempts: [{ attempt: 1, status: "interrupted" }],
        },
      ],
    });
  });

  it("rehydrates agent-produced title artifacts before resuming publish", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "tdd",
      "---\nname: tdd\ndescription: Resume evidence skill\n---\nKeep tests first.\n",
    );
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "resume-publish-title.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-title");
    const worktreePath = join(runDirectory, "worktree");
    const implementAttemptDirectory = join(runDirectory, "stages", "implement", "1");
    const publishAttemptDirectory = join(runDirectory, "stages", "publish", "1");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-publish-title" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            skills: ["tdd"],
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-title",
      worktreePath,
      "HEAD",
    ]);
    await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
    await mkdir(implementAttemptDirectory, { recursive: true });
    await mkdir(publishAttemptDirectory, { recursive: true });
    await writeFile(
      join(implementAttemptDirectory, "implementation.md"),
      "Resume implementation\n",
      "utf8",
    );
    await writeFile(
      join(implementAttemptDirectory, "pr-title.md"),
      "Resume with custom title\n",
      "utf8",
    );
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-resume-title",
      artifacts: [
        {
          id: "pr-title",
          name: "Existing PR title",
          type: "title",
          description: "Existing title metadata",
          producer: "implement",
          mediaType: "text/markdown",
          schema: { maxLength: 72 },
          version: "1",
          path: "stages/implement/1/pr-title.md",
          sourceUri: "stages/implement/1/pr-title.md",
          filename: "pr-title.md",
          createdAt: "2026-06-19T12:00:00.000Z",
        },
      ],
    });

    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-title",
      type: "run.created",
      payload: {
        flowName: "resume-publish-title",
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        branchName: "nitely/run-resume-title",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-title",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-title",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: implementAttemptDirectory },
    });
    seedStore.append({
      runId: "run-resume-title",
      stageId: "implement",
      attempt: 1,
      type: "stage.skills.loaded",
      payload: {
        skills: [
          {
            id: "tdd",
            name: "tdd",
            description: "Resume evidence skill",
            sourcePath: ".nitely/skills/tdd/SKILL.md",
            contentHash: "abc123",
            resources: [],
          },
        ],
      },
    });
    seedStore.append({
      runId: "run-resume-title",
      stageId: "implement",
      attempt: 1,
      type: "artifact.published",
      payload: {
        artifact: {
          id: "pr-title",
          name: "Existing PR title",
          type: "title",
          description: "Existing title metadata",
          producer: "implement",
          mediaType: "text/markdown",
          schema: { maxLength: 72 },
          version: "1",
          path: "stages/implement/1/pr-title.md",
          sourceUri: "stages/implement/1/pr-title.md",
          filename: "pr-title.md",
          createdAt: "2026-06-19T12:00:00.000Z",
        },
      },
      createdAt: "2026-06-19T12:00:00.000Z",
    });
    seedStore.append({
      runId: "run-resume-title",
      stageId: "implement",
      attempt: 1,
      type: "stage.completed",
      payload: { outputs: ["implementation", "pr-title"] },
    });
    seedStore.append({
      runId: "run-resume-title",
      stageId: "publish",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: publishAttemptDirectory },
    });
    seedStore.close();

    let publishTitle = "";
    let commitMessage = "";
    const backend: ExecutionBackend = {
      async createWorkspace() {
        throw new Error("resume should reuse the existing workspace");
      },
      async runAgent() {
        throw new Error("publish resume should not run an agent");
      },
      async runCommand() {
        throw new Error("publish resume should not run a command");
      },
      async commitAll(_workspace, message) {
        commitMessage = message;
        return { committed: true };
      },
    };
    const result = await resumeRun(
      { repoPath: repo, runId: "run-resume-title" },
      {
        backend,
        publishChange: async (input) => {
          publishTitle = input.title;
          expect(input.body).toContain("Source: artifact pr-title");
          expect(input.body).toContain("## Loaded Skills");
          expect(input.body).toContain(
            "- implement / tdd: .nitely/skills/tdd/SKILL.md (sha256:abc123)",
          );
          expect(input.body).toContain("Description: Resume evidence skill");
          return {
            url: "https://example.test/pr/resume-title",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    expect(publishTitle).toBe("Resume with custom title");
    expect(result.worktreePath).toBe(worktreePath);
    expect(commitMessage).toBe("feat: Resume with custom title");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-title");
    store.close();
    const artifactEvents = events.filter(
      (event) =>
        event.type === "artifact.published" &&
        (event.payload as { artifact?: { id?: string; producer?: string } }).artifact
          ?.id === "pr-title" &&
        (event.payload as { artifact?: { id?: string; producer?: string } }).artifact
          ?.producer === "implement",
    );
    expect(artifactEvents).toHaveLength(1);
    expect(projectRun(events).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pr-title",
          producer: "implement",
          name: "Existing PR title",
          description: "Existing title metadata",
          createdAt: "2026-06-19T12:00:00.000Z",
        }),
        expect.objectContaining({
          id: "implementation",
          producer: "implement",
          path: "stages/implement/1/implementation.md",
        }),
      ]),
    );
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(
      "- publish attempt 2/1: complete - publish-change completed on attempt 2",
    );
    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pr-title",
          producer: "implement",
          name: "Existing PR title",
          description: "Existing title metadata",
          createdAt: "2026-06-19T12:00:00.000Z",
        }),
      ]),
    );
  });

  it("refreshes persisted evidence after a resumed update-change completes", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-update-evidence.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-update-evidence");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-update-evidence" },
      spec: {
        stages: [
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: [],
            outputs: ["change-request"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-update-evidence",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "update", "1"), { recursive: true });
    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 77,
      url: "https://github.com/Instask/nitely/pull/77",
      baseBranch: "master",
      headBranch: "nitely/run-resume-update-evidence",
      headSha: "a".repeat(40),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-update-evidence",
      type: "run.created",
      payload: {
        flowName: "resume-update-evidence",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-update-evidence",
        baseBranch: "master",
        changeRequestTarget: {
          provider: "github",
          target: String(target.number),
          resolved: target,
        },
      },
    });
    seedStore.append({
      runId: "run-resume-update-evidence",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-update-evidence",
      stageId: "update",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "update", "1"),
      },
    });
    seedStore.close();

    await resumeRun(
      { repoPath: repo, runId: "run-resume-update-evidence" },
      {
        scmProvider: localReworkProvider({ repo, target }),
      },
    );

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(
      "- update attempt 2/1: complete - update-change completed on attempt 2",
    );
  });

  it("publishes one compatibility artifact event when legacy resume has no durable artifact", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "resume-legacy-artifact.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-legacy-artifact");
    const worktreePath = join(runDirectory, "worktree");
    const implementAttemptDirectory = join(runDirectory, "stages", "implement", "1");
    const publishAttemptDirectory = join(runDirectory, "stages", "publish", "1");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-legacy-artifact" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: [
              {
                id: "pr-title",
                name: "PR title",
                type: "title",
                mediaType: "text/markdown",
              },
            ],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-legacy-artifact",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(implementAttemptDirectory, { recursive: true });
    await mkdir(publishAttemptDirectory, { recursive: true });
    await writeFile(join(implementAttemptDirectory, "pr-title.md"), "Legacy title\n", "utf8");

    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-legacy-artifact",
      type: "run.created",
      payload: {
        flowName: "resume-legacy-artifact",
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        branchName: "nitely/run-resume-legacy-artifact",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-legacy-artifact",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-legacy-artifact",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: implementAttemptDirectory },
    });
    seedStore.append({
      runId: "run-resume-legacy-artifact",
      stageId: "implement",
      attempt: 1,
      type: "stage.completed",
      payload: { outputs: ["pr-title"] },
    });
    seedStore.append({
      runId: "run-resume-legacy-artifact",
      stageId: "publish",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: publishAttemptDirectory },
    });
    seedStore.close();

    await resumeRun(
      { repoPath: repo, runId: "run-resume-legacy-artifact" },
      {
        backend: {
          async createWorkspace() {
            throw new Error("resume should reuse the existing workspace");
          },
          async runAgent() {
            throw new Error("publish resume should not run an agent");
          },
          async runCommand() {
            throw new Error("publish resume should not run a command");
          },
          async commitAll() {
            return { committed: true };
          },
        },
        publishChange: async (input) => {
          expect(input.title).toBe("Legacy title");
          expect(input.body).toContain("Source: artifact pr-title");
          return {
            url: "https://example.test/pr/resume-legacy-artifact",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-legacy-artifact");
    store.close();
    const artifactEvents = events.filter(
      (event) => event.type === "artifact.published",
    );
    expect(artifactEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            artifact: expect.objectContaining({
              id: "pr-title",
              producer: "implement",
              name: "PR title",
              mediaType: "text/markdown",
            }),
          }),
        }),
      ]),
    );
    expect(projectRun(events).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pr-title",
          producer: "implement",
          name: "PR title",
          mediaType: "text/markdown",
        }),
      ]),
    );
  });

  it("publishes through the configured SCM provider and persists change request metadata", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "provider-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "provider-publish" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
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
    const changeRequest: ChangeRequest = {
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/8",
      number: 8,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-provider",
      draft: true,
      outcome: "reused",
    };
    let publishInput:
      | Parameters<ScmProvider["publishChange"]>[0]
      | undefined;
    const scmProvider: ScmProvider = {
      type: "github",
      publishChange: async (input) => {
        publishInput = input;
        return changeRequest;
      },
    };

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-provider",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        },
        scmProvider,
      },
    );

    expect(publishInput).toMatchObject({
      repoPath: repo,
      worktreePath: result.worktreePath,
      remoteName: "origin",
      baseBranch: "master",
      headBranch: "nitely/run-provider",
      title: "Nitely: provider-publish",
    });
    expect(publishInput?.body).toContain("Nitely Run Evidence: provider-publish");
    expect(publishInput?.body).toContain("- implement");
    expect(result.changeRequestUrl).toBe(changeRequest.url);
    expect(result.changeRequest).toEqual(changeRequest);

    const runJson = JSON.parse(
      await readFile(join(repo, ".nitely", "runs", "run-provider", "run.json"), "utf8"),
    );
    expect(runJson.changeRequest).toEqual(changeRequest);
    const changeRequestArtifact = await readFile(
      join(repo, ".nitely", "runs", "run-provider", "stages", "publish", "1", "change-request.md"),
      "utf8",
    );
    expect(changeRequestArtifact).toContain("Change outcome: reused");
  });

  it("uses an agent-produced title artifact when publishing a change request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create billing dashboard", "utf8");
    const flowPath = join(repo, "flows", "provider-publish-title.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "provider-publish-title" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let publishInput: Parameters<NonNullable<ScmProvider["publishChange"]>>[0] | undefined;
    const scmProvider: ScmProvider = {
      type: "github",
      publishChange: async (input) => {
        publishInput = input;
        return {
          provider: "github",
          url: "https://github.com/Instask/nitely/pull/33",
          number: 33,
          owner: "Instask",
          repository: "nitely",
          baseBranch: "master",
          headBranch: "nitely/run-title",
          draft: true,
        };
      },
    };

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-title",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "pr-title.md"), "Add billing dashboard\n", "utf8");
        },
        scmProvider,
      },
    );

    expect(publishInput?.title).toBe("Add billing dashboard");
    expect(publishInput?.body).toContain("## Change Title");
    expect(publishInput?.body).toContain("Title: Add billing dashboard");
    expect(publishInput?.body).toContain("Source: artifact pr-title");
    const { stdout: commitMessage } = await git(result.worktreePath, [
      "log",
      "-1",
      "--pretty=%B",
    ]);
    expect(commitMessage.trim()).toBe("feat: Add billing dashboard");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-title");
    store.close();
    expect(events.find((event) => event.type === "change.published")?.payload).toMatchObject({
      title: {
        title: "Add billing dashboard",
        source: "artifact",
        artifactId: "pr-title",
      },
    });
  });

  it("tells explicit backends where real agents should write declared text outputs", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create billing dashboard", "utf8");
    const flowPath = join(repo, "flows", "backend-title-contract.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "backend-title-contract" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let prompt = "";
    let attemptDirectory = "";
    let publishTitle = "";
    const backend: ExecutionBackend = {
      createWorkspace: async ({ repoPath, branchName, runId, worktreePath }) => {
        await git(repoPath, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      runAgent: async (workspace, input) => {
        prompt = input.prompt;
        attemptDirectory = input.attemptDirectory;
        await writeFile(join(workspace.path ?? "", "feature.txt"), "implemented\n", "utf8");
        await writeFile(join(input.attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        await writeFile(join(input.attemptDirectory, "pr-title.txt"), "Add billing dashboard\n", "utf8");
        return { stdout: "", stderr: "" };
      },
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      commitAll: async (workspace, message) => {
        await git(workspace.path ?? "", ["add", "."]);
        await git(workspace.path ?? "", ["commit", "-m", message]);
        return { committed: true };
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-backend-title-contract",
        backend,
        publishChange: async (input) => {
          publishTitle = input.title;
          return {
            url: "https://example.test/pr/backend-title-contract",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    const expectedAttemptDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run-backend-title-contract",
      "stages",
      "implement",
      "1",
    );
    expect(attemptDirectory).toBe(expectedAttemptDirectory);
    expect(prompt).toContain("## Output Files");
    expect(prompt).toContain(`Write each required output artifact to:\n${expectedAttemptDirectory}`);
    expect(prompt).toContain("- implementation.md or implementation.txt");
    expect(prompt).toContain("- pr-title.md or pr-title.txt");
    expect(publishTitle).toBe("Add billing dashboard");
  });

  it("falls back to the flow-name title when publishing without a title artifact input", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "fallback-publish-title.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "fallback-publish-title" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
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

    let publishTitle = "";
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-title-fallback",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        },
        publishChange: async (input) => {
          publishTitle = input.title;
          expect(input.body).toContain("Source: fallback");
          return {
            url: "https://example.test/pr/fallback",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    expect(publishTitle).toBe("Nitely: fallback-publish-title");
    const { stdout: commitMessage } = await git(result.worktreePath, [
      "log",
      "-1",
      "--pretty=%B",
    ]);
    expect(commitMessage.trim()).toBe("feat: fallback-publish-title");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-title-fallback");
    store.close();
    expect(events.find((event) => event.type === "change.published")?.payload).toMatchObject({
      title: {
        title: "Nitely: fallback-publish-title",
        source: "fallback",
      },
    });
  });

  it("sanitizes multi-line and overlong title artifacts before publishing", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "sanitize-title.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "sanitize-title" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const longTail = "x".repeat(160);

    let publishTitle = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
      },
      {
        createRunId: () => "run-title-sanitize",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
          await writeFile(
            join(attemptDirectory, "pr-title.md"),
            `# Add\n\n\tbetter    title ${longTail}\nsecond line\n`,
            "utf8",
          );
        },
        publishChange: async (input) => {
          publishTitle = input.title;
          return {
            url: "https://example.test/pr/sanitize",
            evidencePath: input.evidencePath,
          };
        },
      },
    );

    expect(publishTitle).toHaveLength(120);
    expect(publishTitle).toBe(`Add better title ${"x".repeat(103)}`);
    expect(publishTitle).not.toMatch(/\s{2,}|\r|\n|\t|^#/);
  });

  it("checks out a rework run from an existing pull request branch and updates that pull request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Rework feature.txt", "utf8");
    await git(repo, ["checkout", "-b", "nitely/pr-22"]);
    await writeFile(join(repo, "feature.txt"), "previous\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);

    const flowPath = join(repo, "flows", "rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "claude",
            prompt: "Apply the requested rework.",
            inputs: ["spec"],
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

    const target = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      number: 22,
      url: "https://github.com/Instask/nitely/pull/22",
      baseBranch: "master",
      headBranch: "nitely/pr-22",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    const scmProvider: ScmProvider = {
      type: "github",
      resolveChangeRequestTarget: async (input) => {
        expect(input).toEqual({
          repoPath: repo,
          remoteName: "origin",
          target: "22",
        });
        return target;
      },
      checkoutChangeRequest: async (input) => {
        expect(input.target).toEqual(target);
        await git(repo, [
          "worktree",
          "add",
          input.worktreePath,
          target.headBranch,
        ]);
        return { previousHeadSha: target.headSha };
      },
      updateChangeRequest: async (input) => {
        expect(input.target).toEqual(target);
        await git(input.worktreePath, ["add", "."]);
        await git(input.worktreePath, ["commit", "-m", input.title]);
        const { stdout } = await git(input.worktreePath, ["rev-parse", "HEAD"]);
        return {
          changeRequest: {
            provider: "github",
            url: target.url,
            number: target.number,
            owner: target.owner,
            repository: target.repository,
            baseBranch: target.baseBranch,
            headBranch: target.headBranch,
            draft: true,
          },
          url: target.url,
          number: target.number,
          previousHeadSha: target.headSha,
          updatedHeadSha: stdout.trim(),
        };
      },
      publishChange: async () => {
        throw new Error("publishChange must not be called during rework");
      },
    };

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
        changeRequestTarget: { provider: "github", target: "22" },
      },
      {
        createRunId: () => "run-rework",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          expect(await readFile(join(worktreePath, "feature.txt"), "utf8")).toBe(
            "previous\n",
          );
          await writeFile(join(worktreePath, "feature.txt"), "updated\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "updated\n", "utf8");
        },
        scmProvider,
      },
    );

    expect(result.branchName).toBe("nitely/pr-22");
    expect(result.changeRequestUrl).toBe(target.url);
    await expect(readFile(join(repo, "feature.txt"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(result.worktreePath, "feature.txt"), "utf8"),
    ).resolves.toBe("updated\n");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-rework", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Change Request Target");
    expect(evidence).toContain("PR URL: https://github.com/Instask/nitely/pull/22");
    expect(evidence).toContain("PR Number: 22");
    expect(evidence).toContain(`Previous head SHA: ${target.headSha}`);
    expect(evidence).toMatch(/Updated head SHA: [0-9a-f]{40}/);
    expect(evidence).toContain("Triggering instruction source: specs/change.md");
    expect(evidence).toContain("## Agent Runtimes");
    expect(evidence).toContain("- implement: runtime claude, model default");
    expect(evidence).toContain("- update");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-rework");
    store.close();
    expect(events.map((event) => event.type)).toEqual([
      "context.manifest.updated",
      "run.created",
      "change.target.resolved",
      "workspace.created",
      "knowledge.generated",
      "stage.started",
      "stage.context.usage",
      "stage.runtime.selected",
      "artifact.published",
      "orchestrator.decision",
      "stage.completed",
      "stage.started",
      "change.updated",
      "artifact.published",
      "orchestrator.decision",
      "stage.completed",
      "run.completed",
    ]);
    expect(projectRun(events).orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          stageType: "agent",
          action: "complete",
        }),
        expect.objectContaining({
          stageId: "update",
          stageType: "update-change",
          action: "complete",
        }),
      ]),
    );
    expect(events.find((event) => event.type === "run.created")?.payload).toMatchObject({
      changeRequestTarget: {
        provider: "github",
        target: "22",
        resolved: target,
      },
    });
  });

  it("runs reflection after updating an existing change request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Update feature.txt", "utf8");
    await git(repo, ["checkout", "-b", "nitely/pr-157"]);
    await writeFile(join(repo, "feature.txt"), "previous\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    const { stdout: headSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);

    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 157,
      url: "https://github.com/Instask/nitely/pull/157",
      baseBranch: "master",
      headBranch: "nitely/pr-157",
      headSha: headSha.trim(),
      headRepository: {
        owner: "Instask",
        repository: "nitely",
      },
      isCrossRepository: false,
    };
    const flowPath = join(repo, "flows", "update-reflect.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "update-reflect" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "claude",
            prompt: "Update the PR branch.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "claude",
            prompt: "Reflect on the rework execution.",
            inputs: ["implementation", "change-request"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
        changeRequestTarget: { provider: "github", target: "157" },
      },
      {
        createRunId: () => "run-update-reflect",
        executeAgent: async ({ stage, attemptDirectory, worktreePath, prompt }) => {
          if (stage.id === "implement") {
            expect(await readFile(join(worktreePath, "feature.txt"), "utf8")).toBe(
              "previous\n",
            );
            await writeFile(join(worktreePath, "feature.txt"), "updated\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "updated\n", "utf8");
            return;
          }
          reflectionPrompt = prompt;
          await writeFile(
            join(attemptDirectory, "reflection.md"),
            "Created follow-up: none.\n",
            "utf8",
          );
        },
        scmProvider: localReworkProvider({ repo, target }),
      },
    );

    expect(result.changeRequestUrl).toBe(target.url);
    expect(reflectionPrompt).toContain("Artifact: change-request");
    expect(reflectionPrompt).toContain(target.url);
    expect(reflectionPrompt).toContain("Updated head SHA:");

    const runDirectory = join(repo, ".nitely", "runs", "run-update-reflect");
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("- change-request: producer update");
    expect(evidence).toContain("Path: stages/update/1/change-request.md");
    expect(evidence).toContain("- reflection: producer reflect");
    expect(evidence).toContain("Path: stages/reflect/1/reflection.md");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-update-reflect"));
    store.close();
    expect(projection.completedStages).toEqual(["implement", "update", "reflect"]);
  });

  it("uses an agent-produced title artifact when updating an existing pull request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Rework feature.txt", "utf8");
    await git(repo, ["checkout", "-b", "nitely/pr-44"]);
    await writeFile(join(repo, "feature.txt"), "previous\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);

    const flowPath = join(repo, "flows", "rework-title.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework-title" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Apply the requested rework.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    const target = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      number: 44,
      url: "https://github.com/Instask/nitely/pull/44",
      baseBranch: "master",
      headBranch: "nitely/pr-44",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    let updateTitle = "";
    const scmProvider: ScmProvider = {
      type: "github",
      resolveChangeRequestTarget: async () => target,
      checkoutChangeRequest: async (input) => {
        await git(repo, [
          "worktree",
          "add",
          input.worktreePath,
          target.headBranch,
        ]);
        return { previousHeadSha: target.headSha };
      },
      updateChangeRequest: async (input) => {
        updateTitle = input.title;
        await git(input.worktreePath, ["add", "."]);
        await git(input.worktreePath, ["commit", "-m", input.title]);
        const { stdout } = await git(input.worktreePath, ["rev-parse", "HEAD"]);
        return {
          changeRequest: {
            provider: "github",
            url: target.url,
            number: target.number,
            owner: target.owner,
            repository: target.repository,
            baseBranch: target.baseBranch,
            headBranch: target.headBranch,
            draft: true,
          },
          url: target.url,
          number: target.number,
          previousHeadSha: target.headSha,
          updatedHeadSha: stdout.trim(),
        };
      },
      publishChange: async () => {
        throw new Error("publishChange must not be called during rework");
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
        changeRequestTarget: { provider: "github", target: "44" },
      },
      {
        createRunId: () => "run-rework-title",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "updated\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "updated\n", "utf8");
          await writeFile(join(attemptDirectory, "pr-title.md"), "Tighten rework flow\n", "utf8");
        },
        scmProvider,
      },
    );

    expect(updateTitle).toBe("Tighten rework flow");
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-rework-title", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Change Title");
    expect(evidence).toContain("Title: Tighten rework flow");
    expect(evidence).toContain("Source: artifact pr-title");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-rework-title");
    store.close();
    expect(events.find((event) => event.type === "change.updated")?.payload).toMatchObject({
      title: {
        title: "Tighten rework flow",
        source: "artifact",
        artifactId: "pr-title",
      },
    });
  });

  it("fails a rework run before creating a worktree when the target is unsupported", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "rework-reject.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework-reject" },
      spec: {
        stages: [
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: [],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const scmProvider: ScmProvider = {
      type: "github",
      resolveChangeRequestTarget: async () => {
        throw new Error("cross-repository pull requests are not supported");
      },
      publishChange: async () => {
        throw new Error("publishChange must not be called");
      },
    };

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
          changeRequestTarget: { provider: "github", target: "22" },
        },
        {
          createRunId: () => "run-rework-reject",
          scmProvider,
        },
      ),
    ).rejects.toThrow(/cross-repository/);

    await expect(
      stat(join(repo, ".nitely", "runs", "run-rework-reject", "worktree")),
    ).rejects.toThrow();
  });

  it("rejects rework runs that contain publish-change stages", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "rework-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework-publish" },
      spec: {
        stages: [
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: [],
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
          changeRequestTarget: { provider: "github", target: "22" },
        },
        {
          createRunId: () => "run-rework-publish",
          scmProvider: {
            type: "github",
            publishChange: async () => {
              throw new Error("publishChange must not be called");
            },
            resolveChangeRequestTarget: async () => {
              throw new Error("resolveChangeRequestTarget must not be called");
            },
          },
        },
      ),
    ).rejects.toThrow(/rework runs cannot use publish-change stages/);

    await expect(
      stat(join(repo, ".nitely", "runs", "run-rework-publish")),
    ).rejects.toThrow();
  });

  it("records a failed run when rework checkout fails after target resolution", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "rework-checkout-fails.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework-checkout-fails" },
      spec: {
        stages: [
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: [],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const target = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      number: 22,
      url: "https://github.com/Instask/nitely/pull/22",
      baseBranch: "master",
      headBranch: "nitely/pr-22",
      headSha: "abc123",
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
          changeRequestTarget: { provider: "github", target: "22" },
        },
        {
          createRunId: () => "run-rework-checkout-fails",
          scmProvider: {
            type: "github",
            resolveChangeRequestTarget: async () => target,
            checkoutChangeRequest: async () => {
              throw new Error("fetch failed");
            },
            publishChange: async () => {
              throw new Error("publishChange must not be called");
            },
          },
        },
      ),
    ).rejects.toThrow(/fetch failed/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-rework-checkout-fails"));
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.changeRequestTarget).toMatchObject({
      resolved: target,
    });
    await expect(
      stat(join(repo, ".nitely", "runs", "run-rework-checkout-fails", "worktree")),
    ).rejects.toThrow();
  });

  it("requires a rework target for update-change stages", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "update-without-target.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "update-without-target" },
      spec: {
        stages: [
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: [],
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
        },
        {
          createRunId: () => "run-update-without-target",
        },
      ),
    ).rejects.toThrow(/update-change requires a change request target/);
  });

  it("requires a rework target for sync-change stages", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "sync-without-target.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "sync-without-target" },
      spec: {
        stages: [
          {
            id: "sync",
            type: "sync-change",
            strategy: "merge",
            inputs: [],
            outputs: ["sync-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["sync-report"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    let published = false;

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
        },
        {
          createRunId: () => "run-sync-without-target",
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/1", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/sync-change requires a change request target/);
    expect(published).toBe(false);
  });

  it("merges the latest base into a clean same-repository PR branch", async () => {
    const { repo } = await createRepoWithOrigin();
    await git(repo, ["checkout", "-b", "nitely/pr-23"]);
    await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    await git(repo, ["push", "-u", "origin", "nitely/pr-23"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);
    await writeFile(join(repo, "base.txt"), "base changed\n", "utf8");
    await git(repo, ["add", "base.txt"]);
    await git(repo, ["commit", "-m", "advance base"]);
    await git(repo, ["push", "origin", "master"]);
    const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);

    const flowPath = join(repo, "flows", "sync-clean.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "sync-clean" },
      spec: {
        stages: [
          {
            id: "sync",
            type: "sync-change",
            strategy: "merge",
            inputs: [],
            outputs: ["sync-report"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["sync-report"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 23,
      url: "https://github.com/Instask/nitely/pull/23",
      baseBranch: "master",
      headBranch: "nitely/pr-23",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };

    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        changeRequestTarget: { provider: "github", target: "23" },
      },
      {
        createRunId: () => "run-sync-clean",
        scmProvider: localReworkProvider({ repo, target }),
      },
    );

    expect(result.changeRequestUrl).toBe(target.url);
    await expect(readFile(join(result.worktreePath, "base.txt"), "utf8")).resolves.toBe(
      "base changed\n",
    );
    const { stdout: parents } = await git(result.worktreePath, [
      "show",
      "--no-patch",
      "--format=%P",
      "HEAD",
    ]);
    expect(parents.trim().split(" ")).toEqual(
      expect.arrayContaining([previousHeadSha.trim(), baseSha.trim()]),
    );
    const { stdout: unmerged } = await git(result.worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    expect(unmerged.trim()).toBe("");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-sync-clean");
    store.close();
    const syncEvent = events.find((event) => event.type === "change.sync.completed");
    expect(syncEvent?.payload).toMatchObject({
      prUrl: target.url,
      prNumber: target.number,
      baseBranch: "master",
      strategy: "merge",
      baseSha: baseSha.trim(),
      headShaBefore: previousHeadSha.trim(),
      result: "clean",
      conflictFiles: [],
    });
    const reportPath = (syncEvent?.payload as { reportPath?: string }).reportPath;
    expect(reportPath).toBeTruthy();
    await expect(readFile(reportPath ?? "", "utf8")).resolves.toContain(
      "Result: clean",
    );
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-sync-clean", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Sync");
    expect(evidence).toContain("Strategy: merge");
    expect(evidence).toContain("Result: clean");
    expect(evidence).toContain(`Base SHA: ${baseSha.trim()}`);
    expect(evidence).toContain("Conflict files: none");
    expect(projectRun(events).orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "sync",
          stageType: "sync-change",
          action: "complete",
        }),
        expect.objectContaining({
          stageId: "update",
          stageType: "update-change",
          action: "complete",
        }),
      ]),
    );
  });

  it("redacts sync-change stdout stderr report events and evidence", async () => {
    const { repo } = await createRepoWithOrigin();
    const secret = "sync-secret-value";
    process.env.NITELY_SYNC_TOKEN = secret;
    try {
      const baseBranch = `base-${secret}`;
      await git(repo, ["checkout", "-b", baseBranch]);
      await writeFile(join(repo, "base.txt"), "base changed\n", "utf8");
      await git(repo, ["add", "base.txt"]);
      await git(repo, ["commit", "-m", "advance secret base"]);
      await git(repo, ["push", "-u", "origin", baseBranch]);
      const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["checkout", "master"]);
      await git(repo, ["checkout", "-b", "nitely/pr-redacted-sync"]);
      await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
      await git(repo, ["add", "feature.txt"]);
      await git(repo, ["commit", "-m", "seed pr branch"]);
      await git(repo, ["push", "-u", "origin", "nitely/pr-redacted-sync"]);
      const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["checkout", "master"]);

      const flowPath = join(repo, "flows", "sync-redaction.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "sync-redaction" },
        spec: {
          stages: [
            {
              id: "sync",
              type: "sync-change",
              strategy: "merge",
              inputs: [],
              outputs: ["sync-report"],
            },
            {
              id: "update",
              type: "update-change",
              provider: "github",
              inputs: ["sync-report"],
              outputs: ["change-request"],
            },
          ],
        },
      });
      const target: ChangeRequestTarget = {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 59,
        url: `https://github.com/Instask/nitely/pull/59?token=${secret}`,
        baseBranch,
        headBranch: "nitely/pr-redacted-sync",
        headSha: previousHeadSha.trim(),
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      };

      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
          changeRequestTarget: { provider: "github", target: "59" },
        },
        {
          createRunId: () => "run-sync-redaction",
          scmProvider: localReworkProvider({ repo, target }),
        },
      );

      const runDirectory = join(repo, ".nitely", "runs", "run-sync-redaction");
      const stdoutLog = await readFile(
        join(runDirectory, "stages", "sync", "1", "stdout.log"),
        "utf8",
      );
      const stderrLog = await readFile(
        join(runDirectory, "stages", "sync", "1", "stderr.log"),
        "utf8",
      );
      const report = await readFile(
        join(runDirectory, "stages", "sync", "1", "sync-report.md"),
        "utf8",
      );
      const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
      for (const text of [stdoutLog, stderrLog, report, evidence]) {
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain(secret);
      }
      expect(report).toContain(`Base SHA: ${baseSha.trim()}`);
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list("run-sync-redaction");
      store.close();
      const syncEvent = events.find((event) => event.type === "change.sync.completed");
      expect(JSON.stringify(syncEvent?.payload)).toContain("[REDACTED]");
      expect(JSON.stringify(syncEvent?.payload)).not.toContain(secret);
    } finally {
      delete process.env.NITELY_SYNC_TOKEN;
    }
  });

  it("records conflicted sync metadata and leaves conflict markers for the agent", async () => {
    const { repo } = await createRepoWithOrigin();
    await writeFile(join(repo, "feature.txt"), "original\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "add shared file"]);
    await git(repo, ["push", "origin", "master"]);
    await git(repo, ["checkout", "-b", "nitely/pr-23"]);
    await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "change pr branch"]);
    await git(repo, ["push", "-u", "origin", "nitely/pr-23"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);
    await writeFile(join(repo, "feature.txt"), "base branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "change base branch"]);
    await git(repo, ["push", "origin", "master"]);
    const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);

    const flowPath = join(repo, "flows", "sync-conflicted.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "sync-conflicted" },
      spec: {
        stages: [
          {
            id: "sync",
            type: "sync-change",
            strategy: "merge",
            inputs: [],
            outputs: ["sync-report"],
          },
          {
            id: "resolve",
            type: "agent",
            runtime: "codex",
            prompt: "Resolve conflict markers.",
            inputs: ["sync-report"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 23,
      url: "https://github.com/Instask/nitely/pull/23",
      baseBranch: "master",
      headBranch: "nitely/pr-23",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    let agentSawMarkers = false;
    let agentPrompt = "";

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        changeRequestTarget: { provider: "github", target: "23" },
      },
      {
        createRunId: () => "run-sync-conflicted",
        scmProvider: localReworkProvider({ repo, target }),
        executeAgent: async ({ prompt, attemptDirectory, worktreePath }) => {
          agentPrompt = prompt;
          const conflicted = await readFile(join(worktreePath, "feature.txt"), "utf8");
          agentSawMarkers = conflicted.includes("<<<<<<<");
          await writeFile(join(worktreePath, "feature.txt"), "resolved\n", "utf8");
          await git(worktreePath, ["add", "feature.txt"]);
          await git(worktreePath, ["commit", "-m", "resolve conflict"]);
          await writeFile(join(attemptDirectory, "implementation.md"), "resolved\n", "utf8");
        },
      },
    );

    expect(agentSawMarkers).toBe(true);
    expect(agentPrompt).toContain("## Input: sync-report");
    expect(agentPrompt).toContain("feature.txt");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-sync-conflicted");
    store.close();
    const syncEvent = events.find((event) => event.type === "change.sync.conflicted");
    expect(syncEvent?.payload).toMatchObject({
      prUrl: target.url,
      prNumber: target.number,
      baseBranch: "master",
      strategy: "merge",
      baseSha: baseSha.trim(),
      headShaBefore: previousHeadSha.trim(),
      result: "conflicted",
      conflictFiles: ["feature.txt"],
    });
  });

  it("does not update a conflicted PR when downstream verification fails", async () => {
    const { repo } = await createRepoWithOrigin();
    await writeFile(join(repo, "feature.txt"), "original\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "add shared file"]);
    await git(repo, ["push", "origin", "master"]);
    await git(repo, ["checkout", "-b", "nitely/pr-23"]);
    await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "change pr branch"]);
    await git(repo, ["push", "-u", "origin", "nitely/pr-23"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);
    await writeFile(join(repo, "feature.txt"), "base branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "change base branch"]);
    await git(repo, ["push", "origin", "master"]);

    const flowPath = join(repo, "flows", "sync-verify-fails.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "sync-verify-fails" },
      spec: {
        stages: [
          {
            id: "sync",
            type: "sync-change",
            inputs: [],
            outputs: ["sync-report"],
          },
          {
            id: "test",
            type: "command",
            command: 'test -z "$(git diff --name-only --diff-filter=U)"',
            inputs: ["sync-report"],
            outputs: ["test-report"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["test-report"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 23,
      url: "https://github.com/Instask/nitely/pull/23",
      baseBranch: "master",
      headBranch: "nitely/pr-23",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    let updateCalled = false;

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {},
          changeRequestTarget: { provider: "github", target: "23" },
        },
        {
          createRunId: () => "run-sync-verify-fails",
          scmProvider: localReworkProvider({
            repo,
            target,
            onUpdate: async () => {
              updateCalled = true;
            },
          }),
        },
      ),
    ).rejects.toThrow(/command failed/);
    expect(updateCalled).toBe(false);
  });

  it("does not update a PR when staged conflict markers remain", async () => {
    const { repo } = await createRepoWithOrigin();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "spec.md"), "Resolve conflicts\n", "utf8");
    await writeFile(
      join(repo, "specs", "tech-design.md"),
      "Verify staged markers\n",
      "utf8",
    );
    await git(repo, ["checkout", "-b", "nitely/pr-43"]);
    await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    await git(repo, ["push", "-u", "origin", "nitely/pr-43"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);

    const binDirectory = await mkdtemp(join(tmpdir(), "nitely-pnpm-stub-"));
    const pnpmPath = join(binDirectory, "pnpm");
    await writeFile(pnpmPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(pnpmPath, 0o755);

    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 43,
      url: "https://github.com/Instask/nitely/pull/43",
      baseBranch: "master",
      headBranch: "nitely/pr-43",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    let updateCalled = false;
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;
    try {
      await expect(
        runFlow(
          {
            flowPath: join(
              repositoryRoot,
              "flows",
              "resolve-conflicts-bootstrap.json",
            ),
            repoPath: repo,
            inputs: {
              spec: { connector: "local-file", uri: "specs/spec.md" },
              "tech-design": {
                connector: "local-file",
                uri: "specs/tech-design.md",
              },
            },
            changeRequestTarget: { provider: "github", target: "43" },
          },
          {
            createRunId: () => "run-staged-conflict-markers",
            scmProvider: localReworkProvider({
              repo,
              target,
              onUpdate: async () => {
                updateCalled = true;
              },
            }),
            executeAgent: async ({ stage, attemptDirectory, worktreePath }) => {
              if (stage.id !== "resolve") return;
              await writeFile(
                join(worktreePath, "staged-conflict.txt"),
                [
                  "<<<<<<< HEAD",
                  "ours",
                  "=======",
                  "theirs",
                  ">>>>>>> base",
                  "",
                ].join("\n"),
                "utf8",
              );
              await git(worktreePath, ["add", "staged-conflict.txt"]);
              await writeFile(join(attemptDirectory, "implementation.md"), "left staged marker\n", "utf8");
              await writeFile(join(attemptDirectory, "pr-title.md"), "Resolve conflicts\n", "utf8");
            },
          },
        ),
      ).rejects.toThrow(/command failed/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
    expect(updateCalled).toBe(false);
  });

  it("does not update a PR when untracked conflict markers remain", async () => {
    const { repo } = await createRepoWithOrigin();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "spec.md"), "Resolve conflicts\n", "utf8");
    await writeFile(
      join(repo, "specs", "tech-design.md"),
      "Verify untracked markers\n",
      "utf8",
    );
    await git(repo, ["checkout", "-b", "nitely/pr-43"]);
    await writeFile(join(repo, "feature.txt"), "pr branch\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    await git(repo, ["push", "-u", "origin", "nitely/pr-43"]);
    const { stdout: previousHeadSha } = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "master"]);

    const binDirectory = await mkdtemp(join(tmpdir(), "nitely-pnpm-stub-"));
    const pnpmPath = join(binDirectory, "pnpm");
    await writeFile(pnpmPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(pnpmPath, 0o755);

    const target: ChangeRequestTarget = {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 43,
      url: "https://github.com/Instask/nitely/pull/43",
      baseBranch: "master",
      headBranch: "nitely/pr-43",
      headSha: previousHeadSha.trim(),
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    };
    let updateCalled = false;
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;
    try {
      await expect(
        runFlow(
          {
            flowPath: join(
              repositoryRoot,
              "flows",
              "resolve-conflicts-bootstrap.json",
            ),
            repoPath: repo,
            inputs: {
              spec: { connector: "local-file", uri: "specs/spec.md" },
              "tech-design": {
                connector: "local-file",
                uri: "specs/tech-design.md",
              },
            },
            changeRequestTarget: { provider: "github", target: "43" },
          },
          {
            createRunId: () => "run-untracked-conflict-markers",
            scmProvider: localReworkProvider({
              repo,
              target,
              onUpdate: async () => {
                updateCalled = true;
              },
            }),
            executeAgent: async ({ stage, attemptDirectory, worktreePath }) => {
              if (stage.id !== "resolve") return;
              await writeFile(
                join(worktreePath, "untracked conflict.txt"),
                [
                  "<<<<<<< HEAD",
                  "ours",
                  "=======",
                  "theirs",
                  ">>>>>>> base",
                  "",
                ].join("\n"),
                "utf8",
              );
              await writeFile(join(attemptDirectory, "implementation.md"), "left untracked marker\n", "utf8");
              await writeFile(join(attemptDirectory, "pr-title.md"), "Resolve conflicts\n", "utf8");
            },
          },
        ),
      ).rejects.toThrow(/command failed/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
    expect(updateCalled).toBe(false);
  });

  it("rehydrates generated sync reports before resuming downstream agents", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "spec.md"), "Use the sync report\n", "utf8");
    const flowPath = join(repo, "flows", "resume-sync-report.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-sync-report");
    const worktreePath = join(runDirectory, "worktree");
    const reportPath = join(runDirectory, "stages", "sync", "1", "sync-report.md");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-sync-report" },
      spec: {
        stages: [
          {
            id: "sync",
            type: "sync-change",
            strategy: "merge",
            inputs: [],
            outputs: ["sync-report"],
          },
          {
            id: "resolve",
            type: "agent",
            runtime: "codex",
            prompt: "Resume with the generated report.",
            inputs: ["spec", "sync-report"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-sync-report",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      "# Sync Report\n\nResult: conflicted\n\n## Conflict Files\n\n- feature.txt\n",
      "utf8",
    );
    await mkdir(join(runDirectory, "stages", "resolve", "1"), {
      recursive: true,
    });

    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-sync-report",
      type: "run.created",
      payload: {
        flowName: "resume-sync-report",
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/spec.md" } },
        branchName: "nitely/run-resume-sync-report",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-sync-report",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-sync-report",
      stageId: "sync",
      attempt: 1,
      type: "change.sync.conflicted",
      payload: {
        prUrl: "https://github.com/Instask/nitely/pull/23",
        prNumber: 23,
        baseBranch: "master",
        strategy: "merge",
        baseSha: "a".repeat(40),
        headShaBefore: "b".repeat(40),
        result: "conflicted",
        conflictFiles: ["feature.txt"],
        stdoutPath: join(runDirectory, "stages", "sync", "1", "stdout.log"),
        stderrPath: join(runDirectory, "stages", "sync", "1", "stderr.log"),
        reportPath,
      },
    });
    seedStore.append({
      runId: "run-resume-sync-report",
      stageId: "sync",
      attempt: 1,
      type: "stage.completed",
      payload: { outputs: ["sync-report"] },
    });
    seedStore.append({
      runId: "run-resume-sync-report",
      stageId: "resolve",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "resolve", "1"),
      },
    });
    seedStore.close();

    let prompt = "";
    await resumeRun(
      { repoPath: repo, runId: "run-resume-sync-report" },
      {
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "resumed\n", "utf8");
        },
      },
    );

    expect(prompt).toContain("## Input: sync-report");
    expect(prompt).toContain("Result: conflicted");
    expect(prompt).toContain("- feature.txt");
  });

  it("routes runFlow execution through a supplied backend", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "backend.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "backend-flow" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "go",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    const calls: string[] = [];
    const backend: ExecutionBackend = {
      async createWorkspace(input) {
        calls.push("createWorkspace");
        await git(repo, [
          "worktree",
          "add",
          "-b",
          input.branchName,
          input.worktreePath,
          "HEAD",
        ]);
        return { runId: input.runId, path: input.worktreePath };
      },
      async runAgent(_workspace, input) {
        calls.push("runAgent");
        await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
        return { stdout: "", stderr: "" };
      },
      async runCommand() {
        calls.push("runCommand");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async commitAll() {
        calls.push("commitAll");
        return { committed: false };
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      { createRunId: () => "be", backend },
    );

    expect(calls).toEqual(["createWorkspace", "runAgent", "runCommand"]);
  });

  it("routes resumeRun execution through a supplied backend", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-backend.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-be");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-backend" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "go",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-be",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), {
      recursive: true,
    });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-be",
      type: "run.created",
      payload: {
        flowName: "resume-backend",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-be",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-be",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-be",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.close();

    const calls: string[] = [];
    const backend: ExecutionBackend = {
      async createWorkspace(input) {
        calls.push("createWorkspace");
        return { runId: input.runId, path: input.worktreePath };
      },
      async runAgent(_workspace, input) {
        calls.push("runAgent");
        await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
        return { stdout: "", stderr: "" };
      },
      async runCommand() {
        calls.push("runCommand");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async commitAll() {
        calls.push("commitAll");
        return { committed: false };
      },
    };

    await resumeRun({ repoPath: repo, runId: "run-resume-be" }, { backend });

    // Resume reuses the existing worktree (no createWorkspace) and runs the
    // interrupted agent stage through the backend.
    expect(calls).toEqual(["runAgent"]);
  });

  it("records a stage.context.usage event per agent attempt", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "context-usage.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "context-usage" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-context-usage",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "implemented\n",
            "utf8",
          );
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-context-usage");
    store.close();
    const usage = events.find((event) => event.type === "stage.context.usage");
    expect(usage).toBeDefined();
    expect(usage?.stageId).toBe("implement");
    const payload = usage?.payload as Record<string, number>;
    expect(payload.promptBytes).toBeGreaterThan(0);
    expect(payload.approxTokens).toBe(Math.ceil(payload.promptBytes / 4));
    expect(typeof payload.inputBytesSaved).toBe("number");
    expect(payload.inputCount).toBeGreaterThanOrEqual(0);
  });

  it("records stage.runtime.usage when the execution backend reports usage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-usage.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-usage" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-runtime-usage",
        backend: backendWithAgent(repo, async (_workspace, input) => {
          await writeFile(
            join(input.attemptDirectory, "implementation.md"),
            "implemented\n",
            "utf8",
          );
          return {
            stdout: "",
            stderr: "",
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              contextWindow: 200000,
              estimatedCostUsd: 0.02,
              raw: { provider: "mock" },
            },
          };
        }),
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-runtime-usage");
    store.close();
    const usage = events.find((event) => event.type === "stage.runtime.usage");
    expect(usage).toBeDefined();
    expect(usage?.stageId).toBe("implement");
    expect(usage?.payload).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      contextWindow: 200000,
      estimatedCostUsd: 0.02,
      raw: { provider: "mock" },
    });
    expect(projectRun(events).runtimeUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      knownAttempts: 1,
      unknownAttempts: 0,
    });
  });
});

describe("resolveMaxInputTokens", () => {
  const base = { id: "s", type: "agent", runtime: "codex", prompt: "p", inputs: [], outputs: ["o"], skills: [] } as unknown as import("../../src/flow/schema.js").Stage;
  it("prefers stage over flow, falls back to flow, else undefined", () => {
    expect(resolveMaxInputTokens({ ...base, maxInputTokens: 10 } as never, 99)).toBe(10);
    expect(resolveMaxInputTokens(base, 99)).toBe(99);
    expect(resolveMaxInputTokens(base, undefined)).toBeUndefined();
  });
});

describe("fitPromptToBudget", () => {
  function ctx() {
    return { runId: "r", runDirectory: "/repo/.nitely/runs/r", manifestEntries: [], manifestEntryIndexes: new Map(), artifactEntries: [], artifactEntryIndexes: new Map(), redactionSecrets: [], constitution: { loaded: false as const, path: ".nitely/constitution.md" as const } };
  }
  function art(id: string, body: string) {
    return { id, reference: { connector: "generated", uri: "/x" }, resource: { sourceUri: id, mediaType: "text/markdown", content: Buffer.from(body), metadata: { filename: id } }, contentPath: `/repo/.nitely/runs/r/inputs/${id}/content` } as never;
  }
  const inputs = new Map<string, never>([["big", art("big", "x".repeat(40000))], ["small", art("small", "y".repeat(100))]]);
  // fake render: base 100 tokens + 100 tokens per non-forced input
  const render = (forced: Set<string>) => {
    const live = [...inputs.keys()].filter((id) => !forced.has(id)).length;
    const approxTokens = 100 + live * 100;
    return { prompt: `forced=${[...forced].join(",")}`, contextUsage: { promptBytes: approxTokens * 4, approxTokens, inputBytesInlined: 0, inputBytesSaved: 0, inputCount: inputs.size } };
  };

  it("returns ok when under budget", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 1000, render });
    expect(r.outcome.status).toBe("ok");
  });
  it("trims the largest input first until it fits", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 250, render });
    expect(r.outcome.status).toBe("trimmed");
    expect(r.outcome.trimmedInputIds).toEqual(["big"]); // big has more inlined bytes, forced first
    expect(r.outcome.approxTokensAfter).toBeLessThanOrEqual(250);
  });
  it("reports exceeded when minimal context still overflows", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 50, render });
    expect(r.outcome.status).toBe("exceeded");
    expect(r.outcome.approxTokens).toBe(100); // both forced, base remains
  });
  it("is a no-op when budget is undefined", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: undefined, render });
    expect(r.outcome.status).toBe("ok");
  });
});

describe("budget enforcement (integration)", () => {
  /**
   * Builds a single-agent flow with a `spec` input of the given body and
   * runs it with the given maxInputTokens budget at the flow spec level.
   * Returns the captured prompt, the event list, and the run status string.
   */
  async function runAgentFlowWithBudget(opts: {
    maxInputTokens: number;
    inputBody: string;
  }): Promise<{ capturedPrompt: string; events: { type: string; payload: unknown }[]; runStatus: string }> {
    const repo = await createRepo();

    // Write a spec file with the given body.
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), opts.inputBody, "utf8");

    const flowPath = join(repo, "flows", "budget-flow.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "budget-flow" },
      spec: {
        maxInputTokens: opts.maxInputTokens,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const runId = "run-budget-" + Math.random().toString(36).slice(2, 8);
    let capturedPrompt = "";
    let runStatus = "completed";

    try {
      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        },
        {
          createRunId: () => runId,
          executeAgent: async ({ prompt, attemptDirectory }) => {
            capturedPrompt = prompt;
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              "done\n",
              "utf8",
            );
          },
        },
      );
    } catch {
      runStatus = "failed";
    }

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();

    return { capturedPrompt, events, runStatus };
  }

  it("auto-trims an oversized input to fit maxInputTokens and records budget.trimmed", async () => {
    // Build a flow with an agent stage: maxInputTokens small, plus one large input artifact.
    // Run it; the fake executeAgent writes the required output and captures the prompt.
    const { events, capturedPrompt } = await runAgentFlowWithBudget({ maxInputTokens: 500, inputBody: "x".repeat(40000) });
    const trimmed = events.find((e) => e.type === "budget.trimmed");
    expect(trimmed).toBeDefined();
    expect((trimmed!.payload as { trimmedInputIds: string[] }).trimmedInputIds.length).toBeGreaterThan(0);
    // The prompt handed to the agent must reference the path, not the 40k body.
    expect(capturedPrompt).not.toContain("x".repeat(1000));
    expect(capturedPrompt).toContain("MUST read the full file");
  });

  it("fails the attempt with budget.exceeded when minimal context overflows", async () => {
    // maxInputTokens tiny enough that the fixed prompt (instructions/outputs) alone exceeds it.
    const { events, runStatus } = await runAgentFlowWithBudget({ maxInputTokens: 1, inputBody: "small" });
    expect(events.find((e) => e.type === "budget.exceeded")).toBeDefined();
    expect(runStatus).toBe("failed");
  });

  it("fails the run with budget.exceeded at a review-gate site when minimal context overflows", async () => {
    // Builds a flow with a single review-gate stage and a tiny maxInputTokens budget so that
    // the fixed prompt alone exceeds it. Asserts that budget.exceeded is recorded as an event
    // AND the run fails (hard failure, not swallowed as a soft gate failure).
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "small", "utf8");

    const flowPath = join(repo, "flows", "gate-budget-flow.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "gate-budget-flow" },
      spec: {
        maxInputTokens: 1,
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: ["spec"],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    const runId = "run-gate-budget-" + Math.random().toString(36).slice(2, 8);
    let runStatus = "completed";

    try {
      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        },
        {
          createRunId: () => runId,
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "review-gate.md"), "No issues\n", "utf8");
          },
        },
      );
    } catch {
      runStatus = "failed";
    }

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();

    expect(events.find((e) => e.type === "budget.exceeded")).toBeDefined();
    expect(runStatus).toBe("failed");
  });
});

describe("agent memory files", () => {
  async function writeAgentMemoryFlow(repo: string): Promise<string> {
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "agent-memory.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "agent-memory" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            model: "gpt-5",
            prompt: "Implement the change.",
            inputs: ["spec"],
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
    return flowPath;
  }

  async function runAgentMemoryFlow(input: {
    repo: string;
    flowPath: string;
    runId: string;
    onAgent?: (worktreePath: string) => Promise<void>;
    onPublish?: (worktreePath: string) => Promise<void>;
  }): Promise<void> {
    await runFlow(
      {
        flowPath: input.flowPath,
        repoPath: input.repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => input.runId,
        executeAgent: async ({ worktreePath, attemptDirectory }) => {
          await input.onAgent?.(worktreePath);
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
        publishChange: async ({ worktreePath, evidencePath }) => {
          await input.onPublish?.(worktreePath);
          return { url: `https://example.test/${input.runId}`, evidencePath };
        },
      },
    );
  }

  it("generates memory once, injects both files for agents, and reuses the cache on the next run", async () => {
    const repo = await createRepo();
    const flowPath = await writeAgentMemoryFlow(repo);
    const seenDuringAgent: string[] = [];

    await runAgentMemoryFlow({
      repo,
      flowPath,
      runId: "run-agent-memory-1",
      onAgent: async (worktreePath) => {
        seenDuringAgent.push(await readFile(join(worktreePath, "AGENTS.md"), "utf8"));
        seenDuringAgent.push(await readFile(join(worktreePath, "CLAUDE.md"), "utf8"));
      },
      onPublish: async (worktreePath) => {
        await expect(stat(join(worktreePath, "AGENTS.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(join(worktreePath, "CLAUDE.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    });

    expect(seenDuringAgent).toHaveLength(2);
    expect(seenDuringAgent.every((content) => content.includes("# Repository Memory"))).toBe(true);
    const firstStore = new EventStore(join(repo, ".nitely", "events.db"));
    const firstEvents = firstStore.list("run-agent-memory-1");
    firstStore.close();
    expect(firstEvents.filter((event) => event.type === "knowledge.generated")).toHaveLength(1);

    await runAgentMemoryFlow({
      repo,
      flowPath,
      runId: "run-agent-memory-2",
    });
    const secondStore = new EventStore(join(repo, ".nitely", "events.db"));
    const secondEvents = secondStore.list("run-agent-memory-2");
    secondStore.close();
    expect(secondEvents.filter((event) => event.type === "knowledge.generated")).toHaveLength(0);
  });

  it("preserves a repository-owned AGENTS.md while injecting CLAUDE.md", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "AGENTS.md"), "# User Agents\n", "utf8");
    await git(repo, ["add", "AGENTS.md"]);
    await git(repo, ["commit", "-m", "add user agents"]);
    const flowPath = await writeAgentMemoryFlow(repo);

    await runAgentMemoryFlow({
      repo,
      flowPath,
      runId: "run-agent-memory-user-file",
      onAgent: async (worktreePath) => {
        await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toBe(
          "# User Agents\n",
        );
        await expect(readFile(join(worktreePath, "CLAUDE.md"), "utf8")).resolves.toContain(
          "# Repository Memory",
        );
      },
      onPublish: async (worktreePath) => {
        await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toBe(
          "# User Agents\n",
        );
        await expect(stat(join(worktreePath, "CLAUDE.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    });
  });

  it("cleans injected files when agent execution throws", async () => {
    const repo = await createRepo();
    const flowPath = await writeAgentMemoryFlow(repo);
    let capturedWorktreePath = "";

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        },
        {
          createRunId: () => "run-agent-memory-throws",
          executeAgent: async ({ worktreePath }) => {
            capturedWorktreePath = worktreePath;
            await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toContain(
              "# Repository Memory",
            );
            await expect(readFile(join(worktreePath, "CLAUDE.md"), "utf8")).resolves.toContain(
              "# Repository Memory",
            );
            throw new Error("agent exploded after injection");
          },
        },
      ),
    ).rejects.toThrow("agent exploded after injection");

    await expect(stat(join(capturedWorktreePath, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(capturedWorktreePath, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("project constitution", () => {
  async function writeConstitutionFlow(repo: string): Promise<string> {
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "constitution.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "constitution-flow" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: ["implementation"],
            outputs: ["review-gate"],
          },
        ],
      },
    });
    return flowPath;
  }

  async function runConstitutionFlow(repo: string, runId: string): Promise<void> {
    const flowPath = await writeConstitutionFlow(repo);
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => runId,
        executeAgent: async ({ stage, worktreePath, attemptDirectory }) => {
          if (stage.id === "review") {
            await writeFile(
              join(attemptDirectory, "review-gate.md"),
              "No issues\n",
              "utf8",
            );
            return;
          }
          await writeFile(
            join(worktreePath, "feature.txt"),
            "implemented\n",
            "utf8",
          );
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "done\n",
            "utf8",
          );
        },
      },
    );
  }

  it("injects a loaded constitution into agent prompts and records it in evidence", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely", "constitution.md"),
      "# Constitution\n\n- Keep run evidence durable.\n",
      "utf8",
    );

    await runConstitutionFlow(repo, "run-constitution");

    const runDirectory = join(repo, ".nitely", "runs", "run-constitution");
    const prompt = await readFile(
      join(runDirectory, "stages", "implement", "1", "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("## Governing Principles");
    expect(prompt).toContain("- Keep run evidence durable.");

    const reviewPrompt = await readFile(
      join(runDirectory, "stages", "review", "1", "prompt.md"),
      "utf8",
    );
    expect(reviewPrompt).toContain("## Governing Principles");
    expect(reviewPrompt).toContain("- Keep run evidence durable.");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Constitution");
    expect(evidence).toContain("Loaded: yes");
    expect(evidence).toContain("Path: .nitely/constitution.md");
    expect(evidence).toMatch(/Hash: sha256:[0-9a-f]{64}/);
  });

  it("keeps existing flows working when no constitution exists", async () => {
    const repo = await createRepo();

    await runConstitutionFlow(repo, "run-no-constitution");

    const runDirectory = join(repo, ".nitely", "runs", "run-no-constitution");
    const prompt = await readFile(
      join(runDirectory, "stages", "implement", "1", "prompt.md"),
      "utf8",
    );
    expect(prompt).not.toContain("## Governing Principles");

    const reviewPrompt = await readFile(
      join(runDirectory, "stages", "review", "1", "prompt.md"),
      "utf8",
    );
    expect(reviewPrompt).not.toContain("## Governing Principles");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Constitution");
    expect(evidence).toContain("Loaded: no");
  });
});
