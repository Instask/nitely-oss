import { lstat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { ArtifactContract } from "../artifacts/types.js";
import { validateAgainstSchema } from "../artifacts/validate.js";
import { runRelativePath } from "../context/manifest.js";
import {
  readRunOwnedFile,
  writeRunOwnedFileAtomically,
} from "./owned-file.js";

export interface AttemptOutputManifest {
  version: 1;
  stageId: string;
  attempt: number;
  outputs: AttemptOutputEntry[];
}

/**
 * An `artifact.json` exactly as an agent wrote it. `stageId` and `attempt` are
 * optional here; {@link validateAttemptOutputs} fills them from the runner.
 */
export interface DeclaredAttemptOutputManifest {
  version: 1;
  stageId?: string;
  attempt?: number;
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
  content: Buffer;
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
    !(
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    )
  );
}

function requireAttemptPath(input: {
  attemptDirectory: string;
  path: string;
  outputId: string;
}): string {
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
  return resolvedPath;
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

function readManifestValue(value: unknown): DeclaredAttemptOutputManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("artifact.json must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("artifact.json version must be 1");
  }
  // stageId and attempt are advisory. The runner owns both values because it
  // created <run>/stages/<stage-id>/<attempt>, so an agent that omits or
  // mistypes them must not lose an otherwise complete attempt.
  if (record.stageId !== undefined && typeof record.stageId !== "string") {
    throw new Error("artifact.json stageId must be a string");
  }
  if (
    record.attempt !== undefined &&
    (typeof record.attempt !== "number" || !Number.isInteger(record.attempt))
  ) {
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
    ...(record.stageId !== undefined ? { stageId: record.stageId } : {}),
    ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
    outputs,
  };
}

async function readManifest(input: {
  runDirectory: string;
  path: string;
}): Promise<DeclaredAttemptOutputManifest | undefined> {
  let content: Buffer;
  try {
    ({ content } = await readRunOwnedFile({
      runDirectory: input.runDirectory,
      path: input.path,
      subject: "attempt output manifest path",
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return readManifestValue(JSON.parse(content.toString("utf8")));
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

interface PhysicalFileIdentity {
  dev: number;
  ino: number;
}

async function physicalFileIdentity(
  path: string,
): Promise<PhysicalFileIdentity | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    return {
      dev: metadata.dev,
      ino: metadata.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function referencesReservedOutputSummary(input: {
  attemptDirectory: string;
  manifest: DeclaredAttemptOutputManifest;
}): Promise<boolean> {
  const reservedPath = resolve(input.attemptDirectory, "output.md");
  const reservedIdentity = await physicalFileIdentity(reservedPath);
  for (const output of input.manifest.outputs) {
    const candidatePath = requireAttemptPath({
      attemptDirectory: input.attemptDirectory,
      path: output.path,
      outputId: output.id,
    });
    if (candidatePath === reservedPath) return true;
    if (!reservedIdentity) continue;
    const candidateIdentity = await physicalFileIdentity(candidatePath);
    if (!candidateIdentity) continue;
    if (
      candidateIdentity.ino !== 0 &&
      candidateIdentity.dev === reservedIdentity.dev &&
      candidateIdentity.ino === reservedIdentity.ino
    ) {
      return true;
    }
  }
  return false;
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
      { path: `${output.id}.json`, mediaType: "application/json" },
    ];
    let found: AttemptOutputEntry | undefined;
    for (const candidate of candidates) {
      if (candidate.path === "output.md") continue;
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
  const absolutePath = requireAttemptPath({
    attemptDirectory: input.attemptDirectory,
    path: input.entry.path,
    outputId: input.entry.id,
  });
  const materialized = await readRunOwnedFile({
    runDirectory: input.runDirectory,
    path: absolutePath,
    subject: `output ${input.entry.id} path`,
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`missing required output ${input.entry.id}: ${input.entry.path}`);
    }
    throw error;
  });
  const content = materialized.content;
  if (content.toString("utf8").trim().length === 0) {
    throw new Error(`output ${input.entry.id} is empty: ${input.entry.path}`);
  }
  const relativePath = attemptRelativePath(input.attemptDirectory, absolutePath);
  return {
    id: input.entry.id,
    absolutePath,
    runRelativePath: materialized.relativePath,
    attemptRelativePath: relativePath,
    content,
    mediaType: input.entry.mediaType ?? inferMediaType(input.entry.path),
    filename: input.entry.filename ?? basename(input.entry.path),
    manifestSource: input.manifestSource,
  };
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function validateOutputContracts(input: {
  contracts: ArtifactContract[];
  outputs: ValidatedAttemptOutput[];
}): void {
  const contracts = new Map(
    input.contracts.map((contract) => [contract.id, contract] as const),
  );
  for (const output of input.outputs) {
    const contract = contracts.get(output.id);
    if (!contract) continue;
    if (
      contract.mediaType !== undefined &&
      output.mediaType !== contract.mediaType
    ) {
      throw new Error(
        `output ${output.id} media type ${output.mediaType} does not match ${contract.mediaType}`,
      );
    }
    if (!isJsonMediaType(output.mediaType) && contract.schema === undefined) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.content.toString("utf8"));
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`output ${output.id} is not valid JSON${detail}`);
    }
    if (contract.schema === undefined) continue;
    const result = validateAgainstSchema(contract.schema, parsed);
    if (!result.valid) {
      throw new Error(
        `output ${output.id} failed schema validation: ${result.errors.join("; ")}`,
      );
    }
  }
}

async function requireDistinctPhysicalOutputs(
  outputs: ValidatedAttemptOutput[],
): Promise<void> {
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const output of outputs) {
    const canonicalPath = resolve(output.absolutePath);
    const metadata = await lstat(canonicalPath);
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (paths.has(canonicalPath) || identities.has(identity)) {
      throw new Error(
        `output ${output.id} must use a distinct physical file`,
      );
    }
    paths.add(canonicalPath);
    identities.add(identity);
  }
}

async function writeOutputSummary(input: {
  runDirectory: string;
  path: string;
  stageId: string;
  attempt: number;
  outputs: ValidatedAttemptOutput[];
}): Promise<void> {
  try {
    await readRunOwnedFile({
      runDirectory: input.runDirectory,
      path: input.path,
      subject: "attempt output summary path",
      maximumBytes: 256 * 1024,
    });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeRunOwnedFileAtomically({
    runDirectory: input.runDirectory,
    path: input.path,
    subject: "attempt output summary path",
    content: [
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
  });
}

export async function validateAttemptOutputs(input: {
  runDirectory: string;
  attemptDirectory: string;
  stageId: string;
  attempt: number;
  outputs: ArtifactContract[];
  validateContracts?: boolean;
  allowMarkdownFallback?: boolean;
}): Promise<ValidateAttemptOutputsResult> {
  const resolvedRunDirectory = resolve(input.runDirectory);
  const resolvedAttemptDirectory = resolve(input.attemptDirectory);
  if (!isPathInside(resolvedRunDirectory, resolvedAttemptDirectory)) {
    throw new Error(
      `attempt directory escapes run directory: ${input.attemptDirectory}`,
    );
  }
  const manifestPath = join(resolvedAttemptDirectory, "artifact.json");
  const explicitManifest = await readManifest({
    runDirectory: resolvedRunDirectory,
    path: manifestPath,
  });
  if (
    explicitManifest &&
    (await referencesReservedOutputSummary({
      attemptDirectory: resolvedAttemptDirectory,
      manifest: explicitManifest,
    }))
  ) {
    throw new Error(
      "explicit artifact.json cannot reference reserved output.md",
    );
  }
  let manifest: DeclaredAttemptOutputManifest =
    explicitManifest ??
    (await discoverManifest({
      stageId: input.stageId,
      attempt: input.attempt,
      attemptDirectory: resolvedAttemptDirectory,
      outputs: input.outputs,
    }));
  if (
    !explicitManifest &&
    manifest.outputs.length === 0 &&
    input.allowMarkdownFallback &&
    input.outputs.length === 1 &&
    input.outputs[0]?.mediaType === "text/markdown" &&
    input.outputs[0]?.schema === undefined &&
    (await pathExists(join(resolvedAttemptDirectory, "output.md")))
  ) {
    manifest = {
      version: 1,
      stageId: input.stageId,
      attempt: input.attempt,
      outputs: [
        {
          id: input.outputs[0].id,
          path: "output.md",
          mediaType: "text/markdown",
        },
      ],
    };
  }
  const manifestSource: ValidatedAttemptOutput["manifestSource"] = explicitManifest
    ? "declared-manifest"
    : "discovered";

  // The runner owns stageId and attempt. A manifest that omits or contradicts
  // them is normalized rather than failing an attempt whose output files exist.

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

  await requireDistinctPhysicalOutputs(validated);

  if (input.validateContracts) {
    validateOutputContracts({ contracts: input.outputs, outputs: validated });
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
    await writeRunOwnedFileAtomically({
      runDirectory: resolvedRunDirectory,
      path: manifestPath,
      subject: "attempt output manifest path",
      content: `${JSON.stringify(normalizedManifest, null, 2)}\n`,
    });
  }

  const outputPath = join(resolvedAttemptDirectory, "output.md");
  await writeOutputSummary({
    runDirectory: resolvedRunDirectory,
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
