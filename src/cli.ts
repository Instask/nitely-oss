import { readFile, writeFile } from "node:fs/promises";

import { FlowValidationError, loadFlow } from "./flow/load.js";
import {
  resumeRun,
  runFlow,
  type ResumeRunInput,
  type RunFlowInput,
  type RunFlowResult,
} from "./run/run-flow.js";
import {
  processPullRequestComments,
  type ProcessPullRequestCommentsInput,
  type ProcessPullRequestCommentsResult,
} from "./pr-comments/loop.js";
import {
  buildRepoIndex,
  queryRepoIndex,
  recordRepoIndexQuery,
} from "./repo-index/index.js";
import {
  getProjectedRun,
  getProjectedRunLogs,
  listProjectedRuns,
  type ProjectedLog,
  type ProjectedRun,
} from "./run/project.js";
import { startWebServer, type StartWebServerInput, type WebServer } from "./web/server.js";
import {
  analyzeSpecClarifications,
  applySpecClarificationAnswers,
  type ClarificationAnswer,
} from "./spec-artifacts/clarify.js";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

type FetchFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CliDependencies {
  runFlow?: (input: RunFlowInput) => Promise<RunFlowResult>;
  resumeRun?: (input: ResumeRunInput) => Promise<RunFlowResult>;
  listRuns?: (repoPath: string) => Promise<ProjectedRun[]>;
  getRunStatus?: (repoPath: string, runId: string) => Promise<ProjectedRun>;
  getRunLogs?: (
    repoPath: string,
    runId: string,
    options: { stageId?: string },
  ) => Promise<ProjectedLog[]>;
  startWebServer?: (input: StartWebServerInput) => Promise<WebServer>;
  processPullRequestComments?: (
    input: ProcessPullRequestCommentsInput,
  ) => Promise<ProcessPullRequestCommentsResult>;
  fetch?: FetchFunction;
  env?: Record<string, string | undefined>;
}

const HELP = `nitely

Commands:
  validate <flow> [--external-input <name>]
  clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]
  run <flow> --repo <path>
  rework-pr <pr-url-or-number> --repo <path> --flow <flow>
  pr-comments <pr-url-or-number> --repo <path> --flow <flow>
  repo-index build --repo <path>
  repo-index query --repo <path> <target> [--limit <n>] [--run <run-id> --stage <stage-id> --attempt <n>]
  task create --server <url> --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>]
  task watch <task-id> --server <url> [--interval-ms <n>]
  run watch <run-id> --server <url> [--interval-ms <n>]
  runs
  status <run-id>
  logs <run-id>
  resume <run-id>
  web --repo <path> --host <host> --port <port> [--auth local|required] [--repository <id>=<path>]`;

function parseRunInput(value: string): [string, { connector: "local-file"; uri: string }] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --input value: ${value}`);
  }
  return [
    value.slice(0, separator),
    { connector: "local-file", uri: value.slice(separator + 1) },
  ];
}

function parseTaskScopeOption(value: string): NonNullable<RunFlowInput["taskScope"]> {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --task-scope value: ${value}`);
  }
  return {
    inputId: value.slice(0, separator),
    expression: value.slice(separator + 1),
  };
}

function parseRepoOption(argv: string[], startIndex: number): { repoPath: string; nextIndex: number } {
  let repoPath = ".";
  let index = startIndex;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--repo") {
      repoPath = argv[++index] ?? "";
      index += 1;
      continue;
    }
    break;
  }
  return { repoPath, nextIndex: index };
}

function parseRepositoryOption(value: string): { id: string; path: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --repository value: ${value}`);
  }
  return {
    id: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

function printResumeResult(io: CliIo, result: RunFlowResult, verb: "completed" | "resumed"): void {
  io.stdout(`RUN ${result.runId} ${verb}`);
  io.stdout(`Branch: ${result.branchName}`);
  io.stdout(`Worktree: ${result.worktreePath}`);
  if (result.changeRequestUrl) {
    io.stdout(`Change request: ${result.changeRequestUrl}`);
  }
}

function printLogs(io: CliIo, logs: ProjectedLog[]): void {
  for (const log of logs) {
    io.stdout(`== ${log.stageId} attempt ${log.attempt} ${log.source} ==`);
    if (log.command) {
      io.stdout(`$ ${log.command}`);
    }
    if (log.stdout !== undefined) {
      io.stdout("-- stdout --");
      io.stdout(log.stdout);
    }
    if (log.stderr !== undefined) {
      io.stdout("-- stderr --");
      io.stdout(log.stderr);
    }
  }
}

function blockerSummary(
  blocker: NonNullable<ProjectedRun["blocker"]>,
): string {
  return [
    blocker.stageId ? `stage ${blocker.stageId}` : undefined,
    `reason ${blocker.reason}`,
    blocker.runtime ? `runtime ${blocker.runtime}` : undefined,
    blocker.retryAfter ? `retry after ${blocker.retryAfter}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function printPrCommentsResult(
  io: CliIo,
  result: ProcessPullRequestCommentsResult,
): void {
  io.stdout(`PR: ${result.target.url}`);
  io.stdout(`Processed: ${result.processed}`);
  for (const item of result.triggered) {
    io.stdout(`Triggered: ${item.commentId} -> ${item.runId}`);
  }
  for (const item of result.explained) {
    io.stdout(`Explained: ${item.commentId}`);
  }
  io.stdout(`Skipped: ${result.skipped.length}`);
  for (const item of result.skipped) {
    io.stdout(`Skipped ${item.commentId}: ${item.reason}`);
  }
}

function parsePositiveIntegerOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name} value: ${value}`);
  }
  return parsed;
}

interface RemoteTaskCreateInput {
  serverUrl: string;
  title: string;
  specPath: string;
  techDesignPath: string;
  issueUrl?: string;
  flowPath?: string;
  repoId?: string;
}

interface RemoteTaskSummary {
  id: string;
  status?: string;
  issueUrl?: string;
}

type RemoteRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

interface RemoteRunWatchState {
  runId: string;
  status: RemoteRunStatus;
  currentStage?: string;
  latestOutputSummary?: string;
  changeRequestUrl?: string;
  prUrl?: string;
}

function normalizeRemoteServerUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("server URL must use http or https");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "server URL must use http or https") {
      throw error;
    }
    throw new Error(`invalid server URL: ${value}`);
  }
  return trimmed;
}

function remoteWatchStatus(value: unknown): RemoteRunStatus | undefined {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "interrupted" ||
    value === "cancelled"
    ? value
    : undefined;
}

function parseRemoteRunPayload(payload: unknown, fallbackRunId: string): RemoteRunWatchState {
  const root = readJsonObject(payload);
  const run = readJsonObject(root?.run);
  const status = remoteWatchStatus(run?.status);
  if (!run || !status) {
    throw new Error("remote run watch failed: invalid response: missing run.status");
  }
  const runId = typeof run.runId === "string" && run.runId ? run.runId : fallbackRunId;
  return {
    runId,
    status,
    ...(typeof run.currentStage === "string" ? { currentStage: run.currentStage } : {}),
    ...(typeof run.latestOutputSummary === "string"
      ? { latestOutputSummary: run.latestOutputSummary }
      : {}),
    ...(typeof run.changeRequestUrl === "string"
      ? { changeRequestUrl: run.changeRequestUrl }
      : {}),
    ...(typeof run.prUrl === "string" ? { prUrl: run.prUrl } : {}),
  };
}

function parseRemoteLatestRunId(payload: unknown): string {
  const root = readJsonObject(payload);
  const task = readJsonObject(root?.task);
  const latestRun = readJsonObject(task?.latestRun);
  const runId =
    typeof task?.latestRunId === "string"
      ? task.latestRunId
      : typeof latestRun?.runId === "string"
        ? latestRun.runId
        : "";
  if (!runId) {
    throw new Error("remote task watch failed: task has no latest run");
  }
  return runId;
}

async function fetchRemoteJson(
  url: string,
  fetchImpl: FetchFunction,
  label: string,
): Promise<unknown> {
  const response = await fetchImpl(url);
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

async function fetchRemoteRun(
  serverUrl: string,
  runId: string,
  fetchImpl: FetchFunction,
): Promise<RemoteRunWatchState> {
  const payload = await fetchRemoteJson(
    `${normalizeRemoteServerUrl(serverUrl)}/api/runs/${encodeURIComponent(runId)}`,
    fetchImpl,
    "remote run watch",
  );
  return parseRemoteRunPayload(payload, runId);
}

async function fetchRemoteTaskLatestRunId(
  serverUrl: string,
  taskId: string,
  fetchImpl: FetchFunction,
): Promise<string> {
  const payload = await fetchRemoteJson(
    `${normalizeRemoteServerUrl(serverUrl)}/api/tasks/${encodeURIComponent(taskId)}`,
    fetchImpl,
    "remote task watch",
  );
  return parseRemoteLatestRunId(payload);
}

function terminalRemoteRunStatus(status: RemoteRunStatus): boolean {
  return status !== "running";
}

function remoteWatchLine(state: RemoteRunWatchState): string {
  const parts = [`RUN ${state.runId}`, state.status];
  if (state.currentStage) {
    parts.push(`stage=${state.currentStage}`);
  }
  if (state.latestOutputSummary) {
    parts.push(`summary=${state.latestOutputSummary}`);
  }
  const url = state.changeRequestUrl ?? state.prUrl;
  if (url) {
    parts.push(`url=${url}`);
  }
  return parts.join(" ");
}

async function watchRemoteRun(input: {
  runId: string;
  serverUrl: string;
  intervalMs: number;
  fetchImpl: FetchFunction;
  io: CliIo;
}): Promise<number> {
  let previousLine = "";
  while (true) {
    const state = await fetchRemoteRun(
      input.serverUrl,
      input.runId,
      input.fetchImpl,
    );
    const line = remoteWatchLine(state);
    if (line !== previousLine) {
      input.io.stdout(line);
      previousLine = line;
    }
    if (terminalRemoteRunStatus(state.status)) {
      return state.status === "completed" ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
}

function parseRemoteWatchOptions(
  argv: string[],
  startIndex: number,
  env: Record<string, string | undefined>,
): { serverUrl: string; intervalMs: number } {
  let serverUrl = env.NITELY_SERVER_URL ?? "";
  let intervalMs = 2000;
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server") {
      serverUrl = argv[++index] ?? "";
      if (!serverUrl) throw new Error("Missing value for --server");
      continue;
    }
    if (arg === "--interval-ms") {
      intervalMs = parsePositiveIntegerOption("--interval-ms", argv[++index] ?? "");
      continue;
    }
    throw new Error(`Unknown watch option: ${arg}`);
  }
  if (!serverUrl) throw new Error("Missing --server or NITELY_SERVER_URL");
  return { serverUrl, intervalMs };
}

async function readTaskInputFile(optionName: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read ${optionName} file: ${message}`);
  }
}

function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function remoteErrorMessage(response: Response): Promise<string> {
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

async function createRemoteTask(
  input: RemoteTaskCreateInput,
  fetchImpl: FetchFunction,
): Promise<RemoteTaskSummary> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const spec = await readTaskInputFile("--spec", input.specPath);
  const techDesign = await readTaskInputFile("--tech-design", input.techDesignPath);
  const response = await fetchImpl(`${serverUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      spec,
      techDesign,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
      ...(input.flowPath ? { flowPath: input.flowPath } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `remote task create failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("remote task create failed: invalid JSON response");
  }
  const root = readJsonObject(payload);
  const task = readJsonObject(root?.task);
  if (typeof task?.id !== "string" || !task.id) {
    throw new Error("remote task create failed: invalid response: missing task.id");
  }
  return {
    id: task.id,
    ...(typeof task.status === "string" ? { status: task.status } : {}),
    ...(typeof task.issueUrl === "string" ? { issueUrl: task.issueUrl } : {}),
  };
}

function printRemoteTaskResult(
  io: CliIo,
  serverUrl: string,
  task: RemoteTaskSummary,
): void {
  const status = task.status ? ` ${task.status}` : "";
  io.stdout(`TASK ${task.id}${status}`);
  if (task.issueUrl) {
    io.stdout(`Issue: ${task.issueUrl}`);
  }
  io.stdout(`Web: ${normalizeRemoteServerUrl(serverUrl)}/tasks/${encodeURIComponent(task.id)}`);
}

export async function runCli(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  argv = argv[0] === "--" ? argv.slice(1) : argv;

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    io.stdout(HELP);
    return 0;
  }

  if (argv[0] === "validate") {
    const path = argv[1];
    if (!path) {
      io.stderr("Usage: nitely validate <flow> [--external-input <name>]");
      return 1;
    }
    const externalInputs: string[] = [];
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--external-input") {
        const value = argv[++index] ?? "";
        if (!value) {
          io.stderr("Missing value for --external-input");
          return 1;
        }
        externalInputs.push(value);
        continue;
      }
      io.stderr(`Unknown validate option: ${arg}`);
      return 1;
    }

    try {
      const { flow, graph } = await loadFlow(path, { externalInputs });
      io.stdout(
        `VALID ${flow.metadata.name}: ${flow.spec.stages.length} stages, ${graph.producerByArtifact.size} artifacts`,
      );
      return 0;
    } catch (error) {
      if (error instanceof FlowValidationError) {
        for (const message of error.errors) {
          io.stderr(`[error] ${message}`);
        }
        return 1;
      }
      throw error;
    }
  }

  if (argv[0] === "clarify-spec") {
    const specPath = argv[1];
    if (!specPath) {
      io.stderr("Usage: nitely clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]");
      return 1;
    }
    const answers: ClarificationAnswer[] = [];
    let sessionId = "cli";
    let date = new Date().toISOString().slice(0, 10);
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--answer") {
          const value = argv[++index] ?? "";
          const separator = value.indexOf("=");
          if (separator <= 0 || separator === value.length - 1) {
            throw new Error(`invalid --answer value: ${value}`);
          }
          answers.push({
            questionId: value.slice(0, separator),
            optionId: value.slice(separator + 1),
          });
          continue;
        }
        if (arg === "--session") {
          sessionId = argv[++index] ?? "";
          if (!sessionId) throw new Error("Missing value for --session");
          continue;
        }
        if (arg === "--date") {
          date = argv[++index] ?? "";
          if (!date) throw new Error("Missing value for --date");
          continue;
        }
        io.stderr(`Unknown clarify-spec option: ${arg}`);
        return 1;
      }
      const markdown = await readFile(specPath, "utf8");
      const analysis = analyzeSpecClarifications(markdown);
      if (answers.length === 0) {
        io.stdout(JSON.stringify(analysis, null, 2));
        return 0;
      }
      const updated = applySpecClarificationAnswers(markdown, {
        questions: analysis.questions,
        answers,
        date,
        sessionId,
      });
      await writeFile(specPath, updated.markdown, "utf8");
      io.stdout(`Applied ${updated.applied} clarification(s)`);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "run" && argv[1] === "watch") {
    const runId = argv[2];
    if (!runId) {
      io.stderr("Usage: nitely run watch <run-id> --server <url> [--interval-ms <n>]");
      return 1;
    }
    try {
      const options = parseRemoteWatchOptions(argv, 3, dependencies.env ?? process.env);
      return await watchRemoteRun({
        runId,
        serverUrl: options.serverUrl,
        intervalMs: options.intervalMs,
        fetchImpl: dependencies.fetch ?? fetch,
        io,
      });
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "run") {
    const flowPath = argv[1];
    if (!flowPath) {
      io.stderr("Usage: nitely run <flow> --repo <path> --input <name>=<path> [--task-scope <input>:<scope>]");
      return 1;
    }

    let repoPath = ".";
    const inputs: RunFlowInput["inputs"] = {};
    let taskScope: RunFlowInput["taskScope"];
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--input") {
          const [name, reference] = parseRunInput(argv[++index] ?? "");
          inputs[name] = reference;
          continue;
        }
        if (arg === "--task-scope") {
          taskScope = parseTaskScopeOption(argv[++index] ?? "");
          continue;
        }
        io.stderr(`Unknown run option: ${arg}`);
        return 1;
      }
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }

    try {
      const result = await (dependencies.runFlow ?? runFlow)({
        flowPath,
        repoPath,
        inputs,
        ...(taskScope ? { taskScope } : {}),
      });
      printResumeResult(io, result, "completed");
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "repo-index") {
    const action = argv[1];
    if (action !== "build" && action !== "query") {
      io.stderr(
        "Usage: nitely repo-index build --repo <path> | nitely repo-index query --repo <path> <target>",
      );
      return 1;
    }

    let repoPath = ".";
    let target = "";
    let limit: number | undefined;
    let runId = "";
    let stageId = "";
    let attempt: number | undefined;
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (action === "query" && arg === "--limit") {
          limit = parsePositiveIntegerOption("--limit", argv[++index] ?? "");
          continue;
        }
        if (action === "query" && arg === "--run") {
          runId = argv[++index] ?? "";
          continue;
        }
        if (action === "query" && arg === "--stage") {
          stageId = argv[++index] ?? "";
          continue;
        }
        if (action === "query" && arg === "--attempt") {
          attempt = parsePositiveIntegerOption("--attempt", argv[++index] ?? "");
          continue;
        }
        if (action === "query" && !target) {
          target = arg ?? "";
          continue;
        }
        io.stderr(`Unknown repo-index option: ${arg}`);
        return 1;
      }
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }

    try {
      if (action === "build") {
        const result = await buildRepoIndex(repoPath);
        io.stdout(
          `INDEX ${result.indexPath}: ${result.index.files.length} files, ${result.index.symbols.length} symbols, ${result.index.directories.length} directories`,
        );
        return 0;
      }

      if (!target) {
        io.stderr("Usage: nitely repo-index query --repo <path> <target>");
        return 1;
      }
      const result = await queryRepoIndex({ repoPath, query: target, limit });
      if (runId || stageId || attempt !== undefined) {
        if (!runId || !stageId || attempt === undefined) {
          io.stderr("--run, --stage, and --attempt must be supplied together");
          return 1;
        }
        recordRepoIndexQuery({
          repoPath,
          runId,
          stageId,
          attempt,
          result,
        });
      }
      io.stdout(`INDEX QUERY ${result.query}: ${result.matches.length} matches`);
      if (result.stale.stale) {
        io.stdout(`STALE: ${result.stale.reasons.join("; ")}`);
      }
      for (const match of result.matches) {
        const reasons = match.reasons.length > 0
          ? ` [${match.reasons.join(", ")}]`
          : "";
        const symbols = match.symbols.length > 0
          ? ` symbols: ${match.symbols.slice(0, 5).map((symbol) => symbol.name).join(", ")}`
          : "";
        io.stdout(`- ${match.path}${reasons}${symbols}`);
      }
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "task") {
    const action = argv[1];
    if (action !== "create" && action !== "watch") {
      io.stderr(
        "Usage: nitely task create --server <url> --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>] | nitely task watch <task-id> --server <url> [--interval-ms <n>]",
      );
      return 1;
    }

    const env = dependencies.env ?? process.env;
    if (action === "watch") {
      const taskId = argv[2];
      if (!taskId) {
        io.stderr("Usage: nitely task watch <task-id> --server <url> [--interval-ms <n>]");
        return 1;
      }
      try {
        const options = parseRemoteWatchOptions(argv, 3, env);
        const fetchImpl = dependencies.fetch ?? fetch;
        const runId = await fetchRemoteTaskLatestRunId(
          options.serverUrl,
          taskId,
          fetchImpl,
        );
        return await watchRemoteRun({
          runId,
          serverUrl: options.serverUrl,
          intervalMs: options.intervalMs,
          fetchImpl,
          io,
        });
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    let serverUrl = env.NITELY_SERVER_URL ?? "";
    let title = "";
    let specPath = "";
    let techDesignPath = "";
    let issueUrl: string | undefined;
    let flowPath: string | undefined;
    let repoId: string | undefined;
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--server") {
          serverUrl = argv[++index] ?? "";
          if (!serverUrl) throw new Error("Missing value for --server");
          continue;
        }
        if (arg === "--title") {
          title = argv[++index] ?? "";
          if (!title) throw new Error("Missing value for --title");
          continue;
        }
        if (arg === "--issue") {
          issueUrl = argv[++index] ?? "";
          if (!issueUrl) throw new Error("Missing value for --issue");
          continue;
        }
        if (arg === "--spec") {
          specPath = argv[++index] ?? "";
          if (!specPath) throw new Error("Missing value for --spec");
          continue;
        }
        if (arg === "--tech-design") {
          techDesignPath = argv[++index] ?? "";
          if (!techDesignPath) throw new Error("Missing value for --tech-design");
          continue;
        }
        if (arg === "--flow") {
          flowPath = argv[++index] ?? "";
          if (!flowPath) throw new Error("Missing value for --flow");
          continue;
        }
        if (arg === "--repo-id") {
          repoId = argv[++index] ?? "";
          if (!repoId) throw new Error("Missing value for --repo-id");
          continue;
        }
        io.stderr(`Unknown task create option: ${arg}`);
        return 1;
      }
      if (!serverUrl) throw new Error("Missing --server or NITELY_SERVER_URL");
      if (!title) throw new Error("Missing value for --title");
      if (!specPath) throw new Error("Missing value for --spec");
      if (!techDesignPath) throw new Error("Missing value for --tech-design");
      const task = await createRemoteTask(
        {
          serverUrl,
          title,
          specPath,
          techDesignPath,
          ...(issueUrl ? { issueUrl } : {}),
          ...(flowPath ? { flowPath } : {}),
          ...(repoId ? { repoId } : {}),
        },
        dependencies.fetch ?? fetch,
      );
      printRemoteTaskResult(io, serverUrl, task);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "rework-pr") {
    const target = argv[1];
    if (!target) {
      io.stderr(
        "Usage: nitely rework-pr <pr-url-or-number> --repo <path> --flow <flow> --input <name>=<path>",
      );
      return 1;
    }

    let repoPath = ".";
    let flowPath = "";
    let provider: "github" | "github-cli" = "github-cli";
    const inputs: RunFlowInput["inputs"] = {};
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--flow") {
          flowPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--provider") {
          const value = argv[++index] ?? "";
          if (value !== "github" && value !== "github-cli") {
            io.stderr("Invalid value for --provider");
            return 1;
          }
          provider = value;
          continue;
        }
        if (arg === "--input") {
          const [name, reference] = parseRunInput(argv[++index] ?? "");
          inputs[name] = reference;
          continue;
        }
        io.stderr(`Unknown rework-pr option: ${arg}`);
        return 1;
      }
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (!repoPath || !flowPath) {
      io.stderr(
        "Usage: nitely rework-pr <pr-url-or-number> --repo <path> --flow <flow> --input <name>=<path>",
      );
      return 1;
    }

    try {
      const result = await (dependencies.runFlow ?? runFlow)({
        flowPath,
        repoPath,
        inputs,
        changeRequestTarget: {
          provider,
          target,
        },
      });
      printResumeResult(io, result, "completed");
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "pr-comments") {
    const target = argv[1];
    if (!target) {
      io.stderr(
        "Usage: nitely pr-comments <pr-url-or-number> --repo <path> --flow <flow>",
      );
      return 1;
    }

    let repoPath = ".";
    let flowPath = "flows/rework-pr-bootstrap.json";
    let dryRun = false;
    const allowAuthors: string[] = [];
    let botLogin: string | undefined;
    let priorRunId: string | undefined;
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--repo") {
        repoPath = argv[++index] ?? "";
        continue;
      }
      if (arg === "--flow") {
        flowPath = argv[++index] ?? "";
        continue;
      }
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg === "--allow-author") {
        const value = argv[++index] ?? "";
        if (!value) {
          io.stderr("Missing value for --allow-author");
          return 1;
        }
        allowAuthors.push(value);
        continue;
      }
      if (arg === "--bot-login") {
        botLogin = argv[++index] ?? "";
        if (!botLogin) {
          io.stderr("Missing value for --bot-login");
          return 1;
        }
        continue;
      }
      if (arg === "--prior-run") {
        priorRunId = argv[++index] ?? "";
        if (!priorRunId) {
          io.stderr("Missing value for --prior-run");
          return 1;
        }
        continue;
      }
      io.stderr(`Unknown pr-comments option: ${arg}`);
      return 1;
    }

    if (!repoPath || !flowPath) {
      io.stderr(
        "Usage: nitely pr-comments <pr-url-or-number> --repo <path> --flow <flow>",
      );
      return 1;
    }

    try {
      const result = await (
        dependencies.processPullRequestComments ?? processPullRequestComments
      )({
        repoPath,
        target,
        flowPath,
        ...(dryRun ? { dryRun } : {}),
        ...(allowAuthors.length > 0 ? { allowAuthors } : {}),
        ...(botLogin ? { botLogin } : {}),
        ...(priorRunId ? { priorRunId } : {}),
      });
      printPrCommentsResult(io, result);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "runs") {
    const { repoPath, nextIndex } = parseRepoOption(argv, 1);
    if (nextIndex < argv.length) {
      io.stderr(`Unknown runs option: ${argv[nextIndex]}`);
      return 1;
    }
    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }
    try {
      const runs = await (dependencies.listRuns ?? listProjectedRuns)(repoPath);
      for (const run of runs) {
        io.stdout(
          `${run.runId}\t${run.status}\t${run.flowName ?? ""}\t${run.completedStages.length} stages`,
        );
      }
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "status") {
    const runId = argv[1];
    if (!runId) {
      io.stderr("Usage: nitely status <run-id> [--repo <path>]");
      return 1;
    }
    const { repoPath, nextIndex } = parseRepoOption(argv, 2);
    if (nextIndex < argv.length) {
      io.stderr(`Unknown status option: ${argv[nextIndex]}`);
      return 1;
    }
    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }
    try {
      const run = await (dependencies.getRunStatus ?? getProjectedRun)(
        repoPath,
        runId,
      );
      io.stdout(`Run: ${run.runId}`);
      io.stdout(`Status: ${run.status}`);
      if (run.flowName) {
        io.stdout(`Flow: ${run.flowName}`);
      }
      if (run.branchName) {
        io.stdout(`Branch: ${run.branchName}`);
      }
      if (run.worktreePath) {
        io.stdout(`Worktree: ${run.worktreePath}`);
      }
      if (run.blocker) {
        io.stdout(`Blocked: ${blockerSummary(run.blocker)}`);
        if (run.blocker.message) {
          io.stdout(`Message: ${run.blocker.message}`);
        }
      }
      io.stdout("Stages:");
      for (const stage of run.stages) {
        const blockerSuffix = stage.blocker
          ? `\treason: ${stage.blocker.reason}`
          : "";
        io.stdout(
          `  ${stage.stageId}\t${stage.status}\tattempts: ${stage.attempts.length}${blockerSuffix}`,
        );
      }
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "logs") {
    const runId = argv[1];
    if (!runId) {
      io.stderr("Usage: nitely logs <run-id> [--repo <path>] [--stage <stage-id>]");
      return 1;
    }
    let repoPath = ".";
    let stageId: string | undefined;
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--repo") {
        repoPath = argv[++index] ?? "";
        continue;
      }
      if (arg === "--stage") {
        stageId = argv[++index] ?? "";
        continue;
      }
      io.stderr(`Unknown logs option: ${arg}`);
      return 1;
    }
    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }
    if (stageId === "") {
      io.stderr("Missing value for --stage");
      return 1;
    }
    try {
      const logs = await (dependencies.getRunLogs ?? getProjectedRunLogs)(
        repoPath,
        runId,
        { stageId },
      );
      printLogs(io, logs);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "resume") {
    const runId = argv[1];
    if (!runId) {
      io.stderr("Usage: nitely resume <run-id> [--repo <path>]");
      return 1;
    }
    const { repoPath, nextIndex } = parseRepoOption(argv, 2);
    if (nextIndex < argv.length) {
      io.stderr(`Unknown resume option: ${argv[nextIndex]}`);
      return 1;
    }
    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }
    try {
      const result = await (dependencies.resumeRun ?? resumeRun)({
        repoPath,
        runId,
      });
      printResumeResult(io, result, "resumed");
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (argv[0] === "web") {
    let repoPath = ".";
    let host = "127.0.0.1";
    let port = 4173;
    let authMode: StartWebServerInput["authMode"] | undefined;
    const repositories: NonNullable<StartWebServerInput["repositories"]> = [];

    try {
      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--repository") {
          repositories.push(parseRepositoryOption(argv[++index] ?? ""));
          continue;
        }
        if (arg === "--host") {
          host = argv[++index] ?? "";
          continue;
        }
        if (arg === "--port") {
          const value = argv[++index] ?? "";
          port = Number.parseInt(value, 10);
          continue;
        }
        if (arg === "--auth") {
          const value = argv[++index] ?? "";
          if (value !== "local" && value !== "required") {
            io.stderr("Invalid value for --auth");
            return 1;
          }
          authMode = value;
          continue;
        }
        io.stderr(`Unknown web option: ${arg}`);
        return 1;
      }
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (!repoPath) {
      io.stderr("Missing value for --repo");
      return 1;
    }
    if (!host) {
      io.stderr("Missing value for --host");
      return 1;
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.stderr("Invalid value for --port");
      return 1;
    }

    try {
      const server = await (dependencies.startWebServer ?? startWebServer)({
        repoPath,
        host,
        port,
        ...(repositories.length > 0 ? { repositories } : {}),
        ...(authMode ? { authMode } : {}),
      });
      io.stdout(`Web Console: ${server.url}`);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  io.stderr(`Unknown command: ${argv[0]}`);
  return 1;
}
