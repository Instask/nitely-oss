import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { redactUnknown } from "../context/redaction.js";
import type { ArtifactRegistry, RunArtifact } from "./types.js";

function artifactKey(artifact: RunArtifact): string {
  return `${artifact.producer}\0${artifact.id}`;
}

export function mergeArtifacts(artifacts: RunArtifact[]): RunArtifact[] {
  const indexes = new Map<string, number>();
  const merged: RunArtifact[] = [];
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, merged.length);
      merged.push(artifact);
      continue;
    }
    merged[existing] = { ...merged[existing], ...artifact };
  }
  return merged;
}

export function redactRunArtifact(
  artifact: RunArtifact,
  redactionSecrets: Iterable<string> = [],
): RunArtifact {
  return redactUnknown(artifact, redactionSecrets) as RunArtifact;
}

export async function writeArtifactRegistry(input: {
  runDirectory: string;
  runId: string;
  artifacts: RunArtifact[];
  redactionSecrets: Iterable<string>;
}): Promise<void> {
  await mkdir(input.runDirectory, { recursive: true });
  const registry: ArtifactRegistry = {
    runId: input.runId,
    artifacts: mergeArtifacts(input.artifacts).map((artifact) =>
      redactRunArtifact(artifact, input.redactionSecrets),
    ),
  };
  await writeFile(
    resolve(input.runDirectory, "artifacts.json"),
    JSON.stringify(registry, null, 2),
    "utf8",
  );
}

export async function readArtifactRegistry(input: {
  runDirectory: string;
}): Promise<ArtifactRegistry | undefined> {
  try {
    const content = await readFile(
      resolve(input.runDirectory, "artifacts.json"),
      "utf8",
    );
    const parsed = JSON.parse(content) as ArtifactRegistry;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : "",
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
