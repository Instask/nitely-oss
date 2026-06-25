import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WebInputError, WebNotFoundError } from "../web/errors.js";
import { IDENTIFIER_PATTERN } from "../flow/schema.js";
import type {
  CreateWorkItemInput,
  CreateWorkItemOptions,
  UpdateWorkItemPatch,
  WorkItemRecord,
} from "./types.js";
import { validatePlanningApprovalStatus } from "./planning.js";

const workItemIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function workItemsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "work-items");
}

export function validateWorkItemId(id: string): void {
  if (!workItemIdPattern.test(id)) {
    throw new WebInputError("invalid work item id");
  }
}

function validateWorkItemType(workItemType: string): void {
  if (!IDENTIFIER_PATTERN.test(workItemType)) {
    throw new WebInputError("invalid work item type");
  }
}

function workItemDirectory(repoPath: string, id: string): string {
  validateWorkItemId(id);
  return join(workItemsRoot(repoPath), id);
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createWorkItem(
  repoPath: string,
  input: CreateWorkItemInput,
  options: CreateWorkItemOptions = {},
): Promise<WorkItemRecord> {
  const title = normalizeTitle(input.title);
  if (!title) {
    throw new WebInputError("title is required");
  }
  validateWorkItemType(input.workItemType);
  if (typeof input.flowPath !== "string" || !input.flowPath.trim()) {
    throw new WebInputError("flow path is required");
  }

  const id = options.createId?.() ?? `wi-${randomUUID()}`;
  validateWorkItemId(id);
  const now = (options.now?.() ?? new Date()).toISOString();

  const record: WorkItemRecord = {
    id,
    title,
    status: "ready",
    ...(options.repoId ? { repoId: options.repoId } : {}),
    workItemType: input.workItemType,
    flowPath: input.flowPath,
    inputs: input.inputs ?? {},
    createdAt: now,
    updatedAt: now,
  };
  if (input.flowId?.trim()) {
    record.flowId = input.flowId.trim();
  }
  if (input.issueUrl?.trim()) {
    record.issueUrl = input.issueUrl.trim();
  }
  if (options.ownerId) {
    record.ownerId = options.ownerId;
  }
  if (options.organizationId) {
    record.organizationId = options.organizationId;
  }
  if (input.planning) {
    record.planning = validatePlanningApprovalStatus(input.planning);
  }

  await writeJsonAtomic(
    join(workItemDirectory(repoPath, id), "work-item.json"),
    record,
  );
  return record;
}

export async function getWorkItem(
  repoPath: string,
  id: string,
): Promise<WorkItemRecord> {
  const path = join(workItemDirectory(repoPath, id), "work-item.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as WorkItemRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("work item not found");
    }
    throw error;
  }
}

export async function listWorkItems(
  repoPath: string,
): Promise<WorkItemRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(workItemsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const items = await Promise.all(
    entries.map(async (entry) => {
      try {
        validateWorkItemId(entry);
        return await getWorkItem(repoPath, entry);
      } catch {
        return undefined;
      }
    }),
  );
  return items
    .filter((item): item is WorkItemRecord => item !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateWorkItem(
  repoPath: string,
  id: string,
  patch: UpdateWorkItemPatch,
): Promise<WorkItemRecord> {
  const record = await getWorkItem(repoPath, id);
  const updated: WorkItemRecord = {
    ...record,
    ...patch,
    ...(patch.planning ? { planning: validatePlanningApprovalStatus(patch.planning) } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (patch.changeRequestUrl === undefined) {
    delete updated.changeRequestUrl;
  }
  await writeJsonAtomic(
    join(workItemDirectory(repoPath, id), "work-item.json"),
    updated,
  );
  return updated;
}
