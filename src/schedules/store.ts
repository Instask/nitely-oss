import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { assertTimezone, parseCronExpression } from "./cron.js";
import { nextTriggerOccurrence } from "./trigger.js";
import { loadFactoryQueue } from "../factory-queue.js";
import { getTask } from "../web/tasks.js";
import type {
  CreateScheduleInput,
  ScheduleMisfirePolicy,
  ScheduleOccurrence,
  ScheduleOccurrenceWithLineage,
  ScheduleOverlapPolicy,
  ScheduleRecord,
  ScheduleStoreOptions,
  ScheduleTrigger,
  UpdateScheduleInput,
} from "./types.js";

export class ScheduleNotFoundError extends Error {
  constructor(public readonly scheduleId: string) {
    super(`schedule ${scheduleId} not found`);
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleInputError";
  }
}

/** The shortest interval a schedule may repeat on. */
export const MIN_INTERVAL_MS = 60_000;
/** A late scan within this window is a normal firing, not a misfire. */
export const DEFAULT_MISFIRE_GRACE_MS = 5 * 60_000;
/** The most missed occurrences a catch-up policy may materialize. */
export const MAX_CATCH_UP_LIMIT = 50;

const misfireSchema = z.object({
  policy: z.enum(["skip", "run_once_now", "catch_up"]),
  limit: z.number().int().positive().max(MAX_CATCH_UP_LIMIT).optional(),
  graceMs: z.number().int().nonnegative().optional(),
}).strict();

const overlapSchema = z.enum(["allow", "skip", "queue"]);

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.string().min(1) }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMs: z.number().int().positive(),
    anchorAt: z.string().min(1),
  }).strict(),
]);

const templateSchema = z.object({
  title: z.string().trim().min(1),
  spec: z.string().min(1),
  techDesign: z.string().min(1),
  flowPath: z.string().trim().min(1).optional(),
  riskClass: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
}).strict();

const scheduleSchema = z.object({
  schemaVersion: z.literal("nitely.schedule.v1"),
  id: z.string().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  trigger: triggerSchema,
  timezone: z.string().min(1),
  template: templateSchema,
  admission: z.enum(["auto", "review"]),
  misfire: misfireSchema,
  overlap: overlapSchema,
  revision: z.number().int().positive(),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastOccurrenceId: z.string().optional(),
  completedAt: z.string().optional(),
  createdBy: z.string().optional(),
  ownerId: z.string().optional(),
  organizationId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const occurrenceSchema = z.object({
  schemaVersion: z.literal("nitely.schedule-occurrence.v1"),
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  scheduleRevision: z.number().int().positive(),
  intendedFireAt: z.string(),
  materializedAt: z.string(),
  status: z.enum(["pending", "materialized", "skipped"]),
  workItemId: z.string().optional(),
  candidateId: z.string().optional(),
  reason: z.string().optional(),
  manual: z.literal(true).optional(),
}).strict();

const schedulesFileSchema = z.object({
  version: z.literal(1),
  schedules: z.array(scheduleSchema),
}).strict();

const occurrencesFileSchema = z.object({
  version: z.literal(1),
  occurrences: z.array(occurrenceSchema),
}).strict();

type SchedulesFile = z.infer<typeof schedulesFileSchema>;
type OccurrencesFile = z.infer<typeof occurrencesFileSchema>;

export function schedulesDirectory(repoPath: string): string {
  return join(repoPath, ".nitely", "schedules");
}

function schedulesPath(repoPath: string): string {
  return join(schedulesDirectory(repoPath), "schedules.json");
}

function occurrencesPath(repoPath: string): string {
  return join(schedulesDirectory(repoPath), "occurrences.json");
}

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
  empty: T,
): Promise<T> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  const parsed = schema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`invalid ${path}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readSchedulesFile(repoPath: string): Promise<SchedulesFile> {
  return readJsonFile(schedulesPath(repoPath), schedulesFileSchema, { version: 1, schedules: [] });
}

export async function writeSchedulesFile(repoPath: string, file: SchedulesFile): Promise<void> {
  await writeJsonFile(schedulesPath(repoPath), file);
}

export async function readOccurrencesFile(repoPath: string): Promise<OccurrencesFile> {
  return readJsonFile(occurrencesPath(repoPath), occurrencesFileSchema, {
    version: 1,
    occurrences: [],
  });
}

export async function writeOccurrencesFile(
  repoPath: string,
  file: OccurrencesFile,
): Promise<void> {
  await writeJsonFile(occurrencesPath(repoPath), file);
}

function validateTrigger(trigger: ScheduleTrigger, timezone: string): void {
  try {
    assertTimezone(timezone);
  } catch (error) {
    throw new ScheduleInputError((error as Error).message);
  }
  switch (trigger.type) {
    case "once":
      if (!Number.isFinite(Date.parse(trigger.at))) {
        throw new ScheduleInputError("once trigger needs a valid ISO instant in `at`");
      }
      return;
    case "cron":
      try {
        parseCronExpression(trigger.expression);
      } catch (error) {
        throw new ScheduleInputError((error as Error).message);
      }
      return;
    case "interval":
      if (trigger.everyMs < MIN_INTERVAL_MS) {
        throw new ScheduleInputError(
          `interval trigger must repeat at least every ${MIN_INTERVAL_MS / 1000} seconds`,
        );
      }
      if (!Number.isFinite(Date.parse(trigger.anchorAt))) {
        throw new ScheduleInputError("interval trigger needs a valid ISO instant in `anchorAt`");
      }
      return;
  }
}

function normalizeTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
  switch (trigger.type) {
    case "once":
      return { type: "once", at: new Date(trigger.at).toISOString() };
    case "interval":
      return {
        type: "interval",
        everyMs: trigger.everyMs,
        anchorAt: new Date(trigger.anchorAt).toISOString(),
      };
    case "cron":
      return { type: "cron", expression: trigger.expression.trim() };
  }
}

export function nextRunAtFor(
  schedule: Pick<ScheduleRecord, "trigger" | "timezone">,
  after: Date,
): string | undefined {
  return nextTriggerOccurrence(schedule.trigger, after, schedule.timezone)?.toISOString();
}

function parseInput(input: CreateScheduleInput): CreateScheduleInput {
  const template = templateSchema.safeParse(input.template);
  if (!template.success) {
    throw new ScheduleInputError(
      `invalid schedule template: ${template.error.issues[0]?.path.join(".") ?? ""} ${template.error.issues[0]?.message ?? ""}`.trim(),
    );
  }
  const trigger = triggerSchema.safeParse(input.trigger);
  if (!trigger.success) {
    throw new ScheduleInputError("invalid schedule trigger");
  }
  if (!input.name?.trim()) throw new ScheduleInputError("schedule name is required");
  if (!input.timezone?.trim()) throw new ScheduleInputError("schedule timezone is required");
  validateTrigger(trigger.data, input.timezone);
  const misfire = misfireSchema.safeParse(input.misfire ?? { policy: "run_once_now" });
  if (!misfire.success) {
    const issue = misfire.error.issues[0];
    throw new ScheduleInputError(
      `invalid misfire policy${issue?.path.length ? ` (${issue.path.join(".")})` : ""}: ${issue?.message ?? "schema mismatch"}`,
    );
  }
  if (misfire.data.policy === "catch_up" && misfire.data.limit === undefined) {
    throw new ScheduleInputError("catch_up misfire policy needs a bounded limit");
  }
  const overlap = overlapSchema.safeParse(input.overlap ?? "allow");
  if (!overlap.success) throw new ScheduleInputError("invalid overlap policy");
  return {
    ...input,
    template: template.data,
    trigger: normalizeTrigger(trigger.data),
    misfire: misfire.data,
    overlap: overlap.data,
  };
}

export function scheduleMisfireGraceMs(policy: ScheduleMisfirePolicy): number {
  return policy.graceMs ?? DEFAULT_MISFIRE_GRACE_MS;
}

export async function createSchedule(
  repoPath: string,
  rawInput: CreateScheduleInput,
  options: ScheduleStoreOptions = {},
): Promise<ScheduleRecord> {
  const input = parseInput(rawInput);
  const now = options.now?.() ?? new Date();
  const id = options.createId?.() ?? `sch_${randomBytes(6).toString("hex")}`;
  const file = await readSchedulesFile(repoPath);
  if (file.schedules.some((schedule) => schedule.id === id)) {
    throw new ScheduleInputError(`schedule ${id} already exists`);
  }
  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRunAtFor(input, now) : undefined;
  const record: ScheduleRecord = {
    schemaVersion: "nitely.schedule.v1",
    id,
    name: input.name.trim(),
    enabled,
    trigger: input.trigger,
    timezone: input.timezone.trim(),
    template: input.template,
    admission: input.admission ?? "auto",
    misfire: input.misfire as ScheduleMisfirePolicy,
    overlap: input.overlap as ScheduleOverlapPolicy,
    revision: 1,
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  file.schedules.push(record);
  await writeSchedulesFile(repoPath, file);
  return record;
}

export async function listSchedules(repoPath: string): Promise<ScheduleRecord[]> {
  return (await readSchedulesFile(repoPath)).schedules;
}

export async function getSchedule(repoPath: string, id: string): Promise<ScheduleRecord> {
  const schedule = (await readSchedulesFile(repoPath)).schedules.find((s) => s.id === id);
  if (!schedule) throw new ScheduleNotFoundError(id);
  return schedule;
}

/**
 * Rewrites one schedule. Every edit bumps the revision so occurrences can
 * name the definition they came from; historical occurrences are untouched.
 */
export async function updateSchedule(
  repoPath: string,
  id: string,
  patch: UpdateScheduleInput,
  options: ScheduleStoreOptions = {},
): Promise<ScheduleRecord> {
  const file = await readSchedulesFile(repoPath);
  const index = file.schedules.findIndex((s) => s.id === id);
  if (index < 0) throw new ScheduleNotFoundError(id);
  const existing = file.schedules[index];
  const merged = parseInput({
    name: patch.name ?? existing.name,
    trigger: patch.trigger ?? existing.trigger,
    timezone: patch.timezone ?? existing.timezone,
    template: patch.template ?? existing.template,
    admission: patch.admission ?? existing.admission,
    misfire: patch.misfire ?? existing.misfire,
    overlap: patch.overlap ?? existing.overlap,
  });
  const now = options.now?.() ?? new Date();
  const triggerChanged = patch.trigger !== undefined || patch.timezone !== undefined;
  const nextRunAt = !existing.enabled || existing.completedAt
    ? existing.nextRunAt
    : triggerChanged
      ? nextRunAtFor(merged, now)
      : existing.nextRunAt;
  const { nextRunAt: _previous, completedAt, ...rest } = existing;
  const updated: ScheduleRecord = {
    ...rest,
    name: merged.name.trim(),
    trigger: merged.trigger,
    timezone: merged.timezone.trim(),
    template: merged.template,
    admission: merged.admission ?? "auto",
    misfire: merged.misfire as ScheduleMisfirePolicy,
    overlap: merged.overlap as ScheduleOverlapPolicy,
    revision: existing.revision + 1,
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(completedAt && !triggerChanged ? { completedAt } : {}),
    updatedAt: now.toISOString(),
  };
  file.schedules[index] = updated;
  await writeSchedulesFile(repoPath, file);
  return updated;
}

/**
 * Pausing clears the next firing; resuming computes it from now, so the
 * occurrences a pause covered are never replayed.
 */
export async function setScheduleEnabled(
  repoPath: string,
  id: string,
  enabled: boolean,
  options: ScheduleStoreOptions = {},
): Promise<ScheduleRecord> {
  const file = await readSchedulesFile(repoPath);
  const index = file.schedules.findIndex((s) => s.id === id);
  if (index < 0) throw new ScheduleNotFoundError(id);
  const existing = file.schedules[index];
  const now = options.now?.() ?? new Date();
  const { nextRunAt: _previous, ...rest } = existing;
  const nextRunAt = enabled && !existing.completedAt ? nextRunAtFor(existing, now) : undefined;
  const updated: ScheduleRecord = {
    ...rest,
    enabled,
    ...(nextRunAt ? { nextRunAt } : {}),
    updatedAt: now.toISOString(),
  };
  file.schedules[index] = updated;
  await writeSchedulesFile(repoPath, file);
  return updated;
}

/** Removes the definition only: occurrences, tasks and runs stay. */
export async function deleteSchedule(repoPath: string, id: string): Promise<void> {
  const file = await readSchedulesFile(repoPath);
  if (!file.schedules.some((s) => s.id === id)) throw new ScheduleNotFoundError(id);
  file.schedules = file.schedules.filter((s) => s.id !== id);
  await writeSchedulesFile(repoPath, file);
}

export async function listScheduleOccurrences(
  repoPath: string,
  filter: { scheduleId?: string } = {},
): Promise<ScheduleOccurrence[]> {
  return (await readOccurrencesFile(repoPath)).occurrences.filter(
    (occurrence) => filter.scheduleId === undefined || occurrence.scheduleId === filter.scheduleId,
  );
}

/**
 * Occurrences joined to what they produced: the task's current status, the
 * latest Run it started, and the candidate's queue status. Lineage is read
 * live rather than copied, so it never goes stale.
 */
export async function listScheduleOccurrencesWithLineage(
  repoPath: string,
  filter: { scheduleId?: string } = {},
): Promise<ScheduleOccurrenceWithLineage[]> {
  const occurrences = await listScheduleOccurrences(repoPath, filter);
  const queue = occurrences.some((o) => o.candidateId)
    ? await loadFactoryQueue(repoPath)
    : undefined;
  return await Promise.all(
    occurrences.map(async (occurrence) => {
      const lineage: ScheduleOccurrenceWithLineage["lineage"] = {};
      if (occurrence.workItemId) {
        try {
          const task = await getTask(repoPath, occurrence.workItemId);
          lineage.taskStatus = task.status;
          if (task.latestRunId) lineage.runId = task.latestRunId;
        } catch {
          lineage.taskStatus = "missing";
        }
      }
      const candidate = queue?.candidates.find((c) => c.id === occurrence.candidateId);
      if (candidate) lineage.candidateStatus = candidate.status;
      return { ...occurrence, lineage };
    }),
  );
}
