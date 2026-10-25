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
 * Run `operation` while holding the Run continuation claim for `runId`. Every
 * entry point that resumes an existing Run goes through this, so a CLI resume
 * cannot race a Web, scheduler or rollback resume of the same Run.
 */
export async function withRunContinuationClaim<T>(
  repoPath: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
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
    throw new RunContinuationClaimConflictError(runId);
  }
  try {
    return await operation();
  } finally {
    withClaims((claims) => claims.release(runId, token));
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
