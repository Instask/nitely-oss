import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { ArtifactContract } from "../artifacts/types.js";
import { runRelativePath } from "../context/manifest.js";

export interface AttemptOutputManifest {
  version: 1;
  stageId: string;
  attempt: number;
  outputs: AttemptOutputEntry[];
}

export interface AttemptOutputEntry {
  id: string;
  path: string;
  mediaType?: string;
  filename?: string;
}

export interface ValidatedAttemptOutput {
  id: string;
  absolutePath: string;
  runRelativePath?: string;
  attemptRelativePath: string;
  mediaType: string;
  filename: string;
  manifestSource: "declared-manifest" | "discovered";
}

export interface ValidateAttemptOutputsResult {
  manifestPath: string;
  manifestRunRelativePath?: string;
  outputPath: string;
  outputRunRelativePath?: string;
  outputs: ValidatedAttemptOutput[];
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function requireAttemptPath(input: {
  attemptDirectory: string;
  path: string;
  outputId: string;
}): Promise<string> {
  if (isAbsolute(input.path)) {
    throw new Error(
      `output ${input.outputId} path escapes attempt directory: ${input.path}`,
    );
  }
  const resolvedAttemptDirectory = resolve(input.attemptDirectory);
  const resolvedPath = resolve(resolvedAttemptDirectory, input.path);
  if (!isPathInside(resolvedAttemptDirectory, resolvedPath)) {
    throw new Error(
      `output ${input.outputId} path escapes attempt directory: ${input.path}`,
    );
  }
  let realAttemptDirectory: string;
  let realPath: string;
  try {
    realAttemptDirectory = await realpath(resolvedAttemptDirectory);
    realPath = await realpath(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`missing required output ${input.outputId}: ${input.path}`);
    }
    throw error;
  }
  if (!isPathInside(realAttemptDirectory, realPath)) {
    throw new Error(
      `output ${input.outputId} path escapes attempt directory: ${input.path}`,
    );
  }
  return realPath;
}

function attemptRelativePath(attemptDirectory: string, path: string): string {
  return relative(resolve(attemptDirectory), resolve(path)).replaceAll("\\", "/");
}

function inferMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function readManifestValue(value: unknown): AttemptOutputManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("artifact.json must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("artifact.json version must be 1");
  }
  if (typeof record.stageId !== "string") {
    throw new Error("artifact.json stageId must be a string");
  }
  if (typeof record.attempt !== "number" || !Number.isInteger(record.attempt)) {
    throw new Error("artifact.json attempt must be an integer");
  }
  if (!Array.isArray(record.outputs)) {
    throw new Error("artifact.json outputs must be an array");
  }
  const outputs = record.outputs.map((entry, index): AttemptOutputEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`artifact.json outputs[${index}] must be an object`);
    }
    const output = entry as Record<string, unknown>;
    if (typeof output.id !== "string" || output.id.length === 0) {
      throw new Error(`artifact.json outputs[${index}].id must be a string`);
    }
    if (typeof output.path !== "string" || output.path.length === 0) {
      throw new Error(`artifact.json outputs[${index}].path must be a string`);
    }
    if (output.mediaType !== undefined && typeof output.mediaType !== "string") {
      throw new Error(`artifact.json outputs[${index}].mediaType must be a string`);
    }
    if (output.filename !== undefined && typeof output.filename !== "string") {
      throw new Error(`artifact.json outputs[${index}].filename must be a string`);
    }
    return {
      id: output.id,
      path: output.path,
      mediaType: output.mediaType,
      filename: output.filename,
    };
  });
  return {
    version: 1,
    stageId: record.stageId,
    attempt: record.attempt,
    outputs,
  };
}

async function readManifest(path: string): Promise<AttemptOutputManifest | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return readManifestValue(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`artifact.json is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function discoverManifest(input: {
  stageId: string;
  attempt: number;
  attemptDirectory: string;
  outputs: ArtifactContract[];
}): Promise<AttemptOutputManifest> {
  const entries: AttemptOutputEntry[] = [];
  for (const output of input.outputs) {
    const candidates = [
      { path: `${output.id}.md`, mediaType: "text/markdown" },
      { path: `${output.id}.txt`, mediaType: "text/plain" },
    ];
    let found: AttemptOutputEntry | undefined;
    for (const candidate of candidates) {
      if (await pathExists(join(input.attemptDirectory, candidate.path))) {
        found = {
          id: output.id,
          path: candidate.path,
          mediaType: candidate.mediaType,
        };
        break;
      }
    }
    if (found) {
      entries.push(found);
    }
  }
  return {
    version: 1,
    stageId: input.stageId,
    attempt: input.attempt,
    outputs: entries,
  };
}

async function validateEntry(input: {
  runDirectory: string;
  attemptDirectory: string;
  entry: AttemptOutputEntry;
  manifestSource: ValidatedAttemptOutput["manifestSource"];
}): Promise<ValidatedAttemptOutput> {
  const absolutePath = await requireAttemptPath({
    attemptDirectory: input.attemptDirectory,
    path: input.entry.path,
    outputId: input.entry.id,
  });
  const content = await readFile(absolutePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`missing required output ${input.entry.id}: ${input.entry.path}`);
    }
    throw error;
  });
  if (content.trim().length === 0) {
    throw new Error(`output ${input.entry.id} is empty: ${input.entry.path}`);
  }
  const relativePath = attemptRelativePath(input.attemptDirectory, absolutePath);
  return {
    id: input.entry.id,
    absolutePath,
    runRelativePath: runRelativePath(input.runDirectory, absolutePath),
    attemptRelativePath: relativePath,
    mediaType: input.entry.mediaType ?? inferMediaType(input.entry.path),
    filename: input.entry.filename ?? basename(input.entry.path),
    manifestSource: input.manifestSource,
  };
}

async function writeOutputSummary(input: {
  path: string;
  stageId: string;
  attempt: number;
  outputs: ValidatedAttemptOutput[];
}): Promise<void> {
  if (await pathExists(input.path)) return;
  await writeFile(
    input.path,
    [
      "# Agent Attempt",
      "",
      `Stage: ${input.stageId}`,
      `Attempt: ${input.attempt}`,
      "",
      "## Outputs",
      "",
      ...input.outputs.map(
        (output) =>
          `- ${output.id}: ${output.attemptRelativePath} (${output.mediaType})`,
      ),
      "",
      "## Logs",
      "",
      "- stdout: stdout.log",
      "- stderr: stderr.log",
      "- manifest: artifact.json",
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function validateAttemptOutputs(input: {
  runDirectory: string;
  attemptDirectory: string;
  stageId: string;
  attempt: number;
  outputs: ArtifactContract[];
}): Promise<ValidateAttemptOutputsResult> {
  const resolvedRunDirectory = resolve(input.runDirectory);
  const resolvedAttemptDirectory = resolve(input.attemptDirectory);
  if (!isPathInside(resolvedRunDirectory, resolvedAttemptDirectory)) {
    throw new Error(
      `attempt directory escapes run directory: ${input.attemptDirectory}`,
    );
  }
  const manifestPath = join(resolvedAttemptDirectory, "artifact.json");
  const explicitManifest = await readManifest(manifestPath);
  const manifest =
    explicitManifest ??
    (await discoverManifest({
      stageId: input.stageId,
      attempt: input.attempt,
      attemptDirectory: resolvedAttemptDirectory,
      outputs: input.outputs,
    }));
  const manifestSource: ValidatedAttemptOutput["manifestSource"] = explicitManifest
    ? "declared-manifest"
    : "discovered";

  if (manifest.stageId !== input.stageId) {
    throw new Error(
      `artifact.json stageId ${manifest.stageId} does not match ${input.stageId}`,
    );
  }
  if (manifest.attempt !== input.attempt) {
    throw new Error(
      `artifact.json attempt ${manifest.attempt} does not match ${input.attempt}`,
    );
  }

  const declaredIds = new Set(input.outputs.map((output) => output.id));
  const seenIds = new Set<string>();
  for (const entry of manifest.outputs) {
    if (!declaredIds.has(entry.id)) {
      throw new Error(`artifact.json contains undeclared output id ${entry.id}`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`artifact.json contains duplicate output id ${entry.id}`);
    }
    seenIds.add(entry.id);
  }
  for (const output of input.outputs) {
    if (!seenIds.has(output.id)) {
      throw new Error(`missing required output ${output.id}`);
    }
  }

  const validated: ValidatedAttemptOutput[] = [];
  for (const output of input.outputs) {
    const entry = manifest.outputs.find((candidate) => candidate.id === output.id);
    if (!entry) {
      throw new Error(`missing required output ${output.id}`);
    }
    validated.push(
      await validateEntry({
        runDirectory: resolvedRunDirectory,
        attemptDirectory: resolvedAttemptDirectory,
        entry,
        manifestSource,
      }),
    );
  }

  const normalizedManifest: AttemptOutputManifest = {
    version: 1,
    stageId: input.stageId,
    attempt: input.attempt,
    outputs: validated.map((output) => ({
      id: output.id,
      path: output.attemptRelativePath,
      mediaType: output.mediaType,
    })),
  };
  if (!explicitManifest) {
    await writeFile(
      manifestPath,
      `${JSON.stringify(normalizedManifest, null, 2)}\n`,
      "utf8",
    );
  }

  const outputPath = join(resolvedAttemptDirectory, "output.md");
  await writeOutputSummary({
    path: outputPath,
    stageId: input.stageId,
    attempt: input.attempt,
    outputs: validated,
  });

  return {
    manifestPath,
    manifestRunRelativePath: runRelativePath(resolvedRunDirectory, manifestPath),
    outputPath,
    outputRunRelativePath: runRelativePath(resolvedRunDirectory, outputPath),
    outputs: validated,
  };
}
