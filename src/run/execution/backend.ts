import { createHash } from "node:crypto";

import { LocalExecutionBackend, type RuntimeEnv } from "./local.js";
import { MiseExecutionBackend } from "./mise.js";
import { parseNetworkAllowlist } from "./network-gateway.js";
import { OciExecutionBackend, type OciReadinessIssue } from "./oci.js";
import type { ExecutionBackend } from "./types.js";

export type ExecutionBackendName = "local" | "mise" | "oci";

export interface CreateExecutionBackendInput {
  backend?: string;
  env?: RuntimeEnv;
  imageIdentity?: string;
}

function commaSeparatedNames(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
}

function positiveNumber(
  env: RuntimeEnv,
  name: string,
  options: { integer?: boolean } = {},
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (options.integer === true && !Number.isInteger(value))
  ) {
    throw new Error(`${name} must be a positive${options.integer ? " integer" : " number"}`);
  }
  return value;
}

function nonNegativeInteger(
  env: RuntimeEnv,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function booleanFlag(env: RuntimeEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new Error(`${name} must be true or false`);
}

function ociResources(env: RuntimeEnv) {
  const values = {
    cpus: positiveNumber(env, "NITELY_OCI_CPUS"),
    memoryBytes: positiveNumber(env, "NITELY_OCI_MEMORY_BYTES", { integer: true }),
    pids: positiveNumber(env, "NITELY_OCI_PIDS", { integer: true }),
    tmpfsBytes: positiveNumber(env, "NITELY_OCI_TMPFS_BYTES", { integer: true }),
    maxFileBytes: positiveNumber(env, "NITELY_OCI_MAX_FILE_BYTES", { integer: true }),
    maxCapturedOutputBytes: positiveNumber(
      env,
      "NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES",
      { integer: true },
    ),
    timeoutMs: positiveNumber(env, "NITELY_OCI_TIMEOUT_MS", { integer: true }),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

export function normalizeExecutionBackendName(
  value: string | undefined,
): ExecutionBackendName {
  const backend = (value ?? "local").trim().toLowerCase();
  if (backend === "" || backend === "local") {
    return "local";
  }
  if (backend === "mise") {
    return "mise";
  }
  if (backend === "oci" || backend === "docker") {
    return "oci";
  }
  throw new Error(
    `unsupported execution backend: ${value}. Supported backends: local, mise, oci`,
  );
}

export function createExecutionBackend(
  input: CreateExecutionBackendInput = {},
): ExecutionBackend {
  const backend = normalizeExecutionBackendName(input.backend);
  if (backend === "mise") {
    return new MiseExecutionBackend({
      env: input.env,
      miseCommand: input.env?.NITELY_MISE_COMMAND,
    });
  }
  if (backend === "oci") {
    const env = input.env ?? process.env;
    if (env.NITELY_OCI_DISK_BYTES?.trim()) {
      throw new Error(
        "OCI aggregate bind-mount disk quota is not supported and will not be; configure NITELY_OCI_MAX_FILE_BYTES and NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES",
      );
    }
    return new OciExecutionBackend({
      image: env.NITELY_OCI_IMAGE ?? "",
      ...(input.imageIdentity ? { imageIdentity: input.imageIdentity } : {}),
      env,
      engineCommand: env.NITELY_OCI_ENGINE_COMMAND,
      environmentAllowlist: commaSeparatedNames(
        env.NITELY_OCI_ENV_ALLOWLIST,
      ),
      secretAllowlist: commaSeparatedNames(env.NITELY_OCI_SECRET_ALLOWLIST),
      networkAllowlist: [
        ...parseNetworkAllowlist(env.NITELY_OCI_NETWORK_ALLOWLIST),
      ],
      resources: ociResources(env),
      tmpfsExec: booleanFlag(env, "NITELY_OCI_TMPFS_EXEC"),
      uid: nonNegativeInteger(env, "NITELY_OCI_UID"),
      gid: nonNegativeInteger(env, "NITELY_OCI_GID"),
    });
  }
  return new LocalExecutionBackend({ env: input.env });
}

const OCI_READINESS_TTL_MS = 30_000;
const ociReadinessCache = new Map<string, { expiresAt: number; issues: Promise<OciReadinessIssue[]> }>();

/** Drops cached probe results, for callers that just changed the engine or image. */
export function clearOciReadinessCache(): void {
  ociReadinessCache.clear();
}

/**
 * Probes launch containers, so identical environment and stage inputs share
 * one in-flight probe and reuse its result briefly. The key is a digest
 * because the environment can carry credentials.
 */
export async function checkOciReadiness(input: {
  env?: RuntimeEnv;
  stages?: import("./types.js").AgentRunnableStage[];
} = {}): Promise<OciReadinessIssue[]> {
  const env = input.env ?? process.env;
  if (!env.NITELY_OCI_IMAGE?.trim()) {
    return [{ code: "oci.image.missing", message: "NITELY_OCI_IMAGE is required for the OCI execution backend" }];
  }
  const now = Date.now();
  for (const [key, entry] of ociReadinessCache) {
    if (entry.expiresAt <= now) ociReadinessCache.delete(key);
  }
  const key = createHash("sha256").update(JSON.stringify([
    Object.entries(env).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)),
    input.stages ?? null,
  ])).digest("hex");
  const cached = ociReadinessCache.get(key);
  if (cached) return await cached.issues;
  const issues = probeOciReadiness(env, input.stages);
  ociReadinessCache.set(key, { expiresAt: now + OCI_READINESS_TTL_MS, issues });
  return await issues;
}

async function probeOciReadiness(
  env: RuntimeEnv,
  stages: import("./types.js").AgentRunnableStage[] | undefined,
): Promise<OciReadinessIssue[]> {
  try {
    const backend = createExecutionBackend({ backend: "oci", env }) as OciExecutionBackend;
    if (!stages?.length) return await backend.checkReadiness();
    const issues: OciReadinessIssue[] = [];
    const groups = new Map<string, import("./types.js").AgentRunnableStage[]>();
    for (const stage of stages) groups.set(stage.id, [...(groups.get(stage.id) ?? []), stage]);
    for (const group of groups.values()) {
      const failures: OciReadinessIssue[] = [];
      let available = false;
      for (const stage of group) {
        const result = await backend.checkReadiness(stage);
        if (result.length === 0) { available = true; break; }
        failures.push(...result);
      }
      if (!available) issues.push(...failures);
    }
    return issues;
  } catch (error) {
    return [{ code: "oci.configuration.invalid", message: error instanceof Error ? error.message : String(error) }];
  }
}
