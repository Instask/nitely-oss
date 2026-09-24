import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../../src/artifacts/registry.js";
import {
  createContextKnowledgeEntry,
  listContextKnowledgeEntries,
} from "../../src/context-kg/store.js";
import { EventStore } from "../../src/events/store.js";
import { loadContextPolicy } from "../../src/context/policy.js";
import { CONFORMANCE_REPORT_MEDIA_TYPE } from "../../src/conformance/report.js";
import {
  CONVERGENCE_REPORT_MEDIA_TYPE,
  CONVERGENCE_REPORT_SCHEMA,
  CONVERGENCE_REPORT_VERSION,
} from "../../src/task-artifacts/convergence.js";
import { writeTaskIssueRegistry } from "../../src/task-issues/registry.js";
import { resolveApproval } from "../../src/run/approvals.js";
import { answerQuestion } from "../../src/run/questions.js";
import { submitOperatorReview } from "../../src/run/operator-review.js";
import { projectRun } from "../../src/run/project.js";
import { readRecoverySnapshot } from "../../src/run/recovery.js";
import { sha256Text } from "../../src/run/reproducibility.js";
import { buildRunTrace } from "../../src/run/trace.js";
import {
  buildRepoIndex,
  queryRepoIndex,
  recordRepoIndexQuery,
} from "../../src/repo-index/index.js";
import { createCodexExecArgs, resumeRun, runFlow, resolveMaxInputTokens, fitPromptToBudget } from "../../src/run/run-flow.js";
import { LocalExecutionBackend } from "../../src/run/execution/local.js";
import { DEFAULT_MAX_RUNTIME_TOKENS } from "../../src/run/budget-defaults.js";
import { listNotificationDeliveryReceipts } from "../../src/web/notification-delivery.js";
import { getRunDetail } from "../../src/web/runs.js";
import { listNotifications } from "../../src/web/notifications.js";
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

async function withDefaultMaxRuntimeTokens<T>(
  tokens: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = "NITELY_DEFAULT_MAX_RUNTIME_TOKENS";
  const previous = process.env[key];
  process.env[key] = String(tokens);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(
    `timed out waiting for file ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

function nodeEval(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function withSourceServer<T>(
  input: {
    content: string;
    mediaType?: string;
    path?: string;
    status?: number;
  },
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    if (request.url !== (input.path ?? "/source.md")) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(input.status ?? 200, {
      "content-type": input.mediaType ?? "text/markdown",
      etag: "\"source-revision\"",
    });
    response.end(input.content);
  });
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}${input.path ?? "/source.md"}`);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      }),
    );
  }
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

  it.skipIf(process.platform !== "linux")(
    "records redacted OCI sandbox policy in durable run evidence",
    async () => {
      const repo = await createRepo();
      const flowPath = join(repo, "flows", "oci-evidence.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "oci-evidence" },
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
      const backend: ExecutionBackend = {
        ...backendWithAgent(repo, async (_workspace, { attemptDirectory }) => {
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "implemented\n",
            "utf8",
          );
          return { stdout: "done\n" };
        }),
        describeExecution: () => ({
          backend: "oci",
          engine: "docker-rootless",
          image: "nitely-runner:test",
          policyVersion: 1,
          isolation: "rootless-container",
          identity: {
            uid: 0,
            gid: 0,
            strategy: "rootless-container-root",
          },
          network: "none",
          mounts: ["task worktree", "attempt output"],
          environment: {
            allowedNames: ["LANG"],
            secretNames: ["OPENAI_API_KEY"],
            valuesRecorded: false,
          },
          commands: { mediation: "stated" },
          resources: {
            cpus: 1,
            memoryBytes: 1_073_741_824,
            pids: 128,
            tmpfsBytes: 268_435_456,
            maxFileBytes: 268_435_456,
            maxCapturedOutputBytes: 16_777_216,
            timeoutMs: 600_000,
          },
          cleanup: "run --rm plus forced rm -f",
          limitations: ["Git metadata is not mounted"],
        }),
      };

      const result = await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-oci-evidence", backend },
      );
      const evidence = await readFile(
        join(repo, ".nitely", "runs", result.runId, "evidence.md"),
        "utf8",
      );

      expect(evidence).toContain("## Execution Sandbox");
      expect(evidence).toContain("Backend: oci");
      expect(evidence).toContain("Policy version: 1");
      expect(evidence).toContain(
        "Identity: 0:0 (rootless-container-root)",
      );
      expect(evidence).toContain(
        "Secret names: OPENAI_API_KEY (values omitted)",
      );
      expect(evidence).not.toContain("super-secret-value");
    },
  );

  it("pins a fresh origin default-branch SHA without changing the local checkout", async () => {
    const { repo, remote } = await createRepoWithOrigin();
    const remoteClone = await mkdtemp(join(tmpdir(), "nitely-run-remote-clone-"));
    await git(remoteClone, ["clone", remote, "."]);
    await git(remoteClone, ["config", "user.email", "nitely@example.test"]);
    await git(remoteClone, ["config", "user.name", "Nitely Test"]);
    await writeFile(join(remoteClone, "REMOTE.md"), "fresh remote\n", "utf8");
    await git(remoteClone, ["add", "REMOTE.md"]);
    await git(remoteClone, ["commit", "-m", "advance remote default branch"]);
    await git(remoteClone, ["push", "origin", "master"]);
    const { stdout: remoteRevisionOutput } = await git(remoteClone, ["rev-parse", "HEAD"]);
    const remoteRevision = remoteRevisionOutput.trim();
    await writeFile(join(repo, "local-uncommitted.txt"), "keep this file\n", "utf8");
    const { stdout: localBranchOutput } = await git(repo, ["branch", "--show-current"]);

    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "fresh-remote-baseline" },
      spec: { stages: [{ id: "verify", type: "command", command: "printf verified", inputs: [], outputs: ["test-report"] }] },
    });
    let receivedSourceRevision: string | undefined;
    const backend: ExecutionBackend = {
      async createWorkspace(input) {
        receivedSourceRevision = input.sourceRevision;
        throw new Error("stop after workspace input capture");
      },
      async runCommand() { throw new Error("command should not run"); },
      async runAgent() { throw new Error("agent should not run"); },
      async commitAll() { throw new Error("commit should not run"); },
    };

    await expect(runFlow(
      {
        repoPath: repo,
        flowPath: join(repo, "flows", "fresh-remote-baseline.json"),
        flowDocument,
        inputs: {},
      },
      { createRunId: () => "run-fresh-remote-baseline", backend },
    )).rejects.toThrow("stop after workspace input capture");

    expect(receivedSourceRevision).toBe(remoteRevision);
    await expect(readFile(join(repo, "local-uncommitted.txt"), "utf8")).resolves.toBe("keep this file\n");
    await expect(git(repo, ["branch", "--show-current"])).resolves.toMatchObject({ stdout: localBranchOutput });
    const runDirectory = join(repo, ".nitely", "runs", "run-fresh-remote-baseline");
    const reproducibility = JSON.parse(await readFile(join(runDirectory, "reproducibility.json"), "utf8")) as {
      repo: { baseBranch?: string; baseCommit?: string };
    };
    expect(reproducibility.repo).toMatchObject({ baseBranch: "master", baseCommit: remoteRevision });
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    expect(store.list("run-fresh-remote-baseline").find((event) => event.type === "run.created")?.payload).toMatchObject({
      baseCommit: remoteRevision,
    });
    store.close();
  });

  it("fails before workspace creation when the configured origin cannot be fetched", async () => {
    const { repo } = await createRepoWithOrigin();
    await git(repo, ["remote", "set-url", "origin", join(repo, "missing-origin")]);
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "unreachable-origin" },
      spec: { stages: [{ id: "verify", type: "command", command: "printf verified", inputs: [], outputs: ["test-report"] }] },
    });
    let workspaceCreated = false;
    const backend: ExecutionBackend = {
      async createWorkspace() { workspaceCreated = true; throw new Error("workspace should not be created"); },
      async runCommand() { throw new Error("command should not run"); },
      async runAgent() { throw new Error("agent should not run"); },
      async commitAll() { throw new Error("commit should not run"); },
    };
    await expect(runFlow(
      { repoPath: repo, flowPath: join(repo, "flows", "unreachable-origin.json"), flowDocument, inputs: {} },
      { createRunId: () => "run-unreachable-origin", backend },
    )).rejects.toThrow(/unable to resolve origin default branch|unable to fetch origin default branch/);
    expect(workspaceCreated).toBe(false);
  });

  it("does not refresh origin when an explicit source revision is supplied", async () => {
    const { repo } = await createRepoWithOrigin();
    const { stdout: sourceRevisionOutput } = await git(repo, ["rev-parse", "HEAD"]);
    const sourceRevision = sourceRevisionOutput.trim();
    await git(repo, ["remote", "set-url", "origin", join(repo, "missing-origin")]);
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "explicit-source-revision" },
      spec: { stages: [{ id: "verify", type: "command", command: "printf verified", inputs: [], outputs: ["test-report"] }] },
    });
    let receivedSourceRevision: string | undefined;
    const backend: ExecutionBackend = {
      async createWorkspace(input) { receivedSourceRevision = input.sourceRevision; throw new Error("stop after workspace input capture"); },
      async runCommand() { throw new Error("command should not run"); },
      async runAgent() { throw new Error("agent should not run"); },
      async commitAll() { throw new Error("commit should not run"); },
    };
    await expect(runFlow(
      {
        repoPath: repo,
        flowPath: join(repo, "flows", "explicit-source-revision.json"),
        flowDocument,
        expectedSourceRevision: sourceRevision,
        inputs: {},
      },
      { createRunId: () => "run-explicit-source-revision", backend },
    )).rejects.toThrow("stop after workspace input capture");
    expect(receivedSourceRevision).toBe(sourceRevision);
  });

  it("rejects a replay when the effective context policy digest changed", async () => {
    const repo = await createRepo();
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "pinned-context" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf verified",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow({
        repoPath: repo,
        flowPath: join(repo, "flows", "pinned-context.json"),
        flowDocument,
        expectedContextPolicySha256: `sha256:${"0".repeat(64)}`,
        inputs: {},
      }),
    ).rejects.toThrow(/context policy digest mismatch/);
  });

  it.skipIf(process.platform !== "linux")(
    "creates replay workspaces from the pinned source revision",
    async () => {
      const repo = await createRepo();
      const { stdout: sourceRevisionOutput } = await git(repo, [
        "rev-parse",
        "HEAD",
      ]);
      const sourceRevision = sourceRevisionOutput.trim();
      await git(repo, ["checkout", "--detach", sourceRevision]);
      const flowDocument = JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "pinned-source" },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "printf verified",
              inputs: [],
              outputs: ["test-report"],
            },
          ],
        },
      });
      let receivedSourceRevision: string | undefined;
      const backend: ExecutionBackend = {
        async createWorkspace(input) {
          receivedSourceRevision = input.sourceRevision;
          throw new Error("stop after workspace input capture");
        },
        async runCommand() {
          throw new Error("command should not run");
        },
        async runAgent() {
          throw new Error("agent should not run");
        },
        async commitAll() {
          throw new Error("commit should not run");
        },
      };

      await expect(
        runFlow(
          {
            repoPath: repo,
            flowPath: join(repo, "flows", "pinned-source.json"),
            flowDocument,
            expectedSourceRevision: sourceRevision,
            evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
            inputs: {},
          },
          { createRunId: () => "run-pinned-source", backend },
        ),
      ).rejects.toThrow("stop after workspace input capture");
      expect(receivedSourceRevision).toBe(sourceRevision);
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      expect(store.list("run-pinned-source").find(
        (event) => event.type === "run.created",
      )?.payload).toMatchObject({
        evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
        configurationSnapshotPath: "configuration.json",
        configurationSha256: sha256Text("{}"),
      });
      store.close();
      await expect(
        readFile(
          join(
            repo,
            ".nitely",
            "runs",
            "run-pinned-source",
            "configuration.json",
          ),
          "utf8",
        ),
      ).resolves.toBe("{}");
    },
  );

  it.skipIf(process.platform === "linux")(
    "fails closed before an eval replay can persist an unanchored configuration snapshot",
    async () => {
      const repo = await createRepo();
      const flowDocument = JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "unanchored-replay" },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "printf verified",
              inputs: [],
              outputs: ["test-report"],
            },
          ],
        },
      });
      let workspaceRequested = false;
      const backend: ExecutionBackend = {
        async createWorkspace() {
          workspaceRequested = true;
          throw new Error("workspace should not be requested");
        },
        async runCommand() {
          throw new Error("command should not run");
        },
        async runAgent() {
          throw new Error("agent should not run");
        },
        async commitAll() {
          throw new Error("commit should not run");
        },
      };

      await expect(
        runFlow(
          {
            repoPath: repo,
            flowPath: join(repo, "flows", "unanchored-replay.json"),
            flowDocument,
            evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
            inputs: {},
          },
          { createRunId: () => "run-unanchored-replay", backend },
        ),
      ).rejects.toThrow(/requires Linux descriptor-relative path anchoring/);
      expect(workspaceRequested).toBe(false);
      await expect(
        readFile(
          join(
            repo,
            ".nitely",
            "runs",
            "run-unanchored-replay",
            "configuration.json",
          ),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    {
      label: "a sensitive key",
      key: "accessTokens",
      value: "opaque-secret",
      expected: /secret-bearing configuration key: accessTokens/,
    },
    {
      label: "a token-containing key",
      key: "accessTokensList",
      value: "opaque-secret",
      expected: /secret-bearing configuration key: accessTokensList/,
    },
    {
      label: "a string disguised as a token count",
      key: "inputTokens",
      value: "opaque-secret",
      expected: /secret-bearing configuration key: inputTokens/,
    },
    {
      label: "a header key",
      key: "headers",
      value: "opaque-secret",
      expected: /secret-bearing configuration key: headers/,
    },
    {
      label: "a sensitive assignment in a value",
      key: "notes",
      value: "accessTokens=opaque-secret",
      expected: /secret-bearing configuration value: notes/,
    },
  ])("rejects eval configuration with $label before persistence", async ({
    key,
    value,
    expected,
  }) => {
    const repo = await createRepo();
    const runId = `run-secret-configuration-${key.toLowerCase()}`;
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "secret-configuration",
        configurables: [
          { key, type: "text", label: "Unsafe", required: true },
        ],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf verified",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    let workspaceRequested = false;
    const backend: ExecutionBackend = {
      async createWorkspace() {
        workspaceRequested = true;
        throw new Error("workspace should not be requested");
      },
      async runCommand() {
        throw new Error("command should not run");
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async commitAll() {
        throw new Error("commit should not run");
      },
    };

    await expect(
      runFlow(
        {
          repoPath: repo,
          flowPath: join(repo, "flows", "secret-configuration.json"),
          flowDocument,
          evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
          configuration: { [key]: value },
          inputs: {},
        },
        { createRunId: () => runId, backend },
      ),
    ).rejects.toThrow(expected);
    expect(workspaceRequested).toBe(false);
    await expect(
      stat(join(repo, ".nitely", "runs", runId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows eval token-count configuration through the secret guard", async () => {
    const repo = await createRepo();
    const runId = "run-token-count-configuration";
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "token-count-configuration",
        configurables: [
          { key: "inputTokens", type: "number", label: "Input tokens" },
          { key: "outputTokens", type: "number", label: "Output tokens" },
          {
            key: "cachedInputTokens",
            type: "number",
            label: "Cached input tokens",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf verified",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    let workspaceRequested = false;
    const backend: ExecutionBackend = {
      async createWorkspace() {
        workspaceRequested = true;
        throw new Error("stop after workspace request");
      },
      async runCommand() {
        throw new Error("command should not run");
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async commitAll() {
        throw new Error("commit should not run");
      },
    };

    const execution = runFlow(
      {
        repoPath: repo,
        flowPath: join(repo, "flows", "token-count-configuration.json"),
        flowDocument,
        evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
        configuration: {
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 20,
        },
        inputs: {},
      },
      { createRunId: () => runId, backend },
    );
    if (process.platform === "linux") {
      await expect(execution).rejects.toThrow("stop after workspace request");
      expect(workspaceRequested).toBe(true);
      await expect(
        readFile(
          join(repo, ".nitely", "runs", runId, "configuration.json"),
          "utf8",
        ),
      ).resolves.toBe(JSON.stringify({
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 20,
      }));
    } else {
      await expect(execution).rejects.toThrow(
        /requires Linux descriptor-relative path anchoring/,
      );
      expect(workspaceRequested).toBe(false);
    }
  });

  it("records an ordinary configuration digest without persisting a raw snapshot", async () => {
    const repo = await createRepo();
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "portable-configuration",
        configurables: [
          { key: "scope", type: "text", label: "Scope", required: true },
        ],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf verified",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    let workspaceRequested = false;
    const backend: ExecutionBackend = {
      async createWorkspace() {
        workspaceRequested = true;
        throw new Error("stop after workspace request");
      },
      async runCommand() {
        throw new Error("command should not run");
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async commitAll() {
        throw new Error("commit should not run");
      },
    };

    await expect(
      runFlow(
        {
          repoPath: repo,
          flowPath: join(repo, "flows", "portable-configuration.json"),
          flowDocument,
          configuration: { scope: "sensitive-config-value" },
          inputs: {},
        },
        { createRunId: () => "run-portable-configuration", backend },
      ),
    ).rejects.toThrow("stop after workspace request");
    expect(workspaceRequested).toBe(true);

    const configurationDocument = JSON.stringify({
      scope: "sensitive-config-value",
    });
    const runDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run-portable-configuration",
    );
    await expect(
      readFile(join(runDirectory, "configuration.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-portable-configuration"));
    store.close();
    expect(projection).toMatchObject({
      configuration: { scope: "sensitive-config-value" },
      configurationSha256: sha256Text(configurationDocument),
    });
    expect(projection.configurationSnapshotPath).toBeUndefined();
  });

  it("injects submitted flow configuration into prompts and evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "configured.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "configured",
        configurables: [
          { key: "scope", type: "text", label: "Scope", required: true },
          { key: "dryRun", type: "boolean", label: "Dry run", default: true },
          { key: "retries", type: "number", label: "Retries", default: 2 },
        ],
      },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement {{config.scope}} with {{scope}}.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let prompt = "";
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        configuration: { scope: "checkout" },
      },
      {
        createRunId: () => "run-configured",
        executeAgent: async ({ prompt: renderedPrompt, attemptDirectory }) => {
          prompt = renderedPrompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(prompt).toContain("Implement checkout with checkout.");
    expect(prompt).toContain("## Configuration");
    expect(prompt).toContain("- scope: checkout");
    expect(prompt).toContain("- dryRun: true");
    expect(prompt).toContain("- retries: 2");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", result.runId, "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Configuration");
    expect(evidence).toContain("- scope: checkout");
    expect(evidence).toContain("- dryRun: true");
    expect(evidence).toContain("- retries: 2");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list(result.runId));
    store.close();
    expect(projection.configuration).toEqual({
      scope: "checkout",
      dryRun: true,
      retries: 2,
    });
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

    let publishedBody = "";
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
        publishChange: async ({ baseBranch, branchName, evidencePath, body }) => {
          expect(baseBranch).toBe("master");
          publishedBody = body;
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
      "- implement (agent): runtime codex, model gpt-5.3-codex-spark",
    );
    for (const surface of [evidence, publishedBody]) {
      expect(surface).toContain("Base branch: master");
      expect(surface).toContain("Source repository:");
      expect(surface).toContain("## Inputs");
      expect(surface).toContain("- spec");
      expect(surface).toContain("  Source URI: specs/change.md");
      expect(surface).toContain("  Media type: text/markdown");
      expect(surface).toContain("  Snapshot path: inputs/spec/content");
      expect(surface).toContain("## Changed Files");
      expect(surface).toContain("Compare: master...HEAD");
      expect(surface).toContain("Diff summary:");
      expect(surface).toContain("feature.txt");
      expect(surface).toContain("Files:");
      expect(surface).toContain("- A: feature.txt");
      expect(surface).toContain("Worktree status:");
      expect(surface).toContain("clean");
      expect(surface).toContain("## Attempt Files");
      expect(surface).toContain("- stages/implement/1");
      expect(surface).toContain("- stages/test/1");
      expect(surface).toContain("  Command: test -f feature.txt");
      expect(surface).toContain("  Exit code: 0");
      expect(surface).toContain("  Output summary: stages/test/1/output.md");
      expect(surface).toContain("  Stdout: stages/test/1/stdout.log");
      expect(surface).toContain("  Stderr: stages/test/1/stderr.log");
    }

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

  it("adds GitHub source issue linkage and closing reference to published PR evidence", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Implement the GitHub issue", "utf8");
    await writeJson(join(repo, ".nitely/tasks/task-19/execution/workflow-metadata.json"), {
      taskId: "task-19",
      title: "Implement issue 19",
      issueUrl: "https://github.com/Instask/nitely/issues/19",
      sourceUri: "https://github.com/Instask/nitely/issues/19",
    });
    const flowPath = join(repo, "flows", "issue-backed-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "issue-backed-publish" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
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
    let publishedBody = "";

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
          "workflow-metadata": {
            connector: "local-file",
            uri: ".nitely/tasks/task-19/execution/workflow-metadata.json",
          },
        },
      },
      {
        createRunId: () => "run-source-issue",
        executeAgent: async ({ attemptDirectory, worktreePath }) => {
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
        },
        publishChange: async (input) => {
          publishedBody = input.body;
          return {
            url: "https://github.com/Instask/nitely/pull/148",
            evidencePath: input.evidencePath,
            changeRequest: {
              provider: "github",
              url: "https://github.com/Instask/nitely/pull/148",
              number: 148,
              owner: "Instask",
              repository: "nitely",
              baseBranch: "master",
              headBranch: input.branchName,
              draft: true,
            },
          };
        },
      },
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-source-issue", "evidence.md"),
      "utf8",
    );
    for (const surface of [publishedBody, evidence]) {
      expect(surface).toContain("## Source Issue");
      expect(surface).toContain("URL: https://github.com/Instask/nitely/issues/19");
      expect(surface).toContain("Issue: Instask/nitely#19");
      expect(surface).toContain("Closing reference: Closes Instask/nitely#19");
      expect(surface).toContain("\nCloses Instask/nitely#19\n");
    }
  });

  it("injects relevant context-kg entries into agent prompts and run evidence", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Add preflight UI", "utf8");
    await createContextKnowledgeEntry(
      repo,
      {
        category: "pitfalls",
        title: "Preflight stays local",
        body: "Task detail refreshes must not fetch remote branches.",
        keywords: ["preflight"],
      },
      {
        createId: () => "ctx-preflight-local",
        now: () => "2026-07-07T00:00:00.000Z",
      },
    );
    const flowPath = join(repo, "flows", "preflight-flow.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "run preflight doctor" },
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

    let renderedPrompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "specs/change.md" },
        },
        workItemId: "task-225",
      },
      {
        createRunId: () => "run-context-kg",
        executeAgent: async ({ prompt, attemptDirectory }) => {
          renderedPrompt = prompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(renderedPrompt).toContain("## Repository Context Knowledge");
    expect(renderedPrompt).toContain("Preflight stays local");
    expect(renderedPrompt).toContain(
      "Task detail refreshes must not fetch remote branches.",
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-context-kg", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Context Knowledge");
    expect(evidence).toContain("- ctx-preflight-local (pitfalls): Preflight stays local");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-context-kg"));
    store.close();
    expect(projection.contextKnowledge).toEqual([
      expect.objectContaining({
        id: "ctx-preflight-local",
        category: "pitfalls",
        title: "Preflight stays local",
        linkedTaskId: "task-225",
      }),
    ]);

    await expect(listContextKnowledgeEntries(repo)).resolves.toEqual([
      expect.objectContaining({
        id: "ctx-preflight-local",
        linkedRunIds: ["run-context-kg"],
        linkedTaskIds: ["task-225"],
      }),
    ]);
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

  it("runs an alwaysRun reflection finalizer after publish with terminal context", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "publish-reflect-finalizer.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "publish-reflect-finalizer" },
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
            alwaysRun: true,
            prompt: "Reflect on the finished issue execution.",
            inputs: ["implementation", "change-request"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    let publishBody = "";
    let refreshedBody = "";
    let refreshedEvidencePath = "";
    const changeRequest: ChangeRequest = {
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/164",
      number: 164,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-publish-reflect-finalizer",
      draft: true,
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
        createRunId: () => "run-publish-reflect-finalizer",
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
        publishChange: async ({ evidencePath, body }) => {
          publishBody = body;
          return {
            url: changeRequest.url,
            evidencePath,
            changeRequest,
          };
        },
        refreshChangeRequestEvidence: async ({ evidencePath, body, changeRequest: target }) => {
          expect(target).toEqual(changeRequest);
          refreshedBody = body;
          refreshedEvidencePath = evidencePath;
          return {
            url: changeRequest.url,
            evidencePath,
            changeRequest: { ...changeRequest, outcome: "updated" },
            metadataUpdate: {
              transport: "github-rest-api",
              outcome: "updated",
              fields: ["body"],
            },
          };
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-publish-reflect-finalizer");
    expect(publishBody).toContain("Status: in-progress");
    expect(publishBody).not.toContain("## Change Request");
    expect(publishBody).not.toContain("run-finalizer-context");
    expect(publishBody).not.toContain("stages/reflect/1/reflection.md");
    expect(refreshedEvidencePath).toBe(join(runDirectory, "evidence.md"));
    expect(refreshedBody).toContain("Status: completed");
    expect(refreshedBody).toContain("## Change Request");
    expect(refreshedBody).toContain("URL: https://github.com/Instask/nitely/pull/164");
    expect(refreshedBody).toContain("Number: 164");
    expect(refreshedBody).toContain("Base branch: master");
    expect(refreshedBody).toContain("Head branch: nitely/run-publish-reflect-finalizer");
    expect(refreshedBody).toContain("- publish");
    expect(refreshedBody).toContain("- reflect");
    expect(refreshedBody).toContain("- run-finalizer-context: producer run-finalizer");
    expect(refreshedBody).toContain("Path: finalizer-context.md");
    expect(refreshedBody).toContain("- reflection: producer reflect");
    expect(refreshedBody).toContain("Path: stages/reflect/1/reflection.md");

    expect(reflectionPrompt).toContain("Artifact: run-finalizer-context");
    expect(reflectionPrompt).toContain("Terminal status: completed");
    expect(reflectionPrompt).toContain("Change request URL: https://github.com/Instask/nitely/pull/164");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-publish-reflect-finalizer");
    const projection = projectRun(events);
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "change.evidence.refreshed" }),
      ]),
    );
    expect(projection.status).toBe("completed");
    expect(projection.completedStages).toEqual(["implement", "publish", "reflect"]);
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-finalizer-context",
          producer: "run-finalizer",
        }),
        expect.objectContaining({
          id: "reflection",
          producer: "reflect",
        }),
      ]),
    );
  });

  it("keeps the run successful when terminal evidence refresh fails", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "publish-refresh-failure.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "publish-refresh-failure" },
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
            alwaysRun: true,
            prompt: "Reflect on the finished issue execution.",
            inputs: ["implementation", "change-request"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    const changeRequest: ChangeRequest = {
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/302",
      number: 302,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-publish-refresh-failure",
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
        createRunId: () => "run-publish-refresh-failure",
        executeAgent: async ({ stage, worktreePath, attemptDirectory }) => {
          if (stage.id === "implement") {
            await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
            return;
          }
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
        refreshChangeRequestEvidence: async () => {
          throw new Error("GitHub edit failed");
        },
      },
    );

    expect(result.changeRequestUrl).toBe(changeRequest.url);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-publish-refresh-failure");
    const projection = projectRun(events);
    store.close();
    expect(projection.status).toBe("completed");
    expect(projection.completedStages).toEqual(["implement", "publish", "reflect"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "change.evidence.refresh_failed",
          payload: expect.objectContaining({ error: "GitHub edit failed" }),
        }),
      ]),
    );
  });

  it("runs an alwaysRun reflection finalizer after a command stage fails", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "failed-command-reflect-finalizer.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "failed-command-reflect-finalizer" },
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
          {
            id: "test",
            type: "command",
            command: "exit 2",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt: "Reflect on the failed issue execution.",
            inputs: ["implementation", "test-report"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-failed-command-reflect-finalizer",
          executeAgent: async ({ stage, attemptDirectory, prompt }) => {
            if (stage.id === "implement") {
              await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
              return;
            }
            reflectionPrompt = prompt;
            await writeFile(join(attemptDirectory, "reflection.md"), "Test failed.\n", "utf8");
          },
        },
      ),
    ).rejects.toThrow(/command failed with exit code 2/);

    expect(reflectionPrompt).toContain("Artifact: run-finalizer-context");
    expect(reflectionPrompt).toContain("Terminal status: failed");
    expect(reflectionPrompt).toContain("Stage: test");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-failed-command-reflect-finalizer"));
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.completedStages).toEqual(["implement", "reflect"]);
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reflection", producer: "reflect" }),
      ]),
    );
  });

  it("creates proposed context-kg entries from reflection finalizer output", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "failed-command-context-proposals.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "failed-command-context-proposals" },
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
          {
            id: "test",
            type: "command",
            command: "exit 2",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt: "Reflect on the failed issue execution and propose reusable context.",
            inputs: ["implementation", "test-report"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    const deliveryRequests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    const deliveryEnv = {
      NITELY_NOTIFICATION_WEBHOOK_URL:
        process.env.NITELY_NOTIFICATION_WEBHOOK_URL,
      NITELY_PUBLIC_BASE_URL: process.env.NITELY_PUBLIC_BASE_URL,
    };
    process.env.NITELY_NOTIFICATION_WEBHOOK_URL =
      "https://customer.example.test/nitely/events";
    process.env.NITELY_PUBLIC_BASE_URL = "https://nitely.example.test";
    globalThis.fetch = async (request, init = {}) => {
      deliveryRequests.push({ url: String(request), init });
      return new Response("ok", {
        status: 200,
        headers: { "x-request-id": "reflection-delivery-1" },
      });
    };
    try {
      await expect(
        runFlow(
          {
            flowPath,
            repoPath: repo,
            inputs: {},
            workItemId: "task-reflection",
          },
          {
            createRunId: () => "run-reflection-context-proposal",
            executeAgent: async ({ stage, attemptDirectory, prompt }) => {
              if (stage.id === "implement") {
                await writeFile(
                  join(attemptDirectory, "implementation.md"),
                  "implemented\n",
                  "utf8",
                );
                return;
              }
              reflectionPrompt = prompt;
              await writeFile(
                join(attemptDirectory, "reflection.md"),
                [
                  "Test failed.",
                  "",
                  "```context-kg",
                  JSON.stringify(
                    [
                      {
                        category: "pitfalls",
                        title: "Command stages need explicit test fixtures",
                        body: "When a command stage exits before writing its declared output, future runs should check the fixture setup before retrying.",
                        tags: ["testing"],
                        keywords: ["command", "fixture"],
                      },
                    ],
                    null,
                    2,
                  ),
                  "```",
                  "",
                ].join("\n"),
                "utf8",
              );
            },
          },
        ),
      ).rejects.toThrow(/command failed with exit code 2/);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(deliveryEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(reflectionPrompt).toContain("## Context Knowledge Proposals");
    expect(reflectionPrompt).toContain("```context-kg");
    await expect(listContextKnowledgeEntries(repo)).resolves.toEqual([
      expect.objectContaining({
        category: "pitfalls",
        title: "Command stages need explicit test fixtures",
        body: expect.stringContaining("future runs should check the fixture setup"),
        status: "proposed",
        tags: ["testing"],
        keywords: ["command", "fixture"],
        source: {
          type: "reflection",
          runId: "run-reflection-context-proposal",
          taskId: "task-reflection",
        },
        linkedRunIds: ["run-reflection-context-proposal"],
        linkedTaskIds: ["task-reflection"],
        version: 1,
      }),
    ]);
    const [proposal] = await listContextKnowledgeEntries(repo);
    await expect(listNotifications(repo)).resolves.toEqual([
      expect.objectContaining({
        sourceKey: `context-kg:${proposal?.id}:proposal`,
        type: "review-memory",
        proposalId: proposal?.id,
        taskId: "task-reflection",
        runId: "run-reflection-context-proposal",
        link: `/context-kg?entry=${encodeURIComponent(proposal?.id ?? "")}`,
      }),
    ]);
    expect(deliveryRequests).toHaveLength(1);
    expect(deliveryRequests[0]?.url).toBe(
      "https://customer.example.test/nitely/events",
    );
    expect(
      new Headers(deliveryRequests[0]?.init.headers).get(
        "x-nitely-dedupe-key",
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      listNotificationDeliveryReceipts(
        repo,
        `context-kg:${proposal?.id}:proposal`,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 1,
        externalId: "reflection-delivery-1",
      }),
    ]);
  });

  it("records reflection-skipped when an alwaysRun reflection finalizer cannot run", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "reflection-skipped-finalizer.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "reflection-skipped-finalizer" },
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
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt: "Reflect on the issue execution.",
            inputs: ["implementation"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-reflection-skipped-finalizer",
        executeAgent: async ({ stage, attemptDirectory }) => {
          if (stage.id === "implement") {
            await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
            return;
          }
          throw new Error("reflection runtime unavailable");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-reflection-skipped-finalizer");
    const skipped = await readFile(
      join(runDirectory, "stages", "reflect", "1", "reflection-skipped.md"),
      "utf8",
    );
    expect(skipped).toContain("reflection runtime unavailable");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("- reflection-skipped: producer reflect");
    expect(evidence).not.toContain("- reflection: producer reflect");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-reflection-skipped-finalizer"));
    store.close();
    expect(projection.status).toBe("completed");
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reflection-skipped",
          producer: "reflect",
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

  it("cites mapped task issues and creates one idempotent terminal-run backlink", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "tasks.md"),
      `# Tasks

## Phase 1: Foundation

- [ ] T001 Build foundation

## Phase 2: Delivery

- [ ] T002 Implement delivery
- [ ] T003 Verify delivery
`,
      "utf8",
    );
    const flowPath = join(repo, "flows", "task-issues.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "task-issues" },
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
    const commit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const repository = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      url: "https://github.com/Instask/nitely",
    };
    await writeTaskIssueRegistry({
      repoPath: repo,
      repository,
      bindings: ["T002", "T003"].map((taskId) => ({
        taskId,
        issueNumber: 44,
        issueUrl: "https://github.com/Instask/nitely/issues/44",
        issueTitle: "T002: Delivery (2 tasks)",
        issueState: "open" as const,
        source: {
          commit,
          tasksPath: "docs/tasks.md",
          specPath: "docs/spec.md",
          planPath: "docs/plan.md",
        },
        syncedAt: "2026-07-14T00:00:00.000Z",
      })),
    });
    const commentBodies: string[] = [];
    let publishedBody = "";
    const scmProvider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("publishChange must not run");
      },
      resolveRepository: async () => repository,
      listRepositoryIssueComments: async () => [],
      createRepositoryIssueComment: async ({ body }) => {
        commentBodies.push(body);
        return {
          provider: "github",
          id: "55",
          url: "https://github.com/Instask/nitely/issues/44#issuecomment-55",
          body,
          authorLogin: "nitely",
          createdAt: "2026-07-14T00:00:01Z",
        };
      },
      updateRepositoryIssueComment: async () => {
        throw new Error("task issue comment update must not run for a new run");
      },
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          tasks: { connector: "local-file", uri: "docs/tasks.md" },
        },
        taskScope: { inputId: "tasks", expression: "T002,T003,T001" },
      },
      {
        createRunId: () => "run-task-issues",
        scmProvider,
        publishChange: async ({ body, evidencePath }) => {
          publishedBody = body;
          return {
            url: "https://github.com/Instask/nitely/pull/45",
            evidencePath,
          };
        },
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-task-issues");
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Task Issues");
    expect(evidence).toContain(
      "- T002, T003: https://github.com/Instask/nitely/issues/44 (#44, open)",
    );
    expect(evidence).toContain("- Unmapped selected tasks: T001");
    expect(publishedBody).toContain(
      "- T002, T003: https://github.com/Instask/nitely/issues/44 (#44, open)",
    );
    expect(commentBodies).toHaveLength(1);
    expect(commentBodies[0]).toContain("Nitely run `run-task-issues`");
    expect(commentBodies[0]).toContain("`T002`, `T003`");
    expect(commentBodies[0]).toContain(
      "`.nitely/runs/run-task-issues/evidence.md`",
    );
    expect(commentBodies[0]).toContain("https://github.com/Instask/nitely/pull/45");
    const runMetadata = JSON.parse(
      await readFile(join(runDirectory, "run.json"), "utf8"),
    ) as { taskIssues?: { issues?: Array<{ issueNumber: number }> } };
    expect(runMetadata.taskIssues?.issues).toMatchObject([{ issueNumber: 44 }]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-task-issues");
    store.close();
    expect(events.map((event) => event.type)).toContain("task.issue.scope_resolved");
    expect(events.map((event) => event.type)).toContain("task.issue.run_linked");
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

  it("executes task-plan loops one current task at a time before final review", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "task-plan-loop.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "task-plan-loop" },
      spec: {
        stages: [
          {
            id: "plan",
            type: "agent",
            runtime: "mock",
            prompt: "Decompose work into task-plan.json.",
            inputs: [],
            outputs: [
              {
                id: "task-plan",
                type: "task-plan",
                mediaType: "application/json",
              },
            ],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement only the current task.",
            inputs: ["task-plan"],
            outputs: ["implementation"],
            maxAttempts: 3,
            taskPlan: {
              input: "task-plan",
              role: "execute-current",
              max_iterations: 2,
            },
          },
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["task-plan", "implementation"],
            outputs: ["verification"],
            maxAttempts: 3,
            taskPlan: {
              input: "task-plan",
              role: "verify-advance",
            },
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            prompt: "Run final review only after the task plan is complete.",
            inputs: ["task-plan", "implementation"],
            outputs: ["review"],
            taskPlan: {
              input: "task-plan",
              role: "final",
            },
          },
        ],
      },
    });

    const implementPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-task-plan-loop",
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          if (stage.id === "plan") {
            await writeFile(
              join(attemptDirectory, "task-plan.json"),
              `${JSON.stringify(
                {
                  version: "nitely.task-plan.v1",
                  max_iterations: 2,
                  tasks: [
                    {
                      id: "T001",
                      title: "Create the first slice",
                      status: "pending",
                      paths: ["src/first.ts"],
                    },
                    {
                      id: "T002",
                      title: "Create the second slice",
                      status: "pending",
                      dependencies: ["T001"],
                      paths: ["src/second.ts"],
                    },
                  ],
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
            await writeFile(
              join(attemptDirectory, "artifact.json"),
              `${JSON.stringify(
                {
                  version: 1,
                  stageId: "plan",
                  attempt: 1,
                  outputs: [
                    {
                      id: "task-plan",
                      path: "task-plan.json",
                      mediaType: "application/json",
                    },
                  ],
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
            return;
          }
          if (stage.id === "implement") {
            implementPrompts.push(prompt);
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              `implemented ${implementPrompts.length}\n`,
              "utf8",
            );
            return;
          }
          if (stage.id === "review") {
            reviewPrompts.push(prompt);
            await writeFile(join(attemptDirectory, "review.md"), "Verdict: approved\n", "utf8");
          }
        },
      },
    );

    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[0]).toContain("Current task: T001 Create the first slice");
    expect(implementPrompts[0]).not.toContain("Create the second slice");
    expect(implementPrompts[1]).toContain("Current task: T002 Create the second slice");
    expect(reviewPrompts).toHaveLength(1);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-task-plan-loop");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.plan.iteration.started",
        "task.plan.task.completed",
        "task.plan.loop.continues",
        "task.plan.completed",
        "task.plan.final.ready",
      ]),
    );
    expect(projection.taskPlan).toMatchObject({
      inputId: "task-plan",
      completedTaskIds: ["T001", "T002"],
      remainingTaskIds: [],
      completedCount: 2,
      remainingCount: 0,
      totalTaskCount: 2,
      maxIterations: 2,
    });
    expect(projection.taskPlan?.history.map((entry) => entry.taskId)).toEqual([
      "T001",
      "T002",
    ]);

    const detail = await getRunDetail(repo, "run-task-plan-loop");
    expect(detail.taskPlan).toMatchObject({
      inputId: "task-plan",
      completedCount: 2,
      remainingCount: 0,
    });
    expect(detail.timeline.find((item) => item.stageId === "review")?.taskPlan)
      .toMatchObject({
        inputId: "task-plan",
        completedCount: 2,
        remainingCount: 0,
      });
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
              reconnectRequired: false,
              authMethods: [],
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
            reconnectRequired: false,
            authMethods: [],
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

  it("records stage.runtime.usage when the runtime throws with usage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-usage-on-throw.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-usage-on-throw" },
      spec: {
        maxAttempts: 1,
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
          createRunId: () => "run-runtime-usage-on-throw",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error("claude exited with code 1"), {
              stdout: "",
              stderr: "write failed\n",
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                cost: { classification: "actual", usd: 0.25 },
                provenance: {
                  provider: "anthropic",
                  observedAt: "2026-09-08T12:18:59.874Z",
                  source: {
                    kind: "provider-reported",
                    reference: "claude.print.result",
                  },
                },
              },
            });
          }),
        },
      ),
    ).rejects.toThrow(/claude exited with code 1/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-runtime-usage-on-throw");
    store.close();
    const usage = events.find((event) => event.type === "stage.runtime.usage");
    expect(usage).toBeDefined();
    expect(usage?.stageId).toBe("implement");
    expect(usage?.payload).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.25 },
    });
    expect(projectRun(events).runtimeUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      actualCostUsd: 0.25,
      knownAttempts: 1,
      unknownAttempts: 0,
    });
    expect(events.map((event) => event.type)).toContain("stage.failed");
  });

  it("blocks a Claude quota error envelope as agent_usage_limit and records its usage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "claude-quota-envelope.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "claude-quota-envelope" },
      spec: {
        maxAttempts: 3,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "claude",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const quota = "You've hit your limit · resets 12:50am (Asia/Singapore)";
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: quota,
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-claude-quota-envelope",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error(`claude reported an error: ${quota}`), {
              stdout,
              stderr: "",
              usage: {
                inputTokens: 1_023_926,
                outputTokens: 56_315,
                totalTokens: 1_080_241,
                cachedInputTokens: 894_348,
                cost: { classification: "actual", usd: 2.24109555 },
                provenance: {
                  provider: "anthropic",
                  observedAt: "2026-09-08T12:18:59.874Z",
                  source: {
                    kind: "provider-reported",
                    reference: "claude.print.result",
                  },
                },
                raw: { permissionDenialCount: 8 },
              },
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-claude-quota-envelope");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).toContain("stage.blocked");
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(events.map((event) => event.type)).not.toContain("stage.failed");
    expect(projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_usage_limit",
        stageId: "implement",
        runtime: "claude",
        retryAfter: "12:50am (Asia/Singapore)",
      },
      runtimeUsage: {
        inputTokens: 1_023_926,
        outputTokens: 56_315,
        totalTokens: 1_080_241,
        actualCostUsd: 2.24109555,
        knownAttempts: 1,
        unknownAttempts: 0,
      },
      stages: [
        {
          stageId: "implement",
          status: "blocked",
          attempts: [{
            attempt: 1,
            status: "blocked",
            runtimeUsage: {
              inputTokens: 1_023_926,
              outputTokens: 56_315,
              totalTokens: 1_080_241,
              cachedInputTokens: 894_348,
              cost: { classification: "actual", usd: 2.24109555 },
              raw: { permissionDenialCount: 8 },
            },
          }],
        },
      ],
    });
  });

  it("blocks for a structured question, records an answer, and injects it on resume", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "operator-question.json");
    const runId = "run-operator-question";
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "operator-question" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement safely.",
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
          createRunId: () => runId,
          backend: backendWithAgent(repo, async (_workspace, input) => {
            expect(input.prompt).toContain("## Structured Operator Question");
            await writeJson(join(input.attemptDirectory, "question.json"), {
              version: 1,
              question: "Should deleted tasks keep their run history?",
              options: [
                { id: "keep", label: "Keep run history", recommended: true },
                { id: "purge", label: "Purge run history" },
              ],
              context: "Affects retention behavior.",
            });
            return { stdout: "question asked\n", stderr: "" };
          }),
        },
      ),
    ).rejects.toThrow(
      /run blocked by awaiting_operator_answer on stage implement/,
    );

    const initialStore = new EventStore(join(repo, ".nitely", "events.db"));
    const initialEvents = initialStore.list(runId);
    const initialProjection = projectRun(initialEvents);
    initialStore.close();
    expect(initialEvents.map((event) => event.type)).toContain("stage.question");
    expect(initialEvents.map((event) => event.type)).not.toContain("stage.failed");
    expect(initialEvents.map((event) => event.type)).not.toContain("stage.retrying");
    expect(initialProjection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "awaiting_operator_answer",
        questionId: "implement-1",
      },
      pendingQuestion: {
        id: "implement-1",
        status: "pending",
      },
    });
    expect(initialProjection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "implement-1",
          mediaType: "application/vnd.nitely.operator-question+json",
        }),
      ]),
    );

    await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(
      /operator question must be answered before resume/,
    );

    await answerQuestion({
      repoPath: repo,
      runId,
      questionId: "implement-1",
      answer: { optionId: "keep" },
      actor: "leo",
    });

    let resumedPrompt = "";
    await resumeRun(
      { repoPath: repo, runId },
      {
        backend: {
          async createWorkspace() {
            throw new Error("resume should reuse the existing workspace");
          },
          async runAgent(_workspace, input) {
            resumedPrompt = input.prompt;
            await writeFile(
              join(input.attemptDirectory, "implementation.md"),
              "kept history\n",
              "utf8",
            );
            return { stdout: "implemented\n", stderr: "" };
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

    expect(resumedPrompt).toContain("## Operator Question And Answer");
    expect(resumedPrompt).toContain(
      "Question: Should deleted tasks keep their run history?",
    );
    expect(resumedPrompt).toContain("Selected option: keep — Keep run history");
    expect(resumedPrompt).toContain("Answered by: leo");

    const completedStore = new EventStore(join(repo, ".nitely", "events.db"));
    const completedProjection = projectRun(completedStore.list(runId));
    completedStore.close();
    expect(completedProjection.status).toBe("completed");
    expect(completedProjection.activeQuestion).toBeUndefined();
    expect(completedProjection.questions?.[0]).toMatchObject({
      status: "answered",
      answer: { optionId: "keep", actor: "leo" },
    });
    const evidence = await readFile(
      join(repo, ".nitely", "runs", runId, "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Operator Questions And Answers");
    expect(evidence).toContain("Answer: option keep — Keep run history");
    expect(evidence).toContain("Answered by: leo");
  });

  it("fails normally when question.json is malformed", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "invalid-operator-question.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "invalid-operator-question" },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement safely.",
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
          createRunId: () => "run-invalid-operator-question",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            await writeFile(
              join(input.attemptDirectory, "question.json"),
              "{not-json",
              "utf8",
            );
            return { stdout: "", stderr: "" };
          }),
        },
      ),
    ).rejects.toThrow(/invalid structured question: malformed JSON/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-invalid-operator-question");
    store.close();
    expect(events.map((event) => event.type)).toContain("stage.failed");
    expect(events.map((event) => event.type)).toContain("run.failed");
    expect(events.map((event) => event.type)).not.toContain("stage.question");
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
  });

  it("runs an alwaysRun reflection finalizer after an agent usage-limit blocker", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "usage-limit-reflect-finalizer.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "usage-limit-reflect-finalizer" },
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
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt: "Reflect on the blocked issue execution.",
            inputs: ["implementation"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-usage-limit-reflect-finalizer",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            if (input.stage.id === "reflect") {
              reflectionPrompt = input.prompt;
              await writeFile(join(input.attemptDirectory, "reflection.md"), "Blocked by quota.\n", "utf8");
              return { stdout: "reflected\n", stderr: "" };
            }
            throw Object.assign(new Error("codex exited with code 1"), {
              stdout: "",
              stderr: "usage limit reached; try again in 10 minutes\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    expect(reflectionPrompt).toContain("Terminal status: blocked");
    expect(reflectionPrompt).toContain("Reason: agent_usage_limit");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-usage-limit-reflect-finalizer"));
    store.close();
    expect(projection.status).toBe("blocked");
    expect(projection.completedStages).toEqual(["reflect"]);
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reflection", producer: "reflect" }),
      ]),
    );
  });

  it("does not retry or run finalizers after invalid agent credentials", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "invalid-credentials.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "invalid-credentials" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "claude",
            maxAttempts: 3,
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "claude",
            alwaysRun: true,
            prompt: "Reflect on the failed execution.",
            inputs: ["implementation"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionRan = false;
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-invalid-credentials",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            if (input.stage.id === "reflect") reflectionRan = true;
            throw new Error(
              'Failed to authenticate. API Error: 401 {"type":"authentication_error","message":"OAuth access token is invalid."}',
            );
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_credentials_invalid on stage implement/);

    expect(reflectionRan).toBe(false);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-invalid-credentials");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(events.some((event) => event.stageId === "reflect")).toBe(false);
    expect(projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_credentials_invalid",
        stageId: "implement",
        runtime: "claude",
      },
    });
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
              reconnectRequired: false,
              authMethods: [],
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

  it("deterministically converges task artifacts, records evidence, and feeds downstream rework", async () => {
    const repo = await createRepo();
    const artifactDirectory = join(repo, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "spec.md"),
      "# Spec\n\n## Functional Requirements\n\n- FR-002: Add recovery.\n",
      "utf8",
    );
    await writeFile(
      join(artifactDirectory, "plan.md"),
      "# Plan\n\n- PD-001: Keep recovery in src/recovery.ts.\n",
      "utf8",
    );
    const sourceTasks = "# Tasks\r\n\r\n- [x] T007 FR-001 Preserve existing work\r\n";
    await writeFile(join(artifactDirectory, "tasks.md"), sourceTasks, "utf8");
    const flowPath = join(repo, "flows", "convergence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "convergence",
        inputs: [{ id: "spec" }, { id: "plan" }, { id: "tasks" }],
      },
      spec: {
        stages: [
          {
            id: "converge",
            type: "agent",
            runtime: "mock",
            prompt: "Assess implementation gaps.",
            inputs: ["spec", "plan", "tasks"],
            outputs: [
              {
                id: "convergence-report",
                type: "convergence.report",
                mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
                schema: CONVERGENCE_REPORT_SCHEMA,
              },
              {
                id: "converged-tasks",
                type: "task.converged",
                mediaType: "text/markdown",
              },
            ],
            convergence: {
              tasksInput: "tasks",
              reportOutput: "convergence-report",
              tasksOutput: "converged-tasks",
            },
          },
          {
            id: "rework",
            type: "agent",
            runtime: "mock",
            prompt: "Prepare rework from the converged tasks.",
            inputs: ["converged-tasks"],
            outputs: ["rework"],
          },
        ],
      },
    });

    let convergencePrompt = "";
    let reworkPrompt = "";
    const result = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {
          spec: { connector: "local-file", uri: "artifacts/spec.md" },
          plan: { connector: "local-file", uri: "artifacts/plan.md" },
          tasks: { connector: "local-file", uri: "artifacts/tasks.md" },
        },
      },
      {
        createRunId: () => "run-convergence",
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          if (stage.id === "converge") {
            convergencePrompt = prompt;
            await writeJson(join(attemptDirectory, "convergence-report.json"), {
              version: CONVERGENCE_REPORT_VERSION,
              summary: "Recovery is missing.",
              gaps: [
                {
                  classification: "missing",
                  title: "Implement bounded recovery",
                  sourceRefs: ["FR-002", "PD-001"],
                  evidence: ["src/recovery.ts does not exist."],
                  paths: ["src/recovery.ts"],
                },
              ],
            });
            await writeFile(
              join(attemptDirectory, "converged-tasks.md"),
              "AGENT AUTHORED REWRITE MUST NOT SURVIVE\n",
              "utf8",
            );
            await writeJson(join(attemptDirectory, "artifact.json"), {
              version: 1,
              stageId: "converge",
              attempt: 1,
              outputs: [
                {
                  id: "convergence-report",
                  path: "convergence-report.json",
                  mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
                },
                {
                  id: "converged-tasks",
                  path: "converged-tasks.md",
                  mediaType: "text/markdown",
                },
              ],
            });
            return;
          }
          reworkPrompt = prompt;
          await writeFile(join(attemptDirectory, "rework.md"), "ready\n", "utf8");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", result.runId);
    const convergedPath = join(
      runDirectory,
      "stages",
      "converge",
      "1",
      "converged-tasks.md",
    );
    const converged = await readFile(convergedPath, "utf8");
    expect(converged.startsWith(sourceTasks)).toBe(true);
    expect(converged).toContain("## Convergence\r\n");
    expect(converged).toContain("T008 [CONVERGENCE:missing] FR-002 PD-001");
    expect(converged).toContain("`src/recovery.ts`");
    expect(converged).not.toContain("AGENT AUTHORED REWRITE");
    await expect(readFile(join(artifactDirectory, "tasks.md"), "utf8")).resolves.toBe(
      sourceTasks,
    );

    expect(convergencePrompt).toContain("## Convergence Contract");
    expect(convergencePrompt).toContain(CONVERGENCE_REPORT_VERSION);
    expect(convergencePrompt).toContain("Do not edit the source task artifact");
    expect(reworkPrompt).toContain("Artifact: converged-tasks");
    expect(reworkPrompt).toContain("T008 [CONVERGENCE:missing]");

    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "convergence-report",
          producer: "converge",
          type: "convergence.report",
          mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
        }),
        expect.objectContaining({
          id: "converged-tasks",
          producer: "converge",
          type: "task.converged",
          mediaType: "text/markdown",
        }),
      ]),
    );
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(
      "- convergence-report: producer converge, type convergence.report",
    );
    expect(evidence).toContain(
      "- converged-tasks: producer converge, type task.converged",
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const completed = store
      .list(result.runId)
      .find((event) => event.type === "stage.completed" && event.stageId === "converge");
    store.close();
    expect(completed?.payload).toMatchObject({
      convergence: {
        reportOutput: "convergence-report",
        tasksOutput: "converged-tasks",
        unchanged: false,
        appendedTaskIds: ["T008"],
        classifications: { missing: 1, partial: 0, contradicts: 0, unrequested: 0 },
      },
    });
  });

  it("fails convergence before completion when report and task outputs alias", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "tasks.md"), "# Tasks\n\n- [ ] T001 Existing\n", "utf8");
    const flowPath = join(repo, "flows", "aliased-convergence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "aliased-convergence", inputs: [{ id: "tasks" }] },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "converge",
            type: "agent",
            runtime: "mock",
            prompt: "Converge.",
            inputs: ["tasks"],
            outputs: [
              {
                id: "convergence-report",
                type: "convergence.report",
                mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
              },
              {
                id: "converged-tasks",
                type: "task.converged",
                mediaType: "text/markdown",
              },
            ],
            convergence: {
              tasksInput: "tasks",
              reportOutput: "convergence-report",
              tasksOutput: "converged-tasks",
            },
          },
        ],
      },
    });

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { tasks: { connector: "local-file", uri: "tasks.md" } },
        },
        {
          createRunId: () => "run-aliased-convergence",
          executeAgent: async ({ attemptDirectory }) => {
            await writeJson(join(attemptDirectory, "shared.json"), {
              version: CONVERGENCE_REPORT_VERSION,
              gaps: [],
            });
            await writeJson(join(attemptDirectory, "artifact.json"), {
              version: 1,
              stageId: "converge",
              attempt: 1,
              outputs: [
                {
                  id: "convergence-report",
                  path: "shared.json",
                  mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
                },
                {
                  id: "converged-tasks",
                  path: "shared.json",
                  mediaType: "text/markdown",
                },
              ],
            });
          },
        },
      ),
    ).rejects.toThrow(/must use a distinct physical file/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-aliased-convergence");
    store.close();
    expect(
      events.some(
        (event) => event.type === "stage.completed" && event.stageId === "converge",
      ),
    ).toBe(false);
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

  it("records agent capability policy in run evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "capability-evidence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "capability-evidence" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
            capabilities: {
              read: { scope: "approved inputs", allow: ["docs/"] },
              write: { scope: "worktree", allow: ["src/", "test/"] },
              commands: { mode: "allow-list", allow: ["pnpm test"], advisory: true },
              network: { mode: "disabled", advisory: false },
              allowedRuntimes: ["mock"],
              instructions: { repo: true, generated: false, skills: true },
              evidence: { prompts: true, toolCalls: true, fileChanges: true },
            },
          },
        ],
      },
    });

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-capability-evidence",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", result.runId, "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("- implement (agent): runtime mock, model default");
    expect(evidence).toContain("  Capabilities: explicit");
    expect(evidence).toContain("  Read: scope approved inputs; allow docs/");
    expect(evidence).toContain("  Write: scope worktree; allow src/, test/");
    expect(evidence).toContain("  Commands: allow-list (advisory); allow pnpm test; deny none");
    expect(evidence).toContain("  Network: disabled");
    expect(evidence).toContain("  Allowed runtimes: mock");
    expect(evidence).toContain("  Instructions: repo=true, generated=false, skills=true");
    expect(evidence).toContain("  Evidence: prompts=true, toolCalls=true, fileChanges=true, runtimeUsage=true");
  });

  it("fails before spawning an agent when capability policy denies its runtime", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "capability-runtime-deny.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "capability-runtime-deny" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
            capabilities: {
              allowedRuntimes: ["codex"],
            },
          },
        ],
      },
    });
    let agentCalled = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-capability-runtime-deny",
          executeAgent: async () => {
            agentCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/capability policy does not allow runtime "mock"/);
    expect(agentCalled).toBe(false);
  });

  it("fails before spawning an agent when capability policy denies its model", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "capability-model-deny.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "capability-model-deny" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            model: "fast-model",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
            capabilities: {
              allowedRuntimes: ["mock"],
              allowedModels: ["approved-model"],
            },
          },
        ],
      },
    });
    let agentCalled = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-capability-model-deny",
          executeAgent: async () => {
            agentCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/capability policy does not allow model "fast-model"/);
    expect(agentCalled).toBe(false);
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
          await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
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
    ).rejects.toThrow(/allowedTypes|high-risk|gate|approv/i);
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
      workflowStages: [
        {
          id: "test",
          type: "command",
          inputs: [],
          outputs: ["test-report"],
        },
      ],
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

  it("records heartbeat events while a stage attempt is still running", async () => {
    const previousHeartbeatMs = process.env.NITELY_STAGE_HEARTBEAT_MS;
    process.env.NITELY_STAGE_HEARTBEAT_MS = "1";
    try {
      const repo = await createRepo();
      const flowPath = join(repo, "flows", "heartbeat.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "heartbeat" },
        spec: {
          stages: [
            {
              id: "test",
              type: "command",
              command: nodeEval(
                "require('node:fs').writeFileSync('recovered.txt', 'recover me\\n'); setTimeout(() => {}, 40)",
              ),
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
        { createRunId: () => "run-heartbeat" },
      );

      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list("run-heartbeat");
      store.close();

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "stage.heartbeat",
            stageId: "test",
            attempt: 1,
          }),
        ]),
      );
      await expect(
        readRecoverySnapshot({
          runDirectory: join(repo, ".nitely", "runs", "run-heartbeat"),
        }),
      ).resolves.toMatchObject({
        runId: "run-heartbeat",
        stageId: "test",
        attempt: 1,
        status: "available",
        patchPath: "recovery.patch",
        changedPaths: ["recovered.txt"],
        untrackedPaths: ["recovered.txt"],
      });
      await expect(
        readFile(
          join(repo, ".nitely", "runs", "run-heartbeat", "recovery.patch"),
          "utf8",
        ),
      ).resolves.toContain("+recover me");
    } finally {
      if (previousHeartbeatMs === undefined) {
        delete process.env.NITELY_STAGE_HEARTBEAT_MS;
      } else {
        process.env.NITELY_STAGE_HEARTBEAT_MS = previousHeartbeatMs;
      }
    }
  });

  it("fails an agent stage when the session timeout expires", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "agent-session-timeout.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "agent-session-timeout" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            timeouts: { sessionMs: 25 },
            maxAttempts: 1,
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
          createRunId: () => "run-agent-session-timeout",
          executeAgent: async () => {
            await new Promise<never>(() => {});
          },
        },
      ),
    ).rejects.toThrow(/session timeout.*25ms/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-agent-session-timeout");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.timeout",
          stageId: "implement",
          attempt: 1,
          payload: expect.objectContaining({
            kind: "sessionMs",
            timeoutMs: 25,
          }),
        }),
      ]),
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-agent-session-timeout");
    await expect(
      readFile(join(runDirectory, "stages", "implement", "1", "stderr.log"), "utf8"),
    ).resolves.toContain("session timeout");
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Stage Timeouts");
    expect(evidence).toContain("- implement (agent)");
    expect(evidence).toContain("Session: 25ms");
  });

  it.skipIf(process.platform !== "linux")(
    "waits for backend-owned timeout teardown before recording the timeout",
    async () => {
      const repo = await createRepo();
      const flowPath = join(repo, "flows", "backend-agent-timeout.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "backend-agent-timeout" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Implement the change.",
              timeouts: { sessionMs: 10 },
              maxAttempts: 1,
              inputs: [],
              outputs: ["implementation"],
            },
          ],
        },
      });
      let teardownFinished = false;
      const backend = Object.assign(
        backendWithAgent(repo, async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          teardownFinished = true;
          throw Object.assign(new Error("sandbox process timed out"), {
            code: "EXECUTION_TIMEOUT",
            timeoutMs: 10,
            stdout: "partial output\n",
            stderr: "process timed out after 10ms\n",
          });
        }),
        { agentTimeoutControl: "backend" as const },
      );

      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          {
            createRunId: () => "run-backend-agent-timeout",
            backend,
          },
        ),
      ).rejects.toThrow(/session timeout.*10ms/);

      expect(teardownFinished).toBe(true);
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list("run-backend-agent-timeout");
      store.close();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "stage.timeout",
            stageId: "implement",
            payload: expect.objectContaining({ kind: "sessionMs", timeoutMs: 10 }),
          }),
        ]),
      );
    },
  );

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
    ).rejects.toThrow(/allowedTypes|high-risk|gate|approv/i);
    expect(published).toBe(false);
  });

  it("blocks an unknown protected custom work item type before publishing", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Change", "utf8");
    const flowPath = join(repo, "flows", "custom-ungated-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "custom-ungated-publish", workItemType: "docs.publish" },
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
        },
        {
          createRunId: () => "run-custom-ungated",
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/1", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/docs\.publish|approval|policy/i);
    expect(published).toBe(false);
  });

  it("publishes a custom protected work item type after its approval gate is approved", async () => {
    const repo = await createRepo();
    await writeJson(join(repo, ".nitely", "work-item-policy.json"), {
      customTypes: {
        "docs.publish": { decision: "require-approval" },
      },
    });
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Change", "utf8");
    const flowPath = join(repo, "flows", "custom-gated-publish.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "custom-gated-publish", workItemType: "docs.publish" },
      spec: {
        stages: [
          {
            id: "approve-publish",
            type: "approval",
            prompt: "Approve publishing",
            inputs: ["spec"],
            outputs: ["approval-evidence"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["spec", "approval-evidence"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    let published = false;
    const firstRun = await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      { createRunId: () => "run-custom-gated" },
    );
    expect(firstRun.status).toBe("awaiting-approval");
    expect(published).toBe(false);

    await resolveApproval({
      repoPath: repo,
      runId: "run-custom-gated",
      approvalId: "approve-publish-1",
      decision: "approved",
      actor: "human:test",
    });
    await resumeRun(
      { repoPath: repo, runId: "run-custom-gated" },
      {
        publishChange: async ({ evidencePath }) => {
          published = true;
          return { url: "https://example.test/pr/42", evidencePath };
        },
      },
    );

    expect(published).toBe(true);
  });

  it("blocks strict conformance publishing when the coverage report is missing", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "missing-conformance.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "missing-conformance" },
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
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
            conformance: {
              mode: "strict",
              report: "conformance-report",
              required: ["FR-001"],
            },
          },
        ],
      },
    });
    let published = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-missing-conformance",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          },
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/conformance", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/missing conformance report/);
    expect(published).toBe(false);
  });

  it("blocks strict conformance publishing on missing, partial, unverified, and contradicted coverage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "strict-conformance.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "strict-conformance" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: [
              "implementation",
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
            inputs: ["implementation", "conformance-report"],
            outputs: ["change-request"],
            conformance: {
              mode: "strict",
              report: "conformance-report",
              required: ["FR-001", "SC-001", "PD-001", "T1"],
            },
          },
        ],
      },
    });
    let published = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-strict-conformance",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
            await writeFile(
              join(attemptDirectory, "conformance-report.json"),
              JSON.stringify({
                version: 1,
                items: [
                  { id: "FR-001", status: "partially_satisfied" },
                  { id: "SC-001", status: "not_verified" },
                  { id: "PD-001", status: "not_satisfied" },
                ],
              }),
              "utf8",
            );
            await writeJson(join(attemptDirectory, "artifact.json"), {
              version: 1,
              stageId: "implement",
              attempt: 1,
              outputs: [
                { id: "implementation", path: "implementation.md", mediaType: "text/markdown" },
                {
                  id: "conformance-report",
                  path: "conformance-report.json",
                  mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
                },
              ],
            });
          },
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/conformance", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/FR-001 is partially_satisfied|SC-001 is not_verified|PD-001 is not_satisfied|missing required conformance coverage for T1/);
    expect(published).toBe(false);
  });

  it("publishes advisory conformance reports and includes the matrix in evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "advisory-conformance.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "advisory-conformance" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: [
              "implementation",
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
            inputs: ["implementation", "conformance-report"],
            outputs: ["change-request"],
            conformance: {
              mode: "advisory",
              report: "conformance-report",
              required: ["FR-001", "SC-001"],
            },
          },
        ],
      },
    });

    let publishedBody = "";
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-advisory-conformance",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          await writeFile(
            join(attemptDirectory, "conformance-report.json"),
            JSON.stringify({
              version: 1,
              summary: "FR covered, SC needs manual verification.",
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
                  rationale: "manual browser check pending",
                },
              ],
              scopeDrift: [
                {
                  severity: "warning",
                  description: "Touched a neighboring helper.",
                  files: ["src/helper.ts"],
                },
              ],
            }),
            "utf8",
          );
          await writeJson(join(attemptDirectory, "artifact.json"), {
            version: 1,
            stageId: "implement",
            attempt: 1,
            outputs: [
              { id: "implementation", path: "implementation.md", mediaType: "text/markdown" },
              {
                id: "conformance-report",
                path: "conformance-report.json",
                mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
              },
            ],
          });
        },
        publishChange: async ({ evidencePath, body }) => {
          publishedBody = body;
          return { url: "https://example.test/pr/conformance", evidencePath };
        },
      },
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-advisory-conformance", "evidence.md"),
      "utf8",
    );
    for (const surface of [evidence, publishedBody]) {
      expect(surface).toContain("## Conformance");
      expect(surface).toContain("Policy: advisory; required: FR-001, SC-001");
      expect(surface).toContain("| FR-001 | satisfied | parser updated | src/parser.ts | pnpm test | implementation |");
      expect(surface).toContain("| SC-001 | not_verified | none | none | none | none | manual browser check pending |");
      expect(surface).toContain("warning unsatisfied-item: SC-001 is not_verified");
      expect(surface).toContain("warning scope-drift: Touched a neighboring helper.");
    }
  });

  it("treats an unsafe advisory conformance Artifact as an invalid report", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "unsafe-advisory-conformance.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "unsafe-advisory-conformance" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: [],
            outputs: [
              "implementation",
              {
                id: "conformance-report",
                type: "conformance.report",
                mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
              },
            ],
          },
          {
            id: "tamper",
            type: "agent",
            runtime: "mock",
            prompt: "Simulate post-publication storage tampering.",
            inputs: ["conformance-report"],
            outputs: ["tamper-marker"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: [
              "implementation",
              "conformance-report",
              "tamper-marker",
            ],
            outputs: ["change-request"],
            conformance: {
              mode: "advisory",
              report: "conformance-report",
              required: ["FR-001"],
            },
          },
        ],
      },
    });
    const outsidePath = join(repo, "outside-conformance.json");
    const outsideMarker = "outside-conformance-must-not-be-read";
    await writeJson(outsidePath, {
      summary: outsideMarker,
      items: [{ id: "FR-001", status: "satisfied" }],
    });
    let publishedBody = "";

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-unsafe-advisory-conformance",
        executeAgent: async ({ stage, attemptDirectory }) => {
          if (stage.id === "tamper") {
            const conformancePath = join(
              repo,
              ".nitely",
              "runs",
              "run-unsafe-advisory-conformance",
              "stages",
              "implement",
              "1",
              "conformance-report.json",
            );
            await rm(conformancePath);
            await link(outsidePath, conformancePath);
            await writeFile(
              join(attemptDirectory, "tamper-marker.md"),
              "tampered after publication\n",
              "utf8",
            );
            await writeJson(join(attemptDirectory, "artifact.json"), {
              version: 1,
              stageId: "tamper",
              attempt: 1,
              outputs: [
                {
                  id: "tamper-marker",
                  path: "tamper-marker.md",
                  mediaType: "text/markdown",
                },
              ],
            });
            return;
          }
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "done\n",
            "utf8",
          );
          await writeJson(
            join(attemptDirectory, "conformance-report.json"),
            {
              version: 1,
              items: [{ id: "FR-001", status: "satisfied" }],
            },
          );
          await writeJson(join(attemptDirectory, "artifact.json"), {
            version: 1,
            stageId: "implement",
            attempt: 1,
            outputs: [
              {
                id: "implementation",
                path: "implementation.md",
                mediaType: "text/markdown",
              },
              {
                id: "conformance-report",
                path: "conformance-report.json",
                mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
              },
            ],
          });
        },
        publishChange: async ({ evidencePath, body }) => {
          publishedBody = body;
          return { url: "https://example.test/pr/conformance", evidencePath };
        },
      },
    );

    expect(publishedBody).toContain("warning invalid-report");
    expect(publishedBody).toContain("Run-owned regular file");
    expect(publishedBody).not.toContain(outsideMarker);
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

  it("blocks before stages when a flow pre hook fails and records hook evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "flow-hook-blocks.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "flow-hook-blocks" },
      spec: {
        hooks: {
          preRun: [
            {
              id: "preflight",
              command: nodeEval("process.exit(2)"),
            },
          ],
        },
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
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-flow-hook-blocks" },
      ),
    ).rejects.toThrow(/flow preRun hook preflight blocked execution/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-flow-hook-blocks");
    store.close();
    expect(events.some((event) => event.type === "command.completed")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "hook.completed",
          payload: expect.objectContaining({
            hookId: "preflight",
            scope: "flow",
            phase: "preRun",
            onFailure: "block",
            status: "blocked",
            exitCode: 2,
          }),
        }),
        expect.objectContaining({
          type: "run.failed",
          payload: expect.objectContaining({
            hookPhase: "preRun",
          }),
        }),
      ]),
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-flow-hook-blocks", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Hooks");
    expect(evidence).toContain("- preflight: flow preRun");
    expect(evidence).toContain("Status: blocked");
    expect(evidence).toContain("On failure: block");
  });

  it("continues after warning hooks and records stage post plus flow post hooks", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "hook-evidence.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "hook-evidence" },
      spec: {
        hooks: {
          postRun: [
            {
              id: "postrun",
              command: nodeEval("process.stdout.write('flow post')"),
              onFailure: "evidence-only",
            },
          ],
        },
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["test-report"],
            hooks: {
              pre: [
                {
                  id: "precheck",
                  command: nodeEval("process.exit(3)"),
                  onFailure: "warn",
                },
              ],
              post: [
                {
                  id: "postcheck",
                  command: nodeEval("process.stdout.write('stage post')"),
                },
              ],
            },
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-hook-evidence" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-hook-evidence");
    store.close();
    const hookPayloads = events
      .filter((event) => event.type === "hook.completed")
      .map((event) => event.payload as Record<string, unknown>);
    expect(hookPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "precheck",
          scope: "stage",
          phase: "pre",
          status: "warned",
          exitCode: 3,
        }),
        expect.objectContaining({
          hookId: "postcheck",
          scope: "stage",
          phase: "post",
          status: "passed",
          exitCode: 0,
        }),
        expect.objectContaining({
          hookId: "postrun",
          scope: "flow",
          phase: "postRun",
          status: "passed",
          onFailure: "evidence-only",
          exitCode: 0,
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run.completed" }),
      ]),
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-hook-evidence", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Hooks");
    expect(evidence).toContain("- precheck: stage pre");
    expect(evidence).toContain("Status: warned");
    expect(evidence).toContain("- postcheck: stage post");
    expect(evidence).toContain("- postrun: flow postRun");
    expect(evidence).toContain("Hook: precheck (stage pre)");
  });

  it("fails a command stage when timeouts.commandMs expires", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "command-timeout-controls.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-timeout-controls" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`,
            timeouts: { commandMs: 25 },
            maxAttempts: 1,
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-command-timeout-controls" },
      ),
    ).rejects.toThrow(/command failed after 1 of 1 attempts/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-command-timeout-controls");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.timeout",
          stageId: "test",
          attempt: 1,
          payload: expect.objectContaining({
            kind: "commandMs",
            timeoutMs: 25,
          }),
        }),
        expect.objectContaining({
          type: "command.completed",
          payload: expect.objectContaining({
            timeoutMs: 25,
            timeoutReason: "command timed out after 25ms",
          }),
        }),
      ]),
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-command-timeout-controls", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Stage Timeouts");
    expect(evidence).toContain("- test (command)");
    expect(evidence).toContain("Command: 25ms");
  });

  it.skipIf(process.platform !== "linux")(
    "cancels an active command stage through the run cancellation signal",
    async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "command-cancellation.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-cancellation" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: nodeEval(
              [
                "const { writeFileSync } = require('node:fs');",
                "const { join } = require('node:path');",
                "writeFileSync(join(process.env.NITELY_ATTEMPT_DIR, 'command-started'), 'started');",
                "setTimeout(() => {}, 5000);",
              ].join(" "),
            ),
            maxAttempts: 1,
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const controller = new AbortController();
    const request = {
      actor: "local",
      reason: "operator requested stop",
      requestedAt: "2026-07-18T00:00:00.000Z",
      source: "test",
    };
    const execution = runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-command-cancelled",
        cancellation: {
          signal: controller.signal,
          getRequest: () => request,
        },
      },
    );
    const startedPath = join(
      repo,
      ".nitely",
      "runs",
      "run-command-cancelled",
      "stages",
      "test",
      "1",
      "command-started",
    );

    await waitForFile(startedPath);
    controller.abort(request);

    await expect(execution).rejects.toThrow(/operator requested stop|run cancelled/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-command-cancelled");
    store.close();
    expect(projectRun(events).status).toBe("cancelled");
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "run.cancelled")).toEqual([
      expect.objectContaining({
        stageId: "test",
        attempt: 1,
        payload: expect.objectContaining({
          actor: "local",
          reason: "operator requested stop",
          requestedAt: "2026-07-18T00:00:00.000Z",
          affectedStage: "test",
          affectedAttempt: 1,
          cleanup: expect.objectContaining({
            reason: "cancelled",
            signal: "SIGTERM",
          }),
        }),
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command.completed",
          stageId: "test",
          attempt: 1,
          payload: expect.objectContaining({
            exitCode: 130,
            cancellation: expect.objectContaining({
              reason: "cancelled",
            }),
          }),
        }),
      ]),
    );
    },
  );

  it("records command environment repairs in events, preflight, and evidence", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cmd-env-repair.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cmd-env-repair" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "python --version",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const repair = {
      id: "python-to-python3-compatibility-shim",
      description:
        "Added a python compatibility shim that delegates to python3 because python was unavailable.",
      scope: "outside-worktree" as const,
      path: join(tmpdir(), "nitely-python-compat-test"),
    };
    const backend: ExecutionBackend = {
      async createWorkspace({ runId, branchName, worktreePath }) {
        await git(repo, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
        return { runId, path: worktreePath };
      },
      async runAgent() {
        throw new Error("agent should not run");
      },
      async runCommand() {
        return {
          stdout: "Python 3.12.0\n",
          stderr: "",
          exitCode: 0,
          environmentRepairs: [repair],
        };
      },
      async commitAll() {
        return { committed: false };
      },
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-cmd-env-repair", backend },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-cmd-env-repair");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cmd-env-repair");
    store.close();
    const completed = events.find((event) => event.type === "command.completed");
    expect(completed?.payload).toMatchObject({
      environmentRepairs: [repair],
    });
    const preflight = JSON.parse(
      await readFile(join(runDirectory, "toolchain-preflight.json"), "utf8"),
    );
    expect(preflight.commandEnvironment.repairs).toEqual([repair]);
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Toolchain Preflight");
    expect(evidence).toContain("Environment repairs: Added a python compatibility shim");
    expect(evidence).toContain("scope outside-worktree");
    expect(evidence).toContain(repair.path);
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

    let store = new EventStore(join(repo, ".nitely", "events.db"));
    let events = store.list("run-approval-evidence");
    store.close();
    expect(projectRun(events)).toMatchObject({
      status: "awaiting-approval",
      approvals: [
        {
          id: "approve-plan-1",
          stageId: "approve-plan",
          attempt: 1,
          status: "pending",
          prompt: "Approve the plan",
        },
      ],
    });
    expect(events.some((event) => event.type === "approval.resolved")).toBe(false);

    await resolveApproval({
      repoPath: repo,
      runId: "run-approval-evidence",
      approvalId: "approve-plan-1",
      decision: "approved",
      actor: "human:test",
    });
    await resumeRun({ repoPath: repo, runId: "run-approval-evidence" });

    store = new EventStore(join(repo, ".nitely", "events.db"));
    events = store.list("run-approval-evidence");
    store.close();
    const resolved = events.find((event) => event.type === "approval.resolved");
    const payload = resolved?.payload as Record<string, unknown>;
    expect(payload.actor).toBe("human:test");
    expect(payload.decision).toBe("approved");
    expect(payload.reviewedArtifactIds).toEqual(["site-plan"]);
  });

  it("pauses at an approval stage and does not start downstream stages", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "approval-pause.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "approval-pause" },
      spec: {
        stages: [
          {
            id: "approve-release",
            type: "approval",
            prompt: "Approve release",
            timeouts: { pauseMs: 60_000 },
            inputs: [],
            outputs: [],
          },
          {
            id: "after-approval",
            type: "command",
            command: "printf after",
            inputs: [],
            outputs: ["after"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-approval-pause" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-approval-pause");
    const projection = projectRun(events);
    store.close();

    expect(projection.status).toBe("awaiting-approval");
    expect(projection.completedStages).toEqual([]);
    expect(projection.approvals).toEqual([
      expect.objectContaining({
        id: "approve-release-1",
        stageId: "approve-release",
        status: "pending",
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "stage.started" && event.stageId === "after-approval",
      ),
    ).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval.requested",
          stageId: "approve-release",
          payload: expect.objectContaining({
            pauseTimeoutMs: 60_000,
          }),
        }),
      ]),
    );
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-approval-pause", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Stage Timeouts");
    expect(evidence).toContain("- approve-release (approval)");
    expect(evidence).toContain("Pause: 60000ms");
  });

  it("fails a resumed run when the pending approval is denied", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "approval-deny.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "approval-deny" },
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
            command: "printf after",
            inputs: [],
            outputs: ["after"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-approval-deny" },
    );
    await resolveApproval({
      repoPath: repo,
      runId: "run-approval-deny",
      approvalId: "approve-release-1",
      decision: "denied",
      actor: "human:test",
    });

    await expect(
      resumeRun({ repoPath: repo, runId: "run-approval-deny" }),
    ).rejects.toThrow(/approval approve-release-1 denied/i);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-approval-deny");
    const projection = projectRun(events);
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.stages.find((stage) => stage.stageId === "approve-release")).toMatchObject({
      status: "failed",
      attempts: [{ attempt: 1, status: "failed" }],
    });
    expect(
      events.some(
        (event) =>
          event.type === "stage.started" && event.stageId === "after-approval",
      ),
    ).toBe(false);
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
    await resolveApproval({
      repoPath: repo,
      runId: "run-gate",
      approvalId: "approve-plan-1",
      decision: "approved",
      actor: "human:test",
    });
    await resumeRun({ repoPath: repo, runId: "run-gate" });

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
      gate: { gateId: "approve-plan", state: "approved", actor: "human:test" },
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

  it("passes supported security findings before running the fix agent", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "security"), { recursive: true });
    await writeFile(
      join(repo, "security", "finding.md"),
      "Path traversal in src/web/server.ts allows ../ segments to escape the upload root.",
      "utf8",
    );
    const flowPath = join(repo, "flows", "security-gate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "security-gate" },
      spec: {
        stages: [
          {
            id: "triage",
            type: "gate",
            mode: "security",
            inputs: ["finding"],
            outputs: ["security-assessment"],
          },
          {
            id: "fix",
            type: "agent",
            runtime: "mock",
            prompt: "Fix the supported finding.",
            inputs: ["finding", "security-assessment"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    let agentRan = false;
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { finding: { connector: "local-file", uri: "security/finding.md" } },
      },
      {
        createRunId: () => "run-security-supported",
        executeAgent: async ({ attemptDirectory }) => {
          agentRan = true;
          await writeFile(join(attemptDirectory, "implementation.md"), "fixed\n", "utf8");
        },
      },
    );

    expect(agentRan).toBe(true);
    const runDirectory = join(repo, ".nitely", "runs", "run-security-supported");
    const report = await readFile(
      join(runDirectory, "stages", "triage", "1", "security-assessment.md"),
      "utf8",
    );
    expect(report).toContain("Validation result: supported");
    expect(report).toContain("Class: path-traversal");
    expect(report).toContain("- src/web/server.ts");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-security-supported"));
    store.close();
    expect(projection.gates).toEqual([
      expect.objectContaining({
        mode: "security",
        status: "passed",
      }),
    ]);
    expect(projection.completedStages).toContain("fix");
  });

  it("fails unsupported security findings before code changes", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "security"), { recursive: true });
    await writeFile(
      join(repo, "security", "finding.md"),
      "TLS cipher preference in load balancer infrastructure config.",
      "utf8",
    );
    const flowPath = join(repo, "flows", "security-gate-unsupported.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "security-gate-unsupported" },
      spec: {
        stages: [
          {
            id: "triage",
            type: "gate",
            mode: "security",
            inputs: ["finding"],
            outputs: ["security-assessment"],
          },
          {
            id: "fix",
            type: "agent",
            runtime: "mock",
            prompt: "Fix the supported finding.",
            inputs: ["finding", "security-assessment"],
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
          inputs: { finding: { connector: "local-file", uri: "security/finding.md" } },
        },
        {
          createRunId: () => "run-security-unsupported",
          executeAgent: async () => {
            agentRan = true;
          },
        },
      ),
    ).rejects.toThrow(/does not match supported classes/);

    expect(agentRan).toBe(false);
    const runDirectory = join(repo, ".nitely", "runs", "run-security-unsupported");
    const report = await readFile(
      join(runDirectory, "stages", "triage", "1", "security-assessment.md"),
      "utf8",
    );
    expect(report).toContain("Validation result: unsupported");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-security-unsupported"));
    store.close();
    expect(projection.gates).toEqual([
      expect.objectContaining({
        mode: "security",
        status: "failed",
      }),
    ]);
    expect(projection.completedStages).not.toContain("fix");
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
          await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
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
          content: "Review verdict: pass\n",
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
              content: "Review verdict: pass\n",
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

  it("resumes a blocked review gate with a passing operator verdict without rerunning agents", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Implement the change", "utf8");
    const flowPath = join(repo, "flows", "operator-review-pass.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "operator-review-pass" },
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
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["review-gate"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const runtimeStages: string[] = [];
    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            spec: { connector: "local-file", uri: "specs/change.md" },
          },
        },
        {
          createRunId: () => "run-operator-review-pass",
          backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
            runtimeStages.push(stage.id);
            if (stage.id === "implement") {
              await writeFile(
                join(attemptDirectory, "implementation.md"),
                "Implemented and tested\n",
                "utf8",
              );
              return { stdout: "implemented\n", stderr: "" };
            }
            throw Object.assign(new Error("codex exited with code 1"), {
              stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage review/);

    await submitOperatorReview({
      repoPath: repo,
      runId: "run-operator-review-pass",
      actor: "qualified-reviewer@example.test",
      content: "Review verdict: pass\nReason: implementation and tests verified",
      reviewedArtifactIds: ["implementation"],
    });

    let published = 0;
    const result = await resumeRun(
      { repoPath: repo, runId: "run-operator-review-pass" },
      {
        backend: backendWithAgent(repo, async (_workspace, { stage }) => {
          runtimeStages.push(stage.id);
          throw new Error(`agent must not rerun during operator review resume: ${stage.id}`);
        }),
        publishChange: async ({ evidencePath }) => {
          published += 1;
          return {
            url: "https://example.test/pr/operator-review",
            evidencePath,
          };
        },
      },
    );

    expect(result.changeRequestUrl).toBe(
      "https://example.test/pr/operator-review",
    );
    expect(runtimeStages).toEqual(["implement", "review"]);
    expect(published).toBe(1);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-operator-review-pass");
    const projection = projectRun(events);
    store.close();
    expect(
      events.filter(
        (event) => event.type === "stage.started" && event.stageId === "review",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "operator.review.resolved",
        stageId: "review",
        attempt: 1,
        payload: expect.objectContaining({ resolution: "blocker_overridden" }),
      }),
    );
    expect(projection).toMatchObject({
      status: "completed",
      completedStages: ["implement", "review", "publish"],
      changeRequestUrl: "https://example.test/pr/operator-review",
    });
    expect(projection.gates).toEqual([
      expect.objectContaining({
        stageId: "review",
        status: "passed",
        runtime: "operator",
        attempt: 1,
        operatorReview: expect.objectContaining({
          actor: "qualified-reviewer@example.test",
        }),
      }),
    ]);
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-operator-review-pass", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain(
      "Review source: operator (qualified-reviewer@example.test)",
    );
    expect(evidence).toContain("Source blocker: agent_usage_limit on review");
    const runDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run-operator-review-pass",
    );
    const registry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(registry.artifacts).toContainEqual(
      expect.objectContaining({
        id: "review-gate",
        producer: "review",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdByRunId: "run-operator-review-pass",
        stageId: "review",
        attempt: 1,
      }),
    );
    const manifest = JSON.parse(
      await readFile(join(runDirectory, "context-manifest.json"), "utf8"),
    ) as { entries: Array<Record<string, unknown>> };
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        id: "review-gate",
        kind: "generated-artifact",
        runRelativePath: "stages/review/1/review-gate.json",
      }),
    );
  });

  it("rejects a replaced operator-review gate artifact on resume", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "operator-review-replaced.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "operator-review-replaced" },
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
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-operator-review-replaced",
          backend: backendWithAgent(
            repo,
            async (_workspace, { stage, attemptDirectory }) => {
              if (stage.id === "implement") {
                await writeFile(
                  join(attemptDirectory, "implementation.md"),
                  "Implemented\n",
                  "utf8",
                );
                return { stdout: "implemented\n", stderr: "" };
              }
              throw Object.assign(new Error("codex exited with code 1"), {
                stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
              });
            },
          ),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage review/);

    await submitOperatorReview({
      repoPath: repo,
      runId: "run-operator-review-replaced",
      actor: "qualified-reviewer@example.test",
      content: "Review verdict: pass\nReason: verified",
      reviewedArtifactIds: ["implementation"],
    });
    const gatePath = join(
      repo,
      ".nitely",
      "runs",
      "run-operator-review-replaced",
      "stages",
      "review",
      "1",
      "review-gate.json",
    );
    await rm(gatePath);
    await writeJson(gatePath, { tampered: true });
    expect((await stat(gatePath)).nlink).toBe(1);

    await expect(
      resumeRun(
        { repoPath: repo, runId: "run-operator-review-replaced" },
        {
          backend: backendWithAgent(repo, async (_workspace, { stage }) => {
            throw new Error(`resume must not run an agent: ${stage.id}`);
          }),
        },
      ),
    ).rejects.toThrow(/review-gate.*(sha256|size) does not match/i);
  });

  it("fails before publish when a blocked review gate receives a failing operator verdict", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "change.md"), "Review me", "utf8");
    const flowPath = join(repo, "flows", "operator-review-fail.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "operator-review-fail" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: ["implementation"],
            outputs: ["review-gate"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["review-gate"],
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
          inputs: {
            implementation: { connector: "local-file", uri: "change.md" },
          },
        },
        {
          createRunId: () => "run-operator-review-fail",
          backend: backendWithAgent(repo, async () => {
            throw Object.assign(new Error("codex missing"), {
              stderr: "Unable to start agent runtime codex: ENOENT",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_runtime_unavailable/);

    await submitOperatorReview({
      repoPath: repo,
      runId: "run-operator-review-fail",
      actor: "reviewer",
      content: "Review verdict: fail\nReason: P0 data-loss risk remains",
      reviewedArtifactIds: ["implementation"],
    });
    let published = false;
    await expect(
      resumeRun(
        { repoPath: repo, runId: "run-operator-review-fail" },
        {
          backend: backendWithAgent(repo, async () => {
            throw new Error("review runtime must not rerun");
          }),
          publishChange: async ({ evidencePath }) => {
            published = true;
            return { url: "https://example.test/pr/must-not-publish", evidencePath };
          },
        },
      ),
    ).rejects.toThrow(/operator review reported a failing verdict/);
    expect(published).toBe(false);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-operator-review-fail");
    const projection = projectRun(events);
    store.close();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "operator.review.resolved",
        payload: expect.objectContaining({ resolution: "review_failed" }),
      }),
    );
    expect(projection.status).toBe("failed");
    expect(projection.changeRequestUrl).toBeUndefined();
    expect(projection.stages.find((stage) => stage.stageId === "publish")).toBeUndefined();
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
          await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
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
        await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
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

  it("routes needs_fix review verdicts back to implementation rework", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-needs-fix.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-needs-fix" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
            maxAttempts: 2,
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review.",
            inputs: ["implementation"],
            outputs: ["review"],
            maxAttempts: 2,
          },
        ],
      },
    });
    const implementPrompts: string[] = [];
    let implementAttempts = 0;
    let reviewAttempts = 0;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-review-needs-fix",
        executeAgent: async ({ stage, prompt, attemptDirectory, worktreePath }) => {
          if (stage.id === "implement") {
            implementAttempts += 1;
            implementPrompts.push(prompt);
            const content = implementAttempts === 1 ? "broken\n" : "fixed\n";
            await writeFile(join(worktreePath, "feature.txt"), content, "utf8");
            await writeFile(join(attemptDirectory, "implementation.md"), content, "utf8");
            return;
          }
          reviewAttempts += 1;
          await writeFile(
            join(attemptDirectory, "review.md"),
            reviewAttempts === 1
              ? [
                  "Review verdict: needs_fix",
                  "Target artifact: implementation",
                  "Reason: implementation misses the fixed behavior",
                  "Instructions: update feature.txt to contain fixed",
                  "feature.txt:1: expected fixed content",
                  "",
                ].join("\n")
              : "Review verdict: approved\n",
            "utf8",
          );
        },
      },
    );

    expect(implementAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);
    expect(implementPrompts[1]).toContain("update feature.txt to contain fixed");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-needs-fix");
    const projection = projectRun(events);
    store.close();
    expect(projection.status).toBe("completed");
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "review",
          action: "rework",
          targetStage: "implement",
          targetArtifact: "implementation",
          reworkRequest: expect.objectContaining({
            instructions: "update feature.txt to contain fixed",
            specificIssues: [
              {
                file: "feature.txt",
                line: 1,
                problem: "expected fixed content",
              },
            ],
          }),
        }),
      ]),
    );
    expect(projection.gates[0]?.reviewOutput?.verdict).toMatchObject({
      verdict: "needs_fix",
      targetArtifact: "implementation",
    });
  });

  it("routes needs_rework_spec review verdicts back to an upstream planning stage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-needs-spec-rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-needs-spec-rework" },
      spec: {
        stages: [
          {
            id: "plan",
            type: "agent",
            runtime: "codex",
            prompt: "Plan.",
            inputs: [],
            outputs: ["spec"],
            maxAttempts: 2,
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement.",
            inputs: ["spec"],
            outputs: ["implementation"],
            maxAttempts: 2,
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review.",
            inputs: ["implementation"],
            outputs: ["review"],
            maxAttempts: 2,
          },
        ],
      },
    });
    const planPrompts: string[] = [];
    let planAttempts = 0;
    let implementAttempts = 0;
    let reviewAttempts = 0;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-review-needs-spec-rework",
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          if (stage.id === "plan") {
            planAttempts += 1;
            planPrompts.push(prompt);
            await writeFile(
              join(attemptDirectory, "spec.md"),
              planAttempts === 1 ? "vague spec\n" : "specific spec\n",
              "utf8",
            );
            return;
          }
          if (stage.id === "implement") {
            implementAttempts += 1;
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              `implementation ${implementAttempts}\n`,
              "utf8",
            );
            return;
          }
          reviewAttempts += 1;
          await writeFile(
            join(attemptDirectory, "review.md"),
            reviewAttempts === 1
              ? [
                  "Verdict: needs_rework_spec",
                  "Target stage: plan",
                  "Reason: acceptance criteria are ambiguous",
                  "Instructions: add concrete acceptance checks",
                  "",
                ].join("\n")
              : "Verdict: approved\n",
            "utf8",
          );
        },
      },
    );

    expect(planAttempts).toBe(2);
    expect(implementAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);
    expect(planPrompts[1]).toContain("add concrete acceptance checks");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-needs-spec-rework"));
    store.close();
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "review",
          action: "rework",
          targetStage: "plan",
          reworkRequest: expect.objectContaining({
            targetStage: "plan",
            instructions: "add concrete acceptance checks",
          }),
        }),
      ]),
    );
  });

  it("escalates review verdicts without retrying or reworking", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-escalate.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-escalate" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review.",
            inputs: [],
            outputs: ["review"],
            maxAttempts: 2,
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-escalate",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(
              join(attemptDirectory, "review.md"),
              "Verdict: escalate\nReason: human product decision required\n",
              "utf8",
            );
          },
        },
      ),
    ).rejects.toThrow(/escalated: human product decision required/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-escalate");
    const projection = projectRun(events);
    store.close();
    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(events.map((event) => event.type)).not.toContain(
      "stage.rework.requested",
    );
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "review",
      action: "escalate",
      reason: "human product decision required",
    });
  });

  it("runs an alwaysRun reflection finalizer after a review gate blocker", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-blocker-reflect-finalizer.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-blocker-reflect-finalizer" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review implementation.",
            inputs: ["implementation"],
            outputs: ["review"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "review"],
            outputs: ["change-request"],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt: "Reflect on review failure.",
            inputs: ["implementation", "review", "change-request"],
            outputs: ["reflection"],
          },
        ],
      },
    });

    let reflectionPrompt = "";
    let publishCalled = false;
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-review-blocker-reflect-finalizer",
          executeAgent: async ({ stage, attemptDirectory, prompt }) => {
            if (stage.id === "implement") {
              await writeFile(join(attemptDirectory, "implementation.md"), "implemented\n", "utf8");
              return;
            }
            if (stage.id === "review") {
              await writeFile(
                join(attemptDirectory, "review.md"),
                "Review verdict: fail\n\nP1: missing regression test.\n",
                "utf8",
              );
              return;
            }
            reflectionPrompt = prompt;
            await writeFile(
              join(attemptDirectory, "reflection.md"),
              [
                "Review blocked publish.",
                "",
                "```context-kg",
                JSON.stringify([
                  {
                    category: "feedback",
                    title: "Review blockers require regression tests",
                    body: "When review blocks publish for missing regression tests, future implementation runs should add the regression test before retrying publish.",
                    keywords: ["review", "regression test"],
                  },
                ]),
                "```",
                "",
              ].join("\n"),
              "utf8",
            );
          },
          publishChange: async () => {
            publishCalled = true;
            throw new Error("publish should not run after a blocking review gate");
          },
        },
      ),
    ).rejects.toThrow(/gate failed after 1 of 1 attempts/);

    expect(publishCalled).toBe(false);
    expect(reflectionPrompt).toContain("Terminal status: failed");
    expect(reflectionPrompt).toContain("Stage: review");
    expect(reflectionPrompt).toContain("Artifact: review");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-review-blocker-reflect-finalizer"));
    store.close();
    expect(projection.status).toBe("failed");
    expect(projection.completedStages).toEqual(["implement", "reflect"]);
    expect(projection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reflection", producer: "reflect" }),
      ]),
    );
    await expect(listContextKnowledgeEntries(repo)).resolves.toEqual([
      expect.objectContaining({
        category: "feedback",
        title: "Review blockers require regression tests",
        status: "proposed",
        keywords: ["review", "regression test"],
        source: {
          type: "reflection",
          runId: "run-review-blocker-reflect-finalizer",
        },
        linkedRunIds: ["run-review-blocker-reflect-finalizer"],
      }),
    ]);
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
    ).rejects.toThrow(
      /escalated: review verdict fail did not identify a legal rework target/,
    );

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

  it("fails closed when review gate output has findings but no recognized pass/fail verdict", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-p2-without-verdict.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-p2-without-verdict" },
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
          createRunId: () => "run-review-gate-p2-without-verdict",
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
      ),
    ).rejects.toThrow(/must contain a recognized pass\/fail verdict/);

    expect(publishCalled).toBe(false);
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
            timeouts: { gateMs: 25 },
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
    const events = store.list("run-deterministic-gate-timeout");
    const projection = projectRun(events);
    store.close();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.timeout",
          stageId: "verify",
          attempt: 1,
          payload: expect.objectContaining({
            kind: "gateMs",
            timeoutMs: 25,
          }),
        }),
        expect.objectContaining({
          type: "command.completed",
          payload: expect.objectContaining({
            timeoutMs: 25,
            timeoutReason: "gate timed out after 25ms",
          }),
        }),
      ]),
    );
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
      metadata: { name: "work-item", workItemType: "dev.pr" },
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
        workItemType: "dev.pr",
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
    expect(record).toContain('"workItemType": "dev.pr"');
  });

  it("persists run eligibility override evidence in events and run metadata", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "eligibility-override.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "eligibility-override" },
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
    const runEligibilityOverride = {
      actor: "operator",
      reason: "accepted dependency risk",
      acceptedReasonCodes: ["dependency.incomplete:upstream"],
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: {},
        workItemId: "wi-override",
        runEligibilityOverride,
      },
      { createRunId: () => "run-eligibility-override" },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const created = store
      .list("run-eligibility-override")
      .find((event) => event.type === "run.created");
    store.close();
    expect(created?.payload).toMatchObject({ runEligibilityOverride });

    const runRecord = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-eligibility-override", "run.json"),
        "utf8",
      ),
    ) as { runEligibilityOverride?: unknown };
    expect(runRecord.runEligibilityOverride).toEqual(runEligibilityOverride);
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

  it("pins the Codex sandbox over a conflicting provider environment", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "pinned-codex-sandbox.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "pinned-codex-sandbox" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement with the pinned sandbox.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const runtimeCommand = join(repo, "capture-codex-runtime.sh");
    await writeFile(
      runtimeCommand,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$NITELY_ATTEMPT_DIR/codex-args.txt\"",
        "printf 'done\\n' > \"$NITELY_ATTEMPT_DIR/implementation.md\"",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(runtimeCommand, 0o755);
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({
        NITELY_CODEX_COMMAND: runtimeCommand,
        NITELY_CODEX_SANDBOX: "danger-full-access",
      }),
      listStatuses: async () => [],
    };

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        sandboxPolicy: { codex: "read-only" },
        inputs: {},
      },
      {
        createRunId: () => "run-pinned-codex-sandbox",
        providerStore,
      },
    );

    const attemptDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run-pinned-codex-sandbox",
      "stages",
      "implement",
      "1",
    );
    await expect(readFile(join(attemptDirectory, "codex-args.txt"), "utf8"))
      .resolves.toContain("--sandbox\nread-only\n");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-pinned-codex-sandbox"));
    store.close();
    expect(projection.sandboxPolicy).toEqual({ codex: "read-only" });
    const reproducibility = JSON.parse(
      await readFile(
        join(
          repo,
          ".nitely",
          "runs",
          "run-pinned-codex-sandbox",
          "reproducibility.json",
        ),
        "utf8",
      ),
    ) as { environment?: { sandboxPolicy?: unknown } };
    expect(reproducibility.environment?.sandboxPolicy).toEqual({
      codex: "read-only",
    });
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
            id: "package",
            type: "command",
            command: "printf always-fails >&2; exit 9",
            maxAttempts: 2,
            inputs: [],
            outputs: ["package-report"],
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
      readFile(join(runDirectory, "stages", "package", "1", "stderr.log"), "utf8"),
    ).resolves.toBe("always-fails");
    await expect(
      readFile(join(runDirectory, "stages", "package", "2", "stderr.log"), "utf8"),
    ).resolves.toBe("always-fails");
    await expect(
      readFile(join(runDirectory, "stages", "package", "3", "stderr.log"), "utf8"),
    ).rejects.toThrow();

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list("run-retry-exhausted"));
    store.close();

    expect(projection).toMatchObject({
      status: "failed",
      stages: [
        {
          stageId: "package",
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

  it("fails deterministically when structured rework targets a downstream stage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "downstream-rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "downstream-rework" },
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
          {
            id: "test",
            type: "command",
            command: "printf failed >&2; exit 5",
            inputs: ["implementation"],
            outputs: ["test-report"],
            maxAttempts: 2,
          },
          {
            id: "publish",
            type: "command",
            command: "true",
            inputs: ["test-report"],
            outputs: ["published"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-downstream-rework",
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
          },
          recommendOrchestration: ({ stage }) =>
            stage.id === "test"
              ? {
                  action: "rework",
                  targetStage: "publish",
                  reason: "incorrectly tries to repair a downstream publish step",
                }
              : undefined,
        },
      ),
    ).rejects.toThrow(/invalid rework target stage: publish/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-downstream-rework");
    const projection = projectRun(events);
    store.close();

    expect(events.map((event) => event.type)).not.toContain("stage.retrying");
    expect(events.map((event) => event.type)).not.toContain(
      "stage.rework.requested",
    );
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "test",
      action: "fail",
      reason: "invalid rework target stage: publish",
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
        recommendOrchestration: ({ stage }) =>
          stage.id === "test"
            ? {
                action: "rework",
                targetStage: "implement",
                targetArtifact: "implementation",
                reason: "verification found a broken implementation",
                instructions: "Write the fixed implementation before rerunning verification.",
                context: "grep fixed feature.txt failed",
                specificIssues: [
                  {
                    file: "feature.txt",
                    line: 1,
                    problem: "expected fixed content",
                  },
                ],
              }
            : undefined,
      },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Previous Failure Context");
    expect(prompts[1]).toContain("downstream stage test requested rework");
    expect(prompts[1]).toContain(
      "Write the fixed implementation before rerunning verification.",
    );

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
    expect(events[reworkRequestedIndex]?.payload).toMatchObject({
      targetStage: "implement",
      targetArtifact: "implementation",
      reason: "verification found a broken implementation",
      reworkRequest: {
        targetStage: "implement",
        targetArtifact: "implementation",
        reason: "verification found a broken implementation",
        instructions: "Write the fixed implementation before rerunning verification.",
        context: "grep fixed feature.txt failed",
        specificIssues: [
          {
            file: "feature.txt",
            line: 1,
            problem: "expected fixed content",
          },
        ],
        sourceStage: "test",
        sourceAttempt: 1,
      },
    });
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "test",
          stageType: "command",
          attempt: 1,
          maxAttempts: 2,
          action: "rework",
          targetStage: "implement",
          targetArtifact: "implementation",
          reworkRequest: expect.objectContaining({
            targetStage: "implement",
            instructions: "Write the fixed implementation before rerunning verification.",
          }),
        }),
      ]),
    );
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-valid-rework", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain(
      "rework - verification found a broken implementation",
    );
    expect(evidence).toContain("stage implement");
    expect(evidence).toContain("artifact implementation");
    expect(evidence).toContain(
      "instructions Write the fixed implementation before rerunning verification.",
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

  it.skipIf(process.platform !== "linux")(
    "fails closed on a synthetic A-B rework loop before unbounded cost",
    async () => {
      const repo = await createRepo();
      const flowPath = join(repo, "flows", "rework-oscillation.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "rework-oscillation" },
        spec: {
          stages: [
            {
              id: "A",
              type: "agent",
              runtime: "mock",
              prompt: "Implement the change.",
              inputs: [],
              outputs: ["implementation"],
              maxAttempts: 12,
            },
            {
              id: "B",
              type: "command",
              command: "grep fixed feature.txt",
              inputs: ["implementation"],
              outputs: ["test-report"],
              maxAttempts: 12,
            },
          ],
        },
      });
      let implementCalls = 0;

      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          {
            createRunId: () => "run-rework-oscillation",
            executeAgent: async ({ attemptDirectory, worktreePath }) => {
              implementCalls += 1;
              await writeFile(join(worktreePath, "feature.txt"), "broken\n", "utf8");
              await writeFile(
                join(attemptDirectory, "implementation.md"),
                "broken\n",
                "utf8",
              );
            },
            recommendOrchestration: ({ stage }) =>
              stage.id === "B"
                ? {
                    action: "rework",
                    targetStage: "A",
                    targetArtifact: "implementation",
                    reason: "B requested rework of A",
                  }
                : undefined,
          },
        ),
      ).rejects.toThrow(
        /rework oscillation: B→A repeated 3 times in window 3/,
      );

      expect(implementCalls).toBe(3);
      expect(implementCalls).toBeLessThan(12);

      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list("run-rework-oscillation");
      const projection = projectRun(events);
      store.close();

      expect(
        events.filter((event) => event.type === "stage.rework.requested"),
      ).toHaveLength(2);
      const failedDecision = events.find(
        (event) =>
          event.type === "orchestrator.decision" &&
          (event.payload as { action?: string }).action === "fail",
      );
      expect(failedDecision?.payload).toMatchObject({
        action: "fail",
        reason: "rework oscillation: B→A repeated 3 times in window 3",
        oscillation: {
          from: "B",
          to: "A",
          count: 3,
          window: 3,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: {
          stageId: "B",
          error: "rework oscillation: B→A repeated 3 times in window 3",
          oscillation: {
            from: "B",
            to: "A",
            count: 3,
            window: 3,
          },
        },
      });
      expect(projection.status).toBe("failed");
      expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
        action: "fail",
        oscillation: { from: "B", to: "A", count: 3, window: 3 },
      });
    },
  );

  it("diagnoses verification failures and routes high-confidence implementation rework", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "verification-diagnosis-implementation.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "verification-diagnosis-implementation" },
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
            id: "verify",
            type: "command",
            command: "grep fixed feature.txt",
            inputs: ["implementation"],
            outputs: [
              {
                id: "verification-report",
                type: "verification.report",
                description: "Verification result",
                mediaType: "text/markdown",
              },
            ],
            maxAttempts: 2,
          },
        ],
      },
    });
    const prompts: string[] = [];

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-verification-diagnosis-implementation",
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
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-verification-diagnosis-implementation");
    const projection = projectRun(events);
    store.close();

    const failedIndex = events.findIndex((event) => event.type === "stage.failed");
    const diagnosisIndex = events.findIndex(
      (event) => event.type === "verification.failure.diagnosed",
    );
    const decisionIndex = events.findIndex(
      (event) =>
        event.type === "orchestrator.decision" &&
        (event.payload as { action?: string }).action === "rework",
    );
    const requestedIndex = events.findIndex(
      (event) => event.type === "stage.rework.requested",
    );
    expect(failedIndex).toBeGreaterThan(-1);
    expect(diagnosisIndex).toBeGreaterThan(failedIndex);
    expect(decisionIndex).toBeGreaterThan(diagnosisIndex);
    expect(requestedIndex).toBeGreaterThan(decisionIndex);
    expect(events[diagnosisIndex]?.payload).toMatchObject({
      stageId: "verify",
      stageType: "command",
      attempt: 1,
      maxAttempts: 2,
      classification: "implementation",
      confidence: "high",
      targetStage: "implement",
      targetArtifact: "implementation",
      recommendedAction: "rework",
    });
    expect(projection.verificationDiagnoses).toEqual([
      expect.objectContaining({
        stageId: "verify",
        classification: "implementation",
        confidence: "high",
        targetStage: "implement",
        targetArtifact: "implementation",
      }),
    ]);
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "verify",
          stageType: "command",
          attempt: 1,
          maxAttempts: 2,
          action: "rework",
          targetStage: "implement",
          targetArtifact: "implementation",
          reworkRequest: expect.objectContaining({
            targetStage: "implement",
            targetArtifact: "implementation",
            instructions: expect.stringContaining("Fix implementation artifact"),
          }),
        }),
      ]),
    );
    expect(projection).toMatchObject({
      status: "completed",
      completedStages: ["implement", "verify"],
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
          stageId: "verify",
          status: "completed",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "completed" },
          ],
        },
      ],
    });
    expect(prompts[1]).toContain("downstream stage verify requested rework");
    expect(prompts[1]).toContain("Fix implementation artifact implementation");

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-verification-diagnosis-implementation", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Verification Diagnoses");
    expect(evidence).toContain(
      "- verify attempt 1/2: implementation (high) - verification failure on verify points to implementation rework",
    );
    expect(evidence).toContain(
      "stage implement; artifact implementation; recommended action rework",
    );

    const detail = await getRunDetail(repo, "run-verification-diagnosis-implementation");
    expect(
      detail.timeline
        .find((item) => item.stageId === "verify")
        ?.details?.events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "verification.failure.diagnosed",
          summary: expect.stringContaining("classification implementation"),
        }),
      ]),
    );
  });

  it("diagnoses spec failures and routes high-confidence planning rework", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "verification-diagnosis-spec.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "verification-diagnosis-spec" },
      spec: {
        stages: [
          {
            id: "plan",
            type: "agent",
            runtime: "codex",
            prompt: "Write the spec.",
            inputs: [],
            outputs: [
              {
                id: "spec",
                type: "planning.spec",
                description: "Approved requirements",
              },
            ],
            maxAttempts: 2,
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the spec.",
            inputs: ["spec"],
            outputs: ["implementation"],
            maxAttempts: 2,
          },
          {
            id: "verify",
            type: "command",
            command:
              "test -f spec-ok || { printf 'acceptance criteria mismatch' >&2; exit 3; }",
            inputs: ["spec", "implementation"],
            outputs: ["verification-report"],
            maxAttempts: 2,
          },
        ],
      },
    });
    let planAttempts = 0;

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-verification-diagnosis-spec",
        executeAgent: async ({ stage, attemptDirectory, worktreePath }) => {
          if (stage.id === "plan") {
            planAttempts += 1;
            if (planAttempts > 1) {
              await writeFile(join(worktreePath, "spec-ok"), "ok\n", "utf8");
            }
            await writeFile(join(attemptDirectory, "spec.md"), "spec\n", "utf8");
            return;
          }
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-verification-diagnosis-spec");
    const projection = projectRun(events);
    store.close();

    expect(projection.verificationDiagnoses).toEqual([
      expect.objectContaining({
        stageId: "verify",
        classification: "spec",
        confidence: "high",
        targetStage: "plan",
        targetArtifact: "spec",
        recommendedAction: "rework",
      }),
    ]);
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "verify",
          action: "rework",
          targetStage: "plan",
          targetArtifact: "spec",
          reworkRequest: expect.objectContaining({
            instructions: expect.stringContaining("Revise planning/spec artifact spec"),
          }),
        }),
      ]),
    );
    expect(projection).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "plan",
          attempts: [
            { attempt: 1, status: "completed" },
            { attempt: 2, status: "completed" },
          ],
        },
        {
          stageId: "implement",
          attempts: [
            { attempt: 1, status: "completed" },
            { attempt: 2, status: "completed" },
          ],
        },
        {
          stageId: "verify",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "completed" },
          ],
        },
      ],
    });
  });

  it("escalates repeated low-confidence verification failures instead of looping", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "verification-diagnosis-unclear.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "verification-diagnosis-unclear" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "printf mystery >&2; exit 9",
            inputs: [],
            outputs: ["verification-report"],
            maxAttempts: 3,
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-verification-diagnosis-unclear" },
      ),
    ).rejects.toThrow(/^escalated: verification failure on verify is still unclear/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-verification-diagnosis-unclear");
    const projection = projectRun(events);
    store.close();

    expect(events.filter((event) => event.type === "stage.retrying")).toHaveLength(1);
    expect(events.filter((event) => event.type === "command.completed")).toHaveLength(2);
    expect(projection.verificationDiagnoses).toEqual([
      expect.objectContaining({
        stageId: "verify",
        attempt: 1,
        classification: "unclear",
        confidence: "low",
        recommendedAction: "retry",
      }),
      expect.objectContaining({
        stageId: "verify",
        attempt: 2,
        classification: "unclear",
        confidence: "low",
        recommendedAction: "escalate",
      }),
    ]);
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "verify",
      stageType: "command",
      attempt: 2,
      maxAttempts: 3,
      action: "escalate",
      reason:
        "verification failure on verify is still unclear after repeated attempts; escalate instead of looping",
    });

    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-verification-diagnosis-unclear", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Verification Diagnoses");
    expect(evidence).toContain("unclear (low)");
    expect(evidence).toContain("recommended action escalate");
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
    ).rejects.toThrow(/rework target stage implement has exhausted attempts/);

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
      reason: "rework target stage implement has exhausted attempts",
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

  it("materializes a flow-declared sourceUrl input and records provenance", async () => {
    const repo = await createRepo();
    await withSourceServer(
      { content: "# Imported spec\n\nBuild the thing.\n", path: "/spec.md" },
      async (sourceUrl) => {
        const flowPath = join(repo, "flows", "source-url-input.json");
        await writeJson(flowPath, {
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: {
            name: "source-url-input",
            inputs: [
              {
                id: "spec",
                type: "spec",
                sourceUrl,
              },
            ],
          },
          spec: {
            stages: [
              {
                id: "test",
                type: "command",
                command: "true",
                inputs: ["spec"],
                outputs: ["test-report"],
              },
            ],
          },
        });

        await runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          { createRunId: () => "run-source-url-input" },
        );

        const runDirectory = join(repo, ".nitely", "runs", "run-source-url-input");
        await expect(
          readFile(join(runDirectory, "inputs", "spec", "content"), "utf8"),
        ).resolves.toContain("Imported spec");
        const inputMetadata = JSON.parse(
          await readFile(join(runDirectory, "inputs", "spec", "metadata.json"), "utf8"),
        );
        expect(inputMetadata).toMatchObject({
          sourceUri: sourceUrl,
          mediaType: "text/markdown",
          revision: 'etag:"source-revision"',
          metadata: { filename: "spec.md" },
        });
        expect(typeof inputMetadata.fetchedAt).toBe("string");

        const contextManifest = JSON.parse(
          await readFile(join(runDirectory, "context-manifest.json"), "utf8"),
        );
        expect(contextManifest.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "spec",
              kind: "external-input",
              connector: "source-url",
              sourceUri: sourceUrl,
              runRelativePath: "inputs/spec/content",
              policy: { decision: "allowed" },
            }),
          ]),
        );
        const artifacts = JSON.parse(
          await readFile(join(runDirectory, "artifacts.json"), "utf8"),
        );
        expect(artifacts.artifacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "spec",
              producer: "external",
              sourceUri: sourceUrl,
              path: "inputs/spec/content",
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              size: 34,
              createdByRunId: "run-source-url-input",
            }),
          ]),
        );
        const store = new EventStore(join(repo, ".nitely", "events.db"));
        const created = store
          .list("run-source-url-input")
          .find((event) => event.type === "run.created");
        store.close();
        expect(created?.payload).toMatchObject({
          inputs: {
            spec: { connector: "source-url", uri: sourceUrl },
          },
        });
      },
    );
  });

  it("imports a previous run artifact via artifactUri with origin metadata", async () => {
    const repo = await createRepo();
    const producerFlowPath = join(repo, "flows", "producer.json");
    await writeJson(producerFlowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "producer-flow" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Produce an artifact.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await runFlow(
      { flowPath: producerFlowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-producer",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(
            join(attemptDirectory, "implementation.md"),
            "Produced elsewhere.\n",
            "utf8",
          );
        },
      },
    );

    const artifactUri = "nitely-artifact://run-producer/implementation";
    const consumerFlowPath = join(repo, "flows", "consumer.json");
    await writeJson(consumerFlowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "consumer-flow",
        inputs: [{ id: "imported", artifactUri }],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["imported"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await runFlow(
      { flowPath: consumerFlowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-consumer" },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-consumer");
    await expect(
      readFile(join(runDirectory, "inputs", "imported", "content"), "utf8"),
    ).resolves.toBe("Produced elsewhere.\n");
    const inputMetadata = JSON.parse(
      await readFile(join(runDirectory, "inputs", "imported", "metadata.json"), "utf8"),
    );
    expect(inputMetadata).toMatchObject({
      sourceUri: artifactUri,
      mediaType: "text/markdown",
      metadata: {
        filename: "implementation.md",
        originRunId: "run-producer",
        originArtifactId: "implementation",
        originProducer: "implement",
        originStageId: "implement",
        originFlowName: "producer-flow",
      },
    });
    const artifacts = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    );
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "imported",
          producer: "external",
          sourceUri: artifactUri,
          createdByRunId: "run-producer",
          stageId: "implement",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          path: "inputs/imported/content",
        }),
      ]),
    );
  });

  it("preserves binary agent output bytes across an artifactUri import", async () => {
    const repo = await createRepo();
    const binaryContent = Buffer.from([0xff, 0x00, 0xfe, 0x41, 0x80]);
    const producerFlowPath = join(repo, "flows", "binary-producer.json");
    await writeJson(producerFlowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "binary-producer" },
      spec: {
        stages: [
          {
            id: "generate",
            type: "agent",
            runtime: "mock",
            prompt: "Produce a binary artifact.",
            inputs: [],
            outputs: [
              {
                id: "payload",
                mediaType: "application/octet-stream",
              },
            ],
          },
        ],
      },
    });
    await runFlow(
      { flowPath: producerFlowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-binary-producer",
        executeAgent: async ({ attemptDirectory }) => {
          await writeFile(join(attemptDirectory, "payload.bin"), binaryContent);
          await writeJson(join(attemptDirectory, "artifact.json"), {
            version: 1,
            stageId: "generate",
            attempt: 1,
            outputs: [
              {
                id: "payload",
                path: "payload.bin",
                mediaType: "application/octet-stream",
              },
            ],
          });
        },
      },
    );

    const producerRegistry = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-binary-producer", "artifacts.json"),
        "utf8",
      ),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(producerRegistry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "payload",
          mediaType: "application/octet-stream",
          sha256: createHash("sha256").update(binaryContent).digest("hex"),
          size: binaryContent.byteLength,
        }),
      ]),
    );

    const artifactUri = "nitely-artifact://run-binary-producer/payload";
    const consumerFlowPath = join(repo, "flows", "binary-consumer.json");
    await writeJson(consumerFlowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "binary-consumer",
        inputs: [{ id: "payload", artifactUri }],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["payload"],
            outputs: [],
          },
        ],
      },
    });
    await runFlow(
      { flowPath: consumerFlowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-binary-consumer" },
    );

    await expect(
      readFile(
        join(
          repo,
          ".nitely",
          "runs",
          "run-binary-consumer",
          "inputs",
          "payload",
          "content",
        ),
      ),
    ).resolves.toEqual(binaryContent);
  });

  it("rejects an unsafe previous-run artifact before starting consumer stages", async () => {
    const repo = await createRepo();
    const producerRunDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run-unsafe-producer",
    );
    const producerAttemptDirectory = join(
      producerRunDirectory,
      "attempts",
      "implement",
      "1",
    );
    await mkdir(producerAttemptDirectory, { recursive: true });
    const outsideArtifact = join(repo, "outside-implementation.md");
    await writeFile(outsideArtifact, "Outside the producer Run.\n", "utf8");
    await link(
      outsideArtifact,
      join(producerAttemptDirectory, "implementation.md"),
    );
    await writeJson(join(producerRunDirectory, "artifacts.json"), {
      runId: "run-unsafe-producer",
      artifacts: [
        {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "attempts/implement/1/implementation.md",
        },
      ],
    });

    const flowPath = join(repo, "flows", "unsafe-artifact-uri.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "unsafe-artifact-uri",
        inputs: [
          {
            id: "implementation",
            artifactUri: "nitely-artifact://run-unsafe-producer/implementation",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-unsafe-artifact-uri" },
      ),
    ).rejects.toThrow(/hard link/i);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-unsafe-artifact-uri");
    store.close();
    expect(events.some((event) => event.type === "stage.started")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.failed",
          payload: expect.objectContaining({
            error: expect.stringMatching(/hard link/i),
          }),
        }),
      ]),
    );
    await expect(readFile(outsideArtifact, "utf8")).resolves.toBe(
      "Outside the producer Run.\n",
    );
  });

  it("fails before stages when a flow-declared artifactUri cannot be found", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "missing-artifact-uri.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "missing-artifact-uri",
        inputs: [
          {
            id: "spec",
            artifactUri: "nitely-artifact://missing-run/spec",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: ["spec"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-missing-artifact-uri" },
      ),
    ).rejects.toThrow(/nitely artifact not found: missing-run\/spec/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-missing-artifact-uri");
    store.close();
    expect(events.some((event) => event.type === "stage.started")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.failed",
          payload: expect.objectContaining({
            error: "nitely artifact not found: missing-run/spec",
          }),
        }),
      ]),
    );
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

  it("writes a reproducibility manifest and evidence summary for new runs", async () => {
    const previousSecret = process.env.NITELY_REPRO_SECRET_TOKEN;
    process.env.NITELY_REPRO_SECRET_TOKEN = "repro-secret-value";
    try {
      const repo = await createRepo();
      await writeJson(join(repo, "package.json"), {
        scripts: { test: "printf verified" },
      });
      await git(repo, ["add", "package.json"]);
      await git(repo, ["commit", "-m", "add package manifest"]);
      await mkdir(join(repo, "specs"), { recursive: true });
      await writeFile(
        join(repo, "specs", "repro-secret-value.md"),
        "verify reproducibility\n",
        "utf8",
      );
      const flowPath = join(repo, "flows", "repro.json");
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "repro" },
        spec: {
          stages: [
            {
              id: "test",
              type: "command",
              command: "printf verified",
              inputs: ["spec"],
              outputs: ["test-report"],
            },
          ],
        },
      });

      await runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: {
            spec: { connector: "local-file", uri: "specs/repro-secret-value.md" },
          },
        },
        { createRunId: () => "run-repro" },
      );

      const runDirectory = join(repo, ".nitely", "runs", "run-repro");
      const manifestText = await readFile(
        join(runDirectory, "reproducibility.json"),
        "utf8",
      );
      expect(manifestText).not.toContain("repro-secret-value");
      expect(manifestText).toContain("[REDACTED]");
      const manifest = JSON.parse(manifestText);
      expect(manifest).toMatchObject({
        version: 1,
        runId: "run-repro",
        replayability: "replayable",
        repo: {
          baseBranch: "master",
          branch: "nitely/run-repro",
          worktreePath: join(runDirectory, "worktree"),
        },
        flow: {
          name: "repro",
          path: flowPath,
          documentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          configurationSha256: sha256Text("{}"),
        },
        commands: [
          {
            stageId: "test",
            command: "printf verified",
          },
        ],
        inputs: [
          expect.objectContaining({
            id: "spec",
            connector: "local-file",
            sourceUri: "specs/[REDACTED].md",
            runRelativePath: "inputs/spec/content",
            sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            policy: { decision: "allowed" },
          }),
        ],
        missingReplayPrerequisites: [],
        nonDeterministicFactors: [],
        environment: {
          executionBackend: "local",
          sandboxPolicy: { codex: "danger-full-access" },
        },
      });
      expect(manifest.flow.documentSha256).toBe(
        `sha256:${createHash("sha256")
          .update(await readFile(flowPath))
          .digest("hex")}`,
      );
      expect(manifest.context.policySha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(manifest.repo.headCommit).toMatch(/^[a-f0-9]{40}$/);

      const preflightText = await readFile(
        join(runDirectory, "toolchain-preflight.json"),
        "utf8",
      );
      const preflight = JSON.parse(preflightText);
      expect(preflight).toMatchObject({
        version: 1,
        runId: "run-repro",
        executionBackend: "local",
        commandEnvironment: {
          envSource: "resolved-backend-env",
          shellMode: "non-login sh -c",
          repairs: [],
        },
        toolchainFiles: [
          {
            path: "package.json",
            kind: "node-package",
          },
        ],
      });
      expect(preflight.executables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "git" }),
          expect.objectContaining({ name: "node" }),
        ]),
      );

      const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
      expect(evidence).toContain("## Reproducibility");
      expect(evidence).toContain("Replayability: replayable");
      expect(evidence).toContain("Manifest: reproducibility.json");
      expect(evidence).toContain("## Toolchain Preflight");
      expect(evidence).toContain("Manifest: toolchain-preflight.json");
      expect(evidence).toContain("Toolchain files: package.json (node-package)");
      expect(evidence).not.toContain("repro-secret-value");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_REPRO_SECRET_TOKEN;
      } else {
        process.env.NITELY_REPRO_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("keeps manifest entries distinct while failing closed on redacted Artifact identity collisions", async () => {
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

      await expect(runFlow(
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
      )).rejects.toThrow(/duplicate Artifact identity/i);

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
      redactionSecrets: () => ["q7Z"],
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
        stdout: "stdout has ghp_1234567890abcdefghijklmnopqrstuv and q7Z",
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
      expect(surface).not.toContain("q7Z");
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
          {
            id: "reflect",
            type: "agent",
            runtime: "mock",
            alwaysRun: true,
            prompt: "Reflect on resumed execution.",
            inputs: ["implementation"],
            outputs: ["reflection"],
          },
        ],
      },
    });
    await git(repo, ["worktree", "add", "-b", "nitely/run-resume", worktreePath, "HEAD"]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), { recursive: true });
    const existingRawPath =
      "stages/implement/1/secret=resume-private-value/existing.md";
    await mkdir(join(runDirectory, "stages", "implement", "1", "secret=resume-private-value"), {
      recursive: true,
    });
    await writeFile(join(runDirectory, existingRawPath), "existing evidence\n", "utf8");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repo,
      runId: "run-resume",
      artifacts: [{
        id: "existing-evidence",
        producer: "implement",
        mediaType: "text/markdown",
        path: existingRawPath,
      }],
      redactionSecrets: [],
    });
    const commit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const taskIssueRepository = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      url: "https://github.com/Instask/nitely",
    };
    const runEligibilityOverride = {
      actor: "operator",
      reason: "accepted dependency risk",
      acceptedReasonCodes: ["dependency.incomplete:upstream"],
    };
    await writeTaskIssueRegistry({
      repoPath: repo,
      repository: taskIssueRepository,
      bindings: [
        {
          taskId: "T001",
          issueNumber: 72,
          issueUrl: "https://github.com/Instask/nitely/issues/72",
          issueTitle: "T001: Mutable registry replacement",
          issueState: "open",
          source: {
            commit,
            tasksPath: "docs/tasks.md",
            specPath: "docs/spec.md",
            planPath: "docs/plan.md",
          },
          syncedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume",
      type: "run.created",
      payload: {
        flowName: "resume",
        flowPath,
        repoPath: repo,
        inputs: {},
        runEligibilityOverride,
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
      type: "task.scope.selected",
      payload: {
        inputId: "tasks",
        expression: "T001",
        kind: "ids",
        selectedTaskIds: ["T001"],
        completedTaskIds: [],
        pendingTaskIds: ["T001"],
        sourceTaskCount: 1,
      },
    });
    seedStore.append({
      runId: "run-resume",
      type: "task.issue.scope_resolved",
      payload: {
        schemaVersion: "nitely.task-issue-scope.v1",
        repository: taskIssueRepository,
        issues: [
          {
            issueNumber: 71,
            issueUrl: "https://github.com/Instask/nitely/issues/71",
            issueTitle: "T001: Resume safely",
            issueState: "open",
            taskIds: ["T001"],
          },
        ],
        missingTaskIds: [],
      },
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
    const interrupted = projectRun(seedStore.list("run-resume"), {
      openAttemptStatus: "interrupted",
    });
    seedStore.close();
    expect(interrupted.status).toBe("interrupted");

    let reflectionPrompt = "";
    const taskIssueComments: string[] = [];
    const taskIssueCommentNumbers: number[] = [];
    const taskIssueProvider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("publishChange must not run during resume");
      },
      resolveRepository: async () => taskIssueRepository,
      listRepositoryIssueComments: async () => [],
      createRepositoryIssueComment: async ({ issueNumber, body }) => {
        taskIssueCommentNumbers.push(issueNumber);
        taskIssueComments.push(body);
        return {
          provider: "github",
          id: "72",
          url: "https://github.com/Instask/nitely/issues/71#issuecomment-72",
          body,
          authorLogin: "nitely",
          createdAt: "2026-07-14T00:00:01Z",
        };
      },
      updateRepositoryIssueComment: async () => {
        throw new Error("task issue comment update must not run for a new resume marker");
      },
    };
    const result = await resumeRun(
      {
        repoPath: repo,
        runId: "run-resume",
      },
      {
        scmProvider: taskIssueProvider,
        executeAgent: async ({ stage, attemptDirectory, worktreePath, prompt }) => {
          if (stage.id === "reflect") {
            reflectionPrompt = prompt;
            await writeFile(join(attemptDirectory, "reflection.md"), "Resumed cleanly.\n", "utf8");
            return;
          }
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
    const resumedEvents = store.list("run-resume");
    const projection = projectRun(resumedEvents);
    store.close();

    expect(projection.status).toBe("completed");
    expect(projection.stages.find((stage) => stage.stageId === "implement")).toMatchObject({
      status: "completed",
      attempts: [
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "completed" },
      ],
    });
    expect(projection.stages.find((stage) => stage.stageId === "reflect")).toMatchObject({
      status: "completed",
      attempts: [{ attempt: 1, status: "completed" }],
    });
    expect(projection.completedStages).toEqual(["implement", "reflect"]);
    expect(reflectionPrompt).toContain("Terminal status: completed");
    expect(reflectionPrompt).toContain("Artifact: run-finalizer-context");
    expect(projection.orchestratorDecisions.at(-1)).toMatchObject({
      stageId: "reflect",
      stageType: "agent",
      attempt: 1,
      maxAttempts: 1,
      action: "complete",
    });
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Orchestrator Decisions");
    expect(evidence).toContain(
      "- implement attempt 2 (max policy attempts 1): complete - agent completed on attempt 2",
    );
    expect(evidence).toContain("- reflection: producer reflect");
    expect(evidence).toContain("- Scope: T001");
    expect(evidence).toContain(
      "- T001: https://github.com/Instask/nitely/issues/71 (#71, open)",
    );
    expect(taskIssueComments).toHaveLength(1);
    expect(taskIssueCommentNumbers).toEqual([71]);
    expect(taskIssueComments[0]).toContain("Nitely run `run-resume`");
    expect(resumedEvents.map((event) => event.type)).toContain("task.scope.completed");
    expect(resumedEvents.map((event) => event.type)).toContain("task.issue.run_linked");
    const runRecord = JSON.parse(
      await readFile(join(runDirectory, "run.json"), "utf8"),
    ) as { runEligibilityOverride?: unknown };
    expect(runRecord.runEligibilityOverride).toEqual(runEligibilityOverride);
    expect(await readFile(join(runDirectory, "artifacts.json"), "utf8"))
      .not.toContain("resume-private-value");
    const internalRegistry = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repo,
      runId: "run-resume",
    });
    expect(internalRegistry?.artifacts).toContainEqual(
      expect.objectContaining({
        id: "existing-evidence",
        path: existingRawPath,
      }),
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

  it("does not render resumed runtime-candidate attempts as impossible retry counts", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "resume-runtime-candidate-accounting.json");
    const runId = "run-resume-runtime-candidate-accounting";
    const runDirectory = join(repo, ".nitely", "runs", runId);
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-runtime-candidate-accounting" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            maxAttempts: 2,
            runtimes: [{ runtime: "claude" }, { runtime: "codex" }],
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-runtime-candidate-accounting",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "2"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId,
      type: "run.created",
      payload: {
        flowName: "resume-runtime-candidate-accounting",
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
        branchName: "nitely/run-resume-runtime-candidate-accounting",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId,
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        type: "agent",
        runtime: "claude",
        runtimeCandidateIndex: 0,
        runtimeCandidateCount: 2,
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "stage.blocked",
      payload: {
        reason: "agent_usage_limit",
        stageId: "implement",
        runtime: "claude",
        message: "Provider quota exceeded.",
      },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 2,
      type: "stage.started",
      payload: {
        type: "agent",
        runtime: "codex",
        runtimeCandidateIndex: 1,
        runtimeCandidateCount: 2,
        attemptDirectory: join(runDirectory, "stages", "implement", "2"),
      },
    });
    seedStore.close();

    const runtimes: string[] = [];
    await resumeRun(
      { repoPath: repo, runId },
      {
        backend: backendWithAgent(repo, async (_workspace, { stage, attemptDirectory }) => {
          runtimes.push(stage.runtime ?? "");
          if (stage.runtime === "claude") {
            throw Object.assign(new Error("claude exited with code 1"), {
              stderr: "Provider quota exceeded. Please try again in 10 minutes.\n",
            });
          }
          await writeFile(join(attemptDirectory, "implementation.md"), "resumed\n", "utf8");
          return {
            stdout: "resumed\n",
            stderr: "",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        }),
      },
    );

    expect(runtimes).toEqual(["claude", "codex"]);
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Orchestrator Decisions");
    expect(evidence).not.toContain("- Known attempts:");
    expect(evidence).not.toContain("- Unknown attempts:");
    expect(evidence).toContain("- Attempts with runtime usage data: 1");
    expect(evidence).toContain("- Runtime attempts without usage data: 3");
    expect(evidence).not.toContain("attempt 4/2");
    expect(evidence).toContain(
      "- implement attempt 4 (max policy attempts 2): complete - agent completed on attempt 4",
    );
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

  it("records explicit checkpoint selection before resuming a blocked stage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-selected-checkpoint.json");
    const runId = "run-resume-selected-checkpoint";
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-selected-checkpoint" },
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

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend: backendWithAgent(repo, async (_workspace, input) => {
            if (input.stage.id === "prepare") {
              await writeFile(join(input.attemptDirectory, "prep.md"), "prepared context\n", "utf8");
              return { stdout: "prepared\n", stderr: "" };
            }
            throw Object.assign(new Error("codex exited with code 1"), {
              stderr: "usage limit reached; try again in 10 minutes\n",
            });
          }),
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    let store = new EventStore(join(repo, ".nitely", "events.db"));
    const beforeEvents = store.list(runId);
    store.close();
    const checkpoint = buildRunTrace(beforeEvents).resumableCheckpoints.find(
      (candidate) =>
        candidate.kind === "stage-attempt" && candidate.stageId === "implement",
    );
    expect(checkpoint).toBeDefined();

    const resumedStages: string[] = [];
    await resumeRun(
      { repoPath: repo, runId, checkpointId: checkpoint?.id },
      {
        backend: {
          async createWorkspace() {
            throw new Error("resume should reuse the existing workspace");
          },
          async runAgent(_workspace, input) {
            resumedStages.push(input.stage.id);
            if (input.stage.id === "prepare") {
              throw new Error("resume should not rerun completed upstream stages");
            }
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

    store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    const selected = events.find((event) => event.type === "resume.selected");
    expect(selected).toMatchObject({
      stageId: "implement",
      attempt: 1,
      payload: {
        checkpointId: checkpoint?.id,
        checkpointKind: "stage-attempt",
        selectedStageId: "implement",
        selectedAttempt: 1,
        mode: "resume",
        nonDestructive: true,
      },
    });
    expect(resumedStages).toEqual(["implement"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "implement",
          attempt: 2,
          type: "stage.started",
          payload: expect.objectContaining({ resumedFrom: "blocked" }),
        }),
      ]),
    );
    expect(buildRunTrace(events).checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume-selection",
          eventType: "resume.selected",
          stageId: "implement",
          attempt: 1,
        }),
      ]),
    );
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

  it("retries a resumed command stage while budget remains", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-command-retry.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-command-retry");
    const worktreePath = join(runDirectory, "worktree");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-command-retry" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "resume-test-command",
            maxAttempts: 3,
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
      "nitely/run-resume-command-retry",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "test", "1"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-command-retry",
      type: "run.created",
      payload: {
        flowName: "resume-command-retry",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-command-retry",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId: "run-resume-command-retry",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-command-retry",
      stageId: "test",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "test", "1"),
      },
    });
    seedStore.close();

    let commandCalls = 0;
    await resumeRun(
      { repoPath: repo, runId: "run-resume-command-retry" },
      {
        backend: {
          async createWorkspace() {
            throw new Error("resume should reuse the existing workspace");
          },
          async runAgent() {
            throw new Error("command resume should not run an agent");
          },
          async runCommand() {
            commandCalls += 1;
            return commandCalls === 1
              ? { stdout: "", stderr: "first resume failure", exitCode: 7 }
              : { stdout: "retry success", stderr: "", exitCode: 0 };
          },
          async commitAll() {
            return { committed: false };
          },
        },
      },
    );

    expect(commandCalls).toBe(2);
    await expect(
      readFile(join(runDirectory, "stages", "test", "2", "stderr.log"), "utf8"),
    ).resolves.toBe("first resume failure");
    await expect(
      readFile(join(runDirectory, "stages", "test", "3", "stdout.log"), "utf8"),
    ).resolves.toBe("retry success");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-resume-command-retry");
    const projection = projectRun(events);
    store.close();

    expect(projection).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "test",
          status: "completed",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "failed" },
            { attempt: 3, status: "completed" },
          ],
        },
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.retrying",
          stageId: "test",
          attempt: 2,
          payload: expect.objectContaining({ nextAttempt: 3 }),
        }),
        expect.objectContaining({
          type: "stage.started",
          stageId: "test",
          attempt: 3,
          payload: expect.objectContaining({ resumedFrom: "interrupted" }),
        }),
      ]),
    );
    expect(projection.orchestratorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "test",
          stageType: "command",
          attempt: 2,
          maxAttempts: 3,
          action: "retry",
        }),
        expect.objectContaining({
          stageId: "test",
          stageType: "command",
          attempt: 3,
          maxAttempts: 3,
          action: "complete",
        }),
      ]),
    );
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("- test attempt 2/3: retry - command failed");
    expect(evidence).toContain("- test attempt 3/3: complete - command completed on attempt 3");
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
    const projection = projectRun(store.list("run-resume-missing-flow"), {
      openAttemptStatus: "interrupted",
    });
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
      "- publish attempt 2 (max policy attempts 1): complete - publish-change completed on attempt 2",
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

  it("rejects a replaced agent artifact before a resumed downstream stage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-replaced-artifact.json");
    const runId = "run-resume-replaced-artifact";
    const runDirectory = join(repo, ".nitely", "runs", runId);
    const worktreePath = join(runDirectory, "worktree");
    const implementAttemptDirectory = join(
      runDirectory,
      "stages",
      "implement",
      "1",
    );
    const verifyAttemptDirectory = join(runDirectory, "stages", "verify", "1");
    const artifactPath = join(implementAttemptDirectory, "implementation.md");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-replaced-artifact" },
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
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["implementation"],
            outputs: [],
          },
        ],
      },
    });
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-replaced-artifact",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(implementAttemptDirectory, { recursive: true });
    await mkdir(verifyAttemptDirectory, { recursive: true });
    const originalContent = Buffer.from("trusted implementation\n", "utf8");
    const artifact = {
      id: "implementation",
      producer: "implement",
      mediaType: "text/markdown",
      path: "stages/implement/1/implementation.md",
      sourceUri: "stages/implement/1/implementation.md",
      filename: "implementation.md",
      createdAt: "2026-07-15T00:00:00.000Z",
      sha256: createHash("sha256").update(originalContent).digest("hex"),
      size: originalContent.byteLength,
    };
    await writeFile(artifactPath, originalContent);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId,
      artifacts: [artifact],
    });

    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId,
      type: "run.created",
      payload: {
        flowName: "resume-replaced-artifact",
        flowPath,
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-replaced-artifact",
        baseBranch: "master",
      },
    });
    seedStore.append({
      runId,
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: implementAttemptDirectory },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "artifact.published",
      payload: { artifact },
      createdAt: artifact.createdAt,
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "stage.completed",
      payload: { outputs: ["implementation"] },
    });
    seedStore.append({
      runId,
      stageId: "verify",
      attempt: 1,
      type: "stage.started",
      payload: { attemptDirectory: verifyAttemptDirectory },
    });
    seedStore.close();

    const replacementContent = Buffer.from("replacement content\n", "utf8");
    await rm(artifactPath);
    await writeFile(artifactPath, replacementContent);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId,
      artifacts: [{
        ...artifact,
        sha256: createHash("sha256").update(replacementContent).digest("hex"),
        size: replacementContent.byteLength,
      }],
    });
    expect((await stat(artifactPath)).nlink).toBe(1);

    let commandCalls = 0;
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          backend: {
            async createWorkspace() {
              throw new Error("resume should reuse the existing workspace");
            },
            async runAgent() {
              throw new Error("completed agent should not run again");
            },
            async runCommand() {
              commandCalls += 1;
              return { stdout: "", stderr: "", exitCode: 0 };
            },
            async commitAll() {
              return { committed: false };
            },
          },
        },
      ),
    ).rejects.toThrow(
      /artifact implementation path size does not match its registry metadata/,
    );
    expect(commandCalls).toBe(0);
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
      "- update attempt 2 (max policy attempts 1): complete - update-change completed on attempt 2",
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
      metadataUpdate: {
        transport: "github-rest-api",
        outcome: "updated",
        fields: ["title", "body"],
      },
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
    expect(changeRequestArtifact).toContain("Metadata update: updated");
    expect(changeRequestArtifact).toContain("Metadata transport: github-rest-api");
    expect(changeRequestArtifact).toContain("Metadata fields: title, body");
    expect(changeRequestArtifact.match(/^Metadata update:/gm)).toHaveLength(1);
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-provider", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("Outcome: reused");
    expect(evidence).toContain("Metadata update: updated");
    expect(evidence).toContain("Metadata transport: github-rest-api");
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
      branchName: "nitely/run-title",
      headCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
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
    expect(evidence).toContain("- implement (agent): runtime claude, model default");
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
      "run.risk.classified",
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

  it("refuses to resume an eval replay under a different context policy", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "resume-eval-context.json");
    const runDirectory = join(repo, ".nitely", "runs", "run-resume-eval-context");
    const worktreePath = join(runDirectory, "worktree");
    const flowDocument = `${JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-eval-context" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "resume",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    }, null, 2)}\n`;
    await mkdir(dirname(flowPath), { recursive: true });
    await writeFile(flowPath, flowDocument, "utf8");
    await git(repo, ["add", "flows/resume-eval-context.json"]);
    await git(repo, ["commit", "-m", "add eval context resume flow"]);
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "nitely/run-resume-eval-context",
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), {
      recursive: true,
    });
    const configurationDocument = "{}";
    await writeFile(
      join(runDirectory, "configuration.json"),
      configurationDocument,
      "utf8",
    );
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId: "run-resume-eval-context",
      type: "run.created",
      payload: {
        flowName: "resume-eval-context",
        flowPath,
        flowDocument: "[REDACTED EVENT COPY IS NOT EXECUTABLE]",
        flowDocumentSha256: sha256Text(flowDocument),
        configuration: {},
        configurationSnapshotPath: "configuration.json",
        configurationSha256: sha256Text(configurationDocument),
        repoPath: repo,
        inputs: {},
        branchName: "nitely/run-resume-eval-context",
        baseBranch: "master",
        contextPolicySha256: `sha256:${"0".repeat(64)}`,
        promptContext: {
          constitution: { loaded: false, path: ".nitely/constitution.md" },
          projectInstructions: {
            loaded: false,
            path: ".nitely/instructions.json",
          },
        },
        expectedSkillContentHashes: {},
        executionBackend: "local",
        sandboxPolicy: { codex: "danger-full-access" },
      },
    });
    seedStore.append({
      runId: "run-resume-eval-context",
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId: "run-resume-eval-context",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.append({
      runId: "run-resume-eval-context",
      type: "eval.replay.linked",
      payload: {},
    });
    seedStore.close();

    await expect(
      resumeRun({ repoPath: repo, runId: "run-resume-eval-context" }),
    ).rejects.toThrow(/eval replay resume context policy digest mismatch/);
  });

  it("fails closed when an eval replay crashes before its link event is recorded", async () => {
    const repo = await createRepo();
    const runId = "run-resume-eval-before-link";
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId,
      type: "run.created",
      payload: {
        evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
      },
    });
    seedStore.close();

    await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(
      /eval replay resume is missing its pinned execution backend/,
    );
  });

  it("fails closed when a replay invocation id is malformed", async () => {
    const repo = await createRepo();
    const runId = "run-resume-eval-malformed-invocation";
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId,
      type: "run.created",
      payload: { evalReplayInvocationId: "not-a-valid-invocation-id" },
    });
    seedStore.close();

    await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(
      /invalid eval replay invocation id/,
    );
  });

  it("fails closed when an eval replay has multiple run creation markers", async () => {
    const repo = await createRepo();
    const runId = "run-resume-eval-multiple-invocations";
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({
      runId,
      type: "run.created",
      payload: {
        evalReplayInvocationId: "11111111-1111-4111-8111-111111111111",
      },
    });
    seedStore.append({
      runId,
      type: "run.created",
      payload: {
        evalReplayInvocationId: "22222222-2222-4222-8222-222222222222",
      },
    });
    seedStore.close();

    await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(
      /eval replay resume requires exactly one run\.created event/,
    );
  });

  it.each([
    ["executionBackend", "execution backend"],
    ["sandboxPolicy", "sandbox policy"],
    ["flowDocumentSha256", "Flow document digest"],
    ["configurationSnapshotPath", "configuration snapshot"],
    ["configurationSha256", "configuration digest"],
    ["promptContext", "prompt context"],
    ["expectedSkillContentHashes", "skill content hashes"],
    ["inputExpectedSha256", "input ticket content digest"],
  ])("fails closed when an eval replay resume is missing its pinned %s", async (
    missingField,
    expectedLabel,
  ) => {
    const repo = await createRepo();
    const runId = `run-resume-pin-${missingField.toLowerCase()}`;
    const flowPath = join(repo, "flows", "resume-eval-pins.json");
    const runDirectory = join(repo, ".nitely", "runs", runId);
    const worktreePath = join(runDirectory, "worktree");
    const flowDocument = `${JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "resume-eval-pins" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "resume",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    }, null, 2)}\n`;
    await mkdir(dirname(flowPath), { recursive: true });
    await writeFile(flowPath, flowDocument, "utf8");
    await git(repo, ["add", "flows/resume-eval-pins.json"]);
    await git(repo, ["commit", "-m", "add eval resume flow"]);
    await git(repo, [
      "worktree",
      "add",
      "-b",
      `nitely/${runId}`,
      worktreePath,
      "HEAD",
    ]);
    await mkdir(join(runDirectory, "stages", "implement", "1"), {
      recursive: true,
    });
    const configurationDocument = "{}";
    await writeFile(
      join(runDirectory, "configuration.json"),
      configurationDocument,
      "utf8",
    );
    const payload: Record<string, unknown> = {
      flowName: "resume-eval-pins",
      flowPath,
      flowDocument: "[REDACTED EVENT COPY IS NOT EXECUTABLE]",
      flowDocumentSha256: sha256Text(flowDocument),
      configuration: {},
      configurationSnapshotPath: "configuration.json",
      configurationSha256: sha256Text(configurationDocument),
      repoPath: repo,
      inputs: {},
      branchName: `nitely/${runId}`,
      baseBranch: "master",
      contextPolicySha256: sha256Text(
        JSON.stringify(await loadContextPolicy(repo)),
      ),
      promptContext: {
        constitution: { loaded: false, path: ".nitely/constitution.md" },
        projectInstructions: {
          loaded: false,
          path: ".nitely/instructions.json",
        },
      },
      expectedSkillContentHashes: {},
      executionBackend: "local",
      sandboxPolicy: { codex: "danger-full-access" },
    };
    if (missingField === "inputExpectedSha256") {
      payload.inputs = {
        ticket: { connector: "local-file", uri: "README.md" },
      };
    } else {
      delete payload[missingField];
    }
    const seedStore = new EventStore(join(repo, ".nitely", "events.db"));
    seedStore.append({ runId, type: "run.created", payload });
    seedStore.append({
      runId,
      type: "workspace.created",
      payload: { worktreePath },
    });
    seedStore.append({
      runId,
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: {
        attemptDirectory: join(runDirectory, "stages", "implement", "1"),
      },
    });
    seedStore.append({ runId, type: "eval.replay.linked", payload: {} });
    seedStore.close();

    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ attemptDirectory }) => {
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              "done\n",
              "utf8",
            );
          },
        },
      ),
    ).rejects.toThrow(new RegExp(`missing its pinned ${expectedLabel}`, "i"));
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
              cost: {
                classification: "estimated",
                usd: 0.02,
                method: "pinned mock price card",
              },
              provenance: {
                provider: "mock",
                observedAt: "2026-07-16T00:00:00.000Z",
                source: { kind: "calculated", reference: "mock.price-card" },
              },
              raw: {
                credential: "runtime-private-credential-123",
                provider: "mock",
              },
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
      cost: {
        classification: "estimated",
        usd: 0.02,
        method: "pinned mock price card",
      },
      provenance: {
        provider: "mock",
        source: { kind: "calculated", reference: "mock.price-card" },
      },
      raw: { credential: "[REDACTED]", provider: "mock" },
    });
    expect(projectRun(events).runtimeUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.02,
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
    return {
      runId: "r",
      repoPath: "/repo",
      runDirectory: "/repo/.nitely/runs/r",
      manifestEntries: [],
      manifestEntryIndexes: new Map(),
      artifactEntries: [],
      artifactEntryIndexes: new Map(),
      redactionSecrets: [],
      constitution: { loaded: false as const, path: ".nitely/constitution.md" as const },
      projectInstructions: {
        loaded: false as const,
        path: ".nitely/instructions.json" as const,
      },
    };
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
  it("trims lower-ranked external knowledge before declared inputs", () => {
    const r = fitPromptToBudget({
      inputs: inputs as never,
      context: ctx(),
      budget: 250,
      externalKnowledgeCount: 3,
      render: (forced, retained = 3) => {
        const inputTokens =
          [...inputs.keys()].filter((id) => !forced.has(id)).length * 50;
        const approxTokens = 100 + inputTokens + retained * 75;
        return {
          prompt: `knowledge=${retained};forced=${[...forced].join(",")}`,
          contextUsage: {
            promptBytes: approxTokens * 4,
            approxTokens,
            inputBytesInlined: 0,
            inputBytesSaved: 0,
            inputCount: inputs.size,
          },
        };
      },
    });
    expect(r.outcome).toMatchObject({
      status: "trimmed",
      trimmedExternalKnowledgeCount: 3,
      trimmedInputIds: [],
    });
    expect(r.prompt).toContain("knowledge=0");
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

describe.skipIf(process.platform !== "linux")("budget enforcement (integration)", () => {
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

  async function runAgentFlowWithFullReadInputs(opts: {
    inputBody: string;
    fullReadInputs?: string[];
  }): Promise<string> {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), opts.inputBody, "utf8");

    const flowPath = join(repo, "flows", "full-read-flow.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "full-read-flow" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["spec"],
            ...(opts.fullReadInputs
              ? { context: { fullReadInputs: opts.fullReadInputs } }
              : {}),
            outputs: ["implementation"],
          },
        ],
      },
    });

    let capturedPrompt = "";
    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-full-read-" + Math.random().toString(36).slice(2, 8),
        executeAgent: async ({ prompt, attemptDirectory }) => {
          capturedPrompt = prompt;
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );
    return capturedPrompt;
  }

  it("delivers a truncated input as sufficient when no stage opted into a full read", async () => {
    const prompt = await runAgentFlowWithFullReadInputs({
      inputBody: "x".repeat(40000),
    });
    expect(prompt).toContain("Content preview (truncated — treat it as sufficient");
    expect(prompt).not.toContain("MUST read the full file");
    expect(prompt).not.toContain("Full content:");
  });

  it("mandates a full read only for an input listed in context.fullReadInputs", async () => {
    const prompt = await runAgentFlowWithFullReadInputs({
      inputBody: "x".repeat(40000),
      fullReadInputs: ["spec"],
    });
    expect(prompt).toContain("Full content:");
    expect(prompt).toContain("MUST read the full file");
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
            await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
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

  it("fails fast when run-level runtime token consumption exceeds the hard budget", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-token-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-token-budget" },
      spec: {
        maxAttempts: 3,
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

    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          {
            createRunId: () => "run-runtime-token-budget",
            backend: backendWithAgent(repo, async (_workspace, input) => {
              await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
              return {
                usage: {
                  inputTokens: 90,
                  outputTokens: 60,
                  totalTokens: 150,
                },
              };
            }),
          },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-runtime-token-budget");
    store.close();
    const exceeded = events.find((event) => event.type === "budget.exceeded");
    expect(exceeded?.payload).toMatchObject({
      budgetKind: "runtime-tokens",
      scope: "run",
      phase: "consumption",
      budget: 100,
      consumed: 150,
      approxTokens: 150,
    });
    expect((exceeded?.payload as { message: string }).message).toContain(
      "NITELY_DEFAULT_MAX_RUNTIME_TOKENS",
    );
    expect(events.filter((event) => event.type === "stage.retrying")).toHaveLength(0);
    expect(events.find((event) => event.type === "run.failed")?.payload).toMatchObject({
      reason: "budget_exceeded",
    });
  });

  it("keeps a passing review gate complete when consumption exceeds the runtime token budget", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "review-gate-token-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-gate-token-budget" },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            prompt: "Review the implementation.",
            inputs: [],
            outputs: ["review-gate"],
          },
        ],
      },
    });

    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          {
            createRunId: () => "run-review-gate-token-budget",
            backend: backendWithAgent(repo, async (_workspace, input) => {
              await writeFile(
                join(input.attemptDirectory, "review-gate.md"),
                "Review verdict: pass\n",
                "utf8",
              );
              return {
                usage: {
                  inputTokens: 90,
                  outputTokens: 60,
                  totalTokens: 150,
                },
              };
            }),
          },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-review-gate-token-budget");
    store.close();
    expect(
      events.some(
        (event) => event.stageId === "review" && event.type === "gate.completed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.stageId === "review" && event.type === "stage.completed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.stageId === "review" && event.type === "stage.failed",
      ),
    ).toBe(false);
    expect(events.find((event) => event.type === "budget.exceeded")?.payload)
      .toMatchObject({
        budgetKind: "runtime-tokens",
        phase: "consumption",
      });
    expect(events.find((event) => event.type === "run.failed")?.payload)
      .toMatchObject({ reason: "budget_exceeded" });
    expect(projectRun(events).completedStages).toEqual(["review"]);
  });

  it("enforces verification attempt budgets across retries", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "verification-attempt-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "verification-attempt-budget" },
      spec: {
        maxAttempts: 2,
        verificationBudget: { maxAgentAttempts: 1 },
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

    let executions = 0;
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-verification-attempt-budget",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            executions += 1;
            if (executions === 1) throw new Error("transient failure");
            await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
            return {};
          }),
        },
      ),
    ).rejects.toThrow(/agent attempts budget exhausted/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-verification-attempt-budget");
    store.close();
    expect(executions).toBe(1);
    expect(events.find((event) => event.type === "budget.exceeded")?.payload).toMatchObject({
      budgetKind: "agent-attempts",
      budget: 1,
      consumed: 1,
      remaining: 0,
    });
  });

  it("applies a default runtime token cap to a flow that declares no budget", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "default-runtime-token-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "default-runtime-token-budget" },
      spec: {
        maxAttempts: 3,
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
          createRunId: () => "run-default-token-budget",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
            return {
              usage: {
                inputTokens: DEFAULT_MAX_RUNTIME_TOKENS,
                outputTokens: 1,
                totalTokens: DEFAULT_MAX_RUNTIME_TOKENS + 1,
              },
            };
          }),
        },
      ),
    ).rejects.toThrow(/runtime token budget exhausted/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-default-token-budget");
    store.close();
    const exceeded = events.find((event) => event.type === "budget.exceeded");
    expect(exceeded?.payload).toMatchObject({
      budgetKind: "runtime-tokens",
      scope: "run",
      budget: DEFAULT_MAX_RUNTIME_TOKENS,
      consumed: DEFAULT_MAX_RUNTIME_TOKENS + 1,
    });
    expect((exceeded?.payload as { message: string }).message).toContain(
      "NITELY_DEFAULT_MAX_RUNTIME_TOKENS",
    );
  });

  it("excludes cache reads from the enforced runtime token total", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cached-runtime-token-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cached-runtime-token-budget" },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "write-tests",
            type: "agent",
            runtime: "mock",
            prompt: "Write the tests.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    // The numbers are run 2026-08-30T142227983Z-022c3249, which failed at
    // write-tests on a 2M cap. 93% of its input was cache reads; the work it
    // actually bought was 177,492 tokens.
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-cached-token-budget",
        backend: backendWithAgent(repo, async (_workspace, input) => {
          await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
          return {
            usage: {
              inputTokens: 2_216_578,
              outputTokens: 23_250,
              totalTokens: 2_239_828,
              cachedInputTokens: 2_062_336,
            },
          };
        }),
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cached-token-budget");
    store.close();
    expect(events.find((event) => event.type === "budget.exceeded")).toBeUndefined();
    expect(events.find((event) => event.type === "run.completed")).toBeDefined();
  });

  it("still counts cache creation, which providers bill at a premium", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "cache-creation-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "cache-creation-budget" },
      spec: {
        maxAttempts: 1,
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

    // 200 input of which 20 are cache reads leaves 180 enforced, over the 100
    // cap: cache creation and fresh input are still charged in full.
    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          {
            createRunId: () => "run-cache-creation-budget",
            backend: backendWithAgent(repo, async (_workspace, input) => {
              await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
              return {
                usage: {
                  inputTokens: 200,
                  outputTokens: 0,
                  totalTokens: 200,
                  cachedInputTokens: 20,
                },
              };
            }),
          },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-cache-creation-budget");
    store.close();
    expect(events.find((event) => event.type === "budget.exceeded")?.payload)
      .toMatchObject({
        budgetKind: "runtime-tokens",
        scope: "run",
        budget: 100,
        consumed: 180,
        cachedInputTokens: 20,
      });
  });

  it("keeps a stage complete when the run stops on budget after it", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "budget-after-completion.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "budget-after-completion" },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "write-tests",
            type: "agent",
            runtime: "mock",
            prompt: "Write the tests.",
            inputs: [],
            outputs: ["tests"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["tests"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const invocations: string[] = [];
    const backend = backendWithAgent(repo, async (_workspace, input) => {
      invocations.push(input.stage.id);
      const output = input.stage.id === "write-tests" ? "tests.md" : "implementation.md";
      await writeFile(join(input.attemptDirectory, output), "done\n", "utf8");
      return {
        usage: { inputTokens: 150, outputTokens: 0, totalTokens: 150 },
      };
    });

    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          { createRunId: () => "run-budget-after-completion", backend },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-budget-after-completion");

    // The stage wrote its artifact before the cap fired. `projectRun` deletes a
    // stage from completedStages on `stage.failed`, so emitting one here would
    // silently undo the completion and make the resume below repeat paid work.
    expect(
      events.filter((event) => event.type === "stage.completed")
        .map((event) => event.stageId),
    ).toEqual(["write-tests"]);
    expect(
      events.some(
        (event) => event.stageId === "write-tests" && event.type === "stage.failed",
      ),
    ).toBe(false);
    expect(projectRun(events).completedStages).toEqual(["write-tests"]);
    expect(events.find((event) => event.type === "run.failed")?.payload)
      .toMatchObject({ reason: "budget_exceeded" });
    expect(invocations).toEqual(["write-tests"]);
    store.close();
  });

  it("refuses to resume a budget-stopped run until the cap is raised", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "budget-resume-cap.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "budget-resume-cap" },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "write-tests",
            type: "agent",
            runtime: "mock",
            prompt: "Write the tests.",
            inputs: [],
            outputs: ["tests"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["tests"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const backend = backendWithAgent(repo, async (_workspace, input) => {
      const output = input.stage.id === "write-tests" ? "tests.md" : "implementation.md";
      await writeFile(join(input.attemptDirectory, output), "done\n", "utf8");
      return {
        usage: { inputTokens: 150, outputTokens: 0, totalTokens: 150 },
      };
    });

    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          { createRunId: () => "run-budget-resume-cap", backend },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);

      await expect(
        resumeRun({ repoPath: repo, runId: "run-budget-resume-cap" }, { backend }),
      ).rejects.toThrow(
        /raise NITELY_DEFAULT_MAX_RUNTIME_TOKENS above 150 before resume/,
      );
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-budget-resume-cap");
    store.close();
    expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "stage.started").map((event) => event.stageId))
      .toEqual(["write-tests"]);
  });

  it("resumes a budget-stopped run at the first incomplete stage after the cap is raised", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "budget-resume-raised.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "budget-resume-raised" },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "write-tests",
            type: "agent",
            runtime: "mock",
            prompt: "Write the tests.",
            inputs: [],
            outputs: ["tests"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the change.",
            inputs: ["tests"],
            outputs: ["implementation"],
          },
        ],
      },
    });
    const invocations: string[] = [];
    const backend = backendWithAgent(repo, async (_workspace, input) => {
      invocations.push(input.stage.id);
      const output = input.stage.id === "write-tests" ? "tests.md" : "implementation.md";
      await writeFile(join(input.attemptDirectory, output), "done\n", "utf8");
      return {
        usage: { inputTokens: 150, outputTokens: 0, totalTokens: 150 },
      };
    });

    await withDefaultMaxRuntimeTokens(100, async () => {
      await expect(
        runFlow(
          { flowPath, repoPath: repo, inputs: {} },
          { createRunId: () => "run-budget-resume-raised", backend },
        ),
      ).rejects.toThrow(/runtime token budget exhausted/);
    });
    await withDefaultMaxRuntimeTokens(400, async () => {
      await resumeRun(
        { repoPath: repo, runId: "run-budget-resume-raised" },
        { backend },
      );
    });

    expect(invocations).toEqual(["write-tests", "implement"]);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-budget-resume-raised");
    store.close();
    expect(events.find((event) => event.type === "run.resumed")?.payload).toMatchObject({
      reason: "budget_exceeded",
      selectedStageId: "implement",
    });
    expect(
      events.filter((event) => event.type === "stage.completed").map((event) => event.stageId),
    ).toEqual(["write-tests", "implement"]);
    expect(projectRun(events)).toMatchObject({
      status: "completed",
      completedStages: ["write-tests", "implement"],
    });
  });

  it("does not fail a defaulted budget when a runtime reports no token usage", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "unknown-usage.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "unknown-usage" },
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

    // grok, glm, and pi report no usage at all. The default cap must not turn
    // that into a hard failure the operator never asked for.
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-unknown-usage",
        backend: backendWithAgent(repo, async (_workspace, input) => {
          await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
          return {};
        }),
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-unknown-usage");
    store.close();
    expect(events.find((event) => event.type === "budget.exceeded")).toBeUndefined();
    expect(projectRun(events).status).toBe("completed");
  });

  it("records estimated and actual cost ledgers separately when a cost budget is exceeded", async () => {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "runtime-cost-budget.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "runtime-cost-budget" },
      spec: {
        verificationBudget: { maxRuntimeCostUsd: 0.05 },
        stages: [
          {
            id: "first",
            type: "agent",
            runtime: "mock",
            prompt: "Do the first step.",
            inputs: [],
            outputs: ["first-output"],
          },
          {
            id: "second",
            type: "agent",
            runtime: "mock",
            prompt: "Do the second step.",
            inputs: ["first-output"],
            outputs: ["second-output"],
          },
        ],
      },
    });
    let calls = 0;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-runtime-cost-budget",
          backend: backendWithAgent(repo, async (_workspace, input) => {
            calls += 1;
            await writeFile(
              join(input.attemptDirectory, `${input.stage.id}-output.md`),
              "done\n",
              "utf8",
            );
            if (input.stage.id === "first") {
              return {
                usage: {
                  totalTokens: 50,
                  cost: {
                    classification: "actual",
                    usd: 0.02,
                  },
                  provenance: {
                    provider: "mock",
                    observedAt: "2026-07-23T00:00:00.000Z",
                    source: { kind: "provider-reported", reference: "mock.invoice" },
                  },
                },
              };
            }
            return {
              usage: {
                totalTokens: 50,
                cost: {
                  classification: "estimated",
                  usd: 0.04,
                  method: "test price card",
                },
                provenance: {
                  provider: "mock",
                  observedAt: "2026-07-23T00:00:00.000Z",
                  source: { kind: "calculated", reference: "test.price-card" },
                },
              },
            };
          }),
        },
      ),
    ).rejects.toThrow(/cost budget exhausted/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-runtime-cost-budget");
    store.close();
    expect(calls).toBe(2);
    expect(events.find((event) => event.type === "budget.exceeded")?.payload).toMatchObject({
      budgetKind: "cost",
      scope: "run",
      phase: "consumption",
      budget: 0.05,
      consumed: 0.06,
      actualCostUsd: 0.02,
      estimatedCostUsd: 0.04,
    });
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

  async function writeAgentMemoryReviewFlow(repo: string): Promise<string> {
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "agent-memory-review.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "agent-memory-review" },
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

  it("does not commit injected memory files that an agent staged", async () => {
    const repo = await createRepo();
    const flowPath = await writeAgentMemoryFlow(repo);

    await runAgentMemoryFlow({
      repo,
      flowPath,
      runId: "run-agent-memory-staged",
      onAgent: async (worktreePath) => {
        await git(worktreePath, ["add", "CLAUDE.md"]);
      },
      onPublish: async (worktreePath) => {
        const { stdout } = await git(worktreePath, ["show", "--name-only", "--format=", "HEAD"]);
        expect(stdout.split(/\r?\n/).filter(Boolean)).not.toContain("CLAUDE.md");
      },
    });
  });

  it("cleans generated memory files before review gates evaluate worktree state", async () => {
    const repo = await createRepo();
    const flowPath = await writeAgentMemoryReviewFlow(repo);
    let reviewSawCleanWorktree = false;

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-agent-memory-review-clean",
        executeAgent: async ({ stage, worktreePath, attemptDirectory }) => {
          if (stage.id === "review") {
            reviewSawCleanWorktree = true;
            await expect(stat(join(worktreePath, "AGENTS.md"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(stat(join(worktreePath, "CLAUDE.md"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const { stdout } = await git(worktreePath, ["status", "--short"]);
            expect(stdout).not.toContain("AGENTS.md");
            expect(stdout).not.toContain("CLAUDE.md");
            await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
            return;
          }

          await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toContain(
            "# Repository Memory",
          );
          await expect(readFile(join(worktreePath, "CLAUDE.md"), "utf8")).resolves.toContain(
            "# Repository Memory",
          );
          await git(worktreePath, ["add", "CLAUDE.md"]);
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    expect(reviewSawCleanWorktree).toBe(true);
  });

  it("preserves repository-owned instruction files for review gates", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "AGENTS.md"), "# User Agents\n", "utf8");
    await git(repo, ["add", "AGENTS.md"]);
    await git(repo, ["commit", "-m", "add user agents"]);
    const flowPath = await writeAgentMemoryReviewFlow(repo);

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-agent-memory-review-user-file",
        executeAgent: async ({ stage, worktreePath, attemptDirectory }) => {
          if (stage.id === "review") {
            await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toBe(
              "# User Agents\n",
            );
            await expect(stat(join(worktreePath, "CLAUDE.md"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const { stdout } = await git(worktreePath, ["status", "--short"]);
            expect(stdout).not.toContain("CLAUDE.md");
            await writeFile(join(attemptDirectory, "review-gate.md"), "Review verdict: pass\n", "utf8");
            return;
          }

          await expect(readFile(join(worktreePath, "AGENTS.md"), "utf8")).resolves.toBe(
            "# User Agents\n",
          );
          await expect(readFile(join(worktreePath, "CLAUDE.md"), "utf8")).resolves.toContain(
            "# Repository Memory",
          );
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );
  });

  it("hides repository instruction files for stages with instruction files disabled", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "AGENTS.md"), "# User Agents\n", "utf8");
    await writeFile(join(repo, "CLAUDE.md"), "# User Claude\n", "utf8");
    await git(repo, ["add", "AGENTS.md", "CLAUDE.md"]);
    await git(repo, ["commit", "-m", "add user instructions"]);
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "agent-memory-disabled.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "agent-memory-disabled" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: ["spec"],
            outputs: ["implementation"],
            context: { instructionFiles: false },
          },
        ],
      },
    });
    let capturedWorktreePath = "";

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-agent-memory-disabled",
        executeAgent: async ({ worktreePath, attemptDirectory }) => {
          capturedWorktreePath = worktreePath;
          await expect(stat(join(worktreePath, "AGENTS.md"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(stat(join(worktreePath, "CLAUDE.md"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    await expect(readFile(join(capturedWorktreePath, "AGENTS.md"), "utf8")).resolves.toBe(
      "# User Agents\n",
    );
    await expect(readFile(join(capturedWorktreePath, "CLAUDE.md"), "utf8")).resolves.toBe(
      "# User Claude\n",
    );
    const evidence = await readFile(
      join(repo, ".nitely", "runs", "run-agent-memory-disabled", "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Stage Context Controls");
    expect(evidence).toContain("- implement (agent)");
    expect(evidence).toContain("Instruction files: disabled");
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
              "Review verdict: pass\n",
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

describe("project instructions", () => {
  async function writeProjectInstructionsFlow(repo: string): Promise<string> {
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "project-instructions.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "project-instructions-flow" },
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

  it("injects matching project instruction groups into agent and review prompts", async () => {
    const repo = await createRepo();
    await writeJson(join(repo, ".nitely", "instructions.json"), {
      version: 1,
      instructions: [
        {
          id: "global",
          text: "Always keep the change small and evidence-backed.",
        },
        {
          id: "spec-implementation",
          appliesTo: "agent",
          include: ["specs/**"],
          text: "For spec-backed changes, update tests before implementation.",
        },
        {
          id: "review-generated",
          appliesTo: "review",
          include: ["stages/implement/**"],
          text: "Review the generated implementation artifact before approving.",
        },
        {
          id: "docs-only",
          include: ["docs/**"],
          text: "This docs-only instruction should not match.",
        },
      ],
    });
    const flowPath = await writeProjectInstructionsFlow(repo);

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-project-instructions",
        executeAgent: async ({ stage, worktreePath, attemptDirectory }) => {
          if (stage.id === "review") {
            await writeFile(
              join(attemptDirectory, "review-gate.md"),
              "Review verdict: pass\n",
              "utf8",
            );
            return;
          }
          await writeFile(join(worktreePath, "feature.txt"), "implemented\n", "utf8");
          await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-project-instructions");
    const implementPrompt = await readFile(
      join(runDirectory, "stages", "implement", "1", "prompt.md"),
      "utf8",
    );
    expect(implementPrompt).toContain("## Project Instructions");
    expect(implementPrompt).toContain("### global");
    expect(implementPrompt).toContain("Always keep the change small");
    expect(implementPrompt).toContain("### spec-implementation");
    expect(implementPrompt).toContain("Matched paths: specs/change.md");
    expect(implementPrompt).not.toContain("review-generated");
    expect(implementPrompt).not.toContain("docs-only");

    const reviewPrompt = await readFile(
      join(runDirectory, "stages", "review", "1", "prompt.md"),
      "utf8",
    );
    expect(reviewPrompt).toContain("### global");
    expect(reviewPrompt).toContain("### review-generated");
    expect(reviewPrompt).toContain("Review the generated implementation artifact");
    expect(reviewPrompt).not.toContain("spec-implementation");
    expect(reviewPrompt).not.toContain("docs-only");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Project Instructions");
    expect(evidence).toContain("Loaded: yes");
    expect(evidence).toContain("Path: .nitely/instructions.json");
    expect(evidence).toContain("Groups: 4");
    expect(evidence).toContain("- global: applies to both");
    expect(evidence).toMatch(/Hash: sha256:[0-9a-f]{64}/);
  });

  it("applies flow-level isolation defaults with stage-level continuity overrides", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    await writeJson(join(repo, ".nitely", "instructions.json"), {
      version: 1,
      instructions: [
        {
          id: "global",
          text: "Global instruction should only appear when continuity is enabled.",
        },
      ],
    });
    await createContextKnowledgeEntry(
      repo,
      {
        category: "pitfalls",
        title: "Isolated context warning",
        body: "Continuity-only context knowledge.",
        keywords: ["isolated-context"],
      },
      {
        createId: () => "ctx-isolated-context",
        now: () => "2026-07-08T00:00:00.000Z",
      },
    );
    const flowPath = join(repo, "flows", "isolated-context.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "isolated-context-flow" },
      spec: {
        context: { isolated: true },
        stages: [
          {
            id: "isolated-default",
            type: "agent",
            runtime: "codex",
            prompt: "Create the implementation.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "continuous-override",
            type: "agent",
            runtime: "codex",
            prompt: "Verify the implementation.",
            inputs: ["implementation"],
            outputs: ["verification"],
            context: { isolated: false },
          },
        ],
      },
    });

    await runFlow(
      {
        flowPath,
        repoPath: repo,
        inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
      },
      {
        createRunId: () => "run-isolated-context",
        executeAgent: async ({ stage, attemptDirectory }) => {
          if (stage.id === "isolated-default") {
            await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
            return;
          }
          await writeFile(join(attemptDirectory, "verification.md"), "verified\n", "utf8");
        },
      },
    );

    const runDirectory = join(repo, ".nitely", "runs", "run-isolated-context");
    const isolatedPrompt = await readFile(
      join(runDirectory, "stages", "isolated-default", "1", "prompt.md"),
      "utf8",
    );
    expect(isolatedPrompt).not.toContain("## Project Instructions");
    expect(isolatedPrompt).not.toContain("Global instruction should only appear");
    expect(isolatedPrompt).not.toContain("## Repository Context Knowledge");
    expect(isolatedPrompt).not.toContain("Continuity-only context knowledge.");
    expect(isolatedPrompt).toContain("Create feature.txt");

    const continuousPrompt = await readFile(
      join(runDirectory, "stages", "continuous-override", "1", "prompt.md"),
      "utf8",
    );
    expect(continuousPrompt).toContain("## Project Instructions");
    expect(continuousPrompt).toContain("Global instruction should only appear");
    expect(continuousPrompt).toContain("## Repository Context Knowledge");
    expect(continuousPrompt).toContain("Continuity-only context knowledge.");

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("## Stage Context Controls");
    expect(evidence).toContain("- isolated-default (agent)");
    expect(evidence).toContain("Isolated: yes");
    expect(evidence).toContain("Project instructions: disabled");
    expect(evidence).toContain("Context knowledge: disabled");
    expect(evidence).toContain("- continuous-override (agent)");
    expect(evidence).toContain("Isolated: no");
    expect(evidence).toContain("Project instructions: enabled");
    expect(evidence).toContain("Context knowledge: enabled");
  });
});

describe("global runtime skills", () => {
  async function runWithGlobalSkills(globalSkills?: boolean): Promise<{
    request: unknown;
    runDirectory: string;
    repo: string;
    runId: string;
  }> {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "global-skills.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "global-skills" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "go",
            inputs: [],
            ...(globalSkills === undefined ? {} : { context: { globalSkills } }),
            outputs: ["implementation"],
          },
        ],
      },
    });

    const runId = "run-skills-" + Math.random().toString(36).slice(2, 8);
    let request: unknown;
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => runId,
        backend: {
          async createWorkspace(input) {
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
            request = input.globalSkills;
            await writeFile(
              join(input.attemptDirectory, "implementation.md"),
              "done\n",
              "utf8",
            );
            return {
              stdout: "",
              stderr: "",
              globalSkills: input.globalSkills?.mode === "inherited"
                ? { isolated: false, reason: "flow opted into the operator's global skills" }
                : { isolated: true },
            };
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

    return {
      request,
      runDirectory: join(repo, ".nitely", "runs", runId),
      repo,
      runId,
    };
  }

  it("asks the backend to isolate global skills by default", async () => {
    const { request, repo, runId, runDirectory } = await runWithGlobalSkills();

    expect(request).toEqual({
      mode: "isolate-if-supported",
      homeDirectory: join(repo, ".nitely", "runtime-homes", runId, "codex"),
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events.find((event) => event.type === "stage.runtime.global-skills")?.payload,
    ).toEqual({ isolated: true });

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(
      "Global runtime skills: isolated where the runtime supports it",
    );
  });

  it("demands isolation when a stage sets globalSkills to false", async () => {
    const { request, runDirectory } = await runWithGlobalSkills(false);

    expect(request).toMatchObject({ mode: "required-isolated" });
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("Global runtime skills: isolated (required)");
  });

  it("opts back into the operator's global skills when a stage sets true", async () => {
    const { request, repo, runId, runDirectory } = await runWithGlobalSkills(true);

    expect(request).toEqual({ mode: "inherited" });
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events.find((event) => event.type === "stage.runtime.global-skills")?.payload,
    ).toMatchObject({ isolated: false });

    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain("Global runtime skills: inherited from the operator");
  });
});

describe("stage read policies", () => {
  async function runWithReads(reads?: {
    flow?: Record<string, unknown>;
    stage?: Record<string, unknown>;
  }): Promise<{ prompt: string; evidence: string }> {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "reads.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "reads" },
      spec: {
        ...(reads?.flow ? { reads: reads.flow } : {}),
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "go",
            inputs: [],
            ...(reads?.stage ? { reads: reads.stage } : {}),
            outputs: ["implementation"],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            prompt: "review it",
            inputs: ["implementation"],
            outputs: ["review-verdict"],
          },
        ],
      },
    });

    const runId = "run-reads-" + Math.random().toString(36).slice(2, 8);
    let prompt = "";
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => runId,
        executeAgent: async ({ stage, prompt: given, attemptDirectory }) => {
          if (stage.id === "implement") prompt = given;
          await writeFile(
            join(attemptDirectory, stage.id === "implement" ? "implementation.md" : "review-verdict.md"),
            stage.id === "implement" ? "done\n" : "Review verdict: pass\n",
            "utf8",
          );
        },
      },
    );

    return {
      prompt,
      evidence: await readFile(
        join(repo, ".nitely", "runs", runId, "evidence.md"),
        "utf8",
      ),
    };
  }

  it("states a finite read bound in the prompt and records it in evidence", async () => {
    const { prompt, evidence } = await runWithReads();

    expect(prompt).toContain("## Repository Read Policy");
    expect(prompt).toContain("Do not take more than 262144 bytes");
    expect(prompt).toContain("**/node_modules/**");

    expect(evidence).toContain("## Stage Read Policies");
    expect(evidence).toContain("- implement (agent)");
    expect(evidence).toContain("Max file bytes: 262144");
    // A review gate reads to judge, so it gets the stricter default.
    expect(evidence).toContain("- review (review-gate)");
    expect(evidence).toContain("Max file bytes: 32768");
    expect(evidence).toContain("Enforcement: advisory");
  });

  it("lets a stage override the flow read bound", async () => {
    const { prompt, evidence } = await runWithReads({
      flow: { maxFileBytes: 4096 },
      stage: { maxFileBytes: 8192, deny: ["docs/**"] },
    });

    expect(prompt).toContain("Do not take more than 8192 bytes");
    expect(prompt).toContain("docs/**");
    expect(evidence).toContain("Max file bytes: 8192");
    // The review gate falls back to the flow value, not the stage override.
    expect(evidence).toContain("Max file bytes: 4096");
  });

  it("fails closed when a stage demands enforcement the injected executor lacks", async () => {
    await expect(
      runWithReads({ stage: { enforcement: "required" } }),
    ).rejects.toThrow(
      /declares reads\.enforcement "required", but the injected agent executor enforces no byte-level read bound/,
    );
  });
});

describe("agent session reuse", () => {
  async function runTaskPlanLoop(options: {
    sessionReuse?: boolean;
    reportSessionId?: boolean;
  } = {}): Promise<{
    prompts: string[];
    sessions: Array<{ resumeSessionId: string } | undefined>;
    repo: string;
    runId: string;
  }> {
    const repo = await createRepo();
    const flowPath = join(repo, "flows", "session-reuse.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "session-reuse" },
      spec: {
        stages: [
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt: "Plan the work.",
            inputs: [],
            outputs: [{ id: "task-plan", mediaType: "application/json" }],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            maxAttempts: 6,
            prompt: "Implement only the current pending task.",
            inputs: ["task-plan"],
            ...(options.sessionReuse === undefined
              ? {}
              : { context: { sessionReuse: options.sessionReuse } }),
            outputs: ["implementation"],
            taskPlan: { input: "task-plan", role: "execute-current", max_iterations: 4 },
          },
          {
            id: "verify",
            type: "command",
            command: "true",
            maxAttempts: 6,
            inputs: ["task-plan", "implementation"],
            outputs: ["verification"],
            taskPlan: { input: "task-plan", role: "verify-advance", max_iterations: 4 },
          },
        ],
      },
    });

    const runId = "run-session-" + Math.random().toString(36).slice(2, 8);
    const prompts: string[] = [];
    const sessions: Array<{ resumeSessionId: string } | undefined> = [];
    const threadId = "019bffff-1111-7111-8111-111111111111";
    const agentBackend = backendWithAgent(repo, async (_workspace, input) => {
          if (input.stage.id === "plan-tasks") {
            await writeFile(
              join(input.attemptDirectory, "task-plan.json"),
              JSON.stringify({
                version: "nitely.task-plan.v1",
                max_iterations: 4,
                tasks: [
                  { id: "T001", title: "First", status: "pending" },
                  { id: "T002", title: "Second", status: "pending" },
                ],
              }),
              "utf8",
            );
            return {};
          }
          if (input.stage.id === "implement") {
            prompts.push(input.prompt);
            sessions.push(input.session);
            await writeFile(
              join(input.attemptDirectory, "implementation.md"),
              "done\n",
              "utf8",
            );
            return options.reportSessionId === false
              ? {}
              : { session: { mode: input.session ? "resumed" as const : "cold" as const, sessionId: threadId } };
          }
      return {};
    });
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => runId,
        backend: {
          ...agentBackend,
          runCommand: (workspace, command, options) =>
            new LocalExecutionBackend().runCommand(workspace, command, options),
        },
      },
    );

    return { prompts, sessions, repo, runId };
  }

  it("sends a full prompt once and a delta on later loop iterations", async () => {
    const { prompts, sessions, repo, runId } = await runTaskPlanLoop();

    expect(prompts.length).toBeGreaterThan(1);
    expect(sessions[0]).toBeUndefined();
    expect(sessions[1]).toEqual({
      resumeSessionId: "019bffff-1111-7111-8111-111111111111",
    });

    // The first prompt is the full contract; later iterations carry the delta.
    expect(prompts[0]).toContain("## Available Inputs");
    expect(prompts[0]).toContain("## Required Outputs");
    expect(prompts[1]).toContain("(continued session)");
    expect(prompts[1]).not.toContain("## Available Inputs");
    expect(prompts[1]).toContain("## Updated Input: task-plan");
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length / 2);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    const sessionEvents = events
      .filter((event) => event.type === "stage.runtime.session")
      .map((event) => (event.payload as { mode: string }).mode);
    expect(sessionEvents[0]).toBe("cold");
    expect(sessionEvents[1]).toBe("resumed");
  });

  it("keeps every iteration cold when a stage opts out", async () => {
    const { prompts, sessions } = await runTaskPlanLoop({ sessionReuse: false });

    expect(sessions.every((session) => session === undefined)).toBe(true);
    expect(prompts.every((prompt) => prompt.includes("## Available Inputs"))).toBe(true);
  });

  it("falls back to a full prompt when the runtime reports no session", async () => {
    const { prompts, sessions } = await runTaskPlanLoop({ reportSessionId: false });

    expect(sessions.every((session) => session === undefined)).toBe(true);
    expect(prompts.every((prompt) => prompt.includes("## Available Inputs"))).toBe(true);
  });
});
