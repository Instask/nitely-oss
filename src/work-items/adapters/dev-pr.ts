import type { TaskRecord } from "../../web/tasks.js";
import {
  freezeTaskPlanningBaseline,
  admitTaskRunState,
  getTask,
  getTaskSnapshot,
  listTasks,
  materializeTaskRunCandidateInputs,
  taskPlanningApprovalStatus,
  taskPlanningInputUri,
  taskSourceInputUri,
  taskWorkflowMetadataInputUri,
  updateTaskRunState,
  type TaskPlanningBaseline,
  type TaskExecutionInputSnapshot,
} from "../../web/tasks.js";
import { WebNotFoundError } from "../../web/errors.js";
import {
  getWorkItem,
  getWorkItemSnapshot,
  listWorkItems,
  updateWorkItem,
} from "../store.js";
import type {
  WorkItemCandidateVersion,
  WorkItemRecord,
  UpdateWorkItemPatch,
  WorkItemStoreKind,
} from "../types.js";

export const DEV_PR_WORK_ITEM_TYPE = "dev.pr";

export type WorkItemRunPreparationIntent = "manual" | "automatic";

export interface PreparedLegacyTaskRunCandidate {
  id: string;
  version: WorkItemCandidateVersion;
  activePlanningBaseline: TaskPlanningBaseline | undefined;
  task: TaskRecord;
  workItem: WorkItemRecord;
  executionInputs: TaskExecutionInputSnapshot;
}

export interface FinalizedLegacyTaskRunCandidate {
  task: TaskRecord;
  workItem: WorkItemRecord;
  executionInputs: TaskExecutionInputSnapshot;
}

export interface PreparedUnifiedWorkItemRunCandidates {
  workItems: WorkItemRecord[];
  candidateVersions: Map<string, WorkItemCandidateVersion>;
  legacyTasks: Map<string, PreparedLegacyTaskRunCandidate>;
}

export interface StoredWorkItemCandidate {
  workItem: WorkItemRecord;
  version: WorkItemCandidateVersion;
  store: WorkItemStoreKind;
}

export type StoredWorkItemRunStatePatch = UpdateWorkItemPatch &
  Partial<Pick<
    TaskRecord,
    "sourceDriftOverride" | "specReadinessOverride" | "activePlanningBaseline"
  >>;

/**
 * Map a legacy dev `TaskRecord` into a generic `WorkItemRecord`. The fixed
 * `specPath` / `techDesignPath` become typed input bindings so the rest of the
 * system can treat a dev task as one work item type. No disk migration happens;
 * this projection is computed at read time.
 */
export function taskRecordToWorkItem(
  task: TaskRecord,
  executionInputs?: TaskExecutionInputSnapshot,
): WorkItemRecord {
  const planning = taskPlanningApprovalStatus(task);
  const record: WorkItemRecord = {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.repoId ? { repoId: task.repoId } : {}),
    priority: task.priority ?? "P2",
    dependsOn: task.dependsOn ?? [],
    suggestedDependencies: task.suggestedDependencies ?? [],
    workItemType: DEV_PR_WORK_ITEM_TYPE,
    flowPath: task.flowPath,
    ...(task.template ? { template: task.template } : {}),
    ...(task.specStatus ? { specStatus: task.specStatus } : {}),
    ...(task.techDesignStatus ? { techDesignStatus: task.techDesignStatus } : {}),
    ...(task.planningArtifacts ? { planningArtifacts: task.planningArtifacts } : {}),
    ...(planning ? { planning } : {}),
    ...(task.activePlanningBaseline
      ? { activePlanningBaseline: task.activePlanningBaseline }
      : {}),
    specPath: task.specPath,
    techDesignPath: task.techDesignPath,
    ...(task.planningNotes ? { planningNotes: task.planningNotes } : {}),
    ...(task.source ? { planningSource: task.source } : {}),
    ...(task.sourceDriftOverride
      ? { sourceDriftOverride: task.sourceDriftOverride }
      : {}),
    inputs: {
      spec: {
        connector: "local-file",
        uri: taskPlanningInputUri(task, "spec") ?? task.specPath,
      },
      "tech-design": {
        connector: "local-file",
        uri: taskPlanningInputUri(task, "tech-design") ?? task.techDesignPath,
      },
      ...(task.source
        ? {
            source: {
              connector: "local-file",
              uri: executionInputs?.sourceUri ?? taskSourceInputUri(task),
            },
          }
        : {}),
      "workflow-metadata": {
        connector: "local-file",
        uri:
          executionInputs?.workflowMetadataUri ??
          taskWorkflowMetadataInputUri(task),
      },
    },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.issueUrl) {
    record.issueUrl = task.issueUrl;
  }
  if (task.latestRunId) {
    record.latestRunId = task.latestRunId;
  }
  if (task.changeRequestUrl) {
    record.changeRequestUrl = task.changeRequestUrl;
  }
  if (task.ownerId) {
    record.ownerId = task.ownerId;
  }
  if (task.organizationId) {
    record.organizationId = task.organizationId;
  }
  return record;
}

export async function getStoredWorkItemCandidate(
  repoPath: string,
  id: string,
  store: WorkItemStoreKind,
): Promise<StoredWorkItemCandidate> {
  if (store === "generic") {
    const snapshot = await getWorkItemSnapshot(repoPath, id);
    return { workItem: snapshot.record, version: snapshot.version, store };
  }
  const snapshot = await getTaskSnapshot(repoPath, id);
  return {
    workItem: taskRecordToWorkItem(snapshot.record),
    version: snapshot.version,
    store,
  };
}

export async function getUnifiedWorkItemCandidate(
  repoPath: string,
  id: string,
): Promise<StoredWorkItemCandidate> {
  try {
    return await getStoredWorkItemCandidate(repoPath, id, "generic");
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) throw error;
  }
  return await getStoredWorkItemCandidate(repoPath, id, "legacy-dev-pr");
}

export async function getWorkItemCandidateForRun(
  repoPath: string,
  id: string,
  runId: string,
): Promise<StoredWorkItemCandidate> {
  const candidates: StoredWorkItemCandidate[] = [];
  for (const store of ["generic", "legacy-dev-pr"] as const) {
    try {
      candidates.push(await getStoredWorkItemCandidate(repoPath, id, store));
    } catch (error) {
      if (!(error instanceof WebNotFoundError)) throw error;
    }
  }
  const owners = candidates.filter(
    (candidate) => candidate.workItem.latestRunId === runId,
  );
  if (owners.length === 1) return owners[0]!;
  if (owners.length > 1) {
    throw new Error(
      `Run ${runId} ambiguously belongs to multiple Work item stores: ${id}`,
    );
  }
  if (candidates[0]) return candidates[0];
  throw new WebNotFoundError("work item not found");
}

export async function admitStoredWorkItemRunState(
  repoPath: string,
  id: string,
  store: WorkItemStoreKind,
  patch: StoredWorkItemRunStatePatch,
): Promise<WorkItemRecord> {
  if (store === "generic") {
    return await updateWorkItem(repoPath, id, patch);
  }
  if (!patch.status) {
    throw new Error(`legacy task run-state update requires status: ${id}`);
  }
  return taskRecordToWorkItem(
    await admitTaskRunState(repoPath, id, { ...patch, status: patch.status }),
  );
}

export async function updateStoredWorkItemRunState(
  repoPath: string,
  id: string,
  store: WorkItemStoreKind,
  patch: StoredWorkItemRunStatePatch,
): Promise<WorkItemRecord> {
  if (store === "generic") {
    return await updateWorkItem(repoPath, id, patch);
  }
  if (!patch.status) {
    throw new Error(`legacy task run-state update requires status: ${id}`);
  }
  return taskRecordToWorkItem(
    await updateTaskRunState(repoPath, id, { ...patch, status: patch.status }),
  );
}

function canPrepareLegacyTaskRunCandidate(
  task: Pick<TaskRecord, "status">,
  intent: WorkItemRunPreparationIntent,
): boolean {
  return intent === "automatic"
    ? task.status === "ready"
    : task.status !== "draft" && task.status !== "running";
}

/**
 * Freeze and materialize the legacy execution inputs that eligibility must
 * inspect. Generated source and workflow metadata use a content-addressed
 * candidate path; admission also refreshes the canonical latest projection.
 * Byte-level sealing of arbitrary local-file inputs remains a separate concern.
 */
export async function prepareLegacyTaskRunCandidate(
  repoPath: string,
  id: string,
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedLegacyTaskRunCandidate> {
  const stored = await getTaskSnapshot(repoPath, id);
  const task = stored.record;
  const canPrepare = canPrepareLegacyTaskRunCandidate(task, intent);
  const activePlanningBaseline = canPrepare
    ? freezeTaskPlanningBaseline(task, task.updatedAt)
    : task.activePlanningBaseline;
  const taskSnapshot = {
    ...task,
    activePlanningBaseline,
  };
  const executionInputs = await materializeTaskRunCandidateInputs(
    repoPath,
    taskSnapshot,
    stored.version.fingerprint,
  );
  return {
    id: task.id,
    version: stored.version,
    activePlanningBaseline,
    task: taskSnapshot,
    workItem: taskRecordToWorkItem(taskSnapshot, executionInputs),
    executionInputs,
  };
}

/**
 * Seal the exact generated legacy inputs used by the admitted runner. Each
 * candidate gets a content-addressed path, so a late losing contender cannot
 * overwrite the winner's source or workflow metadata.
 */
export async function finalizeLegacyTaskRunCandidate(
  repoPath: string,
  prepared: PreparedLegacyTaskRunCandidate,
  task: TaskRecord = prepared.task,
): Promise<FinalizedLegacyTaskRunCandidate> {
  const executionTask: TaskRecord = {
    ...task,
    status: "running",
    activePlanningBaseline: prepared.activePlanningBaseline,
  };
  const executionInputs = await materializeTaskRunCandidateInputs(
    repoPath,
    executionTask,
    prepared.version.fingerprint,
  );
  return {
    task: executionTask,
    workItem: taskRecordToWorkItem(task, executionInputs),
    executionInputs,
  };
}

/**
 * Prepare only the requested legacy start candidates. Generic work items and
 * non-candidates retain their persisted projections.
 */
export async function prepareUnifiedWorkItemRunCandidates(
  repoPath: string,
  workItems: WorkItemRecord[],
  candidateIds: string[],
  intent: WorkItemRunPreparationIntent,
): Promise<PreparedUnifiedWorkItemRunCandidates> {
  const byId = new Map(workItems.map((workItem) => [workItem.id, workItem]));
  const candidates = new Map<string, WorkItemRecord>();
  const candidateVersions = new Map<string, WorkItemCandidateVersion>();
  const legacyTasks = new Map<string, PreparedLegacyTaskRunCandidate>();
  await Promise.all(
    [...new Set(candidateIds)].map(async (id) => {
      const workItem = byId.get(id);
      if (!workItem || !canPrepareLegacyTaskRunCandidate(workItem, intent)) {
        return;
      }
      try {
        const snapshot = await getWorkItemSnapshot(repoPath, id);
        candidates.set(id, snapshot.record);
        candidateVersions.set(id, snapshot.version);
        return;
      } catch (error) {
        if (!(error instanceof WebNotFoundError)) {
          throw error;
        }
      }
      const prepared = await prepareLegacyTaskRunCandidate(
        repoPath,
        id,
        intent,
      );
      legacyTasks.set(id, prepared);
      candidates.set(id, prepared.workItem);
      candidateVersions.set(id, prepared.version);
    }),
  );
  return {
    workItems: workItems.map(
      (workItem) => candidates.get(workItem.id) ?? workItem,
    ),
    candidateVersions,
    legacyTasks,
  };
}

/**
 * Unified list of every work item: legacy dev tasks (mapped to `dev.pr`) plus
 * generic store work items. Deduplicated by id with generic store records
 * winning, sorted by creation time descending.
 */
export async function listUnifiedWorkItems(
  repoPath: string,
): Promise<WorkItemRecord[]> {
  const [tasks, generic] = await Promise.all([
    listTasks(repoPath),
    listWorkItems(repoPath),
  ]);
  const byId = new Map<string, WorkItemRecord>();
  for (const task of tasks) {
    byId.set(task.id, taskRecordToWorkItem(task));
  }
  for (const item of generic) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

/**
 * Resolve a single work item by id from either store. The generic store is
 * preferred; a legacy dev task is used as a fallback.
 */
export async function getUnifiedWorkItem(
  repoPath: string,
  id: string,
): Promise<WorkItemRecord> {
  try {
    return await getWorkItem(repoPath, id);
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) {
      throw error;
    }
  }
  const task = await getTask(repoPath, id);
  return taskRecordToWorkItem(task);
}
