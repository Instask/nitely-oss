import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EventStore } from "../events/store.js";
import {
  workItemCandidateVersionFingerprint,
  workItemDependencyEligibilityFingerprint,
} from "../work-items/candidate-version.js";
import type {
  WorkItemCandidateVersion,
  WorkItemRecord,
} from "../work-items/types.js";
import {
  admitWorkItemRunState,
  resolveWorkItemCandidate,
  resolveWorkItemCandidateForRun,
  updateWorkItemRunState,
} from "../work-items/access.js";
import { WebNotFoundError } from "../web/errors.js";
import {
  type TaskPlanningBaseline,
  type TaskSourceDriftOverride,
  type TaskSpecReadinessOverride,
} from "../web/tasks.js";
import { RunAdmissionStore, type StoredRunAdmission } from "./admission-store.js";
import { eventStorePath, projectRun } from "./project.js";
import type { RunFlowInput } from "./run-flow.js";

export interface WorkItemRunCandidate {
  workItem: WorkItemRecord;
  version: WorkItemCandidateVersion;
}

export interface LegacyRunAdmissionState {
  activePlanningBaseline: TaskPlanningBaseline | undefined;
  sourceDriftOverride?: TaskSourceDriftOverride;
  specReadinessOverride?: TaskSpecReadinessOverride;
}

export interface AdmitWorkItemRunInput {
  repoPath: string;
  candidate: WorkItemRunCandidate;
  runInput: RunFlowInput;
  legacyState?: LegacyRunAdmissionState;
  createRunId?: () => string;
  now?: () => Date;
}

export interface AdmitWorkItemRunDependencies {
  beforeProjection?: () => Promise<void>;
  afterWorkItemProjection?: () => Promise<void>;
}

export type WorkItemRunAdmission =
  | {
      decision: "admitted";
      runId: string;
      branchName: string;
      workItem: WorkItemRecord;
    }
  | {
      decision: "conflict";
      reason:
        | "active-run"
        | "candidate-already-admitted"
        | "stale-candidate"
        | "stale-dependency";
      runId?: string;
      changedWorkItemIds?: string[];
      workItem: WorkItemRecord;
    };

export interface SettleWorkItemRunInput {
  repoPath: string;
  workItemId: string;
  runId: string;
  status: "completed" | "failed";
  changeRequestUrl?: string;
  now?: () => Date;
}

export type SettleWorkItemRunResult =
  | { settled: true; workItem: WorkItemRecord }
  | {
      settled: false;
      reason: "not-admitted";
      workItem: WorkItemRecord;
      storeKind: WorkItemCandidateVersion["store"];
    }
  | {
      settled: false;
      reason:
        | "not-active"
        | "work-item-mismatch"
        | "admission-in-progress"
        | "settlement-in-progress"
        | "superseded";
      workItem: WorkItemRecord;
    };

export interface SettleWorkItemRunDependencies {
  beforeProjection?: () => Promise<void>;
  afterWorkItemProjection?: () => Promise<void>;
}

export interface ReconcileTerminalWorkItemRunInput {
  repoPath: string;
  workItemId: string;
  runId: string;
}

export const SETTLEMENT_LEASE_MS = 30_000;

function createRunId(now: Date): string {
  const stamp = now.toISOString().replaceAll(":", "").replaceAll(".", "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function admissionStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "run-admissions.db");
}

async function openAdmissionStore(repoPath: string): Promise<RunAdmissionStore> {
  await mkdir(join(resolve(repoPath), ".nitely"), { recursive: true });
  return new RunAdmissionStore(admissionStorePath(repoPath));
}

async function currentCandidate(
  repoPath: string,
  workItemId: string,
  store: WorkItemCandidateVersion["store"],
): Promise<WorkItemRunCandidate> {
  const candidate = await resolveWorkItemCandidate(repoPath, workItemId, store);
  return {
    workItem: candidate.workItem,
    version: candidate.version,
  };
}

async function dependencyGuardFingerprint(
  repoPath: string,
  workItemId: string,
): Promise<string | null> {
  try {
    const current = await currentUnifiedWorkItem(repoPath, workItemId);
    return workItemDependencyEligibilityFingerprint(current.workItem);
  } catch (error) {
    if (error instanceof WebNotFoundError) return null;
    throw error;
  }
}

async function changedDependencyGuardIds(
  repoPath: string,
  version: WorkItemCandidateVersion,
): Promise<string[]> {
  const guards = version.dependencyGuards ?? [];
  const current = await Promise.all(
    guards.map(async (guard) => ({
      guard,
      fingerprint: await dependencyGuardFingerprint(
        repoPath,
        guard.workItemId,
      ),
    })),
  );
  return current
    .filter(({ guard, fingerprint }) => fingerprint !== guard.fingerprint)
    .map(({ guard }) => guard.workItemId);
}

function acceptedRunPayload(admission: StoredRunAdmission): Record<string, unknown> {
  const input = admission.runInput;
  return {
    flowPath: input.flowPath,
    flowDocument: input.flowDocument,
    repoPath: resolve(input.repoPath),
    repoId: input.repoId,
    repoName: input.repoName,
    inputs: input.inputs,
    configuration: input.configuration,
    branchName: admission.branchName,
    workItemId: input.workItemId,
    workItemType: input.workItemType,
    ownerId: input.ownerId,
    organizationId: input.organizationId,
    planningApproval: input.planningApproval,
    runEligibilityOverride: input.runEligibilityOverride,
  };
}

function ensureRunAdmitted(
  repoPath: string,
  store: RunAdmissionStore,
  admission: StoredRunAdmission,
): void {
  store.withExclusive(() => {
    const events = new EventStore(eventStorePath(repoPath));
    try {
      if (
        events
          .list(admission.runId)
          .some(
            (event) =>
              event.type === "run.admitted" || event.type === "run.created",
          )
      ) {
        return;
      }
      events.append({
        runId: admission.runId,
        type: "run.admitted",
        payload: acceptedRunPayload(admission),
      });
    } finally {
      events.close();
    }
  });
}

function rejectClaimedAdmission(input: {
  repoPath: string;
  store: RunAdmissionStore;
  admission: StoredRunAdmission;
  error: unknown;
  rejectedAt: string;
}): void {
  const rejected = input.store.reject(
    input.admission.runId,
    "admission initialization failed",
    input.rejectedAt,
  );
  if (!rejected) return;
  try {
    const events = new EventStore(eventStorePath(input.repoPath));
    try {
      const runEvents = events.list(input.admission.runId);
      if (
        !runEvents.some(
          (event) =>
            event.type === "run.admitted" || event.type === "run.created",
        ) ||
        runEvents.some(
          (event) =>
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.blocked" ||
            event.type === "run.cancelled",
        )
      ) {
        return;
      }
      events.append({
        runId: input.admission.runId,
        type: "run.failed",
        payload: {
          error: "Run admission initialization failed before dispatch",
        },
      });
    } finally {
      events.close();
    }
  } catch {
    // Releasing the durable owner is authoritative. Event persistence may be
    // the failing dependency, so compensation must remain best effort here.
  }
}

async function updateAdmissionProjection(input: {
  repoPath: string;
  admission: StoredRunAdmission;
  storeKind: WorkItemCandidateVersion["store"];
  legacyState?: LegacyRunAdmissionState;
}): Promise<WorkItemRecord> {
  return await admitWorkItemRunState(
    input.repoPath,
    input.admission.workItemId,
    input.storeKind,
    {
      status: "running",
      latestRunId: input.admission.runId,
      changeRequestUrl: undefined,
      ...(input.legacyState
        ? {
            activePlanningBaseline: input.legacyState.activePlanningBaseline,
            ...(input.legacyState.sourceDriftOverride
              ? { sourceDriftOverride: input.legacyState.sourceDriftOverride }
              : {}),
            ...(input.legacyState.specReadinessOverride
              ? { specReadinessOverride: input.legacyState.specReadinessOverride }
              : {}),
          }
        : {}),
    },
  );
}

export async function admitWorkItemRun(
  input: AdmitWorkItemRunInput,
  dependencies: AdmitWorkItemRunDependencies = {},
): Promise<WorkItemRunAdmission> {
  const current = await currentCandidate(
    input.repoPath,
    input.candidate.workItem.id,
    input.candidate.version.store,
  );
  const candidateChanged =
    current.version.fingerprint !== input.candidate.version.fingerprint;
  const changedWorkItemIds = await changedDependencyGuardIds(
    input.repoPath,
    input.candidate.version,
  );
  if (candidateChanged || changedWorkItemIds.length > 0) {
    return {
      decision: "conflict",
      reason: candidateChanged ? "stale-candidate" : "stale-dependency",
      ...(current.workItem.latestRunId ? { runId: current.workItem.latestRunId } : {}),
      ...(changedWorkItemIds.length > 0 ? { changedWorkItemIds } : {}),
      workItem: current.workItem,
    };
  }

  const now = input.now?.() ?? new Date();
  const runId = input.createRunId?.() ?? createRunId(now);
  const admission: StoredRunAdmission = {
    runId,
    workItemId: input.candidate.workItem.id,
    candidateFingerprint: workItemCandidateVersionFingerprint(
      input.candidate.version,
    ),
    candidateVersion: input.candidate.version,
    state: "active",
    admittedAt: now.toISOString(),
    initializationToken: randomUUID(),
    branchName: `nitely/${runId}`,
    runInput: input.runInput,
    storeKind: input.candidate.version.store,
    ...(input.legacyState ? { legacyState: input.legacyState } : {}),
  };
  const store = await openAdmissionStore(input.repoPath);
  let claimed = false;
  let workItemProjectionPersisted = false;
  try {
    let claim = store.claim(admission);
    if (
      !claim.claimed &&
      claim.admission.state === "active" &&
      claim.admission.settlementToken &&
      claim.admission.settlementStatus
    ) {
      const recovery = await settleWorkItemRun({
        repoPath: input.repoPath,
        workItemId: claim.admission.workItemId,
        runId: claim.admission.runId,
        status: claim.admission.settlementStatus,
        ...(claim.admission.settlementChangeRequestUrl !== undefined
          ? {
              changeRequestUrl:
                claim.admission.settlementChangeRequestUrl,
            }
          : {}),
        now: () => now,
      });
      if (
        recovery.settled ||
        recovery.reason === "superseded" ||
        recovery.reason === "not-active"
      ) {
        claim = store.claim(admission);
      }
    }
    const claimedAdmission = claim.admission;
    if (!claim.claimed) {
      const latest = await currentCandidate(
        input.repoPath,
        input.candidate.workItem.id,
        claimedAdmission.storeKind,
      );
      return {
        decision: "conflict",
        reason: claim.reason,
        runId: claimedAdmission.runId,
        workItem: latest.workItem,
      };
    }
    claimed = true;

    const verified = await currentCandidate(
      input.repoPath,
      input.candidate.workItem.id,
      input.candidate.version.store,
    );
    const verifiedCandidateChanged =
      verified.version.fingerprint !== input.candidate.version.fingerprint;
    const verifiedDependencyChanges = await changedDependencyGuardIds(
      input.repoPath,
      input.candidate.version,
    );
    if (verifiedCandidateChanged || verifiedDependencyChanges.length > 0) {
      store.reject(
        admission.runId,
        "candidate changed during admission",
        now.toISOString(),
      );
      return {
        decision: "conflict",
        reason: verifiedCandidateChanged
          ? "stale-candidate"
          : "stale-dependency",
        ...(verified.workItem.latestRunId
          ? { runId: verified.workItem.latestRunId }
          : {}),
        ...(verifiedDependencyChanges.length > 0
          ? { changedWorkItemIds: verifiedDependencyChanges }
          : {}),
        workItem: verified.workItem,
      };
    }
    ensureRunAdmitted(input.repoPath, store, admission);
    await dependencies.beforeProjection?.();
    const workItem = await updateAdmissionProjection({
      repoPath: input.repoPath,
      admission,
      storeKind: input.candidate.version.store,
      ...(input.legacyState ? { legacyState: input.legacyState } : {}),
    });
    workItemProjectionPersisted = true;
    await dependencies.afterWorkItemProjection?.();
    const markedProjected = store.markProjected(
      admission.runId,
      admission.initializationToken!,
      now.toISOString(),
    );
    const latestAdmission = store.get(admission.runId);
    if (
      !markedProjected ||
      latestAdmission?.state !== "active" ||
      !latestAdmission.projectedAt ||
      latestAdmission.settlementToken
    ) {
      throw new Error(
        `lost Run admission before dispatch: ${admission.runId}`,
      );
    }
    return {
      decision: "admitted",
      runId: admission.runId,
      branchName: admission.branchName,
      workItem,
    };
  } catch (error) {
    if (claimed && !workItemProjectionPersisted) {
      rejectClaimedAdmission({
        repoPath: input.repoPath,
        store,
        admission,
        error,
        rejectedAt: (input.now?.() ?? new Date()).toISOString(),
      });
    }
    throw error;
  } finally {
    store.close();
  }
}

async function currentUnifiedWorkItem(
  repoPath: string,
  workItemId: string,
): Promise<{ workItem: WorkItemRecord; store: WorkItemCandidateVersion["store"] }> {
  const candidate = await resolveWorkItemCandidate(repoPath, workItemId);
  return { workItem: candidate.workItem, store: candidate.store };
}

async function currentUnifiedWorkItemForRun(
  repoPath: string,
  workItemId: string,
  runId: string,
): Promise<{ workItem: WorkItemRecord; store: WorkItemCandidateVersion["store"] }> {
  const candidate = await resolveWorkItemCandidateForRun(repoPath, workItemId, runId);
  return { workItem: candidate.workItem, store: candidate.store };
}

function projectedSettlementMatches(
  admission: StoredRunAdmission,
  input: SettleWorkItemRunInput,
  workItem: WorkItemRecord,
): boolean {
  return (
    admission.workItemId === input.workItemId &&
    admission.settlementStatus === input.status &&
    admission.settlementChangeRequestUrl === input.changeRequestUrl &&
    workItem.latestRunId === input.runId &&
    workItem.status === admission.settlementStatus &&
    workItem.changeRequestUrl === admission.settlementChangeRequestUrl
  );
}

function completeSettlementOrThrow(input: {
  store: RunAdmissionStore;
  runId: string;
  token: string;
  settledAt: string;
  errorMessage: string;
}): void {
  if (
    input.store.completeSettlement(
      input.runId,
      input.token,
      input.settledAt,
    )
  ) {
    return;
  }
  if (input.store.get(input.runId)?.state === "settled") return;
  throw new Error(input.errorMessage);
}

export async function settleWorkItemRun(
  input: SettleWorkItemRunInput,
  dependencies: SettleWorkItemRunDependencies = {},
): Promise<SettleWorkItemRunResult> {
  const store = await openAdmissionStore(input.repoPath);
  try {
    let admission = store.get(input.runId);
    if (!admission) {
      const current = await currentUnifiedWorkItemForRun(
        input.repoPath,
        input.workItemId,
        input.runId,
      );
      return {
        settled: false,
        reason: "not-admitted",
        workItem: current.workItem,
        storeKind: current.store,
      };
    }
    if (admission.workItemId !== input.workItemId) {
      const admitted = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      return {
        settled: false,
        reason: "work-item-mismatch",
        workItem: admitted.workItem,
      };
    }
    if (admission.state !== "active") {
      const current = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      return { settled: false, reason: "not-active", workItem: current.workItem };
    }
    if (!admission.projectedAt) {
      const current = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      if (current.workItem.latestRunId !== input.runId) {
        return {
          settled: false,
          reason: "admission-in-progress",
          workItem: current.workItem,
        };
      }
      if (admission.initializationToken) {
        return {
          settled: false,
          reason: "admission-in-progress",
          workItem: current.workItem,
        };
      }
      const projectedAt = (input.now?.() ?? new Date()).toISOString();
      if (!store.recoverLegacyProjection(input.runId, projectedAt)) {
        admission = store.get(input.runId);
        if (!admission?.projectedAt) {
          return {
            settled: false,
            reason: "admission-in-progress",
            workItem: current.workItem,
          };
        }
      } else {
        admission = store.get(input.runId);
      }
      if (!admission || admission.state !== "active") {
        return {
          settled: false,
          reason: "not-active",
          workItem: current.workItem,
        };
      }
    }
    const settlementNow = input.now?.() ?? new Date();
    const settledAt = settlementNow.toISOString();
    const settlementToken = randomUUID();
    if (
      !store.beginSettlement({
        runId: input.runId,
        token: settlementToken,
        startedAt: settledAt,
        status: input.status,
        ...(input.changeRequestUrl !== undefined
          ? { changeRequestUrl: input.changeRequestUrl }
          : {}),
      })
    ) {
      const latestAdmission = store.get(input.runId);
      const latest = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      if (
        latestAdmission?.state === "active" &&
        latestAdmission.settlementToken
      ) {
        const superseded = latest.workItem.latestRunId !== input.runId;
        const projectionIsDurable = projectedSettlementMatches(
          latestAdmission,
          input,
          latest.workItem,
        );
        if (
          projectionIsDurable &&
          store.recoverStaleSettlementAfterProof(
            input.runId,
            latestAdmission.settlementToken,
            new Date(
              settlementNow.getTime() - SETTLEMENT_LEASE_MS,
            ).toISOString(),
            settledAt,
          )
        ) {
          return superseded
            ? {
                settled: false,
                reason: "superseded",
                workItem: latest.workItem,
              }
            : { settled: true, workItem: latest.workItem };
        }
        const recoveredAdmission = store.get(input.runId);
        if (recoveredAdmission?.state === "settled") {
          return superseded
            ? {
                settled: false,
                reason: "superseded",
                workItem: latest.workItem,
              }
            : projectionIsDurable
              ? { settled: true, workItem: latest.workItem }
              : {
                  settled: false,
                  reason: "not-active",
                  workItem: latest.workItem,
                };
        }
      }
      return {
        settled: false,
        reason:
          latestAdmission?.state === "active" && latestAdmission.settlementToken
            ? "settlement-in-progress"
            : "not-active",
        workItem: latest.workItem,
      };
    }
    let workItemProjectionPersisted = false;
    try {
      const current = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      if (current.workItem.latestRunId !== input.runId) {
        completeSettlementOrThrow({
          store,
          runId: input.runId,
          token: settlementToken,
          settledAt,
          errorMessage: `failed to complete superseded Run settlement: ${input.runId}`,
        });
        return {
          settled: false,
          reason: "superseded",
          workItem: current.workItem,
        };
      }
      await dependencies.beforeProjection?.();
      const projectionStartedAt = (input.now?.() ?? new Date()).toISOString();
      if (
        !store.renewSettlementLease(
          input.runId,
          settlementToken,
          projectionStartedAt,
        )
      ) {
        const latestAdmission = store.get(input.runId);
        const latest = await currentCandidate(
          input.repoPath,
          admission.workItemId,
          admission.storeKind,
        );
        if (latestAdmission?.state === "settled") {
          if (latest.workItem.latestRunId !== input.runId) {
            return {
              settled: false,
              reason: "superseded",
              workItem: latest.workItem,
            };
          }
          if (projectedSettlementMatches(latestAdmission, input, latest.workItem)) {
            return { settled: true, workItem: latest.workItem };
          }
        }
        throw new Error(`lost Run settlement lease before projection: ${input.runId}`);
      }
      const projectionCurrent = await currentCandidate(
        input.repoPath,
        admission.workItemId,
        admission.storeKind,
      );
      if (projectionCurrent.workItem.latestRunId !== input.runId) {
        completeSettlementOrThrow({
          store,
          runId: input.runId,
          token: settlementToken,
          settledAt: projectionStartedAt,
          errorMessage: `failed to complete superseded Run settlement: ${input.runId}`,
        });
        return {
          settled: false,
          reason: "superseded",
          workItem: projectionCurrent.workItem,
        };
      }
      const patch = {
        status: input.status,
        latestRunId: input.runId,
        changeRequestUrl: input.changeRequestUrl,
      } as const;
      const workItem = await updateWorkItemRunState(
        input.repoPath,
        input.workItemId,
        patch,
        admission.storeKind,
      );
      workItemProjectionPersisted = true;
      await dependencies.afterWorkItemProjection?.();
      completeSettlementOrThrow({
        store,
        runId: input.runId,
        token: settlementToken,
        settledAt,
        errorMessage: `failed to complete Run settlement: ${input.runId}`,
      });
      return { settled: true, workItem };
    } catch (error) {
      if (!workItemProjectionPersisted) {
        store.abortSettlement(input.runId, settlementToken);
      }
      throw error;
    }
  } finally {
    store.close();
  }
}

export async function reconcileTerminalWorkItemRun(
  input: ReconcileTerminalWorkItemRunInput,
): Promise<WorkItemRecord | undefined> {
  const events = new EventStore(eventStorePath(input.repoPath));
  const runEvents = (() => {
    try {
      return events.list(input.runId);
    } finally {
      events.close();
    }
  })();
  if (runEvents.length === 0) return undefined;
  const projection = projectRun(runEvents);
  const status =
    projection.status === "completed"
      ? "completed"
      : projection.status === "failed" || projection.status === "cancelled"
        ? "failed"
        : undefined;
  if (!status) return undefined;

  const result = await settleWorkItemRun({
    repoPath: input.repoPath,
    workItemId: input.workItemId,
    runId: input.runId,
    status,
    ...(projection.changeRequestUrl
      ? { changeRequestUrl: projection.changeRequestUrl }
      : {}),
  });
  if (result.settled || result.reason === "superseded") {
    return result.workItem;
  }
  if (result.reason !== "not-admitted") {
    return result.workItem;
  }
  if (result.workItem.latestRunId !== input.runId) {
    return result.workItem;
  }
  const current = await currentCandidate(
    input.repoPath,
    input.workItemId,
    result.storeKind,
  );
  if (current.workItem.status !== "running") {
    return current.workItem;
  }
  const patch = {
    status,
    latestRunId: input.runId,
    changeRequestUrl: projection.changeRequestUrl,
  } as const;
  return await updateWorkItemRunState(
    input.repoPath,
    input.workItemId,
    patch,
    result.storeKind,
  );
}
