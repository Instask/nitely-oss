import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AgentResult,
  AgentReadPolicy,
  AgentRuntimePreflightResult,
  CommandResult,
  ExecutionBackend,
  ExecutionBackendDescription,
  RunCommandOptions,
  WorkspaceHandle,
  AgentRunnableStage,
} from "./types.js";
import {
  claudePermissionModeForPolicy,
  createDefaultAgentRuntimeRegistry,
  LocalExecutionBackend,
  type AgentRuntimeRegistry,
  type ClaudePermissionMode,
  type RuntimeEnv,
} from "./local.js";
import { runSandboxProcess } from "./process-runner.js";
import {
  assertRuntimeCandidateAllowedByCapabilities,
  effectiveCapabilityPolicy,
} from "../../flow/capabilities.js";
import { globMatches } from "../../policy/glob.js";
import { redactText } from "../../context/redaction.js";
import {
  commandMediationError,
  commandMediationPromptSection,
  describeCommandMediation,
  normalizeCommandMediationPolicy,
  resolveCommandMediation,
  type CommandMediationMechanism,
  type CommandMediationOutcome,
} from "./command-mediation.js";
import {
  ContainerNetworkAllowlistGateway,
  formatNetworkPolicyDescription,
  normalizeAllowlistDomain,
  parseOciNetworkPolicy,
  type ContainerNetworkPlan,
  type NetworkAllowlistGateway,
  type OciNetworkPolicy,
} from "./network-gateway.js";

export interface SandboxProcessInput {
  command: string;
  args: string[];
  cwd?: string;
  env?: RuntimeEnv;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface SandboxProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SandboxProcessRunner = (
  input: SandboxProcessInput,
) => Promise<SandboxProcessResult>;

export type EngineSocketVerifier = (socketPath: string) => Promise<void>;

export interface OciResourcePolicy {
  cpus: number;
  memoryBytes: number;
  pids: number;
  tmpfsBytes: number;
  maxFileBytes: number;
  maxCapturedOutputBytes: number;
  timeoutMs: number;
}

export interface SandboxPolicyV1 {
  readonly version: 1;
  readonly image: string;
  readonly engineCommand: string;
  readonly network: Readonly<
    | { mode: "none" }
    | {
        mode: "allowlist";
        domains: readonly string[];
        gatewayId: string;
      }
  >;
  readonly identity: Readonly<{
    uid: number;
    gid: number;
    strategy: "rootless-container-root" | "explicit";
  }>;
  readonly environment: Readonly<{
    allowedNames: readonly string[];
    secretNames: readonly string[];
  }>;
  readonly commands: Readonly<{
    boundary: "agent-spawned";
    mediation: "mechanism" | "stated" | "none";
  }>;
  readonly mounts: Readonly<{
    worktree: "capability-scoped";
    runArtifacts: "read-only";
    attemptOutput: "read-write";
  }>;
  readonly resources: Readonly<OciResourcePolicy>;
  readonly tmpfsExec: boolean;
}

const DEFAULT_RESOURCES: OciResourcePolicy = {
  cpus: 1,
  memoryBytes: 1024 * 1024 * 1024,
  pids: 128,
  tmpfsBytes: 256 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxCapturedOutputBytes: 16 * 1024 * 1024,
  timeoutMs: 10 * 60 * 1000,
};

export interface OciExecutionBackendOptions {
  image: string;
  imageIdentity?: string;
  env?: RuntimeEnv;
  environmentAllowlist?: string[];
  secretAllowlist?: string[];
  /**
   * Domain allowlist for proxy-mediated egress (#477).
   * Empty/omitted keeps deny-all (`--network=none`).
   */
  networkAllowlist?: string[];
  engineCommand?: string;
  processRunner?: SandboxProcessRunner;
  containerName?: () => string;
  uid?: number;
  gid?: number;
  resources?: Partial<OciResourcePolicy>;
  /**
   * Mount /tmp with exec. Off by default; a repository whose verification
   * writes helper scripts or shims to os.tmpdir() and runs them needs it.
   */
  tmpfsExec?: boolean;
  /** Grace period added to the effective workload timeout before reaping. */
  cleanupGraceMs?: number;
  /** Test seam for deterministic lifecycle labels. */
  now?: () => Date;
  runtimeRegistry?: AgentRuntimeRegistry;
  engineSocketVerifier?: EngineSocketVerifier;
  /**
   * Mediates the commands an agent spawns for itself inside the sandbox.
   * Absent by default: container isolation bounds the filesystem and the
   * network, not which binaries run inside the image.
   */
  commandMediation?: CommandMediationMechanism;
  /** Test seam for the HTTP CONNECT allowlist gateway. */
  networkGatewayFactory?: (
    domains: readonly string[],
  ) => NetworkAllowlistGateway;
}

export interface OciContainerReapReport {
  observedAt: string;
  scanned: number;
  removed: string[];
  skipped: number;
  errors: string[];
}

export interface OciContainerReaperOptions {
  env?: RuntimeEnv;
  engineCommand?: string;
  processRunner?: SandboxProcessRunner;
  now?: () => Date;
}

const DEFAULT_OCI_CLEANUP_GRACE_MS = 30_000;
const OCI_CONTROLLER_INSTANCE_ID = randomUUID();
const OCI_LIFECYCLE_LABELS = [
  "com.nitely.managed",
  "com.nitely.run-id",
  "com.nitely.stage-id",
  "com.nitely.created-at",
  "com.nitely.expires-at",
  "com.nitely.instance-id",
] as const;

function assertEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid OCI environment allowlist name: ${name}`);
  }
}

function assertOciImageReference(image: string): void {
  if (image.startsWith("-") || /[\s\0]/u.test(image)) {
    throw new Error(`invalid OCI image reference: ${image}`);
  }
}

function assertContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    throw new Error(`invalid OCI container name: ${name}`);
  }
}

function assertLifecycleLabelValue(name: string, value: string): void {
  if (!value || /[\0\r\n]/u.test(value)) {
    throw new Error(`invalid OCI lifecycle label ${name}`);
  }
}

function lifecycleLabels(input: {
  runId: string;
  stageId: string;
  timeoutMs: number;
  cleanupGraceMs: number;
  now: () => Date;
}): Record<string, string> {
  const createdAt = input.now();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("OCI lifecycle clock returned an invalid date");
  }
  const labels = {
    "com.nitely.managed": "true",
    "com.nitely.run-id": input.runId,
    "com.nitely.stage-id": input.stageId,
    "com.nitely.created-at": createdAt.toISOString(),
    "com.nitely.expires-at": new Date(
      createdAt.getTime() + input.timeoutMs + input.cleanupGraceMs,
    ).toISOString(),
    "com.nitely.instance-id": OCI_CONTROLLER_INSTANCE_ID,
  };
  for (const [name, value] of Object.entries(labels)) {
    assertLifecycleLabelValue(name, value);
  }
  return labels;
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([name, value]) => [
    "--label",
    `${name}=${value}`,
  ]);
}

export async function reapExpiredOciContainers(
  options: OciContainerReaperOptions = {},
): Promise<OciContainerReapReport> {
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const report: OciContainerReapReport = {
    observedAt: observedAt.toISOString(),
    scanned: 0,
    removed: [],
    skipped: 0,
    errors: [],
  };
  try {
    const env = options.env ?? process.env;
    const endpoint = localDockerEndpoint(env);
    const engineEnv = {
      ...(env.PATH ? { PATH: env.PATH } : {}),
      DOCKER_HOST: endpoint.host,
    };
    const command = options.engineCommand?.trim() || env.NITELY_OCI_ENGINE_COMMAND?.trim() || "docker";
    const run = options.processRunner ?? runSandboxProcess;
    const listed = await run({
      command,
      args: ["ps", "-aq", "--filter", "label=com.nitely.managed=true"],
      env: engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (listed.exitCode !== 0) {
      report.errors.push(`list failed with exit ${listed.exitCode}`);
      return report;
    }
    const ids = listed.stdout
      .split(/\s+/u)
      .map((id) => id.trim())
      .filter((id) => /^[A-Za-z0-9]+$/u.test(id));
    report.scanned = ids.length;
    for (const id of ids) {
      const inspected = await run({
        command,
        args: [
          "inspect",
          "--format",
          '{{index .Config.Labels "com.nitely.expires-at"}}',
          id,
        ],
        env: engineEnv,
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
      });
      const expiresAt = Date.parse(inspected.stdout.trim());
      if (inspected.exitCode !== 0 || !Number.isFinite(expiresAt)) {
        report.skipped += 1;
        continue;
      }
      if (expiresAt > observedAt.getTime()) continue;
      const removed = await run({
        command,
        args: ["rm", "-f", id],
        env: engineEnv,
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
      });
      if (removed.exitCode === 0 || /no such container/i.test(removed.stderr)) {
        report.removed.push(id);
      } else {
        report.errors.push(`remove failed for ${id} with exit ${removed.exitCode}`);
      }
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}

function assertPositiveResource(
  name: keyof OciResourcePolicy,
  value: number,
  options: { integer?: boolean } = {},
): void {
  const validInteger =
    options.integer !== true || Number.isSafeInteger(value);
  if (!Number.isFinite(value) || value <= 0 || !validInteger) {
    throw new Error(
      `resources.${name} must be a positive${
        options.integer === true ? " integer" : " number"
      }`,
    );
  }
}

function assertIdentityId(name: "uid" | "gid", value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertDockerMountPath(path: string): void {
  if (path.includes(",")) {
    throw new Error(`OCI bind mount path cannot contain a comma: ${path}`);
  }
}

function localDockerEndpoint(env: RuntimeEnv): {
  host: string;
  socketPath: string;
} {
  const context = env.DOCKER_CONTEXT?.trim();
  if (context) {
    throw new Error(
      "OCI execution does not accept DOCKER_CONTEXT; configure a local Unix Docker socket with DOCKER_HOST",
    );
  }
  const configuredHost = env.DOCKER_HOST?.trim();
  let socketPath: string;
  if (configuredHost) {
    if (!configuredHost.startsWith("unix:///")) {
      throw new Error(
        "OCI execution requires a local Unix Docker socket in DOCKER_HOST",
      );
    }
    socketPath = configuredHost.slice("unix://".length);
  } else {
    const runtimeDirectory = env.XDG_RUNTIME_DIR?.trim();
    if (runtimeDirectory) {
      if (!isAbsolute(runtimeDirectory)) {
        throw new Error("XDG_RUNTIME_DIR must be absolute for OCI execution");
      }
      socketPath = join(runtimeDirectory, "docker.sock");
    } else if (typeof process.getuid === "function") {
      socketPath = `/run/user/${process.getuid()}/docker.sock`;
    } else {
      throw new Error(
        "OCI execution requires DOCKER_HOST to name a local Unix Docker socket",
      );
    }
  }
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    /[\0\r\n?#%]/u.test(socketPath)
  ) {
    throw new Error(
      "OCI execution requires a normalized local Unix Docker socket path",
    );
  }
  return { host: `unix://${socketPath}`, socketPath };
}

async function verifyLocalEngineSocket(socketPath: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(socketPath);
  } catch (error) {
    throw new Error(
      `OCI Docker endpoint is not an accessible local Unix socket: ${socketPath}`,
      { cause: error },
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const canonicalPath = await realpath(socketPath).catch(() => undefined);
  if (
    !entry.isSocket() ||
    entry.isSymbolicLink() ||
    canonicalPath !== socketPath ||
    uid === undefined ||
    entry.uid !== uid
  ) {
    throw new Error(
      `OCI Docker endpoint must be a canonical local Unix socket owned by uid ${uid ?? "unknown"}: ${socketPath}`,
    );
  }
}

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function containerAlreadyRemoved(
  result: SandboxProcessResult,
  containerName: string,
): boolean {
  return (
    result.exitCode === 1 &&
    result.stderr.trim() ===
      `Error response from daemon: No such container: ${containerName}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workloadAndCleanupError(input: {
  primaryError?: unknown;
  result?: SandboxProcessResult;
  cleanup: SandboxProcessResult;
  containerName: string;
}): Error & { code?: unknown } {
  const cleanupMessage =
    input.cleanup.stderr.trim() || `exit ${input.cleanup.exitCode}`;
  const workloadMessage = input.primaryError !== undefined
    ? errorMessage(input.primaryError)
    : input.result
      ? `OCI workload exited ${input.result.exitCode}${
          input.result.stderr.trim() ? `: ${input.result.stderr.trim()}` : ""
        }`
      : "OCI workload outcome is unavailable";
  const combined = new Error(
    `${workloadMessage}; OCI container cleanup failed for ${input.containerName}: ${cleanupMessage}`,
    input.primaryError !== undefined ? { cause: input.primaryError } : undefined,
  ) as Error & { code?: unknown };
  if (
    typeof input.primaryError === "object" &&
    input.primaryError !== null &&
    "code" in input.primaryError
  ) {
    combined.code = (input.primaryError as { code?: unknown }).code;
  }
  return combined;
}

function parseEngineInfo(output: string): {
  rootless: boolean;
  cgroupVersion?: string;
  warnings?: string[];
} {
  const [securityOptionsJson, cgroupVersionJson, warningsJson] = output
    .trim()
    .split("\t");
  try {
    const securityOptions: unknown = JSON.parse(securityOptionsJson ?? "");
    const cgroupVersion: unknown = JSON.parse(cgroupVersionJson ?? "null");
    const warnings: unknown = JSON.parse(warningsJson ?? "null");
    const parsedWarnings =
      warnings === null
        ? []
        : Array.isArray(warnings) &&
            warnings.every((warning) => typeof warning === "string")
          ? warnings
          : undefined;
    return {
      rootless:
        Array.isArray(securityOptions) &&
        securityOptions.some(
          (option) => option === "rootless" || option === "name=rootless",
        ),
      ...(typeof cgroupVersion === "string" || typeof cgroupVersion === "number"
        ? { cgroupVersion: String(cgroupVersion) }
        : {}),
      ...(parsedWarnings ? { warnings: parsedWarnings } : {}),
    };
  } catch {
    return { rootless: false };
  }
}

function isUnsupportedRequiredResourceLimitWarning(warning: string): boolean {
  return /no (?:memory limit|swap limit|cpu cfs (?:quota|period)|pids limit) support/i.test(
    warning,
  );
}

function offlineRuntimeError(runtime: {
  id: string;
  networkAccess?: string;
}): Error {
  const reason =
    runtime.networkAccess === "required"
      ? "requires network access"
      : "does not explicitly declare offline operation";
  return new Error(
    `agent runtime ${runtime.id} ${reason}, but OCI SandboxPolicyV1 enforces network=none; configure NITELY_OCI_NETWORK_ALLOWLIST (or stage capabilities.network.domains) to enable the allowlist gateway, use an explicitly offline runtime, or choose a backend that can enforce the declared network policy`,
  );
}

function normalizeStageNetworkDomains(
  domains: readonly string[] | undefined,
): string[] {
  if (!domains || domains.length === 0) return [];
  return [...new Set(domains.map(normalizeAllowlistDomain))].sort();
}

interface InternalNetwork {
  name: string;
  gatewayContainerName: string;
}

function networkAlreadyRemoved(
  result: SandboxProcessResult,
  networkName: string,
): boolean {
  return (
    result.exitCode === 1 &&
    new RegExp(`(?:No such network|network .* not found).*${networkName}`, "i").test(
      result.stderr,
    )
  );
}

export class OciExecutionBackend implements ExecutionBackend {
  readonly image: string;
  readonly policy: Readonly<SandboxPolicyV1>;
  readonly agentTimeoutControl = "backend" as const;
  private readonly env: RuntimeEnv;
  private readonly engineEnv: RuntimeEnv;
  private readonly engineSocketPath: string;
  private readonly engineSocketVerifier?: EngineSocketVerifier;
  private readonly environmentAllowlist: string[];
  private readonly secretAllowlist: string[];
  private readonly engineCommand: string;
  private readonly processRunner: SandboxProcessRunner;
  private readonly containerName: () => string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly resources: OciResourcePolicy;
  private readonly tmpfsExec: boolean;
  private readonly cleanupGraceMs: number;
  private readonly now: () => Date;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly localGit: LocalExecutionBackend;
  private readonly networkPolicy: OciNetworkPolicy;
  private readonly networkGatewayFactory?: (
    domains: readonly string[],
  ) => NetworkAllowlistGateway;
  private readonly commandMediation?: CommandMediationMechanism;
  private resolvedImage?: string;
  private resolvedImageIdentity?: string;
  private imagePrepared = false;
  private readonly trustedWorkspaceGit = new Map<
    string,
    { workspacePath: string; gitFile: Buffer }
  >();
  private rootlessVerified = false;

  constructor(options: OciExecutionBackendOptions) {
    const image = options.image.trim();
    if (!image) {
      throw new Error("NITELY_OCI_IMAGE is required for the OCI execution backend");
    }
    assertOciImageReference(image);
    if (options.imageIdentity && !/^sha256:[0-9a-f]{64}$/i.test(options.imageIdentity)) {
      throw new Error("OCI image identity must be a sha256 digest");
    }
    const environmentAllowlist = [
      ...new Set(options.environmentAllowlist ?? []),
    ].sort();
    const secretAllowlist = [...new Set(options.secretAllowlist ?? [])].sort();
    for (const name of [...environmentAllowlist, ...secretAllowlist]) {
      assertEnvironmentName(name);
    }
    const networkDomains = [
      ...new Set((options.networkAllowlist ?? []).map(normalizeAllowlistDomain)),
    ].sort();
    this.networkPolicy = parseOciNetworkPolicy({
      allowlistRaw: networkDomains.join(","),
    });
    this.networkGatewayFactory = options.networkGatewayFactory;
    this.commandMediation = options.commandMediation;
    this.image = image;
    if (options.imageIdentity) {
      this.resolvedImage = options.imageIdentity;
      this.resolvedImageIdentity = options.imageIdentity;
    }
    this.env = options.env ?? process.env;
    this.environmentAllowlist = environmentAllowlist;
    this.secretAllowlist = secretAllowlist;
    const endpoint = localDockerEndpoint(this.env);
    this.engineSocketPath = endpoint.socketPath;
    this.engineEnv = Object.fromEntries(
      ["PATH", ...environmentAllowlist, ...secretAllowlist].flatMap((name) => {
        const value = this.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    this.engineEnv.DOCKER_HOST = endpoint.host;
    this.engineSocketVerifier =
      options.engineSocketVerifier ??
      (options.processRunner === undefined ? verifyLocalEngineSocket : undefined);
    const engineCommand = (options.engineCommand ?? "docker").trim();
    if (!engineCommand) {
      throw new Error("engineCommand must be non-empty");
    }
    this.engineCommand = engineCommand;
    this.processRunner = options.processRunner ?? runSandboxProcess;
    this.containerName =
      options.containerName ?? (() => `nitely-${randomUUID().toLowerCase()}`);
    // Rootless Docker maps container root to the unprivileged daemon owner on
    // the host. Reusing the host numeric uid inside the container maps it into
    // the subordinate range and prevents writes to host-user-owned bind mounts.
    this.uid = options.uid ?? 0;
    this.gid = options.gid ?? 0;
    assertIdentityId("uid", this.uid);
    assertIdentityId("gid", this.gid);
    this.resources = { ...DEFAULT_RESOURCES, ...options.resources };
    this.tmpfsExec = options.tmpfsExec === true;
    assertPositiveResource("cpus", this.resources.cpus);
    for (const name of [
      "memoryBytes",
      "pids",
      "tmpfsBytes",
      "maxFileBytes",
      "maxCapturedOutputBytes",
      "timeoutMs",
    ] as const) {
      assertPositiveResource(name, this.resources[name], { integer: true });
    }
    this.cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_OCI_CLEANUP_GRACE_MS;
    if (!Number.isSafeInteger(this.cleanupGraceMs) || this.cleanupGraceMs < 0) {
      throw new Error("cleanupGraceMs must be a non-negative integer");
    }
    this.now = options.now ?? (() => new Date());
    this.policy = Object.freeze({
      version: 1,
      image: this.image,
      engineCommand: this.engineCommand,
      network: Object.freeze(
        this.networkPolicy.mode === "allowlist"
          ? {
              mode: "allowlist" as const,
              domains: Object.freeze([...this.networkPolicy.domains]),
              gatewayId: this.networkPolicy.gatewayId,
            }
          : { mode: "none" as const },
      ),
      identity: Object.freeze({
        uid: this.uid,
        gid: this.gid,
        strategy:
          options.uid === undefined && options.gid === undefined
            ? "rootless-container-root"
            : "explicit",
      }),
      environment: Object.freeze({
        allowedNames: Object.freeze([...this.environmentAllowlist]),
        secretNames: Object.freeze([...this.secretAllowlist]),
      }),
      commands: Object.freeze({
        boundary: "agent-spawned" as const,
        mediation: this.commandMediation ? ("mechanism" as const) : ("stated" as const),
      }),
      mounts: Object.freeze({
        worktree: "capability-scoped",
        runArtifacts: "read-only",
        attemptOutput: "read-write",
      }),
      resources: Object.freeze({ ...this.resources }),
      tmpfsExec: this.tmpfsExec,
    });
    this.runtimeRegistry =
      options.runtimeRegistry ?? createDefaultAgentRuntimeRegistry();
    this.localGit = new LocalExecutionBackend({ env: this.env });
  }

  describeExecution(): ExecutionBackendDescription {
    const networkDescription = formatNetworkPolicyDescription(this.networkPolicy);
    return {
      backend: "oci",
      engine: `${this.engineCommand === "docker" ? "docker" : this.engineCommand}-rootless`,
      image: this.image,
      ...(this.resolvedImageIdentity
        ? {
            imageReference: this.image,
            imageIdentity: this.resolvedImageIdentity,
          }
        : {}),
      policyVersion: this.policy.version,
      isolation: "rootless-container",
      identity: { ...this.policy.identity },
      network: networkDescription,
      mounts: [
        "task worktree (capability-scoped)",
        "task run artifacts (read-only)",
        "attempt output (read-write)",
      ],
      environment: {
        allowedNames: [...this.environmentAllowlist],
        secretNames: [...this.secretAllowlist],
        valuesRecorded: false,
      },
      commands: {
        mediation: this.commandMediation ? "mechanism" : "stated",
        ...(this.commandMediation ? { mechanism: this.commandMediation.id } : {}),
      },
      resources: { ...this.resources },
      tmpfs: { exec: this.tmpfsExec },
      cleanup: "run --rm plus forced rm -f",
      lifecycle: {
        managed: true,
        expiry: "effective timeout plus bounded cleanup grace",
        cleanupGraceMs: this.cleanupGraceMs,
        labelKeys: [...OCI_LIFECYCLE_LABELS],
      },
      limitations: [
        "backing linked-worktree Git metadata is never mounted; host-side workspace create/commit is the only Git write path; Codex uses --skip-git-repo-check and in-container Git commands may be unavailable",
        this.networkPolicy.mode === "allowlist"
          ? "agent egress uses an internal-only workload network and an HTTP CONNECT allowlist gateway; direct sockets have no external route and non-allowlisted CONNECT is denied"
          : "without NITELY_OCI_NETWORK_ALLOWLIST, agent runtimes must be offline or fail preflight; built-in Codex/Claude/GLM/Grok/Pi require the allowlist gateway",
        this.commandMediation
          ? `agent-spawned commands are mediated by ${this.commandMediation.id}`
          : "agent-spawned commands are not mediated inside the image; a stage that sets capabilities.commands.advisory false fails closed instead of running unmediated",
        "aggregate bind-mount disk quota (NITELY_OCI_DISK_BYTES) is not supported and will not be; setting it fails closed. Use per-file NITELY_OCI_MAX_FILE_BYTES and captured-output NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES",
      ],
    };
  }

  async prepareForRun(): Promise<void> {
    if (this.imagePrepared) return;
    await this.verifyRootlessEngine();
    const inspectImage = this.resolvedImage ?? this.image;
    const result = await this.processRunner({
      command: this.engineCommand,
      args: [
        "image",
        "inspect",
        "--format",
        "{{json .Id}}\t{{json .RepoDigests}}",
        inspectImage,
      ],
      env: this.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `unable to resolve OCI image ${inspectImage}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    if (this.resolvedImageIdentity) {
      this.imagePrepared = true;
      return;
    }
    const [idValue, repoDigestsValue] = result.stdout.trim().split("\t", 2);
    let imageId: unknown;
    let repoDigests: unknown;
    try {
      imageId = JSON.parse(idValue ?? "null") as unknown;
      repoDigests = JSON.parse(repoDigestsValue ?? "null") as unknown;
    } catch {
      throw new Error(`unable to resolve OCI image ${this.image}: inspect output is invalid`);
    }
    const immutableImageId = typeof imageId === "string" && /^sha256:[0-9a-f]{64}$/i.test(imageId)
      ? imageId
      : undefined;
    const repoDigest = Array.isArray(repoDigests)
      ? repoDigests.find((value): value is string => typeof value === "string" && /@sha256:[0-9a-f]{64}$/i.test(value))
      : undefined;
    const identity = repoDigest?.match(/@sha256:[0-9a-f]{64}$/i)?.[0].slice(1) ?? immutableImageId;
    if (!identity) {
      throw new Error(`unable to resolve OCI image ${this.image}: no immutable sha256 identity`);
    }
    this.resolvedImage = repoDigest ?? immutableImageId ?? identity;
    this.resolvedImageIdentity = identity;
    this.imagePrepared = true;
  }

  async createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
  }): Promise<WorkspaceHandle> {
    const workspace = await this.localGit.createWorkspace(input);
    if (!workspace.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const workspacePath = await realpath(workspace.path);
    const gitPath = join(workspacePath, ".git");
    const gitEntry = await lstat(gitPath);
    if (!gitEntry.isFile() || gitEntry.isSymbolicLink()) {
      throw new Error("OCI workspace has unsafe Git metadata");
    }
    this.trustedWorkspaceGit.set(workspace.runId, {
      workspacePath,
      gitFile: await readFile(gitPath),
    });
    return workspace;
  }

  async runCommand(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandResult> {
    const plan = await this.commandPlan(ws, command, options);
    return await this.executePlan(plan);
  }

  private async executePlan(plan: {
    containerName: string;
    launch: SandboxProcessInput;
  }): Promise<SandboxProcessResult> {
    await this.verifyRootlessEngine();
    let result: SandboxProcessResult | undefined;
    let primaryError: unknown;
    try {
      result = await this.processRunner(plan.launch);
    } catch (error) {
      primaryError = error;
    }

    const cleanupInput: SandboxProcessInput = {
        command: this.engineCommand,
        args: ["rm", "-f", plan.containerName],
        env: this.engineEnv,
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
    };
    let cleanup = await this.processRunner(cleanupInput).catch((error: unknown) => ({
        stdout: "",
        stderr: errorMessage(error),
        exitCode: 1,
      }));
    if (
      containerAlreadyRemoved(cleanup, plan.containerName) &&
      (primaryError !== undefined || (result?.exitCode ?? 0) !== 0)
    ) {
      for (const delayMs of [100, 250]) {
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, delayMs),
        );
        cleanup = await this.processRunner(cleanupInput).catch((error: unknown) => ({
          stdout: "",
          stderr: errorMessage(error),
          exitCode: 1,
        }));
        if (!containerAlreadyRemoved(cleanup, plan.containerName)) break;
      }
    }
    const cleanupFailed =
      cleanup.exitCode !== 0 &&
      !containerAlreadyRemoved(cleanup, plan.containerName);
    if (cleanupFailed) {
      throw workloadAndCleanupError({
        ...(primaryError !== undefined ? { primaryError } : {}),
        ...(result ? { result } : {}),
        cleanup,
        containerName: plan.containerName,
      });
    }
    if (primaryError !== undefined) throw primaryError;
    if (!result) throw new Error("OCI workload produced no result");
    return {
      ...result,
      stdout: redactText(result.stdout, this.redactionSecrets()) ?? "",
      stderr: redactText(result.stderr, this.redactionSecrets()) ?? "",
    };
  }

  private async commandPlan(
    ws: WorkspaceHandle,
    command: string,
    options?: RunCommandOptions,
    workspaceMountArgs?: string[],
    networkPlan?: ContainerNetworkPlan,
    visibleInputPaths?: readonly string[],
    secretNames?: readonly string[],
  ): Promise<{ containerName: string; launch: SandboxProcessInput }> {
    if (!ws.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const outputPath = options?.outputDirectory ?? options?.attemptDirectory;
    if (!outputPath) {
      throw new Error("OCI execution requires an explicit output directory");
    }
    await mkdir(outputPath, { recursive: true });
    const workspace = await realpath(ws.path);
    const runRoot = await realpath(dirname(workspace));
    const output = await realpath(outputPath);
    if (!isContained(runRoot, output)) {
      throw new Error(`OCI output directory escapes the task run directory: ${outputPath}`);
    }
    for (const path of [workspace, runRoot, output]) assertDockerMountPath(path);
    const workspaceRunAlias = basename(workspace);
    if (workspaceRunAlias.includes(":")) {
      throw new Error(
        `OCI worktree name cannot contain a colon: ${workspaceRunAlias}`,
      );
    }
    const containerName = this.containerName();
    assertContainerName(containerName);
    const timeoutMs = options?.timeoutMs ?? this.resources.timeoutMs;
    const labels = lifecycleLabels({
      runId: options?.runId ?? ws.runId,
      stageId: options?.stageId ?? "command",
      timeoutMs,
      cleanupGraceMs: this.cleanupGraceMs,
      now: this.now,
    });
    const networkArgs = networkPlan?.dockerArgs ?? ["--network=none"];
    const runArtifactMountArgs =
      visibleInputPaths === undefined
        ? [
            "--mount",
            `type=bind,src=${runRoot},dst=/nitely/run,readonly`,
            "--tmpfs",
            `/nitely/run/${workspaceRunAlias}:ro,nosuid,nodev,noexec,size=1048576`,
          ]
        : await this.visibleRunArtifactMounts(runRoot, visibleInputPaths);
    const args = [
      "run",
      "--rm",
      "--init",
      "--pull=never",
      "--read-only",
      ...labelArgs(labels),
      ...networkArgs,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--ipc=none",
      "--name",
      containerName,
      "--user",
      `${this.uid}:${this.gid}`,
      "--cpus",
      String(this.resources.cpus),
      "--memory",
      String(this.resources.memoryBytes),
      "--memory-swap",
      String(this.resources.memoryBytes),
      "--pids-limit",
      String(this.resources.pids),
      "--ulimit",
      `fsize=${this.resources.maxFileBytes}:${this.resources.maxFileBytes}`,
      "--tmpfs",
      // The engine's own tmpfs default is noexec, so exec must be spelled out.
      `/tmp:rw,${this.tmpfsExec ? "exec," : ""}nosuid,nodev,${this.tmpfsExec ? "" : "noexec,"}size=${this.resources.tmpfsBytes}`,
      ...(workspaceMountArgs ?? [
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
      ]),
      "--mount",
      "type=bind,src=/dev/null,dst=/workspace/.git,readonly",
      ...runArtifactMountArgs,
      "--mount",
      `type=bind,src=${output},dst=/nitely/output`,
      ...this.containerEnvironmentArgs(
        options,
        networkPlan?.containerEnv,
        secretNames,
      ),
      "--workdir",
      "/workspace",
      this.resolvedImage ?? this.image,
      "sh",
      "-c",
      command,
    ];
    return {
      containerName,
      launch: {
        command: this.engineCommand,
        args,
        env: this.engineEnv,
        timeoutMs,
        maxOutputBytes: this.resources.maxCapturedOutputBytes,
        signal: options?.signal,
      },
    };
  }

  private containerEnvironmentArgs(
    options?: RunCommandOptions,
    extraEnv?: Record<string, string>,
    secretNames: readonly string[] = this.secretAllowlist,
  ): string[] {
    const allowed = [...this.environmentAllowlist, ...secretNames]
      .filter((name) => this.env[name] !== undefined)
      .flatMap((name) => ["--env", name]);
    const extras = Object.entries(extraEnv ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]);
    return [
      ...allowed,
      ...extras,
      "--env",
      "HOME=/tmp/nitely-home",
      "--env",
      "NITELY_OUTPUT_DIR=/nitely/output",
      "--env",
      "NITELY_ATTEMPT_DIR=/nitely/output",
      ...(options?.runId ? ["--env", `NITELY_RUN_ID=${options.runId}`] : []),
      ...(options?.stageId ? ["--env", `NITELY_STAGE_ID=${options.stageId}`] : []),
      ...(options?.attempt !== undefined
        ? ["--env", `NITELY_ATTEMPT=${options.attempt}`]
        : []),
    ];
  }

  private async verifyRootlessEngine(): Promise<void> {
    if (this.rootlessVerified) return;
    await this.engineSocketVerifier?.(this.engineSocketPath);
    const result = await this.processRunner({
      command: this.engineCommand,
      args: [
        "info",
        "--format",
        "{{json .SecurityOptions}}\t{{json .CgroupVersion}}\t{{json .Warnings}}",
      ],
      env: this.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `unable to inspect OCI engine rootless mode: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`,
      );
    }
    const engineInfo = parseEngineInfo(result.stdout);
    if (!engineInfo.rootless) {
      throw new Error("OCI execution requires a rootless Docker engine");
    }
    if (engineInfo.cgroupVersion !== "2") {
      throw new Error("OCI execution requires cgroup v2 resource enforcement");
    }
    if (!engineInfo.warnings) {
      throw new Error("unable to verify OCI engine resource-limit support");
    }
    const unsupportedLimit = engineInfo.warnings.find((warning) =>
      isUnsupportedRequiredResourceLimitWarning(warning),
    );
    if (unsupportedLimit) {
      throw new Error(
        `OCI engine cannot enforce required resource limits: ${unsupportedLimit}`,
      );
    }
    this.rootlessVerified = true;
  }

  async runAgent(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      prompt: string;
      attemptDirectory: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      visibleInputPaths?: string[];
      readPolicy?: AgentReadPolicy;
    },
  ): Promise<AgentResult> {
    const { policy } = effectiveCapabilityPolicy(input.stage);
    if (input.stage.runtime) {
      assertRuntimeCandidateAllowedByCapabilities({
        stage: input.stage,
        candidate: {
          runtime: input.stage.runtime,
          ...(input.stage.model ? { model: input.stage.model } : {}),
        },
      });
    }
    const mediation = this.resolveCommandMediation(policy);
    if (mediation.status === "unenforceable") {
      throw commandMediationError(input.stage.id, mediation);
    }
    const runtimeId = input.stage.runtime;
    if (!runtimeId) {
      throw new Error(`agent runtime for stage ${input.stage.id} is not configured`);
    }
    const runtime = this.runtimeRegistry.resolve(runtimeId);
    const networkDecision = this.resolveAgentNetworkDecision({
      stage: input.stage,
      runtime,
    });
    let gateway: NetworkAllowlistGateway | undefined;
    let internalNetwork: InternalNetwork | undefined;
    let boundedWorkspace: { path: string; cleanup: string } | undefined;
    let networkPlan: ContainerNetworkPlan | undefined;
    try {
      if (networkDecision.mode === "allowlist") {
        if (!this.networkGatewayFactory) {
          await this.verifyRootlessEngine();
          internalNetwork = await this.createInternalNetwork();
        }
        const labels = lifecycleLabels({
          runId: ws.runId,
          stageId: input.stage.id,
          timeoutMs: input.timeoutMs ?? this.resources.timeoutMs,
          cleanupGraceMs: this.cleanupGraceMs,
          now: this.now,
        });
        gateway = this.createGateway(networkDecision.domains, internalNetwork, labels);
        await gateway.assertEnforceable();
        networkPlan = await gateway.prepareContainerNetwork();
      }
      if (input.readPolicy?.enforcement === "required") {
        if (policy.write.scope !== "none") {
          throw new Error(
            `stage ${input.stage.id} requires a byte-level read bound, but OCI can only enforce it for read-only stages; set capabilities.write.scope to none or use advisory enforcement`,
          );
        }
        boundedWorkspace = await this.createReadBoundWorkspace(
          ws,
          input.readPolicy,
        );
      }
      const secretNames = this.runtimeSecretNames(runtime);
      const runtimeEnv = this.runtimeEnvironment(secretNames);
      const missing = (runtime.requiredEnv ?? []).filter(
        (alternatives) =>
          !alternatives.some((name) => Boolean(runtimeEnv[name])),
      );
      if (missing.length > 0) {
        throw new Error(
          `agent runtime ${runtime.id} is not configured in the OCI environment allowlists. Allow ${missing
            .map((alternatives) => alternatives.join(" or "))
            .join("; ")}.`,
        );
      }
      const preparedPrompt = await this.prepareAgentPrompt({
        workspace: ws,
        attemptDirectory: input.attemptDirectory,
        prompt:
          mediation.status === "stated"
            ? `${input.prompt}\n\n${commandMediationPromptSection(mediation.policy)}`
            : input.prompt,
      });
      // Claude enforces its own tool permissions inside the container, so it
      // gets the same mode the local backend derives from the stage's
      // capabilities; without one, print mode denies every edit and command
      // and the session burns its whole timeout on refusals. The extra
      // directories are the container paths of the attempt output and the
      // stage inputs, which lie outside the /workspace project root.
      let claudeLaunch: {
        permissionMode?: ClaudePermissionMode;
        additionalDirectories?: string[];
      } = {};
      if (runtime.id === "claude") {
        claudeLaunch = {
          // A stage with no worktree writes still writes its declared outputs
          // under /nitely/output. The read-only worktree mount is what
          // enforces the write boundary here, so acceptEdits is safe where the
          // local backend has to leave the mode unset.
          permissionMode: claudePermissionModeForPolicy(policy) ?? "acceptEdits",
          additionalDirectories: [
            "/nitely/output",
            ...input.stage.inputs.map((inputId) => `/nitely/run/inputs/${inputId}`),
          ],
        };
      }
      const launch = runtime.build({
        worktreePath: "/workspace",
        model: input.stage.model,
        prompt: preparedPrompt,
        ...claudeLaunch,
        env: {
          ...runtimeEnv,
          ...(this.env.NITELY_CODEX_COMMAND
            ? { NITELY_CODEX_COMMAND: this.env.NITELY_CODEX_COMMAND }
            : {}),
          ...(this.env.NITELY_CLAUDE_COMMAND
            ? { NITELY_CLAUDE_COMMAND: this.env.NITELY_CLAUDE_COMMAND }
            : {}),
          ...(this.env.NITELY_GLM_COMMAND
            ? { NITELY_GLM_COMMAND: this.env.NITELY_GLM_COMMAND }
            : {}),
          ...(this.env.NITELY_GROK_COMMAND
            ? { NITELY_GROK_COMMAND: this.env.NITELY_GROK_COMMAND }
            : {}),
          ...(this.env.NITELY_PI_COMMAND
            ? { NITELY_PI_COMMAND: this.env.NITELY_PI_COMMAND }
            : {}),
        },
      });
      const options: RunCommandOptions = {
        outputDirectory: input.attemptDirectory,
        attemptDirectory: input.attemptDirectory,
        runId: ws.runId,
        stageId: input.stage.id,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      };
      const workspaceMountArgs = await this.capabilityWorkspaceMounts(
        ws,
        policy,
        boundedWorkspace?.path,
      );
      const plan = await this.commandPlan(
        ws,
        "",
        options,
        workspaceMountArgs,
        networkPlan,
        input.visibleInputPaths ?? [],
        secretNames,
      );
      const runtimeArgs = [...launch.args];
      if (launch.runtime === "codex" && runtimeArgs[0] === "exec") {
        runtimeArgs.splice(1, 0, "--skip-git-repo-check");
      }
      if (launch.runtime === "claude") {
        // A rootless engine maps the operator to uid 0 inside the container,
        // and the Claude CLI refuses to bypass permissions as root unless the
        // environment declares the process sandboxed. This container is the
        // sandbox: read-only root, dropped capabilities, scoped mounts.
        const imageIndex = plan.launch.args.indexOf(this.resolvedImage ?? this.image);
        plan.launch.args.splice(imageIndex, 0, "--env", "IS_SANDBOX=1");
      }
      plan.launch.args.splice(-3, 3, launch.command, ...runtimeArgs);
      if (launch.promptDelivery === "stdin") {
        plan.launch.stdin = preparedPrompt;
        // Without --interactive the engine closes the workload's stdin and the
        // piped prompt never reaches the CLI. No --tty: the prompt is data, not
        // a terminal session, and a tty would mangle the JSON event stream.
        plan.launch.args.splice(1, 0, "--interactive");
      } else {
        plan.launch.stdin = undefined;
      }
      const result = await this.executePlan(plan);
      if (result.exitCode !== 0) {
        if (
          input.timeoutMs !== undefined &&
          result.exitCode === 124 &&
          result.stderr.includes(`process timed out after ${input.timeoutMs}ms`)
        ) {
          throw Object.assign(
            new Error(`${launch.runtime} timed out after ${input.timeoutMs}ms`),
            {
              code: "EXECUTION_TIMEOUT" as const,
              timeoutMs: input.timeoutMs,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          );
        }
        throw Object.assign(
          new Error(`${launch.runtime} exited with code ${result.exitCode}`),
          { stdout: result.stdout, stderr: result.stderr },
        );
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        // The container never mounts the operator's home; HOME is a throwaway
        // path inside the sandbox, so no user-global skill pack can load.
        globalSkills: { isolated: true },
      };
    } finally {
      await gateway?.dispose().catch(() => undefined);
      if (internalNetwork) {
        await this.removeInternalNetwork(internalNetwork.name);
      }
      if (boundedWorkspace) {
        await rm(boundedWorkspace.cleanup, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  /**
   * The stage's command policy governs what the agent spawns for itself. The
   * runtime CLI Nitely launches is the agent, not one of its commands, so it is
   * never matched against the policy.
   */
  private resolveCommandMediation(
    policy: ReturnType<typeof effectiveCapabilityPolicy>["policy"],
  ): CommandMediationOutcome {
    return resolveCommandMediation({
      policy: normalizeCommandMediationPolicy(policy.commands),
      boundary: "the OCI sandbox",
      ...(this.commandMediation ? { mechanism: this.commandMediation } : {}),
    });
  }

  private resolveAgentNetworkDecision(input: {
    stage: AgentRunnableStage;
    runtime: { id: string; networkAccess?: string };
  }): { mode: "none" } | { mode: "allowlist"; domains: readonly string[] } {
    const { policy } = effectiveCapabilityPolicy(input.stage);
    const capMode = policy.network.mode;
    if (capMode === "allowed") {
      throw new Error(
        "OCI execution cannot enforce network mode allowed; use restricted with a domain allowlist, disabled, or advisory",
      );
    }

    const stageDomains = normalizeStageNetworkDomains(policy.network.domains);
    const domains =
      stageDomains.length > 0 ? stageDomains : this.networkPolicy.domains;
    const runtimeNeedsNetwork = input.runtime.networkAccess !== "none";

    if (capMode === "disabled") {
      if (runtimeNeedsNetwork) {
        throw offlineRuntimeError(input.runtime);
      }
      return { mode: "none" };
    }

    // restricted | advisory | (implicit treated as advisory via defaults)
    if (!runtimeNeedsNetwork) {
      return { mode: "none" };
    }

    if (domains.length === 0) {
      if (capMode === "restricted") {
        throw new Error(
          `OCI execution cannot enforce network mode restricted without domains; set capabilities.network.domains or NITELY_OCI_NETWORK_ALLOWLIST`,
        );
      }
      throw offlineRuntimeError(input.runtime);
    }

    return { mode: "allowlist", domains };
  }

  private createGateway(
    domains: readonly string[],
    internalNetwork?: InternalNetwork,
    labels?: Record<string, string>,
  ): NetworkAllowlistGateway {
    if (this.networkGatewayFactory) {
      return this.networkGatewayFactory(domains);
    }
    if (!internalNetwork) {
      throw new Error(
        "OCI network allowlist requires an internal-only workload network; docker bridge is not an enforceable egress boundary",
      );
    }
    return new ContainerNetworkAllowlistGateway({
      domains,
      image: this.image,
      networkName: internalNetwork.name,
      containerName: internalNetwork.gatewayContainerName,
      engineCommand: this.engineCommand,
      engineEnv: this.engineEnv,
      processRunner: this.processRunner,
      ...(labels ? { labels } : {}),
    });
  }

  private async createInternalNetwork(): Promise<InternalNetwork> {
    const name = `nitely-egress-${randomUUID().toLowerCase()}`;
    const gatewayContainerName = `nitely-egress-gateway-${randomUUID().toLowerCase()}`;
    const create = await this.processRunner({
      command: this.engineCommand,
      args: [
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        "--label",
        "com.nitely.network-purpose=oci-egress",
        name,
      ],
      env: this.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (create.exitCode !== 0) {
      throw new Error(
        `OCI internal egress network could not be created: ${
          create.stderr.trim() || `exit ${create.exitCode}`
        }`,
      );
    }
    return { name, gatewayContainerName };
  }

  private async removeInternalNetwork(networkName: string): Promise<void> {
    const result = await this.processRunner({
      command: this.engineCommand,
      args: ["network", "rm", networkName],
      env: this.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0 && !networkAlreadyRemoved(result, networkName)) {
      throw new Error(
        `OCI internal egress network cleanup failed for ${networkName}: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`,
      );
    }
  }

  private async createReadBoundWorkspace(
    ws: WorkspaceHandle,
    policy: AgentReadPolicy,
  ): Promise<{ path: string; cleanup: string }> {
    if (!ws.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const source = await realpath(ws.path);
    const cleanup = await mkdtemp(join(tmpdir(), "nitely-read-bound-"));
    const path = join(cleanup, "workspace");
    try {
      await cp(source, path, {
        recursive: true,
        filter: (candidate) => {
          const relativePath = relative(source, candidate).replaceAll(sep, "/");
          if (relativePath === "") return true;
          const denied = policy.deny.some(
            (pattern) =>
              globMatches(pattern, relativePath) ||
              globMatches(pattern, `${relativePath}/__nitely__`),
          );
          if (denied) return false;
          try {
            const metadata = lstatSync(candidate);
            if (metadata.isSymbolicLink()) return false;
            return metadata.isDirectory() ||
              (metadata.isFile() && metadata.size <= policy.maxFileBytes);
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      await rm(cleanup, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(
        `OCI read-bound workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { path, cleanup };
  }

  private async capabilityWorkspaceMounts(
    ws: WorkspaceHandle,
    policy: ReturnType<typeof effectiveCapabilityPolicy>["policy"],
    workspaceSource?: string,
  ): Promise<string[]> {
    if (!ws.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const workspace = await realpath(ws.path);
    const mountedWorkspace = workspaceSource
      ? await realpath(workspaceSource)
      : workspace;
    const readPaths = policy.read.allow;
    const writePaths = policy.write.allow;
    const writeScope = policy.write.scope ?? "worktree";
    if (
      readPaths.length === 0 &&
      (policy.read.scope ?? "repository") !== "repository"
    ) {
      throw new Error(
        `OCI execution cannot enforce empty read scope ${policy.read.scope}; declare contained read paths or repository scope`,
      );
    }
    if (writeScope !== "worktree" && writeScope !== "none") {
      throw new Error(
        `OCI execution cannot enforce write scope ${policy.write.scope}; use worktree or none`,
      );
    }
    if (writeScope === "none" && writePaths.length > 0) {
      throw new Error(
        "OCI execution cannot combine write scope none with writable paths",
      );
    }
    if (readPaths.length > 0 && writePaths.length === 0) {
      throw new Error(
        "OCI execution cannot combine a restricted read allowlist with full-worktree write access",
      );
    }
    const args: string[] = [];
    if (readPaths.length === 0) {
      args.push(
        "--mount",
        `type=bind,src=${mountedWorkspace},dst=/workspace${
          writeScope === "none" || writePaths.length > 0 ? ",readonly" : ""
        }`,
      );
    } else {
      args.push(
        "--tmpfs",
        "/workspace:ro,nosuid,nodev,noexec,size=1048576",
      );
    }
    const mounts = new Map<string, { source: string; writable: boolean }>();
    for (const path of readPaths) {
      const resolved = await this.resolveCapabilityPath(mountedWorkspace, path);
      mounts.set(resolved.destination, {
        source: resolved.source,
        writable: false,
      });
    }
    for (const path of writePaths) {
      const resolved = await this.resolveCapabilityPath(mountedWorkspace, path);
      mounts.set(resolved.destination, {
        source: resolved.source,
        writable: true,
      });
    }
    for (const [destination, mount] of mounts) {
      args.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${destination}${
          mount.writable ? "" : ",readonly"
        }`,
      );
    }
    return args;
  }

  private async resolveCapabilityPath(
    workspace: string,
    declaredPath: string,
  ): Promise<{ source: string; destination: string }> {
    const segments = declaredPath.replaceAll("\\", "/").split("/").filter(Boolean);
    if (
      isAbsolute(declaredPath) ||
      segments.length === 0 ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`OCI capability path must be a contained relative path: ${declaredPath}`);
    }
    if (segments.some((segment) => segment.toLowerCase() === ".git")) {
      throw new Error("OCI capability paths cannot expose Git metadata");
    }
    const source = await realpath(join(workspace, ...segments));
    if (!isContained(workspace, source)) {
      throw new Error(`OCI capability path escapes the task worktree: ${declaredPath}`);
    }
    assertDockerMountPath(source);
    return {
      source,
      destination: `/workspace/${segments.join("/")}`,
    };
  }

  private async visibleRunArtifactMounts(
    runRoot: string,
    visibleInputPaths: readonly string[],
  ): Promise<string[]> {
    // The tmpfs stays writable so the engine can create each artifact's
    // mountpoint under it: a read-only tmpfs rejects that mkdir and the
    // container never starts. Nothing durable is reachable through it — the
    // artifacts themselves are bound read-only, and the tmpfs is a small
    // per-container memory scratch that is discarded with the workload.
    const args = [
      "--tmpfs",
      "/nitely/run:nosuid,nodev,noexec,size=1048576",
    ];
    const mounted = new Set<string>();
    for (const inputPath of visibleInputPaths) {
      let source: string;
      try {
        source = await realpath(inputPath);
      } catch {
        throw new Error(
          `OCI required stage artifact cannot be mounted: ${inputPath}`,
        );
      }
      if (!isContained(runRoot, source)) {
        throw new Error(
          `OCI stage artifact escapes the task run directory: ${inputPath}`,
        );
      }
      let relativePath = relative(runRoot, source);
      if (
        relativePath.length === 0 ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error(
          `OCI stage artifact must be a relative run path: ${inputPath}`,
        );
      }
      if (
        relativePath.startsWith(`inputs${sep}`) &&
        relativePath.endsWith(`${sep}content`)
      ) {
        source = dirname(source);
        relativePath = dirname(relativePath);
      }
      if (mounted.has(relativePath)) continue;
      mounted.add(relativePath);
      assertDockerMountPath(source);
      args.push(
        "--mount",
        `type=bind,src=${source},dst=/nitely/run/${relativePath},readonly`,
      );
    }
    return args;
  }

  private runtimeSecretNames(runtime: {
    id: string;
    requiredEnv?: string[][];
  }): string[] {
    const requiredNames = new Set((runtime.requiredEnv ?? []).flat());
    // Codex can authenticate through CODEX_HOME, but OPENAI_API_KEY remains
    // its supported environment credential when one is explicitly allowlisted.
    if (requiredNames.size === 0 && runtime.id === "codex") {
      requiredNames.add("OPENAI_API_KEY");
    }
    return this.secretAllowlist.filter((name) => requiredNames.has(name));
  }

  private runtimeEnvironment(secretNames: readonly string[] = this.secretAllowlist): Record<string, string> {
    return Object.fromEntries(
      [...this.environmentAllowlist, ...secretNames].flatMap((name) => {
        const value = this.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
  }

  redactionSecrets(): readonly string[] {
    return this.secretAllowlist.flatMap((name) => {
      const value = this.env[name];
      return value === undefined || value.length === 0 ? [] : [value];
    });
  }

  async prepareAgentPrompt(input: {
    workspace: WorkspaceHandle;
    attemptDirectory: string;
    prompt: string;
  }): Promise<string> {
    const { workspace: ws, attemptDirectory, prompt } = input;
    if (!ws.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const workspace = await realpath(ws.path);
    const runRoot = await realpath(dirname(workspace));
    const output = await realpath(attemptDirectory);
    return prompt
      .replaceAll(output, "/nitely/output")
      .replaceAll(workspace, "/workspace")
      .replaceAll(runRoot, "/nitely/run");
  }

  async preflightAgentRuntime(
    ws: WorkspaceHandle,
    input: {
      stage: AgentRunnableStage;
      attemptDirectory: string;
    },
  ): Promise<AgentRuntimePreflightResult> {
    if (!ws.path) {
      return {
        available: false,
        reason: "OCI execution backend requires a host worktree path",
      };
    }
    const runtimeId = input.stage.runtime;
    if (!runtimeId) {
      return {
        available: false,
        reason: `agent runtime for stage ${input.stage.id} is not configured`,
      };
    }
    let runtime;
    try {
      runtime = this.runtimeRegistry.resolve(runtimeId);
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const { policy } = effectiveCapabilityPolicy(input.stage);
    const mediation = this.resolveCommandMediation(policy);
    if (mediation.status === "unenforceable") {
      return { available: false, reason: mediation.reason };
    }
    let gateway: NetworkAllowlistGateway | undefined;
    let internalNetwork: InternalNetwork | undefined;
    try {
      const networkDecision = this.resolveAgentNetworkDecision({
        stage: input.stage,
        runtime,
      });
      if (networkDecision.mode === "allowlist") {
        if (!this.networkGatewayFactory) {
          await this.verifyRootlessEngine();
          internalNetwork = await this.createInternalNetwork();
        }
        gateway = this.createGateway(networkDecision.domains, internalNetwork);
        await gateway.assertEnforceable();
      }
      await this.capabilityWorkspaceMounts(ws, policy);
      await this.verifyRootlessEngine();
      const runtimeEnv = this.runtimeEnvironment(this.runtimeSecretNames(runtime));
      const missing = (runtime.requiredEnv ?? []).filter(
        (alternatives) =>
          !alternatives.some((name) => Boolean(runtimeEnv[name])),
      );
      if (missing.length === 0) {
        return { available: true };
      }
      return {
        available: false,
        reason: `agent runtime ${runtime.id} is not configured in the OCI environment allowlists. Allow ${missing
          .map((alternatives) => alternatives.join(" or "))
          .join("; ")}.`,
        missingConfig: missing.flat(),
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await gateway?.dispose().catch(() => undefined);
      if (internalNetwork) {
        await this.removeInternalNetwork(internalNetwork.name);
      }
    }
  }

  async commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }> {
    if (!ws.path) {
      throw new Error("OCI execution backend requires a host worktree path");
    }
    const trusted = this.trustedWorkspaceGit.get(ws.runId);
    const workspacePath = await realpath(ws.path);
    if (!trusted || trusted.workspacePath !== workspacePath) {
      throw new Error("OCI workspace Git metadata changed or is untrusted");
    }
    const gitPath = join(workspacePath, ".git");
    const gitEntry = await lstat(gitPath).catch(() => undefined);
    if (!gitEntry?.isFile() || gitEntry.isSymbolicLink()) {
      throw new Error("OCI workspace has unsafe Git metadata");
    }
    const currentGitFile = await readFile(gitPath);
    if (!currentGitFile.equals(trusted.gitFile)) {
      throw new Error("OCI workspace Git metadata changed after sandbox execution");
    }
    return await this.localGit.commitAll(ws, message);
  }
}
