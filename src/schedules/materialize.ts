import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { EventStore } from "../events/store.js";
import type { RunEventType } from "../events/types.js";
import { upsertFactoryCandidate } from "../factory-queue.js";
import { eventStorePath } from "../run/project.js";
import { WebNotFoundError } from "../web/errors.js";
import { createTask, getTask, updateTaskDependencies } from "../web/tasks.js";
import type { CreateTaskInput, CreateTaskOptions, TaskRecord } from "../web/tasks.js";
import {
  nextRunAtFor,
  readOccurrencesFile,
  readSchedulesFile,
  ScheduleNotFoundError,
  scheduleMisfireGraceMs,
  writeOccurrencesFile,
  writeSchedulesFile,
} from "./store.js";
import { nextTriggerOccurrence } from "./trigger.js";
import type { ScheduleOccurrence, ScheduleRecord } from "./types.js";

export interface MaterializeDueSchedulesInput {
  repoPath: string;
  repoId?: string;
  now?: () => Date;
  /** Test seams; production uses the real task and queue writers. */
  createTask?: (
    repoPath: string,
    input: CreateTaskInput,
    options: CreateTaskOptions,
  ) => Promise<TaskRecord>;
  upsertCandidate?: typeof upsertFactoryCandidate;
}

export interface MaterializeDueSchedulesResult {
  fired: ScheduleOccurrence[];
  skipped: ScheduleOccurrence[];
}

/** How many missed instants one scan enumerates before summarizing the rest. */
const MAX_MISSED_ENUMERATED = 1000;
/** How many skipped occurrences one scan records individually. */
const MAX_SKIPS_RECORDED = 25;

/** Deterministic per (schedule, intended fire time), so a rescan cannot double-fire. */
export function scheduleOccurrenceId(scheduleId: string, intendedFireAt: string): string {
  return `occ_${scheduleId}_${intendedFireAt.replace(/[-:.]/g, "")}`;
}

/** The task an occurrence creates has the occurrence's identity, so a retry finds it. */
export function scheduleOccurrenceTaskId(occurrenceId: string): string {
  return `task-${occurrenceId}`;
}

function occurrenceTitle(schedule: ScheduleRecord, intendedFireAt: string): string {
  return `${schedule.template.title} — ${intendedFireAt.slice(0, 16).replace("T", " ")} UTC`;
}

interface Decision {
  intendedFireAt: string;
  action: "fire" | "skip";
  reason?: string;
}

/**
 * Every instant the trigger should have fired at, from the stored next
 * firing up to now, bounded. The first entry is the stored `nextRunAt`.
 */
function missedInstants(schedule: ScheduleRecord, now: Date): { instants: string[]; truncated: boolean } {
  const instants: string[] = [];
  let cursor = schedule.nextRunAt ? new Date(schedule.nextRunAt) : undefined;
  while (cursor && cursor.getTime() <= now.getTime()) {
    instants.push(cursor.toISOString());
    if (instants.length >= MAX_MISSED_ENUMERATED) return { instants, truncated: true };
    cursor = nextTriggerOccurrence(schedule.trigger, cursor, schedule.timezone);
  }
  return { instants, truncated: false };
}

function decide(schedule: ScheduleRecord, instants: string[], now: Date): Decision[] {
  if (instants.length === 0) return [];
  const latest = instants[instants.length - 1];
  const onTime =
    instants.length === 1 &&
    now.getTime() - Date.parse(latest) <= scheduleMisfireGraceMs(schedule.misfire);
  if (onTime) return [{ intendedFireAt: latest, action: "fire" }];
  const policy = schedule.misfire.policy;
  if (policy === "skip") {
    return instants.map((intendedFireAt) => ({
      intendedFireAt,
      action: "skip",
      reason: "misfire: skip policy",
    }));
  }
  if (policy === "run_once_now") {
    return instants.map((intendedFireAt) =>
      intendedFireAt === latest
        ? { intendedFireAt, action: "fire", reason: "misfire: run_once_now policy" }
        : { intendedFireAt, action: "skip", reason: "misfire: run_once_now policy" },
    );
  }
  const limit = schedule.misfire.limit ?? 1;
  return instants.map((intendedFireAt, index) =>
    index < limit
      ? { intendedFireAt, action: "fire", reason: "misfire: catch_up policy" }
      : { intendedFireAt, action: "skip", reason: `misfire: catch_up limit ${limit} reached` },
  );
}

/**
 * Turns every due schedule into Tasks plus Factory Queue candidates. The
 * schedule decides when work is created; the queue and the execution
 * scheduler decide when it runs. Firings that should already have happened
 * follow the schedule's misfire policy and are always bounded; a firing whose
 * predecessor is still active follows its overlap policy. Every decision is
 * recorded as an occurrence with the schedule revision it used.
 */
export async function materializeDueSchedules(
  input: MaterializeDueSchedulesInput,
): Promise<MaterializeDueSchedulesResult> {
  const now = input.now?.() ?? new Date();
  const fired: ScheduleOccurrence[] = [];
  const skipped: ScheduleOccurrence[] = [];
  const schedules = await readSchedulesFile(input.repoPath);
  for (const schedule of schedules.schedules) {
    // A crash mid-materialization leaves a pending occurrence; finish it
    // before anything else, whether or not the schedule is still enabled.
    const pending = (await readOccurrencesFile(input.repoPath)).occurrences.filter(
      (occurrence) => occurrence.scheduleId === schedule.id && occurrence.status === "pending",
    );
    for (const occurrence of pending) {
      fired.push(await completeOccurrence(input, schedule, occurrence, now));
    }
    if (!schedule.enabled || !schedule.nextRunAt || schedule.completedAt) {
      if (pending.length > 0) await advance(input.repoPath, schedule.id, now, fired.at(-1)?.id);
      continue;
    }
    if (Date.parse(schedule.nextRunAt) > now.getTime()) continue;
    const { instants, truncated } = missedInstants(schedule, now);
    const decisions = decide(schedule, instants, now);
    let recordedSkips = 0;
    let lastFiredId: string | undefined;
    for (const [index, decision] of decisions.entries()) {
      const occurrenceId = scheduleOccurrenceId(schedule.id, decision.intendedFireAt);
      const existing = (await readOccurrencesFile(input.repoPath)).occurrences.find(
        (occurrence) => occurrence.id === occurrenceId,
      );
      if (existing && existing.status !== "pending") {
        if (existing.status === "materialized") lastFiredId = existing.id;
        continue;
      }
      let action = decision.action;
      let reason = decision.reason;
      if (action === "fire" && schedule.overlap !== "allow") {
        const previous = await activePredecessor(input.repoPath, schedule, lastFiredId);
        if (previous && schedule.overlap === "skip") {
          action = "skip";
          reason = "overlap: previous occurrence still active";
        }
      }
      if (action === "skip") {
        const remaining = decisions.length - index;
        if (recordedSkips >= MAX_SKIPS_RECORDED || (truncated && index === decisions.length - 1)) {
          const summary = await recordSkipped(
            input.repoPath,
            schedule,
            decision.intendedFireAt,
            `${reason ?? "skipped"}; ${remaining}${truncated ? "+" : ""} further occurrences skipped`,
            now,
          );
          skipped.push(summary);
          break;
        }
        skipped.push(await recordSkipped(input.repoPath, schedule, decision.intendedFireAt, reason ?? "skipped", now));
        recordedSkips += 1;
        continue;
      }
      const occurrence = existing ?? await recordPending(input.repoPath, schedule, decision.intendedFireAt, now, reason);
      const completed = await completeOccurrence(input, schedule, occurrence, now, {
        dependsOn: schedule.overlap === "queue"
          ? await activePredecessor(input.repoPath, schedule, lastFiredId)
          : undefined,
      });
      fired.push(completed);
      lastFiredId = completed.id;
    }
    await advance(input.repoPath, schedule.id, now, lastFiredId);
  }
  return { fired, skipped };
}

/**
 * An operator-triggered occurrence. It is recorded and admitted exactly like
 * a timed one, but leaves the schedule's own next firing untouched.
 */
export async function materializeScheduleNow(
  input: MaterializeDueSchedulesInput & { scheduleId: string },
): Promise<ScheduleOccurrence> {
  const now = input.now?.() ?? new Date();
  const schedule = (await readSchedulesFile(input.repoPath)).schedules.find(
    (candidate) => candidate.id === input.scheduleId,
  );
  if (!schedule) throw new ScheduleNotFoundError(input.scheduleId);
  const intendedFireAt = now.toISOString();
  const existing = (await readOccurrencesFile(input.repoPath)).occurrences.find(
    (occurrence) => occurrence.id === scheduleOccurrenceId(schedule.id, intendedFireAt),
  );
  if (existing && existing.status !== "pending") return existing;
  const occurrence = existing ?? await recordPending(input.repoPath, schedule, intendedFireAt, now, undefined, true);
  return await completeOccurrence(input, schedule, occurrence, now);
}

/** The previous occurrence's task id when that task is still ready or running. */
async function activePredecessor(
  repoPath: string,
  schedule: ScheduleRecord,
  lastFiredId: string | undefined,
): Promise<string | undefined> {
  const previousId = lastFiredId ?? schedule.lastOccurrenceId;
  if (!previousId) return undefined;
  const previous = (await readOccurrencesFile(repoPath)).occurrences.find(
    (occurrence) => occurrence.id === previousId,
  );
  if (!previous?.workItemId) return undefined;
  try {
    const task = await getTask(repoPath, previous.workItemId);
    return task.status === "running" || task.status === "ready" ? task.id : undefined;
  } catch (error) {
    if (error instanceof WebNotFoundError) return undefined;
    throw error;
  }
}

async function saveOccurrence(repoPath: string, occurrence: ScheduleOccurrence): Promise<void> {
  const file = await readOccurrencesFile(repoPath);
  const index = file.occurrences.findIndex((candidate) => candidate.id === occurrence.id);
  if (index >= 0) file.occurrences[index] = occurrence;
  else file.occurrences.push(occurrence);
  await writeOccurrencesFile(repoPath, file);
}

async function recordPending(
  repoPath: string,
  schedule: ScheduleRecord,
  intendedFireAt: string,
  now: Date,
  reason?: string,
  manual?: boolean,
): Promise<ScheduleOccurrence> {
  const occurrence: ScheduleOccurrence = {
    schemaVersion: "nitely.schedule-occurrence.v1",
    id: scheduleOccurrenceId(schedule.id, intendedFireAt),
    scheduleId: schedule.id,
    scheduleRevision: schedule.revision,
    intendedFireAt,
    materializedAt: now.toISOString(),
    status: "pending",
    ...(reason ? { reason } : {}),
    ...(manual ? { manual: true as const } : {}),
  };
  await saveOccurrence(repoPath, occurrence);
  return occurrence;
}

async function recordSkipped(
  repoPath: string,
  schedule: ScheduleRecord,
  intendedFireAt: string,
  reason: string,
  now: Date,
): Promise<ScheduleOccurrence> {
  const occurrence: ScheduleOccurrence = {
    schemaVersion: "nitely.schedule-occurrence.v1",
    id: scheduleOccurrenceId(schedule.id, intendedFireAt),
    scheduleId: schedule.id,
    scheduleRevision: schedule.revision,
    intendedFireAt,
    materializedAt: now.toISOString(),
    status: "skipped",
    reason,
  };
  await saveOccurrence(repoPath, occurrence);
  await emitOccurrenceEvent(repoPath, occurrence, "schedule.occurrence.skipped");
  return occurrence;
}

/**
 * Creates the task and candidate for a pending occurrence, then marks it
 * materialized. Every step is keyed by the occurrence id, so a retry after a
 * crash finds what already exists instead of creating it twice.
 */
async function completeOccurrence(
  input: MaterializeDueSchedulesInput,
  schedule: ScheduleRecord,
  occurrence: ScheduleOccurrence,
  now: Date,
  options: { dependsOn?: string } = {},
): Promise<ScheduleOccurrence> {
  const create = input.createTask ?? createTask;
  const upsert = input.upsertCandidate ?? upsertFactoryCandidate;
  const approved = schedule.admission === "auto";
  const taskId = scheduleOccurrenceTaskId(occurrence.id);
  let task: TaskRecord;
  try {
    task = await getTask(input.repoPath, taskId);
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) throw error;
    task = await create(
      input.repoPath,
      {
        title: occurrenceTitle(schedule, occurrence.intendedFireAt),
        spec: schedule.template.spec,
        techDesign: schedule.template.techDesign,
        ...(schedule.template.flowPath ? { flowPath: schedule.template.flowPath } : {}),
        ...(input.repoId ? { repoId: input.repoId } : {}),
      },
      {
        createId: () => taskId,
        now: () => now,
        ...(input.repoId ? { repoId: input.repoId } : {}),
        ...(schedule.ownerId ? { ownerId: schedule.ownerId } : {}),
        ...(schedule.organizationId ? { organizationId: schedule.organizationId } : {}),
        ...(approved
          ? { specStatus: "approved" as const, techDesignStatus: "approved" as const }
          : {
              initialStatus: "draft" as const,
              specStatus: "draft" as const,
              techDesignStatus: "draft" as const,
            }),
      },
    );
  }
  const dependsOn = task.dependsOn ?? [];
  if (options.dependsOn && !dependsOn.includes(options.dependsOn)) {
    task = await updateTaskDependencies(input.repoPath, task.id, [...dependsOn, options.dependsOn]);
  }
  const candidate = await upsert({
    repoPath: input.repoPath,
    title: task.title,
    workItemId: task.id,
    source: { type: "schedule", identity: `${schedule.id}@${occurrence.intendedFireAt}` },
    labels: schedule.template.labels ?? [],
    state: "open",
    ...(schedule.template.riskClass ? { riskClass: schedule.template.riskClass } : {}),
    planning: { specApproved: approved, techDesignApproved: approved },
    now: () => now,
  });
  const completed: ScheduleOccurrence = {
    ...occurrence,
    materializedAt: now.toISOString(),
    status: "materialized",
    workItemId: task.id,
    candidateId: candidate.id,
  };
  await saveOccurrence(input.repoPath, completed);
  await emitOccurrenceEvent(input.repoPath, completed, "schedule.occurrence.materialized");
  return completed;
}

async function emitOccurrenceEvent(
  repoPath: string,
  occurrence: ScheduleOccurrence,
  type: RunEventType,
): Promise<void> {
  try {
    await mkdir(dirname(eventStorePath(repoPath)), { recursive: true });
    const store = new EventStore(eventStorePath(repoPath));
    try {
      store.append({ runId: occurrence.id, type, payload: occurrence });
    } finally {
      store.close();
    }
  } catch {
    // Occurrence files remain authoritative when audit storage is unavailable.
  }
}

/** Moves the schedule past everything this scan handled; the next firing is computed from now. */
async function advance(
  repoPath: string,
  scheduleId: string,
  now: Date,
  lastOccurrenceId: string | undefined,
): Promise<void> {
  const file = await readSchedulesFile(repoPath);
  const index = file.schedules.findIndex((s) => s.id === scheduleId);
  if (index < 0) return;
  const schedule = file.schedules[index];
  const { nextRunAt: _fired, ...rest } = schedule;
  const nextRunAt = schedule.enabled && !schedule.completedAt ? nextRunAtFor(schedule, now) : undefined;
  file.schedules[index] = {
    ...rest,
    ...(nextRunAt ? { nextRunAt } : {}),
    lastRunAt: now.toISOString(),
    ...(lastOccurrenceId ? { lastOccurrenceId } : {}),
    ...(schedule.trigger.type === "once" ? { completedAt: now.toISOString() } : {}),
    updatedAt: now.toISOString(),
  };
  await writeSchedulesFile(repoPath, file);
}
