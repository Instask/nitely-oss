import type { FactoryRiskClass } from "../factory-queue.js";
import type { ScheduleTrigger } from "./trigger.js";

export type { ScheduleTrigger } from "./trigger.js";

/**
 * How a materialized occurrence is admitted. `auto` approves the template's
 * planning artifacts so the candidate can queue on its own; `review` lands a
 * draft that a human must approve first.
 */
export type ScheduleAdmission = "auto" | "review";

/**
 * What to do when a scan finds firings that should already have happened
 * (beyond `graceMs`). `skip` records them and creates nothing;
 * `run_once_now` fires one occurrence for the latest missed time;
 * `catch_up` fires up to `limit` of them, oldest first. Every policy is
 * bounded: the remainder is recorded as skipped, never queued.
 */
export interface ScheduleMisfirePolicy {
  policy: "skip" | "run_once_now" | "catch_up";
  limit?: number;
  graceMs?: number;
}

/**
 * What to do when the previous occurrence's task is still ready or running:
 * `allow` fires anyway, `skip` records a skipped occurrence, `queue` fires
 * but makes the new task depend on the previous one.
 */
export type ScheduleOverlapPolicy = "allow" | "skip" | "queue";

export interface ScheduleTemplate {
  title: string;
  spec: string;
  techDesign: string;
  flowPath?: string;
  riskClass?: FactoryRiskClass;
  labels?: string[];
}

export interface ScheduleRecord {
  schemaVersion: "nitely.schedule.v1";
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  timezone: string;
  template: ScheduleTemplate;
  admission: ScheduleAdmission;
  misfire: ScheduleMisfirePolicy;
  overlap: ScheduleOverlapPolicy;
  /** Incremented on every edit; occurrences record the revision they used. */
  revision: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastOccurrenceId?: string;
  /** Set once a one-shot schedule has fired. */
  completedAt?: string;
  createdBy?: string;
  ownerId?: string;
  organizationId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `pending` is written before any task or candidate exists, so a crash in
 * the middle of materialization leaves a record the next scan completes.
 */
export type ScheduleOccurrenceStatus = "pending" | "materialized" | "skipped";

export interface ScheduleOccurrence {
  schemaVersion: "nitely.schedule-occurrence.v1";
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  intendedFireAt: string;
  materializedAt: string;
  status: ScheduleOccurrenceStatus;
  workItemId?: string;
  candidateId?: string;
  reason?: string;
  /** Set when an operator fired the schedule outside its trigger. */
  manual?: true;
}

export interface CreateScheduleInput {
  name: string;
  trigger: ScheduleTrigger;
  timezone: string;
  template: ScheduleTemplate;
  admission?: ScheduleAdmission;
  misfire?: ScheduleMisfirePolicy;
  overlap?: ScheduleOverlapPolicy;
  enabled?: boolean;
  createdBy?: string;
  ownerId?: string;
  organizationId?: string;
}

export type UpdateScheduleInput = Partial<
  Pick<
    CreateScheduleInput,
    "name" | "trigger" | "timezone" | "template" | "admission" | "misfire" | "overlap"
  >
>;

export interface ScheduleOccurrenceLineage {
  taskStatus?: string;
  runId?: string;
  candidateStatus?: string;
}

export type ScheduleOccurrenceWithLineage = ScheduleOccurrence & {
  lineage: ScheduleOccurrenceLineage;
};

export interface ScheduleStoreOptions {
  now?: () => Date;
  createId?: () => string;
}
