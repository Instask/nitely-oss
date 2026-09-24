import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  link,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { generateDraftSpec } from "../spec-artifacts/draft.js";
import {
  createTask,
  getTask,
  listTasks,
  materializeTaskExecutionInputs,
  type TaskRecord,
  type TaskSourceIntakeProvenance,
  type TaskSourceRecord,
  type TaskSourceSnapshot,
} from "../web/tasks.js";
import {
  createTaskReworkRequest,
  defaultTaskReworkFlowPath,
  type TaskReworkRequest,
} from "../web/task-rework-requests.js";
import { WebNotFoundError } from "../web/errors.js";
// intake.ts already depends on src/web/ (tasks.js, errors.js); see
// src/web/repositories.ts for the definition.
import { LEGACY_DEFAULT_REPOSITORY_ID } from "../web/repositories.js";
import { normalizeReviewFeedback } from "../review-feedback/model.js";
import { upsertFactoryCandidateForWorkItem } from "../factory-queue.js";
import { projectWorkItem } from "../work-items/access.js";
import type {
  ChangeRequest,
  ChangeRequestTarget,
  PullRequestDiscussionItem,
} from "../scm/types.js";

const defaultMaxDeliveryAgeMs = 5 * 60_000;
const defaultMaxFutureSkewMs = 60_000;
const defaultProcessingLeaseMs = 2 * 60_000;
export const maximumGitHubWebhookBodyBytes = 1024 * 1024;
const maximumGitHubOwnerLength = 39;
const maximumGitHubRepositoryNameLength = 100;
const maximumGitHubLoginLength = 100;
const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const repositoryFullNamePattern =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const repositoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const githubLoginPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

export interface GitHubWebhookRepositoryMapping {
  fullName: string;
  repositoryId: string;
}

export type GitHubWebhookExecutionEvent = "issues" | "issue_comment";
export type GitHubWebhookExecutionAction = "labeled" | "assigned" | "created";

export type GitHubWebhookStatusUpdate =
  | {
      state: "task-created";
      deliveryId: string;
      installationId: number;
      repositoryId: number;
      repositoryFullName: string;
      issueNumber: number;
      sourceUrl: string;
      taskId: string;
      taskPath: string;
    }
  | {
      state: "rework-request-created";
      deliveryId: string;
      installationId: number;
      repositoryId: number;
      repositoryFullName: string;
      pullRequestNumber: number;
      headSha: string;
      sourceUrl: string;
      taskId: string;
      reworkRequestId: string;
      reworkRequestPath: string;
    }
  | {
      state: "failed";
      deliveryId: string;
      installationId: number;
      repositoryId: number;
      repositoryFullName: string;
      issueNumber?: number;
      pullRequestNumber?: number;
      headSha?: string;
      sourceUrl: string;
      failureCode: "processing_failed";
    };

export interface GitHubWebhookStatusPublication {
  provider: "github";
  checkRunId?: number;
  commentId?: number;
}

export type GitHubWebhookStatusPublisher = (
  update: GitHubWebhookStatusUpdate,
  previous?: GitHubWebhookStatusPublication,
) => Promise<GitHubWebhookStatusPublication | void>;

export interface GitHubWebhookConfiguration {
  secret: string;
  repositories: GitHubWebhookRepositoryMapping[];
  allowedActors: string[];
  allowedInstallationIds?: number[];
  triggerLabels?: string[];
  triggerAssignees?: string[];
  triggerMentions?: string[];
  flowPath: string;
  reworkFlowPath?: string;
  maxDeliveryAgeMs?: number;
  maxFutureSkewMs?: number;
  statusPublisher?: GitHubWebhookStatusPublisher;
  now?: () => Date;
}

export interface GitHubWebhookRepositoryTarget {
  id: string;
  path: string;
  home?: true;
}

export interface GitHubWebhookExecutionRequest {
  schemaVersion: 1;
  apiVersion: "nitely.dev/github-webhook/v1";
  kind: "ExecutionRequest";
  idempotencyKey: string;
  provider: "github";
  event: GitHubWebhookExecutionEvent;
  action: GitHubWebhookExecutionAction;
  deliveryId: string;
  receivedAt: string;
  eventAt: string;
  installationId: number;
  repository: {
    id: number;
    fullName: string;
    url: string;
    nitelyRepositoryId: string;
  };
  actor: {
    id?: number;
    login: string;
  };
  source: {
    number: number;
    url: string;
    snapshot: TaskSourceSnapshot;
    snapshotSha256: string;
  };
  requestedFlow: string;
}

export interface GitHubWebhookReworkRequest {
  schemaVersion: 1;
  apiVersion: "nitely.dev/github-webhook/v1";
  kind: "ReworkRequest";
  idempotencyKey: string;
  provider: "github";
  event: "pull_request_review_comment";
  action: "created";
  deliveryId: string;
  receivedAt: string;
  eventAt: string;
  installationId: number;
  repository: {
    id: number;
    fullName: string;
    url: string;
    nitelyRepositoryId: string;
  };
  actor: {
    id?: number;
    login: string;
  };
  pullRequest: {
    number: number;
    url: string;
    baseBranch: string;
    headBranch: string;
    headSha: string;
    headRepository: {
      owner: string;
      repository: string;
    };
    isCrossRepository: boolean;
    draft: boolean;
  };
  comment: {
    id: string;
    url: string;
    body: string;
    authorLogin: string;
    authorAssociation?: string;
    createdAt: string;
    updatedAt?: string;
    path?: string;
    line?: number;
    inReplyToId?: string;
  };
  feedback: {
    action: "rework" | "address";
    instruction: string;
  };
  requestedFlow: string;
}

export type GitHubWebhookRequest =
  | GitHubWebhookExecutionRequest
  | GitHubWebhookReworkRequest;

export type GitHubWebhookDeliveryState =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "ignored"
  | "denied";

export interface GitHubWebhookDeliveryLease {
  schemaVersion: 1;
  deliveryId: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface GitHubWebhookDeliveryRecord {
  schemaVersion: 1;
  deliveryId: string;
  event: string;
  bodySha256: string;
  receivedAt: string;
  updatedAt: string;
  state: GitHubWebhookDeliveryState;
  reason?: string;
  request?: GitHubWebhookRequest;
  taskId?: string;
  reworkRequestId?: string;
  callback?: {
    state: "pending" | "succeeded" | "failed";
    attemptedAt: string;
    attempts: number;
    failureCode?: "status_publish_failed";
    external?: GitHubWebhookStatusPublication;
  };
  failure?: {
    code: "processing_failed";
    message: "GitHub webhook processing failed";
  };
  summary?: {
    action?: string;
    repositoryFullName?: string;
    actorLogin?: string;
    installationId?: number;
    issueNumber?: number;
    pullRequestNumber?: number;
  };
  lease?: GitHubWebhookDeliveryLease;
}

export interface GitHubWebhookAcceptInput {
  deliveryId: string;
  event: string;
  signature: string;
  body: Buffer;
}

export interface GitHubWebhookAcceptance {
  status: 202;
  accepted: boolean;
  duplicate: boolean;
  deliveryId: string;
  state: GitHubWebhookDeliveryState;
  reason?: string;
}

export class GitHubWebhookRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubWebhookRequestError";
  }
}

interface GitHubWebhookIntakeInput {
  stateRepoPath: string;
  configuration: GitHubWebhookConfiguration;
  resolveRepository: (
    repositoryId: string,
  ) => Promise<GitHubWebhookRepositoryTarget | undefined>;
  leaseDurationMs?: number;
  createLeaseOwnerId?: () => string;
}

interface NormalizedConfiguration {
  secret: string;
  repositories: GitHubWebhookRepositoryMapping[];
  allowedActors: Set<string>;
  allowedInstallationIds?: Set<number>;
  triggerLabels: Set<string>;
  triggerAssignees: Set<string>;
  triggerMentions: Set<string>;
  flowPath: string;
  reworkFlowPath: string;
  maxDeliveryAgeMs: number;
  maxFutureSkewMs: number;
  statusPublisher?: GitHubWebhookStatusPublisher;
  now: () => Date;
}

interface GitHubIssueActivationPayload {
  event: "issues" | "issue_comment";
  action: "labeled" | "assigned" | "created";
  installationId: number;
  repository: {
    id: number;
    fullName: string;
    url: string;
  };
  actor: {
    id?: number;
    login: string;
  };
  label?: string;
  assignee?: string;
  comment?: {
    id: string;
    url: string;
    body: string;
    authorLogin: string;
    createdAt: string;
    updatedAt?: string;
  };
  issue: {
    number: number;
    url: string;
    title: string;
    body: string;
    state: string;
    updatedAt: string;
    author?: string;
    assignees: string[];
    labels: string[];
  };
}

interface GitHubPullRequestReviewCommentPayload {
  event: "pull_request_review_comment";
  action: "created";
  installationId: number;
  repository: {
    id: number;
    fullName: string;
    url: string;
  };
  actor: {
    id?: number;
    login: string;
  };
  pullRequest: {
    number: number;
    url: string;
    updatedAt: string;
    baseBranch: string;
    headBranch: string;
    headSha: string;
    headRepository: {
      owner: string;
      repository: string;
    };
    isCrossRepository: boolean;
    draft: boolean;
  };
  comment: {
    id: string;
    url: string;
    body: string;
    authorLogin: string;
    authorAssociation?: string;
    createdAt: string;
    updatedAt?: string;
    path?: string;
    line?: number;
    inReplyToId?: string;
  };
}

function normalizeCase(value: string): string {
  return value.trim().toLowerCase();
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function isValidRepositoryFullName(value: string): boolean {
  const match = repositoryFullNamePattern.exec(value);
  return Boolean(
    match &&
      match[1]!.length <= maximumGitHubOwnerLength &&
      match[2]!.length <= maximumGitHubRepositoryNameLength,
  );
}

function isValidGitHubLogin(value: string): boolean {
  return (
    value.length <= maximumGitHubLoginLength && githubLoginPattern.test(value)
  );
}

function normalizeGitHubMention(value: string): string {
  return normalizeCase(value).replace(/^@+/, "");
}

function normalizedGitHubLoginSet(
  values: string[] | undefined,
  field: string,
): Set<string> {
  const names = (Array.isArray(values) ? values : [])
    .map(normalizeGitHubMention)
    .filter(Boolean);
  if (names.some((name) => !isValidGitHubLogin(name))) {
    throw new Error(`${field} is invalid`);
  }
  return new Set(names);
}

function normalizeConfiguration(
  input: GitHubWebhookConfiguration,
): NormalizedConfiguration {
  const secret = requireNonEmpty(input.secret, "GitHub webhook secret");
  if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
    throw new Error("GitHub webhook repositories are required");
  }
  const repositories = input.repositories.map((mapping) => {
    const fullName = requireNonEmpty(
      mapping.fullName,
      "GitHub webhook repository full name",
    );
    const repositoryId = requireNonEmpty(
      mapping.repositoryId,
      "Nitely repository id",
    );
    if (!isValidRepositoryFullName(fullName)) {
      throw new Error("GitHub webhook repository must be owner/repository");
    }
    if (!repositoryIdPattern.test(repositoryId)) {
      throw new Error("GitHub webhook repository id is invalid");
    }
    return { fullName, repositoryId };
  });
  const repositoryNames = new Set(
    repositories.map((mapping) => normalizeCase(mapping.fullName)),
  );
  if (repositoryNames.size !== repositories.length) {
    throw new Error("GitHub webhook repository mappings must be unique");
  }
  const actorNames = (Array.isArray(input.allowedActors)
    ? input.allowedActors
    : []
  )
    .map(normalizeCase)
    .filter(Boolean);
  if (actorNames.some((actor) => !isValidGitHubLogin(actor))) {
    throw new Error("GitHub webhook allowed actor is invalid");
  }
  const allowedActors = new Set(actorNames);
  if (allowedActors.size === 0) {
    throw new Error("GitHub webhook allowed actors are required");
  }
  const triggerLabels = new Set(
    (input.triggerLabels ?? ["nitely"]).map(normalizeCase).filter(Boolean),
  );
  if (triggerLabels.size === 0) {
    throw new Error("GitHub webhook trigger labels are required");
  }
  const triggerAssignees = normalizedGitHubLoginSet(
    input.triggerAssignees,
    "GitHub webhook trigger assignee",
  );
  const triggerMentions = normalizedGitHubLoginSet(
    input.triggerMentions,
    "GitHub webhook trigger mention",
  );
  const installationIds = input.allowedInstallationIds?.map((id) =>
    requirePositiveInteger(id, "GitHub webhook installation id"),
  );
  const maxDeliveryAgeMs = input.maxDeliveryAgeMs ?? defaultMaxDeliveryAgeMs;
  const maxFutureSkewMs = input.maxFutureSkewMs ?? defaultMaxFutureSkewMs;
  requirePositiveInteger(maxDeliveryAgeMs, "GitHub webhook maximum delivery age");
  requirePositiveInteger(maxFutureSkewMs, "GitHub webhook maximum future skew");
  return {
    secret,
    repositories,
    allowedActors,
    ...(installationIds
      ? { allowedInstallationIds: new Set(installationIds) }
      : {}),
    triggerLabels,
    triggerAssignees,
    triggerMentions,
    flowPath: requireNonEmpty(input.flowPath, "GitHub webhook Flow path"),
    reworkFlowPath: input.reworkFlowPath?.trim() || defaultTaskReworkFlowPath,
    maxDeliveryAgeMs,
    maxFutureSkewMs,
    ...(input.statusPublisher ? { statusPublisher: input.statusPublisher } : {}),
    now: input.now ?? (() => new Date()),
  };
}

function validateDeliveryId(deliveryId: string): string {
  const normalized = deliveryId.trim();
  if (!deliveryIdPattern.test(normalized)) {
    throw new GitHubWebhookRequestError(
      "GitHub delivery id is invalid",
      "invalid_delivery_id",
      400,
    );
  }
  return normalized;
}

function deliveryFileName(deliveryId: string): string {
  return `${validateDeliveryId(deliveryId)}.json`;
}

function deliveryLockFileName(deliveryId: string): string {
  return `${deliveryFileName(deliveryId)}.lock`;
}

type DirectoryHandle = Awaited<ReturnType<typeof open>>;

interface OpenedDeliveryDirectory {
  handle: DirectoryHandle;
  path: string;
}

function directoryAnchor(directory: OpenedDeliveryDirectory): string {
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.handle.fd}`
    : directory.path;
}

function deliveryStorageError(path: string, cause?: unknown): Error {
  return new Error(
    `unsafe GitHub webhook delivery storage at ${path}: symbolic link or non-directory entry`,
    cause === undefined ? undefined : { cause },
  );
}

async function openDeliveryDirectory(
  repoPath: string,
  create: boolean,
): Promise<OpenedDeliveryDirectory | undefined> {
  const repositoryPath = await realpath(resolve(repoPath));
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open(repositoryPath, directoryFlags);
  let currentPath = repositoryPath;
  try {
    for (const segment of [".nitely", "github-webhooks", "deliveries"]) {
      const parent: OpenedDeliveryDirectory = { handle, path: currentPath };
      const childPath = join(directoryAnchor(parent), segment);
      if (create) {
        try {
          await mkdir(childPath, { mode: 0o700 });
          await handle.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      let child: DirectoryHandle;
      try {
        child = await open(childPath, directoryFlags);
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
          await handle.close();
          return undefined;
        }
        throw deliveryStorageError(join(currentPath, segment), error);
      }
      const entry = await child.stat();
      if (!entry.isDirectory()) {
        await child.close();
        throw deliveryStorageError(join(currentPath, segment));
      }
      if (create) await handle.sync();
      await handle.close();
      handle = child;
      currentPath = join(currentPath, segment);
    }
    return { handle, path: currentPath };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function missingDeliveryError(deliveryId: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`GitHub webhook delivery was not found: ${deliveryId}`),
    { code: "ENOENT" },
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotFingerprint(snapshot: TaskSourceSnapshot): string {
  return sha256(JSON.stringify(canonicalize(snapshot)));
}

function parseDeliveryRecord(value: unknown): GitHubWebhookDeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid GitHub webhook delivery record");
  }
  const record = value as GitHubWebhookDeliveryRecord;
  if (
    record.schemaVersion !== 1 ||
    typeof record.deliveryId !== "string" ||
    typeof record.bodySha256 !== "string" ||
    typeof record.state !== "string"
  ) {
    throw new Error("invalid GitHub webhook delivery record");
  }
  return record;
}

async function readDeliveryRecord(
  directory: OpenedDeliveryDirectory,
  deliveryId: string,
): Promise<GitHubWebhookDeliveryRecord> {
  const path = join(directoryAnchor(directory), deliveryFileName(deliveryId));
  let handle: DirectoryHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw deliveryStorageError(path, error);
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw deliveryStorageError(path);
    if (entry.size > maximumGitHubWebhookBodyBytes * 2 + 64 * 1024) {
      throw new Error("GitHub webhook delivery record is too large");
    }
    const record = parseDeliveryRecord(
      JSON.parse(await handle.readFile("utf8")),
    );
    if (record.deliveryId !== validateDeliveryId(deliveryId)) {
      throw new Error("GitHub webhook delivery record identity does not match its path");
    }
    return record;
  } finally {
    await handle.close();
  }
}

async function writeDeliveryRecordAtomic(
  repoPath: string,
  record: GitHubWebhookDeliveryRecord,
): Promise<void> {
  const directory = await openDeliveryDirectory(repoPath, true);
  if (!directory) throw new Error("GitHub webhook delivery directory is missing");
  const anchor = directoryAnchor(directory);
  const path = join(anchor, deliveryFileName(record.deliveryId));
  const temporaryPath = join(
    anchor,
    `${deliveryFileName(record.deliveryId)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: DirectoryHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await directory.handle.sync();
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true }).catch(() => {});
    await directory.handle.sync().catch(() => {});
    await directory.handle.close();
  }
}

export async function getGitHubWebhookDelivery(
  repoPath: string,
  deliveryId: string,
): Promise<GitHubWebhookDeliveryRecord> {
  const directory = await openDeliveryDirectory(repoPath, false);
  if (!directory) throw missingDeliveryError(deliveryId);
  try {
    return await readDeliveryRecord(directory, deliveryId);
  } finally {
    await directory.handle.close();
  }
}

async function findGitHubWebhookDelivery(
  repoPath: string,
  deliveryId: string,
): Promise<GitHubWebhookDeliveryRecord | undefined> {
  try {
    return await getGitHubWebhookDelivery(repoPath, deliveryId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function listGitHubWebhookDeliveries(
  repoPath: string,
): Promise<GitHubWebhookDeliveryRecord[]> {
  const directory = await openDeliveryDirectory(repoPath, false);
  if (!directory) return [];
  try {
    const entries = await readdir(directoryAnchor(directory));
    return await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.endsWith(".json") &&
            deliveryIdPattern.test(entry.slice(0, -".json".length)),
        )
        .sort()
        .map(async (entry) =>
          await readDeliveryRecord(
            directory,
            entry.slice(0, -".json".length),
          ),
        ),
    );
  } finally {
    await directory.handle.close();
  }
}

async function createDeliveryRecord(
  repoPath: string,
  record: GitHubWebhookDeliveryRecord,
): Promise<{ record: GitHubWebhookDeliveryRecord; duplicate: boolean }> {
  const directory = await openDeliveryDirectory(repoPath, true);
  if (!directory) throw new Error("GitHub webhook delivery directory is missing");
  const anchor = directoryAnchor(directory);
  const path = join(anchor, deliveryFileName(record.deliveryId));
  const temporaryPath = join(
    anchor,
    `${deliveryFileName(record.deliveryId)}.${process.pid}.${randomBytes(6).toString("hex")}.incoming`,
  );
  let handle: DirectoryHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
      await directory.handle.sync();
      return { record, duplicate: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent winner may not have synced the link yet. Syncing the
      // shared directory here makes the winning entry durable before this
      // duplicate request acknowledges it.
      await directory.handle.sync();
      const existing = await readDeliveryRecord(directory, record.deliveryId);
      if (
        existing.bodySha256 !== record.bodySha256 ||
        existing.event !== record.event
      ) {
        throw new GitHubWebhookRequestError(
          "GitHub delivery id was already used with a different event or payload",
          "delivery_id_collision",
          409,
        );
      }
      return { record: existing, duplicate: true };
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true }).catch(() => {});
    await directory.handle.sync().catch(() => {});
    await directory.handle.close();
  }
}

async function updateDeliveryRecord(
  repoPath: string,
  record: GitHubWebhookDeliveryRecord,
): Promise<void> {
  await writeDeliveryRecordAtomic(repoPath, record);
}

function parseDeliveryLease(value: unknown): GitHubWebhookDeliveryLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid GitHub webhook delivery lease");
  }
  const lease = value as GitHubWebhookDeliveryLease;
  if (
    lease.schemaVersion !== 1 ||
    typeof lease.deliveryId !== "string" ||
    typeof lease.ownerId !== "string" ||
    typeof lease.token !== "string" ||
    typeof lease.acquiredAt !== "string" ||
    typeof lease.expiresAt !== "string"
  ) {
    throw new Error("invalid GitHub webhook delivery lease");
  }
  return lease;
}

function deliveryLeaseExpired(
  lease: GitHubWebhookDeliveryLease | undefined,
  now: Date,
): boolean {
  if (!lease) return true;
  const expiresAt = Date.parse(lease.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

async function readDeliveryLease(
  directory: OpenedDeliveryDirectory,
  deliveryId: string,
): Promise<GitHubWebhookDeliveryLease | undefined> {
  const path = join(directoryAnchor(directory), deliveryLockFileName(deliveryId));
  let handle: DirectoryHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const entry = await handle.stat();
    if (!entry.isFile()) throw deliveryStorageError(path);
    return parseDeliveryLease(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function acquireDeliveryLease(
  repoPath: string,
  input: {
    deliveryId: string;
    ownerId: string;
    now: Date;
    durationMs: number;
  },
): Promise<GitHubWebhookDeliveryLease | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const directory = await openDeliveryDirectory(repoPath, true);
    if (!directory) throw new Error("GitHub webhook delivery directory is missing");
    const anchor = directoryAnchor(directory);
    const lockPath = join(anchor, deliveryLockFileName(input.deliveryId));
    const acquiredAt = input.now.toISOString();
    const lease: GitHubWebhookDeliveryLease = {
      schemaVersion: 1,
      deliveryId: validateDeliveryId(input.deliveryId),
      ownerId: input.ownerId,
      token: randomBytes(16).toString("hex"),
      acquiredAt,
      expiresAt: new Date(input.now.getTime() + input.durationMs).toISOString(),
    };
    let handle: DirectoryHandle | undefined;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(lease, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await directory.handle.sync();
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readDeliveryLease(directory, input.deliveryId);
      if (!deliveryLeaseExpired(existing, input.now)) return undefined;
      await rm(lockPath, { force: true }).catch(() => {});
      await directory.handle.sync();
    } finally {
      await handle?.close();
      await directory.handle.sync().catch(() => {});
      await directory.handle.close();
    }
  }
  return undefined;
}

async function releaseDeliveryLease(
  repoPath: string,
  lease: GitHubWebhookDeliveryLease,
): Promise<void> {
  const directory = await openDeliveryDirectory(repoPath, false);
  if (!directory) return;
  try {
    const existing = await readDeliveryLease(directory, lease.deliveryId);
    if (existing?.token !== lease.token || existing.ownerId !== lease.ownerId) {
      return;
    }
    await rm(join(directoryAnchor(directory), deliveryLockFileName(lease.deliveryId)), {
      force: true,
    });
    await directory.handle.sync();
  } finally {
    await directory.handle.close();
  }
}

function taskStorageError(path: string, cause?: unknown): Error {
  return new Error(
    `unsafe GitHub webhook task storage at ${path}: symbolic link, hard link, or non-regular entry`,
    cause === undefined ? undefined : { cause },
  );
}

async function openTaskParentDirectory(
  repoPath: string,
): Promise<OpenedDeliveryDirectory> {
  const repositoryPath = await realpath(resolve(repoPath));
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open(repositoryPath, directoryFlags);
  let currentPath = repositoryPath;
  try {
    for (const segment of [".nitely", "tasks"]) {
      const parent: OpenedDeliveryDirectory = { handle, path: currentPath };
      const childPath = join(directoryAnchor(parent), segment);
      try {
        await mkdir(childPath, { mode: 0o700 });
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let child: DirectoryHandle;
      try {
        child = await open(childPath, directoryFlags);
      } catch (error) {
        throw taskStorageError(join(currentPath, segment), error);
      }
      const entry = await child.stat();
      if (!entry.isDirectory()) {
        await child.close();
        throw taskStorageError(join(currentPath, segment));
      }
      await handle.sync();
      await handle.close();
      handle = child;
      currentPath = join(currentPath, segment);
    }
    return { handle, path: currentPath };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function syncTaskDirectoryTree(
  directory: OpenedDeliveryDirectory,
): Promise<void> {
  const anchor = directoryAnchor(directory);
  const entries = await readdir(anchor, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(anchor, entry.name);
    const displayPath = join(directory.path, entry.name);
    if (entry.isSymbolicLink()) throw taskStorageError(displayPath);
    if (entry.isDirectory()) {
      let child: DirectoryHandle;
      try {
        child = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        throw taskStorageError(displayPath, error);
      }
      try {
        const childEntry = await child.stat();
        if (!childEntry.isDirectory()) throw taskStorageError(displayPath);
        await syncTaskDirectoryTree({ handle: child, path: displayPath });
      } finally {
        await child.close();
      }
      continue;
    }
    if (!entry.isFile()) throw taskStorageError(displayPath);
    let file: DirectoryHandle;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw taskStorageError(displayPath, error);
    }
    try {
      const fileEntry = await file.stat();
      if (!fileEntry.isFile() || fileEntry.nlink !== 1) {
        throw taskStorageError(displayPath);
      }
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await directory.handle.sync();
}

async function syncTaskMaterialization(
  repoPath: string,
  taskId: string,
  allowMissing: boolean,
): Promise<boolean> {
  if (!/^github-delivery-[a-f0-9]{24}$/.test(taskId)) {
    throw new Error("invalid deterministic GitHub webhook task id");
  }
  const parent = await openTaskParentDirectory(repoPath);
  try {
    const path = join(directoryAnchor(parent), taskId);
    let taskDirectory: DirectoryHandle;
    try {
      taskDirectory = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await parent.handle.sync();
        return false;
      }
      throw taskStorageError(join(parent.path, taskId), error);
    }
    try {
      const entry = await taskDirectory.stat();
      if (!entry.isDirectory()) throw taskStorageError(join(parent.path, taskId));
      await syncTaskDirectoryTree({
        handle: taskDirectory,
        path: join(parent.path, taskId),
      });
      await parent.handle.sync();
      return true;
    } finally {
      await taskDirectory.close();
    }
  } finally {
    await parent.handle.close();
  }
}

function verifySignature(
  secret: string,
  signature: string,
  body: Buffer,
): void {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature.trim());
  if (!match) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook signature is missing or malformed",
      "invalid_signature",
      401,
    );
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(match[1]!, "hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook signature is invalid",
      "invalid_signature",
      401,
    );
  }
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubWebhookRequestError(
      `GitHub webhook ${field} is invalid`,
      "invalid_payload",
      400,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubWebhookRequestError(
      `GitHub webhook ${field} is invalid`,
      "invalid_payload",
      400,
    );
  }
  return value.trim();
}

function requiredGitHubLogin(
  record: Record<string, unknown>,
  field: string,
): string {
  const login = requiredString(record, field);
  if (!isValidGitHubLogin(login)) {
    throw new GitHubWebhookRequestError(
      `GitHub webhook ${field} is invalid`,
      "invalid_payload",
      400,
    );
  }
  return login;
}

function requiredPositiveInteger(
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubWebhookRequestError(
      `GitHub webhook ${field} is invalid`,
      "invalid_payload",
      400,
    );
  }
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  return requiredPositiveInteger(record, field);
}

function loginArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    requiredGitHubLogin(parseObject(entry, "login"), "login"),
  );
}

function labelArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    return requiredString(parseObject(entry, "label"), "name");
  }).filter(Boolean);
}

function boundedCommentId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128 || /[^\w:.-]/.test(id)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook comment id is invalid",
      "invalid_payload",
      400,
    );
  }
  return id;
}

function parseRepository(value: unknown): {
  id: number;
  fullName: string;
  url: string;
} {
  const repository = parseObject(value, "repository");
  const fullName = requiredString(repository, "full_name");
  if (!isValidRepositoryFullName(fullName)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook repository full name is invalid",
      "invalid_payload",
      400,
    );
  }
  const expectedRepositoryUrl = `https://github.com/${fullName}`;
  const repositoryUrl = requiredString(repository, "html_url").replace(/\/+$/, "");
  if (repositoryUrl !== expectedRepositoryUrl) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook repository URL does not match the repository",
      "invalid_payload",
      400,
    );
  }
  return {
    id: requiredPositiveInteger(repository, "id"),
    fullName,
    url: repositoryUrl,
  };
}

function parseActor(value: unknown): { id?: number; login: string } {
  const sender = parseObject(value, "sender");
  const senderId = optionalPositiveInteger(sender, "id");
  return {
    ...(senderId ? { id: senderId } : {}),
    login: requiredGitHubLogin(sender, "login"),
  };
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new GitHubWebhookRequestError(
      `${field} is invalid`,
      "invalid_payload",
      400,
    );
  }
}

function parseIssueSnapshot(input: {
  issueValue: unknown;
  repository: { fullName: string };
}): GitHubIssueActivationPayload["issue"] {
  const issue = parseObject(input.issueValue, "issue");
  const number = requiredPositiveInteger(issue, "number");
  const expectedIssueUrl = `https://github.com/${input.repository.fullName}/issues/${number}`;
  const issueUrl = requiredString(issue, "html_url").replace(/\/+$/, "");
  if (issueUrl !== expectedIssueUrl) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook source URL does not match the repository",
      "invalid_payload",
      400,
    );
  }
  const updatedAt = requiredString(issue, "updated_at");
  assertTimestamp(updatedAt, "GitHub webhook issue timestamp");
  const user =
    issue.user === undefined
      ? undefined
      : parseObject(issue.user, "issue user");
  const bodyValue = issue.body;
  if (bodyValue !== null && typeof bodyValue !== "string") {
    throw new GitHubWebhookRequestError(
      "GitHub webhook issue body is invalid",
      "invalid_payload",
      400,
    );
  }
  return {
    number,
    url: issueUrl,
    title: requiredString(issue, "title"),
    body: typeof bodyValue === "string" ? bodyValue : "",
    state: requiredString(issue, "state"),
    updatedAt,
    ...(user ? { author: requiredGitHubLogin(user, "login") } : {}),
    assignees: loginArray(issue.assignees),
    labels: labelArray(issue.labels),
  };
}

function parseIssueActivationPayload(
  event: "issues" | "issue_comment",
  value: unknown,
): GitHubIssueActivationPayload {
  const payload = parseObject(value, "payload");
  const action = payload.action;
  if (
    (event === "issues" && action !== "labeled" && action !== "assigned") ||
    (event === "issue_comment" && action !== "created")
  ) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook action is unsupported",
      "unsupported_action",
      400,
    );
  }
  const installation = parseObject(payload.installation, "installation");
  const repository = parseRepository(payload.repository);
  const issue = parseIssueSnapshot({
    issueValue: payload.issue,
    repository,
  });
  const base = {
    event,
    action: action as GitHubIssueActivationPayload["action"],
    installationId: requiredPositiveInteger(installation, "id"),
    repository,
    actor: parseActor(payload.sender),
    issue,
  };
  if (event === "issues" && action === "labeled") {
    const label = parseObject(payload.label, "label");
    return { ...base, label: requiredString(label, "name") };
  }
  if (event === "issues" && action === "assigned") {
    const assignee = parseObject(payload.assignee, "assignee");
    return { ...base, assignee: requiredGitHubLogin(assignee, "login") };
  }
  const comment = parseObject(payload.comment, "comment");
  const commentUrl = requiredString(comment, "html_url");
  if (!commentUrl.startsWith(`${issue.url}#issuecomment-`)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook comment URL does not match the issue",
      "invalid_payload",
      400,
    );
  }
  const commentCreatedAt = requiredString(comment, "created_at");
  assertTimestamp(commentCreatedAt, "GitHub webhook comment timestamp");
  const commentUpdatedAt =
    typeof comment.updated_at === "string" && comment.updated_at
      ? comment.updated_at
      : undefined;
  if (commentUpdatedAt) {
    assertTimestamp(commentUpdatedAt, "GitHub webhook comment updated timestamp");
  }
  const commentBody = requiredString(comment, "body");
  const commentUser =
    comment.user === undefined
      ? undefined
      : parseObject(comment.user, "comment user");
  return {
    ...base,
    comment: {
      id: boundedCommentId(String(requiredPositiveInteger(comment, "id"))),
      url: commentUrl,
      body: commentBody,
      authorLogin: commentUser
        ? requiredGitHubLogin(commentUser, "login")
        : base.actor.login,
      createdAt: commentCreatedAt,
      ...(commentUpdatedAt ? { updatedAt: commentUpdatedAt } : {}),
    },
  };
}

function requiredBranchRef(value: unknown, field: string): string {
  const record = parseObject(value, field);
  const ref = requiredString(record, "ref");
  if (ref.length > 255 || ref.includes("\0")) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook pull request branch is invalid",
      "invalid_payload",
      400,
    );
  }
  return ref;
}

function parsePullRequestReviewCommentPayload(
  value: unknown,
): GitHubPullRequestReviewCommentPayload {
  const payload = parseObject(value, "payload");
  if (payload.action !== "created") {
    throw new GitHubWebhookRequestError(
      "GitHub webhook action is unsupported",
      "unsupported_action",
      400,
    );
  }
  const installation = parseObject(payload.installation, "installation");
  const repository = parseRepository(payload.repository);
  const pullRequest = parseObject(payload.pull_request, "pull_request");
  const number = requiredPositiveInteger(pullRequest, "number");
  const pullUrl = requiredString(pullRequest, "html_url").replace(/\/+$/, "");
  const expectedPullUrl = `https://github.com/${repository.fullName}/pull/${number}`;
  if (pullUrl !== expectedPullUrl) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook pull request URL does not match the repository",
      "invalid_payload",
      400,
    );
  }
  const updatedAt = requiredString(pullRequest, "updated_at");
  assertTimestamp(updatedAt, "GitHub webhook pull request timestamp");
  const head = parseObject(pullRequest.head, "pull_request head");
  const headRepo = parseObject(head.repo, "pull_request head repo");
  const headFullName = requiredString(headRepo, "full_name");
  if (!isValidRepositoryFullName(headFullName)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook head repository is invalid",
      "invalid_payload",
      400,
    );
  }
  const [headOwner, headRepository] = headFullName.split("/") as [string, string];
  const headSha = requiredString(head, "sha");
  if (!/^[a-f0-9]{7,64}$/i.test(headSha)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook pull request head SHA is invalid",
      "invalid_payload",
      400,
    );
  }
  const comment = parseObject(payload.comment, "comment");
  const commentUrl = requiredString(comment, "html_url");
  if (!commentUrl.startsWith(`${pullUrl}#discussion_r`)) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook review comment URL does not match the pull request",
      "invalid_payload",
      400,
    );
  }
  const commentCreatedAt = requiredString(comment, "created_at");
  assertTimestamp(commentCreatedAt, "GitHub webhook review comment timestamp");
  const commentUpdatedAt =
    typeof comment.updated_at === "string" && comment.updated_at
      ? comment.updated_at
      : undefined;
  if (commentUpdatedAt) {
    assertTimestamp(
      commentUpdatedAt,
      "GitHub webhook review comment updated timestamp",
    );
  }
  const commentUser =
    comment.user === undefined
      ? undefined
      : parseObject(comment.user, "comment user");
  const authorAssociation =
    typeof comment.author_association === "string" &&
      comment.author_association.trim()
      ? comment.author_association.trim().slice(0, 64)
      : undefined;
  const path =
    typeof comment.path === "string" && comment.path.trim()
      ? comment.path.trim().slice(0, 500)
      : undefined;
  const line = optionalPositiveInteger(comment, "line");
  const inReplyToId = optionalPositiveInteger(comment, "in_reply_to_id");
  return {
    event: "pull_request_review_comment",
    action: "created",
    installationId: requiredPositiveInteger(installation, "id"),
    repository,
    actor: parseActor(payload.sender),
    pullRequest: {
      number,
      url: pullUrl,
      updatedAt,
      baseBranch: requiredBranchRef(pullRequest.base, "pull_request base"),
      headBranch: requiredBranchRef(pullRequest.head, "pull_request head"),
      headSha,
      headRepository: {
        owner: headOwner,
        repository: headRepository,
      },
      isCrossRepository: normalizeCase(headFullName) !==
        normalizeCase(repository.fullName),
      draft: pullRequest.draft === true,
    },
    comment: {
      id: boundedCommentId(String(requiredPositiveInteger(comment, "id"))),
      url: commentUrl,
      body: requiredString(comment, "body"),
      authorLogin: commentUser
        ? requiredGitHubLogin(commentUser, "login")
        : requiredGitHubLogin(parseObject(payload.sender, "sender"), "login"),
      ...(authorAssociation ? { authorAssociation } : {}),
      createdAt: commentCreatedAt,
      ...(commentUpdatedAt ? { updatedAt: commentUpdatedAt } : {}),
      ...(path ? { path } : {}),
      ...(line ? { line } : {}),
      ...(inReplyToId ? { inReplyToId: String(inReplyToId) } : {}),
    },
  };
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new GitHubWebhookRequestError(
      "GitHub webhook body must be valid JSON",
      "invalid_payload",
      400,
    );
  }
}

function validateFreshness(
  eventAt: string,
  receivedAt: Date,
  configuration: NormalizedConfiguration,
): void {
  const eventTime = Date.parse(eventAt);
  const age = receivedAt.getTime() - eventTime;
  if (age > configuration.maxDeliveryAgeMs) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook delivery is stale",
      "stale_delivery",
      400,
    );
  }
  if (age < -configuration.maxFutureSkewMs) {
    throw new GitHubWebhookRequestError(
      "GitHub webhook delivery timestamp is in the future",
      "future_delivery",
      400,
    );
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsConfiguredMention(
  body: string,
  mentions: Set<string>,
): boolean {
  if (mentions.size === 0) return false;
  return [...mentions].some((mention) =>
    new RegExp(`(^|[^A-Za-z0-9_-])@${regexEscape(mention)}(?![A-Za-z0-9_-])`, "i")
      .test(body)
  );
}

function extractReviewFeedbackCommand(
  body: string,
  mentions: Set<string>,
): { action: "rework" | "address" | "explain"; instruction: string } | undefined {
  if (mentions.size === 0) return undefined;
  for (const mention of mentions) {
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_-])@${regexEscape(mention)}\\s+(rework|address|explain)\\b[:\\s-]*([\\s\\S]*)`,
      "i",
    );
    const match = pattern.exec(body);
    const action = match?.[1]?.toLowerCase();
    const instruction = match?.[2]?.trim();
    if (
      (action === "rework" || action === "address" || action === "explain") &&
      instruction
    ) {
      return { action, instruction };
    }
  }
  return undefined;
}

function issueSnapshotForPayload(
  payload: GitHubIssueActivationPayload,
  receivedAt: string,
): TaskSourceSnapshot {
  return {
    uri: payload.issue.url,
    externalId: `${payload.repository.fullName}#${payload.issue.number}`,
    title: payload.issue.title,
    body: payload.issue.body,
    fetchedAt: receivedAt,
    state: payload.issue.state,
    updatedAt: payload.issue.updatedAt,
    ...(payload.issue.author ? { author: payload.issue.author } : {}),
    assignees: payload.issue.assignees,
    labels: payload.issue.labels,
    ...(payload.comment
      ? {
          comments: [
            {
              author: payload.comment.authorLogin,
              body: payload.comment.body,
              createdAt: payload.comment.createdAt,
              ...(payload.comment.updatedAt
                ? { updatedAt: payload.comment.updatedAt }
                : {}),
            },
          ],
        }
      : {}),
  };
}

function executionRequestForPayload(input: {
  deliveryId: string;
  receivedAt: string;
  payload: GitHubIssueActivationPayload;
  mapping: GitHubWebhookRepositoryMapping;
  flowPath: string;
}): GitHubWebhookExecutionRequest {
  const snapshot = issueSnapshotForPayload(input.payload, input.receivedAt);
  return {
    schemaVersion: 1,
    apiVersion: "nitely.dev/github-webhook/v1",
    kind: "ExecutionRequest",
    idempotencyKey: `github:delivery:${input.deliveryId}`,
    provider: "github",
    event: input.payload.event,
    action: input.payload.action,
    deliveryId: input.deliveryId,
    receivedAt: input.receivedAt,
    eventAt: input.payload.comment?.createdAt ?? input.payload.issue.updatedAt,
    installationId: input.payload.installationId,
    repository: {
      ...input.payload.repository,
      nitelyRepositoryId: input.mapping.repositoryId,
    },
    actor: input.payload.actor,
    source: {
      number: input.payload.issue.number,
      url: input.payload.issue.url,
      snapshot,
      snapshotSha256: snapshotFingerprint(snapshot),
    },
    requestedFlow: input.flowPath,
  };
}

function changeRequestTargetForPayload(
  payload: GitHubPullRequestReviewCommentPayload,
): ChangeRequestTarget {
  const [owner, repository] = payload.repository.fullName.split("/") as [
    string,
    string,
  ];
  return {
    provider: "github",
    owner,
    repository,
    number: payload.pullRequest.number,
    url: payload.pullRequest.url,
    baseBranch: payload.pullRequest.baseBranch,
    headBranch: payload.pullRequest.headBranch,
    headSha: payload.pullRequest.headSha,
    headRepository: payload.pullRequest.headRepository,
    isCrossRepository: payload.pullRequest.isCrossRepository,
  };
}

function reviewCommentForPayload(
  payload: GitHubPullRequestReviewCommentPayload,
): PullRequestDiscussionItem {
  return {
    provider: "github",
    kind: "review-comment",
    id: payload.comment.id,
    url: payload.comment.url,
    body: payload.comment.body,
    authorLogin: payload.comment.authorLogin,
    ...(payload.comment.authorAssociation
      ? { authorAssociation: payload.comment.authorAssociation }
      : {}),
    createdAt: payload.comment.createdAt,
    ...(payload.comment.updatedAt ? { updatedAt: payload.comment.updatedAt } : {}),
    ...(payload.comment.path ? { path: payload.comment.path } : {}),
    ...(typeof payload.comment.line === "number" ? { line: payload.comment.line } : {}),
    ...(payload.comment.inReplyToId
      ? { inReplyToId: payload.comment.inReplyToId }
      : {}),
  };
}

function changeRequestForPayload(
  payload: GitHubPullRequestReviewCommentPayload,
): ChangeRequest {
  const target = changeRequestTargetForPayload(payload);
  return {
    provider: "github",
    url: target.url,
    number: target.number,
    owner: target.owner,
    repository: target.repository,
    baseBranch: target.baseBranch,
    headBranch: target.headBranch,
    draft: payload.pullRequest.draft,
  };
}

function reworkRequestForPayload(input: {
  deliveryId: string;
  receivedAt: string;
  payload: GitHubPullRequestReviewCommentPayload;
  mapping: GitHubWebhookRepositoryMapping;
  feedback: { action: "rework" | "address"; instruction: string };
  flowPath: string;
}): GitHubWebhookReworkRequest {
  return {
    schemaVersion: 1,
    apiVersion: "nitely.dev/github-webhook/v1",
    kind: "ReworkRequest",
    idempotencyKey: `github:pr-review-comment:${input.payload.repository.fullName}#${input.payload.pullRequest.number}:comment:${input.payload.comment.id}`,
    provider: "github",
    event: "pull_request_review_comment",
    action: "created",
    deliveryId: input.deliveryId,
    receivedAt: input.receivedAt,
    eventAt: input.payload.comment.createdAt,
    installationId: input.payload.installationId,
    repository: {
      ...input.payload.repository,
      nitelyRepositoryId: input.mapping.repositoryId,
    },
    actor: input.payload.actor,
    pullRequest: input.payload.pullRequest,
    comment: input.payload.comment,
    feedback: input.feedback,
    requestedFlow: input.flowPath,
  };
}

function ignoredRecord(input: {
  deliveryId: string;
  event: string;
  bodySha256: string;
  receivedAt: string;
  reason: string;
  summary?: GitHubWebhookDeliveryRecord["summary"];
}): GitHubWebhookDeliveryRecord {
  return {
    schemaVersion: 1,
    deliveryId: input.deliveryId,
    event: input.event,
    bodySha256: input.bodySha256,
    receivedAt: input.receivedAt,
    updatedAt: input.receivedAt,
    state: "ignored",
    reason: input.reason,
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

function acceptance(
  record: GitHubWebhookDeliveryRecord,
  duplicate: boolean,
): GitHubWebhookAcceptance {
  return {
    status: 202,
    accepted: Boolean(record.request),
    duplicate,
    deliveryId: record.deliveryId,
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

function deterministicTaskId(request: GitHubWebhookExecutionRequest): string {
  return `github-delivery-${sha256(request.deliveryId).slice(0, 24)}`;
}

function taskIntakeProvenance(
  request: GitHubWebhookExecutionRequest,
): TaskSourceIntakeProvenance {
  return {
    type: "github-webhook",
    deliveryId: request.deliveryId,
    installationId: request.installationId,
    repositoryId: request.repository.id,
    repositoryFullName: request.repository.fullName,
    actorId: request.actor.id,
    actorLogin: request.actor.login,
    event: request.event,
    action: request.action,
    receivedAt: request.receivedAt,
    eventAt: request.eventAt,
    requestedFlow: request.requestedFlow,
    snapshotSha256: request.source.snapshotSha256,
  };
}

function taskSourceForRequest(
  request: GitHubWebhookExecutionRequest,
): TaskSourceRecord {
  const snapshot = request.source.snapshot;
  return {
    type: "github-issue",
    uri: snapshot.uri,
    externalId: snapshot.externalId,
    title: snapshot.title,
    snapshot,
    drift: {
      status: "unchanged",
      checkedAt: snapshot.fetchedAt,
      changedFields: [],
    },
    intake: taskIntakeProvenance(request),
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function hasDraftPlanningArtifact(
  task: TaskRecord,
  kind: "spec" | "techDesign",
): boolean {
  const versions = task.planningArtifacts?.[kind];
  const current = versions?.revisions.find(
    (revision) => revision.versionId === versions.currentVersionId,
  );
  return Boolean(
    versions && !versions.approvedVersionId && current?.approvalState === "draft",
  );
}

function hasExpectedTaskLineage(input: {
  task: TaskRecord;
  target: GitHubWebhookRepositoryTarget;
  request: GitHubWebhookExecutionRequest;
  expectedTitle: string;
  expectedSource: TaskSourceRecord;
}): boolean {
  const { task, target, request, expectedTitle, expectedSource } = input;
  return (
    task.id === deterministicTaskId(request) &&
    task.title === expectedTitle &&
    task.status === "draft" &&
    task.specStatus === "draft" &&
    task.techDesignStatus === "draft" &&
    (task.repoId === target.id ||
      (target.home === true && task.repoId === LEGACY_DEFAULT_REPOSITORY_ID)) &&
    task.flowPath === request.requestedFlow &&
    task.issueUrl === request.source.snapshot.uri &&
    task.specPath === `.nitely/tasks/${task.id}/spec.md` &&
    task.techDesignPath === `.nitely/tasks/${task.id}/tech-design.md` &&
    !task.latestRunId &&
    !task.changeRequestUrl &&
    hasDraftPlanningArtifact(task, "spec") &&
    hasDraftPlanningArtifact(task, "techDesign") &&
    sameCanonicalValue(task.source, expectedSource)
  );
}

async function existingTask(
  repoPath: string,
  taskId: string,
): Promise<TaskRecord | undefined> {
  try {
    return await getTask(repoPath, taskId);
  } catch (error) {
    if (error instanceof WebNotFoundError) return undefined;
    throw error;
  }
}

async function createOrReuseTask(
  target: GitHubWebhookRepositoryTarget,
  request: GitHubWebhookExecutionRequest,
): Promise<TaskRecord> {
  const taskId = deterministicTaskId(request);
  const snapshot = request.source.snapshot;
  if (
    target.id !== request.repository.nitelyRepositoryId ||
    request.idempotencyKey !== `github:delivery:${request.deliveryId}` ||
    request.source.url !== snapshot.uri ||
    snapshotFingerprint(snapshot) !== request.source.snapshotSha256
  ) {
    throw new Error("GitHub execution request lineage is invalid");
  }
  const expectedSource = taskSourceForRequest(request);
  const generated = generateDraftSpec({
    type: "github-issue",
    title: snapshot.title,
    body: snapshot.body.trim() ? snapshot.body : snapshot.title,
    uri: snapshot.uri,
  });
  await syncTaskMaterialization(target.path, taskId, true);
  const prior = await existingTask(target.path, taskId);
  if (prior) {
    if (!hasExpectedTaskLineage({
      task: prior,
      target,
      request,
      expectedTitle: generated.title,
      expectedSource,
    })) {
      throw new Error("deterministic GitHub task identity collision");
    }
    await materializeTaskExecutionInputs(target.path, prior);
    await syncTaskMaterialization(target.path, taskId, false);
    return prior;
  }
  const created = await createTask(
    target.path,
    {
      title: generated.title,
      spec: generated.markdown,
      techDesign:
        "# Technical Design\n\nStatus: draft\n\nA technical design must be created and approved before implementation.\n",
      repoId: target.id,
      issueUrl: snapshot.uri,
      flowPath: request.requestedFlow,
    },
    {
      createId: () => taskId,
      repoId: target.id,
      initialStatus: "draft",
      specStatus: "draft",
      techDesignStatus: "draft",
      source: expectedSource,
    },
  );
  await syncTaskMaterialization(target.path, taskId, false);
  return created;
}

function pullRequestUrlKey(input: {
  owner: string;
  repository: string;
  number: number;
}): string {
  return `${normalizeCase(input.owner)}/${normalizeCase(input.repository)}#${input.number}`;
}

function pullRequestUrlKeyFromUrl(value: string): string | undefined {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  return pullRequestUrlKey({
    owner: match[1]!,
    repository: match[2]!,
    number: Number.parseInt(match[3]!, 10),
  });
}

function reworkChangeRequestTarget(
  request: GitHubWebhookReworkRequest,
): ChangeRequestTarget {
  const [owner, repository] = request.repository.fullName.split("/") as [
    string,
    string,
  ];
  return {
    provider: "github",
    owner,
    repository,
    number: request.pullRequest.number,
    url: request.pullRequest.url,
    baseBranch: request.pullRequest.baseBranch,
    headBranch: request.pullRequest.headBranch,
    headSha: request.pullRequest.headSha,
    headRepository: request.pullRequest.headRepository,
    isCrossRepository: request.pullRequest.isCrossRepository,
  };
}

function reworkChangeRequest(
  request: GitHubWebhookReworkRequest,
): ChangeRequest {
  const target = reworkChangeRequestTarget(request);
  return {
    provider: "github",
    url: target.url,
    number: target.number,
    owner: target.owner,
    repository: target.repository,
    baseBranch: target.baseBranch,
    headBranch: target.headBranch,
    draft: request.pullRequest.draft,
  };
}

function reworkDiscussionItem(
  request: GitHubWebhookReworkRequest,
): PullRequestDiscussionItem {
  return {
    provider: "github",
    kind: "review-comment",
    id: request.comment.id,
    url: request.comment.url,
    body: request.comment.body,
    authorLogin: request.comment.authorLogin,
    ...(request.comment.authorAssociation
      ? { authorAssociation: request.comment.authorAssociation }
      : {}),
    createdAt: request.comment.createdAt,
    ...(request.comment.updatedAt ? { updatedAt: request.comment.updatedAt } : {}),
    ...(request.comment.path ? { path: request.comment.path } : {}),
    ...(typeof request.comment.line === "number" ? { line: request.comment.line } : {}),
    ...(request.comment.inReplyToId
      ? { inReplyToId: request.comment.inReplyToId }
      : {}),
  };
}

async function findTaskForReworkRequest(
  repoPath: string,
  request: GitHubWebhookReworkRequest,
): Promise<TaskRecord | undefined> {
  const expectedKey = pullRequestUrlKey({
    ...reworkChangeRequestTarget(request),
  });
  const tasks = await listTasks(repoPath);
  return tasks.find((task) =>
    task.changeRequestUrl &&
    pullRequestUrlKeyFromUrl(task.changeRequestUrl) === expectedKey
  );
}

async function createOrReuseReworkRequest(
  target: GitHubWebhookRepositoryTarget,
  request: GitHubWebhookReworkRequest,
): Promise<{ task: TaskRecord; reworkRequest: TaskReworkRequest }> {
  if (
    target.id !== request.repository.nitelyRepositoryId ||
    request.event !== "pull_request_review_comment" ||
    request.action !== "created" ||
    !request.idempotencyKey.startsWith("github:pr-review-comment:")
  ) {
    throw new Error("GitHub rework request lineage is invalid");
  }
  const task = await findTaskForReworkRequest(target.path, request);
  if (!task) {
    throw new Error("GitHub rework request target task was not found");
  }
  const feedback = normalizeReviewFeedback({
    target: reworkChangeRequestTarget(request),
    comment: reworkDiscussionItem(request),
    action: request.feedback.action,
    instruction: request.feedback.instruction,
    ...(task.latestRunId ? { priorRunId: task.latestRunId } : {}),
    ingestedAt: request.receivedAt,
  });
  if (feedback.route.target !== "implementation") {
    throw new Error("GitHub rework request route is not supported by this slice");
  }
  const reworkRequest = await createTaskReworkRequest(target.path, task, {
    instruction: feedback.instruction,
    routeTarget: "implementation",
    idempotencyKey: request.idempotencyKey,
    actor: { id: `github:${request.actor.login}` },
    flowPath: request.requestedFlow,
    changeRequest: reworkChangeRequest(request),
  });
  return { task, reworkRequest };
}

export class GitHubWebhookIntake {
  readonly #stateRepoPath: string;
  readonly #configuration: NormalizedConfiguration;
  readonly #resolveRepository: GitHubWebhookIntakeInput["resolveRepository"];
  readonly #leaseOwnerId: string;
  readonly #leaseDurationMs: number;
  #drainTail: Promise<void> = Promise.resolve();

  constructor(input: GitHubWebhookIntakeInput) {
    this.#stateRepoPath = resolve(input.stateRepoPath);
    this.#configuration = normalizeConfiguration(input.configuration);
    this.#resolveRepository = input.resolveRepository;
    this.#leaseOwnerId = input.createLeaseOwnerId?.() ??
      `pid-${process.pid}-${randomBytes(6).toString("hex")}`;
    this.#leaseDurationMs = input.leaseDurationMs ?? defaultProcessingLeaseMs;
    requirePositiveInteger(
      this.#leaseDurationMs,
      "GitHub webhook processing lease duration",
    );
  }

  async accept(input: GitHubWebhookAcceptInput): Promise<GitHubWebhookAcceptance> {
    if (input.body.byteLength > maximumGitHubWebhookBodyBytes) {
      throw new GitHubWebhookRequestError(
        "GitHub webhook body is too large",
        "payload_too_large",
        413,
      );
    }
    verifySignature(this.#configuration.secret, input.signature, input.body);
    const deliveryId = validateDeliveryId(input.deliveryId);
    const event = input.event.trim().toLowerCase();
    if (!event || event.length > 64) {
      throw new GitHubWebhookRequestError(
        "GitHub webhook event is invalid",
        "invalid_event",
        400,
      );
    }
    const bodySha256 = sha256(input.body);
    const receivedAt = this.#configuration.now();
    const receivedAtIso = receivedAt.toISOString();
    const existing = await findGitHubWebhookDelivery(
      this.#stateRepoPath,
      deliveryId,
    );
    if (existing) {
      if (existing.bodySha256 !== bodySha256 || existing.event !== event) {
        throw new GitHubWebhookRequestError(
          "GitHub delivery id was already used with a different event or payload",
          "delivery_id_collision",
          409,
        );
      }
      if (existing.state === "denied") {
        throw new GitHubWebhookRequestError(
          "GitHub webhook request is not permitted",
          existing.reason ?? "request_denied",
          403,
        );
      }
      return acceptance(existing, true);
    }

    const payloadValue = parseJsonBody(input.body);
    const payloadObject = parseObject(payloadValue, "payload");
    if (
      event !== "issues" &&
      event !== "issue_comment" &&
      event !== "pull_request_review_comment"
    ) {
      const created = await createDeliveryRecord(
        this.#stateRepoPath,
        ignoredRecord({
          deliveryId,
          event,
          bodySha256,
          receivedAt: receivedAtIso,
          reason: "unsupported_event",
        }),
      );
      return acceptance(created.record, created.duplicate);
    }

    const action =
      typeof payloadObject.action === "string"
        ? payloadObject.action.trim()
        : "";
    const supportedAction =
      (event === "issues" && (action === "labeled" || action === "assigned")) ||
      (event === "issue_comment" && action === "created") ||
      (event === "pull_request_review_comment" && action === "created");
    if (!supportedAction) {
      const created = await createDeliveryRecord(
        this.#stateRepoPath,
        ignoredRecord({
          deliveryId,
          event,
          bodySha256,
          receivedAt: receivedAtIso,
          reason: "unsupported_action",
          summary: {
            ...(typeof payloadObject.action === "string"
              ? { action: payloadObject.action.slice(0, 64) }
              : {}),
          },
        }),
      );
      return acceptance(created.record, created.duplicate);
    }

    if (
      event === "issue_comment" &&
      action === "created" &&
      typeof payloadObject.issue === "object" &&
      payloadObject.issue !== null &&
      !Array.isArray(payloadObject.issue) &&
      "pull_request" in payloadObject.issue
    ) {
      const created = await createDeliveryRecord(
        this.#stateRepoPath,
        ignoredRecord({
          deliveryId,
          event,
          bodySha256,
          receivedAt: receivedAtIso,
          reason: "unsupported_pull_request_issue_comment",
          summary: { action },
        }),
      );
      return acceptance(created.record, created.duplicate);
    }

    const payload = event === "pull_request_review_comment"
      ? parsePullRequestReviewCommentPayload(payloadValue)
      : parseIssueActivationPayload(event as "issues" | "issue_comment", payloadValue);
    validateFreshness(
      payload.event === "pull_request_review_comment"
        ? payload.comment.createdAt
        : payload.comment?.createdAt ?? payload.issue.updatedAt,
      receivedAt,
      this.#configuration,
    );
    const mapping = this.#configuration.repositories.find(
      (candidate) =>
        normalizeCase(candidate.fullName) ===
        normalizeCase(payload.repository.fullName),
    );
    const denialReason = !mapping
      ? "repository_denied"
      : !this.#configuration.allowedActors.has(normalizeCase(payload.actor.login))
        ? "actor_denied"
        : this.#configuration.allowedInstallationIds &&
            !this.#configuration.allowedInstallationIds.has(payload.installationId)
          ? "installation_denied"
          : undefined;
    const summary: GitHubWebhookDeliveryRecord["summary"] = {
      action: payload.action,
      repositoryFullName: payload.repository.fullName,
      actorLogin: payload.actor.login,
      installationId: payload.installationId,
      ...(payload.event === "pull_request_review_comment"
        ? { pullRequestNumber: payload.pullRequest.number }
        : { issueNumber: payload.issue.number }),
    };
    if (denialReason) {
      const denied: GitHubWebhookDeliveryRecord = {
        ...ignoredRecord({
          deliveryId,
          event,
          bodySha256,
          receivedAt: receivedAtIso,
          reason: denialReason,
          summary,
        }),
        state: "denied",
      };
      await createDeliveryRecord(this.#stateRepoPath, denied);
      throw new GitHubWebhookRequestError(
        "GitHub webhook request is not permitted",
        denialReason,
        403,
      );
    }

    let request: GitHubWebhookRequest | undefined;
    let ignoredReason: string | undefined;
    if (payload.event === "issues" && payload.action === "labeled") {
      ignoredReason = this.#configuration.triggerLabels.has(
        normalizeCase(payload.label ?? ""),
      )
        ? undefined
        : "trigger_not_matched";
      if (!ignoredReason) {
        request = executionRequestForPayload({
          deliveryId,
          receivedAt: receivedAtIso,
          payload,
          mapping: mapping!,
          flowPath: this.#configuration.flowPath,
        });
      }
    } else if (payload.event === "issues" && payload.action === "assigned") {
      ignoredReason = this.#configuration.triggerAssignees.has(
        normalizeGitHubMention(payload.assignee ?? ""),
      )
        ? undefined
        : "trigger_not_matched";
      if (!ignoredReason) {
        request = executionRequestForPayload({
          deliveryId,
          receivedAt: receivedAtIso,
          payload,
          mapping: mapping!,
          flowPath: this.#configuration.flowPath,
        });
      }
    } else if (payload.event === "issue_comment") {
      ignoredReason = containsConfiguredMention(
        payload.comment?.body ?? "",
        this.#configuration.triggerMentions,
      )
        ? undefined
        : "trigger_not_matched";
      if (!ignoredReason) {
        request = executionRequestForPayload({
          deliveryId,
          receivedAt: receivedAtIso,
          payload,
          mapping: mapping!,
          flowPath: this.#configuration.flowPath,
        });
      }
    } else {
      const reworkPayload = payload as GitHubPullRequestReviewCommentPayload;
      const command = extractReviewFeedbackCommand(
        reworkPayload.comment.body,
        this.#configuration.triggerMentions,
      );
      if (!command) {
        ignoredReason = "trigger_not_matched";
      } else if (command.action === "explain") {
        ignoredReason = "unsupported_review_feedback_action";
      } else {
        const feedbackCommand: { action: "rework" | "address"; instruction: string } =
          { action: command.action, instruction: command.instruction };
        const feedback = normalizeReviewFeedback({
          target: changeRequestTargetForPayload(reworkPayload),
          comment: reviewCommentForPayload(reworkPayload),
          action: feedbackCommand.action,
          instruction: feedbackCommand.instruction,
          ingestedAt: receivedAtIso,
        });
        if (feedback.route.target !== "implementation") {
          ignoredReason = "unsupported_review_feedback_route";
        } else {
          request = reworkRequestForPayload({
            deliveryId,
            receivedAt: receivedAtIso,
            payload: reworkPayload,
            mapping: mapping!,
            feedback: feedbackCommand,
            flowPath: this.#configuration.reworkFlowPath,
          });
        }
      }
    }

    if (!request) {
      const created = await createDeliveryRecord(
        this.#stateRepoPath,
        ignoredRecord({
          deliveryId,
          event,
          bodySha256,
          receivedAt: receivedAtIso,
          reason: ignoredReason ?? "trigger_not_matched",
          summary,
        }),
      );
      return acceptance(created.record, created.duplicate);
    }

    const queued: GitHubWebhookDeliveryRecord = {
      schemaVersion: 1,
      deliveryId,
      event,
      bodySha256,
      receivedAt: receivedAtIso,
      updatedAt: receivedAtIso,
      state: "queued",
      request,
    };
    const created = await createDeliveryRecord(this.#stateRepoPath, queued);
    return acceptance(created.record, created.duplicate);
  }

  drain(): Promise<void> {
    const run = this.#drainTail.then(() => this.#drainOnce());
    this.#drainTail = run.catch(() => {});
    return run;
  }

  async #publishStatus(
    update: GitHubWebhookStatusUpdate,
    previous: GitHubWebhookDeliveryRecord["callback"],
  ): Promise<NonNullable<GitHubWebhookDeliveryRecord["callback"]>> {
    const attemptedAt = this.#configuration.now().toISOString();
    const attempts = (previous?.attempts ?? 0) + 1;
    try {
      const publication = await this.#configuration.statusPublisher!(
        update,
        previous?.external,
      );
      const external = mergeStatusPublication(previous?.external, publication);
      return {
        state: "succeeded",
        attemptedAt,
        attempts,
        ...(external ? { external } : {}),
      };
    } catch (error) {
      const external = mergeStatusPublication(
        previous?.external,
        statusPublicationFromError(error),
      );
      return {
        state: "failed",
        attemptedAt,
        attempts,
        failureCode: "status_publish_failed",
        ...(external ? { external } : {}),
      };
    }
  }

  #taskCreatedStatus(
    delivery: GitHubWebhookDeliveryRecord,
    taskId: string,
  ): Extract<GitHubWebhookStatusUpdate, { state: "task-created" }> {
    const request = delivery.request as GitHubWebhookExecutionRequest;
    return {
      state: "task-created",
      deliveryId: delivery.deliveryId,
      installationId: request.installationId,
      repositoryId: request.repository.id,
      repositoryFullName: request.repository.fullName,
      issueNumber: request.source.number,
      sourceUrl: request.source.url,
      taskId,
      taskPath: `/tasks/${encodeURIComponent(taskId)}`,
    };
  }

  #reworkRequestCreatedStatus(
    delivery: GitHubWebhookDeliveryRecord,
    taskId: string,
    reworkRequestId: string,
  ): Extract<GitHubWebhookStatusUpdate, { state: "rework-request-created" }> {
    const request = delivery.request as GitHubWebhookReworkRequest;
    return {
      state: "rework-request-created",
      deliveryId: delivery.deliveryId,
      installationId: request.installationId,
      repositoryId: request.repository.id,
      repositoryFullName: request.repository.fullName,
      pullRequestNumber: request.pullRequest.number,
      headSha: request.pullRequest.headSha,
      sourceUrl: request.comment.url,
      taskId,
      reworkRequestId,
      reworkRequestPath:
        `/tasks/${encodeURIComponent(taskId)}/rework-requests/${encodeURIComponent(reworkRequestId)}`,
    };
  }

  #completedStatus(
    delivery: GitHubWebhookDeliveryRecord,
  ): Extract<
    GitHubWebhookStatusUpdate,
    { state: "task-created" | "rework-request-created" }
  > {
    const request = delivery.request!;
    return request.kind === "ExecutionRequest"
      ? this.#taskCreatedStatus(delivery, delivery.taskId!)
      : this.#reworkRequestCreatedStatus(
          delivery,
          delivery.taskId!,
          delivery.reworkRequestId!,
        );
  }

  #failedStatus(
    delivery: GitHubWebhookDeliveryRecord,
  ): Extract<GitHubWebhookStatusUpdate, { state: "failed" }> {
    const request = delivery.request!;
    const source = request.kind === "ExecutionRequest"
      ? {
          issueNumber: request.source.number,
          sourceUrl: request.source.url,
        }
      : {
          pullRequestNumber: request.pullRequest.number,
          headSha: request.pullRequest.headSha,
          sourceUrl: request.comment.url,
        };
    return {
      state: "failed",
      deliveryId: delivery.deliveryId,
      installationId: request.installationId,
      repositoryId: request.repository.id,
      repositoryFullName: request.repository.fullName,
      ...source,
      failureCode: "processing_failed",
    };
  }

  async #drainOnce(): Promise<void> {
    const deliveries = await listGitHubWebhookDeliveries(this.#stateRepoPath);
    for (const delivery of deliveries) {
      if (
        this.#configuration.statusPublisher &&
        delivery.request &&
        delivery.callback &&
        delivery.callback.state !== "succeeded" &&
        ((delivery.state === "completed" &&
          delivery.taskId &&
          (delivery.request.kind === "ExecutionRequest" ||
            delivery.reworkRequestId)) ||
          delivery.state === "failed")
      ) {
        await this.#withDeliveryLease(delivery.deliveryId, async () => {
          const current = await getGitHubWebhookDelivery(
            this.#stateRepoPath,
            delivery.deliveryId,
          );
          if (
            !current.request ||
            !current.callback ||
            current.callback.state === "succeeded" ||
            !(
              (current.state === "completed" &&
                current.taskId &&
                (current.request.kind === "ExecutionRequest" ||
                  current.reworkRequestId)) ||
              current.state === "failed"
            )
          ) {
            return;
          }
          const callback = await this.#publishStatus(
            current.state === "completed"
              ? this.#completedStatus(current)
              : this.#failedStatus(current),
            current.callback,
          );
          await updateDeliveryRecord(this.#stateRepoPath, {
            ...current,
            callback,
            updatedAt: this.#configuration.now().toISOString(),
          });
        });
        continue;
      }
      if (
        (delivery.state !== "queued" && delivery.state !== "processing") ||
        !delivery.request
      ) {
        continue;
      }
      await this.#withDeliveryLease(delivery.deliveryId, async (lease) => {
        const current = await getGitHubWebhookDelivery(
          this.#stateRepoPath,
          delivery.deliveryId,
        );
        if (
          (current.state !== "queued" && current.state !== "processing") ||
          !current.request
        ) {
          return;
        }
        const processing: GitHubWebhookDeliveryRecord = {
          ...current,
          state: "processing",
          lease,
          updatedAt: this.#configuration.now().toISOString(),
        };
        await updateDeliveryRecord(this.#stateRepoPath, processing);
        try {
          const target = await this.#resolveRepository(
            current.request.repository.nitelyRepositoryId,
          );
          if (!target) throw new Error("mapped Nitely repository is unavailable");
          let task: TaskRecord;
          let reworkRequest: TaskReworkRequest | undefined;
          if (current.request.kind === "ExecutionRequest") {
            task = await createOrReuseTask(target, current.request);
            await upsertFactoryCandidateForWorkItem(target.path, projectWorkItem(task));
          } else {
            const created = await createOrReuseReworkRequest(target, current.request);
            task = created.task;
            reworkRequest = created.reworkRequest;
          }
          let callback: GitHubWebhookDeliveryRecord["callback"];
          if (this.#configuration.statusPublisher) {
            callback = await this.#publishStatus(
              current.request.kind === "ExecutionRequest"
                ? this.#taskCreatedStatus(current, task.id)
                : this.#reworkRequestCreatedStatus(
                    current,
                    task.id,
                    reworkRequest!.id,
                  ),
              undefined,
            );
          }
          await updateDeliveryRecord(this.#stateRepoPath, {
            ...processing,
            state: "completed",
            taskId: task.id,
            ...(reworkRequest ? { reworkRequestId: reworkRequest.id } : {}),
            callback,
            lease: undefined,
            updatedAt: this.#configuration.now().toISOString(),
          });
        } catch {
          const failed: GitHubWebhookDeliveryRecord = {
            ...processing,
            state: "failed",
            failure: {
              code: "processing_failed",
              message: "GitHub webhook processing failed",
            },
            ...(this.#configuration.statusPublisher
              ? {
                  callback: {
                    state: "pending" as const,
                    attemptedAt: this.#configuration.now().toISOString(),
                    attempts: 0,
                  },
                }
              : {}),
            lease: undefined,
            updatedAt: this.#configuration.now().toISOString(),
          };
          await updateDeliveryRecord(this.#stateRepoPath, failed);
          if (this.#configuration.statusPublisher) {
            const callback = await this.#publishStatus(
              this.#failedStatus(failed),
              failed.callback,
            );
            await updateDeliveryRecord(this.#stateRepoPath, {
              ...failed,
              callback,
              updatedAt: this.#configuration.now().toISOString(),
            });
          }
        }
      });
    }
  }

  async #withDeliveryLease(
    deliveryId: string,
    action: (lease: GitHubWebhookDeliveryLease) => Promise<void>,
  ): Promise<void> {
    const lease = await acquireDeliveryLease(this.#stateRepoPath, {
      deliveryId,
      ownerId: this.#leaseOwnerId,
      now: this.#configuration.now(),
      durationMs: this.#leaseDurationMs,
    });
    if (!lease) return;
    try {
      await action(lease);
    } finally {
      await releaseDeliveryLease(this.#stateRepoPath, lease).catch(() => {});
    }
  }
}

function mergeStatusPublication(
  previous: GitHubWebhookStatusPublication | undefined,
  publication: GitHubWebhookStatusPublication | void,
): GitHubWebhookStatusPublication | undefined {
  if (!previous && !publication) return undefined;
  return {
    provider: "github",
    ...(previous?.checkRunId ? { checkRunId: previous.checkRunId } : {}),
    ...(previous?.commentId ? { commentId: previous.commentId } : {}),
    ...(publication?.checkRunId ? { checkRunId: publication.checkRunId } : {}),
    ...(publication?.commentId ? { commentId: publication.commentId } : {}),
  };
}

function statusPublicationFromError(
  error: unknown,
): GitHubWebhookStatusPublication | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "publication" in error
  ) {
    const publication = (error as { publication?: unknown }).publication;
    if (
      typeof publication === "object" &&
      publication !== null &&
      (publication as { provider?: unknown }).provider === "github"
    ) {
      return publication as GitHubWebhookStatusPublication;
    }
  }
  return undefined;
}

function commaSeparated(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseEnvironmentPositiveInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${field} must be a positive integer`);
  }
  return requirePositiveInteger(Number(value), field);
}

export function githubWebhookConfigurationFromEnv(
  env: Record<string, string | undefined>,
): GitHubWebhookConfiguration | undefined {
  const keys = [
    "NITELY_GITHUB_WEBHOOK_SECRET",
    "NITELY_GITHUB_WEBHOOK_REPOSITORIES",
    "NITELY_GITHUB_WEBHOOK_ACTORS",
    "NITELY_GITHUB_WEBHOOK_INSTALLATIONS",
    "NITELY_GITHUB_WEBHOOK_LABELS",
    "NITELY_GITHUB_WEBHOOK_ASSIGNEES",
    "NITELY_GITHUB_WEBHOOK_MENTIONS",
    "NITELY_GITHUB_WEBHOOK_FLOW",
    "NITELY_GITHUB_WEBHOOK_REWORK_FLOW",
    "NITELY_GITHUB_WEBHOOK_MAX_AGE_MS",
  ] as const;
  if (!keys.some((key) => env[key]?.trim())) return undefined;
  const secret = env.NITELY_GITHUB_WEBHOOK_SECRET?.trim();
  const repositoryText = env.NITELY_GITHUB_WEBHOOK_REPOSITORIES?.trim();
  const actorText = env.NITELY_GITHUB_WEBHOOK_ACTORS?.trim();
  const flowPath = env.NITELY_GITHUB_WEBHOOK_FLOW?.trim();
  if (!secret || !repositoryText || !actorText || !flowPath) {
    throw new Error("GitHub webhook configuration is incomplete");
  }
  const repositories = commaSeparated(repositoryText).map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(
        "GitHub webhook repositories must use owner/repository=repository-id",
      );
    }
    return {
      fullName: entry.slice(0, separator).trim(),
      repositoryId: entry.slice(separator + 1).trim(),
    };
  });
  const allowedActors = commaSeparated(actorText);
  const installationText = env.NITELY_GITHUB_WEBHOOK_INSTALLATIONS?.trim();
  const maxAgeText = env.NITELY_GITHUB_WEBHOOK_MAX_AGE_MS?.trim();
  const configuration: GitHubWebhookConfiguration = {
    secret,
    repositories,
    allowedActors,
    ...(installationText
      ? {
          allowedInstallationIds: commaSeparated(installationText).map((value) =>
            parseEnvironmentPositiveInteger(
              value,
              "GitHub webhook installation id",
            ),
          ),
        }
      : {}),
    triggerLabels: commaSeparated(
      env.NITELY_GITHUB_WEBHOOK_LABELS?.trim() || "nitely",
    ),
    triggerAssignees: commaSeparated(
      env.NITELY_GITHUB_WEBHOOK_ASSIGNEES?.trim() || "",
    ),
    triggerMentions: commaSeparated(
      env.NITELY_GITHUB_WEBHOOK_MENTIONS?.trim() || "",
    ),
    flowPath,
    ...(env.NITELY_GITHUB_WEBHOOK_REWORK_FLOW?.trim()
      ? { reworkFlowPath: env.NITELY_GITHUB_WEBHOOK_REWORK_FLOW.trim() }
      : {}),
    ...(maxAgeText
      ? {
          maxDeliveryAgeMs: parseEnvironmentPositiveInteger(
            maxAgeText,
            "GitHub webhook maximum delivery age",
          ),
        }
      : {}),
  };
  normalizeConfiguration(configuration);
  return configuration;
}
