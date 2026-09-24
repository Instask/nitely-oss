import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GitHubWebhookRequestError,
  GitHubWebhookIntake,
  githubWebhookConfigurationFromEnv,
  maximumGitHubWebhookBodyBytes,
  type GitHubWebhookConfiguration,
} from "../github-webhooks/intake.js";
import { githubAppStatusPublisherFromEnv } from "../github-webhooks/checks.js";

import {
  externalKnowledgeAdmissionControls,
  runFlow as defaultRunFlow,
  resumeRun,
  type RunCancellationControl,
  type RunCancellationRequest,
  type RunCancellationStage,
  type RunFlowDependencies,
  type RunFlowInput,
  type RunFlowResult,
} from "../run/run-flow.js";
import {
  normalizeExecutionBackendName,
  type ExecutionBackendName,
} from "../run/execution/backend.js";
import { reapExpiredOciContainers } from "../run/execution/oci.js";
import { parseFlowDocument } from "../flow/load.js";
import {
  evaluateWorkItemRunPreflight,
} from "../run/preflight.js";
import {
  RepositoryFlowPathError,
  resolveRepositoryFlowPath,
} from "../flows/paths.js";
import {
  evaluateWorkItemRunStarts,
  formatRunEligibilityError,
  type RunEligibilityIntent,
} from "../run/eligibility.js";
import {
  admitWorkItemRun,
  reconcileTerminalWorkItemRun,
  settleWorkItemRun,
  type WorkItemRunAdmission,
} from "../run/admission.js";
import { resolveApproval } from "../run/approvals.js";
import { answerQuestion } from "../run/questions.js";
import { submitOperatorReview } from "../run/operator-review.js";
import {
  defaultGitHubIssueFetcher,
  generateDraftSpec,
  normalizeGitHubIssue,
  parseGitHubIssueReference,
  type DraftSpecSource,
  type DraftSpecSourceType,
  type GitHubIssueContent,
  type GitHubIssueFetcher,
} from "../spec-artifacts/draft.js";
import {
  configuredJiraBaseUrl,
  defaultJiraStatusPublisher,
  defaultJiraTicketFetcher,
  parseJiraTicketReference,
  type JiraStatusPublisher,
  type JiraStatusUpdate,
  type JiraTicketFetcher,
} from "../ticket-sources/jira.js";
import type {
  NormalizedTicket,
  TicketSourceType,
} from "../ticket-sources/types.js";
import {
  evaluateWorkItemSpecReadiness,
  evaluateSourceSpecificSpecReadiness,
  formatSourceSpecificSpecReadinessError,
  type SourceSpecificSpecReadinessIssue,
} from "../spec-artifacts/readiness.js";
import {
  collectRepositoryPlanContext,
  generateDraftTechnicalPlan,
} from "../plan-artifacts/draft.js";
import {
  CONTEXT_KNOWLEDGE_CATEGORIES,
  createContextKnowledgeEntry,
  listContextKnowledgeEntries,
  linkContextKnowledgeEntries,
  selectContextKnowledgeEntries,
  updateContextKnowledgeEntry,
  type ContextKnowledgeCategory,
  type ContextKnowledgeEntry,
  type ContextKnowledgeSource,
  type ContextKnowledgeStatus,
  type CreateContextKnowledgeEntryInput,
  type UpdateContextKnowledgeEntryInput,
} from "../context-kg/store.js";
import { loadContextPolicy } from "../context/policy.js";
import {
  collectContextRedactionSecrets,
  containsSensitiveText,
  isSensitiveKey,
  redactText,
} from "../context/redaction.js";
import {
  attachKnowledgeRepository,
  detachKnowledgeRepository,
  getKnowledgeRepositoryStatus,
  listKnowledgeRepositories,
  queryKnowledgeRepositories,
  refreshKnowledgeRepository,
  type KnowledgeRepositoryView,
} from "../knowledge-repositories/service.js";
import { knowledgeRepositoryRegistryExists } from "../knowledge-repositories/paths.js";
import type {
  CreateKnowledgeRepositoryAttachmentInput,
  KnowledgeRepositoryAttachment,
  KnowledgeRepositoryStatus,
} from "../knowledge-repositories/schema.js";
import { createRequire } from "node:module";

import { EventStore } from "../events/store.js";
import { materializeScheduleNow } from "../schedules/materialize.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleOccurrencesWithLineage,
  listSchedules,
  ScheduleInputError,
  ScheduleNotFoundError,
  setScheduleEnabled,
  updateSchedule,
} from "../schedules/store.js";
import type {
  CreateScheduleInput,
  ScheduleOccurrenceWithLineage,
  ScheduleRecord,
  UpdateScheduleInput,
} from "../schedules/types.js";
import {
  PROVIDER_DESCRIPTORS,
  findAuthMethod,
  findDescriptor,
} from "../providers/descriptors.js";
import { FileProviderConnectionStore } from "../providers/file-store.js";
import type { ProviderOAuthOptions } from "../providers/file-store.js";
import { resolveProviderStore } from "../providers/index.js";
import { createProviderOAuthAdapters, PROVIDER_OAUTH_CLIENT_ENV } from "../providers/oauth/adapters.js";
import type { ProviderOAuthAdapter } from "../providers/oauth/adapters.js";
import { MissingConnectionError, ReconnectRequiredError } from "../providers/types.js";
import { ProviderOAuthFlowError, ProviderOAuthFlowRegistry } from "./provider-oauth-flows.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionRecord,
  ProviderConnectionStore,
  ProviderConnectionSummary,
  ProviderCredentialMetadata,
  ProviderCredentialScope,
  ProviderCredentialSource,
  ProviderId,
} from "../providers/types.js";
import {
  isWebError,
  WebCapabilityDeniedError,
  WebForbiddenError,
  WebInputError,
  WebNotFoundError,
  WebRunStartConflictError,
  WebSetupRequiredError,
  WebUnauthorizedError,
} from "./errors.js";
import {
  API_TOKEN_CAPABILITIES,
  appendApiTokenRequestAudit,
  authenticateApiToken,
  createApiToken,
  isHighImpactCapability,
  parseApiTokenId,
  type ApiTokenCapability,
  type ApiTokenRecord,
} from "./api-tokens.js";
import {
  apiTokenActionForRequest,
  type ApiTokenAction,
} from "./api-token-auth.js";
import {
  claimDeviceAuthorization,
  createDeviceAuthorization,
  decideDeviceAuthorization,
  deleteDeviceAuthorization,
  formatUserCode,
  normalizeUserCode,
  readDeviceAuthorization,
  recordDevicePoll,
  resolveDeviceAuthorization,
} from "./device-authorizations.js";
import {
  createTask,
  confirmTaskDependency,
  dismissTaskDependencySuggestion,
  getTask,
  getTaskDetail,
  getTaskSnapshot,
  listTasks,
  materializeTaskExecutionInputs,
  requestTaskPlanningChanges,
  updateTaskDependencies,
  updateTaskDependencySuggestions,
  updateTaskSpecApproval,
  updateTaskTechnicalDesign,
  updateTaskTechnicalDesignApproval,
  updateTaskRunState,
  updateTaskSpec,
  updateTaskSourceRecord,
  isSnapshotBackedTaskSourceType,
  withSourceSnapshotContentHash,
  SOURCE_SNAPSHOT_CONTENT_FIELDS,
  type SnapshotBackedTaskSourceType,
  type SuggestedDependency,
  type TaskRecord,
  type TaskPriority,
  type TaskSourceConversation,
  type TaskSourceDrift,
  type TaskSourceRecord,
  type TaskSourceSnapshot,
  type TaskSourceStatusSync,
} from "./tasks.js";
import {
  ExternalDocumentInputError,
  normalizeExternalDocument,
  type NormalizedExternalDocument,
} from "../intake/external-document.js";
import {
  conversationIntakeSummary,
  IntakeConversationError,
  normalizeIntakeConversation,
  type IntakeConversationTurn,
} from "../intake/conversation.js";
import {
  cancelTaskReworkRequest,
  createTaskReworkRequest,
  defaultTaskReworkFlowPath,
  getTaskReworkRequest,
  listTaskReworkRequests,
  markTaskReworkRequestRunning,
  materializeTaskReworkRequestInputs,
  settleTaskReworkRequest,
  type TaskReworkRequest,
  type TaskReworkRouteTarget,
} from "./task-rework-requests.js";
import { createScmProvider } from "../scm/registry.js";
import type { ChangeRequest, ChangeRequestStatus } from "../scm/types.js";
import type { ChangeRequestStatusFetcher } from "../scheduler/completion.js";
import { wouldCreateCycle } from "../scheduler/graph.js";
import {
  generateDependencySuggestions,
  mergeDependencySuggestions,
} from "../scheduler/suggestions.js";
import {
  MAX_SCHEDULER_CONCURRENCY,
  resolveMaxConcurrentTasks,
  runSchedulerOnce,
  type SchedulerRunSummary,
} from "../scheduler/run.js";
import {
  buildSchedulerView,
  sortSchedulerQueue,
  type SchedulerView,
} from "../scheduler/view.js";
import {
  projectSchedulerCooldowns,
  readSchedulerCooldowns,
} from "../scheduler/cooldown.js";
import {
  dispatchFactoryQueue,
  getFactoryQueueSnapshot,
  setFactoryQueuePaused,
  upsertFactoryCandidate,
} from "../factory-queue.js";
import {
  DEFAULT_RUN_LIST_LIMIT,
  getRunDetail,
  getRunLogStreamSnapshot,
  listRuns,
  type ListRunsOptions,
  type WebRunSummary,
} from "./runs.js";
import { eventStorePath, projectRun } from "../run/project.js";
import { UnsafeRunOwnedFileError } from "../run/owned-file.js";
import {
  DEV_PR_WORK_ITEM_TYPE,
  finalizeWorkItemRunCandidate,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  prepareWorkItemRunCandidate,
  prepareWorkItemRunCandidates,
  projectWorkItem,
} from "../work-items/access.js";
import {
  getWorkItemView,
  listWorkItemViews,
} from "./work-item-views.js";
import { consoleListApiRoutes, dispatchHttpRoutes } from "./route-dispatch.js";
import {
  apiContextKnowledgeId,
  apiDeviceAuthorizationUserCode,
  apiFlowId,
  apiNotificationActionsId,
  apiNotificationAssignId,
  apiNotificationResolveId,
  apiPreviewSessionProxyRef,
  apiPreviewSessionRef,
  apiRunId,
  apiRunLogsStreamId,
  apiRunQuestionAnswerId,
  apiRunReviewVerdictId,
  apiTaskApproveSpecId,
  apiTaskApproveTechDesignId,
  apiTaskDependenciesId,
  apiTaskDependencyId,
  apiTaskDependencySuggestionDismissId,
  apiTaskDependencySuggestionsRefreshId,
  apiTaskDraftTechDesignId,
  apiTaskId,
  apiTaskPreflightId,
  apiTaskReplaceSpecId,
  apiTaskRefreshSourcePlanningId,
  apiTaskReworkRequestId,
  apiTaskReworkRequestsId,
  apiTaskSyncSourceStatusId,
  apiTaskRunId,
  apiWorkItemId,
  apiWorkItemRunId,
  htmlRunId,
  htmlTaskId,
} from "./route-patterns.js";
import { createFlowWorkItem } from "../work-items/create.js";
import {
  confirmWorkItemDependency,
  dismissWorkItemDependencySuggestion,
  getWorkItem,
  getWorkItemSnapshot,
  updateWorkItem,
  updateWorkItemDependencies,
  updateWorkItemDependencySuggestions,
} from "../work-items/store.js";
import { workItemDependencyGuards } from "../work-items/candidate-version.js";
import type { WorkItemStoreKind } from "../work-items/types.js";
import { FlowValidationError } from "../flow/load.js";
import { openFlowStore } from "../flows/store.js";
import { validateFlowDocument } from "../flows/validate.js";
import {
  flowTemplateDocumentForCopy,
  flowTemplateLineage,
  flowTemplates,
  getFlowTemplate,
} from "../flows/templates.js";
import { listFlowViews, getFlowView } from "./flows.js";
import {
  assignNotification,
  assertNotificationActionAllowed,
  getNotification,
  listTaskNotificationDecisions,
  listNotifications,
  notificationActionFromValue,
  recordNotificationDecision,
  resolveNotification,
  resolveNotificationBySourceKey,
  upsertNotification,
  type NotificationAction,
  type NotificationDecisionRecord,
  type NotificationRecord,
  type NotificationStatus,
  type NotificationType,
  type UpsertNotificationInput,
} from "./notifications.js";
import {
  configuredHttpNotificationTargets,
  createGitHubIssueNotificationTarget,
  createJiraNotificationTarget,
  dispatchNotificationDeliveries,
  listNotificationDeliveryReceipts,
  type NotificationDeliveryReceipt,
  type NotificationDeliveryTarget,
} from "./notification-delivery.js";
import {
  addStoredWebRepository,
  hasLegacyHomeState,
  LEGACY_DEFAULT_REPOSITORY_ID,
  loadWebRepositories,
  migrateHomeRepository,
  publicRepository,
  repositoryById,
  syncStoredWebRepository,
  type AddWebRepositoryInput,
  type CloneRepository,
  type ReadOriginUrl,
  type WebRepository,
  type WebRepositoryInput,
} from "./repositories.js";
import { serializeWebJson } from "./json.js";
import { observePromiseOnce } from "./promise-observers.js";
import { listRepositorySkills } from "./skills.js";
import {
  importLocalSkill,
  previewLocalSkillImport,
} from "../skills/import.js";
import {
  runGoldenPathDemo,
  type GoldenPathDemoResult,
} from "../demo/golden-path.js";
import {
  buildManagerDashboard,
  buildMyWorkDashboard,
  filterManagerDashboardRuns,
  type DashboardFilterSelection,
} from "./dashboard.js";
import {
  buildAgentStabilityProjection,
  type AgentStabilityRunInput,
} from "./agent-stability.js";
import { readToolchainPreflight } from "../run/toolchain-preflight.js";
import {
  canonicalChangeRequestTarget,
  changeRequestIdentity,
} from "./change-requests.js";
import {
  bootstrapInitialAdmin,
  createSession,
  deleteSession,
  getPublicUser,
  hasAnyUsers,
  invalidateUserSessions,
  listPublicUsers,
  readSessionUser,
  verifyUserPassword,
  type PublicUser,
} from "./users.js";
import {
  type PublicOrganizationMembership,
} from "./organizations.js";
import {
  organizationRoleHasPermission,
  webPermissionAllowed,
  type WebPermission,
} from "./access-control.js";
import {
  LoginAttemptLimiter,
  type LoginAttemptLimiterOptions,
} from "./login-throttle.js";
import {
  appendSecurityAuditEvent,
  listSecurityAuditEvents,
  securityAuditSubjectFingerprint,
  type SecurityAuditActor,
  type SecurityAuditTarget,
} from "./security-audit.js";
import {
  webSecurityActionForRequest,
  type WebSecurityAction,
} from "./security-actions.js";
import { PreviewSessionManager } from "../preview/manager.js";
import { PlaywrightChromiumPreviewProvider } from "../preview/playwright-provider.js";
import { attachPreviewScreenshotToRun } from "../preview/evidence.js";
import {
  PREVIEW_VIEWPORT_PRESETS,
  type PreviewRuntimeProvider,
  type PreviewSessionRecord,
  type PreviewViewport,
} from "../preview/types.js";
import { compareVisualArtifacts } from "../visual-diff/index.js";
import type { VisualComparisonImageInput } from "../visual-diff/index.js";

const staticDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "web", "static",
);

export interface StartWebServerInput {
  repoPath: string;
  repositories?: WebRepositoryInput[];
  /** Test seam for the home-checkout migration; defaults to reading git. */
  readRepositoryOrigin?: ReadOriginUrl;
  host: string;
  port: number;
  authMode?: WebAuthMode;
  authEnv?: Record<string, string | undefined>;
  providerEnv?: Record<string, string | undefined>;
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>;
  createRunId?: () => string;
  runGoldenPathDemo?: (input: { outputDir: string }) => Promise<GoldenPathDemoResult>;
  providerCommandStatus?: (command: string, args: string[]) => Promise<boolean>;
  providerStore?: ProviderConnectionStore;
  /** HTTP client for provider OAuth token and identity endpoints. */
  providerOAuthFetch?: typeof fetch;
  /** Clock for OAuth expiry and refresh decisions. */
  providerOAuthNow?: () => Date;
  cloneRepository?: CloneRepository;
  githubIssueFetcher?: GitHubIssueFetcher;
  jiraTicketFetcher?: JiraTicketFetcher;
  jiraStatusPublisher?: JiraStatusPublisher;
  notificationScmProvider?: import("../scm/types.js").ScmProvider;
  getChangeRequestStatus?: ChangeRequestStatusFetcher;
  notificationDeliveryTargets?: NotificationDeliveryTarget[];
  loginRateLimit?: LoginAttemptLimiterOptions;
  previewProvider?: PreviewRuntimeProvider;
  createPreviewSessionId?: () => string;
  previewEnv?: Record<string, string | undefined>;
  githubWebhook?: GitHubWebhookConfiguration;
  githubWebhookEnv?: Record<string, string | undefined>;
  knowledgeRepositoryService?: {
    attach: typeof attachKnowledgeRepository;
    list: typeof listKnowledgeRepositories;
    status: typeof getKnowledgeRepositoryStatus;
    refresh: typeof refreshKnowledgeRepository;
    query: typeof queryKnowledgeRepositories;
    detach: typeof detachKnowledgeRepository;
  };
}

interface RuntimeStartWebServerInput extends StartWebServerInput {
  githubWebhookIntake?: GitHubWebhookIntake;
  previewManager?: PreviewSessionManager;
  providerOAuth?: ProviderOAuthRuntime;
}

interface ProviderOAuthRuntime {
  adapters: Map<ProviderId, ProviderOAuthAdapter>;
  flows: ProviderOAuthFlowRegistry;
  now: () => Date;
}

function providerOAuthRuntimeForInput(input: StartWebServerInput): ProviderOAuthRuntime {
  const now = input.providerOAuthNow ?? (() => new Date());
  return {
    adapters: createProviderOAuthAdapters({
      env: input.providerEnv ?? process.env,
      ...(input.providerOAuthFetch ? { fetch: input.providerOAuthFetch } : {}),
      now,
    }),
    flows: new ProviderOAuthFlowRegistry({ now }),
    now,
  };
}

/**
 * The store options that let a stored OAuth credential refresh itself: the
 * adapter for its provider, if one is configured, and the shared clock.
 */
function providerStoreOAuthOptions(
  input: RuntimeStartWebServerInput,
): { oauth?: ProviderOAuthOptions; now?: () => Date } {
  const runtime = input.providerOAuth;
  if (!runtime) return {};
  return {
    now: runtime.now,
    oauth: {
      refresh: async (refreshInput) => {
        const adapter = runtime.adapters.get(refreshInput.providerId);
        if (!adapter) {
          throw new Error(
            `provider ${refreshInput.providerId} has no OAuth client configured to refresh with`,
          );
        }
        const tokens = await adapter.refresh(refreshInput.refreshToken);
        return {
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        };
      },
    },
  };
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
  /** The owner's identity is real, but some admin-only surfaces are reserved for an interactive session and must still know the request came through a token. */
  viaApiToken?: true;
}

interface AuthorizedApiTokenRequest {
  token: ApiTokenRecord;
  action: ApiTokenAction;
  user: WebUserContext;
}

interface PreparedApiTokenRequest {
  tokenId?: string;
  tokenName?: string;
  action: string;
  capability?: ApiTokenCapability;
  target?: { taskId?: string; runId?: string };
  authorized?: AuthorizedApiTokenRequest;
  onBehalfOf?: { userId: string };
  denial?: Error;
  denialReasonCode?: string;
}

const authorizedApiTokenRequests = new WeakMap<
  IncomingMessage,
  AuthorizedApiTokenRequest
>();

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

/** RFC 8628 uses a flat error body; the CLI state machine reads `error`. */
function sendDeviceFlowError(
  response: ServerResponse,
  status: number,
  error: string,
): void {
  sendJson(response, status, { error });
}

/**
 * The base URL the operator's browser should use. The Host header is what the
 * client actually dialed — `input.port` is 0 whenever the server chose its own
 * port, and it knows nothing about a proxy in front.
 *
 * Host is client-controlled, so this is only ever echoed back to that same
 * client for them to open. Never reuse it for a redirect, an email, or
 * anything a third party will follow.
 */
function publicServerUrl(request: IncomingMessage): string {
  const host = requestHeader(request, "host") || "127.0.0.1";
  const forwardedProtocol = requestHeader(request, "x-forwarded-proto");
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}

export interface WebServer {
  url: string;
  readiness?: WebSecurityReadiness;
  closed?: Promise<void>;
  close(): Promise<void>;
}

export interface WebSecurityReadiness {
  readonly schemaVersion: "nitely.web-security-readiness.v1";
  readonly ready: boolean;
  readonly production: boolean;
  readonly auth: {
    readonly mode: WebAuthMode;
    readonly adminConfigured: boolean;
  };
  readonly bind: {
    readonly host: string;
    readonly scope: "loopback" | "non-loopback";
  };
  readonly transport: {
    readonly mode: "loopback-http" | "trusted-reverse-proxy";
    readonly trustedProxy: boolean;
    readonly secureCookie: boolean;
  };
  readonly execution: {
    readonly backend: ExecutionBackendName;
    readonly reason:
      | "trusted-local-default"
      | "required-auth-default"
      | "configured"
      | "unsafe-override";
    readonly unsafeOverride: boolean;
  };
}

type AcceptedRunStatus = "running" | "blocked" | "interrupted" | "completed" | "failed";

interface AcceptedRunMetadata {
  runId: string;
  status: AcceptedRunStatus;
  taskId: string;
  repoId?: string;
  branchName?: string;
}

function runStartResponse<T extends { status?: string }>(run: T): T | (Omit<T, "status"> & { status: "running" }) {
  return run.status === "awaiting-approval"
    ? { ...run, status: "running" }
    : run;
}

function emptySchedulerRunSummary(): SchedulerRunSummary {
  return {
    startedTaskIds: [],
    completedTaskIds: [],
    failedTaskIds: [],
    blockedTaskIds: [],
    cooldownTaskIds: [],
    cooldownUntil: {},
    awaitingApprovalTaskIds: [],
    preflight: {},
    specReadiness: {},
    eligibility: {},
    taskErrors: {},
  };
}

function mergeSchedulerRunSummary(
  target: SchedulerRunSummary,
  source: SchedulerRunSummary,
): SchedulerRunSummary {
  target.startedTaskIds.push(...source.startedTaskIds);
  target.completedTaskIds.push(...source.completedTaskIds);
  target.failedTaskIds.push(...source.failedTaskIds);
  target.blockedTaskIds.push(...source.blockedTaskIds);
  target.cooldownTaskIds?.push(...(source.cooldownTaskIds ?? []));
  target.cooldownUntil = {
    ...(target.cooldownUntil ?? {}),
    ...(source.cooldownUntil ?? {}),
  };
  target.awaitingApprovalTaskIds.push(...source.awaitingApprovalTaskIds);
  target.preflight = {
    ...(target.preflight ?? {}),
    ...(source.preflight ?? {}),
  };
  target.specReadiness = {
    ...(target.specReadiness ?? {}),
    ...(source.specReadiness ?? {}),
  };
  target.eligibility = {
    ...(target.eligibility ?? {}),
    ...(source.eligibility ?? {}),
  };
  target.taskErrors = {
    ...(target.taskErrors ?? {}),
    ...(source.taskErrors ?? {}),
  };
  return target;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(serializeWebJson(value));
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
  response.end(serializeWebJson(value));
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
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof WebRunStartConflictError && error.runId
          ? { runId: error.runId }
          : {}),
      },
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

function errorStatusAndCode(error: unknown): { status: number; code: string } {
  if (isWebError(error)) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof FlowValidationError) {
    return { status: 400, code: "invalid_flow" };
  }
  return { status: 500, code: "internal_error" };
}

function securityAuditActorForUser(user: WebUserContext): SecurityAuditActor {
  return {
    type: user.authMode === "local" ? "local" : "user",
    id: user.id,
    globalRole: user.role,
    ...(user.currentOrganizationId
      ? { organizationId: user.currentOrganizationId }
      : {}),
    ...(user.currentOrganizationRole
      ? { organizationRole: user.currentOrganizationRole }
      : {}),
  };
}

async function appendSecurityAuditBestEffort(
  repoPath: string,
  input: Parameters<typeof appendSecurityAuditEvent>[1],
): Promise<void> {
  try {
    await appendSecurityAuditEvent(repoPath, input);
  } catch (error) {
    console.error(
      `Nitely security audit write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function safeSecurityAuditTarget(
  target: SecurityAuditTarget | undefined,
  credential: string | null | undefined,
): SecurityAuditTarget | undefined {
  if (!target) return undefined;
  if (!target.id) return target;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:@/_-]{0,159}$/.test(target.id) ||
    (credential && redactText(target.id, [credential]) !== target.id)
  ) {
    return { type: target.type };
  }
  return target;
}

function securityAuditDecisionForStatus(
  status: number,
): "allow" | "deny" {
  return status === 401 || status === 403 || status === 404 ? "deny" : "allow";
}

async function auditWebSecurityAction(
  repoPath: string,
  action: WebSecurityAction | null,
  actor: SecurityAuditActor,
  credential: string | null | undefined,
  status: number,
  reasonCode: string,
): Promise<void> {
  if (!action) return;
  const target = safeSecurityAuditTarget(action.target, credential);
  await appendSecurityAuditBestEffort(repoPath, {
    action: action.action,
    permission: action.permission,
    decision: securityAuditDecisionForStatus(status),
    outcome: status < 400 ? "success" : "error",
    httpStatus: status,
    reasonCode,
    actor,
    ...(target ? { target } : {}),
  });
}

function bearerCredential(request: IncomingMessage): string | null | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !/^Bearer(?:\s|$)/i.test(authorization)) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match ? match[1] : null;
}

function safeApiTokenAuditTarget(
  target: ApiTokenAction["target"],
  credential: string,
): ApiTokenAction["target"] {
  if (!target) return undefined;
  const entries = Object.entries(target).filter(
    (entry): entry is ["taskId" | "runId" | "previewSessionId", string] =>
      typeof entry[1] === "string",
  );
  if (entries.length === 0) return undefined;
  for (const [kind, value] of entries) {
    const pattern =
      kind === "taskId"
        ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
        : kind === "runId"
          ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/
          : /^pvs_[a-f0-9]{16}$/;
    if (!pattern.test(value) || redactText(value, [credential]) !== value) {
      return undefined;
    }
  }
  return Object.fromEntries(entries);
}

async function prepareApiTokenRequest(
  request: IncomingMessage,
  repoPath: string,
  authMode: WebAuthMode,
): Promise<PreparedApiTokenRequest | undefined> {
  const credential = bearerCredential(request);
  if (credential === undefined) return undefined;

  const url = new URL(request.url ?? "/", "http://localhost");
  const mapped = apiTokenActionForRequest(request.method, url.pathname);
  const common = {
    action: mapped?.action ?? "api.unsupported",
    ...(mapped ? { capability: mapped.capability } : {}),
  };
  if (!credential) {
    return {
      ...common,
      denial: new WebUnauthorizedError("invalid API token"),
      denialReasonCode: "invalid_token",
    };
  }

  const tokenId = parseApiTokenId(credential);
  const token = await authenticateApiToken(repoPath, credential);
  if (!token) {
    return {
      ...common,
      ...(tokenId ? { tokenId } : {}),
      denial: new WebUnauthorizedError("invalid API token"),
      denialReasonCode: "invalid_token",
    };
  }
  const target = safeApiTokenAuditTarget(mapped?.target, credential);
  const authenticatedCommon = {
    ...common,
    ...(target ? { target } : {}),
  };
  if (!mapped) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebCapabilityDeniedError(
        "API tokens cannot access this endpoint",
      ),
      denialReasonCode: "endpoint_not_allowed",
    };
  }
  if (!token.capabilities.includes(mapped.capability)) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebCapabilityDeniedError(
        `API token capability denied: ${mapped.capability} is required`,
      ),
      denialReasonCode: "capability_denied",
    };
  }

  if (!token.ownerUserId) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebUnauthorizedError(
        "API token has no owner; re-issue it with nitely mcp token create --owner <user>",
      ),
      denialReasonCode: "token_unowned",
    };
  }
  const owner = await getPublicUser(repoPath, token.ownerUserId);
  if (!owner) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebUnauthorizedError("API token owner no longer exists"),
      denialReasonCode: "owner_missing",
    };
  }
  // The token is a credential for its owner, not a fourth kind of principal:
  // everything downstream (organization checks, provider store selection,
  // audit) sees the owner exactly as a browser session of theirs would --
  // including `x-nitely-organization-id`, so an owner with several
  // memberships can select one from the CLI the way the console does.
  const requestedOrganizationId = request.headers["x-nitely-organization-id"];
  let user: WebUserContext;
  try {
    user = {
      ...publicContext(
        owner,
        authMode,
        typeof requestedOrganizationId === "string"
          ? requestedOrganizationId
          : undefined,
      ),
      viaApiToken: true,
    };
  } catch (error) {
    if (!(error instanceof WebForbiddenError)) throw error;
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      onBehalfOf: { userId: owner.id },
      denial: error,
      denialReasonCode: "organization_denied",
    };
  }
  const authorized: AuthorizedApiTokenRequest = {
    token,
    action: mapped,
    user,
  };
  return {
    ...authenticatedCommon,
    tokenId: token.id,
    tokenName: token.name,
    onBehalfOf: { userId: owner.id },
    authorized,
  };
}

async function auditApiTokenRequest(
  repoPath: string,
  prepared: PreparedApiTokenRequest,
  input: {
    decision: "allow" | "deny";
    outcome: "success" | "error";
    httpStatus: number;
    reasonCode: string;
  },
): Promise<void> {
  try {
    await appendApiTokenRequestAudit(repoPath, {
      ...(prepared.tokenId ? { tokenId: prepared.tokenId } : {}),
      ...(prepared.tokenName ? { tokenName: prepared.tokenName } : {}),
      action: prepared.action,
      ...(prepared.capability ? { capability: prepared.capability } : {}),
      ...(prepared.target ? { target: prepared.target } : {}),
      ...(prepared.onBehalfOf ? { onBehalfOf: prepared.onBehalfOf } : {}),
      ...input,
    });
  } catch (error) {
    console.error(
      `Nitely API token audit write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readRequestBody(
  request: IncomingMessage,
  options: { tooLargeError?: () => Error } = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumGitHubWebhookBodyBytes) {
      throw (
        options.tooLargeError?.() ??
        new WebInputError("request body is too large")
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);
  if (body.byteLength === 0) return {};
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new WebInputError("request body must be valid JSON");
  }
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebInputError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readSchedulerRunRequest(
  request: IncomingMessage,
): Promise<{ maxConcurrentTasks?: number; usageLimitCooldownMs?: number }> {
  const body = requireObject(await readRequestJson(request));
  const maxConcurrentTasks = body.maxConcurrentTasks;
  const usageLimitCooldownMs = body.usageLimitCooldownMs;
  if (maxConcurrentTasks === undefined && usageLimitCooldownMs === undefined) return {};
  if (
    maxConcurrentTasks !== undefined &&
    (typeof maxConcurrentTasks !== "number" || !Number.isInteger(maxConcurrentTasks))
  ) {
    throw new WebInputError(
      `maxConcurrentTasks must be an integer between 1 and ${MAX_SCHEDULER_CONCURRENCY}`,
    );
  }
  let resolvedMaxConcurrentTasks: number | undefined;
  try {
    resolvedMaxConcurrentTasks = maxConcurrentTasks === undefined
      ? undefined
      : resolveMaxConcurrentTasks(maxConcurrentTasks);
  } catch (error) {
    throw new WebInputError(error instanceof Error ? error.message : String(error));
  }
  if (
    usageLimitCooldownMs !== undefined &&
    (typeof usageLimitCooldownMs !== "number" ||
      !Number.isInteger(usageLimitCooldownMs) ||
      usageLimitCooldownMs < 1_000 ||
      usageLimitCooldownMs > 86_400_000)
  ) {
    throw new WebInputError("usageLimitCooldownMs must be an integer between 1000 and 86400000");
  }
  return {
    ...(resolvedMaxConcurrentTasks !== undefined
      ? { maxConcurrentTasks: resolvedMaxConcurrentTasks }
      : {}),
    ...(usageLimitCooldownMs !== undefined ? { usageLimitCooldownMs } : {}),
  };
}

function factoryCandidateInputFromJson(value: unknown): {
  repoId: string;
  title: string;
  source: { type: "github-issue" | "explicit"; identity: string; uri?: string; snapshot?: unknown };
  workItemId?: string;
  issueUrl?: string;
  labels?: string[];
  assignees?: string[];
  state?: string;
  workItemType?: string;
  estimatedChangeSize?: number;
  pathFamilies?: string[];
  riskClass?: "low" | "medium" | "high" | "critical";
  planning?: { specApproved?: boolean; techDesignApproved?: boolean };
} {
  const body = requireObject(value);
  const repoId = typeof body.repoId === "string" && body.repoId.trim() ? body.repoId.trim() : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
  const source = requireObject(body.source);
  const sourceType = source.type === "github-issue" || source.type === "explicit" ? source.type : undefined;
  const identity = typeof source.identity === "string" && source.identity.trim() ? source.identity.trim() : "";
  if (!repoId || !title || !sourceType || !identity) throw new WebInputError("repoId, title, and source identity are required");
  const optional = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new WebInputError(`${field} must be a non-empty string`);
    return value.trim();
  };
  const optionalArray = (field: string) => optionalStringArrayFromJson(body[field], field);
  const estimatedChangeSize = body.estimatedChangeSize;
  if (estimatedChangeSize !== undefined && (typeof estimatedChangeSize !== "number" || !Number.isFinite(estimatedChangeSize) || estimatedChangeSize < 0)) {
    throw new WebInputError("estimatedChangeSize must be a non-negative number");
  }
  const riskClass = body.riskClass;
  if (riskClass !== undefined && riskClass !== "low" && riskClass !== "medium" && riskClass !== "high" && riskClass !== "critical") {
    throw new WebInputError("riskClass is invalid");
  }
  const planning = body.planning === undefined ? undefined : requireObject(body.planning);
  if (planning && (planning.specApproved !== undefined && typeof planning.specApproved !== "boolean" || planning.techDesignApproved !== undefined && typeof planning.techDesignApproved !== "boolean")) {
    throw new WebInputError("planning approval fields must be boolean");
  }
  const specApproved = planning?.specApproved;
  const techDesignApproved = planning?.techDesignApproved;
  return {
    repoId,
    title,
    source: {
      type: sourceType,
      identity,
      ...(typeof source.uri === "string" && source.uri.trim() ? { uri: source.uri.trim() } : {}),
      ...(source.snapshot !== undefined ? { snapshot: source.snapshot } : {}),
    },
    ...(optional("workItemId") ? { workItemId: optional("workItemId") } : {}),
    ...(optional("issueUrl") ? { issueUrl: optional("issueUrl") } : {}),
    ...(optionalArray("labels") ? { labels: optionalArray("labels") } : {}),
    ...(optionalArray("assignees") ? { assignees: optionalArray("assignees") } : {}),
    ...(optional("state") ? { state: optional("state") } : {}),
    ...(optional("workItemType") ? { workItemType: optional("workItemType") } : {}),
    ...(estimatedChangeSize !== undefined ? { estimatedChangeSize } : {}),
    ...(optionalArray("pathFamilies") ? { pathFamilies: optionalArray("pathFamilies") } : {}),
    ...(riskClass !== undefined ? { riskClass } : {}),
    ...(planning ? { planning: { ...(typeof specApproved === "boolean" ? { specApproved } : {}), ...(typeof techDesignApproved === "boolean" ? { techDesignApproved } : {}) } } : {}),
  };
}

function optionalStringArrayFromJson(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new WebInputError(`${field} must be an array of strings`);
  }
  if (!value.every((item) => typeof item === "string")) {
    throw new WebInputError(`${field} must be an array of strings`);
  }
  return value;
}

function contextKnowledgeCategoryFromJson(
  value: unknown,
): ContextKnowledgeCategory {
  if (
    typeof value === "string" &&
    CONTEXT_KNOWLEDGE_CATEGORIES.includes(value as ContextKnowledgeCategory)
  ) {
    return value as ContextKnowledgeCategory;
  }
  throw new WebInputError("category must be a valid context-kg category");
}

function contextKnowledgeStatusFromJson(
  value: unknown,
): ContextKnowledgeStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "approved" || value === "proposed" || value === "rejected") {
    return value;
  }
  throw new WebInputError("status must be approved, proposed, or rejected");
}

function contextKnowledgeSourceFromJson(
  value: unknown,
): ContextKnowledgeSource | undefined {
  if (value === undefined) return undefined;
  const record = requireObject(value);
  const type = record.type;
  if (
    type !== "operator" &&
    type !== "reflection" &&
    type !== "review" &&
    type !== "run" &&
    type !== "import"
  ) {
    throw new WebInputError("source.type must be a valid context-kg source type");
  }
  return {
    type,
    ...(typeof record.uri === "string" ? { uri: record.uri } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
  };
}

function createContextKnowledgeInputFromJson(value: unknown): {
  repoId?: string;
  entry: CreateContextKnowledgeEntryInput;
} {
  const record = requireObject(value);
  const status = contextKnowledgeStatusFromJson(record.status);
  const tags = optionalStringArrayFromJson(record.tags, "tags");
  const keywords = optionalStringArrayFromJson(record.keywords, "keywords");
  const source = contextKnowledgeSourceFromJson(record.source);
  const entry: CreateContextKnowledgeEntryInput = {
    category: contextKnowledgeCategoryFromJson(record.category),
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
  };
  if (status !== undefined) entry.status = status;
  if (tags !== undefined) entry.tags = tags;
  if (keywords !== undefined) entry.keywords = keywords;
  if (source !== undefined) entry.source = source;
  return {
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    entry,
  };
}

function updateContextKnowledgeInputFromJson(value: unknown): {
  repoId?: string;
  patch: UpdateContextKnowledgeEntryInput;
} {
  const record = requireObject(value);
  const patch: UpdateContextKnowledgeEntryInput = {};
  if (record.category !== undefined) {
    patch.category = contextKnowledgeCategoryFromJson(record.category);
  }
  if (typeof record.title === "string") patch.title = record.title;
  if (typeof record.body === "string") patch.body = record.body;
  const status = contextKnowledgeStatusFromJson(record.status);
  if (status !== undefined) patch.status = status;
  const tags = optionalStringArrayFromJson(record.tags, "tags");
  if (tags !== undefined) patch.tags = tags;
  const keywords = optionalStringArrayFromJson(record.keywords, "keywords");
  if (keywords !== undefined) patch.keywords = keywords;
  const source = contextKnowledgeSourceFromJson(record.source);
  if (source !== undefined) patch.source = source;
  return {
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    patch,
  };
}

function contextKnowledgeDraftSummary(entry: ContextKnowledgeEntry) {
  return {
    id: entry.id,
    category: entry.category,
    title: entry.title,
  };
}

function draftSpecContextKnowledge(entry: ContextKnowledgeEntry) {
  return {
    id: entry.id,
    category: entry.category,
    title: entry.title,
    body: entry.body,
    version: entry.version,
    tags: entry.tags,
  };
}

async function selectDraftSpecContextKnowledge(input: {
  repoPath: string;
  source: DraftSpecSource;
  flowPath?: string;
}): Promise<ContextKnowledgeEntry[]> {
  return await selectContextKnowledgeEntries({
    repoPath: input.repoPath,
    query: [
      input.source.title,
      input.source.body,
      input.source.uri,
      input.source.guidance,
      input.flowPath,
    ].filter((item): item is string => typeof item === "string" && item.trim() !== ""),
  });
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

function parseOptionalPriority(value: unknown): TaskPriority | undefined {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3"
    ? value
    : undefined;
}

function optionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function dashboardFiltersFromUrl(url: URL): DashboardFilterSelection {
  const filters: DashboardFilterSelection = {};
  for (const key of ["repo", "flow", "status", "priority", "owner", "window", "start", "end"] as const) {
    const value = optionalSearchParam(url, key);
    if (value) {
      filters[key] = value;
    }
  }
  return filters;
}

function parseOptionalDependencyIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((id): id is string => typeof id === "string");
}

function parseOptionalSuggestedDependencies(
  value: unknown,
): SuggestedDependency[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((suggestion): suggestion is SuggestedDependency => {
    if (
      !suggestion ||
      typeof suggestion !== "object" ||
      Array.isArray(suggestion)
    ) {
      return false;
    }
    const record = suggestion as Record<string, unknown>;
    return (
      typeof record.dependsOn === "string" &&
      typeof record.reason === "string" &&
      typeof record.confidence === "number" &&
      typeof record.source === "string" &&
      typeof record.suggestedAt === "string"
    );
  });
}

function authModeForInput(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): WebAuthMode {
  const env = input.authEnv ?? process.env;
  const raw = (input.authMode ?? env.NITELY_WEB_AUTH ?? "local").trim();
  if (raw === "required" || raw === "local") {
    return raw;
  }
  throw new Error("NITELY_WEB_AUTH must be local or required");
}

export function webExecutionBackendPolicy(input: {
  authMode: WebAuthMode;
  configuredBackend?: string;
  allowUnsafeLocal?: boolean;
}): WebSecurityReadiness["execution"] {
  const configuredBackend = input.configuredBackend?.trim();
  const backend = normalizeExecutionBackendName(
    configuredBackend || (input.authMode === "required" ? "oci" : "local"),
  );
  if (input.authMode === "required" && backend !== "oci" && !input.allowUnsafeLocal) {
    throw new Error(
      `required-auth Web execution requires OCI; ${backend} is only available with NITELY_ALLOW_UNSAFE_LOCAL_EXECUTION=true`,
    );
  }
  return {
    backend,
    reason:
      backend !== "oci" && input.authMode === "required"
        ? "unsafe-override"
        : configuredBackend
          ? "configured"
          : input.authMode === "required"
            ? "required-auth-default"
            : "trusted-local-default",
    unsafeOverride: backend !== "oci" && input.authMode === "required",
  };
}

function webExecutionBackendPolicyForInput(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  authMode: WebAuthMode,
): WebSecurityReadiness["execution"] {
  const configuredEnv = input.providerEnv ?? input.authEnv ?? process.env;
  const securityEnv =
    input.providerEnv || input.authEnv
      ? { ...input.providerEnv, ...input.authEnv }
      : process.env;
  return webExecutionBackendPolicy({
    authMode,
    configuredBackend: configuredEnv.NITELY_EXECUTION_BACKEND,
    allowUnsafeLocal: strictBooleanEnvironment(
      securityEnv,
      "NITELY_ALLOW_UNSAFE_LOCAL_EXECUTION",
    ),
  });
}

function strictBooleanEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`${name} must be a boolean (true/false or 1/0)`);
}

function unbracketHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isLoopbackBindHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") !== trimmed.endsWith("]")) return false;
  const normalized = unbracketHost(trimmed);
  if (normalized === "localhost" || normalized === "localhost.") return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  if (family === 6) {
    try {
      return new URL(`http://[${normalized}]/`).hostname === "[::1]";
    } catch {
      return false;
    }
  }
  return false;
}

export function webListenerUrl(host: string, port: number): string {
  const normalized = unbracketHost(host);
  const urlHost = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return `http://${urlHost}:${port}`;
}

interface WebStartupSecurityPolicy {
  authMode: WebAuthMode;
  production: boolean;
  bindScope: "loopback" | "non-loopback";
  trustedProxy: boolean;
  secureCookie: boolean;
  execution: WebSecurityReadiness["execution"];
}

function webStartupSecurityPolicy(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): WebStartupSecurityPolicy {
  const env = input.authEnv ?? process.env;
  const authMode = authModeForInput(input);
  const execution = webExecutionBackendPolicyForInput(input, authMode);
  const production = env.NODE_ENV?.trim().toLowerCase() === "production";
  const bindScope = isLoopbackBindHost(input.host)
    ? "loopback"
    : "non-loopback";
  const trustedProxy = strictBooleanEnvironment(
    env,
    "NITELY_WEB_TRUSTED_PROXY",
  );
  const secureCookie = strictBooleanEnvironment(
    env,
    "NITELY_WEB_SECURE_COOKIE",
  );
  const insecureTestCookie = strictBooleanEnvironment(
    env,
    "NITELY_WEB_INSECURE_TEST_COOKIE",
  );

  if (production && authMode !== "required") {
    throw new Error(
      "production Web startup requires authentication; set NITELY_WEB_AUTH=required or pass --auth required",
    );
  }
  if (bindScope === "non-loopback" && authMode !== "required") {
    throw new Error(
      "non-loopback Web startup requires authentication mode required",
    );
  }
  if (bindScope === "non-loopback" && !trustedProxy) {
    throw new Error(
      "non-loopback Web startup requires an explicit trusted reverse-proxy boundary; set NITELY_WEB_TRUSTED_PROXY=true",
    );
  }
  if (trustedProxy && authMode !== "required") {
    throw new Error(
      "trusted reverse-proxy mode requires authentication mode required",
    );
  }
  if (trustedProxy && !secureCookie && !insecureTestCookie) {
    throw new Error(
      "trusted reverse-proxy mode requires secure session cookies or an explicit insecure test cookie escape hatch; set NITELY_WEB_SECURE_COOKIE=true or NITELY_WEB_INSECURE_TEST_COOKIE=true",
    );
  }

  return {
    authMode,
    production,
    bindScope,
    trustedProxy,
    secureCookie,
    execution,
  };
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

function secureCookieForInput(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): boolean {
  return strictBooleanEnvironment(
    input.authEnv ?? process.env,
    "NITELY_WEB_SECURE_COOKIE",
  );
}

function sessionCookie(sessionId: string, secure: boolean): string {
  return `nitely_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${
    secure ? "; Secure" : ""
  }`;
}

function clearSessionCookie(secure: boolean): string {
  return `nitely_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
    secure ? "; Secure" : ""
  }`;
}

async function resolveUserContext(
  request: IncomingMessage,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
): Promise<WebUserContext | null> {
  const apiTokenRequest = authorizedApiTokenRequests.get(request);
  if (apiTokenRequest) {
    return apiTokenRequest.user;
  }
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

async function securityAuditActorForRequest(
  request: IncomingMessage,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  repoPath: string,
  preparedApiToken?: PreparedApiTokenRequest,
): Promise<SecurityAuditActor> {
  if (preparedApiToken) {
    if (preparedApiToken.tokenId && preparedApiToken.tokenName) {
      return { type: "api-token", id: preparedApiToken.tokenId };
    }
    return { type: "anonymous" };
  }
  const authMode = authModeForInput(input);
  if (authMode === "local") {
    return { type: "local", id: "local", globalRole: "admin" };
  }
  const sessionId = parseCookies(request.headers.cookie).nitely_session;
  if (!sessionId) return { type: "anonymous" };
  const user = await readSessionUser(repoPath, sessionId);
  if (!user) return { type: "anonymous" };
  const requestedOrganizationId = request.headers["x-nitely-organization-id"];
  const selected =
    typeof requestedOrganizationId === "string"
      ? (user.memberships ?? []).find(
          (membership) => membership.organizationId === requestedOrganizationId,
        )
      : undefined;
  const organizationId =
    typeof requestedOrganizationId === "string"
      ? selected?.organizationId
      : user.currentOrganizationId;
  const organizationRole =
    typeof requestedOrganizationId === "string"
      ? selected?.role
      : user.currentOrganizationRole;
  return {
    type: "user",
    id: user.id,
    globalRole: user.role,
    ...(organizationId ? { organizationId } : {}),
    ...(organizationRole ? { organizationRole } : {}),
  };
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

function repositoryVisibleToUser(
  repository: WebRepository,
  user: WebUserContext,
): boolean {
  if (user.authMode === "local" || user.role === "admin") {
    return true;
  }
  if (repository.home === true) {
    return true;
  }
  return recordVisibleToUser(repository, user);
}

function visibleRepositories(
  repositories: WebRepository[],
  user: WebUserContext,
): WebRepository[] {
  return repositories.filter((repository) =>
    repositoryVisibleToUser(repository, user),
  );
}

interface WebScheduleRecord extends ScheduleRecord {
  repoId: string;
  repoName: string;
  /** The most recent decision of any kind, with live task/run lineage. */
  lastOccurrence?: ScheduleOccurrenceWithLineage;
  /** The most recent occurrence that produced a task, for the linked task/run. */
  lastMaterializedOccurrence?: ScheduleOccurrenceWithLineage;
}

async function withScheduleRepository(
  schedule: ScheduleRecord,
  repository: WebRepository,
): Promise<WebScheduleRecord> {
  const history = await listScheduleOccurrencesWithLineage(repository.path, {
    scheduleId: schedule.id,
  });
  const lastOccurrence = history.at(-1);
  const lastMaterializedOccurrence = [...history]
    .reverse()
    .find((occurrence) => occurrence.status === "materialized");
  return {
    ...schedule,
    repoId: repository.id,
    repoName: repository.name,
    ...(lastOccurrence ? { lastOccurrence } : {}),
    ...(lastMaterializedOccurrence ? { lastMaterializedOccurrence } : {}),
  };
}

function scheduleMisfireFromJson(value: unknown): CreateScheduleInput["misfire"] {
  const record = requireObject(value);
  return {
    policy: record.policy as NonNullable<CreateScheduleInput["misfire"]>["policy"],
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    ...(typeof record.graceMs === "number" ? { graceMs: record.graceMs } : {}),
  };
}

async function findScheduleRepository(
  repositories: WebRepository[],
  user: WebUserContext,
  scheduleId: string,
): Promise<{ repository: WebRepository; schedule: ScheduleRecord }> {
  for (const repository of visibleRepositories(repositories, user)) {
    if (repository.synthetic === true) continue;
    const schedule = (await listSchedules(repository.path)).find((s) => s.id === scheduleId);
    if (schedule) return { repository, schedule };
  }
  throw new WebNotFoundError("schedule not found");
}

function scheduleInputFromJson(value: unknown): CreateScheduleInput & { repoId?: string } {
  const record = requireObject(value);
  const template = requireObject(record.template);
  const trigger = requireObject(record.trigger);
  return {
    name: typeof record.name === "string" ? record.name : "",
    trigger: trigger as unknown as CreateScheduleInput["trigger"],
    timezone: typeof record.timezone === "string" ? record.timezone : "",
    template: template as unknown as CreateScheduleInput["template"],
    ...(record.admission === "auto" || record.admission === "review"
      ? { admission: record.admission }
      : {}),
    ...(record.misfire !== undefined ? { misfire: scheduleMisfireFromJson(record.misfire) } : {}),
    ...(typeof record.overlap === "string"
      ? { overlap: record.overlap as CreateScheduleInput["overlap"] }
      : {}),
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.repoId === "string" && record.repoId.trim()
      ? { repoId: record.repoId.trim() }
      : {}),
  };
}

function schedulePatchFromJson(value: unknown): UpdateScheduleInput {
  const record = requireObject(value);
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(record.trigger !== undefined
      ? { trigger: requireObject(record.trigger) as unknown as UpdateScheduleInput["trigger"] }
      : {}),
    ...(typeof record.timezone === "string" ? { timezone: record.timezone } : {}),
    ...(record.template !== undefined
      ? { template: requireObject(record.template) as unknown as UpdateScheduleInput["template"] }
      : {}),
    ...(record.admission === "auto" || record.admission === "review"
      ? { admission: record.admission }
      : {}),
    ...(record.misfire !== undefined ? { misfire: scheduleMisfireFromJson(record.misfire) } : {}),
    ...(typeof record.overlap === "string"
      ? { overlap: record.overlap as UpdateScheduleInput["overlap"] }
      : {}),
  };
}

async function withScheduleErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new WebInputError(error.message);
    if (error instanceof ScheduleNotFoundError) throw new WebNotFoundError("schedule not found");
    throw error;
  }
}

/**
 * Schedules decide when work is created. They are stored per repository and
 * addressed by id across the caller's visible repositories; mutations need
 * the scheduler permission because each firing admits work unattended.
 */
async function handleScheduleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  input: RuntimeStartWebServerInput,
  homeRepoPath: string,
  repositories: WebRepository[],
): Promise<boolean> {
  const user = await requireUserContext(request, input, homeRepoPath);
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    const requestedRepoId = url.searchParams.get("repoId") ?? undefined;
    const schedules = (
      await Promise.all(
        visibleRepositories(repositories, user)
          .filter((repository) =>
            repository.synthetic !== true && (!requestedRepoId || repository.id === requestedRepoId),
          )
          .map(async (repository) =>
            await Promise.all(
              (await listSchedules(repository.path)).map((schedule) =>
                withScheduleRepository(schedule, repository),
              ),
            ),
          ),
      )
    ).flat();
    sendJson(response, 200, { schedules });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    requireAdminAccess(user, "scheduler:run");
    const parsed = scheduleInputFromJson(await readRequestJson(request));
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    const { repoId: _repoId, ...scheduleInput } = parsed;
    const schedule = await withScheduleErrors(() =>
      createSchedule(repository.path, {
        ...scheduleInput,
        ...(user.authMode === "required"
          ? { createdBy: user.id, ownerId: user.id }
          : {}),
        ...(user.currentOrganizationId ? { organizationId: user.currentOrganizationId } : {}),
      }),
    );
    sendJson(response, 201, { schedule: await withScheduleRepository(schedule, repository) });
    return true;
  }
  const match = /^\/api\/schedules\/([^/]+)(?:\/(pause|resume|run-now))?$/.exec(url.pathname);
  if (!match) return false;
  const scheduleId = decodeURIComponent(match[1]);
  const action = match[2];
  const { repository } = await findScheduleRepository(repositories, user, scheduleId);
  if (request.method === "GET" && !action) {
    const [schedule, occurrences] = await Promise.all([
      withScheduleErrors(() => getSchedule(repository.path, scheduleId)),
      listScheduleOccurrencesWithLineage(repository.path, { scheduleId }),
    ]);
    sendJson(response, 200, {
      schedule: await withScheduleRepository(schedule, repository),
      occurrences: [...occurrences].reverse(),
    });
    return true;
  }
  requireAdminAccess(user, "scheduler:run");
  if (request.method === "PATCH" && !action) {
    const patch = schedulePatchFromJson(await readRequestJson(request));
    const schedule = await withScheduleErrors(() =>
      updateSchedule(repository.path, scheduleId, patch),
    );
    sendJson(response, 200, { schedule: await withScheduleRepository(schedule, repository) });
    return true;
  }
  if (request.method === "DELETE" && !action) {
    await withScheduleErrors(() => deleteSchedule(repository.path, scheduleId));
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (request.method === "POST" && (action === "pause" || action === "resume")) {
    const schedule = await withScheduleErrors(() =>
      setScheduleEnabled(repository.path, scheduleId, action === "resume"),
    );
    sendJson(response, 200, { schedule: await withScheduleRepository(schedule, repository) });
    return true;
  }
  if (request.method === "POST" && action === "run-now") {
    const occurrence = await withScheduleErrors(() =>
      materializeScheduleNow({ repoPath: repository.path, repoId: repository.id, scheduleId }),
    );
    sendJson(response, 200, { occurrence });
    return true;
  }
  return false;
}

function requireVisibleRepository(
  repositories: WebRepository[],
  id: string | undefined,
  user: WebUserContext,
): WebRepository {
  const repository = repositoryById(repositories, id);
  if (!repositoryVisibleToUser(repository, user)) {
    throw new WebNotFoundError("repository not found");
  }
  return repository;
}

function requireRepositoryForOrganization(
  repositories: WebRepository[],
  id: string | undefined,
  user: WebUserContext,
  organizationId: string | undefined,
): WebRepository {
  const repository = requireVisibleRepository(repositories, id, user);
  if (
    organizationId &&
    repository.organizationId &&
    repository.organizationId !== organizationId
  ) {
    throw new WebNotFoundError("repository not found");
  }
  return repository;
}

function requireAdminAccess(
  user: WebUserContext,
  permission: WebPermission,
): void {
  if (
    webPermissionAllowed(
      {
        authMode: user.authMode,
        globalRole: user.role,
        organizationRole: user.currentOrganizationRole,
      },
      permission,
    )
  ) {
    return;
  }
  throw new WebForbiddenError(`${permission} permission required`);
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
  permission: WebPermission = "tasks:write",
): void {
  const role = (user.memberships ?? []).find(
    (membership) => membership.organizationId === organizationId,
  )?.role;
  if (
    webPermissionAllowed(
      {
        authMode: user.authMode,
        globalRole: user.role,
        organizationRole: role,
      },
      permission,
    )
  ) {
    return;
  }
  throw new WebForbiddenError(`${permission} permission required`);
}

function requireWriteAccessToRecord(
  user: WebUserContext,
  record: { ownerId?: string; organizationId?: string },
  permission: WebPermission = "tasks:write",
): void {
  if (user.authMode === "local" || user.role === "admin") {
    return;
  }
  if (record.organizationId) {
    requireWriteAccessToOrganization(user, record.organizationId, permission);
    return;
  }
  if (record.ownerId === user.id) {
    return;
  }
  throw new WebForbiddenError("record write access required");
}

function currentWritableOrganizationId(
  user: WebUserContext,
  permission: WebPermission = "tasks:write",
): string | undefined {
  if (user.authMode === "local" || user.role === "admin") {
    return user.currentOrganizationId;
  }
  requireWriteAccessToOrganization(user, user.currentOrganizationId, permission);
  return user.currentOrganizationId;
}

function requireCurrentOrganizationPermission(
  user: WebUserContext,
  permission: WebPermission,
): void {
  if (user.authMode === "local" || user.role === "admin") return;
  const role = user.currentOrganizationId
    ? (user.memberships ?? []).find(
        (membership) => membership.organizationId === user.currentOrganizationId,
      )?.role
    : user.currentOrganizationRole;
  if (organizationRoleHasPermission(role, permission)) return;
  throw new WebForbiddenError(`${permission} permission required`);
}

function taskInputFromJson(value: unknown): {
  title: string;
  spec: string;
  techDesign: string;
  planningStatus?: "draft" | "ready";
  repoId?: string;
  issueUrl?: string;
  flowPath?: string;
  templateId?: string;
} {
  const record = requireObject(value);
  if (
    record.planningStatus !== undefined &&
    record.planningStatus !== "draft" &&
    record.planningStatus !== "ready"
  ) {
    throw new WebInputError("planningStatus must be draft or ready");
  }
  return {
    title: typeof record.title === "string" ? record.title : "",
    spec: typeof record.spec === "string" ? record.spec : "",
    techDesign: typeof record.techDesign === "string" ? record.techDesign : "",
    ...(record.planningStatus === "draft" || record.planningStatus === "ready"
      ? { planningStatus: record.planningStatus }
      : {}),
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    issueUrl: typeof record.issueUrl === "string" ? record.issueUrl : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
    templateId: typeof record.templateId === "string" ? record.templateId : undefined,
  };
}

function previewViewportFromJson(value: unknown): PreviewViewport | undefined {
  if (value === undefined) return undefined;
  const record = requireObject(value);
  const preset = typeof record.preset === "string" ? record.preset.trim() : "";
  if (preset) return { preset, width: 0, height: 0 };
  const width = typeof record.width === "number" ? record.width : Number.NaN;
  const height = typeof record.height === "number" ? record.height : Number.NaN;
  return {
    width,
    height,
    ...(typeof record.deviceScaleFactor === "number"
      ? { deviceScaleFactor: record.deviceScaleFactor }
      : {}),
    ...(typeof record.isMobile === "boolean" ? { isMobile: record.isMobile } : {}),
  };
}

function previewStartInputFromJson(value: unknown): {
  repoId?: string;
  commandId: string;
  workItemId?: string;
  runId?: string;
  targetUrl?: string;
  route?: string;
  viewport?: PreviewViewport;
} {
  const record = requireObject(value);
  return {
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    commandId: requiredTrimmedString(record, "commandId"),
    workItemId:
      typeof record.workItemId === "string" && record.workItemId.trim()
        ? record.workItemId.trim()
        : undefined,
    runId:
      typeof record.runId === "string" && record.runId.trim()
        ? record.runId.trim()
        : undefined,
    targetUrl:
      typeof record.targetUrl === "string" && record.targetUrl.trim()
        ? record.targetUrl.trim()
        : undefined,
    route:
      typeof record.route === "string" && record.route.trim()
        ? record.route.trim()
        : undefined,
    viewport: previewViewportFromJson(record.viewport),
  };
}

function previewAttachmentInputFromJson(value: unknown): {
  screenshotId: string;
  runId?: string;
  workItemId?: string;
  note?: string;
} {
  const record = requireObject(value);
  return {
    screenshotId: requiredTrimmedString(record, "screenshotId"),
    runId:
      typeof record.runId === "string" && record.runId.trim()
        ? record.runId.trim()
        : undefined,
    workItemId:
      typeof record.workItemId === "string" && record.workItemId.trim()
        ? record.workItemId.trim()
        : undefined,
    note:
      typeof record.note === "string" && record.note.trim()
        ? record.note.trim()
        : undefined,
  };
}

function visualComparisonImageInputFromJson(
  value: unknown,
  field: string,
): VisualComparisonImageInput {
  const record = requireObject(value);
  const artifactId =
    typeof record.artifactId === "string" && record.artifactId.trim()
      ? record.artifactId.trim()
      : undefined;
  const artifactProducer =
    typeof record.artifactProducer === "string" && record.artifactProducer.trim()
      ? record.artifactProducer.trim()
      : undefined;
  const path =
    typeof record.path === "string" && record.path.trim()
      ? record.path.trim()
      : undefined;
  if (!artifactId && !path) {
    throw new WebInputError(`${field} requires artifactId or path`);
  }
  return {
    ...(artifactId ? { artifactId } : {}),
    ...(artifactProducer ? { artifactProducer } : {}),
    ...(path ? { path } : {}),
    ...(typeof record.label === "string" && record.label.trim()
      ? { label: record.label.trim() }
      : {}),
    ...(typeof record.sourceUri === "string" && record.sourceUri.trim()
      ? { sourceUri: record.sourceUri.trim() }
      : {}),
    ...(typeof record.mediaType === "string" && record.mediaType.trim()
      ? { mediaType: record.mediaType.trim() }
      : {}),
  };
}

function optionalUnitIntervalFromJson(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new WebInputError(`${field} must be a number between 0 and 1`);
  }
  return value;
}

function optionalNonNegativeIntegerFromJson(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WebInputError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function previewCompareInputFromJson(value: unknown): {
  reference: VisualComparisonImageInput;
  implementation?: VisualComparisonImageInput;
  screenshotId?: string;
  runId?: string;
  workItemId?: string;
  comparisonId?: string;
  note?: string;
  route?: string;
  revision?: string;
  pixelmatchThreshold?: number;
  includeAntiAliased?: boolean;
  allowedChangedPixelCount?: number;
  allowedChangedPixelRatio?: number;
  overlayOpacity?: number;
} {
  const record = requireObject(value);
  const screenshotId =
    typeof record.screenshotId === "string" && record.screenshotId.trim()
      ? record.screenshotId.trim()
      : undefined;
  const implementation = record.implementation === undefined
    ? undefined
    : visualComparisonImageInputFromJson(record.implementation, "implementation");
  if (screenshotId && implementation) {
    throw new WebInputError("provide screenshotId or implementation, not both");
  }
  if (!screenshotId && !implementation) {
    throw new WebInputError("preview comparison requires screenshotId or implementation");
  }
  return {
    reference: visualComparisonImageInputFromJson(record.reference, "reference"),
    ...(implementation ? { implementation } : {}),
    ...(screenshotId ? { screenshotId } : {}),
    ...(typeof record.runId === "string" && record.runId.trim()
      ? { runId: record.runId.trim() }
      : {}),
    ...(typeof record.workItemId === "string" && record.workItemId.trim()
      ? { workItemId: record.workItemId.trim() }
      : {}),
    ...(typeof record.comparisonId === "string" && record.comparisonId.trim()
      ? { comparisonId: record.comparisonId.trim() }
      : {}),
    ...(typeof record.note === "string" && record.note.trim()
      ? { note: record.note.trim() }
      : {}),
    ...(typeof record.route === "string" && record.route.trim()
      ? { route: record.route.trim() }
      : {}),
    ...(typeof record.revision === "string" && record.revision.trim()
      ? { revision: record.revision.trim() }
      : {}),
    ...(record.pixelmatchThreshold !== undefined
      ? {
        pixelmatchThreshold: optionalUnitIntervalFromJson(
          record.pixelmatchThreshold,
          "pixelmatchThreshold",
        ),
      }
      : {}),
    ...(typeof record.includeAntiAliased === "boolean"
      ? { includeAntiAliased: record.includeAntiAliased }
      : {}),
    ...(record.allowedChangedPixelCount !== undefined
      ? {
        allowedChangedPixelCount: optionalNonNegativeIntegerFromJson(
          record.allowedChangedPixelCount,
          "allowedChangedPixelCount",
        ),
      }
      : {}),
    ...(record.allowedChangedPixelRatio !== undefined
      ? {
        allowedChangedPixelRatio: optionalUnitIntervalFromJson(
          record.allowedChangedPixelRatio,
          "allowedChangedPixelRatio",
        ),
      }
      : {}),
    ...(record.overlayOpacity !== undefined
      ? {
        overlayOpacity: optionalUnitIntervalFromJson(
          record.overlayOpacity,
          "overlayOpacity",
        ),
      }
      : {}),
  };
}

function previewNavigateInputFromJson(value: unknown): { url: string } {
  const record = requireObject(value);
  return { url: requiredTrimmedString(record, "url") };
}

function previewSelectorInputFromJson(value: unknown): { selector: string } {
  const record = requireObject(value);
  return { selector: requiredTrimmedString(record, "selector") };
}

function previewTypeInputFromJson(value: unknown): {
  selector: string;
  text: string;
} {
  const record = requireObject(value);
  return {
    selector: requiredTrimmedString(record, "selector"),
    text: typeof record.text === "string" ? record.text : "",
  };
}

function previewScrollInputFromJson(value: unknown): {
  deltaX?: number;
  deltaY?: number;
} {
  const record = requireObject(value);
  return {
    ...(typeof record.deltaX === "number" ? { deltaX: record.deltaX } : {}),
    ...(typeof record.deltaY === "number" ? { deltaY: record.deltaY } : {}),
  };
}

function taskReworkRouteTargetFromJson(
  value: unknown,
): TaskReworkRouteTarget | undefined {
  if (value === undefined) return undefined;
  if (
    value === "implementation" ||
    value === "spec" ||
    value === "tech-design" ||
    value === "workflow"
  ) {
    return value;
  }
  throw new WebInputError(
    "routeTarget must be implementation, spec, tech-design, or workflow",
  );
}

function taskReworkRequestInputFromJson(value: unknown): {
  instruction: string;
  routeTarget?: TaskReworkRouteTarget;
  idempotencyKey?: string;
  flowPath?: string;
} {
  const record = requireObject(value);
  return {
    instruction: typeof record.instruction === "string" ? record.instruction : "",
    routeTarget: taskReworkRouteTargetFromJson(record.routeTarget),
    idempotencyKey:
      typeof record.idempotencyKey === "string"
        ? record.idempotencyKey
        : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
  };
}

function draftSpecInputFromJson(value: unknown): {
  sourceType: DraftSpecSourceType;
  prompt?: string;
  text?: string;
  issue?: string;
  title?: string;
  guidance?: string;
  repoId?: string;
  flowPath?: string;
  templateId?: string;
  syncStatus?: boolean;
  publicBaseUrl?: string;
  documentUrl?: string;
  documentVersion?: string;
  documentExternalId?: string;
  documentAuthor?: string;
  documentUpdatedAt?: string;
  conversation?: IntakeConversationTurn[];
} {
  const record = requireObject(value);
  const sourceType = typeof record.sourceType === "string" ? record.sourceType : "";
  if (
    sourceType !== "prompt" &&
    sourceType !== "text" &&
    sourceType !== "github-issue" &&
    sourceType !== "jira-ticket" &&
    sourceType !== "external-document"
  ) {
    throw new WebInputError(
      "sourceType must be prompt, text, github-issue, jira-ticket, or external-document",
    );
  }
  let conversation: IntakeConversationTurn[] | undefined;
  if (record.conversation !== undefined) {
    if (sourceType !== "prompt" && sourceType !== "text") {
      throw new WebInputError(
        "conversation is only supported for prompt or text intake",
      );
    }
    try {
      conversation = normalizeIntakeConversation(record.conversation);
    } catch (error) {
      if (error instanceof IntakeConversationError) {
        throw new WebInputError(error.message);
      }
      throw error;
    }
  }
  for (const documentField of [
    "documentUrl",
    "documentVersion",
    "documentExternalId",
    "documentAuthor",
    "documentUpdatedAt",
  ] as const) {
    if (record[documentField] === undefined) continue;
    if (typeof record[documentField] !== "string") {
      throw new WebInputError(`${documentField} must be a string`);
    }
    if (sourceType !== "external-document") {
      throw new WebInputError(
        `${documentField} is only supported for external-document intake`,
      );
    }
  }
  if (record.syncStatus !== undefined && typeof record.syncStatus !== "boolean") {
    throw new WebInputError("syncStatus must be a boolean");
  }
  if (
    record.syncStatus !== undefined &&
    sourceType !== "jira-ticket" &&
    sourceType !== "github-issue"
  ) {
    throw new WebInputError("syncStatus is only supported for ticket intake");
  }
  if (
    record.publicBaseUrl !== undefined &&
    typeof record.publicBaseUrl !== "string"
  ) {
    throw new WebInputError("publicBaseUrl must be a string");
  }
  if (
    record.publicBaseUrl !== undefined &&
    sourceType !== "jira-ticket" &&
    sourceType !== "github-issue"
  ) {
    throw new WebInputError("publicBaseUrl is only supported for ticket intake");
  }
  return {
    sourceType,
    prompt: typeof record.prompt === "string" ? record.prompt : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
    issue: typeof record.issue === "string" ? record.issue : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    guidance: typeof record.guidance === "string" ? record.guidance : undefined,
    repoId: typeof record.repoId === "string" ? record.repoId : undefined,
    flowPath: typeof record.flowPath === "string" ? record.flowPath : undefined,
    templateId: typeof record.templateId === "string" ? record.templateId : undefined,
    ...(typeof record.syncStatus === "boolean"
      ? { syncStatus: record.syncStatus }
      : {}),
    publicBaseUrl:
      typeof record.publicBaseUrl === "string" ? record.publicBaseUrl : undefined,
    documentUrl:
      typeof record.documentUrl === "string" ? record.documentUrl : undefined,
    documentVersion:
      typeof record.documentVersion === "string" ? record.documentVersion : undefined,
    documentExternalId:
      typeof record.documentExternalId === "string"
        ? record.documentExternalId
        : undefined,
    documentAuthor:
      typeof record.documentAuthor === "string" ? record.documentAuthor : undefined,
    documentUpdatedAt:
      typeof record.documentUpdatedAt === "string"
        ? record.documentUpdatedAt
        : undefined,
    ...(conversation ? { conversation } : {}),
  };
}

function replaceSpecInputFromJson(value: unknown): { spec: string } {
  const record = requireObject(value);
  if (typeof record.spec !== "string" || !record.spec.trim()) {
    throw new WebInputError("spec is required");
  }
  return { spec: record.spec };
}

function taskTemplateSelection(templateId: string | undefined):
  | {
      flowPath: string;
      template: ReturnType<typeof flowTemplateLineage>;
    }
  | undefined {
  const trimmed = templateId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const template = getFlowTemplate(trimmed);
  if (!template) {
    throw new WebInputError("flow template not found");
  }
  if (!template.flowPath) {
    throw new WebInputError(
      "flow template cannot create a legacy task because it has no repository flow path",
    );
  }
  const unsupportedInputs = template.inputs
    .filter((input) => input.required)
    .map((input) => input.id)
    .filter((id) => id !== "spec" && id !== "tech-design");
  if (unsupportedInputs.length > 0) {
    throw new WebInputError(
      `flow template requires unsupported task inputs: ${unsupportedInputs.join(", ")}`,
    );
  }
  return {
    flowPath: template.flowPath,
    template: flowTemplateLineage(template),
  };
}

function normalizeSourceUri(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function ticketSourceNamespaceUri(value: string | undefined): string | undefined {
  const normalized = normalizeSourceUri(value);
  if (!normalized) return undefined;
  return normalized
    .replace(/\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+$/i, "")
    .replace(/\/issues\/\d+$/i, "");
}

function externalDocumentSourceSnapshot(
  document: NormalizedExternalDocument,
  fetchedAt = new Date().toISOString(),
): TaskSourceSnapshot {
  return withSourceSnapshotContentHash({
    uri: document.url,
    externalId: document.externalId,
    title: document.title,
    body: document.body,
    fetchedAt,
    ...(document.version ? { version: document.version } : {}),
    ...(document.author ? { author: document.author } : {}),
    ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
  });
}

function ticketSourceSnapshot(
  ticket: NormalizedTicket,
  fetchedAt = new Date().toISOString(),
): TaskSourceSnapshot {
  return withSourceSnapshotContentHash({
    uri: ticket.url,
    externalId: ticket.externalId,
    title: ticket.title,
    body: ticket.body,
    fetchedAt,
    ...(ticket.state ? { state: ticket.state } : {}),
    ...(ticket.stateCategory ? { stateCategory: ticket.stateCategory } : {}),
    ...(ticket.updatedAt ? { updatedAt: ticket.updatedAt } : {}),
    ...(ticket.author ? { author: ticket.author } : {}),
    ...(ticket.reporter ? { reporter: ticket.reporter } : {}),
    ...(ticket.assignees ? { assignees: [...ticket.assignees] } : {}),
    ...(ticket.labels ? { labels: [...ticket.labels] } : {}),
    ...(ticket.milestone ? { milestone: ticket.milestone } : {}),
    ...(ticket.comments
      ? {
          comments: ticket.comments.map((comment) => ({
            ...(comment.author ? { author: comment.author } : {}),
            body: comment.body,
            ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
            ...(comment.updatedAt ? { updatedAt: comment.updatedAt } : {}),
          })),
        }
      : {}),
    ...(ticket.attachments
      ? { attachments: ticket.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(ticket.linkedIssues
      ? { linkedIssues: ticket.linkedIssues.map((issue) => ({ ...issue })) }
      : {}),
  });
}

function stableSourceSnapshotValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function changedSourceSnapshotFields(
  baseline: TaskSourceSnapshot,
  latest: TaskSourceSnapshot,
): string[] {
  return SOURCE_SNAPSHOT_CONTENT_FIELDS.filter(
    (field) =>
      stableSourceSnapshotValue(baseline[field]) !==
      stableSourceSnapshotValue(latest[field]),
  );
}

function sourceDriftFromSnapshots(
  baseline: TaskSourceSnapshot,
  latest: TaskSourceSnapshot,
): TaskSourceDrift {
  const changedFields = changedSourceSnapshotFields(baseline, latest);
  const status: TaskSourceDrift["status"] =
    changedFields.length > 0 ? "changed" : "unchanged";
  return {
    status,
    checkedAt: latest.fetchedAt,
    changedFields,
    ...(status === "changed" ? { latestSnapshot: latest } : {}),
  };
}

function draftSpecSourceFromSnapshot(
  sourceType: SnapshotBackedTaskSourceType,
  snapshot: TaskSourceSnapshot,
): DraftSpecSource {
  return {
    type: sourceType,
    uri: snapshot.uri,
    title: snapshot.title,
    body: snapshot.body,
    ...(snapshot.version ? { version: snapshot.version } : {}),
  };
}

function isTicketSourceType(value: string | undefined): value is TicketSourceType {
  return value === "github-issue" || value === "jira-ticket";
}

async function findTaskByTicket(
  repoPath: string,
  ticket: NormalizedTicket,
): Promise<TaskRecord | undefined> {
  const normalizedTicketUrl = normalizeSourceUri(ticket.url);
  if (!normalizedTicketUrl) {
    return undefined;
  }
  const tasks = await listTasks(repoPath);
  return tasks.find((task) => {
    const legacyUrlMatch =
      normalizeSourceUri(task.issueUrl) === normalizedTicketUrl &&
      (!task.source?.type || task.source.type === ticket.sourceType);
    const sourceUriMatch =
      task.source?.type === ticket.sourceType &&
      normalizeSourceUri(task.source.uri) === normalizedTicketUrl;
    const externalIdMatch =
      task.source?.type === ticket.sourceType &&
      task.source.externalId === ticket.externalId &&
      ticketSourceNamespaceUri(task.source.uri ?? task.issueUrl) ===
        ticketSourceNamespaceUri(ticket.url);
    return legacyUrlMatch || sourceUriMatch || externalIdMatch;
  });
}

async function findTaskByExternalDocument(
  repoPath: string,
  document: NormalizedExternalDocument,
): Promise<TaskRecord | undefined> {
  const normalizedUrl = normalizeSourceUri(document.url);
  if (!normalizedUrl) {
    return undefined;
  }
  const tasks = await listTasks(repoPath);
  return tasks.find((task) => {
    if (task.source?.type !== "external-document") return false;
    return (
      normalizeSourceUri(task.source.uri) === normalizedUrl ||
      (Boolean(task.source.externalId) &&
        task.source.externalId === document.externalId)
    );
  });
}

function taskSourceFromExternalDocument(
  document: NormalizedExternalDocument,
  snapshot: TaskSourceSnapshot,
  drift: TaskSourceDrift,
): TaskSourceRecord {
  return {
    type: "external-document",
    uri: document.url,
    externalId: document.externalId,
    title: document.title,
    ...(document.version ? { version: document.version } : {}),
    snapshot,
    drift,
  };
}

function normalizedPublicBaseUrl(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new WebInputError("publicBaseUrl must be an absolute HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new WebInputError(
      "publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function ticketStatusSyncConfiguration(
  input: { syncStatus?: boolean; publicBaseUrl?: string },
  existing?: TaskSourceStatusSync,
): TaskSourceStatusSync {
  const enabled = input.syncStatus ?? existing?.enabled ?? false;
  const publicBaseUrl = normalizedPublicBaseUrl(
    input.publicBaseUrl ?? existing?.publicBaseUrl,
  );
  if (enabled && !publicBaseUrl) {
    throw new WebInputError("publicBaseUrl is required when source status sync is enabled");
  }
  return {
    ...(existing ?? {}),
    enabled,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}

function taskSourceFromTicket(
  ticket: NormalizedTicket,
  snapshot: TaskSourceSnapshot,
  drift: TaskSourceDrift,
  statusSync?: TaskSourceStatusSync,
): TaskSourceRecord {
  return {
    type: ticket.sourceType,
    uri: ticket.url,
    externalId: ticket.externalId,
    title: ticket.title,
    snapshot,
    drift,
    ...(statusSync ? { statusSync } : {}),
  };
}

interface JiraTaskStatusSyncResult {
  task: TaskRecord;
  synced: boolean;
  unchanged: boolean;
  commentUrl?: string;
}

function safeJiraSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Jira status sync failed";
  return message.startsWith("Jira")
    ? message.slice(0, 500)
    : "Jira status sync failed; inspect provider configuration and retry";
}

async function syncJiraTaskStatus(input: {
  repoPath: string;
  task: TaskRecord;
  providerStore: ProviderConnectionStore;
  publisher?: JiraStatusPublisher;
}): Promise<JiraTaskStatusSyncResult> {
  const source = input.task.source;
  if (source?.type !== "jira-ticket") {
    throw new WebInputError("source status sync requires a Jira ticket task");
  }
  if (!source.statusSync?.enabled) {
    throw new WebInputError("Jira status sync is disabled for this task");
  }
  const publicBaseUrl = normalizedPublicBaseUrl(source.statusSync.publicBaseUrl);
  if (!publicBaseUrl) {
    throw new WebInputError("Jira status sync requires a public Nitely base URL");
  }
  const configuredBase = await configuredJiraBaseUrl(input.providerStore);
  const reference = parseJiraTicketReference(source.uri ?? "", configuredBase);
  const taskUrl = `${publicBaseUrl}/tasks/${encodeURIComponent(input.task.id)}`;
  const links: JiraStatusUpdate["links"] = [
    { label: "Task", url: taskUrl },
    { label: "Specification", url: `${taskUrl}#spec` },
    { label: "Technical design", url: `${taskUrl}#tech-design` },
    ...(input.task.latestRunId
      ? [
          {
            label: "Latest run",
            url: `${publicBaseUrl}/runs/${encodeURIComponent(input.task.latestRunId)}`,
          },
        ]
      : []),
    ...(input.task.changeRequestUrl
      ? [{ label: "Change request", url: input.task.changeRequestUrl }]
      : []),
  ];
  const specStatus =
    input.task.specStatus ?? (input.task.status === "draft" ? "draft" : "approved");
  const techDesignStatus =
    input.task.techDesignStatus ??
    (input.task.status === "draft" ? "draft" : "approved");
  const sourceDriftStatus = source.drift?.status ?? "unchanged";
  const update: JiraStatusUpdate = {
    summary: `Nitely task ${input.task.id} is ${input.task.status}; spec is ${specStatus}; technical design is ${techDesignStatus}; source is ${sourceDriftStatus}.`,
    links,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(update), "utf8")
    .digest("hex");
  if (source.statusSync.lastFingerprint === fingerprint) {
    return {
      task: input.task,
      synced: false,
      unchanged: true,
      ...(source.statusSync.lastCommentUrl
        ? { commentUrl: source.statusSync.lastCommentUrl }
        : {}),
    };
  }
  const attemptedAt = new Date().toISOString();
  try {
    const result = input.publisher
      ? await input.publisher(reference, update)
      : await defaultJiraStatusPublisher(reference, update, {
          providerStore: input.providerStore,
        });
    const statusSync: TaskSourceStatusSync = {
      ...source.statusSync,
      lastAttemptedAt: attemptedAt,
      lastSyncedAt: attemptedAt,
      lastFingerprint: fingerprint,
      ...(result.url ? { lastCommentUrl: result.url } : {}),
    };
    delete statusSync.lastError;
    const task = await updateTaskSourceRecord(input.repoPath, input.task.id, {
      ...source,
      statusSync,
    });
    return {
      task,
      synced: true,
      unchanged: false,
      ...(result.url ? { commentUrl: result.url } : {}),
    };
  } catch (error) {
    await updateTaskSourceRecord(input.repoPath, input.task.id, {
      ...source,
      statusSync: {
        ...source.statusSync,
        lastAttemptedAt: attemptedAt,
        lastError: safeJiraSyncError(error),
      },
    });
    throw error;
  }
}

function repositoryInputFromJson(value: unknown): AddWebRepositoryInput {
  const record = requireObject(value);
  if (
    typeof record.id === "string" &&
    record.id.trim() === "demo-golden-path"
  ) {
    throw new WebInputError("repository id is reserved for the mocked demo");
  }
  if ("path" in record) {
    throw new WebInputError(
      "repository path is not accepted; register a GitHub URL",
    );
  }
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    githubUrl: typeof record.githubUrl === "string" ? record.githubUrl : undefined,
    defaultBranch:
      typeof record.defaultBranch === "string" ? record.defaultBranch : undefined,
  };
}

function requiredTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = typeof record[key] === "string" ? record[key].trim() : "";
  if (!value) throw new WebInputError(`${key} is required`);
  return value;
}

function knowledgeAttachmentInputFromJson(value: unknown): {
  repoId?: string;
  attachment: CreateKnowledgeRepositoryAttachmentInput;
} {
  const outer = requireObject(value);
  const record = outer.attachment === undefined
    ? outer
    : requireObject(outer.attachment);
  const sourceValue = record.source;
  let source: CreateKnowledgeRepositoryAttachmentInput["source"];
  if (typeof sourceValue === "string") {
    const sourceText = sourceValue.trim();
    if (!sourceText) {
      throw new WebInputError("source is required");
    }
    if (
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(sourceText) &&
      !sourceText.startsWith("https://")
    ) {
      throw new WebInputError("remote knowledge source must use HTTPS");
    }
    source = sourceText.startsWith("https://")
      ? { type: "remote", providerId: "github", url: sourceText }
      : { type: "local", path: sourceText };
  } else {
    const sourceRecord = requireObject(sourceValue);
    if (sourceRecord.type === "remote") {
      if (
        sourceRecord.providerId !== undefined &&
        sourceRecord.providerId !== "github"
      ) {
        throw new WebInputError("source.providerId must be github");
      }
      source = {
        type: "remote",
        providerId: "github",
        url: requiredTrimmedString(sourceRecord, "url"),
      };
    } else if (sourceRecord.type === "local") {
      source = {
        type: "local",
        path: requiredTrimmedString(sourceRecord, "path"),
      };
    } else {
      throw new WebInputError("source.type must be local or remote");
    }
  }
  const refValue = record.ref;
  let ref: CreateKnowledgeRepositoryAttachmentInput["ref"];
  if (typeof refValue === "string") {
    if (
      record.refType !== undefined &&
      record.refType !== "branch" &&
      record.refType !== "tag" &&
      record.refType !== "commit"
    ) {
      throw new WebInputError("refType must be branch, tag, or commit");
    }
    const refType = record.refType ?? "branch";
    ref = { type: refType, value: refValue };
  } else {
    const refRecord = requireObject(refValue);
    if (
      refRecord.type !== "branch" &&
      refRecord.type !== "tag" &&
      refRecord.type !== "commit"
    ) {
      throw new WebInputError("ref.type must be branch, tag, or commit");
    }
    ref = {
      type: refRecord.type,
      value: requiredTrimmedString(refRecord, "value"),
    };
  }
  const pathRecord = record.paths === undefined ? {} : requireObject(record.paths);
  const include = optionalStringArrayFromJson(
    pathRecord.include ?? record.include,
    "paths.include",
  );
  const exclude = optionalStringArrayFromJson(
    pathRecord.exclude ?? record.exclude,
    "paths.exclude",
  );
  const budgets = record.budgets === undefined
    ? undefined
    : requireObject(record.budgets) as CreateKnowledgeRepositoryAttachmentInput["budgets"];
  const retrievalRecord = record.retrieval === undefined
    ? undefined
    : requireObject(record.retrieval);
  const providerId = retrievalRecord?.providerId ?? record.embeddingProvider;
  if (
    providerId !== undefined &&
    providerId !== "local-hash" &&
    providerId !== "ollama" &&
    providerId !== "openai-compatible"
  ) {
    throw new WebInputError("unsupported embedding provider");
  }
  const model = retrievalRecord?.model ?? record.embeddingModel;
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw new WebInputError("embedding model must be a non-empty string");
  }
  const refreshRecord = record.refreshPolicy === undefined
    ? undefined
    : requireObject(record.refreshPolicy);
  let refreshPolicy: CreateKnowledgeRepositoryAttachmentInput["refreshPolicy"];
  if (refreshRecord?.mode === "on-admission") {
    if (
      typeof refreshRecord.maxAgeSeconds !== "number" ||
      !Number.isSafeInteger(refreshRecord.maxAgeSeconds) ||
      refreshRecord.maxAgeSeconds < 1
    ) {
      throw new WebInputError(
        "refreshPolicy.maxAgeSeconds must be a positive integer",
      );
    }
    refreshPolicy = {
      mode: "on-admission",
      maxAgeSeconds: refreshRecord.maxAgeSeconds,
    };
  } else if (refreshRecord !== undefined) {
    if (refreshRecord.mode !== "manual") {
      throw new WebInputError("refreshPolicy.mode must be manual or on-admission");
    }
    refreshPolicy = { mode: "manual" };
  }
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new WebInputError("enabled must be a boolean");
  }
  if (record.required !== undefined && typeof record.required !== "boolean") {
    throw new WebInputError("required must be a boolean");
  }
  const attachment: CreateKnowledgeRepositoryAttachmentInput = {
    id: requiredTrimmedString(record, "id"),
    name: requiredTrimmedString(record, "name"),
    source,
    ref,
    ...(include || exclude
      ? { paths: { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) } }
      : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled === true } : {}),
    ...(record.required !== undefined ? { required: record.required === true } : {}),
    ...(refreshPolicy ? { refreshPolicy } : {}),
    ...(budgets ? { budgets } : {}),
    ...(providerId || typeof model === "string"
      ? {
          retrieval: {
            ...(providerId ? { providerId } : {}),
            ...(typeof model === "string" ? { model } : {}),
          },
        }
      : {}),
  };
  return {
    ...(typeof outer.repoId === "string" && outer.repoId.trim()
      ? { repoId: outer.repoId.trim() }
      : {}),
    attachment,
  };
}

function publicKnowledgeAttachment(
  attachment: KnowledgeRepositoryAttachment,
): Record<string, unknown> {
  return {
    ...attachment,
    source: attachment.source.type === "remote"
      ? attachment.source
      : { type: "local" },
  };
}

function publicKnowledgeStatus(
  status: KnowledgeRepositoryStatus,
): Record<string, unknown> {
  return {
    ...status,
    ...(status.currentSnapshot
      ? {
          currentSnapshot: Object.fromEntries(
            Object.entries(status.currentSnapshot).filter(([key]) => key !== "indexPath"),
          ),
        }
      : {}),
  };
}

function publicKnowledgeRepositoryView(view: {
  attachment: KnowledgeRepositoryAttachment;
  status: KnowledgeRepositoryStatus;
}): Record<string, unknown> {
  return {
    attachment: publicKnowledgeAttachment(view.attachment),
    status: publicKnowledgeStatus(view.status),
  };
}

function safeKnowledgeWebErrorMessage(
  error: unknown,
  repositoryPath: string,
  fallback: string,
): string {
  const raw = redactText(error instanceof Error ? error.message : String(error)) ?? fallback;
  const withoutRepository = raw.replaceAll(repositoryPath, "[repository]");
  if (
    /(?:^|[\s("'=])\/(?!\/)[^\s]/u.test(withoutRepository) ||
    /\b[A-Za-z]:\\[^\s]/u.test(withoutRepository)
  ) {
    return fallback;
  }
  return withoutRepository.slice(0, 500) || fallback;
}

function skillImportInputFromJson(value: unknown): {
  repoId?: string;
  sourcePath: string;
  overwrite: boolean;
} {
  const record = requireObject(value);
  const repoId = typeof record.repoId === "string" ? record.repoId.trim() : "";
  const sourcePath =
    typeof record.sourcePath === "string" ? record.sourcePath.trim() : "";
  if (!sourcePath) {
    throw new WebInputError("sourcePath is required");
  }
  return {
    ...(repoId ? { repoId } : {}),
    sourcePath,
    overwrite: record.overwrite === true,
  };
}

/**
 * Attach the repository a record was loaded from. That repository is
 * authoritative for `repoId`: records written before the `default`
 * repository was retired still carry `repoId: "default"`, and the view must
 * name the entry they actually live under.
 */
function withRepository<T extends object>(
  value: T,
  repository: WebRepository,
): T & {
  repoId: string;
  repoName: string;
  repoPath: string;
  repoSynthetic?: boolean;
} {
  const existing = value as Partial<{ repoId: string; repoName: string; repoPath: string }>;
  return {
    ...value,
    repoId: repository.id,
    repoName: existing.repoName ?? repository.name,
    repoPath: existing.repoPath ?? repository.path,
    repoSynthetic: repository.synthetic === true ? true : undefined,
  };
}

function withContextKnowledgeRepository(
  entry: ContextKnowledgeEntry,
  repository: WebRepository,
): ContextKnowledgeEntry & { repoId: string; repoName: string; repoPath: string } {
  return {
    ...entry,
    repoId: repository.id,
    repoName: repository.name,
    repoPath: repository.path,
  };
}

function goldenPathDemoView(
  result: GoldenPathDemoResult,
  repository: WebRepository,
) {
  return {
    mocked: true,
    repository: withRepository({}, repository),
    outputDir: result.outputDir,
    repoPath: result.repoPath,
    taskId: result.taskId,
    taskRoute: `/tasks/${encodeURIComponent(result.taskId)}`,
    implementationRunId: result.implementationRunId,
    implementationRunRoute: `/runs/${encodeURIComponent(result.implementationRunId)}`,
    implementationEvidencePath: result.implementationEvidencePath,
    implementationEvidenceRoute: `/runs/${encodeURIComponent(result.implementationRunId)}#evidence`,
    draftPullRequestUrl: result.draftPullRequestUrl,
    reworkRunId: result.reworkRunId,
    reworkRunRoute: `/runs/${encodeURIComponent(result.reworkRunId)}`,
    reworkEvidencePath: result.reworkEvidencePath,
    reworkEvidenceRoute: `/runs/${encodeURIComponent(result.reworkRunId)}#evidence`,
    updatedPullRequestUrl: result.updatedPullRequestUrl,
    proof: result.proof,
  };
}

function withNotificationRepository<T extends NotificationRecord>(
  notification: T,
  repository: WebRepository,
): T & { repoId: string; repoName: string; repoPath: string } {
  return {
    ...notification,
    repoId: repository.id,
    repoName: repository.name,
    repoPath: repository.path,
  };
}

interface WebSpecApprovalReadinessIssue extends SourceSpecificSpecReadinessIssue {
  remediation: string;
}

interface WebSpecApprovalReadiness {
  ready: boolean;
  summary: string;
  hint: string;
  issues: WebSpecApprovalReadinessIssue[];
}

type SourceDriftDiffField = "title" | "body" | "state";

interface WebSourceDriftDiffEntry {
  field: SourceDriftDiffField;
  label: string;
  previous: string;
  latest: string;
}

function specApprovalReadinessRemediation(
  code: SourceSpecificSpecReadinessIssue["code"],
): string {
  if (code === "generic-functional-requirement") {
    return "Replace the generated FR with concrete source-specific behavior from the intake.";
  }
  if (code === "generic-success-criterion") {
    return "Replace the generated SC with a concrete verification check for the source request.";
  }
  if (code === "default-open-question") {
    return "Answer, remove, or replace this generated open question before approval.";
  }
  if (code === "missing-source-specific-functional-requirement") {
    return "Add at least one FR that names the exact behavior requested by the source.";
  }
  if (code === "missing-source-specific-success-criterion") {
    return "Add at least one SC that can verify the source-specific behavior.";
  }
  return "Fix the structured spec diagnostics before approval.";
}

function specApprovalReadinessForDetail(detail: {
  planningSource?: TaskSourceRecord;
  spec?: string;
}): WebSpecApprovalReadiness {
  if (!detail.planningSource) {
    return {
      ready: true,
      summary: "spec approval readiness passed",
      hint: "",
      issues: [],
    };
  }
  const readiness = evaluateSourceSpecificSpecReadiness(detail.spec ?? "");
  return {
    ready: readiness.ready,
    summary: readiness.ready
      ? "spec approval readiness passed"
      : "source-specific requirements are required before approval",
    hint:
      "Replace generated FR/SC placeholders with concrete behavior and verification from the source, then answer or remove generated open questions.",
    issues: readiness.issues.map((issue) => ({
      ...issue,
      remediation: specApprovalReadinessRemediation(issue.code),
    })),
  };
}

const sourceDriftDiffFields: Array<{
  field: SourceDriftDiffField;
  label: string;
}> = [
  { field: "title", label: "Title" },
  { field: "body", label: "Body" },
  { field: "state", label: "State" },
];

function sourceDriftValuePreview(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : "—";
  const compact = text.replace(/\s+/g, " ");
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function sourceDriftDiffForDetail(detail: {
  planningSource?: TaskSourceRecord;
}): WebSourceDriftDiffEntry[] {
  const source = detail.planningSource;
  const baseline = source?.snapshot;
  const latest = source?.drift?.latestSnapshot;
  if (!baseline || !latest || source?.drift?.status !== "changed") {
    return [];
  }
  const changed = new Set(source.drift.changedFields);
  return sourceDriftDiffFields
    .filter(({ field }) => changed.has(field))
    .map(({ field, label }) => ({
      field,
      label,
      previous: sourceDriftValuePreview(baseline[field]),
      latest: sourceDriftValuePreview(latest[field]),
    }));
}

async function evaluateWebWorkItemRunPreflight(
  input: Parameters<typeof evaluateWorkItemRunPreflight>[0],
) {
  try {
    return await evaluateWorkItemRunPreflight(input);
  } catch (error) {
    if (error instanceof RepositoryFlowPathError) {
      throw new WebInputError(error.message);
    }
    throw error;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function getProviderStore(
  input: RuntimeStartWebServerInput,
  repoPath: string,
): ProviderConnectionStore {
  return (
    input.providerStore ??
    resolveProviderStore(
      join(repoPath, ".nitely"),
      input.providerEnv ?? process.env,
      input.providerCommandStatus,
      providerStoreOAuthOptions(input),
    )
  );
}

function providerStoreForUser(
  input: RuntimeStartWebServerInput,
  repoPath: string,
  user: WebUserContext,
): ProviderConnectionStore {
  if (user.authMode === "local") {
    return getProviderStore(input, repoPath);
  }
  // A signed-in user keeps their own credentials, but still sees the ones an
  // operator configured for the repository. Without the fallback a shared
  // credential is invisible to every Web Console user, and the run that needs
  // it fails with no indication that the credential exists one directory up.
  return new FileProviderConnectionStore({
    path: join(repoPath, ".nitely", "users", user.id, "connections.json"),
    fallbackPaths: [join(repoPath, ".nitely", "connections.json")],
    env: input.providerEnv ?? process.env,
    commandStatus: input.providerCommandStatus,
    ...providerStoreOAuthOptions(input),
  });
}

async function webRunRedactionSecrets(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  providerRepoPath: string,
  policyRepoPath: string,
  user: WebUserContext,
): Promise<string[]> {
  const stores = [
    providerStoreForUser(input, providerRepoPath, user),
    providerStoreForUser(input, policyRepoPath, user),
  ].filter((store, index, all) => all.indexOf(store) === index);
  const [policy, providerEnvironments] = await Promise.all([
    loadContextPolicy(policyRepoPath),
    Promise.all(stores.map(async (store) => await store.resolveEnv())),
  ]);
  const secrets = collectContextRedactionSecrets({
    policy,
    processEnv: process.env,
  });
  for (const providerEnv of providerEnvironments) {
    secrets.push(...collectContextRedactionSecrets({
      policy,
      processEnv: {},
      providerEnv,
    }));
  }
  return [...new Set(secrets)];
}

async function requireKnowledgeGitHubCredentialScope(input: {
  store: ProviderConnectionStore;
  repository: WebRepository;
  user: WebUserContext;
}): Promise<void> {
  const status = (await input.store.listStatuses()).find(
    (candidate) => candidate.id === "github",
  );
  const credential = status?.credential;
  if (!credential) return;
  if (
    credential.scope === "repo" &&
    (!credential.repositoryId ||
      credential.repositoryId !== input.repository.id)
  ) {
    throw new WebForbiddenError("GitHub credential repository scope mismatch");
  }
  if (
    (credential.scope === "org" ||
      credential.scope === "external-vault-backed") &&
    (!credential.organizationId ||
      !input.user.currentOrganizationId ||
      credential.organizationId !== input.user.currentOrganizationId)
  ) {
    throw new WebForbiddenError("GitHub credential organization scope mismatch");
  }
  if (
    credential.scope === "user" &&
    (!credential.ownerId || credential.ownerId !== input.user.id)
  ) {
    throw new WebForbiddenError("GitHub credential owner scope mismatch");
  }
}

function knowledgeRepositoryServiceForInput(
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
) {
  return input.knowledgeRepositoryService ?? {
    attach: attachKnowledgeRepository,
    list: listKnowledgeRepositories,
    status: getKnowledgeRepositoryStatus,
    refresh: refreshKnowledgeRepository,
    query: queryKnowledgeRepositories,
    detach: detachKnowledgeRepository,
  };
}

function boundedKnowledgeQuery(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= 60 * 1024) return value;
  return bytes.subarray(0, 60 * 1024).toString("utf8");
}

function safeWebKnowledgeQueryPart(
  value: string,
  redactionSecrets: readonly string[],
): string {
  const redacted = redactText(value, redactionSecrets) ?? "";
  if (containsSensitiveText(redacted)) return "[sensitive source content omitted]";
  const structuredSecret = redacted.split(/\r?\n/u).some((line) => {
    const match = /^\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]/u.exec(line);
    return Boolean(match && isSensitiveKey(match[1] ?? ""));
  });
  const quotedSecret = [...redacted.matchAll(/["']([^"']+)["']\s*:/gu)]
    .some((match) => isSensitiveKey(match[1] ?? ""));
  if (structuredSecret || quotedSecret) {
    return "[sensitive source content omitted]";
  }
  return redacted;
}

async function selectWebExternalKnowledge(input: {
  serverInput: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">;
  homeRepoPath: string;
  repository: WebRepository;
  user: WebUserContext;
  queryParts: Array<string | undefined>;
}): Promise<Array<{ citation: string; text: string }>> {
  if (
    !input.serverInput.knowledgeRepositoryService &&
    !(await knowledgeRepositoryRegistryExists({
      targetRepoPath: input.repository.path,
    }))
  ) {
    return [];
  }
  const service = knowledgeRepositoryServiceForInput(input.serverInput);
  let views: KnowledgeRepositoryView[];
  try {
    views = await service.list({ targetRepoPath: input.repository.path });
  } catch {
    throw new WebInputError("external knowledge registry is unavailable");
  }
  const enabled = views.filter((view) => view.attachment.enabled);
  const required = views.some((view) => view.attachment.required);
  const privilegedAdmin = input.user.role === "admin" &&
    !input.user.viaApiToken;
  if (!privilegedAdmin) {
    if (required) {
      throw new WebForbiddenError(
        "administrator access is required to use required external knowledge",
      );
    }
    return [];
  }
  if (enabled.length === 0) {
    if (required) {
      throw new WebInputError("required external knowledge is unavailable");
    }
    return [];
  }
  const providerStore = providerStoreForUser(
    input.serverInput,
    input.homeRepoPath,
    input.user,
  );
  if (enabled.some((view) => view.attachment.source.type === "remote")) {
    await requireKnowledgeGitHubCredentialScope({
      store: providerStore,
      repository: input.repository,
      user: input.user,
    });
  }
  try {
    const redactionSecrets = await webRunRedactionSecrets(
      input.serverInput,
      input.homeRepoPath,
      input.repository.path,
      input.user,
    );
    const query = boundedKnowledgeQuery(
      input.queryParts
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .map((part) => safeWebKnowledgeQueryPart(part, redactionSecrets))
        .join("\n\n"),
    );
    if (!query.trim()) return [];
    const result = await service.query(
      {
        targetRepoPath: input.repository.path,
        query,
        topK: 6,
        maxPromptTokens: 1_800,
        allowDegraded: true,
      },
      {
        providerStore,
        redactionSecrets,
      },
    );
    return result.matches.map((match) => ({
      citation: match.citation,
      text: safeWebKnowledgeQueryPart(match.text, redactionSecrets),
    }));
  } catch (error) {
    // Optional attachments degrade to no context. A required attachment must
    // stop planning so the generated artifact cannot silently omit policy.
    if (!required) return [];
    if (isWebError(error)) throw error;
    throw new WebInputError("required external knowledge is unavailable");
  }
}

async function requireWebKnowledgeRunAccess(input: {
  serverInput: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">;
  homeRepoPath: string;
  repository: WebRepository;
  user: WebUserContext;
  attachmentIds?: readonly string[];
  pinnedRun?: boolean;
}): Promise<ProviderConnectionStore> {
  const providerStore = providerStoreForUser(
    input.serverInput,
    input.homeRepoPath,
    input.user,
  );
  if (
    !input.pinnedRun &&
    !input.serverInput.knowledgeRepositoryService &&
    !(await knowledgeRepositoryRegistryExists({
      targetRepoPath: input.repository.path,
    }))
  ) {
    return providerStore;
  }
  const service = knowledgeRepositoryServiceForInput(input.serverInput);
  let views: KnowledgeRepositoryView[];
  try {
    views = await service.list({ targetRepoPath: input.repository.path });
  } catch {
    throw new WebInputError("external knowledge registry is unavailable");
  }
  const selectedIds = input.attachmentIds
    ? new Set(input.attachmentIds)
    : undefined;
  const selectedViews = views.filter(
    (view) =>
      (!selectedIds || selectedIds.has(view.attachment.id)),
  );
  const enabled = selectedViews.filter((view) => view.attachment.enabled);
  const requiredUnavailable = selectedViews.some(
    (view) => view.attachment.required && !view.attachment.enabled,
  );
  if (enabled.length === 0 && !requiredUnavailable && !input.pinnedRun) {
    return providerStore;
  }
  if (input.user.role !== "admin" || input.user.viaApiToken) {
    throw new WebForbiddenError(
      "administrator access is required to run Flows with external knowledge",
    );
  }
  if (enabled.some((view) => view.attachment.source.type === "remote")) {
    await requireKnowledgeGitHubCredentialScope({
      store: providerStore,
      repository: input.repository,
      user: input.user,
    });
  }
  return providerStore;
}

function manualRunRequestFacts(
  url: URL,
  body: Record<string, unknown>,
  user: WebUserContext,
): {
  override: boolean;
  overrideReason?: string;
  intent: RunEligibilityIntent;
} {
  const override = url.searchParams.get("override") === "true";
  const overrideReason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : typeof body.overrideReason === "string" && body.overrideReason.trim()
        ? body.overrideReason.trim()
        : undefined;
  return {
    override,
    ...(overrideReason ? { overrideReason } : {}),
    intent: {
      kind: "manual",
      ...(override
        ? {
            override: {
              actor: user.email || user.id,
              reason:
                overrideReason ??
                "operator acknowledged run eligibility blockers and started with override=true",
            },
          }
        : {}),
    },
  };
}

function runStartConflictError(
  admission: Extract<WorkItemRunAdmission, { decision: "conflict" }>,
): WebRunStartConflictError {
  const message =
    admission.reason === "stale-candidate"
      ? "Work item changed after Run eligibility was evaluated; refresh and retry"
      : admission.reason === "stale-dependency"
        ? "A direct dependency changed after Run eligibility was evaluated; refresh and retry"
      : admission.runId
        ? `Work item snapshot already belongs to Run ${admission.runId}`
        : "Work item already has an active Run";
  return new WebRunStartConflictError(message, admission.runId);
}

function assertAdmittedRunId(expectedRunId: string, actualRunId: string): void {
  if (actualRunId !== expectedRunId) {
    throw new Error(
      `runner returned Run ${actualRunId} instead of admitted Run ${expectedRunId}`,
    );
  }
}

async function resolveTaskReworkFlowPath(
  repoPath: string,
  candidatePath?: string,
): Promise<string> {
  try {
    return (await resolveRepositoryFlowPath(
      repoPath,
      candidatePath?.trim() || defaultTaskReworkFlowPath,
    )).flowPath;
  } catch (error) {
    if (error instanceof RepositoryFlowPathError) {
      throw new WebInputError(error.message);
    }
    throw error;
  }
}

function taskRequestChangesCapability(
  task: Pick<TaskRecord, "status" | "latestRunId" | "changeRequestUrl"> & {
    workItemType?: string;
  } &
    Partial<Pick<TaskRecord, "ownerId" | "organizationId">> & { readOnly?: boolean },
  reworkRequests: TaskReworkRequest[],
): { canRequestChanges: boolean; requestChangesDisabledReason?: string } {
  const active = reworkRequests.find(
    (request) =>
      request.status === "pending_confirmation" || request.status === "running",
  );
  if (task.readOnly) {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason: "Task is read-only in this repository view.",
    };
  }
  if (task.workItemType && task.workItemType !== DEV_PR_WORK_ITEM_TYPE) {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason:
        "Request changes currently supports implementation Tasks only.",
    };
  }
  if (active) {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason: `Task already has active rework request ${active.id}.`,
    };
  }
  if (task.status === "running") {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason:
        "Running Tasks cannot receive live message injection; wait for the active run to finish or cancel it first.",
    };
  }
  if (task.status !== "completed") {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason:
        "Request changes is available after a Task has completed.",
    };
  }
  if (!task.latestRunId) {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason: "Task has no prior run to link.",
    };
  }
  if (!task.changeRequestUrl) {
    return {
      canRequestChanges: false,
      requestChangesDisabledReason: "Task has no change request to rework.",
    };
  }
  return { canRequestChanges: true };
}

async function visiblePreviewSessions(input: {
  repositories: WebRepository[];
  manager: PreviewSessionManager;
  user: WebUserContext;
  repoId?: string;
}): Promise<PreviewSessionRecord[]> {
  const repositories = input.repoId
    ? [requireVisibleRepository(input.repositories, input.repoId, input.user)]
    : visibleRepositories(input.repositories, input.user);
  const records = (
    await Promise.all(
      repositories.map((repository) => input.manager.list(repository.path)),
    )
  ).flat();
  return records.filter((record) => recordVisibleToUser(record, input.user));
}

async function getScopedPreviewSession(input: {
  repositories: WebRepository[];
  manager: PreviewSessionManager;
  sessionId: string;
  user: WebUserContext;
}): Promise<{ repository: WebRepository; record: PreviewSessionRecord }> {
  for (const repository of visibleRepositories(input.repositories, input.user)) {
    try {
      const record = await input.manager.get(repository.path, input.sessionId);
      requireRecordAccess(record, input.user, "preview session not found");
      return { repository, record };
    } catch (error) {
      if (
        error instanceof WebNotFoundError ||
        error instanceof WebInputError
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError("preview session not found");
}

function previewNavigationUrl(record: PreviewSessionRecord, value: string): string {
  const base = new URL(record.targetUrl);
  const candidate = new URL(value, base);
  if (candidate.origin !== base.origin) {
    throw new WebInputError("preview navigation must stay on the session origin");
  }
  return candidate.toString();
}

const previewProxyMaxBytes = 16 * 1024 * 1024;
const previewProxyCsp =
  "sandbox allow-scripts allow-forms allow-pointer-lock allow-downloads";

function previewProxyPath(sessionId: string, target: URL): string {
  return `/api/preview-sessions/${encodeURIComponent(sessionId)}/proxy${target.pathname}${target.search}`;
}

function previewProxyTargetUrl(input: {
  record: PreviewSessionRecord;
  proxyPath?: string;
  search: string;
}): URL {
  if (input.record.status !== "ready") {
    throw new WebInputError("preview session is not ready");
  }
  const base = new URL(input.record.currentUrl ?? input.record.targetUrl);
  const target = input.proxyPath === undefined
    ? new URL(`${base.pathname}${base.search}`, base.origin)
    : new URL(`/${input.proxyPath}${input.search}`, base.origin);
  if (target.origin !== base.origin) {
    throw new WebInputError("preview proxy target must stay on the session origin");
  }
  return target;
}

function rewritePreviewHtml(input: {
  html: string;
  sessionId: string;
}): string {
  const baseHref = `/api/preview-sessions/${encodeURIComponent(input.sessionId)}/proxy/`;
  const withBase = /<head(\s[^>]*)?>/i.test(input.html)
    ? input.html.replace(/<head(\s[^>]*)?>/i, (match) =>
        `${match}<base href="${baseHref}">`
      )
    : `<base href="${baseHref}">${input.html}`;
  return withBase
    .replace(
      /\b(src|href|action)=(["'])\/(?!\/)([^"']*)\2/gi,
      (_match, attribute: string, quote: string, path: string) =>
        `${attribute}=${quote}${baseHref}${path}${quote}`,
    )
    .replace(
      /url\(\s*(['"]?)\/(?!\/)([^'")]+)\1\s*\)/gi,
      (_match, quote: string, path: string) =>
        `url(${quote}${baseHref}${path}${quote})`,
    );
}

async function sendPreviewProxyResponse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  record: PreviewSessionRecord;
  proxyPath?: string;
  search: string;
}): Promise<void> {
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    throw new WebInputError("preview proxy only supports GET and HEAD");
  }
  const target = previewProxyTargetUrl({
    record: input.record,
    proxyPath: input.proxyPath,
    search: input.search,
  });
  const upstream = await fetch(target, {
    method: input.request.method,
    redirect: "manual",
    headers: {
      accept: input.request.headers.accept ?? "*/*",
      "user-agent": "Nitely Preview Proxy",
    },
  });
  const location = upstream.headers.get("location");
  if (location && upstream.status >= 300 && upstream.status < 400) {
    const redirected = new URL(location, target);
    if (redirected.origin !== target.origin) {
      throw new WebInputError("preview proxy refused a cross-origin redirect");
    }
    input.response.writeHead(upstream.status, {
      location: previewProxyPath(input.record.id, redirected),
      "cache-control": "no-store",
      "content-security-policy": previewProxyCsp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    input.response.end();
    return;
  }
  const contentLength = upstream.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > previewProxyMaxBytes
  ) {
    throw new WebInputError("preview proxy response is too large");
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength > previewProxyMaxBytes) {
    throw new WebInputError("preview proxy response is too large");
  }
  const contentType = upstream.headers.get("content-type") ??
    "application/octet-stream";
  const isHtml = /\btext\/html\b/i.test(contentType);
  const body = isHtml
    ? Buffer.from(
        rewritePreviewHtml({
          html: bytes.toString("utf8"),
          sessionId: input.record.id,
        }),
        "utf8",
      )
    : bytes;
  input.response.writeHead(upstream.status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": previewProxyCsp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  input.response.end(input.request.method === "HEAD" ? undefined : body);
}

async function runStoredWorkItem(
  repository: WebRepository,
  serverInput: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  workItemId: string,
  user: WebUserContext,
  providerStore: ProviderConnectionStore,
  runner: NonNullable<StartWebServerInput["runFlow"]>,
  notFoundMessage: string,
  intent: RunEligibilityIntent,
  taskScope?: RunFlowInput["taskScope"],
): Promise<RunFlowResult> {
  const repoPath = repository.path;
  let candidate = await getWorkItemSnapshot(repoPath, workItemId);
  let workItem = candidate.record;
  requireRecordAccess(workItem, user, notFoundMessage);
  requireWriteAccessToRecord(user, workItem, "runs:start");
  if (workItem.status === "running" && workItem.latestRunId) {
    const reconciled = await reconcileTerminalWorkItemRun({
      repoPath,
      workItemId,
      runId: workItem.latestRunId,
    });
    if (!reconciled || reconciled.status === "running") {
      throw new WebRunStartConflictError(
        `Work item snapshot already belongs to Run ${workItem.latestRunId}`,
        workItem.latestRunId,
      );
    }
    candidate = await getWorkItemSnapshot(repoPath, workItemId);
    workItem = candidate.record;
    requireRecordAccess(workItem, user, notFoundMessage);
    requireWriteAccessToRecord(user, workItem, "runs:start");
  }
  if (workItem.flowId) {
    const flowStore = openFlowStore(repoPath);
    try {
      requireRecordAccess(flowStore.getFlow(workItem.flowId), user, "flow not found");
    } finally {
      flowStore.close();
    }
  }
  const candidateSnapshot =
    user.authMode === "required" && !workItem.ownerId
      ? { ...workItem, ownerId: user.id }
      : workItem;
  const workItems = (await listUnifiedWorkItems(repoPath)).map((item) =>
    item.id === candidateSnapshot.id ? candidateSnapshot : item,
  );
  const candidateVersion = {
    ...candidate.version,
    dependencyGuards: workItemDependencyGuards(candidateSnapshot, workItems),
  };
  const starts = await evaluateWorkItemRunStarts({
    repoPath,
    repoId: repository.id,
    repoName: repository.name,
    workItems,
    candidateIds: [workItem.id],
    intent,
    providerStore,
    ...(serverInput.getChangeRequestStatus
      ? { getChangeRequestStatus: serverInput.getChangeRequestStatus }
      : {}),
  });
  const decision = starts.eligibility[workItem.id]!;
  if (decision.decision === "blocked") {
    throw new WebInputError(formatRunEligibilityError(decision));
  }
  const evaluatedInput = starts.runInputs[workItem.id];
  if (!evaluatedInput) {
    throw new Error(`eligible Work item has no evaluated Run input: ${workItem.id}`);
  }
  const runnerInput: RunFlowInput = {
    ...evaluatedInput,
    ...(taskScope ? { taskScope } : {}),
  };
  const flowDocument = runnerInput.flowDocument ??
    await readFile(runnerInput.flowPath, "utf8");
  const knowledgeControls = externalKnowledgeAdmissionControls(
    parseFlowDocument(flowDocument, {
      externalInputs: Object.keys(runnerInput.inputs),
    }).flow,
  );
  const knowledgeProviderStore = knowledgeControls
    ? await requireWebKnowledgeRunAccess({
        serverInput,
        homeRepoPath: resolve(serverInput.repoPath),
        repository,
        user,
        ...(knowledgeControls.ids ? { attachmentIds: knowledgeControls.ids } : {}),
      })
    : providerStoreForUser(serverInput, resolve(serverInput.repoPath), user);
  const admission = await admitWorkItemRun({
    repoPath,
    candidate: { workItem, version: candidateVersion },
    runInput: runnerInput,
    ...(serverInput.createRunId
      ? { createRunId: serverInput.createRunId }
      : {}),
  });
  if (admission.decision === "conflict") {
    throw runStartConflictError(admission);
  }
  const running = admission.workItem;
  const cancellation = registerActiveRunCancellation({
    repoPath,
    runId: admission.runId,
  });
  try {
    const result = await runner(
      runnerInput,
      {
        providerStore,
        knowledgeProviderStore,
        createRunId: () => admission.runId,
        cancellation: cancellation.control,
      },
    );
    assertAdmittedRunId(admission.runId, result.runId);
    if (currentProjectedRunStatus(repoPath, admission.runId) === "cancelled") {
      throw new Error(`Run ${admission.runId} was cancelled`);
    }
    if (result.status === "awaiting-approval") {
      const approval = pendingApprovalForRun(
        repository.path,
        result.runId,
        result.approvalId,
      );
      await upsertAndDispatchNotification(repository.path, serverInput, {
        sourceKey: taskSourceKey(
          workItemId,
          `approval:${result.runId}:${result.approvalId ?? approval?.id ?? "pending"}`,
        ),
        type:
          (approval?.reviewedArtifactIds ?? []).some((id) => id === "spec")
            ? "review-spec"
            : (approval?.reviewedArtifactIds ?? []).some((id) => id === "tech-design")
              ? "review-tech-design"
              : "review-rework",
        severity: "warning",
        title: "Approval required",
        body: approval?.prompt ?? "A workflow approval gate is waiting for human review.",
        taskId: workItemId,
        runId: result.runId,
        link: taskReviewLink(workItemId),
        ...(running.ownerId ? { targetUserId: running.ownerId } : {}),
        ...(running.organizationId ? { organizationId: running.organizationId } : {}),
      }, { providerStore });
      return result;
    }
    const settled = await settleWorkItemRun({
      repoPath,
      workItemId,
      runId: admission.runId,
      status: "completed",
      ...(result.changeRequestUrl
        ? { changeRequestUrl: result.changeRequestUrl }
        : {}),
    });
    if (!settled.settled) {
      throw new Error(`admitted Run no longer owns Work item: ${admission.runId}`);
    }
    return result;
  } catch (error) {
    await settleAdmittedRunAfterRunnerError(
      repoPath,
      workItemId,
      admission.runId,
      error,
    );
    throw error;
  } finally {
    cancellation.finish();
  }
}

async function listAllWorkItemViews(
  repositories: WebRepository[],
  user: WebUserContext,
) {
  const grouped = await Promise.all(
    visibleRepositories(repositories, user).map(async (repository) =>
      (await listWorkItemViews(repository.path, user)).map((view) =>
        withRepository(view, repository),
      ),
    ),
  );
  return grouped.flat().sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

async function buildAllSchedulerView(
  repositories: WebRepository[],
  user: WebUserContext,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
): Promise<SchedulerView> {
  const views = await Promise.all(
    visibleRepositories(repositories, user)
      .filter((repository) => repository.synthetic !== true)
      .map(async (repository) => {
        const workItems = await listUnifiedWorkItems(repository.path);
        const requestedCandidateIds = workItems
          .filter(
            (workItem) =>
              recordVisibleToUser(workItem, user) &&
              workItem.status === "ready",
          )
          .map((workItem) => workItem.id);
        const prepared = await prepareWorkItemRunCandidates(
          repository.path,
          workItems,
          requestedCandidateIds,
          "automatic",
        );
        const candidateIds = prepared.workItems
          .filter(
            (workItem) =>
              recordVisibleToUser(workItem, user) &&
              workItem.status === "ready",
          )
          .map((workItem) => workItem.id);
        const tasks = (
          await listWorkItemViews(
            repository.path,
            user,
            prepared.workItems,
          )
        ).map((view) => withRepository(view, repository));
        const starts = await evaluateWorkItemRunStarts({
          repoPath: repository.path,
          repoId: repository.id,
          repoName: repository.name,
          workItems: prepared.workItems,
          candidateIds,
          intent: { kind: "automatic" },
          providerStore: providerStoreForUser(input, repository.path, user),
          ...(input.getChangeRequestStatus
            ? { getChangeRequestStatus: input.getChangeRequestStatus }
            : {}),
        });
        const cooldowns = projectSchedulerCooldowns({
          cooldowns: readSchedulerCooldowns(repository.path),
          runInputs: Object.values(starts.runInputs),
          now: new Date(),
        });
        return buildSchedulerView(tasks, {
          eligibility: starts.eligibility,
          cooldowns: {
            runtimes: cooldowns.runtimes.map((cooldown) => ({
              ...cooldown,
              repoId: repository.id,
              repoName: repository.name,
              repoPath: repository.path,
            })),
            ...(cooldowns.nextWakeUp ? { nextWakeUp: cooldowns.nextWakeUp } : {}),
          },
        });
      }),
  );
  const queue: SchedulerView["queue"] = {
    running: views.flatMap((view) => view.queue.running),
    runnable: views.flatMap((view) => view.queue.runnable),
    blocked: views.flatMap((view) => view.queue.blocked),
    failed: views.flatMap((view) => view.queue.failed),
    completed: views.flatMap((view) => view.queue.completed),
    draft: views.flatMap((view) => view.queue.draft),
  };
  const sortedQueue = sortSchedulerQueue(queue);
  const nodes = views.flatMap((view) => view.nodes);
  const edges = views.flatMap((view) => view.edges);
  const nextWakeUp = views
    .map((view) => view.cooldowns.nextWakeUp)
    .filter((value): value is string => value !== undefined)
    .sort()[0];
  return {
    summary: {
      total: nodes.length,
      running: sortedQueue.running.length,
      runnable: sortedQueue.runnable.length,
      blocked: sortedQueue.blocked.length,
      failed: sortedQueue.failed.length,
      completed: sortedQueue.completed.length,
      draft: sortedQueue.draft.length,
      suggestedEdges: edges.filter((edge) => edge.kind === "suggested").length,
    },
    queue: sortedQueue,
    nodes,
    edges,
    cooldowns: {
      runtimes: views.flatMap((view) => view.cooldowns.runtimes),
      ...(nextWakeUp ? { nextWakeUp } : {}),
    },
  };
}

async function getScopedWorkItemView(
  repositories: WebRepository[],
  id: string,
  user: WebUserContext,
) {
  for (const repository of visibleRepositories(repositories, user)) {
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

async function prepareManualWorkItemDetailSnapshot(
  repoPath: string,
  id: string,
  user: WebUserContext,
) {
  const workItems = await listUnifiedWorkItems(repoPath);
  const persisted = workItems.find((workItem) => workItem.id === id);
  if (!persisted) {
    const detail = await getWorkItemView(repoPath, id, user, workItems);
    return { workItems, persisted: undefined, detail };
  }
  requireRecordAccess(persisted, user, "task not found");
  const prepared = await prepareWorkItemRunCandidates(
    repoPath,
    workItems,
    [persisted.id],
    "manual",
  );
  const preparedWorkItem =
    prepared.workItems.find((workItem) => workItem.id === persisted.id) ??
    persisted;
  requireRecordAccess(preparedWorkItem, user, "task not found");
  return {
    workItems: prepared.workItems,
    persisted: preparedWorkItem,
    detail: await getWorkItemView(repoPath, id, user, prepared.workItems),
  };
}

async function getScopedTask(
  repositories: WebRepository[],
  id: string,
  user: WebUserContext,
) {
  for (const repository of visibleRepositories(repositories, user)) {
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

async function confirmUnifiedWorkItemDependency(
  repoPath: string,
  taskId: string,
  upstreamId: string,
) {
  try {
    return await confirmWorkItemDependency(repoPath, taskId, upstreamId);
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) {
      throw error;
    }
  }
  return confirmTaskDependency(repoPath, taskId, upstreamId);
}

async function updateUnifiedWorkItemDependencies(
  repoPath: string,
  taskId: string,
  dependsOn: string[],
) {
  try {
    return await updateWorkItemDependencies(repoPath, taskId, dependsOn);
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) {
      throw error;
    }
  }
  return updateTaskDependencies(repoPath, taskId, dependsOn);
}

async function dismissUnifiedWorkItemDependencySuggestion(
  repoPath: string,
  taskId: string,
  upstreamId: string,
) {
  try {
    return await dismissWorkItemDependencySuggestion(repoPath, taskId, upstreamId);
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) {
      throw error;
    }
  }
  return dismissTaskDependencySuggestion(repoPath, taskId, upstreamId);
}

async function refreshUnifiedWorkItemDependencySuggestions(
  repoPath: string,
  taskId: string,
) {
  const workItems = await listUnifiedWorkItems(repoPath);
  const subject = workItems.find((item) => item.id === taskId);
  if (!subject) {
    throw new WebNotFoundError("task not found");
  }
  const generated = generateDependencySuggestions({
    subjectId: taskId,
    workItems,
  });
  const suggestedDependencies = mergeDependencySuggestions(
    subject.suggestedDependencies,
    generated,
  );
  try {
    return await updateWorkItemDependencySuggestions(
      repoPath,
      taskId,
      suggestedDependencies,
    );
  } catch (error) {
    if (!(error instanceof WebNotFoundError)) {
      throw error;
    }
  }
  return updateTaskDependencySuggestions(repoPath, taskId, suggestedDependencies);
}

function scheduleDependencySuggestionRefresh(repoPath: string, taskId: string): void {
  void refreshUnifiedWorkItemDependencySuggestions(repoPath, taskId).catch((error) => {
    console.warn(
      `dependency suggestion refresh failed for ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function createAcceptedRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

interface ActiveRunCancellationHandle {
  repoPath: string;
  runId: string;
  controller: AbortController;
  request?: RunCancellationRequest;
  stage?: RunCancellationStage;
  startedAt: string;
}

const activeRunCancellations = new Map<string, ActiveRunCancellationHandle>();

function activeRunCancellationKey(repoPath: string, runId: string): string {
  return `${resolve(repoPath)}\u0000${runId}`;
}

function registerActiveRunCancellation(input: {
  repoPath: string;
  runId: string;
}): {
  control: RunCancellationControl;
  finish: () => void;
} {
  const handle: ActiveRunCancellationHandle = {
    repoPath: resolve(input.repoPath),
    runId: input.runId,
    controller: new AbortController(),
    startedAt: new Date().toISOString(),
  };
  activeRunCancellations.set(
    activeRunCancellationKey(handle.repoPath, handle.runId),
    handle,
  );
  return {
    control: {
      signal: handle.controller.signal,
      getRequest: () => handle.request,
      onStageChange: (stage) => {
        handle.stage = stage;
      },
    },
    finish: () => {
      activeRunCancellations.delete(activeRunCancellationKey(handle.repoPath, handle.runId));
    },
  };
}

function requestActiveRunCancellation(input: {
  repoPath: string;
  runId: string;
  actor: string;
  reason: string;
  source: string;
  notificationId?: string;
  sourceKey?: string;
}): ActiveRunCancellationHandle | undefined {
  const handle = activeRunCancellations.get(
    activeRunCancellationKey(input.repoPath, input.runId),
  );
  if (!handle) return undefined;
  const request: RunCancellationRequest = {
    actor: input.actor,
    reason: input.reason,
    requestedAt: new Date().toISOString(),
    source: input.source,
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
  };
  handle.request = request;
  if (!handle.controller.signal.aborted) {
    handle.controller.abort(request);
  }
  return handle;
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

function runHasPinnedExternalKnowledge(repoPath: string, runId: string): boolean {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const value = projectRun(store.list(runId)).knowledgeSnapshots;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const snapshots = value as Record<string, unknown>;
    return Array.isArray(snapshots.attachments) && snapshots.attachments.length > 0;
  } finally {
    store.close();
  }
}

function pendingApprovalForRun(
  repoPath: string,
  runId: string,
  approvalId?: string,
): ReturnType<typeof projectRun>["approvals"][number] | undefined {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(runId);
    if (events.length === 0) return undefined;
    const approvals = projectRun(events).approvals;
    return approvals.find((approval) =>
      approval.status === "pending" &&
      (approvalId ? approval.id === approvalId : true),
    );
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

function notificationVisibleToUser(
  notification: NotificationRecord,
  user: WebUserContext,
): boolean {
  if (user.authMode === "local" || user.role === "admin") {
    return true;
  }
  const assignedUserId =
    notification.targetUserId ?? notification.assigneeUserId ?? notification.reviewerUserId;
  if (assignedUserId) {
    if (assignedUserId === user.id) {
      return true;
    }
    const organizationId = notification.organizationId ?? notification.teamId;
    const membership = (user.memberships ?? []).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    return membership?.role === "owner" || membership?.role === "maintainer";
  }
  if (notification.organizationId) {
    return (user.memberships ?? []).some(
      (membership) => membership.organizationId === notification.organizationId,
    );
  }
  if (notification.teamId) {
    return (user.memberships ?? []).some(
      (membership) => membership.organizationId === notification.teamId,
    );
  }
  return false;
}

function requireNotificationManageAccess(
  notification: NotificationRecord,
  user: WebUserContext,
): void {
  if (user.authMode === "local" || user.role === "admin") {
    return;
  }
  const organizationId = notification.organizationId ?? notification.teamId;
  if (organizationId) {
    const membership = (user.memberships ?? []).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (membership?.role === "owner" || membership?.role === "maintainer") {
      return;
    }
  }
  throw new WebForbiddenError("notification management access required");
}

function notificationManageableByUser(
  notification: NotificationRecord,
  user: WebUserContext,
): boolean {
  if (user.authMode === "local" || user.role === "admin") {
    return true;
  }
  const organizationId = notification.organizationId ?? notification.teamId;
  if (!organizationId) {
    return false;
  }
  const membership = (user.memberships ?? []).find(
    (candidate) => candidate.organizationId === organizationId,
  );
  return membership?.role === "owner" || membership?.role === "maintainer";
}

function canManageNotificationAssignments(user: WebUserContext): boolean {
  if (user.authMode === "local" || user.role === "admin") {
    return true;
  }
  return manageableNotificationOrganizationIds(user).length > 0;
}

function userBelongsToOrganization(user: PublicUser, organizationId: string): boolean {
  return (user.memberships ?? []).some(
    (membership) => membership.organizationId === organizationId,
  );
}

function manageableNotificationOrganizationIds(user: WebUserContext): string[] {
  return (user.memberships ?? [])
    .filter((membership) =>
      membership.role === "owner" || membership.role === "maintainer",
    )
    .map((membership) => membership.organizationId);
}

function assignmentDirectoryUsers(
  users: PublicUser[],
  currentUser: WebUserContext,
): PublicUser[] {
  if (currentUser.authMode === "local") {
    return [
      {
        id: "local",
        email: "local",
        role: "admin",
      },
    ];
  }
  if (currentUser.role === "admin") {
    return users;
  }
  const manageableIds = new Set(manageableNotificationOrganizationIds(currentUser));
  if (manageableIds.size > 0) {
    return users.filter((user) =>
      (user.memberships ?? []).some((membership) =>
        manageableIds.has(membership.organizationId),
      ),
    );
  }
  return users.filter((user) => user.id === currentUser.id);
}

async function assertAssignableUser(input: {
  repoPath: string;
  userId: string;
  organizationId?: string;
}): Promise<void> {
  const target = await getPublicUser(input.repoPath, input.userId);
  if (!target) {
    throw new WebInputError("targetUserId is not assignable");
  }
  if (
    input.organizationId &&
    !userBelongsToOrganization(target, input.organizationId)
  ) {
    throw new WebInputError("targetUserId is not assignable to this organization");
  }
}

function notificationStatusFromQuery(
  value: string | null,
): NotificationStatus | undefined {
  if (value === "pending" || value === "resolved") {
    return value;
  }
  return undefined;
}

function notificationSummary(notifications: NotificationRecord[]): {
  total: number;
  pending: number;
  resolved: number;
} {
  return {
    total: notifications.length,
    pending: notifications.filter((n) => n.status === "pending").length,
    resolved: notifications.filter((n) => n.status === "resolved").length,
  };
}

function isActionNotification(notification: NotificationRecord): boolean {
  return (
    notification.type.startsWith("review-") ||
    notification.type === "resolve-blocker"
  );
}

function isWorkflowApprovalNotificationType(type: NotificationType): boolean {
  return type === "review-spec" || type === "review-tech-design" || type === "review-rework";
}

function reviewPrResolution(status: ChangeRequestStatus): string | undefined {
  if (status.merged) return "change request merged";
  if (status.state === "closed") return "change request closed";
  return undefined;
}

function reviewPrNotificationCopy(changeRequest?: ChangeRequest): {
  title: string;
  body: string;
} {
  if (changeRequest?.draft === false) {
    return {
      title: "Review PR",
      body: "A ready PR has been published and can be reviewed before merge.",
    };
  }
  return {
    title: "Review draft PR",
    body: "A draft PR has been published and needs human review before it is ready to merge.",
  };
}

function scheduleReviewPrNotificationReconcile(input: {
  repository: WebRepository;
  notification: NotificationRecord;
  user: WebUserContext;
  serverInput?: StartWebServerInput;
}): void {
  if (
    input.repository.synthetic === true ||
    input.notification.type !== "review-pr" ||
    input.notification.status !== "pending" ||
    !input.serverInput?.getChangeRequestStatus
  ) {
    return;
  }

  const target = canonicalChangeRequestTarget(input.notification.link);
  const identity = changeRequestIdentity({
    changeRequestUrl: input.notification.link,
    repoId: input.repository.id,
    repoPath: input.repository.path,
  });
  if (!target || !identity) return;

  const state = dashboardChangeRequestStatusState(input.serverInput);
  const cacheKey = dashboardChangeRequestStatusCacheKey(
    input.user,
    input.repository.path,
    identity,
  );
  const now = Date.now();
  const cached = state.cache.get(cacheKey);
  if (cached && cached.expiresAt <= now) {
    state.cache.delete(cacheKey);
  }

  const reconcile = async (status: ChangeRequestStatus): Promise<void> => {
    try {
      const resolution = reviewPrResolution(status);
      if (!resolution) return;
      await resolveNotification(input.repository.path, input.notification.id, {
        actorId: "system",
        resolution,
      });
    } catch {
      // Best-effort reconciliation must not block or fail inbox reads.
    }
  };

  const freshCached = state.cache.get(cacheKey);
  let pending: Promise<ChangeRequestStatus> | undefined;
  if (freshCached) {
    pending = Promise.resolve(freshCached.status);
  } else {
    pending = state.inFlight.get(cacheKey);
    if (
      !pending &&
      state.limiter.active < dashboardStatusLookupConcurrency
    ) {
      const getChangeRequestStatus = input.serverInput.getChangeRequestStatus;
      pending = startDashboardChangeRequestStatusLookup({
        state,
        cacheKey,
        target: target.target,
        lookup: () => getChangeRequestStatus(target.target),
      });
    }
  }
  if (pending) {
    observePromiseOnce(
      state.reconciliations,
      `${cacheKey}\u0000${input.notification.id}`,
      pending,
      reconcile,
    );
  }
}

async function listAllNotifications(
  repositories: WebRepository[],
  user: WebUserContext,
  filter: { status?: NotificationStatus } = {},
  options: { serverInput?: StartWebServerInput } = {},
): Promise<
  Array<
    NotificationRecord & {
      deliveries: NotificationDeliveryReceipt[];
      repoId: string;
      repoName: string;
      repoPath: string;
    }
  >
> {
  const grouped = await Promise.all(
    visibleRepositories(repositories, user).map(async (repository) => {
      const visible: Array<
        NotificationRecord & {
          deliveries: NotificationDeliveryReceipt[];
          repoId: string;
          repoName: string;
          repoPath: string;
        }
      > = [];
      for (const notification of (await listNotifications(repository.path, filter))
        .filter(isActionNotification)
        .filter((candidate) => notificationVisibleToUser(candidate, user))) {
        if (!(await approvalNotificationStillCurrent(repository, notification))) {
          continue;
        }
        scheduleReviewPrNotificationReconcile({
          repository,
          notification,
          user,
          serverInput: options.serverInput,
        });
        visible.push(withNotificationRepository({
          ...notification,
          deliveries: await listNotificationDeliveryReceipts(
            repository.path,
            notification.sourceKey,
          ),
          canManage: notificationManageableByUser(notification, user),
        }, repository));
      }
      return visible;
    }),
  );
  return grouped.flat().sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

async function approvalNotificationStillCurrent(
  repository: WebRepository,
  notification: NotificationRecord,
): Promise<boolean> {
  if (!isWorkflowApprovalNotificationType(notification.type)) return true;
  const approvalSource = parseApprovalNotificationSourceKey(notification.sourceKey);
  if (!approvalSource) return true;
  const store = new EventStore(eventStorePath(repository.path));
  try {
    const events = store.list(approvalSource.runId);
    if (events.length === 0) return true;
    return projectRun(events).status === "awaiting-approval";
  } catch {
    return true;
  } finally {
    store.close();
  }
}

async function getScopedNotification(
  repositories: WebRepository[],
  id: string,
  user: WebUserContext,
): Promise<{ repository: WebRepository; notification: NotificationRecord }> {
  for (const repository of visibleRepositories(repositories, user)) {
    try {
      const notification = await getNotification(repository.path, id);
      if (!notificationVisibleToUser(notification, user)) {
        throw new WebNotFoundError("notification not found");
      }
      return { repository, notification };
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new WebNotFoundError("notification not found");
}

async function applyNotificationAssignment(input: {
  homeRepoPath: string;
  repository: WebRepository;
  notification: NotificationRecord;
  user: WebUserContext;
  targetUserId: string;
}): Promise<{
  notification: NotificationRecord;
  decision: NotificationDecisionRecord;
}> {
  requireNotificationManageAccess(input.notification, input.user);
  assertNotificationActionAllowed(input.notification, { action: "assign" });
  const targetUserId = input.targetUserId.trim();
  if (!targetUserId) {
    throw new WebInputError("targetUserId is required");
  }
  if (targetUserId.length > 500 || /[\r\n]/.test(targetUserId)) {
    throw new WebInputError(
      "notification assignment target must be a single line of 500 characters or less",
    );
  }
  const organizationId =
    input.notification.organizationId ?? input.notification.teamId;
  await assertAssignableUser({
    repoPath: input.homeRepoPath,
    userId: targetUserId,
    ...(organizationId ? { organizationId } : {}),
  });
  const notification = await assignNotification(
    input.repository.path,
    input.notification.id,
    {
      actorId: input.user.id,
      targetUserId,
      assigneeUserId: targetUserId,
      ...(organizationId ? { organizationId, teamId: organizationId } : {}),
    },
  );
  const decision = await recordNotificationDecision(
    input.repository.path,
    input.notification,
    { actorId: input.user.id, action: "assign", targetUserId },
  );
  return { notification, decision };
}

async function applyNotificationAction(input: {
  serverInput: StartWebServerInput;
  homeRepoPath: string;
  repository: WebRepository;
  notification: NotificationRecord;
  user: WebUserContext;
  action: NotificationAction;
  reason?: string;
  targetUserId?: string;
}): Promise<{
  notification: NotificationRecord;
  decision?: NotificationDecisionRecord;
}> {
  if (input.action === "assign") {
    requireNotificationManageAccess(input.notification, input.user);
  } else {
    requireWriteAccessToRecord(
      input.user,
      {
        ownerId:
          input.notification.targetUserId ??
          input.notification.assigneeUserId ??
          input.notification.reviewerUserId,
        organizationId:
          input.notification.organizationId ?? input.notification.teamId,
      },
      "notifications:resolve",
    );
  }
  const normalized = assertNotificationActionAllowed(input.notification, {
    action: input.action,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (input.notification.status === "resolved") {
    if (
      input.notification.resolution !== normalized.action ||
      (input.notification.reason ?? undefined) !== normalized.reason
    ) {
      throw new WebInputError("notification is already resolved");
    }
    const decisions = input.notification.taskId
      ? await listTaskNotificationDecisions(
          input.repository.path,
          input.notification.taskId,
        )
      : [];
    const decision = decisions
      .filter(
        (candidate) =>
          candidate.notificationId === input.notification.id &&
          candidate.action === normalized.action,
      )
      .at(-1);
    return {
      notification: input.notification,
      ...(decision ? { decision } : {}),
    };
  }
  if (normalized.action === "assign") {
    return applyNotificationAssignment({
      homeRepoPath: input.homeRepoPath,
      repository: input.repository,
      notification: input.notification,
      user: input.user,
      targetUserId: input.targetUserId ?? "",
    });
  }

  const approvalSource = parseApprovalNotificationSourceKey(
    input.notification.sourceKey,
  );
  if (
    approvalSource &&
    (normalized.action === "approve" || normalized.action === "deny")
  ) {
    await applyWorkflowApprovalAction({
      serverInput: input.serverInput,
      user: input.user,
      repository: input.repository,
      notification: input.notification,
      approvalSource,
      action: normalized.action,
    });
  } else if (
    normalized.action === "approve" &&
    !approvalSource &&
    (input.notification.type === "review-spec" ||
      input.notification.type === "review-tech-design")
  ) {
    if (!input.notification.taskId) {
      throw new WebInputError("planning review notification is missing task context");
    }
    const task = await getTask(input.repository.path, input.notification.taskId);
    requireRecordAccess(task, input.user, "task not found");
    requireWriteAccessToRecord(input.user, task, "planning:approve");
    if (input.notification.type === "review-spec") {
      if (task.source) {
        const detail = await getTaskDetail(input.repository.path, task.id);
        const readiness = evaluateSourceSpecificSpecReadiness(detail.spec);
        if (!readiness.ready) {
          throw new WebInputError(
            formatSourceSpecificSpecReadinessError(readiness),
          );
        }
      }
      await updateTaskSpecApproval(input.repository.path, task.id, "approved");
    } else {
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
      await updateTaskTechnicalDesignApproval(
        input.repository.path,
        task.id,
        "approved",
      );
    }
  } else if (
    input.notification.type === "review-memory" &&
    (normalized.action === "approve" || normalized.action === "deny")
  ) {
    if (!input.notification.proposalId) {
      throw new WebInputError("memory review notification is missing proposal context");
    }
    await updateContextKnowledgeEntry(
      input.repository.path,
      input.notification.proposalId,
      { status: normalized.action === "approve" ? "approved" : "rejected" },
    );
  } else if (normalized.action === "request-changes") {
    if (
      input.notification.type === "review-spec" ||
      input.notification.type === "review-tech-design"
    ) {
      if (!input.notification.taskId || !normalized.reason) {
        throw new WebInputError("planning review notification is missing task context");
      }
      await requestTaskPlanningChanges(
        input.repository.path,
        input.notification.taskId,
        input.notification.type === "review-spec" ? "spec" : "tech-design",
        { actor: input.user.id, reason: normalized.reason },
      );
    } else if (
      input.notification.type !== "review-memory" &&
      input.notification.type !== "review-rework" &&
      input.notification.type !== "review-pr"
    ) {
      throw new WebInputError("request-changes requires a review notification");
    }
  } else if (normalized.action === "cancel-run") {
    if (!input.notification.runId || !normalized.reason) {
      throw new WebInputError("cancel-run requires a linked run and reason");
    }
    const activeCancellation = requestActiveRunCancellation({
      repoPath: input.repository.path,
      runId: input.notification.runId,
      actor: input.user.id,
      reason: normalized.reason,
      source: "web-notification",
      notificationId: input.notification.id,
      sourceKey: input.notification.sourceKey,
    });
    const store = new EventStore(eventStorePath(input.repository.path));
    try {
      const events = store.list(input.notification.runId);
      if (events.length === 0) {
        throw new WebInputError("linked run was not found");
      }
      const status = projectRun(events, {
        openAttemptStatus: "interrupted",
      }).status;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        throw new WebInputError(`linked run is already ${status}`);
      }
      store.append({
        runId: input.notification.runId,
        ...(activeCancellation?.stage?.stageId
          ? { stageId: activeCancellation.stage.stageId }
          : {}),
        ...(activeCancellation?.stage?.attempt !== undefined
          ? { attempt: activeCancellation.stage.attempt }
          : {}),
        type: "run.cancelled",
        payload: {
          actor: input.user.id,
          notificationId: input.notification.id,
          sourceKey: input.notification.sourceKey,
          reason: normalized.reason,
          requestedAt: activeCancellation?.request?.requestedAt ?? new Date().toISOString(),
          cancelledAt: new Date().toISOString(),
          source: "web-notification",
          affectedStage: activeCancellation?.stage?.stageId,
          affectedAttempt: activeCancellation?.stage?.attempt,
          cleanup: activeCancellation
            ? {
                result: "abort-signal-dispatched",
                activeSince: activeCancellation.startedAt,
                terminateWithinMs: 10_000,
              }
            : {
                result: "no-active-process",
              },
        },
      });
    } finally {
      store.close();
    }
    if (input.notification.taskId) {
      await settleOrUpdateUnifiedRun(
        input.repository.path,
        input.notification.taskId,
        input.notification.runId,
        {
          status: "failed",
        },
      );
    }
  } else if (normalized.action === "override") {
    // An override dismisses the inbox item with evidence. It deliberately
    // does not claim that the linked blocker recovered or resume the run.
  } else if (
    normalized.action === "resolve" ||
    normalized.action === "deny" ||
    normalized.action === "approve"
  ) {
    // Review sources without a directly mutable local artifact are resolved
    // with durable evidence. Their source workflow remains authoritative.
  } else {
    throw new WebInputError(
      `notification action ${normalized.action} is not implemented`,
    );
  }
  const decision = await recordNotificationDecision(
    input.repository.path,
    input.notification,
    {
      actorId: input.user.id,
      action: normalized.action,
      reason: normalized.reason,
    },
  );
  const notification = await resolveNotification(
    input.repository.path,
    input.notification.id,
    {
      actorId: input.user.id,
      resolution: normalized.action,
      reason: normalized.reason,
    },
  );
  return { notification, decision };
}

function taskSourceKey(taskId: string, kind: string): string {
  return `task:${taskId}:${kind}`;
}

async function upsertAndDispatchNotification(
  repoPath: string,
  input: StartWebServerInput,
  notificationInput: UpsertNotificationInput,
  options: { providerStore?: ProviderConnectionStore } = {},
): Promise<NotificationRecord> {
  const notification = await upsertNotification(repoPath, notificationInput);
  let httpTargets: NotificationDeliveryTarget[] = [];
  try {
    httpTargets = configuredHttpNotificationTargets(
      input.providerEnv ?? process.env,
    );
  } catch {
    // Invalid optional delivery configuration must not break the local inbox.
  }
  const sourceTargets: NotificationDeliveryTarget[] = [];
  if (notification.taskId) {
    try {
      const task = await getTask(repoPath, notification.taskId);
      const source = task.source;
      const publicBaseUrl = source?.statusSync?.publicBaseUrl;
      if (source?.statusSync?.enabled && source.uri && publicBaseUrl) {
        const providerStore = options.providerStore ?? getProviderStore(input, repoPath);
        if (source.type === "github-issue") {
          const mirrorUrl =
            notification.type === "review-pr" &&
            /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/i.test(
              notification.link,
            )
              ? notification.link
              : source.uri;
          sourceTargets.push(
            createGitHubIssueNotificationTarget({
              repoPath,
              issueUrl: mirrorUrl,
              publicBaseUrl,
              provider:
                input.notificationScmProvider ??
                createScmProvider("github", { store: providerStore }),
            }),
          );
        } else if (source.type === "jira-ticket") {
          const jiraBaseUrl = await configuredJiraBaseUrl(providerStore);
          sourceTargets.push(
            createJiraNotificationTarget({
              issueUrl: source.uri,
              jiraBaseUrl,
              publicBaseUrl,
              publisher:
                input.jiraStatusPublisher ??
                ((reference, update) =>
                  defaultJiraStatusPublisher(reference, update, { providerStore })),
            }),
          );
        }
      }
    } catch {
      // Source mirroring is best effort; the in-app record remains authoritative.
    }
  }
  await dispatchNotificationDeliveries(repoPath, notification, [
    ...sourceTargets,
    ...(input.notificationDeliveryTargets ?? []),
    ...httpTargets,
  ]);
  return notification;
}

function taskReviewLink(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

function parseApprovalNotificationSourceKey(
  sourceKey: string,
): { taskId: string; runId: string; approvalId: string } | undefined {
  const match = /^task:([^:]+):approval:([^:]+):(.+)$/.exec(sourceKey);
  if (!match) return undefined;
  return {
    taskId: match[1],
    runId: match[2],
    approvalId: match[3],
  };
}

async function applyWorkflowApprovalAction(input: {
  serverInput: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">;
  user: WebUserContext;
  repository: WebRepository;
  notification: NotificationRecord;
  approvalSource: { taskId: string; runId: string; approvalId: string };
  action: "approve" | "deny";
}): Promise<void> {
  requireWriteAccessToRecord(
    input.user,
    {
      ownerId: input.notification.targetUserId,
      organizationId: input.notification.organizationId,
    },
    "planning:approve",
  );
  const resumesWithKnowledge = input.action === "approve" &&
    runHasPinnedExternalKnowledge(
      input.repository.path,
      input.approvalSource.runId,
    );
  const knowledgeProviderStore = input.action !== "approve"
    ? undefined
    : resumesWithKnowledge
      ? await requireWebKnowledgeRunAccess({
          serverInput: input.serverInput,
          homeRepoPath: resolve(input.serverInput.repoPath),
          repository: input.repository,
          user: input.user,
          pinnedRun: true,
        })
      : providerStoreForUser(
          input.serverInput,
          resolve(input.serverInput.repoPath),
          input.user,
        );
  await resolveApproval({
    repoPath: input.repository.path,
    runId: input.approvalSource.runId,
    approvalId: input.approvalSource.approvalId,
    decision: input.action === "approve" ? "approved" : "denied",
    actor: input.user.id,
  });

  const taskId = input.notification.taskId;
  if (input.action === "deny") {
    if (taskId) {
      ensureRunFailedEvent(
        input.repository.path,
        input.approvalSource.runId,
        new Error(`approval ${input.approvalSource.approvalId} denied`),
      );
      await settleOrUpdateUnifiedRun(
        input.repository.path,
        taskId,
        input.approvalSource.runId,
        { status: "failed" },
      );
    }
    return;
  }
  if (!taskId) return;

  const providerStore = providerStoreForUser(
    input.serverInput,
    input.repository.path,
    input.user,
  );
  const execution = webExecutionBackendPolicyForInput(
    input.serverInput,
    input.user.authMode,
  );
  void (async () => {
    try {
      const result = await resumeRun(
        {
          repoPath: input.repository.path,
          runId: input.approvalSource.runId,
          executionBackend: execution.backend,
        },
        { providerStore, knowledgeProviderStore: knowledgeProviderStore! },
      );
      if (result.status === "awaiting-approval") {
        const approval = pendingApprovalForRun(
          input.repository.path,
          result.runId,
          result.approvalId,
        );
        await updateUnifiedRunState(input.repository.path, taskId, {
          status: "running",
          latestRunId: result.runId,
        });
        await upsertAndDispatchNotification(
          input.repository.path,
          input.serverInput,
          {
            sourceKey: taskSourceKey(
              taskId,
              `approval:${result.runId}:${result.approvalId ?? approval?.id ?? "pending"}`,
            ),
            type:
              (approval?.reviewedArtifactIds ?? []).some((id) => id === "spec")
                ? "review-spec"
                : (approval?.reviewedArtifactIds ?? []).some(
                      (id) => id === "tech-design",
                    )
                  ? "review-tech-design"
                  : "review-rework",
            severity: "warning",
            title: "Approval required",
            body:
              approval?.prompt ??
              "A workflow approval gate is waiting for human review.",
            taskId,
            runId: result.runId,
            link: taskReviewLink(taskId),
            ...(approval?.reviewedArtifactIds?.[0]
              ? { artifactId: approval.reviewedArtifactIds[0] }
              : {}),
            ...(input.notification.targetUserId
              ? { targetUserId: input.notification.targetUserId }
              : {}),
            ...(input.notification.organizationId
              ? { organizationId: input.notification.organizationId }
              : {}),
          },
          { providerStore },
        );
        return;
      }
      const stillOwnsWorkItem = await settleOrUpdateUnifiedRun(
        input.repository.path,
        taskId,
        result.runId,
        {
          status: "completed",
          ...(result.changeRequestUrl
            ? { changeRequestUrl: result.changeRequestUrl }
            : {}),
        },
      );
      if (result.changeRequestUrl && stillOwnsWorkItem) {
        const notificationCopy = reviewPrNotificationCopy(result.changeRequest);
        await upsertAndDispatchNotification(
          input.repository.path,
          input.serverInput,
          {
            sourceKey: taskSourceKey(taskId, `draft-pr:${result.runId}`),
            type: "review-pr",
            severity: "info",
            title: notificationCopy.title,
            body: notificationCopy.body,
            taskId,
            runId: result.runId,
            link: result.changeRequestUrl,
            ...(input.notification.targetUserId
              ? { targetUserId: input.notification.targetUserId }
              : {}),
            ...(input.notification.organizationId
              ? { organizationId: input.notification.organizationId }
              : {}),
          },
          { providerStore },
        );
      }
      ensureRunCompletedEvent(input.repository.path, result);
    } catch (error) {
      ensureRunFailedEvent(
        input.repository.path,
        input.approvalSource.runId,
        error,
      );
      const stillOwnsWorkItem =
        currentProjectedRunStatus(
          input.repository.path,
          input.approvalSource.runId,
        ) === "blocked"
          ? (await getUnifiedWorkItem(input.repository.path, taskId)).latestRunId ===
            input.approvalSource.runId
          : await settleOrUpdateUnifiedRun(
              input.repository.path,
              taskId,
              input.approvalSource.runId,
              { status: "failed" },
            );
      if (stillOwnsWorkItem) {
        await upsertAndDispatchNotification(
          input.repository.path,
          input.serverInput,
          {
            sourceKey: taskSourceKey(
              taskId,
              `run-blocked:${input.approvalSource.runId}`,
            ),
            type: "resolve-blocker",
            severity: "blocker",
            title: "Run needs human input",
            body: error instanceof Error ? error.message : String(error),
            taskId,
            runId: input.approvalSource.runId,
            link: taskReviewLink(taskId),
            ...(input.notification.targetUserId
              ? { targetUserId: input.notification.targetUserId }
              : {}),
            ...(input.notification.organizationId
              ? { organizationId: input.notification.organizationId }
              : {}),
          },
          { providerStore },
        );
      }
    }
  })();
}

function appendAcceptedRunCreated(input: {
  repoPath: string;
  runId: string;
  branchName: string;
  flowPath: string;
  repoId?: string;
  repoName?: string;
  inputs: RunFlowInput["inputs"];
  configuration?: RunFlowInput["configuration"];
  workItemId: string;
  workItemType?: string;
  ownerId?: string;
  organizationId?: string;
  planningApproval?: RunFlowInput["planningApproval"];
  runEligibilityOverride?: RunFlowInput["runEligibilityOverride"];
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
      configuration: input.configuration,
      branchName: input.branchName,
      workItemId: input.workItemId,
      workItemType: input.workItemType,
      ownerId: input.ownerId,
      organizationId: input.organizationId,
      planningApproval: input.planningApproval,
      runEligibilityOverride: input.runEligibilityOverride,
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
      ...(runInput.configuration ? { configuration: runInput.configuration } : {}),
      workItemId: runInput.workItemId,
      workItemType: runInput.workItemType,
      ...(runInput.ownerId ? { ownerId: runInput.ownerId } : {}),
      ...(runInput.organizationId ? { organizationId: runInput.organizationId } : {}),
      ...(runInput.planningApproval
        ? { planningApproval: runInput.planningApproval }
        : {}),
      ...(runInput.runEligibilityOverride
        ? { runEligibilityOverride: runInput.runEligibilityOverride }
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

async function settleAdmittedRunAfterRunnerError(
  repoPath: string,
  workItemId: string,
  runId: string,
  error: unknown,
): Promise<"blocked" | "completed" | "failed"> {
  ensureRunFailedEvent(repoPath, runId, error);
  const projectedStatus = currentProjectedRunStatus(repoPath, runId);
  if (projectedStatus === "blocked") {
    return "blocked";
  }
  const status = projectedStatus === "completed" ? "completed" : "failed";
  await settleWorkItemRun({
    repoPath,
    workItemId,
    runId,
    status,
  });
  return status;
}

async function startConfirmedTaskReworkRun(input: {
  serverInput: StartWebServerInput;
  repository: WebRepository;
  task: TaskRecord;
  request: TaskReworkRequest;
  runner: NonNullable<StartWebServerInput["runFlow"]>;
  providerStore: ProviderConnectionStore;
}): Promise<AcceptedRunMetadata | RunFlowResult> {
  if (input.request.runId && input.request.status === "running") {
    return {
      runId: input.request.runId,
      status: "running",
      taskId: input.task.id,
      repoId: input.repository.id,
    };
  }
  const materialized = await materializeTaskReworkRequestInputs(
    input.repository.path,
    input.request,
  );
  const stored = await getTaskSnapshot(input.repository.path, input.task.id);
  const taskSnapshot: TaskRecord = {
    ...stored.record,
    activePlanningBaseline: input.request.planningBaseline,
  };
  const reworkWorkItem = {
    ...projectWorkItem(taskSnapshot),
    flowPath: input.request.flowPath,
    inputs: materialized.inputs,
    changeRequestUrl: input.request.changeRequest.url,
  };
  const workItems = (await listUnifiedWorkItems(input.repository.path)).map(
    (workItem) => workItem.id === reworkWorkItem.id ? reworkWorkItem : workItem,
  );
  const candidateVersion = {
    ...stored.version,
    dependencyGuards: workItemDependencyGuards(reworkWorkItem, workItems),
  };
  const runnerInput: RunFlowInput = {
    flowPath: input.request.flowPath,
    repoPath: input.repository.path,
    repoId: input.repository.id,
    repoName: input.repository.name,
    inputs: materialized.inputs,
    ownerId: input.task.ownerId,
    organizationId: input.task.organizationId,
    workItemId: input.task.id,
    workItemType: reworkWorkItem.workItemType,
    planningApproval: reworkWorkItem.planning,
    priorRunId: input.request.priorRunId,
    trigger: {
      type: "task-rework-request",
      taskId: input.task.id,
      requestId: input.request.id,
      routeTarget: input.request.route.target,
      instruction: input.request.instruction,
      priorRunId: input.request.priorRunId,
      changeRequestUrl: input.request.changeRequest.url,
      actorId: input.request.actor.id,
    },
    changeRequestTarget: {
      provider: "github-cli",
      target: input.request.changeRequest.target,
    },
  };
  const admission = await admitWorkItemRun({
    repoPath: input.repository.path,
    candidate: {
      workItem: reworkWorkItem,
      version: candidateVersion,
    },
    runInput: runnerInput,
    legacyState: {
      activePlanningBaseline: input.request.planningBaseline,
    },
    ...(input.serverInput.createRunId
      ? { createRunId: input.serverInput.createRunId }
      : {}),
  });
  if (admission.decision === "conflict") {
    throw runStartConflictError(admission);
  }
  const runningRequest = await markTaskReworkRequestRunning({
    repoPath: input.repository.path,
    taskId: input.task.id,
    requestId: input.request.id,
    runId: admission.runId,
  });
  const acceptedRun: AcceptedRunMetadata = {
    runId: admission.runId,
    status: "running",
    taskId: input.task.id,
    repoId: input.repository.id,
    branchName: admission.branchName,
  };
  const cancellation = registerActiveRunCancellation({
    repoPath: input.repository.path,
    runId: admission.runId,
  });
  let runnerExecution: Promise<RunFlowResult>;
  try {
    runnerExecution = input.runner(runnerInput, {
      providerStore: input.providerStore,
      createRunId: () => admission.runId,
      cancellation: cancellation.control,
    });
  } catch (error) {
    runnerExecution = Promise.reject(error);
  }
  const runnerPromise = (async () => {
    try {
      const result = await runnerExecution;
      assertAdmittedRunId(admission.runId, result.runId);
      if (currentProjectedRunStatus(input.repository.path, admission.runId) === "cancelled") {
        throw new Error(`Run ${admission.runId} was cancelled`);
      }
      if (result.status === "awaiting-approval") {
        const approval = pendingApprovalForRun(
          input.repository.path,
          result.runId,
          result.approvalId,
        );
        await upsertAndDispatchNotification(input.repository.path, input.serverInput, {
          sourceKey: taskSourceKey(
            input.task.id,
            `rework-approval:${runningRequest.id}:${result.runId}:${result.approvalId ?? approval?.id ?? "pending"}`,
          ),
          type: "review-rework",
          severity: "warning",
          title: "Approval required",
          body: approval?.prompt ?? "A Task rework run is waiting for human approval.",
          taskId: input.task.id,
          runId: result.runId,
          link: taskReviewLink(input.task.id),
          ...(input.task.ownerId ? { targetUserId: input.task.ownerId } : {}),
          ...(input.task.organizationId
            ? { organizationId: input.task.organizationId }
            : {}),
        }, { providerStore: input.providerStore });
        return result;
      }
      const settled = await settleWorkItemRun({
        repoPath: input.repository.path,
        workItemId: input.task.id,
        runId: admission.runId,
        status: "completed",
        ...(result.changeRequestUrl
          ? { changeRequestUrl: result.changeRequestUrl }
          : { changeRequestUrl: input.request.changeRequest.url }),
      });
      if (!settled.settled) {
        throw new Error(`admitted Run no longer owns Task: ${admission.runId}`);
      }
      await settleTaskReworkRequest({
        repoPath: input.repository.path,
        taskId: input.task.id,
        requestId: runningRequest.id,
        status: "completed",
        resultChangeRequestUrl:
          result.changeRequestUrl ?? input.request.changeRequest.url,
      });
      const notificationCopy = reviewPrNotificationCopy(result.changeRequest);
      await upsertAndDispatchNotification(input.repository.path, input.serverInput, {
        sourceKey: taskSourceKey(input.task.id, `task-rework-pr:${runningRequest.id}`),
        type: "review-pr",
        severity: "info",
        title: notificationCopy.title,
        body: notificationCopy.body,
        taskId: input.task.id,
        runId: result.runId,
        link: result.changeRequestUrl ?? input.request.changeRequest.url,
        ...(input.task.ownerId ? { targetUserId: input.task.ownerId } : {}),
        ...(input.task.organizationId
          ? { organizationId: input.task.organizationId }
          : {}),
      }, { providerStore: input.providerStore });
      ensureRunCompletedEvent(input.repository.path, result, runnerInput);
      return result;
    } catch (error) {
      await settleAdmittedRunAfterRunnerError(
        input.repository.path,
        input.task.id,
        admission.runId,
        error,
      );
      await settleTaskReworkRequest({
        repoPath: input.repository.path,
        taskId: input.task.id,
        requestId: runningRequest.id,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      await upsertAndDispatchNotification(input.repository.path, input.serverInput, {
        sourceKey: taskSourceKey(input.task.id, `task-rework-blocked:${runningRequest.id}`),
        type: "resolve-blocker",
        severity: "blocker",
        title: "Task rework run needs human input",
        body: error instanceof Error ? error.message : String(error),
        taskId: input.task.id,
        runId: admission.runId,
        link: taskReviewLink(input.task.id),
        ...(input.task.ownerId ? { targetUserId: input.task.ownerId } : {}),
        ...(input.task.organizationId
          ? { organizationId: input.task.organizationId }
          : {}),
      }, { providerStore: input.providerStore });
      throw error;
    } finally {
      cancellation.finish();
    }
  })();
  void runnerPromise.catch(() => {});
  const earlyRunnerFailure = runnerExecution.then(
    () => new Promise<never>(() => {}),
    (error) => Promise.reject(error),
  );
  void earlyRunnerFailure.catch(() => {});
  return await Promise.race([
    runnerPromise,
    earlyRunnerFailure,
    new Promise<AcceptedRunMetadata>((resolveAccepted) => {
      setImmediate(() => resolveAccepted(acceptedRun));
    }),
  ]);
}

async function runStoredWorkItemAcrossRepositories(
  repositories: WebRepository[],
  serverInput: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  workItemId: string,
  user: WebUserContext,
  runner: NonNullable<StartWebServerInput["runFlow"]>,
  notFoundMessage: string,
  intent: RunEligibilityIntent,
  taskScope?: RunFlowInput["taskScope"],
): Promise<RunFlowResult> {
  for (const repository of visibleRepositories(repositories, user)) {
    try {
      const providerStore = providerStoreForUser(
        serverInput,
        repository.path,
        user,
      );
      return await runStoredWorkItem(
        repository,
        serverInput,
        workItemId,
        user,
        providerStore,
        runner,
        notFoundMessage,
        intent,
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

async function updateUnifiedRunState(
  repoPath: string,
  id: string,
  patch: Parameters<typeof updateWorkItem>[2],
  storeKind?: WorkItemStoreKind,
): Promise<void> {
  if (storeKind === "generic") {
    await updateWorkItem(repoPath, id, patch);
    return;
  }
  if (storeKind !== "legacy-dev-pr") {
    try {
      await updateWorkItem(repoPath, id, patch);
      return;
    } catch (error) {
      if (!(error instanceof WebNotFoundError)) {
        throw error;
      }
    }
  }
  if (!patch.status) {
    throw new Error(`legacy task run-state update requires status: ${id}`);
  }
  await updateTaskRunState(repoPath, id, {
    status: patch.status,
    ...(patch.latestRunId !== undefined ? { latestRunId: patch.latestRunId } : {}),
    ...(patch.changeRequestUrl !== undefined
      ? { changeRequestUrl: patch.changeRequestUrl }
      : {}),
  });
}

async function settleOrUpdateUnifiedRun(
  repoPath: string,
  workItemId: string,
  runId: string,
  patch: {
    status: "completed" | "failed";
    changeRequestUrl?: string;
  },
): Promise<boolean> {
  const result = await settleWorkItemRun({
    repoPath,
    workItemId,
    runId,
    status: patch.status,
    ...(patch.changeRequestUrl
      ? { changeRequestUrl: patch.changeRequestUrl }
      : {}),
  });
  if (result.settled) return true;
  if (
    result.reason !== "not-admitted" ||
    result.workItem.latestRunId !== runId
  ) {
    return false;
  }
  await updateUnifiedRunState(
    repoPath,
    workItemId,
    {
      status: patch.status,
      latestRunId: runId,
      ...(patch.changeRequestUrl
        ? { changeRequestUrl: patch.changeRequestUrl }
        : {}),
    },
    result.storeKind,
  );
  return true;
}

async function listAllRuns(
  repositories: WebRepository[],
  user: WebUserContext,
  options: ListRunsOptions = {},
) {
  const grouped = await Promise.all(
    visibleRepositories(repositories, user).map(async (repository) =>
      (await listRuns(repository.path, options))
        .filter((run) => recordVisibleToUser(run, user))
        .map((run) => withRepository(run, repository)),
    ),
  );
  return grouped.flat().sort((left, right) =>
    right.runId.localeCompare(left.runId),
  );
}

/** Bound recent-run enrichment for Agent Stability (toolchain preflight only). */
const AGENT_STABILITY_PREFLIGHT_LIMIT = 40;

async function enrichRunsForAgentStability(
  runs: WebRunSummary[],
): Promise<AgentStabilityRunInput[]> {
  const candidates = runs
    .filter((run) => run.repoSynthetic !== true)
    .slice(0, AGENT_STABILITY_PREFLIGHT_LIMIT);

  const preflightByKey = new Map<string, NonNullable<AgentStabilityRunInput["toolchainPreflight"]>>();
  await Promise.all(
    candidates.map(async (run) => {
      const repoPath = run.repoPath;
      if (!repoPath) return;
      const runDirectory = join(repoPath, ".nitely", "runs", run.runId);
      try {
        const preflight = await readToolchainPreflight({ runDirectory });
        if (preflight) {
          preflightByKey.set(`${repoPath}\u0000${run.runId}`, preflight);
        }
      } catch {
        // Missing or unreadable preflight stays unknown.
      }
    }),
  );

  return runs.map((run) => {
    const key =
      run.repoPath !== undefined
        ? `${run.repoPath}\u0000${run.runId}`
        : undefined;
    const toolchainPreflight = key ? preflightByKey.get(key) : undefined;
    const input: AgentStabilityRunInput = {
      ...run,
      ...(toolchainPreflight ? { toolchainPreflight } : {}),
    };
    return input;
  });
}

interface DashboardChangeRequestTarget {
  key: string;
  identity: string;
  target: string;
  repoPath: string;
}

function dashboardChangeRequestTarget(
  run: WebRunSummary,
  defaultRepoPath: string,
): DashboardChangeRequestTarget | undefined {
  const canonical = canonicalChangeRequestTarget(
    run.changeRequestUrl ?? run.prUrl,
  );
  const identity = changeRequestIdentity(run);
  if (!canonical || !identity) return undefined;
  const repoPath = run.repoPath ?? defaultRepoPath;
  return {
    key: `${repoPath}\u0000${identity}`,
    identity,
    target: canonical.target,
    repoPath,
  };
}

function dashboardRunScopeKey(
  run: WebRunSummary,
  defaultRepoPath: string,
): string {
  return `${run.repoPath ?? defaultRepoPath}\u0000${run.runId}`;
}

interface DashboardChangeRequestStatusCacheEntry {
  status: ChangeRequestStatus;
  expiresAt: number;
}

interface DashboardChangeRequestStatusState {
  cache: Map<string, DashboardChangeRequestStatusCacheEntry>;
  inFlight: Map<string, Promise<ChangeRequestStatus>>;
  reconciliations: Set<string>;
  limiter: DashboardChangeRequestStatusLimiter;
}

interface DashboardChangeRequestStatusLimiter {
  active: number;
}

const dashboardChangeRequestStatusStates = new WeakMap<
  object,
  DashboardChangeRequestStatusState
>();
const injectedDashboardChangeRequestStatusLimiters = new WeakMap<
  ChangeRequestStatusFetcher,
  DashboardChangeRequestStatusLimiter
>();
const defaultDashboardChangeRequestStatusLimiter: DashboardChangeRequestStatusLimiter = {
  active: 0,
};
const dashboardKnownStatusCacheMs = 60_000;
const dashboardUnknownStatusCacheMs = 10_000;
const dashboardStatusLookupTimeoutMs = 5_000;
const dashboardStatusLookupConcurrency = 4;

function dashboardChangeRequestStatusState(
  input: StartWebServerInput,
): DashboardChangeRequestStatusState {
  const existing = dashboardChangeRequestStatusStates.get(input);
  if (existing) return existing;
  let limiter = defaultDashboardChangeRequestStatusLimiter;
  if (input.getChangeRequestStatus) {
    limiter = injectedDashboardChangeRequestStatusLimiters.get(
      input.getChangeRequestStatus,
    ) ?? { active: 0 };
    injectedDashboardChangeRequestStatusLimiters.set(
      input.getChangeRequestStatus,
      limiter,
    );
  }
  const created: DashboardChangeRequestStatusState = {
    cache: new Map(),
    inFlight: new Map(),
    reconciliations: new Set(),
    limiter,
  };
  dashboardChangeRequestStatusStates.set(input, created);
  return created;
}

async function withDashboardStatusLookupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new Error("change request status lookup timed out");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("change request status lookup timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function unknownDashboardChangeRequestStatus(
  target: string,
): ChangeRequestStatus {
  return {
    provider: "unknown",
    url: target,
    state: "unknown",
    merged: false,
  };
}

function dashboardChangeRequestStatusKnown(status: ChangeRequestStatus): boolean {
  const state = status.state.trim().toLowerCase();
  return status.provider === "github" && Boolean(state) && state !== "unknown";
}

function cacheDashboardChangeRequestStatus(
  state: DashboardChangeRequestStatusState,
  key: string,
  status: ChangeRequestStatus,
): ChangeRequestStatus {
  state.cache.set(key, {
    status,
    expiresAt:
      Date.now() +
      (dashboardChangeRequestStatusKnown(status)
        ? dashboardKnownStatusCacheMs
        : dashboardUnknownStatusCacheMs),
  });
  return status;
}

function dashboardChangeRequestStatusCacheKey(
  user: WebUserContext,
  repoPath: string,
  identity: string,
): string {
  return `${user.id}\u0000${repoPath}\u0000${identity}`;
}

function startDashboardChangeRequestStatusLookup(input: {
  state: DashboardChangeRequestStatusState;
  cacheKey: string;
  target: string;
  lookup: () => Promise<ChangeRequestStatus>;
}): Promise<ChangeRequestStatus> {
  input.state.limiter.active += 1;
  const pending = Promise.resolve()
    .then(input.lookup)
    .catch(() => unknownDashboardChangeRequestStatus(input.target))
    .then((status) =>
      cacheDashboardChangeRequestStatus(input.state, input.cacheKey, status),
    )
    .finally(() => {
      input.state.limiter.active -= 1;
      input.state.inFlight.delete(input.cacheKey);
    });
  input.state.inFlight.set(input.cacheKey, pending);
  return pending;
}

async function enrichDashboardChangeRequestStatuses(
  runs: WebRunSummary[],
  user: WebUserContext,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  eligibleRunKeys?: ReadonlySet<string>,
): Promise<WebRunSummary[]> {
  const targets = new Map<string, DashboardChangeRequestTarget>();
  for (const run of runs) {
    if (
      run.repoSynthetic === true ||
      (eligibleRunKeys &&
        !eligibleRunKeys.has(dashboardRunScopeKey(run, input.repoPath)))
    ) {
      continue;
    }
    const target = dashboardChangeRequestTarget(run, input.repoPath);
    if (!target || targets.has(target.key)) continue;
    targets.set(target.key, target);
  }
  if (targets.size === 0) return runs;

  const statuses = new Map<string, ChangeRequestStatus>();
  const providers = new Map<string, ReturnType<typeof createScmProvider>>();
  const state = dashboardChangeRequestStatusState(input);
  const cacheNow = Date.now();
  const deadline = cacheNow + dashboardStatusLookupTimeoutMs;
  for (const [key, cached] of state.cache) {
    if (cached.expiresAt <= cacheNow) state.cache.delete(key);
  }
  const entries = [...targets.values()];
  let cursor = 0;
  const fetchStatus = async (
    entry: DashboardChangeRequestTarget,
  ): Promise<ChangeRequestStatus> => {
    try {
      if (input.getChangeRequestStatus) {
        return await input.getChangeRequestStatus(entry.target);
      }
      let provider = providers.get(entry.repoPath);
      if (!provider) {
        provider = createScmProvider("github", {
          store: providerStoreForUser(input, entry.repoPath, user),
        });
        providers.set(entry.repoPath, provider);
      }
      return provider.getChangeRequestStatus
        ? await provider.getChangeRequestStatus({ target: entry.target })
        : unknownDashboardChangeRequestStatus(entry.target);
    } catch {
      return unknownDashboardChangeRequestStatus(entry.target);
    }
  };
  const startLookup = (
    entry: DashboardChangeRequestTarget,
    cacheKey: string,
  ): Promise<ChangeRequestStatus> =>
    startDashboardChangeRequestStatusLookup({
      state,
      cacheKey,
      target: entry.target,
      lookup: () => fetchStatus(entry),
    });
  const lookup = async (entry: DashboardChangeRequestTarget) => {
    const cacheKey = dashboardChangeRequestStatusCacheKey(
      user,
      entry.repoPath,
      entry.identity,
    );
    const now = Date.now();
    const cached = state.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.status;
    if (now >= deadline) {
      return cacheDashboardChangeRequestStatus(
        state,
        cacheKey,
        unknownDashboardChangeRequestStatus(entry.target),
      );
    }
    let pending = state.inFlight.get(cacheKey);
    if (
      !pending &&
      state.limiter.active < dashboardStatusLookupConcurrency
    ) {
      pending = startLookup(entry, cacheKey);
    }
    if (!pending) {
      return cacheDashboardChangeRequestStatus(
        state,
        cacheKey,
        unknownDashboardChangeRequestStatus(entry.target),
      );
    }
    try {
      return await withDashboardStatusLookupTimeout(
        pending,
        deadline - Date.now(),
      );
    } catch {
      return cacheDashboardChangeRequestStatus(
        state,
        cacheKey,
        unknownDashboardChangeRequestStatus(entry.target),
      );
    }
  };
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor];
      cursor += 1;
      if (!entry) continue;
      statuses.set(entry.key, await lookup(entry));
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          dashboardStatusLookupConcurrency,
          entries.length,
        ),
      },
      async () => await worker(),
    ),
  );

  return runs.map((run) => {
    const target = dashboardChangeRequestTarget(run, input.repoPath);
    const changeRequestStatus = target ? statuses.get(target.key) : undefined;
    return changeRequestStatus ? { ...run, changeRequestStatus } : run;
  });
}

async function getScopedRunDetail(
  repositories: WebRepository[],
  homeRepoPath: string,
  input: Required<Pick<StartWebServerInput, "host" | "port">> &
    Omit<StartWebServerInput, "host" | "port">,
  runId: string,
  user: WebUserContext,
) {
  for (const repository of visibleRepositories(repositories, user)) {
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

function parseProviderAuthMethod(
  providerId: ProviderId,
  raw: unknown,
): ProviderAuthMethod {
  const descriptor = findDescriptor(providerId);
  const method = descriptor.authMethods.find((m) => m.method === raw);
  if (!method) {
    throw new WebInputError(
      `provider ${providerId} does not support auth method ${String(raw)}`,
    );
  }
  return method.method;
}

/**
 * A pasted secret may only land on a method that is established by pasting.
 * OAuth account connections come from the provider's connect flow, so a
 * value posted against them is rejected rather than stored as if it were one.
 */
function parsePastedProviderAuthMethod(
  providerId: ProviderId,
  raw: unknown,
): ProviderAuthMethod | undefined {
  if (raw === undefined) return undefined;
  const method = parseProviderAuthMethod(providerId, raw);
  const descriptor = findAuthMethod(findDescriptor(providerId), method);
  if (descriptor.flow === "redirect") {
    throw new WebInputError(
      `provider ${providerId} auth method ${method} is established through its connect flow, not by pasting a value`,
    );
  }
  if (!descriptor.writable) {
    throw new WebInputError(
      `provider ${providerId} auth method ${method} cannot be stored via Web Console`,
    );
  }
  return method;
}

function publicProviderConnection(record: ProviderConnectionRecord): ProviderConnectionSummary {
  return {
    id: record.id,
    authMethod: record.authMethod,
    ...(record.label ? { label: record.label } : {}),
    state: record.state,
    isDefault: record.isDefault,
    reconnectRequired: record.state !== "active",
    refreshable: record.refreshable,
    ...(record.scopes ? { scopes: record.scopes } : {}),
    ...(record.account ? { account: record.account } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    credential: record.credential,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastValidatedAt ? { lastValidatedAt: record.lastValidatedAt } : {}),
  };
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

function parseProviderCredentialScope(value: unknown): ProviderCredentialScope {
  if (
    value === "user" ||
    value === "repo" ||
    value === "org" ||
    value === "env-only" ||
    value === "external-vault-backed"
  ) {
    return value;
  }
  if (value === "env") {
    return "env-only";
  }
  if (value === "external-vault") {
    return "external-vault-backed";
  }
  if (value === undefined) {
    return "user";
  }
  throw new WebInputError("invalid provider credential scope");
}

function parseProviderCredentialSource(value: unknown): ProviderCredentialSource {
  if (
    value === "web-console" ||
    value === "environment" ||
    value === "external-vault"
  ) {
    return value;
  }
  if (value === undefined) {
    return "web-console";
  }
  throw new WebInputError("invalid provider credential source");
}

function optionalMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalMetadataObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function providerCredentialScopeIsShared(
  scope: ProviderCredentialScope | undefined,
): boolean {
  return scope === "org" || scope === "external-vault-backed";
}

function requireSharedProviderCredentialAccess(
  user: WebUserContext,
  organizationId: string | undefined,
): void {
  requireCurrentOrganizationPermission(user, "providers:write:shared");
  if (
    user.authMode === "required" &&
    user.role !== "admin" &&
    organizationId !== undefined &&
    organizationId !== user.currentOrganizationId
  ) {
    throw new WebForbiddenError("shared provider credential organization mismatch");
  }
}

async function requireExistingProviderCredentialWriteAccess(
  store: ProviderConnectionStore,
  providerId: ProviderId,
  user: WebUserContext,
): Promise<void> {
  const status = (await store.listStatuses()).find(
    (candidate) => candidate.id === providerId,
  );
  if (providerCredentialScopeIsShared(status?.credential?.scope)) {
    requireSharedProviderCredentialAccess(
      user,
      status?.credential?.organizationId,
    );
  }
}

function parseProviderCredentialMetadata(
  body: Record<string, unknown>,
  user: WebUserContext,
): Partial<ProviderCredentialMetadata> {
  const raw = optionalMetadataObject(body.metadata);
  const scope = parseProviderCredentialScope(raw?.scope);
  const shared = providerCredentialScopeIsShared(scope);
  const requestedOrganizationId = optionalMetadataString(raw, "organizationId");
  const requestedOwnerId = optionalMetadataString(raw, "ownerId");
  if (shared) {
    requireSharedProviderCredentialAccess(user, requestedOrganizationId);
  }
  if (
    scope === "user" &&
    user.authMode === "required" &&
    user.role !== "admin" &&
    requestedOwnerId !== undefined &&
    requestedOwnerId !== user.id
  ) {
    throw new WebForbiddenError("personal provider credential owner mismatch");
  }
  const organizationId =
    requestedOrganizationId ??
    (shared && user.authMode === "required" ? user.currentOrganizationId : undefined);
  const ownerId =
    scope === "user" && user.authMode === "required" && user.role !== "admin"
      ? user.id
      : requestedOwnerId ?? user.id;
  return {
    scope,
    source: parseProviderCredentialSource(raw?.source),
    ownerId,
    ...(optionalMetadataString(raw, "repositoryId")
      ? { repositoryId: optionalMetadataString(raw, "repositoryId") }
      : {}),
    ...(organizationId
      ? { organizationId }
      : {}),
    ...(optionalMetadataString(raw, "rotationHint")
      ? { rotationHint: optionalMetadataString(raw, "rotationHint") }
      : {}),
    ...(optionalMetadataString(raw, "vaultRef")
      ? { vaultRef: optionalMetadataString(raw, "vaultRef") }
      : {}),
  };
}

interface WebRequestLimiters {
  /** Password guessing against `POST /api/session`, keyed by email. */
  login: LoginAttemptLimiter;
  /**
   * The two unauthenticated device-flow protocol endpoints, keyed by client
   * address — the only thing there is to key them by.
   */
  deviceAuthorization: LoginAttemptLimiter;
  /**
   * User-code guessing from an authenticated admin seat.
   *
   * Its own instance, not the login limiter's: that map is bounded at 10,000
   * subjects with FIFO eviction, and `POST /api/session` records a failure for
   * any attacker-chosen email, so unauthenticated login spam could evict a
   * `device-approve:<adminId>` counter and hand the guesser a fresh budget.
   * Separate maps make the two unable to displace each other.
   */
  deviceApproval: LoginAttemptLimiter;
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: RuntimeStartWebServerInput,
  limiters: WebRequestLimiters,
): Promise<boolean> {
  const {
    login: loginAttemptLimiter,
    deviceAuthorization: deviceAuthorizationLimiter,
    deviceApproval: deviceApprovalLimiter,
  } = limiters;
  const url = new URL(request.url ?? "/", "http://localhost");
  const homeRepoPath = resolve(input.repoPath);
  const repositories = await loadWebRepositories(input.repoPath, input.repositories);
  const authMode = authModeForInput(input);
  const execution = webExecutionBackendPolicyForInput(input, authMode);
  const baseRunner = input.runFlow ?? defaultRunFlow;
  const runner = async (
    runInput: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ): Promise<RunFlowResult> =>
    await baseRunner(
      { ...runInput, executionBackend: execution.backend },
      dependencies,
    );

  if (
    await dispatchHttpRoutes(
      { method: request.method ?? "", pathname: url.pathname },
      consoleListApiRoutes({
        "/api/runs": async () => {
          const user = await requireUserContext(request, input, homeRepoPath);
          sendJson(response, 200, {
            runs: await listAllRuns(
              visibleRepositories(repositories, user),
              user,
              { limit: DEFAULT_RUN_LIST_LIMIT },
            ),
          });
          return true;
        },
        "/api/dashboard": async () => {
          const user = await requireUserContext(request, input, homeRepoPath);
          const scopedRepositories = visibleRepositories(repositories, user);
          const [tasks, runs, notifications] = await Promise.all([
            listAllWorkItemViews(scopedRepositories, user),
            listAllRuns(scopedRepositories, user),
            listAllNotifications(scopedRepositories, user, { status: "pending" }, {
              serverInput: input,
            }),
          ]);
          const filters = dashboardFiltersFromUrl(url);
          const now = new Date();
          const eligibleRunKeys = new Set(
            filterManagerDashboardRuns({
              tasks,
              runs,
              repositories: scopedRepositories,
              filters,
              now,
            }).map((run) => dashboardRunScopeKey(run, input.repoPath)),
          );
          const dashboardRuns = await enrichDashboardChangeRequestStatuses(
            runs,
            user,
            input,
            eligibleRunKeys,
          );
          const managerDashboard = buildManagerDashboard({
            tasks,
            runs: dashboardRuns,
            repositories: scopedRepositories,
            filters,
            now,
          });
          sendJson(response, 200, {
            dashboard: managerDashboard,
            managerDashboard,
            myWork: buildMyWorkDashboard({ notifications }),
          });
          return true;
        },
        "/api/agent-stability": async () => {
          const user = await requireUserContext(request, input, homeRepoPath);
          const scopedRepositories = visibleRepositories(repositories, user);
          const [tasks, runs] = await Promise.all([
            listAllWorkItemViews(scopedRepositories, user),
            listAllRuns(scopedRepositories, user),
          ]);
          const agentStabilityRuns = await enrichRunsForAgentStability(runs);
          sendJson(response, 200, {
            agentStability: buildAgentStabilityProjection({
              runs: agentStabilityRuns,
              tasks,
              repositories: scopedRepositories,
              now: new Date(),
            }),
          });
          return true;
        },
        "/api/tasks": async () => {
          const user = await requireUserContext(request, input, homeRepoPath);
          sendJson(response, 200, {
            tasks: await listAllWorkItemViews(
              visibleRepositories(repositories, user),
              user,
            ),
          });
          return true;
        },
      }),
    )
  ) {
    return true;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/github/webhooks" &&
    input.githubWebhookIntake
  ) {
    const result = await input.githubWebhookIntake.accept({
      deliveryId: requestHeader(request, "x-github-delivery"),
      event: requestHeader(request, "x-github-event"),
      signature: requestHeader(request, "x-hub-signature-256"),
      body: await readRequestBody(request, {
        tooLargeError: () =>
          new GitHubWebhookRequestError(
            "GitHub webhook body is too large",
            "payload_too_large",
            413,
          ),
      }),
    });
    const { status, ...payload } = result;
    sendJson(response, status, payload);
    setImmediate(() => {
      void input.githubWebhookIntake?.drain().catch((error) => {
        console.error(
          `Nitely GitHub webhook drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    return true;
  }

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
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.login",
        decision: "deny",
        outcome: "error",
        httpStatus: 503,
        reasonCode: "setup_required",
        actor: { type: "anonymous" },
      });
      throw new WebSetupRequiredError();
    }
    const body = requireObject(await readRequestJson(request));
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const subjectHash = securityAuditSubjectFingerprint(email);
    const attempt = loginAttemptLimiter.check(email);
    if (!attempt.allowed) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.login",
        decision: "deny",
        outcome: "error",
        httpStatus: 429,
        reasonCode: "throttled",
        actor: { type: "anonymous", subjectHash },
      });
      sendJsonWithHeaders(
        response,
        429,
        {
          error: {
            code: "too_many_attempts",
            message: "too many login attempts; try again later",
          },
        },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }
    const user = await verifyUserPassword(homeRepoPath, email, password);
    if (!user) {
      loginAttemptLimiter.recordFailure(email);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.login",
        decision: "deny",
        outcome: "error",
        httpStatus: 401,
        reasonCode: "invalid_credentials",
        actor: { type: "anonymous", subjectHash },
      });
      throw new WebUnauthorizedError("invalid email or password");
    }
    loginAttemptLimiter.clear(email);
    const session = await createSession(homeRepoPath, user.id);
    const sessionUser = await getPublicUser(homeRepoPath, user.id);
    const auditUser = sessionUser
      ? publicContext(sessionUser, authMode)
      : { id: user.id, email: user.email, role: user.role, authMode };
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.login",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: securityAuditActorForUser(auditUser),
    });
    sendJsonWithHeaders(
      response,
      200,
      { authRequired: true, user: sessionUser },
      { "set-cookie": sessionCookie(session.id, secureCookieForInput(input)) },
    );
    return true;
  }
  if (request.method === "DELETE" && url.pathname === "/api/session") {
    const sessionId = parseCookies(request.headers.cookie).nitely_session;
    const sessionUser = sessionId
      ? await readSessionUser(homeRepoPath, sessionId)
      : null;
    if (sessionId) {
      await deleteSession(homeRepoPath, sessionId).catch(() => {});
    }
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.logout",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: sessionUser
        ? securityAuditActorForUser(publicContext(sessionUser, authMode))
        : { type: "anonymous" },
    });
    sendJsonWithHeaders(response, 200, { ok: true }, {
      "set-cookie": clearSessionCookie(secureCookieForInput(input)),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/device-authorization") {
    if (authMode === "local") {
      sendDeviceFlowError(response, 409, "device_flow_unavailable");
      return true;
    }
    if (!(await hasAnyUsers(homeRepoPath))) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.authorize",
        decision: "deny",
        outcome: "error",
        httpStatus: 503,
        reasonCode: "setup_required",
        actor: { type: "anonymous" },
      });
      throw new WebSetupRequiredError();
    }
    const address = clientAddress(request);
    const attempt = deviceAuthorizationLimiter.check(address);
    if (!attempt.allowed) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.authorize",
        decision: "deny",
        outcome: "error",
        httpStatus: 429,
        reasonCode: "throttled",
        actor: { type: "anonymous" },
      });
      sendJsonWithHeaders(
        response,
        429,
        { error: "slow_down" },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }
    deviceAuthorizationLimiter.recordFailure(address);

    const body = requireObject(await readRequestJson(request));
    const requested = Array.isArray(body.capabilities) ? body.capabilities : [];
    for (const capability of requested) {
      if (
        typeof capability !== "string" ||
        !(API_TOKEN_CAPABILITIES as readonly string[]).includes(capability)
      ) {
        await appendSecurityAuditBestEffort(homeRepoPath, {
          action: "auth.device.authorize",
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "invalid_input",
          actor: { type: "anonymous" },
        });
        throw new WebInputError(`unknown API token capability: ${String(capability)}`);
      }
    }
    if (requested.length === 0) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.authorize",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "invalid_input",
        actor: { type: "anonymous" },
      });
      throw new WebInputError("at least one capability is required");
    }
    // `createApiToken` enforces this pairing too, but that runs at exchange —
    // after an admin has already approved a request the consent screen showed
    // without a high-impact warning, and its failure would leave the record
    // stuck in `approved` and 500 every retry. Reject it here, while the only
    // thing lost is one unstarted login.
    const allowHighImpact = body.allowHighImpact === true;
    if (!allowHighImpact) {
      const highImpact = (requested as ApiTokenCapability[]).find(
        isHighImpactCapability,
      );
      if (highImpact) {
        await appendSecurityAuditBestEffort(homeRepoPath, {
          action: "auth.device.authorize",
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "invalid_input",
          actor: { type: "anonymous" },
        });
        throw new WebInputError(
          `high-impact capability requires confirmation: ${highImpact}`,
        );
      }
    }

    const { deviceCode, record } = await createDeviceAuthorization(homeRepoPath, {
      capabilities: requested as ApiTokenCapability[],
      allowHighImpact,
      ...(typeof body.clientName === "string" ? { clientName: body.clientName } : {}),
    });
    const displayCode = formatUserCode(record.userCode);
    const base = publicServerUrl(request);

    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.device.authorize",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: { type: "anonymous" },
    });

    sendJson(response, 200, {
      device_code: deviceCode,
      user_code: displayCode,
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${displayCode}`,
      expires_in: Math.round(
        (new Date(record.expiresAt).getTime() -
          new Date(record.createdAt).getTime()) / 1000,
      ),
      interval: record.intervalSeconds,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/device-token") {
    if (authMode === "local") {
      sendDeviceFlowError(response, 409, "device_flow_unavailable");
      return true;
    }
    // Unlike its sibling, this endpoint's rejection path costs a file stat and
    // an audit write, and every audit write is two fsyncs — so an
    // unauthenticated caller could otherwise force a synchronous disk flush per
    // request. The throttled response itself writes no audit event, since
    // auditing it would restore exactly the amplification being throttled.
    const address = clientAddress(request);
    const pollAttempt = deviceAuthorizationLimiter.check(address);
    if (!pollAttempt.allowed) {
      sendJsonWithHeaders(
        response,
        429,
        { error: "slow_down" },
        { "retry-after": String(pollAttempt.retryAfterSeconds) },
      );
      return true;
    }
    const body = requireObject(await readRequestJson(request));
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const record = await resolveDeviceAuthorization(homeRepoPath, deviceCode);
    if (!record) {
      // Only unknown codes count against the limiter: a legitimate client
      // polls a valid code a hundred times over one login and must never be
      // throttled for it.
      deviceAuthorizationLimiter.recordFailure(address);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.exchange",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "expired_token",
        actor: { type: "anonymous" },
      });
      sendDeviceFlowError(response, 400, "expired_token");
      return true;
    }

    const now = new Date();
    if (record.lastPolledAt) {
      const sinceLastPoll = now.getTime() - new Date(record.lastPolledAt).getTime();
      if (sinceLastPoll < record.intervalSeconds * 1000) {
        // No write here. This request is being rejected anyway, and a
        // read-modify-write of the whole record is the one thing that could
        // carry a stale `status` back onto disk.
        sendDeviceFlowError(response, 400, "slow_down");
        return true;
      }
    }
    await recordDevicePoll(homeRepoPath, record.userCode, now);

    if (record.status === "denied") {
      await deleteDeviceAuthorization(homeRepoPath, record.userCode);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.exchange",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "access_denied",
        actor: {
          type: "anonymous",
          subjectHash: securityAuditSubjectFingerprint(record.userCode),
        },
      });
      sendDeviceFlowError(response, 400, "access_denied");
      return true;
    }
    if (record.status === "pending") {
      sendDeviceFlowError(response, 400, "authorization_pending");
      return true;
    }

    // The approver is the only identity this token can act as; a record
    // without one cannot mint, because an unowned token would resolve no
    // user's credentials and be refused on its first request anyway.
    if (!record.approvedByUserId) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.exchange",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "access_denied",
        actor: {
          type: "anonymous",
          subjectHash: securityAuditSubjectFingerprint(record.userCode),
        },
      });
      sendDeviceFlowError(response, 400, "access_denied");
      return true;
    }

    // Claim the record *before* minting. Of two concurrent polls that both
    // read `approved`, exactly one is told it won the claim; the loser sees
    // the code as spent, which is what an already-exchanged code looks like
    // anyway. Minting first would issue two tokens from one approval, and the
    // second would be invisible to whoever approved.
    if (!(await claimDeviceAuthorization(homeRepoPath, record.userCode))) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.exchange",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "expired_token",
        actor: {
          type: "anonymous",
          subjectHash: securityAuditSubjectFingerprint(record.userCode),
        },
      });
      sendDeviceFlowError(response, 400, "expired_token");
      return true;
    }

    // Minted here, not at approval, so no plaintext token ever rests on disk.
    const created = await createApiToken(homeRepoPath, {
      name: record.clientName,
      capabilities: record.capabilities,
      allowHighImpact: record.allowHighImpact,
      ownerUserId: record.approvedByUserId,
    });
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.device.exchange",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      // `subjectHash` is the fingerprint of the user code, which the approve
      // and deny events carry too: it is what ties "an admin approved request
      // X" to "token Y was issued for request X", without a live user code
      // ever reaching the log. The target names the admin whose approval
      // caused this token to exist — the claim above took the only other copy
      // of that off disk, so this event is where it durably lives.
      actor: {
        type: "api-token",
        id: created.record.id,
        subjectHash: securityAuditSubjectFingerprint(record.userCode),
      },
      ...(record.approvedByUserId
        ? { target: { type: "user" as const, id: record.approvedByUserId } }
        : {}),
    });

    sendJson(response, 200, {
      access_token: created.token,
      token_id: created.record.id,
      name: created.record.name,
      capabilities: created.record.capabilities,
    });
    return true;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/device-authorizations/approve"
  ) {
    if (authMode === "local") {
      // Unreachable while authorize and token both refuse local mode, but
      // `resolveUserContext` hands back a synthetic admin for a caller with no
      // session at all under `--auth local`, so the guard belongs on every
      // device endpoint rather than only on the two that need it today.
      sendJson(response, 409, {
        error: {
          code: "device_flow_unavailable",
          message:
            "browser sign-in is unavailable when the server runs with --auth local",
        },
      });
      return true;
    }
    const actor = await resolveUserContext(request, input, homeRepoPath);
    if (!actor) throw new WebUnauthorizedError();
    if (actor.role !== "admin") {
      // API tokens are unowned and resolve to a synthetic admin, so a token
      // issued here would outrank its requester. Admins only, until tokens
      // carry a userId.
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 403,
        reasonCode: "forbidden",
        actor: securityAuditActorForUser(actor),
      });
      throw new WebForbiddenError(
        "only an admin can approve a device authorization",
      );
    }

    const body = requireObject(await readRequestJson(request));
    if (body.decision !== "approve" && body.decision !== "deny") {
      throw new WebInputError(
        'decision must be exactly "approve" or "deny"',
      );
    }
    const decision = body.decision;
    const userCode = normalizeUserCode(
      typeof body.userCode === "string" ? body.userCode : "",
    );

    const throttleSubject = `device-approve:${actor.id}`;
    const attempt = deviceApprovalLimiter.check(throttleSubject);
    if (!attempt.allowed) {
      // Tripping the user-code guessing limiter is the event here that most
      // warrants a record, so it is audited like the authorize endpoint's 429.
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 429,
        reasonCode: "throttled",
        actor: securityAuditActorForUser(actor),
      });
      sendJsonWithHeaders(
        response,
        429,
        { error: { code: "too_many_attempts", message: "too many attempts; try again later" } },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }

    const record = userCode
      ? await readDeviceAuthorization(homeRepoPath, userCode)
      : null;
    if (!record) {
      deviceApprovalLimiter.recordFailure(throttleSubject);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
        actor: securityAuditActorForUser(actor),
      });
      throw new WebNotFoundError("device authorization not found");
    }
    if (record.status !== "pending") {
      throw new WebInputError("device authorization already decided");
    }
    deviceApprovalLimiter.clear(throttleSubject);

    const decided = await decideDeviceAuthorization(homeRepoPath, record.userCode, {
      decision,
      userId: actor.id,
    });
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: decision === "approve" ? "auth.device.approve" : "auth.device.deny",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      // The fingerprint of the user code, not the code: it says *which*
      // request this admin decided, and the exchange event carries the same
      // one, so "who approved the request that minted this token" is
      // answerable from the audit log alone.
      actor: {
        ...securityAuditActorForUser(actor),
        subjectHash: securityAuditSubjectFingerprint(record.userCode),
      },
    });

    sendJson(response, 200, {
      status: decided.status,
      clientName: decided.clientName,
      capabilities: decided.capabilities,
    });
    return true;
  }

  const deviceAuthorizationLookupUserCode = apiDeviceAuthorizationUserCode(
    url.pathname,
  );
  if (
    request.method === "GET" &&
    deviceAuthorizationLookupUserCode !== undefined
  ) {
    if (authMode === "local") {
      // Unreachable while authorize and token both refuse local mode, but
      // `resolveUserContext` hands back a synthetic admin for a caller with no
      // session at all under `--auth local`, so the guard belongs on every
      // device endpoint rather than only on the two that need it today.
      sendJson(response, 409, {
        error: {
          code: "device_flow_unavailable",
          message:
            "browser sign-in is unavailable when the server runs with --auth local",
        },
      });
      return true;
    }
    const actor = await resolveUserContext(request, input, homeRepoPath);
    if (!actor) throw new WebUnauthorizedError();
    if (actor.role !== "admin") {
      // Same reasoning as the approve endpoint: API tokens resolve to a
      // synthetic admin, so only a real admin session may see what a
      // device request is asking for.
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 403,
        reasonCode: "forbidden",
        actor: securityAuditActorForUser(actor),
      });
      throw new WebForbiddenError(
        "only an admin can approve a device authorization",
      );
    }

    const throttleSubject = `device-approve:${actor.id}`;
    const attempt = deviceApprovalLimiter.check(throttleSubject);
    if (!attempt.allowed) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 429,
        reasonCode: "throttled",
        actor: securityAuditActorForUser(actor),
      });
      sendJsonWithHeaders(
        response,
        429,
        { error: { code: "too_many_attempts", message: "too many attempts; try again later" } },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }

    const userCode = normalizeUserCode(deviceAuthorizationLookupUserCode);
    const record = userCode
      ? await readDeviceAuthorization(homeRepoPath, userCode)
      : null;
    // "not found", "expired" (readDeviceAuthorization already folds this
    // into null), and "already decided" all take the identical 404 below —
    // this endpoint must not be usable to probe which of those is true.
    if (!record || record.status !== "pending") {
      deviceApprovalLimiter.recordFailure(throttleSubject);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
        actor: securityAuditActorForUser(actor),
      });
      throw new WebNotFoundError("device authorization not found");
    }
    deviceApprovalLimiter.clear(throttleSubject);

    // Never the device code, its hash, or anything else secret — only what
    // the operator needs to decide whether to approve. `highImpactCapabilities`
    // is the subset of `capabilities` the page marks: `allowHighImpact` only
    // says the client would *permit* them, so warning off that flag warns on
    // requests that ask for nothing high-impact at all.
    sendJson(response, 200, {
      clientName: record.clientName,
      capabilities: record.capabilities,
      highImpactCapabilities: record.capabilities.filter(isHighImpactCapability),
      allowHighImpact: record.allowHighImpact,
      expiresAt: record.expiresAt,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/preview-sessions") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:view");
    const sessions = await visiblePreviewSessions({
      repositories,
      manager: input.previewManager!,
      user,
      repoId: optionalSearchParam(url, "repoId"),
    });
    sendJson(response, 200, {
      sessions,
      viewportPresets: PREVIEW_VIEWPORT_PRESETS,
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/preview-sessions") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:control");
    const body = previewStartInputFromJson(await readRequestJson(request));
    const repository = requireRepositoryForOrganization(
      repositories,
      body.repoId,
      user,
      user.currentOrganizationId,
    );
    if (repository.synthetic) {
      throw new WebInputError("preview sessions require a real repository");
    }
    if (body.workItemId) {
      const workItem = await getWorkItem(repository.path, body.workItemId);
      requireRecordAccess(workItem, user, "work item not found");
    }
    if (body.runId) {
      const run = await getRunDetail(repository.path, body.runId);
      requireRecordAccess(run, user, "run not found");
    }
    const session = await input.previewManager!.start({
      repoId: repository.id,
      repoPath: repository.path,
      commandId: body.commandId,
      ...(body.workItemId ? { workItemId: body.workItemId } : {}),
      ...(body.runId ? { runId: body.runId } : {}),
      actor: {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
      },
      ownerId: user.id,
      ...(user.currentOrganizationId
        ? { organizationId: user.currentOrganizationId }
        : {}),
      ...(body.targetUrl ? { targetUrl: body.targetUrl } : {}),
      ...(body.route ? { route: body.route } : {}),
      ...(body.viewport ? { viewport: body.viewport } : {}),
    });
    sendJson(response, 201, { session });
    return true;
  }

  const previewProxyRef = apiPreviewSessionProxyRef(url.pathname);
  if (
    previewProxyRef &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:view");
    const { record } = await getScopedPreviewSession({
      repositories,
      manager: input.previewManager!,
      sessionId: previewProxyRef.sessionId,
      user,
    });
    await sendPreviewProxyResponse({
      request,
      response,
      record,
      proxyPath: previewProxyRef.proxyPath,
      search: url.search,
    });
    return true;
  }

  const previewRef = apiPreviewSessionRef(url.pathname);
  if (previewRef && request.method === "GET" && !previewRef.action) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:view");
    const { record } = await getScopedPreviewSession({
      repositories,
      manager: input.previewManager!,
      sessionId: previewRef.sessionId,
      user,
    });
    sendJson(response, 200, { session: record });
    return true;
  }
  if (previewRef && request.method === "GET" && previewRef.action === "diagnostics") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:view");
    const { repository, record } = await getScopedPreviewSession({
      repositories,
      manager: input.previewManager!,
      sessionId: previewRef.sessionId,
      user,
    });
    const diagnostics = await input.previewManager!.diagnostics(
      repository.path,
      record.id,
    );
    sendJson(response, 200, { diagnostics });
    return true;
  }
  if (previewRef && request.method === "GET" && previewRef.action === "hierarchy") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "preview:view");
    const { repository, record } = await getScopedPreviewSession({
      repositories,
      manager: input.previewManager!,
      sessionId: previewRef.sessionId,
      user,
    });
    const hierarchy = await input.previewManager!.hierarchy(
      repository.path,
      record.id,
    );
    sendJson(response, 200, { hierarchy });
    return true;
  }
  if (previewRef && request.method === "POST" && previewRef.action) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, record } = await getScopedPreviewSession({
      repositories,
      manager: input.previewManager!,
      sessionId: previewRef.sessionId,
      user,
    });
    requireWriteAccessToRecord(user, record, "preview:control");
    if (previewRef.action === "stop") {
      const session = await input.previewManager!.stop(repository.path, record.id);
      sendJson(response, 200, { session });
      return true;
    }
    if (previewRef.action === "navigate") {
      const body = previewNavigateInputFromJson(await readRequestJson(request));
      const session = await input.previewManager!.navigate(
        repository.path,
        record.id,
        previewNavigationUrl(record, body.url),
      );
      sendJson(response, 200, { session });
      return true;
    }
    if (previewRef.action === "reload") {
      const session = await input.previewManager!.reload(repository.path, record.id);
      sendJson(response, 200, { session });
      return true;
    }
    if (previewRef.action === "restart") {
      const session = await input.previewManager!.restart(repository.path, record.id);
      sendJson(response, 201, { session });
      return true;
    }
    if (previewRef.action === "screenshot") {
      const body = requireObject(await readRequestJson(request));
      const screenshot = await input.previewManager!.screenshot({
        repoPath: repository.path,
        sessionId: record.id,
        fullPage: body.fullPage === true,
      });
      const session = await input.previewManager!.get(repository.path, record.id);
      sendJson(response, 201, { screenshot, session });
      return true;
    }
    if (previewRef.action === "attach-screenshot") {
      const body = previewAttachmentInputFromJson(await readRequestJson(request));
      let targetRunId = body.runId ?? record.runId;
      if (body.workItemId) {
        const workItem = await getWorkItem(repository.path, body.workItemId);
        requireWriteAccessToRecord(user, workItem, "preview:control");
        targetRunId = targetRunId ?? workItem.latestRunId;
      } else if (record.workItemId && !targetRunId) {
        const workItem = await getWorkItem(repository.path, record.workItemId);
        requireRecordAccess(workItem, user, "work item not found");
        targetRunId = workItem.latestRunId;
      }
      if (!targetRunId) {
        throw new WebInputError("runId is required to attach preview evidence");
      }
      const run = await getRunDetail(repository.path, targetRunId);
      requireWriteAccessToRecord(user, run, "preview:control");
      const attachment = await attachPreviewScreenshotToRun({
        repoPath: repository.path,
        runId: targetRunId,
        session: record,
        screenshotId: body.screenshotId,
        actorId: user.id,
        ...(body.note ? { note: body.note } : {}),
      });
      sendJson(response, 201, { attachment });
      return true;
    }
    if (previewRef.action === "compare-reference") {
      const body = previewCompareInputFromJson(await readRequestJson(request));
      let targetRunId = body.runId ?? record.runId;
      if (body.workItemId) {
        const workItem = await getWorkItem(repository.path, body.workItemId);
        requireWriteAccessToRecord(user, workItem, "preview:control");
        targetRunId = targetRunId ?? workItem.latestRunId;
      } else if (record.workItemId && !targetRunId) {
        const workItem = await getWorkItem(repository.path, record.workItemId);
        requireRecordAccess(workItem, user, "work item not found");
        targetRunId = workItem.latestRunId;
      }
      if (!targetRunId) {
        throw new WebInputError("runId is required for preview comparison");
      }
      const run = await getRunDetail(repository.path, targetRunId);
      requireWriteAccessToRecord(user, run, "preview:control");

      let implementation = body.implementation;
      let attachment:
        | Awaited<ReturnType<typeof attachPreviewScreenshotToRun>>
        | undefined;
      if (body.screenshotId) {
        attachment = await attachPreviewScreenshotToRun({
          repoPath: repository.path,
          runId: targetRunId,
          session: record,
          screenshotId: body.screenshotId,
          actorId: user.id,
          ...(body.note ? { note: body.note } : {}),
        });
        implementation = {
          artifactId: attachment.artifact.id,
          artifactProducer: attachment.artifact.producer,
        };
      }
      if (!implementation) {
        throw new WebInputError("implementation image is required");
      }
      let currentRoute = body.route ?? record.route;
      if (!currentRoute && record.currentUrl) {
        try {
          currentRoute = new URL(record.currentUrl).pathname;
        } catch {
          // The comparison can still run without route metadata.
        }
      }
      let comparison: Awaited<ReturnType<typeof compareVisualArtifacts>>;
      try {
        comparison = await compareVisualArtifacts({
          repoPath: repository.path,
          runId: targetRunId,
          ...(body.comparisonId ? { id: body.comparisonId } : {}),
          reference: body.reference,
          implementation,
          viewport: record.viewport,
          ...(currentRoute ? { route: currentRoute } : {}),
          ...(body.revision ? { revision: body.revision } : {}),
          ...(body.pixelmatchThreshold !== undefined
            ? { pixelmatchThreshold: body.pixelmatchThreshold }
            : {}),
          ...(body.includeAntiAliased !== undefined
            ? { includeAntiAliased: body.includeAntiAliased }
            : {}),
          ...(body.allowedChangedPixelCount !== undefined
            ? { allowedChangedPixelCount: body.allowedChangedPixelCount }
            : {}),
          ...(body.allowedChangedPixelRatio !== undefined
            ? { allowedChangedPixelRatio: body.allowedChangedPixelRatio }
            : {}),
          ...(body.overlayOpacity !== undefined
            ? { overlayOpacity: body.overlayOpacity }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof UnsafeRunOwnedFileError &&
          /requires Linux descriptor-relative path anchoring/i.test(error.message)
        ) {
          throw new WebInputError(
            "preview comparison requires Linux run-owned file anchoring",
          );
        }
        throw error;
      }
      sendJson(response, 201, {
        comparison: comparison.result,
        artifacts: comparison.artifacts,
        ...(attachment ? { attachment } : {}),
      });
      return true;
    }
    if (previewRef.action === "click") {
      const body = previewSelectorInputFromJson(await readRequestJson(request));
      await input.previewManager!.click(repository.path, record.id, body.selector);
      const session = await input.previewManager!.get(repository.path, record.id);
      sendJson(response, 200, { session });
      return true;
    }
    if (previewRef.action === "type") {
      const body = previewTypeInputFromJson(await readRequestJson(request));
      await input.previewManager!.type(
        repository.path,
        record.id,
        body.selector,
        body.text,
      );
      const session = await input.previewManager!.get(repository.path, record.id);
      sendJson(response, 200, { session });
      return true;
    }
    if (previewRef.action === "scroll") {
      const body = previewScrollInputFromJson(await readRequestJson(request));
      await input.previewManager!.scroll(
        repository.path,
        record.id,
        body.deltaX,
        body.deltaY,
      );
      const session = await input.previewManager!.get(repository.path, record.id);
      sendJson(response, 200, { session });
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const users = assignmentDirectoryUsers(
      authMode === "local" ? [] : await listPublicUsers(homeRepoPath),
      user,
    );
    sendJson(response, 200, {
      users,
      canManageAssignments: canManageNotificationAssignments(user),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/security/audit") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "security:audit:view");
    const rawLimit = url.searchParams.get("limit");
    const rawDecision = url.searchParams.get("decision");
    if (rawDecision !== null && rawDecision !== "allow" && rawDecision !== "deny") {
      throw new WebInputError("security audit decision must be allow or deny");
    }
    try {
      const events = await listSecurityAuditEvents(homeRepoPath, {
        ...(url.searchParams.get("action")
          ? { action: url.searchParams.get("action") ?? undefined }
          : {}),
        ...(rawDecision ? { decision: rawDecision } : {}),
        ...(url.searchParams.get("actorId")
          ? { actorId: url.searchParams.get("actorId") ?? undefined }
          : {}),
        ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
      });
      sendJson(response, 200, { events });
    } catch (error) {
      throw new WebInputError(error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  const revokeUserSessionsMatch = /^\/api\/users\/([^/]+)\/sessions$/.exec(
    url.pathname,
  );
  if (request.method === "DELETE" && revokeUserSessionsMatch) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "sessions:revoke");
    let userId: string;
    try {
      userId = decodeURIComponent(revokeUserSessionsMatch[1]);
    } catch {
      throw new WebInputError("invalid user id");
    }
    if (!(await getPublicUser(homeRepoPath, userId))) {
      throw new WebNotFoundError("user not found");
    }
    const invalidatedSessions = await invalidateUserSessions(homeRepoPath, userId);
    const payload = { ok: true, userId, invalidatedSessions };
    if (userId === user.id) {
      sendJsonWithHeaders(response, 200, payload, {
        "set-cookie": clearSessionCookie(secureCookieForInput(input)),
      });
    } else {
      sendJson(response, 200, payload);
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/demo/golden-path") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "demo:run");
    const demoRepositoryId = "demo-golden-path";
    const result = await (input.runGoldenPathDemo ?? runGoldenPathDemo)({
      outputDir: join(homeRepoPath, ".nitely", "demo", "golden-path"),
    });
    let repository = repositories.find((candidate) => candidate.id === demoRepositoryId);
    if (!repository) {
      repository = await addStoredWebRepository(
        homeRepoPath,
        input.repositories,
        {
          id: demoRepositoryId,
          name: "Mocked golden path demo",
          path: result.repoPath,
          defaultBranch: "master",
          synthetic: true,
        },
        input.cloneRepository,
      );
    }
    sendJson(response, 201, {
      demo: goldenPathDemoView(result, repository),
      repositories: (
        await loadWebRepositories(input.repoPath, input.repositories)
      ).map(publicRepository),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/repositories") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      repositories: visibleRepositories(repositories, user).map(publicRepository),
    });
    return true;
  }
  const knowledgeService = knowledgeRepositoryServiceForInput(input);
  if (
    request.method === "GET" &&
    url.pathname === "/api/knowledge-repositories"
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "knowledge:manage");
    const repository = requireVisibleRepository(
      repositories,
      optionalSearchParam(url, "repoId"),
      user,
    );
    try {
      const views = await knowledgeService.list({ targetRepoPath: repository.path });
      sendJson(response, 200, {
        repository: { id: repository.id, name: repository.name },
        knowledgeRepositories: views.map(publicKnowledgeRepositoryView),
      });
    } catch (error) {
      if (isWebError(error)) throw error;
      throw new WebInputError(
        safeKnowledgeWebErrorMessage(
          error,
          repository.path,
          "knowledge repository list failed",
        ),
      );
    }
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/knowledge-repositories"
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "knowledge:manage");
    const parsed = knowledgeAttachmentInputFromJson(await readRequestJson(request));
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    try {
      const knowledgeProviderStore = providerStoreForUser(input, homeRepoPath, user);
      if (parsed.attachment.source.type === "remote") {
        await requireKnowledgeGitHubCredentialScope({
          store: knowledgeProviderStore,
          repository,
          user,
        });
      }
      const view = await knowledgeService.attach(
        {
          targetRepoPath: repository.path,
          attachment: {
            ...parsed.attachment,
            createdBy: user.id,
            ...(user.authMode === "required" && user.role !== "admin"
              ? { ownerId: user.id }
              : {}),
            ...(user.currentOrganizationId
              ? { organizationId: user.currentOrganizationId }
              : {}),
          },
        },
        {
          providerStore: knowledgeProviderStore,
          redactionSecrets: await webRunRedactionSecrets(
            input,
            homeRepoPath,
            repository.path,
            user,
          ),
        },
      );
      sendJson(response, 201, {
        repository: { id: repository.id, name: repository.name },
        knowledgeRepository: publicKnowledgeRepositoryView(view),
      });
    } catch (error) {
      if (isWebError(error)) throw error;
      throw new WebInputError(
        safeKnowledgeWebErrorMessage(
          error,
          repository.path,
          "knowledge repository attach failed",
        ),
      );
    }
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/knowledge-repositories/query"
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "knowledge:manage");
    const body = requireObject(await readRequestJson(request));
    const repository = requireVisibleRepository(
      repositories,
      typeof body.repoId === "string" ? body.repoId : undefined,
      user,
    );
    const query = requiredTrimmedString(body, "query");
    const attachmentIds = optionalStringArrayFromJson(
      body.attachmentIds,
      "attachmentIds",
    );
    try {
      const knowledgeProviderStore = providerStoreForUser(input, homeRepoPath, user);
      const selectedIds = attachmentIds ? new Set(attachmentIds) : undefined;
      const queryViews = await knowledgeService.list({
        targetRepoPath: repository.path,
      });
      if (
        queryViews.some(
          (view) =>
            view.attachment.enabled &&
            (!selectedIds || selectedIds.has(view.attachment.id)) &&
            view.attachment.source.type === "remote",
        )
      ) {
        await requireKnowledgeGitHubCredentialScope({
          store: knowledgeProviderStore,
          repository,
          user,
        });
      }
      const result = await knowledgeService.query(
        {
          targetRepoPath: repository.path,
          query,
          ...(attachmentIds ? { attachmentIds } : {}),
          ...(body.topK !== undefined ? { topK: Number(body.topK) } : {}),
          ...(body.maxPromptTokens !== undefined
            ? { maxPromptTokens: Number(body.maxPromptTokens) }
            : {}),
        },
        {
          providerStore: knowledgeProviderStore,
          redactionSecrets: await webRunRedactionSecrets(
            input,
            homeRepoPath,
            repository.path,
            user,
          ),
        },
      );
      sendJson(response, 200, {
        repository: { id: repository.id, name: repository.name },
        result,
      });
    } catch (error) {
      if (isWebError(error)) throw error;
      throw new WebInputError(
        safeKnowledgeWebErrorMessage(
          error,
          repository.path,
          "knowledge repository query failed",
        ),
      );
    }
    return true;
  }
  const knowledgeItemMatch =
    /^\/api\/knowledge-repositories\/([^/]+)(?:\/(status|refresh))?$/u.exec(
      url.pathname,
    );
  if (knowledgeItemMatch) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "knowledge:manage");
    const attachmentId = decodeURIComponent(knowledgeItemMatch[1] ?? "");
    const operation = knowledgeItemMatch[2];
    let body: Record<string, unknown> = {};
    if (request.method === "POST") body = requireObject(await readRequestJson(request));
    const repository = requireVisibleRepository(
      repositories,
      typeof body.repoId === "string"
        ? body.repoId
        : optionalSearchParam(url, "repoId"),
      user,
    );
    try {
      if (request.method === "GET" && operation === "status") {
        const view = await knowledgeService.status({
          targetRepoPath: repository.path,
          attachmentId,
        });
        sendJson(response, 200, {
          repository: { id: repository.id, name: repository.name },
          knowledgeRepository: publicKnowledgeRepositoryView(view),
        });
        return true;
      }
      if (request.method === "POST" && operation === "refresh") {
        const existing = await knowledgeService.status({
          targetRepoPath: repository.path,
          attachmentId,
        });
        const knowledgeProviderStore = providerStoreForUser(
          input,
          homeRepoPath,
          user,
        );
        if (existing.attachment.source.type === "remote") {
          await requireKnowledgeGitHubCredentialScope({
            store: knowledgeProviderStore,
            repository,
            user,
          });
        }
        const status = await knowledgeService.refresh(
          { targetRepoPath: repository.path, attachmentId },
          {
            providerStore: knowledgeProviderStore,
            redactionSecrets: await webRunRedactionSecrets(
              input,
              homeRepoPath,
              repository.path,
              user,
            ),
          },
        );
        const view = await knowledgeService.status({
          targetRepoPath: repository.path,
          attachmentId,
        });
        sendJson(response, 200, {
          repository: { id: repository.id, name: repository.name },
          knowledgeRepository: publicKnowledgeRepositoryView({
            attachment: view.attachment,
            status,
          }),
        });
        return true;
      }
      if (request.method === "DELETE" && operation === undefined) {
        const detached = await knowledgeService.detach({
          targetRepoPath: repository.path,
          attachmentId,
        });
        sendJson(response, 200, {
          repository: { id: repository.id, name: repository.name },
          detached: publicKnowledgeAttachment(detached),
        });
        return true;
      }
    } catch (error) {
      if (isWebError(error)) throw error;
      throw new WebInputError(
        safeKnowledgeWebErrorMessage(
          error,
          repository.path,
          "knowledge repository operation failed",
        ),
      );
    }
  }
  if (request.method === "GET" && url.pathname === "/api/skills") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      skills: await listRepositorySkills(visibleRepositories(repositories, user)),
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skills/preview") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "skills:manage");
    const parsed = skillImportInputFromJson(await readRequestJson(request));
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    try {
      const preview = await previewLocalSkillImport({
        repoPath: repository.path,
        sourcePath: parsed.sourcePath,
        overwrite: parsed.overwrite,
      });
      sendJson(response, 200, {
        preview: withRepository(preview, repository),
      });
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skills/import") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "skills:manage");
    const parsed = skillImportInputFromJson(await readRequestJson(request));
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    try {
      const imported = await importLocalSkill({
        repoPath: repository.path,
        sourcePath: parsed.sourcePath,
        overwrite: parsed.overwrite,
      });
      sendJson(response, 201, {
        skill: withRepository(imported, repository),
        skills: await listRepositorySkills(visibleRepositories(repositories, user)),
      });
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/repositories") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "repositories:manage");
    if (user.authMode === "required" && !user.currentOrganizationId) {
      throw new WebInputError("organization is required");
    }
    const organizationId =
      user.authMode === "required"
        ? currentWritableOrganizationId(user, "repositories:manage")
        : undefined;
    if (user.authMode === "required" && !organizationId) {
      throw new WebInputError("organization is required");
    }
    const repository = await addStoredWebRepository(
      homeRepoPath,
      input.repositories,
      {
        ...repositoryInputFromJson(await readRequestJson(request)),
        ...(organizationId ? { organizationId } : {}),
      },
      input.cloneRepository,
    );
    sendJson(response, 201, {
      repository: publicRepository(repository),
      repositories: visibleRepositories(
        await loadWebRepositories(input.repoPath, input.repositories),
        user,
      ).map(publicRepository),
    });
    return true;
  }

  if (url.pathname === "/api/schedules" || url.pathname.startsWith("/api/schedules/")) {
    if (await handleScheduleRequest(request, response, url, input, homeRepoPath, repositories)) {
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/factory-queue") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const entries = await Promise.all(
      visibleRepositories(repositories, user)
        .filter((repository) => repository.synthetic !== true)
        .map(async (repository) => ({
          repository: { id: repository.id, name: repository.name },
          ...(await getFactoryQueueSnapshot(repository.path)),
        })),
    );
    const candidates = entries.flatMap((entry) => entry.queue.candidates);
    sendJson(response, 200, {
      factoryQueue: {
        repositories: entries,
        summary: Object.fromEntries(
          ["candidate", "evaluating", "rejected", "duplicate", "needs_human", "eligible", "queued", "running", "blocked", "completed"]
            .map((status) => [status, candidates.filter((candidate) => candidate.status === status).length]),
        ),
      },
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/factory-queue/candidates") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "tasks:write");
    const parsed = factoryCandidateInputFromJson(await readRequestJson(request));
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    const candidate = await upsertFactoryCandidate({
      repoPath: repository.path,
      ...parsed,
      source: parsed.source as Parameters<typeof upsertFactoryCandidate>[0]["source"],
    });
    sendJson(response, 201, { candidate: { ...candidate, repoId: repository.id, repoName: repository.name } });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/factory-queue/pause") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "scheduler:run");
    const body = requireObject(await readRequestJson(request));
    const repoId = typeof body.repoId === "string" ? body.repoId.trim() : "";
    if (!repoId || typeof body.paused !== "boolean") throw new WebInputError("repoId and paused are required");
    const repository = requireVisibleRepository(repositories, repoId, user);
    sendJson(response, 200, { queue: await setFactoryQueuePaused(repository.path, body.paused) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/factory-queue/dispatch") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "scheduler:run");
    const body = requireObject(await readRequestJson(request));
    const requestedRepoId = typeof body.repoId === "string" ? body.repoId.trim() : undefined;
    if (requestedRepoId) {
      requireVisibleRepository(repositories, requestedRepoId, user);
    }
    const selected = visibleRepositories(repositories, user).filter((repository) =>
      repository.synthetic !== true && (!requestedRepoId || repository.id === requestedRepoId),
    );
    if (requestedRepoId && selected.length === 0) throw new WebNotFoundError("repository not found");
    const dispatched = await Promise.all(selected.map(async (repository) => {
      const providerStore = providerStoreForUser(input, repository.path, user);
      const homeKnowledgeProviderStore = providerStoreForUser(input, homeRepoPath, user);
      const result = await dispatchFactoryQueue({
        repoPath: repository.path,
        runScheduler: (candidateIds, maxConcurrentTasks) => runSchedulerOnce({
          repoPath: repository.path,
          repoId: repository.id,
          repoName: repository.name,
          candidateIds,
          maxConcurrentTasks,
          providerStore,
          scmProvider: createScmProvider("github", { store: providerStore }),
          getChangeRequestStatus: input.getChangeRequestStatus,
          runFlow: async (runInput, dependencies) => {
            const flowDocument = runInput.flowDocument ?? await readFile(runInput.flowPath, "utf8");
            const controls = externalKnowledgeAdmissionControls(
              parseFlowDocument(flowDocument, { externalInputs: Object.keys(runInput.inputs) }).flow,
            );
            const knowledgeProviderStore = controls
              ? await requireWebKnowledgeRunAccess({
                  serverInput: input,
                  homeRepoPath,
                  repository,
                  user,
                  ...(controls.ids ? { attachmentIds: controls.ids } : {}),
                })
              : homeKnowledgeProviderStore;
            return await runner(runInput, { providerStore, knowledgeProviderStore, ...dependencies });
          },
          resumeRun: async (resumeInput) => {
            const pinnedRun = runHasPinnedExternalKnowledge(repository.path, resumeInput.runId);
            const knowledgeProviderStore = pinnedRun
              ? await requireWebKnowledgeRunAccess({
                  serverInput: input,
                  homeRepoPath,
                  repository,
                  user,
                  pinnedRun: true,
                })
              : homeKnowledgeProviderStore;
            return await resumeRun(
              { ...resumeInput, executionBackend: execution.backend },
              { providerStore, knowledgeProviderStore },
            );
          },
        }),
      });
      return { repository: { id: repository.id, name: repository.name }, ...result };
    }));
    sendJson(response, 200, { dispatched });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/scheduler") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, {
      scheduler: await buildAllSchedulerView(repositories, user, input),
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/scheduler/run") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "scheduler:run");
    const schedulerRunRequest = await readSchedulerRunRequest(request);
    const summary = emptySchedulerRunSummary();
    for (const repository of visibleRepositories(repositories, user).filter(
      (candidate) => candidate.synthetic !== true,
    )) {
      const providerStore = providerStoreForUser(input, repository.path, user);
      const homeKnowledgeProviderStore = providerStoreForUser(
        input,
        homeRepoPath,
        user,
      );
      const repoSummary = await runSchedulerOnce({
        repoPath: repository.path,
        repoId: repository.id,
        repoName: repository.name,
        ...schedulerRunRequest,
        providerStore,
        scmProvider: createScmProvider("github", { store: providerStore }),
        getChangeRequestStatus: input.getChangeRequestStatus,
        runFlow: async (runInput, dependencies) => {
          const flowDocument = runInput.flowDocument ??
            await readFile(runInput.flowPath, "utf8");
          const controls = externalKnowledgeAdmissionControls(
            parseFlowDocument(flowDocument, {
              externalInputs: Object.keys(runInput.inputs),
            }).flow,
          );
          const knowledgeProviderStore = controls
            ? await requireWebKnowledgeRunAccess({
                serverInput: input,
                homeRepoPath,
                repository,
                user,
                ...(controls.ids ? { attachmentIds: controls.ids } : {}),
              })
            : homeKnowledgeProviderStore;
          return await runner(runInput, {
            providerStore,
            knowledgeProviderStore,
            ...dependencies,
          });
        },
        resumeRun: async (resumeInput) => {
          const pinnedRun = runHasPinnedExternalKnowledge(
            repository.path,
            resumeInput.runId,
          );
          const knowledgeProviderStore = pinnedRun
            ? await requireWebKnowledgeRunAccess({
                serverInput: input,
                homeRepoPath,
                repository,
                user,
                pinnedRun: true,
              })
            : homeKnowledgeProviderStore;
          return await resumeRun(
            { ...resumeInput, executionBackend: execution.backend },
            {
              providerStore,
              knowledgeProviderStore,
            },
          );
        },
        ...(input.createRunId ? { createRunId: input.createRunId } : {}),
      });
      mergeSchedulerRunSummary(summary, repoSummary);
    }
    sendJson(response, 200, { summary });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const notifications = await listAllNotifications(repositories, user, {
      status: notificationStatusFromQuery(url.searchParams.get("status")),
    }, {
      serverInput: input,
    });
    sendJson(response, 200, {
      notifications,
      summary: notificationSummary(notifications),
    });
    return true;
  }

  const notificationActionsId = apiNotificationActionsId(url.pathname);
  if (request.method === "POST" && notificationActionsId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const action = notificationActionFromValue(body.action);
    if (!action) {
      throw new WebInputError("unknown notification action");
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const targetUserId =
      typeof body.targetUserId === "string" ? body.targetUserId : "";
    const scoped = await getScopedNotification(
      repositories,
      notificationActionsId,
      user,
    );
    const applied = await applyNotificationAction({
      serverInput: input,
      homeRepoPath,
      repository: scoped.repository,
      notification: scoped.notification,
      user,
      action,
      ...(reason !== undefined ? { reason } : {}),
      ...(targetUserId ? { targetUserId } : {}),
    });
    sendJson(response, 200, {
      notification: withNotificationRepository(
        applied.notification,
        scoped.repository,
      ),
      ...(applied.decision ? { decision: applied.decision } : {}),
    });
    return true;
  }

  const assignNotificationId = apiNotificationAssignId(url.pathname);
  if (request.method === "POST" && assignNotificationId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, notification } = await getScopedNotification(
      repositories,
      assignNotificationId,
      user,
    );
    const body = requireObject(await readRequestJson(request));
    const targetUserId =
      typeof body.targetUserId === "string" && body.targetUserId.trim()
        ? body.targetUserId.trim()
        : "";
    const applied = await applyNotificationAction({
      serverInput: input,
      homeRepoPath,
      repository,
      notification,
      user,
      action: "assign",
      targetUserId,
    });
    sendJson(response, 200, {
      notification: withNotificationRepository(applied.notification, repository),
      ...(applied.decision ? { decision: applied.decision } : {}),
    });
    return true;
  }

  const resolveNotificationId = apiNotificationResolveId(url.pathname);
  if (request.method === "POST" && resolveNotificationId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const resolution =
      typeof body.resolution === "string" && body.resolution.trim()
        ? body.resolution.trim()
        : "resolved";
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : undefined;
    const scopedNotification = await getScopedNotification(
      repositories,
      resolveNotificationId,
      user,
    );
    const legacyDecisionAction: NotificationAction | undefined =
      resolution === "approved" &&
      scopedNotification.notification.supportedActions.includes("approve")
        ? "approve"
        : resolution === "denied" &&
            scopedNotification.notification.supportedActions.includes("deny")
          ? "deny"
          : resolution === "resolved" &&
              scopedNotification.notification.supportedActions.includes("resolve")
            ? "resolve"
            : undefined;
    if (!legacyDecisionAction) {
      throw new WebInputError(
        "legacy notification resolution does not match a declared action",
      );
    }
    const applied = await applyNotificationAction({
      serverInput: input,
      homeRepoPath,
      repository: scopedNotification.repository,
      notification: scopedNotification.notification,
      user,
      action: legacyDecisionAction,
      ...(reason ? { reason } : {}),
    });
    sendJson(response, 200, {
      notification: withNotificationRepository(
        applied.notification,
        scopedNotification.repository,
      ),
      ...(applied.decision ? { decision: applied.decision } : {}),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required" ? currentWritableOrganizationId(user) : undefined;
    const taskInput = taskInputFromJson(await readRequestJson(request));
    const { planningStatus, ...taskCreateInput } = taskInput;
    const repository = requireRepositoryForOrganization(
      repositories,
      taskInput.repoId,
      user,
      organizationId,
    );
    const templateSelection = taskTemplateSelection(taskInput.templateId);
    const task = await createTask(
      repository.path,
      {
        ...taskCreateInput,
        ...(templateSelection ? { flowPath: templateSelection.flowPath } : {}),
      },
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(organizationId ? { organizationId } : {}),
        repoId: repository.id,
        ...(planningStatus === "draft"
          ? {
              initialStatus: "draft" as const,
              specStatus: "draft" as const,
              techDesignStatus: "draft" as const,
            }
          : {}),
        ...(templateSelection ? { template: templateSelection.template } : {}),
        resyncRepository: () => syncStoredWebRepository(repository),
      },
    );
    scheduleDependencySuggestionRefresh(repository.path, task.id);
    sendJson(response, 201, { task: withRepository(task, repository) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/draft-specs") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required" ? currentWritableOrganizationId(user) : undefined;
    const draftInput = draftSpecInputFromJson(await readRequestJson(request));
    const repository = requireRepositoryForOrganization(
      repositories,
      draftInput.repoId,
      user,
      organizationId,
    );
    const guidance = draftInput.guidance?.trim();
    let source: DraftSpecSource;
    let sourceSnapshot: TaskSourceSnapshot | undefined;
    let sourceDrift: TaskSourceDrift | undefined;
    let normalizedTicket: NormalizedTicket | undefined;
    let normalizedDocument: NormalizedExternalDocument | undefined;
    let sourceStatusSync: TaskSourceStatusSync | undefined;
    let sourceConversation: TaskSourceConversation | undefined;
    const ticketProviderStore = providerStoreForUser(
      input,
      repository.path,
      user,
    );
    if (isTicketSourceType(draftInput.sourceType)) {
      try {
        if (draftInput.sourceType === "github-issue") {
          const reference = parseGitHubIssueReference(draftInput.issue ?? "");
          const issue: GitHubIssueContent = input.githubIssueFetcher
            ? await input.githubIssueFetcher(reference)
            : await defaultGitHubIssueFetcher(reference, {
                providerStore: ticketProviderStore,
              });
          normalizedTicket = normalizeGitHubIssue(reference, issue);
        } else {
          const baseUrl = await configuredJiraBaseUrl(ticketProviderStore);
          const reference = parseJiraTicketReference(
            draftInput.issue ?? "",
            baseUrl,
          );
          normalizedTicket = input.jiraTicketFetcher
            ? await input.jiraTicketFetcher(reference)
            : await defaultJiraTicketFetcher(reference, {
                providerStore: ticketProviderStore,
              });
          if (normalizedTicket.sourceType !== "jira-ticket") {
            throw new Error("Jira ticket fetcher returned the wrong source type");
          }
        }
      } catch (error) {
        throw new WebInputError((error as Error).message);
      }
      sourceSnapshot = ticketSourceSnapshot(normalizedTicket);
      const existingTask = await findTaskByTicket(
        repository.path,
        normalizedTicket,
      );
      sourceStatusSync = ticketStatusSyncConfiguration(
        draftInput,
        existingTask?.source?.statusSync,
      );
      if (existingTask) {
        requireRecordAccess(existingTask, user, "task not found");
        requireWriteAccessToRecord(user, existingTask);
        const storedBaseline = existingTask.source?.snapshot;
        const baselineSnapshot = storedBaseline
          ? storedBaseline.externalId
            ? storedBaseline
            : { ...storedBaseline, externalId: sourceSnapshot.externalId }
          : sourceSnapshot;
        const drift = sourceDriftFromSnapshots(baselineSnapshot, sourceSnapshot);
        let updatedTask = await updateTaskSourceRecord(
          repository.path,
          existingTask.id,
          taskSourceFromTicket(
            {
              ...normalizedTicket,
              title: existingTask.source?.title ?? normalizedTicket.title,
            },
            baselineSnapshot,
            drift,
            sourceStatusSync,
          ),
        );
        let statusSyncResult:
          | Omit<JiraTaskStatusSyncResult, "task">
          | { synced: false; unchanged: false; error: string }
          | undefined;
        if (
          normalizedTicket.sourceType === "jira-ticket" &&
          sourceStatusSync?.enabled
        ) {
          try {
            const synced = await syncJiraTaskStatus({
              repoPath: repository.path,
              task: updatedTask,
              providerStore: ticketProviderStore,
              publisher: input.jiraStatusPublisher,
            });
            updatedTask = synced.task;
            statusSyncResult = {
              synced: synced.synced,
              unchanged: synced.unchanged,
              ...(synced.commentUrl ? { commentUrl: synced.commentUrl } : {}),
            };
          } catch (error) {
            updatedTask = await getTask(repository.path, updatedTask.id);
            statusSyncResult = {
              synced: false,
              unchanged: false,
              error: safeJiraSyncError(error),
            };
          }
        }
        const detail = await getTaskDetail(repository.path, updatedTask.id);
        sendJson(response, 200, {
          task: withRepository(updatedTask, repository),
          spec: detail.spec,
          ingestion: {
            created: false,
            reused: true,
            driftStatus: drift.status,
          },
          ...(statusSyncResult ? { statusSync: statusSyncResult } : {}),
        });
        return true;
      }
      if (
        normalizedTicket.sourceType === "github-issue" &&
        sourceSnapshot.state?.toLowerCase() === "closed"
      ) {
        throw new WebInputError("GitHub issue is closed");
      }
      sourceDrift = {
        status: "unchanged",
        checkedAt: sourceSnapshot.fetchedAt,
        changedFields: [],
      };
      source = {
        type: normalizedTicket.sourceType,
        title: normalizedTicket.title,
        body: normalizedTicket.body,
        uri: normalizedTicket.url,
        ...(guidance ? { guidance } : {}),
      };
    } else if (draftInput.sourceType === "external-document") {
      try {
        normalizedDocument = normalizeExternalDocument({
          url: draftInput.documentUrl ?? "",
          body: draftInput.text ?? "",
          ...(draftInput.title ? { title: draftInput.title } : {}),
          ...(draftInput.documentVersion
            ? { version: draftInput.documentVersion }
            : {}),
          ...(draftInput.documentExternalId
            ? { externalId: draftInput.documentExternalId }
            : {}),
          ...(draftInput.documentAuthor
            ? { author: draftInput.documentAuthor }
            : {}),
          ...(draftInput.documentUpdatedAt
            ? { updatedAt: draftInput.documentUpdatedAt }
            : {}),
        });
      } catch (error) {
        if (error instanceof ExternalDocumentInputError) {
          throw new WebInputError(error.message);
        }
        throw error;
      }
      sourceSnapshot = externalDocumentSourceSnapshot(normalizedDocument);
      const existingTask = await findTaskByExternalDocument(
        repository.path,
        normalizedDocument,
      );
      if (existingTask) {
        requireRecordAccess(existingTask, user, "task not found");
        requireWriteAccessToRecord(user, existingTask);
        const baselineSnapshot = existingTask.source?.snapshot ?? sourceSnapshot;
        const drift = sourceDriftFromSnapshots(baselineSnapshot, sourceSnapshot);
        // The record keeps the approved baseline's revision. A newer provider
        // revision stays visible on drift.latestSnapshot until planning is
        // refreshed from it.
        const baselineVersion =
          existingTask.source?.version ?? baselineSnapshot.version;
        const updatedTask = await updateTaskSourceRecord(
          repository.path,
          existingTask.id,
          {
            type: "external-document",
            uri: normalizedDocument.url,
            externalId: normalizedDocument.externalId,
            title: existingTask.source?.title ?? normalizedDocument.title,
            ...(baselineVersion ? { version: baselineVersion } : {}),
            snapshot: baselineSnapshot,
            drift,
            ...(existingTask.source?.conversation
              ? { conversation: existingTask.source.conversation }
              : {}),
          },
        );
        const detail = await getTaskDetail(repository.path, updatedTask.id);
        sendJson(response, 200, {
          task: withRepository(updatedTask, repository),
          spec: detail.spec,
          ingestion: {
            created: false,
            reused: true,
            driftStatus: drift.status,
          },
        });
        return true;
      }
      sourceDrift = {
        status: "unchanged",
        checkedAt: sourceSnapshot.fetchedAt,
        changedFields: [],
      };
      source = {
        type: "external-document" as const,
        title: normalizedDocument.title,
        body: normalizedDocument.body,
        uri: normalizedDocument.url,
        ...(normalizedDocument.version
          ? { version: normalizedDocument.version }
          : {}),
        ...(guidance ? { guidance } : {}),
      };
    } else {
      const conversationTurns = draftInput.conversation;
      const explicitBody =
        draftInput.sourceType === "prompt"
          ? (draftInput.prompt ?? "")
          : (draftInput.text ?? "");
      const body = explicitBody.trim()
        ? explicitBody
        : conversationTurns
          ? conversationIntakeSummary(conversationTurns)
          : explicitBody;
      if (conversationTurns && !body.trim()) {
        throw new WebInputError(
          "conversation intake requires at least one operator turn or an explicit prompt",
        );
      }
      if (conversationTurns) {
        sourceConversation = {
          turns: conversationTurns,
          summary: body.trim(),
          recordedAt: new Date().toISOString(),
        };
      }
      source = {
        type: draftInput.sourceType === "prompt" ? "prompt" : "text",
        body,
        ...(draftInput.title ? { title: draftInput.title } : {}),
        ...(guidance ? { guidance } : {}),
        ...(conversationTurns ? { conversation: conversationTurns } : {}),
      };
    }
    const templateSelection = taskTemplateSelection(draftInput.templateId);
    const selectedFlowPath = templateSelection?.flowPath ?? draftInput.flowPath;
    const draftContextKnowledge = await selectDraftSpecContextKnowledge({
      repoPath: repository.path,
      source,
      flowPath: selectedFlowPath,
    });
    if (draftContextKnowledge.length > 0) {
      source = {
        ...source,
        contextKnowledge: draftContextKnowledge.map(draftSpecContextKnowledge),
      };
    }
    const draftExternalKnowledge = await selectWebExternalKnowledge({
      serverInput: input,
      homeRepoPath,
      repository,
      user,
      queryParts: [source.title, source.body, source.guidance, selectedFlowPath],
    });
    if (draftExternalKnowledge.length > 0) {
      source = { ...source, externalKnowledge: draftExternalKnowledge };
    }
    let draft;
    try {
      draft = generateDraftSpec(source);
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    let task = await createTask(
      repository.path,
      {
        title: draft.title,
        spec: draft.markdown,
        techDesign:
          "# Technical Design\n\nStatus: draft\n\nA technical design must be created and approved before implementation.\n",
        repoId: repository.id,
        ...(draft.source.uri ? { issueUrl: draft.source.uri } : {}),
        ...(templateSelection
          ? { flowPath: templateSelection.flowPath }
          : draftInput.flowPath
            ? { flowPath: draftInput.flowPath }
            : {}),
      },
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(organizationId ? { organizationId } : {}),
        repoId: repository.id,
        initialStatus: "draft",
        specStatus: "draft",
        ...(templateSelection ? { template: templateSelection.template } : {}),
        source:
          normalizedTicket && sourceSnapshot && sourceDrift
            ? taskSourceFromTicket(
                normalizedTicket,
                sourceSnapshot,
                sourceDrift,
                sourceStatusSync,
              )
            : normalizedDocument && sourceSnapshot && sourceDrift
              ? taskSourceFromExternalDocument(
                  normalizedDocument,
                  sourceSnapshot,
                  sourceDrift,
                )
              : {
                  ...draft.source,
                  ...(sourceConversation
                    ? { conversation: sourceConversation }
                    : {}),
                },
        ...(guidance ? { planningNotes: { guidance } } : {}),
      },
    );
    scheduleDependencySuggestionRefresh(repository.path, task.id);
    if (draftContextKnowledge.length > 0) {
      await linkContextKnowledgeEntries(
        repository.path,
        draftContextKnowledge.map((entry) => entry.id),
        { taskId: task.id },
      );
    }
    await upsertAndDispatchNotification(repository.path, input, {
      sourceKey: taskSourceKey(task.id, "draft-spec"),
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      body: "A generated draft spec is ready for human review.",
      taskId: task.id,
      link: taskReviewLink(task.id),
      ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
      ...(task.organizationId ? { organizationId: task.organizationId } : {}),
    }, { providerStore: ticketProviderStore });
    let statusSyncResult:
      | Omit<JiraTaskStatusSyncResult, "task">
      | { synced: false; unchanged: false; error: string }
      | undefined;
    if (
      normalizedTicket?.sourceType === "jira-ticket" &&
      sourceStatusSync?.enabled
    ) {
      try {
        const synced = await syncJiraTaskStatus({
          repoPath: repository.path,
          task,
          providerStore: ticketProviderStore,
          publisher: input.jiraStatusPublisher,
        });
        task = synced.task;
        statusSyncResult = {
          synced: synced.synced,
          unchanged: synced.unchanged,
          ...(synced.commentUrl ? { commentUrl: synced.commentUrl } : {}),
        };
      } catch (error) {
        task = await getTask(repository.path, task.id);
        statusSyncResult = {
          synced: false,
          unchanged: false,
          error: safeJiraSyncError(error),
        };
      }
    }
    sendJson(response, 201, {
      task: withRepository(task, repository),
      spec: draft.markdown,
      ...(draftContextKnowledge.length > 0
        ? {
            contextKnowledge: draftContextKnowledge.map(
              contextKnowledgeDraftSummary,
            ),
          }
        : {}),
      ...(draftExternalKnowledge.length > 0
        ? {
            externalKnowledge: draftExternalKnowledge.map(({ citation }) => ({
              citation,
            })),
          }
        : {}),
      ...(isTicketSourceType(draftInput.sourceType)
        ? {
            ingestion: {
              created: true,
              reused: false,
              driftStatus: "unchanged",
            },
          }
        : {}),
      ...(statusSyncResult ? { statusSync: statusSyncResult } : {}),
    });
    return true;
  }

  const replaceSpecTaskId = apiTaskReplaceSpecId(url.pathname);
  if (request.method === "POST" && replaceSpecTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      replaceSpecTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task, "planning:approve");
    const specAlreadyApproved =
      task.specStatus === "approved" ||
      (task.specStatus === undefined && task.status !== "draft");
    if (specAlreadyApproved) {
      throw new WebInputError("only a draft spec can be replaced");
    }
    const replacement = replaceSpecInputFromJson(await readRequestJson(request));
    const updated = await updateTaskSpec(
      repository.path,
      task.id,
      replacement.spec,
      "draft",
      { status: "draft", techDesignStatus: "draft" },
      { producer: "web-spec-replacement" },
    );
    await upsertAndDispatchNotification(repository.path, input, {
      sourceKey: taskSourceKey(task.id, "draft-spec"),
      type: "review-spec",
      severity: "info",
      title: "Review replaced draft spec",
      body: "A replaced draft spec is ready for human review.",
      taskId: task.id,
      link: taskReviewLink(task.id),
      ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
      ...(task.organizationId ? { organizationId: task.organizationId } : {}),
    }, {
      providerStore: providerStoreForUser(input, repository.path, user),
    });
    sendJson(response, 200, {
      task: withRepository(updated, repository),
      spec: replacement.spec,
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
    requireWriteAccessToRecord(user, task, "planning:approve");
    // A Task created without planningStatus: "draft" arrives already approved,
    // so there is no draft spec to approve. Approving one anyway used to set
    // specStatus while leaving techDesignStatus unset, which trips the
    // never-overridable planning.draft_tech_design blocker in run eligibility
    // and cannot be cleared by approve-tech-design. Refuse with the same
    // predicate approve-tech-design already uses to read the spec, so the two
    // routes cannot disagree about what "approved" means.
    const specAlreadyApproved =
      task.specStatus === "approved" ||
      (task.specStatus === undefined && task.status !== "draft");
    if (specAlreadyApproved) {
      throw new WebInputError("draft spec is required before approval");
    }
    if (task.source) {
      const detail = await getTaskDetail(repository.path, task.id);
      const readiness = evaluateSourceSpecificSpecReadiness(detail.spec);
      if (!readiness.ready) {
        throw new WebInputError(formatSourceSpecificSpecReadinessError(readiness));
      }
    }
    const updated = await updateTaskSpecApproval(
      repository.path,
      task.id,
      "approved",
    );
    const sourceKey = taskSourceKey(task.id, "draft-spec");
    const notification = (await listNotifications(repository.path)).find(
      (candidate) => candidate.sourceKey === sourceKey,
    );
    if (notification) {
      await recordNotificationDecision(repository.path, notification, {
        actorId: user.id,
        action: "approve",
      });
    }
    await resolveNotificationBySourceKey(
      repository.path,
      sourceKey,
      {
        actorId: user.id,
        resolution: "approved",
      },
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
    requireWriteAccessToRecord(user, task, "planning:approve");
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
    const sourceKey = taskSourceKey(task.id, "draft-tech-design");
    const notification = (await listNotifications(repository.path)).find(
      (candidate) => candidate.sourceKey === sourceKey,
    );
    if (notification) {
      await recordNotificationDecision(repository.path, notification, {
        actorId: user.id,
        action: "approve",
      });
    }
    await resolveNotificationBySourceKey(
      repository.path,
      sourceKey,
      {
        actorId: user.id,
        resolution: "approved",
      },
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const preflightTaskId = apiTaskPreflightId(url.pathname);
  if (request.method === "GET" && preflightTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      preflightTaskId,
      user,
    );
    const providerStore = providerStoreForUser(input, repository.path, user);
    const snapshot = await prepareManualWorkItemDetailSnapshot(
      repository.path,
      detail.id,
      user,
    );
    requireRecordAccess(snapshot.detail, user, "task not found");
    const preflight = await evaluateWebWorkItemRunPreflight({
      repoPath: repository.path,
      workItem: snapshot.persisted ?? snapshot.detail,
      providerStore,
    });
    sendJson(response, 200, { preflight });
    return true;
  }

  const taskId = apiTaskId(url.pathname);
  if (request.method === "GET" && taskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      taskId,
      user,
    );
    const providerStore = providerStoreForUser(input, repository.path, user);
    const snapshot = await prepareManualWorkItemDetailSnapshot(
      repository.path,
      detail.id,
      user,
    );
    requireRecordAccess(snapshot.detail, user, "task not found");
    const persisted = snapshot.persisted;
    const starts = persisted
      ? await evaluateWorkItemRunStarts({
            repoPath: repository.path,
            repoId: repository.id,
            repoName: repository.name,
            workItems: snapshot.workItems,
            candidateIds: [persisted.id],
            intent: { kind: "manual" },
            providerStore,
            ...(input.getChangeRequestStatus
              ? { getChangeRequestStatus: input.getChangeRequestStatus }
              : {}),
          })
      : undefined;
    const eligibility = persisted
      ? starts?.eligibility[persisted.id]
      : undefined;
    const preflight =
      eligibility?.checks.preflight ??
      (await evaluateWebWorkItemRunPreflight({
        repoPath: repository.path,
        workItem: snapshot.detail,
        providerStore,
      }));
    const specReadiness =
      eligibility?.checks.specReadiness ??
      (await evaluateWorkItemSpecReadiness(repository.path, snapshot.detail));
    const specApprovalReadiness = specApprovalReadinessForDetail(snapshot.detail);
    const sourceDriftDiff = sourceDriftDiffForDetail(snapshot.detail);
    const notificationDecisions = await listTaskNotificationDecisions(
      repository.path,
      snapshot.detail.id,
    );
    const supportsTaskRework =
      !snapshot.detail.workItemType ||
      snapshot.detail.workItemType === DEV_PR_WORK_ITEM_TYPE;
    const reworkRequests = supportsTaskRework
      ? await listTaskReworkRequests(
          repository.path,
          snapshot.detail.id,
        )
      : [];
    const requestChanges = taskRequestChangesCapability(
      snapshot.detail,
      reworkRequests,
    );
    sendJson(response, 200, {
      task: snapshot.detail,
      spec: snapshot.detail.spec ?? "",
      techDesign: snapshot.detail.techDesign ?? "",
      preflight,
      specReadiness,
      eligibility,
      specApprovalReadiness,
      sourceDriftDiff,
      notificationDecisions,
      reworkRequests,
      ...requestChanges,
      runs: snapshot.detail.runs,
      inputContents: snapshot.detail.inputContents,
      artifacts: snapshot.detail.artifacts,
      artifactsByType: snapshot.detail.artifactsByType,
      readOnly: snapshot.detail.readOnly ?? false,
    });
    return true;
  }

  const reworkRequestsTaskId = apiTaskReworkRequestsId(url.pathname);
  if (reworkRequestsTaskId && request.method === "GET") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      reworkRequestsTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    const reworkRequests = await listTaskReworkRequests(repository.path, task.id);
    sendJson(response, 200, {
      reworkRequests,
      ...taskRequestChangesCapability(task, reworkRequests),
    });
    return true;
  }
  if (reworkRequestsTaskId && request.method === "POST") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = taskReworkRequestInputFromJson(await readRequestJson(request));
    const { repository, task } = await getScopedTask(
      repositories,
      reworkRequestsTaskId,
      user,
    );
    requireWriteAccessToRecord(user, task, "runs:start");
    const flowPath = await resolveTaskReworkFlowPath(
      repository.path,
      body.flowPath,
    );
    const reworkRequest = await createTaskReworkRequest(repository.path, task, {
      instruction: body.instruction,
      ...(body.routeTarget ? { routeTarget: body.routeTarget } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      flowPath,
      actor: {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
      },
    });
    sendJson(response, 201, { reworkRequest });
    return true;
  }

  const reworkRequestRef = apiTaskReworkRequestId(url.pathname);
  if (reworkRequestRef && request.method === "GET" && !reworkRequestRef.action) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      reworkRequestRef.taskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    const reworkRequest = await getTaskReworkRequest(
      repository.path,
      task.id,
      reworkRequestRef.requestId,
    );
    sendJson(response, 200, { reworkRequest });
    return true;
  }
  if (
    reworkRequestRef &&
    request.method === "POST" &&
    reworkRequestRef.action === "cancel"
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const { repository, task } = await getScopedTask(
      repositories,
      reworkRequestRef.taskId,
      user,
    );
    requireWriteAccessToRecord(user, task, "runs:start");
    const reworkRequest = await cancelTaskReworkRequest({
      repoPath: repository.path,
      taskId: task.id,
      requestId: reworkRequestRef.requestId,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    sendJson(response, 200, { reworkRequest });
    return true;
  }
  if (
    reworkRequestRef &&
    request.method === "POST" &&
    reworkRequestRef.action === "confirm"
  ) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      reworkRequestRef.taskId,
      user,
    );
    requireWriteAccessToRecord(user, task, "runs:start");
    const reworkRequest = await getTaskReworkRequest(
      repository.path,
      task.id,
      reworkRequestRef.requestId,
    );
    if (reworkRequest.status !== "pending_confirmation" && reworkRequest.runId) {
      sendJson(response, 200, {
        reworkRequest,
        run: runStartResponse({
          runId: reworkRequest.runId,
          status:
            reworkRequest.status === "completed"
              ? "completed"
              : reworkRequest.status === "failed"
                ? "failed"
                : "running",
          taskId: task.id,
          repoId: repository.id,
        }),
      });
      return true;
    }
    const providerStore = providerStoreForUser(input, repository.path, user);
    const outcome = await startConfirmedTaskReworkRun({
      serverInput: input,
      repository,
      task,
      request: reworkRequest,
      runner,
      providerStore,
    });
    const updatedRequest = await getTaskReworkRequest(
      repository.path,
      task.id,
      reworkRequest.id,
    );
    sendJson(response, 200, {
      reworkRequest: updatedRequest,
      run: runStartResponse(outcome),
    });
    return true;
  }

  const dependencyTaskId = apiTaskDependenciesId(url.pathname);
  if (request.method === "POST" && dependencyTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const dependsOn =
      typeof body.dependsOn === "string"
        ? body.dependsOn.trim()
        : undefined;
    if (!dependsOn) {
      throw new WebInputError("dependsOn is required");
    }
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      dependencyTaskId,
      user,
    );
    requireWriteAccessToRecord(user, detail);
    await getUnifiedWorkItem(repository.path, dependsOn);
    const tasks = await listUnifiedWorkItems(repository.path);
    if (
      wouldCreateCycle(
        tasks as unknown as Parameters<typeof wouldCreateCycle>[0],
        detail.id,
        dependsOn,
      )
    ) {
      throw new WebInputError("dependency would create a cycle");
    }
    const updated = await confirmUnifiedWorkItemDependency(
      repository.path,
      detail.id,
      dependsOn,
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const dependencyId = apiTaskDependencyId(url.pathname);
  if (request.method === "DELETE" && dependencyId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      dependencyId.taskId,
      user,
    );
    requireWriteAccessToRecord(user, detail);
    const updated = await updateUnifiedWorkItemDependencies(
      repository.path,
      detail.id,
      (detail.dependsOn ?? []).filter((id) => id !== dependencyId.upstreamId),
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const dismissSuggestion = apiTaskDependencySuggestionDismissId(url.pathname);
  if (request.method === "POST" && dismissSuggestion) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      dismissSuggestion.taskId,
      user,
    );
    requireWriteAccessToRecord(user, detail);
    const updated = await dismissUnifiedWorkItemDependencySuggestion(
      repository.path,
      detail.id,
      dismissSuggestion.upstreamId,
    );
    sendJson(response, 200, { task: withRepository(updated, repository) });
    return true;
  }

  const refreshSuggestionsTaskId = apiTaskDependencySuggestionsRefreshId(url.pathname);
  if (request.method === "POST" && refreshSuggestionsTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      refreshSuggestionsTaskId,
      user,
    );
    requireWriteAccessToRecord(user, detail);
    const updated = await refreshUnifiedWorkItemDependencySuggestions(
      repository.path,
      detail.id,
    );
    sendJson(response, 200, {
      task: withRepository(updated, repository),
      suggestions: updated.suggestedDependencies ?? [],
    });
    return true;
  }

  const refreshSourcePlanningTaskId = apiTaskRefreshSourcePlanningId(url.pathname);
  if (request.method === "POST" && refreshSourcePlanningTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      refreshSourcePlanningTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task);
    const latestSnapshot = task.source?.drift?.latestSnapshot;
    if (
      !isSnapshotBackedTaskSourceType(task.source?.type) ||
      task.source.drift?.status !== "changed"
    ) {
      throw new WebInputError(
        "source planning refresh requires a changed GitHub issue, Jira ticket, or external document source",
      );
    }
    if (!latestSnapshot) {
      throw new WebInputError("latest source snapshot is required before refreshing planning");
    }
    let draftSource = draftSpecSourceFromSnapshot(task.source.type, latestSnapshot);
    const draftContextKnowledge = await selectDraftSpecContextKnowledge({
      repoPath: repository.path,
      source: draftSource,
      flowPath: task.flowPath,
    });
    if (draftContextKnowledge.length > 0) {
      draftSource = {
        ...draftSource,
        contextKnowledge: draftContextKnowledge.map(draftSpecContextKnowledge),
      };
    }
    const draftExternalKnowledge = await selectWebExternalKnowledge({
      serverInput: input,
      homeRepoPath,
      repository,
      user,
      queryParts: [
        draftSource.title,
        draftSource.body,
        draftSource.guidance,
        task.flowPath,
      ],
    });
    if (draftExternalKnowledge.length > 0) {
      draftSource = {
        ...draftSource,
        externalKnowledge: draftExternalKnowledge,
      };
    }
    let draft;
    try {
      draft = generateDraftSpec(draftSource);
    } catch (error) {
      throw new WebInputError((error as Error).message);
    }
    const refreshedSource: TaskSourceRecord = {
      type: task.source.type,
      uri: latestSnapshot.uri,
      ...(latestSnapshot.externalId
        ? { externalId: latestSnapshot.externalId }
        : task.source.externalId
          ? { externalId: task.source.externalId }
          : {}),
      title: latestSnapshot.title,
      ...(latestSnapshot.version
        ? { version: latestSnapshot.version }
        : task.source.version
          ? { version: task.source.version }
          : {}),
      snapshot: latestSnapshot,
      drift: {
        status: "unchanged",
        checkedAt: latestSnapshot.fetchedAt,
        changedFields: [],
      },
      ...(task.source.statusSync ? { statusSync: task.source.statusSync } : {}),
      ...(task.source.conversation
        ? { conversation: task.source.conversation }
        : {}),
    };
    const updated = await updateTaskSpec(
      repository.path,
      task.id,
      draft.markdown,
      "draft",
      {
        source: refreshedSource,
        status: "draft",
        techDesignStatus: "draft",
      },
    );
    if (draftContextKnowledge.length > 0) {
      await linkContextKnowledgeEntries(
        repository.path,
        draftContextKnowledge.map((entry) => entry.id),
        { taskId: task.id },
      );
    }
    await upsertAndDispatchNotification(repository.path, input, {
      sourceKey: taskSourceKey(task.id, "draft-spec"),
      type: "review-spec",
      severity: "info",
      title: "Review refreshed draft spec",
      body: "The source changed, so Nitely regenerated a draft spec from the latest source snapshot.",
      taskId: task.id,
      link: taskReviewLink(task.id),
      ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
      ...(task.organizationId ? { organizationId: task.organizationId } : {}),
    }, {
      providerStore: providerStoreForUser(input, repository.path, user),
    });
    sendJson(response, 200, {
      task: withRepository(updated, repository),
      spec: draft.markdown,
      ...(draftContextKnowledge.length > 0
        ? {
            contextKnowledge: draftContextKnowledge.map(
              contextKnowledgeDraftSummary,
            ),
          }
        : {}),
      ...(draftExternalKnowledge.length > 0
        ? {
            externalKnowledge: draftExternalKnowledge.map(({ citation }) => ({
              citation,
            })),
          }
        : {}),
    });
    return true;
  }

  const syncSourceStatusTaskId = apiTaskSyncSourceStatusId(url.pathname);
  if (request.method === "POST" && syncSourceStatusTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, task } = await getScopedTask(
      repositories,
      syncSourceStatusTaskId,
      user,
    );
    requireRecordAccess(task, user, "task not found");
    requireWriteAccessToRecord(user, task);
    try {
      const result = await syncJiraTaskStatus({
        repoPath: repository.path,
        task,
        providerStore: providerStoreForUser(input, repository.path, user),
        publisher: input.jiraStatusPublisher,
      });
      sendJson(response, 200, {
        task: withRepository(result.task, repository),
        statusSync: {
          synced: result.synced,
          unchanged: result.unchanged,
          ...(result.commentUrl ? { commentUrl: result.commentUrl } : {}),
        },
      });
      return true;
    } catch (error) {
      throw new WebInputError(safeJiraSyncError(error));
    }
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
    const repositoryPlanContext = await collectRepositoryPlanContext(repository.path);
    const draftExternalKnowledge = await selectWebExternalKnowledge({
      serverInput: input,
      homeRepoPath,
      repository,
      user,
      queryParts: [detail.spec, JSON.stringify(repositoryPlanContext)],
    });
    let draft;
    try {
      draft = generateDraftTechnicalPlan({
        specMarkdown: detail.spec,
        context: repositoryPlanContext,
        ...(draftExternalKnowledge.length > 0
          ? { externalKnowledge: draftExternalKnowledge }
          : {}),
        ...(task.source
          ? {
              source: {
                type: task.source.type,
                ...(task.source.uri ? { uri: task.source.uri } : {}),
                ...(task.source.externalId
                  ? { externalId: task.source.externalId }
                  : {}),
              },
            }
          : {}),
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
    await upsertAndDispatchNotification(repository.path, input, {
      sourceKey: taskSourceKey(task.id, "draft-tech-design"),
      type: "review-tech-design",
      severity: "info",
      title: "Review draft technical design",
      body: "A generated technical design is ready for human review.",
      taskId: task.id,
      link: taskReviewLink(task.id),
      ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
      ...(task.organizationId ? { organizationId: task.organizationId } : {}),
    }, {
      providerStore: providerStoreForUser(input, repository.path, user),
    });
    sendJson(response, 200, {
      task: withRepository(updated, repository),
      techDesign: draft.markdown,
      openQuestions: draft.openQuestions,
      ...(draftExternalKnowledge.length > 0
        ? {
            externalKnowledge: draftExternalKnowledge.map(({ citation }) => ({
              citation,
            })),
          }
        : {}),
    });
    return true;
  }

  const runTaskId = apiTaskRunId(url.pathname);
  if (request.method === "POST" && runTaskId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const runFacts = manualRunRequestFacts(url, body, user);
    const taskScope = taskScopeFromJson(body.taskScope);
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
        input,
        runTaskId,
        user,
        runner,
        "task not found",
        runFacts.intent,
        taskScope,
      );
      sendJson(response, 200, { run: runStartResponse(result) });
      return true;
    }
    requireRecordAccess(currentTask, user, "task not found");
    requireWriteAccessToRecord(user, currentTask, "runs:start");
    if (currentTask.status === "running" && currentTask.latestRunId) {
      const reconciled = await reconcileTerminalWorkItemRun({
        repoPath: repository.path,
        workItemId: currentTask.id,
        runId: currentTask.latestRunId,
      });
      if (!reconciled || reconciled.status === "running") {
        throw new WebRunStartConflictError(
          `Work item snapshot already belongs to Run ${currentTask.latestRunId}`,
          currentTask.latestRunId,
        );
      }
      ({ repository, task: currentTask } = await getScopedTask(
        repositories,
        runTaskId,
        user,
      ));
      requireRecordAccess(currentTask, user, "task not found");
      requireWriteAccessToRecord(user, currentTask, "runs:start");
    }
    const taskProviderStore = providerStoreForUser(input, repository.path, user);
    const preparedCandidate = await prepareWorkItemRunCandidate(
      repository.path,
      currentTask,
      "manual",
    );
    const { activePlanningBaseline, task: taskSnapshot } = preparedCandidate;
    const candidateTask =
      user.authMode === "required" && !taskSnapshot.ownerId
        ? { ...taskSnapshot, ownerId: user.id }
        : taskSnapshot;
    const candidateWorkItem = projectWorkItem(
      candidateTask,
      preparedCandidate.executionInputs,
    );
    const workItems = (await listUnifiedWorkItems(repository.path)).map((item) =>
      item.id === candidateWorkItem.id ? candidateWorkItem : item,
    );
    const candidateVersion = {
      ...preparedCandidate.version,
      dependencyGuards: workItemDependencyGuards(
        candidateWorkItem,
        workItems,
      ),
    };
    const starts = await evaluateWorkItemRunStarts({
      repoPath: repository.path,
      repoId: repository.id,
      repoName: repository.name,
      workItems,
      candidateIds: [currentTask.id],
      intent: runFacts.intent,
      providerStore: taskProviderStore,
      ...(input.getChangeRequestStatus
        ? { getChangeRequestStatus: input.getChangeRequestStatus }
        : {}),
    });
    const decision = starts.eligibility[currentTask.id]!;
    if (decision.decision === "blocked") {
      throw new WebInputError(formatRunEligibilityError(decision));
    }
    const evaluatedInput = starts.runInputs[currentTask.id];
    if (!evaluatedInput) {
      throw new Error(`eligible Work item has no evaluated Run input: ${currentTask.id}`);
    }
    const specReadiness = decision.checks.specReadiness!;
    const sourceDriftWasOverridden = decision.overridden.some(
      (reason) => reason.kind === "source-drift",
    );
    const specReadinessWasOverridden = decision.overridden.some(
      (reason) => reason.kind === "spec-readiness",
    );
    const sourceDriftOverride =
      sourceDriftWasOverridden && currentTask.source?.drift?.status === "changed"
        ? {
            acknowledgedAt: new Date().toISOString(),
            actor: user.email || user.id,
            reason:
              runFacts.overrideReason ??
              "operator acknowledged source drift and started with override=true",
            changedFields: currentTask.source.drift.changedFields,
          }
        : undefined;
    const specReadinessOverride =
      specReadinessWasOverridden && specReadiness.status !== "PASS"
        ? {
            acknowledgedAt: new Date().toISOString(),
            reason:
              runFacts.overrideReason ??
              "operator acknowledged spec readiness risk and started with override=true",
            status: specReadiness.status,
            issueCodes: specReadiness.issues.map((issue) => issue.code),
          }
        : undefined;
    const task = {
      ...candidateTask,
      ...(sourceDriftOverride ? { sourceDriftOverride } : {}),
      ...(specReadinessOverride ? { specReadinessOverride } : {}),
    };
    const finalizedCandidate = await finalizeWorkItemRunCandidate(
      repository.path,
      preparedCandidate,
      task,
    );
    const runnerInput: RunFlowInput = {
      ...evaluatedInput,
      inputs: finalizedCandidate.workItem.inputs,
      ...(taskScope ? { taskScope } : {}),
    };
    const admission = await admitWorkItemRun({
      repoPath: repository.path,
      candidate: {
        workItem: finalizedCandidate.workItem,
        version: candidateVersion,
      },
      runInput: runnerInput,
      legacyState: {
        activePlanningBaseline,
        ...(sourceDriftOverride ? { sourceDriftOverride } : {}),
        ...(specReadinessOverride ? { specReadinessOverride } : {}),
      },
      ...(input.createRunId ? { createRunId: input.createRunId } : {}),
    });
    if (admission.decision === "conflict") {
      throw runStartConflictError(admission);
    }
    const acceptedRun: AcceptedRunMetadata = {
      runId: admission.runId,
      status: "running",
      taskId: runTaskId,
      repoId: repository.id,
      branchName: admission.branchName,
    };
    const cancellation = registerActiveRunCancellation({
      repoPath: repository.path,
      runId: admission.runId,
    });
    let runnerExecution: Promise<RunFlowResult>;
    try {
      runnerExecution = runner(runnerInput, {
        providerStore: taskProviderStore,
        createRunId: () => admission.runId,
        cancellation: cancellation.control,
      });
    } catch (error) {
      runnerExecution = Promise.reject(error);
    }
    const runnerPromise = (async () => {
      try {
        const result = await runnerExecution;
        assertAdmittedRunId(admission.runId, result.runId);
        if (currentProjectedRunStatus(repository.path, admission.runId) === "cancelled") {
          throw new Error(`Run ${admission.runId} was cancelled`);
        }
        if (result.status === "awaiting-approval") {
          const approval = pendingApprovalForRun(
            repository.path,
            result.runId,
            result.approvalId,
          );
          await upsertAndDispatchNotification(repository.path, input, {
            sourceKey: taskSourceKey(
              runTaskId,
              `approval:${result.runId}:${result.approvalId ?? approval?.id ?? "pending"}`,
            ),
            type:
              (approval?.reviewedArtifactIds ?? []).some((id) => id === "spec")
                ? "review-spec"
                : (approval?.reviewedArtifactIds ?? []).some((id) => id === "tech-design")
                  ? "review-tech-design"
                  : "review-rework",
            severity: "warning",
            title: "Approval required",
            body: approval?.prompt ?? "A workflow approval gate is waiting for human review.",
            taskId: runTaskId,
            runId: result.runId,
            link: taskReviewLink(runTaskId),
            ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
            ...(task.organizationId ? { organizationId: task.organizationId } : {}),
          }, { providerStore: taskProviderStore });
          return result;
        }
        const settled = await settleWorkItemRun({
          repoPath: repository.path,
          workItemId: runTaskId,
          runId: admission.runId,
          status: "completed",
          ...(result.changeRequestUrl
            ? { changeRequestUrl: result.changeRequestUrl }
            : {}),
        });
        if (!settled.settled) {
          throw new Error(`admitted Run no longer owns Task: ${admission.runId}`);
        }
        if (result.changeRequestUrl) {
          const notificationCopy = reviewPrNotificationCopy(result.changeRequest);
          await upsertAndDispatchNotification(repository.path, input, {
            sourceKey: taskSourceKey(runTaskId, `draft-pr:${result.runId}`),
            type: "review-pr",
            severity: "info",
            title: notificationCopy.title,
            body: notificationCopy.body,
            taskId: runTaskId,
            runId: result.runId,
            link: result.changeRequestUrl,
            ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
            ...(task.organizationId ? { organizationId: task.organizationId } : {}),
          }, { providerStore: taskProviderStore });
        }
        ensureRunCompletedEvent(repository.path, result, runnerInput);
        return result;
      } catch (error) {
        await settleAdmittedRunAfterRunnerError(
          repository.path,
          runTaskId,
          admission.runId,
          error,
        );
        await upsertAndDispatchNotification(repository.path, input, {
          sourceKey: taskSourceKey(runTaskId, `run-blocked:${admission.runId}`),
          type: "resolve-blocker",
          severity: "blocker",
          title: "Run needs human input",
          body: error instanceof Error ? error.message : String(error),
          taskId: runTaskId,
          runId: admission.runId,
          link: taskReviewLink(runTaskId),
          ...(task.ownerId ? { targetUserId: task.ownerId } : {}),
          ...(task.organizationId ? { organizationId: task.organizationId } : {}),
        }, { providerStore: taskProviderStore });
        throw error;
      } finally {
        cancellation.finish();
      }
    })();
    void runnerPromise.catch(() => {});
    const earlyRunnerFailure = runnerExecution.then(
      () => new Promise<never>(() => {}),
      (error) => Promise.reject(error),
    );
    void earlyRunnerFailure.catch(() => {});
    const outcome = await Promise.race([
      runnerPromise,
      earlyRunnerFailure,
      new Promise<AcceptedRunMetadata>((resolveAccepted) => {
        setImmediate(() => resolveAccepted(acceptedRun));
      }),
    ]);
    sendJson(response, 200, { run: runStartResponse(outcome) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/flows") {
    const user = await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { flows: await listFlowViews(homeRepoPath, user) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/flows/templates") {
    await requireUserContext(request, input, homeRepoPath);
    sendJson(response, 200, { templates: flowTemplates });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/flows/from-template") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required"
        ? currentWritableOrganizationId(user, "flows:manage")
        : undefined;
    const body = requireObject(await readRequestJson(request));
    const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
    const template = getFlowTemplate(templateId);
    if (!template) {
      throw new WebInputError("flow template not found");
    }
    const reviewStagePrompt =
      typeof body.reviewStagePrompt === "string"
        ? body.reviewStagePrompt
        : body.insertReviewStage === true
          ? "Review the approved inputs before implementation starts. Write `Review verdict: pass` only when the work is ready to implement."
          : undefined;
    const document = flowTemplateDocumentForCopy(template, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(reviewStagePrompt ? { reviewStagePrompt } : {}),
    });
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
        ...(organizationId ? { organizationId } : {}),
        template: flowTemplateLineage(template),
      });
      sendJson(response, 201, { flow: record });
    } finally {
      store.close();
    }
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
    const organizationId =
      user.authMode === "required"
        ? currentWritableOrganizationId(user, "flows:manage")
        : undefined;
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
        ...(organizationId ? { organizationId } : {}),
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
      const user = await requireUserContext(request, input, homeRepoPath);
      sendJson(response, 200, { flow: await getFlowView(homeRepoPath, flowId, user) });
      return true;
    }
    if (request.method === "PUT") {
      const user = await requireUserContext(request, input, homeRepoPath);
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
        const existing = store.getFlow(flowId);
        requireRecordAccess(existing, user, "flow not found");
        requireWriteAccessToRecord(user, existing, "flows:manage");
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
      const user = await requireUserContext(request, input, homeRepoPath);
      if (flowId.startsWith("flows/")) {
        throw new WebInputError("built-in flows are read-only");
      }
      const store = openFlowStore(homeRepoPath);
      try {
        const existing = store.getFlow(flowId);
        requireRecordAccess(existing, user, "flow not found");
        requireWriteAccessToRecord(user, existing, "flows:manage");
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
      workItems: await listAllWorkItemViews(
        visibleRepositories(repositories, user),
        user,
      ),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/work-items") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const organizationId =
      user.authMode === "required" ? currentWritableOrganizationId(user) : undefined;
    const body = requireObject(await readRequestJson(request));
    const flowId =
      typeof body.flowId === "string" && body.flowId ? body.flowId : undefined;
    if (flowId) {
      const flowStore = openFlowStore(homeRepoPath);
      try {
        requireRecordAccess(flowStore.getFlow(flowId), user, "flow not found");
      } finally {
        flowStore.close();
      }
    }
    const repository = requireRepositoryForOrganization(
      repositories,
      typeof body.repoId === "string" ? body.repoId : undefined,
      user,
      organizationId,
    );
    const workItem = await createFlowWorkItem(
      repository.path,
      {
        title: typeof body.title === "string" ? body.title : "",
        repoId: repository.id,
        ...(typeof body.templateId === "string" && body.templateId
          ? { templateId: body.templateId }
          : flowId
            ? { flowId }
            : { flowPath: typeof body.flowPath === "string" ? body.flowPath : "" }),
        inputs: isResourceReferenceMap(body.inputs) ? body.inputs : {},
        ...(body.configuration &&
        typeof body.configuration === "object" &&
        !Array.isArray(body.configuration)
          ? { configuration: body.configuration as Record<string, unknown> }
          : {}),
        ...(typeof body.issueUrl === "string" ? { issueUrl: body.issueUrl } : {}),
        ...(typeof body.workItemType === "string"
          ? { workItemType: body.workItemType }
          : {}),
        ...(parseOptionalPriority(body.priority)
          ? { priority: parseOptionalPriority(body.priority) }
          : {}),
        ...(parseOptionalDependencyIds(body.dependsOn)
          ? { dependsOn: parseOptionalDependencyIds(body.dependsOn) }
          : {}),
        ...(parseOptionalSuggestedDependencies(body.suggestedDependencies)
          ? {
              suggestedDependencies: parseOptionalSuggestedDependencies(
                body.suggestedDependencies,
              ),
            }
          : {}),
      },
      {
        ...(user.authMode === "required" ? { ownerId: user.id } : {}),
        ...(organizationId ? { organizationId } : {}),
        repoId: repository.id,
      },
    );
    scheduleDependencySuggestionRefresh(repository.path, workItem.id);
    sendJson(response, 201, { workItem: withRepository(workItem, repository) });
    return true;
  }

  const workItemRunId = apiWorkItemRunId(url.pathname);
  if (request.method === "POST" && workItemRunId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const body = requireObject(await readRequestJson(request));
    const runFacts = manualRunRequestFacts(url, body, user);
    const taskScope = taskScopeFromJson(body.taskScope);
    const result = await runStoredWorkItemAcrossRepositories(
      repositories,
      input,
      workItemRunId,
      user,
      runner,
      "work item not found",
      runFacts.intent,
      taskScope,
    );
    sendJson(response, 200, { run: result });
    return true;
  }

  const workItemId = apiWorkItemId(url.pathname);
  if (request.method === "GET" && workItemId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const { repository, detail } = await getScopedWorkItemView(
      repositories,
      workItemId,
      user,
    );
    const snapshot = await prepareManualWorkItemDetailSnapshot(
      repository.path,
      detail.id,
      user,
    );
    requireRecordAccess(snapshot.detail, user, "task not found");
    const persisted = snapshot.persisted;
    const starts = persisted
      ? await evaluateWorkItemRunStarts({
          repoPath: repository.path,
          repoId: repository.id,
          repoName: repository.name,
          workItems: snapshot.workItems,
          candidateIds: [persisted.id],
          intent: { kind: "manual" },
          providerStore: providerStoreForUser(input, repository.path, user),
          ...(input.getChangeRequestStatus
            ? { getChangeRequestStatus: input.getChangeRequestStatus }
            : {}),
        })
      : undefined;
    sendJson(response, 200, {
      workItem: snapshot.detail,
      ...(persisted
        ? { eligibility: starts?.eligibility[persisted.id] }
        : {}),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/context-kg") {
    const user = await requireUserContext(request, input, homeRepoPath);
    const repository = requireVisibleRepository(
      repositories,
      url.searchParams.get("repoId") ?? undefined,
      user,
    );
    const entries = await listContextKnowledgeEntries(repository.path);
    sendJson(response, 200, {
      entries: entries.map((entry) =>
        withContextKnowledgeRepository(entry, repository),
      ),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/context-kg") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "context:manage");
    const parsed = createContextKnowledgeInputFromJson(
      await readRequestJson(request),
    );
    const repository = requireVisibleRepository(repositories, parsed.repoId, user);
    try {
      const entry = await createContextKnowledgeEntry(
        repository.path,
        parsed.entry,
      );
      sendJson(response, 201, {
        entry: withContextKnowledgeRepository(entry, repository),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WebInputError(message);
    }
  }

  const contextKnowledgeId = apiContextKnowledgeId(url.pathname);
  if (request.method === "GET" && contextKnowledgeId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const requestedRepoId = url.searchParams.get("repoId") ?? undefined;
    const candidates = requestedRepoId
      ? [requireVisibleRepository(repositories, requestedRepoId, user)]
      : visibleRepositories(repositories, user);
    for (const repository of candidates) {
      const entries = await listContextKnowledgeEntries(repository.path);
      const entry = entries.find(
        (candidate) => candidate.id === contextKnowledgeId,
      );
      if (entry) {
        sendJson(response, 200, {
          entry: withContextKnowledgeRepository(entry, repository),
        });
        return true;
      }
    }
    throw new WebNotFoundError("context-kg entry not found");
  }
  if (request.method === "PATCH" && contextKnowledgeId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireAdminAccess(user, "context:manage");
    const parsed = updateContextKnowledgeInputFromJson(
      await readRequestJson(request),
    );
    const repository = requireVisibleRepository(
      repositories,
      parsed.repoId ?? url.searchParams.get("repoId") ?? undefined,
      user,
    );
    try {
      const entry = await updateContextKnowledgeEntry(
        repository.path,
        contextKnowledgeId,
        parsed.patch,
      );
      sendJson(response, 200, {
        entry: withContextKnowledgeRepository(entry, repository),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) {
        throw new WebNotFoundError("context-kg entry not found");
      }
      throw new WebInputError(message);
    }
  }

  const runQuestionAnswer = apiRunQuestionAnswerId(url.pathname);
  if (request.method === "POST" && runQuestionAnswer) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const run = await getScopedRunDetail(
      repositories,
      homeRepoPath,
      input,
      runQuestionAnswer.runId,
      user,
    );
    requireWriteAccessToRecord(user, run, "runs:review");
    const body = requireObject(await readRequestJson(request));
    const optionId =
      typeof body.optionId === "string" && body.optionId.trim()
        ? body.optionId.trim()
        : undefined;
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : undefined;
    try {
      const question = await answerQuestion({
        repoPath: run.repoPath,
        runId: runQuestionAnswer.runId,
        questionId: runQuestionAnswer.questionId,
        answer: {
          ...(optionId ? { optionId } : {}),
          ...(text ? { text } : {}),
        },
        actor: user.id,
      });
      sendJson(response, 200, { question });
    } catch (error) {
      throw new WebInputError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
  const runReviewVerdictId = apiRunReviewVerdictId(url.pathname);
  if (request.method === "POST" && runReviewVerdictId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const run = await getScopedRunDetail(
      repositories,
      homeRepoPath,
      input,
      runReviewVerdictId,
      user,
    );
    requireWriteAccessToRecord(user, run, "runs:review");
    const body = requireObject(await readRequestJson(request));
    const content =
      typeof body.content === "string" && body.content.trim()
        ? body.content
        : undefined;
    if (!content) throw new WebInputError("content is required");
    const mediaType =
      body.mediaType === undefined || body.mediaType === "text/markdown"
        ? "text/markdown"
        : body.mediaType === "text/plain"
          ? "text/plain"
          : undefined;
    if (!mediaType) {
      throw new WebInputError(
        "mediaType must be text/markdown or text/plain",
      );
    }
    const rawReviewedArtifactIds = body.reviewedArtifactIds;
    const rawReviewedArtifactCount = Array.isArray(rawReviewedArtifactIds)
      ? rawReviewedArtifactIds.length
      : 0;
    const reviewedArtifactIds = Array.isArray(rawReviewedArtifactIds)
      ? rawReviewedArtifactIds.filter(
          (artifactId): artifactId is string =>
            typeof artifactId === "string" && artifactId.trim().length > 0,
        )
      : undefined;
    if (
      !reviewedArtifactIds ||
      reviewedArtifactIds.length === 0 ||
      reviewedArtifactIds.length !== rawReviewedArtifactCount
    ) {
      throw new WebInputError(
        "reviewedArtifactIds must be a non-empty array of strings",
      );
    }
    try {
      const gate = await submitOperatorReview({
        repoPath: run.repoPath,
        runId: runReviewVerdictId,
        actor: user.id,
        content,
        mediaType,
        reviewedArtifactIds,
      });
      sendJson(response, 201, { gate });
    } catch (error) {
      throw new WebInputError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
  const runLogsStreamId = apiRunLogsStreamId(url.pathname);
  if (request.method === "GET" && runLogsStreamId) {
    const user = await requireUserContext(request, input, homeRepoPath);
    const run = await getScopedRunDetail(
      repositories,
      homeRepoPath,
      input,
      runLogsStreamId,
      user,
    );
    const repoPath = run.repoPath ?? homeRepoPath;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }
    response.write(": connected\n\n");

    const abort = new AbortController();
    const onClose = () => abort.abort();
    request.on("close", onClose);
    const writeEvent = (event: string, data: unknown) => {
      if (response.writableEnded || abort.signal.aborted) return;
      response.write(`event: ${event}\ndata: ${serializeWebJson(data)}\n\n`);
    };

    try {
      let lastFingerprint = "";
      // Cap idle streams so a forgotten tab cannot hold a socket forever.
      const deadline = Date.now() + 30 * 60 * 1000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        const snapshot = await getRunLogStreamSnapshot(repoPath, runLogsStreamId);
        const fingerprint = JSON.stringify({
          status: snapshot.status,
          logs: snapshot.logs,
        });
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          writeEvent("logs", snapshot);
        } else {
          response.write(": ping\n\n");
        }
        if (snapshot.terminal) {
          writeEvent("done", { status: snapshot.status, runId: snapshot.runId });
          break;
        }
        try {
          await sleep(500, abort.signal);
        } catch {
          break;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && !response.writableEnded) {
        writeEvent("error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      request.off("close", onClose);
      if (!response.writableEnded) {
        response.end();
      }
    }
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
    requireCurrentOrganizationPermission(user, "providers:write:personal");
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    const providerId = requireWritableProviderId(providerConnMatch[1]);
    await requireExistingProviderCredentialWriteAccess(
      providerStore,
      providerId,
      user,
    );

    if (request.method === "POST") {
      const setConnection = requireSetConnection(providerStore);
      const body = requireObject(await readRequestJson(request));
      const value =
        typeof body.value === "string" ? body.value.trim() : "";
      if (!value) {
        throw new WebInputError("value is required");
      }
      const authMethod = parsePastedProviderAuthMethod(providerId, body.authMethod);
      const connectionId = optionalMetadataString(body, "connectionId");
      const label = optionalMetadataString(body, "label");
      const record = await setConnection({
        providerId,
        value,
        ...(authMethod ? { authMethod } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(label ? { label } : {}),
        ...(body.makeDefault === true ? { makeDefault: true } : {}),
        metadata: parseProviderCredentialMetadata(body, user),
      });
      sendJson(response, 200, {
        ok: true,
        connection: publicProviderConnection(record),
      });
      return true;
    }
    if (request.method === "DELETE") {
      const clearConnection = requireClearConnection(providerStore);
      const connectionId = url.searchParams.get("connectionId") ?? undefined;
      const authMethod = url.searchParams.get("authMethod") ?? undefined;
      if (connectionId || authMethod) {
        await clearConnection(providerId, {
          ...(connectionId ? { connectionId } : {}),
          ...(authMethod
            ? { authMethod: parseProviderAuthMethod(providerId, authMethod) }
            : {}),
        });
      } else {
        await clearConnection(providerId);
      }
      sendJson(response, 200, { ok: true });
      return true;
    }
  }

  const providerDefaultMatch =
    /^\/api\/providers\/([^/]+)\/connections\/([^/]+)\/default$/.exec(url.pathname);
  if (providerDefaultMatch && request.method === "POST") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "providers:write:personal");
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    const providerId = requireWritableProviderId(providerDefaultMatch[1]);
    await requireExistingProviderCredentialWriteAccess(providerStore, providerId, user);
    if (typeof providerStore.setDefaultConnection !== "function") {
      throw new WebInputError("provider connection store is read-only");
    }
    try {
      await providerStore.setDefaultConnection(
        providerId,
        decodeURIComponent(providerDefaultMatch[2]),
      );
    } catch (error) {
      if (error instanceof MissingConnectionError) {
        throw new WebNotFoundError("provider connection not found");
      }
      throw error;
    }
    sendJson(response, 200, { ok: true });
    return true;
  }

  const providerOAuthStartMatch =
    /^\/api\/providers\/([^/]+)\/oauth\/start$/.exec(url.pathname);
  if (providerOAuthStartMatch && request.method === "POST") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "providers:write:personal");
    const providerId = requireWritableProviderId(providerOAuthStartMatch[1]);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    await requireExistingProviderCredentialWriteAccess(providerStore, providerId, user);
    const adapter = requireProviderOAuthAdapter(input, providerId);
    const body = requireObject(await readRequestJson(request));
    const connectionId = optionalMetadataString(body, "connectionId");
    if (connectionId) {
      const existing = (await providerStore.listConnections?.(providerId))?.find(
        (record) => record.id === connectionId,
      );
      if (!existing) throw new WebNotFoundError("provider connection not found");
      if (existing.authMethod !== "oauth") {
        throw new WebInputError("only OAuth connections can be reconnected through the connect flow");
      }
    }
    const flow = input.providerOAuth!.flows.start({
      userId: user.id,
      providerId,
      ...(connectionId ? { connectionId } : {}),
    });
    const authorizeUrl = adapter.authorizeUrl({
      state: flow.state,
      redirectUri: providerOAuthRedirectUri(request, input, providerId),
      codeChallenge: flow.codeChallenge,
    });
    sendJson(response, 200, { authorizeUrl });
    return true;
  }

  const providerOAuthCallbackMatch = /^\/oauth\/callback\/([^/]+)$/.exec(url.pathname);
  if (providerOAuthCallbackMatch && request.method === "GET") {
    await handleProviderOAuthCallback(request, response, input, homeRepoPath, {
      providerId: providerOAuthCallbackMatch[1],
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    });
    return true;
  }

  const providerConnectionActionMatch =
    /^\/api\/providers\/([^/]+)\/connections\/([^/]+)\/(disconnect|validate)$/.exec(url.pathname);
  if (providerConnectionActionMatch && request.method === "POST") {
    const user = await requireUserContext(request, input, homeRepoPath);
    requireCurrentOrganizationPermission(user, "providers:write:personal");
    const providerId = requireWritableProviderId(providerConnectionActionMatch[1]);
    const connectionId = decodeURIComponent(providerConnectionActionMatch[2]);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    await requireExistingProviderCredentialWriteAccess(providerStore, providerId, user);
    const record = (await providerStore.listConnections?.(providerId))?.find(
      (candidate) => candidate.id === connectionId,
    );
    if (!record) throw new WebNotFoundError("provider connection not found");
    if (providerConnectionActionMatch[3] === "disconnect") {
      await disconnectProviderConnection(input, providerStore, record);
      sendJson(response, 200, { ok: true });
      return true;
    }
    const result = await validateProviderConnection(providerStore, record);
    sendJson(response, 200, result);
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    throw new WebNotFoundError("endpoint not found");
  }
  return false;
}

function requireProviderOAuthAdapter(
  input: RuntimeStartWebServerInput,
  providerId: ProviderId,
): ProviderOAuthAdapter {
  const descriptor = findDescriptor(providerId);
  if (!descriptor.authMethods.some((method) => method.method === "oauth")) {
    throw new WebInputError(`provider ${providerId} does not support an OAuth account connection`);
  }
  const adapter = input.providerOAuth?.adapters.get(providerId);
  if (!adapter) {
    const names = PROVIDER_OAUTH_CLIENT_ENV[providerId as keyof typeof PROVIDER_OAUTH_CLIENT_ENV];
    throw new WebInputError(
      `provider ${providerId} OAuth is not configured: set ${names?.clientId ?? "the OAuth client id"} and ${names?.clientSecret ?? "client secret"}`,
    );
  }
  return adapter;
}

/**
 * The callback URL registered with the provider. A configured public URL
 * wins; without one, only a local-mode server may derive it from the Host
 * header, since that header is client-controlled.
 */
function providerOAuthRedirectUri(
  request: IncomingMessage,
  input: RuntimeStartWebServerInput,
  providerId: ProviderId,
): string {
  const configured = (input.providerEnv ?? process.env).NITELY_WEB_PUBLIC_URL?.trim();
  const base = configured
    ? configured.replace(/\/+$/, "")
    : authModeForInput(input) === "local"
      ? publicServerUrl(request)
      : undefined;
  if (!base) {
    throw new WebInputError(
      "set NITELY_WEB_PUBLIC_URL to the address users reach this Console at before connecting providers with OAuth",
    );
  }
  return `${base}/oauth/callback/${encodeURIComponent(providerId)}`;
}

type ProviderOAuthCallbackFailure =
  | ProviderOAuthFlowError["code"]
  | "access_denied"
  | "missing_code"
  | "exchange_failed"
  | "unauthenticated"
  | "unsupported_provider";

async function handleProviderOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
  input: RuntimeStartWebServerInput,
  homeRepoPath: string,
  query: { providerId: string; code: string | null; state: string | null; error: string | null },
): Promise<void> {
  const actor = await securityAuditActorForRequest(request, input, homeRepoPath);
  const finish = async (
    failure: ProviderOAuthCallbackFailure | undefined,
    target?: SecurityAuditTarget,
  ): Promise<void> => {
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "providers.oauth.connect",
      permission: "providers:write:personal",
      decision: failure === "user_mismatch" || failure === "unauthenticated" ? "deny" : "allow",
      outcome: failure ? "error" : "success",
      httpStatus: 303,
      reasonCode: failure ?? "ok",
      actor,
      ...(target ? { target } : {}),
    });
    response.writeHead(303, {
      location: failure
        ? `/providers?oauthError=${encodeURIComponent(failure)}`
        : `/providers?connected=${encodeURIComponent(query.providerId)}`,
      "cache-control": "no-store",
    });
    response.end();
  };
  const descriptor = PROVIDER_DESCRIPTORS.find((p) => p.id === query.providerId);
  if (!descriptor) {
    await finish("unsupported_provider");
    return;
  }
  const target: SecurityAuditTarget = { type: "provider", id: descriptor.id };
  const user = await resolveUserContext(request, input, homeRepoPath);
  if (!user) {
    await finish("unauthenticated", target);
    return;
  }
  // The state is checked before anything else so a forged or replayed
  // callback never reaches the provider's token endpoint.
  let flow;
  try {
    flow = input.providerOAuth!.flows.consume(query.state ?? "", {
      userId: user.id,
      providerId: descriptor.id,
    });
  } catch (error) {
    if (error instanceof ProviderOAuthFlowError) {
      await finish(error.code, target);
      return;
    }
    throw error;
  }
  if (query.error) {
    await finish(query.error === "access_denied" ? "access_denied" : "exchange_failed", target);
    return;
  }
  if (!query.code) {
    await finish("missing_code", target);
    return;
  }
  const adapter = input.providerOAuth!.adapters.get(descriptor.id);
  if (!adapter) {
    await finish("unsupported_provider", target);
    return;
  }
  try {
    const tokens = await adapter.exchangeCode({
      code: query.code,
      redirectUri: providerOAuthRedirectUri(request, input, descriptor.id),
      codeVerifier: flow.codeVerifier,
    });
    const account = await adapter.fetchIdentity(tokens.accessToken);
    const providerStore = providerStoreForUser(input, homeRepoPath, user);
    const setConnection = requireSetConnection(providerStore);
    await setConnection({
      providerId: descriptor.id,
      authMethod: "oauth",
      value: tokens.accessToken,
      ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      scopes: tokens.scopes ?? adapter.scopes,
      account,
      label: account.login ?? account.email ?? account.displayName,
      metadata: parseProviderCredentialMetadata({}, user),
    });
  } catch (error) {
    console.error(
      `Nitely provider OAuth connect failed for ${descriptor.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await finish("exchange_failed", target);
    return;
  }
  await finish(undefined, target);
}

/**
 * Revokes at the provider when the material is still available, then marks
 * the stored connection revoked. Re-running on an already revoked connection
 * is a no-op success, so a retried click never errors.
 */
async function disconnectProviderConnection(
  input: RuntimeStartWebServerInput,
  providerStore: ProviderConnectionStore,
  record: ProviderConnectionRecord,
): Promise<void> {
  if (record.state === "revoked") return;
  if (typeof providerStore.revokeConnection !== "function") {
    throw new WebInputError("provider connection store is read-only");
  }
  const adapter = input.providerOAuth?.adapters.get(record.providerId);
  if (adapter && record.authMethod === "oauth") {
    try {
      const connection = await providerStore.getConnection(record.providerId, {
        connectionId: record.id,
      });
      await adapter.revoke(await connection.getAccessToken());
    } catch (error) {
      // The provider-side revocation is best effort: an expired token or an
      // unreachable provider must not keep the local connection alive.
      if (!(error instanceof ReconnectRequiredError)) {
        console.error(
          `Nitely provider revoke failed for ${record.providerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  await providerStore.revokeConnection(record.providerId, { connectionId: record.id });
}

async function validateProviderConnection(
  providerStore: ProviderConnectionStore,
  record: ProviderConnectionRecord,
): Promise<{ ok: boolean; reason?: string; connection?: ProviderConnectionSummary }> {
  try {
    const connection = await providerStore.getConnection(record.providerId, {
      connectionId: record.id,
    });
    await connection.getAccessToken();
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
  const refreshed = (await providerStore.listConnections?.(record.providerId))?.find(
    (candidate) => candidate.id === record.id,
  ) ?? record;
  return { ok: true, connection: publicProviderConnection(refreshed) };
}

/**
 * The browser runtime the Console boots with, served from this process so a
 * local-first Console needs no public CDN and a sandboxed browser test needs
 * no egress. The files are the packages' own UMD builds, byte-identical to
 * what unpkg served, so the SRI hashes in support.js keep applying.
 */
const VENDOR_ASSETS: Record<string, { package: string; file: string }> = {
  "react.js": { package: "react", file: "umd/react.production.min.js" },
  "react-dom.js": { package: "react-dom", file: "umd/react-dom.production.min.js" },
  "babel.js": { package: "@babel/standalone", file: "babel.min.js" },
};

const vendorRequire = createRequire(import.meta.url);

/**
 * The UMD builds sit outside the packages' `exports` maps, so the package
 * root is located through its package.json and the file joined onto it.
 */
function vendorAssetPath(asset: { package: string; file: string }): string {
  return join(dirname(vendorRequire.resolve(`${asset.package}/package.json`)), asset.file);
}

async function serveVendorAsset(
  response: ServerResponse,
  name: string,
): Promise<boolean> {
  const asset = Object.hasOwn(VENDOR_ASSETS, name) ? VENDOR_ASSETS[name] : undefined;
  if (!asset) return false;
  const content = await readFile(vendorAssetPath(asset), "utf8");
  response.writeHead(200, {
    "content-type": "application/javascript",
    "cache-control": "public, max-age=86400, immutable",
  });
  response.end(content);
  return true;
}

async function serveStaticFile(
  response: ServerResponse,
  relativePath: string,
  extraHeaders?: Record<string, string>,
): Promise<boolean> {
  const safe = relativePath.replace(/\.\.\//g, "").replace(/\.\.\\/g, "");
  const filePath = join(staticDir, safe);
  try {
    const content = await readFile(filePath, "utf8");
    const contentType =
      safe.endsWith(".js") ? "application/javascript" :
      safe.endsWith(".css") ? "text/css" :
      safe.endsWith(".html") ? "text/html" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, ...extraHeaders });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

// This is the RFC 8628 consent screen: framing it is the classic attack
// (bait UI in an iframe, admin clicks Approve, attacker's client gets the
// token). Scoped to /device only — the rest of the app is a separate change.
const DEVICE_PAGE_FRAME_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

async function handleHtmlRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const consolePaths = new Set([
    "/",
    "/dashboard",
    "/agent-stability",
    "/inbox",
    "/context-kg",
    "/scheduler",
    "/schedules",
    "/preview",
    "/tasks",
    "/work-items",
    "/repositories",
    "/flows",
    "/runs",
    "/skills",
    "/providers",
  ]);
  return await dispatchHttpRoutes(
    { method: request.method ?? "", pathname: url.pathname },
    [
      {
        method: "GET",
        matches: (context) => context.pathname === "/support.js",
        handle: async () => await serveStaticFile(response, "support.js"),
      },
      {
        method: "GET",
        matches: (context) => /^\/vendor\/[a-z-]+\.js$/.test(context.pathname),
        handle: async () =>
          await serveVendorAsset(response, url.pathname.slice("/vendor/".length)),
      },
      {
        method: "GET",
        matches: (context) => context.pathname === "/device",
        handle: async () =>
          await serveStaticFile(response, "device.html", DEVICE_PAGE_FRAME_HEADERS),
      },
      {
        method: "GET",
        matches: (context) => consolePaths.has(context.pathname),
        handle: async () => await serveStaticFile(response, "console.dc.html"),
      },
      {
        method: "GET",
        matches: (context) =>
          Boolean(htmlTaskId(context.pathname)) ||
          Boolean(htmlRunId(context.pathname)) ||
          context.pathname.startsWith("/flows/"),
        handle: async () => await serveStaticFile(response, "console.dc.html"),
      },
    ],
  );
}

export async function startWebServer(
  input: StartWebServerInput,
): Promise<WebServer> {
  const OCI_REAPER_INTERVAL_MS = 60_000;
  const runtimeInput: RuntimeStartWebServerInput = {
    ...input,
    host: unbracketHost(input.host),
    authEnv: { ...(input.authEnv ?? process.env) },
    providerOAuth: providerOAuthRuntimeForInput(input),
  };
  const homeMigration = await migrateHomeRepository(
    input.repoPath,
    input.readRepositoryOrigin,
  );
  if (homeMigration.status === "registered") {
    console.warn(
      `Registered the home checkout as repository ${homeMigration.repository.id} from ${homeMigration.repository.sourceUrl}`,
    );
  } else if (
    homeMigration.reason !== "already-registered" &&
    (await hasLegacyHomeState(input.repoPath))
  ) {
    console.warn(
      `Home directory ${resolve(input.repoPath)} has runs or tasks under .nitely but no registered repository (reason: ${homeMigration.reason}${homeMigration.originUrl ? `, origin: ${homeMigration.originUrl}` : ""}). Register it from the Repos page to see that work again.`,
    );
  }
  let githubWebhookConfiguration =
    input.githubWebhook ??
    githubWebhookConfigurationFromEnv(input.githubWebhookEnv ?? process.env);
  if (githubWebhookConfiguration) {
    if (!githubWebhookConfiguration.statusPublisher) {
      const statusPublisher = githubAppStatusPublisherFromEnv(
        input.githubWebhookEnv ?? process.env,
      );
      if (statusPublisher) {
        githubWebhookConfiguration = {
          ...githubWebhookConfiguration,
          statusPublisher,
        };
      }
    }
    const repositories = await loadWebRepositories(
      input.repoPath,
      input.repositories,
    );
    for (const mapping of githubWebhookConfiguration.repositories) {
      if (
        !repositories.some(
          (repository) => repository.id === mapping.repositoryId,
        )
      ) {
        throw new Error(
          `GitHub webhook repository mapping references unknown repository id: ${mapping.repositoryId}` +
            (mapping.repositoryId === LEGACY_DEFAULT_REPOSITORY_ID
              ? " (the implicit default repository was retired; use the repository id shown on the Repos page)"
              : ""),
        );
      }
    }
    runtimeInput.githubWebhookIntake = new GitHubWebhookIntake({
      stateRepoPath: input.repoPath,
      configuration: githubWebhookConfiguration,
      resolveRepository: async (repositoryId) => {
        const current = await loadWebRepositories(
          input.repoPath,
          input.repositories,
        );
        const repository = current.find(
          (candidate) => candidate.id === repositoryId,
        );
        return repository
          ? {
              id: repository.id,
              path: repository.path,
              ...(repository.home === true ? { home: true as const } : {}),
            }
          : undefined;
      },
    });
  }
  delete runtimeInput.githubWebhook;
  delete runtimeInput.githubWebhookEnv;
  const authInput = {
    ...runtimeInput,
    host: runtimeInput.host,
    port: runtimeInput.port,
  };
  const securityPolicy = webStartupSecurityPolicy(authInput);
  const repoPath = resolve(runtimeInput.repoPath);
  runtimeInput.previewManager = new PreviewSessionManager({
    provider: runtimeInput.previewProvider ??
      new PlaywrightChromiumPreviewProvider({
        executablePath:
          (runtimeInput.previewEnv ?? process.env)
            .NITELY_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      }),
    ...(runtimeInput.createPreviewSessionId
      ? { createId: runtimeInput.createPreviewSessionId }
      : {}),
    env: runtimeInput.previewEnv ?? process.env,
  });
  for (const repository of await loadWebRepositories(
    input.repoPath,
    input.repositories,
  )) {
    await runtimeInput.previewManager.markStale(repository.path);
  }
  let adminConfigured = false;
  if (securityPolicy.authMode === "required") {
    const admin = await bootstrapInitialAdmin(
      repoPath,
      runtimeInput.authEnv ?? process.env,
    );
    adminConfigured = admin !== null;
    if (
      !adminConfigured &&
      (securityPolicy.production || securityPolicy.bindScope === "non-loopback")
    ) {
      throw new Error(
        "production or non-loopback Web startup requires a configured administrator; bootstrap one explicitly with NITELY_ADMIN_EMAIL and NITELY_ADMIN_PASSWORD",
      );
    }
  }
  const readiness: WebSecurityReadiness = Object.freeze({
    schemaVersion: "nitely.web-security-readiness.v1",
    ready: securityPolicy.authMode === "local" || adminConfigured,
    production: securityPolicy.production,
    auth: {
      mode: securityPolicy.authMode,
      adminConfigured,
    } as const,
    bind: {
      host: authInput.host,
      scope: securityPolicy.bindScope,
    } as const,
    transport: {
      mode: securityPolicy.trustedProxy
        ? "trusted-reverse-proxy"
        : "loopback-http",
      trustedProxy: securityPolicy.trustedProxy,
      secureCookie: securityPolicy.secureCookie,
    } as const,
    execution: securityPolicy.execution,
  });
  Object.freeze(readiness.auth);
  Object.freeze(readiness.bind);
  Object.freeze(readiness.transport);
  Object.freeze(readiness.execution);
  const loginAttemptLimiter = new LoginAttemptLimiter(
    runtimeInput.loginRateLimit ?? {
      maxFailures: 5,
      windowMs: 15 * 60 * 1_000,
    },
  );
  /**
   * The device-flow endpoints take no credential, so the only thing standing
   * between them and an unattended script is the caller's address.
   */
  const deviceAuthorizationLimiter = new LoginAttemptLimiter({
    maxFailures: 20,
    windowMs: 60_000,
  });
  /**
   * Same budget as a login, but a separate bounded map: see
   * `WebRequestLimiters.deviceApproval` for why sharing one with the login
   * endpoint let login spam reset this counter.
   */
  const deviceApprovalLimiter = new LoginAttemptLimiter(
    runtimeInput.loginRateLimit ?? {
      maxFailures: 5,
      windowMs: 15 * 60 * 1_000,
    },
  );
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && requestUrl.pathname === "/api/readiness") {
        sendJson(response, readiness.ready ? 200 : 503, readiness);
        return;
      }
      const securityAction = webSecurityActionForRequest(
        request.method,
        requestUrl.pathname,
      );
      const credential = bearerCredential(request);
      let securityActor: SecurityAuditActor = { type: "anonymous" };
      let preparedApiToken: PreparedApiTokenRequest | undefined;
      try {
        const isConfiguredGitHubWebhook =
          request.method === "POST" &&
          requestUrl.pathname === "/api/github/webhooks" &&
          Boolean(runtimeInput.githubWebhookIntake);
        preparedApiToken = isConfiguredGitHubWebhook
          ? undefined
          : await prepareApiTokenRequest(request, repoPath, authModeForInput(authInput));
        if (preparedApiToken?.authorized) {
          authorizedApiTokenRequests.set(request, preparedApiToken.authorized);
        }
        if (securityAction) {
          securityActor = await securityAuditActorForRequest(
            request,
            authInput,
            repoPath,
            preparedApiToken,
          );
        }
        if (preparedApiToken?.denial) {
          throw preparedApiToken.denial;
        }
        if (
          await handleApiRequest(request, response, runtimeInput, {
            login: loginAttemptLimiter,
            deviceAuthorization: deviceAuthorizationLimiter,
            deviceApproval: deviceApprovalLimiter,
          })
        ) {
          if (preparedApiToken) {
            await auditApiTokenRequest(repoPath, preparedApiToken, {
              decision: "allow",
              outcome: response.statusCode < 400 ? "success" : "error",
              httpStatus: response.statusCode,
              reasonCode:
                response.statusCode < 400 ? "ok" : `http_${response.statusCode}`,
            });
          }
          await auditWebSecurityAction(
            repoPath,
            securityAction,
            securityActor,
            credential,
            response.statusCode,
            response.statusCode < 400 ? "ok" : `http_${response.statusCode}`,
          );
          return;
        }
        if (await handleHtmlRequest(request, response)) {
          if (preparedApiToken) {
            await auditApiTokenRequest(repoPath, preparedApiToken, {
              decision: "allow",
              outcome: response.statusCode < 400 ? "success" : "error",
              httpStatus: response.statusCode,
              reasonCode:
                response.statusCode < 400 ? "ok" : `http_${response.statusCode}`,
            });
          }
          return;
        }
        sendHtml(response, 404, "Not found");
        if (preparedApiToken) {
          await auditApiTokenRequest(repoPath, preparedApiToken, {
            decision: "allow",
            outcome: "error",
            httpStatus: 404,
            reasonCode: "not_found",
          });
        }
        await auditWebSecurityAction(
          repoPath,
          securityAction,
          securityActor,
          credential,
          404,
          "not_found",
        );
      } catch (error) {
        const details = errorStatusAndCode(error);
        if (preparedApiToken) {
          await auditApiTokenRequest(repoPath, preparedApiToken, {
            decision: preparedApiToken.authorized ? "allow" : "deny",
            outcome: "error",
            httpStatus: details.status,
            reasonCode:
              preparedApiToken.denialReasonCode ?? details.code,
          });
        }
        await auditWebSecurityAction(
          repoPath,
          securityAction,
          securityActor,
          credential,
          details.status,
          preparedApiToken?.denialReasonCode ?? details.code,
        );
        sendError(response, error);
      } finally {
        authorizedApiTokenRequests.delete(request);
      }
    })();
  });
  const closed = new Promise<void>((resolvePromise) => {
    server.once("close", resolvePromise);
  });
  let ociReaperTimer: ReturnType<typeof setInterval> | undefined;

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(runtimeInput.port, runtimeInput.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  if (runtimeInput.githubWebhookIntake) {
    setImmediate(() => {
      void runtimeInput.githubWebhookIntake?.drain().catch((error) => {
        console.error(
          `Nitely GitHub webhook recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  if (readiness.execution.backend === "oci") {
    // Same env resolution the execution-backend policy uses: an explicitly
    // supplied env wins, and otherwise the reaper needs the process env so it
    // reads the operator's DOCKER_HOST, engine command and PATH rather than
    // guessing a socket.
    const reaperEnv =
      runtimeInput.providerEnv || runtimeInput.authEnv
        ? { ...runtimeInput.providerEnv, ...runtimeInput.authEnv }
        : process.env;
    const runOciReaper = () => {
      void reapExpiredOciContainers({ env: reaperEnv }).then((report) => {
        if (report.errors.length > 0) {
          console.error(
            `Nitely OCI orphan reaper failed: ${report.errors.join("; ")}`,
          );
        }
      });
    };
    runOciReaper();
    ociReaperTimer = setInterval(runOciReaper, OCI_REAPER_INTERVAL_MS);
    ociReaperTimer.unref?.();
  }

  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : runtimeInput.port;
  return {
    url: webListenerUrl(runtimeInput.host, port),
    readiness,
    closed,
    close: async () => {
      if (ociReaperTimer) clearInterval(ociReaperTimer);
      await runtimeInput.previewManager?.stopAll();
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    },
  };
}
