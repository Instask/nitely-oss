import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  AgentRunnableStage,
  AgentRuntimePreflightResult,
  AgentResult,
  CommandResult,
  ExecutionBackend,
  RunCommandOptions,
  WorkspaceHandle,
} from "./types.js";
import {
  LocalExecutionBackend,
  type LocalExecutionBackendOptions,
  type RuntimeEnv,
} from "./local.js";

const execFileAsync = promisify(execFile);
const toolchainFiles = ["mise.toml", ".mise.toml", ".tool-versions"];
const runtimeOwnedCommandEnvironment = [
  "NITELY_OUTPUT_DIR",
  "NITELY_ATTEMPT_DIR",
  "NITELY_RUN_ID",
  "NITELY_STAGE_ID",
  "NITELY_ATTEMPT",
] as const;

export interface MiseExecutionBackendOptions
  extends Omit<LocalExecutionBackendOptions, "commandWrapper"> {
  miseCommand?: string;
}

function requirePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("MiseExecutionBackend requires a host workspace path");
  }
  return ws.path;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function outputFromExecError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  return [stderr, stdout, message].filter(Boolean).join("\n");
}

async function hasToolchainFile(workspacePath: string): Promise<boolean> {
  for (const file of toolchainFiles) {
    try {
      await access(join(workspacePath, file));
      return true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return false;
}

export class MiseExecutionBackend implements ExecutionBackend {
  private readonly miseCommand: string;
  private readonly env: RuntimeEnv;
  private readonly local: LocalExecutionBackend;
  private readonly provisionedWorkspaces = new Set<string>();
  private readonly enabledWorkspaces = new Set<string>();

  constructor(options: MiseExecutionBackendOptions = {}) {
    this.miseCommand = options.miseCommand ?? "mise";
    this.env = options.env ?? process.env;
    this.local = new LocalExecutionBackend({
      env: this.env,
      runtimeRegistry: options.runtimeRegistry,
      spawn: options.spawn,
      commandWrapper: (input) => {
        if (!this.enabledWorkspaces.has(input.cwd)) {
          return { command: input.command, args: input.args };
        }
        const protectedEnvironment = runtimeOwnedCommandEnvironment.flatMap(
          (name) => {
            const value = input.runtimeOwnedEnv?.[name];
            return value === undefined ? [] : [`${name}=${value}`];
          },
        );
        return {
          command: this.miseCommand,
          args: [
            "exec",
            "--",
            ...(protectedEnvironment.length > 0
              ? ["env", ...protectedEnvironment]
              : []),
            input.command,
            ...input.args,
          ],
        };
      },
    });
  }

  async createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
    sourceRevision?: string;
  }): Promise<WorkspaceHandle> {
    return await this.local.createWorkspace(input);
  }

  async runCommand(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandResult> {
    await this.ensureWorkspace(ws);
    return await this.local.runCommand(ws, command, options);
  }

  async runAgent(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      prompt: string;
      attemptDirectory: string;
    },
  ): Promise<AgentResult> {
    await this.ensureWorkspace(ws);
    return await this.local.runAgent(ws, input);
  }

  async preflightAgentRuntime(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      attemptDirectory: string;
    },
  ): Promise<AgentRuntimePreflightResult> {
    return await this.local.preflightAgentRuntime(ws, input);
  }

  async commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }> {
    return await this.local.commitAll(ws, message);
  }

  private async ensureWorkspace(ws: WorkspaceHandle): Promise<void> {
    const workspacePath = requirePath(ws);
    if (this.provisionedWorkspaces.has(workspacePath)) {
      return;
    }
    if (!(await hasToolchainFile(workspacePath))) {
      this.provisionedWorkspaces.add(workspacePath);
      return;
    }

    try {
      await execFileAsync(this.miseCommand, ["install"], {
        cwd: workspacePath,
        env: {
          ...this.env,
          MISE_YES: this.env.MISE_YES ?? "1",
        },
      });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new Error(
          `mise execution backend requires ${this.miseCommand} on PATH. Install mise, set NITELY_MISE_COMMAND, or use NITELY_EXECUTION_BACKEND=local.`,
        );
      }
      const details = outputFromExecError(error);
      throw new Error(
        `mise install failed for ${workspacePath}. Check mise.toml/.tool-versions and install the requested runtimes.${details ? `\n${details}` : ""}`,
      );
    }

    this.enabledWorkspaces.add(workspacePath);
    this.provisionedWorkspaces.add(workspacePath);
  }
}
