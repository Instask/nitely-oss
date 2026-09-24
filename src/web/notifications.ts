import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { EventStore } from "../events/store.js";
import { eventStorePath } from "../run/project.js";
import { WebInputError, WebNotFoundError } from "./errors.js";

export type NotificationSeverity = "info" | "warning" | "blocker";
export type NotificationStatus = "pending" | "resolved";
export type NotificationAction =
  | "approve"
  | "deny"
  | "resolve"
  | "request-changes"
  | "override"
  | "cancel-run"
  | "assign";
export type NotificationType =
  | "review-spec"
  | "review-tech-design"
  | "review-pr"
  | "resolve-blocker"
  | "review-rework"
  | "review-memory";

export interface NotificationRecord {
  id: string;
  sourceKey: string;
  type: NotificationType;
  severity: NotificationSeverity;
  status: NotificationStatus;
  title: string;
  body?: string;
  link: string;
  taskId?: string;
  runId?: string;
  targetUserId?: string;
  assigneeUserId?: string;
  reviewerUserId?: string;
  teamId?: string;
  organizationId?: string;
  proposalId?: string;
  artifactId?: string;
  supportedActions: NotificationAction[];
  requiredReasonActions: NotificationAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  reason?: string;
}

export interface UpsertNotificationInput {
  sourceKey: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  link: string;
  taskId?: string;
  runId?: string;
  targetUserId?: string;
  assigneeUserId?: string;
  reviewerUserId?: string;
  teamId?: string;
  organizationId?: string;
  proposalId?: string;
  artifactId?: string;
  supportedActions?: NotificationAction[];
  requiredReasonActions?: NotificationAction[];
}

export interface AssignNotificationInput {
  actorId: string;
  targetUserId?: string;
  assigneeUserId?: string;
  reviewerUserId?: string;
  teamId?: string;
  organizationId?: string;
}

export interface ResolveNotificationInput {
  actorId: string;
  resolution: string;
  reason?: string;
}

export interface NotificationMutationOptions {
  now?: () => Date;
  createId?: () => string;
}

export interface NotificationActionInput {
  action: NotificationAction;
  reason?: string;
}

export interface NotificationDecisionInput extends NotificationActionInput {
  actorId: string;
  targetUserId?: string;
}

export interface NotificationDecisionRecord {
  schemaVersion: 1;
  id: string;
  notificationId: string;
  sourceKey: string;
  taskId?: string;
  runId?: string;
  proposalId?: string;
  artifactId?: string;
  actorId: string;
  action: NotificationAction;
  targetUserId?: string;
  reason?: string;
  createdAt: string;
}

interface TaskNotificationDecisionFile {
  version: 1;
  decisions: NotificationDecisionRecord[];
}

const notificationActions = new Set<NotificationAction>([
  "approve",
  "deny",
  "resolve",
  "request-changes",
  "override",
  "cancel-run",
  "assign",
]);

export function notificationActionFromValue(
  value: unknown,
): NotificationAction | undefined {
  return typeof value === "string" &&
    notificationActions.has(value as NotificationAction)
    ? (value as NotificationAction)
    : undefined;
}

function defaultNotificationActions(type: NotificationType): {
  supportedActions: NotificationAction[];
  requiredReasonActions: NotificationAction[];
} {
  switch (type) {
    case "review-spec":
    case "review-tech-design":
      return {
        supportedActions: ["approve", "deny", "request-changes", "assign"],
        requiredReasonActions: ["request-changes"],
      };
    case "review-pr":
      return {
        supportedActions: ["request-changes", "resolve", "assign"],
        requiredReasonActions: ["request-changes"],
      };
    case "resolve-blocker":
      return {
        supportedActions: ["resolve", "override", "cancel-run", "assign"],
        requiredReasonActions: ["override", "cancel-run"],
      };
    case "review-rework":
      return {
        supportedActions: [
          "approve",
          "deny",
          "request-changes",
          "override",
          "assign",
        ],
        requiredReasonActions: ["request-changes", "override"],
      };
    case "review-memory":
      return {
        supportedActions: ["approve", "deny", "request-changes", "assign"],
        requiredReasonActions: ["request-changes"],
      };
  }
}

function normalizedActionList(
  value: unknown,
  fallback: NotificationAction[],
): NotificationAction[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.filter(
    (action): action is NotificationAction =>
      notificationActionFromValue(action) !== undefined,
  );
  return [...new Set(normalized)];
}

export function assertNotificationActionAllowed(
  notification: Pick<
    NotificationRecord,
    "supportedActions" | "requiredReasonActions"
  >,
  input: NotificationActionInput,
): NotificationActionInput {
  if (!notification.supportedActions.includes(input.action)) {
    throw new WebInputError(`notification action ${input.action} is not supported`);
  }
  const reason = input.reason?.trim();
  if (notification.requiredReasonActions.includes(input.action) && !reason) {
    throw new WebInputError(
      `reason is required for notification action ${input.action}`,
    );
  }
  if (reason && reason.length > 4_000) {
    throw new WebInputError("notification action reason must be 4000 characters or less");
  }
  return {
    action: input.action,
    ...(reason ? { reason } : {}),
  };
}

function notificationsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "notifications");
}

function taskNotificationDecisionPath(repoPath: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) {
    throw new WebInputError("invalid task id");
  }
  return join(
    resolve(repoPath),
    ".nitely",
    "tasks",
    taskId,
    "evidence",
    "notification-decisions.json",
  );
}

function notificationPath(repoPath: string, id: string): string {
  validateNotificationId(id);
  return join(notificationsRoot(repoPath), `${id}.json`);
}

function validateNotificationId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/.test(id)) {
    throw new WebInputError("invalid notification id");
  }
}

function normalizeNotification(value: NotificationRecord): NotificationRecord {
  const targetUserId =
    value.targetUserId ?? value.assigneeUserId ?? value.reviewerUserId;
  const teamId = value.teamId ?? value.organizationId;
  const defaults = defaultNotificationActions(value.type);
  const supportedActions = normalizedActionList(
    value.supportedActions,
    defaults.supportedActions,
  );
  const requiredReasonActions = normalizedActionList(
    value.requiredReasonActions,
    defaults.requiredReasonActions,
  ).filter((action) => supportedActions.includes(action));
  return {
    ...value,
    ...(targetUserId ? { targetUserId } : {}),
    ...(value.assigneeUserId ?? targetUserId
      ? { assigneeUserId: value.assigneeUserId ?? targetUserId }
      : {}),
    ...(value.reviewerUserId ? { reviewerUserId: value.reviewerUserId } : {}),
    ...(teamId ? { teamId } : {}),
    supportedActions,
    requiredReasonActions,
    status: value.status === "resolved" ? "resolved" : "pending",
  };
}

function notificationSeverityRank(severity: NotificationSeverity): number {
  switch (severity) {
    case "blocker":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

function compareNotifications(
  left: NotificationRecord,
  right: NotificationRecord,
): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  const severity =
    notificationSeverityRank(left.severity) -
    notificationSeverityRank(right.severity);
  if (severity !== 0) return severity;
  const created = right.createdAt.localeCompare(left.createdAt);
  if (created !== 0) return created;
  const type = left.type.localeCompare(right.type);
  if (type !== 0) return type;
  return left.id.localeCompare(right.id);
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

export async function listNotifications(
  repoPath: string,
  filter: { status?: NotificationStatus } = {},
): Promise<NotificationRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(notificationsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const notifications = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const raw = JSON.parse(
            await readFile(join(notificationsRoot(repoPath), entry), "utf8"),
          ) as NotificationRecord;
          return normalizeNotification(raw);
        } catch {
          return undefined;
        }
      }),
  );
  return notifications
    .filter((n): n is NotificationRecord => n !== undefined)
    .filter((n) => (filter.status ? n.status === filter.status : true))
    .sort(compareNotifications);
}

export async function getNotification(
  repoPath: string,
  id: string,
): Promise<NotificationRecord> {
  try {
    return normalizeNotification(
      JSON.parse(await readFile(notificationPath(repoPath, id), "utf8")) as NotificationRecord,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("notification not found");
    }
    throw error;
  }
}

export async function upsertNotification(
  repoPath: string,
  input: UpsertNotificationInput,
  options: NotificationMutationOptions = {},
): Promise<NotificationRecord> {
  const sourceKey = input.sourceKey.trim();
  if (!sourceKey) {
    throw new WebInputError("notification sourceKey is required");
  }
  const existing = (await listNotifications(repoPath)).find(
    (candidate) => candidate.sourceKey === sourceKey,
  );
  const now = (options.now?.() ?? new Date()).toISOString();
  const notification: NotificationRecord = {
    ...(existing ?? {
      id: options.createId?.() ?? `notification-${randomUUID()}`,
      createdAt: now,
    }),
    sourceKey,
    type: input.type,
    severity: input.severity,
    status: "pending",
    title: input.title,
    link: input.link,
    supportedActions: [],
    requiredReasonActions: [],
    updatedAt: now,
  };
  const defaults = defaultNotificationActions(input.type);
  notification.supportedActions = normalizedActionList(
    input.supportedActions ?? existing?.supportedActions,
    defaults.supportedActions,
  );
  notification.requiredReasonActions = normalizedActionList(
    input.requiredReasonActions ?? existing?.requiredReasonActions,
    defaults.requiredReasonActions,
  ).filter((action) => notification.supportedActions.includes(action));
  if (input.body) notification.body = input.body;
  else delete notification.body;
  if (input.taskId) notification.taskId = input.taskId;
  else delete notification.taskId;
  if (input.runId) notification.runId = input.runId;
  else delete notification.runId;
  const targetUserId =
    input.targetUserId ?? input.assigneeUserId ?? input.reviewerUserId;
  if (targetUserId) notification.targetUserId = targetUserId;
  else delete notification.targetUserId;
  if (input.assigneeUserId ?? targetUserId) {
    notification.assigneeUserId = input.assigneeUserId ?? targetUserId;
  } else {
    delete notification.assigneeUserId;
  }
  if (input.reviewerUserId) notification.reviewerUserId = input.reviewerUserId;
  else delete notification.reviewerUserId;
  if (input.teamId ?? input.organizationId) {
    notification.teamId = input.teamId ?? input.organizationId;
  } else {
    delete notification.teamId;
  }
  if (input.organizationId) notification.organizationId = input.organizationId;
  else delete notification.organizationId;
  if (input.proposalId) notification.proposalId = input.proposalId;
  else delete notification.proposalId;
  if (input.artifactId) notification.artifactId = input.artifactId;
  else delete notification.artifactId;
  delete notification.resolvedAt;
  delete notification.resolvedBy;
  delete notification.resolution;
  delete notification.reason;
  await writeJsonAtomic(notificationPath(repoPath, notification.id), notification);
  return notification;
}

export async function assignNotification(
  repoPath: string,
  id: string,
  input: AssignNotificationInput,
  options: NotificationMutationOptions = {},
): Promise<NotificationRecord> {
  const notification = await getNotification(repoPath, id);
  const now = (options.now?.() ?? new Date()).toISOString();
  const targetUserId =
    input.targetUserId ?? input.assigneeUserId ?? input.reviewerUserId;
  const updated: NotificationRecord = {
    ...notification,
    updatedAt: now,
  };
  if (targetUserId) updated.targetUserId = targetUserId;
  else delete updated.targetUserId;
  if (input.assigneeUserId ?? targetUserId) {
    updated.assigneeUserId = input.assigneeUserId ?? targetUserId;
  } else {
    delete updated.assigneeUserId;
  }
  if (input.reviewerUserId) updated.reviewerUserId = input.reviewerUserId;
  else delete updated.reviewerUserId;
  if (input.teamId ?? input.organizationId) {
    updated.teamId = input.teamId ?? input.organizationId;
  }
  if (input.organizationId) updated.organizationId = input.organizationId;
  await writeJsonAtomic(notificationPath(repoPath, id), updated);
  return normalizeNotification(updated);
}

export async function resolveNotification(
  repoPath: string,
  id: string,
  input: ResolveNotificationInput,
  options: NotificationMutationOptions = {},
): Promise<NotificationRecord> {
  const notification = await getNotification(repoPath, id);
  const updated: NotificationRecord = {
    ...notification,
    status: "resolved",
    resolvedAt: (options.now?.() ?? new Date()).toISOString(),
    resolvedBy: input.actorId,
    resolution: input.resolution,
    updatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  if (input.reason) {
    updated.reason = input.reason;
  } else {
    delete updated.reason;
  }
  await writeJsonAtomic(notificationPath(repoPath, id), updated);
  return updated;
}

export async function resolveNotificationBySourceKey(
  repoPath: string,
  sourceKey: string,
  input: ResolveNotificationInput,
  options: NotificationMutationOptions = {},
): Promise<NotificationRecord | undefined> {
  const notification = (await listNotifications(repoPath)).find(
    (candidate) =>
      candidate.sourceKey === sourceKey && candidate.status === "pending",
  );
  if (!notification) {
    return undefined;
  }
  return resolveNotification(repoPath, notification.id, input, options);
}

export async function listTaskNotificationDecisions(
  repoPath: string,
  taskId: string,
): Promise<NotificationDecisionRecord[]> {
  try {
    const parsed = JSON.parse(
      await readFile(taskNotificationDecisionPath(repoPath, taskId), "utf8"),
    ) as TaskNotificationDecisionFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
      throw new Error("invalid task notification decision evidence");
    }
    return parsed.decisions.map((decision) => ({ ...decision }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function recordNotificationDecision(
  repoPath: string,
  notification: NotificationRecord,
  input: NotificationDecisionInput,
  options: NotificationMutationOptions = {},
): Promise<NotificationDecisionRecord> {
  const action = assertNotificationActionAllowed(notification, input);
  const actorId = input.actorId.trim();
  if (!actorId) {
    throw new WebInputError("notification action actor is required");
  }
  if (actorId.length > 500 || /[\r\n]/.test(actorId)) {
    throw new WebInputError(
      "notification action actor must be a single line of 500 characters or less",
    );
  }
  const targetUserId = input.targetUserId?.trim();
  if (action.action === "assign" && !targetUserId) {
    throw new WebInputError("notification assignment target is required");
  }
  if (targetUserId && (targetUserId.length > 500 || /[\r\n]/.test(targetUserId))) {
    throw new WebInputError(
      "notification assignment target must be a single line of 500 characters or less",
    );
  }
  const decision: NotificationDecisionRecord = {
    schemaVersion: 1,
    id: options.createId?.() ?? `notification-decision-${randomUUID()}`,
    notificationId: notification.id,
    sourceKey: notification.sourceKey,
    ...(notification.taskId ? { taskId: notification.taskId } : {}),
    ...(notification.runId ? { runId: notification.runId } : {}),
    ...(notification.proposalId ? { proposalId: notification.proposalId } : {}),
    ...(notification.artifactId ? { artifactId: notification.artifactId } : {}),
    actorId,
    action: action.action,
    ...(targetUserId ? { targetUserId } : {}),
    ...(action.reason ? { reason: action.reason } : {}),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };

  if (notification.taskId) {
    const decisions = await listTaskNotificationDecisions(
      repoPath,
      notification.taskId,
    );
    await writeJsonAtomic(
      taskNotificationDecisionPath(repoPath, notification.taskId),
      {
        version: 1,
        decisions: [...decisions, decision],
      } satisfies TaskNotificationDecisionFile,
    );
  }

  if (notification.runId) {
    const store = new EventStore(eventStorePath(repoPath));
    try {
      if (store.list(notification.runId).length > 0) {
        store.append({
          runId: notification.runId,
          type: "notification.decision",
          payload: {
            decisionId: decision.id,
            notificationId: decision.notificationId,
            sourceKey: decision.sourceKey,
            ...(decision.taskId ? { taskId: decision.taskId } : {}),
            ...(decision.proposalId ? { proposalId: decision.proposalId } : {}),
            ...(decision.artifactId ? { artifactId: decision.artifactId } : {}),
            actorId: decision.actorId,
            action: decision.action,
            ...(decision.targetUserId
              ? { targetUserId: decision.targetUserId }
              : {}),
            ...(decision.reason ? { reason: decision.reason } : {}),
          },
          createdAt: decision.createdAt,
        });
      }
    } finally {
      store.close();
    }
  }
  return decision;
}
