import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { GoogleDriveConnector } from "../connectors/google-drive.js";
import {
  LocalFileConnector,
  resolveLocalFileResource,
} from "../connectors/local-file.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import type { FetchedResource, ResourceReference } from "../connectors/types.js";
import {
  mergeArtifacts,
  readArtifactRegistry,
  writeArtifactRegistry,
} from "../artifacts/registry.js";
import type {
  ArtifactContract,
  GateResult,
  GateReviewOutput,
  RunArtifact,
} from "../artifacts/types.js";
import { withProvenance } from "../artifacts/integrity.js";
import { validateAgainstSchema } from "../artifacts/validate.js";
import { resolveWorkItemTypePolicy } from "../work-items/policy.js";
import {
  assertPlanningReadyForExecution,
  formatPlanningApprovalEvidence,
  type PlanningApprovalStatus,
} from "../work-items/planning.js";
import {
  type ContextManifestEntry,
  redactContextManifestEntry,
  runRelativePath as manifestRunRelativePath,
  writeContextManifest,
} from "../context/manifest.js";
import {
  ContextPolicyError,
  evaluateLocalPath,
  loadContextPolicy,
  type ContextDecision,
  type ContextPolicy,
} from "../context/policy.js";
import {
  collectContextRedactionSecrets,
  redactText,
  redactUnknown,
} from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import {
  stageDependencyRequirements,
  type StageDependencyRequirements,
} from "../flow/requirements.js";
import {
  outputContract,
  outputId,
  stageRuntimeCandidates,
  stageOutputIds,
  type RuntimeCandidate,
  type Flow,
  type Stage,
} from "../flow/schema.js";
import {
  decideStagePolicy,
  type OrchestratorDecision,
  type OrchestratorDecisionEvent,
  type OrchestratorRecommendation,
} from "../policy/decide.js";
import { findDescriptor } from "../providers/descriptors.js";
import { resolveProviderStore } from "../providers/index.js";
import type { ProviderConnectionStore, ProviderId } from "../providers/types.js";
import {
  loadStageSkills,
  type LoadedSkill,
} from "../skills/load.js";
import {
  eventStorePath,
  projectRun,
  type ProjectedRepoIndexQuery,
  type ProjectedRuntimeUsageTotal,
  runDirectoryPath,
  validateRunId,
} from "./project.js";
import {
  classifyAgentRuntimeBlocker,
  type RunBlocker,
} from "./blockers.js";
import {
  loadConstitution,
  type Constitution,
} from "./constitution.js";
import {
  injectAgentMemoryFiles,
  prepareAgentMemory,
  removeInjectedAgentMemoryFiles,
  type InjectedAgentMemoryFile,
} from "./knowledge.js";
import {
  validateAttemptOutputs,
  type ValidatedAttemptOutput,
} from "./attempt-outputs.js";
import { analyzeSpecPlanTasks } from "../analysis/spec-plan-task.js";
import {
  renderScopedTaskArtifact,
  selectTaskScope,
  type TaskScopeInput,
  type TaskScopeSelection,
} from "../task-artifacts/scope.js";
import { createScmProvider } from "../scm/registry.js";
import type {
  ChangeRequest,
  ChangeRequestTarget,
  CheckoutChangeRequestResult,
  ScmProvider,
  UpdateChangeRequestResult,
} from "../scm/types.js";
import { LocalExecutionBackend } from "./execution/local.js";
import type {
  AgentRunnableStage,
  AgentRuntimePreflightResult,
  AgentResult,
  AgentRuntimeUsage,
  CommandResult,
  ExecutionBackend,
  WorkspaceHandle,
} from "./execution/types.js";

export { createCodexExecArgs } from "./execution/local.js";

const execFileAsync = promisify(execFile);

class BudgetExceededError extends Error {}

export interface RunFlowInput {
  flowPath: string;
  flowDocument?: string;
  repoPath: string;
  repoId?: string;
  repoName?: string;
  inputs: Record<string, ResourceReference>;
  ownerId?: string;
  organizationId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  trigger?: RunTrigger;
  priorRunId?: string;
  taskScope?: TaskScopeInput;
  changeRequestTarget?: {
    provider: "github" | "github-cli";
    target: string;
  };
}

export type RunTrigger = {
  type: "github-pr-comment";
  provider: "github";
  owner: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  commentId: string;
  commentUrl: string;
  authorLogin: string;
  action: "rework" | "address" | "explain";
  priorRunId?: string;
};

export interface ResumeRunInput {
  repoPath: string;
  runId: string;
}

export interface AgentExecutionInput {
  stage: AgentRunnableStage;
  prompt: string;
  worktreePath: string;
  attemptDirectory: string;
}

export interface PublishChangeInput {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  branchName: string;
  evidencePath: string;
  title: string;
  body: string;
}

export interface PublishChangeResult {
  url: string;
  evidencePath: string;
  changeRequest?: ChangeRequest;
}

interface ReworkTargetState {
  provider: "github" | "github-cli";
  target: string;
  resolved: ChangeRequestTarget;
  previousHeadSha: string;
  updatedHeadSha?: string;
}

interface SyncMetadata {
  prUrl: string;
  prNumber: number;
  baseBranch: string;
  strategy: "merge";
  baseSha: string;
  headShaBefore: string;
  headShaAfter?: string;
  result: "clean" | "conflicted";
  conflictFiles: string[];
  stdoutPath: string;
  stderrPath: string;
  reportPath: string;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_CHANGE_TITLE_LENGTH = 120;
const MAX_REVIEW_OUTPUT_CONTENT_LENGTH = 64 * 1024;
const INPUT_INLINE_FULL_LIMIT = 8 * 1024;
const TITLE_ARTIFACT_IDS = ["pr-title", "change-title"];

export interface ReworkRecommendationInput {
  stage: Stage;
  attempt: number;
  error: string;
  validReworkTargets: ReadonlySet<string>;
}

export interface OrchestratorRecommendationInput {
  stage: Stage;
  attempt: number;
  error: string;
  validReworkTargets: ReadonlySet<string>;
}

export interface RunFlowDependencies {
  createRunId?: () => string;
  backend?: ExecutionBackend;
  providerStore?: ProviderConnectionStore;
  /** @deprecated Provide `backend` instead. Honored only when `backend` is unset. */
  executeAgent?: (input: AgentExecutionInput) => Promise<void>;
  publishChange?: (input: PublishChangeInput) => Promise<PublishChangeResult>;
  scmProvider?: ScmProvider;
  recommendOrchestration?: (
    input: OrchestratorRecommendationInput,
  ) => OrchestratorRecommendation | undefined;
  recommendRework?: (input: ReworkRecommendationInput) => string | undefined;
}

export interface RunFlowResult {
  runId: string;
  branchName: string;
  worktreePath: string;
  changeRequestUrl?: string;
  changeRequest?: ChangeRequest;
  previousHeadSha?: string;
  updatedHeadSha?: string;
}

interface InputArtifact {
  id: string;
  reference: ResourceReference;
  resource: FetchedResource;
  contentPath: string;
  omittedByPolicy?: ContextDecision;
}

type ChangeTitleSource = "artifact" | "fallback";

interface ChangeTitleMetadata {
  title: string;
  source: ChangeTitleSource;
  artifactId?: string;
}

interface ResolvedChangeTitle extends ChangeTitleMetadata {
  commitMessage: string;
}

interface AgentRuntimeEvidence {
  stageId: string;
  candidates: RuntimeCandidate[];
}

interface StageSkillUsage {
  stageId: string;
  skills: LoadedSkill[];
}

interface AppliedTaskScope {
  selection: TaskScopeSelection;
  scopedInputs: Map<string, InputArtifact>;
}

interface PersistedLoadedSkill {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string;
  resources: LoadedSkill["resources"];
}

interface PreviousFailure {
  attempt: number;
  error: string;
}

interface RuntimeContext {
  runId: string;
  runDirectory: string;
  manifestEntries: ContextManifestEntry[];
  manifestEntryIndexes: Map<string, number>;
  artifactEntries: RunArtifact[];
  artifactEntryIndexes: Map<string, number>;
  redactionSecrets: string[];
  constitution: Constitution;
}

function manifestEntryKey(entry: ContextManifestEntry): string {
  return `${entry.kind}\0${entry.id}`;
}

function upsertManifestEntry(
  context: RuntimeContext,
  entry: ContextManifestEntry,
): void {
  const key = manifestEntryKey(entry);
  const redacted = redactContextManifestEntry(entry, context.redactionSecrets);
  const existing = context.manifestEntryIndexes.get(key);
  if (existing !== undefined) {
    context.manifestEntries[existing] = redacted;
  } else {
    context.manifestEntryIndexes.set(key, context.manifestEntries.length);
    context.manifestEntries.push(redacted);
  }
}

async function persistContextManifest(context: RuntimeContext): Promise<void> {
  await writeContextManifest({
    runDirectory: context.runDirectory,
    runId: context.runId,
    entries: context.manifestEntries,
    redactionSecrets: context.redactionSecrets,
  });
}

function artifactEntryKey(artifact: Pick<RunArtifact, "id" | "producer">): string {
  return `${artifact.producer}\0${artifact.id}`;
}

function upsertArtifactEntry(
  context: RuntimeContext,
  artifact: RunArtifact,
): void {
  const key = artifactEntryKey(artifact);
  const existing = context.artifactEntryIndexes.get(key);
  if (existing !== undefined) {
    context.artifactEntries[existing] = {
      ...context.artifactEntries[existing],
      ...artifact,
    };
  } else {
    context.artifactEntryIndexes.set(key, context.artifactEntries.length);
    context.artifactEntries.push(artifact);
  }
  context.artifactEntries = mergeArtifacts(context.artifactEntries);
  context.artifactEntryIndexes = new Map(
    context.artifactEntries.map((entry, index) => [artifactEntryKey(entry), index]),
  );
}

const AUTO_APPROVAL_ACTOR = "system:auto";

function recordApprovalGate(
  context: RuntimeContext,
  stageId: string,
  evidence: { actor?: string; reason?: string } = {},
): void {
  const actor = evidence.actor ?? AUTO_APPROVAL_ACTOR;
  upsertArtifactEntry(context, {
    id: stageId,
    type: "gate.approval",
    producer: stageId,
    mediaType: "application/vnd.nitely.gate+json",
    createdAt: new Date().toISOString(),
    gate: {
      gateId: stageId,
      state: "approved",
      actor,
      decidedAt: new Date().toISOString(),
      ...(evidence.reason ? { reason: evidence.reason } : {}),
    },
  });
}

async function persistArtifactRegistry(context: RuntimeContext): Promise<void> {
  await writeArtifactRegistry({
    runDirectory: context.runDirectory,
    runId: context.runId,
    artifacts: context.artifactEntries,
    redactionSecrets: context.redactionSecrets,
  });
}

async function seedRuntimeArtifactEntries(
  context: RuntimeContext,
  projection: ReturnType<typeof projectRun>,
): Promise<void> {
  for (const artifact of projection.artifacts) {
    upsertArtifactEntry(context, artifact);
  }
  const registry = await readArtifactRegistry({ runDirectory: context.runDirectory });
  for (const artifact of registry?.artifacts ?? []) {
    upsertArtifactEntry(context, artifact);
  }
}

function redactRuntimeText(
  value: string | undefined,
  context: RuntimeContext,
): string | undefined {
  return redactText(value, context.redactionSecrets);
}

function redactRuntimeUnknown(value: unknown, context: RuntimeContext): unknown {
  return redactUnknown(value, context.redactionSecrets);
}

function assertSafePathSegment(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/.test(value)) {
    throw new Error(`invalid ${kind}: ${value}`);
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function requirePathInside(parent: string, candidate: string, label: string): void {
  if (!isPathInside(resolve(parent), resolve(candidate))) {
    throw new Error(`${label} escapes ${parent}: ${candidate}`);
  }
}

function createDefaultRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
  return await new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            typeof error?.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function providerStoreForRun(
  repoPath: string,
  dependencies: RunFlowDependencies,
): ProviderConnectionStore {
  return (
    dependencies.providerStore ??
    resolveProviderStore(join(repoPath, ".nitely"), process.env)
  );
}

async function collectRuntimeRedactionSecrets(input: {
  policy: ContextPolicy;
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
}): Promise<string[]> {
  let providerEnv: Record<string, string | undefined> | undefined;
  if (!input.dependencies.backend) {
    providerEnv = await input.providerStore.resolveEnv();
  }
  return collectContextRedactionSecrets({
    policy: input.policy,
    processEnv: process.env,
    providerEnv,
  });
}

async function resolveBackend(
  dependencies: RunFlowDependencies,
  providerStore: ProviderConnectionStore,
): Promise<ExecutionBackend> {
  if (dependencies.backend) {
    return dependencies.backend;
  }
  return new LocalExecutionBackend({ env: await providerStore.resolveEnv() });
}

function hasDeclaredDependencyRequirements(
  requirements: StageDependencyRequirements,
): boolean {
  return (
    requirements.mcpServers.length > 0 ||
    requirements.connectors.length > 0
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requirementEventPayload(
  requirements: StageDependencyRequirements,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mcpServers: requirements.mcpServers,
    connectors: requirements.connectors,
    providerIds: requirements.providerIds,
    unknownMcpServers: requirements.unknownMcpServers,
    ...extras,
  };
}

class StageDependencyRequirementError extends Error {
  constructor(
    stageId: string,
    public readonly missingProviders: ProviderId[],
    public readonly hints: string[],
  ) {
    const hintMessage = hints.length > 0 ? ` Hints: ${hints.join(", ")}` : "";
    super(
      `stage ${stageId} requires missing provider(s): ${missingProviders.join(", ")}.${hintMessage}`,
    );
    this.name = "StageDependencyRequirementError";
  }
}

class RunBlockedError extends Error {
  constructor(
    public readonly blocker: RunBlocker,
    public readonly eventsAppended = false,
  ) {
    super(`run blocked by ${blocker.reason} on stage ${blocker.stageId}`);
    this.name = "RunBlockedError";
  }
}

function stageWithRuntimeCandidate<T extends AgentRunnableStage>(
  stage: T,
  candidate: RuntimeCandidate,
): T {
  return {
    ...stage,
    runtime: candidate.runtime,
    ...(candidate.model ? { model: candidate.model } : { model: undefined }),
  };
}

function runtimeCandidateEventPayload(input: {
  candidate: RuntimeCandidate;
  index: number;
  count: number;
}): {
  runtime: string;
  model?: string;
  runtimeCandidateIndex: number;
  runtimeCandidateCount: number;
} {
  return {
    runtime: input.candidate.runtime,
    ...(input.candidate.model ? { model: input.candidate.model } : {}),
    runtimeCandidateIndex: input.index,
    runtimeCandidateCount: input.count,
  };
}

function stageHasRuntimeCandidates(
  stage: Stage,
): stage is Extract<Stage, { type: "agent" }> | Extract<Stage, { type: "gate"; mode: "review" }> {
  return stage.type === "agent" || (stage.type === "gate" && stage.mode === "review");
}

function appendStageStarted(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  attemptDirectory: string;
  resumedFrom?: string;
  runtimeCandidate?: {
    candidate: RuntimeCandidate;
    index: number;
    count: number;
  };
}): void {
  const runtimeCandidate =
    input.runtimeCandidate ??
    (stageHasRuntimeCandidates(input.stage)
      ? {
          candidate: stageRuntimeCandidates(input.stage)[0]!,
          index: 0,
          count: stageRuntimeCandidates(input.stage).length,
        }
      : undefined);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "stage.started",
    payload: {
      attemptDirectory: input.attemptDirectory,
      type: input.stage.type,
      ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
      ...(runtimeCandidate ? runtimeCandidateEventPayload(runtimeCandidate) : {}),
    },
  });
}

function redactRunBlocker(
  blocker: RunBlocker,
  context: RuntimeContext,
): RunBlocker {
  return {
    reason: blocker.reason,
    stageId: redactRuntimeText(blocker.stageId, context) ?? blocker.stageId,
    runtime: redactRuntimeText(blocker.runtime, context),
    message: redactRuntimeText(blocker.message, context) ?? "",
    retryAfter: redactRuntimeText(blocker.retryAfter, context),
  };
}

function classifyRunBlockedError(input: {
  stageId: string;
  runtime?: string;
  error: unknown;
  context: RuntimeContext;
}): RunBlockedError | undefined {
  const blocker = classifyAgentRuntimeBlocker({
    stageId: input.stageId,
    runtime: input.runtime,
    error: input.error,
  });
  return blocker
    ? new RunBlockedError(redactRunBlocker(blocker, input.context))
    : undefined;
}

function appendRunBlockedEvents(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  blocker: RunBlocker;
  context: RuntimeContext;
}): void {
  const payload = redactRuntimeUnknown(input.blocker, input.context);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.blocked",
    payload,
  });
  input.eventStore.append({
    runId: input.runId,
    type: "run.blocked",
    payload,
  });
}

function appendStageBlockedEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  blocker: RunBlocker;
  context: RuntimeContext;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.blocked",
    payload: redactRuntimeUnknown(input.blocker, input.context),
  });
}

function appendRuntimeFallbackEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  failed: RuntimeCandidate;
  next: RuntimeCandidate;
  blocker: RunBlocker;
  context: RuntimeContext;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.runtime.fallback",
    payload: redactRuntimeUnknown(
      {
        failedRuntime: input.failed.runtime,
        failedModel: input.failed.model,
        nextRuntime: input.next.runtime,
        nextModel: input.next.model,
        blocker: input.blocker,
      },
      input.context,
    ),
  });
}

function unavailableRuntimeBlocker(input: {
  stageId: string;
  runtime: string;
  reason: string;
}): RunBlocker {
  return {
    reason: "agent_runtime_unavailable",
    stageId: input.stageId,
    runtime: input.runtime,
    message: input.reason,
  };
}

function appendRuntimeUnavailableEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  candidate: RuntimeCandidate;
  index: number;
  count: number;
  preflight: Extract<AgentRuntimePreflightResult, { available: false }>;
  context: RuntimeContext;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.runtime.unavailable",
    payload: redactRuntimeUnknown(
      {
        ...runtimeCandidateEventPayload({
          candidate: input.candidate,
          index: input.index,
          count: input.count,
        }),
        status: "unavailable",
        reason: input.preflight.reason,
        ...(input.preflight.missingConfig
          ? { missingConfig: input.preflight.missingConfig }
          : {}),
      },
      input.context,
    ),
  });
}

function unavailableCandidatesMessage(
  unavailable: {
    candidate: RuntimeCandidate;
    preflight: Extract<AgentRuntimePreflightResult, { available: false }>;
  }[],
): string {
  const details = unavailable
    .map(({ candidate, preflight }) => {
      const missing = preflight.missingConfig?.join(", ");
      return missing
        ? `${candidate.runtime} missing ${missing}`
        : `${candidate.runtime}: ${preflight.reason}`;
    })
    .join("; ");
  return `all agent runtime candidates unavailable: ${details}`;
}

async function assertStageDependencyRequirements(input: {
  stage: Stage;
  providerStore: ProviderConnectionStore;
  eventStore: EventStore;
  runId: string;
  attempt: number;
  context: RuntimeContext;
}): Promise<StageDependencyRequirements> {
  const requirements = stageDependencyRequirements(input.stage);
  if (!hasDeclaredDependencyRequirements(requirements)) {
    return requirements;
  }

  if (requirements.providerIds.length === 0) {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "stage.requirements.checked",
      payload: redactRuntimeUnknown(
        requirementEventPayload(requirements),
        input.context,
      ),
    });
    return requirements;
  }

  const statuses = await input.providerStore.listStatuses();
  const byId = new Map(statuses.map((status) => [status.id, status]));
  const missingProviders = requirements.providerIds.filter(
    (id) => !byId.get(id)?.configured,
  );

  if (missingProviders.length > 0) {
    const hints = uniqueStrings(
      missingProviders.flatMap((id) => {
        const statusHints = byId.get(id)?.hints ?? [];
        return statusHints.length > 0 ? statusHints : findDescriptor(id).hints;
      }),
    );
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "stage.requirements.failed",
      payload: redactRuntimeUnknown(
        requirementEventPayload(requirements, {
          missingProviders,
          hints,
        }),
        input.context,
      ),
    });
    throw new StageDependencyRequirementError(
      input.stage.id,
      missingProviders,
      hints,
    );
  }

  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "stage.requirements.checked",
    payload: redactRuntimeUnknown(
      requirementEventPayload(requirements),
      input.context,
    ),
  });
  return requirements;
}

function requireWorkspacePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("workspace has no host-accessible path");
  }
  return ws.path;
}

async function runAgentInWorkspace(input: {
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  stage: AgentRunnableStage;
  prompt: string;
  attemptDirectory: string;
  context: RuntimeContext;
}): Promise<{ stdoutPath: string; stderrPath: string; usage?: AgentRuntimeUsage }> {
  await writeFile(join(input.attemptDirectory, "prompt.md"), input.prompt);
  const writeLogs = async (result: AgentResult | undefined) =>
    await writeAgentAttemptLogFiles({
      attemptDirectory: input.attemptDirectory,
      result,
      context: input.context,
    });
  // Deprecated shim: a directly-injected executeAgent wins only when no
  // explicit backend was supplied, preserving existing test behavior.
  if (!input.dependencies.backend && input.dependencies.executeAgent) {
    try {
      await input.dependencies.executeAgent({
        stage: input.stage,
        prompt: input.prompt,
        worktreePath: requireWorkspacePath(input.workspace),
        attemptDirectory: input.attemptDirectory,
      });
      return await writeLogs(undefined);
    } catch (error) {
      await writeLogs(undefined);
      throw error;
    }
  }
  try {
    const result = await input.backend.runAgent(input.workspace, {
      stage: input.stage,
      prompt: input.prompt,
      attemptDirectory: input.attemptDirectory,
    });
    return { ...(await writeLogs(result)), ...(result.usage ? { usage: result.usage } : {}) };
  } catch (error) {
    await writeLogs(error as AgentResult);
    throw error;
  }
}

async function runCommandInWorkspace(input: {
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  command: string;
  timeoutMs?: number;
  maxToolOutputTokens?: number;
  attemptDirectory: string;
  context: RuntimeContext;
}): Promise<{
  result: CommandResult;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  outputSummary: ToolOutputBudgetSummary;
}> {
  const startedAt = Date.now();
  const result = await input.backend.runCommand(input.workspace, input.command, {
    timeoutMs: input.timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const paths = await writeCommandAttemptFiles({
    attemptDirectory: input.attemptDirectory,
    command: input.command,
    result,
    context: input.context,
    maxToolOutputTokens: input.maxToolOutputTokens,
  });
  return { result, durationMs, ...paths };
}

async function writeAgentAttemptLogFiles(input: {
  attemptDirectory: string;
  result?: AgentResult;
  context: RuntimeContext;
}): Promise<{ stdoutPath: string; stderrPath: string }> {
  const stdoutPath = join(input.attemptDirectory, "stdout.log");
  const stderrPath = join(input.attemptDirectory, "stderr.log");
  const stdout =
    input.result?.stdout ??
    "stdout was not captured by this agent execution backend.\n";
  const stderr =
    input.result?.stderr ??
    "stderr was not captured by this agent execution backend.\n";
  await writeFile(
    stdoutPath,
    redactRuntimeText(stdout, input.context) ?? "",
    "utf8",
  );
  await writeFile(
    stderrPath,
    redactRuntimeText(stderr, input.context) ?? "",
    "utf8",
  );
  return { stdoutPath, stderrPath };
}

async function executeGateStage(input: {
  runId: string;
  attempt: number;
  stage: Extract<Stage, { type: "gate" }>;
  repoPath: string;
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  flowName: string;
  flowMaxInputTokens?: number;
  flowMaxToolOutputTokens?: number;
  inputArtifacts: Map<string, InputArtifact>;
  attemptDirectory: string;
  context: RuntimeContext;
  eventStore: EventStore;
  providerStore: ProviderConnectionStore;
  loadedSkillUsages: StageSkillUsage[];
  previousFailures?: PreviousFailure[];
}): Promise<GateResult> {
  if (input.stage.mode === "analysis") {
    const scopedInputs = stageScopedInputs(input.inputArtifacts, input.stage);
    const report = analyzeSpecPlanTasks({
      artifacts: [...scopedInputs].map(([id, artifact]) => ({
        id,
        content: artifact.resource.content.toString("utf8"),
      })),
      constitution: input.context.constitution.loaded
        ? input.context.constitution.content
        : undefined,
    });
    const reportFilename = `${gateResultId(input.stage)}.md`;
    const reportPath = join(input.attemptDirectory, reportFilename);
    requirePathInside(input.context.runDirectory, reportPath, "analysis gate report");
    const reportContent = redactRuntimeText(report.markdown, input.context) ?? "";
    await writeFile(reportPath, reportContent, "utf8");
    const criticalCount = report.summary.critical;
    const blocking = input.stage.blocking ?? true;
    const failed = blocking && criticalCount > 0;
    const gateResult: GateResult = {
      id: gateResultId(input.stage),
      stageId: input.stage.id,
      name: input.stage.name,
      mode: "analysis",
      status: failed ? "failed" : "passed",
      reviewedArtifacts: [...input.stage.inputs],
      reviewOutput: {
        id: gateResultId(input.stage),
        path: reportPath,
        filename: reportFilename,
        mediaType: "text/markdown",
        content: reportContent,
        truncated: false,
      },
      reason: failed
        ? `analysis found ${criticalCount} critical finding${criticalCount === 1 ? "" : "s"}`
        : undefined,
      stdout: reportContent,
      attempt: input.attempt,
      createdAt: new Date().toISOString(),
    };
    await recordGateResultArtifact({
      inputs: input.inputArtifacts,
      stage: input.stage,
      result: gateResult,
      attemptDirectory: input.attemptDirectory,
      context: input.context,
      eventStore: input.eventStore,
    });
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "gate.completed",
      payload: redactRuntimeUnknown(
        { gate: gateResult, analysis: report.summary },
        input.context,
      ),
    });
    return gateResult;
  }

  if (input.stage.mode === "deterministic") {
    const { result, stdoutPath, stderrPath, outputPath, outputSummary } =
      await runCommandInWorkspace({
        backend: input.backend,
        workspace: input.workspace,
        command: input.stage.command,
        timeoutMs: input.stage.timeoutMs,
        maxToolOutputTokens: resolveMaxToolOutputTokens(
          input.stage,
          input.flowMaxToolOutputTokens,
        ),
        attemptDirectory: input.attemptDirectory,
        context: input.context,
      });
    appendToolOutputBudgetEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      summary: outputSummary,
      context: input.context,
    });
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "command.completed",
      payload: redactRuntimeUnknown({
        command: input.stage.command,
        exitCode: result.exitCode,
        stdout: outputSummary.stdout,
        stderr: outputSummary.stderr,
        stdoutPath,
        stderrPath,
        outputPath,
      }, input.context),
    });
    const reason =
      result.exitCode === 0
        ? undefined
        : redactRuntimeText(
            commandFailureMessage(input.stage.command, result),
            input.context,
          ) ?? "";
    const gateResult: GateResult = {
      id: gateResultId(input.stage),
      stageId: input.stage.id,
      name: input.stage.name,
      mode: "deterministic",
      status: result.exitCode === 0 ? "passed" : "failed",
      command: redactRuntimeText(input.stage.command, input.context) ?? "",
      reason,
      stdout: outputSummary.stdout,
      stderr: outputSummary.stderr,
      attempt: input.attempt,
      createdAt: new Date().toISOString(),
    };
    await recordGateResultArtifact({
      inputs: input.inputArtifacts,
      stage: input.stage,
      result: gateResult,
      attemptDirectory: input.attemptDirectory,
      context: input.context,
      eventStore: input.eventStore,
    });
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "gate.completed",
      payload: redactRuntimeUnknown({ gate: gateResult }, input.context),
    });
    return gateResult;
  }

  let reason: string | undefined;
  let reviewOutput: GateReviewOutput | undefined;
  let selectedStage = stageWithRuntimeCandidate(
    input.stage,
    stageRuntimeCandidates(input.stage)[0]!,
  );
  let selectedAttempt = input.attempt;
  let selectedAttemptDirectory = input.attemptDirectory;
  const unavailableCandidates: {
    candidate: RuntimeCandidate;
    preflight: Extract<AgentRuntimePreflightResult, { available: false }>;
  }[] = [];
  try {
    const candidates = stageRuntimeCandidates(input.stage);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      selectedStage = stageWithRuntimeCandidate(input.stage, candidate);
      selectedAttempt = input.attempt + index;
      selectedAttemptDirectory =
        index === 0
          ? input.attemptDirectory
          : await createAttemptDirectory({
              runDirectory: input.context.runDirectory,
              stageId: input.stage.id,
              attempt: selectedAttempt,
            });
      if (index > 0) {
        appendStageStarted({
          eventStore: input.eventStore,
          runId: input.runId,
          stage: input.stage,
          attempt: selectedAttempt,
          attemptDirectory: selectedAttemptDirectory,
          runtimeCandidate: { candidate, index, count: candidates.length },
        });
      }
      await assertStageDependencyRequirements({
        stage: selectedStage,
        providerStore: input.providerStore,
        eventStore: input.eventStore,
        runId: input.runId,
        attempt: selectedAttempt,
        context: input.context,
      });
      const usesLegacyExecuteAgent =
        !input.dependencies.backend && Boolean(input.dependencies.executeAgent);
      const preflight = !usesLegacyExecuteAgent && input.backend.preflightAgentRuntime
        ? await input.backend.preflightAgentRuntime(input.workspace, {
            stage: selectedStage,
            attemptDirectory: selectedAttemptDirectory,
          })
        : { available: true as const };
      if (!preflight.available) {
        unavailableCandidates.push({ candidate, preflight });
        appendRuntimeUnavailableEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          candidate,
          index,
          count: candidates.length,
          preflight,
          context: input.context,
        });
        if (index < candidates.length - 1) {
          appendRuntimeFallbackEvent({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            failed: candidate,
            next: candidates[index + 1]!,
            blocker: unavailableRuntimeBlocker({
              stageId: input.stage.id,
              runtime: candidate.runtime,
              reason: preflight.reason,
            }),
            context: input.context,
          });
          continue;
        }
        throw new Error(unavailableCandidatesMessage(unavailableCandidates));
      }
      const skills = await loadStageSkills({
        repoPath: input.repoPath,
        runDirectory: input.context.runDirectory,
        stageId: input.stage.id,
        skillIds: input.stage.skills,
      });
      recordLoadedSkills(input.loadedSkillUsages, input.stage.id, skills);
      if (skills.length > 0) {
        input.eventStore.append({
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          type: "stage.skills.loaded",
          payload: redactRuntimeUnknown(
            { skills: serializeLoadedSkills(skills) },
            input.context,
          ),
        });
      }
      const scopedInputs = stageScopedInputs(input.inputArtifacts, selectedStage);
      const budget = resolveMaxInputTokens(
        selectedStage,
        input.flowMaxInputTokens,
      );
      const { prompt, contextUsage, outcome } = fitPromptToBudget({
        inputs: scopedInputs,
        context: input.context,
        budget,
        render: (forced) =>
          renderPrompt(
            selectedStage,
            input.flowName,
            scopedInputs,
            selectedAttemptDirectory,
            input.context,
            skills,
            input.previousFailures ?? [],
            forced,
          ),
      });
      appendContextUsageEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        usage: contextUsage,
        context: input.context,
      });
      appendBudgetEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        outcome,
        context: input.context,
      });
      if (outcome.status === "exceeded") {
        throw new BudgetExceededError(
          `stage "${input.stage.id}" minimal context ${outcome.approxTokens} tokens exceeds budget ${outcome.budget}`,
        );
      }
      try {
        const result = await runAgentInWorkspace({
          backend: input.backend,
          dependencies: input.dependencies,
          workspace: input.workspace,
          stage: selectedStage,
          prompt,
          attemptDirectory: selectedAttemptDirectory,
          context: input.context,
        });
        appendRuntimeUsageEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          usage: result.usage,
          context: input.context,
        });
      } catch (error) {
        const blocked = classifyRunBlockedError({
          stageId: input.stage.id,
          runtime: selectedStage.runtime,
          error,
          context: input.context,
        });
        if (blocked && index < candidates.length - 1) {
          appendStageBlockedEvent({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            blocker: blocked.blocker,
            context: input.context,
          });
          appendRuntimeFallbackEvent({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            failed: candidate,
            next: candidates[index + 1]!,
            blocker: blocked.blocker,
            context: input.context,
          });
          continue;
        }
        if (blocked) {
          appendRunBlockedEvents({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            blocker: blocked.blocker,
            context: input.context,
          });
          throw new RunBlockedError(blocked.blocker, true);
        }
        throw error;
      }
      input.eventStore.append({
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        type: "stage.runtime.selected",
        payload: redactRuntimeUnknown(
          runtimeCandidateEventPayload({
            candidate,
            index,
            count: candidates.length,
          }),
          input.context,
        ),
      });
      const outputResult = await readReviewGateOutput({
        stage: selectedStage,
        attempt: selectedAttempt,
        attemptDirectory: selectedAttemptDirectory,
        context: input.context,
      });
      reviewOutput = outputResult.output;
      reason = outputResult.reason;
      break;
    }
  } catch (error) {
    // Re-throw run-blocked and budget-overflow errors rather than swallowing them
    // into a fabricated soft gate result. The budget re-throw does NOT bypass
    // retry: it reaches the same stage-failure/decideStagePolicy path as an agent
    // budget overflow, so a deterministic overflow exhausts attempts honestly.
    if (error instanceof RunBlockedError) {
      throw error;
    }
    if (error instanceof BudgetExceededError) {
      throw error;
    }
    reason = redactRuntimeText(
      error instanceof Error ? error.message : String(error),
      input.context,
    ) ?? "";
  }

  const gateResult: GateResult = {
    id: gateResultId(input.stage),
    stageId: input.stage.id,
    name: input.stage.name,
    mode: "review",
    status: reason ? "failed" : "passed",
    runtime: selectedStage.runtime,
    reviewedArtifacts: [...input.stage.inputs],
    reviewOutput,
    reason,
    attempt: selectedAttempt,
    createdAt: new Date().toISOString(),
  };
  await recordGateResultArtifact({
    inputs: input.inputArtifacts,
    stage: selectedStage,
    result: gateResult,
    attemptDirectory: selectedAttemptDirectory,
    context: input.context,
    eventStore: input.eventStore,
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: selectedAttempt,
    type: "gate.completed",
    payload: redactRuntimeUnknown({ gate: gateResult }, input.context),
  });
  return gateResult;
}

function recordGateStageResult(input: {
  runId: string;
  stage: Extract<Stage, { type: "gate" }>;
  attempt: number;
  maxAttempts: number;
  gateResult: GateResult;
  gateResults: GateResult[];
  completedStages: string[];
  eventStore: EventStore;
  context: RuntimeContext;
}): { gateAttempt: number; passed: boolean; reason?: string } {
  input.gateResults.push(input.gateResult);
  const gateAttempt = input.gateResult.attempt ?? input.attempt;
  if (input.gateResult.status !== "passed") {
    return {
      gateAttempt,
      passed: false,
      reason: input.gateResult.reason ?? "gate failed",
    };
  }
  markStageCompleted(input.completedStages, input.stage.id);
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: gateAttempt,
    maxAttempts: input.maxAttempts,
    context: input.context,
  });
  return { gateAttempt, passed: true };
}

async function executeApprovalStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "approval" }>;
  attempt: number;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
}): Promise<void> {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "approval.requested",
    payload: redactRuntimeUnknown({ prompt: input.stage.prompt }, input.context),
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "approval.resolved",
    payload: {
      approved: true,
      actor: AUTO_APPROVAL_ACTOR,
      decision: "approved",
      reviewedArtifactIds: input.stage.inputs,
    },
  });
  recordApprovalGate(input.context, input.stage.id);
  await persistArtifactRegistry(input.context);
  markStageCompleted(input.completedStages, input.stage.id);
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: 1,
    context: input.context,
  });
}

async function executeSyncChangeStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "sync-change" }>;
  attempt: number;
  attemptDirectory: string;
  worktreePath: string;
  reworkTarget: ReworkTargetState | undefined;
  inputArtifacts: Map<string, InputArtifact>;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
}): Promise<SyncMetadata> {
  if (!input.reworkTarget) {
    throw new Error("sync-change requires a change request target");
  }
  const { metadata, reportContent } = await runSyncChange({
    worktreePath: input.worktreePath,
    attemptDirectory: input.attemptDirectory,
    target: input.reworkTarget,
    strategy: input.stage.strategy,
    context: input.context,
  });
  for (const output of input.stage.outputs) {
    const id = outputId(output);
    recordGeneratedMarkdownArtifact({
      inputs: input.inputArtifacts,
      id,
      contentPath: metadata.reportPath,
      content: reportContent,
      producerStageId: input.stage.id,
      contract: outputContract(output),
      context: input.context,
      eventStore: input.eventStore,
    });
  }
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type:
      metadata.result === "clean"
        ? "change.sync.completed"
        : "change.sync.conflicted",
    payload: redactRuntimeUnknown(metadata, input.context),
  });
  markStageCompleted(input.completedStages, input.stage.id);
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: 1,
    context: input.context,
  });
  return metadata;
}

async function executePublishChangeStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "publish-change" }>;
  attempt: number;
  attemptDirectory: string;
  runWorkItemType?: string;
  flowName: string;
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  branchName: string;
  inputArtifacts: Map<string, InputArtifact>;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  injectedAgentMemory: { cleanup(): Promise<void> };
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
  onChangeTitleResolved: (title: ChangeTitleMetadata) => void;
  writeEvidenceSnapshot: () => Promise<string>;
}): Promise<{
  changeRequestUrl: string;
  changeRequest?: ChangeRequest;
  changeTitle: ChangeTitleMetadata;
}> {
  assertProtectedStageGate({
    workItemType: input.runWorkItemType,
    stage: input.stage,
    context: input.context,
  });
  const resolvedTitle = await resolveChangeTitle({
    flowName: input.flowName,
    stageInputs: input.stage.inputs,
    artifacts: input.inputArtifacts,
  });
  const changeTitle = changeTitleMetadata(resolvedTitle);
  input.onChangeTitleResolved(changeTitle);
  await input.injectedAgentMemory.cleanup();
  await input.backend.commitAll(input.workspace, resolvedTitle.commitMessage);
  const evidencePath = await input.writeEvidenceSnapshot();
  const publishInput = {
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    branchName: input.branchName,
    evidencePath,
    title: redactRuntimeText(resolvedTitle.title, input.context) ?? resolvedTitle.title,
    body: await readFile(evidencePath, "utf8"),
  };
  const published = input.dependencies.publishChange
    ? await input.dependencies.publishChange(publishInput)
    : input.dependencies.scmProvider
      ? await publishWithProvider(input.dependencies.scmProvider, publishInput)
      : await defaultPublishChange(publishInput, input.stage.provider, input.providerStore);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "change.published",
    payload: redactRuntimeUnknown({
      url: published.url,
      evidencePath: published.evidencePath,
      changeRequest: published.changeRequest,
      title: changeTitle,
    }, input.context),
  });
  await recordChangeRequestStageArtifacts({
    inputs: input.inputArtifacts,
    stage: input.stage,
    attemptDirectory: input.attemptDirectory,
    context: input.context,
    eventStore: input.eventStore,
    url: published.url,
    changeRequest: published.changeRequest,
    title: changeTitle,
  });
  markStageCompleted(input.completedStages, input.stage.id);
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: 1,
    context: input.context,
  });
  return {
    changeRequestUrl: published.url,
    changeRequest: published.changeRequest,
    changeTitle,
  };
}

async function executeUpdateChangeStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "update-change" }>;
  attempt: number;
  attemptDirectory: string;
  runWorkItemType?: string;
  flowName: string;
  repoPath: string;
  worktreePath: string;
  reworkTarget: ReworkTargetState | undefined;
  reworkProvider?: ScmProvider;
  inputArtifacts: Map<string, InputArtifact>;
  injectedAgentMemory: { cleanup(): Promise<void> };
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
  onChangeTitleResolved: (title: ChangeTitleMetadata) => void;
  recordTitleBeforeUpdate: boolean;
  writeEvidenceSnapshot: () => Promise<string>;
}): Promise<{
  changeRequestUrl: string;
  changeRequest: ChangeRequest;
  changeTitle: ChangeTitleMetadata;
}> {
  assertProtectedStageGate({
    workItemType: input.runWorkItemType,
    stage: input.stage,
    context: input.context,
  });
  if (!input.reworkTarget) {
    throw new Error("update-change requires a change request target");
  }
  const resolvedTitle = await resolveChangeTitle({
    flowName: input.flowName,
    stageInputs: input.stage.inputs,
    artifacts: input.inputArtifacts,
  });
  const changeTitle = changeTitleMetadata(resolvedTitle);
  if (input.recordTitleBeforeUpdate) {
    input.onChangeTitleResolved(changeTitle);
  }
  await input.injectedAgentMemory.cleanup();
  const provider = input.reworkProvider ?? scmProviderForRun(
    input.stage.provider ?? input.reworkTarget.provider,
    input.dependencies,
    input.providerStore,
  );
  const updated = await updateChangeRequest({
    provider,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    target: input.reworkTarget.resolved,
    title: resolvedTitle.title,
  });
  if (!input.recordTitleBeforeUpdate) {
    input.onChangeTitleResolved(changeTitle);
  }
  input.reworkTarget.updatedHeadSha = updated.updatedHeadSha;
  markStageCompleted(input.completedStages, input.stage.id);
  const evidencePath = await input.writeEvidenceSnapshot();
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "change.updated",
    payload: redactRuntimeUnknown({
      url: updated.url,
      evidencePath,
      changeRequest: updated.changeRequest,
      previousHeadSha: updated.previousHeadSha,
      updatedHeadSha: updated.updatedHeadSha,
      provider: input.reworkTarget.provider,
      target: input.reworkTarget.target,
      resolved: input.reworkTarget.resolved,
      title: changeTitle,
    }, input.context),
  });
  await recordChangeRequestStageArtifacts({
    inputs: input.inputArtifacts,
    stage: input.stage,
    attemptDirectory: input.attemptDirectory,
    context: input.context,
    eventStore: input.eventStore,
    url: updated.url,
    changeRequest: updated.changeRequest,
    previousHeadSha: updated.previousHeadSha,
    updatedHeadSha: updated.updatedHeadSha,
    title: changeTitle,
  });
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: 1,
    context: input.context,
  });
  return {
    changeRequestUrl: updated.url,
    changeRequest: updated.changeRequest,
    changeTitle,
  };
}

async function executeAgentStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "agent" }>;
  attempt: number;
  attemptDirectory: string;
  runDirectory: string;
  repoPath: string;
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  flowName: string;
  flowMaxInputTokens?: number;
  flowMaxAttempts?: number;
  inputArtifacts: Map<string, InputArtifact>;
  context: RuntimeContext;
  eventStore: EventStore;
  providerStore: ProviderConnectionStore;
  loadedSkillUsages: StageSkillUsage[];
  previousFailures?: PreviousFailure[];
  onAttemptSelected?: (attempt: number) => void;
  resumedFrom?: string;
  completedStages: string[];
}): Promise<{ selectedAttempt: number; selectedStage: Extract<Stage, { type: "agent" }> }> {
  const candidates = stageRuntimeCandidates(input.stage);
  let selectedAttempt = input.attempt;
  let selectedAttemptDirectory = input.attemptDirectory;
  let selectedStage = stageWithRuntimeCandidate(input.stage, candidates[0]!);
  const unavailableCandidates: {
    candidate: RuntimeCandidate;
    preflight: Extract<AgentRuntimePreflightResult, { available: false }>;
  }[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    selectedStage = stageWithRuntimeCandidate(input.stage, candidate);
    selectedAttempt = input.attempt + index;
    selectedAttemptDirectory =
      index === 0
        ? input.attemptDirectory
        : await createAttemptDirectory({
            runDirectory: input.runDirectory,
            stageId: input.stage.id,
            attempt: selectedAttempt,
          });
    input.onAttemptSelected?.(selectedAttempt);
    if (index > 0) {
      appendStageStarted({
        eventStore: input.eventStore,
        runId: input.runId,
        stage: input.stage,
        attempt: selectedAttempt,
        attemptDirectory: selectedAttemptDirectory,
        ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
        runtimeCandidate: { candidate, index, count: candidates.length },
      });
    }
    await assertStageDependencyRequirements({
      stage: selectedStage,
      providerStore: input.providerStore,
      eventStore: input.eventStore,
      runId: input.runId,
      attempt: selectedAttempt,
      context: input.context,
    });
    const usesLegacyExecuteAgent =
      !input.dependencies.backend && Boolean(input.dependencies.executeAgent);
    const preflight = !usesLegacyExecuteAgent && input.backend.preflightAgentRuntime
      ? await input.backend.preflightAgentRuntime(input.workspace, {
          stage: selectedStage,
          attemptDirectory: selectedAttemptDirectory,
        })
      : { available: true as const };
    if (!preflight.available) {
      unavailableCandidates.push({ candidate, preflight });
      appendRuntimeUnavailableEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        candidate,
        index,
        count: candidates.length,
        preflight,
        context: input.context,
      });
      if (index < candidates.length - 1) {
        appendRuntimeFallbackEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          failed: candidate,
          next: candidates[index + 1]!,
          blocker: unavailableRuntimeBlocker({
            stageId: input.stage.id,
            runtime: candidate.runtime,
            reason: preflight.reason,
          }),
          context: input.context,
        });
        continue;
      }
      throw new Error(unavailableCandidatesMessage(unavailableCandidates));
    }
    const skills = await loadStageSkills({
      repoPath: input.repoPath,
      runDirectory: input.runDirectory,
      stageId: input.stage.id,
      skillIds: input.stage.skills,
    });
    recordLoadedSkills(input.loadedSkillUsages, input.stage.id, skills);
    if (skills.length > 0) {
      input.eventStore.append({
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        type: "stage.skills.loaded",
        payload: redactRuntimeUnknown(
          { skills: serializeLoadedSkills(skills) },
          input.context,
        ),
      });
    }
    const scopedInputs = stageScopedInputs(input.inputArtifacts, selectedStage);
    const budget = resolveMaxInputTokens(selectedStage, input.flowMaxInputTokens);
    const { prompt, contextUsage, outcome } = fitPromptToBudget({
      inputs: scopedInputs,
      context: input.context,
      budget,
      render: (forced) =>
        renderPrompt(
          selectedStage,
          input.flowName,
          scopedInputs,
          selectedAttemptDirectory,
          input.context,
          skills,
          input.previousFailures ?? [],
          forced,
        ),
    });
    appendContextUsageEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: selectedAttempt,
      usage: contextUsage,
      context: input.context,
    });
    appendBudgetEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: selectedAttempt,
      outcome,
      context: input.context,
    });
    if (outcome.status === "exceeded") {
      throw new BudgetExceededError(
        `stage "${input.stage.id}" minimal context ${outcome.approxTokens} tokens exceeds budget ${outcome.budget}`,
      );
    }
    try {
      const result = await runAgentInWorkspace({
        backend: input.backend,
        dependencies: input.dependencies,
        workspace: input.workspace,
        stage: selectedStage,
        prompt,
        attemptDirectory: selectedAttemptDirectory,
        context: input.context,
      });
      appendRuntimeUsageEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        usage: result.usage,
        context: input.context,
      });
    } catch (error) {
      const blocked = classifyRunBlockedError({
        stageId: input.stage.id,
        runtime: selectedStage.runtime,
        error,
        context: input.context,
      });
      if (blocked && index < candidates.length - 1) {
        appendStageBlockedEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          blocker: blocked.blocker,
          context: input.context,
        });
        appendRuntimeFallbackEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          failed: candidate,
          next: candidates[index + 1]!,
          blocker: blocked.blocker,
          context: input.context,
        });
        continue;
      }
      if (blocked) {
        appendRunBlockedEvents({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          blocker: blocked.blocker,
          context: input.context,
        });
        throw new RunBlockedError(blocked.blocker, true);
      }
      throw error;
    }
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: selectedAttempt,
      type: "stage.runtime.selected",
      payload: redactRuntimeUnknown(
        runtimeCandidateEventPayload({
          candidate,
          index,
          count: candidates.length,
        }),
        input.context,
      ),
    });
    const validatedOutputs = await validateAttemptOutputs({
      runDirectory: input.runDirectory,
      attemptDirectory: selectedAttemptDirectory,
      stageId: input.stage.id,
      attempt: selectedAttempt,
      outputs: input.stage.outputs.map(outputContract),
    });
    await recordValidatedAttemptOutputs({
      inputs: input.inputArtifacts,
      stage: selectedStage,
      runDirectory: input.runDirectory,
      outputs: validatedOutputs.outputs,
      context: input.context,
      eventStore: input.eventStore,
    });
    enforceStageOutputContracts({
      stage: selectedStage,
      inputs: input.inputArtifacts,
      context: input.context,
    });
    markStageCompleted(input.completedStages, input.stage.id);
    const maxAttempts = maxAttemptsForStage(input.stage, input.flowMaxAttempts);
    appendSuccessfulStageCompletion({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: selectedAttempt,
      maxAttempts,
      context: input.context,
      payload: {
        outputs: stageOutputIds(input.stage),
        runtime: selectedStage.runtime,
        model: selectedStage.model,
      },
    });
    return { selectedAttempt, selectedStage };
  }
  return { selectedAttempt, selectedStage };
}

async function executeCommandStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "command" }>;
  attempt: number;
  attemptDirectory: string;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  flowMaxAttempts?: number;
  flowMaxToolOutputTokens?: number;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
}): Promise<{ failureError?: string }> {
  const { result, durationMs, stdoutPath, stderrPath, outputPath, outputSummary } =
    await runCommandInWorkspace({
      backend: input.backend,
      workspace: input.workspace,
      command: input.stage.command,
      timeoutMs: input.stage.timeoutMs,
      maxToolOutputTokens: resolveMaxToolOutputTokens(
        input.stage,
        input.flowMaxToolOutputTokens,
      ),
      attemptDirectory: input.attemptDirectory,
      context: input.context,
    });
  appendToolOutputBudgetEvent({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    summary: outputSummary,
    context: input.context,
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "command.completed",
    payload: redactRuntimeUnknown({
      command: input.stage.command,
      exitCode: result.exitCode,
      durationMs,
      cwd: requireWorkspacePath(input.workspace),
      ...(input.stage.timeoutMs !== undefined
        ? { timeoutMs: input.stage.timeoutMs }
        : {}),
      stdout: outputSummary.stdout,
      stderr: outputSummary.stderr,
      stdoutPath,
      stderrPath,
      outputPath,
    }, input.context),
  });
  if (result.exitCode !== 0) {
    return { failureError: commandFailureMessage(input.stage.command, result) };
  }
  markStageCompleted(input.completedStages, input.stage.id);
  appendSuccessfulStageCompletion({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: maxAttemptsForStage(input.stage, input.flowMaxAttempts),
    context: input.context,
  });
  return {};
}

async function readReviewGateOutput(input: {
  stage: Extract<Stage, { type: "gate"; mode: "review" }>;
  attempt: number;
  attemptDirectory: string;
  context: RuntimeContext;
}): Promise<{ output?: GateReviewOutput; reason?: string }> {
  const validated = await validateAttemptOutputs({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    stageId: input.stage.id,
    attempt: input.attempt,
    outputs: input.stage.outputs.map(outputContract),
  });
  const selected = validated.outputs[0];
  if (!selected) {
    return { reason: `review gate did not produce a declared output` };
  }
  if (
    selected.mediaType !== "text/markdown" &&
    selected.mediaType !== "text/plain"
  ) {
    return {
      reason: `review gate output ${selected.id} must be text/markdown or text/plain`,
    };
  }
  const content = await readFile(selected.absolutePath, "utf8");
  const redacted = redactRuntimeText(content, input.context) ?? "";
  const outputPath = selected.runRelativePath ?? selected.attemptRelativePath;
  const blockingReason = blockingReviewReason(redacted);
  return {
    output: {
      id: selected.id,
      path: outputPath,
      filename: selected.filename,
      mediaType: selected.mediaType,
      content: boundedText(redacted, MAX_REVIEW_OUTPUT_CONTENT_LENGTH),
      truncated: redacted.length > MAX_REVIEW_OUTPUT_CONTENT_LENGTH,
    },
    reason: blockingReason
      ? `review gate reported ${blockingReason} in ${outputPath}`
      : undefined,
  };
}

function blockingReviewReason(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (
      /^\s*(review\s+verdict|verdict)\s*:\s*(fail|failed|block|blocked)\b/i.test(
        line,
      )
    ) {
      return "a failing verdict";
    }
    if (/^\s*#{1,6}\s*P[01]\b/i.test(line)) {
      return "blocking findings";
    }
    if (/^\s*(?:#{1,6}\s*)?\[P[01]\]\b/i.test(line)) {
      return "blocking findings";
    }
  }
  return undefined;
}

async function defaultPublishChange(
  input: PublishChangeInput,
  providerName = "github",
  providerStore?: ProviderConnectionStore,
): Promise<PublishChangeResult> {
  return await publishWithProvider(
    createScmProvider(providerName, { store: providerStore }),
    input,
  );
}

async function publishWithProvider(
  provider: ScmProvider,
  input: PublishChangeInput,
): Promise<PublishChangeResult> {
  const changeRequest = await provider.publishChange({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    remoteName: "origin",
    baseBranch: input.baseBranch,
    headBranch: input.branchName,
    title: input.title,
    body: input.body,
    bodyPath: input.evidencePath,
  });
  return {
    url: changeRequest.url,
    evidencePath: input.evidencePath,
    changeRequest,
  };
}

function scmProviderForRun(
  providerName: "github" | "github-cli",
  dependencies: RunFlowDependencies,
  providerStore?: ProviderConnectionStore,
): ScmProvider {
  return (
    dependencies.scmProvider ??
    createScmProvider(providerName, { store: providerStore })
  );
}

async function resolveChangeRequestTarget(input: {
  provider: ScmProvider;
  repoPath: string;
  target: string;
}): Promise<ChangeRequestTarget> {
  if (!input.provider.resolveChangeRequestTarget) {
    throw new Error(
      `SCM provider ${input.provider.type} cannot resolve change request targets`,
    );
  }
  return await input.provider.resolveChangeRequestTarget({
    repoPath: input.repoPath,
    remoteName: "origin",
    target: input.target,
  });
}

async function checkoutChangeRequest(input: {
  provider: ScmProvider;
  repoPath: string;
  worktreePath: string;
  target: ChangeRequestTarget;
}): Promise<CheckoutChangeRequestResult> {
  if (!input.provider.checkoutChangeRequest) {
    throw new Error(
      `SCM provider ${input.provider.type} cannot checkout change request targets`,
    );
  }
  return await input.provider.checkoutChangeRequest({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    remoteName: "origin",
    target: input.target,
  });
}

async function updateChangeRequest(input: {
  provider: ScmProvider;
  repoPath: string;
  worktreePath: string;
  target: ChangeRequestTarget;
  title: string;
}): Promise<UpdateChangeRequestResult> {
  if (!input.provider.updateChangeRequest) {
    throw new Error(
      `SCM provider ${input.provider.type} cannot update change request targets`,
    );
  }
  return await input.provider.updateChangeRequest({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    remoteName: "origin",
    target: input.target,
    title: input.title,
  });
}

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

function sanitizeChangeTitle(value: string): string {
  return boundedText(
    value
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/\s+/g, " ")
      .trim(),
    MAX_CHANGE_TITLE_LENGTH,
  );
}

function fallbackChangeTitle(flowName: string): ResolvedChangeTitle {
  return {
    title: `Nitely: ${flowName}`,
    commitMessage: `feat: ${flowName}`,
    source: "fallback",
  };
}

async function readArtifactText(artifact: InputArtifact): Promise<string | undefined> {
  if (artifact.omittedByPolicy) {
    return undefined;
  }
  if (artifact.resource.content.length > 0) {
    return artifact.resource.content.toString("utf8");
  }
  try {
    return await readFile(artifact.contentPath, "utf8");
  } catch {
    return undefined;
  }
}

async function resolveChangeTitle(input: {
  flowName: string;
  stageInputs: string[];
  artifacts: Map<string, InputArtifact>;
  preferredArtifactIds?: string[];
}): Promise<ResolvedChangeTitle> {
  const fallback = fallbackChangeTitle(input.flowName);
  const preferredArtifactIds = input.preferredArtifactIds ?? TITLE_ARTIFACT_IDS;
  const artifactId = preferredArtifactIds.find(
    (candidate) =>
      input.stageInputs.includes(candidate) && input.artifacts.has(candidate),
  );
  if (!artifactId) {
    return fallback;
  }

  const artifact = input.artifacts.get(artifactId);
  const content = artifact ? await readArtifactText(artifact) : undefined;
  const title = sanitizeChangeTitle(content ?? "");
  if (!title) {
    return fallback;
  }

  return {
    title,
    commitMessage: `feat: ${boundedText(title, MAX_CHANGE_TITLE_LENGTH - "feat: ".length)}`,
    source: "artifact",
    artifactId,
  };
}

function changeTitleMetadata(title: ResolvedChangeTitle): ChangeTitleMetadata {
  return {
    title: title.title,
    source: title.source,
    artifactId: title.artifactId,
  };
}

function isTextualMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) return true;
  const type = mediaType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function headWithinBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let slice = buffer.subarray(0, maxBytes).toString("utf8");
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0) slice = slice.slice(0, lastNewline);
  return slice;
}

export interface InputContextUsage {
  inlinedBytes: number;
  savedBytes: number;
}

export interface ContextUsage {
  promptBytes: number;
  approxTokens: number;
  inputBytesInlined: number;
  inputBytesSaved: number;
  inputCount: number;
}

export function renderInputContext(
  input: InputArtifact,
  context: RuntimeContext,
  options?: { forcePathOnly?: boolean },
): { block: string; usage: InputContextUsage } {
  const artifact = context.artifactEntries.find(
    (candidate) => candidate.id === input.id,
  );
  const filename =
    artifact?.filename ??
    input.resource.metadata?.filename ??
    basename(input.contentPath);
  const runPath =
    artifact?.path ??
    manifestRunRelativePath(context.runDirectory, input.contentPath);
  const metadataLines = [
    `Artifact: ${input.id}`,
    artifact?.name ? `Name: ${redactRuntimeText(artifact.name, context) ?? ""}` : undefined,
    artifact?.type ? `Type: ${redactRuntimeText(artifact.type, context) ?? ""}` : undefined,
    artifact?.version ? `Version: ${redactRuntimeText(artifact.version, context) ?? ""}` : undefined,
    artifact?.description ? `Description: ${redactRuntimeText(artifact.description, context) ?? ""}` : undefined,
    artifact?.producer ? `Producer: ${redactRuntimeText(artifact.producer, context) ?? ""}` : undefined,
    `Media type: ${redactRuntimeText(artifact?.mediaType ?? input.resource.mediaType, context) ?? ""}`,
    filename ? `Filename: ${redactRuntimeText(filename, context) ?? ""}` : undefined,
    runPath ? `Path: ${redactRuntimeText(runPath, context) ?? ""}` : undefined,
    runPath ? `Run-relative path: ${redactRuntimeText(runPath, context) ?? ""}` : undefined,
    artifact?.sourceUri ? `Source URI: ${redactRuntimeText(artifact.sourceUri, context) ?? ""}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const baseLines = [
    `## Input: ${input.id}`,
    "",
    ...metadataLines,
    `Source: ${redactRuntimeText(input.resource.sourceUri, context) ?? ""}`,
  ];

  if (input.omittedByPolicy) {
    const block = [
      ...baseLines,
      "Omitted by context policy.",
      `Policy reason: ${redactRuntimeText(input.omittedByPolicy.reason, context) ?? "matched context policy"}`,
      input.omittedByPolicy.matchedPattern
        ? `Matched pattern: ${redactRuntimeText(input.omittedByPolicy.matchedPattern, context) ?? ""}`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    return { block, usage: { inlinedBytes: 0, savedBytes: 0 } };
  }

  const fullPath = redactRuntimeText(input.contentPath, context) ?? input.contentPath;
  const header = [
    ...baseLines,
    `Snapshot: ${runPath ?? ""}`,
    `Full content: ${fullPath}`,
  ];

  if (!isTextualMediaType(artifact?.mediaType ?? input.resource.mediaType)) {
    return {
      block: [...header, "", "Binary artifact — not previewed. Read the file at the path above if needed."].join("\n"),
      usage: { inlinedBytes: 0, savedBytes: input.resource.content.byteLength },
    };
  }

  const redactedFull = redactRuntimeText(input.resource.content.toString("utf8"), context) ?? "";
  const fullBytes = Buffer.byteLength(redactedFull, "utf8");

  if (options?.forcePathOnly) {
    return {
      block: [
        ...header,
        "",
        "Content omitted to fit the stage context budget — full content at the path above.",
        `You MUST read the full file at ${fullPath} before using this input. Do not proceed without it.`,
      ].join("\n"),
      usage: { inlinedBytes: 0, savedBytes: fullBytes },
    };
  }

  if (fullBytes <= INPUT_INLINE_FULL_LIMIT) {
    return {
      block: [...header, "", "Content preview:", "", "```", redactedFull, "```"].join("\n"),
      usage: { inlinedBytes: fullBytes, savedBytes: 0 },
    };
  }

  const preview = headWithinBytes(redactedFull, INPUT_INLINE_FULL_LIMIT);
  const inlinedBytes = Buffer.byteLength(preview, "utf8");
  return {
    block: [
      ...header,
      "",
      "Content preview (truncated — full content at the path above):",
      "",
      "```",
      preview,
      "```",
      "",
      `The preview above is truncated. You MUST read the full file at ${fullPath} before using this input. Do not rely on the preview alone for this artifact.`,
    ].join("\n"),
    usage: { inlinedBytes, savedBytes: fullBytes - inlinedBytes },
  };
}

function renderInputs(
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
  forcedPathOnlyIds?: Set<string>,
): { text: string; inputBytesInlined: number; inputBytesSaved: number; inputCount: number } {
  const blocks: string[] = [];
  let inputBytesInlined = 0;
  let inputBytesSaved = 0;
  let inputCount = 0;
  for (const input of inputs.values()) {
    const { block, usage } = renderInputContext(input, context, {
      forcePathOnly: forcedPathOnlyIds?.has(input.id) ?? false,
    });
    blocks.push(block);
    inputBytesInlined += usage.inlinedBytes;
    inputBytesSaved += usage.savedBytes;
    inputCount += 1;
  }
  return {
    text: blocks.join("\n\n"),
    inputBytesInlined,
    inputBytesSaved,
    inputCount,
  };
}

function stageScopedInputs(
  inputs: Map<string, InputArtifact>,
  stage: Pick<Stage, "inputs">,
): Map<string, InputArtifact> {
  const scoped = new Map<string, InputArtifact>();
  for (const id of stage.inputs) {
    const input = inputs.get(id);
    if (input) {
      scoped.set(id, input);
    }
  }
  return scoped;
}

function renderOutputContract(
  output: Stage["outputs"][number],
  context: RuntimeContext,
): string {
  const contract = outputContract(output);
  const lines = [
    `- ${redactRuntimeText(contract.id, context) ?? ""}`,
    contract.name
      ? `  Name: ${redactRuntimeText(contract.name, context) ?? ""}`
      : undefined,
    contract.type
      ? `  Type: ${redactRuntimeText(contract.type, context) ?? ""}`
      : undefined,
    contract.description
      ? `  Description: ${redactRuntimeText(contract.description, context) ?? ""}`
      : undefined,
    contract.mediaType
      ? `  Media type: ${redactRuntimeText(contract.mediaType, context) ?? ""}`
      : undefined,
    contract.version
      ? `  Version: ${redactRuntimeText(contract.version, context) ?? ""}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function renderSkills(skills: LoadedSkill[], context: RuntimeContext): string[] {
  if (skills.length === 0) return [];

  const lines = ["## Skills", ""];
  for (const skill of skills) {
    lines.push(
      `### Skill: ${redactRuntimeText(skill.id, context) ?? ""}`,
      "",
      `Description: ${redactRuntimeText(skill.description, context) ?? ""}`,
      `Source: ${redactRuntimeText(skill.sourcePath, context) ?? ""}`,
      `Version: sha256:${skill.contentHash}`,
      "",
      redactRuntimeText(skill.body, context) ?? "",
      "",
      "Resources:",
    );
    if (skill.resources.length === 0) {
      lines.push("- none");
    } else {
      for (const resource of skill.resources) {
        lines.push(
          `- ${redactRuntimeText(resource.path, context) ?? ""} -> ${
            redactRuntimeText(resource.snapshotPath, context) ?? ""
          }`,
        );
      }
    }
    lines.push("");
  }
  return lines;
}

function renderConstitution(context: RuntimeContext): string[] {
  if (!context.constitution.loaded) {
    return [];
  }
  return [
    "## Governing Principles",
    "",
    `Source: ${redactRuntimeText(context.constitution.path, context) ?? ""}`,
    `Hash: ${context.constitution.hash}`,
    "",
    redactRuntimeText(context.constitution.content, context) ?? "",
    "",
  ];
}

function renderPrompt(
  stage: AgentRunnableStage,
  flowName: string,
  inputs: Map<string, InputArtifact>,
  attemptDirectory: string,
  context: RuntimeContext,
  skills: LoadedSkill[] = [],
  previousFailures: PreviousFailure[] = [],
  forcedPathOnlyIds?: Set<string>,
): { prompt: string; contextUsage: ContextUsage } {
  const retryContext =
    previousFailures.length === 0
      ? []
      : [
          "## Previous Failure Context",
          "",
          ...previousFailures.map(
            (failure) =>
              `- attempt ${failure.attempt} failed: ${
                redactRuntimeText(failure.error, context) ?? ""
              }`,
          ),
          "",
          "Do not repeat the failed approach. Use this failure context to choose a different fix.",
          "",
        ];
  const inputs_ = renderInputs(inputs, context, forcedPathOnlyIds);
  const prompt = [
    `# Nitely Stage: ${stage.id}`,
    "",
    `Flow: ${flowName}`,
    "",
    "## Instructions",
    "",
    redactRuntimeText(stage.prompt, context) ?? "",
    "",
    ...renderConstitution(context),
    ...renderSkills(skills, context),
    "## Required Outputs",
    "",
    stage.outputs.map((output) => renderOutputContract(output, context)).join("\n"),
    "",
    "## Output Files",
    "",
    "Write each required output artifact to:",
    attemptDirectory,
    "",
    "Accepted filenames:",
    stageOutputIds(stage)
      .map((id) => `- ${id}.md or ${id}.txt`)
      .join("\n"),
    "",
    "## Available Inputs",
    "",
    inputs_.text,
    "",
    ...retryContext,
  ].join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  return {
    prompt,
    contextUsage: {
      promptBytes,
      approxTokens: Math.ceil(promptBytes / 4),
      inputBytesInlined: inputs_.inputBytesInlined,
      inputBytesSaved: inputs_.inputBytesSaved,
      inputCount: inputs_.inputCount,
    },
  };
}

export interface BudgetOutcome {
  status: "ok" | "trimmed" | "exceeded";
  budget?: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  trimmedInputIds?: string[];
}

export function fitPromptToBudget(input: {
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
  budget: number | undefined;
  render: (forcedPathOnlyIds: Set<string>) => {
    prompt: string;
    contextUsage: ContextUsage;
  };
}): { prompt: string; contextUsage: ContextUsage; outcome: BudgetOutcome } {
  const forced = new Set<string>();
  let { prompt, contextUsage } = input.render(forced);
  if (input.budget === undefined || contextUsage.approxTokens <= input.budget) {
    return { prompt, contextUsage, outcome: { status: "ok" } };
  }
  const before = contextUsage.approxTokens;
  // Order inputs by how many bytes they currently inline (largest first).
  const candidates = [...input.inputs.values()]
    .map((artifact) => ({
      id: artifact.id,
      inlinedBytes: renderInputContext(artifact, input.context).usage.inlinedBytes,
    }))
    .filter((entry) => entry.inlinedBytes > 0)
    .sort((left, right) => right.inlinedBytes - left.inlinedBytes);
  const trimmedInputIds: string[] = [];
  for (const candidate of candidates) {
    forced.add(candidate.id);
    trimmedInputIds.push(candidate.id);
    ({ prompt, contextUsage } = input.render(forced));
    if (contextUsage.approxTokens <= input.budget) {
      return {
        prompt,
        contextUsage,
        outcome: {
          status: "trimmed",
          budget: input.budget,
          approxTokensBefore: before,
          approxTokensAfter: contextUsage.approxTokens,
          trimmedInputIds,
        },
      };
    }
  }
  return {
    prompt,
    contextUsage,
    outcome: {
      status: "exceeded",
      budget: input.budget,
      approxTokens: contextUsage.approxTokens,
    },
  };
}

function appendContextUsageEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  usage: ContextUsage;
  context: RuntimeContext;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.context.usage",
    payload: redactRuntimeUnknown({ ...input.usage }, input.context),
  });
}

function appendRuntimeUsageEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  usage?: AgentRuntimeUsage;
  context: RuntimeContext;
}): void {
  if (!input.usage) return;
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.runtime.usage",
    payload: redactRuntimeUnknown({ ...input.usage }, input.context),
  });
}

function appendToolOutputBudgetEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  summary: ToolOutputBudgetSummary;
  context: RuntimeContext;
}): void {
  if (!input.summary.trimmed || input.summary.budget === undefined) return;
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "budget.trimmed",
    payload: redactRuntimeUnknown(
      {
        budgetKind: "tool-output",
        budget: input.summary.budget,
        approxTokensBefore: input.summary.approxTokensBefore,
        approxTokensAfter: input.summary.approxTokensAfter,
      },
      input.context,
    ),
  });
}

function appendBudgetEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  outcome: BudgetOutcome;
  context: RuntimeContext;
}): void {
  if (input.outcome.status === "trimmed") {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "budget.trimmed",
      payload: redactRuntimeUnknown(
        {
          budget: input.outcome.budget,
          approxTokensBefore: input.outcome.approxTokensBefore,
          approxTokensAfter: input.outcome.approxTokensAfter,
          trimmedInputIds: input.outcome.trimmedInputIds,
        },
        input.context,
      ),
    });
  } else if (input.outcome.status === "exceeded") {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "budget.exceeded",
      payload: redactRuntimeUnknown(
        { budget: input.outcome.budget, approxTokens: input.outcome.approxTokens },
        input.context,
      ),
    });
  }
}

function recordLoadedSkills(
  usages: StageSkillUsage[],
  stageId: string,
  skills: LoadedSkill[],
): void {
  if (skills.length === 0) return;
  const existing = usages.find((usage) => usage.stageId === stageId);
  if (!existing) {
    usages.push({ stageId, skills });
    return;
  }
  for (const skill of skills) {
    if (
      !existing.skills.some(
        (candidate) =>
          candidate.id === skill.id &&
          candidate.contentHash === skill.contentHash,
      )
    ) {
      existing.skills.push(skill);
    }
  }
}

function serializeLoadedSkills(skills: LoadedSkill[]): PersistedLoadedSkill[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourcePath: skill.sourcePath,
    contentHash: skill.contentHash,
    resources: skill.resources.map((resource) => ({ ...resource })),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function parseLoadedSkillResources(value: unknown): LoadedSkill["resources"] {
  if (!Array.isArray(value)) return [];
  const resources: LoadedSkill["resources"] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = stringField(item, "path");
    const snapshotPath = stringField(item, "snapshotPath");
    const sizeBytes = numberField(item, "sizeBytes");
    if (!path || !snapshotPath || sizeBytes === undefined) continue;
    const mediaType = stringField(item, "mediaType");
    resources.push({
      path,
      snapshotPath,
      sizeBytes,
      ...(mediaType ? { mediaType } : {}),
    });
  }
  return resources;
}

function parseLoadedSkillEventPayload(payload: unknown): LoadedSkill[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) return [];
  const skills: LoadedSkill[] = [];
  for (const item of payload.skills) {
    if (!isRecord(item)) continue;
    const id = stringField(item, "id");
    const name = stringField(item, "name");
    const description = stringField(item, "description");
    const sourcePath = stringField(item, "sourcePath");
    const contentHash = stringField(item, "contentHash");
    if (!id || !name || !description || !sourcePath || !contentHash) continue;
    skills.push({
      id,
      name,
      description,
      sourcePath,
      contentHash,
      body: "",
      resources: parseLoadedSkillResources(item.resources),
    });
  }
  return skills;
}

function loadedSkillUsagesFromEvents(events: StoredRunEvent[]): StageSkillUsage[] {
  const usages: StageSkillUsage[] = [];
  for (const event of events) {
    if (event.type !== "stage.skills.loaded" || !event.stageId) continue;
    recordLoadedSkills(
      usages,
      event.stageId,
      parseLoadedSkillEventPayload(event.payload),
    );
  }
  return usages;
}

function maxAttemptsForStage(stage: Stage, flowMaxAttempts?: number): number {
  return stage.maxAttempts ?? flowMaxAttempts ?? 1;
}

export function resolveMaxInputTokens(
  stage: Stage,
  flowMaxInputTokens: number | undefined,
): number | undefined {
  const stageMax = "maxInputTokens" in stage ? stage.maxInputTokens : undefined;
  return stageMax ?? flowMaxInputTokens;
}

function resolveMaxToolOutputTokens(
  stage: Stage,
  flowMaxToolOutputTokens: number | undefined,
): number | undefined {
  const stageMax =
    "maxToolOutputTokens" in stage ? stage.maxToolOutputTokens : undefined;
  return stageMax ?? flowMaxToolOutputTokens;
}

async function createAttemptDirectory(input: {
  runDirectory: string;
  stageId: string;
  attempt: number;
}): Promise<string> {
  assertSafePathSegment("stage id", input.stageId);
  const stagesDirectory = join(input.runDirectory, "stages");
  const stageDirectory = join(stagesDirectory, input.stageId);
  requirePathInside(stagesDirectory, stageDirectory, "stage directory");
  await mkdir(stageDirectory, { recursive: true });
  const attemptDirectory = join(stageDirectory, String(input.attempt));
  requirePathInside(stagesDirectory, attemptDirectory, "attempt directory");
  await mkdir(attemptDirectory);
  return attemptDirectory;
}

function commandFailureMessage(command: string, result: { exitCode: number; stderr: string }): string {
  return `command failed with exit code ${result.exitCode}: ${command}\n${result.stderr}`;
}

function gateResultId(stage: Extract<Stage, { type: "gate" }>): string {
  return stageOutputIds(stage)[0] ?? `${stage.id}-gate-result`;
}

interface ToolOutputBudgetSummary {
  stdout: string;
  stderr: string;
  trimmed: boolean;
  approxTokensBefore: number;
  approxTokensAfter: number;
  budget?: number;
}

function truncateWithMarker(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  const marker = "\n[truncated]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    return headWithinBytes("[truncated]", maxBytes);
  }
  return `${headWithinBytes(text, maxBytes - markerBytes)}${marker}`;
}

function summarizeToolOutput(input: {
  stdout: string;
  stderr: string;
  maxToolOutputTokens?: number;
  stdoutPath: string;
  stderrPath: string;
}): ToolOutputBudgetSummary {
  const approxTokensBefore = Math.ceil(
    Buffer.byteLength(`${input.stdout}${input.stderr}`, "utf8") / 4,
  );
  if (
    input.maxToolOutputTokens === undefined ||
    approxTokensBefore <= input.maxToolOutputTokens
  ) {
    return {
      stdout: input.stdout,
      stderr: input.stderr,
      trimmed: false,
      approxTokensBefore,
      approxTokensAfter: approxTokensBefore,
      budget: input.maxToolOutputTokens,
    };
  }

  const maxBytes = Math.max(1, input.maxToolOutputTokens * 4);
  const stdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(input.stderr, "utf8");
  const half = Math.floor(maxBytes / 2);
  let stdoutBudget = input.stderr ? Math.min(stdoutBytes, half) : maxBytes;
  let stderrBudget = input.stdout ? Math.min(stderrBytes, maxBytes - stdoutBudget) : maxBytes;
  let remaining = maxBytes - stdoutBudget - stderrBudget;
  if (remaining > 0 && stdoutBytes > stdoutBudget) {
    const extra = Math.min(remaining, stdoutBytes - stdoutBudget);
    stdoutBudget += extra;
    remaining -= extra;
  }
  if (remaining > 0 && stderrBytes > stderrBudget) {
    stderrBudget += Math.min(remaining, stderrBytes - stderrBudget);
  }
  const stdout =
    stdoutBytes > stdoutBudget
      ? truncateWithMarker(input.stdout, stdoutBudget)
      : input.stdout;
  const stderr =
    stderrBytes > stderrBudget
      ? truncateWithMarker(input.stderr, stderrBudget)
      : input.stderr;
  return {
    stdout,
    stderr,
    trimmed: true,
    approxTokensBefore,
    approxTokensAfter: Math.ceil(Buffer.byteLength(`${stdout}${stderr}`, "utf8") / 4),
    budget: input.maxToolOutputTokens,
  };
}

async function writeCommandAttemptFiles(input: {
  attemptDirectory: string;
  command: string;
  result: { stdout: string; stderr: string; exitCode: number };
  context: RuntimeContext;
  maxToolOutputTokens?: number;
}): Promise<{
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  outputSummary: ToolOutputBudgetSummary;
}> {
  const stdoutPath = join(input.attemptDirectory, "stdout.log");
  const stderrPath = join(input.attemptDirectory, "stderr.log");
  const outputPath = join(input.attemptDirectory, "output.md");
  const stdout = redactRuntimeText(input.result.stdout, input.context) ?? "";
  const stderr = redactRuntimeText(input.result.stderr, input.context) ?? "";
  const command = redactRuntimeText(input.command, input.context) ?? "";
  const outputSummary = summarizeToolOutput({
    stdout,
    stderr,
    maxToolOutputTokens: input.maxToolOutputTokens,
    stdoutPath,
    stderrPath,
  });
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(
    outputPath,
    [
      "# Command Attempt",
      "",
      `Command: ${command}`,
      `Exit code: ${input.result.exitCode}`,
      `Stdout: ${stdoutPath}`,
      `Stderr: ${stderrPath}`,
      outputSummary.trimmed
        ? `Output truncated to maxToolOutputTokens=${input.maxToolOutputTokens}; full logs are stored at the paths above.`
        : "Output was within the configured tool-output budget.",
      "",
      "## Stdout Summary",
      "",
      "```",
      outputSummary.stdout,
      "```",
      "",
      "## Stderr Summary",
      "",
      "```",
      outputSummary.stderr,
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  return { stdoutPath, stderrPath, outputPath, outputSummary };
}

function gitFailureMessage(args: string[], result: GitResult): string {
  return `git ${args.join(" ")} failed with exit code ${result.exitCode}\n${result.stderr}`;
}

async function runSyncChange(input: {
  worktreePath: string;
  attemptDirectory: string;
  target: ReworkTargetState;
  strategy: "merge";
  context: RuntimeContext;
}): Promise<{ metadata: SyncMetadata; reportContent: string }> {
  const stdoutPath = join(input.attemptDirectory, "stdout.log");
  const stderrPath = join(input.attemptDirectory, "stderr.log");
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const run = async (args: string[]): Promise<GitResult> => {
    const result = await runGitResult(input.worktreePath, args);
    stdoutChunks.push(`$ git ${args.join(" ")}\n${result.stdout}`);
    stderrChunks.push(`$ git ${args.join(" ")}\n${result.stderr}`);
    return result;
  };
  const writeLogs = async () => {
    await writeFile(
      stdoutPath,
      redactRuntimeText(stdoutChunks.join("\n"), input.context) ?? "",
      "utf8",
    );
    await writeFile(
      stderrPath,
      redactRuntimeText(stderrChunks.join("\n"), input.context) ?? "",
      "utf8",
    );
  };
  const requireCleanGit = async (args: string[]): Promise<string> => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      await writeLogs();
      throw new Error(gitFailureMessage(args, result));
    }
    return result.stdout.trim();
  };

  const baseBranch = input.target.resolved.baseBranch;
  await requireCleanGit(["fetch", "origin", baseBranch]);
  const baseSha = await requireCleanGit(["rev-parse", "FETCH_HEAD"]);
  const headShaBefore = await requireCleanGit(["rev-parse", "HEAD"]);
  const merge = await run(["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);

  let result: SyncMetadata["result"];
  let headShaAfter: string | undefined;
  let conflictFiles: string[] = [];
  if (merge.exitCode === 0) {
    result = "clean";
    headShaAfter = await requireCleanGit(["rev-parse", "HEAD"]);
  } else {
    const conflicts = await run(["diff", "--name-only", "--diff-filter=U"]);
    conflictFiles = conflicts.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (conflictFiles.length === 0) {
      await writeLogs();
      throw new Error(gitFailureMessage(["merge", "--no-ff", "--no-edit", "FETCH_HEAD"], merge));
    }
    result = "conflicted";
  }
  await writeLogs();

  const reportPath = join(input.attemptDirectory, "sync-report.md");
  const metadata: SyncMetadata = {
    prUrl: input.target.resolved.url,
    prNumber: input.target.resolved.number,
    baseBranch,
    strategy: input.strategy,
    baseSha,
    headShaBefore,
    headShaAfter,
    result,
    conflictFiles,
    stdoutPath,
    stderrPath,
    reportPath,
  };
  const reportContent =
    redactRuntimeText(
      [
        "# Sync Report",
        "",
        `PR URL: ${metadata.prUrl}`,
        `PR Number: ${metadata.prNumber}`,
        `Base branch: ${metadata.baseBranch}`,
        `Strategy: ${metadata.strategy}`,
        `Base SHA: ${metadata.baseSha}`,
        `Head SHA before sync: ${metadata.headShaBefore}`,
        `Head SHA after sync: ${metadata.headShaAfter ?? ""}`,
        `Result: ${metadata.result}`,
        "",
        "## Conflict Files",
        "",
        metadata.conflictFiles.length > 0
          ? metadata.conflictFiles.map((file) => `- ${file}`).join("\n")
          : "- none",
        "",
        "## Git Logs",
        "",
        `Stdout: ${metadata.stdoutPath}`,
        `Stderr: ${metadata.stderrPath}`,
        "",
      ].join("\n"),
      input.context,
    ) ?? "";
  await writeFile(reportPath, reportContent, "utf8");
  return { metadata, reportContent };
}

function recordGeneratedMarkdownArtifact(input: {
  inputs: Map<string, InputArtifact>;
  id: string;
  contentPath: string;
  content: string;
  mediaType?: string;
  manifestSource?: ValidatedAttemptOutput["manifestSource"];
  producerStageId?: string;
  attempt?: number;
  contract?: ArtifactContract;
  context?: RuntimeContext;
  eventStore?: EventStore;
  rehydrateExisting?: boolean;
}): void {
  const mediaType = input.mediaType ?? input.contract?.mediaType ?? "text/markdown";
  const filename = basename(input.contentPath);
  input.inputs.set(input.id, {
    id: input.id,
    reference: { connector: "generated", uri: input.contentPath },
    resource: {
      sourceUri: input.contentPath,
      mediaType,
      content: Buffer.from(input.content, "utf8"),
      metadata: { filename },
    },
    contentPath: input.contentPath,
  });
  if (input.context) {
    const relativePath = manifestRunRelativePath(
      input.context.runDirectory,
      input.contentPath,
    );
    const artifact: RunArtifact = withProvenance(
      {
        ...input.contract,
        id: input.id,
        producer: input.producerStageId ?? "generated",
        mediaType,
        path: relativePath,
        sourceUri: relativePath ?? filename,
        filename,
        manifestSource: input.manifestSource,
        createdAt: new Date().toISOString(),
      },
      input.content,
      {
        runId: input.context.runId,
        stageId: input.producerStageId,
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
    );
    const existingIndex = input.context.artifactEntryIndexes.get(
      artifactEntryKey(artifact),
    );
    const existing =
      existingIndex === undefined
        ? undefined
        : input.context.artifactEntries[existingIndex];
    if (input.rehydrateExisting && existing) {
      upsertArtifactEntry(input.context, {
        ...artifact,
        ...existing,
        createdAt: existing.createdAt ?? artifact.createdAt,
      });
    } else {
      const event = input.eventStore?.append({
        runId: input.context.runId,
        stageId: input.producerStageId,
        type: "artifact.published",
        payload: redactRuntimeUnknown({ artifact }, input.context),
      });
      upsertArtifactEntry(input.context, {
        ...artifact,
        createdAt: event?.createdAt ?? artifact.createdAt,
      });
    }
    upsertManifestEntry(input.context, {
      id: input.id,
      kind: "generated-artifact",
      connector: "generated",
      sourceUri: relativePath ?? filename,
      mediaType,
      filename,
      runRelativePath: relativePath,
      policy: { decision: "allowed" },
    });
  }
}

async function recordGateResultArtifact(input: {
  inputs: Map<string, InputArtifact>;
  stage: Extract<Stage, { type: "gate" }>;
  result: GateResult;
  attemptDirectory: string;
  context: RuntimeContext;
  eventStore?: EventStore;
}): Promise<void> {
  const filename = `${input.result.id}.json`;
  const contentPath = join(input.attemptDirectory, filename);
  requirePathInside(input.context.runDirectory, contentPath, "gate result artifact");
  const content = `${JSON.stringify(input.result, null, 2)}\n`;
  await writeFile(contentPath, content, "utf8");

  const relativePath = manifestRunRelativePath(
    input.context.runDirectory,
    contentPath,
  );
  const contract = input.stage.outputs[0]
    ? outputContract(input.stage.outputs[0])
    : undefined;
  const artifact: RunArtifact = {
    ...contract,
    id: input.result.id,
    type: "gate.result",
    producer: input.stage.id,
    mediaType: "application/json",
    path: relativePath,
    sourceUri: relativePath ?? filename,
    filename,
    createdAt: input.result.createdAt,
    gateResult: input.result,
  };
  const event = input.eventStore?.append({
    runId: input.context.runId,
    stageId: input.stage.id,
    type: "artifact.published",
    payload: redactRuntimeUnknown({ artifact }, input.context),
  });
  upsertArtifactEntry(input.context, {
    ...artifact,
    createdAt: event?.createdAt ?? artifact.createdAt,
  });
  upsertManifestEntry(input.context, {
    id: input.result.id,
    kind: "generated-artifact",
    connector: "generated",
    sourceUri: relativePath ?? filename,
    mediaType: "application/json",
    filename,
    runRelativePath: relativePath,
    policy: { decision: "allowed" },
  });
  input.inputs.set(input.result.id, {
    id: input.result.id,
    reference: { connector: "generated", uri: contentPath },
    resource: {
      sourceUri: relativePath ?? contentPath,
      mediaType: "application/json",
      content: Buffer.from(content, "utf8"),
      metadata: { filename },
    },
    contentPath,
  });
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
}

async function recordChangeRequestStageArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stage: Extract<Stage, { type: "publish-change" | "update-change" }>;
  attemptDirectory: string;
  context: RuntimeContext;
  eventStore: EventStore;
  url: string;
  changeRequest?: ChangeRequest;
  previousHeadSha?: string;
  updatedHeadSha?: string;
  title: ChangeTitleMetadata;
}): Promise<void> {
  for (const output of input.stage.outputs) {
    const id = outputId(output);
    const contentPath = join(input.attemptDirectory, `${id}.md`);
    requirePathInside(input.context.runDirectory, contentPath, "change request artifact");
    const lines = [
      "# Change Request",
      "",
      `URL: ${input.url}`,
      `Title: ${input.title.title}`,
      `Title source: ${input.title.source}`,
    ];
    if (input.title.artifactId) {
      lines.push(`Title artifact: ${input.title.artifactId}`);
    }
    if (input.changeRequest) {
      lines.push(
        `Provider: ${input.changeRequest.provider}`,
        `Number: ${input.changeRequest.number}`,
        `Repository: ${input.changeRequest.owner}/${input.changeRequest.repository}`,
        `Base branch: ${input.changeRequest.baseBranch}`,
        `Head branch: ${input.changeRequest.headBranch}`,
        `Draft: ${input.changeRequest.draft}`,
      );
      if (input.changeRequest.outcome) {
        lines.push(`Change outcome: ${input.changeRequest.outcome}`);
      }
    }
    if (input.previousHeadSha) {
      lines.push(`Previous head SHA: ${input.previousHeadSha}`);
    }
    if (input.updatedHeadSha) {
      lines.push(`Updated head SHA: ${input.updatedHeadSha}`);
    }
    const content = `${lines.join("\n")}\n`;
    await writeFile(contentPath, content, "utf8");
    recordGeneratedMarkdownArtifact({
      inputs: input.inputs,
      id,
      contentPath,
      content,
      producerStageId: input.stage.id,
      contract: outputContract(output),
      context: input.context,
      eventStore: input.eventStore,
    });
  }
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
}

async function recordGeneratedMarkdownArtifactFromFile(input: {
  inputs: Map<string, InputArtifact>;
  id: string;
  runDirectory: string;
  contentPath: string;
  mediaType?: string;
  manifestSource?: ValidatedAttemptOutput["manifestSource"];
  producerStageId?: string;
  contract?: ArtifactContract;
  context?: RuntimeContext;
  eventStore?: EventStore;
  rehydrateExisting?: boolean;
}): Promise<void> {
  requirePathInside(input.runDirectory, input.contentPath, "generated artifact");
  const content = await readFile(input.contentPath, "utf8");
  recordGeneratedMarkdownArtifact({
    inputs: input.inputs,
    id: input.id,
    contentPath: input.contentPath,
    content,
    mediaType: input.mediaType,
    manifestSource: input.manifestSource,
    producerStageId: input.producerStageId,
    contract: input.contract,
    context: input.context,
    eventStore: input.eventStore,
    rehydrateExisting: input.rehydrateExisting,
  });
}

async function recordValidatedAttemptOutputs(input: {
  inputs: Map<string, InputArtifact>;
  stage: Stage;
  runDirectory: string;
  outputs: ValidatedAttemptOutput[];
  context: RuntimeContext;
  eventStore?: EventStore;
  rehydrateExisting?: boolean;
}): Promise<void> {
  const contracts = new Map(
    input.stage.outputs.map((output) => {
      const contract = outputContract(output);
      return [contract.id, contract] as const;
    }),
  );
  for (const output of input.outputs) {
    await recordGeneratedMarkdownArtifactFromFile({
      inputs: input.inputs,
      id: output.id,
      runDirectory: input.runDirectory,
      contentPath: output.absolutePath,
      mediaType: output.mediaType,
      manifestSource: output.manifestSource,
      producerStageId: input.stage.id,
      contract: contracts.get(output.id),
      context: input.context,
      eventStore: input.eventStore,
      rehydrateExisting: input.rehydrateExisting,
    });
  }
  if (input.outputs.length > 0) {
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
  }
}

async function recordGeneratedStageTextArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stage: Stage;
  runDirectory: string;
  attemptDirectory: string;
  context: RuntimeContext;
  eventStore?: EventStore;
  rehydrateExisting?: boolean;
}): Promise<void> {
  let recorded = false;
  for (const output of input.stage.outputs) {
    const id = outputId(output);
    const contract = outputContract(output);
    for (const candidate of [
      { path: join(input.attemptDirectory, `${id}.md`), mediaType: "text/markdown" },
      { path: join(input.attemptDirectory, `${id}.txt`), mediaType: "text/plain" },
    ]) {
      requirePathInside(input.runDirectory, candidate.path, "generated artifact");
      let content: string;
      try {
        content = await readFile(candidate.path, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
      recordGeneratedMarkdownArtifact({
        inputs: input.inputs,
        id,
        contentPath: candidate.path,
        content,
        mediaType: candidate.mediaType,
        producerStageId: input.stage.id,
        contract,
        context: input.context,
        eventStore: input.eventStore,
        rehydrateExisting: input.rehydrateExisting,
      });
      recorded = true;
      break;
    }
  }
  if (recorded) {
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
  }
}

/**
 * Validate that every input declared in `flow.metadata.inputs` is supplied to
 * the run. Throws before any stage executes when a declared input is missing.
 * Flows without declared inputs impose no constraint (backward compatible).
 */
function assertDeclaredInputsSupplied(
  flow: Flow,
  inputs: Record<string, ResourceReference>,
): void {
  const declared = flow.metadata.inputs ?? [];
  const missing = declared
    .map((contract) => contract.id)
    .filter((id) => !(id in inputs));
  if (missing.length > 0) {
    throw new Error(
      `run is missing required flow input(s): ${missing.join(", ")}`,
    );
  }
}

/**
 * Runtime guard (defense in depth): a protected action stage for a high-risk
 * work item type cannot run unless an approved gate exists in this run. This
 * holds even when flow-load governance was bypassed (e.g. a direct CLI run).
 */
function assertProtectedStageGate(input: {
  workItemType?: string;
  stage: Stage;
  context: RuntimeContext;
}): void {
  if (!input.workItemType) {
    return;
  }
  const policy = resolveWorkItemTypePolicy(input.workItemType);
  if (!policy || !policy.highRisk) {
    return;
  }
  if (!(policy.protectedStages ?? []).includes(input.stage.type)) {
    return;
  }
  const approved = input.context.artifactEntries.some(
    (artifact) =>
      artifact.type === "gate.approval" && artifact.gate?.state === "approved",
  );
  if (!approved) {
    throw new Error(
      `protected stage "${input.stage.id}" (${input.stage.type}) requires an approved gate for high-risk work item type "${input.workItemType}"`,
    );
  }
}

/**
 * Enforce a stage's output contracts: every declared output must have been
 * produced as a non-empty artifact, and JSON artifacts that declare a schema
 * must satisfy it. Throws on violation so the stage fails through the normal
 * retry/failure path. Text/markdown artifacts are exempt from schema checks.
 */
function enforceStageOutputContracts(input: {
  stage: Stage;
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
}): void {
  for (const output of input.stage.outputs) {
    // Bare-string outputs are legacy placeholders with lenient semantics. Only
    // outputs declared as a richer contract object are enforced as required,
    // schema-validated artifacts (backward compatible with existing flows).
    if (typeof output === "string") {
      continue;
    }
    const id = outputId(output);
    const contract = outputContract(output);
    const produced = input.inputs.get(id);
    const entry = input.context.artifactEntries.find(
      (artifact) => artifact.id === id && artifact.producer === input.stage.id,
    );
    const content = produced?.resource?.content;
    const size = entry?.size ?? content?.byteLength ?? 0;
    if (!entry || size <= 0) {
      throw new Error(
        `stage ${input.stage.id} did not produce required output "${id}"`,
      );
    }
    if (contract.schema !== undefined && content && content.byteLength > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.toString("utf8"));
      } catch {
        // Not JSON content: text/markdown artifacts are exempt from schema checks.
        continue;
      }
      const result = validateAgainstSchema(contract.schema, parsed);
      if (!result.valid) {
        throw new Error(
          `stage ${input.stage.id} output "${id}" failed schema validation: ${result.errors.join("; ")}`,
        );
      }
    }
  }
}

async function rehydrateCompletedSyncArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stages: Stage[];
  completedStages: string[];
  runDirectory: string;
  syncMetadata: unknown;
  context: RuntimeContext;
  eventStore?: EventStore;
}): Promise<void> {
  const sync = recordValue(input.syncMetadata);
  const reportPath = sync.reportPath;
  if (typeof reportPath !== "string") return;

  for (const stage of input.stages) {
    if (stage.type !== "sync-change") continue;
    if (!input.completedStages.includes(stage.id)) continue;
    for (const output of stage.outputs) {
      const id = outputId(output);
      await recordGeneratedMarkdownArtifactFromFile({
        inputs: input.inputs,
        id,
        runDirectory: input.runDirectory,
        contentPath: reportPath,
        producerStageId: stage.id,
        contract: outputContract(output),
        context: input.context,
        eventStore: input.eventStore,
        rehydrateExisting: true,
      });
    }
  }
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
}

async function rehydrateCompletedAgentTextArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stages: Stage[];
  projection: ReturnType<typeof projectRun>;
  runDirectory: string;
  context: RuntimeContext;
  eventStore?: EventStore;
}): Promise<void> {
  for (const stage of input.stages) {
    if (stage.type !== "agent") continue;
    if (!input.projection.completedStages.includes(stage.id)) continue;
    const projectedStage = input.projection.stages.find(
      (candidate) => candidate.stageId === stage.id,
    );
    const completedAttempt = projectedStage?.attempts
      .filter((attempt) => attempt.status === "completed")
      .at(-1);
    const attemptDirectory = completedAttempt?.attemptDirectory;
    if (!attemptDirectory) continue;
    const validatedOutputs = await validateAttemptOutputs({
      runDirectory: input.runDirectory,
      attemptDirectory,
      stageId: stage.id,
      attempt: completedAttempt.attempt,
      outputs: stage.outputs.map(outputContract),
    });
    await recordValidatedAttemptOutputs({
      inputs: input.inputs,
      stage,
      runDirectory: input.runDirectory,
      outputs: validatedOutputs.outputs,
      context: input.context,
      eventStore: input.eventStore,
      rehydrateExisting: true,
    });
  }
}

function validReworkTargetsForStage(
  stage: Stage,
  producerByArtifact: Map<string, string>,
): Set<string> {
  return new Set(
    stage.inputs.filter((artifact) => producerByArtifact.has(artifact)),
  );
}

function orchestratorDecisionEvent(input: {
  stage: Stage;
  attempt: number;
  maxAttempts: number;
  decision: OrchestratorDecision;
  error?: string;
}): OrchestratorDecisionEvent {
  return {
    stageId: input.stage.id,
    stageType: input.stage.type,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    action: input.decision.action,
    reason: input.decision.reason,
    error: input.error,
    targetArtifact:
      input.decision.action === "rework"
        ? input.decision.targetArtifact
        : undefined,
  };
}

function appendOrchestratorDecision(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  maxAttempts: number;
  decision: OrchestratorDecision;
  context: RuntimeContext;
  error?: string;
}): OrchestratorDecisionEvent {
  const payload = orchestratorDecisionEvent(input);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "orchestrator.decision",
    payload: redactRuntimeUnknown(payload, input.context),
  });
  return payload;
}

function markStageCompleted(completedStages: string[], stageId: string): void {
  if (!completedStages.includes(stageId)) {
    completedStages.push(stageId);
  }
}

function appendSuccessfulStageCompletion(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  maxAttempts: number;
  context: RuntimeContext;
  payload?: Record<string, unknown>;
}): void {
  const decision = decideStagePolicy({
    stageType: input.stage.type,
    succeeded: true,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    validReworkTargets: new Set(),
  });
  appendOrchestratorDecision({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    decision,
    context: input.context,
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "stage.completed",
    payload: input.payload ?? { outputs: stageOutputIds(input.stage) },
  });
}

function assertReworkFlowDoesNotPublishChange(stages: Stage[]): void {
  if (stages.some((stage) => stage.type === "publish-change")) {
    throw new Error("rework runs cannot use publish-change stages; use update-change");
  }
}

function invalidateCompletedStagesFrom(
  completedStages: string[],
  orderedStageIds: string[],
  startIndex: number,
): void {
  const invalidated = new Set(orderedStageIds.slice(startIndex));
  for (let index = completedStages.length - 1; index >= 0; index -= 1) {
    if (invalidated.has(completedStages[index])) {
      completedStages.splice(index, 1);
    }
  }
}

async function snapshotInputs(input: {
  repoPath: string;
  runDirectory: string;
  inputReferences: Record<string, ResourceReference>;
  providerStore?: ProviderConnectionStore;
  policy: ContextPolicy;
  context: RuntimeContext;
  eventStore?: EventStore;
}): Promise<Map<string, InputArtifact>> {
  const registry = new ConnectorRegistry([
    new LocalFileConnector(input.repoPath),
    new GoogleDriveConnector({ store: input.providerStore }),
  ]);
  const inputs = new Map<string, InputArtifact>();
  for (const [id, reference] of Object.entries(input.inputReferences)) {
    assertSafePathSegment("input artifact id", id);
    let decision: ContextDecision = { decision: "allowed" };
    let manifestSourceUri = reference.uri;
    let manifestFilename: string | undefined;
    let manifestMediaType: string | undefined;
    let manifestRevision: string | undefined;
    if (reference.connector === "local-file") {
      const resolved = await resolveLocalFileResource(input.repoPath, reference);
      decision = evaluateLocalPath(input.policy, resolved.repoRelativePath);
      manifestSourceUri = resolved.repoRelativePath;
      manifestFilename = resolved.filename;
      manifestMediaType = resolved.mediaType;
      manifestRevision = resolved.revision;
      if (decision.decision === "excluded") {
        upsertManifestEntry(input.context, {
          id,
          kind: "external-input",
          connector: reference.connector,
          sourceUri: resolved.repoRelativePath,
          mediaType: resolved.mediaType,
          revision: resolved.revision,
          filename: resolved.filename,
          policy: decision,
        });
        await persistContextManifest(input.context);
        input.eventStore?.append({
          runId: input.context.runId,
          type: "context.excluded",
          payload: redactRuntimeUnknown(
            {
              id,
              connector: reference.connector,
              repoRelativePath: resolved.repoRelativePath,
              policy: decision,
            },
            input.context,
          ),
        });
        throw new ContextPolicyError(resolved.repoRelativePath, decision);
      }
      if (decision.decision === "warned") {
        const safeSourceUri =
          redactRuntimeText(resolved.repoRelativePath, input.context) ??
          resolved.repoRelativePath;
        upsertManifestEntry(input.context, {
          id,
          kind: "external-input",
          connector: reference.connector,
          sourceUri: safeSourceUri,
          mediaType: resolved.mediaType,
          revision: resolved.revision,
          filename: resolved.filename,
          policy: decision,
        });
        await persistContextManifest(input.context);
        input.eventStore?.append({
          runId: input.context.runId,
          type: "context.warned",
          payload: redactRuntimeUnknown(
            {
              id,
              connector: reference.connector,
              repoRelativePath: resolved.repoRelativePath,
              policy: decision,
            },
            input.context,
          ),
        });
        input.eventStore?.append({
          runId: input.context.runId,
          type: "context.manifest.updated",
          payload: {
            id,
            kind: "external-input",
          },
        });
        upsertArtifactEntry(input.context, {
          id,
          producer: "external",
          mediaType: resolved.mediaType,
          sourceUri: safeSourceUri,
          filename: resolved.filename,
          createdAt: new Date().toISOString(),
        });
        await persistArtifactRegistry(input.context);
        inputs.set(id, {
          id,
          reference,
          resource: {
            sourceUri: safeSourceUri,
            mediaType: resolved.mediaType,
            revision: resolved.revision,
            content: Buffer.alloc(0),
            metadata: { filename: resolved.filename },
          },
          contentPath: join(input.runDirectory, "inputs", id, "content"),
          omittedByPolicy: decision,
        });
        continue;
      }
    }
    const resource = await registry.fetch(reference);
    const inputDirectory = join(input.runDirectory, "inputs", id);
    requirePathInside(join(input.runDirectory, "inputs"), inputDirectory, "input directory");
    await mkdir(inputDirectory, { recursive: true });
    const contentPath = join(inputDirectory, "content");
    await writeFile(contentPath, resource.content);
    const safeSourceUri =
      redactRuntimeText(manifestSourceUri, input.context) ?? manifestSourceUri;
    const filename =
      manifestFilename ??
      resource.metadata?.filename ??
      resource.metadata?.name ??
      basename(resource.sourceUri);
    const artifactResource: FetchedResource = {
      ...resource,
      sourceUri: safeSourceUri,
      metadata: { filename },
    };
    await writeFile(
      join(inputDirectory, "metadata.json"),
      JSON.stringify(
        {
          sourceUri: artifactResource.sourceUri,
          mediaType: artifactResource.mediaType,
          revision: artifactResource.revision,
          metadata: artifactResource.metadata,
        },
        null,
        2,
      ),
      "utf8",
    );
    inputs.set(id, { id, reference, resource: artifactResource, contentPath });
    const runRelativeSnapshotPath = manifestRunRelativePath(input.runDirectory, contentPath);
    upsertArtifactEntry(
      input.context,
      withProvenance(
        {
          id,
          producer: "external",
          mediaType: manifestMediaType ?? resource.mediaType,
          path: runRelativeSnapshotPath,
          sourceUri: safeSourceUri,
          filename,
          createdAt: new Date().toISOString(),
        },
        resource.content,
        { runId: input.context.runId },
      ),
    );
    upsertManifestEntry(input.context, {
      id,
      kind: reference.connector === "local-file" ? "external-input" : "connector-context",
      connector: reference.connector,
      sourceUri: safeSourceUri,
      mediaType: manifestMediaType ?? resource.mediaType,
      revision: manifestRevision ?? resource.revision,
      filename,
      runRelativePath: runRelativeSnapshotPath,
      policy: decision,
    });
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
    input.eventStore?.append({
      runId: input.context.runId,
      type: "context.manifest.updated",
      payload: {
        id,
        kind: reference.connector === "local-file" ? "external-input" : "connector-context",
      },
    });
  }
  return inputs;
}

function applyTaskScope(input: {
  inputs: Map<string, InputArtifact>;
  taskScope: TaskScopeInput;
}): AppliedTaskScope {
  const source = input.inputs.get(input.taskScope.inputId);
  if (!source) {
    throw new Error(`task scope input not found: ${input.taskScope.inputId}`);
  }
  const markdown = source.resource.content.toString("utf8");
  const result = selectTaskScope({
    inputId: input.taskScope.inputId,
    markdown,
    expression: input.taskScope.expression,
  });
  if (!result.selection) {
    const reason = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
    throw new Error(`invalid task scope "${input.taskScope.expression}": ${reason}`);
  }
  const scopedContent = Buffer.from(renderScopedTaskArtifact(result.selection), "utf8");
  const scopedResource: FetchedResource = {
    ...source.resource,
    content: scopedContent,
    metadata: {
      ...source.resource.metadata,
      filename: source.resource.metadata?.filename ?? basename(source.contentPath),
      taskScope: JSON.stringify({
        expression: result.selection.expression,
        kind: result.selection.kind,
        selectedTaskIds: result.selection.selectedTaskIds,
      }),
    },
  };
  const scopedInputs = new Map(input.inputs);
  scopedInputs.set(input.taskScope.inputId, {
    ...source,
    resource: scopedResource,
  });
  return { selection: result.selection, scopedInputs };
}

function taskScopeEventPayload(selection: TaskScopeSelection) {
  return {
    inputId: selection.inputId,
    expression: selection.expression,
    kind: selection.kind,
    selectedTaskIds: selection.selectedTaskIds,
    completedTaskIds: selection.completedTaskIds,
    pendingTaskIds: selection.pendingTaskIds,
    sourceTaskCount: selection.sourceTaskCount,
  };
}

function formatTaskScopeEvidence(
  selection: TaskScopeSelection | undefined,
): string {
  if (!selection) return "none";
  return [
    `- Input: ${selection.inputId}`,
    `- Scope: ${selection.expression}`,
    `- Kind: ${selection.kind}`,
    `- Selected tasks: ${selection.selectedTaskIds.join(", ")}`,
    `- Completed at run start: ${
      selection.completedTaskIds.length > 0
        ? selection.completedTaskIds.join(", ")
        : "none"
    }`,
    `- Pending at run start: ${
      selection.pendingTaskIds.length > 0
        ? selection.pendingTaskIds.join(", ")
        : "none"
    }`,
    `- Source task count: ${selection.sourceTaskCount}`,
  ].join("\n");
}

function formatRuntimeUsageEvidence(
  usage: ProjectedRuntimeUsageTotal | undefined,
): string {
  if (!usage) return "none";
  const lines = [
    `- Known attempts: ${usage.knownAttempts}`,
    `- Unknown attempts: ${usage.unknownAttempts}`,
  ];
  if (usage.inputTokens !== undefined) {
    lines.push(`- Input tokens: ${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    lines.push(`- Output tokens: ${usage.outputTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    lines.push(`- Total tokens: ${usage.totalTokens}`);
  }
  if (usage.estimatedCostUsd !== undefined) {
    lines.push(`- Estimated cost USD: ${usage.estimatedCostUsd}`);
  }
  return lines.join("\n");
}

function formatRepoIndexQueryEvidence(
  queries: ProjectedRepoIndexQuery[] | undefined,
  context: RuntimeContext,
): string {
  if (!queries || queries.length === 0) return "none";
  return queries
    .map((query) => {
      const heading = [
        `- ${redactRuntimeText(query.query, context) ?? ""}`,
        query.stageId ? `stage ${redactRuntimeText(query.stageId, context) ?? ""}` : undefined,
        query.attempt !== undefined ? `attempt ${query.attempt}` : undefined,
        query.stale ? "stale index" : undefined,
      ].filter((part): part is string => part !== undefined).join(", ");
      const matches = query.matches.length > 0
        ? query.matches
            .slice(0, 5)
            .map((match) => {
              const reasons = match.reasons.length > 0
                ? ` (${match.reasons.join(", ")})`
                : "";
              return `  - ${redactRuntimeText(match.path, context) ?? ""}${reasons}`;
            })
            .join("\n")
        : "  - no matches";
      return [heading, matches].join("\n");
    })
    .join("\n");
}

async function writeEvidence(input: {
  flowName: string;
  runId: string;
  branchName: string;
  runDirectory: string;
  completedStages: string[];
  gates: GateResult[];
  agentRuntimes: AgentRuntimeEvidence[];
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  repoIndexQueries?: ProjectedRepoIndexQuery[];
  loadedSkills: StageSkillUsage[];
  orchestratorDecisions: OrchestratorDecisionEvent[];
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
  taskScope?: TaskScopeSelection;
  planningApproval?: PlanningApprovalStatus;
  changeTitle?: ChangeTitleMetadata;
  reworkTarget?: ReworkTargetState;
  syncMetadata?: SyncMetadata;
}): Promise<string> {
  const evidencePath = join(input.runDirectory, "evidence.md");
  const titleSection = input.changeTitle
    ? [
        "## Change Title",
        "",
        `Title: ${redactRuntimeText(input.changeTitle.title, input.context) ?? ""}`,
        `Source: ${
          input.changeTitle.source === "artifact"
            ? `artifact ${input.changeTitle.artifactId ?? ""}`.trim()
            : "fallback"
        }`,
        "",
      ]
    : [];
  const targetSection = input.reworkTarget
    ? [
        "## Change Request Target",
        "",
        `Provider: ${input.reworkTarget.provider}`,
        `PR URL: ${redactRuntimeText(input.reworkTarget.resolved.url, input.context) ?? ""}`,
        `PR Number: ${input.reworkTarget.resolved.number}`,
        `Base branch: ${input.reworkTarget.resolved.baseBranch}`,
        `Head branch: ${input.reworkTarget.resolved.headBranch}`,
        `Previous head SHA: ${input.reworkTarget.previousHeadSha}`,
        `Updated head SHA: ${input.reworkTarget.updatedHeadSha ?? ""}`,
        `Triggering instruction source: ${
          redactRuntimeText(
            [...input.inputs.values()]
              .map((artifact) => artifact.resource.sourceUri)
              .join(", "),
            input.context,
          ) ?? ""
        }`,
        "",
      ]
    : [];
  const syncSection = input.syncMetadata
    ? [
        "## Sync",
        "",
        `Strategy: ${input.syncMetadata.strategy}`,
        `Result: ${input.syncMetadata.result}`,
        `Base branch: ${input.syncMetadata.baseBranch}`,
        `Base SHA: ${input.syncMetadata.baseSha}`,
        `Previous head SHA: ${input.syncMetadata.headShaBefore}`,
        `Synced head SHA: ${input.syncMetadata.headShaAfter ?? ""}`,
        `Conflict files: ${
          input.syncMetadata.conflictFiles.length > 0
            ? input.syncMetadata.conflictFiles.join(", ")
            : "none"
        }`,
        "",
      ]
    : [];
  const constitutionSection = input.context.constitution.loaded
    ? [
        "## Constitution",
        "",
        "Loaded: yes",
        `Path: ${
          redactRuntimeText(input.context.constitution.path, input.context) ?? ""
        }`,
        `Hash: ${input.context.constitution.hash}`,
        "",
      ]
    : [
        "## Constitution",
        "",
        "Loaded: no",
        `Path: ${
          redactRuntimeText(input.context.constitution.path, input.context) ?? ""
        }`,
        "",
      ];
  const agentRuntimeLines =
    input.agentRuntimes.length > 0
      ? input.agentRuntimes
          .map((agent) => {
            if (agent.candidates.length === 1) {
              const candidate = agent.candidates[0]!;
              return `- ${agent.stageId}: runtime ${candidate.runtime}, model ${candidate.model ?? "default"}`;
            }
            const chain = agent.candidates
              .map(
                (candidate) =>
                  `${candidate.runtime}/${candidate.model ?? "default"}`,
              )
              .join(" -> ");
            return `- ${agent.stageId}: ${chain}`;
          })
          .join("\n")
      : "none";
  const runtimeUsageLines = formatRuntimeUsageEvidence(input.runtimeUsage);
  const repoIndexQueryLines = formatRepoIndexQueryEvidence(
    input.repoIndexQueries,
    input.context,
  );
  const taskScopeLines = formatTaskScopeEvidence(input.taskScope);
  const planningApprovalLines = formatPlanningApprovalEvidence(
    input.planningApproval,
  );
  const gateLines =
    input.gates.length > 0
      ? input.gates
          .map((gate) => {
            const heading = `- ${gate.stageId}${
              gate.name ? ` (${gate.name})` : ""
            }: ${gate.mode}, ${gate.status}`;
            const details = [
              heading,
              gate.command ? `  Command: ${gate.command}` : undefined,
              gate.runtime ? `  Runtime: ${gate.runtime}` : undefined,
              gate.reviewedArtifacts && gate.reviewedArtifacts.length > 0
                ? `  Reviewed artifacts: ${gate.reviewedArtifacts.join(", ")}`
                : undefined,
              gate.reviewOutput
                ? `  Review output: ${gate.reviewOutput.path}`
                : undefined,
              gate.reason ? `  Reason: ${gate.reason}` : undefined,
              gate.stdout ? `  Stdout: ${boundedText(gate.stdout, 500)}` : undefined,
              gate.stderr ? `  Stderr: ${boundedText(gate.stderr, 500)}` : undefined,
            ].filter((line): line is string => line !== undefined);
            return details.join("\n");
          })
          .join("\n")
      : "none";
  const loadedSkillLines =
    input.loadedSkills.length > 0
      ? input.loadedSkills
          .flatMap((usage) =>
            usage.skills.map((skill) => {
              const resources =
                skill.resources.length > 0
                  ? skill.resources
                      .map((resource) => resource.snapshotPath)
                      .join(", ")
                  : "none";
              return [
                `- ${usage.stageId} / ${skill.id}: ${skill.sourcePath} (sha256:${skill.contentHash})`,
                `  Description: ${skill.description}`,
                `  Resources: ${resources}`,
              ].join("\n");
            }),
          )
          .join("\n")
      : "none";
  const orchestratorDecisionLines =
    input.orchestratorDecisions.length > 0
      ? input.orchestratorDecisions
          .map((decision) => {
            const target = decision.targetArtifact
              ? ` (target: ${redactRuntimeText(decision.targetArtifact, input.context) ?? ""})`
              : "";
            return `- ${redactRuntimeText(decision.stageId, input.context) ?? ""} attempt ${
              decision.attempt
            }/${decision.maxAttempts}: ${decision.action} - ${
              redactRuntimeText(decision.reason, input.context) ?? ""
            }${target}`;
          })
          .join("\n")
      : "none";
  const producedArtifacts = input.context.artifactEntries.filter(
    (artifact) => artifact.producer !== "external",
  );
  const attemptFileDirectories = [
    ...new Map(
      producedArtifacts
        .map((artifact) => {
          const match = artifact.path?.match(/^(stages\/[^/]+\/[^/]+)\//);
          return match ? [match[1], match[1]] as const : undefined;
        })
        .filter((entry): entry is readonly [string, string] => entry !== undefined),
    ).values(),
  ];
  const attemptFileLines =
    attemptFileDirectories.length > 0
      ? attemptFileDirectories
          .map((directory) =>
            [
              `- ${redactRuntimeText(directory, input.context) ?? ""}`,
              `  Output summary: ${
                redactRuntimeText(`${directory}/output.md`, input.context) ?? ""
              }`,
              `  Manifest: ${
                redactRuntimeText(`${directory}/artifact.json`, input.context) ?? ""
              }`,
              `  Stdout: ${
                redactRuntimeText(`${directory}/stdout.log`, input.context) ?? ""
              }`,
              `  Stderr: ${
                redactRuntimeText(`${directory}/stderr.log`, input.context) ?? ""
              }`,
            ].join("\n"),
          )
          .join("\n")
      : "none";
  const artifactLines =
    producedArtifacts.length > 0
      ? producedArtifacts
          .map((artifact) => {
            const summary = [
              `- ${redactRuntimeText(artifact.id, input.context) ?? ""}: producer ${
                redactRuntimeText(artifact.producer, input.context) ?? ""
              }`,
              artifact.type
                ? `type ${redactRuntimeText(artifact.type, input.context) ?? ""}`
                : undefined,
              `media ${redactRuntimeText(artifact.mediaType, input.context) ?? ""}`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(", ");
            return [
              summary,
              artifact.path
                ? `  Path: ${redactRuntimeText(artifact.path, input.context) ?? ""}`
                : undefined,
              artifact.description
                ? `  Description: ${
                    redactRuntimeText(artifact.description, input.context) ?? ""
                  }`
                : undefined,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n");
          })
          .join("\n")
      : "none";
  const body = [
    `# Nitely Run Evidence: ${input.flowName}`,
    "",
    `Run ID: ${input.runId}`,
    `Branch: ${input.branchName}`,
    "",
    ...titleSection,
    ...targetSection,
    ...syncSection,
    ...constitutionSection,
    "## Inputs",
    "",
    [...input.inputs.values()]
      .map(
        (artifact) =>
          `- ${artifact.id}: ${
            redactRuntimeText(artifact.resource.sourceUri, input.context) ?? ""
          }`,
      )
      .join("\n"),
    "",
    "## Agent Runtimes",
    "",
    agentRuntimeLines,
    "",
    "## Runtime Usage",
    "",
    runtimeUsageLines,
    "",
    "## Repository Index Queries",
    "",
    repoIndexQueryLines,
    "",
    "## Task Scope",
    "",
    taskScopeLines,
    "",
    "## Planning Approval",
    "",
    planningApprovalLines,
    "",
    "## Gates",
    "",
    gateLines,
    "",
    "## Loaded Skills",
    "",
    loadedSkillLines,
    "",
    "## Orchestrator Decisions",
    "",
    orchestratorDecisionLines,
    "",
    "## Artifacts",
    "",
    artifactLines,
    "",
    "## Attempt Files",
    "",
    attemptFileLines,
    "",
    "## Completed Stages",
    "",
    input.completedStages.map((stage) => `- ${stage}`).join("\n"),
    "",
    "This draft change request was generated by Nitely.",
    "",
  ].join("\n");
  await writeFile(evidencePath, redactRuntimeText(body, input.context) ?? "", "utf8");
  return evidencePath;
}

function collectAgentRuntimeEvidence(stages: Stage[]): AgentRuntimeEvidence[] {
  return stages
    .filter((stage): stage is Extract<Stage, { type: "agent" }> => {
      return stage.type === "agent";
    })
    .map((stage) => ({
      stageId: stage.id,
      candidates: stageRuntimeCandidates(stage),
    }));
}

function firstAgentRuntimeCandidate(stages: Stage[]): RuntimeCandidate | undefined {
  for (const stage of stages) {
    if (stage.type === "agent" || (stage.type === "gate" && stage.mode === "review")) {
      return stageRuntimeCandidates(stage)[0];
    }
  }
  return undefined;
}

async function prepareAndInjectAgentMemory(input: {
  repoPath: string;
  workspace: WorkspaceHandle;
  stages: Stage[];
  runId: string;
  eventStore: EventStore;
  context: RuntimeContext;
}): Promise<InjectedAgentMemoryFile[]> {
  if (!input.workspace.path) {
    return [];
  }
  const runtime = firstAgentRuntimeCandidate(input.stages);
  if (!runtime) {
    return [];
  }
  try {
    const prepared = await prepareAgentMemory({
      repoPath: input.repoPath,
      runtime: runtime.runtime,
      model: runtime.model,
    });
    if (prepared.generated) {
      input.eventStore.append({
        runId: input.runId,
        type: "knowledge.generated",
        payload: redactRuntimeUnknown(
          {
            runtime: prepared.metadata.runtime,
            model: prepared.metadata.model,
            fingerprint: prepared.metadata.fingerprint,
            generatedAt: prepared.metadata.generatedAt,
            contentPath: prepared.metadata.contentPath,
            generator: prepared.metadata.generator,
          },
          input.context,
        ),
      });
    }
    return await injectAgentMemoryFiles({
      worktreePath: input.workspace.path,
      content: prepared.content,
    });
  } catch {
    return [];
  }
}

async function cleanupInjectedAgentMemory(
  injectedFiles: InjectedAgentMemoryFile[],
): Promise<void> {
  // Idempotent cleanup boundary for all injected agent-memory lifecycle paths.
  // Callers share the same array so branch-level cleanup and top-level cleanup
  // cannot remove the same file twice.
  if (injectedFiles.length === 0) {
    return;
  }
  await removeInjectedAgentMemoryFiles(injectedFiles);
  injectedFiles.splice(0, injectedFiles.length);
}

function createInjectedAgentMemoryScope(
  injectedFiles: InjectedAgentMemoryFile[],
): { cleanup(): Promise<void> } {
  return {
    cleanup: async () => {
      await cleanupInjectedAgentMemory(injectedFiles);
    },
  };
}

export async function runFlow(
  input: RunFlowInput,
  dependencies: RunFlowDependencies = {},
): Promise<RunFlowResult> {
  const repoPath = resolve(input.repoPath);
  assertPlanningReadyForExecution(input.planningApproval);
  const providerStore = providerStoreForRun(repoPath, dependencies);
  const contextPolicy = await loadContextPolicy(repoPath);
  const constitution = await loadConstitution(repoPath);
  const redactionSecrets = await collectRuntimeRedactionSecrets({
    policy: contextPolicy,
    dependencies,
    providerStore,
  });
  const runId = (dependencies.createRunId ?? createDefaultRunId)();
  const backend = await resolveBackend(dependencies, providerStore);
  let branchName = `nitely/${runId}`;
  let baseBranch = (await runGit(repoPath, ["branch", "--show-current"])).trim();
  if (!baseBranch) {
    throw new Error("unable to determine base branch for run");
  }
  const runDirectory = join(repoPath, ".nitely", "runs", runId);
  const worktreePath = join(runDirectory, "worktree");
  const loaded =
    input.flowDocument !== undefined
      ? parseFlowDocument(input.flowDocument, {
          externalInputs: Object.keys(input.inputs),
        })
      : await loadFlow(input.flowPath, {
          externalInputs: Object.keys(input.inputs),
        });
  const runWorkItemType =
    input.workItemType ?? loaded.flow.metadata.workItemType;
  assertDeclaredInputsSupplied(loaded.flow, input.inputs);
  for (const inputId of Object.keys(input.inputs)) {
    assertSafePathSegment("input artifact id", inputId);
  }
  if (input.changeRequestTarget) {
    assertReworkFlowDoesNotPublishChange(loaded.flow.spec.stages);
  }
  let reworkTarget: ReworkTargetState | undefined;
  let reworkProvider: ScmProvider | undefined;
  if (input.changeRequestTarget) {
    reworkProvider = scmProviderForRun(
      input.changeRequestTarget.provider,
      dependencies,
      providerStore,
    );
    const resolved = await resolveChangeRequestTarget({
      provider: reworkProvider,
      repoPath,
      target: input.changeRequestTarget.target,
    });
    branchName = resolved.headBranch;
    baseBranch = resolved.baseBranch;
    reworkTarget = {
      provider: input.changeRequestTarget.provider,
      target: input.changeRequestTarget.target,
      resolved,
      previousHeadSha: resolved.headSha,
    };
  }

  await mkdir(runDirectory, { recursive: true });
  const runtimeContext: RuntimeContext = {
    runId,
    runDirectory,
    manifestEntries: [],
    manifestEntryIndexes: new Map(),
    artifactEntries: [],
    artifactEntryIndexes: new Map(),
    redactionSecrets,
    constitution,
  };
  const eventStore = new EventStore(eventStorePath(repoPath));
  let inputArtifacts: Map<string, InputArtifact>;
  try {
    inputArtifacts = await snapshotInputs({
      repoPath,
      runDirectory,
      inputReferences: input.inputs,
      providerStore,
      policy: contextPolicy,
      context: runtimeContext,
      eventStore,
    });
  } catch (error) {
    eventStore.append({
      runId,
      type: "run.failed",
      payload: redactRuntimeUnknown(
        { error: error instanceof Error ? error.message : String(error) },
        runtimeContext,
      ),
    });
    eventStore.close();
    throw error;
  }
  eventStore.append({
    runId,
    type: "run.created",
    payload: redactRuntimeUnknown({
      flowName: loaded.flow.metadata.name,
      ownerId: input.ownerId,
      organizationId: input.organizationId,
      workItemId: input.workItemId,
      workItemType: input.workItemType ?? loaded.flow.metadata.workItemType,
      planningApproval: input.planningApproval,
      flowPath: input.flowPath,
      ...(input.flowDocument !== undefined
        ? { flowDocument: input.flowDocument }
        : {}),
      repoPath,
      repoId: input.repoId,
      repoName: input.repoName,
      inputs: input.inputs,
      branchName,
      baseBranch,
      trigger: input.trigger,
      priorRunId: input.priorRunId,
      taskScope: input.taskScope,
      changeRequestTarget: reworkTarget
        ? {
            provider: reworkTarget.provider,
            target: reworkTarget.target,
            resolved: reworkTarget.resolved,
          }
        : undefined,
    }, runtimeContext),
  });
  let taskScopeSelection: TaskScopeSelection | undefined;
  if (input.taskScope) {
    try {
      const applied = applyTaskScope({
        inputs: inputArtifacts,
        taskScope: input.taskScope,
      });
      taskScopeSelection = applied.selection;
      inputArtifacts = applied.scopedInputs;
      eventStore.append({
        runId,
        type: "task.scope.selected",
        payload: redactRuntimeUnknown(
          taskScopeEventPayload(applied.selection),
          runtimeContext,
        ),
      });
    } catch (error) {
      eventStore.append({
        runId,
        type: "run.failed",
        payload: redactRuntimeUnknown(
          { error: error instanceof Error ? error.message : String(error) },
          runtimeContext,
        ),
      });
      eventStore.close();
      throw error;
    }
  }
  let workspace: WorkspaceHandle;
  if (reworkTarget && reworkProvider) {
    eventStore.append({
      runId,
        type: "change.target.resolved",
      payload: redactRuntimeUnknown({
        provider: reworkTarget.provider,
        target: reworkTarget.target,
        resolved: reworkTarget.resolved,
        previousHeadSha: reworkTarget.previousHeadSha,
      }, runtimeContext),
    });
    try {
      const checkout = await checkoutChangeRequest({
        provider: reworkProvider,
        repoPath,
        worktreePath,
        target: reworkTarget.resolved,
      });
      reworkTarget.previousHeadSha = checkout.previousHeadSha;
    } catch (error) {
      eventStore.append({
        runId,
        type: "run.failed",
        payload: redactRuntimeUnknown({
          stageId: "checkout",
          error: error instanceof Error ? error.message : String(error),
        }, runtimeContext),
      });
      eventStore.close();
      throw error;
    }
    workspace = { runId, path: worktreePath };
  } else {
    workspace = await backend.createWorkspace({
      repoPath,
      branchName,
      runId,
      worktreePath,
    });
  }
  eventStore.append({
    runId,
    type: "workspace.created",
    payload: { worktreePath },
  });
  const injectedAgentMemory = createInjectedAgentMemoryScope(
    await prepareAndInjectAgentMemory({
      repoPath,
      workspace,
      stages: loaded.flow.spec.stages,
      runId,
      eventStore,
      context: runtimeContext,
    }),
  );

  const completedStages: string[] = [];
  let changeRequestUrl: string | undefined;
  let changeRequest: ChangeRequest | undefined;
  let syncMetadata: SyncMetadata | undefined;
  let latestChangeTitle: ChangeTitleMetadata | undefined;
  const gateResults: GateResult[] = [];
  const loadedSkillUsages: StageSkillUsage[] = [];
  const attemptsByStage = new Map<string, number>();
  const previousFailuresByStage = new Map<string, PreviousFailure[]>();
  const writeRunEvidenceSnapshot = async (): Promise<void> => {
    await writeEvidence({
      flowName: loaded.flow.metadata.name,
      runId,
      branchName,
      runDirectory,
      completedStages,
      gates: gateResults,
      agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
      runtimeUsage: projectRun(eventStore.list(runId)).runtimeUsage,
      repoIndexQueries: projectRun(eventStore.list(runId)).repoIndexQueries,
      loadedSkills: loadedSkillUsages,
      orchestratorDecisions: projectRun(eventStore.list(runId)).orchestratorDecisions,
      inputs: inputArtifacts,
      context: runtimeContext,
      taskScope: taskScopeSelection,
      planningApproval: input.planningApproval,
      changeTitle: latestChangeTitle,
      reworkTarget,
      syncMetadata,
    });
  };

  try {
    let stageIndex = 0;
    while (stageIndex < loaded.graph.order.length) {
      const stageId = loaded.graph.order[stageIndex];
      const stage = loaded.flow.spec.stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        stageIndex += 1;
        continue;
      }

      if (stage.type === "agent" || stage.type === "command" || stage.type === "gate") {
        const maxAttempts = maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts);
        const previousFailures = previousFailuresByStage.get(stage.id) ?? [];
        previousFailuresByStage.set(stage.id, previousFailures);
        let reworkRequested = false;
        let stageCompleted = false;

        while ((attemptsByStage.get(stage.id) ?? 0) < maxAttempts) {
          const attempt = (attemptsByStage.get(stage.id) ?? 0) + 1;
          let effectiveAttempt = attempt;
          attemptsByStage.set(stage.id, attempt);
          const attemptDirectory = await createAttemptDirectory({
            runDirectory,
            stageId: stage.id,
            attempt,
          });
          appendStageStarted({
            eventStore,
            runId,
            stage,
            attempt,
            attemptDirectory,
          });

          let failureError: string | undefined;
          try {
            if (stage.type === "agent") {
              const result = await executeAgentStage({
                runId,
                stage,
                attempt,
                attemptDirectory,
                runDirectory,
                repoPath,
                backend,
                dependencies,
                workspace,
                flowName: loaded.flow.metadata.name,
                flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
                flowMaxAttempts: loaded.flow.spec.maxAttempts,
                inputArtifacts,
                context: runtimeContext,
                eventStore,
                providerStore,
                loadedSkillUsages,
                previousFailures,
                completedStages,
                onAttemptSelected: (selectedAttempt) => {
                  effectiveAttempt = selectedAttempt;
                  attemptsByStage.set(stage.id, selectedAttempt);
                },
              });
              effectiveAttempt = result.selectedAttempt;
              stageCompleted = true;
              break;
            }

            if (stage.type === "gate") {
              const gateResult = await executeGateStage({
                runId,
                attempt,
                stage,
                repoPath,
                backend,
                dependencies,
                workspace,
                flowName: loaded.flow.metadata.name,
                flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
                flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                inputArtifacts,
                attemptDirectory,
                context: runtimeContext,
                eventStore,
                providerStore,
                loadedSkillUsages,
                previousFailures,
              });
              const recordedGate = recordGateStageResult({
                runId,
                stage,
                attempt,
                maxAttempts,
                gateResult,
                gateResults,
                completedStages,
                eventStore,
                context: runtimeContext,
              });
              effectiveAttempt = recordedGate.gateAttempt;
              if (recordedGate.passed) {
                stageCompleted = true;
                break;
              }
              failureError = recordedGate.reason;
              throw new Error(failureError);
            }

            const commandResult = await executeCommandStage({
              runId,
              stage,
              attempt,
              attemptDirectory,
              backend,
              workspace,
              flowMaxAttempts: loaded.flow.spec.maxAttempts,
              flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
              context: runtimeContext,
              eventStore,
              completedStages,
            });
            if (!commandResult.failureError) {
              stageCompleted = true;
              break;
            }
            failureError =
              redactRuntimeText(
                commandResult.failureError,
                runtimeContext,
              ) ?? "";
          } catch (error) {
            const blocked =
              error instanceof RunBlockedError
                ? error
                : stage.type === "agent"
                  ? classifyRunBlockedError({
                      stageId: stage.id,
                      runtime: stageRuntimeCandidates(stage)[0]?.runtime,
                      error,
                      context: runtimeContext,
                    })
                  : undefined;
            if (blocked) {
              if (!blocked.eventsAppended) {
                appendRunBlockedEvents({
                  eventStore,
                  runId,
                  stageId: stage.id,
                  attempt: effectiveAttempt,
                  blocker: blocked.blocker,
                  context: runtimeContext,
                });
              }
              throw blocked;
            }
            failureError = error instanceof Error ? error.message : String(error);
          }

          const error = failureError ?? "unknown error";
          eventStore.append({
            runId,
            stageId: stage.id,
            attempt: effectiveAttempt,
            type: "stage.failed",
            payload: redactRuntimeUnknown({ error }, runtimeContext),
          });

          const validReworkTargets = validReworkTargetsForStage(
            stage,
            loaded.graph.producerByArtifact,
          );
          const recommendation = dependencies.recommendOrchestration?.({
            stage,
            attempt: effectiveAttempt,
            error,
            validReworkTargets,
          });
          const reworkTarget =
            recommendation === undefined
              ? dependencies.recommendRework?.({
                  stage,
                  attempt: effectiveAttempt,
                  error,
                  validReworkTargets,
                })
              : undefined;
          const decision = decideStagePolicy({
            stageType: stage.type,
            succeeded: false,
            attempt: effectiveAttempt,
            maxAttempts,
            error,
            recommendation,
            reworkTarget,
            validReworkTargets,
          });
          appendOrchestratorDecision({
            eventStore,
            runId,
            stage,
            attempt: effectiveAttempt,
            maxAttempts,
            decision,
            context: runtimeContext,
            error,
          });

          if (decision.action === "retry") {
            previousFailures.push({ attempt: effectiveAttempt, error });
            eventStore.append({
              runId,
              stageId: stage.id,
              attempt: effectiveAttempt,
              type: "stage.retrying",
              payload: redactRuntimeUnknown(
                { reason: decision.reason, nextAttempt: effectiveAttempt + 1 },
                runtimeContext,
              ),
            });
            continue;
          }

          if (decision.action === "complete") {
            throw new Error("policy returned complete for a failed stage");
          }

          if (decision.action === "escalate") {
            const escalated = `escalated: ${decision.reason}`;
            eventStore.append({
              runId,
              type: "run.failed",
              payload: redactRuntimeUnknown({
                stageId: stage.id,
                error: escalated,
              }, runtimeContext),
            });
            throw new Error(escalated);
          }

          if (decision.action === "rework") {
            const targetStageId = loaded.graph.producerByArtifact.get(
              decision.targetArtifact,
            );
            const targetIndex = targetStageId
              ? loaded.graph.order.indexOf(targetStageId)
              : -1;
            if (!targetStageId || targetIndex < 0) {
              throw new Error(
                `rework target has no producer: ${decision.targetArtifact}`,
              );
            }
            const targetStage = loaded.flow.spec.stages.find(
              (candidate) => candidate.id === targetStageId,
            );
            if (!targetStage) {
              throw new Error(`rework target stage not found: ${targetStageId}`);
            }
            const targetMaxAttempts = maxAttemptsForStage(
              targetStage,
              loaded.flow.spec.maxAttempts,
            );
            const targetNextAttempt = (attemptsByStage.get(targetStageId) ?? 0) + 1;
            if (targetNextAttempt > targetMaxAttempts) {
              const reason = `rework target ${decision.targetArtifact} has exhausted attempts`;
              appendOrchestratorDecision({
                eventStore,
                runId,
                stage,
                attempt: effectiveAttempt,
                maxAttempts,
                decision: {
                  action: "fail",
                  reason,
                },
                context: runtimeContext,
                error,
              });
              eventStore.append({
                runId,
                type: "run.failed",
                payload: redactRuntimeUnknown({
                  stageId: stage.id,
                  error: reason,
                }, runtimeContext),
              });
              throw new Error(reason);
            }
            eventStore.append({
              runId,
              stageId: stage.id,
              attempt: effectiveAttempt,
              type: "stage.rework.requested",
              payload: redactRuntimeUnknown({
                targetArtifact: decision.targetArtifact,
                reason: decision.reason,
              }, runtimeContext),
            });
            const targetFailures =
              previousFailuresByStage.get(targetStageId) ?? [];
            targetFailures.push({
              attempt: attemptsByStage.get(targetStageId) ?? 1,
              error: `downstream stage ${stage.id} requested rework of ${decision.targetArtifact}: ${decision.reason}`,
            });
            previousFailuresByStage.set(targetStageId, targetFailures);
            invalidateCompletedStagesFrom(
              completedStages,
              loaded.graph.order,
              targetIndex,
            );
            stageIndex = targetIndex;
            reworkRequested = true;
            break;
          }

          eventStore.append({
            runId,
            type: "run.failed",
            payload: redactRuntimeUnknown({
              stageId: stage.id,
              error: decision.reason,
            }, runtimeContext),
          });
          throw new Error(decision.reason);
        }
        if (reworkRequested) {
          continue;
        }
        if (!stageCompleted) {
          const usedAttempts = attemptsByStage.get(stage.id) ?? 0;
          const reason = `${stage.type} failed after ${usedAttempts} of ${maxAttempts} attempts`;
          eventStore.append({
            runId,
            type: "run.failed",
            payload: redactRuntimeUnknown({
              stageId: stage.id,
              error: reason,
            }, runtimeContext),
          });
          throw new Error(reason);
        }
        stageIndex += 1;
        continue;
      }

      const attempt = 1;
      const attemptDirectory = await createAttemptDirectory({
        runDirectory,
        stageId: stage.id,
        attempt,
      });
      appendStageStarted({
        eventStore,
        runId,
        stage,
        attempt,
        attemptDirectory,
      });

      try {
        if (stage.type === "sync-change") {
          syncMetadata = await executeSyncChangeStage({
            runId,
            stage,
            attempt,
            attemptDirectory,
            worktreePath,
            reworkTarget,
            inputArtifacts,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          stageIndex += 1;
          continue;
        }

        if (stage.type === "publish-change") {
          const published = await executePublishChangeStage({
            runId,
            stage,
            attempt,
            attemptDirectory,
            runWorkItemType,
            flowName: loaded.flow.metadata.name,
            repoPath,
            worktreePath,
            baseBranch,
            branchName,
            inputArtifacts,
            backend,
            workspace,
            injectedAgentMemory,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
            completedStages,
            onChangeTitleResolved: (title) => {
              latestChangeTitle = title;
            },
            writeEvidenceSnapshot: async () =>
              await writeEvidence({
                flowName: loaded.flow.metadata.name,
                runId,
                branchName,
                runDirectory,
                completedStages,
                gates: gateResults,
                agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
                runtimeUsage: projectRun(eventStore.list(runId)).runtimeUsage,
                repoIndexQueries: projectRun(eventStore.list(runId)).repoIndexQueries,
                loadedSkills: loadedSkillUsages,
                orchestratorDecisions: projectRun(eventStore.list(runId)).orchestratorDecisions,
                inputs: inputArtifacts,
                context: runtimeContext,
                taskScope: taskScopeSelection,
                planningApproval: input.planningApproval,
                changeTitle: latestChangeTitle,
              }),
          });
          changeRequestUrl = published.changeRequestUrl;
          changeRequest = published.changeRequest;
          stageIndex += 1;
          continue;
        }

        if (stage.type === "update-change") {
          const updated = await executeUpdateChangeStage({
            runId,
            stage,
            attempt,
            attemptDirectory,
            runWorkItemType,
            flowName: loaded.flow.metadata.name,
            repoPath,
            worktreePath,
            reworkTarget,
            reworkProvider,
            inputArtifacts,
            injectedAgentMemory,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
            completedStages,
            onChangeTitleResolved: (title) => {
              latestChangeTitle = title;
            },
            recordTitleBeforeUpdate: false,
            writeEvidenceSnapshot: async () =>
              await writeEvidence({
                flowName: loaded.flow.metadata.name,
                runId,
                branchName,
                runDirectory,
                completedStages,
                gates: gateResults,
                agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
                runtimeUsage: projectRun(eventStore.list(runId)).runtimeUsage,
                repoIndexQueries: projectRun(eventStore.list(runId)).repoIndexQueries,
                loadedSkills: loadedSkillUsages,
                orchestratorDecisions: projectRun(eventStore.list(runId)).orchestratorDecisions,
                inputs: inputArtifacts,
                context: runtimeContext,
                taskScope: taskScopeSelection,
                planningApproval: input.planningApproval,
                changeTitle: latestChangeTitle,
                reworkTarget,
                syncMetadata,
              }),
          });
          changeRequestUrl = updated.changeRequestUrl;
          changeRequest = updated.changeRequest;
          stageIndex += 1;
          continue;
        }

        if (stage.type === "approval") {
          await executeApprovalStage({
            runId,
            stage,
            attempt,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        eventStore.append({
          runId,
          stageId: stage.id,
          attempt,
          type: "stage.failed",
          payload: redactRuntimeUnknown({
            error: errorMessage,
          }, runtimeContext),
        });
        appendOrchestratorDecision({
          eventStore,
          runId,
          stage,
          attempt,
          maxAttempts: 1,
          decision: {
            action: "fail",
            reason: `${stage.type} failed after ${attempt} of 1 attempts: ${errorMessage}`,
          },
          context: runtimeContext,
          error: errorMessage,
        });
        eventStore.append({
          runId,
          type: "run.failed",
          payload: redactRuntimeUnknown({
            stageId: stage.id,
            error: errorMessage,
          }, runtimeContext),
        });
        throw error;
      }
      stageIndex += 1;
    }
  } catch (error) {
    try {
      await injectedAgentMemory.cleanup();
      await writeRunEvidenceSnapshot();
    } catch {
      // Preserve the original runtime failure.
    }
    eventStore.close();
    throw error;
  }

  await injectedAgentMemory.cleanup();
  if (taskScopeSelection) {
    eventStore.append({
      runId,
      type: "task.scope.completed",
      payload: redactRuntimeUnknown(
        {
          inputId: taskScopeSelection.inputId,
          expression: taskScopeSelection.expression,
          selectedTaskIds: taskScopeSelection.selectedTaskIds,
          completedTaskIds: taskScopeSelection.selectedTaskIds,
        },
        runtimeContext,
      ),
    });
  }
  await writeRunEvidenceSnapshot();

  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify(
      redactRuntimeUnknown({
        runId,
        flowName: loaded.flow.metadata.name,
        ownerId: input.ownerId,
        organizationId: input.organizationId,
        workItemId: input.workItemId,
        workItemType: input.workItemType ?? loaded.flow.metadata.workItemType,
        planningApproval: input.planningApproval,
        repoId: input.repoId,
        repoName: input.repoName,
        repoPath,
        branchName,
        worktreePath,
        changeRequestUrl,
        changeRequest,
        trigger: input.trigger,
        priorRunId: input.priorRunId,
        changeRequestTarget: reworkTarget
          ? {
              provider: reworkTarget.provider,
              target: reworkTarget.target,
              resolved: reworkTarget.resolved,
              previousHeadSha: reworkTarget.previousHeadSha,
              updatedHeadSha: reworkTarget.updatedHeadSha,
            }
          : undefined,
        sync: syncMetadata,
        gates: gateResults,
        completedStages,
        taskScope: taskScopeSelection
          ? taskScopeEventPayload(taskScopeSelection)
          : undefined,
        inputs: Object.fromEntries(
          [...inputArtifacts].map(([id, artifact]) => [
            id,
            {
              sourceUri: artifact.resource.sourceUri,
              mediaType: artifact.resource.mediaType,
              filename: artifact.resource.metadata?.filename ?? basename(artifact.contentPath),
            },
            ]),
        ),
      }, runtimeContext),
      null,
      2,
    ),
    "utf8",
  );

  eventStore.append({
    runId,
    type: "run.completed",
    payload: redactRuntimeUnknown({
      changeRequestUrl,
      changeRequest,
      trigger: input.trigger,
      priorRunId: input.priorRunId,
      changeRequestTarget: reworkTarget
        ? {
            provider: reworkTarget.provider,
            target: reworkTarget.target,
            resolved: reworkTarget.resolved,
            previousHeadSha: reworkTarget.previousHeadSha,
            updatedHeadSha: reworkTarget.updatedHeadSha,
          }
        : undefined,
      sync: syncMetadata,
      taskScope: taskScopeSelection
        ? taskScopeEventPayload(taskScopeSelection)
        : undefined,
    }, runtimeContext),
  });
  eventStore.close();
  return {
    runId,
    branchName,
    worktreePath,
    changeRequestUrl,
    changeRequest,
    previousHeadSha: reworkTarget?.previousHeadSha,
    updatedHeadSha: reworkTarget?.updatedHeadSha,
  };
}

function projectedInputsAsReferences(
  inputs: Record<string, unknown> | undefined,
): Record<string, ResourceReference> {
  const references: Record<string, ResourceReference> = {};
  for (const [id, value] of Object.entries(inputs ?? {})) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "connector" in value &&
      "uri" in value
    ) {
      references[id] = value as ResourceReference;
    }
  }
  return references;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectedReworkTarget(value: unknown): ReworkTargetState | undefined {
  const metadata = recordValue(value);
  const provider = metadata.provider;
  const resolved = metadata.resolved ?? metadata.target;
  if (provider !== "github" && provider !== "github-cli") return undefined;
  const resolvedRecord = recordValue(resolved);
  if (resolvedRecord.provider !== "github") return undefined;
  if (
    typeof resolvedRecord.owner !== "string" ||
    typeof resolvedRecord.repository !== "string" ||
    typeof resolvedRecord.number !== "number" ||
    typeof resolvedRecord.url !== "string" ||
    typeof resolvedRecord.baseBranch !== "string" ||
    typeof resolvedRecord.headBranch !== "string" ||
    typeof resolvedRecord.headSha !== "string"
  ) {
    return undefined;
  }
  const headRepository = recordValue(resolvedRecord.headRepository);
  if (
    typeof headRepository.owner !== "string" ||
    typeof headRepository.repository !== "string"
  ) {
    return undefined;
  }
  return {
    provider,
    target:
      typeof metadata.target === "string"
        ? metadata.target
        : String(resolvedRecord.number),
    resolved: {
      provider: "github",
      owner: resolvedRecord.owner,
      repository: resolvedRecord.repository,
      number: resolvedRecord.number,
      url: resolvedRecord.url,
      baseBranch: resolvedRecord.baseBranch,
      headBranch: resolvedRecord.headBranch,
      headSha: resolvedRecord.headSha,
      headRepository: {
        owner: headRepository.owner,
        repository: headRepository.repository,
      },
      isCrossRepository: resolvedRecord.isCrossRepository === true,
    },
    previousHeadSha:
      typeof metadata.previousHeadSha === "string"
        ? metadata.previousHeadSha
        : resolvedRecord.headSha,
    updatedHeadSha:
      typeof metadata.updatedHeadSha === "string"
        ? metadata.updatedHeadSha
        : undefined,
  };
}

function nextAttemptForStage(
  projection: ReturnType<typeof projectRun>,
  stageId: string,
): number {
  const stage = projection.stages.find((candidate) => candidate.stageId === stageId);
  if (!stage) return 1;
  return Math.max(0, ...stage.attempts.map((attempt) => attempt.attempt)) + 1;
}

export async function resumeRun(
  input: ResumeRunInput,
  dependencies: RunFlowDependencies = {},
): Promise<RunFlowResult> {
  const repoPath = resolve(input.repoPath);
  validateRunId(input.runId);
  const runDirectory = runDirectoryPath(repoPath, input.runId);
  const eventStore = new EventStore(eventStorePath(repoPath));
  try {
    const events = eventStore.list(input.runId);
    if (events.length === 0) {
      throw new Error(`run not found: ${input.runId}`);
    }

    let projection = projectRun(events);
    const resumableStages = projection.stages.filter(
      (stage) => stage.status === "interrupted" || stage.status === "blocked",
    );
    if (resumableStages.length === 0) {
      throw new Error(`run is not resumable: ${input.runId}`);
    }
    if (!projection.flowPath) {
      throw new Error(`run is missing flow path: ${input.runId}`);
    }
    if (!projection.worktreePath) {
      throw new Error(`run is missing workspace: ${input.runId}`);
    }
    if (!projection.branchName) {
      throw new Error(`run is missing branch: ${input.runId}`);
    }
    const flowPath = projection.flowPath;
    const branchName = projection.branchName;
    const worktreePath = projection.worktreePath;
    const providerStore = providerStoreForRun(repoPath, dependencies);
    const contextPolicy = await loadContextPolicy(repoPath);
    const constitution = await loadConstitution(repoPath);
    const redactionSecrets = await collectRuntimeRedactionSecrets({
      policy: contextPolicy,
      dependencies,
      providerStore,
    });
    const runtimeContext: RuntimeContext = {
      runId: input.runId,
      runDirectory,
      manifestEntries: [],
      manifestEntryIndexes: new Map(),
      artifactEntries: [],
      artifactEntryIndexes: new Map(),
      redactionSecrets,
      constitution,
    };
    const backend = await resolveBackend(dependencies, providerStore);
    const workspace: WorkspaceHandle = { runId: input.runId, path: worktreePath };
    const inputReferences = projectedInputsAsReferences(projection.inputs);
    const loaded =
      projection.flowDocument !== undefined
        ? parseFlowDocument(projection.flowDocument, {
            externalInputs: Object.keys(inputReferences),
          })
        : await loadFlow(flowPath, {
            externalInputs: Object.keys(inputReferences),
          });
    const runWorkItemType =
      projection.workItemType ?? loaded.flow.metadata.workItemType;
    const firstResumableStage = resumableStages[0]?.stageId;
    if (!firstResumableStage) {
      throw new Error(`run is not resumable: ${input.runId}`);
    }
    const startIndex = loaded.graph.order.findIndex(
      (stageId) => stageId === firstResumableStage,
    );
    if (startIndex < 0) {
      throw new Error(`resumable stage is not in flow: ${firstResumableStage}`);
    }

    const inputArtifacts = await snapshotInputs({
      repoPath,
      runDirectory,
      inputReferences,
      providerStore,
      policy: contextPolicy,
      context: runtimeContext,
      eventStore,
    });
    await seedRuntimeArtifactEntries(runtimeContext, projection);
    const completedStages = [...projection.completedStages];
    await rehydrateCompletedSyncArtifacts({
      inputs: inputArtifacts,
      stages: loaded.flow.spec.stages,
      completedStages,
      runDirectory,
      syncMetadata: projection.sync,
      context: runtimeContext,
      eventStore,
    });
    await rehydrateCompletedAgentTextArtifacts({
      inputs: inputArtifacts,
      stages: loaded.flow.spec.stages,
      projection,
      runDirectory,
      context: runtimeContext,
      eventStore,
    });
    const baseBranch = projection.baseBranch ?? "HEAD";
    let changeRequestUrl = projection.changeRequestUrl;
    let changeRequest = projection.changeRequest as ChangeRequest | undefined;
    let syncMetadata = projection.sync as SyncMetadata | undefined;
    let latestChangeTitle: ChangeTitleMetadata | undefined;
    const gateResults: GateResult[] = [...projection.gates];
    const loadedSkillUsages: StageSkillUsage[] =
      loadedSkillUsagesFromEvents(events);
    const reworkTarget = projectedReworkTarget(projection.changeRequestTarget);
    if (reworkTarget) {
      assertReworkFlowDoesNotPublishChange(loaded.flow.spec.stages);
    }
    const reworkProvider = reworkTarget
      ? scmProviderForRun(reworkTarget.provider, dependencies, providerStore)
      : undefined;
    const resumableStageById = new Map(
      resumableStages.map((stage) => [stage.stageId, stage]),
    );
    const writeRunEvidenceSnapshot = async (): Promise<string> => {
      return await writeEvidence({
        flowName: loaded.flow.metadata.name,
        runId: input.runId,
        branchName,
        runDirectory,
        completedStages,
        gates: gateResults,
        agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
        runtimeUsage: projectRun(eventStore.list(input.runId)).runtimeUsage,
        repoIndexQueries: projectRun(eventStore.list(input.runId)).repoIndexQueries,
        loadedSkills: loadedSkillUsages,
        orchestratorDecisions: projectRun(eventStore.list(input.runId)).orchestratorDecisions,
        inputs: inputArtifacts,
        context: runtimeContext,
        changeTitle: latestChangeTitle,
        reworkTarget,
        syncMetadata,
      });
    };
    const injectedAgentMemory = createInjectedAgentMemoryScope(
      await prepareAndInjectAgentMemory({
        repoPath,
        workspace,
        stages: loaded.flow.spec.stages,
        runId: input.runId,
        eventStore,
        context: runtimeContext,
      }),
    );

    for (const stageId of loaded.graph.order.slice(startIndex)) {
      const stage = loaded.flow.spec.stages.find((candidate) => candidate.id === stageId);
      if (!stage) continue;
      const attempt = nextAttemptForStage(projection, stage.id);
      let effectiveAttempt = attempt;
      const attemptDirectory = join(runDirectory, "stages", stage.id, String(attempt));
      await mkdir(attemptDirectory, { recursive: true });
      const resumableStage = resumableStageById.get(stage.id);
      const resumableAttempt = resumableStage?.attempts.at(-1);
      if (resumableAttempt && resumableStage?.status === "interrupted") {
        appendOrchestratorDecision({
          eventStore,
          runId: input.runId,
          stage,
          attempt: resumableAttempt.attempt,
          maxAttempts: maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts),
          decision: {
            action: "fail",
            reason: "interrupted after process restart",
          },
          context: runtimeContext,
          error: "interrupted after process restart",
        });
        eventStore.append({
          runId: input.runId,
          stageId: stage.id,
          attempt: resumableAttempt.attempt,
          type: "stage.failed",
          payload: {
            error: "interrupted after process restart",
            interrupted: true,
          },
        });
        resumableStageById.delete(stage.id);
        projection = projectRun(eventStore.list(input.runId));
      } else if (resumableStage) {
        resumableStageById.delete(stage.id);
      }
      const resumeSource =
        resumableStage?.status ??
        (projection.status === "blocked" ? "blocked" : "interrupted");
      appendStageStarted({
        eventStore,
        runId: input.runId,
        stage,
        attempt,
        attemptDirectory,
        resumedFrom: resumeSource,
      });

      try {
        if (stage.type === "agent") {
          const result = await executeAgentStage({
            runId: input.runId,
            stage,
            attempt,
            attemptDirectory,
            runDirectory,
            repoPath,
            backend,
            dependencies,
            workspace,
            flowName: loaded.flow.metadata.name,
            flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
            flowMaxAttempts: loaded.flow.spec.maxAttempts,
            inputArtifacts,
            context: runtimeContext,
            eventStore,
            providerStore,
            loadedSkillUsages,
            previousFailures: [],
            completedStages,
            resumedFrom: resumeSource,
            onAttemptSelected: (selectedAttempt) => {
              effectiveAttempt = selectedAttempt;
            },
          });
          effectiveAttempt = result.selectedAttempt;
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "command") {
          const commandResult = await executeCommandStage({
            runId: input.runId,
            stage,
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxAttempts: loaded.flow.spec.maxAttempts,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          if (commandResult.failureError) {
            throw new Error(commandResult.failureError);
          }
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "gate") {
          const gateResult = await executeGateStage({
            runId: input.runId,
            attempt,
            stage,
            repoPath,
            backend,
            dependencies,
            workspace,
            flowName: loaded.flow.metadata.name,
            flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
            inputArtifacts,
            attemptDirectory,
            context: runtimeContext,
            eventStore,
            providerStore,
            loadedSkillUsages,
          });
          const recordedGate = recordGateStageResult({
            runId: input.runId,
            stage,
            attempt,
            maxAttempts: maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts),
            gateResult,
            gateResults,
            completedStages,
            eventStore,
            context: runtimeContext,
          });
          effectiveAttempt = recordedGate.gateAttempt;
          if (!recordedGate.passed) {
            throw new Error(recordedGate.reason);
          }
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "sync-change") {
          syncMetadata = await executeSyncChangeStage({
            runId: input.runId,
            stage,
            attempt,
            attemptDirectory,
            worktreePath,
            reworkTarget,
            inputArtifacts,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "publish-change") {
          const published = await executePublishChangeStage({
            runId: input.runId,
            stage,
            attempt,
            attemptDirectory,
            runWorkItemType,
            flowName: loaded.flow.metadata.name,
            repoPath,
            worktreePath,
            baseBranch,
            branchName,
            inputArtifacts,
            backend,
            workspace,
            injectedAgentMemory,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
            completedStages,
            onChangeTitleResolved: (title) => {
              latestChangeTitle = title;
            },
            writeEvidenceSnapshot: writeRunEvidenceSnapshot,
          });
          changeRequestUrl = published.changeRequestUrl;
          changeRequest = published.changeRequest;
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "update-change") {
          const updated = await executeUpdateChangeStage({
            runId: input.runId,
            stage,
            attempt,
            attemptDirectory,
            runWorkItemType,
            flowName: loaded.flow.metadata.name,
            repoPath,
            worktreePath,
            reworkTarget,
            reworkProvider,
            inputArtifacts,
            injectedAgentMemory,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
            completedStages,
            onChangeTitleResolved: (title) => {
              latestChangeTitle = title;
            },
            recordTitleBeforeUpdate: true,
            writeEvidenceSnapshot: writeRunEvidenceSnapshot,
          });
          changeRequestUrl = updated.changeRequestUrl;
          changeRequest = updated.changeRequest;
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        }

        if (stage.type === "approval") {
          await executeApprovalStage({
            runId: input.runId,
            stage,
            attempt,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
        }
      } catch (error) {
        const blocked =
          error instanceof RunBlockedError
            ? error
            : stage.type === "agent"
              ? classifyRunBlockedError({
                  stageId: stage.id,
                  runtime: stageRuntimeCandidates(stage)[0]?.runtime,
                  error,
                  context: runtimeContext,
                })
              : undefined;
        if (blocked) {
          if (!blocked.eventsAppended) {
            appendRunBlockedEvents({
              eventStore,
              runId: input.runId,
              stageId: stage.id,
              attempt: effectiveAttempt,
              blocker: blocked.blocker,
              context: runtimeContext,
            });
          }
          await injectedAgentMemory.cleanup();
          await writeRunEvidenceSnapshot();
          throw blocked;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        eventStore.append({
          runId: input.runId,
          stageId: stage.id,
          attempt: effectiveAttempt,
          type: "stage.failed",
          payload: redactRuntimeUnknown({
            error: errorMessage,
          }, runtimeContext),
        });
        appendOrchestratorDecision({
          eventStore,
          runId: input.runId,
          stage,
          attempt: effectiveAttempt,
          maxAttempts:
            stage.type === "agent" || stage.type === "command" || stage.type === "gate"
              ? maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts)
              : 1,
          decision: {
            action: "fail",
            reason: `${stage.type} failed after ${effectiveAttempt} of ${
              stage.type === "agent" || stage.type === "command" || stage.type === "gate"
                ? maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts)
                : 1
            } attempts: ${errorMessage}`,
          },
          context: runtimeContext,
          error: errorMessage,
        });
        eventStore.append({
          runId: input.runId,
          type: "run.failed",
          payload: redactRuntimeUnknown({
            stageId: stage.id,
            error: errorMessage,
          }, runtimeContext),
        });
        await injectedAgentMemory.cleanup();
        await writeRunEvidenceSnapshot();
        throw error;
      }
    }

    await injectedAgentMemory.cleanup();
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify(
        redactRuntimeUnknown({
          runId: input.runId,
          flowName: loaded.flow.metadata.name,
          ownerId: projection.ownerId,
          organizationId: projection.organizationId,
          workItemId: projection.workItemId,
          workItemType: projection.workItemType ?? loaded.flow.metadata.workItemType,
          repoId: projection.repoId,
          repoName: projection.repoName,
          repoPath,
          branchName,
          worktreePath,
          changeRequestUrl,
          changeRequest,
          trigger: projection.trigger,
          priorRunId: projection.priorRunId,
          changeRequestTarget: reworkTarget
            ? {
                provider: reworkTarget.provider,
                target: reworkTarget.target,
                resolved: reworkTarget.resolved,
                previousHeadSha: reworkTarget.previousHeadSha,
                updatedHeadSha: reworkTarget.updatedHeadSha,
              }
            : undefined,
          sync: syncMetadata,
          gates: gateResults,
          completedStages,
          inputs: Object.fromEntries(
            [...inputArtifacts].map(([id, artifact]) => [
              id,
              {
                sourceUri: artifact.resource.sourceUri,
                mediaType: artifact.resource.mediaType,
                filename: artifact.resource.metadata?.filename ?? basename(artifact.contentPath),
              },
            ]),
          ),
        }, runtimeContext),
        null,
        2,
      ),
      "utf8",
    );
    eventStore.append({
      runId: input.runId,
      type: "run.completed",
      payload: redactRuntimeUnknown({
        changeRequestUrl,
        changeRequest,
        trigger: projection.trigger,
        priorRunId: projection.priorRunId,
        changeRequestTarget: reworkTarget
          ? {
              provider: reworkTarget.provider,
              target: reworkTarget.target,
              resolved: reworkTarget.resolved,
              previousHeadSha: reworkTarget.previousHeadSha,
              updatedHeadSha: reworkTarget.updatedHeadSha,
            }
          : undefined,
        sync: syncMetadata,
      }, runtimeContext),
    });
    return {
      runId: input.runId,
      branchName,
      worktreePath,
      changeRequestUrl,
      changeRequest,
      previousHeadSha: reworkTarget?.previousHeadSha,
      updatedHeadSha: reworkTarget?.updatedHeadSha,
    };
  } finally {
    eventStore.close();
  }
}
