import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { materializeDueSchedules } from "../schedules/materialize.js";

import { EventStore } from "../events/store.js";
import { createScmProvider } from "../scm/registry.js";
import type { ChangeRequestStatus, ScmProvider } from "../scm/types.js";
import type { ProviderConnectionStore } from "../providers/types.js";
import {
  resumeRun as defaultResumeRun,
  runFlow as defaultRunFlow,
} from "../run/run-flow.js";
import type {
  ResumeRunInput,
  RunFlowDependencies,
  RunFlowInput,
  RunFlowResult,
} from "../run/run-flow.js";
import {
  eventStorePath,
  projectRun,
  type ProjectedRun,
} from "../run/project.js";
import type { RunPreflightReport } from "../run/preflight.js";
import {
  evaluateWorkItemRunStarts,
  type RunEligibilityDecision,
} from "../run/eligibility.js";
import {
  admitWorkItemRun,
  reconcileTerminalWorkItemRun,
  settleWorkItemRun,
} from "../run/admission.js";
import {
  finalizeWorkItemRunCandidate,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  prepareWorkItemRunCandidates,
  updateWorkItemRunState,
  type PreparedLegacyWorkItemRunCandidate,
} from "../work-items/access.js";
import { workItemDependencyGuards } from "../work-items/candidate-version.js";
import type {
  WorkItemRecord,
  WorkItemStoreKind,
} from "../work-items/types.js";
import type { SpecReadinessGateResult } from "../spec-artifacts/readiness.js";
import type { StoredWorkItemRunStatePatch } from "../work-items/access.js";
import type { ChangeRequestStatusFetcher } from "./completion.js";
import {
  ResumeClaimStore,
  resumeClaimStorePath,
} from "./resume-claim.js";
import {
  cooldownUntilForRunInput,
  runtimeKey,
  SchedulerCooldownStore,
  schedulerCooldownStorePath,
} from "./cooldown.js";
import {
  SchedulerLeaseStore,
  schedulerLeaseStorePath,
} from "./lease.js";

export interface SchedulerRunSummary {
  startedTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  blockedTaskIds: string[];
  cooldownTaskIds?: string[];
  cooldownUntil?: Record<string, string>;
  awaitingApprovalTaskIds: string[];
  preflight?: Record<string, RunPreflightReport>;
  specReadiness?: Record<string, SpecReadinessGateResult>;
  eligibility?: Record<string, RunEligibilityDecision>;
  taskErrors?: Record<string, SchedulerTaskError>;
}

export interface SchedulerTaskError {
  code: "scheduler_task_processing_failed";
  message: "Scheduler could not process this Work item";
}

export interface RunSchedulerOnceInput {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  candidateIds?: readonly string[];
  maxConcurrentTasks?: number;
  usageLimitCooldownMs?: number;
  concurrency?: {
    global?: number;
    repository?: number;
    flow?: number;
    leaseTtlMs?: number;
  };
  getConflictKeys?: (task: WorkItemRecord) => readonly string[];
  executionBackend?: string;
  providerStore?: ProviderConnectionStore;
  scmProvider?: ScmProvider;
  getChangeRequestStatus?: ChangeRequestStatusFetcher;
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>;
  createRunId?: () => string;
  resumeRun?: (input: ResumeRunInput) => Promise<RunFlowResult>;
  now?: () => Date;
}

export const MAX_SCHEDULER_CONCURRENCY = 64;

export function resolveMaxConcurrentTasks(value: number | undefined): number {
  if (value === undefined) return 1;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SCHEDULER_CONCURRENCY
  ) {
    throw new Error(
      `maxConcurrentTasks must be an integer between 1 and ${MAX_SCHEDULER_CONCURRENCY}`,
    );
  }
  return value;
}

function resolveUsageLimitCooldownMs(value: number | undefined): number {
  const resolved = value ?? 5 * 60_000;
  if (!Number.isInteger(resolved) || resolved < 1_000 || resolved > 86_400_000) {
    throw new Error("usageLimitCooldownMs must be an integer between 1000 and 86400000");
  }
  return resolved;
}

function resolveConcurrency(input: RunSchedulerOnceInput): {
  global: number;
  repository: number;
  flow: number;
  leaseTtlMs: number;
} {
  const global = resolveMaxConcurrentTasks(
    input.concurrency?.global ?? input.maxConcurrentTasks,
  );
  const repository = resolveMaxConcurrentTasks(
    input.concurrency?.repository ?? global,
  );
  const flow = resolveMaxConcurrentTasks(input.concurrency?.flow ?? repository);
  const leaseTtlMs = input.concurrency?.leaseTtlMs ?? 60_000;
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 86_400_000) {
    throw new Error("scheduler leaseTtlMs must be an integer between 1000 and 86400000");
  }
  return { global, repository, flow, leaseTtlMs };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireSchedulerLease(input: {
  repoPath: string;
  task: WorkItemRecord;
  owner: string;
  repositoryLimit: number;
  flowLimit: number;
  ttlMs: number;
  getConflictKeys?: (task: WorkItemRecord) => readonly string[];
  now: () => Date;
}): Promise<SchedulerLeaseStore> {
  await mkdir(resolve(input.repoPath, ".nitely"), { recursive: true });
  const store = new SchedulerLeaseStore(schedulerLeaseStorePath(input.repoPath));
  while (!store.acquire({
    taskId: input.task.id,
    owner: input.owner,
    flowKey: input.task.flowPath,
    resourceKeys: input.getConflictKeys?.(input.task) ?? [],
    repositoryLimit: input.repositoryLimit,
    flowLimit: input.flowLimit,
    now: input.now(),
    ttlMs: input.ttlMs,
  })) {
    await sleep(25);
  }
  return store;
}

async function runWithConcurrency<T>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      await run(values[index]!);
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

function sortSummaryTaskIds(
  summary: SchedulerRunSummary,
  tasks: readonly WorkItemRecord[],
): void {
  const rank = new Map(
    schedulerCandidates([...tasks]).map((task, index) => [task.id, index]),
  );
  const compare = (left: string, right: string) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right);
  summary.startedTaskIds.sort(compare);
  summary.completedTaskIds.sort(compare);
  summary.failedTaskIds.sort(compare);
  summary.blockedTaskIds.sort(compare);
  summary.cooldownTaskIds?.sort(compare);
  summary.awaitingApprovalTaskIds.sort(compare);
}

async function getChangeRequestStatusFromProvider(
  provider: ScmProvider,
  url: string,
): Promise<ChangeRequestStatus> {
  if (!provider.getChangeRequestStatus) {
    return { provider: "unknown", state: "unknown", merged: false };
  }
  return provider.getChangeRequestStatus({ target: url });
}

async function loadSchedulerWorkItems(input: RunSchedulerOnceInput) {
  const tasks = await listUnifiedWorkItems(input.repoPath);
  const provider =
    input.scmProvider ??
    createScmProvider("github", {
      ...(input.providerStore ? { store: input.providerStore } : {}),
    });
  const getStatus =
    input.getChangeRequestStatus ??
    ((url: string) => getChangeRequestStatusFromProvider(provider, url));
  return { tasks, getStatus };
}

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

function schedulerCandidates(tasks: WorkItemRecord[]): WorkItemRecord[] {
  return [...tasks].sort((left, right) => {
    const priority =
      priorityRank[left.priority ?? "P2"] -
      priorityRank[right.priority ?? "P2"];
    return priority !== 0 ? priority : left.createdAt.localeCompare(right.createdAt);
  });
}

function isDependencyOnlyBlock(decision: RunEligibilityDecision): boolean {
  return (
    decision.blockers.length > 0 &&
    decision.blockers.every(
      (reason) =>
        reason.kind === "missing" ||
        reason.kind === "failed" ||
        reason.kind === "incomplete",
    )
  );
}

async function updateSchedulerWorkItem(
  repoPath: string,
  id: string,
  patch: StoredWorkItemRunStatePatch,
  frozenStart?: Pick<PreparedLegacyWorkItemRunCandidate, "activePlanningBaseline">,
  storeKind?: WorkItemStoreKind,
): Promise<WorkItemRecord> {
  return await updateWorkItemRunState(
    repoPath,
    id,
    {
      ...patch,
      ...(frozenStart
        ? { activePlanningBaseline: frozenStart.activePlanningBaseline }
        : {}),
    },
    storeKind,
  );
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function zonedClockTime(value: string, now: Date): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s+\(([^)]+)\))?$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) {
    return undefined;
  }
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);

  const timeZone = match[4]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const current = zonedParts(now, timeZone);
    let year = Number(current.year);
    let month = Number(current.month);
    let day = Number(current.day);
    const toInstant = (wallTime: number): number => {
      let candidate = wallTime;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const displayed = zonedParts(new Date(candidate), timeZone);
        const displayedAsUtc = Date.UTC(
          Number(displayed.year),
          Number(displayed.month) - 1,
          Number(displayed.day),
          Number(displayed.hour),
          Number(displayed.minute),
          Number(displayed.second),
        );
        candidate = wallTime - (displayedAsUtc - candidate);
      }
      return candidate;
    };

    let candidate = toInstant(Date.UTC(year, month - 1, day, hour, minute));
    if (candidate < now.getTime()) {
      const next = new Date(Date.UTC(year, month - 1, day + 1));
      year = next.getUTCFullYear();
      month = next.getUTCMonth() + 1;
      day = next.getUTCDate();
      candidate = toInstant(Date.UTC(year, month - 1, day, hour, minute));
    }
    return new Date(candidate);
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | undefined, now: Date): Date | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  const relative = /\b(?:in\s+)?(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const multiplier =
      unit === "ms" || unit.startsWith("millisecond") || unit.startsWith("msec")
        ? 1
        : unit === "s" || unit.startsWith("second") || unit.startsWith("sec")
          ? 1_000
          : unit === "m" || unit.startsWith("minute") || unit.startsWith("min")
            ? 60_000
            : unit === "h" || unit.startsWith("hour") || unit.startsWith("hr")
              ? 60 * 60_000
              : 24 * 60 * 60_000;
    return new Date(now.getTime() + amount * multiplier);
  }

  const clockTime = zonedClockTime(text, now);
  if (clockTime) return clockTime;

  const normalized = text.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

function usageLimitCooldown(input: {
  task: WorkItemRecord;
  eventStore: EventStore;
  now: Date;
  persisted?: ReadonlyMap<string, Date>;
}): { runId: string; retryAt: Date; runtime?: string } | undefined {
  if (!input.task.latestRunId || input.task.status === "completed") {
    return undefined;
  }
  const events = input.eventStore.list(input.task.latestRunId);
  if (events.length === 0) {
    return undefined;
  }
  const projection: ProjectedRun = projectRun(events);
  if (
    projection.status !== "blocked" ||
    projection.blocker?.reason !== "agent_usage_limit"
  ) {
    return undefined;
  }
  const retryAt = parseRetryAfter(projection.blocker.retryAfter, input.now) ??
    (projection.blocker.runtime
      ? input.persisted?.get(runtimeKey(projection.blocker.runtime))
      : undefined);
  if (!retryAt) {
    return undefined;
  }
  return {
    runId: input.task.latestRunId,
    retryAt,
    ...(projection.blocker?.runtime
      ? { runtime: projection.blocker.runtime }
      : {}),
  };
}

function usageLimitBlockedRun(input: {
  task: WorkItemRecord;
  eventStore: EventStore;
  now: Date;
  persisted?: ReadonlyMap<string, Date>;
}): { runId: string; retryAt: Date; runtime?: string } | undefined {
  const cooldown = usageLimitCooldown(input);
  if (!cooldown || cooldown.retryAt.getTime() > input.now.getTime()) {
    return undefined;
  }
  return {
    runId: cooldown.runId,
    retryAt: cooldown.retryAt,
    ...(cooldown.runtime ? { runtime: cooldown.runtime } : {}),
  };
}

function activeUsageLimitCooldowns(
  repoPath: string,
  tasks: readonly WorkItemRecord[],
  now: Date,
  defaultCooldownMs: number,
): Map<string, Date> {
  const cooldowns = new Map<string, Date>();
  const cooldownStore = new SchedulerCooldownStore(
    schedulerCooldownStorePath(repoPath),
  );
  for (const cooldown of cooldownStore.list()) {
    cooldowns.set(runtimeKey(cooldown.runtime), new Date(cooldown.until));
  }
  const eventStore = new EventStore(eventStorePath(repoPath));
  try {
    for (const task of tasks) {
      const events = task.latestRunId ? eventStore.list(task.latestRunId) : [];
      if (events.length === 0) continue;
      const projection = projectRun(events);
      if (projection.status !== "blocked" || projection.blocker?.reason !== "agent_usage_limit") {
        continue;
      }
      const runtime = projection.blocker.runtime;
      if (!runtime) continue;
      const key = runtimeKey(runtime);
      const retryAt = parseRetryAfter(projection.blocker.retryAfter, now) ??
        cooldowns.get(key) ??
        new Date(now.getTime() + defaultCooldownMs);
      if (!cooldowns.has(key) || retryAt.getTime() > (cooldowns.get(key)?.getTime() ?? 0)) {
        cooldownStore.set(runtime, retryAt);
        cooldowns.set(key, retryAt);
      }
      if (!events.some((event) =>
        event.type === "scheduler.cooldown" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { until?: unknown }).until === retryAt.toISOString()
      )) {
        eventStore.append({
          runId: task.latestRunId as string,
          type: "scheduler.cooldown",
          payload: {
            runtime,
            until: retryAt.toISOString(),
            reason: "agent_usage_limit",
          },
        });
      }
    }
  } finally {
    eventStore.close();
    cooldownStore.close();
  }
  return cooldowns;
}

function clearUsageLimitCooldown(repoPath: string, runtime: string | undefined): void {
  if (!runtime) return;
  const store = new SchedulerCooldownStore(schedulerCooldownStorePath(repoPath));
  try {
    store.clear(runtimeKey(runtime));
  } finally {
    store.close();
  }
}

async function applyRunResult(input: {
  repoPath: string;
  task: WorkItemRecord;
  result: RunFlowResult;
  summary: SchedulerRunSummary;
  storeKind?: WorkItemStoreKind;
}): Promise<void> {
  if (input.result.status === "awaiting-approval") {
    await updateSchedulerWorkItem(
      input.repoPath,
      input.task.id,
      {
        status: "running",
        latestRunId: input.result.runId,
      },
      {
        activePlanningBaseline: input.task.activePlanningBaseline,
      },
      input.storeKind,
    );
    input.summary.awaitingApprovalTaskIds.push(input.task.id);
    return;
  }
  await updateSchedulerWorkItem(
    input.repoPath,
    input.task.id,
    {
      status: "completed",
      latestRunId: input.result.runId,
      changeRequestUrl: input.result.changeRequestUrl,
    },
    undefined,
    input.storeKind,
  );
  input.summary.completedTaskIds.push(input.task.id);
}

function assertAdmittedRunId(expectedRunId: string, actualRunId: string): void {
  if (actualRunId !== expectedRunId) {
    throw new Error(
      `runner returned Run ${actualRunId} instead of admitted Run ${expectedRunId}`,
    );
  }
}

function terminalProjectionAfterRunnerError(
  repoPath: string,
  runId: string,
  error: unknown,
  terminalAfterSequence?: number,
): ProjectedRun {
  const eventStore = new EventStore(eventStorePath(repoPath));
  try {
    const events = eventStore.list(runId);
    const projection = projectRun(events);
    const terminalRecorded =
      terminalAfterSequence === undefined
        ? projection.status === "completed" ||
          projection.status === "failed" ||
          projection.status === "blocked" ||
          projection.status === "cancelled"
        : events.some(
            (event) =>
              event.sequence > terminalAfterSequence &&
              (event.type === "run.completed" ||
                event.type === "run.failed" ||
                event.type === "run.blocked" ||
                event.type === "run.cancelled"),
          );
    if (terminalRecorded) {
      return projection;
    }
    eventStore.append({
      runId,
      type: "run.failed",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return projectRun(eventStore.list(runId));
  } finally {
    eventStore.close();
  }
}

function latestRunEventSequence(repoPath: string, runId: string): number {
  const eventStore = new EventStore(eventStorePath(repoPath));
  try {
    return eventStore.latest(runId)?.sequence ?? 0;
  } finally {
    eventStore.close();
  }
}

async function settleResumedRunResult(input: {
  repoPath: string;
  task: WorkItemRecord;
  result: RunFlowResult;
  summary: SchedulerRunSummary;
}): Promise<void> {
  if (input.result.status === "awaiting-approval") {
    await applyRunResult(input);
    return;
  }
  assertAdmittedRunId(input.task.latestRunId ?? input.result.runId, input.result.runId);
  const settled = await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.task.id,
    runId: input.result.runId,
    status: "completed",
    ...(input.result.changeRequestUrl
      ? { changeRequestUrl: input.result.changeRequestUrl }
      : {}),
  });
  if (settled.settled) {
    input.summary.completedTaskIds.push(input.task.id);
    return;
  }
  if (settled.reason === "not-admitted") {
    await applyRunResult({ ...input, storeKind: settled.storeKind });
    return;
  }
  throw new Error(`resumed Run no longer owns Work item: ${input.result.runId}`);
}

async function settleRunnerErrorProjection(input: {
  repoPath: string;
  task: WorkItemRecord;
  runId: string;
  projection: ProjectedRun;
  summary: SchedulerRunSummary;
}): Promise<void> {
  if (input.projection.status === "blocked") {
    input.summary.blockedTaskIds.push(input.task.id);
    return;
  }
  const status = input.projection.status === "completed" ? "completed" : "failed";
  const settled = await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.task.id,
    runId: input.runId,
    status,
    ...(input.projection.changeRequestUrl
      ? { changeRequestUrl: input.projection.changeRequestUrl }
      : {}),
  });
  if (!settled.settled && settled.reason === "not-admitted") {
    await updateSchedulerWorkItem(
      input.repoPath,
      input.task.id,
      {
        status,
        latestRunId: input.runId,
        ...(input.projection.changeRequestUrl
          ? { changeRequestUrl: input.projection.changeRequestUrl }
          : {}),
      },
      undefined,
      settled.storeKind,
    );
  } else if (!settled.settled) {
    throw new Error(`Run no longer owns Work item: ${input.runId}`);
  }
  (status === "completed"
    ? input.summary.completedTaskIds
    : input.summary.failedTaskIds
  ).push(input.task.id);
}

async function applyAdmittedRunResult(input: {
  repoPath: string;
  task: WorkItemRecord;
  admittedRunId: string;
  result: RunFlowResult;
  summary: SchedulerRunSummary;
}): Promise<void> {
  assertAdmittedRunId(input.admittedRunId, input.result.runId);
  if (input.result.status === "awaiting-approval") {
    input.summary.awaitingApprovalTaskIds.push(input.task.id);
    return;
  }
  const settled = await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.task.id,
    runId: input.admittedRunId,
    status: "completed",
    ...(input.result.changeRequestUrl
      ? { changeRequestUrl: input.result.changeRequestUrl }
      : {}),
  });
  if (!settled.settled) {
    throw new Error(`admitted Run no longer owns Work item: ${input.admittedRunId}`);
  }
  input.summary.completedTaskIds.push(input.task.id);
}

async function resumeDueUsageLimitRuns(input: {
  repoPath: string;
  tasks: WorkItemRecord[];
  candidateIds?: ReadonlySet<string>;
  attempted: Set<string>;
  summary: SchedulerRunSummary;
  resumeRun: (input: ResumeRunInput) => Promise<RunFlowResult>;
  now: Date;
  executionBackend?: string;
  persistedCooldowns?: ReadonlyMap<string, Date>;
}): Promise<boolean> {
  const eventStore = new EventStore(eventStorePath(input.repoPath));
  const candidates = (() => {
    try {
      return input.tasks
        .map((task) => ({
          task,
          blocked: usageLimitBlockedRun({
            task,
            eventStore,
            now: input.now,
            persisted: input.persistedCooldowns,
          }),
        }))
        .filter((candidate): candidate is {
          task: WorkItemRecord;
          blocked: { runId: string; retryAt: Date; runtime?: string };
        } => Boolean(candidate.blocked))
        .filter((candidate) => !input.candidateIds || input.candidateIds.has(candidate.task.id))
        .filter((candidate) => !input.attempted.has(candidate.task.id));
    } finally {
      eventStore.close();
    }
  })();

  await mkdir(resolve(input.repoPath, ".nitely"), { recursive: true });
  let resumed = false;
  for (const staleCandidate of candidates) {
    const claimStore = new ResumeClaimStore(
      resumeClaimStorePath(input.repoPath),
    );
    const claimToken = randomUUID();
    let claimed: boolean;
    try {
      claimed = claimStore.claim({
        runId: staleCandidate.blocked.runId,
        token: claimToken,
        now: new Date(),
      });
    } catch (error) {
      claimStore.close();
      throw error;
    }
    if (!claimed) {
      claimStore.close();
      continue;
    }
    try {
      const currentTask = await getUnifiedWorkItem(
        input.repoPath,
        staleCandidate.task.id,
      );
      const validationEvents = new EventStore(eventStorePath(input.repoPath));
      const currentBlocked = (() => {
        try {
          return usageLimitBlockedRun({
            task: currentTask,
            eventStore: validationEvents,
            now: input.now,
            persisted: input.persistedCooldowns,
          });
        } finally {
          validationEvents.close();
        }
      })();
      if (
        !currentBlocked ||
        currentBlocked.runId !== staleCandidate.blocked.runId
      ) {
        continue;
      }
      const candidate = { task: currentTask, blocked: currentBlocked };
      resumed = true;
      input.attempted.add(candidate.task.id);
      input.summary.startedTaskIds.push(candidate.task.id);
      await updateSchedulerWorkItem(
        input.repoPath,
        candidate.task.id,
        {
          status: "running",
          latestRunId: candidate.blocked.runId,
        },
        {
          activePlanningBaseline: candidate.task.activePlanningBaseline,
        },
      );
      const resumeStartedAfterSequence = latestRunEventSequence(
        input.repoPath,
        candidate.blocked.runId,
      );
      try {
        const result = await input.resumeRun({
          repoPath: input.repoPath,
          runId: candidate.blocked.runId,
          ...(input.executionBackend
            ? { executionBackend: input.executionBackend }
            : {}),
        });
        await settleResumedRunResult({
          repoPath: input.repoPath,
          task: candidate.task,
          result,
          summary: input.summary,
        });
        clearUsageLimitCooldown(input.repoPath, candidate.blocked.runtime);
      } catch (error) {
        await settleRunnerErrorProjection({
          repoPath: input.repoPath,
          task: candidate.task,
          runId: candidate.blocked.runId,
          projection: terminalProjectionAfterRunnerError(
            input.repoPath,
            candidate.blocked.runId,
            error,
            resumeStartedAfterSequence,
          ),
          summary: input.summary,
        });
      }
    } finally {
      try {
        claimStore.release(staleCandidate.blocked.runId, claimToken);
      } finally {
        claimStore.close();
      }
    }
  }

  return resumed;
}

export async function runSchedulerOnce(
  input: RunSchedulerOnceInput,
): Promise<SchedulerRunSummary> {
  const repoPath = resolve(input.repoPath);
  const concurrency = resolveConcurrency(input);
  const usageLimitCooldownMs = resolveUsageLimitCooldownMs(input.usageLimitCooldownMs);
  const runner = input.runFlow ?? defaultRunFlow;
  const resumer = input.resumeRun ?? defaultResumeRun;
  const candidateIds = input.candidateIds ? new Set(input.candidateIds) : undefined;
  const summary: SchedulerRunSummary = {
    startedTaskIds: [],
    completedTaskIds: [],
    failedTaskIds: [],
    blockedTaskIds: [],
    cooldownTaskIds: [],
    cooldownUntil: {},
    awaitingApprovalTaskIds: [],
    preflight: {},
    specReadiness: {},
    eligibility: {},
    taskErrors: {},
  };

  // Time triggers create work; the rest of the cycle decides whether it runs.
  // A cycle scoped to explicit candidates is a dispatch of already admitted
  // work and must not widen itself by firing schedules.
  if (!candidateIds) {
    await materializeDueSchedules({
      repoPath,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  }

  const attempted = new Set<string>();
  while (true) {
    const { tasks, getStatus } = await loadSchedulerWorkItems({
      ...input,
      repoPath,
    });
    let reconciledTerminalRun = false;
    for (const task of tasks) {
      if (task.status !== "running" || !task.latestRunId) continue;
      const reconciled = await reconcileTerminalWorkItemRun({
        repoPath,
        workItemId: task.id,
        runId: task.latestRunId,
      });
      if (reconciled && reconciled.status !== "running") {
        reconciledTerminalRun = true;
      }
    }
    if (reconciledTerminalRun) continue;
    const now = input.now?.() ?? new Date();
    await mkdir(resolve(repoPath, ".nitely"), { recursive: true });
    const cooldowns = activeUsageLimitCooldowns(
      repoPath,
      tasks,
      now,
      usageLimitCooldownMs,
    );
    const resumed = await resumeDueUsageLimitRuns({
      repoPath,
      tasks,
      candidateIds,
      attempted,
      summary,
      resumeRun: resumer,
      now,
      persistedCooldowns: cooldowns,
      ...(input.executionBackend ? { executionBackend: input.executionBackend } : {}),
    });
    if (resumed) {
      continue;
    }
    const candidates = schedulerCandidates(
      tasks.filter(
        (task) => task.status === "ready" &&
          (!candidateIds || candidateIds.has(task.id)) &&
          !attempted.has(task.id),
      ),
    );
    if (candidates.length === 0) {
      return summary;
    }
    const prepared = await prepareWorkItemRunCandidates(
      repoPath,
      tasks,
      candidates.map((task) => task.id),
      "automatic",
    );
    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.repoName ? { repoName: input.repoName } : {}),
      workItems: prepared.workItems,
      candidateIds: candidates.map((task) => task.id),
      intent: { kind: "automatic" },
      ...(input.providerStore ? { providerStore: input.providerStore } : {}),
      getChangeRequestStatus: getStatus,
    });
    const eligibility = starts.eligibility;
    summary.eligibility = { ...(summary.eligibility ?? {}), ...eligibility };
    for (const task of candidates) {
      const decision = eligibility[task.id]!;
      if (decision.checks.preflight) {
        summary.preflight = {
          ...(summary.preflight ?? {}),
          [task.id]: decision.checks.preflight,
        };
      }
      if (decision.checks.specReadiness) {
        summary.specReadiness = {
          ...(summary.specReadiness ?? {}),
          [task.id]: decision.checks.specReadiness,
        };
      }
      if (decision.decision === "blocked" && !isDependencyOnlyBlock(decision)) {
        attempted.add(task.id);
        summary.blockedTaskIds.push(task.id);
      }
    }
    const coolingTaskIds = new Set<string>();
    for (const task of candidates) {
      if (eligibility[task.id]?.decision !== "eligible") continue;
      const runInput = starts.runInputs[task.id];
      const cooldownUntil = runInput
        ? cooldownUntilForRunInput(runInput, cooldowns)
        : undefined;
      // A window that has already passed must not hold ready work back. The
      // persisted cooldowns are kept whole for the resume decision, and a row
      // is only cleared by a successful resume — a task that never becomes
      // resumable would otherwise gate its runtime for good.
      if (!cooldownUntil || cooldownUntil.getTime() <= now.getTime()) continue;
      coolingTaskIds.add(task.id);
      if (!summary.cooldownTaskIds?.includes(task.id)) {
        summary.cooldownTaskIds?.push(task.id);
      }
      if (summary.cooldownUntil) {
        summary.cooldownUntil[task.id] = cooldownUntil.toISOString();
      }
    }
    const runnable = candidates.filter(
      (task) =>
        eligibility[task.id]?.decision === "eligible" &&
        !coolingTaskIds.has(task.id),
    );
    if (runnable.length === 0) {
      summary.blockedTaskIds = [
        ...new Set([
          ...summary.blockedTaskIds,
          ...candidates
            .filter(
              (task) =>
                !attempted.has(task.id) && !coolingTaskIds.has(task.id),
            )
            .map((task) => task.id),
        ]),
      ];
      return summary;
    }

    await runWithConcurrency(runnable, concurrency.global, async (task) => {
      const evaluatedInput = starts.runInputs[task.id];
      if (!evaluatedInput) {
        throw new Error(`eligible Work item has no evaluated Run input: ${task.id}`);
      }
      const preparedCandidate = prepared.candidates.get(task.id);
      if (!preparedCandidate) {
        throw new Error(`prepared Work item candidate is missing: ${task.id}`);
      }
      attempted.add(task.id);
      const leaseOwner = `scheduler:${randomUUID()}`;
      const leaseStore = await acquireSchedulerLease({
        repoPath,
        task,
        owner: leaseOwner,
        repositoryLimit: concurrency.repository,
        flowLimit: concurrency.flow,
        ttlMs: concurrency.leaseTtlMs,
        ...(input.getConflictKeys ? { getConflictKeys: input.getConflictKeys } : {}),
        now: input.now ?? (() => new Date()),
      });
      const heartbeat = setInterval(() => {
        try {
          leaseStore.heartbeat({
            taskId: task.id,
            owner: leaseOwner,
            now: input.now?.() ?? new Date(),
            ttlMs: concurrency.leaseTtlMs,
          });
        } catch {
          // Lease expiry remains fail-closed if the heartbeat store disappears.
        }
      }, Math.max(250, Math.floor(concurrency.leaseTtlMs / 3)));
      heartbeat.unref?.();
      try {
        const finalizedCandidate = await finalizeWorkItemRunCandidate(
          repoPath,
          preparedCandidate,
        );
        const candidateWorkItem = finalizedCandidate.workItem;
        const runnerInput: RunFlowInput = {
          ...evaluatedInput,
          inputs: candidateWorkItem.inputs,
          ...(input.executionBackend
            ? { executionBackend: input.executionBackend }
            : {}),
        };
        const guardedCandidateVersion = {
          ...preparedCandidate.version,
          dependencyGuards: workItemDependencyGuards(
            candidateWorkItem,
            prepared.workItems,
          ),
        };
        const admission = await admitWorkItemRun({
          repoPath,
          candidate: {
            workItem: candidateWorkItem,
            version: guardedCandidateVersion,
          },
          runInput: runnerInput,
          ...(preparedCandidate.legacyState
            ? {
                legacyState: preparedCandidate.legacyState,
              }
            : {}),
          ...(input.createRunId ? { createRunId: input.createRunId } : {}),
        });
        if (admission.decision === "conflict") {
          return;
        }
        const startedTask = admission.workItem;
        summary.startedTaskIds.push(startedTask.id);
        try {
          const result = await runner(runnerInput, {
            createRunId: () => admission.runId,
          });
          await applyAdmittedRunResult({
            repoPath,
            task: startedTask,
            admittedRunId: admission.runId,
            result,
            summary,
          });
        } catch (error) {
          await settleRunnerErrorProjection({
            repoPath,
            task: startedTask,
            runId: admission.runId,
            projection: terminalProjectionAfterRunnerError(
              repoPath,
              admission.runId,
              error,
            ),
            summary,
          });
        }
      } catch {
        summary.taskErrors = {
          ...(summary.taskErrors ?? {}),
          [task.id]: {
            code: "scheduler_task_processing_failed",
            message: "Scheduler could not process this Work item",
          },
        };
      } finally {
        clearInterval(heartbeat);
        try {
          leaseStore.release({ taskId: task.id, owner: leaseOwner });
        } finally {
          leaseStore.close();
        }
      }
    });
    sortSummaryTaskIds(summary, tasks);
  }
}
