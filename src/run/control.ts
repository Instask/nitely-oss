import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ResumeClaimStore,
  resumeClaimStorePath,
} from "../scheduler/resume-claim.js";
import {
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  updateWorkItemRunState,
} from "../work-items/access.js";
import {
  reconcileTerminalWorkItemRun,
  settleWorkItemRun,
} from "./admission.js";
import { RunAdmissionStore } from "./admission-store.js";
import { resolveApproval } from "./approvals.js";
import {
  projectRun,
  type ProjectedApproval,
  type ProjectedRun,
  type ProjectedRunStatus,
} from "./project.js";
import type {
  RunCancellationControl,
  RunCancellationRequest,
  RunCancellationStage,
  RunFlowInput,
  RunFlowResult,
} from "./run-flow.js";
import { exportRunTrace, otlpTraceConfigFromEnv } from "../telemetry/run-trace-otel.js";

import { openRunEventStore, type EventStore } from "../events/run-events.js";
/**
 * Raised when another owner already holds the Run continuation claim, so this
 * caller must not resume the Run.
 */
export class RunContinuationClaimConflictError extends Error {
  constructor(public readonly runId: string) {
    super(`run is already being resumed: ${runId}`);
    this.name = "RunContinuationClaimConflictError";
  }
}

/**
 * Take the Run continuation claim for `runId`. Returns the release function,
 * or undefined when another owner already holds the claim. Callers that must
 * answer before the resume finishes (the Web resume route) take the claim
 * here; everyone else uses `withRunContinuationClaim`.
 */
export async function claimRunContinuation(
  repoPath: string,
  runId: string,
): Promise<(() => void) | undefined> {
  await mkdir(join(resolve(repoPath), ".nitely"), { recursive: true });
  const token = randomUUID();
  const withClaims = <R>(use: (claims: ResumeClaimStore) => R): R => {
    const claims = new ResumeClaimStore(resumeClaimStorePath(repoPath));
    try {
      return use(claims);
    } finally {
      claims.close();
    }
  };
  if (!withClaims((claims) => claims.claim({ runId, token, now: new Date() }))) {
    return undefined;
  }
  return () => {
    withClaims((claims) => claims.release(runId, token));
  };
}

/**
 * Run `operation` while holding the Run continuation claim for `runId`. Every
 * entry point that resumes an existing Run goes through this, so a CLI resume
 * cannot race a Web, scheduler or rollback resume of the same Run.
 */
export async function withRunContinuationClaim<T>(
  repoPath: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await claimRunContinuation(repoPath, runId);
  if (!release) {
    throw new RunContinuationClaimConflictError(runId);
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

interface ActiveRun {
  repoPath: string;
  runId: string;
  controller: AbortController;
  request?: RunCancellationRequest;
  stage?: RunCancellationStage;
  startedAt: string;
}

/** Runs this process is executing, so a cancel can signal their runner. */
const activeRuns = new Map<string, ActiveRun>();

function activeRunKey(repoPath: string, runId: string): string {
  return `${resolve(repoPath)}\u0000${runId}`;
}

/**
 * Register a Run this process is about to execute. Pass `control` to the
 * runner as its cancellation control and call `finish` when it returns.
 * Register before the runner starts so a cancel that lands mid-run can abort it.
 */
export function registerActiveRun(input: { repoPath: string; runId: string }): {
  control: RunCancellationControl;
  finish: () => void;
} {
  const run: ActiveRun = {
    repoPath: resolve(input.repoPath),
    runId: input.runId,
    controller: new AbortController(),
    startedAt: new Date().toISOString(),
  };
  const key = activeRunKey(run.repoPath, run.runId);
  activeRuns.set(key, run);
  return {
    control: {
      signal: run.controller.signal,
      getRequest: () => run.request,
      onStageChange: (stage) => {
        run.stage = stage;
      },
    },
    finish: () => {
      // A later registration for the same Run owns the slot now.
      if (activeRuns.get(key) === run) activeRuns.delete(key);
    },
  };
}

/** Raised when a Run cannot be cancelled: it is missing or already terminal. */
export class RunCancellationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancellationRefusedError";
  }
}

export interface CancelRunInput {
  repoPath: string;
  runId: string;
  actor: string;
  reason: string;
  source: string;
  /** How refusals name the Run, e.g. "linked run" for notification actions. */
  subject?: string;
  notificationId?: string;
  sourceKey?: string;
  workItemId?: string;
}

/**
 * Cancel a non-terminal Run: record `run.cancelled` with the actor and reason,
 * signal its runner if this process executes it, and settle the Work item it
 * belongs to so the Work item leaves `running` and can start again.
 */
export async function cancelRun(input: CancelRunInput): Promise<void> {
  const subject = input.subject ?? "run";
  // Look at the runner without signalling it: a refused cancel must not abort
  // anything.
  const active = activeRuns.get(activeRunKey(input.repoPath, input.runId));
  const requestedAt = new Date().toISOString();
  const store = openRunEventStore(input.repoPath);
  try {
    // BEGIN IMMEDIATE holds SQLite's write lock, so the status read and the
    // append are atomic against every other event writer: a run that
    // completes, fails, blocks, or is cancelled concurrently is either seen
    // here as terminal or writes its event after this one.
    store.transaction(() => {
      const events = store.list(input.runId);
      if (events.length === 0) {
        throw new RunCancellationRefusedError(`${subject} was not found`);
      }
      const status = projectRun(events, {
        openAttemptStatus: "interrupted",
      }).status;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        throw new RunCancellationRefusedError(`${subject} is already ${status}`);
      }
      store.append({
        runId: input.runId,
        ...(active?.stage?.stageId ? { stageId: active.stage.stageId } : {}),
        ...(active?.stage?.attempt !== undefined ? { attempt: active.stage.attempt } : {}),
        type: "run.cancelled",
        payload: {
          actor: input.actor,
          ...(input.notificationId ? { notificationId: input.notificationId } : {}),
          ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
          reason: input.reason,
          requestedAt,
          cancelledAt: new Date().toISOString(),
          source: input.source,
          affectedStage: active?.stage?.stageId,
          affectedAttempt: active?.stage?.attempt,
          cleanup: active
            ? {
                result: "abort-signal-dispatched",
                activeSince: active.startedAt,
                terminateWithinMs: 10_000,
              }
            : {
                result: "no-active-process",
              },
        },
      });
    });
  } finally {
    store.close();
  }
  // Only a recorded cancellation signals the runner. It then stops at its next
  // cancellation check and, seeing run.cancelled, writes no terminal event of
  // its own.
  if (active) {
    active.request = {
      actor: input.actor,
      reason: input.reason,
      requestedAt: new Date().toISOString(),
      source: input.source,
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
      ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
    };
    if (!active.controller.signal.aborted) {
      active.controller.abort(active.request);
    }
  }
  const workItemId =
    input.workItemId ?? (await workItemIdForRun(input.repoPath, input.runId));
  if (workItemId) {
    await reconcileTerminalWorkItemRun({
      repoPath: input.repoPath,
      workItemId,
      runId: input.runId,
    });
  }
  // An active run exports its trace when it returns; a stopped one has no
  // runner left to do it. Not awaited: the cancel answers without waiting
  // on the collector.
  if (!active && otlpTraceConfigFromEnv()) {
    const repoPath = input.repoPath;
    const runId = input.runId;
    void exportRunTrace({
      runId,
      listEvents: () => {
        const traceStore = openRunEventStore(repoPath);
        try {
          return traceStore.list(runId);
        } finally {
          traceStore.close();
        }
      },
    });
  }
}

/**
 * The Work item a Run belongs to: its admission record, or for a Run that
 * predates the admission ledger, the Work item whose latest Run it is.
 */
export async function workItemIdForRun(
  repoPath: string,
  runId: string,
): Promise<string | undefined> {
  const admissionsPath = join(resolve(repoPath), ".nitely", "run-admissions.db");
  if (existsSync(admissionsPath)) {
    const admissions = new RunAdmissionStore(admissionsPath);
    try {
      const admitted = admissions.get(runId)?.workItemId;
      if (admitted) return admitted;
    } finally {
      admissions.close();
    }
  }
  const workItems = await listUnifiedWorkItems(repoPath);
  return workItems.find((item) => item.latestRunId === runId)?.id;
}

const TERMINAL_RUN_STATUSES = new Set<ProjectedRunStatus>([
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
]);

/**
 * Whether no runner is going to write another lifecycle event for a Run in
 * this status without an explicit resume.
 */
export function isSettledRunStatus(status: ProjectedRunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

/** The Run's projected status, or undefined when it has no events. */
export function runStatus(
  repoPath: string,
  runId: string,
): ProjectedRunStatus | undefined {
  const store = openRunEventStore(repoPath);
  try {
    const events = store.list(runId);
    return events.length > 0 ? projectRun(events).status : undefined;
  } finally {
    store.close();
  }
}

/** Raised when a Run cannot be resumed from its current status. */
export class RunResumeRefusedError extends Error {
  constructor(message = "only blocked or interrupted runs can be resumed") {
    super(message);
    this.name = "RunResumeRefusedError";
  }
}

/** Whether a Run in this status may be resumed. */
export function isResumableRunStatus(status: string | undefined): boolean {
  return status === "blocked" || status === "interrupted";
}

/**
 * The Run's projection, treating an attempt with no runner as interrupted.
 * Refuses with `RunResumeRefusedError` unless the Run may be resumed.
 */
export function requireResumableRun(repoPath: string, runId: string): ProjectedRun {
  const store = openRunEventStore(repoPath);
  let run: ProjectedRun;
  try {
    run = projectRun(store.list(runId), { openAttemptStatus: "interrupted" });
  } finally {
    store.close();
  }
  if (!isResumableRunStatus(run.status)) {
    throw new RunResumeRefusedError();
  }
  return run;
}

function appendRunCreated(
  store: EventStore,
  input: {
    repoPath: string;
    runId: string;
    branchName: string;
    runInput: RunFlowInput & { workItemId: string };
  },
): void {
  const { runInput } = input;
  store.append({
    runId: input.runId,
    type: "run.created",
    payload: {
      flowPath: runInput.flowPath,
      repoPath: input.repoPath,
      repoId: runInput.repoId,
      repoName: runInput.repoName,
      inputs: runInput.inputs,
      configuration: runInput.configuration,
      overrides: runInput.overrides,
      aliasOf: runInput.aliasOf,
      providerConnections: runInput.providerConnections,
      branchName: input.branchName,
      workItemId: runInput.workItemId,
      workItemType: runInput.workItemType,
      ownerId: runInput.ownerId,
      organizationId: runInput.organizationId,
      planningApproval: runInput.planningApproval,
      runEligibilityOverride: runInput.runEligibilityOverride,
    },
  });
}

/**
 * Record a completed runner result unless the Run is already settled. A runner
 * normally records its own outcome; this covers runners (injected or older)
 * that return without one, recording `run.created` first when the Run has no
 * events and belongs to a Work item. Checked and appended in one write
 * transaction, so a concurrent cancel is never followed by `run.completed`.
 */
export function recordRunnerCompletion(input: {
  repoPath: string;
  result: RunFlowResult;
  runInput?: RunFlowInput;
}): void {
  const { result, runInput } = input;
  const store = openRunEventStore(input.repoPath);
  try {
    store.transaction(() => {
      const events = store.list(result.runId);
      if (events.length > 0 && isSettledRunStatus(projectRun(events).status)) return;
      if (events.length === 0 && runInput?.workItemId) {
        appendRunCreated(store, {
          repoPath: input.repoPath,
          runId: result.runId,
          branchName: result.branchName,
          runInput: { ...runInput, workItemId: runInput.workItemId },
        });
      }
      store.append({
        runId: result.runId,
        type: "run.completed",
        payload: {
          changeRequestUrl: result.changeRequestUrl,
          changeRequest: result.changeRequest,
        },
      });
    });
  } finally {
    store.close();
  }
}

const TERMINAL_RUN_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.blocked",
  "run.cancelled",
]);

/** The sequence of the Run's latest event, or 0 when it has none. */
export function latestRunEventSequence(repoPath: string, runId: string): number {
  const store = openRunEventStore(repoPath);
  try {
    return store.latest(runId)?.sequence ?? 0;
  } finally {
    store.close();
  }
}

/**
 * Record a runner error as `run.failed` unless the runner already settled the
 * Run. By default a Run in a settled status is left alone. A caller resuming a
 * Run that was already blocked passes `afterSequence`, the latest sequence
 * before it started, so only a terminal event the runner wrote since counts.
 * Returns the Run's projection afterwards.
 */
export function recordRunnerFailure(input: {
  repoPath: string;
  runId: string;
  error: unknown;
  afterSequence?: number;
}): ProjectedRun {
  const store = openRunEventStore(input.repoPath);
  try {
    return store.transaction(() => {
      const events = store.list(input.runId);
      const settled = input.afterSequence === undefined
        ? events.length > 0 && isSettledRunStatus(projectRun(events).status)
        : events.some(
            (event) =>
              event.sequence > input.afterSequence! &&
              TERMINAL_RUN_EVENT_TYPES.has(event.type),
          );
      if (!settled) {
        store.append({
          runId: input.runId,
          type: "run.failed",
          payload: {
            error: input.error instanceof Error ? input.error.message : String(input.error),
          },
        });
      }
      // Either way the Run now has events: the settled one, or run.failed.
      return projectRun(settled ? events : store.list(input.runId));
    });
  } finally {
    store.close();
  }
}

/**
 * Settle a Work item's Run as completed or failed. A Run that predates the
 * admission ledger is settled by updating the Work item directly, but only
 * while it is still the Work item's latest Run. Returns whether the Work item
 * still belongs to this Run.
 */
export async function settleRunWorkItem(input: {
  repoPath: string;
  workItemId: string;
  runId: string;
  status: "completed" | "failed";
  changeRequestUrl?: string;
}): Promise<boolean> {
  const result = await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.workItemId,
    runId: input.runId,
    status: input.status,
    ...(input.changeRequestUrl ? { changeRequestUrl: input.changeRequestUrl } : {}),
  });
  if (result.settled) return true;
  if (
    result.reason !== "not-admitted" ||
    result.workItem.latestRunId !== input.runId
  ) {
    return false;
  }
  await updateWorkItemRunState(
    input.repoPath,
    input.workItemId,
    {
      status: input.status,
      latestRunId: input.runId,
      ...(input.changeRequestUrl ? { changeRequestUrl: input.changeRequestUrl } : {}),
    },
    result.storeKind,
  );
  return true;
}

/**
 * Settle an admitted Run whose runner threw: record the failure unless the
 * runner already settled the Run, then settle its Work item. A blocked Run
 * keeps its Work item, which waits on the blocker.
 */
export async function settleAdmittedRunAfterRunnerError(input: {
  repoPath: string;
  workItemId: string;
  runId: string;
  error: unknown;
}): Promise<"blocked" | "completed" | "failed"> {
  recordRunnerFailure(input);
  const projectedStatus = runStatus(input.repoPath, input.runId);
  if (projectedStatus === "blocked") {
    return "blocked";
  }
  const status = projectedStatus === "completed" ? "completed" : "failed";
  await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.workItemId,
    runId: input.runId,
    status,
  });
  return status;
}

/**
 * Settle a resumed Run whose runner threw. Returns whether the Work item still
 * belongs to this Run, so the caller knows whether to tell anyone about it.
 */
export async function settleResumedRunAfterError(input: {
  repoPath: string;
  workItemId: string;
  runId: string;
  error: unknown;
}): Promise<boolean> {
  recordRunnerFailure(input);
  if (runStatus(input.repoPath, input.runId) === "blocked") {
    return (await getUnifiedWorkItem(input.repoPath, input.workItemId)).latestRunId ===
      input.runId;
  }
  return await settleRunWorkItem({
    repoPath: input.repoPath,
    workItemId: input.workItemId,
    runId: input.runId,
    status: "failed",
  });
}

/**
 * Settle the Work item of a Run whose resume returned. The runner recorded the
 * Run's outcome; this lets the Work item follow it.
 */
export async function settleResumedRun(input: {
  repoPath: string;
  runId: string;
}): Promise<void> {
  const workItemId = await workItemIdForRun(input.repoPath, input.runId);
  if (workItemId) {
    await reconcileTerminalWorkItemRun({
      repoPath: input.repoPath,
      workItemId,
      runId: input.runId,
    });
  }
}

/**
 * Record why a requested resume did not happen. A resume refused or stopped
 * because the Run was cancelled is not recorded: the cancellation explains it.
 * Returns whether a failure was recorded.
 */
export function recordRunResumeFailure(input: {
  repoPath: string;
  runId: string;
  message: string;
  actor: string;
  source: string;
}): boolean {
  const store = openRunEventStore(input.repoPath);
  try {
    return store.transaction(() => {
      const events = store.list(input.runId);
      if (events.length > 0 && projectRun(events).status === "cancelled") return false;
      store.append({
        runId: input.runId,
        type: "run.resume.failed",
        payload: { message: input.message, actor: input.actor, source: input.source },
      });
      return true;
    });
  } finally {
    store.close();
  }
}

/**
 * Deny a pending approval and settle its Run: a denied approval fails the Run,
 * and the Work item that owns it leaves `running`.
 */
export async function denyRunApproval(input: {
  repoPath: string;
  runId: string;
  approvalId: string;
  actor?: string;
  workItemId?: string;
}): Promise<ProjectedApproval> {
  const approval = await resolveApproval({
    repoPath: input.repoPath,
    runId: input.runId,
    approvalId: input.approvalId,
    decision: "denied",
    ...(input.actor ? { actor: input.actor } : {}),
  });
  recordRunnerFailure({
    repoPath: input.repoPath,
    runId: input.runId,
    error: `approval ${input.approvalId} denied`,
  });
  const workItemId =
    input.workItemId ?? (await workItemIdForRun(input.repoPath, input.runId));
  if (workItemId) {
    await reconcileTerminalWorkItemRun({
      repoPath: input.repoPath,
      workItemId,
      runId: input.runId,
    });
  }
  return approval;
}

/**
 * Decide a pending approval. Approving records the decision; the Run continues
 * when it is next resumed. Denying is terminal: it fails the Run and settles
 * its Work item.
 */
export async function decideRunApproval(input: {
  repoPath: string;
  runId: string;
  approvalId: string;
  decision: "approved" | "denied";
  actor?: string;
  workItemId?: string;
}): Promise<ProjectedApproval> {
  if (input.decision === "denied") {
    return await denyRunApproval(input);
  }
  return await resolveApproval({
    repoPath: input.repoPath,
    runId: input.runId,
    approvalId: input.approvalId,
    decision: "approved",
    ...(input.actor ? { actor: input.actor } : {}),
  });
}
