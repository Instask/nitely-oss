import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { eventStorePath, projectRun, runDirectoryPath } from "./project.js";
import {
  resumeRun as resumeRunFlow,
  type ResumeRunInput,
  type RunFlowResult,
} from "./run-flow.js";
import { buildRunTrace, type RunCheckpoint } from "./trace.js";

const execFileAsync = promisify(execFile);

export const ROLLBACK_WORKTREE_POLICIES = ["preserve", "cleanup"] as const;
export const ROLLBACK_BRANCH_POLICIES = [
  "preserve",
  "reset-to-checkpoint",
] as const;
export const ROLLBACK_CHANGE_POLICIES = [
  "preserve-existing-pr",
  "update-existing-pr",
  "new-pr",
  "none",
] as const;

export type RollbackWorktreePolicy = (typeof ROLLBACK_WORKTREE_POLICIES)[number];
export type RollbackBranchPolicy = (typeof ROLLBACK_BRANCH_POLICIES)[number];
export type RollbackChangePolicy = (typeof ROLLBACK_CHANGE_POLICIES)[number];

export interface RecordRollbackDecisionInput {
  repoPath: string;
  runId: string;
  checkpointId: string;
  actor?: string;
  reason?: string;
  worktreePolicy?: RollbackWorktreePolicy;
  branchPolicy?: RollbackBranchPolicy;
  changePolicy?: RollbackChangePolicy;
  now?: () => Date;
}

export interface RollbackDecisionPolicy {
  worktree: RollbackWorktreePolicy;
  branch: RollbackBranchPolicy;
  change: RollbackChangePolicy;
}

export interface RecordRollbackDecisionResult {
  event: StoredRunEvent;
  checkpoint: RunCheckpoint;
  policy: RollbackDecisionPolicy;
}

export interface ApplyRollbackDecisionInput {
  repoPath: string;
  runId: string;
  decisionSequence?: number;
  resumeRun?: (input: ResumeRunInput) => Promise<RunFlowResult>;
  now?: () => Date;
}

export type RollbackPolicyApplicationStatus = "applied" | "failed";

export interface RollbackPolicyApplication {
  status: RollbackPolicyApplicationStatus;
  decisionEventSequence: number;
  checkpointId?: string;
  policy: RollbackDecisionPolicy;
  worktree: {
    policy: RollbackWorktreePolicy;
    status: "preserved" | "removed" | "already-missing" | "blocked";
    path?: string;
    reason?: string;
  };
  branch: {
    policy: RollbackBranchPolicy;
    status: "preserved" | "reset" | "blocked";
    branchName?: string;
    targetHeadSha?: string;
    reason?: string;
  };
  change: {
    policy: RollbackChangePolicy;
    status: "preserved" | "skipped" | "planned" | "applied" | "blocked";
    changeRequestUrl?: string;
    resume?: {
      runId: string;
      checkpointId: string;
      status?: RunFlowResult["status"];
      changeRequestUrl?: string;
    };
    reason?: string;
  };
  failures: string[];
  mutations: string[];
}

export interface ApplyRollbackDecisionResult {
  event: StoredRunEvent;
  decision: StoredRunEvent;
  application: RollbackPolicyApplication;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedActor(value: string | undefined): string {
  return normalizeOptionalText(value) ?? "operator";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizePolicy<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  if (allowed.includes(value)) return value;
  throw new Error(`invalid rollback ${label} policy: ${value}`);
}

function checkpointById(events: StoredRunEvent[], checkpointId: string): RunCheckpoint {
  const trace = buildRunTrace(events);
  const checkpoint = trace.checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (!checkpoint) {
    throw new Error(`checkpoint not found for rollback decision: ${checkpointId}`);
  }
  return checkpoint;
}

function relativeInside(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(basePath, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !relativePath.startsWith("/");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rollbackDecisionEvents(events: StoredRunEvent[]): StoredRunEvent[] {
  return events.filter((event) => event.type === "rollback.recorded");
}

function selectRollbackDecision(
  events: StoredRunEvent[],
  decisionSequence: number | undefined,
): StoredRunEvent {
  const decisions = rollbackDecisionEvents(events);
  if (decisionSequence !== undefined) {
    const decision = decisions.find((event) => event.sequence === decisionSequence);
    if (!decision) {
      throw new Error(`rollback decision not found: ${decisionSequence}`);
    }
    return decision;
  }
  const decision = decisions.at(-1);
  if (!decision) {
    throw new Error("rollback decision not found");
  }
  return decision;
}

function policyFromDecision(event: StoredRunEvent): RollbackDecisionPolicy {
  const payload = asRecord(event.payload);
  const policy = asRecord(payload.policy);
  return rollbackDecisionPolicy({
    worktreePolicy: asString(policy.worktree) as RollbackWorktreePolicy | undefined,
    branchPolicy: asString(policy.branch) as RollbackBranchPolicy | undefined,
    changePolicy: asString(policy.change) as RollbackChangePolicy | undefined,
  });
}

function checkpointIdFromDecision(event: StoredRunEvent): string | undefined {
  return asString(asRecord(event.payload).checkpointId);
}

function checkpointEventSequenceFromDecision(event: StoredRunEvent): number | undefined {
  const sequence = asRecord(event.payload).checkpointEventSequence;
  return typeof sequence === "number" && Number.isInteger(sequence)
    ? sequence
    : undefined;
}

function checkpointBranchHeadSha(
  events: StoredRunEvent[],
  decision: StoredRunEvent,
): string | undefined {
  const checkpointSequence = checkpointEventSequenceFromDecision(decision);
  const checkpointEvent = checkpointSequence === undefined
    ? undefined
    : events.find((event) => event.sequence === checkpointSequence);
  const branchHeadSha = asString(asRecord(checkpointEvent?.payload).branchHeadSha);
  return branchHeadSha && /^[0-9a-f]{40}$/i.test(branchHeadSha)
    ? branchHeadSha
    : undefined;
}

function planRollbackApplication(input: {
  repoPath: string;
  runId: string;
  decision: StoredRunEvent;
  policy: RollbackDecisionPolicy;
  events: StoredRunEvent[];
}): RollbackPolicyApplication {
  const projection = projectRun(input.events);
  const runDirectory = runDirectoryPath(input.repoPath, input.runId);
  const worktreePath = projection.worktreePath
    ? resolve(input.repoPath, projection.worktreePath)
    : undefined;
  const expectedWorktreePath = resolve(runDirectory, "worktree");
  const targetHeadSha = checkpointBranchHeadSha(input.events, input.decision);
  const failures: string[] = [];
  const mutations: string[] = [];

  const worktree: RollbackPolicyApplication["worktree"] =
    input.policy.worktree === "preserve"
      ? {
          policy: input.policy.worktree,
          status: "preserved",
          ...(worktreePath ? { path: worktreePath } : {}),
        }
      : (() => {
          if (!worktreePath) {
            const reason = "run has no recorded worktree path";
            failures.push(reason);
            return {
              policy: input.policy.worktree,
              status: "blocked",
              reason,
            };
          }
          if (
            worktreePath !== expectedWorktreePath ||
            !relativeInside(runDirectory, worktreePath)
          ) {
            const reason = `refusing to remove worktree outside run directory: ${worktreePath}`;
            failures.push(reason);
            return {
              policy: input.policy.worktree,
              status: "blocked",
              path: worktreePath,
              reason,
            };
          }
          mutations.push(`remove worktree ${worktreePath}`);
          return {
            policy: input.policy.worktree,
            status: "removed",
            path: worktreePath,
          };
        })();

  const branch: RollbackPolicyApplication["branch"] =
    input.policy.branch === "preserve"
      ? {
          policy: input.policy.branch,
          status: "preserved",
          ...(projection.branchName ? { branchName: projection.branchName } : {}),
        }
      : (() => {
          if (!worktreePath) {
            const reason = "run has no recorded worktree path for branch reset";
            failures.push(reason);
            return {
              policy: input.policy.branch,
              status: "blocked",
              ...(projection.branchName ? { branchName: projection.branchName } : {}),
              reason,
            };
          }
          if (!targetHeadSha) {
            const reason =
              "checkpoint branch head is not recorded; no branch reset was performed";
            failures.push(reason);
            return {
              policy: input.policy.branch,
              status: "blocked",
              ...(projection.branchName ? { branchName: projection.branchName } : {}),
              reason,
            };
          }
          if (input.policy.worktree === "cleanup") {
            const reason =
              "branch reset with worktree cleanup is not atomic; no mutation was performed";
            failures.push(reason);
            return {
              policy: input.policy.branch,
              status: "blocked",
              ...(projection.branchName ? { branchName: projection.branchName } : {}),
              targetHeadSha,
              reason,
            };
          }
          mutations.push(
            `reset branch ${projection.branchName ?? "worktree"} to ${targetHeadSha}`,
          );
          return {
            policy: input.policy.branch,
            status: "reset",
            ...(projection.branchName ? { branchName: projection.branchName } : {}),
            targetHeadSha,
          };
        })();

  const change: RollbackPolicyApplication["change"] =
    input.policy.change === "preserve-existing-pr"
      ? {
          policy: input.policy.change,
          status: "preserved",
          ...(projection.changeRequestUrl
            ? { changeRequestUrl: projection.changeRequestUrl }
            : {}),
        }
      : input.policy.change === "none"
        ? {
            policy: input.policy.change,
            status: "skipped",
            ...(projection.changeRequestUrl
              ? { changeRequestUrl: projection.changeRequestUrl }
              : {}),
          }
        : (() => {
            if (
              input.policy.worktree !== "preserve" ||
              input.policy.branch !== "preserve"
            ) {
              const reason =
                "change request mutation through resumed execution requires preserved worktree and branch state; no pull request was updated or created";
              failures.push(reason);
              return {
                policy: input.policy.change,
                status: "blocked",
                ...(projection.changeRequestUrl
                  ? { changeRequestUrl: projection.changeRequestUrl }
                  : {}),
                reason,
              };
            }
            if (
              input.policy.change === "update-existing-pr" &&
              !projection.changeRequestTarget &&
              !projection.changeRequestUrl
            ) {
              const reason =
                "update-existing-pr requires an existing change request target; no resumed change execution was started";
              failures.push(reason);
              return {
                policy: input.policy.change,
                status: "blocked",
                reason,
              };
            }
            const checkpointId = checkpointIdFromDecision(input.decision);
            if (!checkpointId) {
              const reason =
                "rollback decision is missing a checkpoint; no resumed change execution was started";
              failures.push(reason);
              return {
                policy: input.policy.change,
                status: "blocked",
                ...(projection.changeRequestUrl
                  ? { changeRequestUrl: projection.changeRequestUrl }
                  : {}),
                reason,
              };
            }
            return {
              policy: input.policy.change,
              status: "planned",
              ...(projection.changeRequestUrl
                ? { changeRequestUrl: projection.changeRequestUrl }
                : {}),
              resume: {
                runId: input.runId,
                checkpointId,
              },
            };
          })();

  const failed = failures.length > 0;
  const effectiveWorktree =
    failed && worktree.status === "removed"
      ? {
          ...worktree,
          status: "blocked" as const,
          reason: "not applied because rollback policy validation failed",
        }
      : worktree;
  const effectiveBranch =
    failed && branch.status === "reset"
      ? {
          ...branch,
          status: "blocked" as const,
          reason: "not applied because rollback policy validation failed",
        }
      : branch;

  return {
    status: failed ? "failed" : "applied",
    decisionEventSequence: input.decision.sequence,
    checkpointId: checkpointIdFromDecision(input.decision),
    policy: input.policy,
    worktree: effectiveWorktree,
    branch: effectiveBranch,
    change,
    failures,
    mutations: failed ? [] : mutations,
  };
}

async function resetRunBranch(input: {
  worktreePath: string;
  targetHeadSha: string;
}): Promise<void> {
  await execFileAsync("git", [
    "-C",
    input.worktreePath,
    "reset",
    "--hard",
    input.targetHeadSha,
  ]);
}

async function removeRunWorktree(input: {
  repoPath: string;
  worktreePath: string;
}): Promise<"removed" | "already-missing"> {
  if (!await pathExists(input.worktreePath)) {
    return "already-missing";
  }
  await execFileAsync("git", [
    "-C",
    input.repoPath,
    "worktree",
    "remove",
    "--force",
    input.worktreePath,
  ]);
  return "removed";
}

async function routeRollbackChangeRequest(input: {
  repoPath: string;
  runId: string;
  application: RollbackPolicyApplication;
  resumeRun?: (input: ResumeRunInput) => Promise<RunFlowResult>;
}): Promise<void> {
  if (input.application.change.status !== "planned") {
    return;
  }
  const checkpointId = input.application.change.resume?.checkpointId;
  if (!checkpointId) {
    input.application.status = "failed";
    input.application.change.status = "blocked";
    input.application.change.reason =
      "rollback decision is missing a checkpoint; no resumed change execution was started";
    input.application.failures.push(input.application.change.reason);
    input.application.mutations = [];
    return;
  }
  try {
    const result = await (input.resumeRun ?? resumeRunFlow)({
      repoPath: input.repoPath,
      runId: input.runId,
      checkpointId,
    });
    input.application.change.resume = {
      runId: result.runId,
      checkpointId,
      ...(result.status ? { status: result.status } : {}),
      ...(result.changeRequestUrl
        ? { changeRequestUrl: result.changeRequestUrl }
        : {}),
    };
    if (result.changeRequestUrl) {
      input.application.change.status = "applied";
      input.application.change.changeRequestUrl = result.changeRequestUrl;
    }
    input.application.mutations.push(
      `resume run ${input.runId} from ${checkpointId} for ${input.application.change.policy}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.application.status = "failed";
    input.application.change.status = "blocked";
    input.application.change.reason =
      `failed to route resumed change execution: ${message}`;
    input.application.failures.push(input.application.change.reason);
    input.application.mutations = [];
  }
}

export function rollbackDecisionPolicy(
  input: Pick<
    RecordRollbackDecisionInput,
    "worktreePolicy" | "branchPolicy" | "changePolicy"
  >,
): RollbackDecisionPolicy {
  return {
    worktree: normalizePolicy(
      input.worktreePolicy,
      ROLLBACK_WORKTREE_POLICIES,
      "preserve",
      "worktree",
    ),
    branch: normalizePolicy(
      input.branchPolicy,
      ROLLBACK_BRANCH_POLICIES,
      "preserve",
      "branch",
    ),
    change: normalizePolicy(
      input.changePolicy,
      ROLLBACK_CHANGE_POLICIES,
      "preserve-existing-pr",
      "change",
    ),
  };
}

export async function recordRollbackDecision(
  input: RecordRollbackDecisionInput,
): Promise<RecordRollbackDecisionResult> {
  const store = new EventStore(eventStorePath(input.repoPath));
  try {
    const events = store.list(input.runId);
    if (events.length === 0) {
      throw new Error(`run not found for rollback decision: ${input.runId}`);
    }
    const checkpoint = checkpointById(events, input.checkpointId);
    const policy = rollbackDecisionPolicy(input);
    const reason = normalizeOptionalText(input.reason);
    const event = store.append({
      runId: input.runId,
      ...(checkpoint.stageId ? { stageId: checkpoint.stageId } : {}),
      ...(checkpoint.attempt ? { attempt: checkpoint.attempt } : {}),
      type: "rollback.recorded",
      createdAt: input.now?.().toISOString(),
      payload: {
        checkpointId: checkpoint.id,
        checkpointKind: checkpoint.kind,
        checkpointLabel: checkpoint.label,
        checkpointEventSequence: checkpoint.eventSequence,
        actor: normalizedActor(input.actor),
        ...(reason ? { reason } : {}),
        policy,
        mode: "record-only",
        nonDestructive: true,
        preserves: [
          "append-only event history",
          "published artifacts and evidence",
          "existing worktree, branch, and change request state",
        ],
        changes: [
          "operator rollback decision is recorded for audit",
          "no worktree, branch, artifact, or pull request mutation is performed",
        ],
      },
    });
    return { event, checkpoint, policy };
  } finally {
    store.close();
  }
}

export async function applyRollbackDecision(
  input: ApplyRollbackDecisionInput,
): Promise<ApplyRollbackDecisionResult> {
  const repoPath = resolve(input.repoPath);
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(input.runId);
    if (events.length === 0) {
      throw new Error(`run not found for rollback apply: ${input.runId}`);
    }
    const decision = selectRollbackDecision(events, input.decisionSequence);
    const policy = policyFromDecision(decision);
    const application = planRollbackApplication({
      repoPath,
      runId: input.runId,
      decision,
      policy,
      events,
    });
    if (application.status === "applied" && application.branch.status === "reset") {
      try {
        const worktreePath = application.worktree.path;
        const targetHeadSha = application.branch.targetHeadSha;
        if (!worktreePath || !targetHeadSha) {
          throw new Error("missing worktree path or target branch head");
        }
        await resetRunBranch({
          worktreePath,
          targetHeadSha,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        application.status = "failed";
        application.branch.status = "blocked";
        application.branch.reason = `failed to reset branch: ${message}`;
        application.failures.push(application.branch.reason);
        application.mutations = [];
      }
    }
    if (application.status === "applied" && application.worktree.status === "removed") {
      try {
        const removalStatus = await removeRunWorktree({
          repoPath,
          worktreePath: application.worktree.path ?? "",
        });
        application.worktree.status = removalStatus;
        if (removalStatus === "already-missing") {
          application.mutations = [];
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        application.status = "failed";
        application.worktree.status = "blocked";
        application.worktree.reason = `failed to remove worktree: ${message}`;
        application.failures.push(application.worktree.reason);
        application.mutations = [];
      }
    }
    if (application.status === "applied") {
      await routeRollbackChangeRequest({
        repoPath,
        runId: input.runId,
        application,
        resumeRun: input.resumeRun,
      });
    }
    const event = store.append({
      runId: input.runId,
      ...(decision.stageId ? { stageId: decision.stageId } : {}),
      ...(decision.attempt ? { attempt: decision.attempt } : {}),
      type:
        application.status === "applied"
          ? "rollback.applied"
          : "rollback.apply_failed",
      createdAt: input.now?.().toISOString(),
      payload: {
        decisionEventSequence: decision.sequence,
        checkpointId: application.checkpointId,
        policy,
        application,
        mode: "policy-apply",
        preserves: [
          "append-only event history",
          "published artifacts and evidence",
        ],
      },
    });
    return { event, decision, application };
  } finally {
    store.close();
  }
}
