import type { Stage } from "../../flow/schema.js";

export type AgentRunnableStage =
  | Extract<Stage, { type: "agent" }>
  | Extract<Stage, { type: "judge" }>
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
  cancelled?: boolean;
  timedOut?: boolean;
  termination?: ProcessTerminationResult;
  environmentRepairs?: CommandEnvironmentRepair[];
}

export interface ProcessTerminationResult {
  reason: "cancelled" | "timeout";
  requestedAt: string;
  exitedAt?: string;
  graceMs: number;
  signal: NodeJS.Signals;
  forceSignal: NodeJS.Signals;
  forceKillSent: boolean;
}

export interface CommandEnvironmentRepair {
  id: string;
  description: string;
  scope: "environment" | "outside-worktree";
  path?: string;
}

export interface AgentRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * The share of `inputTokens` the provider served from its prompt cache.
   * Budgets exclude it: cache reads are the cheapest tokens a provider sells,
   * and charging them at parity makes a long, well-cached stage look like a
   * runaway one. Cache *creation* is billed at a premium and is not counted
   * here.
   */
  cachedInputTokens?: number;
  contextWindow?: number;
  estimatedCostUsd?: number;
  cost?:
    | { classification: "actual"; usd: number }
    | { classification: "estimated"; usd: number; method: string }
    | { classification: "unknown" };
  provenance?: {
    provider: string;
    model?: string;
    observedAt: string;
    source: {
      kind: "provider-reported" | "calculated";
      reference: string;
    };
  };
  raw?: unknown;
}

export interface AgentResult {
  stdout?: string;
  stderr?: string;
  stdoutPath?: string;
  stderrPath?: string;
  usage?: AgentRuntimeUsage;
  globalSkills?: AgentGlobalSkillsOutcome;
  session?: AgentSessionOutcome;
}

export interface AgentReadPolicy {
  maxFileBytes: number;
  deny: string[];
  enforcement: "advisory" | "required";
}

export type AgentRuntimePreflightResult =
  | { available: true }
  | {
      available: false;
      reason: string;
      missingConfig?: string[];
    };

/**
 * Whether an attempt may load the operator's user-global runtime skill packs.
 * `homeDirectory` is a run-owned directory the backend may populate with an
 * isolated runtime home.
 */
export type AgentGlobalSkillsRequest =
  | { mode: "inherited" }
  | {
      mode: "isolate-if-supported" | "required-isolated";
      homeDirectory: string;
    };

export interface AgentGlobalSkillsOutcome {
  isolated: boolean;
  /** Present when isolation was skipped, explaining why. */
  reason?: string;
}

/**
 * A repeated execution of the same stage in the same worktree can continue the
 * runtime's previous session instead of paying for a cold start. The backend
 * decides whether the runtime can honor it.
 */
export interface AgentSessionRequest {
  resumeSessionId: string;
}

export interface AgentSessionOutcome {
  mode: "cold" | "resumed";
  /** Session id to resume next time, when the runtime reported one. */
  sessionId?: string;
  /** Present when a requested resume did not happen, explaining why. */
  reason?: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cancellationGraceMs?: number;
  outputDirectory?: string;
  attemptDirectory?: string;
  runId?: string;
  stageId?: string;
  attempt?: number;
}

export interface ExecutionBackendDescription {
  backend: string;
  engine: string;
  image?: string;
  imageReference?: string;
  imageIdentity?: string;
  policyVersion: number;
  isolation: string;
  identity: {
    uid: number;
    gid: number;
    strategy: string;
  };
  network: string;
  mounts: string[];
  environment: {
    allowedNames: string[];
    secretNames: string[];
    valuesRecorded: false;
  };
  /**
   * How the backend treats an agent stage's command allow/deny policy. Names
   * the mechanism when one exists; never carries argv or values.
   */
  commands: {
    mediation: "mechanism" | "stated" | "none";
    mechanism?: string;
  };
  resources: {
    cpus: number;
    memoryBytes: number;
    pids: number;
    tmpfsBytes: number;
    maxFileBytes: number;
    maxCapturedOutputBytes: number;
    timeoutMs: number;
  };
  /** Whether the workload may execute files it writes under /tmp. */
  tmpfs?: { exec: boolean };
  cleanup: string;
  lifecycle?: {
    managed: true;
    expiry: string;
    cleanupGraceMs: number;
    labelKeys: string[];
  };
  limitations: string[];
}

export interface ExecutionBackend {
  /**
   * `backend` means runAgent enforces timeoutMs and settles only after its
   * workload and cleanup have completed. Other backends are raced by the
   * orchestrator for backwards compatibility.
   */
  readonly agentTimeoutControl?: "backend";
  createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
    sourceRevision?: string;
  }): Promise<WorkspaceHandle>;
  prepareForRun?(): Promise<void>;
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
      timeoutMs?: number;
      signal?: AbortSignal;
      cancellationGraceMs?: number;
      globalSkills?: AgentGlobalSkillsRequest;
      session?: AgentSessionRequest;
      visibleInputPaths?: string[];
      readPolicy?: AgentReadPolicy;
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
  describeExecution?(): ExecutionBackendDescription;
  prepareAgentPrompt?(input: {
    workspace: WorkspaceHandle;
    attemptDirectory: string;
    prompt: string;
  }): Promise<string>;
  redactionSecrets?(): readonly string[];
  // No-op today (worktrees are kept for human review). Present for Docker later.
  disposeWorkspace?(ws: WorkspaceHandle): Promise<void>;
}
