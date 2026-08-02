import { formatAge } from "./dashboard.js";
import type { WebRunStatus } from "./runs.js";

export type AgentStabilityReadinessState =
  | "ready"
  | "degraded"
  | "missing"
  | "unknown";

export type AgentStabilityPublicationState =
  | "published"
  | "updated"
  | "local-only"
  | "unknown";

export type AgentStabilityOssStatus = "candidate";

/** Optional artifact readiness signal (may be absent in OSS run summaries). */
export type AgentStabilityArtifactReadinessStatus =
  | "not-applicable"
  | "pending"
  | "partial"
  | "ready"
  | "missing";

export interface AgentStabilityArtifactReadiness {
  status: AgentStabilityArtifactReadinessStatus;
  declaredIds?: string[];
  readyIds?: string[];
  missingIds?: string[];
}

/** Optional publication metadata when a change request or local branch exists. */
export interface AgentStabilityRunPublication {
  state: "published" | "updated";
  branchName?: string;
  headCommit?: string;
  changeRequestUrl?: string;
  prNumber?: number;
}

/** Optional current agent process metadata (runtime/model/state). */
export interface AgentStabilityStageProcess {
  kind: string;
  label: string;
  command?: string;
  runtime?: string;
  model?: string;
  state?: string;
}

/**
 * Optional toolchain preflight snapshot.
 * When missing, runner readiness reports `unknown` rather than inventing signals.
 */
export interface AgentStabilityToolchainPreflight {
  version?: number;
  runId?: string;
  generatedAt?: string;
  repoPath?: string;
  commandEnvironment?: {
    envSource?: string;
    shellMode?: string;
    pathEntryCount?: number;
    repairs?: unknown[];
  };
  toolchainFiles?: Array<{ path?: string; kind?: string }>;
  executables?: Array<{ name: string; available?: boolean; path?: string }>;
}

export interface AgentStabilitySummary {
  active: number;
  blocked: number;
  failed: number;
  incomplete: number;
  completed: number;
  total: number;
}

export interface AgentStabilityAttentionItem {
  runId: string;
  taskId?: string;
  taskTitle?: string;
  repoName?: string;
  status: string;
  currentStage: string;
  blockerReason?: string;
  ageMs?: number;
  ageLabel: string;
  link: string;
}

export interface AgentStabilityFailureCluster {
  key: string;
  dimension: "status" | "stage" | "runtime" | "flow" | "repository";
  value: string;
  count: number;
  runIds: string[];
}

export interface AgentStabilityRunnerReadiness {
  runtime: string;
  model?: string;
  commandStatus?: string;
  readiness: AgentStabilityReadinessState;
  lastRunId?: string;
  lastObservedAt?: string;
  missingTools: string[];
  warnings: string[];
}

export interface AgentStabilityChangeRecord {
  runId: string;
  taskId?: string;
  branchName?: string;
  headCommit?: string;
  changeRequestUrl?: string;
  prNumber?: number;
  publicationState: AgentStabilityPublicationState;
  error?: string;
}

export interface AgentStabilitySelfTestCandidate {
  runId: string;
  kind: "self-test" | "verify" | "doctor" | "test";
  stages: string[];
  readiness?: AgentStabilityArtifactReadinessStatus;
}

export interface AgentStabilityVerificationSummary {
  totalStages: number;
  passed: number;
  failed: number;
  missing: number;
  partial: number;
  unknown: number;
  evidenceReadyRunIds: string[];
  selfTestCandidates: AgentStabilitySelfTestCandidate[];
}

export interface AgentStabilityOssCandidate {
  id: string;
  status: AgentStabilityOssStatus;
  title: string;
  closedProductSignal: string;
  publicContract: string;
  extractionNotes: string;
}

export interface AgentStabilityProjection {
  generatedAt: string;
  summary: AgentStabilitySummary;
  attention: AgentStabilityAttentionItem[];
  failureClusters: AgentStabilityFailureCluster[];
  runnerReadiness: AgentStabilityRunnerReadiness[];
  changeRecords: AgentStabilityChangeRecord[];
  verification: AgentStabilityVerificationSummary;
  ossExtraction: AgentStabilityOssCandidate[];
}

export interface AgentStabilityTimelineStage {
  stageId: string;
  status?: string;
  state?: string;
  hasEvidence?: boolean;
  artifactReadiness?: AgentStabilityArtifactReadiness;
}

export interface AgentStabilityRunInput {
  runId: string;
  sessionId?: string;
  status: WebRunStatus | string;
  taskId?: string;
  workItemId?: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  repoSynthetic?: boolean;
  flowName?: string;
  flowPath?: string;
  currentStage?: string;
  completedStages?: string[];
  branchName?: string;
  publication?: AgentStabilityRunPublication;
  changeRequestUrl?: string;
  prNumber?: number;
  prUrl?: string;
  blocker?: {
    reason?: string;
    message?: string;
    stageId?: string;
    runtime?: string;
  };
  currentProcess?: Pick<
    AgentStabilityStageProcess,
    "kind" | "label" | "command" | "runtime" | "model" | "state"
  >;
  currentArtifactReadiness?: AgentStabilityArtifactReadiness;
  toolchainPreflight?: AgentStabilityToolchainPreflight;
  timeline?: AgentStabilityTimelineStage[];
  startedAt?: string;
  completedAt?: string;
  statusSummary?: string;
  inputs?: Record<string, unknown>;
}

export interface AgentStabilityTaskInput {
  id: string;
  title: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  repoSynthetic?: boolean;
}

export interface AgentStabilityRepositoryInput {
  id: string;
  name: string;
  path?: string;
  synthetic?: boolean;
}

export interface BuildAgentStabilityProjectionInput {
  runs?: AgentStabilityRunInput[];
  tasks?: AgentStabilityTaskInput[];
  repositories?: AgentStabilityRepositoryInput[];
  now?: Date | string;
}

export const AGENT_STABILITY_OSS_CANDIDATES: AgentStabilityOssCandidate[] = [
  {
    id: "protocol",
    status: "candidate",
    title: "Event schema and heartbeat contracts",
    closedProductSignal:
      "Run event store, heartbeat payloads, and projected run status in the Web Console.",
    publicContract:
      "Stable event schema, heartbeat contract, and run projection shape for external runners.",
    extractionNotes:
      "Extract schema and projection types without Web Console routing or auth assumptions.",
  },
  {
    id: "runner-lifecycle",
    status: "candidate",
    title: "Runner lifecycle, registration, and capability model",
    closedProductSignal:
      "Runtime process state, capability preflight, and stage execution lifecycle recorded per run.",
    publicContract:
      "Runner registration, capability advertisement, and lifecycle state machine for nitely-runner.",
    extractionNotes:
      "Keep control-plane ownership out of the package; expose only lifecycle and capability contracts.",
  },
  {
    id: "evidence-metadata",
    status: "candidate",
    title: "Audit and evidence metadata protocol",
    closedProductSignal:
      "Artifact readiness, evidence paths, gate results, and verification stage metadata.",
    publicContract:
      "Metadata-first evidence protocol with IDs, media types, readiness, and counts only.",
    extractionNotes:
      "Do not export raw log bodies or private artifact contents in the public contract.",
  },
  {
    id: "connector-interface",
    status: "candidate",
    title: "Connector interface with local rehearsal and mock support",
    closedProductSignal:
      "Provider connections, SCM publication metadata, and local demo/golden-path rehearsal paths.",
    publicContract:
      "Connector interface with mock/stub modes and local rehearsal fixtures.",
    extractionNotes:
      "Strip hosted credentials and multi-tenant secrets; keep interface + local stub contracts.",
  },
  {
    id: "doctor",
    status: "candidate",
    title: "Runner doctor and black-box self-test suite",
    closedProductSignal:
      "Toolchain preflight, self-test/verify/doctor stages, and runner readiness diagnostics.",
    publicContract:
      "nitely-runner doctor command and black-box self-test suite over recorded readiness signals.",
    extractionNotes:
      "Ship as a standalone diagnostic suite that consumes readiness metadata, not private logs.",
  },
];

const ATTENTION_STATUSES = new Set(["blocked", "failed", "incomplete", "interrupted", "cancelled"]);
const FAILURE_STATUSES = new Set(["blocked", "failed"]);
const ACTIVE_STATUSES = new Set(["running", "awaiting-approval"]);
const INCOMPLETE_STATUSES = new Set(["incomplete", "interrupted", "cancelled"]);
const SELF_TEST_PATTERN = /test|verify|self-test|doctor/i;

function asDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function isSyntheticRun(
  run: AgentStabilityRunInput,
  syntheticRepoIds: Set<string>,
  syntheticRepoPaths: Set<string>,
): boolean {
  if (run.repoSynthetic === true) return true;
  if (run.repoId !== undefined && syntheticRepoIds.has(run.repoId)) return true;
  if (run.repoPath !== undefined && syntheticRepoPaths.has(run.repoPath)) return true;
  return false;
}

function stageLabel(run: AgentStabilityRunInput): string {
  return run.currentStage?.trim() || run.blocker?.stageId?.trim() || "unknown-stage";
}

function runtimeLabel(run: AgentStabilityRunInput): string {
  return (
    run.currentProcess?.runtime?.trim() ||
    run.blocker?.runtime?.trim() ||
    "unknown"
  );
}

function flowLabel(run: AgentStabilityRunInput): string {
  return run.flowName?.trim() || run.flowPath?.trim() || "unknown";
}

function repositoryLabel(run: AgentStabilityRunInput): string {
  return run.repoName?.trim() || run.repoId?.trim() || "unknown";
}

function blockerReason(run: AgentStabilityRunInput): string | undefined {
  return run.blocker?.message?.trim() || run.blocker?.reason?.trim() || undefined;
}

function itemAgeMs(now: Date, timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return Math.max(0, now.getTime() - parsed.getTime());
}

function attentionPriority(status: string): number {
  switch (status) {
    case "blocked":
      return 0;
    case "failed":
      return 1;
    case "interrupted":
      return 2;
    case "incomplete":
      return 3;
    case "cancelled":
      return 4;
    default:
      return 5;
  }
}

function bumpCluster(
  clusters: Map<string, AgentStabilityFailureCluster>,
  dimension: AgentStabilityFailureCluster["dimension"],
  value: string,
  runId: string,
): void {
  const key = `${dimension}:${value}`;
  const existing = clusters.get(key);
  if (existing) {
    existing.count += 1;
    existing.runIds.push(runId);
    return;
  }
  clusters.set(key, {
    key,
    dimension,
    value,
    count: 1,
    runIds: [runId],
  });
}

function normalizeRuntime(runtime: string): string {
  const lowered = runtime.toLowerCase();
  if (lowered === "codex" || lowered === "grok" || lowered === "glm") return lowered;
  if (runtime === "unknown") return "unknown";
  return runtime;
}

function readinessFromPreflight(
  preflight: AgentStabilityToolchainPreflight | undefined,
): {
  readiness: AgentStabilityReadinessState;
  missingTools: string[];
  warnings: string[];
  commandStatus?: string;
} {
  if (!preflight) {
    return { readiness: "unknown", missingTools: [], warnings: [] };
  }

  const executables = preflight.executables ?? [];
  const missingTools = executables
    .filter((executable) => executable.available !== true)
    .map((executable) => executable.name)
    .filter(Boolean);

  const warnings: string[] = [];
  if ((preflight.toolchainFiles ?? []).length === 0) {
    warnings.push("no-toolchain-files");
  }
  if ((preflight.commandEnvironment?.repairs?.length ?? 0) > 0) {
    warnings.push("environment-repairs");
  }

  if (missingTools.length === 0) {
    return {
      readiness: warnings.length > 0 ? "degraded" : "ready",
      missingTools: [],
      warnings,
      commandStatus: "available",
    };
  }

  const availableCount = executables.filter(
    (executable) => executable.available === true,
  ).length;
  if (availableCount === 0) {
    return {
      readiness: "missing",
      missingTools,
      warnings,
      commandStatus: "missing-tools",
    };
  }

  return {
    readiness: "degraded",
    missingTools,
    warnings,
    commandStatus: "partial-tools",
  };
}

function publicationStateForRun(
  run: AgentStabilityRunInput,
): AgentStabilityPublicationState | undefined {
  const url =
    run.publication?.changeRequestUrl ??
    run.changeRequestUrl ??
    run.prUrl;
  const branch =
    run.publication?.branchName ??
    run.branchName;
  const headCommit = run.publication?.headCommit;
  const publication = run.publication;

  if (url) {
    if (publication?.state === "updated") return "updated";
    if (publication?.state === "published") return "published";
    return "published";
  }

  if (branch || headCommit) {
    return "local-only";
  }

  if (publication) return "unknown";
  return undefined;
}

function isVerificationStageName(name: string): boolean {
  return SELF_TEST_PATTERN.test(name);
}

function selfTestKind(stages: string[]): AgentStabilitySelfTestCandidate["kind"] {
  const joined = stages.join(" ");
  if (/self-test/i.test(joined)) return "self-test";
  if (/doctor/i.test(joined)) return "doctor";
  if (/verify/i.test(joined)) return "verify";
  return "test";
}

function collectVerification(
  runs: AgentStabilityRunInput[],
): AgentStabilityVerificationSummary {
  const summary: AgentStabilityVerificationSummary = {
    totalStages: 0,
    passed: 0,
    failed: 0,
    missing: 0,
    partial: 0,
    unknown: 0,
    evidenceReadyRunIds: [],
    selfTestCandidates: [],
  };

  for (const run of runs) {
    const stageNames = new Set<string>();
    if (run.currentStage && isVerificationStageName(run.currentStage)) {
      stageNames.add(run.currentStage);
    }
    for (const stage of run.completedStages ?? []) {
      if (isVerificationStageName(stage)) stageNames.add(stage);
    }
    for (const item of run.timeline ?? []) {
      if (isVerificationStageName(item.stageId)) stageNames.add(item.stageId);
    }
    if (run.flowName && isVerificationStageName(run.flowName)) {
      stageNames.add(run.flowName);
    }

    const timelineVerification = (run.timeline ?? []).filter((item) =>
      isVerificationStageName(item.stageId),
    );

    const classify = (
      readiness: AgentStabilityArtifactReadinessStatus | undefined,
      status: string | undefined,
      hasEvidence?: boolean,
    ): "passed" | "failed" | "missing" | "partial" | "unknown" => {
      if (status === "failed" || status === "blocked") return "failed";
      if (readiness === "partial") return "partial";
      if (readiness === "missing") return "missing";
      if (readiness === "ready" || hasEvidence === true) return "passed";
      if (status === "completed") return "passed";
      if (readiness === "pending" || readiness === "not-applicable") return "unknown";
      return "unknown";
    };

    if (timelineVerification.length > 0) {
      for (const item of timelineVerification) {
        summary.totalStages += 1;
        const bucket = classify(
          item.artifactReadiness?.status,
          item.status ?? item.state,
          item.hasEvidence,
        );
        summary[bucket] += 1;
      }
    } else if (stageNames.size > 0 || run.currentArtifactReadiness) {
      // Fall back to run-level readiness for verification-named stages.
      const count = Math.max(1, stageNames.size || (run.currentArtifactReadiness ? 1 : 0));
      summary.totalStages += count;
      const bucket = classify(
        run.currentArtifactReadiness?.status,
        run.status,
        run.currentArtifactReadiness?.status === "ready",
      );
      summary[bucket] += count;
    }

    if (
      run.currentArtifactReadiness?.status === "ready" ||
      (run.timeline ?? []).some(
        (item) => item.artifactReadiness?.status === "ready" || item.hasEvidence === true,
      )
    ) {
      summary.evidenceReadyRunIds.push(run.runId);
    }

    if (stageNames.size > 0) {
      summary.selfTestCandidates.push({
        runId: run.runId,
        kind: selfTestKind([...stageNames]),
        stages: [...stageNames].sort(),
        ...(run.currentArtifactReadiness?.status
          ? { readiness: run.currentArtifactReadiness.status }
          : {}),
      });
    }
  }

  summary.evidenceReadyRunIds = [...new Set(summary.evidenceReadyRunIds)];
  return summary;
}

export function buildAgentStabilityProjection(
  input: BuildAgentStabilityProjectionInput = {},
): AgentStabilityProjection {
  const now = asDate(input.now);
  const repositories = input.repositories ?? [];
  const syntheticRepoIds = new Set(
    repositories.filter((repo) => repo.synthetic === true).map((repo) => repo.id),
  );
  const syntheticRepoPaths = new Set(
    repositories
      .filter((repo) => repo.synthetic === true && typeof repo.path === "string")
      .map((repo) => repo.path as string),
  );

  const tasksById = new Map(
    (input.tasks ?? [])
      .filter(
        (task) =>
          task.repoSynthetic !== true &&
          !(task.repoId !== undefined && syntheticRepoIds.has(task.repoId)) &&
          !(task.repoPath !== undefined && syntheticRepoPaths.has(task.repoPath)),
      )
      .map((task) => [task.id, task] as const),
  );

  const runs = (input.runs ?? []).filter(
    (run) => !isSyntheticRun(run, syntheticRepoIds, syntheticRepoPaths),
  );

  const summary: AgentStabilitySummary = {
    active: 0,
    blocked: 0,
    failed: 0,
    incomplete: 0,
    completed: 0,
    total: runs.length,
  };

  for (const run of runs) {
    if (ACTIVE_STATUSES.has(run.status)) summary.active += 1;
    else if (run.status === "blocked") summary.blocked += 1;
    else if (run.status === "failed") summary.failed += 1;
    else if (INCOMPLETE_STATUSES.has(run.status)) summary.incomplete += 1;
    else if (run.status === "completed") summary.completed += 1;
  }

  const attention: AgentStabilityAttentionItem[] = runs
    .filter((run) => ATTENTION_STATUSES.has(run.status))
    .map((run) => {
      const taskId = run.taskId ?? run.workItemId;
      const task = taskId ? tasksById.get(taskId) : undefined;
      const ageMs = itemAgeMs(now, run.startedAt ?? run.completedAt);
      return {
        runId: run.runId,
        ...(taskId ? { taskId } : {}),
        ...(task?.title ? { taskTitle: task.title } : {}),
        ...(run.repoName ? { repoName: run.repoName } : {}),
        status: run.status,
        currentStage: stageLabel(run),
        ...(blockerReason(run) ? { blockerReason: blockerReason(run) } : {}),
        ...(ageMs !== undefined ? { ageMs } : {}),
        ageLabel: formatAge(ageMs),
        link: `/runs/${encodeURIComponent(run.runId)}`,
      };
    })
    .sort((left, right) => {
      const priority = attentionPriority(left.status) - attentionPriority(right.status);
      if (priority !== 0) return priority;
      return (right.ageMs ?? -1) - (left.ageMs ?? -1);
    });

  const clusters = new Map<string, AgentStabilityFailureCluster>();
  for (const run of runs.filter((candidate) => FAILURE_STATUSES.has(candidate.status))) {
    bumpCluster(clusters, "status", run.status, run.runId);
    bumpCluster(clusters, "stage", stageLabel(run), run.runId);
    bumpCluster(clusters, "runtime", normalizeRuntime(runtimeLabel(run)), run.runId);
    bumpCluster(clusters, "flow", flowLabel(run), run.runId);
    bumpCluster(clusters, "repository", repositoryLabel(run), run.runId);
  }
  const failureClusters = [...clusters.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.key.localeCompare(right.key);
  });

  const readinessByRuntime = new Map<
    string,
    {
      runtime: string;
      model?: string;
      lastRunId?: string;
      lastObservedAt?: string;
      lastObservedMs: number;
      preflight?: AgentStabilityToolchainPreflight;
      processState?: string;
    }
  >();

  for (const run of runs) {
    const runtime = normalizeRuntime(runtimeLabel(run));
    if (runtime === "unknown" && !run.toolchainPreflight && !run.currentProcess) {
      continue;
    }
    const observedAt = run.completedAt ?? run.startedAt ?? run.toolchainPreflight?.generatedAt;
    const observedMs = observedAt ? new Date(observedAt).getTime() : 0;
    const existing = readinessByRuntime.get(runtime);
    if (!existing || observedMs >= existing.lastObservedMs) {
      readinessByRuntime.set(runtime, {
        runtime,
        ...(run.currentProcess?.model ? { model: run.currentProcess.model } : {}),
        lastRunId: run.runId,
        ...(observedAt ? { lastObservedAt: observedAt } : {}),
        lastObservedMs: Number.isFinite(observedMs) ? observedMs : 0,
        ...(run.toolchainPreflight ? { preflight: run.toolchainPreflight } : {}),
        ...(run.currentProcess?.state ? { processState: run.currentProcess.state } : {}),
      });
    } else if (existing && !existing.preflight && run.toolchainPreflight) {
      existing.preflight = run.toolchainPreflight;
    }
  }

  const runnerReadiness: AgentStabilityRunnerReadiness[] = [...readinessByRuntime.values()]
    .map((entry) => {
      const derived = readinessFromPreflight(entry.preflight);
      return {
        runtime: entry.runtime,
        ...(entry.model ? { model: entry.model } : {}),
        ...(derived.commandStatus
          ? { commandStatus: derived.commandStatus }
          : entry.processState
            ? { commandStatus: entry.processState }
            : {}),
        readiness: derived.readiness,
        ...(entry.lastRunId ? { lastRunId: entry.lastRunId } : {}),
        ...(entry.lastObservedAt ? { lastObservedAt: entry.lastObservedAt } : {}),
        missingTools: derived.missingTools,
        warnings: derived.warnings,
      };
    })
    .sort((left, right) => left.runtime.localeCompare(right.runtime));

  const changeRecords: AgentStabilityChangeRecord[] = [];
  for (const run of runs) {
    const publicationState = publicationStateForRun(run);
    if (!publicationState) continue;
    const branchName = run.publication?.branchName ?? run.branchName;
    const headCommit = run.publication?.headCommit;
    const changeRequestUrl =
      run.publication?.changeRequestUrl ?? run.changeRequestUrl ?? run.prUrl;
    const prNumber = run.publication?.prNumber ?? run.prNumber;
    const error =
      typeof run.statusSummary === "string" &&
      /publish|change request|pull request/i.test(run.statusSummary) &&
      /fail|error/i.test(run.statusSummary)
        ? run.statusSummary
        : undefined;

    changeRecords.push({
      runId: run.runId,
      ...(run.taskId ?? run.workItemId
        ? { taskId: run.taskId ?? run.workItemId }
        : {}),
      ...(branchName ? { branchName } : {}),
      ...(headCommit ? { headCommit } : {}),
      ...(changeRequestUrl ? { changeRequestUrl } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      publicationState,
      ...(error ? { error } : {}),
    });
  }

  return {
    generatedAt: now.toISOString(),
    summary,
    attention,
    failureClusters,
    runnerReadiness,
    changeRecords,
    verification: collectVerification(runs),
    ossExtraction: AGENT_STABILITY_OSS_CANDIDATES.map((candidate) => ({ ...candidate })),
  };
}
