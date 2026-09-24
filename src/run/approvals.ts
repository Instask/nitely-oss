import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { EventStore } from "../events/store.js";
import {
  eventStorePath,
  projectRun,
  type ProjectedApproval,
} from "./project.js";

export type ApprovalDecision = "approved" | "denied";

export interface ResolveApprovalInput {
  repoPath: string;
  runId: string;
  approvalId: string;
  decision: ApprovalDecision;
  actor?: string;
}

export async function listApprovals(
  repoPath: string,
  runId: string,
): Promise<ProjectedApproval[]> {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(runId);
    if (events.length === 0) {
      throw new Error(`run not found: ${runId}`);
    }
    return projectRun(events).approvals;
  } finally {
    store.close();
  }
}

export async function resolveApproval(
  input: ResolveApprovalInput,
): Promise<ProjectedApproval> {
  await mkdir(dirname(eventStorePath(input.repoPath)), { recursive: true });
  const store = new EventStore(eventStorePath(input.repoPath));
  try {
    const events = store.list(input.runId);
    if (events.length === 0) {
      throw new Error(`run not found: ${input.runId}`);
    }
    const projection = projectRun(events);
    const approval = projection.approvals.find(
      (candidate) => candidate.id === input.approvalId,
    );
    if (!approval) {
      throw new Error(`approval not found: ${input.approvalId}`);
    }
    if (approval.status !== "pending") {
      throw new Error(
        `approval ${input.approvalId} is already ${approval.status}`,
      );
    }
    store.append({
      runId: input.runId,
      stageId: approval.stageId,
      attempt: approval.attempt,
      type: "approval.resolved",
      payload: {
        approvalId: approval.id,
        approved: input.decision === "approved",
        actor: input.actor ?? "cli",
        decision: input.decision,
        reviewedArtifactIds: approval.reviewedArtifactIds ?? [],
      },
    });
    const resolved = projectRun(store.list(input.runId)).approvals.find(
      (candidate) => candidate.id === input.approvalId,
    );
    if (!resolved) {
      throw new Error(`approval not found after resolving: ${input.approvalId}`);
    }
    return resolved;
  } finally {
    store.close();
  }
}
