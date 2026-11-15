import type { RunBlocker } from "../run/blockers.js";
import type {
  TaskPlanHistoryEntry,
  TaskPlanTask,
} from "../task-artifacts/plan.js";

/**
 * Payload shapes for the Run events whose writers and readers live in
 * different modules. Writers are checked against these through
 * `EventStore.append`; readers get the same shapes back from
 * `decodeRunEvent`. Event types not listed here still carry an untyped
 * payload.
 */
export interface TypedRunEventPayloads {
  "run.completed": RunCompletedPayload;
  "run.failed": RunFailedPayload;
  "run.blocked": RunBlockedPayload;
  "run.cancelled": RunCancelledPayload;
  "run.resumed": RunResumedPayload;
  "run.resume.failed": RunResumeFailedPayload;
  "stage.completed": StageCompletedPayload;
  "stage.failed": StageFailedPayload;
  "stage.blocked": RunBlockedPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "task.plan.iteration.started": TaskPlanProgressPayload;
  "task.plan.task.completed": TaskPlanProgressPayload;
  "task.plan.loop.continues": TaskPlanLoopContinuesPayload;
  "task.plan.final.deferred": TaskPlanFinalDeferredPayload;
  "task.plan.final.ready": TaskPlanProgressPayload;
  "task.plan.completed": TaskPlanProgressPayload;
}

export type TypedRunEventType = keyof TypedRunEventPayloads;

export interface RunCompletedPayload {
  changeRequestUrl?: string;
  /** Older writers recorded the change request URL as `url`. */
  url?: string;
  changeRequest?: unknown;
  changeRequestTarget?: unknown;
  sync?: unknown;
  trigger?: unknown;
  priorRunId?: string;
}

export interface RunFailedPayload {
  error: string;
  stageId?: string;
  reason?: string;
  hookPhase?: string;
}

export type RunBlockedPayload = Partial<Omit<RunBlocker, "reason">> & {
  reason: string;
};

export interface RunCancelledPayload {
  actor: string;
  reason: string;
  requestedAt: string;
  cancelledAt: string;
  source: string;
  notificationId?: string;
  sourceKey?: string;
  affectedStage?: string;
  affectedAttempt?: number;
  cleanup?: unknown;
}

export interface RunResumedPayload {
  reason?: string;
  selectedStageId?: string;
  consumed?: unknown;
  cap?: unknown;
  budgets?: unknown;
}

export interface RunResumeFailedPayload {
  message: string;
  actor?: string;
  source?: string;
}

export interface StageCompletedPayload {
  outputs?: string[];
  [field: string]: unknown;
}

export interface StageFailedPayload {
  error?: string;
  [field: string]: unknown;
}

export interface ApprovalRequestedPayload {
  approvalId: string;
  prompt?: string;
  reviewedArtifactIds?: string[];
  pauseTimeoutMs?: number;
}

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalResolvedPayload {
  approvalId: string;
  approved: boolean;
  decision?: ApprovalDecision;
  actor?: string;
  prompt?: string;
  reviewedArtifactIds?: string[];
}

export type TaskPlanEventTask = Omit<TaskPlanTask, "raw"> & { raw?: unknown };

export interface TaskPlanProgressPayload {
  inputId: string;
  version?: string;
  currentTask?: TaskPlanEventTask;
  currentTaskId?: string;
  completedTaskIds: string[];
  remainingTaskIds: string[];
  completedCount: number;
  remainingCount: number;
  totalTaskCount: number;
  iteration?: number;
  maxIterations?: number;
  history: TaskPlanHistoryEntry[];
  targetStage?: string;
}

export interface TaskPlanLoopContinuesPayload extends TaskPlanProgressPayload {
  reopenedTaskId?: string;
  reason?: string;
  reworkRequest?: unknown;
}

export interface TaskPlanFinalDeferredPayload extends TaskPlanProgressPayload {
  reason?: string;
}
