import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { summarizeCommandMediationLog } from "./command-mediation.js";
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

const MAX_MEDIATION_LOG_BYTES = 256 * 1024;

/**
 * Read mediator logs the attempt directories already contain. Only the
 * stage/attempt layout is walked, and each log is reduced to basenames,
 * rule names, and counts.
 */
export async function collectCommandMediationEvidence(
  runDirectory: string,
): Promise<string> {
  let stageNames: string[];
  try {
    stageNames = await readdir(join(runDirectory, "stages"));
  } catch {
    return "";
  }
  const blocks: string[] = [];
  for (const stage of stageNames.sort()) {
    let attempts: string[];
    try {
      attempts = await readdir(join(runDirectory, "stages", stage));
    } catch {
      continue;
    }
    for (const attempt of attempts.sort()) {
      let text: string;
      try {
        const buffer = await readFile(
          join(runDirectory, "stages", stage, attempt, "command-mediation.jsonl"),
        );
        text = buffer.subarray(0, MAX_MEDIATION_LOG_BYTES).toString("utf8");
      } catch {
        continue;
      }
      const summary = summarizeCommandMediationLog(text);
      if (summary.length === 0) continue;
      blocks.push([`Stage ${stage} attempt ${attempt}:`, ...summary].join("\n"));
    }
  }
  return blocks.join("\n");
}
