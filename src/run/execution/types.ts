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
  /**
   * Per-call log for traces. Not part of the usage record: run-flow writes it
   * as its own `stage.runtime.calls` event.
   */
  callLog?: AgentRuntimeCall[];
  /** Calls left out of `callLog` once it reached its cap. */
  callLogDropped?: number;
  /**
   * Where `callLog` came from when a runtime has more than one source. Codex
   * records come from `codex exec --json` turn totals (`codex.exec.json`) or,
   * per model call, from its rollout file (`codex.rollout.token_count`).
   */
  callLogSource?: string;
  /** Why a finer-grained call source was not used. No paths or content. */
  callLogFallback?: { reason: string; detail: string };
}

/**
 * One model call or tool execution inside an agent attempt, as the runtime
 * reported it. Pi-based runtimes report these in `usage.callLog`, run-flow
 * persists them as `stage.runtime.calls`, and the trace exporter turns them
 * into spans. Token counts follow the attempt
 * totals: `inputTokens` includes cache reads and writes. `output`,
 * `toolCalls[].arguments` are present only when content capture is on.
 *
 * `granularity` says what the runtime actually emitted. Pi omits it and means
 * one model call. Codex exec reports a cumulative total per turn, so each
 * record is a turn and its tokens are the increase since the previous
 * snapshot (`accounting: "delta"`). When Codex's rollout file is readable,
 * those turn records are replaced with one record per model call
 * (`granularity: "call"`, `accounting: "delta"`), and tool records carry
 * `outputBytes`, the size of what the tool returned to the model. Claude's
 * JSON result is the whole attempt.
 */
export type AgentRuntimeCall =
  | {
      kind: "llm";
      /** What this record measures. Omitted means one model call. */
      granularity?: "call" | "turn" | "attempt";
      /**
       * `delta` tokens add up across the attempt. `cumulative` is a session
       * snapshot that must not be added to sibling records.
       */
      accounting?: "delta" | "cumulative";
      operation?: "compaction";
      startedAt?: string;
      endedAt?: string;
      provider?: string;
      model?: string;
      responseModel?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadInputTokens: number;
      cacheWriteInputTokens: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
      stopReason?: string;
      error?: string;
      /** The call was cut off; its usage is what streamed so far. */
      incomplete?: true;
      toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>;
      output?: string;
    }
  | {
      kind: "tool";
      toolCallId?: string;
      toolName?: string;
      startedAt?: string;
      endedAt?: string;
      isError?: boolean;
      /**
       * UTF-8 bytes the tool returned to the model. Every later model call in
       * the same context resends them.
       */
      outputBytes?: number;
      /** `outputBytes` is the size of the whole rollout line, an upper bound. */
      outputBytesEstimated?: true;
    };

export interface AgentResult {
  stdout?: string;
  stderr?: string;
  stdoutPath?: string;
  stderrPath?: string;
  usage?: AgentRuntimeUsage;
  globalSkills?: AgentGlobalSkillsOutcome;
  mcpServers?: AgentMcpServersOutcome;
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
 * Which of the operator's configured MCP servers an attempt may load. Every
 * enabled server's tool definitions are resent on each model call, so a stage
 * loads only the servers it declares unless the flow opts back in.
 */
export type AgentMcpServersRequest =
  | { mode: "inherited" }
  | {
      mode: "declared-if-supported" | "declared-required";
      declared: string[];
    };

/**
 * - `enforced`: the runtime confirmed every undeclared server is off.
 * - `partial`: a restriction was attempted but could not be confirmed
 *   complete; some undeclared server may still load.
 * - `unsupported`: the runtime has no restriction mechanism, so every
 *   configured server loads.
 * - `inherited`: the flow opted into every configured server.
 */
export type AgentMcpServersEnforcement = "enforced" | "partial" | "unsupported" | "inherited";

export interface AgentMcpServersOutcome {
  enforcement: AgentMcpServersEnforcement;
  /** Configured servers the attempt left enabled. */
  enabled?: string[];
  /** Configured servers the attempt disabled. */
  disabled?: string[];
  /** Declared servers the runtime has no configuration for. */
  unconfigured?: string[];
  /** Present when the restriction is not enforced, explaining why. */
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
  /** Only the staged workspace and its output subdirectory may be mounted. */
  isolatedWorkspace?: boolean;
  networkDomains?: readonly string[];
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
      mcpServers?: AgentMcpServersRequest;
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
