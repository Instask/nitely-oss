import {
  normalizeRemoteServerUrl,
  remoteAuthorizationHeaders,
  resolveRemoteTarget,
} from "../cli-current-instance.js";
import { WEB_RUN_STATUSES, type WebRunStatus } from "../web/runs.js";
import type { CliIo, FetchFunction } from "./io.js";

export function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export async function remoteErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return response.statusText || "request failed";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return response.statusText || "request failed";
  }
  try {
    const payload = readJsonObject(JSON.parse(trimmed));
    const error = readJsonObject(payload?.error);
    const message = error?.message ?? payload?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  } catch {
    // Fall through to the plain response body.
  }
  return trimmed;
}

export function redactSecret(message: string, ...secrets: Array<string | undefined>): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function remoteRequestHeaders(
  token: string | undefined,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  const merged = {
    ...(headers ?? {}),
    ...remoteAuthorizationHeaders(token),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const MISSING_REMOTE_INSTANCE_MESSAGE =
  "Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect";

export function requireRemoteServerUrl(serverUrl: string | undefined): string {
  if (!serverUrl) {
    throw new Error(MISSING_REMOTE_INSTANCE_MESSAGE);
  }
  return serverUrl;
}

export async function fetchRemoteJson(
  url: string,
  fetchImpl: FetchFunction,
  label: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(
      `${label} failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} failed: invalid JSON response`);
  }
}

export const REMOTE_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
] as const;

export type RemoteRunStatus = (typeof REMOTE_RUN_STATUSES)[number];

export function remoteWatchStatus(value: unknown): RemoteRunStatus | undefined {
  return typeof value === "string" &&
    (REMOTE_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as RemoteRunStatus)
    : undefined;
}

export async function listRemoteCollection(
  input: { serverUrl: string; apiToken?: string },
  fetchImpl: FetchFunction,
  route: string,
  key: string,
  label: string,
): Promise<unknown[]> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const headers = remoteRequestHeaders(input.apiToken);
  const response = await fetchImpl(`${serverUrl}${route}`, headers ? { headers } : {});
  if (!response.ok) {
    throw new Error(
      `${label} failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} failed: invalid JSON response`);
  }
  const items = readJsonObject(payload)?.[key];
  if (!Array.isArray(items)) {
    throw new Error(`${label} failed: invalid response: missing ${key}`);
  }
  return items;
}

export function listRemoteTasks(
  input: { serverUrl: string; apiToken?: string },
  fetchImpl: FetchFunction,
): Promise<unknown[]> {
  return listRemoteCollection(input, fetchImpl, "/api/tasks", "tasks", "remote task list");
}

export function listRemoteRuns(
  input: { serverUrl: string; apiToken?: string },
  fetchImpl: FetchFunction,
): Promise<unknown[]> {
  return listRemoteCollection(input, fetchImpl, "/api/runs", "runs", "remote run list");
}

export function parseRemoteRunStatusOption(value: string): WebRunStatus {
  if (!(WEB_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(
      `invalid --status value: ${value}. Supported statuses: ${WEB_RUN_STATUSES.join(", ")}`,
    );
  }
  return value as WebRunStatus;
}

export function printRemoteTaskList(io: CliIo, tasks: unknown[]): void {
  const rows = tasks.flatMap((entry) => {
    const record = readJsonObject(entry);
    if (typeof record?.id !== "string" || !record.id) return [];
    const status =
      typeof record.displayStatus === "string" && record.displayStatus
        ? record.displayStatus
        : typeof record.status === "string" && record.status
          ? record.status
          : "-";
    const title = typeof record.title === "string" && record.title ? record.title : record.id;
    return [`${record.id}  ${status}  ${title}`];
  });
  if (rows.length === 0) {
    io.stdout("No tasks");
    return;
  }
  for (const row of rows) io.stdout(row);
}

export function printRemoteRunList(
  io: CliIo,
  runs: unknown[],
  statusFilter?: WebRunStatus,
): void {
  const rows = runs.flatMap((entry) => {
    const record = readJsonObject(entry);
    if (typeof record?.runId !== "string" || !record.runId) return [];
    const status = typeof record.status === "string" && record.status ? record.status : "-";
    if (statusFilter && status !== statusFilter) return [];
    const taskId = typeof record.taskId === "string" && record.taskId ? record.taskId : "-";
    const stage =
      typeof record.currentStage === "string" && record.currentStage
        ? record.currentStage
        : "-";
    return [`${record.runId}  ${status}  ${taskId}  ${stage}`];
  });
  if (rows.length === 0) {
    io.stdout("No runs");
    return;
  }
  for (const row of rows) io.stdout(row);
}

export interface RemoteListCommandInput {
  argv: string[];
  startIndex: number;
  usage: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchFunction;
  io: CliIo;
  allowStatusFilter: boolean;
  fetchItems: (
    input: { serverUrl: string; apiToken?: string },
    fetchImpl: FetchFunction,
  ) => Promise<unknown[]>;
  jsonKey: string;
  print: (io: CliIo, items: unknown[], statusFilter?: WebRunStatus) => void;
}

export async function runRemoteListCommand(input: RemoteListCommandInput): Promise<number> {
  const { argv, io, env } = input;
  let serverFlag = "";
  let asJson = false;
  let statusFilter: WebRunStatus | undefined;
  let resolvedApiToken: string | undefined;
  try {
    for (let index = input.startIndex; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--server") {
        serverFlag = argv[++index] ?? "";
        if (!serverFlag) throw new Error("Missing value for --server");
        continue;
      }
      if (arg === "--json") {
        asJson = true;
        continue;
      }
      if (input.allowStatusFilter && arg === "--status") {
        const value = argv[++index] ?? "";
        if (!value) throw new Error("Missing value for --status");
        statusFilter = parseRemoteRunStatusOption(value);
        continue;
      }
      io.stderr(`Unknown option: ${arg}. ${input.usage}`);
      return 1;
    }
    const remote = await resolveRemoteTarget({
      env,
      ...(serverFlag ? { flag: serverFlag } : {}),
    });
    resolvedApiToken = remote.apiToken;
    const serverUrl = requireRemoteServerUrl(remote.serverUrl);
    const items = await input.fetchItems(
      {
        serverUrl,
        ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
      },
      input.fetchImpl,
    );
    if (asJson) {
      io.stdout(JSON.stringify({ [input.jsonKey]: items }));
    } else {
      input.print(io, items, statusFilter);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
    return 1;
  }
}

export async function postRemoteTaskAction(
  input: { serverUrl: string; apiToken?: string; taskId: string },
  fetchImpl: FetchFunction,
  route: string,
  label: string,
): Promise<unknown> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const response = await fetchImpl(
    `${serverUrl}/api/tasks/${encodeURIComponent(input.taskId)}/${route}`,
    {
      method: "POST",
      headers: remoteRequestHeaders(input.apiToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `${label} failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} failed: invalid JSON response`);
  }
}

export function printRemoteTaskApproval(
  io: CliIo,
  payload: unknown,
  taskId: string,
  statusKey: "specStatus" | "techDesignStatus",
  artifactLabel: string,
): void {
  const task = readJsonObject(readJsonObject(payload)?.task);
  const id = typeof task?.id === "string" && task.id ? task.id : taskId;
  const status = task?.[statusKey];
  if (typeof status !== "string" || !status) {
    const command =
      statusKey === "techDesignStatus"
        ? "remote task approve-tech-design"
        : "remote task approve-spec";
    throw new Error(`${command} failed: invalid response: missing task.${statusKey}`);
  }
  io.stdout(`TASK ${id} ${artifactLabel} ${status}`);
}

export function printRemoteRunStart(io: CliIo, payload: unknown): void {
  const run = readJsonObject(readJsonObject(payload)?.run);
  if (typeof run?.runId !== "string" || !run.runId) {
    throw new Error("remote task start failed: invalid response: missing run.runId");
  }
  const status = typeof run.status === "string" && run.status ? run.status : "unknown";
  io.stdout(`RUN ${run.runId} ${status}`);
  io.stdout(`Watch command: nitely run watch ${run.runId}`);
}

export type RemoteIntakeSourceType =
  | "prompt"
  | "text"
  | "github-issue"
  | "jira-ticket"
  | "external-document";

export interface RemoteDraftTaskInput {
  serverUrl: string;
  sourceType: RemoteIntakeSourceType;
  prompt?: string;
  text?: string;
  issue?: string;
  documentUrl?: string;
  documentVersion?: string;
  conversation?: unknown[];
  title?: string;
  guidance?: string;
  repoId?: string;
  flowPath?: string;
  templateId?: string;
  apiToken?: string;
}

export interface RemoteDraftTaskResult {
  id: string;
  status?: string;
  specStatus?: string;
  techDesignStatus?: string;
  sourceType?: string;
  sourceUri?: string;
  reused: boolean;
  driftStatus?: string;
}

/**
 * Create a draft Task from one intake source. This is the CLI half of the
 * planning intake the Web Console runs: no spec or technical design is
 * supplied, and the Task comes back in `draft` behind the same approval gates.
 */
export async function createRemoteDraftTask(
  input: RemoteDraftTaskInput,
  fetchImpl: FetchFunction,
): Promise<RemoteDraftTaskResult> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const response = await fetchImpl(`${serverUrl}/api/draft-specs`, {
    method: "POST",
    headers: remoteRequestHeaders(input.apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      sourceType: input.sourceType,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.issue ? { issue: input.issue } : {}),
      ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
      ...(input.documentVersion
        ? { documentVersion: input.documentVersion }
        : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.flowPath ? { flowPath: input.flowPath } : {}),
      ...(input.templateId ? { templateId: input.templateId } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `remote task intake failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("remote task intake failed: invalid JSON response");
  }
  const root = readJsonObject(payload);
  const task = readJsonObject(root?.task);
  if (typeof task?.id !== "string" || !task.id) {
    throw new Error("remote task intake failed: invalid response: missing task.id");
  }
  const ingestion = readJsonObject(root?.ingestion);
  const source = readJsonObject(task.source);
  return {
    id: task.id,
    ...(typeof task.status === "string" ? { status: task.status } : {}),
    ...(typeof task.specStatus === "string"
      ? { specStatus: task.specStatus }
      : {}),
    ...(typeof task.techDesignStatus === "string"
      ? { techDesignStatus: task.techDesignStatus }
      : {}),
    ...(typeof source?.type === "string" ? { sourceType: source.type } : {}),
    ...(typeof source?.uri === "string" ? { sourceUri: source.uri } : {}),
    reused: ingestion?.reused === true,
    ...(typeof ingestion?.driftStatus === "string"
      ? { driftStatus: ingestion.driftStatus }
      : {}),
  };
}

export function printRemoteDraftTaskResult(
  io: CliIo,
  serverUrl: string,
  task: RemoteDraftTaskResult,
): void {
  const status = task.status ? ` ${task.status}` : "";
  io.stdout(`TASK ${task.id}${status}`);
  const provenance = [task.sourceType, task.sourceUri].filter(Boolean).join(" · ");
  if (provenance) {
    io.stdout(`Source: ${provenance}`);
  }
  io.stdout(
    `Spec: ${task.specStatus ?? "draft"}  Tech design: ${task.techDesignStatus ?? "draft"}`,
  );
  if (task.reused) {
    io.stdout(
      task.driftStatus === "changed"
        ? "Existing task reused: the source changed since planning was approved. Refresh planning before starting a run."
        : "Existing task reused: the source is unchanged.",
    );
  }
  io.stdout(
    `Web: ${normalizeRemoteServerUrl(serverUrl)}/tasks/${encodeURIComponent(task.id)}`,
  );
  io.stdout(`Next: nitely task approve-spec ${task.id}`);
}

export function printRemoteTaskDraftTechDesign(
  io: CliIo,
  payload: unknown,
  taskId: string,
): void {
  const root = readJsonObject(payload);
  const task = readJsonObject(root?.task);
  const id = typeof task?.id === "string" && task.id ? task.id : taskId;
  const status =
    typeof task?.techDesignStatus === "string" && task.techDesignStatus
      ? task.techDesignStatus
      : "draft";
  io.stdout(`TASK ${id} tech-design ${status}`);
  const openQuestions = Array.isArray(root?.openQuestions)
    ? root.openQuestions.filter((question): question is string =>
        typeof question === "string" && question.trim().length > 0,
      )
    : [];
  for (const question of openQuestions) {
    io.stdout(`Open question: ${question}`);
  }
  io.stdout(`Next: nitely task approve-tech-design ${id}`);
}

export interface RemoteTaskActionCommandInput {
  argv: string[];
  startIndex: number;
  taskId: string;
  usage: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchFunction;
  io: CliIo;
  route: string;
  label: string;
  print: (io: CliIo, payload: unknown, taskId: string) => void;
}

export async function runRemoteTaskActionCommand(
  input: RemoteTaskActionCommandInput,
): Promise<number> {
  const { argv, io, env } = input;
  let serverFlag = "";
  let asJson = false;
  let resolvedApiToken: string | undefined;
  try {
    for (let index = input.startIndex; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--server") {
        serverFlag = argv[++index] ?? "";
        if (!serverFlag) throw new Error("Missing value for --server");
        continue;
      }
      if (arg === "--json") {
        asJson = true;
        continue;
      }
      io.stderr(`Unknown option: ${arg}. ${input.usage}`);
      return 1;
    }
    const remote = await resolveRemoteTarget({
      env,
      ...(serverFlag ? { flag: serverFlag } : {}),
    });
    resolvedApiToken = remote.apiToken;
    const serverUrl = requireRemoteServerUrl(remote.serverUrl);
    const payload = await postRemoteTaskAction(
      {
        serverUrl,
        taskId: input.taskId,
        ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
      },
      input.fetchImpl,
      input.route,
      input.label,
    );
    input.print(asJson ? { stdout: () => {}, stderr: () => {} } : io, payload, input.taskId);
    if (asJson) {
      io.stdout(JSON.stringify(payload));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
    return 1;
  }
}
