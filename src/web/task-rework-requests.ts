import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ResourceReference } from "../connectors/types.js";
import type { ChangeRequest } from "../scm/types.js";
import {
  freezeTaskPlanningBaseline,
  validateTaskId,
  type TaskPlanningBaseline,
  type TaskRecord,
} from "./tasks.js";
import { WebInputError, WebNotFoundError } from "./errors.js";

export type TaskReworkRequestStatus =
  | "pending_confirmation"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskReworkRouteTarget =
  | "implementation"
  | "spec"
  | "tech-design"
  | "workflow";

export interface TaskReworkRequestActor {
  id: string;
  email?: string;
}

export interface TaskReworkRequestRoute {
  target: TaskReworkRouteTarget;
  confidence: "explicit";
  reason: string;
  requiresOperatorApproval: boolean;
}

export interface TaskReworkRequestChangeTarget {
  provider: "github";
  target: string;
  url: string;
  owner?: string;
  repository?: string;
  number?: number;
  baseBranch?: string;
  headBranch?: string;
  headSha?: string;
}

export interface TaskReworkRequest {
  schemaVersion: "nitely.task-rework-request.v1";
  id: string;
  idempotencyKey: string;
  taskId: string;
  status: TaskReworkRequestStatus;
  instruction: string;
  route: TaskReworkRequestRoute;
  actor: TaskReworkRequestActor;
  createdAt: string;
  updatedAt: string;
  planningBaseline?: TaskPlanningBaseline;
  priorRunId: string;
  flowPath: string;
  changeRequest: TaskReworkRequestChangeTarget;
  confirmedAt?: string;
  runId?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  terminalReason?: string;
  resultChangeRequestUrl?: string;
}

export interface CreateTaskReworkRequestInput {
  instruction: string;
  routeTarget?: TaskReworkRouteTarget;
  idempotencyKey?: string;
  actor: TaskReworkRequestActor;
  flowPath?: string;
  changeRequest?: ChangeRequest;
  now?: Date;
}

export interface MaterializedTaskReworkRequestInputs {
  directory: string;
  inputs: Record<"spec" | "tech-design", ResourceReference>;
}

export const defaultTaskReworkFlowPath = "flows/rework-pr-bootstrap.json";
const requestIdPattern = /^tcr_[a-f0-9]{16}$/;
const activeStatuses = new Set<TaskReworkRequestStatus>([
  "pending_confirmation",
  "running",
]);

function reworkRequestsRoot(repoPath: string, taskId: string): string {
  validateTaskId(taskId);
  return join(resolve(repoPath), ".nitely", "tasks", taskId, "rework-requests");
}

function reworkRequestPath(
  repoPath: string,
  taskId: string,
  requestId: string,
): string {
  validateReworkRequestId(requestId);
  return join(reworkRequestsRoot(repoPath, taskId), `${requestId}.json`);
}

function requestDirectory(
  repoPath: string,
  taskId: string,
  requestId: string,
): string {
  validateReworkRequestId(requestId);
  return join(reworkRequestsRoot(repoPath, taskId), requestId);
}

function validateReworkRequestId(requestId: string): void {
  if (!requestIdPattern.test(requestId)) {
    throw new WebInputError("invalid task rework request id");
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableIdempotencyKey(input: {
  taskId: string;
  instruction: string;
  routeTarget: TaskReworkRouteTarget;
  changeRequestUrl: string;
  actorId: string;
}): string {
  return sha256Hex(
    [
      "task-rework-request",
      input.taskId,
      input.routeTarget,
      input.changeRequestUrl,
      input.actorId,
      input.instruction,
    ].join("\0"),
  );
}

function requestIdFor(taskId: string, idempotencyKey: string): string {
  return `tcr_${sha256Hex(`${taskId}\0${idempotencyKey}`).slice(0, 16)}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeInstruction(value: string): string {
  const instruction = value.trim();
  if (!instruction) {
    throw new WebInputError("rework instruction is required");
  }
  if (instruction.length > 20_000) {
    throw new WebInputError("rework instruction must be at most 20000 characters");
  }
  return instruction;
}

function normalizeRouteTarget(
  value: TaskReworkRouteTarget | undefined,
): TaskReworkRouteTarget {
  return value ?? "implementation";
}

function routeFor(target: TaskReworkRouteTarget): TaskReworkRequestRoute {
  if (target !== "implementation") {
    throw new WebInputError(
      `task request changes first slice supports only implementation route; ${target} planning refinement is not yet enabled`,
    );
  }
  return {
    target,
    confidence: "explicit",
    reason:
      "Operator selected implementation-scoped same-PR rework from Task detail.",
    requiresOperatorApproval: true,
  };
}

function parseGitHubPullUrl(
  value: string,
): Pick<TaskReworkRequestChangeTarget, "owner" | "repository" | "number"> | undefined {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const number = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(number)) return undefined;
  return {
    owner: match[1],
    repository: match[2],
    number,
  };
}

function changeTargetFor(input: {
  task: TaskRecord;
  changeRequest?: ChangeRequest;
}): TaskReworkRequestChangeTarget {
  const url = input.changeRequest?.url ?? input.task.changeRequestUrl;
  if (!url) {
    throw new WebInputError("completed task has no change request to rework");
  }
  const parsed = parseGitHubPullUrl(url);
  return {
    provider: "github",
    target: parsed?.number ? String(parsed.number) : url,
    url,
    ...(parsed ? parsed : {}),
    ...(input.changeRequest?.baseBranch
      ? { baseBranch: input.changeRequest.baseBranch }
      : {}),
    ...(input.changeRequest?.headBranch
      ? { headBranch: input.changeRequest.headBranch }
      : {}),
  };
}

function assertTaskCanCreateReworkRequest(task: TaskRecord): void {
  if (task.status === "running") {
    throw new WebInputError(
      "running Task cannot receive live request changes; wait for the active run to finish or cancel it first",
    );
  }
  if (task.status !== "completed") {
    throw new WebInputError(
      "request changes is available only for completed Tasks in this slice",
    );
  }
  if (!task.latestRunId) {
    throw new WebInputError("completed task has no prior run to link");
  }
  if (!task.changeRequestUrl) {
    throw new WebInputError("completed task has no change request to rework");
  }
}

function compatibleExistingRequest(
  existing: TaskReworkRequest,
  input: {
    instruction: string;
    route: TaskReworkRequestRoute;
    flowPath: string;
    changeRequestUrl: string;
  },
): boolean {
  return (
    existing.instruction === input.instruction &&
    existing.route.target === input.route.target &&
    existing.flowPath === input.flowPath &&
    existing.changeRequest.url === input.changeRequestUrl
  );
}

export async function listTaskReworkRequests(
  repoPath: string,
  taskId: string,
): Promise<TaskReworkRequest[]> {
  const root = reworkRequestsRoot(repoPath, taskId);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const requests = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const request = JSON.parse(
            await readFile(join(root, entry), "utf8"),
          ) as TaskReworkRequest;
          return request.schemaVersion === "nitely.task-rework-request.v1"
            ? request
            : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return requests
    .filter((request): request is TaskReworkRequest => request !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getTaskReworkRequest(
  repoPath: string,
  taskId: string,
  requestId: string,
): Promise<TaskReworkRequest> {
  try {
    return JSON.parse(
      await readFile(reworkRequestPath(repoPath, taskId, requestId), "utf8"),
    ) as TaskReworkRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("task rework request not found");
    }
    throw error;
  }
}

export async function createTaskReworkRequest(
  repoPath: string,
  task: TaskRecord,
  input: CreateTaskReworkRequestInput,
): Promise<TaskReworkRequest> {
  assertTaskCanCreateReworkRequest(task);
  const instruction = normalizeInstruction(input.instruction);
  const routeTarget = normalizeRouteTarget(input.routeTarget);
  const route = routeFor(routeTarget);
  const flowPath = input.flowPath?.trim() || defaultTaskReworkFlowPath;
  const changeRequest = changeTargetFor({
    task,
    ...(input.changeRequest ? { changeRequest: input.changeRequest } : {}),
  });
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    stableIdempotencyKey({
      taskId: task.id,
      instruction,
      routeTarget,
      changeRequestUrl: changeRequest.url,
      actorId: input.actor.id,
    });
  const id = requestIdFor(task.id, idempotencyKey);
  const existing = await listTaskReworkRequests(repoPath, task.id);
  const sameKey = existing.find(
    (request) => request.idempotencyKey === idempotencyKey,
  );
  if (sameKey) {
    if (
      !compatibleExistingRequest(sameKey, {
        instruction,
        route,
        flowPath,
        changeRequestUrl: changeRequest.url,
      })
    ) {
      throw new WebInputError(
        "idempotency key already belongs to a different task rework request",
      );
    }
    return sameKey;
  }
  const active = existing.find((request) => activeStatuses.has(request.status));
  if (active) {
    throw new WebInputError(
      `task already has an active rework request: ${active.id}`,
    );
  }
  const now = (input.now ?? new Date()).toISOString();
  const request: TaskReworkRequest = {
    schemaVersion: "nitely.task-rework-request.v1",
    id,
    idempotencyKey,
    taskId: task.id,
    status: "pending_confirmation",
    instruction,
    route,
    actor: input.actor,
    createdAt: now,
    updatedAt: now,
    planningBaseline: task.activePlanningBaseline ?? freezeTaskPlanningBaseline(task, now),
    priorRunId: task.latestRunId!,
    flowPath,
    changeRequest,
  };
  await writeJsonAtomic(reworkRequestPath(repoPath, task.id, id), request);
  return request;
}

export async function cancelTaskReworkRequest(input: {
  repoPath: string;
  taskId: string;
  requestId: string;
  reason?: string;
  now?: Date;
}): Promise<TaskReworkRequest> {
  const request = await getTaskReworkRequest(
    input.repoPath,
    input.taskId,
    input.requestId,
  );
  if (request.status === "running") {
    throw new WebInputError("running task rework request cannot be cancelled");
  }
  if (request.status !== "pending_confirmation") {
    return request;
  }
  const now = (input.now ?? new Date()).toISOString();
  const updated: TaskReworkRequest = {
    ...request,
    status: "cancelled",
    updatedAt: now,
    cancelledAt: now,
    ...(input.reason?.trim() ? { terminalReason: input.reason.trim() } : {}),
  };
  await writeJsonAtomic(
    reworkRequestPath(input.repoPath, input.taskId, input.requestId),
    updated,
  );
  return updated;
}

export async function markTaskReworkRequestRunning(input: {
  repoPath: string;
  taskId: string;
  requestId: string;
  runId: string;
  now?: Date;
}): Promise<TaskReworkRequest> {
  const request = await getTaskReworkRequest(
    input.repoPath,
    input.taskId,
    input.requestId,
  );
  if (request.status === "running" && request.runId === input.runId) {
    return request;
  }
  if (request.status !== "pending_confirmation") {
    throw new WebInputError(
      `task rework request ${request.id} is not pending confirmation`,
    );
  }
  const now = (input.now ?? new Date()).toISOString();
  const updated: TaskReworkRequest = {
    ...request,
    status: "running",
    runId: input.runId,
    confirmedAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(
    reworkRequestPath(input.repoPath, input.taskId, input.requestId),
    updated,
  );
  return updated;
}

export async function settleTaskReworkRequest(input: {
  repoPath: string;
  taskId: string;
  requestId: string;
  status: "completed" | "failed";
  resultChangeRequestUrl?: string;
  reason?: string;
  now?: Date;
}): Promise<TaskReworkRequest> {
  const request = await getTaskReworkRequest(
    input.repoPath,
    input.taskId,
    input.requestId,
  );
  const now = (input.now ?? new Date()).toISOString();
  const updated: TaskReworkRequest = {
    ...request,
    status: input.status,
    updatedAt: now,
    ...(input.status === "completed" ? { completedAt: now } : { failedAt: now }),
    ...(input.resultChangeRequestUrl
      ? { resultChangeRequestUrl: input.resultChangeRequestUrl }
      : {}),
    ...(input.reason ? { terminalReason: input.reason } : {}),
  };
  await writeJsonAtomic(
    reworkRequestPath(input.repoPath, input.taskId, input.requestId),
    updated,
  );
  return updated;
}

export async function materializeTaskReworkRequestInputs(
  repoPath: string,
  request: TaskReworkRequest,
): Promise<MaterializedTaskReworkRequestInputs> {
  const directory = join(
    requestDirectory(repoPath, request.taskId, request.id),
    "inputs",
  );
  await mkdir(directory, { recursive: true });
  const specPath = join(directory, "spec.md");
  const techDesignPath = join(directory, "tech-design.md");
  const requestPath = join(directory, "request.json");
  await writeFile(
    specPath,
    [
      "# Task Request Changes",
      "",
      `Task ID: ${request.taskId}`,
      `Request ID: ${request.id}`,
      `Route: ${request.route.target}`,
      `Prior run ID: ${request.priorRunId}`,
      `Change request: ${request.changeRequest.url}`,
      "",
      "## Requested Change",
      "",
      request.instruction,
      "",
      "Update the existing pull request branch only. Keep the change scoped to this Task request.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    techDesignPath,
    [
      "# Rework Operating Plan",
      "",
      "- Check out and inspect the existing pull request branch before editing.",
      "- Apply only the requested implementation-scoped refinement.",
      "- Preserve the approved planning baseline unless the request explicitly requires a follow-up planning revision.",
      "- Update tests and documentation when behavior changes.",
      "- Push updates through the same change request.",
      "",
      "## Planning Baseline",
      "",
      request.planningBaseline
        ? JSON.stringify(request.planningBaseline, null, 2)
        : "No approved planning baseline was recorded.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeJsonAtomic(requestPath, request);
  return {
    directory,
    inputs: {
      spec: { connector: "local-file", uri: specPath },
      "tech-design": { connector: "local-file", uri: techDesignPath },
    },
  };
}
