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

import {
  RepositoryFlowPathError,
  resolveRepositoryFlowPath,
} from "../flows/paths.js";
import type { IntakeConversationTurn } from "../intake/conversation.js";
import type { PlanningApprovalStatus } from "../work-items/planning.js";
import type { FlowTemplateLineage } from "../flows/templates.js";
import type {
  WorkItemCandidateVersion,
} from "../work-items/types.js";
import type {
  NormalizedLinkedIssue,
  NormalizedTicketAttachment,
  TicketSourceType,
} from "../ticket-sources/types.js";
import { WebInputError, WebNotFoundError } from "./errors.js";
import { setStructuredSpecStatus } from "../spec-artifacts/parse.js";
import { workItemCandidateFingerprint } from "../work-items/candidate-version.js";

export type TaskStatus = "draft" | "ready" | "running" | "completed" | "failed";
export type SpecApprovalStatus = "draft" | "approved";
export type TaskPriority = "P0" | "P1" | "P2" | "P3";
export type PlanningArtifactKind = "spec" | "tech-design";
export type PlanningArtifactApprovalState =
  | "draft"
  | "approved"
  | "rejected"
  | "changes_requested";
export type PlanningArtifactDecision = "approve" | "reject" | "request_changes";

export interface PlanningArtifactDecisionRecord {
  decision: PlanningArtifactDecision;
  at: string;
  actor?: string;
  reason?: string;
}

export interface PlanningArtifactRevision {
  kind: PlanningArtifactKind;
  versionId: string;
  revision: number;
  contentPath: string;
  contentHash: string;
  producer: string;
  sourceInputs?: string[];
  createdAt: string;
  parentVersionId?: string;
  approvalState: PlanningArtifactApprovalState;
  decisions: PlanningArtifactDecisionRecord[];
}

export interface PlanningArtifactVersionSet {
  currentVersionId: string;
  approvedVersionId?: string;
  revisions: PlanningArtifactRevision[];
}

export interface TaskPlanningArtifacts {
  spec?: PlanningArtifactVersionSet;
  techDesign?: PlanningArtifactVersionSet;
}

export interface TaskPlanningBaseline {
  specVersionId?: string;
  specContentHash?: string;
  specContentPath?: string;
  techDesignVersionId?: string;
  techDesignContentHash?: string;
  techDesignContentPath?: string;
  recordedAt: string;
}

export interface SuggestedDependency {
  dependsOn: string;
  reason: string;
  confidence: number;
  source: string;
  suggestedAt: string;
}

export interface TaskSourceCommentSnapshot {
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskSourceSnapshot {
  uri: string;
  externalId?: string;
  title: string;
  body: string;
  fetchedAt: string;
  /**
   * Content digest of the comparable snapshot fields. It travels with the
   * snapshot so an approved planning baseline can be shown to match, or not
   * match, the source it was approved against.
   */
  contentHash?: string;
  /** Provider-reported document revision, when the provider exposes one. */
  version?: string;
  state?: string;
  stateCategory?: string;
  updatedAt?: string;
  author?: string;
  reporter?: string;
  assignees?: string[];
  labels?: string[];
  milestone?: string;
  comments?: TaskSourceCommentSnapshot[];
  attachments?: NormalizedTicketAttachment[];
  linkedIssues?: NormalizedLinkedIssue[];
}

export interface TaskSourceDrift {
  status: "unchanged" | "changed";
  checkedAt: string;
  changedFields: string[];
  latestSnapshot?: TaskSourceSnapshot;
}

export interface TaskSourceIntakeProvenance {
  type: "github-webhook";
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  actorId?: number;
  actorLogin: string;
  event: "issues" | "issue_comment";
  action: "labeled" | "assigned" | "created";
  receivedAt: string;
  eventAt: string;
  requestedFlow: string;
  snapshotSha256: string;
}

export type TaskSourceType =
  | "prompt"
  | "text"
  | "external-document"
  | TicketSourceType;

/**
 * Sources Nitely can re-snapshot and re-plan from. Prompt and text intake have
 * no external baseline to drift against.
 */
export type SnapshotBackedTaskSourceType = TicketSourceType | "external-document";

export function isSnapshotBackedTaskSourceType(
  value: string | undefined,
): value is SnapshotBackedTaskSourceType {
  return (
    value === "github-issue" ||
    value === "jira-ticket" ||
    value === "external-document"
  );
}

export interface TaskSourceConversation {
  turns: IntakeConversationTurn[];
  summary: string;
  recordedAt: string;
}

export interface TaskSourceRecord {
  type: TaskSourceType;
  uri?: string;
  externalId?: string;
  title?: string;
  version?: string;
  snapshot?: TaskSourceSnapshot;
  drift?: TaskSourceDrift;
  statusSync?: TaskSourceStatusSync;
  intake?: TaskSourceIntakeProvenance;
  /**
   * Planning turns kept for auditability when a Task was intaken from a
   * conversation instead of a single prompt or external document.
   */
  conversation?: TaskSourceConversation;
}

export interface TaskSourceStatusSync {
  enabled: boolean;
  publicBaseUrl?: string;
  lastAttemptedAt?: string;
  lastSyncedAt?: string;
  lastFingerprint?: string;
  lastCommentUrl?: string;
  lastError?: string;
}

export interface TaskSourceDriftOverride {
  acknowledgedAt: string;
  reason: string;
  changedFields: string[];
  actor?: string;
}

export interface TaskSpecReadinessOverride {
  acknowledgedAt: string;
  reason: string;
  status: "BLOCK" | "WARN";
  issueCodes: string[];
}

export interface TaskPlanningNotes {
  guidance?: string;
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
  sourceDriftOverride?: TaskSourceDriftOverride;
  specReadinessOverride?: TaskSpecReadinessOverride;
  repoId?: string;
  flowPath: string;
  template?: FlowTemplateLineage;
  issueUrl?: string;
  specPath: string;
  techDesignPath: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  dependsOn?: string[];
  suggestedDependencies?: SuggestedDependency[];
  planningArtifacts?: TaskPlanningArtifacts;
  activePlanningBaseline?: TaskPlanningBaseline;
  priority?: TaskPriority;
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
  planningNotes?: TaskPlanningNotes;
  template?: FlowTemplateLineage;
  /**
   * Bring the repository checkout up to date. Called once, only when a flow
   * path cannot be seen, and expected to resolve true when it changed
   * anything. Nitely's own clones go stale silently: a flow committed after
   * registration is invisible until the checkout is refreshed, and the
   * resulting error points at the path rather than at the stale snapshot.
   */
  resyncRepository?: () => Promise<boolean>;
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

function taskVersionDirectory(
  repoPath: string,
  taskId: string,
  kind: PlanningArtifactKind,
): string {
  return join(taskDirectory(repoPath, taskId), "versions", kind);
}

function planningArtifactKey(
  kind: PlanningArtifactKind,
): keyof TaskPlanningArtifacts {
  return kind === "spec" ? "spec" : "techDesign";
}

function planningArtifactPrefix(kind: PlanningArtifactKind): string {
  return kind === "spec" ? "spec" : "tech-design";
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Fields that decide whether a source snapshot still matches the one planning
 * was approved against. `fetchedAt` and `contentHash` are deliberately absent:
 * re-fetching an unchanged source must not read as a change.
 */
export const SOURCE_SNAPSHOT_CONTENT_FIELDS: Array<keyof TaskSourceSnapshot> = [
  "uri",
  "externalId",
  "title",
  "body",
  "version",
  "state",
  "stateCategory",
  "updatedAt",
  "author",
  "reporter",
  "assignees",
  "labels",
  "milestone",
  "comments",
  "attachments",
  "linkedIssues",
];

/**
 * Content digest over the comparable fields of a source snapshot. Two fetches
 * of an unchanged source produce the same hash, so the digest can be compared
 * across time, stores, and providers.
 */
export function sourceSnapshotContentHash(snapshot: TaskSourceSnapshot): string {
  const canonical = SOURCE_SNAPSHOT_CONTENT_FIELDS.map((field) => [
    field,
    snapshot[field] ?? null,
  ]);
  return sha256Hex(JSON.stringify(canonical));
}

/** Attach the content digest a snapshot is identified by. */
export function withSourceSnapshotContentHash(
  snapshot: TaskSourceSnapshot,
): TaskSourceSnapshot {
  return { ...snapshot, contentHash: sourceSnapshotContentHash(snapshot) };
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

function normalizeTaskPriority(value: unknown): TaskPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3"
    ? value
    : "P2";
}

function normalizeTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    planningArtifacts: normalizePlanningArtifacts(task.planningArtifacts),
    priority: normalizeTaskPriority(task.priority),
    dependsOn: Array.isArray(task.dependsOn)
      ? [...new Set(task.dependsOn.filter((id) => typeof id === "string" && id))]
      : [],
    suggestedDependencies: Array.isArray(task.suggestedDependencies)
      ? task.suggestedDependencies.filter(
          (suggestion) =>
            suggestion &&
            typeof suggestion.dependsOn === "string" &&
            typeof suggestion.reason === "string" &&
            typeof suggestion.confidence === "number" &&
            typeof suggestion.source === "string" &&
            typeof suggestion.suggestedAt === "string",
        )
      : [],
  };
}

function normalizePlanningArtifacts(
  artifacts: TaskPlanningArtifacts | undefined,
): TaskPlanningArtifacts | undefined {
  if (!artifacts) {
    return undefined;
  }
  return {
    ...(artifacts.spec ? { spec: normalizeVersionSet(artifacts.spec) } : {}),
    ...(artifacts.techDesign
      ? { techDesign: normalizeVersionSet(artifacts.techDesign) }
      : {}),
  };
}

function normalizeVersionSet(
  versionSet: PlanningArtifactVersionSet,
): PlanningArtifactVersionSet {
  return {
    ...versionSet,
    revisions: Array.isArray(versionSet.revisions)
      ? versionSet.revisions.filter(
          (revision) =>
            revision &&
            typeof revision.versionId === "string" &&
            typeof revision.contentPath === "string" &&
            typeof revision.contentHash === "string" &&
            typeof revision.createdAt === "string",
        )
      : [],
  };
}

async function validateFlowPath(
  repoPath: string,
  candidatePath: string,
): Promise<string> {
  try {
    return (await resolveRepositoryFlowPath(repoPath, candidatePath)).flowPath;
  } catch (error) {
    if (error instanceof RepositoryFlowPathError) {
      throw new WebInputError(error.message);
    }
    throw error;
  }
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

async function createPlanningArtifactRevision(
  repoPath: string,
  taskId: string,
  kind: PlanningArtifactKind,
  content: string,
  input: {
    producer: string;
    createdAt: string;
    approvalState: PlanningArtifactApprovalState;
    previous?: PlanningArtifactVersionSet;
    sourceInputs?: string[];
    decisions?: PlanningArtifactDecisionRecord[];
  },
): Promise<PlanningArtifactRevision> {
  const revision = (input.previous?.revisions.length ?? 0) + 1;
  const versionId = `${planningArtifactPrefix(kind)}-r${revision}`;
  const contentPath = `.nitely/tasks/${taskId}/versions/${kind}/r${revision}.md`;
  await mkdir(taskVersionDirectory(repoPath, taskId, kind), { recursive: true });
  await writeFile(resolve(repoPath, contentPath), content, "utf8");
  return {
    kind,
    versionId,
    revision,
    contentPath,
    contentHash: sha256Hex(content),
    producer: input.producer,
    ...(input.sourceInputs?.length ? { sourceInputs: input.sourceInputs } : {}),
    createdAt: input.createdAt,
    ...(input.previous?.currentVersionId
      ? { parentVersionId: input.previous.currentVersionId }
      : {}),
    approvalState: input.approvalState,
    decisions: input.decisions ?? [],
  };
}

async function appendPlanningArtifactRevision(
  repoPath: string,
  task: TaskRecord,
  kind: PlanningArtifactKind,
  content: string,
  input: {
    producer: string;
    createdAt: string;
    approvalState: PlanningArtifactApprovalState;
    sourceInputs?: string[];
    decisions?: PlanningArtifactDecisionRecord[];
  },
): Promise<TaskPlanningArtifacts> {
  const key = planningArtifactKey(kind);
  const existing = task.planningArtifacts?.[key];
  const revision = await createPlanningArtifactRevision(
    repoPath,
    task.id,
    kind,
    content,
    {
      ...input,
      previous: existing,
    },
  );
  const versionSet: PlanningArtifactVersionSet = {
    currentVersionId: revision.versionId,
    ...(revision.approvalState === "approved"
      ? { approvedVersionId: revision.versionId }
      : existing?.approvedVersionId
        ? { approvedVersionId: existing.approvedVersionId }
        : {}),
    revisions: [...(existing?.revisions ?? []), revision],
  };
  return {
    ...(task.planningArtifacts ?? {}),
    [key]: versionSet,
  };
}

function latestApprovedPlanningRevision(
  task: TaskRecord,
  kind: PlanningArtifactKind,
): PlanningArtifactRevision | undefined {
  const versionSet = task.planningArtifacts?.[planningArtifactKey(kind)];
  const versionId = versionSet?.approvedVersionId ?? versionSet?.currentVersionId;
  return versionSet?.revisions.find((revision) => revision.versionId === versionId);
}

export function taskPlanningInputUri(
  task: TaskRecord,
  kind: PlanningArtifactKind,
): string | undefined {
  return latestApprovedPlanningRevision(task, kind)?.contentPath;
}

export function taskSourceInputUri(task: Pick<TaskRecord, "id">): string {
  return `.nitely/tasks/${task.id}/execution/source.json`;
}

export function taskWorkflowMetadataInputUri(task: TaskRecord): string {
  return `.nitely/tasks/${task.id}/execution/workflow-metadata.json`;
}

export interface TaskExecutionInputSnapshot {
  fingerprint: string;
  sourceUri?: string;
  workflowMetadataUri: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function taskWorkflowMetadataDocument(task: TaskRecord): Record<string, unknown> {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    repoId: task.repoId,
    flowPath: task.flowPath,
    template: task.template,
    issueUrl: task.issueUrl,
    sourceUri: task.source?.uri,
    sourceDrift: task.source?.drift,
    sourceDriftOverride: task.sourceDriftOverride,
    specReadinessOverride: task.specReadinessOverride,
    planningArtifacts: task.planningArtifacts,
    planningBaseline: task.activePlanningBaseline,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function materializeTaskRunCandidateInputs(
  repoPath: string,
  task: TaskRecord,
  candidateFingerprint: string,
): Promise<TaskExecutionInputSnapshot> {
  const workflowMetadata = taskWorkflowMetadataDocument(task);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizeJson({
          candidateFingerprint,
          source: task.source,
          workflowMetadata,
        }),
      ),
      "utf8",
    )
    .digest("hex");
  const root = `.nitely/tasks/${task.id}/execution/candidates/${fingerprint}`;
  const sourceUri = task.source ? `${root}/source.json` : undefined;
  const workflowMetadataUri = `${root}/workflow-metadata.json`;
  if (task.source && sourceUri) {
    await writeJsonAtomic(resolve(repoPath, sourceUri), task.source);
  }
  await writeJsonAtomic(resolve(repoPath, workflowMetadataUri), workflowMetadata);
  return {
    fingerprint,
    ...(sourceUri ? { sourceUri } : {}),
    workflowMetadataUri,
  };
}

export function taskPlanningApprovalStatus(
  task: TaskRecord,
): PlanningApprovalStatus | undefined {
  const spec = latestApprovedPlanningRevision(task, "spec");
  const techDesign = latestApprovedPlanningRevision(task, "tech-design");
  if (!spec && !techDesign) {
    return undefined;
  }
  return {
    artifacts: {
      ...(spec
        ? {
            spec: {
              path: spec.contentPath,
              state: "spec_approved" as const,
              versionId: spec.versionId,
              contentHash: spec.contentHash,
            },
          }
        : {}),
      ...(techDesign
        ? {
            techDesign: {
              path: techDesign.contentPath,
              state: "tech_design_approved" as const,
              versionId: techDesign.versionId,
              contentHash: techDesign.contentHash,
            },
          }
        : {}),
    },
    events: [
      ...(spec
        ? [
            {
              artifact: "spec" as const,
              artifactPath: spec.contentPath,
              decision: "approve" as const,
              at:
                spec.decisions.find((decision) => decision.decision === "approve")
                  ?.at ?? spec.createdAt,
              previousState: "draft_spec" as const,
              nextState: "spec_approved" as const,
            },
          ]
        : []),
      ...(techDesign
        ? [
            {
              artifact: "tech-design" as const,
              artifactPath: techDesign.contentPath,
              decision: "approve" as const,
              at:
                techDesign.decisions.find(
                  (decision) => decision.decision === "approve",
                )?.at ?? techDesign.createdAt,
              previousState: "draft_tech_design" as const,
              nextState: "tech_design_approved" as const,
            },
          ]
        : []),
    ],
  };
}

export function freezeTaskPlanningBaseline(
  task: TaskRecord,
  recordedAt = new Date().toISOString(),
): TaskPlanningBaseline | undefined {
  const spec = latestApprovedPlanningRevision(task, "spec");
  const techDesign = latestApprovedPlanningRevision(task, "tech-design");
  if (!spec && !techDesign) {
    return undefined;
  }
  return {
    ...(spec
      ? {
          specVersionId: spec.versionId,
          specContentHash: spec.contentHash,
          specContentPath: spec.contentPath,
        }
      : {}),
    ...(techDesign
      ? {
          techDesignVersionId: techDesign.versionId,
          techDesignContentHash: techDesign.contentHash,
          techDesignContentPath: techDesign.contentPath,
        }
      : {}),
    recordedAt,
  };
}

export async function materializeTaskExecutionInputs(
  repoPath: string,
  task: TaskRecord,
): Promise<void> {
  if (task.source) {
    await writeJsonAtomic(resolve(repoPath, taskSourceInputUri(task)), task.source);
  }
  await writeJsonAtomic(
    resolve(repoPath, taskWorkflowMetadataInputUri(task)),
    taskWorkflowMetadataDocument(task),
  );
}

function initialApprovalState(
  taskStatus: TaskStatus,
  artifactStatus: SpecApprovalStatus | undefined,
): PlanningArtifactApprovalState {
  if (artifactStatus === "draft") {
    return "draft";
  }
  if (artifactStatus === "approved" || taskStatus !== "draft") {
    return "approved";
  }
  return "draft";
}

function approvalDecisionForState(
  state: PlanningArtifactApprovalState,
  at: string,
): PlanningArtifactDecisionRecord[] {
  return state === "approved" ? [{ decision: "approve", at }] : [];
}

function planningRevisionSourceInputs(
  task: Pick<TaskRecord, "id" | "source">,
  ...artifactPaths: Array<string | undefined>
): string[] {
  return [
    ...(task.source ? [taskSourceInputUri(task)] : []),
    ...artifactPaths.filter((path): path is string => Boolean(path)),
  ];
}

export function validateTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new WebInputError("invalid task id");
  }
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

  const requestedFlowPath = normalizeOptionalText(input.flowPath) ?? defaultFlowPath;
  let flowPath: string;
  try {
    flowPath = await validateFlowPath(repoPath, requestedFlowPath);
  } catch (error) {
    if (!(error instanceof WebInputError) || !options.resyncRepository) throw error;
    await options.resyncRepository();
    flowPath = await validateFlowPath(repoPath, requestedFlowPath);
  }
  const id = options.createId?.() ?? `task-${randomUUID()}`;
  validateTaskId(id);

  const now = (options.now?.() ?? new Date()).toISOString();
  const directory = taskDirectory(repoPath, id);
  const specPath = `.nitely/tasks/${id}/spec.md`;
  const techDesignPath = `.nitely/tasks/${id}/tech-design.md`;
  const taskStatus = options.initialStatus ?? "ready";
  const task: TaskRecord = {
    id,
    title,
    status: taskStatus,
    ...(options.specStatus ? { specStatus: options.specStatus } : {}),
    ...(options.techDesignStatus
      ? { techDesignStatus: options.techDesignStatus }
      : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.planningNotes ? { planningNotes: options.planningNotes } : {}),
    ...(options.repoId ? { repoId: options.repoId } : {}),
    flowPath,
    ...(options.template ? { template: options.template } : {}),
    specPath,
    techDesignPath,
    priority: "P2",
    dependsOn: [],
    suggestedDependencies: [],
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
  const specState = initialApprovalState(taskStatus, options.specStatus);
  const specRevision = await createPlanningArtifactRevision(
    repoPath,
    id,
    "spec",
    spec,
    {
      producer: "web-task-create",
      createdAt: now,
      approvalState: specState,
      decisions: approvalDecisionForState(specState, now),
      sourceInputs: planningRevisionSourceInputs(task, specPath),
    },
  );
  const techDesignState = initialApprovalState(
    taskStatus,
    options.techDesignStatus,
  );
  const techDesignRevision = await createPlanningArtifactRevision(
    repoPath,
    id,
    "tech-design",
    techDesign,
    {
      producer: "web-task-create",
      createdAt: now,
      approvalState: techDesignState,
      decisions: approvalDecisionForState(techDesignState, now),
      sourceInputs: planningRevisionSourceInputs(
        task,
        specRevision.contentPath,
        techDesignPath,
      ),
    },
  );
  task.planningArtifacts = {
    spec: {
      currentVersionId: specRevision.versionId,
      ...(specState === "approved"
        ? { approvedVersionId: specRevision.versionId }
        : {}),
      revisions: [specRevision],
    },
    techDesign: {
      currentVersionId: techDesignRevision.versionId,
      ...(techDesignState === "approved"
        ? { approvedVersionId: techDesignRevision.versionId }
        : {}),
      revisions: [techDesignRevision],
    },
  };
  await writeJsonAtomic(join(directory, "task.json"), task);
  await materializeTaskExecutionInputs(repoPath, task);
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
  const now = new Date().toISOString();
  const planningArtifacts = await appendPlanningArtifactRevision(
    repoPath,
    task,
    "tech-design",
    techDesign,
    {
      producer: "web-tech-design-draft",
      createdAt: now,
      approvalState: status,
      decisions: approvalDecisionForState(status, now),
      sourceInputs: planningRevisionSourceInputs(
        task,
        taskPlanningInputUri(task, "spec") ?? task.specPath,
        task.techDesignPath,
      ),
    },
  );
  const updated: TaskRecord = {
    ...task,
    techDesignStatus: status,
    planningArtifacts,
    ...(planningNotes
      ? { planningNotes: { ...(task.planningNotes ?? {}), ...planningNotes } }
      : {}),
    updatedAt: now,
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  if (updated.source) {
    await materializeTaskExecutionInputs(repoPath, updated);
  }
  return updated;
}

export async function updateTaskSpec(
  repoPath: string,
  taskId: string,
  spec: string,
  status: SpecApprovalStatus,
  patch?: Partial<
    Pick<TaskRecord, "source" | "sourceDriftOverride" | "status" | "techDesignStatus">
  >,
  options: { producer?: string } = {},
): Promise<TaskRecord> {
  if (!spec.trim()) {
    throw new WebInputError("specification text is required");
  }
  const task = await getTask(repoPath, taskId);
  await writeFile(resolve(repoPath, task.specPath), spec, "utf8");
  const now = new Date().toISOString();
  const planningArtifacts = await appendPlanningArtifactRevision(
    repoPath,
    task,
    "spec",
    spec,
    {
      producer: options.producer ?? "web-spec-refresh",
      createdAt: now,
      approvalState: status,
      decisions: approvalDecisionForState(status, now),
      sourceInputs: planningRevisionSourceInputs(task, task.specPath),
    },
  );
  const updated: TaskRecord = {
    ...task,
    ...patch,
    specStatus: status,
    planningArtifacts,
    updatedAt: now,
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  if (updated.source) {
    await materializeTaskExecutionInputs(repoPath, updated);
  }
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
  await writeFile(
    resolve(repoPath, task.specPath),
    setStructuredSpecStatus(spec, status),
    "utf8",
  );
  const now = new Date().toISOString();
  const approvedSpec = await readFile(resolve(repoPath, task.specPath), "utf8");
  const planningArtifacts = await appendPlanningArtifactRevision(
    repoPath,
    task,
    "spec",
    approvedSpec,
    {
      producer: "web-spec-approval",
      createdAt: now,
      approvalState: status,
      decisions: approvalDecisionForState(status, now),
      sourceInputs: planningRevisionSourceInputs(task, task.specPath),
    },
  );
  const updated: TaskRecord = {
    ...task,
    specStatus: status,
    planningArtifacts,
    updatedAt: now,
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  if (updated.source) {
    await materializeTaskExecutionInputs(repoPath, updated);
  }
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
  const now = new Date().toISOString();
  const planningArtifacts = await appendPlanningArtifactRevision(
    repoPath,
    task,
    "tech-design",
    techDesign,
    {
      producer: "web-tech-design-approval",
      createdAt: now,
      approvalState: status,
      decisions: approvalDecisionForState(status, now),
      sourceInputs: planningRevisionSourceInputs(
        task,
        taskPlanningInputUri(task, "spec") ?? task.specPath,
        task.techDesignPath,
      ),
    },
  );
  const updated: TaskRecord = {
    ...task,
    techDesignStatus: status,
    status: status === "approved" ? "ready" : "draft",
    planningArtifacts,
    updatedAt: now,
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  await materializeTaskExecutionInputs(repoPath, updated);
  return updated;
}

export async function requestTaskPlanningChanges(
  repoPath: string,
  taskId: string,
  kind: PlanningArtifactKind,
  input: { actor?: string; reason: string },
): Promise<TaskRecord> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new WebInputError("planning change request reason is required");
  }
  const task = await getTask(repoPath, taskId);
  const contentPath = kind === "spec" ? task.specPath : task.techDesignPath;
  let content = await readFile(resolve(repoPath, contentPath), "utf8");
  if (!content.trim()) {
    throw new WebInputError(
      kind === "spec"
        ? "specification text is required"
        : "technical design text is required",
    );
  }
  if (kind === "spec") {
    content = setStructuredSpecStatus(content, "draft");
    await writeFile(resolve(repoPath, contentPath), content, "utf8");
  }
  const now = new Date().toISOString();
  const planningArtifacts = await appendPlanningArtifactRevision(
    repoPath,
    task,
    kind,
    content,
    {
      producer:
        kind === "spec" ? "web-spec-review" : "web-tech-design-review",
      createdAt: now,
      approvalState: "changes_requested",
      decisions: [
        {
          decision: "request_changes",
          at: now,
          ...(input.actor ? { actor: input.actor } : {}),
          reason,
        },
      ],
      sourceInputs: planningRevisionSourceInputs(
        task,
        kind === "tech-design"
          ? taskPlanningInputUri(task, "spec") ?? task.specPath
          : undefined,
        contentPath,
      ),
    },
  );
  const versionSet = planningArtifacts[planningArtifactKey(kind)];
  if (versionSet) delete versionSet.approvedVersionId;
  if (kind === "spec" && planningArtifacts.techDesign) {
    delete planningArtifacts.techDesign.approvedVersionId;
  }
  const updated: TaskRecord = {
    ...task,
    status: "draft",
    ...(kind === "spec"
      ? { specStatus: "draft" as const, techDesignStatus: "draft" as const }
      : { techDesignStatus: "draft" as const }),
    planningArtifacts,
    updatedAt: now,
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  if (updated.source) {
    await materializeTaskExecutionInputs(repoPath, updated);
  }
  return updated;
}

export async function getTask(repoPath: string, taskId: string): Promise<TaskRecord> {
  return (await getTaskSnapshot(repoPath, taskId)).record;
}

export interface StoredTaskSnapshot {
  record: TaskRecord;
  version: WorkItemCandidateVersion;
}

export async function getTaskSnapshot(
  repoPath: string,
  taskId: string,
): Promise<StoredTaskSnapshot> {
  const path = join(taskDirectory(repoPath, taskId), "task.json");
  try {
    const document = await readFile(path, "utf8");
    const record = normalizeTaskRecord(JSON.parse(document) as TaskRecord);
    return {
      record,
      version: {
        store: "legacy-dev-pr",
        fingerprint: workItemCandidateFingerprint(
          record as unknown as Record<string, unknown>,
        ),
      },
    };
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
    Partial<
      Pick<
        TaskRecord,
        | "latestRunId"
        | "changeRequestUrl"
        | "sourceDriftOverride"
        | "specReadinessOverride"
        | "activePlanningBaseline"
      >
    >,
): Promise<TaskRecord> {
  const updated = await prepareTaskRunState(repoPath, taskId, patch);
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

async function prepareTaskRunState(
  repoPath: string,
  taskId: string,
  patch: Pick<TaskRecord, "status"> &
    Partial<
      Pick<
        TaskRecord,
        | "latestRunId"
        | "changeRequestUrl"
        | "sourceDriftOverride"
        | "specReadinessOverride"
        | "activePlanningBaseline"
      >
    >,
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  const updatedAt = new Date().toISOString();
  const updated: TaskRecord = {
    ...task,
    ...patch,
    ...(patch.status === "running"
      ? {
          activePlanningBaseline:
            "activePlanningBaseline" in patch
              ? patch.activePlanningBaseline
              : freezeTaskPlanningBaseline(task, updatedAt),
        }
      : {}),
    updatedAt,
  };
  if (patch.changeRequestUrl === undefined) {
    delete updated.changeRequestUrl;
  }
  return updated;
}

export async function admitTaskRunState(
  repoPath: string,
  taskId: string,
  patch: Parameters<typeof updateTaskRunState>[2],
): Promise<TaskRecord> {
  const updated = await prepareTaskRunState(repoPath, taskId, patch);
  await materializeTaskExecutionInputs(repoPath, updated);
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function updateTaskSourceRecord(
  repoPath: string,
  taskId: string,
  source: TaskSourceRecord,
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  const updated: TaskRecord = {
    ...task,
    source,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  await materializeTaskExecutionInputs(repoPath, updated);
  return updated;
}

export async function updateTaskDependencies(
  repoPath: string,
  taskId: string,
  dependsOn: string[],
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  for (const upstreamId of dependsOn) {
    validateTaskId(upstreamId);
  }
  const uniqueDependencies = [...new Set(dependsOn)].filter((id) => id !== taskId);
  const updated: TaskRecord = {
    ...task,
    dependsOn: uniqueDependencies,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function confirmTaskDependency(
  repoPath: string,
  taskId: string,
  upstreamId: string,
): Promise<TaskRecord> {
  validateTaskId(upstreamId);
  const task = await getTask(repoPath, taskId);
  const updated: TaskRecord = {
    ...task,
    dependsOn: [...new Set([...(task.dependsOn ?? []), upstreamId])].filter(
      (id) => id !== taskId,
    ),
    suggestedDependencies: (task.suggestedDependencies ?? []).filter(
      (suggestion) => suggestion.dependsOn !== upstreamId,
    ),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function dismissTaskDependencySuggestion(
  repoPath: string,
  taskId: string,
  upstreamId: string,
): Promise<TaskRecord> {
  validateTaskId(upstreamId);
  const task = await getTask(repoPath, taskId);
  const updated: TaskRecord = {
    ...task,
    suggestedDependencies: (task.suggestedDependencies ?? []).filter(
      (suggestion) => suggestion.dependsOn !== upstreamId,
    ),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}

export async function updateTaskDependencySuggestions(
  repoPath: string,
  taskId: string,
  suggestedDependencies: SuggestedDependency[],
): Promise<TaskRecord> {
  const task = await getTask(repoPath, taskId);
  for (const suggestion of suggestedDependencies) {
    validateTaskId(suggestion.dependsOn);
  }
  const byDependency = new Map<string, SuggestedDependency>();
  for (const suggestion of suggestedDependencies) {
    if (suggestion.dependsOn !== taskId) {
      byDependency.set(suggestion.dependsOn, suggestion);
    }
  }
  const updated: TaskRecord = {
    ...task,
    suggestedDependencies: [...byDependency.values()],
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(taskDirectory(repoPath, taskId), "task.json"), updated);
  return updated;
}
