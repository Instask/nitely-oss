import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertMetadataBoundary,
  assertRunnerEventEnvelope,
  createControlPlaneEvent,
  type ControlPlaneToRunnerEvent,
  type RunnerPolicySnapshot,
  type RunnerTaskAssignment,
  type RunnerToControlPlaneEvent,
} from "./protocol.js";

export type StoredAssignmentStatus =
  | "assigned"
  | "accepted"
  | "rejected"
  | "preparing"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface StoredRunnerRegistration {
  tenantId: string;
  runnerId: string;
  policy: RunnerPolicySnapshot;
  lastSeenAt?: string;
  status?: string;
  version?: string;
  activeRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredRunnerAssignment {
  tenantId: string;
  runnerId: string;
  taskId: string;
  repoId: string;
  repository?: RunnerTaskAssignment["repository"];
  sourceRevision?: string;
  flowId: string;
  title?: string;
  inputs: Record<string, unknown>;
  policyVersion: string;
  status: StoredAssignmentStatus;
  latestRunId?: string;
  rejection?: {
    reason: string;
    safeMessage: string;
  };
  blocker?: {
    runId?: string;
    stageId?: string;
    category?: string;
    safeMessage?: string;
  };
  failure?: {
    runId?: string;
    category?: string;
    safeMessage?: string;
  };
  cancellation?: {
    runId?: string;
    safeMessage?: string;
  };
  changeRequestUrl?: string;
  evidenceSummary?: unknown;
  assignedEvent: ControlPlaneToRunnerEvent;
  createdAt: string;
  updatedAt: string;
}

interface FileRunnerControlPlaneState {
  version: 1;
  runners: Record<string, StoredRunnerRegistration>;
  assignments: Record<string, StoredRunnerAssignment>;
  runnerEvents: RunnerToControlPlaneEvent[];
}

interface FileRunnerOutboxState {
  version: 1;
  events: RunnerToControlPlaneEvent[];
}

export interface RunnerEventRejectedResult {
  eventId: string;
  kind: string;
  reason: string;
}

export interface RunnerEventReportResult {
  acceptedEventIds: string[];
  duplicateEventIds: string[];
  rejectedEvents: RunnerEventRejectedResult[];
}

export interface FileRunnerControlPlaneOptions {
  path: string;
  now?: () => Date;
}

export interface RegisterRunnerOptions {
  now?: () => Date;
  createId?: () => string;
}

export interface AssignRunnerTaskInput extends RunnerTaskAssignment {
  tenantId: string;
  runnerId: string;
}

export interface AssignRunnerTaskOptions {
  now?: () => Date;
  createId?: () => string;
}

export class FileRunnerControlPlane {
  readonly #path: string;
  readonly #now?: () => Date;

  constructor(options: FileRunnerControlPlaneOptions) {
    this.#path = options.path;
    this.#now = options.now;
  }

  async registerRunner(
    policy: RunnerPolicySnapshot,
    options: RegisterRunnerOptions = {},
  ): Promise<ControlPlaneToRunnerEvent> {
    const state = await readControlPlaneState(this.#path);
    const now = this.#isoNow(options.now);
    const key = runnerKey(policy.tenantId, policy.runnerId);
    state.runners[key] = {
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      policy,
      activeRunIds: state.runners[key]?.activeRunIds ?? [],
      createdAt: state.runners[key]?.createdAt ?? now,
      updatedAt: now,
      ...(state.runners[key]?.lastSeenAt
        ? { lastSeenAt: state.runners[key]!.lastSeenAt }
        : {}),
      ...(state.runners[key]?.status ? { status: state.runners[key]!.status } : {}),
      ...(state.runners[key]?.version
        ? { version: state.runners[key]!.version }
        : {}),
    };
    await writeControlPlaneState(this.#path, state);
    return createControlPlaneEvent({
      kind: "runner.register.accepted",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      policyVersion: policy.policyVersion,
      now: options.now ?? this.#now,
      createId: options.createId,
      payload: {
        runnerId: policy.runnerId,
        policyVersion: policy.policyVersion,
        allowedRepositories: policy.allowedRepositories,
      },
    });
  }

  async assignTask(
    input: AssignRunnerTaskInput,
    options: AssignRunnerTaskOptions = {},
  ): Promise<ControlPlaneToRunnerEvent> {
    const state = await readControlPlaneState(this.#path);
    const runner = requireRunner(state, input.tenantId, input.runnerId);
    const event = createControlPlaneEvent({
      kind: "task.assigned",
      tenantId: input.tenantId,
      runnerId: input.runnerId,
      taskId: input.taskId,
      policyVersion: input.policyVersion,
      now: options.now ?? this.#now,
      createId: options.createId,
      payload: {
        taskId: input.taskId,
        repoId: input.repoId,
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.sourceRevision
          ? { sourceRevision: input.sourceRevision }
          : {}),
        flowId: input.flowId,
        inputs: input.inputs ?? {},
        policyVersion: input.policyVersion,
      },
    });
    const now = event.createdAt;
    state.assignments[assignmentKey(input.tenantId, input.taskId)] = {
      tenantId: input.tenantId,
      runnerId: input.runnerId,
      taskId: input.taskId,
      repoId: input.repoId,
      ...(input.repository ? { repository: input.repository } : {}),
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
      flowId: input.flowId,
      ...(input.title ? { title: input.title } : {}),
      inputs: input.inputs ?? {},
      policyVersion: input.policyVersion,
      status: "assigned",
      assignedEvent: event,
      createdAt: now,
      updatedAt: now,
    };
    runner.updatedAt = now;
    await writeControlPlaneState(this.#path, state);
    return event;
  }

  async pollAssignments(input: {
    tenantId: string;
    runnerId: string;
  }): Promise<ControlPlaneToRunnerEvent[]> {
    const state = await readControlPlaneState(this.#path);
    requireRunner(state, input.tenantId, input.runnerId);
    return Object.values(state.assignments)
      .filter(
        (assignment) =>
          assignment.tenantId === input.tenantId &&
          assignment.runnerId === input.runnerId &&
          assignment.status === "assigned",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((assignment) => assignment.assignedEvent);
  }

  async reportRunnerEvents(
    events: RunnerToControlPlaneEvent[],
  ): Promise<RunnerEventReportResult> {
    const state = await readControlPlaneState(this.#path);
    const result: RunnerEventReportResult = {
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejectedEvents: [],
    };

    for (const event of events) {
      const existing = state.runnerEvents.find(
        (candidate) => candidate.eventId === event.eventId,
      );
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          result.rejectedEvents.push({
            eventId: event.eventId,
            kind: event.kind,
            reason: "event id collision",
          });
        } else {
          result.acceptedEventIds.push(event.eventId);
          result.duplicateEventIds.push(event.eventId);
        }
        continue;
      }

      const runner = state.runners[runnerKey(event.tenantId, event.runnerId)];
      if (!runner) {
        result.rejectedEvents.push({
          eventId: event.eventId,
          kind: event.kind,
          reason: "unknown runner identity",
        });
        continue;
      }

      try {
        assertRunnerEventEnvelope({ event, policy: runner.policy });
        assertMetadataBoundary({ event, policy: runner.policy });
        if (event.taskId) {
          requireAssignment(state, event.tenantId, event.taskId);
        }
      } catch (error) {
        result.rejectedEvents.push({
          eventId: event.eventId,
          kind: event.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      state.runnerEvents.push(event);
      applyRunnerEvent(state, event);
      result.acceptedEventIds.push(event.eventId);
    }

    await writeControlPlaneState(this.#path, state);
    return result;
  }

  async getRunner(input: {
    tenantId: string;
    runnerId: string;
  }): Promise<StoredRunnerRegistration | undefined> {
    const state = await readControlPlaneState(this.#path);
    return state.runners[runnerKey(input.tenantId, input.runnerId)];
  }

  async getAssignment(input: {
    tenantId: string;
    taskId: string;
  }): Promise<StoredRunnerAssignment | undefined> {
    const state = await readControlPlaneState(this.#path);
    return state.assignments[assignmentKey(input.tenantId, input.taskId)];
  }

  async listRunnerEvents(): Promise<RunnerToControlPlaneEvent[]> {
    const state = await readControlPlaneState(this.#path);
    return [...state.runnerEvents];
  }

  #isoNow(now?: () => Date): string {
    return (now ?? this.#now ?? (() => new Date()))().toISOString();
  }
}

export interface FileRunnerEventOutboxOptions {
  path: string;
}

export class FileRunnerEventOutbox {
  readonly #path: string;

  constructor(options: FileRunnerEventOutboxOptions) {
    this.#path = options.path;
  }

  async enqueue(
    events: RunnerToControlPlaneEvent | RunnerToControlPlaneEvent[],
  ): Promise<void> {
    const state = await readOutboxState(this.#path);
    const incoming = Array.isArray(events) ? events : [events];
    const byId = new Map(state.events.map((event) => [event.eventId, event]));
    for (const event of incoming) {
      byId.set(event.eventId, event);
    }
    state.events = [...byId.values()];
    await writeOutboxState(this.#path, state);
  }

  async listEvents(): Promise<RunnerToControlPlaneEvent[]> {
    const state = await readOutboxState(this.#path);
    return [...state.events];
  }

  async replay(
    sender: (
      events: RunnerToControlPlaneEvent[],
    ) => Promise<RunnerEventReportResult> | RunnerEventReportResult,
  ): Promise<RunnerEventReportResult> {
    const state = await readOutboxState(this.#path);
    if (state.events.length === 0) {
      return { acceptedEventIds: [], duplicateEventIds: [], rejectedEvents: [] };
    }
    const report = await sender([...state.events]);
    const accepted = new Set(report.acceptedEventIds);
    state.events = state.events.filter((event) => !accepted.has(event.eventId));
    await writeOutboxState(this.#path, state);
    return report;
  }
}

function applyRunnerEvent(
  state: FileRunnerControlPlaneState,
  event: RunnerToControlPlaneEvent,
): void {
  const runner = requireRunner(state, event.tenantId, event.runnerId);
  runner.updatedAt = event.createdAt;

  if (event.kind === "runner.heartbeat") {
    runner.lastSeenAt = event.createdAt;
    runner.status = stringPayload(event.payload, "status");
    runner.version = stringPayload(event.payload, "version");
    runner.activeRunIds = stringArrayPayload(event.payload, "activeRunIds");
    return;
  }

  if (!event.taskId) {
    return;
  }
  const assignment = requireAssignment(state, event.tenantId, event.taskId);
  assignment.updatedAt = event.createdAt;

  if (event.kind === "task.accepted") {
    assignment.status = "accepted";
    return;
  }
  if (event.kind === "task.rejected") {
    assignment.status = "rejected";
    assignment.rejection = {
      reason: stringPayload(event.payload, "reason") ?? "rejected",
      safeMessage: stringPayload(event.payload, "safeMessage") ?? "rejected",
    };
    return;
  }
  if (event.kind === "run.preparing") {
    assignment.status = "preparing";
    assignment.latestRunId = event.runId ?? stringPayload(event.payload, "runId");
    return;
  }
  if (event.kind === "run.started") {
    assignment.status = "running";
    assignment.latestRunId = event.runId ?? stringPayload(event.payload, "runId");
    return;
  }
  if (event.kind === "run.blocked") {
    assignment.status = "blocked";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.blocker = {
      runId: assignment.latestRunId,
      stageId: stringPayload(event.payload, "stageId"),
      category: stringPayload(event.payload, "blockerCategory"),
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
    return;
  }
  if (event.kind === "run.cancelled") {
    assignment.status = "cancelled";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.cancellation = {
      runId: assignment.latestRunId,
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
    return;
  }
  if (event.kind === "run.completed") {
    assignment.status = "completed";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.changeRequestUrl =
      stringPayload(event.payload, "changeRequestUrl") ??
      stringPayload(event.payload, "prUrl");
    assignment.evidenceSummary = event.payload.evidenceSummary;
    return;
  }
  if (event.kind === "run.failed") {
    assignment.status = "failed";
    assignment.latestRunId =
      event.runId ?? stringPayload(event.payload, "runId") ?? assignment.latestRunId;
    assignment.failure = {
      runId: assignment.latestRunId,
      category: stringPayload(event.payload, "failureCategory"),
      safeMessage: stringPayload(event.payload, "safeMessage"),
    };
  }
}

function emptyControlPlaneState(): FileRunnerControlPlaneState {
  return { version: 1, runners: {}, assignments: {}, runnerEvents: [] };
}

function emptyOutboxState(): FileRunnerOutboxState {
  return { version: 1, events: [] };
}

async function readControlPlaneState(
  path: string,
): Promise<FileRunnerControlPlaneState> {
  const raw = await readJsonFile(path);
  if (raw === undefined) {
    return emptyControlPlaneState();
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error("invalid runner control-plane state: version must be 1");
  }
  return {
    version: 1,
    runners: isRecord(raw.runners)
      ? (raw.runners as Record<string, StoredRunnerRegistration>)
      : {},
    assignments: isRecord(raw.assignments)
      ? (raw.assignments as Record<string, StoredRunnerAssignment>)
      : {},
    runnerEvents: Array.isArray(raw.runnerEvents)
      ? (raw.runnerEvents as RunnerToControlPlaneEvent[])
      : [],
  };
}

async function writeControlPlaneState(
  path: string,
  state: FileRunnerControlPlaneState,
): Promise<void> {
  await writeJsonFile(path, state);
}

async function readOutboxState(path: string): Promise<FileRunnerOutboxState> {
  const raw = await readJsonFile(path);
  if (raw === undefined) {
    return emptyOutboxState();
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error("invalid runner outbox state: version must be 1");
  }
  return {
    version: 1,
    events: Array.isArray(raw.events)
      ? (raw.events as RunnerToControlPlaneEvent[])
      : [],
  };
}

async function writeOutboxState(
  path: string,
  state: FileRunnerOutboxState,
): Promise<void> {
  await writeJsonFile(path, state);
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

function runnerKey(tenantId: string, runnerId: string): string {
  return `${tenantId}:${runnerId}`;
}

function assignmentKey(tenantId: string, taskId: string): string {
  return `${tenantId}:${taskId}`;
}

function requireRunner(
  state: FileRunnerControlPlaneState,
  tenantId: string,
  runnerId: string,
): StoredRunnerRegistration {
  const runner = state.runners[runnerKey(tenantId, runnerId)];
  if (!runner) {
    throw new Error(`unknown runner: ${tenantId}/${runnerId}`);
  }
  return runner;
}

function requireAssignment(
  state: FileRunnerControlPlaneState,
  tenantId: string,
  taskId: string,
): StoredRunnerAssignment {
  const assignment = state.assignments[assignmentKey(tenantId, taskId)];
  if (!assignment) {
    throw new Error(`unknown runner assignment: ${tenantId}/${taskId}`);
  }
  return assignment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringPayload(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayPayload(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
