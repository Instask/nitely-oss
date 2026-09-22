import {
  admitStoredWorkItemRunState,
  DEV_PR_WORK_ITEM_TYPE,
  getStoredWorkItemCandidate,
  getUnifiedWorkItem,
  getUnifiedWorkItemCandidate,
  getWorkItemCandidateForRun,
  finalizeLegacyTaskRunCandidate as finalizeLegacyCandidate,
  listUnifiedWorkItems,
  prepareLegacyTaskRunCandidate as prepareLegacyCandidate,
  prepareUnifiedWorkItemRunCandidates as prepareUnifiedCandidates,
  taskRecordToWorkItem as projectLegacyTask,
  updateStoredWorkItemRunState,
  type FinalizedLegacyTaskRunCandidate,
  type StoredWorkItemCandidate,
  type StoredWorkItemRunStatePatch,
  type PreparedLegacyTaskRunCandidate,
  type WorkItemRunPreparationIntent,
} from "./adapters/dev-pr.js";
import type {
  TaskExecutionInputSnapshot,
  TaskRecord,
} from "../web/tasks.js";
import type {
  WorkItemCandidateVersion,
  WorkItemRecord,
  WorkItemStoreKind,
} from "./types.js";

export {
  DEV_PR_WORK_ITEM_TYPE,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
};
export type {
  StoredWorkItemCandidate,
  StoredWorkItemRunStatePatch,
};

export type PreparedGenericWorkItemRunCandidate = StoredWorkItemCandidate & {
  store: "generic";
  legacyState: undefined;
};
export type PreparedLegacyWorkItemRunCandidate = PreparedLegacyTaskRunCandidate & {
  store: "legacy-dev-pr";
  legacyState: { activePlanningBaseline: PreparedLegacyTaskRunCandidate["activePlanningBaseline"] };
};
export type PreparedWorkItemRunCandidate =
  | PreparedGenericWorkItemRunCandidate
  | PreparedLegacyWorkItemRunCandidate;

export type FinalizedWorkItemRunCandidate =
  | (StoredWorkItemCandidate & { store: "generic" })
  | (FinalizedLegacyTaskRunCandidate & {
      store: "legacy-dev-pr";
      version: WorkItemCandidateVersion;
    });

export interface PreparedWorkItemRunCandidates {
  workItems: WorkItemRecord[];
  candidates: Map<string, PreparedWorkItemRunCandidate>;
}

/** Project either persisted representation to the common Work item shape. */
export function projectWorkItem(
  record: TaskRecord | WorkItemRecord,
  executionInputs?: TaskExecutionInputSnapshot,
): WorkItemRecord {
  return "workItemType" in record
    ? record
    : projectLegacyTask(record, executionInputs);
}

/** Single read seam for generic and legacy dev.pr work-item stores. */
export async function resolveWorkItemCandidate(
  repoPath: string,
  id: string,
  store?: WorkItemStoreKind,
): Promise<StoredWorkItemCandidate> {
  return store
    ? await getStoredWorkItemCandidate(repoPath, id, store)
    : await getUnifiedWorkItemCandidate(repoPath, id);
}

/** Prepare one candidate without exposing its persistence-store branch. */
export function prepareWorkItemRunCandidate(
  repoPath: string,
  record: TaskRecord,
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedLegacyWorkItemRunCandidate>;
export function prepareWorkItemRunCandidate(
  repoPath: string,
  id: string,
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedWorkItemRunCandidate>;
export async function prepareWorkItemRunCandidate(
  repoPath: string,
  recordOrId: TaskRecord | string,
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedWorkItemRunCandidate> {
  if (typeof recordOrId !== "string") {
    const prepared = await prepareLegacyCandidate(repoPath, recordOrId.id, intent);
    return {
      ...prepared,
      store: "legacy-dev-pr",
      legacyState: { activePlanningBaseline: prepared.activePlanningBaseline },
    };
  }
  const candidate = await resolveWorkItemCandidate(repoPath, recordOrId);
  if (candidate.store === "generic") {
    return { ...candidate, store: "generic", legacyState: undefined };
  }
  const prepared = await prepareLegacyCandidate(repoPath, recordOrId, intent);
  return {
    ...prepared,
    store: "legacy-dev-pr",
    legacyState: { activePlanningBaseline: prepared.activePlanningBaseline },
  };
}

/** Finalize prepared inputs; generic candidates need no extra materialization. */
export function finalizeWorkItemRunCandidate(
  repoPath: string,
  prepared: PreparedGenericWorkItemRunCandidate,
  task?: TaskRecord,
): Promise<PreparedGenericWorkItemRunCandidate>;
export function finalizeWorkItemRunCandidate(
  repoPath: string,
  prepared: PreparedLegacyWorkItemRunCandidate,
  task?: TaskRecord,
): Promise<FinalizedLegacyTaskRunCandidate & {
  store: "legacy-dev-pr";
  version: WorkItemCandidateVersion;
}>;
export function finalizeWorkItemRunCandidate(
  repoPath: string,
  prepared: PreparedWorkItemRunCandidate,
  task?: TaskRecord,
): Promise<FinalizedWorkItemRunCandidate>;
export async function finalizeWorkItemRunCandidate(
  repoPath: string,
  prepared: PreparedWorkItemRunCandidate,
  task?: TaskRecord,
): Promise<FinalizedWorkItemRunCandidate> {
  if (prepared.store === "generic") return prepared;
  return {
    ...(await finalizeLegacyCandidate(repoPath, prepared, task)),
    store: "legacy-dev-pr",
    version: prepared.version,
  };
}

/** Prepare a mixed candidate set behind one persistence-selection seam. */
export async function prepareWorkItemRunCandidates(
  repoPath: string,
  workItems: WorkItemRecord[],
  candidateIds: string[],
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedWorkItemRunCandidates> {
  const prepared = await prepareUnifiedCandidates(
    repoPath,
    workItems,
    candidateIds,
    intent,
  );
  const byId = new Map(prepared.workItems.map((workItem) => [workItem.id, workItem]));
  const candidates = new Map<string, PreparedWorkItemRunCandidate>();
  for (const [id, version] of prepared.candidateVersions) {
    const legacy = prepared.legacyTasks.get(id);
    if (legacy) {
      candidates.set(id, {
        ...legacy,
        store: "legacy-dev-pr",
        legacyState: { activePlanningBaseline: legacy.activePlanningBaseline },
      });
      continue;
    }
    const workItem = byId.get(id);
    if (workItem) {
      candidates.set(id, {
        workItem,
        version,
        store: "generic",
        legacyState: undefined,
      });
    }
  }
  return { workItems: prepared.workItems, candidates };
}

/** Single run-state write seam; a known store avoids a second lookup. */
export async function updateWorkItemRunState(
  repoPath: string,
  id: string,
  patch: StoredWorkItemRunStatePatch,
  store?: WorkItemStoreKind,
): Promise<WorkItemRecord> {
  const resolvedStore =
    store ?? (await getUnifiedWorkItemCandidate(repoPath, id)).store;
  return await updateStoredWorkItemRunState(repoPath, id, resolvedStore, patch);
}

/** Admit run state through the selected candidate store. */
export async function admitWorkItemRunState(
  repoPath: string,
  id: string,
  store: WorkItemStoreKind,
  patch: StoredWorkItemRunStatePatch,
): Promise<WorkItemRecord> {
  return await admitStoredWorkItemRunState(repoPath, id, store, patch);
}

/** Resolve the store that owns an existing run without exposing adapter APIs. */
export async function resolveWorkItemCandidateForRun(
  repoPath: string,
  id: string,
  runId: string,
): Promise<StoredWorkItemCandidate> {
  return await getWorkItemCandidateForRun(repoPath, id, runId);
}
