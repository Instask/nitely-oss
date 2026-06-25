import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { redactUnknown } from "./redaction.js";

export interface ContextManifestEntry {
  id: string;
  kind: "external-input" | "generated-artifact" | "connector-context";
  connector: string;
  sourceUri: string;
  mediaType?: string;
  revision?: string;
  filename?: string;
  runRelativePath?: string;
  policy: {
    decision: "allowed" | "excluded" | "warned";
    reason?: string;
    matchedPattern?: string;
  };
}

export interface ContextManifest {
  version: 1;
  runId: string;
  generatedAt: string;
  entries: ContextManifestEntry[];
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function runRelativePath(
  runDirectory: string,
  candidate: string,
): string | undefined {
  const resolvedRunDirectory = resolve(runDirectory);
  const resolvedCandidate = resolve(candidate);
  if (!isPathInside(resolvedRunDirectory, resolvedCandidate)) return undefined;
  return relative(resolvedRunDirectory, resolvedCandidate).replaceAll("\\", "/");
}

export function redactContextManifestEntry(
  entry: ContextManifestEntry,
  extraSecrets: Iterable<string> = [],
): ContextManifestEntry {
  return redactUnknown(entry, extraSecrets) as ContextManifestEntry;
}

export async function writeContextManifest(input: {
  runDirectory: string;
  runId: string;
  entries: ContextManifestEntry[];
  redactionSecrets?: Iterable<string>;
}): Promise<string> {
  await mkdir(input.runDirectory, { recursive: true });
  const path = resolve(input.runDirectory, "context-manifest.json");
  const manifest: ContextManifest = {
    version: 1,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    entries: input.entries.map((entry) =>
      redactContextManifestEntry(entry, input.redactionSecrets),
    ),
  };
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
  return path;
}
