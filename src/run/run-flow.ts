import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { GoogleDriveConnector } from "../connectors/google-drive.js";
import {
  LocalFileConnector,
  resolveLocalFileResource,
} from "../connectors/local-file.js";
import { NitelyArtifactConnector } from "../connectors/nitely-artifact.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { SourceUrlConnector } from "../connectors/source-url.js";
import type { FetchedResource, ResourceReference } from "../connectors/types.js";
import {
  mergeArtifacts,
  readMaterializedArtifact,
  readReconciledArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../artifacts/registry.js";
import type {
  ArtifactContract,
  GateResult,
  GateReviewOutput,
  ReviewGateVerdictRouting,
  RunArtifact,
} from "../artifacts/types.js";
import { SKILL_PAPERCUT_ARTIFACT_CONTRACT } from "../artifacts/types.js";
import { withProvenance } from "../artifacts/integrity.js";
import { validateAgainstSchema } from "../artifacts/validate.js";
import {
  CONFORMANCE_REPORT_MEDIA_TYPE,
  DEFAULT_CONFORMANCE_REPORT_ID,
  evaluateConformanceReport,
  formatConformanceReportEvidence,
  parseConformanceReportText,
  type ConformanceFinding,
  type ConformancePolicy,
  type ConformanceReport,
} from "../conformance/report.js";
import {
  appendConvergenceTasks,
  CONVERGENCE_REPORT_MEDIA_TYPE,
  CONVERGENCE_REPORT_VERSION,
  parseConvergenceReportText,
  type ConvergenceClassification,
} from "../task-artifacts/convergence.js";
import {
  assertWorkItemTypeAllowed,
  policyDeniedMessage,
  resolveEffectiveWorkItemTypePolicy,
} from "../work-items/governance.js";
import {
  assertPlanningReadyForExecution,
  formatPlanningApprovalEvidence,
  type PlanningApprovalStatus,
} from "../work-items/planning.js";
import type { RunEligibilityOverrideEvidence } from "./eligibility.js";
import {
  readContextManifest,
  redactContextManifestEntry,
  runRelativePath as manifestRunRelativePath,
  writeContextManifest,
  type ContextManifestEntry,
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
  containsSensitiveText,
  isSafeTokenCountField,
  isSensitiveKey,
  redactText,
  redactUnknown,
} from "../context/redaction.js";
import { renderExternalKnowledgePrompt } from "../knowledge-repositories/prompt.js";
import { knowledgeRepositoryRegistryExists } from "../knowledge-repositories/paths.js";
import {
  fingerprintKnowledgeRepositoryQuery as defaultFingerprintKnowledgeRepositoryQuery,
  pinKnowledgeRepositorySnapshots as defaultPinKnowledgeRepositorySnapshots,
  queryKnowledgeRepositories as defaultQueryKnowledgeRepositories,
} from "../knowledge-repositories/service.js";
import type {
  KnowledgeRetrievalMatch,
  KnowledgeRetrievalResult,
} from "../knowledge-repositories/retrieval.js";
import type {
  KnowledgeSnapshotSet,
} from "../knowledge-repositories/schema.js";
import {
  CONTEXT_KNOWLEDGE_CATEGORIES,
  createContextKnowledgeEntry,
  linkContextKnowledgeEntries,
  selectContextKnowledgeEntries,
  type ContextKnowledgeCategory,
  type ContextKnowledgeEntry,
} from "../context-kg/store.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { ensureContextKnowledgeProposalNotification } from "../web/context-knowledge-notifications.js";
import { loadFlow, parseFlowDocument, type FlowGraph } from "../flow/load.js";
import { decideBudgetStoppedResume } from "./budget-resume.js";
import { flowInputReferences } from "../flow/inputs.js";
import {
  assertRuntimeCandidateAllowedByCapabilities,
  effectiveCapabilityPolicy,
  isCapabilityStage,
  type EffectiveCapabilityPolicy,
} from "../flow/capabilities.js";
import {
  stageDependencyRequirements,
  type StageDependencyRequirements,
} from "../flow/requirements.js";
import {
  IDENTIFIER_PATTERN,
  outputContract,
  outputId,
  flowWorkItemType,
  stageRuntimeCandidates,
  stageOutputIds,
  type VerificationBudget,
  type ContextControls,
  type HookDefinition,
  type ReadPolicy,
  type TimeoutControls,
  type RuntimeCandidate,
  type Flow,
  type Stage,
} from "../flow/schema.js";
import {
  decideStagePolicy,
  type OrchestratorDecision,
  type OrchestratorDecisionEvent,
  type OrchestratorRecommendation,
  type ReworkRequest,
} from "../policy/decide.js";
import { findDescriptor } from "../providers/descriptors.js";
import { resolveProviderStore } from "../providers/index.js";
import type {
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
} from "../providers/types.js";
import {
  loadStageSkills,
  type LoadedSkill,
} from "../skills/load.js";
import {
  parseSkillPapercutSignals,
  recordReflectionSkillPapercuts,
} from "../skill-improvement/runtime.js";
import {
  applyFlowConfigurationTemplate,
  FlowConfigurationError,
  normalizeFlowConfiguration,
  renderFlowConfiguration,
  type FlowConfiguration,
} from "../flows/configurables.js";
import {
  billableRuntimeTokens,
  eventStorePath,
  projectRun,
  type ProjectedApproval,
  type ProjectedKnowledgeRetrieval,
  type ProjectedOperatorQuestion,
  type ProjectedRepoIndexQuery,
  type ProjectedRiskClassification,
  type ProjectedRuntimeUsageTotal,
  type ProjectedTaskScope,
  type ProjectedVerificationBudget,
  type ProjectedVerificationFailureDiagnosis,
  runDirectoryPath,
  validateRunId,
} from "./project.js";
import {
  questionIdForStageAttempt,
  readAttemptQuestion,
  renderOperatorQuestionAnswer,
} from "./questions.js";
import { operatorReviewForActiveBlocker } from "./operator-review.js";
import {
  blockingReviewReason,
  parseReviewGateVerdict,
} from "./review-verdict.js";
import { parseJudgeResult, type JudgeResult } from "./judge-result.js";
import {
  aggregateReviewPerspectives,
  renderAggregatedReviewMarkdown,
  reviewPerspectiveText,
} from "../review/aggregate.js";
import {
  evaluateChangeRisk,
  type ChangeRiskEvaluation,
} from "./change-risk.js";
import {
  renderRiskClassificationMarkdown,
  REVIEW_POLICY_RELATIVE_PATH,
} from "../policy/review-policy.js";
import { buildRunTrace, type RunCheckpoint } from "./trace.js";
import {
  classifyAgentRuntimeBlocker,
  type RunBlocker,
} from "./blockers.js";
import {
  loadConstitution,
  type Constitution,
} from "./constitution.js";
import {
  loadProjectInstructions,
  selectProjectInstructions,
  type ProjectInstructions,
  type SelectedProjectInstruction,
} from "./project-instructions.js";
import {
  injectAgentMemoryFiles,
  prepareAgentMemory,
  removeGeneratedAgentMemoryFilesFromGit,
  removeInjectedAgentMemoryFiles,
  type InjectedAgentMemoryFile,
} from "./knowledge.js";
import {
  validateAttemptOutputs,
  type ValidatedAttemptOutput,
} from "./attempt-outputs.js";
import {
  requireContainedAttemptDirectory,
  writeAttemptOwnedFile,
} from "./attempt-files.js";
import {
  RunOwnedFileIntegrityError,
  readRunOwnedFile,
  writeRunOwnedFileAtomically,
} from "./owned-file.js";
import {
  sha256File,
  sha256Text,
  readReproducibilityManifest,
  writeReproducibilityManifest,
  type ReproducibilityInputSnapshot,
  type ReproducibilityManifest,
} from "./reproducibility.js";
import {
  readToolchainPreflight,
  writeToolchainPreflight,
  type ToolchainPreflight,
} from "./toolchain-preflight.js";
import { defaultMaxRuntimeTokens } from "./budget-defaults.js";
import { writeRecoverySnapshot } from "./recovery.js";
import { analyzeSpecPlanTasks } from "../analysis/spec-plan-task.js";
import {
  renderScopedTaskArtifact,
  selectTaskScope,
  type TaskScopeInput,
  type TaskScopeSelection,
} from "../task-artifacts/scope.js";
import {
  completedTaskIdsFromPlan,
  nextPendingTask,
  parseTaskPlanJson,
  renderCurrentTaskPlan,
  taskPlanProgress,
  type ParsedTaskPlan,
  type TaskPlanHistoryEntry,
  type TaskPlanTask,
} from "../task-artifacts/plan.js";
import {
  diagnoseVerificationFailure,
  type VerificationFailureDiagnosis,
} from "../verification/diagnosis.js";
import {
  classifySecurityFinding,
  renderSecurityAssessmentMarkdown,
} from "../security/findings.js";
import { createScmProvider } from "../scm/registry.js";
import {
  linkTaskIssuesToRun,
  resolveTaskIssueScope,
  type ResolvedTaskIssueScope,
  type TaskIssueRunStatus,
} from "../task-issues/bridge.js";
import type {
  ChangeRequest,
  ChangeRequestMetadataUpdate,
  ChangeRequestTarget,
  CheckoutChangeRequestResult,
  ScmProvider,
  UpdateChangeRequestResult,
} from "../scm/types.js";
import type { NormalizedReviewFeedback } from "../review-feedback/model.js";
import { normalizeRuntimeUsageForPersistence } from "../eval/usage.js";
import {
  createExecutionBackend,
  normalizeExecutionBackendName,
} from "./execution/backend.js";
import { formatExecutionBackendEvidence } from "./execution/evidence.js";
import {
  requireCodexSandboxMode,
  type RunSandboxPolicy,
} from "./execution/sandbox.js";
import type {
  AgentGlobalSkillsOutcome,
  AgentGlobalSkillsRequest,
  AgentSessionOutcome,
  AgentRunnableStage,
  AgentRuntimePreflightResult,
  AgentResult,
  AgentRuntimeUsage,
  CommandEnvironmentRepair,
  CommandResult,
  ExecutionBackend,
  ExecutionBackendDescription,
  ProcessTerminationResult,
  WorkspaceHandle,
} from "./execution/types.js";
import {
  beginRuntimeCandidateAttempt,
  beginStageAttempt,
  maxAttemptsForStage,
  prepareStageAttempt,
  reworkEdgeFromRequestedPayload,
  runtimeCandidateEventPayload,
  stageWithRuntimeCandidate,
  type ReworkEdge,
} from "./stage-execution.js";

export { createCodexExecArgs } from "./execution/local.js";

const execFileAsync = promisify(execFile);

class BudgetExceededError extends Error {
  readonly stageId?: string;
  readonly attempt?: number;
  /**
   * Set when the breach was detected only after the stage had validated and
   * registered its declared outputs and been recorded complete.
   *
   * The run still stops, but the stage did not fail, so the caller must not
   * append `stage.failed` for it: `projectRun` deletes a stage from
   * `completedStages` on that event, which would make a resume repeat work the
   * operator has already paid for -- the defect #517 was opened about.
   */
  stageCompleted = false;

  constructor(message: string, stageId?: string, attempt?: number) {
    super(message);
    this.name = "BudgetExceededError";
    this.stageId = stageId;
    this.attempt = attempt;
  }
}

class RunCancelledError extends Error {
  readonly stageId?: string;
  readonly attempt?: number;
  readonly cleanup?: ProcessTerminationResult;
  readonly request?: RunCancellationRequest;

  constructor(input: {
    request?: RunCancellationRequest;
    stageId?: string;
    attempt?: number;
    cleanup?: ProcessTerminationResult;
    message?: string;
  }) {
    super(input.message ?? `run cancelled${input.request?.reason ? `: ${input.request.reason}` : ""}`);
    this.name = "RunCancelledError";
    this.request = input.request;
    this.stageId = input.stageId;
    this.attempt = input.attempt;
    this.cleanup = input.cleanup;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cancellationRequestFromSignal(
  cancellation: RunCancellationControl | undefined,
): RunCancellationRequest | undefined {
  const explicit = cancellation?.getRequest?.();
  if (explicit) return explicit;
  const reason = cancellation?.signal.reason as unknown;
  if (reason instanceof Error) {
    return { reason: reason.message };
  }
  if (typeof reason === "string") {
    return { reason };
  }
  const record = recordFromUnknown(reason);
  const request: RunCancellationRequest = {
    ...(typeof record.actor === "string" ? { actor: record.actor } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.requestedAt === "string" ? { requestedAt: record.requestedAt } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.notificationId === "string" ? { notificationId: record.notificationId } : {}),
    ...(typeof record.sourceKey === "string" ? { sourceKey: record.sourceKey } : {}),
  };
  return Object.keys(request).length > 0 ? request : undefined;
}

function throwIfRunCancelled(
  cancellation: RunCancellationControl | undefined,
  stage?: RunCancellationStage,
): void {
  if (!cancellation?.signal.aborted) return;
  const request = cancellationRequestFromSignal(cancellation);
  throw new RunCancelledError({
    request,
    stageId: stage?.stageId,
    attempt: stage?.attempt,
  });
}

function isExecutionCancellationError(error: unknown): error is Error & {
  cancelled: true;
  termination?: ProcessTerminationResult;
} {
  const record = recordFromUnknown(error);
  return record.cancelled === true;
}

function appendRunCancelledEvent(input: {
  eventStore: EventStore;
  runId: string;
  error: RunCancelledError;
  context: RuntimeContext;
}): void {
  const existing = input.eventStore.list(input.runId);
  if (
    existing.some(
      (event) =>
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.blocked" ||
        event.type === "run.cancelled",
    )
  ) {
    return;
  }
  const requestedAt = input.error.request?.requestedAt ?? new Date().toISOString();
  input.eventStore.append({
    runId: input.runId,
    ...(input.error.stageId ? { stageId: input.error.stageId } : {}),
    ...(input.error.attempt !== undefined ? { attempt: input.error.attempt } : {}),
    type: "run.cancelled",
    payload: redactRuntimeUnknown(
      {
        actor: input.error.request?.actor ?? "system",
        reason: input.error.request?.reason ?? "run cancellation requested",
        requestedAt,
        cancelledAt: new Date().toISOString(),
        source: input.error.request?.source ?? "run-flow",
        notificationId: input.error.request?.notificationId,
        sourceKey: input.error.request?.sourceKey,
        affectedStage: input.error.stageId,
        affectedAttempt: input.error.attempt,
        cleanup: input.error.cleanup ?? {
          reason: "cancelled",
          result: "no-active-process-cleanup",
        },
      },
      input.context,
    ),
  });
}

export interface RunFlowInput {
  flowPath: string;
  flowDocument?: string;
  repoPath: string;
  expectedSourceRevision?: string;
  expectedContextPolicySha256?: string;
  expectedPromptContext?: ExpectedPromptContext;
  expectedSkillContentHashes?: ExpectedSkillContentHashes;
  evalReplayInvocationId?: string;
  executionBackend?: string;
  sandboxPolicy?: RunSandboxPolicy;
  repoId?: string;
  repoName?: string;
  inputs: Record<string, ResourceReference>;
  configuration?: Record<string, unknown>;
  ownerId?: string;
  organizationId?: string;
  workItemId?: string;
  workItemType?: string;
  planningApproval?: PlanningApprovalStatus;
  runEligibilityOverride?: RunEligibilityOverrideEvidence;
  trigger?: RunTrigger;
  priorRunId?: string;
  taskScope?: TaskScopeInput;
  changeRequestTarget?: {
    provider: "github" | "github-cli";
    target: string;
  };
}

export interface ExpectedPromptSourceIdentity {
  loaded: boolean;
  path: string;
  hash?: string;
}

export interface ExpectedPromptContext {
  constitution: ExpectedPromptSourceIdentity;
  projectInstructions: ExpectedPromptSourceIdentity;
}

export type ExpectedSkillContentHashes = Record<string, Record<string, string>>;

export type RunTrigger =
  | {
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
      feedback?: NormalizedReviewFeedback;
      priorRunId?: string;
    }
  | {
      type: "task-rework-request";
      taskId: string;
      requestId: string;
      routeTarget: "implementation" | "spec" | "tech-design" | "workflow";
      instruction: string;
      priorRunId: string;
      changeRequestUrl: string;
      actorId: string;
    };

export interface ResumeRunInput {
  repoPath: string;
  runId: string;
  checkpointId?: string;
  executionBackend?: string;
}

export interface AgentExecutionInput {
  stage: AgentRunnableStage;
  prompt: string;
  worktreePath: string;
  attemptDirectory: string;
  signal?: AbortSignal;
}

export interface RunCancellationStage {
  stageId: string;
  attempt: number;
}

export interface RunCancellationRequest {
  actor?: string;
  reason?: string;
  requestedAt?: string;
  source?: string;
  notificationId?: string;
  sourceKey?: string;
}

export interface RunCancellationControl {
  signal: AbortSignal;
  getRequest?: () => RunCancellationRequest | undefined;
  onStageChange?: (stage: RunCancellationStage | undefined) => void;
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

export interface RefreshChangeEvidenceInput {
  repoPath: string;
  worktreePath: string;
  changeRequest: ChangeRequest;
  evidencePath: string;
  title?: string;
  body: string;
}

export interface RefreshChangeEvidenceResult {
  url: string;
  evidencePath: string;
  changeRequest?: ChangeRequest;
  metadataUpdate?: ChangeRequestMetadataUpdate;
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
const GIT_EVIDENCE_MAX_BUFFER = 10 * 1024 * 1024;

export interface ReworkRecommendationInput {
  stage: Stage;
  attempt: number;
  error: string;
  validReworkTargets: ReadonlySet<string>;
  validReworkStages: ReadonlySet<string>;
}

export interface OrchestratorRecommendationInput {
  stage: Stage;
  attempt: number;
  error: string;
  validReworkTargets: ReadonlySet<string>;
  validReworkStages: ReadonlySet<string>;
}

export interface RunFlowDependencies {
  createRunId?: () => string;
  createEventStore?: (path: string) => EventStore;
  backend?: ExecutionBackend;
  providerStore?: ProviderConnectionStore;
  cancellation?: RunCancellationControl;
  /** Web may keep user-scoped knowledge credentials outside the target repository. */
  knowledgeProviderStore?: ProviderConnectionStore;
  /** @deprecated Provide `backend` instead. Honored only when `backend` is unset. */
  executeAgent?: (input: AgentExecutionInput) => Promise<void>;
  publishChange?: (input: PublishChangeInput) => Promise<PublishChangeResult>;
  refreshChangeRequestEvidence?: (
    input: RefreshChangeEvidenceInput,
  ) => Promise<RefreshChangeEvidenceResult | void>;
  scmProvider?: ScmProvider;
  resolveTaskIssueScope?: typeof resolveTaskIssueScope;
  linkTaskIssuesToRun?: typeof linkTaskIssuesToRun;
  recommendOrchestration?: (
    input: OrchestratorRecommendationInput,
  ) => OrchestratorRecommendation | undefined;
  recommendRework?: (input: ReworkRecommendationInput) => string | undefined;
  fingerprintKnowledgeRepositoryQuery?: typeof defaultFingerprintKnowledgeRepositoryQuery;
  pinKnowledgeRepositorySnapshots?: typeof defaultPinKnowledgeRepositorySnapshots;
  queryKnowledgeRepositories?: typeof defaultQueryKnowledgeRepositories;
}

export interface RunFlowResult {
  runId: string;
  branchName: string;
  worktreePath: string;
  status?: "awaiting-approval";
  approvalId?: string;
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
  stageKind: "agent" | "judge" | "review-gate";
  candidates: RuntimeCandidate[];
  capabilityPolicy: EffectiveCapabilityPolicy;
}

interface ConformancePolicyEvidence {
  stageId: string;
  policy: ConformancePolicy;
}

interface CommandAttemptEvidence {
  stageId: string;
  attempt: number;
  directory: string;
  command?: string;
  exitCode?: number;
  outputPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  environmentRepairs: CommandEnvironmentRepair[];
}

interface HookAttemptEvidence {
  hookId: string;
  scope: "flow" | "stage";
  phase: "preRun" | "postRun" | "pre" | "post";
  stageId?: string;
  attempt?: number;
  directory: string;
  command?: string;
  onFailure?: HookDefinition["onFailure"];
  exitCode?: number;
  status?: "passed" | "blocked" | "warned" | "recorded";
  outputPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  environmentRepairs: CommandEnvironmentRepair[];
}

interface AttemptFileEvidence {
  kind: "artifact" | "command" | "hook";
  directory: string;
  command?: string;
  exitCode?: number;
  environmentRepairs?: CommandEnvironmentRepair[];
  hookId?: string;
  hookScope?: HookAttemptEvidence["scope"];
  hookPhase?: HookAttemptEvidence["phase"];
  hookStatus?: HookAttemptEvidence["status"];
  hookOnFailure?: HookDefinition["onFailure"];
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
}

interface StageSkillUsage {
  stageId: string;
  skills: LoadedSkill[];
}

type TerminalRunStatus = "completed" | "failed" | "blocked" | "cancelled";
type EvidenceRunStatus = "in-progress" | TerminalRunStatus;

type EvidenceTaskScope = Pick<
  TaskScopeSelection,
  "inputId" | "expression" | "selectedTaskIds"
> &
  Pick<
    ProjectedTaskScope,
    "kind" | "completedTaskIds" | "pendingTaskIds" | "sourceTaskCount"
  >;

interface AppliedTaskScope {
  selection: TaskScopeSelection;
  scopedInputs: Map<string, InputArtifact>;
}

interface TaskPlanLoopState {
  inputId: string;
  plan: ParsedTaskPlan;
  completedTaskIds: Set<string>;
  currentTaskId?: string;
  iteration: number;
  maxIterations: number;
  history: TaskPlanHistoryEntry[];
}

interface TaskPlanPromptContext {
  inputId: string;
  content: string;
}

interface PreparedTaskPlanStage {
  state: TaskPlanLoopState;
  currentTask?: TaskPlanTask;
  promptContext?: TaskPlanPromptContext;
}

interface TaskPlanExecutionController {
  readonly stageIndex: number;
  readonly done: boolean;
  readonly stageId: string | undefined;
  prepare(stage: Stage): {
    run: boolean;
    prepared?: PreparedTaskPlanStage;
  };
  complete(stage: Stage, prepared: PreparedTaskPlanStage | undefined, attempt?: number): void;
  next(): void;
  rework(stageIndex: number, request: ReworkRequest): void;
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatPathCapability(input: {
  scope?: string;
  allow: readonly string[];
}): string {
  const parts = [
    input.scope ? `scope ${input.scope}` : undefined,
    input.allow.length > 0 ? `allow ${input.allow.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("; ") : "none";
}

function formatCapabilityPolicyEvidence(
  capability: EffectiveCapabilityPolicy,
): string[] {
  const { policy } = capability;
  return [
    `  Capabilities: ${capability.source}`,
    `  Read: ${formatPathCapability(policy.read)}`,
    `  Write: ${formatPathCapability(policy.write)}`,
    `  Commands: ${policy.commands.mode}${
      policy.commands.advisory ? " (advisory)" : ""
    }; allow ${listOrNone(policy.commands.allow)}; deny ${listOrNone(policy.commands.deny)}`,
    `  Network: ${policy.network.mode}${
      policy.network.advisory ? " (advisory)" : ""
    }`,
    `  Allowed runtimes: ${listOrNone(policy.allowedRuntimes)}`,
    `  Allowed models: ${listOrNone(policy.allowedModels)}`,
    `  Instructions: repo=${policy.instructions.repo}, generated=${policy.instructions.generated}, skills=${policy.instructions.skills}`,
    `  Evidence: prompts=${policy.evidence.prompts}, toolCalls=${policy.evidence.toolCalls}, fileChanges=${policy.evidence.fileChanges}, runtimeUsage=${policy.evidence.runtimeUsage}`,
  ];
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

export interface ResolvedExternalKnowledgeControls {
  enabled: boolean;
  ids?: string[];
  topK: number;
  maxPromptTokens: number;
  availability: "required" | "degraded-ok";
}

export interface ExternalKnowledgeAdmissionControls {
  ids?: string[];
  requiredIds?: string[];
  availability: "required" | "degraded-ok";
}

/**
 * How an attempt treats the operator's user-global runtime skill packs
 * (`~/.codex/skills`, plugin caches, `~/.agents/skills`, ...).
 *
 * - `isolate-if-supported`: the default. Isolate on runtimes that can, and run
 *   unchanged on runtimes that cannot.
 * - `required-isolated`: the flow demands isolation; a runtime without a
 *   mechanism fails the stage instead of silently loading the packs.
 * - `inherited`: the flow opted back into the operator's global packs.
 */
type GlobalSkillsMode = "isolate-if-supported" | "required-isolated" | "inherited";

interface ResolvedStageContextControls {
  isolated: boolean;
  instructionFiles: boolean;
  projectInstructions: boolean;
  contextKnowledge: boolean;
  externalKnowledge: ResolvedExternalKnowledgeControls;
  previousFailures: boolean;
  fullReadInputs: string[];
  globalSkills: GlobalSkillsMode;
  /** Undefined means "decide from the stage kind". */
  sessionReuse: boolean | undefined;
}

interface StageContextEvidence {
  stageId: string;
  kind: "agent" | "judge" | "review-gate";
  isolated: boolean;
  instructionFiles: boolean;
  projectInstructions: boolean;
  contextKnowledge: boolean;
  externalKnowledge: ResolvedExternalKnowledgeControls;
  previousFailures: boolean;
  fullReadInputs: string[];
  globalSkills: GlobalSkillsMode;
  /** Undefined means "decide from the stage kind". */
  sessionReuse: boolean | undefined;
}

/**
 * Default read bounds. A review gate reads to judge and should never need a
 * multi-megabyte file; an implement stage edits real sources and gets a larger
 * but still finite cap.
 */
const DEFAULT_AGENT_MAX_READ_FILE_BYTES = 256 * 1024;
const DEFAULT_REVIEW_MAX_READ_FILE_BYTES = 32 * 1024;
const DEFAULT_READ_DENY_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/*.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
] as const;

interface ResolvedStageReadPolicy {
  maxFileBytes: number;
  deny: string[];
  enforcement: "advisory" | "required";
}

interface StageReadPolicyEvidence extends ResolvedStageReadPolicy {
  stageId: string;
  kind: "agent" | "judge" | "review-gate";
}

function resolveStageReadPolicy(
  flowReads: ReadPolicy | undefined,
  stage: Stage,
): ResolvedStageReadPolicy {
  const stageReads = "reads" in stage ? stage.reads : undefined;
  const isReviewGate = stage.type === "gate" && stage.mode === "review";
  return {
    maxFileBytes:
      stageReads?.maxFileBytes ??
      flowReads?.maxFileBytes ??
      (isReviewGate
        ? DEFAULT_REVIEW_MAX_READ_FILE_BYTES
        : DEFAULT_AGENT_MAX_READ_FILE_BYTES),
    deny: [...(stageReads?.deny ?? flowReads?.deny ?? DEFAULT_READ_DENY_GLOBS)],
    enforcement:
      stageReads?.enforcement ?? flowReads?.enforcement ?? "advisory",
  };
}

function collectStageReadPolicyEvidence(flow: Flow): StageReadPolicyEvidence[] {
  return flow.spec.stages
    .filter(
      (
        stage,
      ): stage is
        | Extract<Stage, { type: "agent" }>
        | Extract<Stage, { type: "judge" }>
        | Extract<Stage, { type: "gate"; mode: "review" }> =>
        stage.type === "agent" ||
        stage.type === "judge" ||
        (stage.type === "gate" && stage.mode === "review"),
    )
    .map((stage) => ({
      stageId: stage.id,
      kind: stage.type === "judge"
        ? ("judge" as const)
        : stage.type === "agent"
          ? ("agent" as const)
          : ("review-gate" as const),
      ...resolveStageReadPolicy(flow.spec.reads, stage),
    }));
}

interface ResolvedStageTimeouts {
  sessionMs?: number;
  turnMs?: number;
  stallMs?: number;
  busyIdleMs?: number;
  pauseMs?: number;
  commandMs?: number;
  gateMs?: number;
}

interface StageTimeoutEvidence extends ResolvedStageTimeouts {
  stageId: string;
  kind: Stage["type"] | "review-gate" | "deterministic-gate";
}

interface RuntimeContext {
  runId: string;
  repoPath: string;
  runDirectory: string;
  manifestEntries: ContextManifestEntry[];
  manifestEntryIndexes: Map<string, number>;
  artifactEntries: RunArtifact[];
  artifactEntryIndexes: Map<string, number>;
  redactionSecrets: string[];
  constitution: Constitution;
  projectInstructions: ProjectInstructions;
  expectedSkillContentHashes?: ExpectedSkillContentHashes;
  /** Immutable external knowledge identities admitted for this Run. */
  knowledgeSnapshots?: KnowledgeSnapshotSet;
}

const KNOWLEDGE_SNAPSHOT_SET_PATH = "knowledge-snapshots.json";

function parseKnowledgeSnapshotSet(value: unknown): KnowledgeSnapshotSet {
  const record = asRecord(value);
  if (
    record.version !== 1 ||
    typeof record.pinnedAt !== "string" ||
    !Number.isFinite(new Date(record.pinnedAt).getTime()) ||
    !Array.isArray(record.attachments) ||
    !Array.isArray(record.degradedAttachmentIds) ||
    !record.degradedAttachmentIds.every((id) => typeof id === "string")
  ) {
    throw new Error("invalid external knowledge snapshot set");
  }
  const attachments = record.attachments.map((value) => {
    const pin = asRecord(value);
    if (
      typeof pin.attachmentId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(pin.attachmentId) ||
      typeof pin.snapshotId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(pin.snapshotId) ||
      typeof pin.commitSha !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pin.commitSha) ||
      typeof pin.indexDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(pin.indexDigest) ||
      typeof pin.policyFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(pin.policyFingerprint) ||
      typeof pin.providerId !== "string" ||
      typeof pin.model !== "string" ||
      typeof pin.providerConfigurationDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(pin.providerConfigurationDigest) ||
      !Number.isSafeInteger(pin.topK) ||
      Number(pin.topK) < 1 ||
      Number(pin.topK) > 100 ||
      !Number.isSafeInteger(pin.maxPromptTokens) ||
      Number(pin.maxPromptTokens) < 64 ||
      Number(pin.maxPromptTokens) > 32_768 ||
      typeof pin.attachmentRequired !== "boolean" ||
      typeof pin.required !== "boolean" ||
      Object.prototype.hasOwnProperty.call(pin, "indexPath")
    ) {
      throw new Error("invalid external knowledge snapshot pin");
    }
    return {
      attachmentId: pin.attachmentId,
      snapshotId: pin.snapshotId,
      commitSha: pin.commitSha,
      indexDigest: pin.indexDigest,
      policyFingerprint: pin.policyFingerprint,
      providerId: pin.providerId,
      model: pin.model,
      providerConfigurationDigest: pin.providerConfigurationDigest,
      topK: Number(pin.topK),
      maxPromptTokens: Number(pin.maxPromptTokens),
      attachmentRequired: pin.attachmentRequired,
      required: pin.required,
    };
  });
  const ids = attachments.map((pin) => pin.attachmentId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("external knowledge snapshot set contains duplicate attachments");
  }
  return {
    version: 1,
    pinnedAt: record.pinnedAt,
    attachments,
    degradedAttachmentIds: [...new Set(record.degradedAttachmentIds as string[])].sort(),
  };
}

export function verifyKnowledgeSnapshotSetForResume(
  expectedValue: unknown,
  persisted: KnowledgeSnapshotSet | undefined,
): KnowledgeSnapshotSet | undefined {
  if (expectedValue === undefined && persisted === undefined) return undefined;
  if (expectedValue === undefined || persisted === undefined) {
    throw new Error("external knowledge snapshot set is missing from resume evidence");
  }
  const expected = parseKnowledgeSnapshotSet(expectedValue);
  if (JSON.stringify(expected) !== JSON.stringify(persisted)) {
    throw new Error("external knowledge snapshot set does not match run admission evidence");
  }
  return persisted;
}

async function readKnowledgeSnapshotSetForRun(
  runDirectory: string,
): Promise<KnowledgeSnapshotSet | undefined> {
  const path = join(runDirectory, KNOWLEDGE_SNAPSHOT_SET_PATH);
  requirePathInside(runDirectory, path, "external knowledge snapshot set");
  try {
    return parseKnowledgeSnapshotSet(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function promptSourceIdentity(
  source: Constitution | ProjectInstructions,
): ExpectedPromptSourceIdentity {
  return {
    loaded: source.loaded,
    path: source.path,
    ...(source.loaded ? { hash: source.hash } : {}),
  };
}

function promptContextIdentity(input: {
  constitution: Constitution;
  projectInstructions: ProjectInstructions;
}): ExpectedPromptContext {
  return {
    constitution: promptSourceIdentity(input.constitution),
    projectInstructions: promptSourceIdentity(input.projectInstructions),
  };
}

function samePromptSourceIdentity(
  expected: ExpectedPromptSourceIdentity,
  actual: ExpectedPromptSourceIdentity,
): boolean {
  return expected.loaded === actual.loaded &&
    expected.path === actual.path &&
    expected.hash === actual.hash;
}

function expectedPromptSourceIdentityFromUnknown(
  value: unknown,
): ExpectedPromptSourceIdentity | undefined {
  const record = asRecord(value);
  if (
    typeof record.loaded !== "boolean" ||
    typeof record.path !== "string" ||
    record.path.length === 0
  ) {
    return undefined;
  }
  if (record.loaded) {
    if (
      typeof record.hash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/i.test(record.hash)
    ) {
      return undefined;
    }
    return { loaded: true, path: record.path, hash: record.hash };
  }
  if (record.hash !== undefined) return undefined;
  return { loaded: false, path: record.path };
}

function expectedPromptContextFromUnknown(
  value: unknown,
): ExpectedPromptContext | undefined {
  const record = asRecord(value);
  const constitution = expectedPromptSourceIdentityFromUnknown(
    record.constitution,
  );
  const projectInstructions = expectedPromptSourceIdentityFromUnknown(
    record.projectInstructions,
  );
  return constitution && projectInstructions
    ? { constitution, projectInstructions }
    : undefined;
}

function expectedSkillContentHashesFromUnknown(
  value: unknown,
): ExpectedSkillContentHashes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: ExpectedSkillContentHashes = {};
  for (const [stageId, skillsValue] of Object.entries(value)) {
    if (!IDENTIFIER_PATTERN.test(stageId)) return undefined;
    if (
      typeof skillsValue !== "object" ||
      skillsValue === null ||
      Array.isArray(skillsValue)
    ) {
      return undefined;
    }
    const skills: Record<string, string> = {};
    for (const [skillId, hash] of Object.entries(skillsValue)) {
      if (
        !IDENTIFIER_PATTERN.test(skillId) ||
        typeof hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/i.test(hash)
      ) {
        return undefined;
      }
      skills[skillId] = hash;
    }
    result[stageId] = skills;
  }
  return result;
}

function assertExpectedPromptContext(input: {
  expected?: ExpectedPromptContext;
  constitution: Constitution;
  projectInstructions: ProjectInstructions;
  label: string;
}): void {
  if (!input.expected) return;
  const actual = promptContextIdentity(input);
  for (const key of ["constitution", "projectInstructions"] as const) {
    if (!samePromptSourceIdentity(input.expected[key], actual[key])) {
      throw new Error(`${input.label} ${key} digest mismatch`);
    }
  }
}

function assertExpectedStageSkills(
  context: RuntimeContext,
  stageId: string,
  skills: LoadedSkill[],
): void {
  const expected = context.expectedSkillContentHashes?.[stageId];
  if (expected === undefined) return;
  const actual = Object.fromEntries(
    skills.map((skill) => [skill.id, `sha256:${skill.contentHash}`]),
  );
  const expectedIds = Object.keys(expected).sort();
  const actualIds = Object.keys(actual).sort();
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index]) ||
    expectedIds.some((id) => expected[id] !== actual[id])
  ) {
    throw new Error(`eval replay stage ${stageId} skill content digest mismatch`);
  }
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
    const definedFields = Object.fromEntries(
      Object.entries(artifact).filter(([, value]) => value !== undefined),
    ) as Partial<RunArtifact>;
    context.artifactEntries[existing] = {
      ...context.artifactEntries[existing],
      ...definedFields,
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
const GATE_RESULT_ARTIFACT_SCHEMA = {
  type: "object",
  required: ["id", "stageId", "mode", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    stageId: { type: "string" },
    mode: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
  },
} as const;

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
    boundaryRoot: context.repoPath,
    runId: context.runId,
    artifacts: context.artifactEntries,
    redactionSecrets: context.redactionSecrets,
  });
}

async function seedRuntimeArtifactEntries(
  context: RuntimeContext,
  readEventProjection: () => Promise<RunArtifact[]>,
): Promise<void> {
  const artifacts = await readReconciledArtifactRegistryWithPrivatePaths({
    runDirectory: context.runDirectory,
    boundaryRoot: context.repoPath,
    runId: context.runId,
    readEventProjection,
  });
  for (const artifact of artifacts) {
    upsertArtifactEntry(context, artifact);
  }
}

async function seedRuntimeManifestEntries(context: RuntimeContext): Promise<void> {
  const manifest = await readContextManifest({
    runDirectory: context.runDirectory,
  });
  for (const entry of manifest?.entries ?? []) {
    upsertManifestEntry(context, entry);
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

function assertEvalReplayConfigurationHasNoSecrets(
  configuration: FlowConfiguration,
): void {
  for (const [key, value] of Object.entries(configuration)) {
    if (
      /headers?/i.test(key) ||
      (isSensitiveKey(key) && !isSafeTokenCountField(key, value))
    ) {
      throw new Error(`secret-bearing configuration key: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(configuration)) {
    if (typeof value === "string" && containsSensitiveText(value)) {
      throw new Error(`secret-bearing configuration value: ${key}`);
    }
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function currentBranchHeadSha(
  worktreePath: string | undefined,
): Promise<string | undefined> {
  if (!worktreePath) return undefined;
  try {
    return (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
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

async function resolveFreshRemoteBaseline(input: {
  repoPath: string;
  runId: string;
  localBranch?: string;
}): Promise<{ baseBranch: string; baseCommit: string }> {
  const remote = await runGitResult(input.repoPath, ["remote", "get-url", "origin"]);
  if (remote.exitCode !== 0) {
    if (!input.localBranch) {
      throw new Error("unable to determine base branch for run: repository has no origin remote");
    }
    const localCommit = await gitCommit(input.repoPath, input.localBranch);
    if (!localCommit) {
      throw new Error(`unable to resolve local base branch: ${input.localBranch}`);
    }
    return { baseBranch: input.localBranch, baseCommit: localCommit };
  }

  const remoteHead = await runGitResult(input.repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (remoteHead.exitCode !== 0) {
    throw new Error("unable to resolve origin default branch; remote discovery failed");
  }
  const branch = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remoteHead.stdout)?.[1];
  if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new Error("unable to resolve origin default branch; remote HEAD is invalid");
  }

  const temporaryRef = `refs/nitely/fetch/${input.runId}`;
  try {
    const fetched = await runGitResult(input.repoPath, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:${temporaryRef}`,
    ]);
    if (fetched.exitCode !== 0) {
      throw new Error(`unable to fetch origin default branch: ${branch}`);
    }
    const baseCommit = await gitCommit(input.repoPath, temporaryRef);
    if (!baseCommit) {
      throw new Error(`unable to resolve fetched origin default branch: ${branch}`);
    }
    return { baseBranch: branch, baseCommit };
  } finally {
    await runGitResult(input.repoPath, ["update-ref", "-d", temporaryRef]);
  }
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
  includeProviderStore: boolean;
}): Promise<string[]> {
  const stores = input.includeProviderStore ? [input.providerStore] : [];
  if (
    input.dependencies.knowledgeProviderStore &&
    input.dependencies.knowledgeProviderStore !== input.providerStore
  ) {
    stores.push(input.dependencies.knowledgeProviderStore);
  }
  const providerEnvironments = await Promise.all(
    stores.map(async (store) => await store.resolveEnv()),
  );
  const secrets = collectContextRedactionSecrets({
    policy: input.policy,
    processEnv: process.env,
  });
  for (const providerEnv of providerEnvironments) {
    secrets.push(...collectContextRedactionSecrets({
      policy: input.policy,
      processEnv: {},
      providerEnv,
    }));
  }
  return [...new Set(secrets)];
}

async function resolveBackend(
  backendName: string | undefined,
  dependencies: RunFlowDependencies,
  providerStore: ProviderConnectionStore,
  sandboxPolicy?: RunSandboxPolicy,
  imageIdentity?: string,
): Promise<{
  backend: ExecutionBackend;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  envSource: string;
}> {
  if (dependencies.backend) {
    if (sandboxPolicy) {
      throw new Error(
        "a pinned sandbox policy cannot be verified with an injected execution backend",
      );
    }
    return {
      backend: dependencies.backend,
      env: process.env,
      envSource: "explicit-backend-host-env",
    };
  }
  const providerEnv = await providerStore.resolveEnv();
  const env = sandboxPolicy
    ? {
        ...providerEnv,
        NITELY_CODEX_SANDBOX: requireCodexSandboxMode(sandboxPolicy.codex),
      }
    : providerEnv;
  return {
    backend: createExecutionBackend({
      backend: backendName ?? env.NITELY_EXECUTION_BACKEND,
      env,
      ...(imageIdentity ? { imageIdentity } : {}),
    }),
    env,
    envSource: "resolved-backend-env",
  };
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

class ApprovalDeniedError extends Error {
  constructor(
    public readonly approval: ProjectedApproval,
  ) {
    super(`approval ${approval.id} denied on stage ${approval.stageId}`);
    this.name = "ApprovalDeniedError";
  }
}

function approvalIdForStageAttempt(stageId: string, attempt: number): string {
  return `${stageId}-${attempt}`;
}

function approvalForStageAttempt(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
}): ProjectedApproval | undefined {
  return projectRun(input.eventStore.list(input.runId)).approvals.find(
    (approval) =>
      approval.stageId === input.stageId && approval.attempt === input.attempt,
  );
}

function conformancePolicyForStage(
  stage: Extract<Stage, { type: "publish-change" | "update-change" }>,
): ConformancePolicy | undefined {
  if (!stage.conformance) {
    return undefined;
  }
  return {
    mode: stage.conformance.mode,
    reportId: stage.conformance.report ?? DEFAULT_CONFORMANCE_REPORT_ID,
    requiredIds: stage.conformance.required ?? [],
  };
}

function collectConformancePolicies(stages: Stage[]): ConformancePolicyEvidence[] {
  return stages.flatMap((stage) => {
    if (stage.type !== "publish-change" && stage.type !== "update-change") {
      return [];
    }
    const policy = conformancePolicyForStage(stage);
    return policy ? [{ stageId: stage.id, policy }] : [];
  });
}

function firstChangeRequestStageProvider(
  stages: Stage[],
): "github" | "github-cli" | undefined {
  const stage = stages.find(
    (candidate) =>
      candidate.type === "publish-change" || candidate.type === "update-change",
  );
  return stage?.provider ?? (stage ? "github" : undefined);
}

function isConformanceArtifact(artifact: RunArtifact): boolean {
  return (
    artifact.id === DEFAULT_CONFORMANCE_REPORT_ID ||
    artifact.type === "conformance.report" ||
    artifact.mediaType === CONFORMANCE_REPORT_MEDIA_TYPE
  );
}

async function readConformanceReportArtifact(input: {
  context: RuntimeContext;
  reportId: string;
}): Promise<{
  artifact?: RunArtifact;
  report?: ConformanceReport;
  errors: string[];
}> {
  const artifact = input.context.artifactEntries.find(
    (candidate) => candidate.id === input.reportId,
  );
  if (!artifact) {
    return { errors: [] };
  }
  if (!artifact.path) {
    return {
      artifact,
      errors: [`conformance report "${input.reportId}" has no artifact path`],
    };
  }
  let content: Buffer;
  try {
    const materialized = await readMaterializedArtifact({
      runDirectory: input.context.runDirectory,
      boundaryRoot: input.context.repoPath,
      artifact,
    });
    content = materialized.content;
  } catch {
    return {
      artifact,
      errors: [
        `conformance report "${input.reportId}" is not a Run-owned regular file`,
      ],
    };
  }
  const parsed = parseConformanceReportText(content.toString("utf8"));
  return { artifact, report: parsed.report, errors: parsed.errors };
}

async function assertConformancePolicySatisfied(input: {
  stage: Extract<Stage, { type: "publish-change" | "update-change" }>;
  context: RuntimeContext;
}): Promise<void> {
  const policy = conformancePolicyForStage(input.stage);
  if (!policy) {
    return;
  }
  const loaded = await readConformanceReportArtifact({
    context: input.context,
    reportId: policy.reportId,
  });
  const findings = evaluateConformanceReport(
    loaded.report,
    policy,
    loaded.errors,
  );
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  if (blocking.length > 0) {
    throw new Error(
      `conformance policy failed for stage "${input.stage.id}": ${blocking
        .map((finding) => finding.message)
        .join("; ")}`,
    );
  }
}

async function formatConformanceEvidence(input: {
  context: RuntimeContext;
  policies: ConformancePolicyEvidence[];
}): Promise<string> {
  const processedReportIds = new Set<string>();
  const sections: string[] = [];
  for (const entry of input.policies) {
    processedReportIds.add(entry.policy.reportId);
    const loaded = await readConformanceReportArtifact({
      context: input.context,
      reportId: entry.policy.reportId,
    });
    const findings = evaluateConformanceReport(
      loaded.report,
      entry.policy,
      loaded.errors,
    );
    sections.push(
      [
        `Stage: ${entry.stageId}`,
        formatConformanceReportEvidence({
          reportId: entry.policy.reportId,
          policy: entry.policy,
          report: loaded.report,
          findings,
          errors: loaded.errors,
        }),
      ].join("\n"),
    );
  }

  const extraReports = input.context.artifactEntries.filter(
    (artifact) =>
      isConformanceArtifact(artifact) && !processedReportIds.has(artifact.id),
  );
  for (const artifact of extraReports) {
    const loaded = await readConformanceReportArtifact({
      context: input.context,
      reportId: artifact.id,
    });
    const findings: ConformanceFinding[] =
      loaded.errors.length > 0
        ? [
            {
              severity: "warning",
              code: "invalid-report",
              message: loaded.errors.join("; "),
            },
          ]
        : [];
    sections.push(
      formatConformanceReportEvidence({
        reportId: artifact.id,
        report: loaded.report,
        findings,
        errors: loaded.errors,
      }),
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : "none";
}

const defaultStageHeartbeatMs = 30_000;

function stageHeartbeatMs(): number {
  const configured = Number(process.env.NITELY_STAGE_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : defaultStageHeartbeatMs;
}

async function withStageHeartbeat<T>(
  input: {
    eventStore: EventStore;
    runId: string;
    stageId: string;
    attempt: number;
    captureRecovery?: () => Promise<void>;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const intervalMs = stageHeartbeatMs();
  let count = 0;
  let recoveryCapture = Promise.resolve();
  let recoveryCaptureQueued = false;
  const queueRecoveryCapture = (): void => {
    if (!input.captureRecovery || recoveryCaptureQueued) return;
    recoveryCaptureQueued = true;
    recoveryCapture = recoveryCapture
      .then(async () => {
        recoveryCaptureQueued = false;
        await input.captureRecovery?.();
      })
      .catch(() => undefined);
  };
  const timer = intervalMs > 0
    ? setInterval(() => {
        count += 1;
        try {
          input.eventStore.append({
            runId: input.runId,
            stageId: input.stageId,
            attempt: input.attempt,
            type: "stage.heartbeat",
            payload: { count },
          });
        } catch {
          // Heartbeats are best-effort observability and should not fail the stage.
        }
        queueRecoveryCapture();
      }, intervalMs)
    : undefined;
  timer?.unref?.();
  try {
    return await operation();
  } finally {
    if (timer) clearInterval(timer);
    queueRecoveryCapture();
    await recoveryCapture;
  }
}

function stageAttemptBaseSha(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
}): string | undefined {
  const started = input.eventStore
    .list(input.runId)
    .filter(
      (event) =>
        event.type === "stage.started" &&
        event.stageId === input.stageId &&
        event.attempt === input.attempt,
    )
    .at(-1);
  if (!started || typeof started.payload !== "object" || started.payload === null) {
    return undefined;
  }
  const baseSha = (started.payload as Record<string, unknown>).branchHeadSha;
  return typeof baseSha === "string" && baseSha.length > 0 ? baseSha : undefined;
}

async function captureAttemptRecovery(input: {
  context: RuntimeContext;
  workspace: WorkspaceHandle;
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
}): Promise<void> {
  if (!input.workspace.path) return;
  const baseSha = stageAttemptBaseSha(input);
  if (!baseSha) return;
  await writeRecoverySnapshot({
    runDirectory: input.context.runDirectory,
    worktreePath: input.workspace.path,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    baseSha,
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
    questionId: redactRuntimeText(blocker.questionId, context),
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

/**
 * Isolated runtime homes live in local state next to the runs directory rather
 * than inside it: they hold links to operator credentials, which must never
 * travel with exported run evidence.
 */
function agentGlobalSkillsRequest(input: {
  mode: GlobalSkillsMode;
  repoPath: string;
  runId: string;
  runtime: string | undefined;
}): AgentGlobalSkillsRequest {
  if (input.mode === "inherited") return { mode: "inherited" };
  return {
    mode: input.mode,
    homeDirectory: join(
      input.repoPath,
      ".nitely",
      "runtime-homes",
      input.runId,
      input.runtime ?? "default",
    ),
  };
}

function requireWorkspacePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("workspace has no host-accessible path");
  }
  return ws.path;
}

function executionTimeoutMs(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "EXECUTION_TIMEOUT" ||
    !("timeoutMs" in error) ||
    typeof error.timeoutMs !== "number" ||
    !Number.isSafeInteger(error.timeoutMs) ||
    error.timeoutMs <= 0
  ) {
    return undefined;
  }
  return error.timeoutMs;
}

async function runAgentInWorkspace(input: {
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  stage: AgentRunnableStage;
  prompt: string;
  attemptDirectory: string;
  context: RuntimeContext;
  contextControls: ResolvedStageContextControls;
  readPolicy: ResolvedStageReadPolicy;
  visibleInputPaths: string[];
  resumeSessionId?: string;
  timeoutMs?: number;
}): Promise<{
  stdoutPath: string;
  stderrPath: string;
  usage?: AgentRuntimeUsage;
  globalSkills?: AgentGlobalSkillsOutcome;
  session?: AgentSessionOutcome;
}> {
  const attemptDirectory = await requireContainedAttemptDirectory({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
  });
  throwIfRunCancelled(input.dependencies.cancellation, {
    stageId: input.stage.id,
    attempt: Number(basename(attemptDirectory)),
  });
  const executionPrompt = input.backend.prepareAgentPrompt
    ? await input.backend.prepareAgentPrompt({
        workspace: input.workspace,
        attemptDirectory,
        prompt: input.prompt,
      })
    : input.prompt;
  await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory,
    filename: "prompt.md",
    content: executionPrompt,
  });
  const writeLogs = async (result: AgentResult | undefined) =>
    await writeAgentAttemptLogFiles({
      attemptDirectory,
      result,
      context: input.context,
    });
  const usesLegacyExecuteAgent =
    !input.dependencies.backend && Boolean(input.dependencies.executeAgent);
  // Enforcement now lives in the execution backends: the local backend refuses
  // a required bound and OCI applies it to a filtered read-only workspace. The
  // deprecated injected executor applies nothing, so it still stops here rather
  // than running unbounded while the flow claims a bound.
  if (usesLegacyExecuteAgent && input.readPolicy.enforcement === "required") {
    throw new Error(
      `stage ${input.stage.id} declares reads.enforcement "required", but the injected agent executor enforces no byte-level read bound; run the stage on the OCI execution backend`,
    );
  }
  const backendOwnsTimeout =
    !usesLegacyExecuteAgent && input.backend.agentTimeoutControl === "backend";
  let backendTimeoutLogged = false;
  // Deprecated shim: a directly-injected executeAgent wins only when no
  // explicit backend was supplied, preserving existing test behavior.
  try {
    return await withOperationTimeout({
      stageId: input.stage.id,
      timeoutKind: "sessionMs",
      timeoutMs: backendOwnsTimeout ? undefined : input.timeoutMs,
      operation: async () => {
        const backendAttemptDirectory = await requireContainedAttemptDirectory({
          runDirectory: input.context.runDirectory,
          attemptDirectory,
        });
        if (!input.dependencies.backend && input.dependencies.executeAgent) {
          try {
            await input.dependencies.executeAgent({
              stage: input.stage,
              prompt: executionPrompt,
              worktreePath: requireWorkspacePath(input.workspace),
              attemptDirectory: backendAttemptDirectory,
              signal: input.dependencies.cancellation?.signal,
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
            prompt: executionPrompt,
            attemptDirectory: backendAttemptDirectory,
            timeoutMs: input.timeoutMs,
            signal: input.dependencies.cancellation?.signal,
            globalSkills: agentGlobalSkillsRequest({
              mode: input.contextControls.globalSkills,
              repoPath: input.context.repoPath,
              runId: input.context.runId,
              runtime: input.stage.runtime,
            }),
            visibleInputPaths: input.visibleInputPaths,
            readPolicy: input.readPolicy,
            ...(input.resumeSessionId
              ? { session: { resumeSessionId: input.resumeSessionId } }
              : {}),
          });
          return {
            ...(await writeLogs(result)),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.globalSkills ? { globalSkills: result.globalSkills } : {}),
            ...(result.session ? { session: result.session } : {}),
          };
        } catch (error) {
          const backendTimeoutMs = backendOwnsTimeout
            ? executionTimeoutMs(error)
            : undefined;
          if (backendTimeoutMs !== undefined) {
            const timeoutError = new StageTimeoutError(
              input.stage.id,
              "sessionMs",
              backendTimeoutMs,
            );
            const result = error as AgentResult;
            await writeLogs({
              ...(typeof result.stdout === "string"
                ? { stdout: result.stdout }
                : {}),
              stderr: `${
                typeof result.stderr === "string" ? result.stderr : ""
              }${timeoutError.message}\n`,
            });
            backendTimeoutLogged = true;
            throw timeoutError;
          }
          await writeLogs(error as AgentResult);
          if (isExecutionCancellationError(error)) {
            throw new RunCancelledError({
              request: cancellationRequestFromSignal(input.dependencies.cancellation),
              stageId: input.stage.id,
              attempt: Number(basename(attemptDirectory)),
              cleanup: error.termination,
              message: error.message,
            });
          }
          throw error;
        }
      },
    });
  } catch (error) {
    if (isStageTimeoutError(error) && !backendTimeoutLogged) {
      await writeLogs({ stderr: `${error.message}\n` });
    }
    throw error;
  }
}

async function runCommandInWorkspace(input: {
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  command: string;
  timeoutMs?: number;
  cancellation?: RunCancellationControl;
  maxToolOutputTokens?: number;
  attemptDirectory: string;
  runId?: string;
  stageId?: string;
  attempt?: number;
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
  const attemptDirectory = await requireContainedAttemptDirectory({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
  });
  throwIfRunCancelled(
    input.cancellation,
    input.stageId && input.attempt !== undefined
      ? { stageId: input.stageId, attempt: input.attempt }
      : undefined,
  );
  const result = await input.backend.runCommand(input.workspace, input.command, {
    timeoutMs: input.timeoutMs,
    signal: input.cancellation?.signal,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    outputDirectory: attemptDirectory,
    attemptDirectory,
  });
  const durationMs = Date.now() - startedAt;
  const paths = await writeCommandAttemptFiles({
    attemptDirectory,
    command: input.command,
    result,
    context: input.context,
    maxToolOutputTokens: input.maxToolOutputTokens,
  });
  return { result, durationMs, ...paths };
}

function hookFailureStatus(
  hook: HookDefinition,
  exitCode: number,
): HookAttemptEvidence["status"] {
  if (exitCode === 0) return "passed";
  if (hook.onFailure === "warn") return "warned";
  if (hook.onFailure === "evidence-only") return "recorded";
  return "blocked";
}

function hookScopeLabel(input: {
  scope: HookAttemptEvidence["scope"];
  phase: HookAttemptEvidence["phase"];
  stageId?: string;
}): string {
  return input.scope === "stage"
    ? `stage ${input.stageId ?? "unknown"} ${input.phase}`
    : `flow ${input.phase}`;
}

function selectedAttemptDirectory(input: {
  runDirectory: string;
  stageId: string;
  currentAttempt: number;
  currentAttemptDirectory: string;
  selectedAttempt: number;
}): string {
  return input.selectedAttempt === input.currentAttempt
    ? input.currentAttemptDirectory
    : join(input.runDirectory, "stages", input.stageId, String(input.selectedAttempt));
}

async function executeHooks(input: {
  hooks: HookDefinition[];
  scope: HookAttemptEvidence["scope"];
  phase: HookAttemptEvidence["phase"];
  stageId?: string;
  attempt?: number;
  hookRootDirectory: string;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  flowMaxToolOutputTokens?: number;
  context: RuntimeContext;
  eventStore: EventStore;
  runId: string;
  cancellation?: RunCancellationControl;
}): Promise<void> {
  if (input.hooks.length === 0) return;

  for (const hook of input.hooks) {
    const hookDirectory = join(input.hookRootDirectory, hook.id);
    requirePathInside(input.context.runDirectory, hookDirectory, "hook directory");
    await mkdir(hookDirectory, { recursive: true });
    const { result, durationMs, stdoutPath, stderrPath, outputPath, outputSummary } =
      await runCommandInWorkspace({
        backend: input.backend,
        workspace: input.workspace,
        command: hook.command,
        timeoutMs: hook.timeoutMs,
        maxToolOutputTokens:
          hook.maxToolOutputTokens ?? input.flowMaxToolOutputTokens,
        attemptDirectory: hookDirectory,
        runId: input.runId,
        ...(input.stageId ? { stageId: input.stageId } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        context: input.context,
        cancellation: input.cancellation,
      });
    const status = hookFailureStatus(hook, result.exitCode);
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "hook.completed",
      payload: redactRuntimeUnknown(
        {
          hookId: hook.id,
          scope: input.scope,
          phase: input.phase,
          command: hook.command,
          onFailure: hook.onFailure,
          status,
          exitCode: result.exitCode,
          durationMs,
          stdout: outputSummary.stdout,
          stderr: outputSummary.stderr,
          stdoutPath,
          stderrPath,
          outputPath,
          environmentRepairs: result.environmentRepairs ?? [],
          ...(result.cancelled ? { cancellation: result.termination ?? true } : {}),
        },
        input.context,
      ),
    });
    if (result.cancelled) {
      throw new RunCancelledError({
        request: cancellationRequestFromSignal(input.cancellation),
        stageId: input.stageId,
        attempt: input.attempt,
        cleanup: result.termination,
      });
    }

    if (status === "blocked") {
      throw new Error(
        `${hookScopeLabel(input)} hook ${hook.id} blocked execution: ${commandFailureMessage(
          hook.command,
          result,
        )}`,
      );
    }
  }
}

async function executeFlowHooks(input: {
  hooks: HookDefinition[];
  phase: "preRun" | "postRun";
  runDirectory: string;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  flowMaxToolOutputTokens?: number;
  context: RuntimeContext;
  eventStore: EventStore;
  runId: string;
  cancellation?: RunCancellationControl;
}): Promise<void> {
  try {
    await executeHooks({
      hooks: input.hooks,
      scope: "flow",
      phase: input.phase,
      hookRootDirectory: join(input.runDirectory, "hooks", "flow", input.phase),
      backend: input.backend,
      workspace: input.workspace,
      flowMaxToolOutputTokens: input.flowMaxToolOutputTokens,
      context: input.context,
      eventStore: input.eventStore,
      runId: input.runId,
      cancellation: input.cancellation,
    });
  } catch (error) {
    if (error instanceof RunCancelledError) {
      throw error;
    }
    input.eventStore.append({
      runId: input.runId,
      type: "run.failed",
      payload: redactRuntimeUnknown(
        {
          hookPhase: input.phase,
          error: error instanceof Error ? error.message : String(error),
        },
        input.context,
      ),
    });
    throw error;
  }
}

async function executeStageHooks(input: {
  stage: Stage;
  phase: "pre" | "post";
  attempt: number;
  attemptDirectory: string;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  flowMaxToolOutputTokens?: number;
  context: RuntimeContext;
  eventStore: EventStore;
  runId: string;
  cancellation?: RunCancellationControl;
}): Promise<void> {
  await executeHooks({
    hooks: input.phase === "pre"
      ? input.stage.hooks?.pre ?? []
      : input.stage.hooks?.post ?? [],
    scope: "stage",
    phase: input.phase,
    stageId: input.stage.id,
    attempt: input.attempt,
    hookRootDirectory: join(input.attemptDirectory, "hooks", input.phase),
    backend: input.backend,
    workspace: input.workspace,
    flowMaxToolOutputTokens: input.flowMaxToolOutputTokens,
    context: input.context,
    eventStore: input.eventStore,
    runId: input.runId,
    cancellation: input.cancellation,
  });
}

async function writeAgentAttemptLogFiles(input: {
  attemptDirectory: string;
  result?: AgentResult;
  context: RuntimeContext;
}): Promise<{ stdoutPath: string; stderrPath: string }> {
  const stdout =
    input.result?.stdout ??
    "stdout was not captured by this agent execution backend.\n";
  const stderr =
    input.result?.stderr ??
    "stderr was not captured by this agent execution backend.\n";
  const stdoutPath = await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    filename: "stdout.log",
    content: redactRuntimeText(stdout, input.context) ?? "",
  });
  const stderrPath = await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    filename: "stderr.log",
    content: redactRuntimeText(stderr, input.context) ?? "",
  });
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
  flowTimeouts?: TimeoutControls;
  flowBudgets?: EffectiveBudgetControls;
  inputArtifacts: Map<string, InputArtifact>;
  configuration: FlowConfiguration;
  attemptDirectory: string;
  context: RuntimeContext;
  eventStore: EventStore;
  providerStore: ProviderConnectionStore;
  loadedSkillUsages: StageSkillUsage[];
  contextControls: ResolvedStageContextControls;
  readPolicy: ResolvedStageReadPolicy;
  contextKnowledge?: ContextKnowledgeEntry[];
  previousFailures?: PreviousFailure[];
  taskPlanPrompt?: TaskPlanPromptContext;
  /** Runtime session ids by stage id, carried across loop iterations. */
  agentSessions?: Map<string, string>;
}): Promise<{ result: GateResult; budgetFailure?: BudgetExceededError }> {
  if (input.stage.mode === "analysis") {
    assertHardBudgetAdmission({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
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
    const budgetFailure = captureHardBudgetConsumption({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    return { result: gateResult, budgetFailure };
  }

  if (input.stage.mode === "security") {
    assertHardBudgetAdmission({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    const scopedInputs = stageScopedInputs(input.inputArtifacts, input.stage);
    const findingText = [...scopedInputs.values()]
      .map((artifact) => artifact.resource.content.toString("utf8"))
      .join("\n\n");
    const assessment = classifySecurityFinding(findingText);
    const reportFilename = `${gateResultId(input.stage)}.md`;
    const reportPath = join(input.attemptDirectory, reportFilename);
    requirePathInside(input.context.runDirectory, reportPath, "security gate report");
    const reportContent =
      redactRuntimeText(renderSecurityAssessmentMarkdown(assessment), input.context) ?? "";
    await writeFile(reportPath, reportContent, "utf8");
    const blocking = input.stage.blocking ?? true;
    const failed = blocking && !assessment.supported;
    const gateResult: GateResult = {
      id: gateResultId(input.stage),
      stageId: input.stage.id,
      name: input.stage.name,
      mode: "security",
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
      reason: failed ? assessment.reason : undefined,
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
        { gate: gateResult, security: assessment },
        input.context,
      ),
    });
    const budgetFailure = captureHardBudgetConsumption({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    return { result: gateResult, budgetFailure };
  }

  if (input.stage.mode === "review-aggregate") {
    assertHardBudgetAdmission({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    const scopedInputs = stageScopedInputs(input.inputArtifacts, input.stage);
    const outputs = new Map<string, string>();
    for (const [id, artifact] of scopedInputs) {
      outputs.set(
        id,
        reviewPerspectiveText({
          content: artifact.resource.content.toString("utf8"),
          mediaType: artifact.resource.mediaType,
        }),
      );
    }
    const decision = aggregateReviewPerspectives({
      declared: input.stage.perspectives,
      outputs,
    });
    const reportFilename = `${gateResultId(input.stage)}.md`;
    const reportPath = join(input.attemptDirectory, reportFilename);
    requirePathInside(
      input.context.runDirectory,
      reportPath,
      "review aggregate report",
    );
    const reportContent =
      redactRuntimeText(renderAggregatedReviewMarkdown(decision), input.context) ??
      "";
    await writeFile(reportPath, reportContent, "utf8");
    const blocking = input.stage.blocking ?? true;
    const blocked = decision.status === "blocked";
    const failed = blocking && blocked;
    const reason = decision.reason
      ? redactRuntimeText(decision.reason, input.context) ?? ""
      : undefined;
    const gateResult: GateResult = {
      id: gateResultId(input.stage),
      stageId: input.stage.id,
      name: input.stage.name,
      mode: "review-aggregate",
      status: failed ? "failed" : "passed",
      reviewedArtifacts: [...input.stage.inputs],
      reviewOutput: {
        id: gateResultId(input.stage),
        path: reportPath,
        filename: reportFilename,
        mediaType: "text/markdown",
        content: reportContent,
        truncated: false,
        ...(decision.routing ? { verdict: decision.routing } : {}),
      },
      ...(failed && reason ? { reason } : {}),
      ...(!blocking && blocked && reason ? { advisoryReason: reason } : {}),
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
        {
          gate: gateResult,
          reviewAggregate: {
            status: decision.status,
            blockingPerspectives: decision.blockingPerspectives,
            perspectives: decision.perspectives.map((perspective) => ({
              id: perspective.id,
              status: perspective.status,
              ...(perspective.verdict ? { verdict: perspective.verdict } : {}),
            })),
            findings: decision.findings.length,
          },
        },
        input.context,
      ),
    });
    const budgetFailure = captureHardBudgetConsumption({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    return { result: gateResult, budgetFailure };
  }

  if (input.stage.mode === "deterministic") {
    const stage = input.stage;
    assertHardBudgetAdmission({
      eventStore: input.eventStore,
      runId: input.runId,
      stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    const timeoutMs = resolveGateTimeoutMs(input.flowTimeouts, stage);
    const { result, stdoutPath, stderrPath, outputPath, outputSummary } =
      await withStageHeartbeat(
        {
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: stage.id,
          attempt: input.attempt,
          captureRecovery: async () => await captureAttemptRecovery({
            context: input.context,
            workspace: input.workspace,
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: stage.id,
            attempt: input.attempt,
          }),
        },
        async () => await runCommandInWorkspace({
          backend: input.backend,
          workspace: input.workspace,
          command: stage.command,
          timeoutMs,
          maxToolOutputTokens: resolveMaxToolOutputTokens(
            stage,
            input.flowMaxToolOutputTokens,
          ),
          attemptDirectory: input.attemptDirectory,
          context: input.context,
          cancellation: input.dependencies.cancellation,
        }),
      );
    appendToolOutputBudgetEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      summary: outputSummary,
      context: input.context,
    });
    const timedOut = commandTimedOut(result, timeoutMs);
    if (timedOut && timeoutMs !== undefined) {
      appendStageTimeoutEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: input.attempt,
        kind: "gateMs",
        timeoutMs,
        context: input.context,
      });
    }
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "command.completed",
      payload: redactRuntimeUnknown({
        command: input.stage.command,
        exitCode: result.exitCode,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(timedOut ? { timeoutReason: `gate timed out after ${timeoutMs}ms` } : {}),
        stdout: outputSummary.stdout,
        stderr: outputSummary.stderr,
        stdoutPath,
        stderrPath,
        outputPath,
        environmentRepairs: result.environmentRepairs ?? [],
        ...(result.cancelled ? { cancellation: result.termination ?? true } : {}),
      }, input.context),
    });
    if (result.cancelled) {
      throw new RunCancelledError({
        request: cancellationRequestFromSignal(input.dependencies.cancellation),
        stageId: input.stage.id,
        attempt: input.attempt,
        cleanup: result.termination,
      });
    }
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
    const budgetFailure = timedOut
      ? undefined
      : captureHardBudgetConsumption({
          eventStore: input.eventStore,
          runId: input.runId,
          stage,
          attempt: input.attempt,
          runBudgets: input.flowBudgets,
          context: input.context,
        });
    return { result: gateResult, budgetFailure };
  }

  let reason: string | undefined;
  /**
   * Set when the review never produced a usable verdict (runtime failure,
   * missing or malformed output). A non-blocking perspective downgrades its
   * own verdict, never an execution failure: a perspective that could not run
   * must not read as one that had nothing to say.
   */
  let executionFailure = false;
  let reviewOutput: GateReviewOutput | undefined;
  let budgetFailure: BudgetExceededError | undefined;
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
      assertRuntimeCandidateAllowedByCapabilities({
        stage: input.stage,
        candidate,
      });
      const selected = await beginRuntimeCandidateAttempt({
        eventStore: input.eventStore,
        runId: input.runId,
        runDirectory: input.context.runDirectory,
        stage: input.stage,
        baseAttempt: input.attempt,
        attemptDirectory: input.attemptDirectory,
        candidate,
        index,
        count: candidates.length,
        ...(index > 0
          ? { branchHeadSha: await currentBranchHeadSha(input.workspace.path) }
          : {}),
      });
      selectedStage = selected.stage;
      selectedAttempt = selected.attempt;
      selectedAttemptDirectory = selected.attemptDirectory;
      assertHardBudgetAdmission({
        eventStore: input.eventStore,
        runId: input.runId,
        stage: input.stage,
        attempt: selectedAttempt,
        runBudgets: input.flowBudgets,
        context: input.context,
      });
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
      assertExpectedStageSkills(input.context, input.stage.id, skills);
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
      const scopedInputs = applyTaskPlanPromptContext(
        stageScopedInputs(input.inputArtifacts, selectedStage),
        input.taskPlanPrompt,
      );
      const externalKnowledge = await retrieveExternalKnowledgeForStage({
        stage: selectedStage,
        flowName: input.flowName,
        configuration: input.configuration,
        inputs: scopedInputs,
        controls: input.contextControls.externalKnowledge,
        context: input.context,
        dependencies: input.dependencies,
      });
      const budget = resolveMaxInputTokens(
        selectedStage,
        input.flowMaxInputTokens,
      );
      const resumeSessionId = sessionReuseEnabled(selectedStage, input.contextControls)
        ? input.agentSessions?.get(input.stage.id)
        : undefined;
      const resumePrompt = resumeSessionId
        ? renderResumePrompt({
          stage: selectedStage,
          attemptDirectory: selectedAttemptDirectory,
          context: input.context,
          ...(input.taskPlanPrompt ? { taskPlanPrompt: input.taskPlanPrompt } : {}),
          previousFailures: input.previousFailures ?? [],
          includePreviousFailures: input.contextControls.previousFailures,
        })
        : undefined;
      const { prompt, contextUsage, outcome } = fitPromptToBudget({
        inputs: scopedInputs,
        context: input.context,
        budget,
        externalKnowledgeCount: externalKnowledge?.matches.length,
        render: (forced, retainedExternalKnowledgeCount) =>
          resumePrompt !== undefined
            ? {
              prompt: resumePrompt,
              contextUsage: {
                promptBytes: Buffer.byteLength(resumePrompt, "utf8"),
                approxTokens: Math.ceil(Buffer.byteLength(resumePrompt, "utf8") / 4),
                inputBytesInlined: 0,
                inputBytesSaved: 0,
                inputCount: 0,
              },
            }
            : renderPrompt(
            selectedStage,
            input.flowName,
            scopedInputs,
            selectedAttemptDirectory,
            input.context,
            skills,
            input.configuration,
            input.contextControls,
            input.contextKnowledge ?? [],
            externalKnowledge?.matches.slice(0, retainedExternalKnowledgeCount) ?? [],
            input.previousFailures ?? [],
            forced,
            undefined,
            input.readPolicy,
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
      if (externalKnowledge) {
        const trimmedForBudget = outcome.status === "exceeded"
          ? externalKnowledge.matches.length
          : outcome.trimmedExternalKnowledgeCount ?? 0;
        appendKnowledgeRetrievalEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          retrieval: externalKnowledge,
          retainedCount: Math.max(0, externalKnowledge.matches.length - trimmedForBudget),
          context: input.context,
        });
      }
      if (outcome.status === "exceeded") {
        throw new BudgetExceededError(
          `stage "${input.stage.id}" minimal context ${outcome.approxTokens} tokens exceeds budget ${outcome.budget}`,
          input.stage.id,
          selectedAttempt,
        );
      }
      const sessionTimeoutMs = resolveAgentSessionTimeoutMs(
        input.flowTimeouts,
        selectedStage,
      );
      try {
        const result = await withStageHeartbeat(
          {
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            captureRecovery: async () => await captureAttemptRecovery({
              context: input.context,
              workspace: input.workspace,
              eventStore: input.eventStore,
              runId: input.runId,
              stageId: input.stage.id,
              attempt: selectedAttempt,
            }),
          },
          async () => await runAgentInWorkspace({
            backend: input.backend,
            dependencies: input.dependencies,
            workspace: input.workspace,
            stage: selectedStage,
            prompt,
            attemptDirectory: selectedAttemptDirectory,
            context: input.context,
            contextControls: input.contextControls,
            readPolicy: input.readPolicy,
            visibleInputPaths: [...scopedInputs.values()].map(
              (artifact) => artifact.contentPath,
            ),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            timeoutMs: sessionTimeoutMs,
          }),
        );
        appendGlobalSkillsEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          ...(result.globalSkills ? { outcome: result.globalSkills } : {}),
          context: input.context,
        });
        recordAgentSession({
          sessions: input.agentSessions,
          stageId: input.stage.id,
          eventStore: input.eventStore,
          runId: input.runId,
          attempt: selectedAttempt,
          ...(result.session ? { outcome: result.session } : {}),
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
        budgetFailure = captureHardBudgetConsumption({
          eventStore: input.eventStore,
          runId: input.runId,
          stage: input.stage,
          attempt: selectedAttempt,
          runBudgets: input.flowBudgets,
          context: input.context,
        });
      } catch (error) {
        if (error instanceof RunCancelledError) {
          throw error;
        }
        appendRuntimeUsageEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          usage: runtimeUsageFromThrown(error),
          context: input.context,
        });
        if (isStageTimeoutError(error)) {
          appendStageTimeoutEvent({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            kind: error.timeoutKind,
            timeoutMs: error.timeoutMs,
            context: input.context,
            message: error.message,
          });
        }
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
      // No readable output at all is a failure of the stage, not a verdict.
      executionFailure = outputResult.output === undefined;
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
    executionFailure = true;
  }

  const blocking = input.stage.blocking ?? true;
  const advisoryVerdict = Boolean(reason) && !blocking && !executionFailure;
  const gateResult: GateResult = {
    id: gateResultId(input.stage),
    stageId: input.stage.id,
    name: input.stage.name,
    mode: "review",
    status: reason && !advisoryVerdict ? "failed" : "passed",
    runtime: selectedStage.runtime,
    reviewedArtifacts: [...input.stage.inputs],
    reviewOutput,
    ...(advisoryVerdict ? { advisoryReason: reason } : { reason }),
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
  return { result: gateResult, budgetFailure };
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
  if (
    !input.gateResults.some(
      (gate) =>
        gate.id === input.gateResult.id &&
        gate.stageId === input.gateResult.stageId &&
        gate.attempt === input.gateResult.attempt &&
        gate.createdAt === input.gateResult.createdAt,
    )
  ) {
    input.gateResults.push(input.gateResult);
  }
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
  flowTimeouts?: TimeoutControls;
  context: RuntimeContext;
  eventStore: EventStore;
  completedStages: string[];
}): Promise<{ status: "awaiting-approval"; approvalId: string } | { status: "completed" }> {
  const existing = approvalForStageAttempt({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
  });
  if (existing?.status === "denied") {
    throw new ApprovalDeniedError(existing);
  }
  if (existing?.status !== "approved") {
    const approvalId =
      existing?.id ?? approvalIdForStageAttempt(input.stage.id, input.attempt);
    if (!existing) {
      input.eventStore.append({
        runId: input.runId,
        stageId: input.stage.id,
        attempt: input.attempt,
        type: "approval.requested",
        payload: redactRuntimeUnknown(
          {
            approvalId,
            prompt: input.stage.prompt,
            reviewedArtifactIds: input.stage.inputs,
            pauseTimeoutMs: resolveStageTimeouts(
              input.flowTimeouts,
              input.stage,
            ).pauseMs,
          },
          input.context,
        ),
      });
    }
    return { status: "awaiting-approval", approvalId };
  }

  recordApprovalGate(input.context, input.stage.id, {
    actor: existing.actor,
  });
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
  return { status: "completed" };
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
  await assertProtectedStageGate({
    repoPath: input.repoPath,
    workItemType: input.runWorkItemType,
    stage: input.stage,
    context: input.context,
  });
  await assertConformancePolicySatisfied({
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
  await removeGeneratedAgentMemoryFilesFromGit(input.worktreePath);
  await input.backend.commitAll(input.workspace, resolvedTitle.commitMessage);
  // Classified after the commit so the diff it reads is the one being
  // published, and before the evidence snapshot so the change request body
  // carries the verdict that gated it.
  await classifyAndEnforceChangeRisk({
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    ...(input.runWorkItemType ? { workItemType: input.runWorkItemType } : {}),
    context: input.context,
    eventStore: input.eventStore,
  });
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
  const headCommit = await currentBranchHeadSha(input.worktreePath);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "change.published",
    payload: redactRuntimeUnknown({
      url: published.url,
      evidencePath: published.evidencePath,
      changeRequest: published.changeRequest,
      branchName: input.branchName,
      headCommit,
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
  await assertProtectedStageGate({
    repoPath: input.repoPath,
    workItemType: input.runWorkItemType,
    stage: input.stage,
    context: input.context,
  });
  await assertConformancePolicySatisfied({
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
  await removeGeneratedAgentMemoryFilesFromGit(input.worktreePath);
  // Rework changes the diff, so the previous classification is recomputed
  // rather than inherited before this update is pushed to the change request.
  await classifyAndEnforceChangeRisk({
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: input.reworkTarget.resolved.baseBranch,
    ...(input.runWorkItemType ? { workItemType: input.runWorkItemType } : {}),
    context: input.context,
    eventStore: input.eventStore,
  });
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
      metadataUpdate: updated.metadataUpdate,
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
    metadataUpdate: updated.metadataUpdate,
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

interface AgentStageConvergenceEvidence {
  reportOutput: string;
  tasksOutput: string;
  unchanged: boolean;
  gapCount: number;
  appendedTaskIds: string[];
  skippedExistingCount: number;
  classifications: Record<ConvergenceClassification, number>;
}

async function applyAgentStageConvergence(input: {
  stage: Extract<Stage, { type: "agent" }>;
  inputs: Map<string, InputArtifact>;
  outputs: ValidatedAttemptOutput[];
  runDirectory: string;
}): Promise<AgentStageConvergenceEvidence | undefined> {
  const config = input.stage.convergence;
  if (!config) return undefined;
  const source = input.inputs.get(config.tasksInput);
  if (!source || source.omittedByPolicy) {
    throw new Error(
      `stage ${input.stage.id} convergence task input "${config.tasksInput}" is unavailable`,
    );
  }
  const reportOutput = input.outputs.find(
    (output) => output.id === config.reportOutput,
  );
  const tasksOutput = input.outputs.find(
    (output) => output.id === config.tasksOutput,
  );
  if (!reportOutput || !tasksOutput) {
    throw new Error(
      `stage ${input.stage.id} convergence outputs are incomplete`,
    );
  }
  if (reportOutput.absolutePath === tasksOutput.absolutePath) {
    throw new Error(
      `stage ${input.stage.id} convergence report and task outputs must resolve to different files`,
    );
  }
  if (reportOutput.mediaType !== CONVERGENCE_REPORT_MEDIA_TYPE) {
    throw new Error(
      `stage ${input.stage.id} convergence report output must use media type ${CONVERGENCE_REPORT_MEDIA_TYPE}`,
    );
  }
  if (tasksOutput.mediaType !== "text/markdown") {
    throw new Error(
      `stage ${input.stage.id} convergence task output must use media type text/markdown`,
    );
  }
  const parsed = parseConvergenceReportText(
    reportOutput.content.toString("utf8"),
  );
  if (!parsed.report) {
    throw new Error(
      `stage ${input.stage.id} convergence report is invalid: ${parsed.errors.join("; ")}`,
    );
  }
  const result = appendConvergenceTasks(source.resource.content, parsed.report);
  if (!tasksOutput.runRelativePath) {
    throw new Error(
      `stage ${input.stage.id} convergence task output is outside its Run`,
    );
  }
  await writeRunOwnedFileAtomically({
    runDirectory: input.runDirectory,
    path: tasksOutput.runRelativePath,
    subject: `output ${tasksOutput.id} path`,
    content: result.content,
  });
  tasksOutput.content = result.content;
  const classifications: Record<ConvergenceClassification, number> = {
    missing: 0,
    partial: 0,
    contradicts: 0,
    unrequested: 0,
  };
  for (const gap of parsed.report.gaps) {
    classifications[gap.classification] += 1;
  }
  return {
    reportOutput: config.reportOutput,
    tasksOutput: config.tasksOutput,
    unchanged: result.unchanged,
    gapCount: parsed.report.gaps.length,
    appendedTaskIds: result.appended.map((task) => task.taskId),
    skippedExistingCount: result.skippedFingerprints.length,
    classifications,
  };
}

async function executeAgentStage(input: {
  runId: string;
  stage: AgentRunnableStage;
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
  flowTimeouts?: TimeoutControls;
  flowBudgets?: EffectiveBudgetControls;
  inputArtifacts: Map<string, InputArtifact>;
  configuration: FlowConfiguration;
  context: RuntimeContext;
  eventStore: EventStore;
  providerStore: ProviderConnectionStore;
  loadedSkillUsages: StageSkillUsage[];
  contextControls: ResolvedStageContextControls;
  readPolicy: ResolvedStageReadPolicy;
  contextKnowledge?: ContextKnowledgeEntry[];
  previousFailures?: PreviousFailure[];
  operatorQuestion?: ProjectedOperatorQuestion;
  taskPlanPrompt?: TaskPlanPromptContext;
  /** Runtime session ids by stage id, carried across loop iterations. */
  agentSessions?: Map<string, string>;
  onAttemptSelected?: (attempt: number) => void;
  resumedFrom?: string;
  completedStages: string[];
  completeStage?: boolean;
  blockRunOnAgentBlocker?: boolean;
}): Promise<{ selectedAttempt: number; selectedStage: AgentRunnableStage }> {
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
    assertRuntimeCandidateAllowedByCapabilities({
      stage: input.stage,
      candidate,
    });
    const selected = await beginRuntimeCandidateAttempt({
      eventStore: input.eventStore,
      runId: input.runId,
      runDirectory: input.runDirectory,
      stage: input.stage,
      baseAttempt: input.attempt,
      attemptDirectory: input.attemptDirectory,
      candidate,
      index,
      count: candidates.length,
      resumedFrom: input.resumedFrom,
      ...(index > 0
        ? { branchHeadSha: await currentBranchHeadSha(input.workspace.path) }
        : {}),
      onAttemptSelected: input.onAttemptSelected,
    });
    selectedStage = selected.stage;
    selectedAttempt = selected.attempt;
    selectedAttemptDirectory = selected.attemptDirectory;
    assertHardBudgetAdmission({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: selectedAttempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
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
    assertExpectedStageSkills(input.context, input.stage.id, skills);
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
    const scopedInputs = applyTaskPlanPromptContext(
      stageScopedInputs(input.inputArtifacts, selectedStage),
      input.taskPlanPrompt,
    );
    const externalKnowledge = await retrieveExternalKnowledgeForStage({
      stage: selectedStage,
      flowName: input.flowName,
      configuration: input.configuration,
      inputs: scopedInputs,
      controls: input.contextControls.externalKnowledge,
      context: input.context,
      dependencies: input.dependencies,
    });
    const budget = resolveMaxInputTokens(selectedStage, input.flowMaxInputTokens);
    const resumeSessionId = sessionReuseEnabled(selectedStage, input.contextControls)
      ? input.agentSessions?.get(input.stage.id)
      : undefined;
    const resumePrompt = resumeSessionId
      ? renderResumePrompt({
        stage: selectedStage,
        attemptDirectory: selectedAttemptDirectory,
        context: input.context,
        ...(input.taskPlanPrompt ? { taskPlanPrompt: input.taskPlanPrompt } : {}),
        previousFailures: input.previousFailures ?? [],
        includePreviousFailures: input.contextControls.previousFailures,
      })
      : undefined;
    const { prompt, contextUsage, outcome } = fitPromptToBudget({
      inputs: scopedInputs,
      context: input.context,
      budget,
      externalKnowledgeCount: externalKnowledge?.matches.length,
      render: (forced, retainedExternalKnowledgeCount) =>
        resumePrompt !== undefined
          ? {
            prompt: resumePrompt,
            contextUsage: {
              promptBytes: Buffer.byteLength(resumePrompt, "utf8"),
              approxTokens: Math.ceil(Buffer.byteLength(resumePrompt, "utf8") / 4),
              inputBytesInlined: 0,
              inputBytesSaved: 0,
              inputCount: 0,
            },
          }
          : renderPrompt(
          selectedStage,
          input.flowName,
          scopedInputs,
          selectedAttemptDirectory,
          input.context,
          skills,
          input.configuration,
          input.contextControls,
          input.contextKnowledge ?? [],
          externalKnowledge?.matches.slice(0, retainedExternalKnowledgeCount) ?? [],
          input.previousFailures ?? [],
          forced,
          input.operatorQuestion,
          input.readPolicy,
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
    if (externalKnowledge) {
      const trimmedForBudget = outcome.status === "exceeded"
        ? externalKnowledge.matches.length
        : outcome.trimmedExternalKnowledgeCount ?? 0;
      appendKnowledgeRetrievalEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        retrieval: externalKnowledge,
        retainedCount: Math.max(0, externalKnowledge.matches.length - trimmedForBudget),
        context: input.context,
      });
    }
    if (outcome.status === "exceeded") {
      throw new BudgetExceededError(
        `stage "${input.stage.id}" minimal context ${outcome.approxTokens} tokens exceeds budget ${outcome.budget}`,
        input.stage.id,
        selectedAttempt,
      );
    }
    const sessionTimeoutMs = resolveAgentSessionTimeoutMs(
      input.flowTimeouts,
      selectedStage,
    );
    let budgetFailure: BudgetExceededError | undefined;
    try {
      const result = await withStageHeartbeat(
        {
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          captureRecovery: async () => await captureAttemptRecovery({
            context: input.context,
            workspace: input.workspace,
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
          }),
        },
        async () => await runAgentInWorkspace({
          backend: input.backend,
          dependencies: input.dependencies,
          workspace: input.workspace,
          stage: selectedStage,
          prompt,
          attemptDirectory: selectedAttemptDirectory,
          context: input.context,
          contextControls: input.contextControls,
          readPolicy: input.readPolicy,
          visibleInputPaths: [...scopedInputs.values()].map(
            (artifact) => artifact.contentPath,
          ),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          timeoutMs: sessionTimeoutMs,
        }),
      );
      appendGlobalSkillsEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        ...(result.globalSkills ? { outcome: result.globalSkills } : {}),
        context: input.context,
      });
      recordAgentSession({
        sessions: input.agentSessions,
        stageId: input.stage.id,
        eventStore: input.eventStore,
        runId: input.runId,
        attempt: selectedAttempt,
        ...(result.session ? { outcome: result.session } : {}),
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
      budgetFailure = captureHardBudgetConsumption({
        eventStore: input.eventStore,
        runId: input.runId,
        stage: input.stage,
        attempt: selectedAttempt,
        runBudgets: input.flowBudgets,
        context: input.context,
      });
    } catch (error) {
      if (error instanceof RunCancelledError) {
        throw error;
      }
      appendRuntimeUsageEvent({
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        usage: runtimeUsageFromThrown(error),
        context: input.context,
      });
      if (isStageTimeoutError(error)) {
        appendStageTimeoutEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          kind: error.timeoutKind,
          timeoutMs: error.timeoutMs,
          context: input.context,
          message: error.message,
        });
      }
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
        if (input.blockRunOnAgentBlocker ?? true) {
          appendRunBlockedEvents({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            blocker: blocked.blocker,
            context: input.context,
          });
        } else {
          appendStageBlockedEvent({
            eventStore: input.eventStore,
            runId: input.runId,
            stageId: input.stage.id,
            attempt: selectedAttempt,
            blocker: blocked.blocker,
            context: input.context,
          });
        }
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
    const attemptQuestion = await readAttemptQuestion(
      input.runDirectory,
      selectedAttemptDirectory,
    );
    if (attemptQuestion) {
      const questionId = questionIdForStageAttempt(
        input.stage.id,
        selectedAttempt,
      );
      requirePathInside(
        input.runDirectory,
        attemptQuestion.path,
        "structured question artifact",
      );
      recordGeneratedMarkdownArtifact({
        inputs: input.inputArtifacts,
        id: questionId,
        contentPath: attemptQuestion.path,
        content: attemptQuestion.raw,
        mediaType: "application/vnd.nitely.operator-question+json",
        producerStageId: input.stage.id,
        attempt: selectedAttempt,
        context: input.context,
        eventStore: input.eventStore,
      });
      await persistContextManifest(input.context);
      await persistArtifactRegistry(input.context);
      const artifactPath = manifestRunRelativePath(
        input.runDirectory,
        attemptQuestion.path,
      );
      input.eventStore.append({
        runId: input.runId,
        stageId: input.stage.id,
        attempt: selectedAttempt,
        type: "stage.question",
        payload: redactRuntimeUnknown(
          {
            questionId,
            question: attemptQuestion.question,
            artifactPath,
          },
          input.context,
        ),
      });
      if (budgetFailure) throw budgetFailure;
      const blocker: RunBlocker = {
        reason: "awaiting_operator_answer",
        stageId: input.stage.id,
        runtime: selectedStage.runtime,
        message: attemptQuestion.question.question,
        questionId,
      };
      if (input.blockRunOnAgentBlocker ?? true) {
        appendRunBlockedEvents({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          blocker,
          context: input.context,
        });
      } else {
        appendStageBlockedEvent({
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: selectedAttempt,
          blocker,
          context: input.context,
        });
      }
      throw new RunBlockedError(blocker, true);
    }
    const validatedOutputs = await validateAttemptOutputs({
      runDirectory: input.runDirectory,
      attemptDirectory: selectedAttemptDirectory,
      stageId: input.stage.id,
      attempt: selectedAttempt,
      outputs: input.stage.outputs.map(outputContract),
    });
    const convergence = selectedStage.type === "agent"
      ? await applyAgentStageConvergence({
          stage: selectedStage,
          inputs: input.inputArtifacts,
          outputs: validatedOutputs.outputs,
          runDirectory: input.runDirectory,
        })
      : undefined;
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
    if (input.completeStage !== false) {
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
          ...(convergence ? { convergence } : {}),
        },
      });
    }
    if (budgetFailure) {
      budgetFailure.stageCompleted = true;
      throw budgetFailure;
    }
    return { selectedAttempt, selectedStage };
  }
  return { selectedAttempt, selectedStage };
}

function alwaysRunAgentFinalizers(
  stages: Stage[],
): Extract<Stage, { type: "agent" }>[] {
  return stages.filter(
    (stage): stage is Extract<Stage, { type: "agent" }> =>
      stage.type === "agent" && stage.alwaysRun === true,
  );
}

function terminalFinalizerContextContent(input: {
  runId: string;
  flowName: string;
  terminalStatus: TerminalRunStatus;
  completedStages: string[];
  terminalStageId?: string;
  terminalError?: string;
  blocker?: RunBlocker;
  changeRequestUrl?: string;
  changeRequest?: ChangeRequest;
  reworkTarget?: ReworkTargetState;
  syncMetadata?: SyncMetadata;
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
}): string {
  const lines = [
    "# Run Finalizer Context",
    "",
    `Run id: ${redactRuntimeText(input.runId, input.context) ?? ""}`,
    `Flow: ${redactRuntimeText(input.flowName, input.context) ?? ""}`,
    `Terminal status: ${input.terminalStatus}`,
  ];
  if (input.terminalStageId) {
    lines.push(`Stage: ${redactRuntimeText(input.terminalStageId, input.context) ?? ""}`);
  }
  if (input.terminalError) {
    lines.push(`Error: ${redactRuntimeText(input.terminalError, input.context) ?? ""}`);
  }
  if (input.blocker) {
    lines.push(
      "",
      "## Blocker",
      "",
      `Reason: ${redactRuntimeText(input.blocker.reason, input.context) ?? ""}`,
    );
    if (input.blocker.stageId) {
      lines.push(`Stage: ${redactRuntimeText(input.blocker.stageId, input.context) ?? ""}`);
    }
    if (input.blocker.runtime) {
      lines.push(`Runtime: ${redactRuntimeText(input.blocker.runtime, input.context) ?? ""}`);
    }
    if (input.blocker.retryAfter) {
      lines.push(`Retry after: ${redactRuntimeText(input.blocker.retryAfter, input.context) ?? ""}`);
    }
    if (input.blocker.message) {
      lines.push(`Message: ${redactRuntimeText(input.blocker.message, input.context) ?? ""}`);
    }
  }
  if (input.changeRequestUrl || input.changeRequest) {
    lines.push("", "## Change Request", "");
    if (input.changeRequestUrl) {
      lines.push(
        `Change request URL: ${redactRuntimeText(input.changeRequestUrl, input.context) ?? ""}`,
      );
    }
    if (input.changeRequest) {
      lines.push(
        `Provider: ${input.changeRequest.provider}`,
        `Number: ${input.changeRequest.number}`,
        `Repository: ${redactRuntimeText(`${input.changeRequest.owner}/${input.changeRequest.repository}`, input.context) ?? ""}`,
        `Base branch: ${redactRuntimeText(input.changeRequest.baseBranch, input.context) ?? ""}`,
        `Head branch: ${redactRuntimeText(input.changeRequest.headBranch, input.context) ?? ""}`,
      );
    }
  }
  if (input.reworkTarget) {
    lines.push(
      "",
      "## Change Request Target",
      "",
      `Target: ${redactRuntimeText(String(input.reworkTarget.target), input.context) ?? ""}`,
      `URL: ${redactRuntimeText(input.reworkTarget.resolved.url, input.context) ?? ""}`,
      `Previous head SHA: ${input.reworkTarget.previousHeadSha}`,
    );
    if (input.reworkTarget.updatedHeadSha) {
      lines.push(`Updated head SHA: ${input.reworkTarget.updatedHeadSha}`);
    }
  }
  if (input.syncMetadata) {
    lines.push(
      "",
      "## Sync",
      "",
      `Result: ${input.syncMetadata.result}`,
      `Base branch: ${redactRuntimeText(input.syncMetadata.baseBranch, input.context) ?? ""}`,
    );
  }
  lines.push(
    "",
    "## Completed Stages",
    "",
    input.completedStages.length > 0
      ? input.completedStages
          .map((stage) => `- ${redactRuntimeText(stage, input.context) ?? ""}`)
          .join("\n")
      : "- none",
    "",
    "## Input Sources",
    "",
  );
  for (const artifact of input.inputs.values()) {
    lines.push(
      `- ${redactRuntimeText(artifact.id, input.context) ?? ""}: ${
        redactRuntimeText(artifact.resource.sourceUri, input.context) ?? ""
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function recordRunFinalizerContextArtifact(input: {
  inputArtifacts: Map<string, InputArtifact>;
  runDirectory: string;
  context: RuntimeContext;
  eventStore: EventStore;
  content: string;
}): Promise<void> {
  const contentPath = join(input.runDirectory, "finalizer-context.md");
  requirePathInside(input.runDirectory, contentPath, "run finalizer context artifact");
  await writeFile(contentPath, input.content, "utf8");
  recordGeneratedMarkdownArtifact({
    inputs: input.inputArtifacts,
    id: "run-finalizer-context",
    contentPath,
    content: input.content,
    producerStageId: "run-finalizer",
    eventStageId: null,
    context: input.context,
    eventStore: input.eventStore,
  });
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
}

async function recordReflectionSkippedArtifact(input: {
  inputArtifacts: Map<string, InputArtifact>;
  stage: Extract<Stage, { type: "agent" }>;
  attempt: number;
  attemptDirectory: string;
  runDirectory: string;
  terminalStatus: TerminalRunStatus;
  reason: string;
  context: RuntimeContext;
  eventStore: EventStore;
}): Promise<void> {
  const contentPath = join(input.attemptDirectory, "reflection-skipped.md");
  requirePathInside(input.runDirectory, contentPath, "reflection skipped artifact");
  const content = [
    "# Reflection Skipped",
    "",
    `Stage: ${redactRuntimeText(input.stage.id, input.context) ?? ""}`,
    `Terminal status: ${input.terminalStatus}`,
    `Reason: ${redactRuntimeText(input.reason, input.context) ?? ""}`,
    "",
  ].join("\n");
  await writeFile(contentPath, content, "utf8");
  recordGeneratedMarkdownArtifact({
    inputs: input.inputArtifacts,
    id: "reflection-skipped",
    contentPath,
    content,
    producerStageId: input.stage.id,
    context: input.context,
    eventStore: input.eventStore,
  });
  input.eventStore.append({
    runId: input.context.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "stage.failed",
    payload: redactRuntimeUnknown({ error: input.reason, finalizerSkipped: true }, input.context),
  });
  await persistContextManifest(input.context);
  await persistArtifactRegistry(input.context);
}

async function runAlwaysRunFinalizers(input: {
  runId: string;
  flowName: string;
  workItemId?: string;
  stages: Stage[];
  terminalStatus: TerminalRunStatus;
  terminalStageId?: string;
  terminalError?: string;
  blocker?: RunBlocker;
  runDirectory: string;
  repoPath: string;
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  flowMaxInputTokens?: number;
  flowMaxAttempts?: number;
  flowContext?: ContextControls;
  flowReads?: ReadPolicy;
  flowTimeouts?: TimeoutControls;
  flowBudgets?: EffectiveBudgetControls;
  inputArtifacts: Map<string, InputArtifact>;
  configuration: FlowConfiguration;
  context: RuntimeContext;
  eventStore: EventStore;
  providerStore: ProviderConnectionStore;
  loadedSkillUsages: StageSkillUsage[];
  contextKnowledge?: ContextKnowledgeEntry[];
  completedStages: string[];
  injectedAgentMemory?: InjectedAgentMemoryScope;
  changeRequestUrl?: string;
  changeRequest?: ChangeRequest;
  reworkTarget?: ReworkTargetState;
  syncMetadata?: SyncMetadata;
  nextAttempt: (stageId: string) => number;
  onAttemptSelected?: (stageId: string, attempt: number) => void;
}): Promise<void> {
  if (input.blocker?.reason === "agent_credentials_invalid") return;

  const finalizers = alwaysRunAgentFinalizers(input.stages);
  if (finalizers.length === 0) return;

  await recordRunFinalizerContextArtifact({
    inputArtifacts: input.inputArtifacts,
    runDirectory: input.runDirectory,
    context: input.context,
    eventStore: input.eventStore,
    content: terminalFinalizerContextContent({
      runId: input.runId,
      flowName: input.flowName,
      terminalStatus: input.terminalStatus,
      completedStages: input.completedStages,
      terminalStageId: input.terminalStageId,
      terminalError: input.terminalError,
      blocker: input.blocker,
      changeRequestUrl: input.changeRequestUrl,
      changeRequest: input.changeRequest,
      reworkTarget: input.reworkTarget,
      syncMetadata: input.syncMetadata,
      inputs: input.inputArtifacts,
      context: input.context,
    }),
  });

  for (const stage of finalizers) {
    const attempt = input.nextAttempt(stage.id);
    let selectedAttempt = attempt;
    const stageInputs = Array.from(
      new Set([...stage.inputs, "run-finalizer-context"]),
    );
    const finalizerStage = { ...stage, inputs: stageInputs };
    const contextControls = resolveStageContextControlsFrom(
      input.flowContext,
      finalizerStage.context,
    );
    const readPolicy = resolveStageReadPolicy(input.flowReads, finalizerStage);
    await prepareStageInstructionFilesBeforeAttempt({
      stage: finalizerStage,
      controls: contextControls,
      injectedAgentMemory: input.injectedAgentMemory,
    });
    const { attemptDirectory } = await beginStageAttempt({
      eventStore: input.eventStore,
      runId: input.runId,
      runDirectory: input.runDirectory,
      stage,
      attempt,
      resumedFrom: input.terminalStatus,
      branchHeadSha: await currentBranchHeadSha(input.workspace.path),
    });
    try {
      const result = await withStageInstructionFiles({
        stage: finalizerStage,
        controls: contextControls,
        attemptDirectory,
        workspace: input.workspace,
        injectedAgentMemory: input.injectedAgentMemory,
        run: async () => await executeAgentStage({
          runId: input.runId,
          stage: finalizerStage,
          attempt,
          attemptDirectory,
          runDirectory: input.runDirectory,
          repoPath: input.repoPath,
          backend: input.backend,
          dependencies: input.dependencies,
          workspace: input.workspace,
          flowName: input.flowName,
          flowMaxInputTokens: input.flowMaxInputTokens,
          flowMaxAttempts: input.flowMaxAttempts,
          flowTimeouts: input.flowTimeouts,
          flowBudgets: input.flowBudgets,
          inputArtifacts: input.inputArtifacts,
          configuration: input.configuration,
          context: input.context,
          eventStore: input.eventStore,
          providerStore: input.providerStore,
          loadedSkillUsages: input.loadedSkillUsages,
          contextControls,
          readPolicy,
          contextKnowledge: input.contextKnowledge,
          previousFailures: [],
          completedStages: input.completedStages,
          resumedFrom: input.terminalStatus,
          blockRunOnAgentBlocker: false,
          onAttemptSelected: (candidateAttempt) => {
            selectedAttempt = candidateAttempt;
            input.onAttemptSelected?.(stage.id, candidateAttempt);
          },
        }),
      });
      selectedAttempt = result.selectedAttempt;
      input.onAttemptSelected?.(stage.id, selectedAttempt);
      await createContextKnowledgeProposalsFromFinalizerOutputs({
        repoPath: input.repoPath,
        runId: input.runId,
        workItemId: input.workItemId,
        stage: finalizerStage,
        inputArtifacts: input.inputArtifacts,
        context: input.context,
        eventStore: input.eventStore,
      });
      const skillSignals = finalizerStage.outputs.flatMap((output) => {
        const artifact = input.inputArtifacts.get(outputId(output));
        return artifact
          ? parseSkillPapercutSignals(artifact.resource.content.toString("utf8"))
          : [];
      });
      const skillObservations = await recordReflectionSkillPapercuts({
        repoPath: input.repoPath,
        runId: input.runId,
        repository: input.repoPath,
        flow: input.flowName,
        stage: finalizerStage.id,
        signals: skillSignals,
        eventStore: input.eventStore,
      });
      if (skillObservations.length > 0) {
        const skillPapercutPath = join(
          input.runDirectory,
          "stages",
          finalizerStage.id,
          String(selectedAttempt),
          "skill-papercuts.json",
        );
        const content = `${JSON.stringify({
          schemaVersion: "nitely.skill-papercut.v1",
          observations: skillObservations,
        }, null, 2)}\n`;
        await writeRunOwnedFileAtomically({
          runDirectory: input.runDirectory,
          path: relative(input.runDirectory, skillPapercutPath),
          subject: "skill papercut artifact",
          content,
        });
        recordGeneratedMarkdownArtifact({
          inputs: input.inputArtifacts,
          id: SKILL_PAPERCUT_ARTIFACT_CONTRACT.id,
          contentPath: skillPapercutPath,
          content,
          mediaType: SKILL_PAPERCUT_ARTIFACT_CONTRACT.mediaType,
          producerStageId: finalizerStage.id,
          attempt: selectedAttempt,
          contract: SKILL_PAPERCUT_ARTIFACT_CONTRACT,
          context: input.context,
          eventStore: input.eventStore,
        });
        await persistContextManifest(input.context);
        await persistArtifactRegistry(input.context);
      }
    } catch (error) {
      const reason =
        error instanceof RunBlockedError
          ? `reflection finalizer blocked: ${error.blocker.reason}`
          : error instanceof Error
            ? error.message
            : String(error);
      await recordReflectionSkippedArtifact({
        inputArtifacts: input.inputArtifacts,
        stage,
        attempt: selectedAttempt,
        attemptDirectory:
          selectedAttempt === attempt
            ? attemptDirectory
            : join(input.runDirectory, "stages", stage.id, String(selectedAttempt)),
        runDirectory: input.runDirectory,
        terminalStatus: input.terminalStatus,
        reason,
        context: input.context,
        eventStore: input.eventStore,
      });
    }
  }
}

async function executeCommandStage(input: {
  runId: string;
  stage: Extract<Stage, { type: "command" }>;
  attempt: number;
  attemptDirectory: string;
  runDirectory: string;
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  flowMaxAttempts?: number;
  flowMaxToolOutputTokens?: number;
  flowTimeouts?: TimeoutControls;
  flowBudgets?: EffectiveBudgetControls;
  context: RuntimeContext;
  eventStore: EventStore;
  inputArtifacts: Map<string, InputArtifact>;
  completedStages: string[];
  cancellation?: RunCancellationControl;
}): Promise<{ failureError?: string }> {
  assertHardBudgetAdmission({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    runBudgets: input.flowBudgets,
    context: input.context,
  });
  const timeoutMs = resolveCommandTimeoutMs(input.flowTimeouts, input.stage);
  const { result, durationMs, stdoutPath, stderrPath, outputPath, outputSummary } =
    await withStageHeartbeat(
      {
        eventStore: input.eventStore,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: input.attempt,
        captureRecovery: async () => await captureAttemptRecovery({
          context: input.context,
          workspace: input.workspace,
          eventStore: input.eventStore,
          runId: input.runId,
          stageId: input.stage.id,
          attempt: input.attempt,
        }),
      },
      async () => await runCommandInWorkspace({
        backend: input.backend,
        workspace: input.workspace,
        command: input.stage.command,
        timeoutMs,
        maxToolOutputTokens: resolveMaxToolOutputTokens(
          input.stage,
          input.flowMaxToolOutputTokens,
        ),
        attemptDirectory: input.attemptDirectory,
        runId: input.runId,
        stageId: input.stage.id,
        attempt: input.attempt,
        context: input.context,
        cancellation: input.cancellation,
      }),
    );
  appendToolOutputBudgetEvent({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    summary: outputSummary,
    context: input.context,
  });
  const timedOut = commandTimedOut(result, timeoutMs);
  if (timedOut && timeoutMs !== undefined) {
    appendStageTimeoutEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      kind: "commandMs",
      timeoutMs,
      context: input.context,
    });
  }
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
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(timedOut ? { timeoutReason: `command timed out after ${timeoutMs}ms` } : {}),
      ...(result.cancelled ? { cancellation: result.termination ?? true } : {}),
      stdout: outputSummary.stdout,
      stderr: outputSummary.stderr,
      stdoutPath,
      stderrPath,
      outputPath,
      environmentRepairs: result.environmentRepairs ?? [],
    }, input.context),
  });
  if (result.cancelled) {
    throw new RunCancelledError({
      request: cancellationRequestFromSignal(input.cancellation),
      stageId: input.stage.id,
      attempt: input.attempt,
      cleanup: result.termination,
    });
  }
  if (result.exitCode !== 0) {
    assertHardBudgetConsumption({
      eventStore: input.eventStore,
      runId: input.runId,
      stage: input.stage,
      attempt: input.attempt,
      runBudgets: input.flowBudgets,
      context: input.context,
    });
    return { failureError: commandFailureMessage(input.stage.command, result) };
  }
  const richOutputs = input.stage.outputs
    .filter((output) => typeof output !== "string")
    .map(outputContract);
  if (richOutputs.length > 0) {
    try {
      const validatedOutputs = await validateAttemptOutputs({
        runDirectory: input.runDirectory,
        attemptDirectory: input.attemptDirectory,
        stageId: input.stage.id,
        attempt: input.attempt,
        outputs: richOutputs,
        validateContracts: true,
        allowMarkdownFallback: true,
      });
      await recordValidatedAttemptOutputs({
        inputs: input.inputArtifacts,
        stage: input.stage,
        attempt: input.attempt,
        runDirectory: input.runDirectory,
        outputs: validatedOutputs.outputs,
        context: input.context,
        eventStore: input.eventStore,
      });
      enforceStageOutputContracts({
        stage: input.stage,
        inputs: input.inputArtifacts,
        context: input.context,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { failureError: `command output validation failed: ${reason}` };
    }
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
  const budgetFailure = captureHardBudgetConsumption({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    runBudgets: input.flowBudgets,
    context: input.context,
  });
  if (budgetFailure) {
    budgetFailure.stageCompleted = true;
    throw budgetFailure;
  }
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
  const content = selected.content.toString("utf8");
  const redacted = redactRuntimeText(content, input.context) ?? "";
  const outputPath = selected.runRelativePath ?? selected.attemptRelativePath;
  const verdict = parseReviewGateVerdict(redacted);
  const blockingReason = blockingReviewReason(redacted);
  return {
    output: {
      id: selected.id,
      path: outputPath,
      filename: selected.filename,
      mediaType: selected.mediaType,
      content: boundedText(redacted, MAX_REVIEW_OUTPUT_CONTENT_LENGTH),
      truncated: redacted.length > MAX_REVIEW_OUTPUT_CONTENT_LENGTH,
      ...(verdict ? { verdict } : {}),
    },
    reason: blockingReason
      ? `review gate reported ${blockingReason} in ${outputPath}`
      : verdict
        ? undefined
        : `review gate output ${outputPath} must contain a recognized pass/fail verdict`,
  };
}

async function readJudgeOutput(input: {
  stage: Extract<Stage, { type: "judge" }>;
  attempt: number;
  attemptDirectory: string;
  context: RuntimeContext;
}): Promise<{ result?: JudgeResult; outputPath?: string; reason?: string }> {
  const validated = await validateAttemptOutputs({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    stageId: input.stage.id,
    attempt: input.attempt,
    outputs: input.stage.outputs.map(outputContract),
  });
  const selected = validated.outputs[0];
  if (!selected) return { reason: "judge did not produce a declared output" };
  const content = redactRuntimeText(selected.content.toString("utf8"), input.context) ?? "";
  const result = parseJudgeResult(content);
  const outputPath = selected.runRelativePath ?? selected.attemptRelativePath;
  return result
    ? { result, outputPath }
    : {
        outputPath,
        reason: `judge output ${outputPath} must contain a structured PASS, REWORK, or HUMAN_REVIEW verdict`,
      };
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

async function refreshChangeEvidenceWithProvider(input: {
  provider: ScmProvider;
  refresh: RefreshChangeEvidenceInput;
}): Promise<RefreshChangeEvidenceResult | undefined> {
  if (!input.provider.updateChangeRequestMetadata) {
    return undefined;
  }
  const updated = await input.provider.updateChangeRequestMetadata({
    repoPath: input.refresh.repoPath,
    worktreePath: input.refresh.worktreePath,
    remoteName: "origin",
    changeRequest: input.refresh.changeRequest,
    title: input.refresh.title,
    body: input.refresh.body,
    bodyPath: input.refresh.evidencePath,
  });
  return {
    url: updated.url,
    evidencePath: input.refresh.evidencePath,
    changeRequest: updated.changeRequest,
    metadataUpdate: updated.metadataUpdate,
  };
}

async function refreshChangeRequestEvidence(input: {
  dependencies: RunFlowDependencies;
  providerStore?: ProviderConnectionStore;
  providerName?: "github" | "github-cli";
  refresh: RefreshChangeEvidenceInput;
}): Promise<RefreshChangeEvidenceResult | undefined> {
  if (input.dependencies.refreshChangeRequestEvidence) {
    return (
      (await input.dependencies.refreshChangeRequestEvidence(input.refresh)) ??
      undefined
    );
  }
  if (input.dependencies.publishChange && !input.dependencies.scmProvider) {
    return undefined;
  }
  const provider =
    input.dependencies.scmProvider ??
    createScmProvider(input.providerName ?? input.refresh.changeRequest.provider, {
      store: input.providerStore,
    });
  return await refreshChangeEvidenceWithProvider({
    provider,
    refresh: input.refresh,
  });
}

async function refreshTerminalChangeRequestEvidence(input: {
  runId: string;
  repoPath: string;
  worktreePath: string;
  changeRequest: ChangeRequest | undefined;
  evidencePath: string;
  title?: string;
  dependencies: RunFlowDependencies;
  providerStore?: ProviderConnectionStore;
  providerName?: "github" | "github-cli";
  context: RuntimeContext;
  eventStore: EventStore;
}): Promise<ChangeRequest | undefined> {
  if (!input.changeRequest) {
    return undefined;
  }
  const body = await readFile(input.evidencePath, "utf8");
  try {
    const refreshed = await refreshChangeRequestEvidence({
      dependencies: input.dependencies,
      providerStore: input.providerStore,
      providerName: input.providerName,
      refresh: {
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        changeRequest: input.changeRequest,
        evidencePath: input.evidencePath,
        title: input.title,
        body,
      },
    });
    if (!refreshed) {
      return input.changeRequest;
    }
    input.eventStore.append({
      runId: input.runId,
      type: "change.evidence.refreshed",
      payload: redactRuntimeUnknown(
        {
          url: refreshed.url,
          evidencePath: refreshed.evidencePath,
          changeRequest: refreshed.changeRequest,
          metadataUpdate: refreshed.metadataUpdate,
        },
        input.context,
      ),
    });
    return refreshed.changeRequest ?? input.changeRequest;
  } catch (error) {
    input.eventStore.append({
      runId: input.runId,
      type: "change.evidence.refresh_failed",
      payload: redactRuntimeUnknown(
        {
          url: input.changeRequest.url,
          evidencePath: input.evidencePath,
          error: error instanceof Error ? error.message : String(error),
        },
        input.context,
      ),
    });
    return input.changeRequest;
  }
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
  knowledgeChunkCount?: number;
  knowledgeBytesInlined?: number;
  knowledgeApproxTokens?: number;
}

export function renderInputContext(
  input: InputArtifact,
  context: RuntimeContext,
  options?: { forcePathOnly?: boolean; fullRead?: boolean },
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
  // "Full content" is the label for an input the prompt orders the agent to
  // read in full. A preview-sufficient input still carries an absolute path,
  // under a label that does not read as an instruction.
  const mandatoryRead = options?.forcePathOnly === true || options?.fullRead === true;
  const header = [
    ...baseLines,
    `Snapshot: ${runPath ?? ""}`,
    mandatoryRead ? `Full content: ${fullPath}` : `Local path: ${fullPath}`,
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
      // The prompt shrank but the agent is ordered to read every byte back, so
      // no context was saved.
      usage: { inlinedBytes: 0, savedBytes: 0 },
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
  if (options?.fullRead) {
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
      usage: { inlinedBytes, savedBytes: 0 },
    };
  }
  return {
    block: [
      ...header,
      "",
      "Content preview (truncated — treat it as sufficient for this input):",
      "",
      "```",
      preview,
      "```",
      "",
      `The preview above is the head of this artifact. Open ${fullPath} only if this task genuinely needs more than the preview.`,
    ].join("\n"),
    usage: { inlinedBytes, savedBytes: fullBytes - inlinedBytes },
  };
}

function renderInputs(
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
  forcedPathOnlyIds?: Set<string>,
  fullReadIds?: Set<string>,
): { text: string; inputBytesInlined: number; inputBytesSaved: number; inputCount: number } {
  const blocks: string[] = [];
  let inputBytesInlined = 0;
  let inputBytesSaved = 0;
  let inputCount = 0;
  for (const input of inputs.values()) {
    const { block, usage } = renderInputContext(input, context, {
      forcePathOnly: forcedPathOnlyIds?.has(input.id) ?? false,
      fullRead: fullReadIds?.has(input.id) ?? false,
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

const MAX_EXTERNAL_KNOWLEDGE_QUERY_BYTES = 60 * 1024;
const MAX_EXTERNAL_KNOWLEDGE_INPUT_BYTES = 12 * 1024;

interface StageKnowledgeRetrieval {
  matches: KnowledgeRetrievalMatch[];
  queryFingerprint?: string;
  status: "ready" | "degraded";
  degradedAttachmentIds: string[];
  reasonCodes: string[];
  candidateCount: number;
  retrievalTrimmedCount: number;
  approxTokens: number;
}

function structuredValueHasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(structuredValueHasSensitiveKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, entry]) => isSensitiveKey(key) || structuredValueHasSensitiveKey(entry),
  );
}

function querySafeText(value: string, context: RuntimeContext): string {
  const redacted = redactRuntimeText(value, context) ?? "";
  if (containsSensitiveText(redacted)) return "[content omitted: sensitive assignment]";
  if (
    redacted.split(/\r?\n/u).some((line) => {
      const match = /^\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]/u.exec(line);
      return Boolean(match && isSensitiveKey(match[1] ?? ""));
    })
  ) {
    return "[content omitted: sensitive structured key]";
  }
  const trimmed = redacted.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      if (structuredValueHasSensitiveKey(JSON.parse(trimmed))) {
        return "[content omitted: sensitive structured key]";
      }
    } catch {
      // Non-JSON text is still covered by the line and assignment scanners.
    }
  }
  return redacted;
}

function buildExternalKnowledgeQuery(input: {
  stage: AgentRunnableStage;
  flowName: string;
  configuration: FlowConfiguration;
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
}): string {
  const safeConfigurationKeys = Object.keys(input.configuration)
    .filter((key) => !isSensitiveKey(key))
    .sort();
  const blocks = [
    `Flow: ${querySafeText(input.flowName, input.context)}`,
    `Stage: ${querySafeText(input.stage.id, input.context)}`,
    `Task: ${querySafeText(input.stage.prompt, input.context)}`,
    `Configuration keys: ${safeConfigurationKeys.join(", ") || "none"}`,
  ];
  for (const [id, artifact] of [...input.inputs].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (
      artifact.omittedByPolicy ||
      !isTextualMediaType(artifact.resource.mediaType)
    ) {
      continue;
    }
    const content = headWithinBytes(
      querySafeText(artifact.resource.content.toString("utf8"), input.context),
      MAX_EXTERNAL_KNOWLEDGE_INPUT_BYTES,
    );
    blocks.push(`Input ${id}:\n${content}`);
  }
  return headWithinBytes(blocks.join("\n\n"), MAX_EXTERNAL_KNOWLEDGE_QUERY_BYTES);
}

export function externalKnowledgeQueryFailureIsFatal(input: {
  availability: ResolvedExternalKnowledgeControls["availability"];
  pins: readonly Pick<KnowledgeSnapshotSet["attachments"][number], "attachmentRequired">[];
}): boolean {
  return input.availability === "required" ||
    input.pins.some((pin) => pin.attachmentRequired);
}

async function retrieveExternalKnowledgeForStage(input: {
  stage: AgentRunnableStage;
  flowName: string;
  configuration: FlowConfiguration;
  inputs: Map<string, InputArtifact>;
  controls: ResolvedExternalKnowledgeControls;
  context: RuntimeContext;
  dependencies: RunFlowDependencies;
}): Promise<StageKnowledgeRetrieval | undefined> {
  const snapshots = input.context.knowledgeSnapshots;
  if (!input.controls.enabled || !snapshots) return undefined;
  const selected = input.controls.ids
    ? new Set(input.controls.ids)
    : undefined;
  const pins = snapshots.attachments.filter(
    (pin) => !selected || selected.has(pin.attachmentId),
  );
  const degradedAttachmentIds = snapshots.degradedAttachmentIds.filter(
    (id) => !selected || selected.has(id),
  );
  if (pins.length === 0 && degradedAttachmentIds.length === 0) return undefined;
  const query = buildExternalKnowledgeQuery({
    stage: input.stage,
    flowName: input.flowName,
    configuration: input.configuration,
    inputs: input.inputs,
    context: input.context,
  });
  const queryFingerprint = await (
    input.dependencies.fingerprintKnowledgeRepositoryQuery ??
    defaultFingerprintKnowledgeRepositoryQuery
  )(
    { targetRepoPath: input.context.repoPath, query },
    { redactionSecrets: input.context.redactionSecrets },
  );
  try {
    const result = await (
      input.dependencies.queryKnowledgeRepositories ??
      defaultQueryKnowledgeRepositories
    )(
      {
        targetRepoPath: input.context.repoPath,
        query,
        pins: snapshots,
        ...(input.controls.ids ? { attachmentIds: input.controls.ids } : {}),
        topK: input.controls.topK,
        maxPromptTokens: input.controls.maxPromptTokens,
        allowDegraded: input.controls.availability !== "required",
        ...(input.controls.availability === "required"
          ? {}
          : { requiredAttachmentIds: [] }),
      },
      { redactionSecrets: input.context.redactionSecrets },
    ) as unknown as KnowledgeRetrievalResult;
    const allDegraded = [...new Set([
      ...degradedAttachmentIds,
      ...result.degradedAttachmentIds,
    ])].sort();
    return {
      matches: result.matches,
      queryFingerprint: result.queryDigest || queryFingerprint,
      status: allDegraded.length > 0 ? "degraded" : "ready",
      degradedAttachmentIds: allDegraded,
      reasonCodes: result.warnings.length > 0 ? ["embedding-degraded"] : [],
      candidateCount: result.selectedCount + result.truncatedCount,
      retrievalTrimmedCount: result.truncatedCount,
      approxTokens: result.approxTokens,
    };
  } catch (error) {
    if (externalKnowledgeQueryFailureIsFatal({
      availability: input.controls.availability,
      pins,
    })) {
      throw error;
    }
    return {
      matches: [],
      queryFingerprint,
      status: "degraded",
      degradedAttachmentIds: [...new Set([
        ...degradedAttachmentIds,
        ...pins.map((pin) => pin.attachmentId),
      ])].sort(),
      reasonCodes: ["query-failed"],
      candidateCount: 0,
      retrievalTrimmedCount: 0,
      approxTokens: 0,
    };
  }
}

function appendKnowledgeRetrievalEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  retrieval: StageKnowledgeRetrieval;
  retainedCount: number;
  context: RuntimeContext;
}): void {
  const snapshots = new Map(
    input.context.knowledgeSnapshots?.attachments.map((pin) => [pin.attachmentId, pin]) ?? [],
  );
  const retained = input.retrieval.matches.slice(0, input.retainedCount);
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "knowledge.retrieved",
    payload: redactRuntimeUnknown(
      {
        queryFingerprint: input.retrieval.queryFingerprint,
        status: input.retrieval.status,
        candidateCount: input.retrieval.candidateCount,
        selectedCount: retained.length,
        trimmedCount:
          input.retrieval.retrievalTrimmedCount +
          (input.retrieval.matches.length - retained.length),
        promptTokens: Math.ceil(Buffer.byteLength(
          renderExternalKnowledgePrompt(retained).join("\n"),
          "utf8",
        ) / 4),
        degradedAttachmentIds: input.retrieval.degradedAttachmentIds,
        reasonCodes: input.retrieval.reasonCodes,
        matches: retained.map((match) => {
          const snapshot = snapshots.get(match.attachmentId);
          return {
            attachmentId: match.attachmentId,
            snapshotId: snapshot?.snapshotId,
            commitSha: match.commitSha,
            indexDigest: snapshot?.indexDigest,
            chunkId: match.chunkId,
            citation: match.citation,
            rank: match.rank,
            lexicalScore: match.lexicalScore,
            semanticScore: match.semanticScore,
            combinedScore: match.combinedScore ?? match.fusedScore,
            providerId: snapshot?.providerId,
            model: snapshot?.model,
          };
        }),
      },
      input.context,
    ),
  });
}

function contextControlValue<K extends keyof ContextControls>(
  key: K,
  flowContext: ContextControls | undefined,
  stageContext: ContextControls | undefined,
): ContextControls[K] | undefined {
  return stageContext?.[key] ?? flowContext?.[key];
}

function resolveStageContextControls(
  flow: Flow,
  stage: Stage,
): ResolvedStageContextControls {
  return resolveStageContextControlsFrom(flow.spec.context, stage.context);
}

function resolveStageContextControlsFrom(
  flowContext: ContextControls | undefined,
  stageContext: ContextControls | undefined,
): ResolvedStageContextControls {
  const isolated =
    contextControlValue("isolated", flowContext, stageContext) ?? false;
  const inheritedPromptContextDefault = !isolated;
  const externalKnowledge = resolveExternalKnowledgeControls({
    flow: flowContext?.externalKnowledge,
    stage: stageContext?.externalKnowledge,
    inheritedDefault: inheritedPromptContextDefault,
  });
  return {
    isolated,
    instructionFiles:
      contextControlValue("instructionFiles", flowContext, stageContext) ?? true,
    projectInstructions:
      contextControlValue("projectInstructions", flowContext, stageContext) ??
      inheritedPromptContextDefault,
    contextKnowledge:
      contextControlValue("contextKnowledge", flowContext, stageContext) ??
      inheritedPromptContextDefault,
    // Isolation is a hard boundary: an explicit external-knowledge enablement
    // must not reopen a context source that isolation closed.
    externalKnowledge: isolated
      ? { ...externalKnowledge, enabled: false }
      : externalKnowledge,
    previousFailures:
      contextControlValue("previousFailures", flowContext, stageContext) ??
      inheritedPromptContextDefault,
    // Opt-in only. A truncated preview is the default contract, so nothing is
    // mandatory-read unless a flow says this stage cannot work from a preview.
    fullReadInputs: [
      ...(contextControlValue("fullReadInputs", flowContext, stageContext) ?? []),
    ],
    globalSkills: resolveGlobalSkillsMode(
      contextControlValue("globalSkills", flowContext, stageContext),
    ),
    sessionReuse: contextControlValue("sessionReuse", flowContext, stageContext),
  };
}

/**
 * A task-plan loop re-runs one stage in one worktree over and over, which is
 * exactly the shape a warm session helps: iteration N+1 should not re-ingest
 * iteration N's context. Other stages run once, so a cold session costs
 * nothing and keeps their prompt self-contained.
 */
function sessionReuseEnabled(
  stage: AgentRunnableStage,
  controls: ResolvedStageContextControls,
): boolean {
  return controls.sessionReuse ?? stage.taskPlan !== undefined;
}

function resolveGlobalSkillsMode(value: boolean | undefined): GlobalSkillsMode {
  if (value === undefined) return "isolate-if-supported";
  return value ? "inherited" : "required-isolated";
}

type ExternalKnowledgeControl = NonNullable<ContextControls["externalKnowledge"]>;

function externalKnowledgeObject(
  value: ExternalKnowledgeControl | undefined,
): Exclude<ExternalKnowledgeControl, boolean> | undefined {
  return typeof value === "object" ? value : undefined;
}

function explicitlyEnablesExternalKnowledge(
  value: ExternalKnowledgeControl | undefined,
): boolean {
  return value === true ||
    (typeof value === "object" && value.enabled !== false);
}

function minimumExternalKnowledgeLimit(
  fallback: number,
  ...values: Array<number | undefined>
): number {
  const configured = values.filter((value): value is number => value !== undefined);
  return configured.length > 0 ? Math.min(...configured) : fallback;
}

export function resolveExternalKnowledgeControls(input: {
  flow?: ExternalKnowledgeControl;
  stage?: ExternalKnowledgeControl;
  inheritedDefault: boolean;
}): ResolvedExternalKnowledgeControls {
  const flow = externalKnowledgeObject(input.flow);
  const stage = externalKnowledgeObject(input.stage);
  const explicitlyDisabled =
    input.flow === false ||
    input.stage === false ||
    flow?.enabled === false ||
    stage?.enabled === false;
  const explicitlyEnabled =
    explicitlyEnablesExternalKnowledge(input.flow) ||
    explicitlyEnablesExternalKnowledge(input.stage);
  const flowIds = flow?.ids;
  const stageIds = stage?.ids;
  const ids = flowIds && stageIds
    ? flowIds.filter((id) => stageIds.includes(id))
    : flowIds ?? stageIds;
  return {
    enabled: explicitlyDisabled
      ? false
      : explicitlyEnabled
        ? true
        : input.inheritedDefault,
    ...(ids ? { ids: [...new Set(ids)].sort() } : {}),
    topK: minimumExternalKnowledgeLimit(6, flow?.topK, stage?.topK),
    maxPromptTokens: minimumExternalKnowledgeLimit(
      1_800,
      flow?.maxPromptTokens,
      stage?.maxPromptTokens,
    ),
    availability:
      flow?.availability === "required" ||
        stage?.availability === "required"
        ? "required"
        : "degraded-ok",
  };
}

export function externalKnowledgeAdmissionControls(
  flow: Flow,
): ExternalKnowledgeAdmissionControls | undefined {
  const enabled = flow.spec.stages
    .filter(
      (stage) =>
        stage.type === "agent" ||
        (stage.type === "gate" && stage.mode === "review"),
    )
    .map((stage) => resolveStageContextControls(flow, stage).externalKnowledge)
    .filter((controls) => controls.enabled);
  if (enabled.length === 0) return undefined;
  if (
    enabled.some(
      (controls) =>
        controls.availability === "required" &&
        controls.ids !== undefined &&
        controls.ids.length === 0,
    )
  ) {
    throw new Error(
      "required external knowledge selection is empty after applying flow and stage scopes",
    );
  }
  const selectsAll = enabled.some((controls) => controls.ids === undefined);
  const ids = selectsAll
    ? undefined
    : [...new Set(enabled.flatMap((controls) => controls.ids ?? []))].sort();
  const required = enabled.filter(
    (controls) => controls.availability === "required",
  );
  const requireAll = required.some((controls) => controls.ids === undefined);
  const requiredIds = requireAll
    ? undefined
    : [...new Set(required.flatMap((controls) => controls.ids ?? []))].sort();
  return {
    ...(ids ? { ids } : {}),
    ...(required.length > 0 && requiredIds ? { requiredIds } : {}),
    availability: requireAll ? "required" : "degraded-ok",
  };
}

async function pinExternalKnowledgeForRun(input: {
  repoPath: string;
  runDirectory: string;
  flow: Flow;
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
  redactionSecrets: readonly string[];
}): Promise<KnowledgeSnapshotSet | undefined> {
  const controls = externalKnowledgeAdmissionControls(input.flow);
  if (!controls) return undefined;
  if (!input.dependencies.pinKnowledgeRepositorySnapshots) {
    const registryExists = await knowledgeRepositoryRegistryExists({
      targetRepoPath: input.repoPath,
    });
    if (
      !registryExists &&
      controls.availability === "degraded-ok" &&
      controls.ids === undefined &&
      controls.requiredIds === undefined
    ) {
      return undefined;
    }
  }
  const pinInput = {
    targetRepoPath: input.repoPath,
    ...(controls.ids ? { ids: controls.ids } : {}),
    ...(controls.requiredIds ? { requiredIds: controls.requiredIds } : {}),
    availability:
      controls.availability === "required" ? "require-all" as const : "allow-degraded" as const,
  };
  const pins = parseKnowledgeSnapshotSet(
    await (input.dependencies.pinKnowledgeRepositorySnapshots
      ? input.dependencies.pinKnowledgeRepositorySnapshots(pinInput)
      : defaultPinKnowledgeRepositorySnapshots(pinInput, {
          providerStore: input.providerStore,
          redactionSecrets: input.redactionSecrets,
        })),
  );
  await writeRunOwnedFileAtomically({
    runDirectory: input.runDirectory,
    path: KNOWLEDGE_SNAPSHOT_SET_PATH,
    subject: "external knowledge snapshot set",
    content: `${JSON.stringify(pins, null, 2)}\n`,
  });
  return pins;
}

function globalSkillsEvidenceLabel(mode: GlobalSkillsMode): string {
  switch (mode) {
    case "inherited":
      return "inherited from the operator";
    case "required-isolated":
      return "isolated (required)";
    default:
      return "isolated where the runtime supports it";
  }
}

function collectStageContextEvidence(flow: Flow): StageContextEvidence[] {
  return flow.spec.stages
    .filter(
      (
        stage,
      ): stage is
        | Extract<Stage, { type: "agent" }>
        | Extract<Stage, { type: "judge" }>
        | Extract<Stage, { type: "gate"; mode: "review" }> =>
        stage.type === "agent" ||
        stage.type === "judge" ||
        (stage.type === "gate" && stage.mode === "review"),
    )
    .map((stage) => ({
      stageId: stage.id,
      kind: stage.type === "judge"
        ? "judge"
        : stage.type === "agent"
          ? "agent"
          : "review-gate",
      ...resolveStageContextControls(flow, stage),
    }));
}

function timeoutControlValue<K extends keyof TimeoutControls>(
  key: K,
  flowTimeouts: TimeoutControls | undefined,
  stageTimeouts: TimeoutControls | undefined,
): TimeoutControls[K] | undefined {
  return stageTimeouts?.[key] ?? flowTimeouts?.[key];
}

function resolveStageTimeouts(
  flowTimeouts: TimeoutControls | undefined,
  stage: Stage,
): ResolvedStageTimeouts {
  return {
    sessionMs: timeoutControlValue("sessionMs", flowTimeouts, stage.timeouts),
    turnMs: timeoutControlValue("turnMs", flowTimeouts, stage.timeouts),
    stallMs: timeoutControlValue("stallMs", flowTimeouts, stage.timeouts),
    busyIdleMs: timeoutControlValue("busyIdleMs", flowTimeouts, stage.timeouts),
    pauseMs: timeoutControlValue("pauseMs", flowTimeouts, stage.timeouts),
    commandMs: timeoutControlValue("commandMs", flowTimeouts, stage.timeouts),
    gateMs: timeoutControlValue("gateMs", flowTimeouts, stage.timeouts),
  };
}

function resolveCommandTimeoutMs(
  flowTimeouts: TimeoutControls | undefined,
  stage: Extract<Stage, { type: "command" }>,
): number | undefined {
  return stage.timeoutMs ?? resolveStageTimeouts(flowTimeouts, stage).commandMs;
}

function resolveGateTimeoutMs(
  flowTimeouts: TimeoutControls | undefined,
  stage: Extract<Stage, { type: "gate"; mode: "deterministic" }>,
): number | undefined {
  return stage.timeoutMs ?? resolveStageTimeouts(flowTimeouts, stage).gateMs;
}

function resolveAgentSessionTimeoutMs(
  flowTimeouts: TimeoutControls | undefined,
  stage: AgentRunnableStage,
): number | undefined {
  return resolveStageTimeouts(flowTimeouts, stage).sessionMs;
}

function collectStageTimeoutEvidence(flow: Flow): StageTimeoutEvidence[] {
  return flow.spec.stages.map((stage) => {
    const kind =
      stage.type === "gate" && stage.mode === "review"
        ? "review-gate"
        : stage.type === "gate" && stage.mode === "deterministic"
          ? "deterministic-gate"
          : stage.type;
    return {
      stageId: stage.id,
      kind,
      ...resolveStageTimeouts(flow.spec.timeouts, stage),
    };
  });
}

class StageTimeoutError extends Error {
  constructor(
    readonly stageId: string,
    readonly timeoutKind: keyof ResolvedStageTimeouts,
    readonly timeoutMs: number,
  ) {
    super(
      `${timeoutKind.replace(/Ms$/, "")} timeout for stage "${stageId}" after ${timeoutMs}ms`,
    );
    this.name = "StageTimeoutError";
  }
}

function isStageTimeoutError(error: unknown): error is StageTimeoutError {
  return error instanceof StageTimeoutError;
}

async function withOperationTimeout<T>(input: {
  stageId: string;
  timeoutKind: keyof ResolvedStageTimeouts;
  timeoutMs?: number;
  operation: () => Promise<T>;
}): Promise<T> {
  if (input.timeoutMs === undefined) {
    return await input.operation();
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      input.operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new StageTimeoutError(
              input.stageId,
              input.timeoutKind,
              input.timeoutMs!,
            ),
          );
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function appendStageTimeoutEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  kind: keyof ResolvedStageTimeouts;
  timeoutMs: number;
  context: RuntimeContext;
  message?: string;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.timeout",
    payload: redactRuntimeUnknown(
      {
        kind: input.kind,
        timeoutMs: input.timeoutMs,
        message:
          input.message ??
          `${input.kind.replace(/Ms$/, "")} timeout after ${input.timeoutMs}ms`,
      },
      input.context,
    ),
  });
}

function commandTimedOut(result: CommandResult, timeoutMs: number | undefined): boolean {
  return (
    timeoutMs !== undefined &&
    result.exitCode === 124 &&
    result.stderr.includes(`timed out after ${timeoutMs}ms`)
  );
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

function renderContextKnowledge(
  entries: ContextKnowledgeEntry[],
  context: RuntimeContext,
): string[] {
  if (entries.length === 0) return [];
  const lines = [
    "## Repository Context Knowledge",
    "",
    "Use these approved repo knowledge entries when they are relevant to the current stage.",
    "",
  ];
  for (const entry of entries) {
    lines.push(
      `### ${redactRuntimeText(entry.title, context) ?? ""}`,
      "",
      `ID: ${redactRuntimeText(entry.id, context) ?? ""}`,
      `Category: ${entry.category}`,
      `Version: ${entry.version}`,
      entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "Tags: none",
      "",
      redactRuntimeText(entry.body, context) ?? "",
      "",
    );
  }
  return lines;
}

function renderContextKnowledgeProposalInstructions(stage: Stage): string[] {
  if (stage.type !== "agent" || stage.alwaysRun !== true) return [];
  return [
    "## Context Knowledge Proposals",
    "",
    "If this reflection discovered reusable repo knowledge, include a JSON array block opening with ```context-kg in one declared markdown output.",
    "Each entry must include `category`, `title`, and `body`; optional `tags` and `keywords` must be string arrays.",
    `Allowed categories: ${CONTEXT_KNOWLEDGE_CATEGORIES.join(", ")}.`,
    "",
    "## Skill Papercut Proposals",
    "",
    "If this reflection identifies a recurring skill-linked failure, include a JSON array block opening with ```skill-papercut in one declared markdown output.",
    "Each entry must include `stage`, `skillId`, `category`, `summary`, and `deduplicationKey`; optional `evidenceRefs` is a string array.",
    "Use the exact skill id and stage from the supplied skill snapshot. These observations remain inferred until an operator confirms them.",
    "",
  ];
}

function renderConvergenceInstructions(stage: AgentRunnableStage): string[] {
  if (stage.type !== "agent" || !stage.convergence) return [];
  const config = stage.convergence;
  return [
    "## Convergence Contract",
    "",
    `Compare the current worktree with the supplied feature artifacts and write ${config.reportOutput}.json as a strict ${CONVERGENCE_REPORT_VERSION} report.`,
    "Use `gaps` entries with classification (`missing`, `partial`, `contradicts`, or `unrequested`), an inline `title`, non-empty `sourceRefs`, non-empty worktree `evidence`, and optional repository-relative `paths`.",
    "Supported refs include FR-001, SC-001, US-001/AC-001, PD-001, plan:<slug>, and constitution:<slug>.",
    `Declare the report in artifact.json with mediaType ${CONVERGENCE_REPORT_MEDIA_TYPE}.`,
    `Copy the ${config.tasksInput} input byte-for-byte to ${config.tasksOutput}.md as a non-empty placeholder and declare it with mediaType text/markdown. Nitely will replace only that generated placeholder with a deterministic append after validating the report.`,
    "Do not edit the source task artifact, spec, or plan. Do not append or allocate task IDs yourself.",
    "Use an empty `gaps` array for a clean pass.",
    "",
  ];
}

/**
 * The prompt for a continued session. The runtime still holds everything the
 * cold prompt already delivered, so this carries only what changed: the current
 * task, where to write this attempt's outputs, and any new failure context.
 * Re-sending the full prompt each iteration is exactly what made a 24 KB
 * prompt.md grow into a 2.6M-token session.
 */
function renderResumePrompt(input: {
  stage: AgentRunnableStage;
  attemptDirectory: string;
  context: RuntimeContext;
  taskPlanPrompt?: TaskPlanPromptContext;
  previousFailures: PreviousFailure[];
  includePreviousFailures: boolean;
}): string {
  const retryContext =
    !input.includePreviousFailures || input.previousFailures.length === 0
      ? []
      : [
        "## Previous Failure Context",
        "",
        ...input.previousFailures.map(
          (failure) =>
            `- attempt ${failure.attempt} failed: ${
              redactRuntimeText(failure.error, input.context) ?? ""
            }`,
        ),
        "",
        "Do not repeat the failed approach. Use this failure context to choose a different fix.",
        "",
      ];
  return [
    `# Nitely Stage: ${input.stage.id} (continued session)`,
    "",
    "You are continuing the session you already ran for this stage in this worktree.",
    "Everything from the first prompt still applies. Do not re-read artifacts you already read unless this prompt says they changed.",
    "",
    redactRuntimeText(input.stage.prompt, input.context) ?? "",
    "",
    ...(input.taskPlanPrompt
      ? [
        `## Updated Input: ${input.taskPlanPrompt.inputId}`,
        "",
        redactRuntimeText(input.taskPlanPrompt.content, input.context) ?? "",
        "",
      ]
      : []),
    "## Output Files",
    "",
    "Write each required output artifact for this attempt to:",
    input.attemptDirectory,
    "",
    "Accepted filenames:",
    input.stage.outputs.map(renderAcceptedOutputFilename).join("\n"),
    "",
    ...retryContext,
  ].join("\n");
}

function renderReadPolicy(policy: ResolvedStageReadPolicy | undefined): string[] {
  if (!policy) return [];
  return [
    "## Repository Read Policy",
    "",
    `Do not take more than ${policy.maxFileBytes} bytes of any single repository file into context. For anything larger, search it, read the ranges you need, and summarize — do not dump the file.`,
    ...(policy.deny.length > 0
      ? [
        `Do not read these paths in bulk: ${policy.deny.join(", ")}.`,
      ]
      : []),
    "Prefer targeted searches with bounded output over whole-file or whole-tree reads.",
    "",
  ];
}

function renderAcceptedOutputFilename(
  output: Stage["outputs"][number],
): string {
  const contract = outputContract(output);
  const mediaType = contract.mediaType?.toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json")
    ? `- ${contract.id}.json`
    : `- ${contract.id}.md or ${contract.id}.txt`;
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

function projectInstructionCandidatePaths(
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
): string[] {
  return [...inputs.values()]
    .flatMap((artifact) => [
      artifact.resource.sourceUri,
      manifestRunRelativePath(context.runDirectory, artifact.contentPath),
    ])
    .filter((sourceUri): sourceUri is string => sourceUri !== undefined)
    .filter((sourceUri) => sourceUri.length > 0);
}

function renderSelectedProjectInstruction(
  instruction: SelectedProjectInstruction,
  context: RuntimeContext,
): string[] {
  return [
    `### ${redactRuntimeText(instruction.id, context) ?? ""}`,
    instruction.title
      ? `Title: ${redactRuntimeText(instruction.title, context) ?? ""}`
      : undefined,
    `Applies to: ${instruction.appliesTo}`,
    `Include: ${instruction.include.join(", ")}`,
    `Exclude: ${listOrNone(instruction.exclude)}`,
    instruction.matchedPaths.length > 0
      ? `Matched paths: ${instruction.matchedPaths
          .map((path) => redactRuntimeText(path, context) ?? "")
          .join(", ")}`
      : "Matched paths: all",
    "",
    redactRuntimeText(instruction.text, context) ?? "",
    "",
  ].filter((line): line is string => line !== undefined);
}

function renderProjectInstructions(
  stage: AgentRunnableStage,
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
): string[] {
  const selected = selectProjectInstructions({
    instructions: context.projectInstructions,
    stage,
    candidatePaths: projectInstructionCandidatePaths(inputs, context),
  });
  if (selected.length === 0 || !context.projectInstructions.loaded) {
    return [];
  }
  return [
    "## Project Instructions",
    "",
    `Source: ${redactRuntimeText(context.projectInstructions.path, context) ?? ""}`,
    `Hash: ${context.projectInstructions.hash}`,
    "",
    ...selected.flatMap((instruction) =>
      renderSelectedProjectInstruction(instruction, context),
    ),
  ];
}

function renderPrompt(
  stage: AgentRunnableStage,
  flowName: string,
  inputs: Map<string, InputArtifact>,
  attemptDirectory: string,
  context: RuntimeContext,
  skills: LoadedSkill[] = [],
  configuration: FlowConfiguration = {},
  contextControls: ResolvedStageContextControls = {
    isolated: false,
    instructionFiles: true,
    projectInstructions: true,
    contextKnowledge: true,
    externalKnowledge: {
      enabled: true,
      topK: 6,
      maxPromptTokens: 1_800,
      availability: "degraded-ok",
    },
    previousFailures: true,
    fullReadInputs: [],
    globalSkills: "isolate-if-supported",
    sessionReuse: undefined,
  },
  contextKnowledge: ContextKnowledgeEntry[] = [],
  externalKnowledge: readonly KnowledgeRetrievalMatch[] = [],
  previousFailures: PreviousFailure[] = [],
  forcedPathOnlyIds?: Set<string>,
  operatorQuestion?: ProjectedOperatorQuestion,
  readPolicy?: ResolvedStageReadPolicy,
): { prompt: string; contextUsage: ContextUsage } {
  const retryContext =
    !contextControls.previousFailures || previousFailures.length === 0
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
  const inputs_ = renderInputs(
    inputs,
    context,
    forcedPathOnlyIds,
    new Set(contextControls.fullReadInputs),
  );
  const externalKnowledgeLines = renderExternalKnowledgePrompt(
    externalKnowledge.map((match) => ({
      ...match,
      text: querySafeText(match.text, context),
    })),
  );
  const prompt = [
    `# Nitely Stage: ${stage.id}`,
    "",
    `Flow: ${flowName}`,
    "",
    "## Instructions",
    "",
    redactRuntimeText(
      applyFlowConfigurationTemplate(stage.prompt, configuration),
      context,
    ) ?? "",
    "",
    ...(stage.type === "judge"
      ? [
          "## Judge Criteria",
          "",
          ...stage.criteria.map((criterion) => `- ${criterion}`),
          "",
          "Return exactly one structured verdict: PASS, REWORK, or HUMAN_REVIEW.",
          "For REWORK, include reworkTarget and actionable reworkInstructions.",
          "",
        ]
      : []),
    ...renderFlowConfiguration(configuration).map(
      (line) => redactRuntimeText(line, context) ?? "",
    ),
    ...renderConstitution(context),
    ...(contextControls.projectInstructions
      ? renderProjectInstructions(stage, inputs, context)
      : []),
    ...(contextControls.contextKnowledge
      ? renderContextKnowledge(contextKnowledge, context)
      : []),
    ...renderContextKnowledgeProposalInstructions(stage),
    ...renderSkills(skills, context),
    ...renderOperatorQuestionAnswer(operatorQuestion).map(
      (line) => redactRuntimeText(line, context) ?? "",
    ),
    ...renderConvergenceInstructions(stage),
    ...renderReadPolicy(readPolicy),
    ...externalKnowledgeLines,
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
    stage.outputs.map(renderAcceptedOutputFilename).join("\n"),
    "",
    ...(stage.type === "agent" && !stage.alwaysRun
      ? [
          "## Structured Operator Question",
          "",
          "If a genuine human decision prevents safe completion, write question.json in the attempt directory instead of guessing or failing.",
          "Use exactly this JSON shape:",
          '{"version":1,"question":"...","options":[{"id":"choice","label":"...","recommended":true}],"context":"..."}',
          "Option ids must be unique. At most one option may be recommended. Options and context are optional.",
          "Only escalate when the answer is required to proceed. A valid question pauses this stage before required-output validation.",
          "",
        ]
      : []),
    "## Available Inputs",
    "",
    inputs_.text,
    "",
    ...retryContext,
  ].join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const knowledgeBytesInlined = Buffer.byteLength(
    externalKnowledgeLines.join("\n"),
    "utf8",
  );
  return {
    prompt,
    contextUsage: {
      promptBytes,
      approxTokens: Math.ceil(promptBytes / 4),
      inputBytesInlined: inputs_.inputBytesInlined,
      inputBytesSaved: inputs_.inputBytesSaved,
      inputCount: inputs_.inputCount,
      ...(externalKnowledge.length > 0
        ? {
            knowledgeChunkCount: externalKnowledge.length,
            knowledgeBytesInlined,
            knowledgeApproxTokens: Math.ceil(knowledgeBytesInlined / 4),
          }
        : {}),
    },
  };
}

export interface BudgetOutcome {
  status: "ok" | "trimmed" | "exceeded";
  budget?: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  trimmedExternalKnowledgeCount?: number;
  trimmedInputIds?: string[];
}

export function fitPromptToBudget(input: {
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
  budget: number | undefined;
  externalKnowledgeCount?: number;
  render: (
    forcedPathOnlyIds: Set<string>,
    retainedExternalKnowledgeCount?: number,
  ) => {
    prompt: string;
    contextUsage: ContextUsage;
  };
}): { prompt: string; contextUsage: ContextUsage; outcome: BudgetOutcome } {
  const forced = new Set<string>();
  let retainedExternalKnowledgeCount = input.externalKnowledgeCount;
  let { prompt, contextUsage } = input.render(
    forced,
    retainedExternalKnowledgeCount,
  );
  if (input.budget === undefined || contextUsage.approxTokens <= input.budget) {
    return { prompt, contextUsage, outcome: { status: "ok" } };
  }
  const before = contextUsage.approxTokens;
  let trimmedExternalKnowledgeCount = 0;
  while (
    retainedExternalKnowledgeCount !== undefined &&
    retainedExternalKnowledgeCount > 0
  ) {
    retainedExternalKnowledgeCount -= 1;
    trimmedExternalKnowledgeCount += 1;
    ({ prompt, contextUsage } = input.render(
      forced,
      retainedExternalKnowledgeCount,
    ));
    if (contextUsage.approxTokens <= input.budget) {
      return {
        prompt,
        contextUsage,
        outcome: {
          status: "trimmed",
          budget: input.budget,
          approxTokensBefore: before,
          approxTokensAfter: contextUsage.approxTokens,
          trimmedExternalKnowledgeCount,
          trimmedInputIds: [],
        },
      };
    }
  }
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
    ({ prompt, contextUsage } = input.render(
      forced,
      retainedExternalKnowledgeCount,
    ));
    if (contextUsage.approxTokens <= input.budget) {
      return {
        prompt,
        contextUsage,
        outcome: {
          status: "trimmed",
          budget: input.budget,
          approxTokensBefore: before,
          approxTokensAfter: contextUsage.approxTokens,
          ...(trimmedExternalKnowledgeCount > 0
            ? { trimmedExternalKnowledgeCount }
            : {}),
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

type HardBudgetKind =
  | "duration"
  | "runtime-tokens"
  | "cost"
  | "agent-attempts"
  | "judge-attempts"
  | "ci-runs";
type HardBudgetScope = "run" | "stage";

interface RuntimeBudgetTotals {
  runtimeTokens: number;
  cachedRuntimeTokens: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  unknownRuntimeAttempts: number;
  unknownCostAttempts: number;
}

interface BudgetExceededEventInput {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  kind: HardBudgetKind;
  scope: HardBudgetScope;
  phase: "admission" | "consumption";
  budget: number;
  consumed?: number;
  remaining?: number;
  actualCostUsd?: number;
  estimatedCostUsd?: number;
  cachedInputTokens?: number;
  unknownRuntimeAttempts?: number;
  unknownCostAttempts?: number;
  message: string;
  context: RuntimeContext;
}

function appendHardBudgetExceededEvent(input: BudgetExceededEventInput): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "budget.exceeded",
    payload: redactRuntimeUnknown(
      {
        budgetKind: input.kind,
        scope: input.scope,
        phase: input.phase,
        budget: input.budget,
        ...(input.consumed !== undefined ? { consumed: input.consumed } : {}),
        ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
        ...(input.kind === "runtime-tokens" && input.consumed !== undefined
          ? { approxTokens: input.consumed }
          : {}),
        ...(input.actualCostUsd !== undefined
          ? { actualCostUsd: input.actualCostUsd }
          : {}),
        ...(input.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: input.estimatedCostUsd }
          : {}),
        ...(input.cachedInputTokens !== undefined
          ? { cachedInputTokens: input.cachedInputTokens }
          : {}),
        ...(input.unknownRuntimeAttempts !== undefined
          ? { unknownRuntimeAttempts: input.unknownRuntimeAttempts }
          : {}),
        ...(input.unknownCostAttempts !== undefined
          ? { unknownCostAttempts: input.unknownCostAttempts }
          : {}),
        message: input.message,
      },
      input.context,
    ),
  });
}

function runtimeCostForBudget(
  usage: NonNullable<ReturnType<typeof projectRun>["stages"][number]["attempts"][number]["runtimeUsage"]>,
): { classification: "actual" | "estimated"; usd: number } | undefined {
  const provenance = usage.provenance;
  const hasProvenance =
    provenance !== undefined &&
    provenance.provider.trim().length > 0 &&
    Number.isFinite(Date.parse(provenance.observedAt)) &&
    provenance.source.reference.trim().length > 0;
  if (
    usage.cost?.classification === "actual" &&
    hasProvenance &&
    provenance.source.kind === "provider-reported"
  ) {
    return { classification: "actual", usd: usage.cost.usd };
  }
  if (
    usage.cost?.classification === "estimated" &&
    hasProvenance &&
    provenance.source.kind === "calculated"
  ) {
    return { classification: "estimated", usd: usage.cost.usd };
  }
  return undefined;
}

function runtimeBudgetTotals(input: {
  events: StoredRunEvent[];
  excludeAttempt?: { stageId: string; attempt: number };
}): RuntimeBudgetTotals {
  const projection = projectRun(input.events, { openAttemptStatus: "interrupted" });
  const totals: RuntimeBudgetTotals = {
    runtimeTokens: 0,
    cachedRuntimeTokens: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    unknownRuntimeAttempts: 0,
    unknownCostAttempts: 0,
  };
  const stages = projection.stages;
  for (const stage of stages) {
    for (const attempt of stage.attempts) {
      if (attempt.status === "unavailable" || attempt.status === "skipped") {
        continue;
      }
      if (
        input.excludeAttempt &&
        stage.stageId === input.excludeAttempt.stageId &&
        attempt.attempt === input.excludeAttempt.attempt
      ) {
        continue;
      }
      const isRuntimeAttempt =
        attempt.runtime !== undefined || stage.stageType === "agent";
      if (!isRuntimeAttempt) continue;
      if (!attempt.runtimeUsage) {
        totals.unknownRuntimeAttempts += 1;
        totals.unknownCostAttempts += 1;
        continue;
      }
      const tokens = billableRuntimeTokens(attempt.runtimeUsage);
      if (tokens === undefined) {
        totals.unknownRuntimeAttempts += 1;
      } else {
        totals.runtimeTokens += tokens;
        totals.cachedRuntimeTokens += attempt.runtimeUsage.cachedInputTokens ?? 0;
      }
      const cost = runtimeCostForBudget(attempt.runtimeUsage);
      if (!cost) {
        totals.unknownCostAttempts += 1;
      } else if (cost.classification === "actual") {
        totals.actualCostUsd += cost.usd;
      } else {
        totals.estimatedCostUsd += cost.usd;
      }
    }
  }
  return totals;
}

function costTotalUsd(totals: RuntimeBudgetTotals): number {
  return totals.actualCostUsd + totals.estimatedCostUsd;
}

function failHardBudget(input: BudgetExceededEventInput): never {
  appendHardBudgetExceededEvent(input);
  throw new BudgetExceededError(input.message, input.stageId, input.attempt);
}

/**
 * Runs the consumption checks without letting the failure interrupt the caller.
 *
 * A stage that produced its declared artifacts and then crossed the cap has
 * already been paid for; throwing before those artifacts are registered loses
 * the work and makes a resume repeat it. The `budget.exceeded` event is still
 * appended where the breach is detected — only the throw is deferred, to a
 * point where the attempt's outputs are safely recorded.
 */
function captureHardBudgetConsumption(
  input: Parameters<typeof assertHardBudgetConsumption>[0],
): BudgetExceededError | undefined {
  try {
    assertHardBudgetConsumption(input);
    return undefined;
  } catch (error) {
    if (error instanceof BudgetExceededError) return error;
    throw error;
  }
}

function checkRuntimeTokenBudget(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  totals: RuntimeBudgetTotals;
  phase: "admission" | "consumption";
  context: RuntimeContext;
}): void {
  const budget = defaultMaxRuntimeTokens();
  if (budget === undefined) return;
  const consumed = input.totals.runtimeTokens;
  const remaining = Math.max(0, budget - consumed);
  if (
    (input.phase === "admission" && remaining <= 0) ||
    (input.phase === "consumption" && consumed > budget)
  ) {
    failHardBudget({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      kind: "runtime-tokens",
      scope: "run",
      phase: input.phase,
      budget,
      consumed,
      remaining,
      cachedInputTokens: input.totals.cachedRuntimeTokens,
      message:
        `run runtime token budget exhausted: ${consumed} tokens used of ${budget}${
          input.totals.cachedRuntimeTokens > 0
            ? `, excluding ${input.totals.cachedRuntimeTokens} cache-read tokens`
            : ""
        }. This is Nitely's machine-wide runaway ceiling; set NITELY_DEFAULT_MAX_RUNTIME_TOKENS to raise it or 0 to disable`,
      context: input.context,
    });
  }
}

function checkCostBudget(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  budgets: EffectiveBudgetControls | undefined;
  totals: RuntimeBudgetTotals;
  phase: "admission" | "consumption";
  context: RuntimeContext;
}): void {
  if (input.budgets?.maxCostUsd === undefined) return;
  const budget = input.budgets.maxCostUsd;
  const consumed = costTotalUsd(input.totals);
  const remaining = Math.max(0, budget - consumed);
  if (input.totals.unknownCostAttempts > 0) {
    failHardBudget({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      kind: "cost",
      scope: "run",
      phase: input.phase,
      budget,
      consumed,
      remaining,
      actualCostUsd: input.totals.actualCostUsd,
      estimatedCostUsd: input.totals.estimatedCostUsd,
      unknownCostAttempts: input.totals.unknownCostAttempts,
      message:
        `run cost budget cannot be enforced because ${input.totals.unknownCostAttempts} runtime attempt(s) have unknown or unclassified cost`,
      context: input.context,
    });
  }
  if (
    (input.phase === "admission" && remaining <= 0) ||
    (input.phase === "consumption" && consumed > budget)
  ) {
    failHardBudget({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      kind: "cost",
      scope: "run",
      phase: input.phase,
      budget,
      consumed,
      remaining,
      actualCostUsd: input.totals.actualCostUsd,
      estimatedCostUsd: input.totals.estimatedCostUsd,
      message:
        `run cost budget exhausted: $${consumed} used of $${budget}`,
      context: input.context,
    });
  }
}

function priorVerificationAttempts(
  events: StoredRunEvent[],
  stage: Stage,
  attempt: number,
): number {
  return events.filter((event) => {
    if (event.type !== "stage.started") return false;
    if (event.stageId === stage.id && event.attempt === attempt) return false;
    const payload = asRecord(event.payload);
    if (payload.type !== stage.type) return false;
    if (stage.type !== "command") return true;
    const costClass = payload.costClass ?? stage.costClass;
    return costClass === undefined || costClass === "expensive";
  }).length;
}

function checkVerificationAttemptBudget(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  budgets: EffectiveBudgetControls | undefined;
  events: StoredRunEvent[];
  context: RuntimeContext;
}): void {
  const limits: Array<{
    stageType: Stage["type"];
    key: "maxAgentAttempts" | "maxJudgeAttempts" | "maxCiRuns";
    kind: Extract<HardBudgetKind, "agent-attempts" | "judge-attempts" | "ci-runs">;
    label: string;
  }> = [
    { stageType: "agent", key: "maxAgentAttempts", kind: "agent-attempts", label: "agent attempts" },
    { stageType: "judge", key: "maxJudgeAttempts", kind: "judge-attempts", label: "Judge attempts" },
    { stageType: "command", key: "maxCiRuns", kind: "ci-runs", label: "CI runs" },
  ];
  const limit = limits.find((candidate) => candidate.stageType === input.stage.type);
  if (!limit) return;
  const budget = input.budgets?.[limit.key];
  if (budget === undefined) return;
  const consumed = priorVerificationAttempts(input.events, input.stage, input.attempt);
  const remaining = Math.max(0, budget - consumed);
  if (remaining <= 0) {
    failHardBudget({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      kind: limit.kind,
      scope: "run",
      phase: "admission",
      budget,
      consumed,
      remaining,
      message: `run ${limit.label} budget exhausted: ${consumed} used of ${budget}`,
      context: input.context,
    });
  }
}

function assertHardBudgetAdmission(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  runBudgets: EffectiveBudgetControls | undefined;
  context: RuntimeContext;
}): void {
  const events = input.eventStore.list(input.runId);
  checkVerificationAttemptBudget({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    budgets: input.runBudgets,
    events,
    context: input.context,
  });
  const runTotals = runtimeBudgetTotals({
    events,
    excludeAttempt: { stageId: input.stage.id, attempt: input.attempt },
  });
  checkRuntimeTokenBudget({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    totals: runTotals,
    phase: "admission",
    context: input.context,
  });
  checkCostBudget({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    budgets: input.runBudgets,
    totals: runTotals,
    phase: "admission",
    context: input.context,
  });
}

function assertHardBudgetConsumption(input: {
  eventStore: EventStore;
  runId: string;
  stage: Stage;
  attempt: number;
  runBudgets: EffectiveBudgetControls | undefined;
  context: RuntimeContext;
}): void {
  const events = input.eventStore.list(input.runId);
  const runTotals = runtimeBudgetTotals({ events });
  checkRuntimeTokenBudget({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    totals: runTotals,
    phase: "consumption",
    context: input.context,
  });
  checkCostBudget({
    eventStore: input.eventStore,
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    budgets: input.runBudgets,
    totals: runTotals,
    phase: "consumption",
    context: input.context,
  });
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

function runtimeUsageFromThrown(error: unknown): AgentRuntimeUsage | undefined {
  if (typeof error !== "object" || error === null || !("usage" in error)) {
    return undefined;
  }
  const usage = error.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return undefined;
  }
  return usage as AgentRuntimeUsage;
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
    payload: redactRuntimeUnknown(
      normalizeRuntimeUsageForPersistence(input.usage),
      input.context,
    ),
  });
}

function appendGlobalSkillsEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  outcome?: AgentGlobalSkillsOutcome;
  context: RuntimeContext;
}): void {
  if (!input.outcome) return;
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.runtime.global-skills",
    payload: redactRuntimeUnknown(
      {
        isolated: input.outcome.isolated,
        ...(input.outcome.reason ? { reason: input.outcome.reason } : {}),
      },
      input.context,
    ),
  });
}

/**
 * Remembers the session id a runtime just reported, so the next execution of
 * this stage in the same worktree can continue it, and records what happened.
 */
function recordAgentSession(input: {
  sessions: Map<string, string> | undefined;
  stageId: string;
  eventStore: EventStore;
  runId: string;
  attempt: number;
  outcome?: AgentSessionOutcome;
  context: RuntimeContext;
}): void {
  if (!input.outcome) return;
  if (input.outcome.sessionId) {
    input.sessions?.set(input.stageId, input.outcome.sessionId);
  } else {
    input.sessions?.delete(input.stageId);
  }
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.runtime.session",
    payload: redactRuntimeUnknown(
      {
        mode: input.outcome.mode,
        ...(input.outcome.sessionId ? { sessionId: input.outcome.sessionId } : {}),
        ...(input.outcome.reason ? { reason: input.outcome.reason } : {}),
      },
      input.context,
    ),
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
  const stdout = redactRuntimeText(input.result.stdout, input.context) ?? "";
  const stderr = redactRuntimeText(input.result.stderr, input.context) ?? "";
  const command = redactRuntimeText(input.command, input.context) ?? "";
  const stdoutPath = join(input.attemptDirectory, "stdout.log");
  const stderrPath = join(input.attemptDirectory, "stderr.log");
  const outputSummary = summarizeToolOutput({
    stdout,
    stderr,
    maxToolOutputTokens: input.maxToolOutputTokens,
    stdoutPath,
    stderrPath,
  });
  const writtenStdoutPath = await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    filename: "stdout.log",
    content: stdout,
  });
  const writtenStderrPath = await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    filename: "stderr.log",
    content: stderr,
  });
  const outputPath = await writeAttemptOwnedFile({
    runDirectory: input.context.runDirectory,
    attemptDirectory: input.attemptDirectory,
    filename: "output.md",
    content: [
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
  });
  return {
    stdoutPath: writtenStdoutPath,
    stderrPath: writtenStderrPath,
    outputPath,
    outputSummary,
  };
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

function assertRehydratedArtifactIntegrity(input: {
  current: RunArtifact;
  existing: RunArtifact;
}): void {
  const subject = `artifact ${input.current.id}`;
  const expectedSha256 = (input.existing as { sha256?: unknown }).sha256;
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(expectedSha256))
  ) {
    throw new RunOwnedFileIntegrityError(
      `${subject} has invalid sha256 registry metadata`,
    );
  }
  if (
    typeof expectedSha256 === "string" &&
    expectedSha256.toLowerCase() !== input.current.sha256
  ) {
    throw new RunOwnedFileIntegrityError(
      `${subject} sha256 does not match its registry metadata`,
    );
  }

  const expectedSize = (input.existing as { size?: unknown }).size;
  if (
    expectedSize !== undefined &&
    (typeof expectedSize !== "number" ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0)
  ) {
    throw new RunOwnedFileIntegrityError(
      `${subject} has invalid size registry metadata`,
    );
  }
  if (
    typeof expectedSize === "number" &&
    expectedSize !== input.current.size
  ) {
    throw new RunOwnedFileIntegrityError(
      `${subject} size does not match its registry metadata`,
    );
  }
}

function recordGeneratedMarkdownArtifact(input: {
  inputs: Map<string, InputArtifact>;
  id: string;
  contentPath: string;
  content: string | Buffer;
  mediaType?: string;
  manifestSource?: ValidatedAttemptOutput["manifestSource"];
  producerStageId?: string;
  attempt?: number;
  contract?: ArtifactContract;
  context?: RuntimeContext;
  eventStore?: EventStore;
  deferredEvents?: Array<Parameters<EventStore["append"]>[0]>;
  eventStageId?: string | null;
  rehydrateExisting?: boolean;
}): void {
  const mediaType = input.mediaType ?? input.contract?.mediaType ?? "text/markdown";
  const filename = basename(input.contentPath);
  const contentSnapshot = Buffer.isBuffer(input.content)
    ? Buffer.from(input.content)
    : Buffer.from(input.content, "utf8");
  let relativePath: string | undefined;
  let artifact: RunArtifact | undefined;
  let existing: RunArtifact | undefined;
  if (input.context) {
    relativePath = manifestRunRelativePath(
      input.context.runDirectory,
      input.contentPath,
    );
    artifact = withProvenance(
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
      contentSnapshot,
      {
        runId: input.context.runId,
        stageId: input.producerStageId,
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
    );
    const existingIndex = input.context.artifactEntryIndexes.get(
      artifactEntryKey(artifact),
    );
    existing =
      existingIndex === undefined
        ? undefined
        : input.context.artifactEntries[existingIndex];
    if (input.rehydrateExisting && existing) {
      assertRehydratedArtifactIntegrity({ current: artifact, existing });
    }
  }

  // Do not expose restored bytes to downstream stages until any persisted
  // integrity constraints have been checked against this exact snapshot.
  input.inputs.set(input.id, {
    id: input.id,
    reference: { connector: "generated", uri: input.contentPath },
    resource: {
      sourceUri: input.contentPath,
      mediaType,
      content: contentSnapshot,
      metadata: { filename },
    },
    contentPath: input.contentPath,
  });
  if (input.context && artifact) {
    if (input.rehydrateExisting && existing) {
      upsertArtifactEntry(input.context, {
        ...artifact,
        ...existing,
        createdAt: existing.createdAt ?? artifact.createdAt,
      });
    } else {
      const eventCreatedAt = artifact.createdAt ?? new Date().toISOString();
      artifact = { ...artifact, createdAt: eventCreatedAt };
      const eventInput: Parameters<EventStore["append"]>[0] = {
        runId: input.context.runId,
        type: "artifact.published",
        payload: redactRuntimeUnknown({ artifact }, input.context),
        createdAt: eventCreatedAt,
      };
      const eventStageId =
        input.eventStageId === null
          ? undefined
          : input.eventStageId ?? input.producerStageId;
      if (eventStageId !== undefined) {
        eventInput.stageId = eventStageId;
      }
      let event: ReturnType<EventStore["append"]> | undefined;
      if (input.deferredEvents) {
        input.deferredEvents.push(eventInput);
      } else {
        event = input.eventStore?.append(eventInput);
      }
      upsertArtifactEntry(input.context, {
        ...artifact,
        createdAt: event?.createdAt ?? eventCreatedAt,
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
  const artifact = withProvenance(
    {
      ...contract,
      id: input.result.id,
      type: "gate.result",
      schema: GATE_RESULT_ARTIFACT_SCHEMA,
      producer: input.stage.id,
      mediaType: "application/json",
      path: relativePath,
      sourceUri: relativePath ?? filename,
      filename,
      createdAt: input.result.createdAt,
      gateResult: input.result,
    },
    content,
    {
      runId: input.context.runId,
      stageId: input.stage.id,
      ...(input.result.attempt !== undefined
        ? { attempt: input.result.attempt }
        : {}),
    },
  );
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
  metadataUpdate?: UpdateChangeRequestResult["metadataUpdate"];
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
      if (input.changeRequest.metadataUpdate) {
        lines.push(
          `Metadata update: ${input.changeRequest.metadataUpdate.outcome}`,
          `Metadata transport: ${input.changeRequest.metadataUpdate.transport}`,
          `Metadata fields: ${input.changeRequest.metadataUpdate.fields.join(", ")}`,
        );
      }
    }
    if (input.metadataUpdate) {
      lines.push(
        `Metadata update: ${input.metadataUpdate.outcome}`,
        `Metadata transport: ${input.metadataUpdate.transport}`,
        `Metadata fields: ${input.metadataUpdate.fields.join(", ")}`,
      );
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
  const { content } = await readRunOwnedFile({
    runDirectory: input.runDirectory,
    path: input.contentPath,
    subject: `generated artifact ${input.id} path`,
  });
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

function restoreValidatedOutputPublicationState(input: {
  inputs: Map<string, InputArtifact>;
  inputEntries: Array<[string, InputArtifact]>;
  context: RuntimeContext;
  manifestEntries: ContextManifestEntry[];
  manifestEntryIndexes: Map<string, number>;
  artifactEntries: RunArtifact[];
  artifactEntryIndexes: Map<string, number>;
}): void {
  input.inputs.clear();
  for (const [id, artifact] of input.inputEntries) {
    input.inputs.set(id, artifact);
  }
  input.context.manifestEntries = input.manifestEntries;
  input.context.manifestEntryIndexes = input.manifestEntryIndexes;
  input.context.artifactEntries = input.artifactEntries;
  input.context.artifactEntryIndexes = input.artifactEntryIndexes;
}

async function recordValidatedAttemptOutputs(input: {
  inputs: Map<string, InputArtifact>;
  stage: Stage;
  attempt?: number;
  runDirectory: string;
  outputs: ValidatedAttemptOutput[];
  context: RuntimeContext;
  eventStore?: EventStore;
  rehydrateExisting?: boolean;
}): Promise<void> {
  if (input.outputs.length === 0) return;
  const contracts = new Map(
    input.stage.outputs.map((output) => {
      const contract = outputContract(output);
      return [contract.id, contract] as const;
    }),
  );
  const inputEntries = [...input.inputs.entries()];
  const manifestEntries = [...input.context.manifestEntries];
  const manifestEntryIndexes = new Map(input.context.manifestEntryIndexes);
  const artifactEntries = [...input.context.artifactEntries];
  const artifactEntryIndexes = new Map(input.context.artifactEntryIndexes);
  const deferredEvents: Array<Parameters<EventStore["append"]>[0]> = [];
  const persist = async (): Promise<void> => {
    for (const output of input.outputs) {
      requirePathInside(
        input.runDirectory,
        output.absolutePath,
        "validated attempt output",
      );
      recordGeneratedMarkdownArtifact({
        inputs: input.inputs,
        id: output.id,
        contentPath: output.absolutePath,
        content: output.content,
        mediaType: output.mediaType,
        manifestSource: output.manifestSource,
        producerStageId: input.stage.id,
        attempt: input.attempt,
        contract: contracts.get(output.id),
        context: input.context,
        eventStore: input.eventStore,
        deferredEvents: input.eventStore ? deferredEvents : undefined,
        rehydrateExisting: input.rehydrateExisting,
      });
    }
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
  };
  try {
    await persist();
    const eventStore = input.eventStore;
    if (eventStore && deferredEvents.length > 0) {
      eventStore.transaction(() => {
        for (const event of deferredEvents) {
          eventStore.append(event);
        }
      });
    }
  } catch (error) {
    restoreValidatedOutputPublicationState({
      inputs: input.inputs,
      inputEntries,
      context: input.context,
      manifestEntries,
      manifestEntryIndexes,
      artifactEntries,
      artifactEntryIndexes,
    });
    // The Artifact registry is a bound public/private pair on current master.
    // Re-materialize the restored in-memory state through its owning writers;
    // restoring only artifacts.json could strand or mismatch its private sidecar.
    await Promise.allSettled([
      persistContextManifest(input.context),
      persistArtifactRegistry(input.context),
    ]);
    throw error;
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
 * Runtime guard (defense in depth): a protected action stage for a high-risk or
 * approval-required work item type cannot run unless an approved gate exists in
 * this run. This holds even when flow-load governance was bypassed.
 */
async function assertProtectedStageGate(input: {
  repoPath: string;
  workItemType?: string;
  stage: Stage;
  context: RuntimeContext;
}): Promise<void> {
  if (!input.workItemType) {
    return;
  }
  const policy = await resolveEffectiveWorkItemTypePolicy({
    repoPath: input.repoPath,
    workItemType: input.workItemType,
    hasProtectedStage: true,
  });
  if (policy.decision === "deny") {
    throw new Error(policyDeniedMessage(input.workItemType, policy));
  }
  if (!policy.highRisk) {
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
 * Classify what this run actually changed and enforce the repository's review
 * policy for that class before a protected stage publishes it.
 *
 * Declared intent alone under-describes accountability: a nominally low-risk
 * task can produce a diff that touches authentication, payments, migrations,
 * or dependency manifests. The classification is recomputed from the current
 * diff at every publication decision, so rework cannot inherit a verdict its
 * diff no longer earns, and it is recorded as a run event so the console, the
 * approval inbox, and the change request can all say why a human is needed.
 */
async function classifyAndEnforceChangeRisk(input: {
  runId: string;
  stage: Extract<Stage, { type: "publish-change" | "update-change" }>;
  attempt: number;
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  workItemType?: string;
  context: RuntimeContext;
  eventStore: EventStore;
}): Promise<ChangeRiskEvaluation> {
  const highRiskWorkItemType = input.workItemType
    ? (
        await resolveEffectiveWorkItemTypePolicy({
          repoPath: input.repoPath,
          workItemType: input.workItemType,
          hasProtectedStage: true,
        })
      ).highRisk
    : undefined;
  const evaluation = await evaluateChangeRisk({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    ...(input.workItemType ? { workItemType: input.workItemType } : {}),
    ...(highRiskWorkItemType !== undefined ? { highRiskWorkItemType } : {}),
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "run.risk.classified",
    payload: redactRuntimeUnknown(
      {
        classification: evaluation.classification,
        requirement: evaluation.requirement,
        policyConfigured: evaluation.policyConfigured,
        ...(evaluation.codeOwnersPath
          ? { codeOwnersPath: evaluation.codeOwnersPath }
          : {}),
      },
      input.context,
    ),
  });
  if (!evaluation.requirement.requireRunApproval) {
    return evaluation;
  }
  const approved = input.context.artifactEntries.some(
    (artifact) =>
      artifact.type === "gate.approval" && artifact.gate?.state === "approved",
  );
  if (!approved) {
    throw new Error(
      `stage "${input.stage.id}" (${input.stage.type}) requires an approved gate: ${evaluation.classification.explanation} ${REVIEW_POLICY_RELATIVE_PATH} prohibits publishing a ${evaluation.classification.effective}-risk change unattended`,
    );
  }
  return evaluation;
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

async function rehydrateCompletedRegisteredArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stages: Stage[];
  completedStages: string[];
  runDirectory: string;
  context: RuntimeContext;
  eventStore?: EventStore;
}): Promise<Set<string>> {
  const completed = new Set(input.completedStages);
  const verified: Array<{
    stageId: string;
    contract: ArtifactContract;
    artifact: RunArtifact;
    contentPath: string;
    content: Buffer;
  }> = [];
  for (const stage of input.stages) {
    if (!completed.has(stage.id)) continue;
    for (const declaration of stage.outputs) {
      const contract = outputContract(declaration);
      const artifact = input.context.artifactEntries.find(
        (candidate) =>
          candidate.producer === stage.id && candidate.id === contract.id,
      );
      if (!artifact?.path) continue;
      const materialized = await readMaterializedArtifact({
        runDirectory: input.runDirectory,
        boundaryRoot: input.context.repoPath,
        artifact,
      });
      const contentBuffer = materialized.content;
      const gateResultCompatibility =
        artifact.type === "gate.result" &&
        artifact.gateResult?.id === contract.id &&
        artifact.gateResult.stageId === stage.id;
      const expectedMediaType = gateResultCompatibility
        ? "application/json"
        : contract.mediaType;
      if (
        expectedMediaType !== undefined &&
        artifact.mediaType !== expectedMediaType
      ) {
        throw new Error(
          `registered artifact ${stage.id}/${contract.id} media type ${artifact.mediaType} does not match ${expectedMediaType}`,
        );
      }
      const content = contentBuffer.toString("utf8");
      const expectedSchema = gateResultCompatibility
        ? GATE_RESULT_ARTIFACT_SCHEMA
        : contract.schema;
      if (expectedSchema !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (error) {
          const detail = error instanceof Error ? `: ${error.message}` : "";
          throw new Error(
            `registered artifact ${stage.id}/${contract.id} is not valid JSON${detail}`,
          );
        }
        const result = validateAgainstSchema(expectedSchema, parsed);
        if (!result.valid) {
          throw new Error(
            `registered artifact ${stage.id}/${contract.id} failed schema validation: ${result.errors.join("; ")}`,
          );
        }
        if (gateResultCompatibility) {
          const parsedGate = parsed as { id?: unknown; stageId?: unknown };
          if (
            parsedGate.id !== contract.id ||
            parsedGate.stageId !== stage.id
          ) {
            throw new Error(
              `registered artifact ${stage.id}/${contract.id} failed gate result identity validation`,
            );
          }
        }
      }
      verified.push({
        stageId: stage.id,
        contract,
        artifact,
        contentPath: join(input.runDirectory, materialized.relativePath),
        content: contentBuffer,
      });
    }
  }
  for (const artifact of verified) {
    recordGeneratedMarkdownArtifact({
      inputs: input.inputs,
      id: artifact.contract.id,
      contentPath: artifact.contentPath,
      content: artifact.content,
      mediaType: artifact.artifact.mediaType,
      manifestSource: artifact.artifact.manifestSource,
      producerStageId: artifact.stageId,
      contract: artifact.contract,
      context: input.context,
      eventStore: input.eventStore,
      rehydrateExisting: true,
    });
  }
  if (verified.length > 0) {
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
  }
  return new Set(
    verified.map((artifact) =>
      artifactEntryKey({
        producer: artifact.stageId,
        id: artifact.contract.id,
      }),
    ),
  );
}

async function rehydrateCompletedSyncArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stages: Stage[];
  completedStages: string[];
  runDirectory: string;
  syncMetadata: unknown;
  context: RuntimeContext;
  eventStore?: EventStore;
  restoredArtifacts: ReadonlySet<string>;
}): Promise<void> {
  const sync = recordValue(input.syncMetadata);
  const reportPath = sync.reportPath;
  if (typeof reportPath !== "string") return;

  let rehydrated = false;
  for (const stage of input.stages) {
    if (stage.type !== "sync-change") continue;
    if (!input.completedStages.includes(stage.id)) continue;
    for (const output of stage.outputs) {
      const id = outputId(output);
      if (
        input.restoredArtifacts.has(
          artifactEntryKey({ producer: stage.id, id }),
        )
      ) {
        continue;
      }
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
      rehydrated = true;
    }
  }
  if (rehydrated) {
    await persistContextManifest(input.context);
    await persistArtifactRegistry(input.context);
  }
}

async function rehydrateCompletedAgentTextArtifacts(input: {
  inputs: Map<string, InputArtifact>;
  stages: Stage[];
  projection: ReturnType<typeof projectRun>;
  runDirectory: string;
  context: RuntimeContext;
  eventStore?: EventStore;
  restoredArtifacts: ReadonlySet<string>;
}): Promise<void> {
  for (const stage of input.stages) {
    if (stage.type !== "agent") continue;
    if (!input.projection.completedStages.includes(stage.id)) continue;
    const missingOutputIds = new Set(
      stage.outputs
        .map(outputId)
        .filter(
          (id) =>
            !input.restoredArtifacts.has(
              artifactEntryKey({ producer: stage.id, id }),
            ),
        ),
    );
    if (missingOutputIds.size === 0) continue;
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
      outputs: validatedOutputs.outputs.filter((output) =>
        missingOutputIds.has(output.id),
      ),
      context: input.context,
      eventStore: input.eventStore,
      rehydrateExisting: true,
    });
  }
}

async function rehydrateOperatorReviewGateArtifact(input: {
  inputs: Map<string, InputArtifact>;
  gate: GateResult | undefined;
  runDirectory: string;
  context: RuntimeContext;
}): Promise<void> {
  const gate = input.gate;
  if (!gate?.operatorReview || gate.attempt === undefined) return;
  const expectedContentPath = join(
    input.runDirectory,
    "stages",
    gate.stageId,
    String(gate.attempt),
    `${gate.id}.json`,
  );
  requirePathInside(
    input.runDirectory,
    expectedContentPath,
    "operator review gate artifact",
  );
  const expectedRelativePath = manifestRunRelativePath(
    input.runDirectory,
    expectedContentPath,
  );
  const artifact = input.context.artifactEntries.find(
    (candidate) =>
      candidate.id === gate.id && candidate.producer === gate.stageId,
  );
  if (artifact && artifact.path !== expectedRelativePath) {
    throw new RunOwnedFileIntegrityError(
      `operator review gate ${gate.id} path does not match its registry metadata`,
    );
  }
  const materialized = artifact
    ? await readMaterializedArtifact({
        runDirectory: input.runDirectory,
        boundaryRoot: input.context.repoPath,
        artifact,
      })
    : await readRunOwnedFile({
        runDirectory: input.runDirectory,
        path: expectedContentPath,
        subject: `operator review gate ${gate.id} path`,
      });
  const content = materialized.content;
  const sourceUri = materialized.relativePath;
  const contentPath = join(input.runDirectory, materialized.relativePath);
  input.inputs.set(gate.id, {
    id: gate.id,
    reference: { connector: "generated", uri: contentPath },
    resource: {
      sourceUri,
      mediaType: "application/json",
      content,
      metadata: { filename: basename(contentPath) },
    },
    contentPath,
  });
}

function validReworkTargetsForStage(
  stage: Stage,
  producerByArtifact: Map<string, string>,
): Set<string> {
  return new Set(
    stage.inputs.filter((artifact) => producerByArtifact.has(artifact)),
  );
}

function validReworkStagesForStage(stageId: string, graph: FlowGraph): Set<string> {
  const valid = new Set<string>([stageId]);
  const pending = [...(graph.predecessors.get(stageId) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || valid.has(current)) continue;
    valid.add(current);
    pending.push(...(graph.predecessors.get(current) ?? []));
  }
  return valid;
}

function artifactProducerStage(
  artifactId: string | undefined,
  graph: FlowGraph,
): string | undefined {
  return artifactId ? graph.producerByArtifact.get(artifactId) : undefined;
}

function reviewTargetCandidates(
  stage: Pick<Stage, "inputs">,
  graph: FlowGraph,
  validReworkStages: ReadonlySet<string>,
): Array<{ targetArtifact: string; targetStage: string }> {
  return stage.inputs
    .map((artifact) => {
      const producer = graph.producerByArtifact.get(artifact);
      return producer && validReworkStages.has(producer)
        ? { targetArtifact: artifact, targetStage: producer }
        : undefined;
    })
    .filter(
      (candidate): candidate is { targetArtifact: string; targetStage: string } =>
        candidate !== undefined,
    );
}

function reviewTargetLooksSpecLike(value: string): boolean {
  return /\b(spec|plan|design|requirement|brief)\b/i.test(value);
}

function inferReviewReworkTarget(input: {
  stage: Pick<Stage, "inputs">;
  verdict: ReviewGateVerdictRouting;
  graph: FlowGraph;
  validReworkStages: ReadonlySet<string>;
}): { targetStage?: string; targetArtifact?: string } {
  const artifactProducer = artifactProducerStage(
    input.verdict.targetArtifact,
    input.graph,
  );
  if (input.verdict.targetStage) {
    const matchingArtifact = reviewTargetCandidates(
      input.stage,
      input.graph,
      input.validReworkStages,
    ).find((candidate) => candidate.targetStage === input.verdict.targetStage);
    return {
      targetStage: input.verdict.targetStage,
      targetArtifact: input.verdict.targetArtifact ?? matchingArtifact?.targetArtifact,
    };
  }
  if (artifactProducer) {
    return {
      targetStage: artifactProducer,
      targetArtifact: input.verdict.targetArtifact,
    };
  }

  const candidates = reviewTargetCandidates(
    input.stage,
    input.graph,
    input.validReworkStages,
  );
  const preferred =
    input.verdict.verdict === "needs_rework_spec"
      ? candidates.find(
          (candidate) =>
            reviewTargetLooksSpecLike(candidate.targetArtifact) ||
            reviewTargetLooksSpecLike(candidate.targetStage),
        )
      : candidates.find(
          (candidate) =>
            !reviewTargetLooksSpecLike(candidate.targetArtifact) &&
            !reviewTargetLooksSpecLike(candidate.targetStage),
        );
  return preferred ?? candidates[0] ?? {};
}

/**
 * Artifacts a failing review may send back for rework. An aggregating gate
 * also consumes its perspectives' review outputs; those are reviewer results,
 * not work, so they are never rework targets.
 */
function reviewReworkInputs(
  stage: Extract<Stage, { type: "gate"; mode: "review" | "review-aggregate" }>,
): { inputs: string[] } {
  return {
    inputs:
      stage.mode === "review-aggregate"
        ? stage.inputs.filter((id) => !stage.perspectives.includes(id))
        : stage.inputs,
  };
}

function reviewGateVerdictRecommendation(input: {
  stage: Extract<Stage, { type: "gate"; mode: "review" | "review-aggregate" }>;
  gateResult: GateResult;
  graph: FlowGraph;
  validReworkStages: ReadonlySet<string>;
}): OrchestratorRecommendation | undefined {
  const verdict = input.gateResult.reviewOutput?.verdict;
  if (!verdict || verdict.verdict === "approved" || verdict.verdict === "pass") return undefined;
  const reason =
    verdict.reason ??
    input.gateResult.reason ??
    `review gate ${input.stage.id} returned ${verdict.verdict}`;
  if (verdict.verdict === "escalate") {
    return { action: "escalate", reason };
  }

  const target = inferReviewReworkTarget({
    stage: reviewReworkInputs(input.stage),
    verdict: {
      ...verdict,
      targetArtifact: verdict.targetArtifact ?? verdict.reworkTarget,
    },
    graph: input.graph,
    validReworkStages: input.validReworkStages,
  });
  if (!target.targetStage && !target.targetArtifact) {
    return {
      action: "escalate",
      reason: `review verdict ${verdict.verdict} did not identify a legal rework target`,
    };
  }
  const targetLabel =
    target.targetStage ??
    (target.targetArtifact ? `artifact ${target.targetArtifact}` : "upstream");
  const common = {
    reason,
    instructions:
      verdict.instructions ??
      `Address review verdict ${verdict.verdict} in ${targetLabel}.`,
    context: [
      `Review gate ${input.stage.id} returned ${verdict.verdict}.`,
      input.gateResult.reviewOutput?.path
        ? `Review output: ${input.gateResult.reviewOutput.path}.`
        : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" "),
    ...(verdict.specificIssues ? { specificIssues: verdict.specificIssues } : {}),
  };
  if (target.targetStage) {
    return {
      action: "rework",
      targetStage: target.targetStage,
      ...(target.targetArtifact ? { targetArtifact: target.targetArtifact } : {}),
      ...common,
    };
  }
  return {
    action: "rework",
    targetArtifact: target.targetArtifact!,
    ...common,
  };
}

function judgeRecommendation(input: {
  stage: Extract<Stage, { type: "judge" }>;
  result: JudgeResult;
  graph: FlowGraph;
  validReworkStages: ReadonlySet<string>;
}): OrchestratorRecommendation | undefined {
  if (input.result.verdict === "PASS") return undefined;
  if (input.result.verdict === "HUMAN_REVIEW") {
    return {
      action: "escalate",
      reason:
        input.result.humanReviewReason ??
        (input.result.findings.join("; ") ||
          `judge ${input.stage.id} requires human review`),
    };
  }

  const requested = input.result.reworkTarget ?? input.stage.onRework;
  const targetStage = requested && input.validReworkStages.has(requested)
    ? requested
    : requested
      ? artifactProducerStage(requested, input.graph)
      : undefined;
  if (!targetStage || !input.validReworkStages.has(targetStage)) {
    return {
      action: "escalate",
      reason: `judge ${input.stage.id} requested rework without a legal configured target`,
    };
  }
  const targetArtifact = input.graph.producerByArtifact.get(requested ?? "") === targetStage
    ? requested
    : undefined;
  const findings = input.result.findings.length > 0
    ? `Findings: ${input.result.findings.join("; ")}`
    : undefined;
  const evidence = input.result.evidence.length > 0
    ? `Evidence: ${input.result.evidence.join("; ")}`
    : undefined;
  return {
    action: "rework",
    targetStage,
    ...(targetArtifact ? { targetArtifact } : {}),
    reason: findings ?? `judge ${input.stage.id} requested rework`,
    instructions: input.result.reworkInstructions ?? findings,
    context: [findings, evidence].filter((part): part is string => part !== undefined).join(" "),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function structuredReworkRequest(input: {
  stage: Stage;
  attempt: number;
  error: string;
  graph: FlowGraph;
  recommendation?: OrchestratorRecommendation;
  legacyTarget?: string;
}): ReworkRequest | undefined {
  const source = {
    sourceStage: input.stage.id,
    sourceAttempt: input.attempt,
  };
  if (input.recommendation?.action === "rework") {
    const targetArtifact = normalizeOptionalText(input.recommendation.targetArtifact);
    const targetStage =
      normalizeOptionalText(input.recommendation.targetStage) ??
      artifactProducerStage(targetArtifact, input.graph);
    if (!targetStage) return undefined;
    const reason =
      normalizeOptionalText(input.recommendation.reason) ??
      (targetArtifact
        ? `rework requested for ${targetArtifact} after attempt ${input.attempt}: ${input.error}`
        : `rework requested for stage ${targetStage} after attempt ${input.attempt}: ${input.error}`);
    return {
      targetStage,
      reason,
      ...(targetArtifact ? { targetArtifact } : {}),
      ...(normalizeOptionalText(input.recommendation.instructions)
        ? { instructions: normalizeOptionalText(input.recommendation.instructions) }
        : {}),
      ...(normalizeOptionalText(input.recommendation.context)
        ? { context: normalizeOptionalText(input.recommendation.context) }
        : {}),
      ...(input.recommendation.specificIssues &&
      input.recommendation.specificIssues.length > 0
        ? { specificIssues: input.recommendation.specificIssues }
        : {}),
      ...source,
    };
  }

  const targetArtifact = normalizeOptionalText(input.legacyTarget);
  const targetStage = artifactProducerStage(targetArtifact, input.graph);
  if (!targetArtifact || !targetStage) return undefined;
  return {
    targetStage,
    targetArtifact,
    reason: `rework requested for ${targetArtifact} after attempt ${input.attempt}: ${input.error}`,
    ...source,
  };
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
    targetStage:
      input.decision.action === "rework"
        ? input.decision.targetStage
        : undefined,
    targetArtifact:
      input.decision.action === "rework"
        ? input.decision.targetArtifact
        : undefined,
    reworkRequest:
      input.decision.action === "rework"
        ? input.decision.reworkRequest
        : undefined,
    ...(input.decision.action === "fail" && input.decision.oscillation
      ? { oscillation: input.decision.oscillation }
      : {}),
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

function appendVerificationFailureDiagnosis(input: {
  eventStore: EventStore;
  runId: string;
  diagnosis: VerificationFailureDiagnosis;
  context: RuntimeContext;
}): void {
  const { recommendation: _recommendation, ...payload } = input.diagnosis;
  input.eventStore.append({
    runId: input.runId,
    stageId: input.diagnosis.stageId,
    attempt: input.diagnosis.attempt,
    type: "verification.failure.diagnosed",
    payload: redactRuntimeUnknown(payload, input.context),
  });
}

function applyFailedStagePolicy(input: {
  stage: Extract<Stage, { type: "agent" | "judge" | "command" | "gate" }>;
  attempt: number;
  maxAttempts: number;
  flowMaxAttempts?: number;
  diagnosisAttempt?: number;
  error: string;
  builtInRecommendation?: OrchestratorRecommendation;
  dependencies: RunFlowDependencies;
  stages: Stage[];
  graph: FlowGraph;
  attemptsByStage: Map<string, number>;
  previousFailuresByStage: Map<string, PreviousFailure[]>;
  completedStages: string[];
  reworkEdges: ReworkEdge[];
  eventStore: EventStore;
  runId: string;
  context: RuntimeContext;
}):
  | { action: "retry" }
  | { action: "rework"; stageIndex: number; request: ReworkRequest } {
  const validReworkTargets = validReworkTargetsForStage(
    input.stage,
    input.graph.producerByArtifact,
  );
  const validReworkStages = validReworkStagesForStage(
    input.stage.id,
    input.graph,
  );
  const diagnosed = diagnoseVerificationFailure({
    stage: input.stage,
    stages: input.stages,
    graph: input.graph,
    attempt: input.diagnosisAttempt ?? input.attempt,
    maxAttempts: input.maxAttempts,
    error: input.error,
    validReworkTargets,
    validReworkStages,
  });
  const verificationDiagnosis = diagnosed
    ? { ...diagnosed, attempt: input.attempt }
    : undefined;
  if (verificationDiagnosis) {
    appendVerificationFailureDiagnosis({
      eventStore: input.eventStore,
      runId: input.runId,
      diagnosis: verificationDiagnosis,
      context: input.context,
    });
  }
  const recommendation = input.dependencies.recommendOrchestration?.({
    stage: input.stage,
    attempt: input.attempt,
    error: input.error,
    validReworkTargets,
    validReworkStages,
  }) ?? input.builtInRecommendation ?? verificationDiagnosis?.recommendation;
  const reworkTarget =
    recommendation === undefined
      ? input.dependencies.recommendRework?.({
          stage: input.stage,
          attempt: input.attempt,
          error: input.error,
          validReworkTargets,
          validReworkStages,
        })
      : undefined;
  const reworkRequest = structuredReworkRequest({
    stage: input.stage,
    attempt: input.attempt,
    error: input.error,
    graph: input.graph,
    recommendation,
    legacyTarget: reworkTarget,
  });
  const decision = decideStagePolicy({
    stageType: input.stage.type,
    succeeded: false,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    ...(input.stage.type === "judge" && input.stage.maxRework !== undefined
      ? { maxRework: input.stage.maxRework }
      : {}),
    error: input.error,
    reworkRequest,
    recommendation,
    reworkTarget,
    validReworkTargets,
    validReworkStages,
    sourceStage: input.stage.id,
    sourceAttempt: input.attempt,
    reworkEdges: input.reworkEdges,
  });
  appendOrchestratorDecision({
    eventStore: input.eventStore,
    runId: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    decision,
    context: input.context,
    error: input.error,
  });

  if (decision.action === "retry") {
    const previousFailures =
      input.previousFailuresByStage.get(input.stage.id) ?? [];
    previousFailures.push({ attempt: input.attempt, error: input.error });
    input.previousFailuresByStage.set(input.stage.id, previousFailures);
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "stage.retrying",
      payload: redactRuntimeUnknown(
        { reason: decision.reason, nextAttempt: input.attempt + 1 },
        input.context,
      ),
    });
    return { action: "retry" };
  }

  if (decision.action === "complete") {
    throw new Error("policy returned complete for a failed stage");
  }
  if (decision.action === "escalate") {
    const escalated = `escalated: ${decision.reason}`;
    input.eventStore.append({
      runId: input.runId,
      type: "run.failed",
      payload: redactRuntimeUnknown(
        { stageId: input.stage.id, error: escalated },
        input.context,
      ),
    });
    throw new Error(escalated);
  }
  if (decision.action === "rework") {
    const request = decision.reworkRequest;
    const targetStageId = request.targetStage;
    const targetIndex = input.graph.order.indexOf(targetStageId);
    if (!targetStageId || targetIndex < 0) {
      throw new Error(`rework target stage not found: ${targetStageId}`);
    }
    if (!validReworkStages.has(targetStageId)) {
      throw new Error(`invalid rework target stage: ${targetStageId}`);
    }
    const targetArtifactProducer = artifactProducerStage(
      request.targetArtifact,
      input.graph,
    );
    if (
      request.targetArtifact &&
      targetArtifactProducer !== targetStageId
    ) {
      throw new Error(
        `rework target artifact ${request.targetArtifact} is produced by ${targetArtifactProducer ?? "unknown"}, not ${targetStageId}`,
      );
    }
    const targetStage = input.stages.find(
      (candidate) => candidate.id === targetStageId,
    );
    if (!targetStage) {
      throw new Error(`rework target stage not found: ${targetStageId}`);
    }
    const targetMaxAttempts = maxAttemptsForStage(
      targetStage,
      input.flowMaxAttempts,
    );
    const targetNextAttempt = (input.attemptsByStage.get(targetStageId) ?? 0) + 1;
    if (targetNextAttempt > targetMaxAttempts) {
      const reason = `rework target stage ${targetStageId} has exhausted attempts`;
      appendOrchestratorDecision({
        eventStore: input.eventStore,
        runId: input.runId,
        stage: input.stage,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        decision: { action: "fail", reason },
        context: input.context,
        error: input.error,
      });
      input.eventStore.append({
        runId: input.runId,
        type: "run.failed",
        payload: redactRuntimeUnknown(
          { stageId: input.stage.id, error: reason },
          input.context,
        ),
      });
      throw new Error(reason);
    }
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "stage.rework.requested",
      payload: redactRuntimeUnknown(
        {
          reworkRequest: request,
          targetStage: targetStageId,
          targetArtifact: request.targetArtifact,
          reason: decision.reason,
        },
        input.context,
      ),
    });
    input.reworkEdges.push({ from: input.stage.id, to: targetStageId });
    const targetFailures =
      input.previousFailuresByStage.get(targetStageId) ?? [];
    const detail = [
      `downstream stage ${input.stage.id} requested rework of stage ${targetStageId}`,
      request.targetArtifact ? `artifact ${request.targetArtifact}` : undefined,
      decision.reason,
      request.instructions ? `instructions: ${request.instructions}` : undefined,
      request.context ? `context: ${request.context}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(": ");
    targetFailures.push({
      attempt: input.attemptsByStage.get(targetStageId) ?? 1,
      error: detail,
    });
    input.previousFailuresByStage.set(targetStageId, targetFailures);
    invalidateCompletedStagesFrom(
      input.completedStages,
      input.graph.order,
      targetIndex,
    );
    return { action: "rework", stageIndex: targetIndex, request };
  }

  input.eventStore.append({
    runId: input.runId,
    type: "run.failed",
    payload: redactRuntimeUnknown(
      {
        stageId: input.stage.id,
        error: decision.reason,
        ...(decision.oscillation ? { oscillation: decision.oscillation } : {}),
      },
      input.context,
    ),
  });
  throw new Error(decision.reason);
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

function manifestKindForInputReference(
  reference: ResourceReference,
): ContextManifestEntry["kind"] {
  return reference.connector === "google-drive"
    ? "connector-context"
    : "external-input";
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
  const localFileAllowedRoots = [process.cwd()];
  const registry = new ConnectorRegistry([
    new LocalFileConnector(input.repoPath, {
      allowedRoots: localFileAllowedRoots,
    }),
    new NitelyArtifactConnector(input.repoPath),
    new SourceUrlConnector(),
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
      const resolved = await resolveLocalFileResource(
        input.repoPath,
        reference,
        { allowedRoots: localFileAllowedRoots },
      );
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
    const manifestKind = manifestKindForInputReference(reference);
    const fetchedAt = new Date().toISOString();
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
      metadata: {
        ...resource.metadata,
        filename,
      },
    };
    await writeFile(
      join(inputDirectory, "metadata.json"),
      JSON.stringify(
        {
          sourceUri: artifactResource.sourceUri,
          mediaType: artifactResource.mediaType,
          revision: artifactResource.revision,
          fetchedAt,
          metadata: artifactResource.metadata,
        },
        null,
        2,
      ),
      "utf8",
    );
    inputs.set(id, { id, reference, resource: artifactResource, contentPath });
    const runRelativeSnapshotPath = manifestRunRelativePath(input.runDirectory, contentPath);
    const originAttempt = artifactResource.metadata?.originAttempt
      ? Number(artifactResource.metadata.originAttempt)
      : undefined;
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
          createdAt: fetchedAt,
          ...(artifactResource.metadata?.originRunId
            ? { createdByRunId: artifactResource.metadata.originRunId }
            : {}),
          ...(artifactResource.metadata?.originStageId
            ? { stageId: artifactResource.metadata.originStageId }
            : {}),
          ...(originAttempt !== undefined && Number.isFinite(originAttempt)
            ? { attempt: originAttempt }
            : {}),
        },
        resource.content,
        { runId: input.context.runId },
      ),
    );
    upsertManifestEntry(input.context, {
      id,
      kind: manifestKind,
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
        kind: manifestKind,
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

function taskPlanConfig(stage: Stage): NonNullable<Stage["taskPlan"]> | undefined {
  return stage.taskPlan;
}

function taskPlanConfigMaxIterations(
  config: NonNullable<Stage["taskPlan"]>,
): number | undefined {
  return config.maxIterations ?? config.max_iterations;
}

function taskPlanConfigMaxTasks(
  config: NonNullable<Stage["taskPlan"]>,
): number | undefined {
  return config.maxTasks ?? config.max_tasks;
}

function taskPlanLoopMaxIterations(
  config: NonNullable<Stage["taskPlan"]>,
  plan: ParsedTaskPlan,
): number {
  return taskPlanConfigMaxIterations(config) ?? plan.maxIterations ?? plan.tasks.length;
}

function taskPlanDiagnosticsMessage(plan: ParsedTaskPlan): string {
  return plan.diagnostics
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
    .join("; ");
}

function assertTaskPlanTaskLimit(input: {
  config: NonNullable<Stage["taskPlan"]>;
  inputId: string;
  plan: ParsedTaskPlan;
}): void {
  const maxTasks = taskPlanConfigMaxTasks(input.config);
  if (maxTasks !== undefined && input.plan.tasks.length > maxTasks) {
    throw new Error(
      `task plan "${input.inputId}" has ${input.plan.tasks.length} tasks, exceeding max_tasks ${maxTasks}`,
    );
  }
}

function ensureTaskPlanLoopState(input: {
  states: Map<string, TaskPlanLoopState>;
  stage: Stage;
  inputArtifacts: Map<string, InputArtifact>;
}): TaskPlanLoopState | undefined {
  const config = taskPlanConfig(input.stage);
  if (!config) return undefined;
  const existing = input.states.get(config.input);
  if (existing) {
    assertTaskPlanTaskLimit({
      config,
      inputId: config.input,
      plan: existing.plan,
    });
    const stageMax = taskPlanConfigMaxIterations(config);
    if (stageMax !== undefined) {
      existing.maxIterations = stageMax;
    }
    return existing;
  }
  const source = input.inputArtifacts.get(config.input);
  if (!source) {
    throw new Error(`task plan input not found: ${config.input}`);
  }
  const plan = parseTaskPlanJson(source.resource.content.toString("utf8"));
  if (!plan.valid) {
    throw new Error(`invalid task plan "${config.input}": ${taskPlanDiagnosticsMessage(plan)}`);
  }
  assertTaskPlanTaskLimit({ config, inputId: config.input, plan });
  const state: TaskPlanLoopState = {
    inputId: config.input,
    plan,
    completedTaskIds: new Set(completedTaskIdsFromPlan(plan)),
    iteration: 0,
    maxIterations: taskPlanLoopMaxIterations(config, plan),
    history: [...plan.history],
  };
  input.states.set(config.input, state);
  return state;
}

function taskPlanProgressPayload(
  state: TaskPlanLoopState,
  currentTask?: TaskPlanTask,
): Record<string, unknown> {
  const progress = taskPlanProgress(
    state.plan,
    state.completedTaskIds,
    currentTask?.id ?? state.currentTaskId,
  );
  return {
    inputId: state.inputId,
    version: state.plan.version,
    currentTask: currentTask ?? progress.currentTask,
    currentTaskId: (currentTask ?? progress.currentTask)?.id,
    completedTaskIds: progress.completedTaskIds,
    remainingTaskIds: progress.remainingTaskIds,
    completedCount: progress.completedCount,
    remainingCount: progress.remainingCount,
    totalTaskCount: progress.totalTaskCount,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    history: state.history,
  };
}

function taskPlanIsComplete(state: TaskPlanLoopState): boolean {
  return state.plan.tasks.every((task) => state.completedTaskIds.has(task.id));
}

function taskPlanExecuteStageId(input: {
  stages: Stage[];
  inputId: string;
}): string | undefined {
  return input.stages.find(
    (stage) =>
      stage.taskPlan?.input === input.inputId &&
      stage.taskPlan.role === "execute-current",
  )?.id;
}

function taskPlanPromptContext(
  state: TaskPlanLoopState,
  currentTask: TaskPlanTask,
): TaskPlanPromptContext {
  return {
    inputId: state.inputId,
    content: renderCurrentTaskPlan({
      inputId: state.inputId,
      plan: state.plan,
      completedTaskIds: state.completedTaskIds,
      currentTask,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      history: state.history,
    }),
  };
}

function prepareTaskPlanStageStart(input: {
  states: Map<string, TaskPlanLoopState>;
  stage: Stage;
  inputArtifacts: Map<string, InputArtifact>;
  stages: Stage[];
  graph: FlowGraph;
  completedStages: string[];
  eventStore: EventStore;
  runId: string;
  context: RuntimeContext;
}):
  | { kind: "none"; prepared?: PreparedTaskPlanStage }
  | { kind: "skip"; prepared: PreparedTaskPlanStage }
  | { kind: "jump"; stageIndex: number; prepared: PreparedTaskPlanStage } {
  const config = taskPlanConfig(input.stage);
  if (!config) {
    const state = [...input.states.values()].find(
      (candidate) => input.stage.inputs.includes(candidate.inputId),
    );
    if (!state?.currentTaskId) return { kind: "none" };
    const currentTask = state.plan.tasks.find(
      (task) =>
        task.id === state.currentTaskId &&
        !state.completedTaskIds.has(task.id),
    );
    if (!currentTask) return { kind: "none" };
    return {
      kind: "none",
      prepared: {
        state,
        currentTask,
        promptContext: taskPlanPromptContext(state, currentTask),
      },
    };
  }
  const state = ensureTaskPlanLoopState({
    states: input.states,
    stage: input.stage,
    inputArtifacts: input.inputArtifacts,
  })!;

  if (config.role === "final") {
    if (taskPlanIsComplete(state)) {
      input.eventStore.append({
        runId: input.runId,
        stageId: input.stage.id,
        type: "task.plan.final.ready",
        payload: redactRuntimeUnknown(taskPlanProgressPayload(state), input.context),
      });
      const progress = taskPlanProgress(state.plan, state.completedTaskIds);
      const currentTask = progress.currentTask;
      return {
        kind: "none",
        prepared: {
          state,
          currentTask,
          ...(currentTask ? { promptContext: taskPlanPromptContext(state, currentTask) } : {}),
        },
      };
    }
    const executeStageId = taskPlanExecuteStageId({
      stages: input.stages,
      inputId: state.inputId,
    });
    const executeIndex = executeStageId
      ? input.graph.order.indexOf(executeStageId)
      : -1;
    if (!executeStageId || executeIndex < 0) {
      throw new Error(
        `task plan ${state.inputId} is incomplete and has no execute-current stage`,
      );
    }
    const currentTask = nextPendingTask(state.plan, state.completedTaskIds);
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      type: "task.plan.final.deferred",
      payload: redactRuntimeUnknown(
        {
          ...taskPlanProgressPayload(state, currentTask),
          targetStage: executeStageId,
          reason: "task plan is not complete",
        },
        input.context,
      ),
    });
    invalidateCompletedStagesFrom(input.completedStages, input.graph.order, executeIndex);
    return {
      kind: "jump",
      stageIndex: executeIndex,
      prepared: {
        state,
        currentTask,
        ...(currentTask ? { promptContext: taskPlanPromptContext(state, currentTask) } : {}),
      },
    };
  }

  const currentTask =
    state.currentTaskId !== undefined && !state.completedTaskIds.has(state.currentTaskId)
      ? state.plan.tasks.find((task) => task.id === state.currentTaskId)
      : nextPendingTask(state.plan, state.completedTaskIds);
  if (!currentTask) {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      type: "task.plan.completed",
      payload: redactRuntimeUnknown(taskPlanProgressPayload(state), input.context),
    });
    return { kind: "skip", prepared: { state } };
  }

  if (config.role === "execute-current" && state.currentTaskId !== currentTask.id) {
    if (state.iteration >= state.maxIterations) {
      throw new Error(
        `task plan ${state.inputId} exhausted max_iterations ${state.maxIterations}`,
      );
    }
    state.currentTaskId = currentTask.id;
    state.iteration += 1;
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      type: "task.plan.iteration.started",
      payload: redactRuntimeUnknown(
        taskPlanProgressPayload(state, currentTask),
        input.context,
      ),
    });
  }

  return {
    kind: "none",
    prepared: {
      state,
      currentTask,
      promptContext: taskPlanPromptContext(state, currentTask),
    },
  };
}

function advanceTaskPlanAfterStage(input: {
  prepared: PreparedTaskPlanStage | undefined;
  stage: Stage;
  attempt: number | undefined;
  stages: Stage[];
  graph: FlowGraph;
  completedStages: string[];
  eventStore: EventStore;
  runId: string;
  context: RuntimeContext;
}): { stageIndex?: number } {
  const config = taskPlanConfig(input.stage);
  if (!config || config.role !== "verify-advance") return {};
  const state = input.prepared?.state;
  const currentTask = input.prepared?.currentTask;
  if (!state || !currentTask) {
    throw new Error(`task plan ${config.input} has no current task to verify`);
  }
  state.completedTaskIds.add(currentTask.id);
  state.history.push({
    taskId: currentTask.id,
    status: "completed",
    stageId: input.stage.id,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    message: "verify-advance stage completed",
    createdAt: new Date().toISOString(),
  });
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "task.plan.task.completed",
    payload: redactRuntimeUnknown(
      taskPlanProgressPayload(state, currentTask),
      input.context,
    ),
  });
  state.currentTaskId = undefined;

  const nextTask = nextPendingTask(state.plan, state.completedTaskIds);
  if (!nextTask) {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      type: "task.plan.completed",
      payload: redactRuntimeUnknown(taskPlanProgressPayload(state), input.context),
    });
    return {};
  }
  const executeStageId = taskPlanExecuteStageId({
    stages: input.stages,
    inputId: state.inputId,
  });
  const executeIndex = executeStageId
    ? input.graph.order.indexOf(executeStageId)
    : -1;
  if (!executeStageId || executeIndex < 0) {
    throw new Error(
      `task plan ${state.inputId} has remaining tasks and no execute-current stage`,
    );
  }
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "task.plan.loop.continues",
    payload: redactRuntimeUnknown(
      {
        ...taskPlanProgressPayload(state, nextTask),
        targetStage: executeStageId,
      },
      input.context,
    ),
  });
  invalidateCompletedStagesFrom(input.completedStages, input.graph.order, executeIndex);
  return { stageIndex: executeIndex };
}

function eventPayloadRecord(event: StoredRunEvent): Record<string, unknown> {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function taskPlanEventInputId(
  event: StoredRunEvent,
  configuredInputIds: ReadonlySet<string>,
): string {
  const inputId = eventPayloadRecord(event).inputId;
  if (typeof inputId !== "string" || !IDENTIFIER_PATTERN.test(inputId)) {
    throw new Error(
      `task plan event ${event.type} has invalid inputId; expected a Flow identifier`,
    );
  }
  if (!configuredInputIds.has(inputId)) {
    throw new Error(
      `task plan event ${event.type} references unknown inputId "${inputId}"`,
    );
  }
  return inputId;
}

function taskPlanHistoryFromPayload(value: unknown): TaskPlanHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: TaskPlanHistoryEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
    const status = record.status;
    if (
      !taskId ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed" &&
        status !== "blocked")
    ) {
      return undefined;
    }
    entries.push({
      taskId,
      status,
      ...(typeof record.stageId === "string" ? { stageId: record.stageId } : {}),
      ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    });
  }
  return entries;
}

function rehydrateTaskPlanLoopStates(input: {
  stages: Stage[];
  inputArtifacts: Map<string, InputArtifact>;
  events: StoredRunEvent[];
}): Map<string, TaskPlanLoopState> {
  const states = new Map<string, TaskPlanLoopState>();
  const configuredInputIds = new Set(
    input.stages.flatMap((stage) => {
      const config = taskPlanConfig(stage);
      return config ? [config.input] : [];
    }),
  );
  const taskPlanEvents = input.events
    .filter((event) => event.type.startsWith("task.plan."))
    .map((event) => ({
      event,
      inputId: taskPlanEventInputId(event, configuredInputIds),
    }));
  const eventInputIds = new Set(
    taskPlanEvents.map(({ inputId }) => inputId),
  );
  for (const stage of input.stages) {
    const config = taskPlanConfig(stage);
    if (!config) continue;
    if (
      !input.inputArtifacts.has(config.input) &&
      !eventInputIds.has(config.input)
    ) {
      continue;
    }
    ensureTaskPlanLoopState({
      states,
      stage,
      inputArtifacts: input.inputArtifacts,
    });
  }

  for (const { event, inputId } of taskPlanEvents) {
    const payload = eventPayloadRecord(event);
    const state = states.get(inputId);
    if (!state) continue;

    if (Array.isArray(payload.completedTaskIds)) {
      state.completedTaskIds = new Set(
        payload.completedTaskIds.filter(
          (taskId): taskId is string => typeof taskId === "string",
        ),
      );
    }
    if (typeof payload.iteration === "number" && Number.isInteger(payload.iteration)) {
      state.iteration = payload.iteration;
    }
    if (
      typeof payload.maxIterations === "number" &&
      Number.isInteger(payload.maxIterations) &&
      payload.maxIterations > 0
    ) {
      state.maxIterations = payload.maxIterations;
    }
    const history = taskPlanHistoryFromPayload(payload.history);
    if (history) state.history = history;

    const currentTaskId =
      typeof payload.currentTaskId === "string" ? payload.currentTaskId : undefined;
    if (
      event.type === "task.plan.task.completed" ||
      event.type === "task.plan.completed"
    ) {
      state.currentTaskId = undefined;
    } else if (
      currentTaskId &&
      !state.completedTaskIds.has(currentTaskId) &&
      state.plan.tasks.some((task) => task.id === currentTaskId)
    ) {
      state.currentTaskId = currentTaskId;
    }
  }
  return states;
}

function taskPlanStateForReworkTarget(input: {
  states: Map<string, TaskPlanLoopState>;
  stages: Stage[];
  graph: FlowGraph;
  targetStageIndex: number;
}): TaskPlanLoopState | undefined {
  const targetStageId = input.graph.order[input.targetStageIndex];
  const targetStage = input.stages.find((stage) => stage.id === targetStageId);
  if (!targetStage) return undefined;

  const matches = [...input.states.values()].filter((state) => {
    if (
      targetStage.taskPlan?.input !== state.inputId &&
      !targetStage.inputs.includes(state.inputId)
    ) {
      return false;
    }
    const executeIndexes = input.stages
      .filter(
        (stage) =>
          stage.taskPlan?.input === state.inputId &&
          stage.taskPlan.role === "execute-current",
      )
      .map((stage) => input.graph.order.indexOf(stage.id))
      .filter((index) => index >= 0);
    const verifyIndexes = input.stages
      .filter(
        (stage) =>
          stage.taskPlan?.input === state.inputId &&
          stage.taskPlan.role === "verify-advance",
      )
      .map((stage) => input.graph.order.indexOf(stage.id))
      .filter((index) => index >= 0);
    return executeIndexes.some((executeIndex) =>
      verifyIndexes.some(
        (verifyIndex) =>
          executeIndex <= input.targetStageIndex &&
          input.targetStageIndex <= verifyIndex,
      ),
    );
  });
  if (matches.length > 1) {
    throw new Error(
      `rework target stage ${targetStage.id} belongs to multiple task plans`,
    );
  }
  return matches[0];
}

function taskPlanTextMentionsIdentifier(
  text: string,
  identifier: string,
): boolean {
  if (!identifier) return false;
  const isIdentifierCharacter = (character: string | undefined) =>
    character !== undefined && /[A-Za-z0-9_-]/.test(character);
  let offset = text.indexOf(identifier);
  while (offset >= 0) {
    const before = offset > 0 ? text[offset - 1] : undefined;
    const after = text[offset + identifier.length];
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
      return true;
    }
    offset = text.indexOf(identifier, offset + identifier.length);
  }
  return false;
}

function taskPlanTaskForCompletedRework(input: {
  state: TaskPlanLoopState;
  request: ReworkRequest;
}): TaskPlanTask {
  const requestText = [
    input.request.reason,
    input.request.instructions,
    input.request.context,
    input.request.targetArtifact,
    ...(input.request.specificIssues ?? []).flatMap((issue) => [
      issue.file,
      issue.problem,
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const requestMatchedTasks = input.state.plan.tasks.filter(
    (task) =>
      taskPlanTextMentionsIdentifier(requestText, task.id) ||
      task.paths.some((path) =>
        taskPlanTextMentionsIdentifier(requestText, path),
      ),
  );
  if (requestMatchedTasks.length === 1) return requestMatchedTasks[0]!;
  if (requestMatchedTasks.length > 1) {
    throw new Error(
      `task plan ${input.state.inputId} rework request identifies multiple tasks: ${requestMatchedTasks.map((task) => task.id).join(", ")}`,
    );
  }

  if (input.state.currentTaskId) {
    const currentTask = input.state.plan.tasks.find(
      (task) =>
        task.id === input.state.currentTaskId &&
        input.state.completedTaskIds.has(task.id),
    );
    if (currentTask) return currentTask;
  }

  if (input.state.completedTaskIds.size === 1) {
    const [completedTaskId] = input.state.completedTaskIds;
    const completedTask = input.state.plan.tasks.find(
      (task) => task.id === completedTaskId,
    );
    if (completedTask) return completedTask;
  }
  throw new Error(
    `task plan ${input.state.inputId} cannot determine which completed task to reopen`,
  );
}

function reopenCompletedTaskPlanForRework(input: {
  states: Map<string, TaskPlanLoopState>;
  stages: Stage[];
  graph: FlowGraph;
  targetStageIndex: number;
  request: ReworkRequest;
  eventStore: EventStore;
  runId: string;
  context: RuntimeContext;
}): void {
  const state = taskPlanStateForReworkTarget(input);
  if (!state || !taskPlanIsComplete(state)) return;
  const currentTask = taskPlanTaskForCompletedRework({
    state,
    request: input.request,
  });
  if (state.iteration >= state.maxIterations) {
    throw new Error(
      `task plan ${state.inputId} exhausted max_iterations ${state.maxIterations}`,
    );
  }
  state.completedTaskIds.delete(currentTask.id);
  state.currentTaskId = currentTask.id;
  state.iteration += 1;
  state.history.push({
    taskId: currentTask.id,
    status: "in_progress",
    ...(input.request.sourceStage ? { stageId: input.request.sourceStage } : {}),
    ...(input.request.sourceAttempt !== undefined
      ? { attempt: input.request.sourceAttempt }
      : {}),
    message: `reopened after structured rework request: ${input.request.reason}`,
    createdAt: new Date().toISOString(),
  });
  const targetStage = input.graph.order[input.targetStageIndex];
  input.eventStore.append({
    runId: input.runId,
    stageId: targetStage,
    type: "task.plan.iteration.started",
    payload: redactRuntimeUnknown(
      {
        ...taskPlanProgressPayload(state, currentTask),
        reopenedTaskId: currentTask.id,
        reason: "structured rework started a new task-plan iteration",
        reworkRequest: input.request,
      },
      input.context,
    ),
  });
  input.eventStore.append({
    runId: input.runId,
    ...(input.request.sourceStage ? { stageId: input.request.sourceStage } : {}),
    ...(input.request.sourceAttempt !== undefined
      ? { attempt: input.request.sourceAttempt }
      : {}),
    type: "task.plan.loop.continues",
    payload: redactRuntimeUnknown(
      {
        ...taskPlanProgressPayload(state, currentTask),
        targetStage,
        reopenedTaskId: currentTask.id,
        reason: "structured rework reopened a completed task",
        reworkRequest: input.request,
      },
      input.context,
    ),
  });
}

function createTaskPlanExecutionController(input: {
  startIndex: number;
  states: Map<string, TaskPlanLoopState>;
  inputArtifacts: Map<string, InputArtifact>;
  stages: Stage[];
  graph: FlowGraph;
  completedStages: string[];
  eventStore: EventStore;
  runId: string;
  context: RuntimeContext;
}): TaskPlanExecutionController {
  let stageIndex = input.startIndex;
  return {
    get stageIndex() {
      return stageIndex;
    },
    get done() {
      return stageIndex >= input.graph.order.length;
    },
    get stageId() {
      return input.graph.order[stageIndex];
    },
    prepare(stage) {
      const result = prepareTaskPlanStageStart({
        states: input.states,
        stage,
        inputArtifacts: input.inputArtifacts,
        stages: input.stages,
        graph: input.graph,
        completedStages: input.completedStages,
        eventStore: input.eventStore,
        runId: input.runId,
        context: input.context,
      });
      if (result.kind === "jump") {
        stageIndex = result.stageIndex;
        return { run: false, prepared: result.prepared };
      }
      if (result.kind === "skip") {
        stageIndex += 1;
        return { run: false, prepared: result.prepared };
      }
      return { run: true, prepared: result.prepared };
    },
    complete(stage, prepared, attempt) {
      const advanced = advanceTaskPlanAfterStage({
        prepared,
        stage,
        attempt,
        stages: input.stages,
        graph: input.graph,
        completedStages: input.completedStages,
        eventStore: input.eventStore,
        runId: input.runId,
        context: input.context,
      });
      stageIndex = advanced.stageIndex ?? stageIndex + 1;
    },
    next() {
      stageIndex += 1;
    },
    rework(nextStageIndex, request) {
      reopenCompletedTaskPlanForRework({
        states: input.states,
        stages: input.stages,
        graph: input.graph,
        targetStageIndex: nextStageIndex,
        request,
        eventStore: input.eventStore,
        runId: input.runId,
        context: input.context,
      });
      stageIndex = nextStageIndex;
    },
  };
}

function applyTaskPlanPromptContext(
  inputs: Map<string, InputArtifact>,
  context: TaskPlanPromptContext | undefined,
): Map<string, InputArtifact> {
  if (!context) return inputs;
  const source = inputs.get(context.inputId);
  if (!source) return inputs;
  const scoped = new Map(inputs);
  const content = Buffer.from(context.content, "utf8");
  scoped.set(context.inputId, {
    ...source,
    resource: {
      ...source.resource,
      mediaType: "text/markdown",
      content,
      metadata: {
        ...source.resource.metadata,
        filename: `current-${context.inputId}.md`,
        taskPlan: "current-task",
      },
    },
  });
  return scoped;
}

function formatTaskScopeEvidence(
  selection: EvidenceTaskScope | undefined,
): string {
  if (!selection) return "none";
  const completedTaskIds = selection.completedTaskIds ?? [];
  const pendingTaskIds = selection.pendingTaskIds ?? [];
  return [
    `- Input: ${selection.inputId}`,
    `- Scope: ${selection.expression}`,
    `- Kind: ${selection.kind ?? "unknown"}`,
    `- Selected tasks: ${selection.selectedTaskIds.join(", ")}`,
    `- Completed at run start: ${
      completedTaskIds.length > 0
        ? completedTaskIds.join(", ")
        : "none"
    }`,
    `- Pending at run start: ${
      pendingTaskIds.length > 0
        ? pendingTaskIds.join(", ")
        : "none"
    }`,
    `- Source task count: ${selection.sourceTaskCount ?? "unknown"}`,
  ].join("\n");
}

function formatTaskIssueEvidence(
  scope: ResolvedTaskIssueScope | undefined,
): string {
  if (!scope) return "none";
  const issueLines = scope.issues.length > 0
    ? scope.issues.map(
        (issue) =>
          `- ${issue.taskIds.join(", ")}: ${issue.issueUrl} (#${issue.issueNumber}, ${issue.issueState})`,
      )
    : ["- Mapped issues: none"];
  return [
    ...issueLines,
    `- Unmapped selected tasks: ${
      scope.missingTaskIds.length > 0 ? scope.missingTaskIds.join(", ") : "none"
    }`,
    ...(scope.registryError ? [`- Registry unavailable: ${scope.registryError}`] : []),
  ].join("\n");
}

function taskIssueCapableProvider(
  dependencies: RunFlowDependencies,
): ScmProvider | undefined {
  const provider = dependencies.scmProvider;
  return provider?.resolveRepository &&
    provider.listRepositoryIssueComments &&
    provider.createRepositoryIssueComment &&
    provider.updateRepositoryIssueComment
    ? provider
    : undefined;
}

async function taskIssueScopeForRun(input: {
  repoPath: string;
  taskIds: string[];
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
}): Promise<ResolvedTaskIssueScope> {
  const provider = taskIssueCapableProvider(input.dependencies);
  return await (input.dependencies.resolveTaskIssueScope ?? resolveTaskIssueScope)({
    repoPath: input.repoPath,
    taskIds: input.taskIds,
    providerStore: input.providerStore,
    ...(provider ? { provider } : {}),
  });
}

async function recordTaskIssueRunLinks(input: {
  repoPath: string;
  runId: string;
  status: TaskIssueRunStatus;
  evidencePath: string;
  changeRequestUrl?: string;
  scope: ResolvedTaskIssueScope | undefined;
  dependencies: RunFlowDependencies;
  providerStore: ProviderConnectionStore;
  context: RuntimeContext;
  eventStore: EventStore;
}): Promise<void> {
  if (!input.scope?.repository || input.scope.issues.length === 0) return;
  try {
    const provider = taskIssueCapableProvider(input.dependencies);
    const results = await (input.dependencies.linkTaskIssuesToRun ?? linkTaskIssuesToRun)({
      repoPath: input.repoPath,
      runId: input.runId,
      status: input.status,
      evidencePath: input.evidencePath,
      changeRequestUrl: input.changeRequestUrl,
      scope: input.scope,
      providerStore: input.providerStore,
      ...(provider ? { provider } : {}),
    });
    for (const result of results) {
      input.eventStore.append({
        runId: input.runId,
        type:
          result.outcome === "failed"
            ? "task.issue.run_link_failed"
            : "task.issue.run_linked",
        payload: redactRuntimeUnknown(
          {
            status: input.status,
            issueNumber: result.issueNumber,
            issueUrl: result.issueUrl,
            taskIds: result.taskIds,
            outcome: result.outcome,
            commentUrl: result.commentUrl,
            error: result.error,
          },
          input.context,
        ),
      });
    }
  } catch (error) {
    input.eventStore.append({
      runId: input.runId,
      type: "task.issue.run_link_failed",
      payload: redactRuntimeUnknown(
        {
          status: input.status,
          issueNumbers: input.scope.issues.map((issue) => issue.issueNumber),
          error: error instanceof Error ? error.message : String(error),
        },
        input.context,
      ),
    });
  }
}

function formatRuntimeUsageEvidence(
  usage: ProjectedRuntimeUsageTotal | undefined,
): string {
  if (!usage) return "none";
  const lines = [
    `- Attempts with runtime usage data: ${usage.knownAttempts}`,
    `- Runtime attempts without usage data: ${usage.unknownAttempts}`,
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

function formatAttemptEvidence(input: {
  attempt: number;
  maxAttempts: number;
}): string {
  return input.attempt <= input.maxAttempts
    ? `attempt ${input.attempt}/${input.maxAttempts}`
    : `attempt ${input.attempt} (max policy attempts ${input.maxAttempts})`;
}

function formatOrchestratorAttemptEvidence(
  decision: OrchestratorDecisionEvent,
): string {
  return formatAttemptEvidence(decision);
}

function formatCommandEnvironmentRepair(
  repair: CommandEnvironmentRepair,
): string {
  return [
    repair.description,
    `scope ${repair.scope}`,
    repair.path ? `path ${repair.path}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function formatCommandEnvironmentRepairs(
  repairs: CommandEnvironmentRepair[],
): string {
  return repairs.map(formatCommandEnvironmentRepair).join("; ");
}

function formatToolchainPreflightEvidence(
  preflight: ToolchainPreflight,
): string {
  const files =
    preflight.toolchainFiles.length > 0
      ? preflight.toolchainFiles
          .map((file) => `${file.path} (${file.kind})`)
          .join(", ")
      : "none";
  const executables = preflight.executables
    .map((executable) =>
      executable.available
        ? `${executable.name}: available${executable.path ? ` at ${executable.path}` : ""}`
        : `${executable.name}: missing`,
    )
    .join("; ");
  const repairs =
    preflight.commandEnvironment.repairs.length > 0
      ? formatCommandEnvironmentRepairs(preflight.commandEnvironment.repairs)
      : "none";
  return [
    "Manifest: toolchain-preflight.json",
    `Backend: ${preflight.executionBackend ?? "local"}`,
    `Env source: ${preflight.commandEnvironment.envSource}`,
    `Shell mode: ${preflight.commandEnvironment.shellMode}`,
    `PATH entries: ${preflight.commandEnvironment.pathEntryCount}`,
    `Toolchain files: ${files}`,
    `Executables: ${executables}`,
    `Environment repairs: ${repairs}`,
  ].join("\n");
}

interface EvidenceChangeSummary {
  sourceRepository: string;
  compareRef: string;
  diffStat: string;
  files: string;
  worktreeStatus: string;
}

async function gitEvidence(
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: GIT_EVIDENCE_MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function formatNameStatus(output: string | undefined): string {
  if (!output) return "none";
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return "none";
  return lines
    .map((line) => {
      const [status = "", ...paths] = line.split("\t");
      return `- ${status}: ${paths.join(" -> ")}`;
    })
    .join("\n");
}

async function collectEvidenceChangeSummary(input: {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
}): Promise<EvidenceChangeSummary> {
  const sourceRepository =
    await gitEvidence(input.repoPath, ["remote", "get-url", "origin"]) ??
    input.repoPath;
  const compareCandidates = [
    `${input.baseBranch}...HEAD`,
    `${input.baseBranch}..HEAD`,
  ];
  let compareRef = compareCandidates[0] ?? "HEAD";
  let diffStat = "";
  let nameStatus = "";
  for (const candidate of compareCandidates) {
    const candidateStat = await gitEvidence(input.worktreePath, [
      "diff",
      "--stat",
      candidate,
    ]);
    const candidateNameStatus = await gitEvidence(input.worktreePath, [
      "diff",
      "--name-status",
      candidate,
    ]);
    if (candidateStat !== undefined || candidateNameStatus !== undefined) {
      compareRef = candidate;
      diffStat = candidateStat ?? "";
      nameStatus = candidateNameStatus ?? "";
      break;
    }
  }
  if (!diffStat) {
    diffStat = await gitEvidence(input.worktreePath, ["diff", "--stat"]) ?? "";
  }
  if (!nameStatus) {
    nameStatus = await gitEvidence(input.worktreePath, ["diff", "--name-status"]) ?? "";
  }
  const worktreeStatus =
    await gitEvidence(input.worktreePath, ["status", "--short"]) ?? "";
  return {
    sourceRepository,
    compareRef,
    diffStat: diffStat || "none",
    files: formatNameStatus(nameStatus),
    worktreeStatus: worktreeStatus || "clean",
  };
}

interface GitHubSourceIssueReference {
  owner: string;
  repository: string;
  number: number;
  url: string;
  closingReference: string;
}

function parseGitHubSourceIssueUrl(
  value: string | undefined,
): GitHubSourceIssueReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?(?:$|[?#])/.exec(
      trimmed,
    );
  if (!match) return undefined;
  const owner = match[1] ?? "";
  const repository = match[2] ?? "";
  const number = Number.parseInt(match[3] ?? "", 10);
  if (!owner || !repository || !Number.isFinite(number)) {
    return undefined;
  }
  return {
    owner,
    repository,
    number,
    url: trimmed,
    closingReference: `Closes ${owner}/${repository}#${number}`,
  };
}

function parseArtifactJson(artifact: InputArtifact): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(artifact.resource.content.toString("utf8")));
  } catch {
    return {};
  }
}

function githubSourceIssueFromInputs(
  inputs: Map<string, InputArtifact>,
): GitHubSourceIssueReference | undefined {
  const metadataArtifacts = ["workflow-metadata", "source"]
    .map((id) => inputs.get(id))
    .filter((artifact): artifact is InputArtifact => artifact !== undefined);
  for (const artifact of metadataArtifacts) {
    const json = parseArtifactJson(artifact);
    const snapshot = asRecord(json.snapshot);
    const candidates = [
      stringValue(json.issueUrl),
      stringValue(json.sourceUri),
      stringValue(json.uri),
      stringValue(snapshot.uri),
    ];
    for (const candidate of candidates) {
      const parsed = parseGitHubSourceIssueUrl(candidate);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

async function writeEvidence(input: {
  flowName: string;
  runId: string;
  branchName: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string;
  runDirectory: string;
  status?: EvidenceRunStatus;
  completedStages: string[];
  gates: GateResult[];
  agentRuntimes: AgentRuntimeEvidence[];
  stageContextControls?: StageContextEvidence[];
  stageReadPolicies?: StageReadPolicyEvidence[];
  stageTimeouts?: StageTimeoutEvidence[];
  runtimeUsage?: ProjectedRuntimeUsageTotal;
  verificationBudget?: ProjectedVerificationBudget;
  repoIndexQueries?: ProjectedRepoIndexQuery[];
  knowledgeRetrievals?: ProjectedKnowledgeRetrieval[];
  commandAttempts: CommandAttemptEvidence[];
  hookAttempts: HookAttemptEvidence[];
  conformancePolicies: ConformancePolicyEvidence[];
  loadedSkills: StageSkillUsage[];
  contextKnowledge?: ContextKnowledgeEntry[];
  orchestratorDecisions: OrchestratorDecisionEvent[];
  verificationDiagnoses: ProjectedVerificationFailureDiagnosis[];
  operatorQuestions?: ProjectedOperatorQuestion[];
  inputs: Map<string, InputArtifact>;
  configuration: FlowConfiguration;
  context: RuntimeContext;
  taskScope?: EvidenceTaskScope;
  taskIssues?: ResolvedTaskIssueScope;
  planningApproval?: PlanningApprovalStatus;
  changeTitle?: ChangeTitleMetadata;
  changeRequest?: ChangeRequest;
  reworkTarget?: ReworkTargetState;
  syncMetadata?: SyncMetadata;
  reproducibility?: ReproducibilityManifest;
  toolchainPreflight?: ToolchainPreflight;
  executionBackend?: ExecutionBackendDescription;
  riskClassification?: ProjectedRiskClassification;
}): Promise<string> {
  const evidencePath = join(input.runDirectory, "evidence.md");
  const changeSummary = await collectEvidenceChangeSummary({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
  });
  const sourceIssue = githubSourceIssueFromInputs(input.inputs);
  const sourceIssueSection = sourceIssue
    ? [
        "## Source Issue",
        "",
        "Provider: github",
        `URL: ${redactRuntimeText(sourceIssue.url, input.context) ?? ""}`,
        `Issue: ${redactRuntimeText(
          `${sourceIssue.owner}/${sourceIssue.repository}#${sourceIssue.number}`,
          input.context,
        ) ?? ""}`,
        `Closing reference: ${
          redactRuntimeText(sourceIssue.closingReference, input.context) ?? ""
        }`,
        redactRuntimeText(sourceIssue.closingReference, input.context) ?? "",
        "",
      ]
    : [];
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
  const changeRequestSection = input.changeRequest
    ? [
        "## Change Request",
        "",
        `Provider: ${input.changeRequest.provider}`,
        `URL: ${redactRuntimeText(input.changeRequest.url, input.context) ?? ""}`,
        `Number: ${input.changeRequest.number}`,
        `Base branch: ${
          redactRuntimeText(input.changeRequest.baseBranch, input.context) ?? ""
        }`,
        `Head branch: ${
          redactRuntimeText(input.changeRequest.headBranch, input.context) ?? ""
        }`,
        `Draft: ${input.changeRequest.draft ? "yes" : "no"}`,
        input.changeRequest.outcome
          ? `Outcome: ${input.changeRequest.outcome}`
          : undefined,
        input.changeRequest.metadataUpdate
          ? `Metadata update: ${input.changeRequest.metadataUpdate.outcome}`
          : undefined,
        input.changeRequest.metadataUpdate
          ? `Metadata transport: ${input.changeRequest.metadataUpdate.transport}`
          : undefined,
        input.changeRequest.metadataUpdate
          ? `Metadata fields: ${input.changeRequest.metadataUpdate.fields.join(", ")}`
          : undefined,
        "",
      ].filter((line): line is string => line !== undefined)
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
  const projectInstructions = input.context.projectInstructions;
  const projectInstructionsSection = projectInstructions.loaded
    ? [
        "## Project Instructions",
        "",
        "Loaded: yes",
        `Path: ${redactRuntimeText(projectInstructions.path, input.context) ?? ""}`,
        `Hash: ${projectInstructions.hash}`,
        `Groups: ${projectInstructions.groups.length}`,
        "",
        projectInstructions.groups.length > 0
          ? projectInstructions.groups
              .map((group) =>
                [
                  `- ${redactRuntimeText(group.id, input.context) ?? ""}: applies to ${group.appliesTo}`,
                  group.title
                    ? `  Title: ${redactRuntimeText(group.title, input.context) ?? ""}`
                    : undefined,
                  `  Include: ${group.include.join(", ")}`,
                  `  Exclude: ${listOrNone(group.exclude)}`,
                ]
                  .filter((line): line is string => line !== undefined)
                  .join("\n"),
              )
              .join("\n")
          : "none",
        "",
      ]
    : [
        "## Project Instructions",
        "",
        "Loaded: no",
        `Path: ${redactRuntimeText(projectInstructions.path, input.context) ?? ""}`,
        "",
      ];
  const agentRuntimeLines =
    input.agentRuntimes.length > 0
      ? input.agentRuntimes
          .map((agent) => {
            const capabilityLines = formatCapabilityPolicyEvidence(
              agent.capabilityPolicy,
            );
            if (agent.candidates.length === 1) {
              const candidate = agent.candidates[0]!;
              return [
                `- ${agent.stageId} (${agent.stageKind}): runtime ${candidate.runtime}, model ${candidate.model ?? "default"}`,
                ...capabilityLines,
              ].join("\n");
            }
            const chain = agent.candidates
              .map(
                (candidate) =>
                  `${candidate.runtime}/${candidate.model ?? "default"}`,
              )
              .join(" -> ");
            return [
              `- ${agent.stageId} (${agent.stageKind}): ${chain}`,
              ...capabilityLines,
            ].join("\n");
          })
          .join("\n")
      : "none";
  const stageContextControlLines =
    (input.stageContextControls ?? []).length > 0
      ? (input.stageContextControls ?? [])
          .map((controls) =>
            [
              `- ${redactRuntimeText(controls.stageId, input.context) ?? ""} (${controls.kind})`,
              `  Isolated: ${controls.isolated ? "yes" : "no"}`,
              `  Instruction files: ${controls.instructionFiles ? "enabled" : "disabled"}`,
              `  Project instructions: ${controls.projectInstructions ? "enabled" : "disabled"}`,
              `  Context knowledge: ${controls.contextKnowledge ? "enabled" : "disabled"}`,
              `  External knowledge: ${controls.externalKnowledge.enabled ? `enabled (top ${controls.externalKnowledge.topK}, ${controls.externalKnowledge.maxPromptTokens} prompt tokens, ${controls.externalKnowledge.availability})` : "disabled"}`,
              `  Previous failures: ${controls.previousFailures ? "enabled" : "disabled"}`,
              `  Global runtime skills: ${globalSkillsEvidenceLabel(controls.globalSkills)}`,
              `  Full-read inputs: ${
                controls.fullReadInputs.length > 0
                  ? controls.fullReadInputs
                    .map((id) => redactRuntimeText(id, input.context) ?? "")
                    .join(", ")
                  : "none"
              }`,
            ].join("\n"),
          )
          .join("\n")
      : "none";
  const stageReadPolicyLines =
    (input.stageReadPolicies ?? []).length > 0
      ? (input.stageReadPolicies ?? [])
          .map((policy) =>
            [
              `- ${redactRuntimeText(policy.stageId, input.context) ?? ""} (${policy.kind})`,
              `  Max file bytes: ${policy.maxFileBytes}`,
              `  Enforcement: ${policy.enforcement}`,
              `  Deny: ${policy.deny.length > 0 ? policy.deny.join(", ") : "none"}`,
            ].join("\n"),
          )
          .join("\n")
      : "none";
  const timeoutValue = (value: number | undefined): string =>
    value === undefined ? "default" : `${value}ms`;
  const stageTimeoutLines =
    (input.stageTimeouts ?? []).length > 0
      ? (input.stageTimeouts ?? [])
          .map((timeouts) =>
            [
              `- ${redactRuntimeText(timeouts.stageId, input.context) ?? ""} (${timeouts.kind})`,
              `  Session: ${timeoutValue(timeouts.sessionMs)}`,
              `  Turn: ${timeoutValue(timeouts.turnMs)}`,
              `  Stall: ${timeoutValue(timeouts.stallMs)}`,
              `  Busy idle: ${timeoutValue(timeouts.busyIdleMs)}`,
              `  Pause: ${timeoutValue(timeouts.pauseMs)}`,
              `  Command: ${timeoutValue(timeouts.commandMs)}`,
              `  Gate: ${timeoutValue(timeouts.gateMs)}`,
            ].join("\n"),
          )
          .join("\n")
      : "none";
  const runtimeUsageLines = formatRuntimeUsageEvidence(input.runtimeUsage);
  const verificationBudgetLines = input.verificationBudget
    ? JSON.stringify(input.verificationBudget, null, 2)
    : "not declared";
  const repoIndexQueryLines = formatRepoIndexQueryEvidence(
    input.repoIndexQueries,
    input.context,
  );
  const knowledgeRetrievalLines =
    (input.knowledgeRetrievals ?? []).length > 0
      ? (input.knowledgeRetrievals ?? [])
          .map((retrieval) => {
            const heading = [
              retrieval.stageId ?? "planning",
              retrieval.attempt ? `attempt ${retrieval.attempt}` : undefined,
              retrieval.status,
              retrieval.selectedCount !== undefined
                ? `${retrieval.selectedCount} selected`
                : undefined,
              retrieval.trimmedCount
                ? `${retrieval.trimmedCount} trimmed`
                : undefined,
            ].filter(Boolean).join(" · ");
            const citations = retrieval.matches.length > 0
              ? retrieval.matches.map((match) =>
                  `  - ${redactRuntimeText(match.citation, input.context) ?? ""} (rank ${match.rank}, lexical ${match.lexicalScore ?? "n/a"}, semantic ${match.semanticScore ?? "n/a"})`
                ).join("\n")
              : "  - no passage selected";
            return `- ${heading}\n${citations}`;
          })
          .join("\n")
      : "none";
  const conformanceLines = await formatConformanceEvidence({
    context: input.context,
    policies: input.conformancePolicies,
  });
  const taskScopeLines = formatTaskScopeEvidence(input.taskScope);
  const taskIssueLines = formatTaskIssueEvidence(input.taskIssues);
  const planningApprovalLines = formatPlanningApprovalEvidence(
    input.planningApproval,
  );
  const reproducibilityLines = input.reproducibility
    ? [
        `Replayability: ${input.reproducibility.replayability}`,
        "Manifest: reproducibility.json",
        `Repo head: ${input.reproducibility.repo.headCommit ?? "unknown"}`,
        `Inputs: ${input.reproducibility.inputs.length}`,
        `Runtime stages: ${input.reproducibility.runtimes.length}`,
        input.reproducibility.missingReplayPrerequisites.length > 0
          ? `Missing prerequisites: ${input.reproducibility.missingReplayPrerequisites.join("; ")}`
          : "Missing prerequisites: none",
        input.reproducibility.nonDeterministicFactors.length > 0
          ? `Known non-determinism: ${input.reproducibility.nonDeterministicFactors.join("; ")}`
          : "Known non-determinism: none",
      ].join("\n")
    : "not available";
  const toolchainPreflightLines = input.toolchainPreflight
    ? formatToolchainPreflightEvidence(input.toolchainPreflight)
    : "not available";
  const executionBackendLines = input.executionBackend
    ? formatExecutionBackendEvidence(input.executionBackend)
    : "not available";
  const riskLines = input.riskClassification
    ? redactRuntimeText(
        renderRiskClassificationMarkdown({
          classification: input.riskClassification,
          requirement: input.riskClassification.requirement,
        }),
        input.context,
      ) ?? ""
    : "not classified";
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
              gate.reviewOutput?.verdict
                ? `  Review verdict: ${gate.reviewOutput.verdict.verdict}`
                : undefined,
              gate.reviewOutput?.verdict?.targetStage
                ? `  Review target stage: ${gate.reviewOutput.verdict.targetStage}`
                : undefined,
              gate.reviewOutput?.verdict?.targetArtifact
                ? `  Review target artifact: ${gate.reviewOutput.verdict.targetArtifact}`
                : undefined,
              gate.operatorReview
                ? `  Review source: operator (${redactRuntimeText(gate.operatorReview.actor, input.context) ?? ""})`
                : undefined,
              gate.operatorReview
                ? `  Submitted at: ${gate.operatorReview.submittedAt}`
                : undefined,
              gate.operatorReview
                ? `  Source blocker: ${gate.operatorReview.blocker.reason} on ${redactRuntimeText(gate.operatorReview.blocker.stageId, input.context) ?? ""}`
                : undefined,
              gate.reason ? `  Reason: ${gate.reason}` : undefined,
              gate.advisoryReason
                ? `  Advisory reason: ${gate.advisoryReason}`
                : undefined,
              gate.stdout ? `  Stdout: ${boundedText(gate.stdout, 500)}` : undefined,
              gate.stderr ? `  Stderr: ${boundedText(gate.stderr, 500)}` : undefined,
            ].filter((line): line is string => line !== undefined);
            return details.join("\n");
          })
          .join("\n")
      : "none";
  const hookLines =
    input.hookAttempts.length > 0
      ? input.hookAttempts
          .map((hook) =>
            [
              `- ${redactRuntimeText(hook.hookId, input.context) ?? ""}: ${hook.scope} ${hook.phase}`,
              hook.stageId
                ? `  Stage: ${redactRuntimeText(hook.stageId, input.context) ?? ""}`
                : undefined,
              hook.attempt !== undefined ? `  Attempt: ${hook.attempt}` : undefined,
              `  Status: ${hook.status ?? "passed"}`,
              `  On failure: ${hook.onFailure ?? "block"}`,
              hook.command
                ? `  Command: ${redactRuntimeText(hook.command, input.context) ?? ""}`
                : undefined,
              hook.exitCode !== undefined
                ? `  Exit code: ${hook.exitCode}`
                : undefined,
              `  Output summary: ${
                redactRuntimeText(hook.outputPath, input.context) ?? ""
              }`,
              `  Stdout: ${
                redactRuntimeText(hook.stdoutPath, input.context) ?? ""
              }`,
              `  Stderr: ${
                redactRuntimeText(hook.stderrPath, input.context) ?? ""
              }`,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n"),
          )
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
  const contextKnowledgeLines =
    (input.contextKnowledge ?? []).length > 0
      ? (input.contextKnowledge ?? [])
          .map((entry) =>
            [
              `- ${redactRuntimeText(entry.id, input.context) ?? ""} (${entry.category}): ${
                redactRuntimeText(entry.title, input.context) ?? ""
              }`,
              `  Version: ${entry.version}`,
              entry.tags.length > 0 ? `  Tags: ${entry.tags.join(", ")}` : undefined,
              `  Body: ${boundedText(redactRuntimeText(entry.body, input.context) ?? "", 500)}`,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n"),
          )
          .join("\n")
      : "none";
  const verificationDiagnosisLines =
    input.verificationDiagnoses.length > 0
      ? input.verificationDiagnoses
          .map((diagnosis) => {
            const targetDetails = [
              diagnosis.targetStage
                ? `stage ${redactRuntimeText(diagnosis.targetStage, input.context) ?? ""}`
                : undefined,
              diagnosis.targetArtifact
                ? `artifact ${redactRuntimeText(diagnosis.targetArtifact, input.context) ?? ""}`
                : undefined,
              `recommended action ${diagnosis.recommendedAction}`,
            ].filter((detail): detail is string => detail !== undefined);
            const evidence =
              diagnosis.evidence.length > 0
                ? diagnosis.evidence
                    .map(
                      (line) =>
                        `  Evidence: ${
                          redactRuntimeText(boundedText(line, 500), input.context) ?? ""
                        }`,
                    )
                    .join("\n")
                : undefined;
            return [
              `- ${redactRuntimeText(diagnosis.stageId, input.context) ?? ""} ${formatAttemptEvidence(diagnosis)}: ${diagnosis.classification} (${diagnosis.confidence}) - ${redactRuntimeText(diagnosis.reason, input.context) ?? ""}${
                targetDetails.length > 0 ? ` (${targetDetails.join("; ")})` : ""
              }`,
              evidence,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n");
          })
          .join("\n")
      : "none";
  const orchestratorDecisionLines =
    input.orchestratorDecisions.length > 0
      ? input.orchestratorDecisions
          .map((decision) => {
            const request = decision.reworkRequest;
            const targetDetails = [
              request?.targetStage ?? decision.targetStage
                ? `stage ${redactRuntimeText(request?.targetStage ?? decision.targetStage ?? "", input.context) ?? ""}`
                : undefined,
              request?.targetArtifact ?? decision.targetArtifact
                ? `artifact ${redactRuntimeText(request?.targetArtifact ?? decision.targetArtifact ?? "", input.context) ?? ""}`
                : undefined,
              request?.instructions
                ? `instructions ${redactRuntimeText(request.instructions, input.context) ?? ""}`
                : undefined,
              request?.specificIssues && request.specificIssues.length > 0
                ? `issues ${request.specificIssues
                    .map((issue) =>
                      redactRuntimeText(
                        `${issue.file ? `${issue.file}:` : ""}${issue.line ?? ""}${issue.file || issue.line ? " " : ""}${issue.problem}`,
                        input.context,
                      ) ?? "",
                    )
                    .filter(Boolean)
                    .join("; ")}`
                : undefined,
            ].filter((detail): detail is string => detail !== undefined);
            const target =
              targetDetails.length > 0 ? ` (${targetDetails.join("; ")})` : "";
            return `- ${redactRuntimeText(decision.stageId, input.context) ?? ""} ${
              formatOrchestratorAttemptEvidence(decision)
            }: ${decision.action} - ${
              redactRuntimeText(decision.reason, input.context) ?? ""
            }${target}`;
          })
          .join("\n")
      : "none";
  const operatorQuestionLines =
    (input.operatorQuestions ?? []).length > 0
      ? (input.operatorQuestions ?? [])
          .map((question) => {
            const selected = question.answer?.optionId
              ? question.options.find(
                  (option) => option.id === question.answer?.optionId,
                )
              : undefined;
            return [
              `- ${redactRuntimeText(question.id, input.context) ?? ""}: ${question.status}`,
              `  Stage: ${redactRuntimeText(question.stageId, input.context) ?? ""} attempt ${question.attempt}`,
              `  Asked at: ${question.askedAt}`,
              `  Question: ${redactRuntimeText(question.question, input.context) ?? ""}`,
              question.context
                ? `  Context: ${redactRuntimeText(question.context, input.context) ?? ""}`
                : undefined,
              selected
                ? `  Answer: option ${redactRuntimeText(selected.id, input.context) ?? ""} — ${redactRuntimeText(selected.label, input.context) ?? ""}`
                : question.answer?.text
                  ? `  Answer: ${redactRuntimeText(question.answer.text, input.context) ?? ""}`
                  : "  Answer: pending",
              question.answer
                ? `  Answered by: ${redactRuntimeText(question.answer.actor, input.context) ?? ""} at ${question.answer.answeredAt}`
                : undefined,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n");
          })
          .join("\n")
      : "none";
  const producedArtifacts = input.context.artifactEntries.filter(
    (artifact) => artifact.producer !== "external",
  );
  const artifactAttemptEntries: AttemptFileEvidence[] = producedArtifacts
    .map((artifact) => {
      const match = artifact.path?.match(/^(stages\/[^/]+\/[^/]+)\//);
      if (!match) return undefined;
      const directory = match[1]!;
      return {
        kind: "artifact",
        directory,
        outputPath: `${directory}/output.md`,
        stdoutPath: `${directory}/stdout.log`,
        stderrPath: `${directory}/stderr.log`,
      };
    })
    .filter((entry): entry is AttemptFileEvidence => entry !== undefined);
  const commandAttemptEntries: AttemptFileEvidence[] = input.commandAttempts.map(
    (attempt) => ({
      kind: "command",
      directory: attempt.directory,
      command: attempt.command,
      exitCode: attempt.exitCode,
      outputPath: attempt.outputPath ?? `${attempt.directory}/output.md`,
      stdoutPath: attempt.stdoutPath ?? `${attempt.directory}/stdout.log`,
      stderrPath: attempt.stderrPath ?? `${attempt.directory}/stderr.log`,
      environmentRepairs: attempt.environmentRepairs,
    }),
  );
  const hookAttemptEntries: AttemptFileEvidence[] = input.hookAttempts.map(
    (attempt) => ({
      kind: "hook",
      directory: attempt.directory,
      command: attempt.command,
      exitCode: attempt.exitCode,
      outputPath: attempt.outputPath ?? `${attempt.directory}/output.md`,
      stdoutPath: attempt.stdoutPath ?? `${attempt.directory}/stdout.log`,
      stderrPath: attempt.stderrPath ?? `${attempt.directory}/stderr.log`,
      environmentRepairs: attempt.environmentRepairs,
      hookId: attempt.hookId,
      hookScope: attempt.scope,
      hookPhase: attempt.phase,
      hookStatus: attempt.status,
      hookOnFailure: attempt.onFailure,
    }),
  );
  const attemptFileEntries = [
    ...new Map(
      [...artifactAttemptEntries, ...commandAttemptEntries, ...hookAttemptEntries].map((attempt) => [
        attempt.directory,
        attempt,
      ]),
    ).values(),
  ];
  const attemptFileLines =
    attemptFileEntries.length > 0
      ? attemptFileEntries
          .map((attempt) =>
            [
              `- ${redactRuntimeText(attempt.directory, input.context) ?? ""}`,
              attempt.kind === "command" && attempt.command
                ? `  Command: ${redactRuntimeText(attempt.command, input.context) ?? ""}`
                : undefined,
              attempt.kind === "hook"
                ? `  Hook: ${redactRuntimeText(attempt.hookId, input.context) ?? ""} (${attempt.hookScope} ${attempt.hookPhase})`
                : undefined,
              attempt.kind === "hook" && attempt.hookStatus
                ? `  Hook status: ${attempt.hookStatus}`
                : undefined,
              attempt.kind === "hook" && attempt.hookOnFailure
                ? `  On failure: ${attempt.hookOnFailure}`
                : undefined,
              attempt.kind === "hook" && attempt.command
                ? `  Command: ${redactRuntimeText(attempt.command, input.context) ?? ""}`
                : undefined,
              attempt.kind === "command" && attempt.exitCode !== undefined
                ? `  Exit code: ${attempt.exitCode}`
                : undefined,
              attempt.kind === "hook" && attempt.exitCode !== undefined
                ? `  Exit code: ${attempt.exitCode}`
                : undefined,
              attempt.kind === "command" &&
              (attempt.environmentRepairs?.length ?? 0) > 0
                ? `  Environment repairs: ${formatCommandEnvironmentRepairs(attempt.environmentRepairs ?? [])}`
                : undefined,
              attempt.kind === "hook" &&
              (attempt.environmentRepairs?.length ?? 0) > 0
                ? `  Environment repairs: ${formatCommandEnvironmentRepairs(attempt.environmentRepairs ?? [])}`
                : undefined,
              `  Output summary: ${
                redactRuntimeText(attempt.outputPath, input.context) ?? ""
              }`,
              attempt.kind === "command"
                ? undefined
                : `  Manifest: ${
                    redactRuntimeText(`${attempt.directory}/artifact.json`, input.context) ?? ""
                  }`,
              `  Stdout: ${
                redactRuntimeText(attempt.stdoutPath, input.context) ?? ""
              }`,
              `  Stderr: ${
                redactRuntimeText(attempt.stderrPath, input.context) ?? ""
              }`,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n"),
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
  const inputLines = [...input.inputs.values()]
    .map((artifact) =>
      [
        `- ${redactRuntimeText(artifact.id, input.context) ?? ""}`,
        `  Source URI: ${
          redactRuntimeText(artifact.resource.sourceUri, input.context) ?? ""
        }`,
        `  Media type: ${
          redactRuntimeText(artifact.resource.mediaType, input.context) ?? ""
        }`,
        `  Snapshot path: ${
          redactRuntimeText(
            relative(input.runDirectory, artifact.contentPath),
            input.context,
          ) ?? ""
        }`,
      ].join("\n"),
    )
    .join("\n");
  const configurationLines = Object.entries(input.configuration)
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join("\n") || "none";
  const body = [
    `# Nitely Run Evidence: ${input.flowName}`,
    "",
    `Run ID: ${input.runId}`,
    `Status: ${input.status ?? "in-progress"}`,
    `Branch: ${input.branchName}`,
    `Base branch: ${input.baseBranch}`,
    `Source repository: ${redactRuntimeText(changeSummary.sourceRepository, input.context) ?? ""}`,
    "",
    ...sourceIssueSection,
    ...titleSection,
    ...changeRequestSection,
    ...targetSection,
    ...syncSection,
    ...constitutionSection,
    ...projectInstructionsSection,
    "## Inputs",
    "",
    inputLines,
    "",
    "## Configuration",
    "",
    configurationLines,
    "",
    "## Changed Files",
    "",
    `Compare: ${redactRuntimeText(changeSummary.compareRef, input.context) ?? ""}`,
    "Diff summary:",
    redactRuntimeText(changeSummary.diffStat, input.context) ?? "",
    "",
    "Files:",
    redactRuntimeText(changeSummary.files, input.context) ?? "",
    "",
    "Worktree status:",
    redactRuntimeText(changeSummary.worktreeStatus, input.context) ?? "",
    "",
    "## Agent Runtimes",
    "",
    agentRuntimeLines,
    "",
    "## Stage Context Controls",
    "",
    stageContextControlLines,
    "",
    "## Stage Read Policies",
    "",
    stageReadPolicyLines,
    "",
    "## Stage Timeouts",
    "",
    stageTimeoutLines,
    "",
    "## Runtime Usage",
    "",
    runtimeUsageLines,
    "",
    "## Verification Budget",
    "",
    verificationBudgetLines,
    "",
    "## Repository Index Queries",
    "",
    repoIndexQueryLines,
    "",
    "## External Knowledge Retrieval",
    "",
    knowledgeRetrievalLines,
    "",
    "## Conformance",
    "",
    conformanceLines,
    "",
    "## Task Scope",
    "",
    taskScopeLines,
    "",
    "## Task Issues",
    "",
    taskIssueLines,
    "",
    "## Planning Approval",
    "",
    planningApprovalLines,
    "",
    "## Reproducibility",
    "",
    reproducibilityLines,
    "",
    "## Toolchain Preflight",
    "",
    toolchainPreflightLines,
    "",
    "## Execution Sandbox",
    "",
    executionBackendLines,
    "",
    "## Risk Classification",
    "",
    riskLines,
    "",
    "## Gates",
    "",
    gateLines,
    "",
    "## Hooks",
    "",
    hookLines,
    "",
    "## Loaded Skills",
    "",
    loadedSkillLines,
    "",
    "## Context Knowledge",
    "",
    contextKnowledgeLines,
    "",
    "## Verification Diagnoses",
    "",
    verificationDiagnosisLines,
    "",
    "## Orchestrator Decisions",
    "",
    orchestratorDecisionLines,
    "",
    "## Operator Questions And Answers",
    "",
    operatorQuestionLines,
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
    .filter(isCapabilityStage)
    .map((stage) => ({
      stageId: stage.id,
      stageKind: stage.type === "judge"
        ? "judge"
        : stage.type === "agent"
          ? "agent"
          : "review-gate",
      candidates: stageRuntimeCandidates(stage),
      capabilityPolicy: effectiveCapabilityPolicy(stage),
    }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function commandEnvironmentRepairsValue(
  value: unknown,
): CommandEnvironmentRepair[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const id = stringValue(record.id);
      const description = stringValue(record.description);
      const scope = stringValue(record.scope);
      if (
        !id ||
        !description ||
        (scope !== "environment" && scope !== "outside-worktree")
      ) {
        return undefined;
      }
      return {
        id,
        description,
        scope,
        ...(stringValue(record.path) ? { path: stringValue(record.path) } : {}),
      };
    })
    .filter((entry): entry is CommandEnvironmentRepair => entry !== undefined);
}

function collectCommandEnvironmentRepairs(
  events: StoredRunEvent[],
): CommandEnvironmentRepair[] {
  const repairs: CommandEnvironmentRepair[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "command.completed") continue;
    for (const repair of commandEnvironmentRepairsValue(
      asRecord(event.payload).environmentRepairs,
    )) {
      const key = `${repair.id}\0${repair.scope}\0${repair.path ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repairs.push(repair);
    }
  }
  return repairs;
}

function runRelativeEvidencePath(input: {
  runDirectory: string;
  path: string | undefined;
}): string | undefined {
  if (!input.path) return undefined;
  if (!isAbsolute(input.path)) return input.path;
  if (!isPathInside(resolve(input.runDirectory), resolve(input.path))) {
    return undefined;
  }
  return relative(input.runDirectory, input.path);
}

function collectCommandAttemptEvidence(input: {
  runDirectory: string;
  stages: Stage[];
  events: StoredRunEvent[];
}): CommandAttemptEvidence[] {
  const commandStageIds = new Set(
    input.stages
      .filter((stage) => stage.type === "command")
      .map((stage) => stage.id),
  );
  return input.events
    .filter(
      (event) =>
        event.type === "command.completed" &&
        event.stageId !== undefined &&
        event.attempt !== undefined &&
        commandStageIds.has(event.stageId),
    )
    .map((event) => {
      const payload = asRecord(event.payload);
      const directory = `stages/${event.stageId}/${event.attempt}`;
      return {
        stageId: event.stageId!,
        attempt: event.attempt!,
        directory,
        command: stringValue(payload.command),
        exitCode: numberValue(payload.exitCode),
        outputPath:
          runRelativeEvidencePath({
            runDirectory: input.runDirectory,
            path: stringValue(payload.outputPath),
          }) ?? `${directory}/output.md`,
        stdoutPath:
          runRelativeEvidencePath({
            runDirectory: input.runDirectory,
            path: stringValue(payload.stdoutPath),
          }) ?? `${directory}/stdout.log`,
        stderrPath:
          runRelativeEvidencePath({
            runDirectory: input.runDirectory,
            path: stringValue(payload.stderrPath),
          }) ?? `${directory}/stderr.log`,
        environmentRepairs: commandEnvironmentRepairsValue(
          payload.environmentRepairs,
        ),
      };
    });
}

function collectHookAttemptEvidence(input: {
  runDirectory: string;
  events: StoredRunEvent[];
}): HookAttemptEvidence[] {
  return input.events
    .filter((event) => event.type === "hook.completed")
    .map((event) => {
      const payload = asRecord(event.payload);
      const hookId = stringValue(payload.hookId) ?? "unknown-hook";
      const scopeValue = stringValue(payload.scope);
      const phaseValue = stringValue(payload.phase);
      const scope: HookAttemptEvidence["scope"] =
        scopeValue === "stage" ? "stage" : "flow";
      const phase: HookAttemptEvidence["phase"] =
        phaseValue === "postRun" ||
        phaseValue === "pre" ||
        phaseValue === "post"
          ? phaseValue
          : "preRun";
      const fallbackDirectory =
        scope === "stage"
          ? `stages/${event.stageId ?? "unknown"}/${event.attempt ?? 1}/hooks/${phase}/${hookId}`
          : `hooks/flow/${phase}/${hookId}`;
      const outputPath = runRelativeEvidencePath({
        runDirectory: input.runDirectory,
        path: stringValue(payload.outputPath),
      });
      const stdoutPath = runRelativeEvidencePath({
        runDirectory: input.runDirectory,
        path: stringValue(payload.stdoutPath),
      });
      const stderrPath = runRelativeEvidencePath({
        runDirectory: input.runDirectory,
        path: stringValue(payload.stderrPath),
      });
      const statusValue = stringValue(payload.status);
      const onFailureValue = stringValue(payload.onFailure);
      return {
        hookId,
        scope,
        phase,
        ...(event.stageId ? { stageId: event.stageId } : {}),
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        directory: outputPath
          ? outputPath.split("/").slice(0, -1).join("/")
          : fallbackDirectory,
        command: stringValue(payload.command),
        onFailure:
          onFailureValue === "warn" || onFailureValue === "evidence-only"
            ? onFailureValue
            : "block",
        exitCode: numberValue(payload.exitCode),
        status:
          statusValue === "blocked" ||
          statusValue === "warned" ||
          statusValue === "recorded"
            ? statusValue
            : "passed",
        outputPath: outputPath ?? `${fallbackDirectory}/output.md`,
        stdoutPath: stdoutPath ?? `${fallbackDirectory}/stdout.log`,
        stderrPath: stderrPath ?? `${fallbackDirectory}/stderr.log`,
        environmentRepairs: commandEnvironmentRepairsValue(
          payload.environmentRepairs,
        ),
      };
    });
}

async function gitCommit(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit(cwd, ["rev-parse", ref])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function reproducibilityInputSnapshots(input: {
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
}): Promise<ReproducibilityInputSnapshot[]> {
  const snapshots: ReproducibilityInputSnapshot[] = [];
  for (const artifact of input.inputs.values()) {
    const manifest = input.context.manifestEntries.find(
      (entry) => entry.id === artifact.id && entry.kind === "external-input",
    );
    snapshots.push({
      id: redactRuntimeText(artifact.id, input.context) ?? artifact.id,
      connector: artifact.reference.connector,
      sourceUri:
        redactRuntimeText(artifact.resource.sourceUri, input.context) ??
        artifact.resource.sourceUri,
      mediaType: artifact.resource.mediaType,
      revision: artifact.resource.revision,
      runRelativePath: manifest?.runRelativePath,
      sha256: await sha256File(artifact.contentPath),
      policy: manifest?.policy,
    });
  }
  return snapshots;
}

function reproducibilityRuntimeStages(input: {
  stages: Stage[];
  events: StoredRunEvent[];
}): ReproducibilityManifest["runtimes"] {
  const selectedByStage = new Map<string, RuntimeCandidate>();
  for (const event of input.events) {
    if (event.type !== "stage.runtime.selected" || !event.stageId) continue;
    const payload = asRecord(event.payload);
    const runtime = stringValue(payload.runtime);
    if (!runtime) continue;
    selectedByStage.set(event.stageId, {
      runtime,
      ...(stringValue(payload.model) ? { model: stringValue(payload.model) } : {}),
    });
  }
  return collectAgentRuntimeEvidence(input.stages).map((stage) => ({
    stageId: stage.stageId,
    kind: stage.stageKind,
    candidates: stage.candidates,
    ...(selectedByStage.get(stage.stageId)
      ? { selected: selectedByStage.get(stage.stageId) }
      : {}),
  }));
}

function reproducibilityCommandStages(stages: Stage[]): ReproducibilityManifest["commands"] {
  return stages
    .filter((stage): stage is Extract<Stage, { type: "command" }> => stage.type === "command")
    .map((stage) => ({
      stageId: stage.id,
      command: stage.command,
      ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
    }));
}

function reproducibilitySkillSources(
  loadedSkills: StageSkillUsage[],
): ReproducibilityManifest["skills"] {
  return loadedSkills.flatMap((usage) =>
    usage.skills.map((skill) => ({
      stageId: usage.stageId,
      id: skill.id,
      sourcePath: skill.sourcePath,
      contentHash: `sha256:${skill.contentHash}`,
      resources: skill.resources.map((resource) => resource.snapshotPath),
    })),
  );
}

function reproducibilityNonDeterminism(input: {
  runtimes: ReproducibilityManifest["runtimes"];
  inputs: ReproducibilityInputSnapshot[];
}): string[] {
  const factors: string[] = [];
  if (input.runtimes.length > 0) {
    factors.push("agent runtime output depends on external model/provider behavior");
  }
  if (input.inputs.some((entry) => entry.connector !== "local-file")) {
    factors.push("external connector inputs may change outside the repository");
  }
  return factors;
}

function reproducibilityMissingPrerequisites(input: {
  repoHeadCommit?: string;
  inputs: ReproducibilityInputSnapshot[];
}): string[] {
  const missing: string[] = [];
  if (!input.repoHeadCommit) {
    missing.push("repo head commit could not be resolved");
  }
  for (const snapshot of input.inputs) {
    if (!snapshot.sha256) {
      missing.push(`input ${snapshot.id} snapshot hash unavailable`);
    }
  }
  return missing;
}

async function providerStatusesForReproducibility(
  providerStore: ProviderConnectionStore,
): Promise<ProviderConnectionStatus[]> {
  try {
    return await providerStore.listStatuses();
  } catch {
    return [];
  }
}

type EffectiveBudgetControls = Partial<VerificationBudget> & {
  maxCostUsd?: number;
};

function effectiveFlowBudgets(flow: Flow): EffectiveBudgetControls | undefined {
  const verification = flow.spec.verificationBudget;
  if (!verification) return undefined;
  return {
    ...verification,
    ...(verification.maxRuntimeCostUsd !== undefined
      ? { maxCostUsd: verification.maxRuntimeCostUsd }
      : {}),
  };
}

function workflowStageManifest(stages: Stage[]): unknown[] {
  return stages.map((stage) => ({
    id: stage.id,
    type: stage.type,
    ...(stage.costClass ? { costClass: stage.costClass } : {}),
    ...(typeof (stage as { command?: unknown }).command === "string"
      ? { command: (stage as { command: string }).command }
      : {}),
    inputs: stage.inputs,
    outputs: stageOutputIds(stage),
    maxAttempts: stage.maxAttempts,
  }));
}

function contextKnowledgeSummary(entry: ContextKnowledgeEntry): Record<string, unknown> {
  return {
    id: entry.id,
    category: entry.category,
    title: entry.title,
    status: entry.status,
    version: entry.version,
    tags: entry.tags,
    keywords: entry.keywords,
  };
}

function contextKnowledgeQuery(input: {
  flowName: string;
  flowPath: string;
  repoName?: string;
  workItemId?: string;
  workItemType?: string;
  inputArtifacts: Map<string, InputArtifact>;
}): string[] {
  return [
    input.flowName,
    input.flowPath,
    input.repoName,
    input.workItemId,
    input.workItemType,
    ...[...input.inputArtifacts.values()].flatMap((artifact) => [
      artifact.id,
      artifact.resource.sourceUri,
      artifact.resource.metadata?.filename,
      artifact.reference.uri,
    ]),
  ].filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

async function prepareContextKnowledgeForRun(input: {
  repoPath: string;
  runId: string;
  flowName: string;
  flowPath: string;
  repoName?: string;
  workItemId?: string;
  workItemType?: string;
  inputArtifacts: Map<string, InputArtifact>;
  eventStore: EventStore;
  context: RuntimeContext;
}): Promise<ContextKnowledgeEntry[]> {
  const query = contextKnowledgeQuery(input);
  const entries = await selectContextKnowledgeEntries({
    repoPath: input.repoPath,
    query,
  });
  if (entries.length === 0) return [];
  await linkContextKnowledgeEntries(
    input.repoPath,
    entries.map((entry) => entry.id),
    {
      runId: input.runId,
      taskId: input.workItemId,
    },
  );
  input.eventStore.append({
    runId: input.runId,
    type: "context-kg.injected",
    payload: redactRuntimeUnknown(
      {
        query,
        linkedTaskId: input.workItemId,
        entries: entries.map(contextKnowledgeSummary),
      },
      input.context,
    ),
  });
  return entries;
}

function contextKnowledgeCategoryValue(
  value: unknown,
): ContextKnowledgeCategory | undefined {
  return typeof value === "string" &&
    CONTEXT_KNOWLEDGE_CATEGORIES.includes(value as ContextKnowledgeCategory)
    ? (value as ContextKnowledgeCategory)
    : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function contextKnowledgeProposalPayloads(markdown: string): Array<{
  category: ContextKnowledgeCategory;
  title: string;
  body: string;
  tags?: string[];
  keywords?: string[];
}> {
  const proposals: Array<{
    category: ContextKnowledgeCategory;
    title: string;
    body: string;
    tags?: string[];
    keywords?: string[];
  }> = [];
  const blocks = markdown.matchAll(/```context-kg\s*([\s\S]*?)```/gi);
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue;
    }
    const recordEntries = asRecord(parsed).entries;
    const rawEntries: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(recordEntries)
        ? recordEntries
        : [];
    for (const rawEntry of rawEntries) {
      const record = asRecord(rawEntry);
      const category = contextKnowledgeCategoryValue(record.category);
      const title = stringValue(record.title);
      const body = stringValue(record.body);
      if (!category || !title || !body) continue;
      const tags = stringArrayValue(record.tags);
      const keywords = stringArrayValue(record.keywords);
      proposals.push({
        category,
        title,
        body,
        ...(tags ? { tags } : {}),
        ...(keywords ? { keywords } : {}),
      });
    }
  }
  return proposals;
}

async function createContextKnowledgeProposalsFromFinalizerOutputs(input: {
  repoPath: string;
  runId: string;
  workItemId?: string;
  stage: Extract<Stage, { type: "agent" }>;
  inputArtifacts: Map<string, InputArtifact>;
  context: RuntimeContext;
  eventStore: EventStore;
}): Promise<ContextKnowledgeEntry[]> {
  const created: ContextKnowledgeEntry[] = [];
  for (const output of input.stage.outputs) {
    const artifact = input.inputArtifacts.get(outputId(output));
    if (!artifact) continue;
    const markdown = artifact.resource.content.toString("utf8");
    for (const proposal of contextKnowledgeProposalPayloads(markdown)) {
      try {
        const source = {
          type: "reflection" as const,
          runId: input.runId,
          ...(input.workItemId ? { taskId: input.workItemId } : {}),
        };
        const entry = await createContextKnowledgeEntry(input.repoPath, {
          ...proposal,
          title: redactRuntimeText(proposal.title, input.context) ?? proposal.title,
          body: redactRuntimeText(proposal.body, input.context) ?? proposal.body,
          status: "proposed",
          source,
        });
        const [linked] = await linkContextKnowledgeEntries(
          input.repoPath,
          [entry.id],
          {
            runId: input.runId,
            taskId: input.workItemId,
          },
        );
        const proposalEntry = linked ?? entry;
        created.push(proposalEntry);
        try {
          await ensureContextKnowledgeProposalNotification({
            repoPath: input.repoPath,
            entry: proposalEntry,
            body: "Reflection proposed reusable repository knowledge.",
            ...(input.workItemId ? { taskId: input.workItemId } : {}),
            runId: input.runId,
          });
        } catch {
          // The proposal is durable even if its local notification cannot be written.
        }
      } catch {
        continue;
      }
    }
  }
  if (created.length > 0) {
    input.eventStore.append({
      runId: input.runId,
      type: "context-kg.proposed",
      payload: redactRuntimeUnknown(
        {
          sourceStageId: input.stage.id,
          linkedTaskId: input.workItemId,
          entries: created.map(contextKnowledgeSummary),
        },
        input.context,
      ),
    });
  }
  return created;
}

function firstAgentRuntimeCandidate(stages: Stage[]): RuntimeCandidate | undefined {
  for (const stage of stages) {
    if (stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review")) {
      return stageRuntimeCandidates(stage)[0];
    }
  }
  return undefined;
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

const REPOSITORY_INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

interface InjectedAgentMemoryScope {
  cleanup(): Promise<void>;
  ensureInjected(): Promise<void>;
}

interface HiddenRepositoryInstructionFile {
  filename: (typeof REPOSITORY_INSTRUCTION_FILENAMES)[number];
  path: string;
  hiddenPath: string;
}

async function hideRepositoryInstructionFiles(input: {
  worktreePath: string;
  attemptDirectory: string;
}): Promise<HiddenRepositoryInstructionFile[]> {
  const hidden: HiddenRepositoryInstructionFile[] = [];
  const hiddenDirectory = join(
    input.attemptDirectory,
    "disabled-repository-instructions",
  );
  await mkdir(hiddenDirectory, { recursive: true });
  for (const filename of REPOSITORY_INSTRUCTION_FILENAMES) {
    const path = join(input.worktreePath, filename);
    const hiddenPath = join(hiddenDirectory, filename);
    try {
      await rename(path, hiddenPath);
      hidden.push({ filename, path, hiddenPath });
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
  }
  return hidden;
}

async function restoreRepositoryInstructionFiles(
  hidden: HiddenRepositoryInstructionFile[],
): Promise<void> {
  for (const file of hidden.reverse()) {
    try {
      await stat(file.path);
      throw new Error(
        `cannot restore disabled repository instruction file ${file.filename}: ${file.path} was recreated during the stage; original remains at ${file.hiddenPath}`,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // Expected: restore only when the stage did not recreate the hidden file.
      } else {
        throw error;
      }
    }
    try {
      await rename(file.hiddenPath, file.path);
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
  }
}

async function prepareStageInstructionFilesBeforeAttempt(input: {
  stage: AgentRunnableStage;
  controls: ResolvedStageContextControls;
  injectedAgentMemory?: InjectedAgentMemoryScope;
}): Promise<void> {
  const shouldInjectGeneratedMemory =
    input.controls.instructionFiles && input.stage.type === "agent";
  if (shouldInjectGeneratedMemory) {
    await input.injectedAgentMemory?.ensureInjected();
  } else {
    await input.injectedAgentMemory?.cleanup();
  }
}

async function withStageInstructionFiles<T>(input: {
  stage: AgentRunnableStage;
  controls: ResolvedStageContextControls;
  attemptDirectory: string;
  workspace: WorkspaceHandle;
  injectedAgentMemory?: InjectedAgentMemoryScope;
  run: () => Promise<T>;
}): Promise<T> {
  if (!input.workspace.path) {
    return await input.run();
  }
  await prepareStageInstructionFilesBeforeAttempt(input);
  const hidden = input.controls.instructionFiles
    ? []
    : await hideRepositoryInstructionFiles({
        worktreePath: input.workspace.path,
        attemptDirectory: input.attemptDirectory,
      });
  try {
    return await input.run();
  } finally {
    await restoreRepositoryInstructionFiles(hidden);
  }
}

function createInjectedAgentMemoryScope(
  input: {
    repoPath: string;
    workspace: WorkspaceHandle;
    stages: Stage[];
    runId: string;
    eventStore: EventStore;
    context: RuntimeContext;
  },
): InjectedAgentMemoryScope {
  const injectedFiles: InjectedAgentMemoryFile[] = [];
  let preparedContent: string | undefined;
  let knowledgeGeneratedEventRecorded = false;
  return {
    cleanup: async () => {
      await cleanupInjectedAgentMemory(injectedFiles);
      if (input.workspace.path) {
        await removeGeneratedAgentMemoryFilesFromGit(input.workspace.path);
      }
    },
    ensureInjected: async () => {
      if (!input.workspace.path || injectedFiles.length > 0) {
        return;
      }
      const runtime = firstAgentRuntimeCandidate(input.stages);
      if (!runtime) {
        return;
      }
      try {
        if (preparedContent === undefined) {
          const prepared = await prepareAgentMemory({
            repoPath: input.repoPath,
            runtime: runtime.runtime,
            model: runtime.model,
          });
          preparedContent = prepared.content;
          if (prepared.generated && !knowledgeGeneratedEventRecorded) {
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
            knowledgeGeneratedEventRecorded = true;
          }
        }
        injectedFiles.push(
          ...(await injectAgentMemoryFiles({
            worktreePath: input.workspace.path,
            content: preparedContent,
          })),
        );
      } catch {
        await cleanupInjectedAgentMemory(injectedFiles);
      }
    },
  };
}

export async function runFlow(
  input: RunFlowInput,
  dependencies: RunFlowDependencies = {},
): Promise<RunFlowResult> {
  const repoPath = resolve(input.repoPath);
  if (
    input.evalReplayInvocationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.evalReplayInvocationId,
    )
  ) {
    throw new Error("invalid eval replay invocation id");
  }
  assertPlanningReadyForExecution(input.planningApproval);
  const providerStore = providerStoreForRun(repoPath, dependencies);
  const contextPolicy = await loadContextPolicy(repoPath);
  const contextPolicySha256 = sha256Text(JSON.stringify(contextPolicy));
  if (
    input.expectedContextPolicySha256 !== undefined &&
    input.expectedContextPolicySha256 !== contextPolicySha256
  ) {
    throw new Error(
      `context policy digest mismatch: expected ${input.expectedContextPolicySha256}, got ${contextPolicySha256}`,
    );
  }
  const constitution = await loadConstitution(repoPath);
  const projectInstructions = await loadProjectInstructions(repoPath);
  assertExpectedPromptContext({
    expected: input.expectedPromptContext,
    constitution,
    projectInstructions,
    label: "eval replay prompt context",
  });
  const backendResolution = await resolveBackend(
    input.executionBackend,
    dependencies,
    providerStore,
    input.sandboxPolicy,
  );
  const backend = backendResolution.backend;
  await backend.prepareForRun?.();
  const redactionSecrets = [
    ...(await collectRuntimeRedactionSecrets({
      policy: contextPolicy,
      dependencies,
      providerStore,
      includeProviderStore: !dependencies.backend,
    })),
    ...(backend.redactionSecrets?.() ?? []),
  ];
  const runId = (dependencies.createRunId ?? createDefaultRunId)();
  const effectiveExecutionBackend = normalizeExecutionBackendName(
    input.executionBackend ?? backendResolution.env.NITELY_EXECUTION_BACKEND,
  );
  const effectiveSandboxPolicy: RunSandboxPolicy | undefined =
    dependencies.backend
      ? undefined
      : {
          codex: requireCodexSandboxMode(
            input.sandboxPolicy?.codex ??
              backendResolution.env.NITELY_CODEX_SANDBOX ??
              backendResolution.env.NIGHTLY_CODEX_SANDBOX ??
              "danger-full-access",
          ),
        };
  let branchName = `nitely/${runId}`;
  let baseBranch = (await runGit(repoPath, ["branch", "--show-current"])).trim();
  let baseCommit: string | undefined;
  if (input.expectedSourceRevision !== undefined) {
    if (!baseBranch) baseBranch = input.expectedSourceRevision;
    if (!/^[0-9a-f]{40}$/i.test(input.expectedSourceRevision)) {
      throw new Error("expected source revision must be a 40-character commit SHA");
    }
    baseCommit = await gitCommit(
      repoPath,
      `${input.expectedSourceRevision}^{commit}`,
    );
    if (baseCommit?.toLowerCase() !== input.expectedSourceRevision.toLowerCase()) {
      throw new Error(
        `expected source revision is not an available commit: ${input.expectedSourceRevision}`,
      );
    }
  } else {
    const baseline = await resolveFreshRemoteBaseline({
      repoPath,
      runId,
      localBranch: baseBranch || undefined,
    });
    baseBranch = baseline.baseBranch;
    baseCommit = baseline.baseCommit;
  }
  const runDirectory = join(repoPath, ".nitely", "runs", runId);
  const worktreePath = join(runDirectory, "worktree");
  const loadedFlowDocument =
    input.flowDocument ?? (await readFile(input.flowPath, "utf8"));
  const loaded = parseFlowDocument(loadedFlowDocument, {
    externalInputs: Object.keys(input.inputs),
  });
  const runWorkItemType = input.workItemType ?? flowWorkItemType(loaded.flow);
  await assertWorkItemTypeAllowed({
    repoPath,
    workItemType: runWorkItemType,
    loaded,
  });
  let configuration: FlowConfiguration;
  try {
    configuration = normalizeFlowConfiguration(loaded.flow, input.configuration ?? {});
  } catch (error) {
    if (error instanceof FlowConfigurationError) {
      throw new Error(error.message);
    }
    throw error;
  }
  if (input.evalReplayInvocationId !== undefined) {
    assertEvalReplayConfigurationHasNoSecrets(configuration);
  }
  const runInputReferences = flowInputReferences(loaded.flow, input.inputs);
  assertDeclaredInputsSupplied(loaded.flow, runInputReferences);
  for (const inputId of Object.keys(runInputReferences)) {
    assertSafePathSegment("input artifact id", inputId);
  }
  if (input.changeRequestTarget) {
    if (input.expectedSourceRevision !== undefined) {
      throw new Error(
        "expected source revision cannot be combined with a change request target",
      );
    }
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
    baseCommit = await gitCommit(repoPath, baseBranch);
    reworkTarget = {
      provider: input.changeRequestTarget.provider,
      target: input.changeRequestTarget.target,
      resolved,
      previousHeadSha: resolved.headSha,
    };
  }

  await mkdir(runDirectory, { recursive: true });
  const configurationSnapshotPath = input.evalReplayInvocationId !== undefined
    ? "configuration.json"
    : undefined;
  const configurationDocument = JSON.stringify(configuration);
  const configurationSha256 = sha256Text(configurationDocument);
  if (configurationSnapshotPath) {
    await writeRunOwnedFileAtomically({
      runDirectory,
      path: configurationSnapshotPath,
      subject: "eval replay configuration snapshot",
      content: configurationDocument,
    });
  }
  const runtimeContext: RuntimeContext = {
    runId,
    repoPath,
    runDirectory,
    manifestEntries: [],
    manifestEntryIndexes: new Map(),
    artifactEntries: [],
    artifactEntryIndexes: new Map(),
    redactionSecrets,
    constitution,
    projectInstructions,
    expectedSkillContentHashes: input.expectedSkillContentHashes,
  };
  const eventStore = (dependencies.createEventStore ??
    ((path: string) => new EventStore(path)))(eventStorePath(repoPath));
  let inputArtifacts: Map<string, InputArtifact>;
  try {
    runtimeContext.knowledgeSnapshots = await pinExternalKnowledgeForRun({
      repoPath,
      runDirectory,
      flow: loaded.flow,
      dependencies,
      providerStore: dependencies.knowledgeProviderStore ?? providerStore,
      redactionSecrets,
    });
    inputArtifacts = await snapshotInputs({
      repoPath,
      runDirectory,
      inputReferences: runInputReferences,
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
      workItemType: runWorkItemType,
      planningApproval: input.planningApproval,
      runEligibilityOverride: input.runEligibilityOverride,
      flowPath: input.flowPath,
      flowDocument: loadedFlowDocument,
      flowDocumentSha256: sha256Text(loadedFlowDocument),
      repoPath,
      repoId: input.repoId,
      repoName: input.repoName,
      contextPolicySha256,
      promptContext: promptContextIdentity({ constitution, projectInstructions }),
      expectedSkillContentHashes: input.expectedSkillContentHashes,
      knowledgeSnapshots: runtimeContext.knowledgeSnapshots,
      evalReplayInvocationId: input.evalReplayInvocationId,
      executionBackend: effectiveExecutionBackend,
      sandboxPolicy: effectiveSandboxPolicy,
      inputs: runInputReferences,
      configuration,
      configurationSnapshotPath,
      configurationSha256,
      baseCommit,
      ...(defaultMaxRuntimeTokens() !== undefined
        ? { budgets: { maxRuntimeTokens: defaultMaxRuntimeTokens() } }
        : {}),
      verificationBudget: loaded.flow.spec.verificationBudget,
      workflowStages: workflowStageManifest(loaded.flow.spec.stages),
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
  const loadedSkillUsages: StageSkillUsage[] = [];
  const writeRunReproducibilitySnapshot = async (): Promise<ReproducibilityManifest> => {
    const events = eventStore.list(runId);
    const inputSnapshots = await reproducibilityInputSnapshots({
      inputs: inputArtifacts,
      context: runtimeContext,
    });
    const runtimes = reproducibilityRuntimeStages({
      stages: loaded.flow.spec.stages,
      events,
    });
    const execution = backend.describeExecution?.();
    const headCommit =
      (await currentBranchHeadSha(worktreePath)) ?? (await gitCommit(repoPath, "HEAD"));
    return await writeReproducibilityManifest({
      runDirectory,
      runId,
      repo: {
        path: repoPath,
        name: input.repoName,
        baseBranch,
        baseCommit,
        branch: branchName,
        headCommit,
        worktreePath,
      },
      flow: {
        name: loaded.flow.metadata.name,
        path: input.flowPath,
        documentSha256: sha256Text(loadedFlowDocument),
        configurationSha256,
      },
      inputs: inputSnapshots,
      context: {
        policySha256: contextPolicySha256,
        constitution: {
          loaded: runtimeContext.constitution.loaded,
          path: runtimeContext.constitution.path,
          ...(runtimeContext.constitution.loaded
            ? { hash: runtimeContext.constitution.hash }
            : {}),
        },
        projectInstructions: {
          loaded: runtimeContext.projectInstructions.loaded,
          path: runtimeContext.projectInstructions.path,
          ...(runtimeContext.projectInstructions.loaded
            ? { hash: runtimeContext.projectInstructions.hash }
            : {}),
        },
      },
      runtimes,
      commands: reproducibilityCommandStages(loaded.flow.spec.stages),
      skills: reproducibilitySkillSources(loadedSkillUsages),
      providers: await providerStatusesForReproducibility(providerStore),
      executionBackend: effectiveExecutionBackend,
      ...(execution?.imageIdentity && execution.imageReference
        ? {
            executionImage: {
              reference: execution.imageReference,
              identity: execution.imageIdentity,
            },
          }
        : {}),
      sandboxPolicy: effectiveSandboxPolicy,
      nonDeterministicFactors: reproducibilityNonDeterminism({
        runtimes,
        inputs: inputSnapshots,
      }),
      missingReplayPrerequisites: reproducibilityMissingPrerequisites({
        repoHeadCommit: headCommit,
        inputs: inputSnapshots,
      }),
    });
  };
  await writeRunReproducibilitySnapshot();
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
  let taskIssues: ResolvedTaskIssueScope | undefined;
  if (taskScopeSelection) {
    try {
      taskIssues = await taskIssueScopeForRun({
        repoPath,
        taskIds: taskScopeSelection.selectedTaskIds,
        dependencies,
        providerStore,
      });
    } catch (error) {
      taskIssues = {
        issues: [],
        missingTaskIds: taskScopeSelection.selectedTaskIds,
        registryError: error instanceof Error ? error.message : String(error),
      };
    }
    if (taskIssues.registryError) {
      eventStore.append({
        runId,
        type: "task.issue.registry_unavailable",
        payload: redactRuntimeUnknown(
          { error: taskIssues.registryError },
          runtimeContext,
        ),
      });
    }
    eventStore.append({
      runId,
      type: "task.issue.scope_resolved",
      payload: redactRuntimeUnknown(
        {
          schemaVersion: "nitely.task-issue-scope.v1",
          ...taskIssues,
        },
        runtimeContext,
      ),
    });
  }
  const contextKnowledge = await prepareContextKnowledgeForRun({
    repoPath,
    runId,
    flowName: loaded.flow.metadata.name,
    flowPath: input.flowPath,
    repoName: input.repoName,
    workItemId: input.workItemId,
    workItemType: input.workItemType ?? loaded.flow.metadata.workItemType,
    inputArtifacts,
    eventStore,
    context: runtimeContext,
  });
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
    try {
      workspace = await backend.createWorkspace({
        repoPath,
        branchName,
        runId,
        worktreePath,
        sourceRevision: baseCommit,
      });
    } catch (error) {
      eventStore.append({
        runId,
        type: "run.failed",
        payload: redactRuntimeUnknown({
          stageId: "workspace",
          error: error instanceof Error ? error.message : String(error),
        }, runtimeContext),
      });
      eventStore.close();
      throw error;
    }
  }
  eventStore.append({
    runId,
    type: "workspace.created",
    payload: { worktreePath },
  });
  const writeRunToolchainPreflightSnapshot = async (
    events: StoredRunEvent[] = eventStore.list(runId),
  ): Promise<ToolchainPreflight> =>
    await writeToolchainPreflight({
      runDirectory,
      runId,
      repoPath,
      worktreePath: workspace.path ?? worktreePath,
      executionBackend: effectiveExecutionBackend,
      envSource: backendResolution.envSource,
      env: backendResolution.env,
      environmentRepairs: collectCommandEnvironmentRepairs(events),
    });
  await writeRunToolchainPreflightSnapshot();
  const injectedAgentMemory = createInjectedAgentMemoryScope({
    repoPath,
    workspace,
    stages: loaded.flow.spec.stages,
    runId,
    eventStore,
    context: runtimeContext,
  });

  const completedStages: string[] = [];
  let changeRequestUrl: string | undefined;
  let changeRequest: ChangeRequest | undefined;
  let changeRequestProvider: "github" | "github-cli" | undefined;
  let syncMetadata: SyncMetadata | undefined;
  let latestChangeTitle: ChangeTitleMetadata | undefined;
  const gateResults: GateResult[] = [];
  const attemptsByStage = new Map<string, number>();
  const previousFailuresByStage = new Map<string, PreviousFailure[]>();
  const reworkEdges: ReworkEdge[] = [];
  const taskPlanStates = new Map<string, TaskPlanLoopState>();
  // Runtime session ids by stage id. Deliberately in-memory: a resumed Nitely
  // run starts the stage cold rather than reaching for a session it cannot
  // prove is still alive.
  const agentSessions = new Map<string, string>();
  const writeRunEvidenceSnapshot = async (
    status: EvidenceRunStatus = "in-progress",
  ): Promise<string> => {
    const events = eventStore.list(runId);
    const projection = projectRun(events);
    const reproducibility = await writeRunReproducibilitySnapshot();
    const toolchainPreflight = await writeRunToolchainPreflightSnapshot(events);
    return await writeEvidence({
      flowName: loaded.flow.metadata.name,
      runId,
      branchName,
      baseBranch,
      repoPath,
      worktreePath: workspace.path ?? worktreePath,
      runDirectory,
      status,
      completedStages,
      gates: gateResults,
      agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
      executionBackend: backend.describeExecution?.(),
      stageContextControls: collectStageContextEvidence(loaded.flow),
      stageReadPolicies: collectStageReadPolicyEvidence(loaded.flow),
      stageTimeouts: collectStageTimeoutEvidence(loaded.flow),
      conformancePolicies: collectConformancePolicies(loaded.flow.spec.stages),
      runtimeUsage: projection.runtimeUsage,
      verificationBudget: projection.verificationBudget,
      repoIndexQueries: projection.repoIndexQueries,
      knowledgeRetrievals: projection.knowledgeRetrievals,
      commandAttempts: collectCommandAttemptEvidence({
        runDirectory,
        stages: loaded.flow.spec.stages,
        events,
      }),
      hookAttempts: collectHookAttemptEvidence({ runDirectory, events }),
      loadedSkills: loadedSkillUsages,
      contextKnowledge,
      orchestratorDecisions: projection.orchestratorDecisions,
      verificationDiagnoses: projection.verificationDiagnoses,
      operatorQuestions: projection.questions,
      inputs: inputArtifacts,
      configuration,
      context: runtimeContext,
      taskScope: taskScopeSelection,
      taskIssues,
      planningApproval: input.planningApproval,
      changeTitle: latestChangeTitle,
      changeRequest,
      reworkTarget,
      syncMetadata,
      reproducibility,
      toolchainPreflight,
      ...(projection.riskClassification
        ? { riskClassification: projection.riskClassification }
        : {}),
    });
  };

  try {
    await executeFlowHooks({
      hooks: loaded.flow.spec.hooks?.preRun ?? [],
      phase: "preRun",
      runDirectory,
      backend,
      workspace,
      flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
      context: runtimeContext,
      eventStore,
      runId,
      cancellation: dependencies.cancellation,
    });

    const taskPlanController = createTaskPlanExecutionController({
      startIndex: 0,
      states: taskPlanStates,
      inputArtifacts,
      stages: loaded.flow.spec.stages,
      graph: loaded.graph,
      completedStages,
      eventStore,
      runId,
      context: runtimeContext,
    });
    while (!taskPlanController.done) {
      const stageIndex = taskPlanController.stageIndex;
      const stageId = taskPlanController.stageId;
      const stage = loaded.flow.spec.stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        taskPlanController.next();
        continue;
      }
      if (stage.alwaysRun) {
        taskPlanController.next();
        continue;
      }

      const taskPlanStage = taskPlanController.prepare(stage);
      if (!taskPlanStage.run) continue;
      const preparedTaskPlan = taskPlanStage.prepared;

      if (stage.type === "agent" || stage.type === "judge" || stage.type === "command" || stage.type === "gate") {
        const maxAttempts = maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts);
        const previousFailures = previousFailuresByStage.get(stage.id) ?? [];
        previousFailuresByStage.set(stage.id, previousFailures);
        let reworkRequested = false;
        let stageCompleted = false;
        let completedAttempt: number | undefined;

        while ((attemptsByStage.get(stage.id) ?? 0) < maxAttempts) {
          const attempt = (attemptsByStage.get(stage.id) ?? 0) + 1;
          let effectiveAttempt = attempt;
          attemptsByStage.set(stage.id, attempt);
          const { attemptDirectory } = await prepareStageAttempt({
            begin: {
              eventStore,
              runId,
              runDirectory,
              stage,
              attempt,
              branchHeadSha: await currentBranchHeadSha(worktreePath),
            },
            prepare:
              stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review")
                ? async () => await prepareStageInstructionFilesBeforeAttempt({
                    stage,
                    controls: resolveStageContextControls(loaded.flow, stage),
                    injectedAgentMemory,
                  })
                : undefined,
            onStageChange: () =>
              dependencies.cancellation?.onStageChange?.({
                stageId: stage.id,
                attempt,
              }),
            assertNotCancelled: () =>
              throwIfRunCancelled(dependencies.cancellation, {
                stageId: stage.id,
                attempt,
              }),
          });

          let failureError: string | undefined;
          let budgetExceededError: BudgetExceededError | undefined;
          let builtInRecommendation: OrchestratorRecommendation | undefined;
          try {
            await executeStageHooks({
              stage,
              phase: "pre",
              attempt,
              attemptDirectory,
              backend,
              workspace,
              flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
              context: runtimeContext,
              eventStore,
              runId,
              cancellation: dependencies.cancellation,
            });

            if (stage.type === "judge") {
              const contextControls = resolveStageContextControls(loaded.flow, stage);
              const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
              const result = await withStageInstructionFiles({
                stage,
                controls: contextControls,
                attemptDirectory,
                workspace,
                injectedAgentMemory,
                run: async () => await executeAgentStage({
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
                  flowTimeouts: loaded.flow.spec.timeouts,
                  flowBudgets: effectiveFlowBudgets(loaded.flow),
                  inputArtifacts,
                  configuration,
                  context: runtimeContext,
                  eventStore,
                  providerStore,
                  loadedSkillUsages,
                  contextControls,
                  readPolicy,
                  contextKnowledge,
                  previousFailures,
                  taskPlanPrompt: preparedTaskPlan?.promptContext,
                  agentSessions,
                  completedStages,
                  completeStage: false,
                  onAttemptSelected: (selectedAttempt) => {
                    effectiveAttempt = selectedAttempt;
                    attemptsByStage.set(stage.id, selectedAttempt);
                  },
                }),
              });
              effectiveAttempt = result.selectedAttempt;
              const judgeOutput = await readJudgeOutput({
                stage,
                attempt: effectiveAttempt,
                attemptDirectory: selectedAttemptDirectory({
                  runDirectory,
                  stageId: stage.id,
                  currentAttempt: attempt,
                  currentAttemptDirectory: attemptDirectory,
                  selectedAttempt: effectiveAttempt,
                }),
                context: runtimeContext,
              });
              if (!judgeOutput.result) {
                failureError = judgeOutput.reason;
                throw new Error(failureError);
              }
              eventStore.append({
                runId,
                stageId: stage.id,
                attempt: effectiveAttempt,
                type: "judge.completed",
                payload: redactRuntimeUnknown({
                  verdict: judgeOutput.result.verdict,
                  findings: judgeOutput.result.findings,
                  evidence: judgeOutput.result.evidence,
                  reworkTarget: judgeOutput.result.reworkTarget,
                  reworkInstructions: judgeOutput.result.reworkInstructions,
                  humanReviewReason: judgeOutput.result.humanReviewReason,
                  outputPath: judgeOutput.outputPath,
                  criteria: stage.criteria,
                }, runtimeContext),
              });
              if (judgeOutput.result.verdict !== "PASS") {
                builtInRecommendation = judgeRecommendation({
                  stage,
                  result: judgeOutput.result,
                  graph: loaded.graph,
                  validReworkStages: validReworkStagesForStage(stage.id, loaded.graph),
                });
                failureError = `judge returned ${judgeOutput.result.verdict}`;
                throw new Error(failureError);
              }
              markStageCompleted(completedStages, stage.id);
              appendSuccessfulStageCompletion({
                eventStore,
                runId,
                stage,
                attempt: effectiveAttempt,
                maxAttempts,
                context: runtimeContext,
                payload: {
                  outputs: stageOutputIds(stage),
                  verdict: judgeOutput.result.verdict,
                  criteria: stage.criteria,
                },
              });
              await executeStageHooks({
                stage,
                phase: "post",
                attempt: effectiveAttempt,
                attemptDirectory: selectedAttemptDirectory({
                  runDirectory,
                  stageId: stage.id,
                  currentAttempt: attempt,
                  currentAttemptDirectory: attemptDirectory,
                  selectedAttempt: effectiveAttempt,
                }),
                backend,
                workspace,
                flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                context: runtimeContext,
                eventStore,
                runId,
                cancellation: dependencies.cancellation,
              });
              stageCompleted = true;
              completedAttempt = effectiveAttempt;
              break;
            }

            if (stage.type === "agent") {
              const contextControls = resolveStageContextControls(loaded.flow, stage);
              const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
              const result = await withStageInstructionFiles({
                stage,
                controls: contextControls,
                attemptDirectory,
                workspace,
                injectedAgentMemory,
                run: async () => await executeAgentStage({
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
                  flowTimeouts: loaded.flow.spec.timeouts,
                  flowBudgets: effectiveFlowBudgets(loaded.flow),
                  inputArtifacts,
                  configuration,
                  context: runtimeContext,
                  eventStore,
                  providerStore,
                  loadedSkillUsages,
                  contextControls,
                  readPolicy,
                  contextKnowledge,
                  previousFailures,
                  taskPlanPrompt: preparedTaskPlan?.promptContext,
                  agentSessions,
                  completedStages,
                  onAttemptSelected: (selectedAttempt) => {
                    effectiveAttempt = selectedAttempt;
                    attemptsByStage.set(stage.id, selectedAttempt);
                    dependencies.cancellation?.onStageChange?.({
                      stageId: stage.id,
                      attempt: selectedAttempt,
                    });
                  },
                }),
              });
              effectiveAttempt = result.selectedAttempt;
              await executeStageHooks({
                stage,
                phase: "post",
                attempt: effectiveAttempt,
                attemptDirectory: selectedAttemptDirectory({
                  runDirectory,
                  stageId: stage.id,
                  currentAttempt: attempt,
                  currentAttemptDirectory: attemptDirectory,
                  selectedAttempt: effectiveAttempt,
                }),
                backend,
                workspace,
                flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                context: runtimeContext,
                eventStore,
                runId,
                cancellation: dependencies.cancellation,
              });
              stageCompleted = true;
              completedAttempt = effectiveAttempt;
              break;
            }

            if (stage.type === "gate") {
              const contextControls = resolveStageContextControls(loaded.flow, stage);
              const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
              const runGate = async () => await executeGateStage({
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
                flowTimeouts: loaded.flow.spec.timeouts,
                flowBudgets: effectiveFlowBudgets(loaded.flow),
                inputArtifacts,
                configuration,
                attemptDirectory,
                context: runtimeContext,
                eventStore,
                providerStore,
                loadedSkillUsages,
                contextControls,
                readPolicy,
                contextKnowledge,
                previousFailures,
                taskPlanPrompt: preparedTaskPlan?.promptContext,
                agentSessions,
              });
              const { result: gateResult, budgetFailure } = stage.mode === "review"
                ? await withStageInstructionFiles({
                    stage,
                    controls: contextControls,
                    attemptDirectory,
                    workspace,
                    injectedAgentMemory,
                    run: runGate,
                  })
                : await (async () => {
                    await injectedAgentMemory.cleanup();
                    return await runGate();
                  })();
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
              if (
                !recordedGate.passed &&
                (stage.mode === "review" || stage.mode === "review-aggregate")
              ) {
                builtInRecommendation = reviewGateVerdictRecommendation({
                  stage,
                  gateResult,
                  graph: loaded.graph,
                  validReworkStages: validReworkStagesForStage(
                    stage.id,
                    loaded.graph,
                  ),
                });
              }
              if (budgetFailure) {
                if (recordedGate.passed) {
                  budgetFailure.stageCompleted = true;
                }
                throw budgetFailure;
              }
              if (recordedGate.passed) {
                await executeStageHooks({
                  stage,
                  phase: "post",
                  attempt: effectiveAttempt,
                  attemptDirectory: selectedAttemptDirectory({
                    runDirectory,
                    stageId: stage.id,
                    currentAttempt: attempt,
                    currentAttemptDirectory: attemptDirectory,
                    selectedAttempt: effectiveAttempt,
                  }),
                  backend,
                  workspace,
                  flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                  context: runtimeContext,
                  eventStore,
                  runId,
                  cancellation: dependencies.cancellation,
                });
                stageCompleted = true;
                completedAttempt = effectiveAttempt;
                break;
              }
              failureError = recordedGate.reason;
              throw new Error(failureError);
            }

            await injectedAgentMemory.cleanup();
            const commandResult = await executeCommandStage({
              runId,
              stage,
              attempt,
              attemptDirectory,
              runDirectory,
              backend,
              workspace,
              flowMaxAttempts: loaded.flow.spec.maxAttempts,
              flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
              flowTimeouts: loaded.flow.spec.timeouts,
              flowBudgets: effectiveFlowBudgets(loaded.flow),
              context: runtimeContext,
              eventStore,
              inputArtifacts,
              completedStages,
              cancellation: dependencies.cancellation,
            });
            if (!commandResult.failureError) {
              await executeStageHooks({
                stage,
                phase: "post",
                attempt,
                attemptDirectory,
                backend,
                workspace,
                flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                context: runtimeContext,
                eventStore,
                runId,
                cancellation: dependencies.cancellation,
              });
              stageCompleted = true;
              completedAttempt = attempt;
              break;
            }
            failureError =
              redactRuntimeText(
                commandResult.failureError,
                runtimeContext,
              ) ?? "";
          } catch (error) {
            if (error instanceof RunCancelledError) {
              throw error;
            }
            if (error instanceof BudgetExceededError) {
              budgetExceededError = error;
              failureError = error.message;
              // A stage that finished and registered its outputs before the
              // breach keeps its completion. Only the run stops.
              if (!error.stageCompleted) {
                invalidateCompletedStagesFrom(completedStages, loaded.graph.order, stageIndex);
              }
            } else {
              const blocked =
                error instanceof RunBlockedError
                  ? error
                  : (stage.type === "agent" || stage.type === "judge")
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
              invalidateCompletedStagesFrom(completedStages, loaded.graph.order, stageIndex);
              failureError = error instanceof Error ? error.message : String(error);
            }
          }

          const error = failureError ?? "unknown error";
          // `projectRun` deletes a stage from `completedStages` on
          // `stage.failed`, so emitting it here would undo the completion this
          // stage earned and make a resume repeat paid work.
          if (!budgetExceededError?.stageCompleted) {
            eventStore.append({
              runId,
              stageId: stage.id,
              attempt: effectiveAttempt,
              type: "stage.failed",
              payload: redactRuntimeUnknown({ error }, runtimeContext),
            });
          }
          if (budgetExceededError) {
            eventStore.append({
              runId,
              type: "run.failed",
              payload: redactRuntimeUnknown({
                stageId: stage.id,
                error,
                reason: "budget_exceeded",
              }, runtimeContext),
            });
            throw budgetExceededError;
          }

          const policy = applyFailedStagePolicy({
            stage,
            attempt: effectiveAttempt,
            maxAttempts,
            flowMaxAttempts: loaded.flow.spec.maxAttempts,
            error,
            builtInRecommendation,
            dependencies,
            stages: loaded.flow.spec.stages,
            graph: loaded.graph,
            attemptsByStage,
            previousFailuresByStage,
            completedStages,
            reworkEdges,
            eventStore,
            runId,
            context: runtimeContext,
          });
          if (policy.action === "retry") continue;
          taskPlanController.rework(policy.stageIndex, policy.request);
          reworkRequested = true;
          break;
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
        taskPlanController.complete(stage, preparedTaskPlan, completedAttempt);
        continue;
      }

      const attempt = 1;
      const { attemptDirectory } = await beginStageAttempt({
        eventStore,
        runId,
        runDirectory,
        stage,
        attempt,
        branchHeadSha: await currentBranchHeadSha(worktreePath),
      });
      dependencies.cancellation?.onStageChange?.({ stageId: stage.id, attempt });
      throwIfRunCancelled(dependencies.cancellation, { stageId: stage.id, attempt });

      try {
        await executeStageHooks({
          stage,
          phase: "pre",
          attempt,
          attemptDirectory,
          backend,
          workspace,
          flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
          context: runtimeContext,
          eventStore,
          runId,
          cancellation: dependencies.cancellation,
        });

        if (stage.type === "sync-change") {
          await injectedAgentMemory.cleanup();
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
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId,
            cancellation: dependencies.cancellation,
          });
          taskPlanController.next();
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
            writeEvidenceSnapshot: async () => {
              const events = eventStore.list(runId);
              const projection = projectRun(events);
              return await writeEvidence({
                flowName: loaded.flow.metadata.name,
                runId,
                branchName,
                baseBranch,
                repoPath,
                worktreePath,
                runDirectory,
                completedStages,
                gates: gateResults,
                agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
                executionBackend: backend.describeExecution?.(),
                stageContextControls: collectStageContextEvidence(loaded.flow),
                stageReadPolicies: collectStageReadPolicyEvidence(loaded.flow),
                stageTimeouts: collectStageTimeoutEvidence(loaded.flow),
                conformancePolicies: collectConformancePolicies(loaded.flow.spec.stages),
                runtimeUsage: projection.runtimeUsage,
                repoIndexQueries: projection.repoIndexQueries,
                knowledgeRetrievals: projection.knowledgeRetrievals,
                commandAttempts: collectCommandAttemptEvidence({
                  runDirectory,
                  stages: loaded.flow.spec.stages,
                  events,
                }),
                hookAttempts: collectHookAttemptEvidence({ runDirectory, events }),
                loadedSkills: loadedSkillUsages,
                orchestratorDecisions: projection.orchestratorDecisions,
                verificationDiagnoses: projection.verificationDiagnoses,
                operatorQuestions: projection.questions,
                inputs: inputArtifacts,
                configuration,
                context: runtimeContext,
                taskScope: taskScopeSelection,
                taskIssues,
                planningApproval: input.planningApproval,
                changeTitle: latestChangeTitle,
                ...(projection.riskClassification
                  ? { riskClassification: projection.riskClassification }
                  : {}),
              });
            },
          });
          changeRequestUrl = published.changeRequestUrl;
          changeRequest = published.changeRequest;
          changeRequestProvider = stage.provider ?? "github";
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId,
            cancellation: dependencies.cancellation,
          });
          taskPlanController.next();
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
            writeEvidenceSnapshot: async () => {
              const events = eventStore.list(runId);
              const projection = projectRun(events);
              return await writeEvidence({
                flowName: loaded.flow.metadata.name,
                runId,
                branchName,
                baseBranch,
                repoPath,
                worktreePath,
                runDirectory,
                completedStages,
                gates: gateResults,
                agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
                executionBackend: backend.describeExecution?.(),
                stageContextControls: collectStageContextEvidence(loaded.flow),
                stageReadPolicies: collectStageReadPolicyEvidence(loaded.flow),
                stageTimeouts: collectStageTimeoutEvidence(loaded.flow),
                conformancePolicies: collectConformancePolicies(loaded.flow.spec.stages),
                runtimeUsage: projection.runtimeUsage,
                repoIndexQueries: projection.repoIndexQueries,
                knowledgeRetrievals: projection.knowledgeRetrievals,
                commandAttempts: collectCommandAttemptEvidence({
                  runDirectory,
                  stages: loaded.flow.spec.stages,
                  events,
                }),
                hookAttempts: collectHookAttemptEvidence({ runDirectory, events }),
                loadedSkills: loadedSkillUsages,
                orchestratorDecisions: projection.orchestratorDecisions,
                verificationDiagnoses: projection.verificationDiagnoses,
                operatorQuestions: projection.questions,
                inputs: inputArtifacts,
                configuration,
                context: runtimeContext,
                taskScope: taskScopeSelection,
                taskIssues,
                planningApproval: input.planningApproval,
                changeTitle: latestChangeTitle,
                reworkTarget,
                syncMetadata,
              });
            },
          });
          changeRequestUrl = updated.changeRequestUrl;
          changeRequest = updated.changeRequest;
          changeRequestProvider = reworkTarget?.provider ?? stage.provider ?? "github";
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId,
            cancellation: dependencies.cancellation,
          });
          taskPlanController.next();
          continue;
        }

        if (stage.type === "approval") {
          await injectedAgentMemory.cleanup();
          const approval = await executeApprovalStage({
            runId,
            stage,
            attempt,
            flowTimeouts: loaded.flow.spec.timeouts,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          if (approval.status === "awaiting-approval") {
            await injectedAgentMemory.cleanup();
            await writeRunEvidenceSnapshot();
            eventStore.close();
            return {
              runId,
              branchName,
              worktreePath,
              status: "awaiting-approval",
              approvalId: approval.approvalId,
              changeRequestUrl,
              changeRequest,
              previousHeadSha: reworkTarget?.previousHeadSha,
              updatedHeadSha: reworkTarget?.updatedHeadSha,
            };
          }
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId,
            cancellation: dependencies.cancellation,
          });
        }
      } catch (error) {
        if (error instanceof RunCancelledError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        invalidateCompletedStagesFrom(completedStages, loaded.graph.order, stageIndex);
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
      taskPlanController.next();
    }
    throwIfRunCancelled(dependencies.cancellation);
    await executeFlowHooks({
      hooks: loaded.flow.spec.hooks?.postRun ?? [],
      phase: "postRun",
      runDirectory,
      backend,
      workspace,
      flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
      context: runtimeContext,
      eventStore,
      runId,
      cancellation: dependencies.cancellation,
    });
  } catch (error) {
    try {
      let events = eventStore.list(runId);
      const projection = projectRun(events);
      const terminalStatus: TerminalRunStatus =
        error instanceof RunCancelledError || projection.status === "cancelled"
          ? "cancelled"
          : error instanceof RunBlockedError || projection.status === "blocked"
            ? "blocked"
            : "failed";
      if (error instanceof RunCancelledError) {
        appendRunCancelledEvent({
          eventStore,
          runId,
          error,
          context: runtimeContext,
        });
        events = eventStore.list(runId);
      }
      if (
        terminalStatus === "failed" &&
        !events.some(
          (event) =>
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.blocked" ||
            event.type === "run.cancelled",
        )
      ) {
        eventStore.append({
          runId,
          type: "run.failed",
          payload: redactRuntimeUnknown(
            { error: error instanceof Error ? error.message : String(error) },
            runtimeContext,
          ),
        });
        events = eventStore.list(runId);
      }
      const latestFailure = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "run.failed" ||
            event.type === "run.blocked" ||
            event.type === "run.cancelled" ||
            event.type === "stage.failed" ||
            event.type === "stage.blocked",
        );
      const payload =
        typeof latestFailure?.payload === "object" &&
        latestFailure.payload !== null &&
        !Array.isArray(latestFailure.payload)
          ? (latestFailure.payload as Record<string, unknown>)
          : {};
      await runAlwaysRunFinalizers({
        runId,
        flowName: loaded.flow.metadata.name,
        workItemId: input.workItemId,
        stages: loaded.flow.spec.stages,
        terminalStatus,
        terminalStageId:
          error instanceof RunCancelledError
            ? error.stageId
            : error instanceof RunBlockedError
            ? error.blocker.stageId
            : latestFailure?.stageId ?? (typeof payload.stageId === "string" ? payload.stageId : undefined),
        terminalError: error instanceof Error ? error.message : String(error),
        blocker:
          error instanceof RunBlockedError
            ? error.blocker
            : undefined,
        runDirectory,
        repoPath,
        backend,
        dependencies,
        workspace,
        flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
        flowMaxAttempts: loaded.flow.spec.maxAttempts,
        flowContext: loaded.flow.spec.context,
        flowReads: loaded.flow.spec.reads,
        flowTimeouts: loaded.flow.spec.timeouts,
        flowBudgets: effectiveFlowBudgets(loaded.flow),
        inputArtifacts,
        configuration,
        context: runtimeContext,
        eventStore,
        providerStore,
        loadedSkillUsages,
        contextKnowledge,
        completedStages,
        injectedAgentMemory,
        changeRequestUrl,
        changeRequest,
        reworkTarget,
        syncMetadata,
        nextAttempt: (stageId) => (attemptsByStage.get(stageId) ?? 0) + 1,
        onAttemptSelected: (stageId, attempt) => {
          attemptsByStage.set(stageId, attempt);
        },
      });
      await injectedAgentMemory.cleanup();
      const finalEvidencePath = await writeRunEvidenceSnapshot(terminalStatus);
      changeRequest = await refreshTerminalChangeRequestEvidence({
        runId,
        repoPath,
        worktreePath,
        changeRequest,
        evidencePath: finalEvidencePath,
        title: latestChangeTitle?.title,
        dependencies,
        providerStore,
        providerName: changeRequestProvider,
        context: runtimeContext,
        eventStore,
      }) ?? changeRequest;
      changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
      await recordTaskIssueRunLinks({
        repoPath,
        runId,
        status: terminalStatus,
        evidencePath: finalEvidencePath,
        changeRequestUrl,
        scope: taskIssues,
        dependencies,
        providerStore,
        context: runtimeContext,
        eventStore,
      });
    } catch {
      // Preserve the original runtime failure.
    }
    eventStore.close();
    throw error;
  }

  if (dependencies.cancellation?.signal.aborted) {
    const error = new RunCancelledError({
      request: cancellationRequestFromSignal(dependencies.cancellation),
    });
    appendRunCancelledEvent({
      eventStore,
      runId,
      error,
      context: runtimeContext,
    });
    eventStore.close();
    throw error;
  }
  await runAlwaysRunFinalizers({
    runId,
    flowName: loaded.flow.metadata.name,
    workItemId: input.workItemId,
    stages: loaded.flow.spec.stages,
    terminalStatus: "completed",
    runDirectory,
    repoPath,
    backend,
    dependencies,
    workspace,
    flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
    flowMaxAttempts: loaded.flow.spec.maxAttempts,
    flowContext: loaded.flow.spec.context,
    flowReads: loaded.flow.spec.reads,
    flowTimeouts: loaded.flow.spec.timeouts,
    flowBudgets: effectiveFlowBudgets(loaded.flow),
    inputArtifacts,
    configuration,
    context: runtimeContext,
    eventStore,
    providerStore,
    loadedSkillUsages,
    contextKnowledge,
    completedStages,
    injectedAgentMemory,
    changeRequestUrl,
    changeRequest,
    reworkTarget,
    syncMetadata,
    nextAttempt: (stageId) => (attemptsByStage.get(stageId) ?? 0) + 1,
    onAttemptSelected: (stageId, attempt) => {
      attemptsByStage.set(stageId, attempt);
    },
  });
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
  const finalEvidencePath = await writeRunEvidenceSnapshot("completed");
  changeRequest = await refreshTerminalChangeRequestEvidence({
    runId,
    repoPath,
    worktreePath,
    changeRequest,
    evidencePath: finalEvidencePath,
    title: latestChangeTitle?.title,
    dependencies,
    providerStore,
    providerName: changeRequestProvider,
    context: runtimeContext,
    eventStore,
  }) ?? changeRequest;
  changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
  await recordTaskIssueRunLinks({
    repoPath,
    runId,
    status: "completed",
    evidencePath: finalEvidencePath,
    changeRequestUrl,
    scope: taskIssues,
    dependencies,
    providerStore,
    context: runtimeContext,
    eventStore,
  });

  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify(
      redactRuntimeUnknown({
        runId,
        flowName: loaded.flow.metadata.name,
        ownerId: input.ownerId,
        organizationId: input.organizationId,
        workItemId: input.workItemId,
        workItemType: runWorkItemType,
        planningApproval: input.planningApproval,
        runEligibilityOverride: input.runEligibilityOverride,
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
        taskIssues,
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

  if (projectRun(eventStore.list(runId)).status === "cancelled") {
    eventStore.close();
    throw new RunCancelledError({
      request: cancellationRequestFromSignal(dependencies.cancellation),
    });
  }
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
      taskIssues,
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

function rehydrateStageExecutionState(events: StoredRunEvent[]): {
  attemptsByStage: Map<string, number>;
  previousFailuresByStage: Map<string, PreviousFailure[]>;
  reworkEdges: ReworkEdge[];
} {
  const attemptsByStage = new Map<string, number>();
  const previousFailuresByStage = new Map<string, PreviousFailure[]>();
  const reworkEdges: ReworkEdge[] = [];
  for (const event of events) {
    if (event.stageId && event.attempt !== undefined) {
      attemptsByStage.set(
        event.stageId,
        Math.max(attemptsByStage.get(event.stageId) ?? 0, event.attempt),
      );
    }
    if (event.type === "stage.failed" && event.stageId) {
      const payload = eventPayloadRecord(event);
      const error = typeof payload.error === "string" ? payload.error : "unknown error";
      const failures = previousFailuresByStage.get(event.stageId) ?? [];
      failures.push({ attempt: event.attempt ?? 1, error });
      previousFailuresByStage.set(event.stageId, failures);
    }
    if (event.type === "stage.rework.requested") {
      const payload = eventPayloadRecord(event);
      const reworkEdge = reworkEdgeFromRequestedPayload({
        stageId: event.stageId,
        payload,
      });
      if (reworkEdge) reworkEdges.push(reworkEdge);
      const targetStage =
        typeof payload.targetStage === "string" ? payload.targetStage : undefined;
      if (!targetStage) continue;
      const request =
        typeof payload.reworkRequest === "object" &&
        payload.reworkRequest !== null &&
        !Array.isArray(payload.reworkRequest)
          ? (payload.reworkRequest as Record<string, unknown>)
          : {};
      const detail = [
        event.stageId
          ? `downstream stage ${event.stageId} requested rework of stage ${targetStage}`
          : `rework requested for stage ${targetStage}`,
        typeof payload.targetArtifact === "string"
          ? `artifact ${payload.targetArtifact}`
          : undefined,
        typeof payload.reason === "string" ? payload.reason : undefined,
        typeof request.instructions === "string"
          ? `instructions: ${request.instructions}`
          : undefined,
        typeof request.context === "string" ? `context: ${request.context}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(": ");
      const failures = previousFailuresByStage.get(targetStage) ?? [];
      failures.push({
        attempt: attemptsByStage.get(targetStage) ?? 1,
        error: detail,
      });
      previousFailuresByStage.set(targetStage, failures);
    }
  }
  return { attemptsByStage, previousFailuresByStage, reworkEdges };
}

function selectResumeStage(input: {
  runId: string;
  events: StoredRunEvent[];
  checkpointId?: string;
  resumableStages: ReturnType<typeof projectRun>["stages"];
  fallbackStageId?: string;
}): { stageId: string; checkpoint?: RunCheckpoint } {
  if (!input.checkpointId) {
    const stageId = input.resumableStages[0]?.stageId ?? input.fallbackStageId;
    if (!stageId) {
      throw new Error(`run is not resumable: ${input.runId}`);
    }
    return { stageId };
  }
  const trace = buildRunTrace(input.events);
  const checkpoint = trace.checkpoints.find(
    (candidate) => candidate.id === input.checkpointId,
  );
  if (!checkpoint) {
    throw new Error(`checkpoint not found for resume: ${input.checkpointId}`);
  }
  const isResumeCandidate =
    checkpoint.kind === "stage-attempt" &&
    checkpoint.status === "candidate" &&
    checkpoint.action === "resume-run" &&
    checkpoint.stageId !== undefined;
  if (!isResumeCandidate) {
    throw new Error(`checkpoint is not resumable by run resume: ${input.checkpointId}`);
  }
  const resumableStage = input.resumableStages.find(
    (stage) => stage.stageId === checkpoint.stageId,
  );
  if (!resumableStage) {
    throw new Error(`checkpoint stage is not currently resumable: ${input.checkpointId}`);
  }
  return { stageId: resumableStage.stageId, checkpoint };
}

function appendResumeSelectionEvent(input: {
  eventStore: EventStore;
  runId: string;
  checkpoint: RunCheckpoint;
}): void {
  input.eventStore.append({
    runId: input.runId,
    ...(input.checkpoint.stageId ? { stageId: input.checkpoint.stageId } : {}),
    ...(input.checkpoint.attempt ? { attempt: input.checkpoint.attempt } : {}),
    type: "resume.selected",
    payload: {
      checkpointId: input.checkpoint.id,
      checkpointKind: input.checkpoint.kind,
      checkpointLabel: input.checkpoint.label,
      checkpointEventSequence: input.checkpoint.eventSequence,
      selectedStageId: input.checkpoint.stageId,
      selectedAttempt: input.checkpoint.attempt,
      actor: "operator",
      mode: "resume",
      nonDestructive: true,
      preserves: [
        "append-only event history",
        "existing worktree and branch state",
        "published artifacts and evidence",
      ],
      changes: [
        "resume execution starts from the selected checkpoint stage",
        "no worktree, branch, artifact, or pull request reset is performed",
      ],
    },
  });
}

export async function resumeRun(
  input: ResumeRunInput,
  dependencies: RunFlowDependencies = {},
): Promise<RunFlowResult> {
  const repoPath = resolve(input.repoPath);
  validateRunId(input.runId);
  const runDirectory = runDirectoryPath(repoPath, input.runId);
  const eventStore = (dependencies.createEventStore ??
    ((path: string) => new EventStore(path)))(eventStorePath(repoPath));
  try {
    const events = eventStore.list(input.runId);
    if (events.length === 0) {
      throw new Error(`run not found: ${input.runId}`);
    }

    let projection = projectRun(events, { openAttemptStatus: "interrupted" });
    const runCreatedEvents = events.filter(
      (event) => event.type === "run.created",
    );
    const evalReplayInvocationIds = runCreatedEvents.flatMap((event) => {
      const payload = asRecord(event.payload);
      return Object.prototype.hasOwnProperty.call(
        payload,
        "evalReplayInvocationId",
      )
        ? [payload.evalReplayInvocationId]
        : [];
    });
    if (
      evalReplayInvocationIds.some(
        (invocationId) =>
          typeof invocationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            invocationId,
          ),
      )
    ) {
      throw new Error("invalid eval replay invocation id in run.created event");
    }
    const evalReplay =
      evalReplayInvocationIds.length > 0 ||
      events.some((event) => event.type === "eval.replay.linked");
    if (evalReplay && runCreatedEvents.length !== 1) {
      throw new Error(
        "eval replay resume requires exactly one run.created event",
      );
    }
    if (evalReplay && !projection.executionBackend) {
      throw new Error("eval replay resume is missing its pinned execution backend");
    }
    if (evalReplay && !projection.sandboxPolicy) {
      throw new Error("eval replay resume is missing its pinned sandbox policy");
    }
    if (
      evalReplay &&
      input.executionBackend !== undefined &&
      projection.executionBackend !== undefined &&
      normalizeExecutionBackendName(input.executionBackend) !==
        normalizeExecutionBackendName(projection.executionBackend)
    ) {
      throw new Error(
        `eval replay resume backend must remain ${projection.executionBackend}`,
      );
    }
    const resumableStages = projection.stages.filter(
      (stage) =>
        stage.status === "interrupted" ||
        stage.status === "blocked" ||
        stage.status === "awaiting-approval",
    );
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
    const contextPolicySha256 = sha256Text(JSON.stringify(contextPolicy));
    if (evalReplay) {
      if (!projection.contextPolicySha256) {
        throw new Error("eval replay resume is missing its pinned context policy digest");
      }
      if (projection.contextPolicySha256 !== contextPolicySha256) {
        throw new Error(
          `eval replay resume context policy digest mismatch: expected ${projection.contextPolicySha256}, got ${contextPolicySha256}`,
        );
      }
    }
    const constitution = await loadConstitution(repoPath);
    const projectInstructions = await loadProjectInstructions(repoPath);
    const pinnedPromptContext = expectedPromptContextFromUnknown(
      projection.promptContext,
    );
    const pinnedSkillContentHashes = expectedSkillContentHashesFromUnknown(
      projection.expectedSkillContentHashes,
    );
    if (evalReplay) {
      if (!pinnedPromptContext) {
        throw new Error("eval replay resume is missing its pinned prompt context");
      }
      if (!pinnedSkillContentHashes) {
        throw new Error("eval replay resume is missing its pinned skill content hashes");
      }
      assertExpectedPromptContext({
        expected: pinnedPromptContext,
        constitution,
        projectInstructions,
        label: "eval replay resume prompt context",
      });
    }
    const knowledgeSnapshots = verifyKnowledgeSnapshotSetForResume(
      projection.knowledgeSnapshots,
      await readKnowledgeSnapshotSetForRun(runDirectory),
    );
    const backendResolution = await resolveBackend(
      input.executionBackend ?? projection.executionBackend,
      dependencies,
      providerStore,
      projection.sandboxPolicy,
      (await readReproducibilityManifest({ runDirectory }))?.environment.imageIdentity,
    );
    const backend = backendResolution.backend;
    await backend.prepareForRun?.();
    const redactionSecrets = [
      ...(await collectRuntimeRedactionSecrets({
        policy: contextPolicy,
        dependencies,
        providerStore,
        includeProviderStore: !dependencies.backend,
      })),
      ...(backend.redactionSecrets?.() ?? []),
    ];
    const runtimeContext: RuntimeContext = {
      runId: input.runId,
      repoPath,
      runDirectory,
      manifestEntries: [],
      manifestEntryIndexes: new Map(),
      artifactEntries: [],
      artifactEntryIndexes: new Map(),
      redactionSecrets,
      constitution,
      projectInstructions,
      expectedSkillContentHashes: evalReplay
        ? pinnedSkillContentHashes
        : undefined,
      knowledgeSnapshots,
    };
    const workspace: WorkspaceHandle = { runId: input.runId, path: worktreePath };
    const inputReferences = projectedInputsAsReferences(projection.inputs);
    if (evalReplay) {
      for (const [inputId, reference] of Object.entries(inputReferences)) {
        const expectedSha256 = asRecord(reference.options).expectedSha256;
        if (
          reference.connector !== "local-file" ||
          typeof expectedSha256 !== "string" ||
          !/^sha256:[0-9a-f]{64}$/i.test(expectedSha256)
        ) {
          throw new Error(
            `eval replay resume is missing its pinned input ${inputId} content digest`,
          );
        }
      }
    }
    let resumeFlowDocument = projection.flowDocument;
    let resumeConfiguration = projection.configuration;
    if (evalReplay) {
      if (
        !projection.flowDocumentSha256 ||
        !/^sha256:[0-9a-f]{64}$/i.test(projection.flowDocumentSha256)
      ) {
        throw new Error(
          "eval replay resume is missing its pinned Flow document digest",
        );
      }
      const flowIdentity = relative(repoPath, resolve(flowPath)).replaceAll(
        "\\",
        "/",
      );
      if (
        flowIdentity.length === 0 ||
        flowIdentity === ".." ||
        flowIdentity.startsWith("../") ||
        isAbsolute(flowIdentity)
      ) {
        throw new Error("eval replay resume Flow path escapes the repository");
      }
      const fetchedFlow = await new LocalFileConnector(worktreePath).fetch({
        connector: "local-file",
        uri: flowIdentity,
        options: { expectedSha256: projection.flowDocumentSha256 },
      });
      resumeFlowDocument = fetchedFlow.content.toString("utf8");

      if (!projection.configurationSnapshotPath) {
        throw new Error(
          "eval replay resume is missing its pinned configuration snapshot",
        );
      }
      if (
        !projection.configurationSha256 ||
        !/^sha256:[0-9a-f]{64}$/i.test(projection.configurationSha256)
      ) {
        throw new Error(
          "eval replay resume is missing its pinned configuration digest",
        );
      }
      const configurationSnapshot = await readRunOwnedFile({
        runDirectory,
        path: projection.configurationSnapshotPath,
        subject: "eval replay configuration snapshot",
        maximumBytes: 1024 * 1024,
        expectedSha256: projection.configurationSha256.slice("sha256:".length),
      });
      let parsedConfiguration: unknown;
      try {
        parsedConfiguration = JSON.parse(
          configurationSnapshot.content.toString("utf8"),
        ) as unknown;
      } catch (error) {
        throw new Error("eval replay configuration snapshot is not valid JSON", {
          cause: error,
        });
      }
      if (
        typeof parsedConfiguration !== "object" ||
        parsedConfiguration === null ||
        Array.isArray(parsedConfiguration)
      ) {
        throw new Error("eval replay configuration snapshot is not an object");
      }
      resumeConfiguration = parsedConfiguration as Record<string, unknown>;
    }
    let loaded = resumeFlowDocument !== undefined
      ? parseFlowDocument(resumeFlowDocument, {
          externalInputs: Object.keys(inputReferences),
        })
      : await loadFlow(flowPath, {
          externalInputs: Object.keys(inputReferences),
        });
    let budgetResumeStageId: string | undefined;
    if (resumableStages.length === 0) {
      const alwaysRunStageIds = loaded.flow.spec.stages
        .filter((stage) => stage.alwaysRun)
        .map((stage) => stage.id);
      const recordedDecision = decideBudgetStoppedResume({
        projection,
        events,
        graphOrder: loaded.graph.order,
        alwaysRunStageIds,
        currentBudgets: effectiveFlowBudgets(loaded.flow),
      });
      if (recordedDecision.kind === "not-applicable") {
        throw new Error(`run is not resumable: ${input.runId}`);
      }
      let currentBudgets = effectiveFlowBudgets(loaded.flow);
      if (!evalReplay) {
        const currentFlow = await loadFlow(flowPath, {
          externalInputs: Object.keys(inputReferences),
        });
        currentBudgets = effectiveFlowBudgets(currentFlow.flow);
        loaded = {
          ...loaded,
          flow: {
            ...loaded.flow,
            spec: {
              ...loaded.flow.spec,
              verificationBudget: currentFlow.flow.spec.verificationBudget,
            },
          },
        };
      }
      const decision = evalReplay
        ? recordedDecision
        : decideBudgetStoppedResume({
            projection,
            events,
            graphOrder: loaded.graph.order,
            alwaysRunStageIds,
            currentBudgets,
          });
      if (decision.kind === "cap-not-raised" || decision.kind === "no-remaining-stage") {
        throw new Error(decision.message);
      }
      if (decision.kind !== "resume") {
        throw new Error(`run is not resumable: ${input.runId}`);
      }
      budgetResumeStageId = decision.stageId;
      eventStore.append({
        runId: input.runId,
        type: "run.resumed",
        payload: redactRuntimeUnknown(
          {
            reason: "budget_exceeded",
            selectedStageId: decision.stageId,
            consumed: decision.consumed,
            cap: decision.cap,
            budgets: currentBudgets,
          },
          runtimeContext,
        ),
      });
      projection = projectRun(eventStore.list(input.runId), {
        openAttemptStatus: "interrupted",
      });
    }
    const runWorkItemType = projection.workItemType ?? flowWorkItemType(loaded.flow);
    await assertWorkItemTypeAllowed({
      repoPath,
      workItemType: runWorkItemType,
      loaded,
    });
    let configuration: FlowConfiguration;
    try {
      configuration = normalizeFlowConfiguration(
        loaded.flow,
        resumeConfiguration ?? {},
      );
    } catch (error) {
      if (error instanceof FlowConfigurationError) {
        throw new Error(error.message);
      }
      throw error;
    }
    const selectedResume = selectResumeStage({
      runId: input.runId,
      events,
      checkpointId: input.checkpointId,
      resumableStages,
      fallbackStageId: budgetResumeStageId,
    });
    const answeredOperatorQuestion =
      projection.blocker?.reason === "awaiting_operator_answer"
        ? (projection.questions ?? []).find(
            (question) => question.id === projection.blocker?.questionId,
          )
        : undefined;
    const submittedOperatorReview = operatorReviewForActiveBlocker(projection);
    if (projection.blocker?.reason === "awaiting_operator_answer") {
      if (!answeredOperatorQuestion) {
        throw new Error(
          `run blocker is missing operator question: ${
            projection.blocker.questionId ?? "unknown"
          }`,
        );
      }
      if (answeredOperatorQuestion.status !== "answered") {
        throw new Error(
          `operator question must be answered before resume: ${answeredOperatorQuestion.id}`,
        );
      }
      if (selectedResume.stageId !== answeredOperatorQuestion.stageId) {
        throw new Error(
          `operator question resume must start from stage ${answeredOperatorQuestion.stageId}`,
        );
      }
    }
    const startIndex = loaded.graph.order.findIndex(
      (stageId) => stageId === selectedResume.stageId,
    );
    if (startIndex < 0) {
      throw new Error(`resumable stage is not in flow: ${selectedResume.stageId}`);
    }
    if (selectedResume.checkpoint) {
      appendResumeSelectionEvent({
        eventStore,
        runId: input.runId,
        checkpoint: selectedResume.checkpoint,
      });
    }

    await seedRuntimeArtifactEntries(runtimeContext, async () =>
      projectRun(eventStore.list(input.runId), {
        openAttemptStatus: "interrupted",
      }).artifacts
    );
    await seedRuntimeManifestEntries(runtimeContext);
    const inputArtifacts = await snapshotInputs({
      repoPath,
      runDirectory,
      inputReferences,
      providerStore,
      policy: contextPolicy,
      context: runtimeContext,
      eventStore,
    });
    await rehydrateOperatorReviewGateArtifact({
      inputs: inputArtifacts,
      gate: submittedOperatorReview,
      runDirectory,
      context: runtimeContext,
    });
    const completedStages = [...projection.completedStages];
    const restoredArtifacts = await rehydrateCompletedRegisteredArtifacts({
      inputs: inputArtifacts,
      stages: loaded.flow.spec.stages,
      completedStages,
      runDirectory,
      context: runtimeContext,
      eventStore,
    });
    await rehydrateCompletedSyncArtifacts({
      inputs: inputArtifacts,
      stages: loaded.flow.spec.stages,
      completedStages,
      runDirectory,
      syncMetadata: projection.sync,
      context: runtimeContext,
      eventStore,
      restoredArtifacts,
    });
    await rehydrateCompletedAgentTextArtifacts({
      inputs: inputArtifacts,
      stages: loaded.flow.spec.stages,
      projection,
      runDirectory,
      context: runtimeContext,
      eventStore,
      restoredArtifacts,
    });
    const agentSessions = new Map<string, string>();
    const taskPlanStates = rehydrateTaskPlanLoopStates({
      stages: loaded.flow.spec.stages,
      inputArtifacts,
      events,
    });
    const { attemptsByStage, previousFailuresByStage, reworkEdges } =
      rehydrateStageExecutionState(events);
    const baseBranch = projection.baseBranch ?? "HEAD";
    let changeRequestUrl = projection.changeRequestUrl;
    let changeRequest = projection.changeRequest as ChangeRequest | undefined;
    let syncMetadata = projection.sync as SyncMetadata | undefined;
    let latestChangeTitle: ChangeTitleMetadata | undefined;
    const gateResults: GateResult[] = [...projection.gates];
    const loadedSkillUsages: StageSkillUsage[] =
      loadedSkillUsagesFromEvents(events);
    const contextKnowledge: ContextKnowledgeEntry[] = [];
    const reworkTarget = projectedReworkTarget(projection.changeRequestTarget);
    let changeRequestProvider: "github" | "github-cli" | undefined =
      reworkTarget?.provider ??
      (changeRequest
        ? firstChangeRequestStageProvider(loaded.flow.spec.stages)
        : undefined);
    if (reworkTarget) {
      assertReworkFlowDoesNotPublishChange(loaded.flow.spec.stages);
    }
    const reworkProvider = reworkTarget
      ? scmProviderForRun(reworkTarget.provider, dependencies, providerStore)
      : undefined;
    const resumedTaskScope = projection.taskScope;
    let taskIssues: ResolvedTaskIssueScope | undefined = projection.taskIssues;
    if (resumedTaskScope && !taskIssues) {
      try {
        taskIssues = await taskIssueScopeForRun({
          repoPath,
          taskIds: resumedTaskScope.selectedTaskIds,
          dependencies,
          providerStore,
        });
      } catch (error) {
        taskIssues = {
          issues: [],
          missingTaskIds: resumedTaskScope.selectedTaskIds,
          registryError: error instanceof Error ? error.message : String(error),
        };
      }
      if (taskIssues.registryError) {
        eventStore.append({
          runId: input.runId,
          type: "task.issue.registry_unavailable",
          payload: redactRuntimeUnknown(
            { error: taskIssues.registryError },
            runtimeContext,
          ),
        });
      }
      eventStore.append({
        runId: input.runId,
        type: "task.issue.scope_resolved",
        payload: redactRuntimeUnknown(
          {
            schemaVersion: "nitely.task-issue-scope.v1",
            ...taskIssues,
          },
          runtimeContext,
        ),
      });
    }
    const resumableStageById = new Map(
      resumableStages.map((stage) => [stage.stageId, stage]),
    );
    const writeRunEvidenceSnapshot = async (
      status: EvidenceRunStatus = "in-progress",
    ): Promise<string> => {
      const events = eventStore.list(input.runId);
      const projection = projectRun(events);
      const reproducibility = await readReproducibilityManifest({ runDirectory });
      const existingToolchainPreflight = await readToolchainPreflight({
        runDirectory,
      });
      const toolchainPreflight = await writeToolchainPreflight({
        runDirectory,
        runId: input.runId,
        repoPath,
        worktreePath,
        executionBackend:
          input.executionBackend ??
          existingToolchainPreflight?.executionBackend ??
          backendResolution.env.NITELY_EXECUTION_BACKEND ??
          "local",
        envSource: backendResolution.envSource,
        env: backendResolution.env,
        environmentRepairs: collectCommandEnvironmentRepairs(events),
      });
      return await writeEvidence({
        flowName: loaded.flow.metadata.name,
        runId: input.runId,
        branchName,
        baseBranch,
        repoPath,
        worktreePath,
        runDirectory,
        status,
        completedStages,
        gates: gateResults,
        agentRuntimes: collectAgentRuntimeEvidence(loaded.flow.spec.stages),
        executionBackend: backend.describeExecution?.(),
        stageContextControls: collectStageContextEvidence(loaded.flow),
        stageReadPolicies: collectStageReadPolicyEvidence(loaded.flow),
        stageTimeouts: collectStageTimeoutEvidence(loaded.flow),
        conformancePolicies: collectConformancePolicies(loaded.flow.spec.stages),
        runtimeUsage: projection.runtimeUsage,
        verificationBudget: projection.verificationBudget,
        repoIndexQueries: projection.repoIndexQueries,
        knowledgeRetrievals: projection.knowledgeRetrievals,
        commandAttempts: collectCommandAttemptEvidence({
          runDirectory,
          stages: loaded.flow.spec.stages,
          events,
        }),
        hookAttempts: collectHookAttemptEvidence({ runDirectory, events }),
        loadedSkills: loadedSkillUsages,
        contextKnowledge,
        orchestratorDecisions: projection.orchestratorDecisions,
        verificationDiagnoses: projection.verificationDiagnoses,
        operatorQuestions: projection.questions,
        inputs: inputArtifacts,
        configuration,
        context: runtimeContext,
        taskScope: resumedTaskScope,
        taskIssues,
        changeTitle: latestChangeTitle,
        changeRequest,
        reworkTarget,
        syncMetadata,
        reproducibility,
        toolchainPreflight,
        ...(projection.riskClassification
          ? { riskClassification: projection.riskClassification }
          : {}),
      });
    };
    const injectedAgentMemory = createInjectedAgentMemoryScope({
      repoPath,
      workspace,
      stages: loaded.flow.spec.stages,
      runId: input.runId,
      eventStore,
      context: runtimeContext,
    });
    const finalizeResumedTerminal = async (terminal: {
      status: "blocked" | "failed";
      stageId: string;
      error: string;
      blocker?: RunBlocker;
    }): Promise<void> => {
      await runAlwaysRunFinalizers({
        runId: input.runId,
        flowName: loaded.flow.metadata.name,
        workItemId: projection.workItemId,
        stages: loaded.flow.spec.stages,
        terminalStatus: terminal.status,
        terminalStageId: terminal.blocker?.stageId ?? terminal.stageId,
        terminalError: terminal.error,
        blocker: terminal.blocker,
        runDirectory,
        repoPath,
        backend,
        dependencies,
        workspace,
        flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
        flowMaxAttempts: loaded.flow.spec.maxAttempts,
        flowContext: loaded.flow.spec.context,
        flowReads: loaded.flow.spec.reads,
        flowTimeouts: loaded.flow.spec.timeouts,
        flowBudgets: effectiveFlowBudgets(loaded.flow),
        inputArtifacts,
        configuration,
        context: runtimeContext,
        eventStore,
        providerStore,
        loadedSkillUsages,
        contextKnowledge,
        completedStages,
        injectedAgentMemory,
        changeRequestUrl,
        changeRequest,
        reworkTarget,
        syncMetadata,
        nextAttempt: (finalizerStageId) =>
          nextAttemptForStage(
            projectRun(eventStore.list(input.runId)),
            finalizerStageId,
          ),
      });
      await injectedAgentMemory.cleanup();
      const finalEvidencePath = await writeRunEvidenceSnapshot(terminal.status);
      changeRequest = await refreshTerminalChangeRequestEvidence({
        runId: input.runId,
        repoPath,
        worktreePath,
        changeRequest,
        evidencePath: finalEvidencePath,
        title: latestChangeTitle?.title,
        dependencies,
        providerStore,
        providerName: changeRequestProvider,
        context: runtimeContext,
        eventStore,
      }) ?? changeRequest;
      changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
      await recordTaskIssueRunLinks({
        repoPath,
        runId: input.runId,
        status: terminal.status,
        evidencePath: finalEvidencePath,
        changeRequestUrl,
        scope: taskIssues,
        dependencies,
        providerStore,
        context: runtimeContext,
        eventStore,
      });
    };

    const taskPlanController = createTaskPlanExecutionController({
      startIndex,
      states: taskPlanStates,
      inputArtifacts,
      stages: loaded.flow.spec.stages,
      graph: loaded.graph,
      completedStages,
      eventStore,
      runId: input.runId,
      context: runtimeContext,
    });
    while (!taskPlanController.done) {
      const stageIndex = taskPlanController.stageIndex;
      const stageId = taskPlanController.stageId;
      const stage = loaded.flow.spec.stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        taskPlanController.next();
        continue;
      }
      if (stage.alwaysRun) {
        taskPlanController.next();
        continue;
      }
      const taskPlanStage = taskPlanController.prepare(stage);
      if (!taskPlanStage.run) continue;
      const preparedTaskPlan = taskPlanStage.prepared;
      const resumableStage = resumableStageById.get(stage.id);
      const resumableAttempt = resumableStage?.attempts.at(-1);
      const resumeApprovalAttempt =
        stage.type === "approval" && resumableStage?.status === "awaiting-approval"
          ? resumableAttempt
          : undefined;
      const resumeOperatorReview =
        stage.type === "gate" &&
        stage.mode === "review" &&
        resumableStage?.status === "blocked" &&
        submittedOperatorReview?.stageId === stage.id
          ? submittedOperatorReview
          : undefined;

      if (stage.type === "agent" || stage.type === "judge" || stage.type === "command" || stage.type === "gate") {
        const resumableAttempt = resumableStage?.attempts.at(-1);
        if (resumableAttempt && resumableStage?.status === "interrupted") {
          appendOrchestratorDecision({
            eventStore,
            runId: input.runId,
            stage,
            attempt: resumableAttempt.attempt,
            maxAttempts: maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts),
            decision: { action: "fail", reason: "interrupted after process restart" },
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
          const failures = previousFailuresByStage.get(stage.id) ?? [];
          failures.push({
            attempt: resumableAttempt.attempt,
            error: "interrupted after process restart",
          });
          previousFailuresByStage.set(stage.id, failures);
          projection = projectRun(eventStore.list(input.runId));
        }
        if (resumableStage) resumableStageById.delete(stage.id);
        const resumeSource =
          resumableStage?.status ??
          (projection.status === "blocked" ? "blocked" : "interrupted");
        const maxAttempts = maxAttemptsForStage(stage, loaded.flow.spec.maxAttempts);
        const previousFailures = previousFailuresByStage.get(stage.id) ?? [];
        previousFailuresByStage.set(stage.id, previousFailures);
        let reworkRequested = false;
        let stageCompleted = false;
        let completedAttempt: number | undefined;
        let continuationAttemptAvailable = resumableStage !== undefined;

        try {
          if (resumeOperatorReview && stage.type === "gate") {
            const recordedGate = recordGateStageResult({
              runId: input.runId,
              stage,
              attempt: resumeOperatorReview.attempt ?? 1,
              maxAttempts,
              gateResult: resumeOperatorReview,
              gateResults,
              completedStages,
              eventStore,
              context: runtimeContext,
            });
            completedAttempt = recordedGate.gateAttempt;
            attemptsByStage.set(
              stage.id,
              Math.max(attemptsByStage.get(stage.id) ?? 0, recordedGate.gateAttempt),
            );
            if (resumeOperatorReview.operatorReview) {
              eventStore.append({
                runId: input.runId,
                stageId: stage.id,
                attempt: recordedGate.gateAttempt,
                type: "operator.review.resolved",
                payload: redactRuntimeUnknown(
                  {
                    gateResultId: resumeOperatorReview.id,
                    actor: resumeOperatorReview.operatorReview.actor,
                    submittedAt: resumeOperatorReview.operatorReview.submittedAt,
                    blocker: resumeOperatorReview.operatorReview.blocker,
                    resolution: recordedGate.passed
                      ? "blocker_overridden"
                      : "review_failed",
                  },
                  runtimeContext,
                ),
              });
            }
            if (!recordedGate.passed) {
              throw new Error(recordedGate.reason);
            }
            const operatorAttemptDirectory = join(
              runDirectory,
              "stages",
              stage.id,
              String(recordedGate.gateAttempt),
            );
            await executeStageHooks({
              stage,
              phase: "post",
              attempt: recordedGate.gateAttempt,
              attemptDirectory: operatorAttemptDirectory,
              backend,
              workspace,
              flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
              context: runtimeContext,
              eventStore,
              runId: input.runId,
            });
            stageCompleted = true;
          }

          while (
            !stageCompleted &&
            ((attemptsByStage.get(stage.id) ?? 0) < maxAttempts ||
              continuationAttemptAvailable)
          ) {
            continuationAttemptAvailable = false;
            const attempt = (attemptsByStage.get(stage.id) ?? 0) + 1;
            let effectiveAttempt = attempt;
            attemptsByStage.set(stage.id, attempt);
            const { attemptDirectory } = await prepareStageAttempt({
              begin: {
                eventStore,
                runId: input.runId,
                runDirectory,
                stage,
                attempt,
                resumedFrom: resumeSource,
                branchHeadSha: await currentBranchHeadSha(worktreePath),
                directoryMode: "ensure",
              },
              prepare:
                stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review")
                  ? async () => await prepareStageInstructionFilesBeforeAttempt({
                      stage,
                      controls: resolveStageContextControls(loaded.flow, stage),
                      injectedAgentMemory,
                    })
                  : undefined,
            });

            let failureError: string | undefined;
            let budgetExceededError: BudgetExceededError | undefined;
            let builtInRecommendation: OrchestratorRecommendation | undefined;
            try {
              await executeStageHooks({
                stage,
                phase: "pre",
                attempt,
                attemptDirectory,
                backend,
                workspace,
                flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                context: runtimeContext,
                eventStore,
                runId: input.runId,
              });

              if (stage.type === "judge") {
                const contextControls = resolveStageContextControls(loaded.flow, stage);
                const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
                const result = await withStageInstructionFiles({
                  stage,
                  controls: contextControls,
                  attemptDirectory,
                  workspace,
                  injectedAgentMemory,
                  run: async () => await executeAgentStage({
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
                    flowTimeouts: loaded.flow.spec.timeouts,
                    flowBudgets: effectiveFlowBudgets(loaded.flow),
                    inputArtifacts,
                    configuration,
                    context: runtimeContext,
                    eventStore,
                    providerStore,
                    loadedSkillUsages,
                    contextControls,
                    readPolicy,
                    contextKnowledge,
                    previousFailures,
                    taskPlanPrompt: preparedTaskPlan?.promptContext,
                    agentSessions,
                    completedStages,
                    completeStage: false,
                    resumedFrom: resumeSource,
                    onAttemptSelected: (selectedAttempt) => {
                      effectiveAttempt = selectedAttempt;
                      attemptsByStage.set(stage.id, selectedAttempt);
                    },
                  }),
                });
                effectiveAttempt = result.selectedAttempt;
                const judgeOutput = await readJudgeOutput({
                  stage,
                  attempt: effectiveAttempt,
                  attemptDirectory: selectedAttemptDirectory({
                    runDirectory,
                    stageId: stage.id,
                    currentAttempt: attempt,
                    currentAttemptDirectory: attemptDirectory,
                    selectedAttempt: effectiveAttempt,
                  }),
                  context: runtimeContext,
                });
                if (!judgeOutput.result) throw new Error(judgeOutput.reason);
                eventStore.append({
                  runId: input.runId,
                  stageId: stage.id,
                  attempt: effectiveAttempt,
                  type: "judge.completed",
                  payload: redactRuntimeUnknown({
                    verdict: judgeOutput.result.verdict,
                    findings: judgeOutput.result.findings,
                    evidence: judgeOutput.result.evidence,
                    reworkTarget: judgeOutput.result.reworkTarget,
                    reworkInstructions: judgeOutput.result.reworkInstructions,
                    humanReviewReason: judgeOutput.result.humanReviewReason,
                    outputPath: judgeOutput.outputPath,
                    criteria: stage.criteria,
                  }, runtimeContext),
                });
                if (judgeOutput.result.verdict !== "PASS") {
                  builtInRecommendation = judgeRecommendation({
                    stage,
                    result: judgeOutput.result,
                    graph: loaded.graph,
                    validReworkStages: validReworkStagesForStage(stage.id, loaded.graph),
                  });
                  throw new Error(`judge returned ${judgeOutput.result.verdict}`);
                }
                markStageCompleted(completedStages, stage.id);
                appendSuccessfulStageCompletion({
                  eventStore,
                  runId: input.runId,
                  stage,
                  attempt: effectiveAttempt,
                  maxAttempts,
                  context: runtimeContext,
                  payload: {
                    outputs: stageOutputIds(stage),
                    verdict: judgeOutput.result.verdict,
                    criteria: stage.criteria,
                  },
                });
                await executeStageHooks({
                  stage,
                  phase: "post",
                  attempt: effectiveAttempt,
                  attemptDirectory: selectedAttemptDirectory({
                    runDirectory,
                    stageId: stage.id,
                    currentAttempt: attempt,
                    currentAttemptDirectory: attemptDirectory,
                    selectedAttempt: effectiveAttempt,
                  }),
                  backend,
                  workspace,
                  flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                  context: runtimeContext,
                  eventStore,
                  runId: input.runId,
                });
                stageCompleted = true;
                completedAttempt = effectiveAttempt;
                break;
              }

              if (stage.type === "agent") {
                const contextControls = resolveStageContextControls(loaded.flow, stage);
              const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
                const result = await withStageInstructionFiles({
                  stage,
                  controls: contextControls,
                  attemptDirectory,
                  workspace,
                  injectedAgentMemory,
                  run: async () => await executeAgentStage({
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
                    flowTimeouts: loaded.flow.spec.timeouts,
                    flowBudgets: effectiveFlowBudgets(loaded.flow),
                    inputArtifacts,
                    configuration,
                    context: runtimeContext,
                    eventStore,
                    providerStore,
                    loadedSkillUsages,
                    contextControls,
                    readPolicy,
                    contextKnowledge,
                    previousFailures,
                    operatorQuestion:
                      answeredOperatorQuestion?.stageId === stage.id
                        ? answeredOperatorQuestion
                        : undefined,
                    taskPlanPrompt: preparedTaskPlan?.promptContext,
                    agentSessions,
                    completedStages,
                    resumedFrom: resumeSource,
                    onAttemptSelected: (selectedAttempt) => {
                      effectiveAttempt = selectedAttempt;
                      attemptsByStage.set(stage.id, selectedAttempt);
                      dependencies.cancellation?.onStageChange?.({
                        stageId: stage.id,
                        attempt: selectedAttempt,
                      });
                    },
                  }),
                });
                effectiveAttempt = result.selectedAttempt;
                await executeStageHooks({
                  stage,
                  phase: "post",
                  attempt: effectiveAttempt,
                  attemptDirectory: selectedAttemptDirectory({
                    runDirectory,
                    stageId: stage.id,
                    currentAttempt: attempt,
                    currentAttemptDirectory: attemptDirectory,
                    selectedAttempt: effectiveAttempt,
                  }),
                  backend,
                  workspace,
                  flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                  context: runtimeContext,
                  eventStore,
                  runId: input.runId,
                });
                stageCompleted = true;
                completedAttempt = effectiveAttempt;
                break;
              }

              if (stage.type === "gate") {
                const contextControls = resolveStageContextControls(loaded.flow, stage);
              const readPolicy = resolveStageReadPolicy(loaded.flow.spec.reads, stage);
                const runGate = async () => await executeGateStage({
                  runId: input.runId,
                  attempt,
                  stage,
                  repoPath,
                  backend,
                  dependencies,
                  workspace,
                  flowName: loaded.flow.metadata.name,
                  flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
                  flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                  flowTimeouts: loaded.flow.spec.timeouts,
                  flowBudgets: effectiveFlowBudgets(loaded.flow),
                  inputArtifacts,
                  configuration,
                  attemptDirectory,
                  context: runtimeContext,
                  eventStore,
                  providerStore,
                  loadedSkillUsages,
                  contextControls,
                  readPolicy,
                  contextKnowledge,
                  previousFailures,
                  taskPlanPrompt: preparedTaskPlan?.promptContext,
                  agentSessions,
                });
                const { result: gateResult, budgetFailure } = stage.mode === "review"
                  ? await withStageInstructionFiles({
                      stage,
                      controls: contextControls,
                      attemptDirectory,
                      workspace,
                      injectedAgentMemory,
                      run: runGate,
                    })
                  : await (async () => {
                      await injectedAgentMemory.cleanup();
                      return await runGate();
                    })();
                const recordedGate = recordGateStageResult({
                  runId: input.runId,
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
                attemptsByStage.set(stage.id, effectiveAttempt);
                if (
                  !recordedGate.passed &&
                  (stage.mode === "review" || stage.mode === "review-aggregate")
                ) {
                  builtInRecommendation = reviewGateVerdictRecommendation({
                    stage,
                    gateResult,
                    graph: loaded.graph,
                    validReworkStages: validReworkStagesForStage(
                      stage.id,
                      loaded.graph,
                    ),
                  });
                }
                if (budgetFailure) {
                  if (recordedGate.passed) {
                    budgetFailure.stageCompleted = true;
                  }
                  throw budgetFailure;
                }
                if (recordedGate.passed) {
                  await executeStageHooks({
                    stage,
                    phase: "post",
                    attempt: effectiveAttempt,
                    attemptDirectory: selectedAttemptDirectory({
                      runDirectory,
                      stageId: stage.id,
                      currentAttempt: attempt,
                      currentAttemptDirectory: attemptDirectory,
                      selectedAttempt: effectiveAttempt,
                    }),
                    backend,
                    workspace,
                    flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                    context: runtimeContext,
                    eventStore,
                    runId: input.runId,
                    cancellation: dependencies.cancellation,
                  });
                  stageCompleted = true;
                  completedAttempt = effectiveAttempt;
                  break;
                }
                failureError = recordedGate.reason;
              } else {
                await injectedAgentMemory.cleanup();
                const commandResult = await executeCommandStage({
                  runId: input.runId,
                  stage,
                  attempt,
                  attemptDirectory,
                  runDirectory,
                  backend,
                  workspace,
                  flowMaxAttempts: loaded.flow.spec.maxAttempts,
                  flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                  flowTimeouts: loaded.flow.spec.timeouts,
                flowBudgets: effectiveFlowBudgets(loaded.flow),
                  context: runtimeContext,
                  eventStore,
                  inputArtifacts,
                  completedStages,
                  cancellation: dependencies.cancellation,
                });
                if (!commandResult.failureError) {
                  await executeStageHooks({
                    stage,
                    phase: "post",
                    attempt,
                    attemptDirectory,
                    backend,
                    workspace,
                    flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
                    context: runtimeContext,
                    eventStore,
                    runId: input.runId,
                  });
                  stageCompleted = true;
                  completedAttempt = attempt;
                  break;
                }
                failureError =
                  redactRuntimeText(commandResult.failureError, runtimeContext) ?? "";
              }
            } catch (error) {
              if (error instanceof RunCancelledError) {
                throw error;
              }
              if (error instanceof BudgetExceededError) {
                budgetExceededError = error;
                // A stage that finished and registered its outputs before the
                // breach keeps its completion. Only the run stops.
                if (!error.stageCompleted) {
                  invalidateCompletedStagesFrom(
                    completedStages,
                    loaded.graph.order,
                    stageIndex,
                  );
                }
                failureError = error.message;
              } else {
                const blocked =
                  error instanceof RunBlockedError
                    ? error
                    : (stage.type === "agent" || stage.type === "judge")
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
                  throw blocked;
                }
                invalidateCompletedStagesFrom(
                  completedStages,
                  loaded.graph.order,
                  stageIndex,
                );
                failureError = error instanceof Error ? error.message : String(error);
              }
            }

            const error = failureError ?? "unknown error";
            // `projectRun` deletes a stage from `completedStages` on
            // `stage.failed`, so emitting it here would undo the completion
            // this stage earned and make a resume repeat paid work.
            if (!budgetExceededError?.stageCompleted) {
              eventStore.append({
                runId: input.runId,
                stageId: stage.id,
                attempt: effectiveAttempt,
                type: "stage.failed",
                payload: redactRuntimeUnknown({ error }, runtimeContext),
              });
            }
            if (budgetExceededError) {
              eventStore.append({
                runId: input.runId,
                type: "run.failed",
                payload: redactRuntimeUnknown({
                  stageId: stage.id,
                  error,
                  reason: "budget_exceeded",
                }, runtimeContext),
              });
              throw budgetExceededError;
            }
            const policy = applyFailedStagePolicy({
              stage,
              attempt: effectiveAttempt,
              maxAttempts,
              flowMaxAttempts: loaded.flow.spec.maxAttempts,
              diagnosisAttempt:
                previousFailures.filter(
                  (failure) => failure.error !== "interrupted after process restart",
                ).length + 1,
              error,
              builtInRecommendation,
              dependencies,
              stages: loaded.flow.spec.stages,
              graph: loaded.graph,
              attemptsByStage,
              previousFailuresByStage,
              completedStages,
              reworkEdges,
              eventStore,
              runId: input.runId,
              context: runtimeContext,
            });
            if (policy.action === "retry") continue;
            taskPlanController.rework(policy.stageIndex, policy.request);
            reworkRequested = true;
            break;
          }

          if (reworkRequested) continue;
          if (!stageCompleted) {
            const usedAttempts = attemptsByStage.get(stage.id) ?? 0;
            throw new Error(
              `${stage.type} failed after ${usedAttempts} of ${maxAttempts} attempts`,
            );
          }
          taskPlanController.complete(stage, preparedTaskPlan, completedAttempt);
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          continue;
        } catch (error) {
          if (error instanceof RunCancelledError) {
            appendRunCancelledEvent({
              eventStore,
              runId: input.runId,
              error,
              context: runtimeContext,
            });
            await injectedAgentMemory.cleanup();
            const finalEvidencePath = await writeRunEvidenceSnapshot("cancelled");
            await recordTaskIssueRunLinks({
              repoPath,
              runId: input.runId,
              status: "cancelled",
              evidencePath: finalEvidencePath,
              changeRequestUrl,
              scope: taskIssues,
              dependencies,
              providerStore,
              context: runtimeContext,
              eventStore,
            });
            throw error;
          }
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
                attempt: attemptsByStage.get(stage.id) ?? 1,
                blocker: blocked.blocker,
                context: runtimeContext,
              });
            }
            await finalizeResumedTerminal({
              status: "blocked",
              stageId: stage.id,
              error: blocked.message,
              blocker: blocked.blocker,
            });
            throw blocked;
          }
          const errorMessage = error instanceof Error ? error.message : String(error);
          const failedAttempt = attemptsByStage.get(stage.id) ?? 1;
          const terminalEvents = eventStore.list(input.runId);
          if (
            !terminalEvents.some(
              (event) =>
                event.type === "stage.failed" &&
                event.stageId === stage.id &&
                event.attempt === failedAttempt,
            )
          ) {
            eventStore.append({
              runId: input.runId,
              stageId: stage.id,
              attempt: failedAttempt,
              type: "stage.failed",
              payload: redactRuntimeUnknown({ error: errorMessage }, runtimeContext),
            });
          }
          if (
            !terminalEvents.some(
              (event) =>
                event.type === "orchestrator.decision" &&
                event.stageId === stage.id &&
                event.attempt === failedAttempt,
            )
          ) {
            appendOrchestratorDecision({
              eventStore,
              runId: input.runId,
              stage,
              attempt: failedAttempt,
              maxAttempts,
              decision: {
                action: "fail",
                reason: `${stage.type} failed after ${failedAttempt} of ${maxAttempts} attempts: ${errorMessage}`,
              },
              context: runtimeContext,
              error: errorMessage,
            });
          }
          if (!terminalEvents.some((event) => event.type === "run.failed")) {
            eventStore.append({
              runId: input.runId,
              type: "run.failed",
              payload: redactRuntimeUnknown(
                { stageId: stage.id, error: errorMessage },
                runtimeContext,
              ),
            });
          }
          await finalizeResumedTerminal({
            status: "failed",
            stageId: stage.id,
            error: errorMessage,
          });
          throw error;
        }
      }

      const attempt =
        resumeApprovalAttempt?.attempt ??
        resumeOperatorReview?.attempt ??
        nextAttemptForStage(projection, stage.id);
      let effectiveAttempt = attempt;
      let attemptDirectory = join(runDirectory, "stages", stage.id, String(attempt));
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
      if (!resumeApprovalAttempt && !resumeOperatorReview) {
        const stageAttempt = await beginStageAttempt({
          eventStore,
          runId: input.runId,
          runDirectory,
          stage,
          attempt,
          resumedFrom: resumeSource,
          branchHeadSha: await currentBranchHeadSha(worktreePath),
          directoryMode: "ensure",
        });
        attemptDirectory = stageAttempt.attemptDirectory;
      } else {
        attemptDirectory = await requireContainedAttemptDirectory({
          runDirectory,
          attemptDirectory,
        });
      }

      try {
        if (!resumeApprovalAttempt && !resumeOperatorReview) {
          await executeStageHooks({
            stage,
            phase: "pre",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId: input.runId,
            cancellation: dependencies.cancellation,
          });
        }

        if (stage.type === "sync-change") {
          await injectedAgentMemory.cleanup();
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
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId: input.runId,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          taskPlanController.next();
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
          changeRequestProvider = stage.provider ?? "github";
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId: input.runId,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          taskPlanController.next();
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
          changeRequestProvider = reworkTarget?.provider ?? stage.provider ?? "github";
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId: input.runId,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          taskPlanController.next();
          continue;
        }

        if (stage.type === "approval") {
          await injectedAgentMemory.cleanup();
          const approval = await executeApprovalStage({
            runId: input.runId,
            stage,
            attempt,
            flowTimeouts: loaded.flow.spec.timeouts,
            context: runtimeContext,
            eventStore,
            completedStages,
          });
          if (approval.status === "awaiting-approval") {
            await injectedAgentMemory.cleanup();
            await writeRunEvidenceSnapshot();
            return {
              runId: input.runId,
              branchName,
              worktreePath,
              status: "awaiting-approval",
              approvalId: approval.approvalId,
              changeRequestUrl,
              changeRequest,
              previousHeadSha: reworkTarget?.previousHeadSha,
              updatedHeadSha: reworkTarget?.updatedHeadSha,
            };
          }
          await executeStageHooks({
            stage,
            phase: "post",
            attempt,
            attemptDirectory,
            backend,
            workspace,
            flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
            context: runtimeContext,
            eventStore,
            runId: input.runId,
          });
          projection = projectRun(eventStore.list(input.runId));
          await writeRunEvidenceSnapshot();
          taskPlanController.next();
          continue;
        }
      } catch (error) {
        if (error instanceof RunCancelledError) {
          appendRunCancelledEvent({
            eventStore,
            runId: input.runId,
            error,
            context: runtimeContext,
          });
          await injectedAgentMemory.cleanup();
          const finalEvidencePath = await writeRunEvidenceSnapshot("cancelled");
          await recordTaskIssueRunLinks({
            repoPath,
            runId: input.runId,
            status: "cancelled",
            evidencePath: finalEvidencePath,
            changeRequestUrl,
            scope: taskIssues,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
          });
          throw error;
        }
        const blocked = error instanceof RunBlockedError ? error : undefined;
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
          await runAlwaysRunFinalizers({
            runId: input.runId,
            flowName: loaded.flow.metadata.name,
            workItemId: projection.workItemId,
            stages: loaded.flow.spec.stages,
            terminalStatus: "blocked",
            terminalStageId: blocked.blocker.stageId ?? stage.id,
            terminalError: blocked.message,
            blocker: blocked.blocker,
            runDirectory,
            repoPath,
            backend,
            dependencies,
            workspace,
            flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
            flowMaxAttempts: loaded.flow.spec.maxAttempts,
            flowContext: loaded.flow.spec.context,
            flowReads: loaded.flow.spec.reads,
            flowTimeouts: loaded.flow.spec.timeouts,
            flowBudgets: effectiveFlowBudgets(loaded.flow),
            inputArtifacts,
            configuration,
            context: runtimeContext,
            eventStore,
            providerStore,
            loadedSkillUsages,
            contextKnowledge,
            completedStages,
            injectedAgentMemory,
            changeRequestUrl,
            changeRequest,
            reworkTarget,
            syncMetadata,
            nextAttempt: (finalizerStageId) =>
              nextAttemptForStage(projectRun(eventStore.list(input.runId)), finalizerStageId),
          });
          await injectedAgentMemory.cleanup();
          const finalEvidencePath = await writeRunEvidenceSnapshot("blocked");
          changeRequest = await refreshTerminalChangeRequestEvidence({
            runId: input.runId,
            repoPath,
            worktreePath,
            changeRequest,
            evidencePath: finalEvidencePath,
            title: latestChangeTitle?.title,
            dependencies,
            providerStore,
            providerName: changeRequestProvider,
            context: runtimeContext,
            eventStore,
          }) ?? changeRequest;
          changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
          await recordTaskIssueRunLinks({
            repoPath,
            runId: input.runId,
            status: "blocked",
            evidencePath: finalEvidencePath,
            changeRequestUrl,
            scope: taskIssues,
            dependencies,
            providerStore,
            context: runtimeContext,
            eventStore,
          });
          throw blocked;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        const currentStageIndex = loaded.graph.order.indexOf(stage.id);
        if (currentStageIndex >= 0) {
          invalidateCompletedStagesFrom(
            completedStages,
            loaded.graph.order,
            currentStageIndex,
          );
        }
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
          maxAttempts: 1,
          decision: {
            action: "fail",
            reason: `${stage.type} failed after ${effectiveAttempt} of 1 attempts: ${errorMessage}`,
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
        await runAlwaysRunFinalizers({
          runId: input.runId,
          flowName: loaded.flow.metadata.name,
          workItemId: projection.workItemId,
          stages: loaded.flow.spec.stages,
          terminalStatus: "failed",
          terminalStageId: stage.id,
          terminalError: errorMessage,
          runDirectory,
          repoPath,
          backend,
          dependencies,
          workspace,
          flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
          flowMaxAttempts: loaded.flow.spec.maxAttempts,
          flowContext: loaded.flow.spec.context,
          flowReads: loaded.flow.spec.reads,
          flowTimeouts: loaded.flow.spec.timeouts,
          flowBudgets: effectiveFlowBudgets(loaded.flow),
          inputArtifacts,
          configuration,
          context: runtimeContext,
          eventStore,
          providerStore,
          loadedSkillUsages,
          contextKnowledge,
          completedStages,
          injectedAgentMemory,
          changeRequestUrl,
          changeRequest,
          reworkTarget,
          syncMetadata,
          nextAttempt: (finalizerStageId) =>
            nextAttemptForStage(projectRun(eventStore.list(input.runId)), finalizerStageId),
        });
        await injectedAgentMemory.cleanup();
        const finalEvidencePath = await writeRunEvidenceSnapshot("failed");
        changeRequest = await refreshTerminalChangeRequestEvidence({
          runId: input.runId,
          repoPath,
          worktreePath,
          changeRequest,
          evidencePath: finalEvidencePath,
          title: latestChangeTitle?.title,
          dependencies,
          providerStore,
          providerName: changeRequestProvider,
          context: runtimeContext,
          eventStore,
        }) ?? changeRequest;
        changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
        await recordTaskIssueRunLinks({
          repoPath,
          runId: input.runId,
          status: "failed",
          evidencePath: finalEvidencePath,
          changeRequestUrl,
          scope: taskIssues,
          dependencies,
          providerStore,
          context: runtimeContext,
          eventStore,
        });
        throw error;
      }
    }

    try {
      await executeFlowHooks({
        hooks: loaded.flow.spec.hooks?.postRun ?? [],
        phase: "postRun",
        runDirectory,
        backend,
        workspace,
        flowMaxToolOutputTokens: loaded.flow.spec.maxToolOutputTokens,
        context: runtimeContext,
        eventStore,
        runId: input.runId,
        cancellation: dependencies.cancellation,
      });
    } catch (error) {
      if (error instanceof RunCancelledError) {
        appendRunCancelledEvent({
          eventStore,
          runId: input.runId,
          error,
          context: runtimeContext,
        });
        await injectedAgentMemory.cleanup();
        const finalEvidencePath = await writeRunEvidenceSnapshot("cancelled");
        await recordTaskIssueRunLinks({
          repoPath,
          runId: input.runId,
          status: "cancelled",
          evidencePath: finalEvidencePath,
          changeRequestUrl,
          scope: taskIssues,
          dependencies,
          providerStore,
          context: runtimeContext,
          eventStore,
        });
        throw error;
      }
      await injectedAgentMemory.cleanup();
      const finalEvidencePath = await writeRunEvidenceSnapshot("failed");
      await recordTaskIssueRunLinks({
        repoPath,
        runId: input.runId,
        status: "failed",
        evidencePath: finalEvidencePath,
        changeRequestUrl,
        scope: taskIssues,
        dependencies,
        providerStore,
        context: runtimeContext,
        eventStore,
      });
      throw error;
    }

    await runAlwaysRunFinalizers({
      runId: input.runId,
      flowName: loaded.flow.metadata.name,
      workItemId: projection.workItemId,
      stages: loaded.flow.spec.stages,
      terminalStatus: "completed",
      runDirectory,
      repoPath,
      backend,
      dependencies,
      workspace,
      flowMaxInputTokens: loaded.flow.spec.maxInputTokens,
      flowMaxAttempts: loaded.flow.spec.maxAttempts,
      flowContext: loaded.flow.spec.context,
      flowReads: loaded.flow.spec.reads,
      flowTimeouts: loaded.flow.spec.timeouts,
      flowBudgets: effectiveFlowBudgets(loaded.flow),
      inputArtifacts,
      configuration,
      context: runtimeContext,
      eventStore,
      providerStore,
      loadedSkillUsages,
      contextKnowledge,
      completedStages,
      injectedAgentMemory,
      changeRequestUrl,
      changeRequest,
      reworkTarget,
      syncMetadata,
      nextAttempt: (finalizerStageId) =>
        nextAttemptForStage(projectRun(eventStore.list(input.runId)), finalizerStageId),
    });
    if (resumedTaskScope && !resumedTaskScope.completedAt) {
      eventStore.append({
        runId: input.runId,
        type: "task.scope.completed",
        payload: redactRuntimeUnknown(
          {
            inputId: resumedTaskScope.inputId,
            expression: resumedTaskScope.expression,
            selectedTaskIds: resumedTaskScope.selectedTaskIds,
            completedTaskIds: resumedTaskScope.selectedTaskIds,
          },
          runtimeContext,
        ),
      });
    }
    const finalEvidencePath = await writeRunEvidenceSnapshot("completed");
    changeRequest = await refreshTerminalChangeRequestEvidence({
      runId: input.runId,
      repoPath,
      worktreePath,
      changeRequest,
      evidencePath: finalEvidencePath,
      title: latestChangeTitle?.title,
      dependencies,
      providerStore,
      providerName: changeRequestProvider,
      context: runtimeContext,
      eventStore,
    }) ?? changeRequest;
    changeRequestUrl = changeRequest?.url ?? changeRequestUrl;
    await recordTaskIssueRunLinks({
      repoPath,
      runId: input.runId,
      status: "completed",
      evidencePath: finalEvidencePath,
      changeRequestUrl,
      scope: taskIssues,
      dependencies,
      providerStore,
      context: runtimeContext,
      eventStore,
    });
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
          workItemType: runWorkItemType,
          runEligibilityOverride: projection.runEligibilityOverride,
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
          taskScope: resumedTaskScope,
          taskIssues,
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
          configuration,
        }, runtimeContext),
        null,
        2,
      ),
      "utf8",
    );
    if (projectRun(eventStore.list(input.runId)).status === "cancelled") {
      eventStore.close();
      throw new RunCancelledError({
        request: cancellationRequestFromSignal(dependencies.cancellation),
      });
    }
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
        taskScope: resumedTaskScope,
        taskIssues,
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
