import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import type { Stage } from "../../flow/schema.js";
import type {
  AgentRunnableStage,
  AgentRuntimePreflightResult,
  AgentResult,
  CommandResult,
  ExecutionBackend,
  RunCommandOptions,
  WorkspaceHandle,
} from "./types.js";

const execFileAsync = promisify(execFile);

type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface AgentRuntimeLaunchInput {
  worktreePath: string;
  model?: string;
  env: RuntimeEnv;
}

export interface AgentRuntimeLaunchSpec {
  runtime: string;
  command: string;
  args: string[];
  promptDelivery: "stdin";
}

export interface AgentRuntimeLauncher {
  id: string;
  requiredEnv?: string[][];
  build(input: AgentRuntimeLaunchInput): AgentRuntimeLaunchSpec;
}

export interface AgentRuntimeRegistry {
  supportedIds(): string[];
  resolve(runtime: string): AgentRuntimeLauncher;
}

interface AgentChildProcess {
  stdin: Writable;
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

type AgentSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ["pipe", "pipe", "pipe"];
    env: RuntimeEnv;
  },
) => AgentChildProcess;

export interface LocalExecutionBackendOptions {
  env?: RuntimeEnv;
  runtimeRegistry?: AgentRuntimeRegistry;
  spawn?: AgentSpawn;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function requirePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("LocalExecutionBackend requires a host workspace path");
  }
  return ws.path;
}

export function createCodexExecArgs(
  worktreePath: string,
  model?: string,
): string[] {
  return [
    "exec",
    "--sandbox",
    process.env.NITELY_CODEX_SANDBOX ??
      process.env.NIGHTLY_CODEX_SANDBOX ??
      "danger-full-access",
    ...(model ? ["-m", model] : []),
    "--cd",
    worktreePath,
    "-",
  ];
}

class DefaultAgentRuntimeRegistry implements AgentRuntimeRegistry {
  private readonly runtimes: Map<string, AgentRuntimeLauncher>;

  constructor(runtimes: AgentRuntimeLauncher[]) {
    this.runtimes = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  }

  supportedIds(): string[] {
    return [...this.runtimes.keys()];
  }

  resolve(runtime: string): AgentRuntimeLauncher {
    const id = runtime.trim();
    const launcher = this.runtimes.get(id);
    if (!launcher) {
      throw new Error(
        `unsupported agent runtime: ${id}. Supported runtimes: ${this.supportedIds().join(", ")}`,
      );
    }
    return launcher;
  }
}

export function createDefaultAgentRuntimeRegistry(): AgentRuntimeRegistry {
  return new DefaultAgentRuntimeRegistry([
    {
      id: "codex",
      build: ({ worktreePath, model, env }) => ({
        runtime: "codex",
        command: env.NITELY_CODEX_COMMAND ?? "codex",
        args: createCodexExecArgs(worktreePath, model),
        promptDelivery: "stdin",
      }),
    },
    {
      id: "claude",
      requiredEnv: [["ANTHROPIC_API_KEY"]],
      build: ({ model, env }) => ({
        runtime: "claude",
        command: env.NITELY_CLAUDE_COMMAND ?? "claude",
        args: ["-p", ...(model ? ["--model", model] : [])],
        promptDelivery: "stdin",
      }),
    },
    {
      id: "glm",
      requiredEnv: [["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"]],
      build: ({ model, env }) => ({
        runtime: "glm",
        command: env.NITELY_GLM_COMMAND ?? "glm",
        args: ["chat", ...(model ? ["--model", model] : [])],
        promptDelivery: "stdin",
      }),
    },
  ]);
}

function missingRuntimeEnv(
  runtime: AgentRuntimeLauncher,
  env: RuntimeEnv,
): string[][] {
  return (runtime.requiredEnv ?? []).filter(
    (alternatives) => !alternatives.some((name) => Boolean(env[name])),
  );
}

function formatMissingRuntimeEnv(missing: string[][]): string {
  return missing
    .map((alternatives) =>
      alternatives.length === 1
        ? alternatives[0]
        : `one of ${alternatives.join(", ")}`,
    )
    .join("; ");
}

async function assertRuntimeConfigured(
  runtime: AgentRuntimeLauncher,
  env: RuntimeEnv,
): Promise<void> {
  const missing = missingRuntimeEnv(runtime, env);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `agent runtime ${runtime.id} is not configured. Set ${formatMissingRuntimeEnv(missing)}.`,
  );
}

export class LocalExecutionBackend implements ExecutionBackend {
  private readonly env: RuntimeEnv;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly spawnAgent: AgentSpawn;

  constructor(options: LocalExecutionBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.runtimeRegistry =
      options.runtimeRegistry ?? createDefaultAgentRuntimeRegistry();
    this.spawnAgent = options.spawn ?? (spawn as AgentSpawn);
  }

  async createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
  }): Promise<WorkspaceHandle> {
    await runGit(input.repoPath, [
      "worktree",
      "add",
      "-b",
      input.branchName,
      input.worktreePath,
      "HEAD",
    ]);
    return { runId: input.runId, path: input.worktreePath };
  }

  async runCommand(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandResult> {
    const cwd = requirePath(ws);
    return await new Promise((resolvePromise, reject) => {
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const child = spawn("sh", ["-lc", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: options?.timeoutMs !== undefined,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const clearTimers = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
      };
      const killChild = (signal: NodeJS.Signals) => {
        if (child.pid && options?.timeoutMs !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to killing the shell process below.
          }
        }
        child.kill(signal);
      };
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        clearTimers();
        reject(error);
      });
      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          stderr.push(
            Buffer.from(`command timed out after ${options.timeoutMs}ms\n`, "utf8"),
          );
          killChild("SIGTERM");
          forceKillTimeout = setTimeout(() => killChild("SIGKILL"), 100);
        }, options.timeoutMs);
      }
      child.on("close", (code) => {
        clearTimers();
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: timedOut ? 124 : code ?? 1,
        });
      });
    });
  }

  async runAgent(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      prompt: string;
      attemptDirectory: string;
    },
  ): Promise<AgentResult> {
    const cwd = requirePath(ws);
    const runtimeId = input.stage.runtime;
    if (!runtimeId) {
      throw new Error(`agent runtime for stage ${input.stage.id} is not configured`);
    }
    const runtime = this.runtimeRegistry.resolve(runtimeId);
    const runtimeEnv = {
      ...this.env,
      NITELY_ATTEMPT_DIR: input.attemptDirectory,
      NITELY_OUTPUT_DIR: input.attemptDirectory,
    };
    await assertRuntimeConfigured(runtime, runtimeEnv);
    const launch = runtime.build({
      worktreePath: cwd,
      model: input.stage.model,
      env: runtimeEnv,
    });
    return await new Promise<AgentResult>((resolvePromise, reject) => {
      const child = this.spawnAgent(launch.command, launch.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: runtimeEnv,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        process.stderr.write(chunk);
      });
      const capturedResult = (): AgentResult => ({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
          return;
        }
        reject(error);
      });
      child.stdin.end(input.prompt);
      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          reject(Object.assign(
            new Error(
              `unable to start agent runtime ${launch.runtime}: command ${launch.command} was not found`,
            ),
            capturedResult(),
          ),
          );
          return;
        }
        reject(Object.assign(error, capturedResult()));
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise(capturedResult());
        } else {
          reject(
            Object.assign(
              new Error(`${launch.runtime} exited with code ${code ?? 1}`),
              capturedResult(),
            ),
          );
        }
      });
    });
  }

  async preflightAgentRuntime(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      attemptDirectory: string;
    },
  ): Promise<AgentRuntimePreflightResult> {
    requirePath(ws);
    const runtimeId = input.stage.runtime;
    if (!runtimeId) {
      return {
        available: false,
        reason: `agent runtime for stage ${input.stage.id} is not configured`,
      };
    }
    let runtime: AgentRuntimeLauncher;
    try {
      runtime = this.runtimeRegistry.resolve(runtimeId);
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const runtimeEnv = {
      ...this.env,
      NITELY_ATTEMPT_DIR: input.attemptDirectory,
      NITELY_OUTPUT_DIR: input.attemptDirectory,
    };
    const missing = missingRuntimeEnv(runtime, runtimeEnv);
    if (missing.length === 0) {
      return { available: true };
    }
    return {
      available: false,
      reason: `agent runtime ${runtime.id} is not configured. Set ${formatMissingRuntimeEnv(missing)}.`,
      missingConfig: missing.flat(),
    };
  }

  async commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }> {
    const cwd = requirePath(ws);
    await runGit(cwd, ["add", "."]);
    const status = await runGit(cwd, ["status", "--short"]);
    if (status.trim().length === 0) {
      return { committed: false };
    }
    await runGit(cwd, ["commit", "-m", message]);
    return { committed: true };
  }
}
