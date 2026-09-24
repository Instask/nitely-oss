import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import type {
  AgentGlobalSkillsOutcome,
  AgentGlobalSkillsRequest,
  AgentSessionOutcome,
  AgentSessionRequest,
  AgentRunnableStage,
  AgentRuntimePreflightResult,
  AgentRuntimeUsage,
  AgentResult,
  AgentReadPolicy,
  CommandEnvironmentRepair,
  CommandResult,
  ExecutionBackend,
  ProcessTerminationResult,
  RunCommandOptions,
  WorkspaceHandle,
} from "./types.js";
import {
  commandMediationError,
  normalizeCommandMediationPolicy,
  resolveCommandMediation,
} from "./command-mediation.js";
import { effectiveCapabilityPolicy } from "../../flow/capabilities.js";
import type { AgentCapabilityPolicy } from "../../flow/schema.js";
import {
  requireCodexSandboxMode,
  type CodexSandboxMode,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);

export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ProcessLaunchInput {
  kind: "command" | "agent";
  cwd: string;
  command: string;
  args: string[];
  runtimeOwnedEnv?: RuntimeEnv;
}

export interface ProcessLaunchSpec {
  command: string;
  args: string[];
}

export type ProcessCommandWrapper = (
  input: ProcessLaunchInput,
) => ProcessLaunchSpec;

export type ClaudePermissionMode = "acceptEdits" | "bypassPermissions";

export interface AgentRuntimeLaunchInput {
  worktreePath: string;
  model?: string;
  prompt: string;
  env: RuntimeEnv;
  permissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
}

export interface AgentRuntimeLaunchSpec {
  runtime: string;
  command: string;
  args: string[];
  promptDelivery: "stdin" | "argument";
}

/**
 * How a runtime's user-global skill packs can be kept out of an attempt.
 *
 * Every runtime that supports this does it the same way: it reads its packs
 * from a per-user home directory that one environment variable relocates, so
 * pointing that variable at a run-owned directory that holds only credentials
 * and configuration leaves the packs behind.
 */
export interface RuntimeHomeIsolation {
  /** Environment variable that relocates the runtime's per-user home. */
  envVar: string;
  /** Resolves the operator's real home for this runtime, when it exists. */
  resolveDefaultHome(env: RuntimeEnv): string | undefined;
  /**
   * Entries linked from the real home into the isolated one. Keep this to
   * credentials and configuration: anything not listed is deliberately absent.
   */
  preserve: string[];
}

/**
 * How a runtime continues a session it already ran, so a repeated execution of
 * the same stage does not pay for a cold start.
 */
export interface RuntimeSessionReuse {
  /** Reads the session id the runtime reported, if any. */
  parseSessionId(stdout: string): string | undefined;
  /** Launches a continuation of `sessionId` instead of a new session. */
  buildResume(
    input: AgentRuntimeLaunchInput & { sessionId: string },
  ): AgentRuntimeLaunchSpec;
}

export interface AgentRuntimeLauncher {
  id: string;
  requiredEnv?: string[][];
  /** Whether the runtime itself needs network access while executing. */
  networkAccess?: "none" | "required";
  /** Absent when this runtime offers no way to drop the operator's packs. */
  globalSkillIsolation?: RuntimeHomeIsolation;
  /** Absent when this runtime cannot continue a previous session. */
  sessionReuse?: RuntimeSessionReuse;
  build(input: AgentRuntimeLaunchInput): AgentRuntimeLaunchSpec;
}

export interface AgentRuntimeRegistry {
  supportedIds(): string[];
  resolve(runtime: string): AgentRuntimeLauncher;
}

interface AgentChildProcess {
  pid?: number;
  stdin: Writable;
  stdout?: Readable | null;
  stderr?: Readable | null;
  kill?(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

type AgentSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ["pipe", "pipe", "pipe"];
    detached?: boolean;
    env: RuntimeEnv;
  },
) => AgentChildProcess;

const PYTHON_COMPATIBILITY_SHIM_NOTICE =
  "Nitely command environment added a python compatibility shim for projects that call python when only python3 is available.";
const PROCESS_TERMINATION_GRACE_MS = 10_000;
const CANCELLED_EXIT_CODE = 130;

/**
 * Streams process output into attempt log files as chunks arrive so the web
 * console can live-refresh growing stdout/stderr while a stage is still
 * running. Failures to open/write are ignored so virtual test paths still work.
 */
function createStreamingAttemptLogWriters(attemptDirectory: string | undefined): {
  writeStdout: (chunk: Buffer | string) => void;
  writeStderr: (chunk: Buffer | string) => void;
  close: () => Promise<void>;
} {
  if (!attemptDirectory) {
    return {
      writeStdout: () => {},
      writeStderr: () => {},
      close: async () => {},
    };
  }
  let openFailed = false;
  try {
    mkdirSync(attemptDirectory, { recursive: true });
  } catch {
    openFailed = true;
  }
  const openStream = (filename: string): WriteStream | undefined => {
    if (openFailed) return undefined;
    try {
      const stream = createWriteStream(join(attemptDirectory, filename), {
        flags: "a",
      });
      stream.on("error", () => {
        openFailed = true;
      });
      return stream;
    } catch {
      openFailed = true;
      return undefined;
    }
  };
  const stdoutStream = openStream("stdout.log");
  const stderrStream = openStream("stderr.log");
  const write = (stream: WriteStream | undefined, chunk: Buffer | string) => {
    if (!stream || openFailed || stream.destroyed || !stream.writable) return;
    stream.write(chunk);
  };
  const endStream = (stream: WriteStream | undefined): Promise<void> =>
    new Promise((resolve) => {
      if (!stream || stream.destroyed || stream.closed) {
        resolve();
        return;
      }
      stream.end(() => resolve());
      stream.on("error", () => resolve());
    });
  return {
    writeStdout: (chunk) => write(stdoutStream, chunk),
    writeStderr: (chunk) => write(stderrStream, chunk),
    close: async () => {
      await Promise.all([endStream(stdoutStream), endStream(stderrStream)]);
    },
  };
}

export interface LocalExecutionBackendOptions {
  env?: RuntimeEnv;
  runtimeRegistry?: AgentRuntimeRegistry;
  spawn?: AgentSpawn;
  commandWrapper?: ProcessCommandWrapper;
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

function commandOutputNeedsPythonCompatibility(result: CommandResult): boolean {
  if (result.cancelled || result.timedOut) {
    return false;
  }
  if (result.exitCode === 0) {
    return false;
  }
  return /(^|[\s:])python: (not found|command not found|No such file or directory)/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

async function createPythonCompatibilityShim(env: RuntimeEnv): Promise<{
  env: RuntimeEnv;
  repair: CommandEnvironmentRepair;
}> {
  const shimDirectory = await mkdtemp(join(tmpdir(), "nitely-python-compat-"));
  const shimPath = join(shimDirectory, "python");
  await writeFile(shimPath, "#!/bin/sh\nexec python3 \"$@\"\n", "utf8");
  await chmod(shimPath, 0o755);
  return {
    env: {
      ...env,
      PATH: `${shimDirectory}:${env.PATH ?? process.env.PATH ?? ""}`,
    },
    repair: {
      id: "python-to-python3-compatibility-shim",
      description:
        "Added a python compatibility shim that delegates to python3 because python was unavailable.",
      scope: "outside-worktree",
      path: shimDirectory,
    },
  };
}

function mergeRetryResult(
  first: CommandResult,
  retry: CommandResult,
  repair: CommandEnvironmentRepair,
): CommandResult {
  return {
    stdout: retry.stdout,
    stderr: [
      first.stderr.trimEnd(),
      PYTHON_COMPATIBILITY_SHIM_NOTICE,
      retry.stderr.trimEnd(),
    ]
      .filter(Boolean)
      .join("\n"),
    exitCode: retry.exitCode,
    environmentRepairs: [
      ...(first.environmentRepairs ?? []),
      repair,
      ...(retry.environmentRepairs ?? []),
    ],
  };
}

function cancellationReasonText(signal: AbortSignal | undefined): string | undefined {
  const reason = signal?.reason as unknown;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    !Array.isArray(reason) &&
    typeof (reason as { reason?: unknown }).reason === "string"
  ) {
    return (reason as { reason: string }).reason;
  }
  return undefined;
}

function cancellationMessage(kind: "command" | "agent", signal: AbortSignal | undefined): string {
  const reason = cancellationReasonText(signal);
  return `${kind} cancelled${reason ? `: ${reason}` : ""}`;
}

function createTerminationResult(
  reason: ProcessTerminationResult["reason"],
  graceMs: number,
): ProcessTerminationResult {
  return {
    reason,
    requestedAt: new Date().toISOString(),
    graceMs,
    signal: "SIGTERM",
    forceSignal: "SIGKILL",
    forceKillSent: false,
  };
}

function commandAttemptEnvironment(
  env: RuntimeEnv,
  options?: RunCommandOptions,
): RuntimeEnv {
  return {
    ...env,
    ...commandAttemptEnvironmentOverrides(options),
  };
}

function commandAttemptEnvironmentOverrides(
  options?: RunCommandOptions,
): RuntimeEnv {
  const outputDirectory =
    options?.outputDirectory ?? options?.attemptDirectory;
  return {
    ...(outputDirectory
      ? {
          NITELY_OUTPUT_DIR: outputDirectory,
          NITELY_ATTEMPT_DIR: outputDirectory,
        }
      : {}),
    ...(options?.runId ? { NITELY_RUN_ID: options.runId } : {}),
    ...(options?.stageId ? { NITELY_STAGE_ID: options.stageId } : {}),
    ...(options?.attempt !== undefined
      ? { NITELY_ATTEMPT: String(options.attempt) }
      : {}),
  };
}

export function createCodexExecArgs(
  worktreePath: string,
  model?: string,
  env: RuntimeEnv = process.env,
  jsonOutput = false,
): string[] {
  const sandbox = requireCodexSandboxMode(
    env.NITELY_CODEX_SANDBOX ??
      env.NIGHTLY_CODEX_SANDBOX ??
      "danger-full-access",
  );
  return [
    "exec",
    "--sandbox",
    sandbox,
    ...(model ? ["-m", model] : []),
    ...(jsonOutput ? ["--json"] : []),
    "--cd",
    worktreePath,
    "-",
  ];
}

export function createCodexResumeArgs(
  sessionId: string,
  model?: string,
  jsonOutput = true,
): string[] {
  // `codex exec resume` inherits the sandbox and working directory from the
  // session it resumes, and rejects --sandbox and --cd.
  return [
    "exec",
    "resume",
    sessionId,
    ...(model ? ["-m", model] : []),
    ...(jsonOutput ? ["--json"] : []),
    "-",
  ];
}

export function parseCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = usageRecord(event);
    if (
      record?.type === "thread.started" &&
      typeof record.thread_id === "string" &&
      UUID_PATTERN.test(record.thread_id)
    ) {
      return record.thread_id;
    }
  }
  return undefined;
}

export function claudePermissionModeForPolicy(
  policy: Pick<AgentCapabilityPolicy, "write" | "commands">,
): ClaudePermissionMode | undefined {
  const writes = (policy.write.scope ?? "worktree") !== "none";
  const commandMode = policy.commands.mode;
  const runsCommands = commandMode !== "none";
  if (!writes && runsCommands) {
    throw new Error(
      `Claude cannot honor write scope none while commands.mode is ${commandMode}; a command can mutate the worktree. Set commands.mode to none, or allow writes.`,
    );
  }
  if (runsCommands) return "bypassPermissions";
  if (writes) return "acceptEdits";
  return undefined;
}

/**
 * Map the stage's broad write boundary onto Codex's native sandbox modes.
 * Path allowlists remain backend-specific; OCI enforces those in #482.
 */
export function codexSandboxModeForPolicy(
  policy: Pick<AgentCapabilityPolicy, "write">,
): CodexSandboxMode {
  return policy.write.scope === "none" ? "read-only" : "workspace-write";
}

function tightenCodexSandboxMode(
  configured: CodexSandboxMode,
  requested: CodexSandboxMode,
): CodexSandboxMode {
  const rank: Record<CodexSandboxMode, number> = {
    "read-only": 0,
    "workspace-write": 1,
    "danger-full-access": 2,
  };
  if (rank[configured] < rank[requested]) {
    throw new Error(
      `stage capability requires Codex sandbox ${requested}, but the run is pinned to ${configured}`,
    );
  }
  return rank[requested] < rank[configured] ? requested : configured;
}

export function runInputsDirectoryFromAttempt(
  attemptDirectory: string,
): string | undefined {
  const match = attemptDirectory.match(
    /^(.*)[/\\]stages[/\\][^/\\]+[/\\][^/\\]+$/,
  );
  return match ? join(match[1], "inputs") : undefined;
}

export function claudeAdditionalDirectories(input: {
  attemptDirectory: string;
  inputIds: string[];
}): string[] {
  const inputsRoot = runInputsDirectoryFromAttempt(input.attemptDirectory);
  if (!inputsRoot || input.inputIds.length === 0) return [];
  return input.inputIds.map((inputId) => join(inputsRoot, inputId));
}

export function createClaudePrintArgs(input: {
  model?: string;
  permissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
}): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    ...(input.permissionMode
      ? ["--permission-mode", input.permissionMode]
      : []),
    ...(input.additionalDirectories ?? []).flatMap((directory) => [
      "--add-dir",
      directory,
    ]),
    ...(input.model ? ["--model", input.model] : []),
  ];
}

export function createGrokBuildArgs(
  worktreePath: string,
  prompt: string,
  model?: string,
): string[] {
  return [
    "--no-auto-update",
    "--cwd",
    worktreePath,
    "--always-approve",
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
  ];
}

export function createPiAgentArgs(model?: string): string[] {
  return ["-p", ...(model ? ["--model", model] : [])];
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
      networkAccess: "required",
      // Codex reads skills, plugins, packages, and rules from $CODEX_HOME.
      // An isolated CODEX_HOME that holds only auth.json and config.toml keeps
      // login and model configuration while leaving every pack behind.
      globalSkillIsolation: {
        envVar: "CODEX_HOME",
        resolveDefaultHome: (env) =>
          env.CODEX_HOME?.trim() ||
          (env.HOME?.trim() ? join(env.HOME.trim(), ".codex") : undefined),
        preserve: ["auth.json", "config.toml"],
      },
      sessionReuse: {
        parseSessionId: parseCodexSessionId,
        buildResume: ({ model, env, sessionId }) => ({
          runtime: "codex",
          command: env.NITELY_CODEX_COMMAND ?? "codex",
          args: createCodexResumeArgs(sessionId, model, true),
          promptDelivery: "stdin",
        }),
      },
      build: ({ worktreePath, model, env }) => ({
        runtime: "codex",
        command: env.NITELY_CODEX_COMMAND ?? "codex",
        args: createCodexExecArgs(worktreePath, model, env, true),
        promptDelivery: "stdin",
      }),
    },
    {
      id: "claude",
      requiredEnv: [["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]],
      networkAccess: "required",
      build: ({ model, env, permissionMode, additionalDirectories }) => ({
        runtime: "claude",
        command: env.NITELY_CLAUDE_COMMAND ?? "claude",
        args: createClaudePrintArgs({
          model,
          permissionMode,
          additionalDirectories,
        }),
        promptDelivery: "stdin",
      }),
    },
    {
      id: "glm",
      requiredEnv: [["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"]],
      networkAccess: "required",
      build: ({ model, env }) => ({
        runtime: "glm",
        command: env.NITELY_GLM_COMMAND ?? "glm",
        args: ["chat", ...(model ? ["--model", model] : [])],
        promptDelivery: "stdin",
      }),
    },
    {
      id: "grok",
      networkAccess: "required",
      build: ({ worktreePath, model, prompt, env }) => ({
        runtime: "grok",
        command: env.NITELY_GROK_COMMAND ?? "grok",
        args: createGrokBuildArgs(worktreePath, prompt, model),
        promptDelivery: "argument",
      }),
    },
    {
      id: "pi",
      networkAccess: "required",
      build: ({ model, env }) => ({
        runtime: "pi",
        command: env.NITELY_PI_COMMAND ?? "pi",
        args: createPiAgentArgs(model),
        promptDelivery: "stdin",
      }),
    },
  ]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Builds a runtime home that carries credentials and configuration but none of
 * the operator's skill packs, and returns the environment override that points
 * the runtime at it.
 */
async function prepareIsolatedRuntimeHome(input: {
  isolation: RuntimeHomeIsolation;
  homeDirectory: string;
  env: RuntimeEnv;
}): Promise<RuntimeEnv> {
  const source = input.isolation.resolveDefaultHome(input.env);
  await mkdir(input.homeDirectory, { recursive: true, mode: 0o700 });
  // Drop every link we placed before and re-create only the preserved ones, so
  // an entry that is no longer preserved cannot survive. Real files stay: they
  // are state the runtime wrote itself, including the session store that lets a
  // later attempt resume, and none of it is the operator's skill packs.
  for (const entry of await readdir(input.homeDirectory)) {
    const path = join(input.homeDirectory, entry);
    if ((await lstat(path)).isSymbolicLink()) await rm(path, { force: true });
  }
  if (source) {
    for (const entry of input.isolation.preserve) {
      const from = join(source, entry);
      if (!(await pathExists(from))) continue;
      await symlink(from, join(input.homeDirectory, entry));
    }
  }
  return { [input.isolation.envVar]: input.homeDirectory };
}

async function resolveGlobalSkillsIsolation(input: {
  runtime: AgentRuntimeLauncher;
  request: AgentGlobalSkillsRequest | undefined;
  env: RuntimeEnv;
  stageId: string;
}): Promise<{ envOverrides: RuntimeEnv; outcome?: AgentGlobalSkillsOutcome }> {
  const request = input.request;
  // A caller that says nothing about global skills gets the previous behavior
  // and no claim in the result.
  if (!request) return { envOverrides: {} };
  if (request.mode === "inherited") {
    return {
      envOverrides: {},
      outcome: { isolated: false, reason: "flow opted into the operator's global skills" },
    };
  }
  const isolation = input.runtime.globalSkillIsolation;
  if (!isolation) {
    const reason = `agent runtime ${input.runtime.id} has no global skill isolation mechanism`;
    if (request.mode === "required-isolated") {
      throw new Error(
        `stage ${input.stageId} requires isolated global skills but ${reason}`,
      );
    }
    return { envOverrides: {}, outcome: { isolated: false, reason } };
  }
  if (!request.homeDirectory) {
    const reason = "no run-owned directory was supplied for an isolated runtime home";
    if (request.mode === "required-isolated") {
      throw new Error(
        `stage ${input.stageId} requires isolated global skills but ${reason}`,
      );
    }
    return { envOverrides: {}, outcome: { isolated: false, reason } };
  }
  const envOverrides = await prepareIsolatedRuntimeHome({
    isolation,
    homeDirectory: request.homeDirectory,
    env: input.env,
  });
  return { envOverrides, outcome: { isolated: true } };
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredUsageCount(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalUsageCount(
  record: Record<string, unknown>,
  key: string,
): { valid: boolean; value?: number } {
  const raw = record[key];
  if (raw === undefined || raw === null) return { valid: true };
  const value = requiredUsageCount(record, key);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function safeUsageCountSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    const nextTotal = total + value;
    if (!Number.isSafeInteger(nextTotal)) return undefined;
    total = nextTotal;
  }
  return total;
}

function providerProvenance(
  provider: string,
  reference: string,
): NonNullable<AgentRuntimeUsage["provenance"]> {
  return {
    provider,
    observedAt: new Date().toISOString(),
    source: { kind: "provider-reported", reference },
  };
}

function parseCodexUsage(stdout: string): AgentRuntimeUsage | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: Record<string, unknown>[] = [];
  try {
    for (const line of lines) {
      const event = usageRecord(JSON.parse(line));
      if (!event) return undefined;
      events.push(event);
    }
  } catch {
    return undefined;
  }
  if (events.length < 3) return undefined;
  const first = events[0];
  const last = events.at(-1);
  if (
    first?.type !== "thread.started" ||
    typeof first.thread_id !== "string" ||
    !UUID_PATTERN.test(first.thread_id) ||
    last?.type !== "turn.completed" ||
    events.filter((event) => event.type === "thread.started").length !== 1 ||
    events.filter((event) => event.type === "turn.started").length !== 1 ||
    events.filter((event) => event.type === "turn.completed").length !== 1 ||
    events.some((event) => event.type === "turn.failed" || event.type === "error")
  ) {
    return undefined;
  }
  const turnStartedIndex = events.findIndex((event) => event.type === "turn.started");
  if (turnStartedIndex <= 0 || turnStartedIndex >= events.length - 1) {
    return undefined;
  }
  const usage = usageRecord(last.usage);
  if (!usage) return undefined;
  const inputTokens = requiredUsageCount(usage, "input_tokens");
  const cachedInputTokens = requiredUsageCount(usage, "cached_input_tokens");
  const outputTokens = requiredUsageCount(usage, "output_tokens");
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    cachedInputTokens > inputTokens
  ) {
    return undefined;
  }
  const totalTokens = safeUsageCountSum([inputTokens, outputTokens]);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    provenance: providerProvenance(
      "openai",
      "codex.exec.turn.completed.usage",
    ),
    raw: { cachedInputTokens },
  };
}

interface ClaudeTokenCounts {
  uncached?: number;
  cacheCreation?: number;
  cacheRead?: number;
  output?: number;
}

function parseClaudeResultDocument(
  stdout: string,
): Record<string, unknown> | undefined {
  let document: Record<string, unknown> | undefined;
  try {
    document = usageRecord(JSON.parse(stdout.trim()));
  } catch {
    return undefined;
  }
  if (
    !document ||
    document.type !== "result" ||
    typeof document.result !== "string" ||
    typeof document.session_id !== "string" ||
    !UUID_PATTERN.test(document.session_id)
  ) {
    return undefined;
  }
  return document;
}

function claudeResultIsError(document: Record<string, unknown>): boolean {
  return document.is_error === true
    || (typeof document.subtype === "string" && document.subtype !== "success");
}

function claudeErrorResultMessage(stdout: string): string | undefined {
  const document = parseClaudeResultDocument(stdout);
  if (!document || !claudeResultIsError(document)) return undefined;
  const result = document.result;
  return typeof result === "string" && result.trim().length > 0
    ? result.trim()
    : "error result";
}

function readClaudeTokenCounts(
  record: Record<string, unknown>,
  keys: {
    input: string;
    cacheCreation: string;
    cacheRead: string;
    output: string;
  },
): { valid: boolean; counts?: ClaudeTokenCounts } {
  const input = optionalUsageCount(record, keys.input);
  const cacheCreation = optionalUsageCount(record, keys.cacheCreation);
  const cacheRead = optionalUsageCount(record, keys.cacheRead);
  const output = optionalUsageCount(record, keys.output);
  if (!input.valid || !cacheCreation.valid || !cacheRead.valid || !output.valid) {
    return { valid: false };
  }
  return {
    valid: true,
    counts: {
      ...(input.value !== undefined ? { uncached: input.value } : {}),
      ...(cacheCreation.value !== undefined
        ? { cacheCreation: cacheCreation.value }
        : {}),
      ...(cacheRead.value !== undefined ? { cacheRead: cacheRead.value } : {}),
      ...(output.value !== undefined ? { output: output.value } : {}),
    },
  };
}

function addOptionalUsageCount(
  current: { present: boolean; value: number },
  add: number | undefined,
): { present: boolean; value: number } | undefined {
  if (add === undefined) return current;
  const next = safeUsageCountSum([current.value, add]);
  if (next === undefined) return undefined;
  return { present: true, value: next };
}

function sumClaudeModelUsage(
  value: unknown,
): { valid: boolean; counts?: ClaudeTokenCounts } {
  if (value === undefined || value === null) return { valid: true };
  const record = usageRecord(value);
  if (!record) return { valid: false };
  const models = Object.values(record);
  if (models.length === 0) return { valid: true };

  let uncached = { present: false, value: 0 };
  let cacheCreation = { present: false, value: 0 };
  let cacheRead = { present: false, value: 0 };
  let output = { present: false, value: 0 };
  for (const model of models) {
    const entry = usageRecord(model);
    if (!entry) return { valid: false };
    const parsed = readClaudeTokenCounts(entry, {
      input: "inputTokens",
      cacheCreation: "cacheCreationInputTokens",
      cacheRead: "cacheReadInputTokens",
      output: "outputTokens",
    });
    if (!parsed.valid || !parsed.counts) return { valid: false };
    const nextUncached = addOptionalUsageCount(uncached, parsed.counts.uncached);
    const nextCacheCreation = addOptionalUsageCount(
      cacheCreation,
      parsed.counts.cacheCreation,
    );
    const nextCacheRead = addOptionalUsageCount(
      cacheRead,
      parsed.counts.cacheRead,
    );
    const nextOutput = addOptionalUsageCount(output, parsed.counts.output);
    if (
      !nextUncached ||
      !nextCacheCreation ||
      !nextCacheRead ||
      !nextOutput
    ) {
      return { valid: false };
    }
    uncached = nextUncached;
    cacheCreation = nextCacheCreation;
    cacheRead = nextCacheRead;
    output = nextOutput;
  }
  return {
    valid: true,
    counts: {
      ...(uncached.present ? { uncached: uncached.value } : {}),
      ...(cacheCreation.present ? { cacheCreation: cacheCreation.value } : {}),
      ...(cacheRead.present ? { cacheRead: cacheRead.value } : {}),
      ...(output.present ? { output: output.value } : {}),
    },
  };
}

function optionalPermissionDenialCount(
  value: unknown,
): { valid: boolean; value?: number } {
  if (value === undefined || value === null) return { valid: true };
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length)) {
    return { valid: false };
  }
  return { valid: true, value: value.length };
}

function parseClaudeUsage(stdout: string): AgentRuntimeUsage | undefined {
  const document = parseClaudeResultDocument(stdout);
  if (!document) return undefined;
  const usageValue = document.usage;
  const usage = usageValue === undefined || usageValue === null
    ? undefined
    : usageRecord(usageValue);
  if (usageValue !== undefined && usageValue !== null && !usage) {
    return undefined;
  }
  const topLevel = readClaudeTokenCounts(usage ?? {}, {
    input: "input_tokens",
    cacheCreation: "cache_creation_input_tokens",
    cacheRead: "cache_read_input_tokens",
    output: "output_tokens",
  });
  if (!topLevel.valid || !topLevel.counts) return undefined;
  const modelUsage = sumClaudeModelUsage(document.modelUsage);
  if (!modelUsage.valid) return undefined;
  const permissionDenials = optionalPermissionDenialCount(
    document.permission_denials,
  );
  if (!permissionDenials.valid) return undefined;
  const modelCounts = modelUsage.counts;
  const counts = modelCounts &&
      (modelCounts.uncached !== undefined ||
        modelCounts.cacheCreation !== undefined ||
        modelCounts.cacheRead !== undefined ||
        modelCounts.output !== undefined)
    ? modelCounts
    : topLevel.counts;
  const rawCost = document.total_cost_usd;
  const costUsd = rawCost === undefined || rawCost === null
    ? undefined
    : typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0
      ? rawCost
      : null;
  if (costUsd === null) return undefined;

  let inputTokens: number | undefined;
  if (counts.uncached !== undefined) {
    inputTokens = safeUsageCountSum([
      counts.uncached,
      counts.cacheCreation ?? 0,
      counts.cacheRead ?? 0,
    ]);
    if (inputTokens === undefined) return undefined;
  }
  const outputTokens = counts.output;
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined
    ? safeUsageCountSum([inputTokens, outputTokens])
    : undefined;
  if (
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }

  const raw: Record<string, number> = {};
  if (counts.uncached !== undefined) raw.uncachedInputTokens = counts.uncached;
  if (counts.cacheCreation !== undefined) {
    raw.cacheCreationInputTokens = counts.cacheCreation;
  }
  if (counts.cacheRead !== undefined) raw.cacheReadInputTokens = counts.cacheRead;
  if (permissionDenials.value !== undefined) {
    raw.permissionDenialCount = permissionDenials.value;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(counts.cacheRead !== undefined
      ? { cachedInputTokens: counts.cacheRead }
      : {}),
    ...(costUsd !== undefined
      ? { cost: { classification: "actual" as const, usd: costUsd } }
      : {}),
    provenance: providerProvenance("anthropic", "claude.print.result"),
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
  };
}

function parseRuntimeUsage(
  runtime: string,
  stdout: string,
): AgentRuntimeUsage | undefined {
  if (runtime === "codex") return parseCodexUsage(stdout);
  if (runtime === "claude") return parseClaudeUsage(stdout);
  return undefined;
}

export class LocalExecutionBackend implements ExecutionBackend {
  private readonly env: RuntimeEnv;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly spawnAgent: AgentSpawn;
  private readonly commandWrapper: ProcessCommandWrapper;

  constructor(options: LocalExecutionBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.runtimeRegistry =
      options.runtimeRegistry ?? createDefaultAgentRuntimeRegistry();
    this.spawnAgent = options.spawn ?? (spawn as AgentSpawn);
    this.commandWrapper =
      options.commandWrapper ??
      ((input) => ({ command: input.command, args: input.args }));
  }

  async createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
    sourceRevision?: string;
  }): Promise<WorkspaceHandle> {
    await runGit(input.repoPath, [
      "worktree",
      "add",
      "-b",
      input.branchName,
      input.worktreePath,
      input.sourceRevision ?? "HEAD",
    ]);
    return { runId: input.runId, path: input.worktreePath };
  }

  async runCommand(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandResult> {
    const cwd = requirePath(ws);
    const commandEnv = commandAttemptEnvironment(this.env, options);
    const runtimeOwnedEnv = commandAttemptEnvironmentOverrides(options);
    const result = await this.runShellCommand(
      cwd,
      command,
      commandEnv,
      options,
      runtimeOwnedEnv,
    );
    if (!commandOutputNeedsPythonCompatibility(result)) {
      return result;
    }
    const retryEnvironment = await createPythonCompatibilityShim(commandEnv);
    const retry = await this.runShellCommand(
      cwd,
      command,
      retryEnvironment.env,
      options,
      runtimeOwnedEnv,
    );
    return mergeRetryResult(result, retry, retryEnvironment.repair);
  }

  private async runShellCommand(
    cwd: string,
    command: string,
    env: RuntimeEnv,
    options?: RunCommandOptions,
    runtimeOwnedEnv?: RuntimeEnv,
  ): Promise<CommandResult> {
    if (options?.signal?.aborted) {
      return {
        stdout: "",
        stderr: `${cancellationMessage("command", options.signal)} before start\n`,
        exitCode: CANCELLED_EXIT_CODE,
        cancelled: true,
        termination: {
          ...createTerminationResult(
            "cancelled",
            options.cancellationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
          ),
          exitedAt: new Date().toISOString(),
        },
      };
    }
    return await new Promise((resolvePromise, reject) => {
      const launch = this.commandWrapper({
        kind: "command",
        cwd,
        command: "sh",
        args: ["-c", command],
        runtimeOwnedEnv,
      });
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let termination: ProcessTerminationResult | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const shouldDetach = options?.timeoutMs !== undefined || options?.signal !== undefined;
      const child = spawn(launch.command, launch.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: shouldDetach,
        env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const logWriters = createStreamingAttemptLogWriters(
        options?.outputDirectory ?? options?.attemptDirectory,
      );
      const clearTimers = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        options?.signal?.removeEventListener("abort", abortCommand);
      };
      const killChild = (signal: NodeJS.Signals) => {
        if (child.pid && shouldDetach) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to killing the shell process below.
          }
        }
        child.kill?.(signal);
      };
      const terminate = (reason: ProcessTerminationResult["reason"]) => {
        if (termination) return;
        const graceMs = options?.cancellationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
        termination = createTerminationResult(reason, graceMs);
        if (reason === "timeout") {
          timedOut = true;
          const message = `command timed out after ${options?.timeoutMs}ms\n`;
          stderr.push(Buffer.from(message, "utf8"));
          logWriters.writeStderr(message);
        } else {
          cancelled = true;
          const message = `${cancellationMessage("command", options?.signal)}\n`;
          stderr.push(Buffer.from(message, "utf8"));
          logWriters.writeStderr(message);
        }
        killChild(termination.signal);
        forceKillTimeout = setTimeout(() => {
          if (termination) {
            termination.forceKillSent = true;
          }
          killChild("SIGKILL");
        }, graceMs);
      };
      const abortCommand = () => terminate("cancelled");
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        logWriters.writeStdout(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        logWriters.writeStderr(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        void logWriters.close();
        reject(error);
      });
      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminate("timeout");
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", abortCommand, { once: true });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (termination) {
          termination.exitedAt = new Date().toISOString();
        }
        void logWriters.close().finally(() => {
          resolvePromise({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: timedOut ? 124 : cancelled ? CANCELLED_EXIT_CODE : code ?? 1,
            ...(cancelled ? { cancelled: true } : {}),
            ...(timedOut ? { timedOut: true } : {}),
            ...(termination ? { termination } : {}),
          });
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
      timeoutMs?: number;
      signal?: AbortSignal;
      cancellationGraceMs?: number;
      globalSkills?: AgentGlobalSkillsRequest;
      session?: AgentSessionRequest;
      readPolicy?: AgentReadPolicy;
    },
  ): Promise<AgentResult> {
    const cwd = requirePath(ws);
    if (input.readPolicy?.enforcement === "required") {
      throw new Error(
        `stage ${input.stage.id} declares reads.enforcement "required", but no execution backend enforces a byte-level read bound on the local backend; use advisory or OCI read-only execution`,
      );
    }
    const runtimeId = input.stage.runtime;
    if (!runtimeId) {
      throw new Error(`agent runtime for stage ${input.stage.id} is not configured`);
    }
    // The local backend runs the agent as an ordinary child process, so it
    // mediates nothing the agent spawns. A stage that demands enforcement must
    // not run here rather than run unmediated.
    const mediation = resolveCommandMediation({
      policy: normalizeCommandMediationPolicy(
        effectiveCapabilityPolicy(input.stage).policy.commands,
      ),
      boundary: "the local execution backend",
    });
    if (mediation.status === "unenforceable") {
      throw commandMediationError(input.stage.id, mediation);
    }
    const runtime = this.runtimeRegistry.resolve(runtimeId);
    const effectiveCapabilities = effectiveCapabilityPolicy(input.stage);
    const capabilityPolicy = effectiveCapabilities.policy;
    if (
      runtime.id !== "codex" &&
      runtime.id !== "claude" &&
      capabilityPolicy.write.scope === "none"
    ) {
      throw new Error(
        `stage ${input.stage.id} requires read-only execution, but local runtime ${runtime.id} has no read-only enforcement; use codex, claude, or OCI`,
      );
    }
    const globalSkills = await resolveGlobalSkillsIsolation({
      runtime,
      request: input.globalSkills,
      env: this.env,
      stageId: input.stage.id,
    });
    let runtimeEnv: RuntimeEnv = {
      ...this.env,
      ...globalSkills.envOverrides,
      NITELY_ATTEMPT_DIR: input.attemptDirectory,
      NITELY_OUTPUT_DIR: input.attemptDirectory,
    };
    if (runtime.id === "codex" && effectiveCapabilities.source === "explicit") {
      const configured = requireCodexSandboxMode(
        runtimeEnv.NITELY_CODEX_SANDBOX ??
          runtimeEnv.NIGHTLY_CODEX_SANDBOX ??
          "danger-full-access",
      );
      runtimeEnv = {
        ...runtimeEnv,
        NITELY_CODEX_SANDBOX: tightenCodexSandboxMode(
          configured,
          codexSandboxModeForPolicy(capabilityPolicy),
        ),
      };
    }
    await assertRuntimeConfigured(runtime, runtimeEnv);
    let claudeLaunch: {
      permissionMode?: ClaudePermissionMode;
      additionalDirectories?: string[];
    } = {};
    if (runtime.id === "claude") {
      try {
        claudeLaunch = {
          permissionMode: claudePermissionModeForPolicy(capabilityPolicy),
          additionalDirectories: claudeAdditionalDirectories({
            attemptDirectory: input.attemptDirectory,
            inputIds: input.stage.inputs,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`stage ${input.stage.id}: ${message}`);
      }
    }
    const launchInput = {
      worktreePath: cwd,
      model: input.stage.model,
      prompt: input.prompt,
      env: runtimeEnv,
      ...claudeLaunch,
    };
    const resumeSessionId = input.session?.resumeSessionId;
    const canResume = resumeSessionId !== undefined && runtime.sessionReuse !== undefined;
    const launch = canResume
      ? runtime.sessionReuse!.buildResume({ ...launchInput, sessionId: resumeSessionId! })
      : runtime.build(launchInput);
    const sessionOutcome: AgentSessionOutcome = canResume
      ? { mode: "resumed", sessionId: resumeSessionId }
      : {
        mode: "cold",
        ...(resumeSessionId !== undefined
          ? {
            reason: `agent runtime ${runtime.id} cannot resume a previous session`,
          }
          : {}),
      };
    const processLaunch = this.commandWrapper({
      kind: "agent",
      cwd,
      command: launch.command,
      args: launch.args,
    });
    if (input.signal?.aborted) {
      throw Object.assign(new Error(`${cancellationMessage("agent", input.signal)} before start`), {
        stdout: "",
        stderr: `${cancellationMessage("agent", input.signal)} before start\n`,
        cancelled: true,
        termination: {
          ...createTerminationResult(
            "cancelled",
            input.cancellationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
          ),
          exitedAt: new Date().toISOString(),
        },
      });
    }
    return await new Promise<AgentResult>((resolvePromise, reject) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let termination: ProcessTerminationResult | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const shouldDetach = input.timeoutMs !== undefined || input.signal !== undefined;
      const child = this.spawnAgent(processLaunch.command, processLaunch.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: shouldDetach,
        env: runtimeEnv,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const logWriters = createStreamingAttemptLogWriters(input.attemptDirectory);
      const clearTimers = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        input.signal?.removeEventListener("abort", abortAgent);
      };
      const killChild = (signal: NodeJS.Signals) => {
        if (child.pid && shouldDetach) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to killing the runtime process below.
          }
        }
        child.kill?.(signal);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        process.stdout.write(chunk);
        logWriters.writeStdout(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        process.stderr.write(chunk);
        logWriters.writeStderr(chunk);
      });
      const capturedResult = (): AgentResult => {
        const capturedStdout = Buffer.concat(stdout).toString("utf8");
        const usage = parseRuntimeUsage(launch.runtime, capturedStdout);
        // A resumed session keeps its id; a cold one reports whatever the
        // runtime just started, so the next execution can continue it.
        const sessionId =
          runtime.sessionReuse?.parseSessionId(capturedStdout) ??
          sessionOutcome.sessionId;
        return {
          stdout: capturedStdout,
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(usage ? { usage } : {}),
          ...(globalSkills.outcome ? { globalSkills: globalSkills.outcome } : {}),
          ...(input.session !== undefined || sessionId !== undefined
            ? {
              session: {
                ...sessionOutcome,
                ...(sessionId ? { sessionId } : {}),
              },
            }
            : {}),
        };
      };
      const settle = (action: () => void) => {
        void logWriters.close().finally(action);
      };
      const terminationError = (message: string) =>
        Object.assign(new Error(message), capturedResult(), {
          ...(cancelled ? { cancelled: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
          ...(termination ? { termination } : {}),
        });
      const terminate = (reason: ProcessTerminationResult["reason"]) => {
        if (termination) return;
        const graceMs = input.cancellationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
        termination = createTerminationResult(reason, graceMs);
        if (reason === "timeout") {
          timedOut = true;
          const message = `agent session timed out after ${input.timeoutMs}ms\n`;
          stderr.push(Buffer.from(message, "utf8"));
          logWriters.writeStderr(message);
        } else {
          cancelled = true;
          const message = `${cancellationMessage("agent", input.signal)}\n`;
          stderr.push(Buffer.from(message, "utf8"));
          logWriters.writeStderr(message);
        }
        killChild(termination.signal);
        forceKillTimeout = setTimeout(() => {
          if (termination) {
            termination.forceKillSent = true;
          }
          killChild("SIGKILL");
        }, graceMs);
      };
      const abortAgent = () => terminate("cancelled");
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
          return;
        }
        reject(error);
      });
      child.stdin.end(
        launch.promptDelivery === "stdin" ? input.prompt : undefined,
      );
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (error.code === "ENOENT") {
          settle(() =>
            reject(Object.assign(
              new Error(
                `unable to start agent runtime ${launch.runtime}: command ${processLaunch.command} was not found`,
              ),
              capturedResult(),
            )),
          );
          return;
        }
        settle(() => reject(Object.assign(error, capturedResult())));
      });
      if (input.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminate("timeout");
        }, input.timeoutMs);
      }
      input.signal?.addEventListener("abort", abortAgent, { once: true });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (termination) {
          termination.exitedAt = new Date().toISOString();
        }
        if (cancelled) {
          settle(() =>
            reject(terminationError(cancellationMessage("agent", input.signal))),
          );
          return;
        }
        if (timedOut) {
          settle(() =>
            reject(
              terminationError(
                `agent session timed out after ${input.timeoutMs}ms`,
              ),
            ),
          );
          return;
        }
        const result = capturedResult();
        const envelopeError = launch.runtime === "claude"
          ? claudeErrorResultMessage(result.stdout ?? "")
          : undefined;
        if (code === 0 && envelopeError === undefined) {
          settle(() => resolvePromise(result));
          return;
        }
        const message = code === 0
          ? `${launch.runtime} reported an error: ${envelopeError}`
          : `${launch.runtime} exited with code ${code ?? 1}`;
        settle(() => reject(Object.assign(new Error(message), result)));
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
