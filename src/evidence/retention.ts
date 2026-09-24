import {
  access,
  lstat,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  isArtifactRegistryRemovingFilename,
  isArtifactRegistryTemporaryFilename,
  isPrivateArtifactPathRegistryFilename,
  isPrivateArtifactPathRegistryRemovingFilename,
  isPrivateArtifactPathRegistryTemporaryFilename,
  readArtifactRegistry,
  readArtifactRegistryWithPrivatePaths,
  readPrivateArtifactPathsFromSidecar,
} from "../artifacts/registry.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import {
  eventStorePath,
  projectRun,
  validateRunId,
} from "../run/project.js";
import {
  removeRunOwnedDirectoryRecursively,
  removeRunOwnedFile,
  runOwnedRemovalOriginalFilename,
  runOwnedTemporaryOriginalFilename,
  UnsafeRunOwnedFileError,
} from "../run/owned-file.js";
import {
  listEvidenceRuns,
  projectedRunIsTerminal,
  readReconciledRawRunArtifacts,
  type EvidenceRunRecord,
} from "./catalog.js";
import {
  loadEvidencePolicy,
  type LoadedEvidencePolicy,
} from "./policy.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SOURCE_DIRECTORIES = new Set(["inputs", "worktree"]);

type ComponentCategory = "logs" | "artifacts" | "evidence" | "runs";

interface RunOwnedResidue {
  path: string;
  originalPath: string;
  kind: "temporary" | "removing";
  temporaryOrigin: boolean;
  disposition: "safe" | "unsafe";
}

interface RunDirectoryQuarantine {
  runId: string;
  path: string;
  timestamp: string;
}

export type EvidencePruneCategory =
  | "runs"
  | "events"
  | "logs"
  | "artifacts"
  | "evidence";

export interface EvidencePruneAction {
  runId: string;
  category: EvidencePruneCategory;
  retainedDays: number;
  cutoff: string;
  runTimestamp: string;
  paths: string[];
  eventCount?: number;
}

export interface EvidencePrunePlan {
  mode: "dry-run";
  repoPath: string;
  evaluatedAt: string;
  policy: LoadedEvidencePolicy;
  actions: EvidencePruneAction[];
}

export interface EvidencePruneApplyResult {
  mode: "applied";
  repoPath: string;
  evaluatedAt: string;
  applied: EvidencePruneAction[];
  skipped: Array<{ action: EvidencePruneAction; reason: string }>;
}

export interface BuildEvidencePrunePlanInput {
  repoPath: string;
  now?: Date;
  policy?: LoadedEvidencePolicy;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cutoffFor(now: Date, retainedDays: number): Date {
  return new Date(now.getTime() - retainedDays * DAY_MS);
}

function expiredAt(
  timestamp: string,
  now: Date,
  retainedDays: number | null,
): { expired: boolean; cutoff?: string } {
  if (retainedDays === null) return { expired: false };
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return { expired: false };
  const cutoff = cutoffFor(now, retainedDays);
  return { expired: parsed <= cutoff.getTime(), cutoff: cutoff.toISOString() };
}

function componentCategoryForPath(
  runDirectory: string,
  path: string,
): ComponentCategory | undefined {
  const resolvedRunDirectory = resolve(runDirectory);
  const candidate = resolve(
    isAbsolute(path) ? path : join(resolvedRunDirectory, path),
  );
  if (!isPathInside(resolvedRunDirectory, candidate)) return undefined;
  const relativePath = relative(resolvedRunDirectory, candidate);
  const segments = relativePath.split(/[\\/]/u);
  if (segments[0] && SOURCE_DIRECTORIES.has(segments[0])) return "runs";
  const name = basename(candidate);
  if (name.endsWith(".log")) return "logs";
  if (relativePath === "evidence.md") return "evidence";
  if (name === "prompt.md" || name === "prompt.txt") return "runs";
  return "artifacts";
}

function publishedArtifacts(events: StoredRunEvent[]): unknown[] {
  return events.flatMap((event) => {
    if (event.type !== "artifact.published") return [];
    if (typeof event.payload !== "object" || event.payload === null) return [];
    const artifact = (event.payload as { artifact?: unknown }).artifact;
    return artifact === undefined ? [] : [artifact];
  });
}

async function collectLogFiles(
  runDirectory: string,
  directory = runDirectory,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "inputs" || entry.name === "worktree") continue;
      files.push(...await collectLogFiles(runDirectory, path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".log")) files.push(path);
  }
  return files.sort();
}

type RunFileInspection =
  | { disposition: "safe"; path: string }
  | { disposition: "missing" | "excluded" | "unsafe" };

async function inspectRunFile(
  runDirectory: string,
  path: string,
): Promise<RunFileInspection> {
  const candidate = resolve(isAbsolute(path) ? path : join(runDirectory, path));
  if (!isPathInside(resolve(runDirectory), candidate)) {
    throw new Error(`evidence retention path escapes run directory: ${path}`);
  }
  const relativePath = relative(resolve(runDirectory), candidate);
  const topLevelDirectory = relativePath.split(/[\\/]/u)[0];
  if (topLevelDirectory && SOURCE_DIRECTORIES.has(topLevelDirectory)) {
    return { disposition: "excluded" };
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { disposition: "missing" };
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1
  ) {
    return { disposition: "unsafe" };
  }
  const [resolvedRunDirectory, resolvedCandidate] = await Promise.all([
    realpath(runDirectory),
    realpath(candidate),
  ]);
  if (!isPathInside(resolvedRunDirectory, resolvedCandidate)) {
    throw new Error(`evidence retention path resolves outside run directory: ${path}`);
  }
  const resolvedRelativePath = relative(resolvedRunDirectory, resolvedCandidate);
  const resolvedTopLevelDirectory = resolvedRelativePath.split(/[\\/]/u)[0];
  if (
    resolvedTopLevelDirectory &&
    SOURCE_DIRECTORIES.has(resolvedTopLevelDirectory)
  ) {
    return { disposition: "excluded" };
  }
  if (relativePath !== resolvedRelativePath) {
    return { disposition: "unsafe" };
  }
  return { disposition: "safe", path: candidate };
}

async function validatedRunFile(
  runDirectory: string,
  path: string,
): Promise<string | undefined> {
  const inspection = await inspectRunFile(runDirectory, path);
  return inspection.disposition === "safe" ? inspection.path : undefined;
}

function residueOriginalFilename(filename: string): {
  kind: RunOwnedResidue["kind"];
  filename: string;
  temporaryOrigin: boolean;
} | undefined {
  const removingOriginal = runOwnedRemovalOriginalFilename(filename);
  if (removingOriginal) {
    const temporaryOriginal = runOwnedTemporaryOriginalFilename(removingOriginal);
    return {
      kind: "removing",
      filename: temporaryOriginal ?? removingOriginal,
      temporaryOrigin: temporaryOriginal !== undefined,
    };
  }
  const temporaryOriginal = runOwnedTemporaryOriginalFilename(filename);
  return temporaryOriginal
    ? {
        kind: "temporary",
        filename: temporaryOriginal,
        temporaryOrigin: true,
      }
    : undefined;
}

async function collectRunOwnedResidues(
  runDirectory: string,
  directory = runDirectory,
): Promise<RunOwnedResidue[]> {
  const residues: RunOwnedResidue[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const original = residueOriginalFilename(entry.name);
    if (original) {
      const originalPath = join(directory, original.filename);
      if (!entry.isFile()) {
        residues.push({
          path,
          originalPath,
          kind: original.kind,
          temporaryOrigin: original.temporaryOrigin,
          disposition: "unsafe",
        });
        continue;
      }
      const inspection = await inspectRunFile(runDirectory, path);
      residues.push({
        path,
        originalPath,
        kind: original.kind,
        temporaryOrigin: original.temporaryOrigin,
        disposition: inspection.disposition === "safe" ? "safe" : "unsafe",
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const relativePath = relative(runDirectory, path);
    const topLevelDirectory = relativePath.split(/[\\/]/u)[0];
    if (topLevelDirectory && SOURCE_DIRECTORIES.has(topLevelDirectory)) continue;
    residues.push(...await collectRunOwnedResidues(runDirectory, path));
  }
  return residues.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectLogFilesWithResidues(
  runDirectory: string,
  residues: RunOwnedResidue[],
): Promise<string[]> {
  const files = new Set(await collectLogFiles(runDirectory));
  for (const residue of residues) {
    if (componentCategoryForPath(runDirectory, residue.originalPath) !== "logs") {
      continue;
    }
    if (residue.disposition === "unsafe") return [];
    files.add(residue.path);
  }
  return [...files].sort();
}

async function evidenceSummaryFiles(
  runDirectory: string,
  residues: RunOwnedResidue[],
): Promise<string[]> {
  const files = new Set<string>();
  const path = await validatedRunFile(runDirectory, "evidence.md");
  if (path) files.add(path);
  for (const residue of residues) {
    if (
      componentCategoryForPath(runDirectory, residue.originalPath) !==
        "evidence"
    ) continue;
    if (residue.disposition === "unsafe") return [];
    files.add(residue.path);
  }
  return [...files].sort();
}

async function listRunDirectoryQuarantines(
  repoPath: string,
): Promise<RunDirectoryQuarantine[]> {
  const runsRoot = resolve(repoPath, ".nitely", "runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const quarantines: RunDirectoryQuarantine[] = [];
  for (const entry of entries) {
    const runId = runOwnedRemovalOriginalFilename(entry.name);
    if (!runId || !entry.isDirectory()) continue;
    try {
      validateRunId(runId);
    } catch {
      continue;
    }
    const path = join(runsRoot, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    const resolvedPath = await realpath(path);
    if (!isPathInside(await realpath(runsRoot), resolvedPath)) continue;
    quarantines.push({
      runId,
      path,
      timestamp: metadata.mtime.toISOString(),
    });
  }
  return quarantines.sort((left, right) =>
    left.runId.localeCompare(right.runId) || left.path.localeCompare(right.path)
  );
}

async function strictPrivateRegistryFiles(
  runDirectory: string,
): Promise<{
  files: Array<{ path: string; temporary: boolean; removing: boolean }>;
  unsafe: boolean;
}> {
  const files: Array<{
    path: string;
    temporary: boolean;
    removing: boolean;
  }> = [];
  for (const entry of await readdir(runDirectory, { withFileTypes: true })) {
    const removingOriginal = runOwnedRemovalOriginalFilename(entry.name);
    const temporary = isPrivateArtifactPathRegistryTemporaryFilename(entry.name) ||
      (removingOriginal !== undefined &&
        isPrivateArtifactPathRegistryTemporaryFilename(removingOriginal));
    const removing = isPrivateArtifactPathRegistryRemovingFilename(entry.name);
    if (
      !temporary &&
      !removing &&
      !isPrivateArtifactPathRegistryFilename(entry.name)
    ) {
      continue;
    }
    const inspection = await inspectRunFile(runDirectory, entry.name);
    if (inspection.disposition === "unsafe") {
      return { files: [], unsafe: true };
    }
    if (inspection.disposition === "safe") {
      files.push({ path: inspection.path, temporary, removing });
    }
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    unsafe: false,
  };
}

async function strictPublicRegistryResidueFiles(
  runDirectory: string,
): Promise<{ paths: string[]; unsafe: boolean }> {
  const paths: string[] = [];
  for (const entry of await readdir(runDirectory, { withFileTypes: true })) {
    if (
      !isArtifactRegistryTemporaryFilename(entry.name) &&
      !isArtifactRegistryRemovingFilename(entry.name)
    ) continue;
    const inspection = await inspectRunFile(runDirectory, entry.name);
    if (inspection.disposition === "unsafe") {
      return { paths: [], unsafe: true };
    }
    if (inspection.disposition === "safe") paths.push(inspection.path);
  }
  return { paths: paths.sort(), unsafe: false };
}

function registeredArtifactPath(artifact: unknown): string | undefined {
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    typeof (artifact as { path?: unknown }).path !== "string"
  ) {
    return undefined;
  }
  const path = (artifact as { path: string }).path;
  return path.length > 0 ? path : undefined;
}

function normalizedRegisteredArtifactPath(
  runDirectory: string,
  path: string,
): string | undefined {
  const candidate = resolve(isAbsolute(path) ? path : join(runDirectory, path));
  return isPathInside(resolve(runDirectory), candidate) ? candidate : undefined;
}

async function durableRegistryArtifactPaths(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
}): Promise<Set<string> | undefined> {
  try {
    const publicRegistry = await readArtifactRegistry(input);
    const privateRegistry = await readArtifactRegistryWithPrivatePaths(input);
    const paths = new Set<string>();
    for (
      const artifact of [
        ...(publicRegistry?.artifacts ?? []),
        ...(privateRegistry?.artifacts ?? []),
      ]
    ) {
      const path = registeredArtifactPath(artifact);
      if (!path) continue;
      const normalized = normalizedRegisteredArtifactPath(
        input.runDirectory,
        path,
      );
      if (normalized) paths.add(normalized);
    }
    const privateRegistries = await strictPrivateRegistryFiles(
      input.runDirectory,
    );
    if (privateRegistries.unsafe) return undefined;
    for (const privateRegistry of privateRegistries.files) {
      if (privateRegistry.temporary || privateRegistry.removing) continue;
      const privatePaths = await readPrivateArtifactPathsFromSidecar({
        ...input,
        filename: basename(privateRegistry.path),
      });
      for (const path of privatePaths) {
        const normalized = normalizedRegisteredArtifactPath(
          input.runDirectory,
          path,
        );
        if (normalized) paths.add(normalized);
      }
    }
    return paths;
  } catch {
    // An unreadable current registry cannot be treated as a durable retry
    // index. Keep the event projection instead of risking the last reference.
    return undefined;
  }
}

async function eventProjectionNeedsRetryIndex(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  artifacts: unknown[];
}): Promise<boolean> {
  const eventPaths = input.artifacts.flatMap((artifact) => {
    const path = registeredArtifactPath(artifact);
    return path ? [path] : [];
  });
  if (eventPaths.length === 0) return false;

  const durablePaths = await durableRegistryArtifactPaths(input);
  if (!durablePaths) return true;
  let residues: RunOwnedResidue[];
  try {
    residues = await collectRunOwnedResidues(input.runDirectory);
  } catch {
    return true;
  }
  for (const eventPath of eventPaths) {
    const category = componentCategoryForPath(input.runDirectory, eventPath);
    if (category && category !== "artifacts") continue;
    const normalized = normalizedRegisteredArtifactPath(
      input.runDirectory,
      eventPath,
    );
    if (!normalized) return true;
    if (durablePaths.has(normalized)) continue;
    if (residues.some((residue) =>
      normalizedRegisteredArtifactPath(
        input.runDirectory,
        residue.originalPath,
      ) === normalized
    )) return true;
    try {
      const inspection = await inspectRunFile(input.runDirectory, eventPath);
      if (
        inspection.disposition === "safe" ||
        inspection.disposition === "unsafe"
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

async function collectArtifactFiles(
  runDirectory: string,
  boundaryRoot: string,
  eventArtifacts: unknown[],
  residues: RunOwnedResidue[],
): Promise<string[]> {
  const materializedFiles = new Set<string>();
  const publicIndexFiles = new Set<string>();
  const privateIndexFiles = new Set<string>();
  for (const name of ["recovery.json", "recovery.patch"]) {
    const inspection = await inspectRunFile(runDirectory, name);
    if (inspection.disposition === "unsafe") return [];
    if (inspection.disposition === "safe") {
      materializedFiles.add(inspection.path);
    }
  }

  const registryInspection = await inspectRunFile(runDirectory, "artifacts.json");
  if (registryInspection.disposition === "unsafe") return [];
  const registryPath = registryInspection.disposition === "safe"
    ? registryInspection.path
    : undefined;
  if (registryPath) publicIndexFiles.add(registryPath);
  const privateRegistries = await strictPrivateRegistryFiles(runDirectory);
  if (privateRegistries.unsafe) return [];
  privateRegistries.files.forEach(({ path }) => privateIndexFiles.add(path));
  const publicRegistryResidues = await strictPublicRegistryResidueFiles(
    runDirectory,
  );
  if (publicRegistryResidues.unsafe) return [];
  publicRegistryResidues.paths.forEach((path) => publicIndexFiles.add(path));

  const artifactPaths = new Set<string>();
  const publicRegistry = await readArtifactRegistry({
    runDirectory,
    boundaryRoot,
  });
  for (const artifact of publicRegistry?.artifacts ?? []) {
    const path = registeredArtifactPath(artifact);
    if (path) artifactPaths.add(path);
  }
  for (const privateRegistry of privateRegistries.files) {
    try {
      const rawPaths = await readPrivateArtifactPathsFromSidecar({
        runDirectory,
        boundaryRoot,
        runId: basename(runDirectory),
        filename: basename(privateRegistry.path),
      });
      rawPaths.forEach((path) => artifactPaths.add(path));
    } catch (error) {
      if (!privateRegistry.temporary) throw error;
      // A crash can leave a partially written private temporary. Its raw path
      // cannot be recovered reliably, but the sensitive temporary itself must
      // still be removed in the private-index phase.
    }
  }
  const reconciledArtifacts = await readReconciledRawRunArtifacts({
    repoPath: boundaryRoot,
    runId: basename(runDirectory),
    runDirectory,
  });
  for (const artifact of reconciledArtifacts) {
    const path = registeredArtifactPath(artifact);
    if (path) artifactPaths.add(path);
  }
  for (const artifact of eventArtifacts) {
    const path = registeredArtifactPath(artifact);
    if (path) artifactPaths.add(path);
  }

  const normalizedArtifactPaths = new Set<string>();
  for (const artifactPath of artifactPaths) {
    const category = componentCategoryForPath(runDirectory, artifactPath);
    if (!category) {
      throw new Error("evidence retention Artifact path escapes run directory");
    }
    if (category !== "artifacts") continue;
    const normalized = normalizedRegisteredArtifactPath(
      runDirectory,
      artifactPath,
    );
    if (normalized) normalizedArtifactPaths.add(normalized);
    const inspection = await inspectRunFile(runDirectory, artifactPath);
    if (inspection.disposition === "unsafe") return [];
    if (inspection.disposition === "safe") {
      materializedFiles.add(inspection.path);
    }
  }

  for (const residue of residues) {
    const residueName = basename(residue.path);
    if (isPrivateArtifactPathRegistryRemovingFilename(residueName)) {
      if (residue.disposition === "unsafe") return [];
      privateIndexFiles.add(residue.path);
      continue;
    }
    if (isArtifactRegistryRemovingFilename(residueName)) {
      if (residue.disposition === "unsafe") return [];
      publicIndexFiles.add(residue.path);
      continue;
    }
    if (
      componentCategoryForPath(runDirectory, residue.originalPath) !==
        "artifacts"
    ) continue;
    const normalizedOriginal = normalizedRegisteredArtifactPath(
      runDirectory,
      residue.originalPath,
    );
    const originalName = basename(residue.originalPath);
    const isKnownRemoval = residue.kind !== "removing" ||
      residue.temporaryOrigin ||
      originalName === "recovery.json" ||
      originalName === "recovery.patch" ||
      (normalizedOriginal !== undefined &&
        normalizedArtifactPaths.has(normalizedOriginal));
    if (!isKnownRemoval) continue;
    if (residue.disposition === "unsafe") return [];
    materializedFiles.add(residue.path);
  }

  // Keep every index available until every materialized and recovery path is
  // gone so an interrupted prune can discover and retry sensitive files.
  publicIndexFiles.forEach((path) => materializedFiles.delete(path));
  privateIndexFiles.forEach((path) => materializedFiles.delete(path));
  return [...materializedFiles].sort().concat(
    ...[...publicIndexFiles].sort(),
    ...[...privateIndexFiles].sort(),
  );
}

function actionForFiles(input: {
  run: EvidenceRunRecord;
  category: Exclude<EvidencePruneCategory, "events">;
  retainedDays: number;
  cutoff: string;
  paths: string[];
}): EvidencePruneAction | undefined {
  if (input.paths.length === 0) return undefined;
  return {
    runId: input.run.runId,
    category: input.category,
    retainedDays: input.retainedDays,
    cutoff: input.cutoff,
    runTimestamp: input.run.updatedAt,
    paths: input.paths,
  };
}

const CATEGORY_ORDER: Record<EvidencePruneCategory, number> = {
  runs: 0,
  logs: 1,
  artifacts: 2,
  evidence: 3,
  events: 4,
};

export async function buildEvidencePrunePlan(
  input: BuildEvidencePrunePlanInput,
): Promise<EvidencePrunePlan> {
  const repoPath = resolve(input.repoPath);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("invalid evidence prune evaluation timestamp");
  }
  const policy = input.policy ?? await loadEvidencePolicy(repoPath);
  const records = await listEvidenceRuns(repoPath);
  const quarantines = await listRunDirectoryQuarantines(repoPath);
  const quarantinesByRunId = new Map<string, RunDirectoryQuarantine[]>();
  for (const quarantine of quarantines) {
    const existing = quarantinesByRunId.get(quarantine.runId) ?? [];
    existing.push(quarantine);
    quarantinesByRunId.set(quarantine.runId, existing);
  }
  const actions: EvidencePruneAction[] = [];
  const recordedRunIds = new Set<string>();
  let store: EventStore | undefined;
  if (await pathExists(eventStorePath(repoPath))) {
    store = new EventStore(eventStorePath(repoPath));
  }
  try {
    for (const run of records) {
      recordedRunIds.add(run.runId);
      if (!projectedRunIsTerminal(run.status)) continue;
      const runTimestamp = run.updatedAt;
      const events = store?.list(run.runId) ?? [];
      const eventArtifacts = publishedArtifacts(events);
      const runQuarantines = quarantinesByRunId.get(run.runId) ?? [];
      const runDirectoryPaths = [...new Set([
        ...(run.runDirectory ? [run.runDirectory] : []),
        ...runQuarantines.map((quarantine) => quarantine.path),
      ])].sort();
      const runExpiry = expiredAt(
        runTimestamp,
        now,
        policy.retention.runsDays,
      );
      let wholeRunSelected = false;
      if (
        runDirectoryPaths.length > 0 &&
        policy.retention.runsDays !== null &&
        runExpiry.expired &&
        runExpiry.cutoff
      ) {
        const action = actionForFiles({
          run,
          category: "runs",
          retainedDays: policy.retention.runsDays,
          cutoff: runExpiry.cutoff,
          paths: runDirectoryPaths,
        });
        if (action) {
          actions.push(action);
          wholeRunSelected = true;
        }
      }

      if (!wholeRunSelected && run.runDirectory) {
        let residuesPromise: Promise<RunOwnedResidue[]> | undefined;
        const residues = () => {
          residuesPromise ??= collectRunOwnedResidues(
            run.runDirectory as string,
          );
          return residuesPromise;
        };
        const componentDefinitions = [
          {
            category: "logs" as const,
            days: policy.retention.logsDays,
            collect: async () => collectLogFilesWithResidues(
              run.runDirectory as string,
              await residues(),
            ),
          },
          {
            category: "artifacts" as const,
            days: policy.retention.artifactsDays,
            collect: async () => collectArtifactFiles(
              run.runDirectory as string,
              repoPath,
              eventArtifacts,
              await residues(),
            ),
          },
          {
            category: "evidence" as const,
            days: policy.retention.evidenceDays,
            collect: async () => evidenceSummaryFiles(
              run.runDirectory as string,
              await residues(),
            ),
          },
        ];
        for (const component of componentDefinitions) {
          const expiry = expiredAt(runTimestamp, now, component.days);
          if (component.days === null || !expiry.expired || !expiry.cutoff) continue;
          const action = actionForFiles({
            run,
            category: component.category,
            retainedDays: component.days,
            cutoff: expiry.cutoff,
            paths: await component.collect(),
          });
          if (action) actions.push(action);
        }
      }

      const eventExpiry = expiredAt(
        runTimestamp,
        now,
        policy.retention.eventsDays,
      );
      if (
        store &&
        policy.retention.eventsDays !== null &&
        eventExpiry.expired &&
        eventExpiry.cutoff
      ) {
        const eventCount = events.length;
        const needsRetryIndex = eventCount > 0 && run.runDirectory
          ? await eventProjectionNeedsRetryIndex({
            runDirectory: run.runDirectory,
            boundaryRoot: repoPath,
            runId: run.runId,
            artifacts: eventArtifacts,
          })
          : false;
        if (eventCount > 0 && !needsRetryIndex) {
          actions.push({
            runId: run.runId,
            category: "events",
            retainedDays: policy.retention.eventsDays,
            cutoff: eventExpiry.cutoff,
            runTimestamp,
            paths: [`${eventStorePath(repoPath)}#run=${run.runId}`],
            eventCount,
          });
        }
      }
    }

    if (policy.retention.runsDays !== null) {
      for (const [runId, runQuarantines] of quarantinesByRunId) {
        if (recordedRunIds.has(runId)) continue;
        const runTimestamp = runQuarantines
          .map((quarantine) => quarantine.timestamp)
          .sort()
          .at(-1) as string;
        const expiry = expiredAt(
          runTimestamp,
          now,
          policy.retention.runsDays,
        );
        if (!expiry.expired || !expiry.cutoff) continue;
        actions.push({
          runId,
          category: "runs",
          retainedDays: policy.retention.runsDays,
          cutoff: expiry.cutoff,
          runTimestamp,
          paths: runQuarantines.map((quarantine) => quarantine.path).sort(),
        });
      }
    }
  } finally {
    store?.close();
  }
  actions.sort((left, right) =>
    left.runId.localeCompare(right.runId) ||
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category],
  );
  return {
    mode: "dry-run",
    repoPath,
    evaluatedAt: now.toISOString(),
    policy,
    actions,
  };
}

function actionKey(action: EvidencePruneAction): string {
  return `${action.runId}\0${action.category}\0${action.runTimestamp}\0${action.eventCount ?? ""}\0${[...action.paths].sort().join("\0")}`;
}

async function removeRunDirectory(repoPath: string, path: string): Promise<void> {
  const runsRoot = resolve(repoPath, ".nitely", "runs");
  const candidate = resolve(path);
  if (!isPathInside(runsRoot, candidate) || candidate === runsRoot) {
    throw new Error(`refusing to prune path outside run root: ${path}`);
  }
  await removeRunOwnedDirectoryRecursively({
    runDirectory: resolve(repoPath),
    path: relative(resolve(repoPath), candidate),
    subject: `evidence retention run directory ${candidate}`,
  });
}

async function removeRunFiles(
  repoPath: string,
  action: EvidencePruneAction,
): Promise<void> {
  const runDirectory = resolve(repoPath, ".nitely", "runs", action.runId);
  for (const path of action.paths) {
    const candidate = resolve(isAbsolute(path) ? path : join(runDirectory, path));
    if (!isPathInside(runDirectory, candidate)) {
      throw new Error(`evidence retention path escapes run directory: ${path}`);
    }
    const relativePath = relative(runDirectory, candidate);
    const topLevelDirectory = relativePath.split(/[\\/]/u)[0];
    if (topLevelDirectory && SOURCE_DIRECTORIES.has(topLevelDirectory)) {
      continue;
    }
    await removeRunOwnedFile({
      runDirectory: resolve(repoPath),
      path: relative(resolve(repoPath), candidate),
      subject: `evidence retention path ${relativePath}`,
    });
  }
}

async function deleteRunEvents(
  repoPath: string,
  action: EvidencePruneAction,
): Promise<number> {
  const path = eventStorePath(repoPath);
  if (!await pathExists(path)) return 0;
  const store = new EventStore(path);
  try {
    const events = store.list(action.runId);
    if (events.length === 0) return 0;
    if (events.length !== action.eventCount) return 0;
    const projection = projectRun(events, { openAttemptStatus: "interrupted" });
    if (!projectedRunIsTerminal(projection.status)) return 0;
    const latestAt = events.at(-1)?.createdAt;
    const latestTimestamp = latestAt ? Date.parse(latestAt) : Number.NaN;
    if (
      !Number.isFinite(latestTimestamp) ||
      new Date(latestTimestamp).toISOString() !== action.runTimestamp
    ) return 0;
    return store.deleteRun(action.runId);
  } finally {
    store.close();
  }
}

async function currentEventProjectionNeedsRetryIndex(
  repoPath: string,
  runId: string,
): Promise<boolean> {
  const runDirectory = resolve(repoPath, ".nitely", "runs", runId);
  try {
    const metadata = await lstat(runDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  const path = eventStorePath(repoPath);
  if (!await pathExists(path)) return false;
  const store = new EventStore(path);
  try {
    const events = store.list(runId);
    if (events.length === 0) return false;
    return await eventProjectionNeedsRetryIndex({
      runDirectory,
      boundaryRoot: repoPath,
      runId,
      artifacts: publishedArtifacts(events),
    });
  } catch {
    return true;
  } finally {
    store.close();
  }
}

export async function applyEvidencePrunePlan(
  plan: EvidencePrunePlan,
): Promise<EvidencePruneApplyResult> {
  const current = await buildEvidencePrunePlan({
    repoPath: plan.repoPath,
    now: new Date(plan.evaluatedAt),
    policy: plan.policy,
  });
  const currentActions = new Map(
    current.actions.map((action) => [actionKey(action), action]),
  );
  const applied: EvidencePruneAction[] = [];
  const skipped: EvidencePruneApplyResult["skipped"] = [];
  const requestedActionKeys = new Set<string>();
  for (const requestedAction of plan.actions) {
    const key = actionKey(requestedAction);
    if (!currentActions.has(key)) {
      skipped.push({
        action: requestedAction,
        reason: "state changed since the dry-run plan",
      });
      continue;
    }
    requestedActionKeys.add(key);
  }
  for (const action of current.actions) {
    if (!requestedActionKeys.has(actionKey(action))) continue;
    if (action.category === "events") {
      if (await currentEventProjectionNeedsRetryIndex(plan.repoPath, action.runId)) {
        skipped.push({
          action,
          reason: "event projection is still the retry index for materialized Artifacts",
        });
        continue;
      }
      const deleted = await deleteRunEvents(plan.repoPath, action);
      if (deleted === 0) {
        skipped.push({ action, reason: "event history changed or run is no longer terminal" });
        continue;
      }
      applied.push(action);
      continue;
    }
    try {
      if (action.category === "runs") {
        for (const path of action.paths) {
          await removeRunDirectory(plan.repoPath, path);
        }
      } else {
        await removeRunFiles(plan.repoPath, action);
      }
    } catch (error) {
      if (action.category === "artifacts" && error instanceof UnsafeRunOwnedFileError) {
        skipped.push({
          action,
          reason: "artifact path became unsafe since the dry-run plan",
        });
        continue;
      }
      throw error;
    }
    applied.push(action);
  }
  return {
    mode: "applied",
    repoPath: plan.repoPath,
    evaluatedAt: plan.evaluatedAt,
    applied,
    skipped,
  };
}
