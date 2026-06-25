import type { Stage } from "../../flow/schema.js";

export type AgentRunnableStage =
  | Extract<Stage, { type: "agent" }>
  | Extract<Stage, { type: "gate"; mode: "review" }>;

export interface WorkspaceHandle {
  readonly runId: string;
  // Host-accessible path to the workspace. LocalExecutionBackend always sets
  // this. A future Docker backend may leave it undefined unless bind-mounted.
  readonly path: string | undefined;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  estimatedCostUsd?: number;
  raw?: unknown;
}

export interface AgentResult {
  stdout?: string;
  stderr?: string;
  stdoutPath?: string;
  stderrPath?: string;
  usage?: AgentRuntimeUsage;
}

export type AgentRuntimePreflightResult =
  | { available: true }
  | {
      available: false;
      reason: string;
      missingConfig?: string[];
    };

export interface RunCommandOptions {
  timeoutMs?: number;
}

export interface ExecutionBackend {
  createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
  }): Promise<WorkspaceHandle>;
  runCommand(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandResult>;
  runAgent(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      prompt: string;
      attemptDirectory: string;
    },
  ): Promise<AgentResult>;
  preflightAgentRuntime?(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      attemptDirectory: string;
    },
  ): Promise<AgentRuntimePreflightResult>;
  commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }>;
  // No-op today (worktrees are kept for human review). Present for Docker later.
  disposeWorkspace?(ws: WorkspaceHandle): Promise<void>;
}
