import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runFlow as defaultRunFlow,
  type RunFlowDependencies,
  type RunFlowInput,
  type RunFlowResult,
} from "../run/run-flow.js";
import {
  defaultGitHubIssueFetcher,
  generateDraftSpec,
  parseGitHubIssueReference,
  type DraftSpecSource,
  type DraftSpecSourceType,
  type GitHubIssueFetcher,
} from "../spec-artifacts/draft.js";
import {
  collectRepositoryPlanContext,
  generateDraftTechnicalPlan,
} from "../plan-artifacts/draft.js";
import { loadContextPolicy } from "../context/policy.js";
import { collectContextRedactionSecrets } from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors.js";
import { FileProviderConnectionStore } from "../providers/file-store.js";
import { resolveProviderStore } from "../providers/index.js";
import type { ProviderConnectionStore, ProviderId } from "../providers/types.js";
import {
  isWebError,
  WebForbiddenError,
  WebInputError,
  WebNotFoundError,
  WebSetupRequiredError,
  WebUnauthorizedError,
} from "./errors.js";
import {
  createTask,
  getTask,
  getTaskDetail,
  resolveTaskFlowPath,
  updateTaskSpecApproval,
  updateTaskTechnicalDesign,
  updateTaskTechnicalDesignApproval,
  updateTaskRunState,
} from "./tasks.js";
import { getRunDetail, listRuns } from "./runs.js";
import { eventStorePath, projectRun } from "../run/project.js";
import { taskRecordToWorkItem } from "../work-items/adapters/dev-pr.js";
import {
  getWorkItemView,
  listWorkItemViews,
} from "./work-item-views.js";
import { createFlowWorkItem } from "../work-items/create.js";
import { assertPlanningReadyForExecution } from "../work-items/planning.js";
import { getWorkItem, updateWorkItem } from "../work-items/store.js";
import { assertWorkItemTypeAllowed } from "../work-items/governance.js";
import { FlowValidationError, loadFlow, parseFlowDocument } from "../flow/load.js";
import { openFlowStore } from "../flows/store.js";
import { validateFlowDocument } from "../flows/validate.js";
import { flowTemplates } from "../flows/templates.js";
import { listFlowViews, getFlowView } from "./flows.js";
import { flowWorkItemType } from "../flow/schema.js";
import {
  addStoredWebRepository,
  loadWebRepositories,
  repositoryById,
  type AddWebRepositoryInput,
  type CloneRepository,
  type WebRepository,
  type WebRepositoryInput,
} from "./repositories.js";
import { buildManagerDashboard } from "./dashboard.js";
import {
  bootstrapInitialAdmin,
  createSession,
  deleteSession,
  getPublicUser,
  hasAnyUsers,
  readSessionUser,
  verifyUserPassword,
  type PublicUser,
} from "./users.js";
import {
  organizationRoleCanWrite,
  type PublicOrganizationMembership,
} from "./organizations.js";

const staticDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "web", "static",
);

export interface StartWebServerInput {
  repoPath: string;
  repositories?: WebRepositoryInput[];
  host: string;
  port: number;
  authMode?: WebAuthMode;
  authEnv?: Record<string, string | undefined>;
  providerEnv?: Record<string, string | undefined>;
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>;
  providerCommandStatus?: (command: string, args: string[]) => Promise<boolean>;
  providerStore?: ProviderConnectionStore;
  cloneRepository?: CloneRepository;
  githubIssueFetcher?: GitHubIssueFetcher;
}

export type WebAuthMode = "local" | "required";

export interface WebUserContext {
  id: string;
  email: string;
  role: "admin" | "user";
  authMode: WebAuthMode;
  memberships?: PublicOrganizationMembership[];
  currentOrganizationId?: string;
  currentOrganizationRole?: PublicOrganizationMembership["role"];
}

export interface WebServer {
  url: string;
  close(): Promise<void>;
}

type AcceptedRunStatus = "running" | "blocked" | "interrupted" | "completed" | "failed";

interface AcceptedRunMetadata {
  runId: string;
  status: AcceptedRunStatus;
  taskId: string;
  repoId?: string;
  branchName?: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function sendJsonWithHeaders(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(value);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (isWebError(error)) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof FlowValidationError) {
    sendJson(response, 400, {
      error: { code: "invalid_flow", message: error.message },
    });
    return;
  }
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "internal server error",
    },
  });
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) {
      throw new WebInputError("request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WebInputError("request body must be valid JSON");
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebInputError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function taskScopeFromJson(value: unknown): RunFlowInput["taskScope"] {
  if (value === undefined) return undefined;
  const record = requireObject(value);
  const inputId = typeof record.inputId === "string" ? record.inputId.trim() : "";
  const expression =
    typeof record.expression === "string" ? record.expression.trim() : "";
  if (!inputId || !expression) {
    throw new WebInputError("taskScope must include inputId and expression");
  }
  return { inputId, expression };
}

function isResourceReferenceMap(
  value: unknown,
): value is Record<string, { connector: string; uri: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((reference) => {
    if (
      typeof reference !== "object" ||
      reference === null ||
      Array.isArray(reference)
    ) {
      return false;
    }
    const record = reference as Record<string, unknown>;
    return (
      typeof record.connector === "string" && typeof record.uri === "string"
    );
  });
}

function authModeForInput(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): WebAuthMode {
  const env = input.authEnv ?? process.env;
  const raw = input.authMode ?? env.NITELY_WEB_AUTH ?? "local";
  if (raw === "required") {
    return "required";
  }
  return "local";
}

function selectOrganizationContext(
  user: PublicUser,
  requestedOrganizationId: string | undefined,
): PublicUser {
  if (!requestedOrganizationId) {
    return user;
  }
  const membership = (user.memberships ?? []).find(
    (candidate) => candidate.organizationId === requestedOrganizationId,
  );
  if (!membership) {
    throw new WebForbiddenError("organization access required");
  }
  return {
    ...user,
    currentOrganizationId: membership.organizationId,
    currentOrganizationRole: membership.role,
  };
}

function publicContext(
  user: PublicUser,
  authMode: WebAuthMode,
  requestedOrganizationId?: string,
): WebUserContext {
  return { ...selectOrganizationContext(user, requestedOrganizationId), authMode };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        continue;
      }
    }
  }
  return cookies;
}

function sessionCookie(sessionId: string): string {
  return `nitely_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie(): string {
  return "nitely_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

async function resolveUserContext(
  request: IncomingMessage,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
): Promise<WebUserContext | null> {
  const authMode = authModeForInput(input);
  if (authMode === "local") {
    return { id: "local", email: "local", role: "admin", authMode };
  }
  const sessionId = parseCookies(request.headers.cookie).nitely_session;
  if (!sessionId) {
    return null;
  }
  const user = await readSessionUser(repoPath, sessionId);
  const requestedOrganizationId = request.headers["x-nitely-organization-id"];
  return user
    ? publicContext(
        user,
        authMode,
        typeof requestedOrganizationId === "string"
          ? requestedOrganizationId
          : undefined,
      )
    : null;
}

async function requireUserContext(
  request: IncomingMessage,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
): Promise<WebUserContext> {
  const user = await resolveUserContext(request, input, repoPath);
  if (!user) {
    throw new WebUnauthorizedError();
  }
  return user;
}

function recordVisibleToUser(
  record: { ownerId?: string; organizationId?: string },
  user: WebUserContext,
): boolean {
  if (user.authMode === "local" || user.role === "admin") {
    return true;
  }
  if (record.organizationId) {
    return (user.memberships ?? []).some(
      (membership) => membership.organizationId === record.organizationId,
    );
  }
  return record.ownerId === user.id;
}

function requireAdminAccess(user: WebUserContext): void {
  if (user.authMode === "local" || user.role === "admin") {
    return;
  }
  throw new WebForbiddenError("admin access required");
}

function requireRecordAccess(
  record: { ownerId?: string; organizationId?: string },
  user: WebUserContext,
  message: string,
): void {
  if (!recordVisibleToUser(record, user)) {
    throw new WebNotFoundError(message);
  }
}

function requireWriteAccessToOrganization(
  user: WebUserContext,
  organizationId: string | undefined,
): void {
  if (user.authMode === "local" || user.role === "admin") {
    return;
  }
  const role = (user.memberships ?? []).find(
    (membership) => membership.organizationId === organizationId,
  )?.role;
  if (organizationRoleCanWrite(role)) {
    return;
  }
  throw new WebForbiddenError("organization write access required");
}

function requireWriteAccessToRecord(
  user: WebUserContext,
  record: { ownerId?: string; organizationId?: string },
): void {
  if (user.authMode === "local" || user.role === "admin") {
    return;
  }
  if (record.organizationId) {
    requireWriteAccessToOrganization(user, record.organizationId);
    return;
  }
  if (record.ownerId === user.id) {
    return;
  }
  throw new WebForbiddenError("record write access required");
}

function currentWritableOrganizationId(user: WebUserContext): string | undefined {
  if (user.authMode === "local" || user.role === "admin") {
    return user.currentOrganizationId;
  }
  requireWriteAccessToOrganization(user, user.currentOrganizationId);
  return user.currentOrganizationId;
}

function taskInputFromJson(value: unknown): {
  title: string;
  spec: string;
  techDesign: string;
  repoId?: string;
  issueUrl?: string;
  flowPath?: string;
} {
  const record = requireObject(value);
  return {
    title: typeof record.title === "string" ? record.title : "",
    spec: typeof record.spec === "string" ? record.spec : "",
    techDesign: typeof record.techDesign === "string" ? record.techDesign : "",
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    issueUrl: typeof record.issueUrl === "string" ? record.issueUrl : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
  };
}

function draftSpecInputFromJson(value: unknown): {
  sourceType: DraftSpecSourceType;
  prompt?: string;
  text?: string;
  issue?: string;
  title?: string;
  repoId?: string;
  flowPath?: string;
} {
  const record = requireObject(value);
  const sourceType = typeof record.sourceType === "string" ? record.sourceType : "";
  if (
    sourceType !== "prompt" &&
    sourceType !== "text" &&
    sourceType !== "github-issue"
  ) {
    throw new WebInputError("sourceType must be prompt, text, or github-issue");
  }
  return {
    sourceType,
    prompt: typeof record.prompt === "string" ? record.prompt : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
    issue: typeof record.issue === "string" ? record.issue : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
  };
}

function repositoryInputFromJson(value: unknown): AddWebRepositoryInput {
  const record = requireObject(value);
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    githubUrl: typeof record.githubUrl === "string" ? record.githubUrl : undefined,
    defaultBranch:
      typeof record.defaultBranch === "string" ? record.defaultBranch : undefined,
  };
}

function withRepository<T extends { repoId?: string; repoName?: string; repoPath?: string }>(
  value: T,
  repository: WebRepository,
): T & { repoId: string; repoName: string; repoPath: string } {
  return {
    ...value,
    repoId: value.repoId ?? repository.id,
    repoName: value.repoName ?? repository.name,
    repoPath: value.repoPath ?? repository.path,
  };
}

function apiTaskId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiTaskRunId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/runs$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiTaskDraftTechDesignId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/draft-tech-design$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiTaskApproveSpecId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/approve-spec$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiTaskApproveTechDesignId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/approve-tech-design$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiRunId(pathname: string): string | undefined {
  const match = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiWorkItemId(pathname: string): string | undefined {
  const match = /^\/api\/work-items\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiWorkItemRunId(pathname: string): string | undefined {
  const match = /^\/api\/work-items\/([^/]+)\/runs$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function apiFlowId(pathname: string): string | undefined {
  const match = /^\/api\/flows\/(.+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function flowDocumentMetadata(document: string): {
  name: string;
  workItemType?: string;
} {
  const parsed = JSON.parse(document) as {
    metadata?: { name?: unknown; workItemType?: unknown };
  };
  return {
    name:
      typeof parsed.metadata?.name === "string" ? parsed.metadata.name : "flow",
    ...(typeof parsed.metadata?.workItemType === "string"
      ? { workItemType: parsed.metadata.workItemType }
      : {}),
  };
}

function htmlRunId(pathname: string): string | undefined {
  const match = /^\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function htmlTaskId(pathname: string): string | undefined {
  const match = /^\/tasks\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function getProviderStore(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
): ProviderConnectionStore {
  return (
    input.providerStore ??
    resolveProviderStore(
      join(repoPath, ".nitely"),
      input.providerEnv ?? process.env,
      input.providerCommandStatus,
    )
  );
}

function providerStoreForUser(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
  user: WebUserContext,
): ProviderConnectionStore {
  if (user.authMode === "local") {
    return getProviderStore(input, repoPath);
  }
  return new FileProviderConnectionStore({
    path: join(repoPath, ".nitely", "users", user.id, "connections.json"),
    env: input.providerEnv ?? process.env,
    commandStatus: input.providerCommandStatus,
  });
}

async function webRunRedactionSecrets(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  providerRepoPath: string,
  policyRepoPath: string,
  user: WebUserContext,
): Promise<string[]> {
  const providerStore = providerStoreForUser(input, providerRepoPath, user);
  const [policy, providerEnv] = await Promise.all([
    loadContextPolicy(policyRepoPath),
    providerStore.resolveEnv(),
  ]);
  return collectContextRedactionSecrets({
    policy,
    processEnv: process.env,
    providerEnv,
  });
}

async function runStoredWorkItem(
  repository: WebRepository,
  workItemId: string,
  user: WebUserContext,
  providerStore: ProviderConnectionStore,
  runner: NonNullable<StartWebServerInput["runFlow"]>,
  notFoundMessage: string,
  taskScope?: RunFlowInput["taskScope"],
): Promise<RunFlowResult> {
  const repoPath = repository.path;
  const workItem = await getWorkItem(repoPath, workItemId);
  requireRecordAccess(workItem, user, notFoundMessage);
  requireWriteAccessToRecord(user, workItem);
  if (workItem.status === "draft") {
    throw new WebInputError("draft work item must be approved before starting a run");
  }
  assertPlanningReadyForExecution(workItem.planning);
  if (workItem.status === "running") {
    throw new WebInputError("work item is already running");
  }
  const externalInputs = Object.keys(workItem.inputs);
  let runnerFlowPath: string;
  let runnerFlowDocument: string | undefined;
  let flow;
  if (workItem.flowId) {
    const flowStore = openFlowStore(repoPath);
    try {
      runnerFlowDocument = flowStore.getFlow(workItem.flowId).document;
    } finally {
      flowStore.close();
    }
    runnerFlowPath = workItem.flowId;
    flow = parseFlowDocument(runnerFlowDocument, { externalInputs }).flow;
  } else {
    runnerFlowPath = resolveTaskFlowPath(repoPath, {
      flowPath: workItem.flowPath,
    } as Parameters<typeof resolveTaskFlowPath>[1]);
    flow = (await loadFlow(runnerFlowPath, { externalInputs })).flow;
  }
  await assertWorkItemTypeAllowed({
    repoPath,
    workItemType: workItem.workItemType || flowWorkItemType(flow),
    flow,
  });
  const running = await updateWorkItem(repoPath, workItemId, {
    status: "running",
  });
  try {
    const result = await runner({
      flowPath: runnerFlowPath,
      ...(runnerFlowDocument !== undefined
        ? { flowDocument: runnerFlowDocument }
        : {}),
      repoPath,
      repoId: workItem.repoId ?? repository.id,
      repoName: repository.name,
      inputs: running.inputs,
      workItemId: running.id,
      workItemType: running.workItemType,
      ...(running.planning ? { planningApproval: running.planning } : {}),
      ...(taskScope ? { taskScope } : {}),
      ...(user.authMode === "required"
        ? { ownerId: running.ownerId ?? user.id }
        : {}),
      ...(running.organizationId ? { organizationId: running.organizationId } : {}),
    }, {
      providerStore,
    });
    await updateWorkItem(repoPath, workItemId, {
      status: "completed",
      latestRunId: result.runId,
      changeRequestUrl: result.changeRequestUrl,
    });
    return result;
  } catch (error) {
    await updateWorkItem(repoPath, workItemId, { status: "failed" });
    throw error;
  }
}

async function listAllWorkItemViews(
  repositories: WebRepository[],
  user: WebUserContext,
) {
  const grouped = await Promise.all(
    repositories.map(async (repository) =>
      (await listWorkItemViews(repository.path, user)).map((view) =>
        withRepository(view, repository),
      ),
    ),
  );
  return grouped.flat().sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

async function getScopedWorkItemView(
  repositories: WebRepository[],
  id: string,
  user: WebUserContext,
) {
  for (const repository of repositories) {
    try {
      const detail = await getWorkItemView(repository.path, id, user);
      requireRecordAccess(detail, user, "task not found");
      return { repository, detail: withRepository(detail, repository) };
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError("task not found");
}

async function getScopedTask(
  repositories: WebRepository[],
  id: string,
  user: WebUserContext,
) {
  for (const repository of repositories) {
    try {
      const task = await getTask(repository.path, id);
      requireRecordAccess(task, user, "task not found");
      return { repository, task };
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError("task not found");
}

function createAcceptedRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function appendRunEvent(
  repoPath: string,
  event: Parameters<EventStore["append"]>[0],
): void {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    store.append(event);
  } finally {
    store.close();
  }
}

function currentProjectedRunStatus(
  repoPath: string,
  runId: string,
): ReturnType<typeof projectRun>["status"] | undefined {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(runId);
    return events.length > 0 ? projectRun(events).status : undefined;
  } finally {
    store.close();
  }
}

function isTerminalProjectedRunStatus(
  status: ReturnType<typeof projectRun>["status"] | undefined,
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

function appendAcceptedRunCreated(input: {
  repoPath: string;
  runId: string;
  branchName: string;
  flowPath: string;
  repoId?: string;
  repoName?: string;
  inputs: RunFlowInput["inputs"];
  workItemId: string;
  workItemType?: string;
  ownerId?: string;
  organizationId?: string;
  planningApproval?: RunFlowInput["planningApproval"];
}): void {
  appendRunEvent(input.repoPath, {
    runId: input.runId,
    type: "run.created",
    payload: {
      flowPath: input.flowPath,
      repoPath: input.repoPath,
      repoId: input.repoId,
      repoName: input.repoName,
      inputs: input.inputs,
      branchName: input.branchName,
      workItemId: input.workItemId,
      workItemType: input.workItemType,
      ownerId: input.ownerId,
      organizationId: input.organizationId,
      planningApproval: input.planningApproval,
    },
  });
}

function ensureRunCompletedEvent(
  repoPath: string,
  result: RunFlowResult,
  runInput?: RunFlowInput,
): void {
  const status = currentProjectedRunStatus(repoPath, result.runId);
  if (isTerminalProjectedRunStatus(status)) {
    return;
  }
  if (!status && runInput?.workItemId) {
    appendAcceptedRunCreated({
      repoPath,
      runId: result.runId,
      branchName: result.branchName,
      flowPath: runInput.flowPath,
      repoId: runInput.repoId,
      repoName: runInput.repoName,
      inputs: runInput.inputs,
      workItemId: runInput.workItemId,
      workItemType: runInput.workItemType,
      ...(runInput.ownerId ? { ownerId: runInput.ownerId } : {}),
      ...(runInput.organizationId ? { organizationId: runInput.organizationId } : {}),
      ...(runInput.planningApproval
        ? { planningApproval: runInput.planningApproval }
        : {}),
    });
  }
  appendRunEvent(repoPath, {
    runId: result.runId,
    type: "run.completed",
    payload: {
      changeRequestUrl: result.changeRequestUrl,
      changeRequest: result.changeRequest,
    },
  });
}

function ensureRunFailedEvent(repoPath: string, runId: string, error: unknown): void {
  if (isTerminalProjectedRunStatus(currentProjectedRunStatus(repoPath, runId))) {
    return;
  }
  appendRunEvent(repoPath, {
    runId,
    type: "run.failed",
    payload: { error: error instanceof Error ? error.message : String(error) },
  });
}

async function runStoredWorkItemAcrossRepositories(
  repositories: WebRepository[],
  workItemId: string,
  user: WebUserContext,
  providerStore: ProviderConnectionStore,
  runner: NonNullable<StartWebServerInput["runFlow"]>,
  notFoundMessage: string,
  taskScope?: RunFlowInput["taskScope"],
): Promise<RunFlowResult> {
  for (const repository of repositories) {
    try {
      return await runStoredWorkItem(
        repository,
        workItemId,
        user,
        providerStore,
        runner,
        notFoundMessage,
        taskScope,
      );
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError(notFoundMessage);
}

async function listAllRuns(repositories: WebRepository[], user: WebUserContext) {
  const grouped = await Promise.all(
    repositories.map(async (repository) =>
      (await listRuns(repository.path))
        .filter((run) => recordVisibleToUser(run, user))
        .map((run) => withRepository(run, repository)),
    ),
  );
  return grouped.flat().sort((left, right) =>
    right.runId.localeCompare(left.runId),
  );
}

async function getScopedRunDetail(
  repositories: WebRepository[],
  homeRepoPath: string,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  runId: string,
  user: WebUserContext,
) {
  for (const repository of repositories) {
    try {
      const run = await getRunDetail(repository.path, runId, {
        redactionSecrets: await webRunRedactionSecrets(
          input,
          homeRepoPath,
          repository.path,
          user,
        ),
      });
      const decorated = withRepository(run, repository);
      requireRecordAccess(decorated, user, "run not found");
      return {
        ...decorated,
        parentRun:
          decorated.parentRun && recordVisibleToUser(decorated.parentRun, user)
            ? withRepository(decorated.parentRun, repository)
            : undefined,
        childRuns: decorated.childRuns
          .filter((child) => recordVisibleToUser(child, user))
          .map((child) => withRepository(child, repository)),
      };
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError("run not found");
}

function requireWritableProviderId(rawId: string): ProviderId {
  const descriptor = PROVIDER_DESCRIPTORS.find((provider) => provider.id === rawId);
  if (!descriptor) {
    throw new WebNotFoundError("provider not found");
  }
  if (!descriptor.writable) {
    throw new WebInputError("provider does not support Web Console connection writes");
  }
  return descriptor.id;
}

function requireSetConnection(
  providerStore: ProviderConnectionStore,
): NonNullable<ProviderConnectionStore["setConnection"]> {
  if (typeof providerStore.setConnection !== "function") {
    throw new WebInputError("provider connection store is read-only");
  }
  return providerStore.setConnection.bind(providerStore);
}

function requireClearConnection(
  providerStore: ProviderConnectionStore,
): NonNullable<ProviderConnectionStore["clearConnection"]> {
  if (typeof providerStore.clearConnection !== "function") {
    throw new WebInputError("provider connection store is read-only");
  }
  return providerStore.clearConnection.bind(providerStore);
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const homeRepoPath = resolve(input.repoPath);
  const repositories = await loadWebRepositories(input.repoPath, input.repositories);
  const runner = input.runFlow ?? defaultRunFlow;
  const authMode = authModeForInput(input);

  if (request.method === "GET" && url.pathname === "/api/session") {
    const user = await resolveUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      authRequired: authMode === "required",
      user: user
        ? {
            id: user.id,
            email: user.email,
            role: user.role,
            ...(user.memberships ? { memberships: user.memberships } : {}),
            ...(user.currentOrganizationId
              ? { currentOrganizationId: user.currentOrganizationId }
              : {}),
            ...(user.currentOrganizationRole
              ? { currentOrganizationRole: user.currentOrganizationRole }
              : {}),
          }
        : null,
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/session") {
    if (authMode === "local") {
      sendJson(response, 200, {
        authRequired: false,
        user: { id: "local", email: "local", role: "admin" },
      });
      return true;
    }
    if (!(await hasAnyUsers(homeRepoPath))) {
      throw new WebSetupRequiredError();
    }
    const body = requireObject(await readRequestJson(request));
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = await verifyUserPassword(homeRepoPath, email, password);
    if (!user) {
      throw new WebUnauthorizedError("invalid email or password");
    }
    const session = await createSession(homeRepoPath, user.id);
    const sessionUser = await getPublicUser(homeRepoPath, user.id);
    sendJsonWithHeaders(
      response,
      200,
      { authRequired: true, user: sessionUser },
      { "set-cookie": sessionCookie(session.id) },
    );
    return true;
  }
  if (request.method === "DELETE" && url.pathname === "/api/session") {
    const sessionId = parseCookies(request.headers.cookie).nitely_session;
    if (sessionId) {
      await deleteSession(homeRepoPath, sessionId).catch(() => {});
    }
    sendJsonWithHeaders(response, 200, { ok: true }, {
      "set-cookie": clearSessionCookie(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/repositories") {
    await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { repositories });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/repositories") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user);
    const repository = await addStoredWebRepository(
      homeRepoPath,
      input.repositories,
      repositoryInputFromJson(await readRequestJson(request)),
      input.cloneRepository,
    );
    sendJson(response, 201, {
      repository,
      repositories: await loadWebRepositories(input.repoPath, input.repositories),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const [tasks, runs] = await Promise.all([
      listAllWorkItemViews(repositories, user),
      listAllRuns(repositories, user),
    ]);
    sendJson(response, 200, {
      dashboard: buildManagerDashboard({ tasks, runs, repositories }),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { tasks: await listAllWorkItemViews(repositories, user) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required" ? currentWritableOrganizationId(user) : undefined;
    const taskInput = taskInputFromJson(await readRequestJson(request));
    const repository = repositoryById(repositories, taskInput.repoId);
    const task = await createTask(
      repository.path,
      taskInput,
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(organizationId ? { organizationId } : {}),
        repoId: repository.id,
      },
    );
    sendJson(response, 201, { task: withRepository(task, repository) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/draft-specs") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const draftInput = draftSpecInputFromJson(await readRequestJson(request));
    const repository = repositoryById(repositories, draftInput.repoId);
    let source: DraftSpecSource;
    if (draftInput.sourceType === "github-issue") {
      try {
        const reference = parseGitHubIssueReference(draftInput.issue ?? "");
        const issue = await (input.githubIssueFetcher ?? defaultGitHubIssueFetcher)(
          reference,
        );
        source = {
          type: "github-issue" as const,
          title: issue.title,
          body: issue.body,
          uri: issue.url,
        };
      } catch (error) {
        throw new WebInputError((error as Error).message);
      }
    } else if (draftInput.sourceType === "prompt") {
      source = {
        type: "prompt" as const,
        body: draftInput.prompt ?? "",
        ...(draftInput.title ? { title: draftInput.title } : {}),
      };
    } else {
      source = {
        type: "text" as const,
        body: draftInput.text ?? "",
        ...(draftInput.title ? { title: draftInput.title } : {}),
      };
    }
    let draft;
    try {
      draft = generateDraftSpec(source);
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    const task = await createTask(
      repository.path,
      {
        title: draft.title,
        spec: draft.markdown,
        techDesign:
          "# Technical Design\n\nStatus: draft\n\nA technical design must be created and approved before implementation.\n",
        repoId: repository.id,
        ...(draft.source.uri ? { issueUrl: draft.source.uri } : {}),
        ...(draftInput.flowPath ? { flowPath: draftInput.flowPath } : {}),
      },
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(user.authMode === "required"
          ? { organizationId: currentWritableOrganizationId(user) }
          : {}),
        repoId: repository.id,
        initialStatus: "draft",
        specStatus: "draft",
        source: draft.source,
      },
    );
    sendJson(response, 201, {
      task: withRepository(task, repository),
      spec: draft.markdown,
    });
    return true;
  }

  const approveSpecTaskId = apiTaskApproveSpecId(url.pathname);
  if (request.method === "POST" && approveSpecTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      approveSpecTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task);
    const updated = await updateTaskSpecApproval(
      repository.path,
      task.id,
      "approved",
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const approveTechDesignTaskId = apiTaskApproveTechDesignId(url.pathname);
  if (request.method === "POST" && approveTechDesignTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      approveTechDesignTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task);
    const specApproved =
      task.specStatus === "approved" ||
      (task.specStatus === undefined && task.status !== "draft");
    if (!specApproved) {
      throw new WebInputError(
        "approved spec is required before approving a technical design",
      );
    }
    if (task.techDesignStatus !== "draft") {
      throw new WebInputError(
        "draft technical design is required before approval",
      );
    }
    const updated = await updateTaskTechnicalDesignApproval(
      repository.path,
      task.id,
      "approved",
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const taskId = apiTaskId(url.pathname);
  if (request.method === "GET" && taskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { detail } = await getScopedWorkItemView(repositories, taskId, user);
    sendJson(response, 200, {
      task: detail,
      spec: detail.spec ?? "",
      techDesign: detail.techDesign ?? "",
      runs: detail.runs,
      inputContents: detail.inputContents,
      artifacts: detail.artifacts,
      artifactsByType: detail.artifactsByType,
      readOnly: detail.readOnly ?? false,
    });
    return true;
  }

  const draftTechDesignTaskId = apiTaskDraftTechDesignId(url.pathname);
  if (request.method === "POST" && draftTechDesignTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      draftTechDesignTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task);
    if (
      task.specStatus === "draft" ||
      (task.status === "draft" && task.specStatus !== "approved")
    ) {
      throw new WebInputError(
        "approved spec is required before drafting a technical design",
      );
    }
    const detail = await getTaskDetail(repository.path, task.id);
    let draft;
    try {
      draft = generateDraftTechnicalPlan({
        specMarkdown: detail.spec,
        context: await collectRepositoryPlanContext(repository.path),
      });
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    const updated = await updateTaskTechnicalDesign(
      repository.path,
      task.id,
      draft.markdown,
      "draft",
      { openQuestions: draft.openQuestions },
    );
    sendJson(response, 200, {
      task: withRepository(updated, repository),
      techDesign: draft.markdown,
      openQuestions: draft.openQuestions,
    });
    return true;
  }

  const runTaskId = apiTaskRunId(url.pathname);
  if (request.method === "POST" && runTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const taskScope = taskScopeFromJson(body.taskScope);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    let currentTask: Awaited<ReturnType<typeof getTask>>;
    let repository: WebRepository;
    try {
      ({ repository, task: currentTask } = await getScopedTask(repositories, runTaskId, user));
    } catch (error) {
      if (!(error instanceof WebNotFoundError)) {
        throw error;
      }
      const result = await runStoredWorkItemAcrossRepositories(
        repositories,
        runTaskId,
        user,
        providerStore,
        runner,
        "task not found",
        taskScope,
      );
      sendJson(response, 200, { run: result });
      return true;
    }
    requireRecordAccess(currentTask, user, "task not found");
    requireWriteAccessToRecord(user, currentTask);
    if (
      currentTask.status === "draft" ||
      currentTask.specStatus === "draft" ||
      currentTask.techDesignStatus === "draft"
    ) {
      if (currentTask.specStatus === "draft") {
        throw new WebInputError("draft spec must be approved before starting a run");
      }
      if (
        currentTask.specStatus === "approved" &&
        currentTask.techDesignStatus === undefined
      ) {
        throw new WebInputError(
          "draft technical design is required before starting a run",
        );
      }
      throw new WebInputError(
        "draft technical design must be approved before starting a run",
      );
    }
    if (currentTask.status === "running") {
      throw new WebInputError("task is already running");
    }
    const task = await updateTaskRunState(repository.path, runTaskId, {
      status: "running",
    });
    const workItem = taskRecordToWorkItem(task);
    const runnerInput: RunFlowInput = {
        flowPath: resolveTaskFlowPath(repository.path, task),
        repoPath: repository.path,
        repoId: task.repoId ?? repository.id,
        repoName: repository.name,
        inputs: workItem.inputs,
        workItemId: workItem.id,
        workItemType: workItem.workItemType,
        ...(taskScope ? { taskScope } : {}),
        ...(user.authMode === "required" ? { ownerId: task.ownerId ?? user.id } : {}),
        ...(task.organizationId ? { organizationId: task.organizationId } : {}),
    };
    let acceptedRunId: string | undefined;
    let acceptedRunRejected = false;
    let resolveAcceptedRun!: (run: AcceptedRunMetadata) => void;
    let rejectAcceptedRun!: (error: unknown) => void;
    const acceptedRunPromise = new Promise<AcceptedRunMetadata>((resolve, reject) => {
      resolveAcceptedRun = resolve;
      rejectAcceptedRun = reject;
    });
    const createRunId = (): string => {
      if (acceptedRunId) return acceptedRunId;
      acceptedRunId = createAcceptedRunId();
      const branchName = `nitely/${acceptedRunId}`;
      appendAcceptedRunCreated({
        repoPath: repository.path,
        runId: acceptedRunId,
        branchName,
        flowPath: runnerInput.flowPath,
        repoId: runnerInput.repoId,
        repoName: runnerInput.repoName,
        inputs: runnerInput.inputs,
        workItemId: workItem.id,
        workItemType: workItem.workItemType,
        ...(runnerInput.ownerId ? { ownerId: runnerInput.ownerId } : {}),
        ...(runnerInput.organizationId
          ? { organizationId: runnerInput.organizationId }
          : {}),
      });
      void updateTaskRunState(repository.path, runTaskId, {
        status: "running",
        latestRunId: acceptedRunId,
      }).then(
        () =>
          resolveAcceptedRun({
            runId: acceptedRunId as string,
            status: "running",
            taskId: runTaskId,
            repoId: task.repoId ?? repository.id,
            branchName,
          }),
        (error) => {
          acceptedRunRejected = true;
          rejectAcceptedRun(error);
        },
      );
      return acceptedRunId;
    };
    const runnerPromise = (async () => {
      try {
        const result = await runner(runnerInput, {
          providerStore,
          createRunId,
        });
        await updateTaskRunState(repository.path, runTaskId, {
          status: "completed",
          latestRunId: result.runId,
          changeRequestUrl: result.changeRequestUrl,
        });
        ensureRunCompletedEvent(repository.path, result, runnerInput);
        return result;
      } catch (error) {
        await updateTaskRunState(repository.path, runTaskId, { status: "failed" });
        if (acceptedRunId) {
          ensureRunFailedEvent(repository.path, acceptedRunId, error);
        }
        if (!acceptedRunId && !acceptedRunRejected) {
          rejectAcceptedRun(error);
        }
        throw error;
      }
    })();
    void runnerPromise.catch(() => {});
    const outcome = await Promise.race([
      acceptedRunPromise.then((run) => ({ kind: "accepted" as const, run })),
      runnerPromise.then((run) => ({ kind: "completed" as const, run })),
    ]);
    sendJson(response, 200, { run: outcome.run });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/flows") {
    await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { flows: await listFlowViews(homeRepoPath) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/flows/templates") {
    await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { templates: flowTemplates });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/flows/validate") {
    await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const document = typeof body.document === "string" ? body.document : "";
    sendJson(response, 200, {
      report: await validateFlowDocument(homeRepoPath, document),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/flows") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const document = typeof body.document === "string" ? body.document : "";
    const report = await validateFlowDocument(homeRepoPath, document);
    if (!report.valid) {
      sendJson(response, 422, { report });
      return true;
    }
    const meta = flowDocumentMetadata(document);
    const store = openFlowStore(homeRepoPath);
    try {
      const record = store.createFlow({
        name: meta.name,
        document,
        ...(meta.workItemType ? { workItemType: meta.workItemType } : {}),
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
      });
      sendJson(response, 201, { flow: record });
    } finally {
      store.close();
    }
    return true;
  }

  const flowId = apiFlowId(url.pathname);
  if (flowId) {
    if (request.method === "GET") {
      await requireUserContext(request, input, homeRepoPath);
      sendJson(response, 200, { flow: await getFlowView(homeRepoPath, flowId) });
      return true;
    }
    if (request.method === "PUT") {
      await requireUserContext(request, input, homeRepoPath);
      if (flowId.startsWith("flows/")) {
        throw new WebInputError("built-in flows are read-only");
      }
      const body = requireObject(await readRequestJson(request));
      const document = typeof body.document === "string" ? body.document : "";
      const report = await validateFlowDocument(homeRepoPath, document);
      if (!report.valid) {
        sendJson(response, 422, { report });
        return true;
      }
      const meta = flowDocumentMetadata(document);
      const store = openFlowStore(homeRepoPath);
      try {
        const record = store.updateFlow(flowId, {
          name: meta.name,
          document,
          ...(meta.workItemType ? { workItemType: meta.workItemType } : {}),
        });
        sendJson(response, 200, { flow: record });
      } finally {
        store.close();
      }
      return true;
    }
    if (request.method === "DELETE") {
      await requireUserContext(request, input, homeRepoPath);
      if (flowId.startsWith("flows/")) {
        throw new WebInputError("built-in flows are read-only");
      }
      const store = openFlowStore(homeRepoPath);
      try {
        store.deleteFlow(flowId);
      } finally {
        store.close();
      }
      sendJson(response, 200, { deleted: flowId });
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/work-items") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      workItems: await listAllWorkItemViews(repositories, user),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/work-items") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required" ? currentWritableOrganizationId(user) : undefined;
    const body = requireObject(await readRequestJson(request));
    const repository = repositoryById(
      repositories,
      typeof body.repoId === "string" ? body.repoId : undefined,
    );
    const workItem = await createFlowWorkItem(
      repository.path,
      {
        title: typeof body.title === "string" ? body.title : "",
        repoId: repository.id,
        ...(typeof body.flowId === "string" && body.flowId
          ? { flowId: body.flowId }
          : { flowPath: typeof body.flowPath === "string" ? body.flowPath : "" }),
        inputs: isResourceReferenceMap(body.inputs) ? body.inputs : {},
        ...(typeof body.issueUrl === "string" ? { issueUrl: body.issueUrl } : {}),
        ...(typeof body.workItemType === "string"
          ? { workItemType: body.workItemType }
          : {}),
      },
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(organizationId ? { organizationId } : {}),
        repoId: repository.id,
      },
    );
    sendJson(response, 201, { workItem: withRepository(workItem, repository) });
    return true;
  }

  const workItemRunId = apiWorkItemRunId(url.pathname);
  if (request.method === "POST" && workItemRunId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const taskScope = taskScopeFromJson(body.taskScope);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    const result = await runStoredWorkItemAcrossRepositories(
      repositories,
      workItemRunId,
      user,
      providerStore,
      runner,
      "work item not found",
      taskScope,
    );
    sendJson(response, 200, { run: result });
    return true;
  }

  const workItemId = apiWorkItemId(url.pathname);
  if (request.method === "GET" && workItemId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { detail } = await getScopedWorkItemView(repositories, workItemId, user);
    sendJson(response, 200, { workItem: detail });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      runs: await listAllRuns(repositories, user),
    });
    return true;
  }
  const runId = apiRunId(url.pathname);
  if (request.method === "GET" && runId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const run = await getScopedRunDetail(
      repositories,
      homeRepoPath,
      input,
      runId,
      user,
    );
    sendJson(response, 200, {
      run,
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/providers") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    sendJson(response, 200, {
      providers: await providerStore.listStatuses(),
    });
    return true;
  }

  // Provider connection set/clear
  const providerConnMatch =
    /^\/api\/providers\/([^/]+)\/connection$/.exec(url.pathname);
  if (providerConnMatch) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    const providerId = requireWritableProviderId(providerConnMatch[1]);

    if (request.method === "POST") {
      const setConnection = requireSetConnection(providerStore);
      const body = requireObject(await readRequestJson(request));
      const value =
        typeof body.value === "string" ? body.value.trim() : "";
      if (!value) {
        throw new WebInputError("value is required");
      }
      await setConnection({ providerId, value });
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (request.method === "DELETE") {
      const clearConnection = requireClearConnection(providerStore);
      await clearConnection(providerId);
      sendJson(response, 200, { ok: true });
      return true;
    }
  }

  if (url.pathname.startsWith("/api/")) {
    throw new WebNotFoundError("endpoint not found");
  }
  return false;
}

async function serveStaticFile(
  response: ServerResponse,
  relativePath: string,
): Promise<boolean> {
  const safe = relativePath.replace(/\.\.\//g, "").replace(/\.\.\\/g, "");
  const filePath = join(staticDir, safe);
  try {
    const content = await readFile(filePath, "utf8");
    const contentType =
      safe.endsWith(".js") ? "application/javascript" :
      safe.endsWith(".css") ? "text/css" :
      safe.endsWith(".html") ? "text/html" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function handleHtmlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: StartWebServerInput,
): Promise<boolean> {
  if (request.method !== "GET") {
    return false;
  }
  const url = new URL(request.url ?? "/", "http://localhost");

  // Serve static assets
  if (url.pathname === "/support.js") {
    return serveStaticFile(response, "support.js");
  }

  // SPA: serve the Design Component for all page routes
  if (
    url.pathname === "/" ||
    url.pathname === "/dashboard" ||
    url.pathname === "/tasks" ||
    url.pathname === "/work-items" ||
    url.pathname === "/flows" ||
    url.pathname === "/runs" ||
    url.pathname === "/providers"
  ) {
    return serveStaticFile(response, "console.dc.html");
  }

  // SPA: task/run/flow detail routes serve the DC (client-side routing)
  if (
    htmlTaskId(url.pathname) ||
    htmlRunId(url.pathname) ||
    url.pathname.startsWith("/flows/")
  ) {
    return serveStaticFile(response, "console.dc.html");
  }

  return false;
}

export async function startWebServer(
  input: StartWebServerInput,
): Promise<WebServer> {
  const authInput = {
    ...input,
    host: input.host,
    port: input.port,
  };
  if (authModeForInput(authInput) === "required") {
    await bootstrapInitialAdmin(resolve(input.repoPath), input.authEnv ?? process.env);
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (await handleApiRequest(request, response, input)) {
          return;
        }
        if (await handleHtmlRequest(request, response, input)) {
          return;
        }
        sendHtml(response, 404, "Not found");
      } catch (error) {
        sendError(response, error);
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : input.port;
  return {
    url: `http://${input.host}:${port}`,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    },
  };
}
