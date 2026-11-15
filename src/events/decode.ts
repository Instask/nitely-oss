import type { TaskPlanHistoryEntry } from "../task-artifacts/plan.js";
import type {
  ApprovalRequestedPayload,
  ApprovalResolvedPayload,
  RunBlockedPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunResumedPayload,
  RunResumeFailedPayload,
  StageCompletedPayload,
  StageFailedPayload,
  TaskPlanEventTask,
  TaskPlanFinalDeferredPayload,
  TaskPlanLoopContinuesPayload,
  TaskPlanProgressPayload,
  TypedRunEventPayloads,
  TypedRunEventType,
} from "./payloads.js";
import type { StoredRunEvent } from "./types.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

/**
 * Task plan progress may be recorded partially; readers merge each event
 * onto the state they already hold, so every field is optional on read.
 */
export type DecodedTaskPlanProgress<T extends TaskPlanProgressPayload> = Partial<T>;

/**
 * What `decodeRunEvent` returns for each typed event. It is the written shape,
 * except where a reader must tell a missing field from a recorded one.
 */
export type DecodedRunEventPayloads = Omit<
  TypedRunEventPayloads,
  | "task.plan.iteration.started"
  | "task.plan.task.completed"
  | "task.plan.loop.continues"
  | "task.plan.final.deferred"
  | "task.plan.final.ready"
  | "task.plan.completed"
> & {
  "task.plan.iteration.started": DecodedTaskPlanProgress<TaskPlanProgressPayload>;
  "task.plan.task.completed": DecodedTaskPlanProgress<TaskPlanProgressPayload>;
  "task.plan.loop.continues": DecodedTaskPlanProgress<TaskPlanLoopContinuesPayload>;
  "task.plan.final.deferred": DecodedTaskPlanProgress<TaskPlanFinalDeferredPayload>;
  "task.plan.final.ready": DecodedTaskPlanProgress<TaskPlanProgressPayload>;
  "task.plan.completed": DecodedTaskPlanProgress<TaskPlanProgressPayload>;
};

type Decoder<K extends TypedRunEventType> = (
  payload: Record<string, unknown>,
  event: StoredRunEvent,
) => DecodedRunEventPayloads[K] | undefined;

function definedFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function decodeRunBlocked(payload: Record<string, unknown>): RunBlockedPayload | undefined {
  const reason = asString(payload.reason);
  if (!reason) return undefined;
  return definedFields({
    reason,
    stageId: asString(payload.stageId),
    runtime: asString(payload.runtime),
    message: asString(payload.message),
    retryAfter: asString(payload.retryAfter),
    questionId: asString(payload.questionId),
  });
}

function approvalIdFor(
  payload: Record<string, unknown>,
  event: StoredRunEvent,
): string | undefined {
  const approvalId = asString(payload.approvalId);
  if (approvalId) return approvalId;
  if (!event.stageId || !event.attempt) return undefined;
  return `${event.stageId}-${event.attempt}`;
}

const TASK_PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "blocked"]);

/**
 * Decodes recorded task plan history. A malformed entry rejects the whole
 * history, so a reader keeps what it had instead of adopting a partial one.
 */
export function decodeTaskPlanHistory(value: unknown): TaskPlanHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: TaskPlanHistoryEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const taskId = asString(record.taskId);
    const status = record.status;
    if (!taskId || typeof status !== "string" || !TASK_PLAN_STATUSES.has(status)) {
      return undefined;
    }
    entries.push({
      taskId,
      status: status as TaskPlanHistoryEntry["status"],
      ...(typeof record.stageId === "string" ? { stageId: record.stageId } : {}),
      ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    });
  }
  return entries;
}

function decodeTaskPlanTask(value: unknown): TaskPlanEventTask | undefined {
  const record = asRecord(value);
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return undefined;
  const status = asString(record.status);
  return definedFields({
    id,
    title,
    status: (status && TASK_PLAN_STATUSES.has(status)
      ? status
      : "pending") as TaskPlanEventTask["status"],
    dependencies: asStringArray(record.dependencies) ?? [],
    paths: asStringArray(record.paths) ?? [],
    notes: asString(record.notes),
  });
}

function decodeTaskPlanProgress(
  payload: Record<string, unknown>,
): DecodedTaskPlanProgress<TaskPlanProgressPayload> {
  const iteration = asNumber(payload.iteration);
  const maxIterations = asNumber(payload.maxIterations);
  return definedFields({
    inputId: asString(payload.inputId),
    version: asString(payload.version),
    currentTask: decodeTaskPlanTask(payload.currentTask),
    currentTaskId: asString(payload.currentTaskId),
    completedTaskIds: asStringArray(payload.completedTaskIds),
    remainingTaskIds: asStringArray(payload.remainingTaskIds),
    completedCount: asNumber(payload.completedCount),
    remainingCount: asNumber(payload.remainingCount),
    totalTaskCount: asNumber(payload.totalTaskCount),
    iteration: iteration !== undefined && Number.isInteger(iteration) ? iteration : undefined,
    maxIterations:
      maxIterations !== undefined && Number.isInteger(maxIterations) && maxIterations > 0
        ? maxIterations
        : undefined,
    history: decodeTaskPlanHistory(payload.history),
    targetStage: asString(payload.targetStage),
  });
}

const decoders: { [K in TypedRunEventType]: Decoder<K> } = {
  "run.completed": (payload): RunCompletedPayload =>
    definedFields({
      changeRequestUrl: asString(payload.changeRequestUrl),
      url: asString(payload.url),
      changeRequest: payload.changeRequest,
      changeRequestTarget: payload.changeRequestTarget,
      sync: payload.sync,
      trigger: payload.trigger,
      priorRunId: asString(payload.priorRunId),
    }),
  "run.failed": (payload): RunFailedPayload =>
    definedFields({
      error: asString(payload.error) ?? "run failed",
      stageId: asString(payload.stageId),
      reason: asString(payload.reason),
      hookPhase: asString(payload.hookPhase),
    }),
  "run.blocked": decodeRunBlocked,
  "run.cancelled": (payload, event): RunCancelledPayload =>
    definedFields({
      actor: asString(payload.actor) ?? "system",
      reason: asString(payload.reason) ?? "run cancellation requested",
      requestedAt: asString(payload.requestedAt) ?? event.createdAt,
      cancelledAt: asString(payload.cancelledAt) ?? event.createdAt,
      source: asString(payload.source) ?? "unknown",
      notificationId: asString(payload.notificationId),
      sourceKey: asString(payload.sourceKey),
      affectedStage: asString(payload.affectedStage),
      affectedAttempt: asNumber(payload.affectedAttempt),
      cleanup: payload.cleanup,
    }),
  "run.resumed": (payload): RunResumedPayload =>
    definedFields({
      reason: asString(payload.reason),
      selectedStageId: asString(payload.selectedStageId),
      consumed: payload.consumed,
      cap: payload.cap,
      budgets:
        typeof payload.budgets === "object" && payload.budgets !== null
          ? payload.budgets
          : undefined,
    }),
  "run.resume.failed": (payload): RunResumeFailedPayload =>
    definedFields({
      message: asString(payload.message) ?? "resume failed",
      actor: asString(payload.actor),
      source: asString(payload.source),
    }),
  "stage.completed": (payload): StageCompletedPayload => ({
    ...payload,
    ...definedFields({ outputs: asStringArray(payload.outputs) }),
  }),
  "stage.failed": (payload): StageFailedPayload => ({
    ...payload,
    ...definedFields({ error: asString(payload.error) }),
  }),
  "stage.blocked": decodeRunBlocked,
  "approval.requested": (payload, event): ApprovalRequestedPayload | undefined => {
    const approvalId = approvalIdFor(payload, event);
    if (!approvalId) return undefined;
    return definedFields({
      approvalId,
      prompt: asString(payload.prompt),
      reviewedArtifactIds: asStringArray(payload.reviewedArtifactIds),
      pauseTimeoutMs: asNumber(payload.pauseTimeoutMs),
    });
  },
  "approval.resolved": (payload, event): ApprovalResolvedPayload | undefined => {
    const approvalId = approvalIdFor(payload, event);
    if (!approvalId) return undefined;
    const decision = asString(payload.decision);
    return definedFields({
      approvalId,
      approved: payload.approved === true || decision === "approved",
      decision:
        decision === "approved" || decision === "denied"
          ? (decision as ApprovalResolvedPayload["decision"])
          : undefined,
      actor: asString(payload.actor),
      prompt: asString(payload.prompt),
      reviewedArtifactIds: asStringArray(payload.reviewedArtifactIds),
    });
  },
  "task.plan.iteration.started": decodeTaskPlanProgress,
  "task.plan.task.completed": decodeTaskPlanProgress,
  "task.plan.loop.continues": (payload) =>
    definedFields({
      ...decodeTaskPlanProgress(payload),
      reopenedTaskId: asString(payload.reopenedTaskId),
      reason: asString(payload.reason),
      reworkRequest: payload.reworkRequest,
    }),
  "task.plan.final.deferred": (payload) =>
    definedFields({
      ...decodeTaskPlanProgress(payload),
      reason: asString(payload.reason),
    }),
  "task.plan.final.ready": decodeTaskPlanProgress,
  "task.plan.completed": decodeTaskPlanProgress,
};

export function isTypedRunEventType(type: string): type is TypedRunEventType {
  return Object.hasOwn(decoders, type);
}

/**
 * Decodes the payload of a stored event of `type`. Returns `undefined` when the
 * event is of another type or its payload lacks the fields that identify it.
 */
export function decodeRunEvent<K extends TypedRunEventType>(
  event: StoredRunEvent,
  type: K,
): DecodedRunEventPayloads[K] | undefined {
  if (event.type !== type) return undefined;
  return (decoders[type] as Decoder<K>)(asRecord(event.payload), event);
}
