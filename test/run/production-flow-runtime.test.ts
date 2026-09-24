import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../../src/artifacts/registry.js";
import {
  EventStore,
  type SynchronousTransactionOperation,
} from "../../src/events/store.js";
import { resolveApproval } from "../../src/run/approvals.js";
import { projectRun } from "../../src/run/project.js";
import { resumeRun, runFlow } from "../../src/run/run-flow.js";
import type {
  CommandResult,
  ExecutionBackend,
  RunCommandOptions,
} from "../../src/run/execution/types.js";
import {
  createDurableReleaseAdapterFixture,
  readReleaseFixtureState,
  seedRollbackRecoveryFixtureState,
  seedReleaseFixtureState,
  type DurableReleaseReceipt,
  type FakeReleaseEnvironmentState,
  type ReleaseDurabilityEvent,
} from "./release-adapter-fixture.js";

const execFileAsync = promisify(execFile);

class ArtifactPublicationFaultStore extends EventStore {
  private artifactAppends = 0;
  private failedAfterPersistence = false;

  constructor(
    path: string,
    private readonly failurePoint: "second-event" | "after-persist",
  ) {
    super(path);
  }

  override append(
    event: Parameters<EventStore["append"]>[0],
  ): ReturnType<EventStore["append"]> {
    if (
      this.failurePoint === "second-event" &&
      event.type === "artifact.published" &&
      event.stageId === "release" &&
      (event.payload as { artifact?: { attempt?: number } }).artifact?.attempt === 1
    ) {
      this.artifactAppends += 1;
      if (this.artifactAppends === 2) {
        throw new Error("injected second artifact event failure");
      }
    }
    return super.append(event);
  }

  override transaction<T>(operation: SynchronousTransactionOperation<T>): T {
    if (
      this.failurePoint === "after-persist" &&
      !this.failedAfterPersistence
    ) {
      this.failedAfterPersistence = true;
      throw new Error("injected artifact persistence failure");
    }
    return super.transaction(operation);
  }
}

class ArtifactPublicationConcurrencyStore extends EventStore {
  observedPersistedOutputSet = false;

  constructor(
    path: string,
    private readonly peerStore: EventStore,
    private readonly registryPath: string,
  ) {
    super(path);
  }

  override transaction<T>(operation: SynchronousTransactionOperation<T>): T {
    if (!this.observedPersistedOutputSet) {
      const registry = JSON.parse(
        readFileSync(this.registryPath, "utf8"),
      ) as {
        artifacts: Array<{
          id?: string;
          producer?: string;
          attempt?: number;
        }>;
      };
      const releaseOutputs = registry.artifacts.filter(
        (artifact) =>
          artifact.producer === "release" &&
          artifact.attempt === 1 &&
          ["release-report", "smoke-report"].includes(artifact.id ?? ""),
      );
      if (releaseOutputs.length !== 2) {
        throw new Error(
          "typed output files were not persisted before the event transaction",
        );
      }
      this.observedPersistedOutputSet = true;
      this.peerStore.append({
        runId: "run-peer-during-publication",
        type: "run.created",
        payload: {},
      });
    }
    return super.transaction(operation);
  }
}

class SimulatedReleaseProcessCrashStore extends EventStore {
  private crashed = false;

  crash(): never {
    this.crashed = true;
    throw new Error("simulated release process crash");
  }

  override append(
    event: Parameters<EventStore["append"]>[0],
  ): ReturnType<EventStore["append"]> {
    if (this.crashed) throw new Error("simulated release process crash");
    return super.append(event);
  }

  override transaction<T>(operation: SynchronousTransactionOperation<T>): T {
    if (this.crashed) throw new Error("simulated release process crash");
    return super.transaction(operation);
  }
}

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-production-runtime-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

const commandProtocolRepos: string[] = [];
const fifoReaders = new Set<ChildProcess>();

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref();
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function startCrashHeldSqliteLock(lockPath: string): Promise<ChildProcess> {
  await mkdir(dirname(lockPath), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { DatabaseSync } = require('node:sqlite');",
        "const database = new DatabaseSync(process.env.LOCK_PATH);",
        "database.exec('BEGIN EXCLUSIVE');",
        "process.stdout.write('locked\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  fifoReaders.add(child);
  child.once("exit", () => fifoReaders.delete(child));
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for SQLite lock: ${stderr}`)),
      5_000,
    );
    timeout.unref();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("locked\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `SQLite lock owner exited before readiness (${code ?? signal}): ${stderr}`,
        ),
      );
    });
  });
  return child;
}

async function crashChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function startReleaseAdapterWorker(input: {
  repo: string;
  runId: string;
  attempt: number;
  outputDirectory: string;
}): Promise<{ child: ChildProcess; completion: Promise<CommandResult> }> {
  const fixtureUrl = pathToFileURL(
    join(process.cwd(), "test", "run", "release-adapter-fixture.ts"),
  ).href;
  const workerInput = JSON.stringify(input);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        "const { mkdir } = await import('node:fs/promises');",
        "const input = JSON.parse(process.env.RELEASE_WORKER_INPUT);",
        "const fixture = await import(process.env.RELEASE_FIXTURE_URL);",
        "await mkdir(input.outputDirectory, { recursive: true });",
        "process.stdout.write('adapter-worker-started\\n');",
        "const adapter = fixture.createDurableReleaseAdapterFixture(input);",
        "const result = await adapter.runCommand({",
        "  runId: input.runId,",
        "  stageId: 'release',",
        "  attempt: input.attempt,",
        "  attemptDirectory: input.outputDirectory,",
        "  outputDirectory: input.outputDirectory,",
        "});",
        "process.stdout.write('adapter-worker-result:' + JSON.stringify(result) + '\\n');",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        RELEASE_FIXTURE_URL: fixtureUrl,
        RELEASE_WORKER_INPUT: workerInput,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  fifoReaders.add(child);
  child.once("exit", () => fifoReaders.delete(child));

  let stdout = "";
  let stderr = "";
  let started = false;
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (!started && stdout.includes("adapter-worker-started\n")) {
      started = true;
      resolveStarted();
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const completion = new Promise<CommandResult>((resolve, reject) => {
    child.once("error", (error) => {
      rejectStarted(error);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!started) {
        rejectStarted(
          new Error(
            `release adapter worker exited before readiness (${code ?? signal}): ${stderr}`,
          ),
        );
      }
      if (code !== 0) {
        reject(
          new Error(
            `release adapter worker exited with ${code ?? signal}: ${stderr}`,
          ),
        );
        return;
      }
      const resultLine = stdout
        .split("\n")
        .find((line) => line.startsWith("adapter-worker-result:"));
      if (!resultLine) {
        reject(new Error(`release adapter worker omitted its result: ${stderr}`));
        return;
      }
      resolve(
        JSON.parse(resultLine.slice("adapter-worker-result:".length)) as CommandResult,
      );
    });
  });
  await readiness;
  return { child, completion };
}

afterEach(async () => {
  await Promise.all([...fifoReaders].map(stopChild));
  fifoReaders.clear();
  await Promise.all(
    commandProtocolRepos.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true }),
    ),
  );
});

async function createCommandProtocolRepo(): Promise<string> {
  const repo = await createRepo();
  commandProtocolRepos.push(repo);
  return repo;
}

function commandProtocolBackend(input: {
  repo: string;
  runCommand: (
    options: RunCommandOptions,
    call: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runAgent?: ExecutionBackend["runAgent"];
}): ExecutionBackend {
  let commandCalls = 0;
  return {
    async createWorkspace({ runId, branchName, worktreePath }) {
      await git(input.repo, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        "HEAD",
      ]);
      return { runId, path: worktreePath };
    },
    async runCommand(_workspace, _command, options = {}) {
      commandCalls += 1;
      return await input.runCommand(options, commandCalls);
    },
    async runAgent(workspace, agentInput) {
      if (!input.runAgent) {
        throw new Error("agent should not run");
      }
      return await input.runAgent(workspace, agentInput);
    },
    async commitAll() {
      return { committed: false };
    },
  };
}

function richMarkdownOutput(id: string) {
  return {
    id,
    type: "report",
    description: `${id} evidence`,
    mediaType: "text/markdown",
  };
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function releaseFlowFixture(maxAttempts = 1): Record<string, unknown> {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "release-safety-fixture" },
    spec: {
      maxAttempts: 6,
      stages: [
        {
          id: "release",
          type: "command",
          command: "./scripts/nitely/release-production",
          timeoutMs: 1_800_000,
          maxAttempts,
          inputs: [],
          outputs: [
            richMarkdownOutput("release-report"),
            richMarkdownOutput("smoke-report"),
          ],
        },
      ],
    },
  };
}

function durableReleaseAdapterFixture(input: {
  repo: string;
  runId: string;
  interruptAfterDeploy?: () => never;
  interruptAfterInitialExternalState?: () => never;
  terminalFailureAfterDeploy?: string;
}): { backend: ExecutionBackend; receiptPath: string; lockPath: string } {
  const adapter = createDurableReleaseAdapterFixture(input);
  return {
    backend: commandProtocolBackend({
      repo: input.repo,
      runCommand: adapter.runCommand,
    }),
    receiptPath: adapter.paths.receiptPath,
    lockPath: adapter.paths.lockPath,
  };
}

async function invokeReleaseAdapter(input: {
  backend: ExecutionBackend;
  repo: string;
  runId: string;
  attempt: number;
  outputDirectory: string;
}) {
  await mkdir(input.outputDirectory, { recursive: true });
  return await input.backend.runCommand(
    { runId: input.runId, path: input.repo },
    "./scripts/nitely/release-production",
    {
      runId: input.runId,
      stageId: "release",
      attempt: input.attempt,
      attemptDirectory: input.outputDirectory,
      outputDirectory: input.outputDirectory,
    },
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function productionFlowFixture(
  taskCount = 2,
  options: {
    maxAttempts?: number;
    maxIterations?: number;
    maxTasks?: number;
  } = {},
): Record<string, unknown> {
  const maxAttempts = options.maxAttempts ?? 6;
  const maxIterations = options.maxIterations ?? taskCount;
  const maxTasks = options.maxTasks ?? taskCount;
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "production-runtime-fixture" },
    spec: {
      maxAttempts,
      stages: [
        {
          id: "plan",
          type: "agent",
          runtime: "mock",
          prompt: `Create a ${taskCount}-task plan.`,
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
          id: "approve-plan",
          type: "approval",
          prompt: "Approve implementation of this task plan.",
          inputs: ["task-plan"],
          outputs: [],
        },
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement only the current task.",
          inputs: ["task-plan"],
          outputs: ["implementation"],
          maxAttempts,
          taskPlan: {
            input: "task-plan",
            role: "execute-current",
            max_iterations: maxIterations,
            max_tasks: maxTasks,
          },
        },
        {
          id: "spec-review",
          type: "gate",
          mode: "review",
          runtime: "mock",
          prompt: "Review only the current task against the specification.",
          inputs: ["task-plan", "implementation"],
          outputs: ["spec-review"],
          maxAttempts,
        },
        {
          id: "quality-review",
          type: "gate",
          mode: "review",
          runtime: "mock",
          prompt: "Review only the current task for code quality.",
          inputs: ["task-plan", "implementation", "spec-review"],
          outputs: ["quality-review"],
          maxAttempts,
          taskPlan: {
            input: "task-plan",
            role: "verify-advance",
            max_iterations: maxIterations,
            max_tasks: maxTasks,
          },
        },
        {
          id: "final-review",
          type: "gate",
          mode: "review",
          runtime: "mock",
          prompt: "Run the final holistic review.",
          inputs: ["task-plan", "implementation", "quality-review"],
          outputs: ["final-review"],
          maxAttempts,
          taskPlan: {
            input: "task-plan",
            role: "final",
            max_tasks: maxTasks,
          },
        },
      ],
    },
  };
}

async function writeTaskPlan(
  attemptDirectory: string,
  taskCount: number,
  maxIterations = taskCount,
): Promise<void> {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const sequence = index + 1;
    const id = `T${String(sequence).padStart(3, "0")}`;
    const previousId = `T${String(sequence - 1).padStart(3, "0")}`;
    return {
      id,
      title:
        sequence === 1
          ? "Create the first slice"
          : sequence === 2
            ? "Create the second slice"
            : `Create slice ${sequence}`,
      status: "pending",
      ...(sequence > 1 ? { dependencies: [previousId] } : {}),
      paths: [
        sequence === 1
          ? "src/first.ts"
          : sequence === 2
            ? "src/second.ts"
            : `src/slice-${String(sequence).padStart(3, "0")}.ts`,
      ],
    };
  });
  await writeJson(join(attemptDirectory, "task-plan.json"), {
    version: "nitely.task-plan.v1",
    max_iterations: maxIterations,
    tasks,
  });
  await writeJson(join(attemptDirectory, "artifact.json"), {
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
  });
}

function currentTaskId(prompt: string): string | undefined {
  return /Current task: (T\d{3})\b/.exec(prompt)?.[1];
}

async function startAtApproval(input: {
  repo: string;
  runId: string;
  taskCount?: number;
  maxAttempts?: number;
  maxIterations?: number;
  maxTasks?: number;
}): Promise<{ flowPath: string }> {
  const taskCount = input.taskCount ?? 2;
  const maxIterations = input.maxIterations ?? taskCount;
  const flowPath = join(input.repo, "flows", "production-runtime.json");
  await writeJson(
    flowPath,
    productionFlowFixture(taskCount, {
      maxAttempts: input.maxAttempts,
      maxIterations,
      maxTasks: input.maxTasks,
    }),
  );
  const result = await runFlow(
    { flowPath, repoPath: input.repo, inputs: {} },
    {
      createRunId: () => input.runId,
      executeAgent: async ({ stage, attemptDirectory }) => {
        expect(stage.id).toBe("plan");
        await writeTaskPlan(attemptDirectory, taskCount, maxIterations);
      },
    },
  );
  expect(result).toMatchObject({
    runId: input.runId,
    status: "awaiting-approval",
    approvalId: "approve-plan-1",
  });
  await resolveApproval({
    repoPath: input.repo,
    runId: input.runId,
    approvalId: "approve-plan-1",
    decision: "approved",
    actor: "human:test",
  });
  return { flowPath };
}

async function startBeforeBuiltInTaskPlan(input: {
  repo: string;
  runId: string;
}): Promise<void> {
  const flowPath = join(
    import.meta.dirname,
    "..",
    "..",
    "flows",
    "pilot-issue-to-production.json",
  );
  const flowDocument = JSON.parse(await readFile(flowPath, "utf8")) as {
    metadata: { inputs?: Array<{ id: string }> };
    spec: {
      stages: Array<{
        id: string;
        type: string;
        runtime?: string;
        inputs: string[];
      }>;
    };
  };
  const externalInputIds = new Set(["issue", "repo-notes", "release-runbook"]);
  flowDocument.metadata.inputs = [];
  for (const stage of flowDocument.spec.stages) {
    stage.inputs = stage.inputs.filter((inputId) => !externalInputIds.has(inputId));
    if (stage.type === "agent" || stage.type === "gate") {
      stage.runtime = "mock";
    }
  }
  expect(flowDocument.spec.stages.slice(0, 5).map((stage) => stage.id)).toEqual([
    "draft-spec",
    "approve-spec",
    "draft-tech-design",
    "approve-tech-design",
    "plan-tasks",
  ]);

  const started = await runFlow(
    {
      flowPath,
      flowDocument: JSON.stringify(flowDocument),
      repoPath: input.repo,
      inputs: {},
    },
    {
      createRunId: () => input.runId,
      executeAgent: async ({ stage, attemptDirectory }) => {
        expect(stage.id).toBe("draft-spec");
        await writeFile(join(attemptDirectory, "spec.md"), "# Spec\n", "utf8");
      },
    },
  );
  expect(started).toMatchObject({
    status: "awaiting-approval",
    approvalId: "approve-spec-1",
  });
}

async function approveBuiltInSpec(repo: string, runId: string): Promise<void> {
  await resolveApproval({
    repoPath: repo,
    runId,
    approvalId: "approve-spec-1",
    decision: "approved",
    actor: "human:test",
  });
}

function appendTaskPlanTestEvent(input: {
  repo: string;
  runId: string;
  payload: unknown;
}): void {
  const store = new EventStore(join(input.repo, ".nitely", "events.db"));
  try {
    store.append({
      runId: input.runId,
      type: "task.plan.loop.continues",
      payload: input.payload,
    });
  } finally {
    store.close();
  }
}

async function writePassingStageOutput(input: {
  stageId: string;
  attemptDirectory: string;
  taskId?: string;
}): Promise<void> {
  if (input.stageId === "implement") {
    await writeFile(
      join(input.attemptDirectory, "implementation.md"),
      `implemented ${input.taskId ?? "unknown"}\n`,
      "utf8",
    );
    return;
  }
  await writeFile(
    join(input.attemptDirectory, `${input.stageId}.md`),
    "Review verdict: pass\n",
    "utf8",
  );
}

// Multi-stage process integration needs headroom under full CI worker contention.
const GOVERNED_PRODUCTION_RESUME_TEST_TIMEOUT_MS = 90_000;

describe("governed production Flow resume runtime", {
  timeout: GOVERNED_PRODUCTION_RESUME_TEST_TIMEOUT_MS,
}, () => {
  it("resumes the built-in approval-before-plan sequence before a task plan exists", async () => {
    const repo = await createRepo();
    const runId = "run-production-pre-plan-approval";
    await startBeforeBuiltInTaskPlan({ repo, runId });
    await approveBuiltInSpec(repo, runId);

    const resumedStages: string[] = [];
    const resumed = await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, attemptDirectory }) => {
          resumedStages.push(stage.id);
          expect(stage.id).toBe("draft-tech-design");
          await writeFile(
            join(attemptDirectory, "tech-design.md"),
            "# Technical design\n",
            "utf8",
          );
        },
      },
    );

    expect(resumedStages).toEqual(["draft-tech-design"]);
    expect(resumed).toMatchObject({
      status: "awaiting-approval",
      approvalId: "approve-tech-design-1",
    });
  });

  it.each([
    {
      label: "missing",
      payload: {},
      error: /task plan event task\.plan\.loop\.continues has invalid inputId/,
    },
    {
      label: "non-string",
      payload: { inputId: 42 },
      error: /task plan event task\.plan\.loop\.continues has invalid inputId/,
    },
    {
      label: "whitespace-only",
      payload: { inputId: " \t " },
      error: /task plan event task\.plan\.loop\.continues has invalid inputId/,
    },
    {
      label: "invalid identifier",
      payload: { inputId: "../task-plan" },
      error: /task plan event task\.plan\.loop\.continues has invalid inputId/,
    },
    {
      label: "unknown",
      payload: { inputId: "unknown-task-plan" },
      error:
        /task plan event task\.plan\.loop\.continues references unknown inputId "unknown-task-plan"/,
    },
  ])(
    "fails closed when a task-plan event has a $label inputId",
    async ({ label, payload, error }) => {
      const repo = await createRepo();
      const runId = `run-production-corrupt-task-plan-${label.replaceAll(" ", "-")}`;
      await startBeforeBuiltInTaskPlan({ repo, runId });
      appendTaskPlanTestEvent({ repo, runId, payload });
      await approveBuiltInSpec(repo, runId);

      await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(error);
    },
  );

  it("fails closed when a task-plan event references a missing plan artifact", async () => {
    const repo = await createRepo();
    const runId = "run-production-task-plan-event-without-artifact";
    await startBeforeBuiltInTaskPlan({ repo, runId });
    appendTaskPlanTestEvent({
      repo,
      runId,
      payload: { inputId: "task-plan" },
    });
    await approveBuiltInSpec(repo, runId);

    await expect(resumeRun({ repoPath: repo, runId })).rejects.toThrow(
      "task plan input not found: task-plan",
    );
  });

  it("preserves the complete two-task plan loop after a mandatory approval resume", async () => {
    const repo = await createRepo();
    const runId = "run-production-approval-resume";
    await startAtApproval({ repo, runId });

    const calls: Array<{ stageId: string; taskId?: string; prompt: string }> = [];
    await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          const taskId = currentTaskId(prompt);
          calls.push({ stageId: stage.id, taskId, prompt });
          await writePassingStageOutput({
            stageId: stage.id,
            attemptDirectory,
            taskId,
          });
        },
      },
    );

    expect(calls.map(({ stageId, taskId }) => `${stageId}:${taskId ?? "all"}`))
      .toEqual([
        "implement:T001",
        "spec-review:T001",
        "quality-review:T001",
        "implement:T002",
        "spec-review:T002",
        "quality-review:T002",
        "final-review:all",
      ]);
    for (const call of calls.filter((candidate) => candidate.stageId !== "final-review")) {
      expect(call.taskId).toBeDefined();
      if (call.taskId === "T001") {
        expect(call.prompt).toContain("Create the first slice");
        expect(call.prompt).not.toContain("Create the second slice");
      } else {
        expect(call.prompt).toContain("Create the second slice");
        expect(call.prompt).not.toContain("Create the first slice");
      }
    }

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    const projection = projectRun(events);
    store.close();
    const completedTasks = events.filter(
      (event) => event.type === "task.plan.task.completed",
    );
    expect(completedTasks.map((event) =>
      (event.payload as { currentTaskId?: string }).currentTaskId,
    )).toEqual(["T001", "T002"]);
    expect(new Set(completedTasks.map((event) =>
      (event.payload as { currentTaskId?: string }).currentTaskId,
    )).size).toBe(2);
    expect(events.filter((event) => event.type === "task.plan.final.ready"))
      .toHaveLength(1);
    expect(projection).toMatchObject({
      status: "completed",
      taskPlan: {
        completedTaskIds: ["T001", "T002"],
        remainingTaskIds: [],
      },
    });
  });

  it("resumes a T002 blocker without rerunning completed T001 work", async () => {
    const repo = await createRepo();
    const runId = "run-production-task-blocker";
    await startAtApproval({ repo, runId });

    const calls: string[] = [];
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ stage, prompt, attemptDirectory }) => {
            const taskId = currentTaskId(prompt);
            calls.push(`${stage.id}:${taskId ?? "all"}`);
            if (stage.id === "implement" && taskId === "T002") {
              throw Object.assign(new Error("mock agent exited with code 1"), {
                stdout: "",
                stderr: "Provider usage limit reached; try again in 10 minutes\n",
              });
            }
            await writePassingStageOutput({
              stageId: stage.id,
              attemptDirectory,
              taskId,
            });
          },
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    let store = new EventStore(join(repo, ".nitely", "events.db"));
    let events = store.list(runId);
    let projection = projectRun(events);
    store.close();
    expect(projection).toMatchObject({
      status: "blocked",
      taskPlan: {
        currentTaskId: "T002",
        completedTaskIds: ["T001"],
        remainingTaskIds: ["T002"],
      },
    });
    expect(events.filter((event) => event.type === "task.plan.final.ready"))
      .toHaveLength(0);
    expect(calls).not.toContain("final-review:all");

    await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          const taskId = currentTaskId(prompt);
          calls.push(`${stage.id}:${taskId ?? "all"}`);
          expect(taskId === "T001" && stage.id !== "final-review").toBe(false);
          await writePassingStageOutput({
            stageId: stage.id,
            attemptDirectory,
            taskId,
          });
        },
      },
    );

    store = new EventStore(join(repo, ".nitely", "events.db"));
    events = store.list(runId);
    projection = projectRun(events);
    store.close();
    expect(calls.filter((call) => call === "implement:T001")).toHaveLength(1);
    expect(calls.filter((call) => call === "spec-review:T001")).toHaveLength(1);
    expect(calls.filter((call) => call === "quality-review:T001")).toHaveLength(1);
    expect(events.filter((event) => event.type === "task.plan.task.completed"))
      .toHaveLength(2);
    expect(projection).toMatchObject({
      status: "completed",
      taskPlan: {
        completedTaskIds: ["T001", "T002"],
        remainingTaskIds: [],
      },
    });
    expect(
      projection.stages.find((stage) => stage.stageId === "implement")?.attempts,
    ).toEqual([
      expect.objectContaining({ attempt: 1, status: "completed" }),
      expect.objectContaining({ attempt: 2, status: "blocked" }),
      expect.objectContaining({ attempt: 3, status: "completed" }),
    ]);
  });

  it("applies retry and structured rework policy to reviews reached after resume", async () => {
    const repo = await createRepo();
    const runId = "run-production-resumed-review-policy";
    await startAtApproval({ repo, runId, taskCount: 1 });

    const prompts = new Map<string, string[]>();
    let specReviewCalls = 0;
    let qualityReviewCalls = 0;
    await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          const stagePrompts = prompts.get(stage.id) ?? [];
          stagePrompts.push(prompt);
          prompts.set(stage.id, stagePrompts);
          const taskId = currentTaskId(prompt);
          if (stage.id === "spec-review") {
            specReviewCalls += 1;
            if (specReviewCalls === 1) {
              throw new Error("transient review runtime failure");
            }
          }
          if (stage.id === "quality-review") {
            qualityReviewCalls += 1;
            if (qualityReviewCalls === 1) {
              await writeFile(
                join(attemptDirectory, "quality-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: implementation needs a focused correction",
                  "Instructions: correct the implementation before reviewing again",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
          }
          await writePassingStageOutput({
            stageId: stage.id,
            attemptDirectory,
            taskId,
          });
        },
      },
    );

    expect(prompts.get("implement")).toHaveLength(2);
    expect(prompts.get("spec-review")).toHaveLength(3);
    expect(prompts.get("quality-review")).toHaveLength(2);
    expect(prompts.get("final-review")).toHaveLength(1);
    expect(prompts.get("spec-review")?.[1]).toContain("## Previous Failure Context");
    expect(prompts.get("spec-review")?.[1]).toContain(
      "transient review runtime failure",
    );
    expect(prompts.get("implement")?.[1]).toContain("## Previous Failure Context");
    expect(prompts.get("implement")?.[1]).toContain(
      "correct the implementation before reviewing again",
    );
    for (const stageId of ["implement", "spec-review", "quality-review"]) {
      for (const prompt of prompts.get(stageId) ?? []) {
        expect(prompt).toContain("Current task: T001 Create the first slice");
      }
    }

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    const projection = projectRun(events);
    store.close();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "stage.retrying",
        stageId: "spec-review",
        attempt: 1,
      }),
      expect.objectContaining({
        type: "stage.rework.requested",
        stageId: "quality-review",
        payload: expect.objectContaining({
          targetStage: "implement",
          targetArtifact: "implementation",
        }),
      }),
    ]));
    expect(events.filter((event) => event.type === "task.plan.task.completed"))
      .toHaveLength(1);
    expect(events.filter((event) => event.type === "task.plan.final.ready"))
      .toHaveLength(1);
    expect(projection.status).toBe("completed");
  });

  it("reopens a completed task when final review requests structured rework", async () => {
    const repo = await createRepo();
    const runId = "run-production-final-review-rework";
    await startAtApproval({ repo, runId, maxIterations: 3 });

    const calls: Array<{ stageId: string; taskId?: string; prompt: string }> = [];
    let finalReviewCalls = 0;
    await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          const taskId = currentTaskId(prompt);
          calls.push({ stageId: stage.id, taskId, prompt });
          if (stage.id === "final-review") {
            finalReviewCalls += 1;
            if (finalReviewCalls === 1) {
              await writeFile(
                join(attemptDirectory, "final-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: T002 does not satisfy the final review",
                  "Instructions: reopen T002 and correct it before final review",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
          }
          await writePassingStageOutput({
            stageId: stage.id,
            attemptDirectory,
            taskId,
          });
        },
      },
    );

    expect(calls.map(({ stageId, taskId }) => `${stageId}:${taskId ?? "all"}`))
      .toEqual([
        "implement:T001",
        "spec-review:T001",
        "quality-review:T001",
        "implement:T002",
        "spec-review:T002",
        "quality-review:T002",
        "final-review:all",
        "implement:T002",
        "spec-review:T002",
        "quality-review:T002",
        "final-review:all",
      ]);
    const reworkImplement = calls.filter(
      (call) => call.stageId === "implement" && call.taskId === "T002",
    )[1];
    expect(reworkImplement?.prompt).toContain("## Previous Failure Context");
    expect(reworkImplement?.prompt).toContain(
      "reopen T002 and correct it before final review",
    );
    expect(reworkImplement?.prompt).toContain(
      "Current task: T002 Create the second slice",
    );
    expect(reworkImplement?.prompt).toContain("Iteration: 3/3");
    expect(reworkImplement?.prompt).not.toContain("Create the first slice");

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    const projection = projectRun(events);
    store.close();
    expect(events.filter((event) => event.type === "task.plan.task.completed")
      .map((event) =>
        (event.payload as { currentTaskId?: string }).currentTaskId,
      )).toEqual(["T001", "T002", "T002"]);
    expect(events.filter((event) => event.type === "task.plan.final.ready"))
      .toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === "task.plan.iteration.started")
        .map((event) => (event.payload as { iteration?: number }).iteration),
    ).toEqual([1, 2, 3]);
    expect(projection).toMatchObject({
      status: "completed",
      taskPlan: {
        completedTaskIds: ["T001", "T002"],
        remainingTaskIds: [],
      },
    });
  });

  it("rejects final-review rework after the task-plan iteration cap is exhausted", async () => {
    const repo = await createRepo();
    const runId = "run-production-final-review-rework-cap";
    await startAtApproval({ repo, runId, maxIterations: 2 });

    const calls: string[] = [];
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ stage, prompt, attemptDirectory }) => {
            const taskId = currentTaskId(prompt);
            calls.push(`${stage.id}:${taskId ?? "all"}`);
            if (stage.id === "final-review") {
              await writeFile(
                join(attemptDirectory, "final-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: T002 needs one more correction",
                  "Instructions: reopen T002 after the iteration budget is exhausted",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
            await writePassingStageOutput({
              stageId: stage.id,
              attemptDirectory,
              taskId,
            });
          },
        },
      ),
    ).rejects.toThrow("task plan task-plan exhausted max_iterations 2");

    expect(calls).toEqual([
      "implement:T001",
      "spec-review:T001",
      "quality-review:T001",
      "implement:T002",
      "spec-review:T002",
      "quality-review:T002",
      "final-review:all",
    ]);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events
        .filter((event) => event.type === "task.plan.iteration.started")
        .map((event) => (event.payload as { iteration?: number }).iteration),
    ).toEqual([1, 2]);
    expect(events.filter((event) => event.type === "task.plan.loop.continues"))
      .toHaveLength(1);
  });

  it("rejects a 13-task plan before executing any task when max_tasks is 12", async () => {
    const repo = await createRepo();
    const runId = "run-production-task-plan-max-tasks";
    await startAtApproval({
      repo,
      runId,
      taskCount: 13,
      maxAttempts: 24,
      maxIterations: 24,
      maxTasks: 12,
    });

    let executedStage = false;
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async () => {
            executedStage = true;
          },
        },
      ),
    ).rejects.toThrow(
      'task plan "task-plan" has 13 tasks, exceeding max_tasks 12',
    );
    expect(executedStage).toBe(false);
  });

  it("uses the built-in 12-task retry and rework budget without exhausting stage attempts", async () => {
    const builtInFlow = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "..",
          "flows",
          "pilot-issue-to-production.json",
        ),
        "utf8",
      ),
    ) as {
      spec: {
        stages: Array<{
          id: string;
          maxAttempts?: number;
          taskPlan?: { max_iterations?: number };
        }>;
      };
    };
    const builtInStage = (id: string) =>
      builtInFlow.spec.stages.find((stage) => stage.id === id)!;
    const maxAttempts = builtInStage("implement").maxAttempts!;
    const maxIterations = builtInStage("implement").taskPlan!.max_iterations!;
    const repo = await createRepo();
    const runId = "run-production-12-task-budget";
    await startAtApproval({
      repo,
      runId,
      taskCount: 12,
      maxAttempts,
      maxIterations,
    });

    const calls: Array<{ stageId: string; taskId?: string; prompt: string }> = [];
    let specReviewCalls = 0;
    let finalReviewCalls = 0;
    await resumeRun(
      { repoPath: repo, runId },
      {
        executeAgent: async ({ stage, prompt, attemptDirectory }) => {
          const taskId = currentTaskId(prompt);
          calls.push({ stageId: stage.id, taskId, prompt });
          if (stage.id === "spec-review") {
            specReviewCalls += 1;
            if (specReviewCalls === 1) {
              throw new Error("transient first-task review failure");
            }
          }
          if (stage.id === "final-review") {
            finalReviewCalls += 1;
            if (finalReviewCalls === 1) {
              await writeFile(
                join(attemptDirectory, "final-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: T012 needs a final correction",
                  "Instructions: reopen T012 within the shared rework budget",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
          }
          await writePassingStageOutput({
            stageId: stage.id,
            attemptDirectory,
            taskId,
          });
        },
      },
    );

    expect(calls.filter((call) => call.stageId === "implement")).toHaveLength(13);
    expect(calls.filter((call) => call.stageId === "spec-review")).toHaveLength(14);
    expect(calls.filter((call) => call.stageId === "quality-review")).toHaveLength(13);
    expect(calls.filter((call) => call.stageId === "final-review")).toHaveLength(2);
    const reworkPrompt = calls.filter(
      (call) => call.stageId === "implement" && call.taskId === "T012",
    )[1]?.prompt;
    expect(reworkPrompt).toContain(`Iteration: 13/${maxIterations}`);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    const projection = projectRun(events);
    store.close();
    expect(
      events
        .filter((event) => event.type === "task.plan.iteration.started")
        .map((event) => (event.payload as { iteration?: number }).iteration),
    ).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(projection).toMatchObject({
      status: "completed",
      taskPlan: {
        completedCount: 12,
        remainingCount: 0,
        iteration: 13,
        maxIterations,
      },
    });
  });

  it("fails closed when final rework cannot uniquely identify a completed task", async () => {
    const repo = await createRepo();
    const runId = "run-production-ambiguous-final-rework";
    await startAtApproval({ repo, runId });

    const calls: string[] = [];
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ stage, prompt, attemptDirectory }) => {
            const taskId = currentTaskId(prompt);
            calls.push(`${stage.id}:${taskId ?? "all"}`);
            if (stage.id === "final-review") {
              await writeFile(
                join(attemptDirectory, "final-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: the implementation needs a final correction",
                  "Instructions: correct the implementation before final review",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
            await writePassingStageOutput({
              stageId: stage.id,
              attemptDirectory,
              taskId,
            });
          },
        },
      ),
    ).rejects.toThrow(
      "task plan task-plan cannot determine which completed task to reopen",
    );
    expect(calls).toEqual([
      "implement:T001",
      "spec-review:T001",
      "quality-review:T001",
      "implement:T002",
      "spec-review:T002",
      "quality-review:T002",
      "final-review:all",
    ]);
  });

  it("fails closed when final rework identifies multiple completed tasks", async () => {
    const repo = await createRepo();
    const runId = "run-production-multi-target-final-rework";
    await startAtApproval({ repo, runId });

    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ stage, prompt, attemptDirectory }) => {
            const taskId = currentTaskId(prompt);
            if (stage.id === "final-review") {
              await writeFile(
                join(attemptDirectory, "final-review.md"),
                [
                  "Verdict: needs_fix",
                  "Target stage: implement",
                  "Target artifact: implementation",
                  "Reason: T001 needs another correction",
                  "Instructions: also correct src/second.ts for T002",
                  "",
                ].join("\n"),
                "utf8",
              );
              return;
            }
            await writePassingStageOutput({
              stageId: stage.id,
              attemptDirectory,
              taskId,
            });
          },
        },
      ),
    ).rejects.toThrow(
      "task plan task-plan rework request identifies multiple tasks: T001, T002",
    );
  });

  it("projects a reopened task as incomplete when its rework attempt blocks", async () => {
    const repo = await createRepo();
    const runId = "run-production-reopened-task-blocker";
    await startAtApproval({ repo, runId, maxIterations: 3 });

    let finalReviewCalls = 0;
    let t002ImplementCalls = 0;
    await expect(
      resumeRun(
        { repoPath: repo, runId },
        {
          executeAgent: async ({ stage, prompt, attemptDirectory }) => {
            const taskId = currentTaskId(prompt);
            if (stage.id === "implement" && taskId === "T002") {
              t002ImplementCalls += 1;
              if (t002ImplementCalls === 2) {
                throw Object.assign(new Error("mock agent exited with code 1"), {
                  stdout: "",
                  stderr: "Provider usage limit reached; try again later\n",
                });
              }
            }
            if (stage.id === "final-review") {
              finalReviewCalls += 1;
              if (finalReviewCalls === 1) {
                await writeFile(
                  join(attemptDirectory, "final-review.md"),
                  [
                    "Verdict: needs_fix",
                    "Target stage: implement",
                    "Target artifact: implementation",
                    "Reason: T002 needs a final correction",
                    "Instructions: reopen T002 before final review",
                    "",
                  ].join("\n"),
                  "utf8",
                );
                return;
              }
            }
            await writePassingStageOutput({
              stageId: stage.id,
              attemptDirectory,
              taskId,
            });
          },
        },
      ),
    ).rejects.toThrow(/run blocked by agent_usage_limit on stage implement/);

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list(runId));
    store.close();
    expect(projection).toMatchObject({
      status: "blocked",
      taskPlan: {
        currentTaskId: "T002",
        completedTaskIds: ["T001"],
        remainingTaskIds: ["T002"],
      },
    });
    expect(projection.taskPlan?.completedAt).toBeUndefined();
    expect(projection.taskPlan?.deferredAt).toBeUndefined();
  });
});

describe("typed command output protocol", () => {
  const NON_REGULAR_ATTEMPT_FILE_WATCHDOG_MS = 15_000;
  const nitelyOwnedAttemptFiles = ["stdout.log", "stderr.log", "output.md"] as const;
  const nonRegularKinds = ["symlink", "directory", "fifo"] as const;

  it.each(
    nitelyOwnedAttemptFiles.flatMap((filename) =>
      nonRegularKinds.map((kind) => ({ filename, kind })),
    ),
  )("fails closed quickly when command $filename is a $kind", async ({
    filename,
    kind,
  }) => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", `unsafe-${filename}-${kind}.json`);
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: `unsafe-command-attempt-file-${kind}` },
      spec: {
        maxAttempts: 1,
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["test-report"],
            maxAttempts: 1,
          },
        ],
      },
    });
    const sentinelPath = join(repo, `harmless-${filename}-${kind}-sentinel.txt`);
    const sentinel = `harmless ${filename} ${kind} sentinel\n`;
    await writeFile(sentinelPath, sentinel, "utf8");
    let fifoOutput = "";
    let fifoReader: ChildProcess | undefined;
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options) => {
        const attemptDirectory = options.attemptDirectory;
        expect(attemptDirectory).toBeDefined();
        const targetPath = join(attemptDirectory!, filename);
        if (kind === "symlink") {
          await symlink(sentinelPath, targetPath);
        } else if (kind === "directory") {
          await mkdir(targetPath);
        } else {
          await execFileAsync("mkfifo", [targetPath]);
          fifoReader = spawn("cat", [targetPath], {
            stdio: ["ignore", "pipe", "ignore"],
          });
          fifoReaders.add(fifoReader);
          fifoReader.stdout?.on("data", (chunk: Buffer) => {
            fifoOutput += chunk.toString("utf8");
          });
        }
        return { stdout: "new stdout\n", stderr: "new stderr\n", exitCode: 0 };
      },
    });

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("command attempt file validation timed out")),
        NON_REGULAR_ATTEMPT_FILE_WATCHDOG_MS,
      );
    });
    try {
      await expect(
        Promise.race([
          runFlow(
            { flowPath, repoPath: repo, inputs: {} },
            {
              createRunId: () => `run-unsafe-${filename}-${kind}`,
              backend,
            },
          ),
          deadline,
        ]),
      ).rejects.toThrow(new RegExp(`${filename.replace(".", "\\.")} must be a regular file`));
    } finally {
      if (timeout) clearTimeout(timeout);
      if (fifoReader) {
        await stopChild(fifoReader);
        fifoReaders.delete(fifoReader);
      }
    }

    await expect(readFile(sentinelPath, "utf8")).resolves.toBe(sentinel);
    expect(fifoOutput).toBe("");
  });

  it("atomically replaces existing regular command attempt files", async () => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", "replace-command-attempt-files.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "replace-command-attempt-files" },
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
    let attemptDirectory = "";
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options) => {
        attemptDirectory = options.attemptDirectory!;
        for (const filename of nitelyOwnedAttemptFiles) {
          await writeFile(join(attemptDirectory, filename), `old ${filename}\n`, "utf8");
        }
        return { stdout: "new stdout\n", stderr: "new stderr\n", exitCode: 0 };
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-replace-command-attempt-files", backend },
    );

    await expect(readFile(join(attemptDirectory, "stdout.log"), "utf8")).resolves.toBe(
      "new stdout\n",
    );
    await expect(readFile(join(attemptDirectory, "stderr.log"), "utf8")).resolves.toBe(
      "new stderr\n",
    );
    const output = await readFile(join(attemptDirectory, "output.md"), "utf8");
    expect(output).toContain("# Command Attempt");
    expect(output).not.toContain("old output.md");
    expect((await readdir(attemptDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
  });

  it("registers the redacted command output.md fallback and exposes it downstream", async () => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", "command-fallback.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-fallback" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "./scripts/verify",
            inputs: [],
            outputs: [richMarkdownOutput("verification")],
          },
          {
            id: "consume",
            type: "agent",
            runtime: "mock",
            prompt: "Consume the verification report.",
            inputs: ["verification"],
            outputs: ["done"],
          },
        ],
      },
    });
    let downstreamPrompt = "";
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options) => {
        expect(options).toMatchObject({
          runId: "run-command-fallback",
          stageId: "verify",
          attempt: 1,
          outputDirectory: expect.stringMatching(/\/stages\/verify\/1$/),
          attemptDirectory: expect.stringMatching(/\/stages\/verify\/1$/),
        });
        return {
          stdout: "verification passed\ntoken=command-secret-value\n",
          stderr: "",
          exitCode: 0,
        };
      },
      runAgent: async (_workspace, input) => {
        downstreamPrompt = input.prompt;
        await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-command-fallback", backend },
    );

    expect(downstreamPrompt).toContain("## Input: verification");
    expect(downstreamPrompt).toContain("# Command Attempt");
    expect(downstreamPrompt).toContain("verification passed");
    expect(downstreamPrompt).toContain("token=[REDACTED]");
    expect(downstreamPrompt).not.toContain("command-secret-value");
    const registry = JSON.parse(
      await readFile(
        join(repo, ".nitely", "runs", "run-command-fallback", "artifacts.json"),
        "utf8",
      ),
    ) as { artifacts: Array<Record<string, unknown>> };
    expect(registry.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "verification",
          producer: "verify",
          mediaType: "text/markdown",
          path: "stages/verify/1/output.md",
          attempt: 1,
        }),
      ]),
    );
  });

  it("validates and registers two conventional adapter outputs as one complete set", async () => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", "command-multi-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-multi-output" },
      spec: {
        stages: [
          {
            id: "release",
            type: "command",
            command: "./scripts/nitely/release-production",
            inputs: [],
            outputs: [
              richMarkdownOutput("release-report"),
              richMarkdownOutput("smoke-report"),
            ],
          },
          {
            id: "consume",
            type: "agent",
            runtime: "mock",
            prompt: "Consume both reports.",
            inputs: ["release-report", "smoke-report"],
            outputs: ["done"],
          },
        ],
      },
    });
    let downstreamPrompt = "";
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options) => {
        const outputDirectory = options.outputDirectory;
        expect(outputDirectory).toBeDefined();
        await writeFile(
          join(outputDirectory!, "release-report.md"),
          "# Release\n\nDeployed.\n",
          "utf8",
        );
        await writeFile(
          join(outputDirectory!, "smoke-report.md"),
          "# Smoke\n\nHealthy.\n",
          "utf8",
        );
        return { stdout: "released\n", stderr: "", exitCode: 0 };
      },
      runAgent: async (_workspace, input) => {
        downstreamPrompt = input.prompt;
        await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-command-multi", backend },
    );

    expect(downstreamPrompt).toContain("## Input: release-report");
    expect(downstreamPrompt).toContain("Deployed.");
    expect(downstreamPrompt).toContain("## Input: smoke-report");
    expect(downstreamPrompt).toContain("Healthy.");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-command-multi");
    store.close();
    const releaseEvents = events.filter(
      (event) =>
        event.type === "artifact.published" && event.stageId === "release",
    );
    expect(releaseEvents).toHaveLength(2);
    const completedIndex = events.findIndex(
      (event) => event.type === "stage.completed" && event.stageId === "release",
    );
    expect(releaseEvents.every((event) => events.indexOf(event) < completedIndex)).toBe(
      true,
    );
  });

  it("fails a partial rich output set closed and retries in a fresh attempt directory", async () => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", "command-output-retry.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-output-retry" },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "release",
            type: "command",
            command: "./scripts/nitely/release-production",
            inputs: [],
            outputs: [
              richMarkdownOutput("release-report"),
              richMarkdownOutput("smoke-report"),
            ],
          },
        ],
      },
    });
    const attemptDirectories: string[] = [];
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options, call) => {
        const outputDirectory = options.outputDirectory;
        expect(outputDirectory).toBeDefined();
        attemptDirectories.push(outputDirectory!);
        await writeFile(
          join(outputDirectory!, "release-report.md"),
          `release attempt ${call}\n`,
          "utf8",
        );
        if (call === 2) {
          await writeFile(
            join(outputDirectory!, "smoke-report.md"),
            "healthy\n",
            "utf8",
          );
        }
        return { stdout: "exit zero\n", stderr: "", exitCode: 0 };
      },
    });

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-command-output-retry", backend },
    );

    expect(attemptDirectories).toHaveLength(2);
    expect(attemptDirectories[0]).toMatch(/\/stages\/release\/1$/);
    expect(attemptDirectories[1]).toMatch(/\/stages\/release\/2$/);
    await expect(
      readFile(join(attemptDirectories[0]!, "release-report.md"), "utf8"),
    ).resolves.toBe("release attempt 1\n");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list("run-command-output-retry");
    store.close();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.failed",
          stageId: "release",
          attempt: 1,
          payload: expect.objectContaining({
            error: expect.stringMatching(/missing required output smoke-report/),
          }),
        }),
        expect.objectContaining({
          type: "stage.retrying",
          stageId: "release",
          attempt: 1,
        }),
      ]),
    );
    const releaseArtifacts = events.filter(
      (event) =>
        event.type === "artifact.published" && event.stageId === "release",
    );
    expect(releaseArtifacts).toHaveLength(2);
    expect(releaseArtifacts.every((event) =>
      (event.payload as { artifact?: { attempt?: number } }).artifact?.attempt === 2,
    )).toBe(true);
    expect(
      events
        .filter(
          (event) =>
            event.type === "stage.completed" && event.stageId === "release",
        )
        .map((event) => event.attempt),
    ).toEqual([2]);
    const registry = JSON.parse(
      await readFile(
        join(
          repo,
          ".nitely",
          "runs",
          "run-command-output-retry",
          "artifacts.json",
        ),
        "utf8",
      ),
    ) as { artifacts: Array<{ producer?: string; attempt?: number }> };
    expect(
      registry.artifacts.filter((artifact) => artifact.producer === "release"),
    ).toEqual([
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 2 }),
    ]);
  });

  it("rolls back partial artifact publication before retrying the complete set", async () => {
    for (const failurePoint of ["second-event", "after-persist"] as const) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-command-publication-${failurePoint}`;
      const flowPath = join(repo, "flows", `command-publication-${failurePoint}.json`);
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: `command-publication-${failurePoint}` },
        spec: {
          maxAttempts: 2,
          stages: [
            {
              id: "release",
              type: "command",
              command: "./scripts/nitely/release-production",
              inputs: [],
              outputs: [
                richMarkdownOutput("release-report"),
                richMarkdownOutput("smoke-report"),
              ],
            },
            {
              id: "consume",
              type: "agent",
              runtime: "mock",
              prompt: "Consume the atomically published reports.",
              inputs: ["release-report", "smoke-report"],
              outputs: ["done"],
            },
          ],
        },
      });
      let commandCalls = 0;
      let downstreamPrompt = "";
      const backend = commandProtocolBackend({
        repo,
        runCommand: async (options, call) => {
          commandCalls = call;
          await writeFile(
            join(options.outputDirectory!, "release-report.md"),
            `release attempt ${call}\n`,
            "utf8",
          );
          await writeFile(
            join(options.outputDirectory!, "smoke-report.md"),
            `smoke attempt ${call}\n`,
            "utf8",
          );
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        runAgent: async (_workspace, input) => {
          downstreamPrompt = input.prompt;
          await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
          return { stdout: "", stderr: "" };
        },
      });

      await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend,
          createEventStore: (path) =>
            new ArtifactPublicationFaultStore(path, failurePoint),
        },
      );

      expect(commandCalls).toBe(2);
      expect(downstreamPrompt).toContain("release attempt 2");
      expect(downstreamPrompt).toContain("smoke attempt 2");
      expect(downstreamPrompt).not.toContain("attempt 1");
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const events = store.list(runId);
      store.close();
      expect(
        events
          .filter(
            (event) =>
              event.type === "artifact.published" &&
              event.stageId === "release",
          )
          .map(
            (event) =>
              (event.payload as { artifact?: { attempt?: number } }).artifact
                ?.attempt,
          ),
      ).toEqual([2, 2]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "stage.failed",
            stageId: "release",
            attempt: 1,
          }),
          expect.objectContaining({
            type: "stage.completed",
            stageId: "release",
            attempt: 2,
          }),
        ]),
      );
      const registry = JSON.parse(
        await readFile(
          join(repo, ".nitely", "runs", runId, "artifacts.json"),
          "utf8",
        ),
      ) as {
        artifacts: Array<{
          producer?: string;
          attempt?: number;
          path?: string;
        }>;
      };
      expect(
        registry.artifacts
          .filter((artifact) => artifact.producer === "release")
          .map((artifact) => ({
            attempt: artifact.attempt,
            path: artifact.path,
          })),
      ).toEqual([
        {
          attempt: 2,
          path: "stages/release/2/release-report.md",
        },
        {
          attempt: 2,
          path: "stages/release/2/smoke-report.md",
        },
      ]);
      const manifest = JSON.parse(
        await readFile(
          join(repo, ".nitely", "runs", runId, "context-manifest.json"),
          "utf8",
        ),
      ) as { entries: Array<{ id?: string; runRelativePath?: string }> };
      expect(
        manifest.entries
          .filter((entry) =>
            ["release-report", "smoke-report"].includes(entry.id ?? ""),
          )
          .map((entry) => entry.runRelativePath),
      ).toEqual([
        "stages/release/2/release-report.md",
        "stages/release/2/smoke-report.md",
      ]);
    }
  });

  it("persists typed output files before a short atomic event transaction", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-command-publication-concurrency";
    const flowPath = join(repo, "flows", "command-publication-concurrency.json");
    await writeJson(flowPath, releaseFlowFixture());
    let publicationStore: ArtifactPublicationConcurrencyStore | undefined;
    let peerStore: EventStore | undefined;

    try {
      await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend: commandProtocolBackend({
            repo,
            runCommand: async (options) => {
              await writeFile(
                join(options.outputDirectory!, "release-report.md"),
                "release completed\n",
                "utf8",
              );
              await writeFile(
                join(options.outputDirectory!, "smoke-report.md"),
                "smoke passed\n",
                "utf8",
              );
              return { stdout: "", stderr: "", exitCode: 0 };
            },
          }),
          createEventStore: (path) => {
            peerStore = new EventStore(path);
            publicationStore = new ArtifactPublicationConcurrencyStore(
              path,
              peerStore,
              join(repo, ".nitely", "runs", runId, "artifacts.json"),
            );
            return publicationStore;
          },
        },
      );

      expect(publicationStore?.observedPersistedOutputSet).toBe(true);
      expect(peerStore?.list("run-peer-during-publication")).toHaveLength(1);
      const releaseEvents = peerStore
        ?.list(runId)
        .filter(
          (event) =>
            event.type === "artifact.published" && event.stageId === "release",
        );
      expect(releaseEvents).toHaveLength(2);
      expect(releaseEvents?.[1]?.sequence).toBe(
        (releaseEvents?.[0]?.sequence ?? 0) + 1,
      );
      for (const event of releaseEvents ?? []) {
        expect(
          (event.payload as { artifact?: { createdAt?: string } }).artifact
            ?.createdAt,
        ).toBe(event.createdAt);
      }
    } finally {
      peerStore?.close();
    }
  });

  it("keeps legacy bare-string command outputs lenient", async () => {
    const repo = await createCommandProtocolRepo();
    const flowPath = join(repo, "flows", "legacy-command-output.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "legacy-command-output" },
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
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-legacy-command-output",
          backend: commandProtocolBackend({
            repo,
            runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          }),
        },
      ),
    ).resolves.toMatchObject({ runId: "run-legacy-command-output" });
  });

  it("rehydrates registered command outputs across approval resume without republishing", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-command-approval-resume";
    const flowPath = join(repo, "flows", "command-approval-resume.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-approval-resume" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "./scripts/verify",
            inputs: [],
            outputs: [richMarkdownOutput("verification")],
          },
          {
            id: "approve",
            type: "approval",
            prompt: "Approve the verified result.",
            inputs: ["verification"],
            outputs: [],
          },
          {
            id: "consume",
            type: "agent",
            runtime: "mock",
            prompt: "Consume the resumed verification report.",
            inputs: ["verification"],
            outputs: ["done"],
          },
        ],
      },
    });
    let downstreamPrompt = "";
    const backend = commandProtocolBackend({
      repo,
      runCommand: async (options) => {
        await writeFile(
          join(options.outputDirectory!, "verification.md"),
          "# Verification\n\nPassed before approval.\n",
          "utf8",
        );
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      runAgent: async (_workspace, input) => {
        downstreamPrompt = input.prompt;
        await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    });

    const paused = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => runId, backend },
    );
    expect(paused).toMatchObject({
      status: "awaiting-approval",
      approvalId: "approve-1",
    });
    await resolveApproval({
      repoPath: repo,
      runId,
      approvalId: "approve-1",
      decision: "approved",
      actor: "human:test",
    });

    await resumeRun({ repoPath: repo, runId }, { backend });

    expect(downstreamPrompt).toContain("## Input: verification");
    expect(downstreamPrompt).toContain("Passed before approval.");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events.filter(
        (event) =>
          event.type === "artifact.published" &&
          event.stageId === "verify" &&
          (event.payload as { artifact?: { id?: string } }).artifact?.id ===
            "verification",
      ),
    ).toHaveLength(1);
  });

  it("fails resume closed when a completed command artifact changed or stopped being a regular file", async () => {
    for (const tamperKind of ["content", "directory"] as const) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-command-resume-tamper-${tamperKind}`;
      const flowPath = join(repo, "flows", `command-resume-tamper-${tamperKind}.json`);
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: `command-resume-tamper-${tamperKind}` },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "./scripts/verify",
              inputs: [],
              outputs: [richMarkdownOutput("verification")],
            },
            {
              id: "approve",
              type: "approval",
              prompt: "Approve the verified result.",
              inputs: ["verification"],
              outputs: [],
            },
            {
              id: "consume",
              type: "agent",
              runtime: "mock",
              prompt: "Consume only verified evidence.",
              inputs: ["verification"],
              outputs: ["done"],
            },
          ],
        },
      });
      let agentCalls = 0;
      const backend = commandProtocolBackend({
        repo,
        runCommand: async (options) => {
          await writeFile(
            join(options.outputDirectory!, "verification.md"),
            "# Verification\n\nOriginal evidence.\n",
            "utf8",
          );
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        runAgent: async (_workspace, input) => {
          agentCalls += 1;
          await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
          return { stdout: "", stderr: "" };
        },
      });

      await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend },
      );
      await resolveApproval({
        repoPath: repo,
        runId,
        approvalId: "approve-1",
        decision: "approved",
        actor: "human:test",
      });
      const artifactPath = join(
        repo,
        ".nitely",
        "runs",
        runId,
        "stages",
        "verify",
        "1",
        "verification.md",
      );
      if (tamperKind === "content") {
        await writeFile(artifactPath, "# Verification\n\nTampered evidence.\n", "utf8");
      } else {
        await rm(artifactPath);
        await mkdir(artifactPath);
      }

      await expect(
        resumeRun({ repoPath: repo, runId }, { backend }),
        tamperKind,
      ).rejects.toThrow(
        tamperKind === "content"
          ? /artifact verification path sha256 does not match its registry metadata/
          : /artifact verification path is not a regular file/,
      );
      expect(agentCalls).toBe(0);
      const store = new EventStore(join(repo, ".nitely", "events.db"));
      const published = store.list(runId).filter(
        (event) =>
          event.type === "artifact.published" &&
          event.stageId === "verify" &&
          (event.payload as { artifact?: { id?: string } }).artifact?.id ===
            "verification",
      );
      store.close();
      expect(published).toHaveLength(1);
    }
  });

  it("revalidates registered artifact media and schema contracts on resume", async () => {
    for (const invalidKind of ["media", "schema"] as const) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-command-resume-contract-${invalidKind}`;
      const flowPath = join(repo, "flows", `command-resume-contract-${invalidKind}.json`);
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: `command-resume-contract-${invalidKind}` },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "./scripts/verify",
              inputs: [],
              outputs: [
                {
                  id: "verification",
                  type: "report",
                  description: "typed verification evidence",
                  mediaType: "application/json",
                  schema: {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean" } },
                  },
                },
              ],
            },
            {
              id: "approve",
              type: "approval",
              prompt: "Approve the verified result.",
              inputs: ["verification"],
              outputs: [],
            },
            {
              id: "consume",
              type: "agent",
              runtime: "mock",
              prompt: "Consume only contract-valid evidence.",
              inputs: ["verification"],
              outputs: ["done"],
            },
          ],
        },
      });
      let agentCalls = 0;
      const backend = commandProtocolBackend({
        repo,
        runCommand: async (options) => {
          await writeFile(
            join(options.outputDirectory!, "verification.json"),
            '{"ok":true}\n',
            "utf8",
          );
          await writeJson(join(options.outputDirectory!, "artifact.json"), {
            version: 1,
            stageId: "verify",
            attempt: 1,
            outputs: [
              {
                id: "verification",
                path: "verification.json",
                mediaType: "application/json",
              },
            ],
          });
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        runAgent: async (_workspace, input) => {
          agentCalls += 1;
          await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
          return { stdout: "", stderr: "" };
        },
      });

      await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend },
      );
      const runDirectory = join(repo, ".nitely", "runs", runId);
      const registry = await readArtifactRegistryWithPrivatePaths({
        runDirectory,
        boundaryRoot: repo,
        runId,
      });
      expect(registry).toBeDefined();
      const registryArtifact = registry!.artifacts.find(
        (artifact) => artifact.id === "verification",
      );
      expect(registryArtifact).toBeDefined();
      const database = new DatabaseSync(join(repo, ".nitely", "events.db"));
      const row = database
        .prepare(
          "SELECT sequence, payload_json FROM events WHERE run_id = ? AND stage_id = ? AND type = ?",
        )
        .get(runId, "verify", "artifact.published") as
        | { sequence: number; payload_json: string }
        | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload_json) as {
        artifact: {
          mediaType?: string;
          sha256?: string;
          size?: number;
        };
      };
      if (invalidKind === "media") {
        registryArtifact!.mediaType = "text/plain";
        payload.artifact.mediaType = "text/plain";
      } else {
        delete registryArtifact!.sha256;
        delete registryArtifact!.size;
        delete payload.artifact.sha256;
        delete payload.artifact.size;
        await writeFile(
          join(
            repo,
            ".nitely",
            "runs",
            runId,
            "stages",
            "verify",
            "1",
            "verification.json",
          ),
          '{"ok":"yes"}\n',
          "utf8",
        );
      }
      await writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repo,
        runId,
        artifacts: registry!.artifacts,
        redactionSecrets: [],
      });
      database
        .prepare("UPDATE events SET payload_json = ? WHERE sequence = ?")
        .run(JSON.stringify(payload), row!.sequence);
      database.close();
      await resolveApproval({
        repoPath: repo,
        runId,
        approvalId: "approve-1",
        decision: "approved",
        actor: "human:test",
      });

      await expect(
        resumeRun({ repoPath: repo, runId }, { backend }),
        invalidKind,
      ).rejects.toThrow(
        invalidKind === "media"
          ? /media type text\/plain does not match application\/json/
          : /failed schema validation/,
      );
      expect(agentCalls).toBe(0);
    }
  });

  it("rehydrates a rich review gate result across approval and rejects tampering", async () => {
    for (const tamperKind of ["clean", "content", "media"] as const) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-rich-review-approval-${tamperKind}`;
      const flowPath = join(repo, "flows", `${runId}.json`);
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: runId },
        spec: {
          stages: [
            {
              id: "review",
              type: "gate",
              mode: "review",
              runtime: "mock",
              prompt: "Review release readiness.",
              inputs: [],
              outputs: [richMarkdownOutput("review-report")],
            },
            {
              id: "approve-release",
              type: "approval",
              prompt: "Approve the reviewed release.",
              inputs: ["review-report"],
              outputs: [],
            },
            {
              id: "consume",
              type: "agent",
              runtime: "mock",
              prompt: "Consume the approved review.",
              inputs: ["review-report"],
              outputs: ["done"],
            },
          ],
        },
      });
      let downstreamPrompt = "";
      const executeAgent = async (input: {
        stage: { id: string };
        prompt: string;
        attemptDirectory: string;
      }) => {
        if (input.stage.id === "review") {
          await writeFile(
            join(input.attemptDirectory, "review-report.md"),
            "Review verdict: pass\n\nRelease is ready.\n",
            "utf8",
          );
          return;
        }
        downstreamPrompt = input.prompt;
        await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
      };

      const paused = await runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, executeAgent },
      );
      expect(paused).toMatchObject({
        status: "awaiting-approval",
        approvalId: "approve-release-1",
      });
      const runDirectory = join(repo, ".nitely", "runs", runId);
      const gateResultPath = join(
        runDirectory,
        "stages",
        "review",
        "1",
        "review-report.json",
      );
      const registry = await readArtifactRegistryWithPrivatePaths({
        runDirectory,
        boundaryRoot: repo,
        runId,
      });
      expect(registry).toBeDefined();
      const gateArtifact = registry!.artifacts.find(
        (artifact) => artifact.id === "review-report",
      );
      expect(gateArtifact).toEqual(
        expect.objectContaining({
          type: "gate.result",
          mediaType: "application/json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          size: expect.any(Number),
          schema: expect.objectContaining({
            type: "object",
            required: expect.arrayContaining([
              "id",
              "stageId",
              "mode",
              "status",
              "createdAt",
            ]),
          }),
        }),
      );
      await resolveApproval({
        repoPath: repo,
        runId,
        approvalId: "approve-release-1",
        decision: "approved",
        actor: "human:test",
      });
      if (tamperKind === "content") {
        await writeFile(gateResultPath, '{"status":"tampered"}\n', "utf8");
        await expect(
          resumeRun({ repoPath: repo, runId }, { executeAgent }),
        ).rejects.toThrow(
          /artifact review-report path size does not match its registry metadata/,
        );
        expect(downstreamPrompt).toBe("");
      } else if (tamperKind === "media") {
        gateArtifact!.mediaType = "text/markdown";
        await writeArtifactRegistry({
          runDirectory,
          boundaryRoot: repo,
          runId,
          artifacts: registry!.artifacts,
          redactionSecrets: [],
        });
        const database = new DatabaseSync(join(repo, ".nitely", "events.db"));
        const artifactRows = database
          .prepare(
            "SELECT sequence, payload_json FROM events WHERE run_id = ? AND stage_id = ? AND type = ?",
          )
          .all(runId, "review", "artifact.published") as Array<{
            sequence: number;
            payload_json: string;
          }>;
        const artifactRow = artifactRows.find(({ payload_json }) => {
          const payload = JSON.parse(payload_json) as {
            artifact?: { id?: string };
          };
          return payload.artifact?.id === "review-report";
        });
        expect(artifactRow).toBeDefined();
        const payload = JSON.parse(artifactRow!.payload_json) as {
          artifact: { mediaType?: string };
        };
        payload.artifact.mediaType = "text/markdown";
        database
          .prepare("UPDATE events SET payload_json = ? WHERE sequence = ?")
          .run(JSON.stringify(payload), artifactRow!.sequence);
        database.close();
        await expect(
          resumeRun({ repoPath: repo, runId }, { executeAgent }),
        ).rejects.toThrow(
          /media type text\/markdown does not match application\/json/,
        );
        expect(downstreamPrompt).toBe("");
      } else {
        await resumeRun({ repoPath: repo, runId }, { executeAgent });
        expect(downstreamPrompt).toContain("Review verdict: pass");
        const store = new EventStore(join(repo, ".nitely", "events.db"));
        const published = store.list(runId).filter(
          (event) =>
            event.type === "artifact.published" &&
            event.stageId === "review" &&
            (event.payload as { artifact?: { id?: string } }).artifact?.id ===
              "review-report",
        );
        store.close();
        expect(published).toHaveLength(1);
      }
    }
  });

  it("does not invoke legacy agent rehydration after registry verification", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-agent-registry-only-resume";
    const flowPath = join(repo, "flows", `${runId}.json`);
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: runId },
      spec: {
        stages: [
          {
            id: "prepare",
            type: "agent",
            runtime: "mock",
            prompt: "Prepare evidence.",
            inputs: [],
            outputs: [richMarkdownOutput("prepared")],
          },
          {
            id: "approve",
            type: "approval",
            prompt: "Approve prepared evidence.",
            inputs: ["prepared"],
            outputs: [],
          },
          {
            id: "consume",
            type: "agent",
            runtime: "mock",
            prompt: "Consume verified prepared evidence.",
            inputs: ["prepared"],
            outputs: ["done"],
          },
        ],
      },
    });
    let downstreamPrompt = "";
    const executeAgent = async (input: {
      stage: { id: string };
      prompt: string;
      attemptDirectory: string;
    }) => {
      if (input.stage.id === "prepare") {
        await writeFile(
          join(input.attemptDirectory, "custom-prepared.data"),
          "registry-verified custom evidence\n",
          "utf8",
        );
        await writeJson(join(input.attemptDirectory, "artifact.json"), {
          version: 1,
          stageId: "prepare",
          attempt: 1,
          outputs: [
            {
              id: "prepared",
              path: "custom-prepared.data",
              mediaType: "text/markdown",
            },
          ],
        });
        return;
      }
      downstreamPrompt = input.prompt;
      await writeFile(join(input.attemptDirectory, "done.md"), "consumed\n", "utf8");
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => runId, executeAgent },
    );
    await rm(
      join(
        repo,
        ".nitely",
        "runs",
        runId,
        "stages",
        "prepare",
        "1",
        "artifact.json",
      ),
    );
    await resolveApproval({
      repoPath: repo,
      runId,
      approvalId: "approve-1",
      decision: "approved",
      actor: "human:test",
    });

    await resumeRun({ repoPath: repo, runId }, { executeAgent });

    expect(downstreamPrompt).toContain("registry-verified custom evidence");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const published = store.list(runId).filter(
      (event) =>
        event.type === "artifact.published" &&
        event.stageId === "prepare" &&
        (event.payload as { artifact?: { id?: string } }).artifact?.id ===
          "prepared",
    );
    store.close();
    expect(published).toHaveLength(1);
  });
});

describe("production release safety contract", () => {
  it("durably links every recursively created adapter directory before use", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-directory-durability";
    const adapterRoot = join(repo, "nested", "durable", "release-root");
    const outputDirectory = join(repo, "adapter-output", "directory-durability");
    await mkdir(outputDirectory, { recursive: true });

    const events: ReleaseDurabilityEvent[] = [];
    const awaitingParentSync = new Set<string>();
    const observeDurability = (event: ReleaseDurabilityEvent) => {
      events.push(event);
      if (event.type === "directory-created") {
        awaitingParentSync.add(event.directory);
        return;
      }
      if (
        event.type === "directory-synced" &&
        event.path !== undefined &&
        awaitingParentSync.has(event.path)
      ) {
        awaitingParentSync.delete(event.path);
        return;
      }
      if (awaitingParentSync.size > 0) {
        throw new Error(
          `fault observer saw ${event.type} before parent directory fsync`,
        );
      }
    };
    const adapter = createDurableReleaseAdapterFixture({
      repo: adapterRoot,
      durabilityRoot: repo,
      runId,
      observeDurability,
    });

    let result: CommandResult;
    try {
      result = await adapter.runCommand({
        runId,
        stageId: "release",
        attempt: 1,
        attemptDirectory: outputDirectory,
        outputDirectory,
      });
    } catch (error) {
      if (
        ["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        expect(
          events.some(
            ({ type }) =>
              type === "lock-open-started" || type === "atomic-write-started",
          ),
        ).toBe(false);
        return;
      }
      throw error;
    }

    expect(result.exitCode).toBe(0);
    expect(awaitingParentSync).toEqual(new Set());
    const recursivelyCreatedDirectories = [
      join(repo, "nested"),
      join(repo, "nested", "durable"),
      adapterRoot,
      join(adapterRoot, ".release-locks"),
      join(adapterRoot, ".fake-release-state"),
      join(adapterRoot, ".release-receipts"),
    ];
    expect(
      events
        .filter(({ type }) => type === "directory-created")
        .map(({ directory }) => directory),
    ).toEqual(recursivelyCreatedDirectories);
    expect(
      [
        ...new Set(
          events
            .filter(
              ({ type, path }) =>
                type === "directory-synced" &&
                path !== undefined &&
                recursivelyCreatedDirectories.includes(path),
            )
            .map(({ path }) => path),
        ),
      ],
    ).toEqual(recursivelyCreatedDirectories);

    const expectDurableUse = (
      observedEvents: ReleaseDurabilityEvent[],
      path: string,
    ) => {
      const containingDirectory = dirname(path);
      const parentSync = observedEvents.findIndex(
        (event) =>
          event.type === "directory-synced" &&
          event.directory === dirname(containingDirectory) &&
          event.path === containingDirectory,
      );
      const useStarted = observedEvents.findIndex(
        (event) =>
          (event.type === "lock-open-started" ||
            event.type === "atomic-write-started") &&
          event.path === path,
      );
      const containingSync = observedEvents.findIndex(
        (event) =>
          event.type === "directory-synced" &&
          event.directory === containingDirectory &&
          event.path === path,
      );
      expect(parentSync, path).toBeGreaterThanOrEqual(0);
      expect(useStarted, path).toBeGreaterThan(parentSync);
      expect(containingSync, path).toBeGreaterThan(useStarted);
    };
    for (const path of [
      adapter.paths.lockPath,
      adapter.paths.externalStatePath,
      adapter.paths.receiptPath,
    ]) {
      expectDurableUse(events, path);
    }

    const existingDirectoryEventStart = events.length;
    const existingDirectoryRunId = `${runId}-existing-directories`;
    const existingDirectoryAdapter = createDurableReleaseAdapterFixture({
      repo: adapterRoot,
      durabilityRoot: repo,
      runId: existingDirectoryRunId,
      observeDurability,
    });
    const existingDirectoryOutput = join(
      repo,
      "adapter-output",
      "existing-directory-durability",
    );
    await mkdir(existingDirectoryOutput, { recursive: true });
    const existingDirectoryResult = await existingDirectoryAdapter.runCommand({
      runId: existingDirectoryRunId,
      stageId: "release",
      attempt: 1,
      attemptDirectory: existingDirectoryOutput,
      outputDirectory: existingDirectoryOutput,
    });
    expect(existingDirectoryResult.exitCode).toBe(0);
    const existingDirectoryEvents = events.slice(existingDirectoryEventStart);
    expect(
      existingDirectoryEvents.some(
        ({ type }) => type === "directory-created",
      ),
    ).toBe(false);
    for (const path of [
      existingDirectoryAdapter.paths.lockPath,
      existingDirectoryAdapter.paths.externalStatePath,
      existingDirectoryAdapter.paths.receiptPath,
    ]) {
      expectDurableUse(existingDirectoryEvents, path);
    }
  });

  it("resyncs every ancestor after a crash between recursive mkdir and fsync", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-directory-retry-durability";
    const adapterRoot = join(repo, "nested-retry", "durable", "release-root");
    const lockDirectory = join(adapterRoot, ".release-locks");

    // Model the exact filesystem image left when recursive mkdir succeeds and
    // the process dies before it can fsync any newly linked directory.
    await mkdir(lockDirectory, { recursive: true });

    const events: ReleaseDurabilityEvent[] = [];
    const adapter = createDurableReleaseAdapterFixture({
      repo: adapterRoot,
      durabilityRoot: repo,
      runId,
      observeDurability: (event) => events.push(event),
    });
    const outputDirectory = join(
      repo,
      "adapter-output",
      "directory-retry-durability",
    );
    await mkdir(outputDirectory, { recursive: true });

    const result = await adapter.runCommand({
      runId,
      stageId: "release",
      attempt: 1,
      attemptDirectory: outputDirectory,
      outputDirectory,
    });

    expect(result.exitCode).toBe(0);
    const lockStarted = events.findIndex(
      ({ type }) => type === "lock-open-started",
    );
    expect(lockStarted).toBeGreaterThanOrEqual(0);
    const preLockEvents = events.slice(0, lockStarted);
    expect(
      preLockEvents.some(({ type }) => type === "directory-created"),
    ).toBe(false);
    expect(
      preLockEvents
        .filter(({ type }) => type === "directory-synced")
        .map(({ path }) => path),
    ).toEqual([
      join(repo, "nested-retry"),
      join(repo, "nested-retry", "durable"),
      adapterRoot,
      lockDirectory,
    ]);
  });

  it("finishes rollback-in-progress before returning from either crash window", async () => {
    for (const externalRollbackApplied of [false, true]) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-release-rollback-recovery-${externalRollbackApplied}`;
      await seedRollbackRecoveryFixtureState({
        repo,
        runId,
        externalRollbackApplied,
      });
      const outputDirectory = join(repo, "adapter-output", "rollback-recovery");

      const result = await invokeReleaseAdapter({
        backend: durableReleaseAdapterFixture({ repo, runId }).backend,
        repo,
        runId,
        attempt: 2,
        outputDirectory,
      });

      expect(result.exitCode, String(externalRollbackApplied)).toBe(70);
      const { receipt, externalState } = await readReleaseFixtureState(
        repo,
        runId,
      );
      expect(receipt, String(externalRollbackApplied)).toMatchObject({
        phase: "rolled-back",
        terminalError: "post-deploy verification failed",
        provenanceAttempts: [1, 2],
        transitions: expect.arrayContaining([
          externalRollbackApplied ? "rollback-reconciled" : "rollback-recorded",
        ]),
      });
      expect(externalState, String(externalRollbackApplied)).toMatchObject({
        productionSha: "production-sha-before-release",
        rollbackMutations: 1,
        mutationLog: ["merge", "deploy", "rollback"],
      });
      await expect(
        readFile(join(outputDirectory, "release-report.md"), "utf8"),
      ).rejects.toThrow();
    }
  });

  it("reclaims a receipt lock left by a terminated process", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-stale-lock";
    const adapter = durableReleaseAdapterFixture({ repo, runId });
    const { lockPath } = adapter;
    const lockOwner = await startCrashHeldSqliteLock(lockPath);
    await crashChild(lockOwner);

    const startedAt = Date.now();
    const result = await invokeReleaseAdapter({
      backend: adapter.backend,
      repo,
      runId,
      attempt: 1,
      outputDirectory: join(repo, "adapter-output", "after-stale-lock"),
    });

    expect(result.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const database = new DatabaseSync(lockPath);
    expect(() => database.exec("BEGIN EXCLUSIVE; ROLLBACK")).not.toThrow();
    database.close();
  }, 15_000);

  it("blocks separate adapter processes until a crashed lock owner releases", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-cross-process-lock";
    const adapter = durableReleaseAdapterFixture({ repo, runId });
    const { lockPath } = adapter;
    const lockOwner = await startCrashHeldSqliteLock(lockPath);
    const attemptCount = 8;
    const workers = await Promise.all(
      Array.from({ length: attemptCount }, (_, index) =>
        startReleaseAdapterWorker({
          repo,
          runId,
          attempt: index + 1,
          outputDirectory: join(
            repo,
            "adapter-output",
            `concurrent-stale-${index + 1}`,
          ),
        }),
      ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(
      workers.map(({ child }) => ({
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      })),
    ).toEqual(
      Array.from({ length: attemptCount }, () => ({
        exitCode: null,
        signalCode: null,
      })),
    );

    await crashChild(lockOwner);
    const results = await Promise.all(
      workers.map(({ completion }) => completion),
    );

    expect(results.map(({ exitCode }) => exitCode)).toEqual(
      Array.from({ length: attemptCount }, () => 0),
    );
    const { receipt, externalState } = await readReleaseFixtureState(
      repo,
      runId,
    );
    expect([...receipt.provenanceAttempts].sort((left, right) => left - right)).toEqual(
      Array.from({ length: attemptCount }, (_, index) => index + 1),
    );
    expect(externalState).toMatchObject({
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 0,
    });
  }, 30_000);

  it("rolls production back before returning a terminal release failure", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-rollback-before-failure";
    const flowPath = join(repo, "flows", "release-rollback-before-failure.json");
    await writeJson(flowPath, releaseFlowFixture());
    const adapter = durableReleaseAdapterFixture({
      repo,
      runId,
      terminalFailureAfterDeploy: "post-deploy verification failed",
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend: adapter.backend },
      ),
    ).rejects.toThrow(/after 1 of 1 attempts.*exit code 70/s);

    const externalState = JSON.parse(
      await readFile(
        join(repo, ".fake-release-state", `${runId}--release.json`),
        "utf8",
      ),
    ) as FakeReleaseEnvironmentState;
    expect(externalState).toMatchObject({
      rollbackBaseline: "production-sha-before-release",
      scmHead: "release-sha",
      productionSha: "production-sha-before-release",
      operationTokens: {
        merge: `${runId}:release:merge`,
        deploy: `${runId}:release:deploy`,
        rollback: `${runId}:release:rollback`,
      },
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 1,
      mutationLog: ["merge", "deploy", "rollback"],
    });
    const receipt = JSON.parse(
      await readFile(adapter.receiptPath, "utf8"),
    ) as DurableReleaseReceipt;
    expect(receipt).toMatchObject({
      phase: "rolled-back",
      terminalError: "post-deploy verification failed",
      transitions: [
        "baseline-captured",
        "merge-recorded",
        "deploy-recorded",
        "post-deploy-failure-observed",
        "rollback-recorded",
      ],
    });

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events.filter(
        (event) =>
          (event.type === "stage.retrying" ||
            event.type === "artifact.published") &&
          event.stageId === "release",
      ),
    ).toEqual([]);
    expect(projectRun(events)).toMatchObject({
      status: "failed",
      stages: [
        {
          stageId: "release",
          attempts: [{ attempt: 1, status: "failed" }],
        },
      ],
    });
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", " \t\n"],
  ] as const)(
    "rejects %s injected terminal release failure before writing state",
    async (_name, invalidTerminalFailure) => {
      const repo = await createCommandProtocolRepo();
      const runId = `run-release-invalid-injected-terminal-${invalidTerminalFailure.length}`;

      expect(() =>
        createDurableReleaseAdapterFixture({
          repo,
          runId,
          terminalFailureAfterDeploy: invalidTerminalFailure,
        }),
      ).toThrow(/terminal failure.*non-blank/i);

      for (const path of [
        join(repo, ".release-locks", `${runId}--release.sqlite`),
        join(repo, ".release-receipts", `${runId}--release.json`),
        join(repo, ".fake-release-state", `${runId}--release.json`),
        join(repo, "adapter-output", "release-report.md"),
        join(repo, "adapter-output", "smoke-report.md"),
      ]) {
        await expect(readFile(path, "utf8"), path).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(readdir(repo)).resolves.not.toEqual(
        expect.arrayContaining([
          ".release-locks",
          ".release-receipts",
          ".fake-release-state",
        ]),
      );
    },
  );

  it("reconciles every durable release phase and replays completed evidence", async () => {
    const scenarios: Array<{
      name: string;
      phase: Exclude<DurableReleaseReceipt["phase"], "rolled-back">;
      externalMergeAhead?: boolean;
    }> = [
      {
        name: "baseline-captured",
        phase: "baseline-captured",
      },
      {
        name: "baseline-captured after merge side effect",
        phase: "baseline-captured",
        externalMergeAhead: true,
      },
      { name: "merged", phase: "merged" },
      { name: "deployed", phase: "deployed" },
      { name: "completed", phase: "completed" },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const repo = await createCommandProtocolRepo();
      const runId = `run-release-phase-${index}`;
      const { paths, completedEvidence } = await seedReleaseFixtureState({
        repo,
        runId,
        phase: scenario.phase,
        externalMergeAhead: scenario.externalMergeAhead,
      });
      const outputDirectory = join(repo, "adapter-output", "reconciled");
      const result = await invokeReleaseAdapter({
        backend: durableReleaseAdapterFixture({ repo, runId }).backend,
        repo,
        runId,
        attempt: 2,
        outputDirectory,
      });

      expect(result.exitCode, scenario.name).toBe(0);
      const { receipt: finalReceipt, externalState: finalExternalState } =
        await readReleaseFixtureState(repo, runId);
      expect(finalReceipt.phase, scenario.name).toBe("completed");
      expect(finalReceipt.provenanceAttempts, scenario.name).toEqual([1, 2]);
      expect(finalExternalState, scenario.name).toMatchObject({
        mergeMutations: 1,
        deployMutations: 1,
        rollbackMutations: 0,
      });
      const releaseReport = await readFile(
        join(outputDirectory, "release-report.md"),
        "utf8",
      );
      const smokeReport = await readFile(
        join(outputDirectory, "smoke-report.md"),
        "utf8",
      );
      if (scenario.phase === "completed") {
        expect(releaseReport, scenario.name).toBe(
          completedEvidence.releaseReport,
        );
        expect(smokeReport, scenario.name).toBe(completedEvidence.smokeReport);
      } else {
        expect(releaseReport, scenario.name).toContain(paths.idempotencyKey);
        expect(smokeReport, scenario.name).toContain("Production is healthy");
      }
    }
  });

  it.each([
    ["merge", ""],
    ["merge", " \t"],
    ["deploy", ""],
    ["deploy", " \n"],
    ["rollback", ""],
    ["rollback", " \r\n"],
  ] as const)("fails closed on a blank or whitespace durable %s marker", async (
    marker,
    invalidToken,
  ) => {
    const repo = await createCommandProtocolRepo();
    const runId = `run-release-invalid-${marker}-${invalidToken.length}`;
    const paths =
      marker === "rollback"
        ? await seedRollbackRecoveryFixtureState({
            repo,
            runId,
            externalRollbackApplied: true,
          })
        : (
            await seedReleaseFixtureState({
              repo,
              runId,
              phase: "deployed",
            })
          ).paths;
    const externalState = JSON.parse(
      await readFile(paths.externalStatePath, "utf8"),
    ) as FakeReleaseEnvironmentState;
    externalState.operationTokens[marker] = invalidToken;
    await writeJson(paths.externalStatePath, externalState);
    const externalBefore = await readFile(paths.externalStatePath, "utf8");
    const receiptBefore = await readFile(paths.receiptPath, "utf8");
    const outputDirectory = join(
      repo,
      "adapter-output",
      `invalid-${marker}-${invalidToken.length}`,
    );

    const result = await invokeReleaseAdapter({
      backend: durableReleaseAdapterFixture({ repo, runId }).backend,
      repo,
      runId,
      attempt: 2,
      outputDirectory,
    });

    expect(result).toMatchObject({
      exitCode: 78,
      stderr: expect.stringMatching(/operation token/i),
    });
    await expect(readFile(paths.externalStatePath, "utf8")).resolves.toBe(
      externalBefore,
    );
    await expect(readFile(paths.receiptPath, "utf8")).resolves.toBe(
      receiptBefore,
    );
    await expect(
      readFile(join(outputDirectory, "release-report.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(outputDirectory, "smoke-report.md"), "utf8"),
    ).rejects.toThrow();
  });

  it.each(["", " \t\n"])(
    "fails closed on a blank or whitespace durable terminal error",
    async (invalidTerminalError) => {
      const repo = await createCommandProtocolRepo();
      const runId = `run-release-invalid-terminal-error-${invalidTerminalError.length}`;
      const paths = await seedRollbackRecoveryFixtureState({
        repo,
        runId,
        externalRollbackApplied: false,
      });
      const receipt = JSON.parse(
        await readFile(paths.receiptPath, "utf8"),
      ) as DurableReleaseReceipt;
      receipt.terminalError = invalidTerminalError;
      await writeJson(paths.receiptPath, receipt);
      const externalBefore = await readFile(paths.externalStatePath, "utf8");
      const receiptBefore = await readFile(paths.receiptPath, "utf8");
      const outputDirectory = join(
        repo,
        "adapter-output",
        "blank-terminal-error",
      );

      const result = await invokeReleaseAdapter({
        backend: durableReleaseAdapterFixture({ repo, runId }).backend,
        repo,
        runId,
        attempt: 2,
        outputDirectory,
      });

      expect(result).toMatchObject({
        exitCode: 78,
        stderr: expect.stringMatching(/terminal error/i),
      });
      await expect(readFile(paths.externalStatePath, "utf8")).resolves.toBe(
        externalBefore,
      );
      await expect(readFile(paths.receiptPath, "utf8")).resolves.toBe(
        receiptBefore,
      );
      await expect(
        readFile(join(outputDirectory, "release-report.md"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(join(outputDirectory, "smoke-report.md"), "utf8"),
      ).rejects.toThrow();
    },
  );

  it("recovers a pristine external-only initialization after a crash", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-initialization-crash";
    const first = durableReleaseAdapterFixture({
      repo,
      runId,
      interruptAfterInitialExternalState: () => {
        throw new Error("simulated initialization crash");
      },
    });
    const firstOutput = join(repo, "adapter-output", "initialization-crash");

    const interrupted = await invokeReleaseAdapter({
      backend: first.backend,
      repo,
      runId,
      attempt: 1,
      outputDirectory: firstOutput,
    });
    expect(interrupted).toMatchObject({
      exitCode: 78,
      stderr: expect.stringMatching(/simulated initialization crash/),
    });
    await expect(readFile(first.receiptPath, "utf8")).rejects.toThrow();
    await expect(
      readFile(
        join(repo, ".fake-release-state", `${runId}--release.json`),
        "utf8",
      ),
    ).resolves.toContain('"mergeMutations": 0');

    const resumed = await invokeReleaseAdapter({
      backend: durableReleaseAdapterFixture({ repo, runId }).backend,
      repo,
      runId,
      attempt: 2,
      outputDirectory: join(repo, "adapter-output", "initialization-resumed"),
    });

    expect(resumed.exitCode).toBe(0);
    const { receipt, externalState } = await readReleaseFixtureState(repo, runId);
    expect(receipt).toMatchObject({
      provenanceAttempts: [2],
      phase: "completed",
    });
    expect(externalState).toMatchObject({
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 0,
      mutationLog: ["merge", "deploy"],
    });
  });

  it("fails closed on non-pristine external-only initialization state", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-non-pristine-external-only";
    const interruptedFixture = durableReleaseAdapterFixture({
      repo,
      runId,
      interruptAfterInitialExternalState: () => {
        throw new Error("simulated initialization crash");
      },
    });
    await invokeReleaseAdapter({
      backend: interruptedFixture.backend,
      repo,
      runId,
      attempt: 1,
      outputDirectory: join(repo, "adapter-output", "non-pristine-crash"),
    });
    const externalStatePath = join(
      repo,
      ".fake-release-state",
      `${runId}--release.json`,
    );
    const externalState = JSON.parse(
      await readFile(externalStatePath, "utf8"),
    ) as FakeReleaseEnvironmentState;
    externalState.scmHead = "release-sha";
    externalState.operationTokens.merge = `${runId}:release:merge`;
    externalState.mergeMutations = 1;
    externalState.mutationLog.push("merge");
    await writeJson(externalStatePath, externalState);
    const externalBefore = await readFile(externalStatePath, "utf8");

    const result = await invokeReleaseAdapter({
      backend: durableReleaseAdapterFixture({ repo, runId }).backend,
      repo,
      runId,
      attempt: 2,
      outputDirectory: join(repo, "adapter-output", "non-pristine-resume"),
    });

    expect(result).toMatchObject({
      exitCode: 78,
      stderr: expect.stringMatching(/not an exact pristine initialization/),
    });
    await expect(readFile(externalStatePath, "utf8")).resolves.toBe(
      externalBefore,
    );
    await expect(readFile(interruptedFixture.receiptPath, "utf8")).rejects.toThrow();
  });

  it("serializes concurrent invocations for one release identity", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-concurrent";
    const first = durableReleaseAdapterFixture({ repo, runId });
    const second = durableReleaseAdapterFixture({ repo, runId });
    const firstOutput = join(repo, "adapter-output", "first");
    const secondOutput = join(repo, "adapter-output", "second");

    const results = await Promise.all([
      invokeReleaseAdapter({
        backend: first.backend,
        repo,
        runId,
        attempt: 1,
        outputDirectory: firstOutput,
      }),
      invokeReleaseAdapter({
        backend: second.backend,
        repo,
        runId,
        attempt: 2,
        outputDirectory: secondOutput,
      }),
    ]);

    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
    const receipt = JSON.parse(
      await readFile(first.receiptPath, "utf8"),
    ) as DurableReleaseReceipt;
    expect([...receipt.provenanceAttempts].sort()).toEqual([1, 2]);
    expect(receipt.phase).toBe("completed");
    const externalState = JSON.parse(
      await readFile(
        join(repo, ".fake-release-state", `${runId}--release.json`),
        "utf8",
      ),
    ) as FakeReleaseEnvironmentState;
    expect(externalState).toMatchObject({
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 0,
    });
    expect(
      (externalState.mutationLog ?? []).filter((entry) => entry === "merge"),
    ).toHaveLength(1);
    expect(
      (externalState.mutationLog ?? []).filter((entry) => entry === "deploy"),
    ).toHaveLength(1);
    await expect(
      readFile(join(firstOutput, "release-report.md"), "utf8"),
    ).resolves.toContain(`${runId}:release`);
    await expect(
      readFile(join(secondOutput, "smoke-report.md"), "utf8"),
    ).resolves.toContain("Production is healthy");
    await expect(readdir(join(repo, ".release-receipts"))).resolves.toEqual([
      `${runId}--release.json`,
    ]);
  });

  it("recovers from an orphan atomic-write temp and fails closed on a torn receipt", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-torn-receipt";
    const adapter = durableReleaseAdapterFixture({ repo, runId });
    const firstOutput = join(repo, "adapter-output", "first");
    const replayOutput = join(repo, "adapter-output", "replay");
    const rejectedOutput = join(repo, "adapter-output", "rejected");

    await expect(
      invokeReleaseAdapter({
        backend: adapter.backend,
        repo,
        runId,
        attempt: 1,
        outputDirectory: firstOutput,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(`${adapter.receiptPath}.orphan.tmp`, '{"phase":', "utf8");
    await expect(
      invokeReleaseAdapter({
        backend: durableReleaseAdapterFixture({ repo, runId }).backend,
        repo,
        runId,
        attempt: 2,
        outputDirectory: replayOutput,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      readFile(join(replayOutput, "release-report.md"), "utf8"),
    ).resolves.toContain(`${runId}:release`);

    const externalStatePath = join(
      repo,
      ".fake-release-state",
      `${runId}--release.json`,
    );
    const externalBefore = await readFile(externalStatePath, "utf8");
    for (const [index, invalidReceipt] of [
      '{"phase":',
      '{"phase":"merged"}',
      JSON.stringify({
        idempotencyKey: "another-run:release",
        runId: "another-run",
        stageId: "release",
        rollbackBaseline: "production-sha-before-release",
        provenanceAttempts: [1],
        transitions: [],
        phase: "merged",
      }),
    ].entries()) {
      await writeFile(adapter.receiptPath, invalidReceipt, "utf8");
      const failedResult = await invokeReleaseAdapter({
        backend: durableReleaseAdapterFixture({ repo, runId }).backend,
        repo,
        runId,
        attempt: 3 + index,
        outputDirectory: join(rejectedOutput, String(index)),
      });
      expect(failedResult, invalidReceipt).toMatchObject({
        stderr: expect.stringMatching(/invalid durable release receipt/),
      });
      expect(failedResult.exitCode, invalidReceipt).not.toBe(0);
    }
    await expect(readFile(externalStatePath, "utf8")).resolves.toBe(
      externalBefore,
    );
    await expect(
      readFile(join(rejectedOutput, "0", "release-report.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("reconciles an interrupted release by durable run and stage identity", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-interrupted-reconcile";
    const flowPath = join(repo, "flows", "release-interrupted-reconcile.json");
    await writeJson(flowPath, releaseFlowFixture());

    let crashStore: SimulatedReleaseProcessCrashStore | undefined;
    const firstInvocation = durableReleaseAdapterFixture({
      repo,
      runId,
      interruptAfterDeploy: () => crashStore!.crash(),
    });
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend: firstInvocation.backend,
          createEventStore: (path) => {
            crashStore = new SimulatedReleaseProcessCrashStore(path);
            return crashStore;
          },
        },
      ),
    ).rejects.toThrow(/simulated release process crash/);

    const interruptedReceipt = JSON.parse(
      await readFile(firstInvocation.receiptPath, "utf8"),
    ) as DurableReleaseReceipt;
    expect(interruptedReceipt).toMatchObject({
      idempotencyKey: `${runId}:release`,
      runId,
      stageId: "release",
      rollbackBaseline: "production-sha-before-release",
      provenanceAttempts: [1],
      transitions: ["baseline-captured", "merge-recorded"],
      phase: "merged",
    });
    const externalStatePath = join(
      repo,
      ".fake-release-state",
      `${runId}--release.json`,
    );
    const interruptedExternalState = JSON.parse(
      await readFile(externalStatePath, "utf8"),
    ) as FakeReleaseEnvironmentState;
    expect(interruptedExternalState).toMatchObject({
      scmHead: "release-sha",
      productionSha: "release-sha",
      operationTokens: {
        merge: `${runId}:release:merge`,
        deploy: `${runId}:release:deploy`,
      },
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 0,
    });
    await expect(
      readdir(join(repo, ".release-receipts")),
    ).resolves.toEqual([`${runId}--release.json`]);

    let store = new EventStore(join(repo, ".nitely", "events.db"));
    const interruptedEvents = store.list(runId);
    store.close();
    expect(
      interruptedEvents.filter(
        (event) => event.type === "stage.retrying" && event.stageId === "release",
      ),
    ).toEqual([]);
    expect(
      interruptedEvents.some((event) => event.type === "run.failed"),
    ).toBe(false);
    expect(
      projectRun(interruptedEvents, { openAttemptStatus: "interrupted" }),
    ).toMatchObject({
      status: "interrupted",
      stages: [
        {
          stageId: "release",
          attempts: [{ attempt: 1, status: "interrupted" }],
        },
      ],
    });

    const resumedInvocation = durableReleaseAdapterFixture({ repo, runId });
    await resumeRun(
      { repoPath: repo, runId },
      { backend: resumedInvocation.backend },
    );

    const completedReceipt = JSON.parse(
      await readFile(resumedInvocation.receiptPath, "utf8"),
    ) as DurableReleaseReceipt;
    expect(completedReceipt).toMatchObject({
      idempotencyKey: `${runId}:release`,
      provenanceAttempts: [1, 2],
      phase: "completed",
      transitions: [
        "baseline-captured",
        "merge-recorded",
        "deploy-reconciled",
        "reports-completed",
      ],
    });
    const completedExternalState = JSON.parse(
      await readFile(externalStatePath, "utf8"),
    ) as FakeReleaseEnvironmentState;
    expect(completedExternalState).toMatchObject({
      mergeMutations: 1,
      deployMutations: 1,
      rollbackMutations: 0,
      scmHead: "release-sha",
      productionSha: "release-sha",
    });

    store = new EventStore(join(repo, ".nitely", "events.db"));
    const completedEvents = store.list(runId);
    store.close();
    expect(projectRun(completedEvents)).toMatchObject({
      status: "completed",
      stages: [
        {
          stageId: "release",
          attempts: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "completed" },
          ],
        },
      ],
    });
    expect(
      completedEvents
        .filter(
          (event) =>
            event.type === "artifact.published" && event.stageId === "release",
        )
        .map(
          (event) =>
            (event.payload as { artifact?: { id?: string; attempt?: number } })
              .artifact,
        ),
    ).toEqual([
      expect.objectContaining({ id: "release-report", attempt: 2 }),
      expect.objectContaining({ id: "smoke-report", attempt: 2 }),
    ]);
    await expect(
      readFile(
        join(
          repo,
          ".nitely",
          "runs",
          runId,
          "stages",
          "release",
          "2",
          "release-report.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("without repeating mutation");
  });

  it("does not automatically retry a non-zero production release", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-nonzero";
    const flowPath = join(repo, "flows", "release-nonzero.json");
    await writeJson(flowPath, releaseFlowFixture());
    let commandCalls = 0;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend: commandProtocolBackend({
            repo,
            runCommand: async () => {
              commandCalls += 1;
              return {
                stdout: "",
                stderr: "release failed before a safe outcome\n",
                exitCode: 23,
              };
            },
          }),
        },
      ),
    ).rejects.toThrow(/after 1 of 1 attempts/);

    expect(commandCalls).toBe(1);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === "stage.retrying" && event.stageId === "release",
      ),
    ).toEqual([]);
    expect(projectRun(events)).toMatchObject({
      status: "failed",
      stages: [
        {
          stageId: "release",
          attempts: [{ attempt: 1, status: "failed" }],
        },
      ],
    });
  });

  it.skipIf(process.platform !== "linux")(
    "fails closed before a release backend sees a symlinked future attempt parent",
    async () => {
      const repo = await createCommandProtocolRepo();
      const runId = "run-release-symlinked-attempt-parent";
      const flowPath = join(repo, "flows", "release-symlinked-attempt-parent.json");
      const outsideDirectory = await mkdtemp(
        join(tmpdir(), "nitely-release-attempt-outside-"),
      );
      await writeJson(flowPath, {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "release-symlinked-attempt-parent" },
        spec: {
          stages: [
            {
              id: "prepare-release",
              type: "agent",
              runtime: "mock",
              prompt: "Prepare release inputs.",
              inputs: [],
              outputs: [richMarkdownOutput("preparation")],
            },
            {
              id: "release",
              type: "command",
              command: "./scripts/nitely/release-production",
              timeoutMs: 1_800_000,
              maxAttempts: 1,
              inputs: [],
              outputs: [
                richMarkdownOutput("release-report"),
                richMarkdownOutput("smoke-report"),
              ],
            },
          ],
        },
      });
      let commandCalls = 0;

      try {
        await expect(
          runFlow(
            { flowPath, repoPath: repo, inputs: {} },
            {
              createRunId: () => runId,
              backend: commandProtocolBackend({
                repo,
                runAgent: async (_workspace, agentInput) => {
                  await writeFile(
                    join(agentInput.attemptDirectory, "preparation.md"),
                    "# Preparation\n\nRelease inputs are ready.\n",
                    "utf8",
                  );
                  await writeJson(join(agentInput.attemptDirectory, "artifact.json"), {
                    version: 1,
                    stageId: "prepare-release",
                    attempt: 1,
                    outputs: [
                      {
                        id: "preparation",
                        path: "preparation.md",
                        mediaType: "text/markdown",
                      },
                    ],
                  });
                  await symlink(
                    outsideDirectory,
                    join(
                      repo,
                      ".nitely",
                      "runs",
                      runId,
                      "stages",
                      "release",
                    ),
                  );
                  return { stdout: "", stderr: "" };
                },
                runCommand: async (options) => {
                  commandCalls += 1;
                  await writeFile(
                    join(options.outputDirectory!, "release-report.md"),
                    "# Release report\n\nThis must stay inside the Run.\n",
                    "utf8",
                  );
                  await writeFile(
                    join(options.outputDirectory!, "smoke-report.md"),
                    "# Smoke report\n\nThis must stay inside the Run.\n",
                    "utf8",
                  );
                  return { stdout: "", stderr: "", exitCode: 0 };
                },
              }),
            },
          ),
        ).rejects.toThrow(/symbolic link|descriptor-relative|escapes run directory/i);

        expect(commandCalls).toBe(0);
        await expect(readdir(outsideDirectory)).resolves.toEqual([]);
        const store = new EventStore(join(repo, ".nitely", "events.db"));
        try {
          const events = store.list(runId);
          expect(projectRun(events).status).toBe("failed");
          expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
        } finally {
          store.close();
        }
      } finally {
        await rm(outsideDirectory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails closed before a release backend sees a replaced logical Run root",
    async () => {
      const repo = await createCommandProtocolRepo();
      const runId = "run-release-replaced-root";
      const flowPath = join(repo, "flows", "release-replaced-root.json");
      const runDirectory = join(repo, ".nitely", "runs", runId);
      const movedRunDirectory = `${runDirectory}.moved`;
      const outsideDirectory = await mkdtemp(
        join(tmpdir(), "nitely-release-root-outside-"),
      );
      const outsideAttemptDirectory = join(
        outsideDirectory,
        "stages",
        "release",
        "1",
      );
      await mkdir(outsideAttemptDirectory, { recursive: true });
      await writeJson(flowPath, releaseFlowFixture());
      let commandCalls = 0;

      class RunRootReplacementStore extends EventStore {
        private replaced = false;

        override append(
          event: Parameters<EventStore["append"]>[0],
        ): ReturnType<EventStore["append"]> {
          const stored = super.append(event);
          if (
            !this.replaced &&
            event.type === "stage.started" &&
            event.stageId === "release" &&
            event.attempt === 1
          ) {
            this.replaced = true;
            renameSync(runDirectory, movedRunDirectory);
            symlinkSync(outsideDirectory, runDirectory, "dir");
          }
          return stored;
        }
      }

      try {
        await expect(
          runFlow(
            { flowPath, repoPath: repo, inputs: {} },
            {
              createRunId: () => runId,
              createEventStore: (path) => new RunRootReplacementStore(path),
              backend: commandProtocolBackend({
                repo,
                runCommand: async (options) => {
                  commandCalls += 1;
                  await writeFile(
                    join(options.outputDirectory!, "release-report.md"),
                    "# Release report\n\nThis must stay inside the Run.\n",
                    "utf8",
                  );
                  await writeFile(
                    join(options.outputDirectory!, "smoke-report.md"),
                    "# Smoke report\n\nThis must stay inside the Run.\n",
                    "utf8",
                  );
                  return { stdout: "", stderr: "", exitCode: 0 };
                },
              }),
            },
          ),
        ).rejects.toThrow(/run directory|symbolic link|descriptor-relative/i);

        expect(commandCalls).toBe(0);
        await expect(readdir(outsideAttemptDirectory)).resolves.toEqual([]);
      } finally {
        await rm(outsideDirectory, { recursive: true, force: true });
      }
    },
  );

  it("fails a missing release report closed without partial registration", async () => {
    const repo = await createCommandProtocolRepo();
    const runId = "run-release-missing-report";
    const flowPath = join(repo, "flows", "release-missing-report.json");
    await writeJson(flowPath, releaseFlowFixture());
    let commandCalls = 0;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => runId,
          backend: commandProtocolBackend({
            repo,
            runCommand: async (options) => {
              commandCalls += 1;
              await writeFile(
                join(options.outputDirectory!, "release-report.md"),
                "# Release report\n\nDeployment appears complete.\n",
                "utf8",
              );
              return { stdout: "", stderr: "", exitCode: 0 };
            },
          }),
        },
      ),
    ).rejects.toThrow(/missing required output smoke-report/);

    expect(commandCalls).toBe(1);
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(runId);
    store.close();
    expect(
      events.filter(
        (event) =>
          (event.type === "artifact.published" || event.type === "stage.retrying") &&
          event.stageId === "release",
      ),
    ).toEqual([]);
    const registry = await readJsonIfPresent<{
      artifacts: Array<{ producer?: string }>;
    }>(join(repo, ".nitely", "runs", runId, "artifacts.json"));
    expect(
      (registry?.artifacts ?? []).filter(
        (artifact) => artifact.producer === "release",
      ),
    ).toEqual([]);
  });
});
