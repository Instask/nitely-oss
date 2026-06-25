import type { TaskRecord } from "../../web/tasks.js";
import { getTask, listTasks } from "../../web/tasks.js";
import { WebNotFoundError } from "../../web/errors.js";
import { getWorkItem, listWorkItems } from "../store.js";
import type { WorkItemRecord } from "../types.js";

export const DEV_PR_WORK_ITEM_TYPE = "dev.pr";

/**
 * Map a legacy dev `TaskRecord` into a generic `WorkItemRecord`. The fixed
 * `specPath` / `techDesignPath` become typed input bindings so the rest of the
 * system can treat a dev task as one work item type. No disk migration happens;
 * this projection is computed at read time.
 */
export function taskRecordToWorkItem(task: TaskRecord): WorkItemRecord {
  const record: WorkItemRecord = {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.repoId ? { repoId: task.repoId } : {}),
    workItemType: DEV_PR_WORK_ITEM_TYPE,
    flowPath: task.flowPath,
    ...(task.specStatus ? { specStatus: task.specStatus } : {}),
    ...(task.techDesignStatus ? { techDesignStatus: task.techDesignStatus } : {}),
    ...(task.planningNotes ? { planningNotes: task.planningNotes } : {}),
    ...(task.source ? { planningSource: task.source } : {}),
    inputs: {
      spec: { connector: "local-file", uri: task.specPath },
      "tech-design": { connector: "local-file", uri: task.techDesignPath },
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
