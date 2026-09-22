import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  formatFlowGraph,
  type FlowGraphFormat,
} from "./flow/format-graph.js";
import { FlowValidationError, loadFlow, parseFlowDocument } from "./flow/load.js";
import { lintFlowProduction } from "./flows/lint.js";
import {
  resumeRun,
  runFlow,
  type ResumeRunInput,
  type RunFlowInput,
  type RunFlowResult,
} from "./run/run-flow.js";
import {
  evaluateRunPreflight,
  type EvaluateRunPreflightInput,
  type RunPreflightReport,
} from "./run/preflight.js";
import {
  processPullRequestComments,
  type ProcessPullRequestCommentsInput,
  type ProcessPullRequestCommentsResult,
} from "./pr-comments/loop.js";
import type { ReviewFeedbackRouteTarget } from "./review-feedback/model.js";
import {
  buildRepoIndex,
  queryRepoIndex,
  recordRepoIndexQuery,
} from "./repo-index/index.js";
import {
  runKnowledgeRepositoryCli,
  type KnowledgeRepositoryCliService,
} from "./knowledge-repositories/cli.js";
import {
  eventStorePath,
  getProjectedRun,
  getProjectedRunLogs,
  listProjectedRuns,
  type ProjectedApproval,
  type ProjectedLog,
  type ProjectedOperatorQuestion,
  type ProjectedRun,
} from "./run/project.js";
import { diagnoseRepoRun, type EfficiencyReport } from "./run/efficiency.js";
import { buildRunTrace } from "./run/trace.js";
import {
  diagnosticForManifest,
  readReproducibilityManifest,
  reproducibilityManifestPath,
} from "./run/reproducibility.js";
import {
  applyRollbackDecision,
  recordRollbackDecision,
  type ApplyRollbackDecisionInput,
  type RecordRollbackDecisionInput,
  type RecordRollbackDecisionResult,
  type ApplyRollbackDecisionResult,
} from "./run/rollback.js";
import { EventStore } from "./events/store.js";
import {
  listApprovals,
  resolveApproval,
  type ResolveApprovalInput,
} from "./run/approvals.js";
import {
  answerQuestion,
  listQuestions,
  type OperatorAnswerInput,
} from "./run/questions.js";
import {
  submitOperatorReview,
  type SubmitOperatorReviewInput,
} from "./run/operator-review.js";
import { startWebServer, type StartWebServerInput, type WebServer } from "./web/server.js";
import { buildFactoryMetrics } from "./web/dashboard.js";
import { listRuns as listWebRuns, type WebRunSummary } from "./web/runs.js";
import { listUnifiedWorkItems } from "./work-items/access.js";
import {
  analyzeSpecClarifications,
  applySpecClarificationAnswers,
  type ClarificationAnswer,
} from "./spec-artifacts/clarify.js";
import {
  resolveMaxConcurrentTasks,
  runSchedulerOnce,
  type SchedulerRunSummary,
} from "./scheduler/run.js";
import { materializeDueSchedules } from "./schedules/materialize.js";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  setScheduleEnabled,
} from "./schedules/store.js";
import type { ScheduleTrigger } from "./schedules/types.js";
import {
  runGoldenPathDemo,
  type GoldenPathDemoInput,
  type GoldenPathDemoResult,
} from "./demo/golden-path.js";
import { importLocalSkill } from "./skills/import.js";
import {
  confirmSkillPapercut,
  decideStoredSkillImprovementProposal,
  evaluateStoredSkillImprovementProposal,
  reconcileSkillImprovementProposals,
  skillImprovementStorePath,
  SkillImprovementStore,
} from "./skill-improvement/runtime.js";
import {
  defaultCiRepairDependencies,
  parseCiFailureObservation,
  readGitHubPullRequestHead,
  recordCiRepairDecision,
  submitCiRepair,
} from "./ci-repair/runtime.js";
import {
  defaultPilotSetupReportPath,
  generatePilotSetupReport,
  type GeneratePilotSetupReportInput,
  type PilotSetupReport,
} from "./pilots/setup-report.js";
import {
  API_TOKEN_CAPABILITIES,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenCapability,
  type ApiTokenRecord,
} from "./web/api-tokens.js";
import { findUserByIdOrEmail, hasAnyUsers } from "./web/users.js";
import {
  startNitelyMcpStdioServer,
  type NitelyMcpServerInput,
} from "./mcp/server.js";
import { loadEvidencePolicy } from "./evidence/policy.js";
import {
  searchEvidenceRuns,
  type EvidenceSearchFilters,
} from "./evidence/catalog.js";
import { exportEvidenceBundle } from "./evidence/export.js";
import {
  applyEvidencePrunePlan,
  buildEvidencePrunePlan,
  type EvidencePruneAction,
  type EvidencePruneApplyResult,
  type EvidencePrunePlan,
} from "./evidence/retention.js";
import {
  syncTaskIssues,
  type SyncTaskIssuesResult,
} from "./task-issues/bridge.js";
import type { CliIo, FetchFunction } from "./cli/io.js";
import {
  MISSING_REMOTE_INSTANCE_MESSAGE,
  REMOTE_RUN_STATUSES,
  createRemoteDraftTask,
  fetchRemoteJson,
  listRemoteCollection,
  listRemoteRuns,
  listRemoteTasks,
  parseRemoteRunStatusOption,
  postRemoteTaskAction,
  printRemoteDraftTaskResult,
  printRemoteRunList,
  printRemoteRunStart,
  printRemoteTaskApproval,
  printRemoteTaskDraftTechDesign,
  printRemoteTaskList,
  readJsonObject,
  redactSecret,
  remoteErrorMessage,
  remoteRequestHeaders,
  remoteWatchStatus,
  requireRemoteServerUrl,
  runRemoteListCommand,
  runRemoteTaskActionCommand,
} from "./cli/remote.js";
import type {
  RemoteIntakeSourceType,
  RemoteListCommandInput,
  RemoteRunStatus,
  RemoteTaskActionCommandInput,
} from "./cli/remote.js";
import { buildCliHelp, selectCliCommand, type CliCommand } from "./cli/registry.js";
import { runEvalCli } from "./eval/cli.js";
import {
  clearCurrentInstance,
  normalizeRemoteServerUrl,
  readCurrentInstance,
  resolveRemoteTarget,
  writeCurrentInstance,
} from "./cli-current-instance.js";
import {
  openBrowser as defaultOpenBrowser,
  pollForDeviceToken,
  requestDeviceAuthorization,
} from "./cli/auth-device.js";

export interface CliDependencies {
  runFlow?: (input: RunFlowInput) => Promise<RunFlowResult>;
  resumeRun?: (input: ResumeRunInput) => Promise<RunFlowResult>;
  recordRollbackDecision?: (
    input: RecordRollbackDecisionInput,
  ) => Promise<RecordRollbackDecisionResult>;
  applyRollbackDecision?: (
    input: ApplyRollbackDecisionInput,
  ) => Promise<ApplyRollbackDecisionResult>;
  listRuns?: (repoPath: string) => Promise<ProjectedRun[]>;
  listFactoryRuns?: (repoPath: string) => Promise<WebRunSummary[]>;
  listFactoryWorkItems?: typeof listUnifiedWorkItems;
  getRunStatus?: (repoPath: string, runId: string) => Promise<ProjectedRun>;
  listApprovals?: (repoPath: string, runId: string) => Promise<ProjectedApproval[]>;
  resolveApproval?: (input: ResolveApprovalInput) => Promise<ProjectedApproval>;
  listQuestions?: (
    repoPath: string,
    runId: string,
  ) => Promise<ProjectedOperatorQuestion[]>;
  answerQuestion?: (input: {
    repoPath: string;
    runId: string;
    questionId: string;
    answer: OperatorAnswerInput;
    actor?: string;
  }) => Promise<ProjectedOperatorQuestion>;
  submitOperatorReview?: (
    input: SubmitOperatorReviewInput,
  ) => ReturnType<typeof submitOperatorReview>;
  getRunLogs?: (
    repoPath: string,
    runId: string,
    options: { stageId?: string },
  ) => Promise<ProjectedLog[]>;
  diagnoseRun?: (repoPath: string, runId: string) => EfficiencyReport;
  startWebServer?: (input: StartWebServerInput) => Promise<WebServer>;
  runSchedulerOnce?: (input: {
    repoPath: string;
    maxConcurrentTasks?: number;
    usageLimitCooldownMs?: number;
  }) => Promise<SchedulerRunSummary>;
  evaluateRunPreflight?: (
    input: EvaluateRunPreflightInput,
  ) => Promise<RunPreflightReport>;
  runGoldenPathDemo?: (input: GoldenPathDemoInput) => Promise<GoldenPathDemoResult>;
  generatePilotSetupReport?: (
    input: GeneratePilotSetupReportInput,
  ) => Promise<PilotSetupReport>;
  processPullRequestComments?: (
    input: ProcessPullRequestCommentsInput,
  ) => Promise<ProcessPullRequestCommentsResult>;
  fetch?: FetchFunction;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => boolean;
  env?: Record<string, string | undefined>;
  createApiToken?: typeof createApiToken;
  listApiTokens?: typeof listApiTokens;
  revokeApiToken?: typeof revokeApiToken;
  findUserByIdOrEmail?: typeof findUserByIdOrEmail;
  hasAnyUsers?: typeof hasAnyUsers;
  startMcpServer?: (input: NitelyMcpServerInput) => Promise<unknown>;
  syncTaskIssues?: typeof syncTaskIssues;
  knowledgeRepositories?: KnowledgeRepositoryCliService;
}

function tryBuildRunTrace(
  repoPath: string,
  runId: string,
): ReturnType<typeof buildRunTrace> | undefined {
  try {
    const store = new EventStore(eventStorePath(repoPath));
    try {
      const events = store.list(runId);
      return events.length > 0 ? buildRunTrace(events) : undefined;
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

const CLI_HELP_HEADER = "nitely";

function isEvalCohortReport(
  value: unknown,
): value is Parameters<typeof evaluateStoredSkillImprovementProposal>[0]["report"] {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "nitely.eval-report.v1" ||
      (record.status !== "passed" && record.status !== "regressed" && record.status !== "insufficient_data")) {
    return false;
  }
  const lineage = record.runLineage;
  if (typeof lineage !== "object" || lineage === null) return false;
  for (const side of ["baseline", "candidate"] as const) {
    const entries = (lineage as Record<string, unknown>)[side];
    if (!Array.isArray(entries) || entries.some((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const item = entry as Record<string, unknown>;
      return typeof item.caseId !== "string" || typeof item.runId !== "string";
    })) return false;
  }
  return true;
}

function parseRunInput(value: string): [string, { connector: "local-file"; uri: string }] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --input value: ${value}`);
  }
  const raw = value.slice(separator + 1);
  const uri = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return [
    value.slice(0, separator),
    { connector: "local-file", uri },
  ];
}

function parseRunConfig(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error(`invalid --config value: ${value}`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
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

function parseDurationMs(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`invalid --every duration: ${value} (use e.g. 30m, 6h, 1d)`);
  const amount = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return amount * unit;
}

function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.type) {
    case "cron":
      return `cron ${trigger.expression}`;
    case "interval":
      return `every ${trigger.everyMs / 60_000}m`;
    case "once":
      return `once ${trigger.at}`;
  }
}

function parseScheduleCreateOptions(argv: string[], now: Date): {
  repoPath: string;
  name: string;
  trigger: ScheduleTrigger;
  timezone: string;
  title: string;
  specFile: string;
  techDesignFile: string;
  flowPath?: string;
  admission?: "auto" | "review";
  misfire?: { policy: "skip" | "run_once_now" | "catch_up"; limit?: number };
  overlap?: "allow" | "skip" | "queue";
  json: boolean;
} {
  let repoPath = ".";
  let name = "";
  let timezone = "UTC";
  let title = "";
  let specFile = "";
  let techDesignFile = "";
  let flowPath: string | undefined;
  let admission: "auto" | "review" | undefined;
  let misfirePolicy: "skip" | "run_once_now" | "catch_up" | undefined;
  let catchUpLimit: number | undefined;
  let overlap: "allow" | "skip" | "queue" | undefined;
  let json = false;
  let trigger: ScheduleTrigger | undefined;
  const valueOf = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo": repoPath = valueOf(index, arg); index += 1; break;
      case "--name": name = valueOf(index, arg); index += 1; break;
      case "--timezone": timezone = valueOf(index, arg); index += 1; break;
      case "--title": title = valueOf(index, arg); index += 1; break;
      case "--spec-file": specFile = valueOf(index, arg); index += 1; break;
      case "--tech-design-file": techDesignFile = valueOf(index, arg); index += 1; break;
      case "--flow": flowPath = valueOf(index, arg); index += 1; break;
      case "--admission": {
        const value = valueOf(index, arg);
        if (value !== "auto" && value !== "review") throw new Error("--admission must be auto or review");
        admission = value;
        index += 1;
        break;
      }
      case "--misfire": {
        const value = valueOf(index, arg);
        if (value !== "skip" && value !== "run_once_now" && value !== "catch_up") {
          throw new Error("--misfire must be skip, run_once_now or catch_up");
        }
        misfirePolicy = value;
        index += 1;
        break;
      }
      case "--catch-up-limit":
        catchUpLimit = parsePositiveIntegerOption("--catch-up-limit", valueOf(index, arg));
        index += 1;
        break;
      case "--overlap": {
        const value = valueOf(index, arg);
        if (value !== "allow" && value !== "skip" && value !== "queue") {
          throw new Error("--overlap must be allow, skip or queue");
        }
        overlap = value;
        index += 1;
        break;
      }
      case "--cron": trigger = { type: "cron", expression: valueOf(index, arg) }; index += 1; break;
      case "--every":
        trigger = { type: "interval", everyMs: parseDurationMs(valueOf(index, arg)), anchorAt: now.toISOString() };
        index += 1;
        break;
      case "--at": trigger = { type: "once", at: valueOf(index, arg) }; index += 1; break;
      case "--json": json = true; break;
      default:
        throw new Error(`Unknown schedule option: ${arg}`);
    }
  }
  if (!name) throw new Error("Missing --name");
  if (!trigger) throw new Error("Missing trigger: pass --cron, --every or --at");
  if (!title) throw new Error("Missing --title");
  if (!specFile || !techDesignFile) throw new Error("Missing --spec-file or --tech-design-file");
  return {
    repoPath, name, trigger, timezone, title, specFile, techDesignFile,
    ...(flowPath ? { flowPath } : {}),
    ...(admission ? { admission } : {}),
    ...(misfirePolicy
      ? { misfire: { policy: misfirePolicy, ...(catchUpLimit !== undefined ? { limit: catchUpLimit } : {}) } }
      : {}),
    ...(overlap ? { overlap } : {}),
    json,
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

function printResumeResult(
  io: CliIo,
  result: RunFlowResult,
  verb: "completed" | "resumed",
  repoPath: string,
): void {
  const absoluteRepoPath = resolve(repoPath);
  if (result.status === "awaiting-approval") {
    io.stdout(`RUN ${result.runId} awaiting approval`);
    if (result.approvalId) {
      io.stdout(`Approval: ${result.approvalId}`);
    }
    io.stdout(`Branch: ${result.branchName}`);
    io.stdout(`Worktree: ${result.worktreePath}`);
    io.stdout(
      `Status command: nitely status ${result.runId} --repo ${absoluteRepoPath}`,
    );
    io.stdout(
      `Run directory: ${join(absoluteRepoPath, ".nitely", "runs", result.runId)}`,
    );
    return;
  }
  io.stdout(`RUN ${result.runId} ${verb}`);
  io.stdout(`Branch: ${result.branchName}`);
  io.stdout(`Worktree: ${result.worktreePath}`);
  if (result.changeRequestUrl) {
    io.stdout(`Change request: ${result.changeRequestUrl}`);
  }
  io.stdout(
    `Status command: nitely status ${result.runId} --repo ${absoluteRepoPath}`,
  );
  io.stdout(
    `Run directory: ${join(absoluteRepoPath, ".nitely", "runs", result.runId)}`,
  );
}

function formatRunLookupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/run not found/i.test(message) && !/--repo/i.test(message)) {
    return `${message}; retry with --repo <path used for run>`;
  }
  return message;
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

function printApprovals(io: CliIo, approvals: ProjectedApproval[]): void {
  if (approvals.length === 0) {
    io.stdout("No approvals");
    return;
  }
  for (const approval of approvals) {
    io.stdout(
      `${approval.id}\t${approval.status}\t${approval.stageId}\tattempt ${approval.attempt}\t${approval.prompt}`,
    );
  }
}

function printQuestions(
  io: CliIo,
  questions: ProjectedOperatorQuestion[],
): void {
  if (questions.length === 0) {
    io.stdout("No questions");
    return;
  }
  for (const question of questions) {
    io.stdout(
      `${question.id}\t${question.status}\t${question.stageId}\tattempt ${question.attempt}\t${question.question}`,
    );
    for (const option of question.options) {
      io.stdout(
        `  ${option.id}\t${option.label}${option.recommended ? " (recommended)" : ""}`,
      );
    }
    if (question.answer) {
      io.stdout(
        `  answered by ${question.answer.actor}: ${question.answer.optionId ?? question.answer.text ?? ""}`,
      );
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
    blocker.questionId ? `question ${blocker.questionId}` : undefined,
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
  for (const item of result.pendingApprovals) {
    io.stdout(`Pending approval: ${item.commentId} route ${item.route} - ${item.reason}`);
  }
  io.stdout(`Skipped: ${result.skipped.length}`);
  for (const item of result.skipped) {
    io.stdout(`Skipped ${item.commentId}: ${item.reason}`);
  }
}

const reviewFeedbackRouteTargets = new Set([
  "implementation",
  "spec",
  "tech-design",
  "workflow",
  "memory",
]);

function parseRouteFlowOption(value: string): { route: string; flowPath: string } {
  const [route, ...flowPathParts] = value.split("=");
  const flowPath = flowPathParts.join("=").trim();
  const normalizedRoute = route?.trim();
  if (!normalizedRoute || !flowPath) {
    throw new Error(`invalid --route-flow value: ${value}`);
  }
  if (!reviewFeedbackRouteTargets.has(normalizedRoute)) {
    throw new Error(`unknown --route-flow route: ${normalizedRoute}`);
  }
  return { route: normalizedRoute, flowPath };
}

function parseRouteOverrideOption(value: string): {
  commentId: string;
  route: ReviewFeedbackRouteTarget;
} {
  const [commentId, ...routeParts] = value.split("=");
  const route = routeParts.join("=").trim();
  const normalizedCommentId = commentId?.trim();
  if (!normalizedCommentId || !route) {
    throw new Error(`invalid --route-override value: ${value}`);
  }
  if (!reviewFeedbackRouteTargets.has(route)) {
    throw new Error(`unknown --route-override route: ${route}`);
  }
  return {
    commentId: normalizedCommentId,
    route: route as ReviewFeedbackRouteTarget,
  };
}

function parsePositiveIntegerOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name} value: ${value}`);
  }
  return parsed;
}

function printTaskIssueSync(io: CliIo, result: SyncTaskIssuesResult): void {
  io.stdout("TASK ISSUES synced");
  io.stdout(`Repository: ${result.repository.owner}/${result.repository.repository}`);
  io.stdout(`Grouping: ${result.grouping}`);
  io.stdout(`Created: ${result.created}`);
  io.stdout(`Reused: ${result.reused}`);
  io.stdout(`Registry: ${result.registryPath}`);
  for (const entry of result.issues) {
    io.stdout(
      `${entry.outcome === "created" ? "Created" : "Reused"} ${entry.taskIds.join(", ")}: ${entry.issue.url}`,
    );
  }
}

interface RemoteTaskCreateInput {
  serverUrl: string;
  title: string;
  specPath: string;
  techDesignPath: string;
  issueUrl?: string;
  flowPath?: string;
  repoId?: string;
  apiToken?: string;
}

interface RemoteTaskSummary {
  id: string;
  status?: string;
  issueUrl?: string;
}

interface RemoteRunWatchState {
  runId: string;
  status: RemoteRunStatus;
  currentStage?: string;
  latestOutputSummary?: string;
  changeRequestUrl?: string;
  prUrl?: string;
}

interface RemoteProviderStatus {
  id: string;
  configured: boolean;
  message?: string;
}

interface RemoteGitHubIssueIntakeSmokeResult {
  issueUrl: string;
  taskId: string;
  title: string;
  hasBody: boolean;
  commentCount: number;
}

const GITHUB_ISSUE_INTAKE_CREDENTIAL_SKIP_MESSAGE =
  "GitHub provider credentials are not configured";

const GITHUB_ISSUE_INTAKE_CREDENTIAL_SETUP_HINT =
  "Configure NITELY_GITHUB_TOKEN, GITHUB_TOKEN, or the Web Console GitHub provider connection.";

function parseRemoteSchedulerRunPayload(payload: unknown): SchedulerRunSummary {
  const root = readJsonObject(payload);
  const summary = readJsonObject(root?.summary);
  if (!summary) {
    throw new Error("remote scheduler run failed: invalid response: missing summary");
  }
  const readStringArray = (key: keyof SchedulerRunSummary): string[] => {
    const value = summary[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  const taskErrors: NonNullable<SchedulerRunSummary["taskErrors"]> = {};
  for (const [taskId, value] of Object.entries(
    readJsonObject(summary.taskErrors) ?? {},
  )) {
    const taskError = readJsonObject(value);
    if (
      taskError?.code === "scheduler_task_processing_failed" &&
      taskError.message === "Scheduler could not process this Work item"
    ) {
      taskErrors[taskId] = {
        code: "scheduler_task_processing_failed",
        message: "Scheduler could not process this Work item",
      };
    }
  }
  return {
    startedTaskIds: readStringArray("startedTaskIds"),
    completedTaskIds: readStringArray("completedTaskIds"),
    failedTaskIds: readStringArray("failedTaskIds"),
    blockedTaskIds: readStringArray("blockedTaskIds"),
    cooldownTaskIds: readStringArray("cooldownTaskIds"),
    awaitingApprovalTaskIds: readStringArray("awaitingApprovalTaskIds"),
    ...(readJsonObject(summary.cooldownUntil)
      ? { cooldownUntil: summary.cooldownUntil as SchedulerRunSummary["cooldownUntil"] }
      : {}),
    ...(Object.keys(taskErrors).length > 0 ? { taskErrors } : {}),
    ...(readJsonObject(summary.preflight)
      ? {
          preflight: summary.preflight as SchedulerRunSummary["preflight"],
        }
      : {}),
    ...(readJsonObject(summary.specReadiness)
      ? {
          specReadiness: summary.specReadiness as SchedulerRunSummary["specReadiness"],
        }
      : {}),
  };
}

function parseRemoteProviderStatuses(payload: unknown): RemoteProviderStatus[] {
  const root = readJsonObject(payload);
  const providers = root?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("remote provider status failed: invalid response: missing providers");
  }
  return providers
    .map((provider) => {
      const item = readJsonObject(provider);
      if (typeof item?.id !== "string") return undefined;
      return {
        id: item.id,
        configured: item.configured === true,
        ...(typeof item.message === "string" ? { message: item.message } : {}),
      };
    })
    .filter((provider): provider is RemoteProviderStatus => provider !== undefined);
}

function parseGitHubIssueIntakeSmokePayload(
  payload: unknown,
  requestedIssueUrl: string,
): RemoteGitHubIssueIntakeSmokeResult {
  const root = readJsonObject(payload);
  const task = readJsonObject(root?.task);
  if (typeof task?.id !== "string" || !task.id) {
    throw new Error("remote GitHub issue intake smoke failed: invalid response: missing task.id");
  }
  const source = readJsonObject(task.source);
  if (source?.type !== "github-issue") {
    throw new Error("remote GitHub issue intake smoke failed: invalid response: missing github issue source");
  }
  const snapshot = readJsonObject(source.snapshot);
  if (!snapshot) {
    throw new Error("remote GitHub issue intake smoke failed: invalid response: missing source snapshot");
  }
  const issueUrl =
    typeof snapshot.uri === "string"
      ? snapshot.uri
      : typeof source.uri === "string"
        ? source.uri
        : requestedIssueUrl;
  const title = typeof snapshot.title === "string" ? snapshot.title.trim() : "";
  const body = typeof snapshot.body === "string" ? snapshot.body.trim() : "";
  if (!title) {
    throw new Error("remote GitHub issue intake smoke failed: invalid response: missing issue title");
  }
  if (!body) {
    throw new Error("remote GitHub issue intake smoke failed: invalid response: missing issue body");
  }
  const comments = Array.isArray(snapshot.comments) ? snapshot.comments : [];
  return {
    issueUrl,
    taskId: task.id,
    title,
    hasBody: Boolean(body),
    commentCount: comments.length,
  };
}

function printCurrentInstance(io: CliIo, instance: { serverUrl: string; apiToken?: string }): void {
  io.stdout(`Connected: ${instance.serverUrl}`);
  io.stdout(`API token: ${instance.apiToken ? "configured" : "not configured"}`);
}

async function runRemoteSchedulerOnce(input: {
  serverUrl: string;
  fetchImpl: FetchFunction;
  maxConcurrentTasks?: number;
  usageLimitCooldownMs?: number;
  apiToken?: string;
}): Promise<SchedulerRunSummary> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const headers = remoteRequestHeaders(
    input.apiToken,
    input.maxConcurrentTasks !== undefined || input.usageLimitCooldownMs !== undefined
      ? { "content-type": "application/json" }
      : undefined,
  );
  const response = await input.fetchImpl(`${serverUrl}/api/scheduler/run`, {
    method: "POST",
    ...(headers ? { headers } : {}),
    ...(input.maxConcurrentTasks !== undefined || input.usageLimitCooldownMs !== undefined
      ? {
          body: JSON.stringify({
            ...(input.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: input.maxConcurrentTasks } : {}),
            ...(input.usageLimitCooldownMs !== undefined ? { usageLimitCooldownMs: input.usageLimitCooldownMs } : {}),
          }),
        }
      : {}),
  });
  if (!response.ok) {
    throw new Error(
      `remote scheduler run failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("remote scheduler run failed: invalid JSON response");
  }
  return parseRemoteSchedulerRunPayload(payload);
}

interface SchedulerWindow {
  raw: string;
  startMinutes: number;
  endMinutes: number;
}

function parseSchedulerWindow(value: string): SchedulerWindow {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Invalid --window value, expected HH:MM-HH:MM");
  }
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    throw new Error("Invalid --window value, expected HH:MM-HH:MM");
  }
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (startMinutes === endMinutes) {
    throw new Error("Invalid --window value, start and end must differ");
  }
  return { raw: value, startMinutes, endMinutes };
}

function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function schedulerWindowActive(window: SchedulerWindow, now: Date): boolean {
  const current = localMinutes(now);
  if (window.startMinutes < window.endMinutes) {
    return current >= window.startMinutes && current < window.endMinutes;
  }
  return current >= window.startMinutes || current < window.endMinutes;
}

function schedulerIntervalMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const value = env.NITELY_SCHEDULER_INTERVAL_MS;
  return value
    ? parsePositiveIntegerOption("NITELY_SCHEDULER_INTERVAL_MS", value)
    : 60_000;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSchedulerWindowLoop(input: {
  window?: SchedulerWindow;
  daemon?: boolean;
  intervalMs: number;
  maxCycles?: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  runCycle: () => Promise<SchedulerRunSummary>;
  io: CliIo;
}): Promise<void> {
  if (!input.daemon && input.window && !schedulerWindowActive(input.window, input.now())) {
    input.io.stdout(`SCHEDULER window=${input.window.raw} inactive; no cycles run`);
    return;
  }
  input.io.stdout(
    `SCHEDULER ${input.daemon ? "daemon" : `window=${input.window?.raw}`} intervalMs=${input.intervalMs}`,
  );
  let cycle = 0;
  while (input.daemon || (input.window ? schedulerWindowActive(input.window, input.now()) : false)) {
    cycle += 1;
    input.io.stdout(`SCHEDULER cycle=${cycle}`);
    const summary = await input.runCycle();
    printSchedulerSummary(input.io, summary);
    if (input.maxCycles !== undefined && cycle >= input.maxCycles) {
      return;
    }
    const nextReset = Object.values(summary.cooldownUntil ?? {})
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value) && value > input.now().getTime())
      .sort((left, right) => left - right)[0];
    const resetDelay = nextReset === undefined
      ? input.intervalMs
      : Math.max(0, nextReset - input.now().getTime());
    await input.sleep(Math.min(input.intervalMs, resetDelay));
  }
}

async function runRemoteGitHubIssueIntakeSmoke(input: {
  serverUrl: string;
  issueUrl: string;
  fetchImpl: FetchFunction;
  apiToken?: string;
}): Promise<RemoteGitHubIssueIntakeSmokeResult | "skipped"> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const headers = remoteRequestHeaders(input.apiToken);
  const providerResponse = await input.fetchImpl(
    `${serverUrl}/api/providers`,
    headers ? { headers } : undefined,
  );
  if (!providerResponse.ok) {
    throw new Error(
      `remote provider status failed (HTTP ${providerResponse.status}): ${await remoteErrorMessage(providerResponse)}`,
    );
  }
  let providerPayload: unknown;
  try {
    providerPayload = await providerResponse.json();
  } catch {
    throw new Error("remote provider status failed: invalid JSON response");
  }
  const github = parseRemoteProviderStatuses(providerPayload).find(
    (provider) => provider.id === "github",
  );
  if (!github?.configured) {
    return "skipped";
  }

  const draftResponse = await input.fetchImpl(`${serverUrl}/api/draft-specs`, {
    method: "POST",
    headers: remoteRequestHeaders(input.apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      sourceType: "github-issue",
      issue: input.issueUrl,
    }),
  });
  if (!draftResponse.ok) {
    throw new Error(
      `remote GitHub issue intake smoke failed (HTTP ${draftResponse.status}): ${await remoteErrorMessage(draftResponse)}`,
    );
  }
  let draftPayload: unknown;
  try {
    draftPayload = await draftResponse.json();
  } catch {
    throw new Error("remote GitHub issue intake smoke failed: invalid JSON response");
  }
  return parseGitHubIssueIntakeSmokePayload(draftPayload, input.issueUrl);
}

function printSchedulerSummary(io: CliIo, summary: SchedulerRunSummary): void {
  io.stdout(`SCHEDULER started=${summary.startedTaskIds.length} completed=${summary.completedTaskIds.length} awaitingApproval=${summary.awaitingApprovalTaskIds.length} failed=${summary.failedTaskIds.length} blocked=${summary.blockedTaskIds.length}`);
  if (summary.startedTaskIds.length > 0) {
    io.stdout(`Started: ${summary.startedTaskIds.join(", ")}`);
  }
  if (summary.awaitingApprovalTaskIds.length > 0) {
    io.stdout(`Awaiting approval: ${summary.awaitingApprovalTaskIds.join(", ")}`);
  }
  if (summary.failedTaskIds.length > 0) {
    io.stdout(`Failed: ${summary.failedTaskIds.join(", ")}`);
  }
  if (summary.blockedTaskIds.length > 0) {
    io.stdout(`Blocked: ${summary.blockedTaskIds.join(", ")}`);
  }
  if ((summary.cooldownTaskIds?.length ?? 0) > 0) {
    io.stdout(`Cooling down: ${summary.cooldownTaskIds!.map((taskId) => {
      const until = summary.cooldownUntil?.[taskId];
      return until ? `${taskId} until ${until}` : taskId;
    }).join(", ")}`);
  }
  for (const taskId of Object.keys(summary.taskErrors ?? {}).sort()) {
    const taskError = summary.taskErrors?.[taskId];
    if (!taskError) continue;
    io.stdout(`Task error ${taskId}: ${taskError.code} - ${taskError.message}`);
  }
  for (const taskId of Object.keys(summary.preflight ?? {}).sort()) {
    const report = summary.preflight?.[taskId];
    if (!report || report.status === "PASS") continue;
    const issue = report.issues[0];
    const detail = issue ? ` - ${issue.message}` : "";
    io.stdout(`Preflight ${taskId}: ${report.status}${detail}`);
  }
  for (const taskId of Object.keys(summary.specReadiness ?? {}).sort()) {
    const readiness = summary.specReadiness?.[taskId];
    if (!readiness || readiness.status === "PASS") continue;
    const issue = readiness.issues[0];
    const detail = issue ? ` - ${issue.message}` : "";
    io.stdout(`Spec readiness ${taskId}: ${readiness.status}${detail}`);
  }
}

function printRunPreflightReport(io: CliIo, report: RunPreflightReport): void {
  io.stdout(
    `DOCTOR ${report.status} ${report.flowName ?? report.flowPath}: ${report.stageCount} stages, ${report.artifactCount} artifacts`,
  );
  if (report.requiredInputs.length > 0) {
    io.stdout(`Inputs: ${report.requiredInputs.join(", ")}`);
  }
  if (report.requiredProviders.length > 0) {
    io.stdout(`Providers: ${report.requiredProviders.join(", ")}`);
  }
  for (const issue of report.issues) {
    const scope = [
      issue.stageId ? `stage ${issue.stageId}` : undefined,
      issue.inputId ? `input ${issue.inputId}` : undefined,
      issue.providerId ? `provider ${issue.providerId}` : undefined,
    ].filter((part): part is string => part !== undefined).join(" ");
    io.stdout(
      `${issue.severity.toUpperCase()} ${issue.code}${scope ? ` ${scope}` : ""}: ${issue.message}`,
    );
  }
}

function printGitHubIssueIntakeSmokeResult(
  io: CliIo,
  result: RemoteGitHubIssueIntakeSmokeResult,
): void {
  io.stdout("SMOKE github-issue-intake ok");
  io.stdout(`Issue: ${result.issueUrl}`);
  io.stdout(`Task: ${result.taskId}`);
  io.stdout(
    `Source: ${result.title} (body=${result.hasBody ? "present" : "missing"} comments=${result.commentCount})`,
  );
}

function printGoldenPathDemoResult(io: CliIo, result: GoldenPathDemoResult): void {
  io.stdout("SMOKE golden-path ok");
  io.stdout(`Output: ${result.outputDir}`);
  io.stdout(`Task: ${result.taskId}`);
  io.stdout(`Implementation run: ${result.implementationRunId}`);
  io.stdout(`Draft PR: ${result.draftPullRequestUrl}`);
  io.stdout(`Rework run: ${result.reworkRunId}`);
  io.stdout(`Updated PR: ${result.updatedPullRequestUrl}`);
  const proofValues = Object.values(result.proof);
  const passedProofCount = proofValues.filter(Boolean).length;
  io.stdout(
    `Proof: ${passedProofCount}/${proofValues.length} passed (approved planning, eligible implementation start, verification/review, draft PR, evidence, same-PR rework)`,
  );
  io.stdout(`Evidence: ${result.implementationEvidencePath}`);
  io.stdout(`Evidence: ${result.reworkEvidencePath}`);
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

async function fetchRemoteRun(
  serverUrl: string,
  runId: string,
  fetchImpl: FetchFunction,
  apiToken?: string,
): Promise<RemoteRunWatchState> {
  const headers = remoteRequestHeaders(apiToken);
  const payload = await fetchRemoteJson(
    `${normalizeRemoteServerUrl(serverUrl)}/api/runs/${encodeURIComponent(runId)}`,
    fetchImpl,
    "remote run watch",
    headers ? { headers } : undefined,
  );
  return parseRemoteRunPayload(payload, runId);
}

async function fetchRemoteTaskLatestRunId(
  serverUrl: string,
  taskId: string,
  fetchImpl: FetchFunction,
  apiToken?: string,
): Promise<string> {
  const headers = remoteRequestHeaders(apiToken);
  const payload = await fetchRemoteJson(
    `${normalizeRemoteServerUrl(serverUrl)}/api/tasks/${encodeURIComponent(taskId)}`,
    fetchImpl,
    "remote task watch",
    headers ? { headers } : undefined,
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
  apiToken?: string;
}): Promise<number> {
  let previousLine = "";
  while (true) {
    const state = await fetchRemoteRun(
      input.serverUrl,
      input.runId,
      input.fetchImpl,
      input.apiToken,
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

async function parseRemoteWatchOptions(
  argv: string[],
  startIndex: number,
  env: Record<string, string | undefined>,
): Promise<{ serverUrl: string; intervalMs: number; apiToken?: string }> {
  let serverFlag = "";
  let intervalMs = 2000;
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server") {
      serverFlag = argv[++index] ?? "";
      if (!serverFlag) throw new Error("Missing value for --server");
      continue;
    }
    if (arg === "--interval-ms") {
      intervalMs = parsePositiveIntegerOption("--interval-ms", argv[++index] ?? "");
      continue;
    }
    throw new Error(`Unknown watch option: ${arg}`);
  }
  const target = await resolveRemoteTarget({
    env,
    ...(serverFlag ? { flag: serverFlag } : {}),
  });
  return {
    serverUrl: requireRemoteServerUrl(target.serverUrl),
    intervalMs,
    ...(target.apiToken ? { apiToken: target.apiToken } : {}),
  };
}

async function readTaskInputFile(optionName: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read ${optionName} file: ${message}`);
  }
}

export const TASK_COMMAND_USAGE =
  "Usage: nitely task plan [--server <url>] (--prompt <text> | --prompt-file <path> | --issue <url> | --jira <ref> | --document-url <url> --document-file <path>) [--conversation <path>] [--title <title>] [--guidance <text>] [--repo-id <id>] [--json] | nitely task create [--server <url>] --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>] | nitely task list [--server <url>] [--json] | nitely task approve-spec|draft-tech-design|approve-tech-design|refresh-source-planning|start <task-id> [--server <url>] [--json] | nitely task watch <task-id> [--server <url>] [--interval-ms <n>]";

class TaskCommandUsageError extends Error {}

interface TaskCreateOptions {
  serverFlag: string;
  title: string;
  specPath: string;
  techDesignPath: string;
  issue?: string;
  jira?: string;
  prompt?: string;
  promptPath?: string;
  documentUrl?: string;
  documentBody?: string;
  documentPath?: string;
  documentVersion?: string;
  conversationPath?: string;
  guidance?: string;
  flowPath?: string;
  templateId?: string;
  repoId?: string;
  asJson: boolean;
}

function parseTaskCreateOptions(argv: string[], label: string): TaskCreateOptions {
  const options: TaskCreateOptions = {
    serverFlag: "",
    title: "",
    specPath: "",
    techDesignPath: "",
    asJson: false,
  };
  const valueOptions: Record<string, keyof TaskCreateOptions> = {
    "--server": "serverFlag",
    "--title": "title",
    "--spec": "specPath",
    "--tech-design": "techDesignPath",
    "--issue": "issue",
    "--jira": "jira",
    "--prompt": "prompt",
    "--prompt-file": "promptPath",
    "--document-url": "documentUrl",
    "--document-body": "documentBody",
    "--document-file": "documentPath",
    "--document-version": "documentVersion",
    "--conversation": "conversationPath",
    "--guidance": "guidance",
    "--flow": "flowPath",
    "--template": "templateId",
    "--repo-id": "repoId",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      options.asJson = true;
      continue;
    }
    const key = valueOptions[arg];
    if (!key) {
      throw new TaskCommandUsageError(`Unknown ${label} option: ${arg}`);
    }
    const value = argv[++index] ?? "";
    if (!value) throw new Error(`Missing value for ${arg}`);
    (options as unknown as Record<string, unknown>)[key] = value;
  }
  return options;
}

async function readTaskConversationFile(path: string): Promise<unknown[]> {
  const raw = await readTaskInputFile("--conversation", path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("--conversation file must contain JSON");
  }
  const turns = Array.isArray(parsed)
    ? parsed
    : readJsonObject(parsed)?.turns;
  if (!Array.isArray(turns)) {
    throw new Error(
      "--conversation file must contain an array of turns or an object with a turns array",
    );
  }
  return turns;
}

interface TaskIntakeSelection {
  sourceType: RemoteIntakeSourceType;
  prompt?: string;
  text?: string;
  issue?: string;
  documentUrl?: string;
  documentVersion?: string;
  conversation?: unknown[];
}

/**
 * Decide whether this invocation is artifact-first task creation or planning
 * intake, and read whatever local files the chosen intake source needs.
 * Returns undefined when the caller supplied spec and technical-design paths,
 * which keeps the original file-based `task create` contract intact.
 */
async function resolveTaskIntake(
  options: TaskCreateOptions,
  requireIntake: boolean,
): Promise<TaskIntakeSelection | undefined> {
  const intakeFlags = [
    options.prompt !== undefined ? "--prompt" : undefined,
    options.promptPath !== undefined ? "--prompt-file" : undefined,
    options.jira !== undefined ? "--jira" : undefined,
    options.documentUrl !== undefined ? "--document-url" : undefined,
    options.conversationPath !== undefined ? "--conversation" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  const artifactFirst = Boolean(options.specPath || options.techDesignPath);
  if (artifactFirst) {
    if (intakeFlags.length > 0) {
      throw new TaskCommandUsageError(
        `${intakeFlags.join(", ")} cannot be combined with --spec or --tech-design. ${TASK_COMMAND_USAGE}`,
      );
    }
    if (requireIntake) {
      throw new TaskCommandUsageError(
        `task plan creates a draft task from one intake source; use task create for --spec and --tech-design. ${TASK_COMMAND_USAGE}`,
      );
    }
    return undefined;
  }
  const conversation = options.conversationPath
    ? await readTaskConversationFile(options.conversationPath)
    : undefined;
  const sources = [
    options.prompt !== undefined || options.promptPath !== undefined
      ? "prompt"
      : undefined,
    options.issue !== undefined ? "issue" : undefined,
    options.jira !== undefined ? "jira" : undefined,
    options.documentUrl !== undefined ? "document" : undefined,
  ].filter((source): source is string => source !== undefined);
  if (sources.length > 1) {
    throw new TaskCommandUsageError(
      `Choose one intake source, not ${sources.length}. ${TASK_COMMAND_USAGE}`,
    );
  }
  if (sources.length === 0) {
    if (conversation) {
      return { sourceType: "prompt", conversation };
    }
    throw new TaskCommandUsageError(
      requireIntake
        ? `task plan requires one intake source. ${TASK_COMMAND_USAGE}`
        : `task create requires --spec and --tech-design, or one intake source. ${TASK_COMMAND_USAGE}`,
    );
  }
  const [source] = sources;
  if (source === "issue") {
    return {
      sourceType: "github-issue",
      issue: options.issue ?? "",
      ...(conversation ? { conversation } : {}),
    };
  }
  if (source === "jira") {
    return {
      sourceType: "jira-ticket",
      issue: options.jira ?? "",
      ...(conversation ? { conversation } : {}),
    };
  }
  if (source === "document") {
    if (options.documentBody === undefined && options.documentPath === undefined) {
      throw new TaskCommandUsageError(
        `--document-url requires --document-file or --document-body so the snapshot can be stored and hashed. ${TASK_COMMAND_USAGE}`,
      );
    }
    if (options.documentBody !== undefined && options.documentPath !== undefined) {
      throw new TaskCommandUsageError(
        `Choose --document-file or --document-body, not both. ${TASK_COMMAND_USAGE}`,
      );
    }
    const text = options.documentPath
      ? await readTaskInputFile("--document-file", options.documentPath)
      : (options.documentBody ?? "");
    return {
      sourceType: "external-document",
      documentUrl: options.documentUrl ?? "",
      text,
      ...(options.documentVersion
        ? { documentVersion: options.documentVersion }
        : {}),
    };
  }
  const prompt = options.promptPath
    ? await readTaskInputFile("--prompt-file", options.promptPath)
    : (options.prompt ?? "");
  return {
    sourceType: "prompt",
    prompt,
    ...(conversation ? { conversation } : {}),
  };
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
    headers: remoteRequestHeaders(input.apiToken, {
      "content-type": "application/json",
    }),
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

interface RemoteFlowSummary {
  id: string;
  name?: string;
  source?: string;
  runnable?: boolean;
}

async function listRemoteFlows(
  input: { serverUrl: string; apiToken?: string },
  fetchImpl: FetchFunction,
): Promise<unknown[]> {
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const headers = remoteRequestHeaders(input.apiToken);
  const response = await fetchImpl(
    `${serverUrl}/api/flows`,
    headers ? { headers } : {},
  );
  if (!response.ok) {
    throw new Error(
      `remote flow list failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("remote flow list failed: invalid JSON response");
  }
  const flows = readJsonObject(payload)?.flows;
  if (!Array.isArray(flows)) {
    throw new Error("remote flow list failed: invalid response: missing flows");
  }
  return flows;
}

function remoteFlowSummary(value: unknown): RemoteFlowSummary | undefined {
  const record = readJsonObject(value);
  if (typeof record?.id !== "string" || !record.id) return undefined;
  return {
    id: record.id,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.runnable === "boolean" ? { runnable: record.runnable } : {}),
  };
}

function printRemoteFlows(io: CliIo, flows: unknown[]): void {
  if (flows.length === 0) {
    io.stdout("No flows");
    return;
  }
  for (const entry of flows) {
    const flow = remoteFlowSummary(entry);
    if (!flow) continue;
    const source = flow.source ?? "unknown";
    const runnable = flow.runnable === false ? "blocked" : "runnable";
    io.stdout(`${flow.id}  ${source}  ${runnable}  ${flow.name ?? flow.id}`);
  }
  io.stdout("Pass an id above to nitely task create --flow <id>.");
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

function isApiTokenCapability(value: string): value is ApiTokenCapability {
  return API_TOKEN_CAPABILITIES.includes(value as ApiTokenCapability);
}

function printApiTokens(io: CliIo, tokens: ApiTokenRecord[]): void {
  if (tokens.length === 0) {
    io.stdout("No API tokens");
    return;
  }
  for (const token of tokens) {
    io.stdout(
      `${token.id}\t${token.revokedAt ? "revoked" : "active"}\t${token.name}\t${token.capabilities.join(",")}\t${token.ownerUserId ?? "unowned"}`,
    );
  }
}

const EVIDENCE_USAGE =
  "Usage: nitely evidence policy|search|export|prune ...";

function retentionDaysLabel(value: number | null): string {
  return value === null ? "indefinite" : `${value}d`;
}

function publicEvidencePruneAction(action: EvidencePruneAction) {
  return {
    runId: action.runId,
    category: action.category,
    retainedDays: action.retainedDays,
    cutoff: action.cutoff,
    runTimestamp: action.runTimestamp,
    targetCount: action.paths.length,
    ...(action.eventCount !== undefined
      ? { eventCount: action.eventCount }
      : {}),
  };
}

function publicEvidencePrunePlan(plan: EvidencePrunePlan) {
  return {
    mode: plan.mode,
    repoPath: plan.repoPath,
    evaluatedAt: plan.evaluatedAt,
    policy: plan.policy,
    actions: plan.actions.map(publicEvidencePruneAction),
  };
}

function publicEvidencePruneApplyResult(result: EvidencePruneApplyResult) {
  return {
    mode: result.mode,
    repoPath: result.repoPath,
    evaluatedAt: result.evaluatedAt,
    applied: result.applied.map(publicEvidencePruneAction),
    skipped: result.skipped.map((entry) => ({
      action: publicEvidencePruneAction(entry.action),
      reason: entry.reason,
    })),
  };
}

async function runEvidenceCli(argv: string[], io: CliIo): Promise<number> {
  const action = argv[1];
  if (
    action !== "policy" &&
    action !== "search" &&
    action !== "export" &&
    action !== "prune"
  ) {
    io.stderr(EVIDENCE_USAGE);
    return 1;
  }

  if (action === "policy") {
    let repoPath = ".";
    let json = false;
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--repo") {
        repoPath = argv[++index] ?? "";
        if (!repoPath) {
          io.stderr("Missing value for --repo");
          return 1;
        }
        continue;
      }
      if (arg === "--json") {
        json = true;
        continue;
      }
      io.stderr(`Unknown evidence policy option: ${arg}`);
      return 1;
    }
    try {
      const policy = await loadEvidencePolicy(repoPath);
      if (json) {
        io.stdout(JSON.stringify(policy, null, 2));
        return 0;
      }
      io.stdout(`EVIDENCE POLICY valid (${policy.source})`);
      io.stdout(`Path: ${policy.path}`);
      io.stdout(
        `Configured: runs=${retentionDaysLabel(policy.retention.runsDays)} events=${retentionDaysLabel(policy.retention.eventsDays)} logs=${retentionDaysLabel(policy.retention.logsDays)} artifacts=${retentionDaysLabel(policy.retention.artifactsDays)} evidence=${retentionDaysLabel(policy.retention.evidenceDays)}`,
      );
      io.stdout(
        `Effective: runs=${retentionDaysLabel(policy.effectiveRetention.runsDays)} events=${retentionDaysLabel(policy.effectiveRetention.eventsDays)} logs=${retentionDaysLabel(policy.effectiveRetention.logsDays)} artifacts=${retentionDaysLabel(policy.effectiveRetention.artifactsDays)} evidence=${retentionDaysLabel(policy.effectiveRetention.evidenceDays)}`,
      );
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (action === "search") {
    let repoPath = ".";
    let json = false;
    const filters: EvidenceSearchFilters = {};
    const filterOptions: Record<string, keyof EvidenceSearchFilters> = {
      "--run": "run",
      "--task": "task",
      "--repository": "repository",
      "--flow": "flow",
      "--status": "status",
      "--pr": "pr",
      "--blocker": "blocker",
      "--from": "from",
      "--to": "to",
      "--artifact": "artifact",
    };
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index] as string;
      if (arg === "--repo") {
        repoPath = argv[++index] ?? "";
        if (!repoPath) {
          io.stderr("Missing value for --repo");
          return 1;
        }
        continue;
      }
      if (arg === "--json") {
        json = true;
        continue;
      }
      const filter = filterOptions[arg];
      if (filter) {
        const value = argv[++index] ?? "";
        if (!value) {
          io.stderr(`Missing value for ${arg}`);
          return 1;
        }
        filters[filter] = value;
        continue;
      }
      io.stderr(`Unknown evidence search option: ${arg}`);
      return 1;
    }
    try {
      const runs = await searchEvidenceRuns(repoPath, filters);
      if (json) {
        io.stdout(JSON.stringify(runs, null, 2));
        return 0;
      }
      if (runs.length === 0) {
        io.stdout("No evidence runs");
        return 0;
      }
      io.stdout("RUN\tSTATUS\tUPDATED\tTASK\tREPOSITORY\tFLOW\tPR\tBLOCKER");
      for (const run of runs) {
        io.stdout([
          run.runId,
          run.status,
          run.terminalAt ?? run.updatedAt,
          run.taskId ?? "",
          run.repositoryName ?? run.repositoryId ?? "",
          run.flowName ?? "",
          run.prUrl ?? "",
          run.blockerCategory ?? "",
        ].join("\t"));
      }
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (action === "export") {
    let repoPath = ".";
    let outputPath = "";
    let includeRaw = false;
    const runIds: string[] = [];
    for (let index = 2; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--repo") {
        repoPath = argv[++index] ?? "";
        if (!repoPath) {
          io.stderr("Missing value for --repo");
          return 1;
        }
        continue;
      }
      if (arg === "--run") {
        const runId = argv[++index] ?? "";
        if (!runId) {
          io.stderr("Missing value for --run");
          return 1;
        }
        runIds.push(runId);
        continue;
      }
      if (arg === "--output") {
        outputPath = argv[++index] ?? "";
        if (!outputPath) {
          io.stderr("Missing value for --output");
          return 1;
        }
        continue;
      }
      if (arg === "--include-raw") {
        includeRaw = true;
        continue;
      }
      io.stderr(`Unknown evidence export option: ${arg}`);
      return 1;
    }
    if (runIds.length === 0 || !outputPath) {
      io.stderr(
        "Usage: nitely evidence export --repo <path> --run <run-id> [--run <run-id> ...] --output <directory> [--include-raw]",
      );
      return 1;
    }
    try {
      const result = await exportEvidenceBundle({
        repoPath,
        runIds,
        outputPath,
        includeRaw,
      });
      io.stdout(
        `EVIDENCE EXPORT ${result.rawIncluded ? "sensitive-raw-opt-in" : "metadata-only"}`,
      );
      io.stdout(`Output: ${result.outputPath}`);
      io.stdout(`Runs: ${result.runIds.join(", ")}`);
      io.stdout(`Files: ${result.files.length}`);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  let repoPath = ".";
  let at: Date | undefined;
  let apply = false;
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      repoPath = argv[++index] ?? "";
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      continue;
    }
    if (arg === "--at") {
      const value = argv[++index] ?? "";
      at = new Date(value);
      if (!value || !Number.isFinite(at.getTime())) {
        io.stderr(`Invalid value for --at: ${value}`);
        return 1;
      }
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    io.stderr(`Unknown evidence prune option: ${arg}`);
    return 1;
  }
  try {
    const plan = await buildEvidencePrunePlan({
      repoPath,
      ...(at ? { now: at } : {}),
    });
    if (apply) {
      const result = await applyEvidencePrunePlan(plan);
      if (json) {
        io.stdout(JSON.stringify(publicEvidencePruneApplyResult(result), null, 2));
      } else {
        io.stdout(
          `EVIDENCE PRUNE APPLIED: ${result.applied.length} applied, ${result.skipped.length} skipped`,
        );
        for (const skipped of result.skipped) {
          io.stdout(`SKIPPED\t${skipped.action.runId}\t${skipped.action.category}\t${skipped.reason}`);
        }
      }
      return result.skipped.length > 0 ? 1 : 0;
    }
    if (json) {
      io.stdout(JSON.stringify(publicEvidencePrunePlan(plan), null, 2));
      return 0;
    }
    io.stdout(`EVIDENCE PRUNE DRY-RUN: ${plan.actions.length} action(s)`);
    for (const pruneAction of plan.actions) {
      io.stdout(
        `${pruneAction.runId}\t${pruneAction.category}\t${pruneAction.paths.length} target(s)\tcutoff ${pruneAction.cutoff}`,
      );
    }
    io.stdout("No changes applied. Review the plan and re-run with --apply to prune.");
    return 0;
  } catch {
    io.stderr(
      "Evidence prune failed safely; sensitive path details were omitted.",
    );
    return 1;
  }
}

type NitelyCliCommand = CliCommand<{
  argv: string[];
  io: CliIo;
  dependencies: CliDependencies;
}>;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stageInputIds(stage: Record<string, unknown>): string[] {
  return Array.isArray(stage.inputs)
    ? stage.inputs.filter((value): value is string => typeof value === "string")
    : [];
}

function pathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" ||
    !(relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath));
}

async function inputReferencesFromDirectory(
  directory: string,
  ids: string[],
): Promise<RunFlowInput["inputs"]> {
  const root = resolve(directory);
  const manifest = new Map<string, string>();
  try {
    const parsed = JSON.parse(await readFile(join(root, "artifact.json"), "utf8")) as unknown;
    const outputs = recordValue(parsed)?.outputs;
    if (Array.isArray(outputs)) {
      for (const output of outputs) {
        const entry = recordValue(output);
        if (typeof entry?.id === "string" && typeof entry.path === "string") {
          const path = resolve(root, entry.path);
          if (!pathInside(root, path)) {
            throw new Error(`artifact input path escapes directory: ${entry.path}`);
          }
          manifest.set(entry.id, path);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const references: RunFlowInput["inputs"] = {};
  for (const id of ids) {
    const candidate = manifest.get(id) ?? join(root, id);
    try {
      await readFile(candidate);
    } catch {
      throw new Error(`missing stage input "${id}" in ${root}`);
    }
    references[id] = { connector: "local-file", uri: candidate };
  }
  return references;
}

async function readSingleStageFlow(input: {
  flowPath: string;
  stageId: string;
}): Promise<{ document: string; stage: Record<string, unknown>; inputIds: string[] }> {
  const raw = JSON.parse(await readFile(input.flowPath, "utf8")) as unknown;
  const root = recordValue(raw);
  const spec = recordValue(root?.spec);
  const stages = spec?.stages;
  if (!root || !spec || !Array.isArray(stages)) {
    throw new Error("flow document must contain spec.stages");
  }
  const stage = stages
    .map(recordValue)
    .find((candidate) => candidate?.id === input.stageId);
  if (!stage) throw new Error(`stage not found: ${input.stageId}`);
  const metadata = recordValue(root.metadata) ?? {};
  const document = JSON.stringify({
    ...root,
    metadata: {
      ...metadata,
      name: `${String(metadata.name ?? "flow")}-${input.stageId}-replay`,
    },
    spec: { ...spec, stages: [stage] },
  });
  return { document, stage, inputIds: stageInputIds(stage) };
}

function printStageDryRun(
  io: CliIo,
  loaded: ReturnType<typeof parseFlowDocument>,
  stageInputs: RunFlowInput["inputs"],
): void {
  const stage = loaded.flow.spec.stages[0]!;
  const runtime = "runtimes" in stage
    ? (stage.runtimes ?? []).map((candidate) => `${candidate.runtime}${candidate.model ? `/${candidate.model}` : ""}`).join(", ")
    : "runtime" in stage
      ? `${stage.runtime}${stage.model ? `/${stage.model}` : ""}`
      : undefined;
  io.stdout(`FLOW ${loaded.flow.metadata.name}`);
  io.stdout(`STAGE ${stage.id}`);
  io.stdout(`TYPE ${stage.type}`);
  if (runtime) io.stdout(`RUNTIME ${runtime}`);
  if ("command" in stage) io.stdout(`COMMAND ${stage.command}`);
  io.stdout(`INPUTS ${stage.inputs.length > 0 ? stage.inputs.join(", ") : "none"}`);
  io.stdout(`OUTPUTS ${stage.outputs.map((output) => typeof output === "string" ? output : output.id).join(", ") || "none"}`);
  io.stdout(`ATTEMPTS ${stage.maxAttempts ?? loaded.flow.spec.maxAttempts ?? 1}`);
  for (const id of stage.inputs) {
    io.stdout(`INPUT ${id} ${stageInputs[id]?.uri ?? "<provide with --input or --input-dir>"}`);
  }
  io.stdout("ACTION dry-run only; no worktree, publish, or external PR will be created");
}

const CLI_COMMANDS: NitelyCliCommand[] = [
  {
    name: "doctor",
    usage: [
      "  doctor <flow> --repo <path> [--input <name>=<path>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const flowPath = argv[1];
      if (!flowPath) {
        io.stderr("Usage: nitely doctor <flow> --repo <path> [--input <name>=<path>]");
        return 1;
      }
      let repoPath = ".";
      const inputs: EvaluateRunPreflightInput["inputs"] = {};
      try {
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--input") {
            const [name, reference] = parseRunInput(argv[++index] ?? "");
            inputs[name] = reference;
            continue;
          }
          io.stderr(`Unknown doctor option: ${arg}`);
          return 1;
        }
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
      try {
        const report = await (dependencies.evaluateRunPreflight ?? evaluateRunPreflight)({
          repoPath,
          flowPath,
          inputs,
        });
        printRunPreflightReport(io, report);
        return report.status === "BLOCK" ? 1 : 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "validate",
    usage: [
      "  validate <flow> [--external-input <name>]",
    ],
    run: async ({ argv, io, dependencies }) => {
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
        for (const message of lintFlowProduction(flow)) {
          io.stdout(`[warning] ${message}`);
        }
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

    },
  },
  {
    name: "graph",
    usage: [
      "  graph <flow> [--format text|mermaid|json] [--external-input <name>]",
    ],
    run: async ({ argv, io }) => {
      const path = argv[1];
      if (!path) {
        io.stderr(
          "Usage: nitely graph <flow> [--format text|mermaid|json] [--external-input <name>]",
        );
        return 1;
      }
      const externalInputs: string[] = [];
      let format: FlowGraphFormat = "text";
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--format") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --format");
            return 1;
          }
          if (value !== "text" && value !== "mermaid" && value !== "json") {
            io.stderr(
              `Unknown graph format: ${value} (expected text, mermaid, or json)`,
            );
            return 1;
          }
          format = value;
          continue;
        }
        if (arg === "--external-input") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --external-input");
            return 1;
          }
          externalInputs.push(value);
          continue;
        }
        io.stderr(`Unknown graph option: ${arg}`);
        return 1;
      }

      try {
        const { flow, graph } = await loadFlow(path, { externalInputs });
        io.stdout(formatFlowGraph(flow, graph, { format }));
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
    },
  },
  {
    name: "run-stage",
    usage: [
      "  run-stage <flow> <stage-id> [--repo <path>] [--input <name>=<path>] [--input-dir <path>] [--dry-run] [--backend local|mise|oci]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const flowPath = argv[1];
      const stageId = argv[2];
      if (!flowPath || !stageId) {
        io.stderr("Usage: nitely run-stage <flow> <stage-id> [--repo <path>] [--input <name>=<path>] [--input-dir <path>] [--dry-run] [--backend local|mise|oci]");
        return 1;
      }

      let repoPath = ".";
      let inputDirectory: string | undefined;
      let dryRun = false;
      let executionBackend: string | undefined;
      const inputs: RunFlowInput["inputs"] = {};
      try {
        for (let index = 3; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--input") {
            const [name, reference] = parseRunInput(argv[++index] ?? "");
            inputs[name] = reference;
            continue;
          }
          if (arg === "--input-dir") {
            const value = argv[++index] ?? "";
            if (!value) throw new Error("Missing value for --input-dir");
            inputDirectory = resolve(value);
            continue;
          }
          if (arg === "--dry-run") {
            dryRun = true;
            continue;
          }
          if (arg === "--backend") {
            executionBackend = argv[++index] ?? "";
            if (!executionBackend) throw new Error("Missing value for --backend");
            continue;
          }
          io.stderr(`Unknown run-stage option: ${arg}`);
          return 1;
        }

        const replay = await readSingleStageFlow({ flowPath, stageId });
        const loaded = parseFlowDocument(replay.document, {
          externalInputs: replay.inputIds,
        });
        if (inputDirectory) {
          Object.assign(
            inputs,
            await inputReferencesFromDirectory(
              inputDirectory,
              replay.inputIds.filter((id) => inputs[id] === undefined),
            ),
          );
        }
        if (dryRun) {
          printStageDryRun(io, loaded, inputs);
          return 0;
        }
        for (const inputId of replay.inputIds) {
          if (!inputs[inputId]) {
            throw new Error(`missing stage input "${inputId}"; use --input or --input-dir`);
          }
        }
        const stage = loaded.flow.spec.stages[0]!;
        if (["approval", "publish-change", "update-change", "sync-change"].includes(stage.type)) {
          throw new Error(`run-stage cannot execute side-effect stage type: ${stage.type}`);
        }
        const result = await (dependencies.runFlow ?? runFlow)({
          flowPath,
          flowDocument: replay.document,
          repoPath,
          inputs,
          ...(executionBackend ? { executionBackend } : {}),
        });
        printResumeResult(io, result, "completed", repoPath);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
    },
  },
  {
    name: "clarify-spec",
    usage: [
      "  clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]",
    ],
    run: async ({ argv, io, dependencies }) => {
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

    },
  },
  {
    name: "tasks-to-issues",
    usage: [
      "  tasks-to-issues --repo <path> --tasks <path> --spec <path> --plan <path> [--group-by task|phase]",
    ],
    run: async ({ argv, io, dependencies }) => {
      let repoPath = ".";
      let tasksPath = "";
      let specPath = "";
      let planPath = "";
      let grouping: "task" | "phase" = "task";
      try {
        for (let index = 1; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--tasks") {
            tasksPath = argv[++index] ?? "";
            if (!tasksPath) throw new Error("Missing value for --tasks");
            continue;
          }
          if (arg === "--spec") {
            specPath = argv[++index] ?? "";
            if (!specPath) throw new Error("Missing value for --spec");
            continue;
          }
          if (arg === "--plan") {
            planPath = argv[++index] ?? "";
            if (!planPath) throw new Error("Missing value for --plan");
            continue;
          }
          if (arg === "--group-by") {
            const value = argv[++index] ?? "";
            if (value !== "task" && value !== "phase") {
              throw new Error(`invalid --group-by value: ${value}`);
            }
            grouping = value;
            continue;
          }
          throw new Error(`Unknown tasks-to-issues option: ${arg}`);
        }
        if (!tasksPath) throw new Error("Missing --tasks");
        if (!specPath) throw new Error("Missing --spec");
        if (!planPath) throw new Error("Missing --plan");
        const result = await (dependencies.syncTaskIssues ?? syncTaskIssues)({
          repoPath,
          tasksPath,
          specPath,
          planPath,
          grouping,
          env: dependencies.env ?? process.env,
        });
        printTaskIssueSync(io, result);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "skill",
    matches: (argv) => argv[1] === "import" || argv[1] === "improvements",
    usage: [
      "  skill import <path> --repo <path> [--overwrite]",
      "  skill improvements list|confirm|propose|decide|evaluate --repo <path>",
    ],
    run: async ({ argv, io, dependencies }) => {
      if (argv[1] === "improvements") {
        const action = argv[2] ?? "list";
        let repoPath = ".";
        let actor = "operator";
        let reason: string | undefined;
        let reportPath = "";
        let problem = "";
        let minimalDiff = "";
        let expectedBehavior = "";
        let evalCasesPath = "";
        const targetId = ["confirm", "decide", "evaluate"].includes(action) ? argv[3] : undefined;
        const decisionValue = action === "decide" ? argv[4] : undefined;
        const optionStart = action === "list" || action === "propose" ? 3 : action === "decide" ? 5 : 4;
        for (let index = optionStart; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--actor") {
            actor = argv[++index] ?? "";
            if (!actor) throw new Error("Missing value for --actor");
            continue;
          }
          if (arg === "--reason") {
            reason = argv[++index] ?? "";
            if (!reason) throw new Error("Missing value for --reason");
            continue;
          }
          if (arg === "--report") {
            reportPath = argv[++index] ?? "";
            if (!reportPath) throw new Error("Missing value for --report");
            continue;
          }
          if (arg === "--problem") {
            problem = argv[++index] ?? "";
            if (!problem) throw new Error("Missing value for --problem");
            continue;
          }
          if (arg === "--minimal-diff") {
            minimalDiff = argv[++index] ?? "";
            if (!minimalDiff) throw new Error("Missing value for --minimal-diff");
            continue;
          }
          if (arg === "--expected-behavior") {
            expectedBehavior = argv[++index] ?? "";
            if (!expectedBehavior) throw new Error("Missing value for --expected-behavior");
            continue;
          }
          if (arg === "--eval-cases") {
            evalCasesPath = argv[++index] ?? "";
            if (!evalCasesPath) throw new Error("Missing value for --eval-cases");
            continue;
          }
          throw new Error(`Unknown skill improvements option: ${arg}`);
        }
        await mkdir(join(resolve(repoPath), ".nitely"), { recursive: true });
        if (action === "list") {
          const store = new SkillImprovementStore(skillImprovementStorePath(repoPath));
          try {
            io.stdout(JSON.stringify({ observations: store.listObservations(), proposals: store.listProposals() }, null, 2));
            return 0;
          } finally {
            store.close();
          }
        }
        const eventStore = new EventStore(eventStorePath(repoPath));
        try {
        if (action === "propose") {
          if (!problem || !minimalDiff || !expectedBehavior) {
            throw new Error("propose requires --problem, --minimal-diff, and --expected-behavior");
          }
          let evalCases: Parameters<typeof reconcileSkillImprovementProposals>[0]["evalCases"];
          if (evalCasesPath) {
            const parsed: unknown = JSON.parse(await readFile(resolve(evalCasesPath), "utf8"));
            if (!Array.isArray(parsed) || parsed.some((entry) => {
              if (typeof entry !== "object" || entry === null) return true;
              const record = entry as Record<string, unknown>;
              return typeof record.id !== "string" || typeof record.before !== "string" ||
                typeof record.after !== "string" || (record.source !== "pinned-#429" && record.source !== "generated");
            })) {
              throw new Error("--eval-cases must point to a JSON array of eval cases");
            }
            evalCases = parsed as NonNullable<typeof evalCases>;
          }
          const proposals = await reconcileSkillImprovementProposals({
            repoPath,
            author: actor,
            problem,
            minimalDiff,
            expectedBehavior,
            ...(reason ? { risks: [reason] } : {}),
            ...(evalCases ? { evalCases } : {}),
            eventStore,
          });
          io.stdout(JSON.stringify(proposals, null, 2));
          return 0;
        }
        if (!targetId) throw new Error("Missing skill papercut or proposal id");
        if (action === "confirm") {
          const confirmed = await confirmSkillPapercut({ repoPath, id: targetId, actor, eventStore });
          io.stdout(`SKILL PAPERCUT confirmed ${confirmed.id}`);
          return 0;
        }
        if (action === "decide") {
          const decision = decisionValue;
          if (decision !== "accept" && decision !== "reject" && decision !== "suppress") {
            throw new Error("Decision must be accept, reject, or suppress");
          }
          const proposal = await decideStoredSkillImprovementProposal({
            repoPath,
            proposalId: targetId,
            decision,
            actor,
            ...(reason ? { reason } : {}),
            eventStore,
          });
          io.stdout(`SKILL PROPOSAL ${proposal.id} ${proposal.status}`);
          return 0;
        }
        if (action === "evaluate") {
          if (!reportPath) throw new Error("evaluate requires --report");
          const reportValue: unknown = JSON.parse(await readFile(resolve(reportPath), "utf8"));
          if (!isEvalCohortReport(reportValue)) throw new Error("--report must be a nitely.eval-report.v1 document");
          const result = await evaluateStoredSkillImprovementProposal({
            repoPath,
            proposalId: targetId,
            report: reportValue,
            eventStore,
          });
          io.stdout(JSON.stringify(result, null, 2));
          return result.decision.allowed ? 0 : 1;
        }
        throw new Error(`Unknown skill improvements action: ${action}`);
        } finally {
          eventStore.close();
        }
      }
      const sourcePath = argv[2];
      if (!sourcePath) {
        io.stderr("Usage: nitely skill import <path> --repo <path> [--overwrite]");
        return 1;
      }
      let repoPath = "";
      let overwrite = false;
      try {
        for (let index = 3; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--overwrite") {
            overwrite = true;
            continue;
          }
          throw new Error(`Unknown skill import option: ${arg}`);
        }
        if (!repoPath) {
          throw new Error("Missing --repo");
        }
        const imported = await importLocalSkill({
          sourcePath,
          repoPath,
          overwrite,
        });
        io.stdout(`SKILL imported ${imported.id}`);
        io.stdout(`Target: ${imported.targetPath}`);
        io.stdout(`Hash: ${imported.contentHash}`);
        io.stdout(`Resources: ${imported.resourceCount}`);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "run",
    usage: [
      "  run <flow> --repo <path> [--config <key=value>] [--backend local|mise|oci]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const flowPath = argv[1];
      if (!flowPath) {
        io.stderr("Usage: nitely run <flow> --repo <path> --input <name>=<path> [--config <key=value>] [--task-scope <input>:<scope>] [--backend local|mise|oci]");
        return 1;
      }

      let repoPath = ".";
      const inputs: RunFlowInput["inputs"] = {};
      const configuration: NonNullable<RunFlowInput["configuration"]> = {};
      let taskScope: RunFlowInput["taskScope"];
      let executionBackend: string | undefined;
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
          if (arg === "--config") {
            const [name, value] = parseRunConfig(argv[++index] ?? "");
            configuration[name] = value;
            continue;
          }
          if (arg === "--task-scope") {
            taskScope = parseTaskScopeOption(argv[++index] ?? "");
            continue;
          }
          if (arg === "--backend") {
            executionBackend = argv[++index] ?? "";
            if (!executionBackend) {
              throw new Error("Missing value for --backend");
            }
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
          ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
          ...(taskScope ? { taskScope } : {}),
          ...(executionBackend ? { executionBackend } : {}),
        });
        printResumeResult(io, result, "completed", repoPath);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "approvals",
    usage: [
      "  approvals <run-id>",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      if (!runId) {
        io.stderr("Usage: nitely approvals <run-id> [--repo <path>]");
        return 1;
      }
      const { repoPath, nextIndex } = parseRepoOption(argv, 2);
      if (nextIndex < argv.length) {
        io.stderr(`Unknown approvals option: ${argv[nextIndex]}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      try {
        const approvals = await (dependencies.listApprovals ?? listApprovals)(
          repoPath,
          runId,
        );
        printApprovals(io, approvals);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "approve",
    usage: [
      "  approve <run-id> <approval-id> [--actor <name>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      const approvalId = argv[2];
      if (!runId || !approvalId) {
        io.stderr(
          `Usage: nitely ${argv[0]} <run-id> <approval-id> [--repo <path>] [--actor <name>]`,
        );
        return 1;
      }
      let repoPath = ".";
      let actor: string | undefined;
      for (let index = 3; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--actor") {
          actor = argv[++index] ?? "";
          continue;
        }
        io.stderr(`Unknown ${argv[0]} option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      if (actor === "") {
        io.stderr("Missing value for --actor");
        return 1;
      }
      try {
        const decision = argv[0] === "approve" ? "approved" : "denied";
        const approval = await (dependencies.resolveApproval ?? resolveApproval)({
          repoPath,
          runId,
          approvalId,
          decision,
          ...(actor ? { actor } : {}),
        });
        io.stdout(`APPROVAL ${approval.id} ${approval.status}`);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "deny",
    usage: [
      "  deny <run-id> <approval-id> [--actor <name>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      const approvalId = argv[2];
      if (!runId || !approvalId) {
        io.stderr(
          `Usage: nitely ${argv[0]} <run-id> <approval-id> [--repo <path>] [--actor <name>]`,
        );
        return 1;
      }
      let repoPath = ".";
      let actor: string | undefined;
      for (let index = 3; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--actor") {
          actor = argv[++index] ?? "";
          continue;
        }
        io.stderr(`Unknown ${argv[0]} option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      if (actor === "") {
        io.stderr("Missing value for --actor");
        return 1;
      }
      try {
        const decision = argv[0] === "approve" ? "approved" : "denied";
        const approval = await (dependencies.resolveApproval ?? resolveApproval)({
          repoPath,
          runId,
          approvalId,
          decision,
          ...(actor ? { actor } : {}),
        });
        io.stdout(`APPROVAL ${approval.id} ${approval.status}`);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "questions",
    usage: [
      "  questions <run-id>",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      if (!runId) {
        io.stderr("Usage: nitely questions <run-id> [--repo <path>]");
        return 1;
      }
      const { repoPath, nextIndex } = parseRepoOption(argv, 2);
      if (nextIndex < argv.length) {
        io.stderr(`Unknown questions option: ${argv[nextIndex]}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      try {
        const questions = await (dependencies.listQuestions ?? listQuestions)(
          repoPath,
          runId,
        );
        printQuestions(io, questions);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "answer",
    usage: [
      "  answer <run-id> <question-id> (--option <id> | --text <answer>) [--actor <name>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      const questionId = argv[2];
      if (!runId || !questionId) {
        io.stderr(
          "Usage: nitely answer <run-id> <question-id> (--option <id> | --text <answer>) [--repo <path>] [--actor <name>]",
        );
        return 1;
      }
      let repoPath = ".";
      let actor: string | undefined;
      let optionId: string | undefined;
      let text: string | undefined;
      for (let index = 3; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--actor") {
          actor = argv[++index] ?? "";
          continue;
        }
        if (arg === "--option") {
          optionId = argv[++index] ?? "";
          continue;
        }
        if (arg === "--text") {
          text = argv[++index] ?? "";
          continue;
        }
        io.stderr(`Unknown answer option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      if (actor === "") {
        io.stderr("Missing value for --actor");
        return 1;
      }
      if ((optionId ? 1 : 0) + (text ? 1 : 0) !== 1) {
        io.stderr("Exactly one of --option or --text is required");
        return 1;
      }
      try {
        const question = await (dependencies.answerQuestion ?? answerQuestion)({
          repoPath,
          runId,
          questionId,
          answer: {
            ...(optionId ? { optionId } : {}),
            ...(text ? { text } : {}),
          },
          ...(actor ? { actor } : {}),
        });
        io.stdout(`QUESTION ${question.id} ${question.status}`);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "review-verdict",
    usage: [
      "  review-verdict <run-id> --file <review.md> --actor <name> --reviewed-artifact <id> [--reviewed-artifact <id> ...]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      if (!runId) {
        io.stderr(
          "Usage: nitely review-verdict <run-id> --file <review.md> --actor <name> --reviewed-artifact <id> [--reviewed-artifact <id> ...] [--repo <path>]",
        );
        return 1;
      }
      let repoPath = ".";
      let file = "";
      let actor = "";
      const reviewedArtifactIds: string[] = [];
      for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index] ?? "";
          continue;
        }
        if (arg === "--file") {
          file = argv[++index] ?? "";
          continue;
        }
        if (arg === "--actor") {
          actor = argv[++index] ?? "";
          continue;
        }
        if (arg === "--reviewed-artifact") {
          reviewedArtifactIds.push(argv[++index] ?? "");
          continue;
        }
        io.stderr(`Unknown review-verdict option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      if (!file) {
        io.stderr("Missing value for --file");
        return 1;
      }
      if (!actor) {
        io.stderr("Missing value for --actor");
        return 1;
      }
      if (reviewedArtifactIds.some((artifactId) => !artifactId)) {
        io.stderr("Missing value for --reviewed-artifact");
        return 1;
      }
      if (reviewedArtifactIds.length === 0) {
        io.stderr("At least one --reviewed-artifact is required");
        return 1;
      }
      try {
        const content = await readFile(resolve(file), "utf8");
        const gate = await (
          dependencies.submitOperatorReview ?? submitOperatorReview
        )({
          repoPath,
          runId,
          actor,
          content,
          mediaType: file.toLowerCase().endsWith(".txt")
            ? "text/plain"
            : "text/markdown",
          reviewedArtifactIds,
        });
        io.stdout(
          `REVIEW VERDICT ${gate.stageId} attempt ${gate.attempt ?? "unknown"} ${gate.status}`,
        );
        io.stdout(`Actor: ${gate.operatorReview?.actor ?? actor}`);
        io.stdout(`Reviewed artifacts: ${(gate.reviewedArtifacts ?? []).join(", ")}`);
        if (gate.reviewOutput?.verdict) {
          io.stdout(`Verdict: ${gate.reviewOutput.verdict.verdict}`);
        }
        if (gate.reviewOutput?.path) {
          io.stdout(`Evidence: ${gate.reviewOutput.path}`);
        }
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "rework-pr",
    usage: [
      "  rework-pr <pr-url-or-number> --repo <path> --flow <flow>",
    ],
    run: async ({ argv, io, dependencies }) => {
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
        printResumeResult(io, result, "completed", repoPath);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "pr-comments",
    usage: [
      "  pr-comments <pr-url-or-number> --repo <path> --flow <flow>",
    ],
    run: async ({ argv, io, dependencies }) => {
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
      let maxReworkAttempts: number | undefined;
      let approveRequiredRoutes = false;
      const routeFlowPaths: NonNullable<ProcessPullRequestCommentsInput["routeFlowPaths"]> = {};
      const routeOverrides: NonNullable<ProcessPullRequestCommentsInput["routeOverrides"]> = {};
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
        if (arg === "--route-flow") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --route-flow");
            return 1;
          }
          try {
            const parsed = parseRouteFlowOption(value);
            routeFlowPaths[parsed.route as keyof typeof routeFlowPaths] = parsed.flowPath;
          } catch (error) {
            io.stderr(error instanceof Error ? error.message : String(error));
            return 1;
          }
          continue;
        }
        if (arg === "--route-override") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --route-override");
            return 1;
          }
          try {
            const parsed = parseRouteOverrideOption(value);
            routeOverrides[parsed.commentId] = parsed.route;
          } catch (error) {
            io.stderr(error instanceof Error ? error.message : String(error));
            return 1;
          }
          continue;
        }
        if (arg === "--dry-run") {
          dryRun = true;
          continue;
        }
        if (arg === "--approve-required-routes") {
          approveRequiredRoutes = true;
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
        if (arg === "--max-rework-attempts") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --max-rework-attempts");
            return 1;
          }
          try {
            maxReworkAttempts = parsePositiveIntegerOption("--max-rework-attempts", value);
          } catch (error) {
            io.stderr(error instanceof Error ? error.message : String(error));
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
          ...(Object.keys(routeFlowPaths).length > 0 ? { routeFlowPaths } : {}),
          ...(Object.keys(routeOverrides).length > 0 ? { routeOverrides } : {}),
          ...(dryRun ? { dryRun } : {}),
          ...(allowAuthors.length > 0 ? { allowAuthors } : {}),
          ...(botLogin ? { botLogin } : {}),
          ...(priorRunId ? { priorRunId } : {}),
          ...(maxReworkAttempts !== undefined ? { maxReworkAttempts } : {}),
          ...(approveRequiredRoutes ? { approveRequiredRoutes } : {}),
        });
        printPrCommentsResult(io, result);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "scheduler",
    usage: [
      "  scheduler [--repo <path>] [--window HH:MM-HH:MM] [--daemon] [--once] [--server <url>] [--interval-ms <n>] [--max-cycles <n>] [--max-concurrent-tasks <n>] [--usage-limit-cooldown-ms <n>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      let repoPath = ".";
      let once = false;
      let daemon = false;
      let window: string | undefined;
      const env = dependencies.env ?? process.env;
      let serverFlag = "";
      let intervalMs = schedulerIntervalMsFromEnv(env);
      let maxCycles: number | undefined;
      let maxConcurrentTasks: number | undefined;
      let usageLimitCooldownMs: number | undefined;
      try {
        for (let index = 1; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            continue;
          }
          if (arg === "--server") {
            serverFlag = argv[++index] ?? "";
            if (!serverFlag) throw new Error("Missing value for --server");
            continue;
          }
          if (arg === "--once") {
            once = true;
            continue;
          }
          if (arg === "--daemon") {
            daemon = true;
            continue;
          }
          if (arg === "--window") {
            window = argv[++index] ?? "";
            continue;
          }
          if (arg === "--interval-ms") {
            intervalMs = parsePositiveIntegerOption("--interval-ms", argv[++index] ?? "");
            continue;
          }
          if (arg === "--max-cycles") {
            maxCycles = parsePositiveIntegerOption("--max-cycles", argv[++index] ?? "");
            continue;
          }
          if (arg === "--max-concurrent-tasks") {
            maxConcurrentTasks = resolveMaxConcurrentTasks(
              parsePositiveIntegerOption(
                "--max-concurrent-tasks",
                argv[++index] ?? "",
              ),
            );
            continue;
          }
          if (arg === "--usage-limit-cooldown-ms") {
            usageLimitCooldownMs = parsePositiveIntegerOption(
              "--usage-limit-cooldown-ms",
              argv[++index] ?? "",
            );
            if (usageLimitCooldownMs < 1_000 || usageLimitCooldownMs > 86_400_000) {
              throw new Error("--usage-limit-cooldown-ms must be between 1000 and 86400000");
            }
            continue;
          }
          io.stderr(`Unknown scheduler option: ${arg}`);
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
        const parsedWindow = window ? parseSchedulerWindow(window) : undefined;
        // A saved instance never switches scheduler from local to remote. Remote
        // cycles require an explicit --server or NITELY_SERVER_URL.
        const explicitServer = serverFlag || (env.NITELY_SERVER_URL ?? "");
        const remote = explicitServer
          ? await resolveRemoteTarget({ env, flag: explicitServer })
          : { serverUrl: undefined, apiToken: undefined };
        const runCycle = async () =>
          remote.serverUrl
            ? await runRemoteSchedulerOnce({
              serverUrl: remote.serverUrl,
              fetchImpl: dependencies.fetch ?? fetch,
              ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
              ...(usageLimitCooldownMs !== undefined ? { usageLimitCooldownMs } : {}),
              ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
            })
            : await (dependencies.runSchedulerOnce ?? runSchedulerOnce)({
              repoPath,
              ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
              ...(usageLimitCooldownMs !== undefined ? { usageLimitCooldownMs } : {}),
            });
        if (!once && (parsedWindow || daemon)) {
          await runSchedulerWindowLoop({
            ...(parsedWindow ? { window: parsedWindow } : {}),
            ...(daemon ? { daemon: true } : {}),
            intervalMs,
            ...(maxCycles !== undefined ? { maxCycles } : {}),
            now: dependencies.now ?? (() => new Date()),
            sleep: dependencies.sleep ?? defaultSleep,
            runCycle,
            io,
          });
          return 0;
        }
        if (!once) {
          io.stdout(
            "No scheduler window configured; running one cycle. Use --window HH:MM-HH:MM for continuous mode.",
          );
        }
        const summary = await runCycle();
        printSchedulerSummary(io, summary);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "schedule",
    usage: [
      "  schedule create --name <name> (--cron <expr> | --every <duration> | --at <iso>) --title <title> --spec-file <path> --tech-design-file <path> [--timezone <iana>] [--flow <path>] [--admission auto|review] [--misfire skip|run_once_now|catch_up] [--catch-up-limit <n>] [--overlap allow|skip|queue] [--repo <path>] [--json]",
      "  schedule list [--repo <path>] [--json]",
      "  schedule pause|resume|delete <schedule-id> [--repo <path>]",
      "  schedule tick [--repo <path>] [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const sub = argv[1];
      const now = dependencies.now ?? (() => new Date());
      const fail = (message: string): number => {
        io.stderr(message);
        return 1;
      };
      try {
        if (sub === "create") {
          const options = parseScheduleCreateOptions(argv.slice(2), now());
          const schedule = await createSchedule(
            options.repoPath,
            {
              name: options.name,
              trigger: options.trigger,
              timezone: options.timezone,
              template: {
                title: options.title,
                spec: await readFile(options.specFile, "utf8"),
                techDesign: await readFile(options.techDesignFile, "utf8"),
                ...(options.flowPath ? { flowPath: options.flowPath } : {}),
              },
              ...(options.admission ? { admission: options.admission } : {}),
              ...(options.misfire ? { misfire: options.misfire } : {}),
              ...(options.overlap ? { overlap: options.overlap } : {}),
            },
            { now },
          );
          if (options.json) {
            io.stdout(JSON.stringify({ schedule }, null, 2));
          } else {
            io.stdout(`Created schedule ${schedule.id} (${schedule.name}); next run ${schedule.nextRunAt ?? "none"}`);
          }
          return 0;
        }
        if (sub === "list") {
          const { repoPath, nextIndex } = parseRepoOption(argv, 2);
          const json = argv[nextIndex] === "--json";
          if (!json && nextIndex < argv.length) return fail(`Unknown schedule option: ${argv[nextIndex]}`);
          const schedules = await listSchedules(repoPath);
          if (json) {
            io.stdout(JSON.stringify({ schedules }, null, 2));
          } else if (schedules.length === 0) {
            io.stdout("No schedules.");
          } else {
            for (const schedule of schedules) {
              io.stdout(
                `${schedule.id}\t${schedule.name}\t${describeTrigger(schedule.trigger)} ${schedule.timezone}\t${
                  schedule.enabled ? (schedule.completedAt ? "completed" : "enabled") : "paused"
                }\tmisfire ${schedule.misfire.policy}${schedule.misfire.limit !== undefined ? `(${schedule.misfire.limit})` : ""}\toverlap ${schedule.overlap}\tnext ${schedule.nextRunAt ?? "-"}\tlast ${schedule.lastRunAt ?? "-"}`,
              );
            }
          }
          return 0;
        }
        if (sub === "pause" || sub === "resume" || sub === "delete") {
          const id = argv[2];
          if (!id || id.startsWith("--")) return fail(`Usage: nitely schedule ${sub} <schedule-id> [--repo <path>]`);
          const { repoPath, nextIndex } = parseRepoOption(argv, 3);
          if (nextIndex < argv.length) return fail(`Unknown schedule option: ${argv[nextIndex]}`);
          if (sub === "delete") {
            await deleteSchedule(repoPath, id);
            io.stdout(`Deleted schedule ${id}; its occurrences and tasks are kept.`);
            return 0;
          }
          const schedule = await setScheduleEnabled(repoPath, id, sub === "resume", { now });
          io.stdout(
            `${sub === "resume" ? "Resumed" : "Paused"} schedule ${schedule.id}; next run ${schedule.nextRunAt ?? "none"}`,
          );
          return 0;
        }
        if (sub === "tick") {
          const { repoPath, nextIndex } = parseRepoOption(argv, 2);
          const json = argv[nextIndex] === "--json";
          if (!json && nextIndex < argv.length) return fail(`Unknown schedule option: ${argv[nextIndex]}`);
          const result = await materializeDueSchedules({ repoPath, now });
          if (json) {
            io.stdout(JSON.stringify(result, null, 2));
          } else if (result.fired.length === 0) {
            io.stdout("No schedules due.");
          } else {
            for (const occurrence of result.fired) {
              io.stdout(`${occurrence.scheduleId}\t${occurrence.intendedFireAt}\t${occurrence.status}\ttask ${occurrence.workItemId ?? "-"}`);
            }
          }
          return 0;
        }
        return fail("Usage: nitely schedule <create|list|pause|resume|delete|tick> ...");
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    name: "smoke",
    usage: [
      "  smoke github-issue-intake [--server <url>] --issue <github-issue-url>",
      "  smoke golden-path [--output <dir>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const action = argv[1];
      if (action !== "github-issue-intake" && action !== "golden-path") {
        io.stderr(
          "Usage: nitely smoke github-issue-intake [--server <url>] --issue <github-issue-url> | nitely smoke golden-path [--output <dir>]",
        );
        return 1;
      }

      if (action === "golden-path") {
        let outputDir = "";
        try {
          for (let index = 2; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === "--output") {
              outputDir = argv[++index] ?? "";
              if (!outputDir) throw new Error("Missing value for --output");
              continue;
            }
            io.stderr(`Unknown smoke option: ${arg}`);
            return 1;
          }
          const result = await (dependencies.runGoldenPathDemo ?? runGoldenPathDemo)({
            outputDir: outputDir ? resolve(outputDir) : resolve(".nitely/demo/golden-path"),
          });
          printGoldenPathDemoResult(io, result);
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      const env = dependencies.env ?? process.env;
      let serverFlag = "";
      let issueUrl = "";
      try {
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--server") {
            serverFlag = argv[++index] ?? "";
            if (!serverFlag) throw new Error("Missing value for --server");
            continue;
          }
          if (arg === "--issue") {
            issueUrl = argv[++index] ?? "";
            if (!issueUrl) throw new Error("Missing value for --issue");
            continue;
          }
          io.stderr(`Unknown smoke option: ${arg}`);
          return 1;
        }
        const remote = await resolveRemoteTarget({
          env,
          ...(serverFlag ? { flag: serverFlag } : {}),
        });
        const serverUrl = requireRemoteServerUrl(remote.serverUrl);
        if (!issueUrl) throw new Error("Missing value for --issue");
        const result = await runRemoteGitHubIssueIntakeSmoke({
          serverUrl,
          issueUrl,
          fetchImpl: dependencies.fetch ?? fetch,
          ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
        });
        if (result === "skipped") {
          io.stdout(
            `SMOKE github-issue-intake skipped: ${GITHUB_ISSUE_INTAKE_CREDENTIAL_SKIP_MESSAGE} on ${normalizeRemoteServerUrl(serverUrl)}. ${GITHUB_ISSUE_INTAKE_CREDENTIAL_SETUP_HINT}`,
          );
          return 0;
        }
        printGitHubIssueIntakeSmokeResult(io, result);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "pilot",
    usage: [
      "  pilot setup-report --repo <path> --flow <flow> --runtime <id> --verify-command <cmd> [--output <path>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const action = argv[1];
      if (action !== "setup-report") {
        io.stderr(
          "Usage: nitely pilot setup-report --repo <path> --flow <flow> --runtime <id> --verify-command <cmd> [--output <path>]",
        );
        return 1;
      }

      let repoPath = ".";
      let flowPath = "";
      let outputPath = "";
      let packageManager = "";
      const runtimes: string[] = [];
      const verifyCommands: string[] = [];
      try {
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--flow") {
            flowPath = argv[++index] ?? "";
            if (!flowPath) throw new Error("Missing value for --flow");
            continue;
          }
          if (arg === "--output") {
            outputPath = argv[++index] ?? "";
            if (!outputPath) throw new Error("Missing value for --output");
            continue;
          }
          if (arg === "--runtime") {
            const runtime = argv[++index] ?? "";
            if (!runtime) throw new Error("Missing value for --runtime");
            runtimes.push(runtime);
            continue;
          }
          if (arg === "--verify-command") {
            const command = argv[++index] ?? "";
            if (!command) throw new Error("Missing value for --verify-command");
            verifyCommands.push(command);
            continue;
          }
          if (arg === "--package-manager") {
            packageManager = argv[++index] ?? "";
            if (!packageManager) throw new Error("Missing value for --package-manager");
            continue;
          }
          io.stderr(`Unknown pilot setup-report option: ${arg}`);
          return 1;
        }
        if (!flowPath) {
          throw new Error("Missing value for --flow");
        }
        const reportPath = outputPath ? resolve(outputPath) : defaultPilotSetupReportPath(repoPath);
        const reportInput: GeneratePilotSetupReportInput = {
          repoPath,
          flowPath,
          outputPath: reportPath,
          runtimes: runtimes.length > 0 ? runtimes : ["codex"],
          verifyCommands,
          env: dependencies.env ?? process.env,
          ...(packageManager ? { packageManager } : {}),
        };
        const report = await (dependencies.generatePilotSetupReport ?? generatePilotSetupReport)(
          reportInput,
        );
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, report.markdown, "utf8");
        io.stdout(`PILOT SETUP ${report.ready ? "ready" : "blocked"}`);
        io.stdout(`Report: ${reportPath}`);
        if (!report.ready) {
          const failing = report.checks
            .filter((check) => check.status === "fail")
            .map((check) => check.id);
          io.stdout(`Failing checks: ${failing.join(", ")}`);
          return 1;
        }
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "repo-index",
    usage: [
      "  repo-index build --repo <path>",
      "  repo-index query --repo <path> <target> [--limit <n>] [--run <run-id> --stage <stage-id> --attempt <n>]",
    ],
    run: async ({ argv, io, dependencies }) => {
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

    },
  },
  {
    name: "knowledge-repo",
    usage: [
      "  knowledge-repo attach --repo <path> --id <id> --name <name> --source <path-or-github-url> --ref <ref> [--include <glob>] [--exclude <glob>] [--required] [--embedding-provider <id>] [--embedding-model <model>] [--json]",
      "  knowledge-repo list --repo <path> [--json]",
      "  knowledge-repo status --repo <path> --id <id> [--json]",
      "  knowledge-repo refresh --repo <path> --id <id> [--json]",
      "  knowledge-repo query --repo <path> --query <text> [--attachment <id>] [--limit <n>] [--json]",
      "  knowledge-repo detach --repo <path> --id <id> [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      return await runKnowledgeRepositoryCli(
        argv.slice(1),
        io,
        dependencies.knowledgeRepositories,
      );

    },
  },
  {
    name: "auth",
    usage: [
      "  auth login --server <url> --capability <cap> [--allow-high-impact] [--no-browser]",
      "  auth logout",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;

      if (argv[1] === "logout") {
        if (argv.length > 2) {
          io.stderr(`Unknown auth logout option: ${argv[2]}`);
          return 1;
        }
        try {
          await clearCurrentInstance(env);
          io.stdout("Signed out locally.");
          io.stdout(
            "The API token is still valid on the server; revoke it in the Web Console or with nitely mcp token revoke.",
          );
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      if (argv[1] !== "login") {
        io.stderr(
          "Usage: nitely auth login --server <url> --capability <cap> | nitely auth logout",
        );
        return 1;
      }

      let serverUrl = env.NITELY_SERVER_URL ?? "";
      const capabilities: ApiTokenCapability[] = [];
      let allowHighImpact = false;
      let useBrowser = true;
      let accessToken: string | undefined;

      try {
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--server") {
            serverUrl = argv[++index] ?? "";
            if (!serverUrl) throw new Error("Missing value for --server");
            continue;
          }
          if (arg === "--capability") {
            const capability = argv[++index] ?? "";
            if (!capability) throw new Error("Missing value for --capability");
            if (!isApiTokenCapability(capability)) {
              throw new Error(`Unknown API token capability: ${capability}`);
            }
            capabilities.push(capability);
            continue;
          }
          if (arg === "--allow-high-impact") {
            allowHighImpact = true;
            continue;
          }
          if (arg === "--no-browser") {
            useBrowser = false;
            continue;
          }
          throw new Error(`Unknown auth login option: ${arg}`);
        }
        if (!serverUrl) throw new Error("Missing --server or NITELY_SERVER_URL");
        if (capabilities.length === 0) {
          throw new Error("At least one --capability is required");
        }

        const clientName = `cli@${hostname()}`;
        const deps = {
          fetchImpl: dependencies.fetch ?? fetch,
          ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        };

        const authorization = await requestDeviceAuthorization(
          { serverUrl, capabilities, allowHighImpact, clientName },
          deps,
        );

        io.stderr(`Open ${authorization.verificationUriComplete}`);
        io.stderr(`and confirm the code ${authorization.userCode}`);
        if (useBrowser) {
          (dependencies.openBrowser ?? defaultOpenBrowser)(
            authorization.verificationUriComplete,
          );
        }
        io.stderr("Waiting for approval...");

        const issued = await pollForDeviceToken(
          {
            serverUrl,
            deviceCode: authorization.deviceCode,
            intervalSeconds: authorization.interval,
            expiresInSeconds: authorization.expiresIn,
          },
          deps,
        );
        accessToken = issued.accessToken;

        const path = await writeCurrentInstance(env, {
          serverUrl,
          apiToken: issued.accessToken,
        });

        io.stdout(`Signed in to ${normalizeRemoteServerUrl(serverUrl)}`);
        io.stdout(`Token: ${issued.tokenId} (${issued.name})`);
        io.stdout(`Capabilities: ${issued.capabilities.join(", ")}`);
        io.stdout(`Saved to ${path}`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Every branch is redacted, including DeviceFlowError. No construction
        // of it can embed the token today, but its messages are the ones most
        // likely to start quoting something the server said, and an exemption
        // that has to be re-audited on every future edit is not a safe default.
        io.stderr(redactSecret(message, accessToken, env.NITELY_API_TOKEN));
        return 1;
      }
    },
  },
  {
    name: "connect",
    usage: [
      "  connect --server <url>  # token from NITELY_API_TOKEN",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;
      let serverUrl = env.NITELY_SERVER_URL ?? "";
      try {
        for (let index = 1; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--server") {
            serverUrl = argv[++index] ?? "";
            if (!serverUrl) throw new Error("Missing value for --server");
            continue;
          }
          throw new Error(`Unknown connect option: ${arg}`);
        }
        if (!serverUrl) throw new Error("Missing --server or NITELY_SERVER_URL");
        const apiToken = env.NITELY_API_TOKEN?.trim();
        const instance = {
          serverUrl,
          ...(apiToken ? { apiToken } : {}),
        };
        await writeCurrentInstance(env, instance);
        printCurrentInstance(io, {
          serverUrl: normalizeRemoteServerUrl(serverUrl),
          ...(apiToken ? { apiToken } : {}),
        });
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(redactSecret(message, env.NITELY_API_TOKEN));
        return 1;
      }

    },
  },
  {
    name: "whoami",
    usage: [
      "  whoami",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;
      if (argv.length > 1) {
        io.stderr(`Unknown whoami option: ${argv[1]}`);
        return 1;
      }
      try {
        const saved = await readCurrentInstance(env);
        if (!saved) {
          io.stderr("Not connected. Run nitely connect --server <url>.");
          return 1;
        }
        printCurrentInstance(io, saved);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "disconnect",
    usage: [
      "  disconnect",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;
      if (argv.length > 1) {
        io.stderr(`Unknown disconnect option: ${argv[1]}`);
        return 1;
      }
      try {
        await clearCurrentInstance(env);
        io.stdout("Disconnected");
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "flow",
    usage: [
      "  flow list [--server <url>] [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      if (argv[1] !== "list") {
        io.stderr("Usage: nitely flow list [--server <url>] [--json]");
        return 1;
      }

      const env = dependencies.env ?? process.env;
      let serverFlag = "";
      let asJson = false;
      let resolvedApiToken: string | undefined;
      try {
        for (let index = 2; index < argv.length; index += 1) {
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
          io.stderr(`Unknown flow list option: ${arg}`);
          return 1;
        }
        const remote = await resolveRemoteTarget({
          env,
          ...(serverFlag ? { flag: serverFlag } : {}),
        });
        resolvedApiToken = remote.apiToken;
        const serverUrl = requireRemoteServerUrl(remote.serverUrl);
        const flows = await listRemoteFlows(
          {
            serverUrl,
            ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
          },
          dependencies.fetch ?? fetch,
        );
        if (asJson) {
          io.stdout(JSON.stringify({ flows }));
        } else {
          printRemoteFlows(io, flows);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
        return 1;
      }

    },
  },
  {
    name: "task",
    usage: [
      "  task plan [--server <url>] (--prompt <text> | --prompt-file <path> | --issue <url> | --jira <ref> | --document-url <url> --document-file <path>) [--conversation <path>] [--title <title>] [--guidance <text>] [--document-version <v>] [--flow <path>] [--template <id>] [--repo-id <id>] [--json]",
      "  task create [--server <url>] --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>]",
      "  task list [--server <url>] [--json]",
      "  task approve-spec <task-id> [--server <url>] [--json]",
      "  task draft-tech-design <task-id> [--server <url>] [--json]",
      "  task approve-tech-design <task-id> [--server <url>] [--json]",
      "  task refresh-source-planning <task-id> [--server <url>] [--json]",
      "  task start <task-id> [--server <url>] [--json]",
      "  task watch <task-id> [--server <url>] [--interval-ms <n>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const action = argv[1];
      const remoteTaskActions = {
        "approve-spec": {
          route: "approve-spec",
          label: "remote task approve-spec",
          usage: "Usage: nitely task approve-spec <task-id> [--server <url>] [--json]",
          print: (target: CliIo, payload: unknown, taskId: string) =>
            printRemoteTaskApproval(target, payload, taskId, "specStatus", "spec"),
        },
        "approve-tech-design": {
          route: "approve-tech-design",
          label: "remote task approve-tech-design",
          usage: "Usage: nitely task approve-tech-design <task-id> [--server <url>] [--json]",
          print: (target: CliIo, payload: unknown, taskId: string) =>
            printRemoteTaskApproval(
              target,
              payload,
              taskId,
              "techDesignStatus",
              "tech-design",
            ),
        },
        "draft-tech-design": {
          route: "draft-tech-design",
          label: "remote task draft-tech-design",
          usage:
            "Usage: nitely task draft-tech-design <task-id> [--server <url>] [--json]",
          print: (target: CliIo, payload: unknown, taskId: string) =>
            printRemoteTaskDraftTechDesign(target, payload, taskId),
        },
        "refresh-source-planning": {
          route: "refresh-source-planning",
          label: "remote task refresh-source-planning",
          usage:
            "Usage: nitely task refresh-source-planning <task-id> [--server <url>] [--json]",
          print: (target: CliIo, payload: unknown, taskId: string) =>
            printRemoteTaskApproval(target, payload, taskId, "specStatus", "spec"),
        },
        start: {
          route: "runs",
          label: "remote task start",
          usage: "Usage: nitely task start <task-id> [--server <url>] [--json]",
          print: (target: CliIo, payload: unknown) => printRemoteRunStart(target, payload),
        },
      } as const;
      const remoteTaskAction =
        action && action in remoteTaskActions
          ? remoteTaskActions[action as keyof typeof remoteTaskActions]
          : undefined;
      if (
        action !== "create" &&
        action !== "plan" &&
        action !== "watch" &&
        action !== "list" &&
        !remoteTaskAction
      ) {
        io.stderr(TASK_COMMAND_USAGE);
        return 1;
      }

      const env = dependencies.env ?? process.env;
      if (remoteTaskAction) {
        const taskId = argv[2];
        if (!taskId || taskId.startsWith("--")) {
          io.stderr(remoteTaskAction.usage);
          return 1;
        }
        return await runRemoteTaskActionCommand({
          argv,
          startIndex: 3,
          taskId,
          usage: remoteTaskAction.usage,
          env,
          fetchImpl: dependencies.fetch ?? fetch,
          io,
          route: remoteTaskAction.route,
          label: remoteTaskAction.label,
          print: remoteTaskAction.print,
        });
      }
      if (action === "list") {
        return await runRemoteListCommand({
          argv,
          startIndex: 2,
          usage: "Usage: nitely task list [--server <url>] [--json]",
          env,
          fetchImpl: dependencies.fetch ?? fetch,
          io,
          allowStatusFilter: false,
          fetchItems: listRemoteTasks,
          jsonKey: "tasks",
          print: (target, items) => printRemoteTaskList(target, items),
        });
      }
      if (action === "watch") {
        const taskId = argv[2];
        if (!taskId) {
          io.stderr("Usage: nitely task watch <task-id> [--server <url>] [--interval-ms <n>]");
          return 1;
        }
        try {
          const options = await parseRemoteWatchOptions(argv, 3, env);
          const fetchImpl = dependencies.fetch ?? fetch;
          const runId = await fetchRemoteTaskLatestRunId(
            options.serverUrl,
            taskId,
            fetchImpl,
            options.apiToken,
          );
          return await watchRemoteRun({
            runId,
            serverUrl: options.serverUrl,
            intervalMs: options.intervalMs,
            fetchImpl,
            io,
            ...(options.apiToken ? { apiToken: options.apiToken } : {}),
          });
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      let resolvedApiToken: string | undefined;
      const label = action === "plan" ? "task plan" : "task create";
      try {
        const options = parseTaskCreateOptions(argv, label);
        const remote = await resolveRemoteTarget({
          env,
          ...(options.serverFlag ? { flag: options.serverFlag } : {}),
        });
        resolvedApiToken = remote.apiToken;
        const serverUrl = requireRemoteServerUrl(remote.serverUrl);
        const intake = await resolveTaskIntake(options, action === "plan");
        if (intake) {
          const draft = await createRemoteDraftTask(
            {
              serverUrl,
              ...intake,
              ...(options.title ? { title: options.title } : {}),
              ...(options.guidance ? { guidance: options.guidance } : {}),
              ...(options.flowPath ? { flowPath: options.flowPath } : {}),
              ...(options.templateId ? { templateId: options.templateId } : {}),
              ...(options.repoId ? { repoId: options.repoId } : {}),
              ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
            },
            dependencies.fetch ?? fetch,
          );
          if (options.asJson) {
            io.stdout(JSON.stringify(draft));
          } else {
            printRemoteDraftTaskResult(io, serverUrl, draft);
          }
          return 0;
        }
        if (!options.title) throw new Error("Missing value for --title");
        if (!options.specPath) throw new Error("Missing value for --spec");
        if (!options.techDesignPath) {
          throw new Error("Missing value for --tech-design");
        }
        const task = await createRemoteTask(
          {
            serverUrl,
            title: options.title,
            specPath: options.specPath,
            techDesignPath: options.techDesignPath,
            ...(options.issue ? { issueUrl: options.issue } : {}),
            ...(options.flowPath ? { flowPath: options.flowPath } : {}),
            ...(options.repoId ? { repoId: options.repoId } : {}),
            ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
          },
          dependencies.fetch ?? fetch,
        );
        if (options.asJson) {
          io.stdout(JSON.stringify(task));
        } else {
          printRemoteTaskResult(io, serverUrl, task);
        }
        return 0;
      } catch (error) {
        if (error instanceof TaskCommandUsageError) {
          io.stderr(error.message);
          return 1;
        }
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
        return 1;
      }

    },
  },
  {
    name: "run",
    matches: (argv) => argv[1] === "list",
    usage: [
      "  run list [--server <url>] [--status <status>] [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      return await runRemoteListCommand({
        argv,
        startIndex: 2,
        usage: "Usage: nitely run list [--server <url>] [--status <status>] [--json]",
        env: dependencies.env ?? process.env,
        fetchImpl: dependencies.fetch ?? fetch,
        io,
        allowStatusFilter: true,
        fetchItems: listRemoteRuns,
        jsonKey: "runs",
        print: printRemoteRunList,
      });

    },
  },
  {
    name: "run",
    matches: (argv) => argv[1] === "watch",
    usage: [
      "  run watch <run-id> [--server <url>] [--interval-ms <n>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[2];
      if (!runId) {
        io.stderr("Usage: nitely run watch <run-id> [--server <url>] [--interval-ms <n>]");
        return 1;
      }
      try {
        const options = await parseRemoteWatchOptions(
          argv,
          3,
          dependencies.env ?? process.env,
        );
        return await watchRemoteRun({
          runId,
          serverUrl: options.serverUrl,
          intervalMs: options.intervalMs,
          fetchImpl: dependencies.fetch ?? fetch,
          io,
          ...(options.apiToken ? { apiToken: options.apiToken } : {}),
        });
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "mcp",
    usage: [
      "  mcp serve [--server <url>]  # token from NITELY_API_TOKEN",
      "  mcp token create --repo <path> --name <name> --owner <email-or-user-id> --capability <capability> [--capability <capability> ...] [--allow-high-impact]",
      "  mcp token list --repo <path>",
      "  mcp token revoke <token-id> --repo <path>",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;
      if (argv[1] === "serve") {
        let serverFlag = "";
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--server") {
            serverFlag = argv[++index] ?? "";
            if (!serverFlag) {
              io.stderr("Missing value for --server");
              return 1;
            }
            continue;
          }
          io.stderr(`Unknown mcp serve option: ${arg}`);
          return 1;
        }
        let resolvedApiToken: string | undefined;
        try {
          const target = await resolveRemoteTarget({
            env,
            ...(serverFlag ? { flag: serverFlag } : {}),
          });
          resolvedApiToken = target.apiToken;
          if (!target.serverUrl) {
            io.stderr(MISSING_REMOTE_INSTANCE_MESSAGE);
            return 1;
          }
          if (!target.apiToken) {
            io.stderr("Missing NITELY_API_TOKEN");
            return 1;
          }
          await (dependencies.startMcpServer ?? startNitelyMcpStdioServer)({
            serverUrl: target.serverUrl,
            apiToken: target.apiToken,
          });
          return 0;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
          return 1;
        }
      }

      if (argv[1] !== "token") {
        io.stderr(
          "Usage: nitely mcp serve [--server <url>] | nitely mcp token create|list|revoke ...",
        );
        return 1;
      }
      const action = argv[2];
      if (action === "create") {
        let repoPath = ".";
        let name = "";
        let owner = "";
        const capabilities: ApiTokenCapability[] = [];
        let allowHighImpact = false;
        try {
          for (let index = 3; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === "--repo") {
              repoPath = argv[++index] ?? "";
              if (!repoPath) throw new Error("Missing value for --repo");
              continue;
            }
            if (arg === "--name") {
              name = argv[++index] ?? "";
              if (!name) throw new Error("Missing value for --name");
              continue;
            }
            if (arg === "--owner") {
              owner = argv[++index] ?? "";
              if (!owner) throw new Error("Missing value for --owner");
              continue;
            }
            if (arg === "--capability") {
              const capability = argv[++index] ?? "";
              if (!capability) throw new Error("Missing value for --capability");
              if (!isApiTokenCapability(capability)) {
                throw new Error(`Unknown API token capability: ${capability}`);
              }
              capabilities.push(capability);
              continue;
            }
            if (arg === "--allow-high-impact") {
              allowHighImpact = true;
              continue;
            }
            throw new Error(`Unknown mcp token create option: ${arg}`);
          }
          if (!name) throw new Error("Missing value for --name");
          if (capabilities.length === 0) {
            throw new Error("At least one --capability is required");
          }
          if (!(await (dependencies.hasAnyUsers ?? hasAnyUsers)(repoPath))) {
            throw new Error(
              "No users exist in this instance yet; start the Web Console once with NITELY_ADMIN_EMAIL and NITELY_ADMIN_PASSWORD set to bootstrap the initial admin, then re-run with --owner <that email>",
            );
          }
          if (!owner) throw new Error("--owner <email-or-user-id> is required");
          const ownerUser = await (dependencies.findUserByIdOrEmail ?? findUserByIdOrEmail)(
            repoPath,
            owner,
          );
          if (!ownerUser) throw new Error(`Unknown API token owner: ${owner}`);
          const created = await (dependencies.createApiToken ?? createApiToken)(
            repoPath,
            { name, capabilities, ownerUserId: ownerUser.id, allowHighImpact },
          );
          io.stdout(`API TOKEN ${created.record.id} created`);
          io.stdout(`Name: ${created.record.name}`);
          io.stdout(`Capabilities: ${created.record.capabilities.join(", ")}`);
          io.stdout(`Owner: ${created.record.ownerUserId}`);
          io.stdout(`Token: ${created.token}`);
          io.stdout("Store this token now; it will not be shown again.");
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      if (action === "list") {
        let repoPath = ".";
        for (let index = 3; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg !== "--repo") {
            io.stderr(`Unknown mcp token list option: ${arg}`);
            return 1;
          }
          repoPath = argv[++index] ?? "";
          if (!repoPath) {
            io.stderr("Missing value for --repo");
            return 1;
          }
        }
        try {
          printApiTokens(
            io,
            await (dependencies.listApiTokens ?? listApiTokens)(repoPath),
          );
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      if (action === "revoke") {
        const tokenId = argv[3];
        if (!tokenId) {
          io.stderr("Usage: nitely mcp token revoke <token-id> [--repo <path>]");
          return 1;
        }
        let repoPath = ".";
        for (let index = 4; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg !== "--repo") {
            io.stderr(`Unknown mcp token revoke option: ${arg}`);
            return 1;
          }
          repoPath = argv[++index] ?? "";
          if (!repoPath) {
            io.stderr("Missing value for --repo");
            return 1;
          }
        }
        try {
          const revoked = await (dependencies.revokeApiToken ?? revokeApiToken)(
            repoPath,
            tokenId,
          );
          io.stdout(`API TOKEN ${revoked.id} revoked`);
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      io.stderr(
        "Usage: nitely mcp token create|list|revoke ...",
      );
      return 1;

    },
  },
  {
    name: "evidence",
    usage: [
      "  evidence policy --repo <path> [--json]",
      "  evidence search --repo <path> [--run <text>] [--task <text>] [--repository <text>] [--flow <text>] [--status <status>] [--pr <text>] [--blocker <category>] [--from <ISO>] [--to <ISO>] [--artifact <text>] [--json]",
      "  evidence export --repo <path> --run <run-id> [--run <run-id> ...] --output <directory> [--include-raw]",
      "  evidence prune --repo <path> [--at <ISO>] [--apply] [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      return await runEvidenceCli(argv, io);

    },
  },
  {
    name: "ci-repair",
    usage: [
      "  ci-repair submit <observation.json> --repo <path> --flow <flow> [--current-head <sha>] [--input <name>=<path>] [--secret <value>] [--resume]",
      "  ci-repair decide <idempotency-key> --decision <accept|reject> [--repo <path>] [--actor <actor>] [--reason <text>]",
    ],
    run: async ({ argv, io }) => {
      if (argv[1] === "decide") {
        const idempotencyKey = argv[2];
        if (!idempotencyKey) {
          io.stderr("Usage: nitely ci-repair decide <idempotency-key> --decision <accept|reject> [--repo <path>] [--actor <actor>] [--reason <text>]");
          return 1;
        }
        let repoPath = ".";
        let decision: "accept" | "reject" | undefined;
        let actor: string | undefined;
        let reason: string | undefined;
        try {
          for (let index = 3; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === "--repo") {
              repoPath = argv[++index] ?? "";
              if (!repoPath) throw new Error("Missing value for --repo");
              continue;
            }
            if (arg === "--decision") {
              const value = argv[++index];
              if (value !== "accept" && value !== "reject") throw new Error("--decision must be accept or reject");
              decision = value;
              continue;
            }
            if (arg === "--actor") {
              actor = argv[++index] ?? "";
              if (!actor) throw new Error("Missing value for --actor");
              continue;
            }
            if (arg === "--reason") {
              reason = argv[++index] ?? "";
              if (!reason) throw new Error("Missing value for --reason");
              continue;
            }
            throw new Error(`Unknown ci-repair decide option: ${arg}`);
          }
          if (!decision) throw new Error("Missing value for --decision");
          const evidence = await recordCiRepairDecision({
            repoPath,
            idempotencyKey,
            decision,
            ...(actor ? { actor } : {}),
            ...(reason ? { reason } : {}),
          });
          io.stdout(JSON.stringify(evidence, null, 2));
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }
      if (argv[1] !== "submit" || !argv[2]) {
        io.stderr("Usage: nitely ci-repair submit <observation.json> --repo <path> --flow <flow> [--current-head <sha>] [--input <name>=<path>] [--secret <value>] [--resume]\n       ci-repair decide <idempotency-key> --decision <accept|reject> [--repo <path>] [--actor <actor>] [--reason <text>]");
        return 1;
      }
      const observationPath = argv[2];
      let repoPath = ".";
      let currentHeadSha = "";
      let flowPath = "";
      let resume = false;
      const inputs: RunFlowInput["inputs"] = {};
      const secrets: string[] = [];
      try {
        for (let index = 3; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--repo") {
            repoPath = argv[++index] ?? "";
            if (!repoPath) throw new Error("Missing value for --repo");
            continue;
          }
          if (arg === "--current-head") {
            currentHeadSha = argv[++index] ?? "";
            if (!currentHeadSha) throw new Error("Missing value for --current-head");
            continue;
          }
          if (arg === "--flow") {
            flowPath = argv[++index] ?? "";
            if (!flowPath) throw new Error("Missing value for --flow");
            continue;
          }
          if (arg === "--input") {
            const [name, reference] = parseRunInput(argv[++index] ?? "");
            inputs[name] = reference;
            continue;
          }
          if (arg === "--secret") {
            const secret = argv[++index] ?? "";
            if (!secret) throw new Error("Missing value for --secret");
            secrets.push(secret);
            continue;
          }
          if (arg === "--resume") {
            resume = true;
            continue;
          }
          throw new Error(`Unknown ci-repair option: ${arg}`);
        }
        if (!flowPath) throw new Error("Missing value for --flow");
        const observation = parseCiFailureObservation(
          JSON.parse(await readFile(resolve(observationPath), "utf8")) as unknown,
        );
        const pullRequestTarget = `https://github.com/${observation.repository}/pull/${observation.pullRequest}`;
        const actualHeadSha = await readGitHubPullRequestHead(repoPath, pullRequestTarget);
        if (currentHeadSha && currentHeadSha !== actualHeadSha) {
          throw new Error("pull request head changed since --current-head; refusing CI repair");
        }
        const result = await submitCiRepair({
          repoPath,
          observation,
          currentHeadSha: actualHeadSha,
          secrets,
          resume,
          dependencies: defaultCiRepairDependencies({
            repoPath,
            flowPath: resolve(repoPath, flowPath),
            inputs,
            pullRequestTarget,
          }),
        });
        io.stdout(JSON.stringify(result, null, 2));
        return result.result.outcome === "repaired" ? 0 : 1;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
    },
  },
  {
    name: "eval",
    usage: [
      "  eval plan <manifest> --repo <path> --case <id> [--json]",
      "  eval run <manifest> --repo <path> --case <id> [--json]",
      "  eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path> [--output <report.json>]",
      "  eval recommend <experiment> --repo <path> [--output <recommendation.json>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      return await runEvalCli(argv.slice(1), io);

    },
  },
  {
    name: "metrics",
    usage: [
      "  metrics --repo <path> [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const { repoPath, nextIndex } = parseRepoOption(argv, 1);
      let json = false;
      for (let index = nextIndex; index < argv.length; index += 1) {
        if (argv[index] === "--json") {
          json = true;
          continue;
        }
        io.stderr(`Unknown metrics option: ${argv[index]}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      try {
        const [runs, tasks] = await Promise.all([
          dependencies.listFactoryRuns
            ? dependencies.listFactoryRuns(repoPath)
            : listWebRuns(repoPath),
          (dependencies.listFactoryWorkItems ?? listUnifiedWorkItems)(repoPath),
        ]);
        const report = {
          schemaVersion: "nitely.factory-metrics.v1",
          window: "all",
          generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          metrics: buildFactoryMetrics(tasks, runs),
        };
        if (json) {
          io.stdout(JSON.stringify(report, null, 2));
        } else {
          io.stdout(`Candidates: ${report.metrics.funnel.candidate}`);
          io.stdout(`Eligible: ${report.metrics.funnel.eligible}`);
          io.stdout(`Queued: ${report.metrics.funnel.queued}`);
          io.stdout(`PRs created: ${report.metrics.funnel.prsCreated}`);
          io.stdout(`Merged: ${report.metrics.funnel.merged}`);
          io.stdout(`Human touch rate: ${report.metrics.humanAttention.humanTouchRate ?? "unknown"}`);
          io.stdout(`Runtime cost per merged PR: ${report.metrics.cost.runtimeCostPerMergedPr ?? "unknown"}`);
        }
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
    },
  },
  {
    name: "runs",
    usage: [
      "  runs [--repo <path>]",
    ],
    run: async ({ argv, io, dependencies }) => {
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

    },
  },
  {
    name: "diagnose",
    usage: [
      "  diagnose <run-id> [--repo <path>] [--json]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      if (!runId) {
        io.stderr("Usage: nitely diagnose <run-id> [--repo <path>] [--json]");
        return 1;
      }
      const { repoPath, nextIndex } = parseRepoOption(argv, 2);
      let json = false;
      for (let index = nextIndex; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--json") {
          json = true;
          continue;
        }
        io.stderr(`Unknown diagnose option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      try {
        const report = (dependencies.diagnoseRun ?? diagnoseRepoRun)(repoPath, runId);
        if (json) {
          io.stdout(JSON.stringify(report, null, 2));
          return 0;
        }
        io.stdout(`Run: ${report.runId}`);
        if (report.findings.length === 0) {
          io.stdout("No efficiency findings.");
          return 0;
        }
        for (const finding of report.findings) {
          io.stdout(
            `${finding.severity.toUpperCase()}\t${finding.ruleId}\t${finding.confidence}\t${finding.title}`,
          );
          io.stdout(finding.summary);
          io.stdout(`Remediation: ${finding.remediation}`);
          if (finding.evidence.stageIds.length > 0) {
            io.stdout(`Evidence stages: ${finding.evidence.stageIds.join(", ")}`);
          }
        }
        return 0;
      } catch (error) {
        io.stderr(formatRunLookupError(error));
        return 1;
      }
    },
  },
  {
    name: "status",
    usage: [
      "  status <run-id> [--repo <path>]",
    ],
    run: async ({ argv, io, dependencies }) => {
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
        // A SIGKILLed runner writes no terminal event, so a plain projection
        // would report "running" forever. Downgrade a quiet open attempt.
        const run = await (dependencies.getRunStatus ??
          ((path: string, id: string) =>
            getProjectedRun(path, id, { staleAware: true })))(repoPath, runId);
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
        const runDirectory = join(resolve(repoPath), ".nitely", "runs", runId);
        const reproducibilityManifest = await readReproducibilityManifest({
          runDirectory,
        });
        if (reproducibilityManifest) {
          const diagnostic = diagnosticForManifest(
            reproducibilityManifest,
            reproducibilityManifestPath(runDirectory),
          );
          io.stdout(`Replayability: ${diagnostic.replayability}`);
          io.stdout(`Reproducibility manifest: ${diagnostic.manifestPath}`);
          if (diagnostic.missingReplayPrerequisites.length > 0) {
            io.stdout(
              `Missing replay prerequisites: ${diagnostic.missingReplayPrerequisites.join("; ")}`,
            );
          }
          if (diagnostic.nonDeterministicFactors.length > 0) {
            io.stdout(
              `Known non-determinism: ${diagnostic.nonDeterministicFactors.join("; ")}`,
            );
          }
        }
        if (run.blocker) {
          io.stdout(`Blocked: ${blockerSummary(run.blocker)}`);
          if (run.blocker.message) {
            io.stdout(`Message: ${run.blocker.message}`);
          }
        }
        if (run.activeQuestion) {
          const question = run.activeQuestion;
          io.stdout(`Question: ${question.id} (${question.status})`);
          io.stdout(question.question);
          if (question.context) io.stdout(`Context: ${question.context}`);
          if (question.options.length > 0) {
            io.stdout("Options:");
            for (const option of question.options) {
              io.stdout(
                `  ${option.id}\t${option.label}${option.recommended ? " (recommended)" : ""}`,
              );
            }
          }
          if (question.answer) {
            io.stdout(
              `Answer: ${question.answer.optionId ?? question.answer.text ?? ""} (by ${question.answer.actor})`,
            );
          }
        }
        const operatorReviews = run.gates.filter(
          (gate) => gate.operatorReview !== undefined,
        );
        for (const gate of operatorReviews) {
          io.stdout(
            `Operator review: ${gate.stageId} attempt ${gate.attempt ?? "unknown"} ${gate.status}`,
          );
          io.stdout(
            `  Actor: ${gate.operatorReview?.actor ?? "unknown"} at ${gate.operatorReview?.submittedAt ?? "unknown"}`,
          );
          io.stdout(
            `  Reviewed artifacts: ${(gate.reviewedArtifacts ?? []).join(", ")}`,
          );
          io.stdout(
            `  Blocker: ${gate.operatorReview?.blocker.reason ?? "unknown"}`,
          );
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
        const trace = tryBuildRunTrace(repoPath, runId);
        if (trace?.resumableCheckpoints.length) {
          io.stdout("Checkpoint candidates:");
          for (const checkpoint of trace.resumableCheckpoints) {
            const target = [
              checkpoint.stageId ? `stage ${checkpoint.stageId}` : "",
              checkpoint.attempt ? `attempt ${checkpoint.attempt}` : "",
            ].filter(Boolean).join(" ");
            io.stdout(
              `  ${checkpoint.kind}\t${checkpoint.action}\t${target || checkpoint.label}`,
            );
          }
        }
        return 0;
      } catch (error) {
        io.stderr(formatRunLookupError(error));
        return 1;
      }

    },
  },
  {
    name: "rollback",
    usage: [
      "  rollback record <run-id> --repo <path> --checkpoint <checkpoint-id> [--actor <name>] [--reason <text>] [--worktree preserve|cleanup] [--branch preserve|reset-to-checkpoint] [--change preserve-existing-pr|update-existing-pr|new-pr|none]",
      "  rollback apply <run-id> --repo <path> [--decision <event-sequence>]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const action = argv[1];
      const runId = argv[2];
      if (!runId || (action !== "record" && action !== "apply")) {
        io.stderr(
          "Usage: nitely rollback record <run-id> --repo <path> --checkpoint <checkpoint-id> [--actor <name>] [--reason <text>] [--worktree preserve|cleanup] [--branch preserve|reset-to-checkpoint] [--change preserve-existing-pr|update-existing-pr|new-pr|none]\n       nitely rollback apply <run-id> --repo <path> [--decision <event-sequence>]",
        );
        return 1;
      }
      if (action === "apply") {
        let repoPath: string | undefined;
        let decisionSequence: number | undefined;
        try {
          for (let index = 3; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === "--repo") {
              repoPath = argv[++index];
              continue;
            }
            if (arg === "--decision") {
              decisionSequence = parsePositiveIntegerOption(
                "--decision",
                argv[++index] ?? "",
              );
              continue;
            }
            io.stderr(`Unknown rollback apply option: ${arg}`);
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
          const result = await (
            dependencies.applyRollbackDecision ?? applyRollbackDecision
          )({
            repoPath,
            runId,
            ...(decisionSequence ? { decisionSequence } : {}),
            ...(dependencies.now ? { now: dependencies.now } : {}),
          });
          if (result.application.status === "applied") {
            io.stdout(`ROLLBACK ${result.event.runId} applied`);
          } else {
            io.stdout(`ROLLBACK ${result.event.runId} apply failed`);
          }
          io.stdout(`Decision: ${result.decision.sequence}`);
          io.stdout(
            `Policy: worktree=${result.application.policy.worktree} branch=${result.application.policy.branch} change=${result.application.policy.change}`,
          );
          io.stdout(`Worktree: ${result.application.worktree.status}`);
          io.stdout(`Branch: ${result.application.branch.status}`);
          io.stdout(`Change: ${result.application.change.status}`);
          for (const failure of result.application.failures) {
            io.stdout(`Failure: ${failure}`);
          }
          io.stdout(`Event: ${result.event.sequence}`);
          return result.application.status === "applied" ? 0 : 1;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      let repoPath: string | undefined;
      let checkpointId: string | undefined;
      let actor: string | undefined;
      let reason: string | undefined;
      let worktreePolicy: RecordRollbackDecisionInput["worktreePolicy"];
      let branchPolicy: RecordRollbackDecisionInput["branchPolicy"];
      let changePolicy: RecordRollbackDecisionInput["changePolicy"];
      for (let index = 3; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--repo") {
          repoPath = argv[++index];
          continue;
        }
        if (arg === "--checkpoint") {
          checkpointId = argv[++index] ?? "";
          continue;
        }
        if (arg === "--actor") {
          actor = argv[++index] ?? "";
          continue;
        }
        if (arg === "--reason") {
          reason = argv[++index] ?? "";
          continue;
        }
        if (arg === "--worktree") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --worktree");
            return 1;
          }
          worktreePolicy = value as typeof worktreePolicy;
          continue;
        }
        if (arg === "--branch") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --branch");
            return 1;
          }
          branchPolicy = value as typeof branchPolicy;
          continue;
        }
        if (arg === "--change") {
          const value = argv[++index] ?? "";
          if (!value) {
            io.stderr("Missing value for --change");
            return 1;
          }
          changePolicy = value as typeof changePolicy;
          continue;
        }
        io.stderr(`Unknown rollback option: ${arg}`);
        return 1;
      }
      if (!repoPath) {
        io.stderr("Missing value for --repo");
        return 1;
      }
      if (!checkpointId) {
        io.stderr("Missing value for --checkpoint");
        return 1;
      }
      if (actor === "") {
        io.stderr("Missing value for --actor");
        return 1;
      }
      if (reason === "") {
        io.stderr("Missing value for --reason");
        return 1;
      }
      try {
        const result = await (
          dependencies.recordRollbackDecision ?? recordRollbackDecision
        )({
          repoPath,
          runId,
          checkpointId,
          ...(actor ? { actor } : {}),
          ...(reason ? { reason } : {}),
          ...(worktreePolicy ? { worktreePolicy } : {}),
          ...(branchPolicy ? { branchPolicy } : {}),
          ...(changePolicy ? { changePolicy } : {}),
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
        io.stdout(`ROLLBACK ${result.event.runId} recorded`);
        io.stdout(`Checkpoint: ${result.checkpoint.id}`);
        io.stdout(
          `Policy: worktree=${result.policy.worktree} branch=${result.policy.branch} change=${result.policy.change}`,
        );
        io.stdout(`Event: ${result.event.sequence}`);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "logs",
    usage: [
      "  logs <run-id>",
    ],
    run: async ({ argv, io, dependencies }) => {
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

    },
  },
  {
    name: "resume",
    usage: [
      "  resume <run-id> [--checkpoint <checkpoint-id>] [--backend local|mise|oci]",
    ],
    run: async ({ argv, io, dependencies }) => {
      const runId = argv[1];
      if (!runId) {
        io.stderr("Usage: nitely resume <run-id> [--repo <path>] [--checkpoint <checkpoint-id>] [--backend local|mise|oci]");
        return 1;
      }
      const { repoPath, nextIndex } = parseRepoOption(argv, 2);
      let executionBackend: string | undefined;
      let checkpointId: string | undefined;
      for (let index = nextIndex; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--checkpoint") {
          checkpointId = argv[++index] ?? "";
          if (!checkpointId) {
            io.stderr("Missing value for --checkpoint");
            return 1;
          }
          continue;
        }
        if (arg === "--backend") {
          executionBackend = argv[++index] ?? "";
          if (!executionBackend) {
            io.stderr("Missing value for --backend");
            return 1;
          }
          continue;
        }
        io.stderr(`Unknown resume option: ${arg}`);
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
          ...(checkpointId ? { checkpointId } : {}),
          ...(executionBackend ? { executionBackend } : {}),
        });
        printResumeResult(io, result, "resumed", repoPath);
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
  {
    name: "web",
    usage: [
      "  web --home <dir> --host <host> --port <port> [--auth local|required]",
    ],
    run: async ({ argv, io, dependencies }) => {
      let homePath = ".";
      let host = "127.0.0.1";
      let port = 4173;
      let authMode: StartWebServerInput["authMode"] | undefined;

      try {
        for (let index = 1; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--home" || arg === "--repo") {
            homePath = argv[++index] ?? "";
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
          if (arg === "--repository") {
            io.stderr(
              "--repository was removed; register repositories by GitHub URL from the Repos page",
            );
            return 1;
          }
          io.stderr(`Unknown web option: ${arg}`);
          return 1;
        }
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

      if (!homePath) {
        io.stderr("Missing value for --home");
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
          repoPath: homePath,
          host,
          port,
          ...(authMode ? { authMode } : {}),
        });
        io.stdout(`Web Console: ${server.url}`);
        if (server.readiness) {
          io.stdout(
            `Web Security: ready=${server.readiness.ready} auth=${server.readiness.auth.mode} admin=${
              server.readiness.auth.adminConfigured ? "configured" : "missing"
            } bind=${server.readiness.bind.scope} transport=${server.readiness.transport.mode} secureCookie=${
              server.readiness.transport.secureCookie
            } execution=${server.readiness.execution.backend} reason=${server.readiness.execution.reason} unsafeOverride=${server.readiness.execution.unsafeOverride} production=${server.readiness.production}`,
          );
        }
        if (server.closed) {
          await server.closed;
        }
        return 0;
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }

    },
  },
];

export function cliCommands(): readonly NitelyCliCommand[] {
  return CLI_COMMANDS;
}

export type { CliIo } from "./cli/io.js";

export async function runCli(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  argv = argv[0] === "--" ? argv.slice(1) : argv;

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    io.stdout(buildCliHelp(CLI_HELP_HEADER, CLI_COMMANDS));
    return 0;
  }

  const command = selectCliCommand(CLI_COMMANDS, argv);
  if (!command) {
    io.stderr(`Unknown command: ${argv[0]}`);
    return 1;
  }

  return await command.run({ argv, io, dependencies });
}
