import type { ExecutionBackendDescription } from "./types.js";

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function formatExecutionBackendEvidence(
  description: ExecutionBackendDescription,
): string {
  return [
    `Backend: ${description.backend}`,
    `Engine: ${description.engine}`,
    `Image: ${description.image ?? "none"}`,
    ...(description.imageReference
      ? [`Image reference: ${description.imageReference}`]
      : []),
    ...(description.imageIdentity
      ? [`Image identity: ${description.imageIdentity}`]
      : []),
    `Policy version: ${description.policyVersion}`,
    `Isolation: ${description.isolation}`,
    `Identity: ${description.identity.uid}:${description.identity.gid} (${description.identity.strategy})`,
    `Network: ${description.network}`,
    `Mounts: ${list(description.mounts)}`,
    `Environment names: ${list(description.environment.allowedNames)}`,
    `Secret names: ${list(description.environment.secretNames)} (values omitted)`,
    `Command mediation: ${description.commands.mediation}${
      description.commands.mechanism ? ` (${description.commands.mechanism})` : ""
    }`,
    `CPU: ${description.resources.cpus}`,
    `Memory bytes: ${description.resources.memoryBytes}`,
    `PID limit: ${description.resources.pids}`,
    `Tmpfs bytes: ${description.resources.tmpfsBytes}`,
    `Maximum file bytes: ${description.resources.maxFileBytes}`,
    `Maximum captured output bytes: ${description.resources.maxCapturedOutputBytes}`,
    `Default timeout ms: ${description.resources.timeoutMs}`,
    `Cleanup: ${description.cleanup}`,
    ...(description.lifecycle
      ? [
          `Container lifecycle: managed; expiry=${description.lifecycle.expiry}; cleanup grace ms=${description.lifecycle.cleanupGraceMs}; labels=${list(description.lifecycle.labelKeys)}`,
        ]
      : []),
    `Limitations: ${list(description.limitations)}`,
  ].join("\n");
}
