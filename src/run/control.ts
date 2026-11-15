import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EventStore } from "../events/store.js";
import {
  ResumeClaimStore,
  resumeClaimStorePath,
} from "../scheduler/resume-claim.js";
import { listUnifiedWorkItems } from "../work-items/access.js";
import { reconcileTerminalWorkItemRun } from "./admission.js";
import { RunAdmissionStore } from "./admission-store.js";
import { resolveApproval } from "./approvals.js";
import { eventStorePath, projectRun, type ProjectedApproval } from "./project.js";
import type {
  RunCancellationControl,
  RunCancellationRequest,
  RunCancellationStage,
} from "./run-flow.js";
import { exportRunTrace, otlpTraceConfigFromEnv } from "../telemetry/run-trace-otel.js";

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
  const store = new EventStore(eventStorePath(input.repoPath));
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
        const traceStore = new EventStore(eventStorePath(repoPath));
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

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
]);

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
  const events = new EventStore(eventStorePath(input.repoPath));
  try {
    if (!TERMINAL_RUN_STATUSES.has(projectRun(events.list(input.runId)).status)) {
      events.append({
        runId: input.runId,
        type: "run.failed",
        payload: { error: `approval ${input.approvalId} denied` },
      });
    }
  } finally {
    events.close();
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
  return approval;
}
