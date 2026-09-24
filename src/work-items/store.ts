import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WebInputError, WebNotFoundError } from "../web/errors.js";
import { IDENTIFIER_PATTERN } from "../flow/schema.js";
import type {
  CreateWorkItemInput,
  CreateWorkItemOptions,
  UpdateWorkItemPatch,
  WorkItemCandidateVersion,
  WorkItemRecord,
} from "./types.js";
import type { SuggestedDependency, TaskPriority } from "../web/tasks.js";
import { validatePlanningApprovalStatus } from "./planning.js";
import { workItemCandidateFingerprint } from "./candidate-version.js";

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

function normalizePriority(value: unknown): TaskPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3"
    ? value
    : "P2";
}

function normalizeDependencyIds(ids: unknown, selfId: string): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) {
      continue;
    }
    const dependencyId = id.trim();
    validateWorkItemId(dependencyId);
    if (dependencyId !== selfId) {
      normalized.push(dependencyId);
    }
  }
  return [...new Set(normalized)];
}

function normalizeSuggestedDependencies(
  suggestions: unknown,
  selfId: string,
): SuggestedDependency[] {
  if (!Array.isArray(suggestions)) {
    return [];
  }
  return suggestions.filter((suggestion): suggestion is SuggestedDependency => {
    if (
      !suggestion ||
      typeof suggestion !== "object" ||
      typeof (suggestion as SuggestedDependency).dependsOn !== "string" ||
      typeof (suggestion as SuggestedDependency).reason !== "string" ||
      typeof (suggestion as SuggestedDependency).confidence !== "number" ||
      typeof (suggestion as SuggestedDependency).source !== "string" ||
      typeof (suggestion as SuggestedDependency).suggestedAt !== "string"
    ) {
      return false;
    }
    const dependsOn = (suggestion as SuggestedDependency).dependsOn.trim();
    if (!dependsOn || dependsOn === selfId) {
      return false;
    }
    validateWorkItemId(dependsOn);
    return true;
  });
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
    ...(input.configuration ? { configuration: input.configuration } : {}),
    priority: normalizePriority(input.priority),
    dependsOn: normalizeDependencyIds(input.dependsOn, id),
    suggestedDependencies: normalizeSuggestedDependencies(
      input.suggestedDependencies,
      id,
    ),
    createdAt: now,
    updatedAt: now,
  };
  if (input.flowId?.trim()) {
    record.flowId = input.flowId.trim();
  }
  if (input.template) {
    record.template = input.template;
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
  return (await getWorkItemSnapshot(repoPath, id)).record;
}

export interface StoredWorkItemSnapshot {
  record: WorkItemRecord;
  version: WorkItemCandidateVersion;
}

export async function getWorkItemSnapshot(
  repoPath: string,
  id: string,
): Promise<StoredWorkItemSnapshot> {
  const path = join(workItemDirectory(repoPath, id), "work-item.json");
  try {
    const document = await readFile(path, "utf8");
    const record = JSON.parse(document) as WorkItemRecord;
    return {
      record,
      version: {
        store: "generic",
        fingerprint: workItemCandidateFingerprint(
          record as unknown as Record<string, unknown>,
        ),
      },
    };
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
    ...("planning" in patch && patch.planning
      ? { planning: validatePlanningApprovalStatus(patch.planning) }
      : {}),
    ...("priority" in patch ? { priority: normalizePriority(patch.priority) } : {}),
    ...("dependsOn" in patch
      ? { dependsOn: normalizeDependencyIds(patch.dependsOn, id) }
      : {}),
    ...("suggestedDependencies" in patch
      ? {
          suggestedDependencies: normalizeSuggestedDependencies(
            patch.suggestedDependencies,
            id,
          ),
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  if ("changeRequestUrl" in patch && patch.changeRequestUrl === undefined) {
    delete updated.changeRequestUrl;
  }
  await writeJsonAtomic(
    join(workItemDirectory(repoPath, id), "work-item.json"),
    updated,
  );
  return updated;
}

export async function updateWorkItemDependencies(
  repoPath: string,
  id: string,
  dependsOn: string[],
): Promise<WorkItemRecord> {
  return updateWorkItem(repoPath, id, { dependsOn });
}

export async function confirmWorkItemDependency(
  repoPath: string,
  id: string,
  upstreamId: string,
): Promise<WorkItemRecord> {
  validateWorkItemId(upstreamId);
  const item = await getWorkItem(repoPath, id);
  return updateWorkItem(repoPath, id, {
    dependsOn: [...new Set([...(item.dependsOn ?? []), upstreamId])],
    suggestedDependencies: (item.suggestedDependencies ?? []).filter(
      (suggestion) => suggestion.dependsOn !== upstreamId,
    ),
  });
}

export async function dismissWorkItemDependencySuggestion(
  repoPath: string,
  id: string,
  upstreamId: string,
): Promise<WorkItemRecord> {
  validateWorkItemId(upstreamId);
  const item = await getWorkItem(repoPath, id);
  return updateWorkItem(repoPath, id, {
    suggestedDependencies: (item.suggestedDependencies ?? []).filter(
      (suggestion) => suggestion.dependsOn !== upstreamId,
    ),
  });
}

export async function updateWorkItemDependencySuggestions(
  repoPath: string,
  id: string,
  suggestedDependencies: SuggestedDependency[],
): Promise<WorkItemRecord> {
  return updateWorkItem(repoPath, id, { suggestedDependencies });
}
