import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { RunArtifact } from "../artifacts/types.js";
import { redactUnknown } from "../context/redaction.js";
import { copyRunOwnedFile } from "../run/owned-file.js";
import {
  listEvidenceRuns,
  readReconciledRawRunArtifacts,
  type EvidenceArtifactMetadata,
  type EvidenceRunRecord,
} from "./catalog.js";

const RAW_FILENAMES = new Set([
  "artifacts.json",
  "evidence.md",
  "output.md",
  "prompt.md",
  "prompt.txt",
  "recovery.json",
  "recovery.patch",
  "stderr.log",
  "stdout.log",
]);

const RAW_EXCLUDED_DIRECTORIES = new Set(["inputs", "worktree"]);

export interface ExportEvidenceBundleInput {
  repoPath: string;
  runIds: string[];
  outputPath: string;
  includeRaw?: boolean;
  generatedAt?: string;
}

export interface ExportEvidenceBundleResult {
  outputPath: string;
  runIds: string[];
  rawIncluded: boolean;
  files: string[];
}

interface SafeArtifactMetadata {
  id: string;
  name?: string;
  type?: string;
  producer: string;
  mediaType: string;
  stageId?: string;
  attempt?: number;
  createdAt?: string;
  sha256?: string;
  size?: number;
}

interface RegisteredArtifactIntegrity {
  sha256?: string;
  size?: number;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function assertChecksumSafePath(path: string): void {
  if (/[\r\n\\]/u.test(path)) {
    throw new Error(
      `evidence export refuses checksum-unsafe path: ${JSON.stringify(path)}`,
    );
  }
}

function artifactIntegrity(
  artifact: RunArtifact,
): RegisteredArtifactIntegrity {
  const sha256: unknown = artifact.sha256;
  if (
    sha256 !== undefined &&
    (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256))
  ) {
    throw new Error(`artifact ${artifact.id} has invalid sha256 metadata`);
  }
  const size: unknown = artifact.size;
  if (
    size !== undefined &&
    (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
  ) {
    throw new Error(`artifact ${artifact.id} has invalid size metadata`);
  }
  return {
    ...(sha256 !== undefined ? { sha256: sha256.toLowerCase() } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function mergeArtifactIntegrity(
  current: RegisteredArtifactIntegrity | undefined,
  next: RegisteredArtifactIntegrity,
  path: string,
): RegisteredArtifactIntegrity {
  if (
    current?.sha256 !== undefined &&
    next.sha256 !== undefined &&
    current.sha256 !== next.sha256
  ) {
    throw new Error(`conflicting sha256 metadata for raw evidence path ${path}`);
  }
  if (
    current?.size !== undefined &&
    next.size !== undefined &&
    current.size !== next.size
  ) {
    throw new Error(`conflicting size metadata for raw evidence path ${path}`);
  }
  return {
    sha256: current?.sha256 ?? next.sha256,
    size: current?.size ?? next.size,
  };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function safeArtifact(artifact: EvidenceArtifactMetadata): SafeArtifactMetadata {
  const sha256 = artifact.sha256 && /^[a-f0-9]{64}$/i.test(artifact.sha256)
    ? artifact.sha256.toLowerCase()
    : undefined;
  return {
    id: artifact.id,
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.type ? { type: artifact.type } : {}),
    producer: artifact.producer,
    mediaType: artifact.mediaType,
    ...(artifact.stageId ? { stageId: artifact.stageId } : {}),
    ...(artifact.attempt !== undefined ? { attempt: artifact.attempt } : {}),
    ...(artifact.createdAt ? { createdAt: artifact.createdAt } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(artifact.size !== undefined ? { size: artifact.size } : {}),
  };
}

function safeRunDocument(run: EvidenceRunRecord, rawIncluded: boolean): unknown {
  return redactUnknown({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "EvidenceRunSummary",
    metadata: {
      runId: run.runId,
      status: run.status,
      taskId: run.taskId,
      repository: {
        id: run.repositoryId,
        name: run.repositoryName,
      },
      flow: {
        name: run.flowName,
      },
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      terminalAt: run.terminalAt,
      prUrl: run.prUrl,
      blockerCategory: run.blockerCategory,
    },
    evidence: {
      completedStages: run.completedStages,
      gates: run.gates,
      artifacts: run.artifacts.map(safeArtifact),
    },
    exportBoundary: {
      classification: rawIncluded ? "sensitive-raw-opt-in" : "metadata-only",
      rawContentIncluded: rawIncluded,
      knownSecretsRedactedInMetadata: true,
      rawContentRedactionGuaranteed: false,
      omittedFromMetadata: [
        "absolute repository and flow paths",
        "input URIs and source snapshots",
        "worktree contents",
        "evidence text",
        "prompts and full agent context",
        "stdout and stderr",
        "artifact paths, filenames, descriptions, schemas, and contents",
        "gate commands, output, review bodies, reasons, and blocker messages",
      ],
    },
  });
}

function markdownCell(value: string | undefined): string {
  return (value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildSummary(runs: EvidenceRunRecord[], rawIncluded: boolean): string {
  const lines = [
    "# Nitely Evidence Export",
    "",
    `Classification: ${rawIncluded ? "sensitive-raw-opt-in" : "metadata-only"}`,
    `Raw content included: ${rawIncluded ? "yes" : "no"}`,
    "",
    "The structured summary excludes source, worktrees, inputs, prompts, logs,",
    "artifact contents, and free-form gate or blocker output. See manifest.json",
    "for the complete boundary. Raw opt-in files, when present, are sensitive.",
    "",
    "| Run | Status | Task | Repository | Flow | Updated | PR | Blocker |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map((run) =>
      `| ${markdownCell(run.runId)} | ${markdownCell(run.status)} | ${markdownCell(run.taskId)} | ${markdownCell(run.repositoryName ?? run.repositoryId)} | ${markdownCell(run.flowName)} | ${markdownCell(run.terminalAt ?? run.updatedAt)} | ${markdownCell(run.prUrl)} | ${markdownCell(run.blockerCategory)} |`,
    ),
    "",
  ];
  for (const run of runs) {
    lines.push(`## ${run.runId}`, "");
    lines.push(
      `- Completed stages: ${run.completedStages.length > 0 ? run.completedStages.join(", ") : "none"}`,
      `- Gates: ${run.gates.length > 0
        ? run.gates.map((gate) => `${gate.id}=${gate.status}`).join(", ")
        : "none"}`,
      `- Artifacts: ${run.artifacts.length > 0
        ? run.artifacts.map((artifact) =>
          `${artifact.id}${artifact.sha256 ? ` (sha256 ${artifact.sha256})` : ""}`,
        ).join(", ")
        : "none"}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function collectRecognizedRawFiles(
  runDirectory: string,
  directory = runDirectory,
): Promise<Set<string>> {
  const files = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (RAW_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      for (const nested of await collectRecognizedRawFiles(runDirectory, path)) {
        files.add(nested);
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (RAW_FILENAMES.has(entry.name)) {
        throw new Error(`raw evidence export refuses symbolic link: ${path}`);
      }
      continue;
    }
    if (entry.isFile() && RAW_FILENAMES.has(entry.name)) files.add(path);
  }
  return files;
}

async function validatedRawFile(
  runDirectory: string,
  artifactPath: string,
): Promise<string | undefined> {
  const candidate = resolve(
    runDirectory,
    isAbsolute(artifactPath) ? relative(runDirectory, artifactPath) : artifactPath,
  );
  const resolvedRunDirectory = await realpath(runDirectory);
  if (!isPathInside(resolve(runDirectory), candidate)) {
    throw new Error(`raw evidence path escapes run directory: ${artifactPath}`);
  }
  const relativePath = relative(resolve(runDirectory), candidate);
  const topLevelDirectory = relativePath.split(sep)[0];
  if (topLevelDirectory && RAW_EXCLUDED_DIRECTORIES.has(topLevelDirectory)) {
    return undefined;
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`raw evidence export refuses symbolic link: ${artifactPath}`);
  }
  if (metadata.nlink > 1) {
    throw new Error(`raw evidence export refuses hard link: ${artifactPath}`);
  }
  if (!metadata.isFile()) return undefined;
  const resolvedCandidate = await realpath(candidate);
  if (!isPathInside(resolvedRunDirectory, resolvedCandidate)) {
    throw new Error(`raw evidence path resolves outside run directory: ${artifactPath}`);
  }
  const resolvedRelativePath = relative(resolvedRunDirectory, resolvedCandidate);
  const resolvedTopLevelDirectory = resolvedRelativePath.split(sep)[0];
  if (
    resolvedTopLevelDirectory &&
    RAW_EXCLUDED_DIRECTORIES.has(resolvedTopLevelDirectory)
  ) {
    return undefined;
  }
  if (portablePath(relativePath) !== portablePath(resolvedRelativePath)) {
    throw new Error(`raw evidence export refuses path through symbolic link: ${artifactPath}`);
  }
  return candidate;
}

async function copyRawRun(
  run: EvidenceRunRecord,
  outputPath: string,
  boundaryRoot: string,
): Promise<Map<string, string>> {
  if (!run.runDirectory) {
    throw new Error(`raw evidence unavailable for run without directory: ${run.runId}`);
  }
  const copiedChecksums = new Map<string, string>();
  const candidates = await collectRecognizedRawFiles(run.runDirectory);
  const registeredIntegrity = new Map<string, RegisteredArtifactIntegrity>();
  const artifacts = await readReconciledRawRunArtifacts({
    repoPath: boundaryRoot,
    runId: run.runId,
    runDirectory: run.runDirectory,
  });
  for (const artifact of artifacts) {
    const artifactPath = artifact.path;
    if (!artifactPath) continue;
    const candidate = await validatedRawFile(run.runDirectory, artifactPath);
    if (candidate) {
      candidates.add(candidate);
      registeredIntegrity.set(
        candidate,
        mergeArtifactIntegrity(
          registeredIntegrity.get(candidate),
          artifactIntegrity(artifact),
          portablePath(relative(run.runDirectory, candidate)),
        ),
      );
    }
  }
  for (const sourcePath of [...candidates].sort()) {
    const verifiedSource = await validatedRawFile(
      run.runDirectory,
      relative(run.runDirectory, sourcePath),
    );
    if (!verifiedSource) continue;
    const relativePath = relative(run.runDirectory, verifiedSource);
    const checksumPath = portablePath(relativePath);
    assertChecksumSafePath(checksumPath);
    const destinationPath = join(outputPath, "raw", run.runId, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    const integrity = registeredIntegrity.get(verifiedSource);
    const copied = await copyRunOwnedFile({
      runDirectory: boundaryRoot,
      path: relative(boundaryRoot, verifiedSource),
      subject: `raw evidence path ${checksumPath}`,
      destinationPath,
      expectedSha256: integrity?.sha256,
      expectedSize: integrity?.size,
    });
    copiedChecksums.set(
      portablePath(join("raw", run.runId, relativePath)),
      copied.sha256,
    );
  }
  return copiedChecksums;
}

async function listBundleFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBundleFiles(root, path));
    } else if (entry.isFile()) {
      files.push(portablePath(relative(root, path)));
    }
  }
  return files.sort();
}

async function writeChecksums(
  outputPath: string,
  trustedChecksums: ReadonlyMap<string, string>,
): Promise<void> {
  const files = (await listBundleFiles(outputPath))
    .filter((path) => path !== "checksums.sha256");
  const fileSet = new Set(files);
  for (const path of trustedChecksums.keys()) {
    if (!fileSet.has(path)) {
      throw new Error(`copied evidence file disappeared before checksum: ${path}`);
    }
  }
  const lines: string[] = [];
  for (const path of files) {
    assertChecksumSafePath(path);
    let digest = trustedChecksums.get(path);
    if (!digest) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(outputPath, path))) {
        hash.update(chunk);
      }
      digest = hash.digest("hex");
    }
    lines.push(`${digest}  ${path}`);
  }
  await writeFile(join(outputPath, "checksums.sha256"), `${lines.join("\n")}\n`, "utf8");
}

export async function exportEvidenceBundle(
  input: ExportEvidenceBundleInput,
): Promise<ExportEvidenceBundleResult> {
  const repoPath = resolve(input.repoPath);
  const outputPath = resolve(input.outputPath);
  const requestedRunIds = [...new Set(input.runIds)];
  if (requestedRunIds.length === 0) {
    throw new Error("evidence export requires at least one run id");
  }
  if (isPathInside(join(repoPath, ".nitely", "runs"), outputPath)) {
    throw new Error("evidence export output must be outside .nitely/runs");
  }
  const records = await listEvidenceRuns(repoPath);
  const byRunId = new Map(records.map((run) => [run.runId, run]));
  const runs = requestedRunIds.map((runId) => {
    const run = byRunId.get(runId);
    if (!run) throw new Error(`evidence run not found: ${runId}`);
    return run;
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const runsRoot = join(repoPath, ".nitely", "runs");
  const trustedChecksums = new Map<string, string>();
  try {
    const [resolvedOutputParent, resolvedRunsRoot] = await Promise.all([
      realpath(dirname(outputPath)),
      realpath(runsRoot),
    ]);
    if (
      isPathInside(
        resolvedRunsRoot,
        resolve(resolvedOutputParent, basename(outputPath)),
      )
    ) {
      throw new Error("evidence export output must be outside .nitely/runs");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await mkdir(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`evidence export output already exists: ${outputPath}`);
    }
    throw error;
  }
  try {
    await mkdir(join(outputPath, "runs"));
    const rawIncluded = input.includeRaw === true;
    for (const run of runs) {
      await writeFile(
        join(outputPath, "runs", `${run.runId}.json`),
        `${JSON.stringify(safeRunDocument(run, rawIncluded), null, 2)}\n`,
        "utf8",
      );
    }
    await writeFile(
      join(outputPath, "summary.md"),
      buildSummary(runs, rawIncluded),
      "utf8",
    );
    if (rawIncluded) {
      await writeFile(
        join(outputPath, "RAW_CONTENT_WARNING.txt"),
        "SENSITIVE RAW CONTENT: these files are not guaranteed to be redacted and may contain source, prompts, logs, proprietary output, or secrets. Handle and share them only under an approved policy.\n",
        "utf8",
      );
      for (const run of runs) {
        const copied = await copyRawRun(run, outputPath, repoPath);
        for (const [path, digest] of copied) {
          trustedChecksums.set(path, digest);
        }
      }
    }
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const manifest = redactUnknown({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidenceExport",
      generatedAt,
      runIds: runs.map((run) => run.runId),
      classification: rawIncluded ? "sensitive-raw-opt-in" : "metadata-only",
      rawContentIncluded: rawIncluded,
      metadataKnownSecretsRedacted: true,
      rawContentRedactionGuaranteed: false,
      checksumFile: "checksums.sha256",
      defaultExcludedContent: [
        "source and worktrees",
        "input snapshots and URIs",
        "evidence text",
        "prompts and agent context",
        "stdout and stderr",
        "artifact paths, filenames, descriptions, schemas, and contents",
        "gate commands, output, review bodies, reasons, and blocker messages",
      ],
    });
    await writeFile(
      join(outputPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeChecksums(outputPath, trustedChecksums);
    return {
      outputPath,
      runIds: runs.map((run) => run.runId),
      rawIncluded,
      files: await listBundleFiles(outputPath),
    };
  } catch (error) {
    await rm(outputPath, { recursive: true, force: true });
    throw error;
  }
}
