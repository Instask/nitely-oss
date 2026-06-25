import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { WebInputError, WebNotFoundError } from "./errors.js";

export type TaskStatus = "draft" | "ready" | "running" | "completed" | "failed";
export type SpecApprovalStatus = "draft" | "approved";

export interface TaskSourceRecord {
  type: "prompt" | "text" | "github-issue";
  uri?: string;
  title?: string;
}

export interface TaskPlanningNotes {
  openQuestions?: string[];
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  specStatus?: SpecApprovalStatus;
  techDesignStatus?: SpecApprovalStatus;
  planningNotes?: TaskPlanningNotes;
  source?: TaskSourceRecord;
  repoId?: string;
  flowPath: string;
  issueUrl?: string;
  specPath: string;
  techDesignPath: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  ownerId?: string;
  organizationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  spec: string;
  techDesign: string;
  repoId?: string;
  issueUrl?: string;
  flowPath?: string;
}

export interface TaskDetail {
  task: TaskRecord;
  spec: string;
  techDesign: string;
}

export interface CreateTaskOptions {
  createId?: () => string;
  now?: () => Date;
  ownerId?: string;
  organizationId?: string;
  repoId?: string;
  initialStatus?: TaskStatus;
  specStatus?: SpecApprovalStatus;
  techDesignStatus?: SpecApprovalStatus;
  source?: TaskSourceRecord;
}

const defaultFlowPath = "flows/implement-spec-bootstrap.json";
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function tasksRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "tasks");
}

function taskDirectory(repoPath: string, taskId: string): string {
  validateTaskId(taskId);
  return join(tasksRoot(repoPath), taskId);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pathInsideRepo(repoPath: string, candidatePath: string): boolean {
  const repo = resolve(repoPath);
  const candidate = resolve(repo, candidatePath);
  const fromRepo = relative(repo, candidate);
  return fromRepo === "" || (!fromRepo.startsWith("..") && !fromRepo.includes(`..${sep}`));
}

function absolutePathInsideRepo(repoPath: string, candidatePath: string): boolean {
  const fromRepo = relative(repoPath, candidatePath);
  return fromRepo === "" || (!fromRepo.startsWith("..") && !fromRepo.includes(`..${sep}`));
}

function repoRelativePath(repoPath: string, candidatePath: string): string {
  const repo = resolve(repoPath);
  const absolute = resolve(repo, candidatePath);
  const fromRepo = relative(repo, absolute).replaceAll("\\", "/");
  if (!fromRepo || fromRepo.startsWith("..") || fromRepo.includes("../")) {
    throw new WebInputError("flow path must stay inside the repository");
  }
  return fromRepo;
}

async function validateFlowPath(
  repoPath: string,
  candidatePath: string,
): Promise<string> {
  const relativePath = repoRelativePath(repoPath, candidatePath);
  const repoRealPath = await realpath(resolve(repoPath));
  const absoluteFlowPath = resolve(repoPath, relativePath);
  let flowRealPath: string;
  try {
    flowRealPath = await realpath(absoluteFlowPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebInputError("flow path must exist inside the repository");
    }
    throw error;
  }
  if (!absolutePathInsideRepo(repoRealPath, flowRealPath)) {
    throw new WebInputError("flow path must stay inside the repository");
  }
  return relativePath;
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

export function validateTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new WebInputError("invalid task id");
  }
}

export function resolveTaskFlowPath(repoPath: string, task: TaskRecord): string {
  if (!pathInsideRepo(repoPath, task.flowPath)) {
    throw new WebInputError("flow path must stay inside the repository");
  }
  const repoRealPath = realpathSync(resolve(repoPath));
  const flowPath = resolve(repoPath, task.flowPath);
  let flowRealPath: string;
  try {
    flowRealPath = realpathSync(flowPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebInputError("flow path must exist inside the repository");
    }
    throw error;
  }
  if (!absolutePathInsideRepo(repoRealPath, flowRealPath)) {
    throw new WebInputError("flow path must stay inside the repository");
  }
  return flowPath;
}

export async function createTask(
  repoPath: string,
  input: CreateTaskInput,
  options: CreateTaskOptions = {},
): Promise<TaskRecord> {
  const title = normalizeText(input.title);
  const spec = typeof input.spec === "string" ? input.spec : "";
  const techDesign = typeof input.techDesign === "string" ? input.techDesign : "";
  if (!title) {
    throw new WebInputError("title is required");
  }
  if (!spec.trim()) {
    throw new WebInputError("specification text is required");
  }
  if (!techDesign.trim()) {
    throw new WebInputError("technical design text is required");
  }

  const flowPath = await validateFlowPath(
    repoPath,
    normalizeOptionalText(input.flowPath) ?? defaultFlowPath,
  );
  const id = options.createId?.() ?? `task-${randomUUID()}`;
  validateTaskId(id);

  const now = (options.now?.() ?? new Date()).toISOString();
  const directory = taskDirectory(repoPath, id);
  const specPath = `.nitely/tasks/${id}/spec.md`;
  const techDesignPath = `.nitely/tasks/${id}/tech-design.md`;
  const task: TaskRecord = {
    id,
    title,
    status: options.initialStatus ?? "ready",
    ...(options.specStatus ? { specStatus: options.specStatus } : {}),
    ...(options.techDesignStatus
      ? { techDesignStatus: options.techDesignStatus }
      : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.repoId ? { repoId: options.repoId } : {}),
    flowPath,
    specPath,
    techDesignPath,
    createdAt: now,
    updatedAt: now,
  };
  if (options.ownerId) {
    task.ownerId = options.ownerId;
  }
  if (options.organizationId) {
    task.organizationId = options.organizationId;
  }
  const issueUrl = normalizeOptionalText(input.issueUrl);
  if (issueUrl) {
    task.issueUrl = issueUrl;
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "spec.md"), spec, "utf8");
  await writeFile(join(directory, "tech-design.md"), techDesign, "utf8");
  await writeJsonAtomic(join(directory, "task.json"), task);
  return task;
}

export async function updateTaskTechnicalDesign(
  repoPath: string,
  taskId: string,
  techDesign: string,
  status: SpecApprovalStatus,
  planningNotes?: TaskPlanningNotes,
): Promise<TaskRecord> {
  if (!techDesign.trim()) {
    throw new WebInputError("technical design text is required");
  }
  const task = await getTask(repoPath, taskId);
  await writeFile(resolve(repoPath, task.techDesignPath), techDesign, "utf8");
  const updated: TaskRecord = {
    ...task,
    techDesignStatus: status,
    ...(planningNotes
      ? { planningNotes: { ...(task.planningNotes ?? {}), ...planningNotes } }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function updateTaskSpecApproval(
  repoPath: string,
  taskId: string,
  status: SpecApprovalStatus,
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  const spec = await readFile(resolve(repoPath, task.specPath), "utf8");
  if (!spec.trim()) {
    throw new WebInputError("specification text is required");
  }
  const updated: TaskRecord = {
    ...task,
    specStatus: status,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function updateTaskTechnicalDesignApproval(
  repoPath: string,
  taskId: string,
  status: SpecApprovalStatus,
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  const techDesign = await readFile(resolve(repoPath, task.techDesignPath), "utf8");
  if (!techDesign.trim()) {
    throw new WebInputError("technical design text is required");
  }
  const updated: TaskRecord = {
    ...task,
    techDesignStatus: status,
    status: status === "approved" ? "ready" : "draft",
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function getTask(repoPath: string, taskId: string): Promise<TaskRecord> {
  const path = join(taskDirectory(repoPath, taskId), "task.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as TaskRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("task not found");
    }
    throw error;
  }
}

export async function getTaskDetail(
  repoPath: string,
  taskId: string,
): Promise<TaskDetail> {
  const task = await getTask(repoPath, taskId);
  const [spec, techDesign] = await Promise.all([
    readFile(resolve(repoPath, task.specPath), "utf8"),
    readFile(resolve(repoPath, task.techDesignPath), "utf8"),
  ]);
  return { task, spec, techDesign };
}

export async function listTasks(repoPath: string): Promise<TaskRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(tasksRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tasks = await Promise.all(
    entries.map(async (entry) => {
      try {
        validateTaskId(entry);
        return await getTask(repoPath, entry);
      } catch {
        return undefined;
      }
    }),
  );
  return tasks
    .filter((task): task is TaskRecord => task !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateTaskRunState(
  repoPath: string,
  taskId: string,
  patch: Pick<TaskRecord, "status"> &
    Partial<Pick<TaskRecord, "latestRunId" | "changeRequestUrl">>,
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  const updated: TaskRecord = {
    ...task,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (patch.changeRequestUrl === undefined) {
    delete updated.changeRequestUrl;
  }
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}
