import {
  access,
  stat,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  readArtifactRegistry,
  readReconciledArtifactRegistryWithPrivatePaths,
  reconcileArtifactSources,
} from "../artifacts/registry.js";
import type { GateResult, RunArtifact } from "../artifacts/types.js";
import { redactText } from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import {
  listRunOwnedDirectory,
  readRunOwnedFile,
  UnsafeRunOwnedFileError,
} from "../run/owned-file.js";
import {
  eventStorePath,
  projectRun,
  validateRunId,
  type ProjectedRunStatus,
} from "../run/project.js";

export interface EvidenceArtifactMetadata {
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
  filename?: string;
  path?: string;
  sourceUri?: string;
}

export interface EvidenceGateMetadata {
  id: string;
  stageId: string;
  name?: string;
  mode: GateResult["mode"];
  status: GateResult["status"];
  runtime?: string;
  attempt?: number;
  createdAt?: string;
  reviewedArtifactIds: string[];
  contentOmitted: true;
}

export interface EvidenceRunRecord {
  schemaVersion: 1;
  runId: string;
  status: ProjectedRunStatus | "unknown";
  taskId?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryPath?: string;
  flowName?: string;
  flowPath?: string;
  prUrl?: string;
  blockerCategory?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  completedStages: string[];
  gates: EvidenceGateMetadata[];
  artifacts: EvidenceArtifactMetadata[];
  runDirectory?: string;
  source: "events" | "run-directory";
}

export interface EvidenceSearchFilters {
  run?: string;
  task?: string;
  repository?: string;
  flow?: string;
  status?: string;
  pr?: string;
  blocker?: string;
  from?: string;
  to?: string;
  artifact?: string;
}

export interface CiRepairEvidenceRecord {
  schemaVersion: "nitely.ci-repair-evidence.v1";
  idempotencyKey: string;
  sourceIdentity: string;
  provider: string;
  repository: string;
  pullRequest: number;
  checkSuiteId?: string;
  workflowRunId?: string;
  checkRunId: string;
  checkName: string;
  headSha: string;
  classification?: string;
  confidence?: string;
  diagnosis?: { classification: string; confidence: string; evidence: string; excerpt: string };
  failureOutput: string;
  outputTruncated: boolean;
  localChecks?: { passed: boolean; commands: string[] };
  structuredReview?: { passed: boolean };
  samePullRequestUpdate?: { updatedHeadSha: string; receipt: string };
  repairRunId?: string;
  repairWorktreePath?: string;
  remoteObservationCount: number;
  remoteObservationBudget: { used: number; remaining: number };
  remoteObservations: Array<{ headSha: string; passed: boolean; failureOutput?: string }>;
  outcome?: string;
  humanDecision?: { decision: string; reason?: string; actor?: string };
  terminal: boolean;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function boundedRedactedText(
  value: unknown,
  maximum = 512,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactText(value)?.trim();
  if (!redacted) return undefined;
  return redacted.length <= maximum
    ? redacted
    : `${redacted.slice(0, maximum)}…`;
}

function blockerCategory(value: string | undefined): string | undefined {
  const candidate = boundedRedactedText(value, 80);
  if (!candidate) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(candidate)
    ? candidate
    : "other";
}

function normalizedTimestamp(
  value: string | undefined,
  fallback: string,
): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function optionalTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeArtifact(artifact: RunArtifact): EvidenceArtifactMetadata | undefined {
  const id = boundedRedactedText(artifact.id, 200);
  if (!id) return undefined;
  return {
    id,
    ...(boundedRedactedText(artifact.name, 300)
      ? { name: boundedRedactedText(artifact.name, 300) }
      : {}),
    ...(boundedRedactedText(artifact.type, 200)
      ? { type: boundedRedactedText(artifact.type, 200) }
      : {}),
    producer: boundedRedactedText(artifact.producer, 200) ?? "unknown",
    mediaType: boundedRedactedText(artifact.mediaType, 200) ?? "application/octet-stream",
    ...(boundedRedactedText(artifact.stageId, 200)
      ? { stageId: boundedRedactedText(artifact.stageId, 200) }
      : {}),
    ...(Number.isInteger(artifact.attempt) && (artifact.attempt ?? 0) > 0
      ? { attempt: artifact.attempt }
      : {}),
    ...(optionalTimestamp(artifact.createdAt)
      ? { createdAt: optionalTimestamp(artifact.createdAt) }
      : {}),
    ...(boundedRedactedText(artifact.sha256, 200)
      ? { sha256: boundedRedactedText(artifact.sha256, 200) }
      : {}),
    ...(typeof artifact.size === "number" && Number.isFinite(artifact.size)
      ? { size: artifact.size }
      : {}),
    ...(boundedRedactedText(artifact.filename, 300)
      ? { filename: boundedRedactedText(artifact.filename, 300) }
      : {}),
    ...(boundedRedactedText(artifact.path, 1_024)
      ? { path: boundedRedactedText(artifact.path, 1_024) }
      : {}),
    ...(boundedRedactedText(artifact.sourceUri, 1_024)
      ? { sourceUri: boundedRedactedText(artifact.sourceUri, 1_024) }
      : {}),
  };
}

function artifactMetadata(
  artifacts: RunArtifact[],
): EvidenceArtifactMetadata[] {
  return artifacts
    .map(normalizeArtifact)
    .filter((artifact): artifact is EvidenceArtifactMetadata => artifact !== undefined)
    .sort((left, right) =>
      left.producer.localeCompare(right.producer) || left.id.localeCompare(right.id),
    );
}

function normalizeGate(gate: GateResult): EvidenceGateMetadata {
  const reviewedArtifacts = Array.isArray(gate.reviewedArtifacts)
    ? gate.reviewedArtifacts
    : [];
  return {
    id: boundedRedactedText(gate.id, 200) ?? "unknown",
    stageId: boundedRedactedText(gate.stageId, 200) ?? "unknown",
    ...(boundedRedactedText(gate.name, 300)
      ? { name: boundedRedactedText(gate.name, 300) }
      : {}),
    mode: gate.mode,
    status: gate.status,
    ...(boundedRedactedText(gate.runtime, 200)
      ? { runtime: boundedRedactedText(gate.runtime, 200) }
      : {}),
    ...(Number.isInteger(gate.attempt) && (gate.attempt ?? 0) > 0
      ? { attempt: gate.attempt }
      : {}),
    ...(optionalTimestamp(gate.createdAt)
      ? { createdAt: optionalTimestamp(gate.createdAt) }
      : {}),
    reviewedArtifactIds: reviewedArtifacts
      .map((id) => boundedRedactedText(id, 200))
      .filter((id): id is string => id !== undefined),
    contentOmitted: true,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readRunJsonRecord(
  boundaryRoot: string,
  runDirectory: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { content } = await readRunOwnedFile({
      runDirectory: boundaryRoot,
      path: relative(boundaryRoot, join(runDirectory, "run.json")),
      subject: "evidence Run metadata path",
    });
    return asRecord(JSON.parse(content.toString("utf8")) as unknown);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof UnsafeRunOwnedFileError
    ) {
      return undefined;
    }
    throw new Error(
      `cannot read evidence metadata run.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function listRunDirectories(repoPath: string): Promise<Map<string, string>> {
  const resolvedRepoPath = resolve(repoPath);
  const root = join(resolvedRepoPath, ".nitely", "runs");
  let entries;
  try {
    entries = await listRunOwnedDirectory({
      runDirectory: resolvedRepoPath,
      path: ".nitely/runs",
      subject: "evidence runs root",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const directories = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      validateRunId(entry.name);
    } catch {
      continue;
    }
    directories.set(entry.name, join(root, entry.name));
  }
  return directories;
}

async function artifactRegistryArtifacts(
  boundaryRoot: string,
  runDirectory: string | undefined,
): Promise<RunArtifact[]> {
  if (!runDirectory) return [];
  try {
    const registry = await readArtifactRegistry({ runDirectory, boundaryRoot });
    return registry?.artifacts ?? [];
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof UnsafeRunOwnedFileError
    ) {
      return [];
    }
    throw error;
  }
}

export async function readReconciledRunArtifacts(input: {
  repoPath: string;
  runId: string;
  runDirectory?: string;
}): Promise<RunArtifact[]> {
  const boundaryRoot = resolve(input.repoPath);
  validateRunId(input.runId);
  const registry = await artifactRegistryArtifacts(
    boundaryRoot,
    input.runDirectory,
  );
  const eventProjection = await runEventArtifactProjection(
    boundaryRoot,
    input.runId,
  );
  return reconcileArtifactSources({ registry, eventProjection });
}

async function runEventArtifactProjection(
  boundaryRoot: string,
  runId: string,
): Promise<RunArtifact[]> {
  const path = eventStorePath(boundaryRoot);
  if (!await pathExists(path)) {
    return [];
  }

  const store = new EventStore(path);
  try {
    const events = store.list(runId);
    return events.length > 0
      ? projectRun(events, { openAttemptStatus: "interrupted" }).artifacts
      : [];
  } finally {
    store.close();
  }
}

export async function readReconciledRawRunArtifacts(input: {
  repoPath: string;
  runId: string;
  runDirectory?: string;
}): Promise<RunArtifact[]> {
  const boundaryRoot = resolve(input.repoPath);
  validateRunId(input.runId);
  if (!input.runDirectory) {
    const eventProjection = await runEventArtifactProjection(
      boundaryRoot,
      input.runId,
    );
    return reconcileArtifactSources({ registry: [], eventProjection });
  }
  return await readReconciledArtifactRegistryWithPrivatePaths({
    runDirectory: input.runDirectory,
    boundaryRoot,
    runId: input.runId,
    readEventProjection: () =>
      runEventArtifactProjection(boundaryRoot, input.runId),
  });
}

async function eventRecord(
  boundaryRoot: string,
  runId: string,
  runDirectory: string | undefined,
  store: EventStore,
): Promise<EvidenceRunRecord> {
  const events = store.list(runId);
  const projection = projectRun(events, { openAttemptStatus: "interrupted" });
  const registryArtifacts = await artifactRegistryArtifacts(
    boundaryRoot,
    runDirectory,
  );
  const hasOpenAttempt = projection.stages.some((stage) =>
    stage.status === "started" ||
    stage.status === "awaiting-approval" ||
    stage.status === "interrupted"
  );
  return {
    schemaVersion: 1,
    runId,
    status: projection.terminalStatus && hasOpenAttempt
      ? "interrupted"
      : projection.status,
    ...(boundedRedactedText(projection.workItemId, 200)
      ? { taskId: boundedRedactedText(projection.workItemId, 200) }
      : {}),
    ...(boundedRedactedText(projection.repoId, 200)
      ? { repositoryId: boundedRedactedText(projection.repoId, 200) }
      : {}),
    ...(boundedRedactedText(projection.repoName, 300)
      ? { repositoryName: boundedRedactedText(projection.repoName, 300) }
      : {}),
    ...(boundedRedactedText(projection.repoPath, 1_024)
      ? { repositoryPath: boundedRedactedText(projection.repoPath, 1_024) }
      : {}),
    ...(boundedRedactedText(projection.flowName, 300)
      ? { flowName: boundedRedactedText(projection.flowName, 300) }
      : {}),
    ...(boundedRedactedText(projection.flowPath, 1_024)
      ? { flowPath: boundedRedactedText(projection.flowPath, 1_024) }
      : {}),
    ...(boundedRedactedText(projection.changeRequestUrl, 1_024)
      ? { prUrl: boundedRedactedText(projection.changeRequestUrl, 1_024) }
      : {}),
    ...(blockerCategory(projection.blocker?.reason)
      ? { blockerCategory: blockerCategory(projection.blocker?.reason) }
      : {}),
    createdAt: normalizedTimestamp(events[0]?.createdAt, new Date(0).toISOString()),
    updatedAt: normalizedTimestamp(
      events.at(-1)?.createdAt ?? events[0]?.createdAt,
      new Date(0).toISOString(),
    ),
    ...(optionalTimestamp(projection.terminalEventAt)
      ? { terminalAt: optionalTimestamp(projection.terminalEventAt) }
      : {}),
    completedStages: projection.completedStages
      .map((stageId) => boundedRedactedText(stageId, 200))
      .filter((stageId): stageId is string => stageId !== undefined)
      .sort(),
    gates: projection.gates.map(normalizeGate),
    artifacts: artifactMetadata(reconcileArtifactSources({
      registry: registryArtifacts,
      eventProjection: projection.artifacts,
    })),
    ...(runDirectory ? { runDirectory } : {}),
    source: "events",
  };
}

function fallbackStatus(value: unknown): EvidenceRunRecord["status"] {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "running" ||
    value === "created" ||
    value === "awaiting-approval" ||
    value === "interrupted"
  ) {
    return value;
  }
  return "completed";
}

async function directoryRecord(
  boundaryRoot: string,
  runId: string,
  runDirectory: string,
): Promise<EvidenceRunRecord> {
  const metadata = await readRunJsonRecord(boundaryRoot, runDirectory);
  const registryArtifacts = await artifactRegistryArtifacts(
    boundaryRoot,
    runDirectory,
  );
  const directoryStat = await stat(runDirectory);
  const createdAtFallback =
    (directoryStat.birthtimeMs > 0
      ? directoryStat.birthtime.toISOString()
      : directoryStat.mtime.toISOString());
  const createdAt = normalizedTimestamp(asString(metadata?.createdAt), createdAtFallback);
  const updatedAt = normalizedTimestamp(
    asString(metadata?.updatedAt),
    directoryStat.mtime.toISOString(),
  );
  const gates = Array.isArray(metadata?.gates)
    ? metadata.gates
        .map((value) => {
          const gate = asRecord(value);
          const id = asString(gate.id);
          const stageId = asString(gate.stageId);
          const mode = asString(gate.mode);
          const status = asString(gate.status);
          if (
            !id ||
            !stageId ||
            (mode !== "deterministic" &&
              mode !== "review" &&
              mode !== "review-aggregate" &&
              mode !== "analysis" &&
              mode !== "security") ||
            (status !== "passed" && status !== "failed")
          ) return undefined;
          return normalizeGate(gate as unknown as GateResult);
        })
        .filter((gate): gate is EvidenceGateMetadata => gate !== undefined)
    : [];
  const blocker = asRecord(metadata?.blocker);
  return {
    schemaVersion: 1,
    runId,
    status: metadata ? fallbackStatus(metadata.status) : "interrupted",
    ...(boundedRedactedText(asString(metadata?.workItemId), 200)
      ? { taskId: boundedRedactedText(asString(metadata?.workItemId), 200) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.repoId), 200)
      ? { repositoryId: boundedRedactedText(asString(metadata?.repoId), 200) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.repoName), 300)
      ? { repositoryName: boundedRedactedText(asString(metadata?.repoName), 300) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.repoPath), 1_024)
      ? { repositoryPath: boundedRedactedText(asString(metadata?.repoPath), 1_024) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.flowName), 300)
      ? { flowName: boundedRedactedText(asString(metadata?.flowName), 300) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.flowPath), 1_024)
      ? { flowPath: boundedRedactedText(asString(metadata?.flowPath), 1_024) }
      : {}),
    ...(boundedRedactedText(asString(metadata?.changeRequestUrl), 1_024)
      ? { prUrl: boundedRedactedText(asString(metadata?.changeRequestUrl), 1_024) }
      : {}),
    ...(blockerCategory(asString(blocker.reason))
      ? { blockerCategory: blockerCategory(asString(blocker.reason)) }
      : {}),
    createdAt,
    updatedAt,
    ...(optionalTimestamp(asString(metadata?.terminalAt))
      ? { terminalAt: optionalTimestamp(asString(metadata?.terminalAt)) }
      : {}),
    completedStages: asStringArray(metadata?.completedStages).sort(),
    gates,
    artifacts: artifactMetadata(reconcileArtifactSources({
      registry: registryArtifacts,
      eventProjection: [],
    })),
    runDirectory,
    source: "run-directory",
  };
}

export async function listEvidenceRuns(repoPath: string): Promise<EvidenceRunRecord[]> {
  const resolvedRepoPath = resolve(repoPath);
  const directories = await listRunDirectories(resolvedRepoPath);
  const records: EvidenceRunRecord[] = [];
  const eventPath = eventStorePath(resolvedRepoPath);
  const eventRunIds: string[] = [];
  if (await pathExists(eventPath)) {
    const store = new EventStore(eventPath);
    try {
      for (const runId of store.listRunIds()) {
        validateRunId(runId);
        eventRunIds.push(runId);
        records.push(await eventRecord(
          resolvedRepoPath,
          runId,
          directories.get(runId),
          store,
        ));
      }
    } finally {
      store.close();
    }
  }
  const eventRunIdSet = new Set(eventRunIds);
  for (const [runId, runDirectory] of directories) {
    if (eventRunIdSet.has(runId)) continue;
    records.push(await directoryRecord(
      resolvedRepoPath,
      runId,
      runDirectory,
    ));
  }
  return records.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
  );
}

function contains(value: string | undefined, query: string | undefined): boolean {
  if (!query) return true;
  return (value ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function parseDateFilter(name: "from" | "to", value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid evidence search ${name} timestamp: ${value}`);
  }
  return timestamp;
}

function artifactSearchText(artifact: EvidenceArtifactMetadata): string {
  return [
    artifact.id,
    artifact.name,
    artifact.type,
    artifact.producer,
    artifact.mediaType,
    artifact.stageId,
    artifact.filename,
    artifact.path,
    artifact.sourceUri,
    artifact.sha256,
  ].filter((value): value is string => typeof value === "string").join("\n");
}

export async function searchEvidenceRuns(
  repoPath: string,
  filters: EvidenceSearchFilters = {},
): Promise<EvidenceRunRecord[]> {
  const from = parseDateFilter("from", filters.from);
  const to = parseDateFilter("to", filters.to);
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error("invalid evidence search date range: from must not be after to");
  }
  return (await listEvidenceRuns(repoPath)).filter((run) => {
    const activityAt = Date.parse(run.terminalAt ?? run.updatedAt ?? run.createdAt);
    return (
      contains(run.runId, filters.run) &&
      contains(run.taskId, filters.task) &&
      contains(
        [run.repositoryId, run.repositoryName, run.repositoryPath]
          .filter(Boolean)
          .join("\n"),
        filters.repository,
      ) &&
      contains([run.flowName, run.flowPath].filter(Boolean).join("\n"), filters.flow) &&
      contains(run.status, filters.status) &&
      contains(run.prUrl, filters.pr) &&
      contains(run.blockerCategory, filters.blocker) &&
      (from === undefined || activityAt >= from) &&
      (to === undefined || activityAt <= to) &&
      (!filters.artifact || run.artifacts.some((artifact) =>
        contains(artifactSearchText(artifact), filters.artifact)))
    );
  });
}

export function projectedRunIsTerminal(
  status: EvidenceRunRecord["status"],
): boolean {
  return status === "completed" || status === "failed" ||
    status === "blocked" || status === "cancelled";
}
