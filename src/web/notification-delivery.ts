import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";

import type { ScmProvider } from "../scm/types.js";
import { parseGitHubIssueReference } from "../spec-artifacts/draft.js";
import {
  parseJiraTicketReference,
  type JiraStatusPublisher,
} from "../ticket-sources/jira.js";
import type { NotificationRecord } from "./notifications.js";

const notificationDeliveryChannels = [
  "github",
  "jira",
  "email",
  "slack",
  "webhook",
] as const;

export type NotificationDeliveryChannel =
  (typeof notificationDeliveryChannels)[number];

export interface NotificationDeliveryReceipt {
  sourceKey: string;
  channel: NotificationDeliveryChannel;
  dedupeKey: string;
  status: "pending" | "failed" | "delivered";
  attempts: number;
  lastAttemptAt: string;
  nextRetryAt?: string;
  deliveredAt?: string;
  externalId?: string;
  lastError?: string;
}

export interface NotificationDeliveryTarget {
  channel: NotificationDeliveryChannel;
  deliver(
    notification: NotificationRecord,
  ): Promise<{ externalId?: string } | void>;
}

export interface NotificationDeliveryOptions {
  now?: () => Date;
  beforeAttempt?: (input: {
    sourceKey: string;
    channel: NotificationDeliveryChannel;
  }) => Promise<void> | void;
}

type StoredNotificationDeliveryReceipt = Omit<
  NotificationDeliveryReceipt,
  "status"
> & {
  status: NotificationDeliveryReceipt["status"] | "abandoned";
};

interface NotificationDeliveryReceiptFile {
  version: 1;
  sourceKey: string;
  ownerId: string;
  receipt: StoredNotificationDeliveryReceipt;
}

function sourceKeyDigest(sourceKey: string): string {
  return createHash("sha256").update(sourceKey).digest("hex");
}

function receiptDirectory(repoPath: string, sourceKey: string): string {
  return join(
    resolve(repoPath),
    ".nitely",
    "notifications",
    "deliveries",
    sourceKeyDigest(sourceKey),
  );
}

function channelReceiptDirectory(
  repoPath: string,
  sourceKey: string,
  channel: NotificationDeliveryChannel,
): string {
  return join(receiptDirectory(repoPath, sourceKey), channel);
}

function receiptAttemptPath(
  repoPath: string,
  sourceKey: string,
  channel: NotificationDeliveryChannel,
  ownerId: string,
): string {
  return join(
    channelReceiptDirectory(repoPath, sourceKey, channel),
    `${ownerId}.json`,
  );
}

const deliveryLockStaleMs = 2 * 60_000;

interface DeliveryLock {
  path: string;
  ownerPath: string;
  ownerId: string;
  ownerHandle: FileHandle;
  heartbeat: ReturnType<typeof setInterval>;
}

async function createDeliveryLock(path: string): Promise<DeliveryLock> {
  await mkdir(path);
  const ownerPath = join(path, "owner");
  const ownerId = randomUUID();
  let ownerHandle: FileHandle | undefined;
  try {
    ownerHandle = await open(ownerPath, "wx", 0o600);
    await ownerHandle.writeFile(ownerId, "utf8");
    await ownerHandle.sync();
    const heartbeat = setInterval(() => {
      const now = new Date();
      void ownerHandle?.utimes(now, now).catch(() => {});
    }, Math.floor(deliveryLockStaleMs / 4));
    heartbeat.unref();
    return { path, ownerPath, ownerId, ownerHandle, heartbeat };
  } catch (error) {
    await ownerHandle?.close().catch(() => {});
    await rm(path, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

async function releaseDeliveryLock(lock: DeliveryLock): Promise<void> {
  clearInterval(lock.heartbeat);
  await lock.ownerHandle.close().catch(() => {});
  try {
    if ((await readFile(lock.ownerPath, "utf8")) === lock.ownerId) {
      await rm(lock.path, { force: true, recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function deliveryLockIsCurrent(lock: DeliveryLock): Promise<boolean> {
  try {
    return (await readFile(lock.ownerPath, "utf8")) === lock.ownerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireDeliveryLock(
  repoPath: string,
  sourceKey: string,
  channel: NotificationDeliveryChannel,
): Promise<DeliveryLock | undefined> {
  const path = join(receiptDirectory(repoPath, sourceKey), `${channel}.lock`);
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createDeliveryLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        let lock;
        try {
          lock = await stat(join(path, "owner"));
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw ownerError;
          }
          lock = await stat(path);
        }
        if (Date.now() - lock.mtimeMs <= deliveryLockStaleMs) {
          return undefined;
        }
        const stalePath = `${path}.stale-${randomUUID()}`;
        await rename(path, stalePath);
        await rm(stalePath, { force: true, recursive: true });
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lockError;
        }
      }
    }
  }
  return undefined;
}

export function notificationDeliveryDedupeKey(
  sourceKey: string,
  channel: NotificationDeliveryChannel,
): string {
  return createHash("sha256")
    .update(sourceKey)
    .update("\0")
    .update(channel)
    .digest("hex");
}

function publicHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`notification ${label} URL must use public HTTPS`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !publicHostname(url.hostname)
  ) {
    throw new Error(`notification ${label} URL must use public HTTPS`);
  }
  return url;
}

function publicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (ipVersion === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.")
    );
  }
  return normalized.length > 0;
}

function externalNotificationLink(
  link: string,
  publicBaseUrl: string | undefined,
): string {
  if (/^https?:\/\//i.test(link)) return link;
  if (!publicBaseUrl) return link;
  const base = publicHttpsUrl(publicBaseUrl, "public base");
  return new URL(link, `${base.toString().replace(/\/+$/, "")}/`).toString();
}

function externalNotification(
  notification: NotificationRecord,
  publicBaseUrl: string | undefined,
): Record<string, unknown> {
  return {
    id: notification.id,
    sourceKey: notification.sourceKey,
    type: notification.type,
    severity: notification.severity,
    status: notification.status,
    title: notification.title,
    ...(notification.body ? { body: notification.body } : {}),
    link: externalNotificationLink(notification.link, publicBaseUrl),
    ...(notification.taskId ? { taskId: notification.taskId } : {}),
    ...(notification.runId ? { runId: notification.runId } : {}),
    supportedActions: [...notification.supportedActions],
    requiredReasonActions: [...notification.requiredReasonActions],
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
}

async function postNotificationJson(input: {
  url: URL;
  body: string;
  fetch: typeof fetch;
  headers?: Record<string, string>;
}): Promise<{ externalId?: string }> {
  const response = await input.fetch(input.url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(input.headers ?? {}),
    },
    body: input.body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error("notification delivery endpoint rejected the request");
  }
  const externalId =
    response.headers.get("x-request-id") ?? response.headers.get("location");
  return externalId ? { externalId } : {};
}

export function configuredHttpNotificationTargets(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): NotificationDeliveryTarget[] {
  const targets: NotificationDeliveryTarget[] = [];
  const publicBaseUrl = env.NITELY_PUBLIC_BASE_URL?.trim() || undefined;
  const slackUrl = env.NITELY_NOTIFICATION_SLACK_WEBHOOK_URL?.trim();
  if (slackUrl) {
    const url = publicHttpsUrl(slackUrl, "slack");
    targets.push({
      channel: "slack",
      deliver: async (notification) => {
        const visible = externalNotification(notification, publicBaseUrl);
        return postNotificationJson({
          url,
          fetch: fetchImpl,
          headers: {
            "x-nitely-dedupe-key": notificationDeliveryDedupeKey(
              notification.sourceKey,
              "slack",
            ),
          },
          body: JSON.stringify({
            text: `${notification.title} — ${String(visible.link)}`,
            notification: visible,
          }),
        });
      },
    });
  }

  const emailUrl = env.NITELY_NOTIFICATION_EMAIL_RELAY_URL?.trim();
  if (emailUrl) {
    const url = publicHttpsUrl(emailUrl, "email relay");
    const to = (env.NITELY_NOTIFICATION_EMAIL_TO ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (to.length === 0) {
      throw new Error("notification email relay requires at least one recipient");
    }
    const token = env.NITELY_NOTIFICATION_EMAIL_RELAY_TOKEN?.trim();
    targets.push({
      channel: "email",
      deliver: async (notification) => {
        const visible = externalNotification(notification, publicBaseUrl);
        return postNotificationJson({
          url,
          fetch: fetchImpl,
          headers: {
            "x-nitely-dedupe-key": notificationDeliveryDedupeKey(
              notification.sourceKey,
              "email",
            ),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            to,
            subject: `[Nitely] ${notification.title}`,
            text: [notification.title, notification.body, String(visible.link)]
              .filter(Boolean)
              .join("\n\n"),
            notification: visible,
          }),
        });
      },
    });
  }

  const webhookUrl = env.NITELY_NOTIFICATION_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    const url = publicHttpsUrl(webhookUrl, "webhook");
    const secret = env.NITELY_NOTIFICATION_WEBHOOK_SECRET?.trim();
    targets.push({
      channel: "webhook",
      deliver: async (notification) => {
        const dedupeKey = notificationDeliveryDedupeKey(
          notification.sourceKey,
          "webhook",
        );
        const body = JSON.stringify({
          schemaVersion: 1,
          event: "notification.pending",
          dedupeKey,
          notification: externalNotification(notification, publicBaseUrl),
        });
        return postNotificationJson({
          url,
          fetch: fetchImpl,
          headers: {
            "x-nitely-dedupe-key": dedupeKey,
            ...(secret
              ? {
                  "x-nitely-signature": `sha256=${createHmac("sha256", secret)
                    .update(body)
                    .digest("hex")}`,
                }
              : {}),
          },
          body,
        });
      },
    });
  }
  return targets;
}

function notificationMarker(
  sourceKey: string,
  channel: "github" | "jira",
): string {
  return `nitely-notification:${notificationDeliveryDedupeKey(sourceKey, channel)}`;
}

function renderGitHubNotificationComment(input: {
  notification: NotificationRecord;
  publicBaseUrl?: string;
  marker: string;
}): string {
  const link = externalNotificationLink(
    input.notification.link,
    input.publicBaseUrl,
  );
  return [
    `<!-- ${input.marker} -->`,
    "### Nitely action required",
    "",
    `**${input.notification.title}**`,
    input.notification.body,
    "",
    `- Review in Nitely: ${link}`,
    input.notification.runId
      ? `- Run: \`${input.notification.runId}\``
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function parseGitHubCommentReference(value: string): {
  owner: string;
  repo: string;
  number: number;
  url: string;
} {
  try {
    return parseGitHubIssueReference(value);
  } catch (issueError) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      value.trim(),
    );
    if (!match) throw issueError;
    const owner = match[1]!;
    const repo = match[2]!;
    const number = Number(match[3]!);
    return {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    };
  }
}

export function createGitHubIssueNotificationTarget(input: {
  repoPath: string;
  issueUrl: string;
  publicBaseUrl?: string;
  provider: ScmProvider;
}): NotificationDeliveryTarget {
  const reference = parseGitHubCommentReference(input.issueUrl);
  if (
    !input.provider.listRepositoryIssueComments ||
    !input.provider.createRepositoryIssueComment ||
    !input.provider.updateRepositoryIssueComment
  ) {
    throw new Error("GitHub notification delivery requires issue comment support");
  }
  const repository = {
    provider: "github" as const,
    owner: reference.owner,
    repository: reference.repo,
    url: `https://github.com/${reference.owner}/${reference.repo}`,
  };
  return {
    channel: "github",
    deliver: async (notification) => {
      const marker = notificationMarker(notification.sourceKey, "github");
      const body = renderGitHubNotificationComment({
        notification,
        publicBaseUrl: input.publicBaseUrl,
        marker,
      });
      const comments = await input.provider.listRepositoryIssueComments!({
        repoPath: input.repoPath,
        remoteName: "origin",
        repository,
        issueNumber: reference.number,
      });
      const existing = comments.find((comment) => comment.body.includes(marker));
      if (existing) {
        if (existing.body !== body) {
          const updated = await input.provider.updateRepositoryIssueComment!({
            repoPath: input.repoPath,
            remoteName: "origin",
            repository,
            commentId: existing.id,
            body,
          });
          return { externalId: updated.id };
        }
        return { externalId: existing.id };
      }
      const created = await input.provider.createRepositoryIssueComment!({
        repoPath: input.repoPath,
        remoteName: "origin",
        repository,
        issueNumber: reference.number,
        body,
      });
      return { externalId: created.id };
    },
  };
}

export function createJiraNotificationTarget(input: {
  issueUrl: string;
  jiraBaseUrl?: string;
  publicBaseUrl?: string;
  publisher: JiraStatusPublisher;
}): NotificationDeliveryTarget {
  const reference = parseJiraTicketReference(input.issueUrl, input.jiraBaseUrl);
  return {
    channel: "jira",
    deliver: async (notification) => {
      const marker = notificationMarker(notification.sourceKey, "jira");
      const result = await input.publisher(reference, {
        summary: `[${marker}] ${notification.title}`,
        links: [
          {
            label: "Review in Nitely",
            url: externalNotificationLink(
              notification.link,
              input.publicBaseUrl,
            ),
          },
        ],
      });
      return result.id
        ? { externalId: result.id }
        : result.url
          ? { externalId: result.url }
          : {};
    },
  };
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

async function readDeliveryAttempts(
  repoPath: string,
  sourceKey: string,
  channel: NotificationDeliveryChannel,
): Promise<StoredNotificationDeliveryReceipt[]> {
  let names: string[];
  try {
    names = await readdir(channelReceiptDirectory(repoPath, sourceKey, channel));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const parsed = JSON.parse(
          await readFile(
            join(channelReceiptDirectory(repoPath, sourceKey, channel), name),
            "utf8",
          ),
        ) as NotificationDeliveryReceiptFile;
        if (
          parsed.version !== 1 ||
          parsed.sourceKey !== sourceKey ||
          !parsed.ownerId ||
          parsed.receipt?.sourceKey !== sourceKey ||
          parsed.receipt.channel !== channel
        ) {
          throw new Error("invalid notification delivery receipt file");
        }
        return { ...parsed.receipt };
      }),
  );
}

function effectiveDeliveryReceipt(
  attempts: StoredNotificationDeliveryReceipt[],
): NotificationDeliveryReceipt | undefined {
  const statusRank: Record<NotificationDeliveryReceipt["status"], number> = {
    failed: 1,
    pending: 2,
    delivered: 3,
  };
  const effective = attempts
    .filter(
      (attempt): attempt is NotificationDeliveryReceipt =>
        attempt.status !== "abandoned",
    )
    .sort(
      (left, right) =>
        statusRank[left.status] - statusRank[right.status] ||
        left.attempts - right.attempts ||
        left.lastAttemptAt.localeCompare(right.lastAttemptAt),
    )
    .at(-1);
  return effective ? { ...effective } : undefined;
}

async function readDeliveryReceipt(
  repoPath: string,
  sourceKey: string,
  channel: NotificationDeliveryChannel,
): Promise<NotificationDeliveryReceipt | undefined> {
  return effectiveDeliveryReceipt(
    await readDeliveryAttempts(repoPath, sourceKey, channel),
  );
}

async function writeDeliveryAttempt(
  repoPath: string,
  ownerId: string,
  receipt: StoredNotificationDeliveryReceipt,
): Promise<void> {
  await writeJsonAtomic(
    receiptAttemptPath(
      repoPath,
      receipt.sourceKey,
      receipt.channel,
      ownerId,
    ),
    {
      version: 1,
      sourceKey: receipt.sourceKey,
      ownerId,
      receipt,
    } satisfies NotificationDeliveryReceiptFile,
  );
}

function nextRetryAt(now: Date, attempts: number): string {
  const delayMs = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs).toISOString();
}

export async function listNotificationDeliveryReceipts(
  repoPath: string,
  sourceKey: string,
): Promise<NotificationDeliveryReceipt[]> {
  const receipts = await Promise.all(
    notificationDeliveryChannels.map((channel) =>
      readDeliveryReceipt(repoPath, sourceKey, channel),
    ),
  );
  return receipts.filter(
    (receipt): receipt is NotificationDeliveryReceipt => receipt !== undefined,
  );
}

function receiptPreventsDelivery(
  receipt: NotificationDeliveryReceipt | undefined,
  now: Date,
): boolean {
  if (receipt?.status === "delivered" || receipt?.status === "pending") {
    return true;
  }
  const retryAt = receipt?.nextRetryAt
    ? Date.parse(receipt.nextRetryAt)
    : Number.NaN;
  return (
    receipt?.status === "failed" &&
    Number.isFinite(retryAt) &&
    now.getTime() < retryAt
  );
}

export async function dispatchNotificationDeliveries(
  repoPath: string,
  notification: NotificationRecord,
  targets: NotificationDeliveryTarget[],
  options: NotificationDeliveryOptions = {},
): Promise<NotificationDeliveryReceipt[]> {
  for (const target of targets) {
    const beforeLock = options.now?.() ?? new Date();
    if (
      receiptPreventsDelivery(
        await readDeliveryReceipt(
          repoPath,
          notification.sourceKey,
          target.channel,
        ),
        beforeLock,
      )
    ) {
      continue;
    }
    const lock = await acquireDeliveryLock(
      repoPath,
      notification.sourceKey,
      target.channel,
    );
    if (!lock) continue;
    try {
      const now = options.now?.() ?? new Date();
      const existing = await readDeliveryReceipt(
        repoPath,
        notification.sourceKey,
        target.channel,
      );
      if (receiptPreventsDelivery(existing, now)) continue;
      const attempts = (existing?.attempts ?? 0) + 1;
      const dedupeKey =
        existing?.dedupeKey ??
        notificationDeliveryDedupeKey(notification.sourceKey, target.channel);
      if (!(await deliveryLockIsCurrent(lock))) continue;
      await options.beforeAttempt?.({
        sourceKey: notification.sourceKey,
        channel: target.channel,
      });
      const pending: NotificationDeliveryReceipt = {
        sourceKey: notification.sourceKey,
        channel: target.channel,
        dedupeKey,
        status: "pending",
        attempts,
        lastAttemptAt: now.toISOString(),
      };
      await writeDeliveryAttempt(repoPath, lock.ownerId, pending);
      if (!(await deliveryLockIsCurrent(lock))) {
        await writeDeliveryAttempt(repoPath, lock.ownerId, {
          ...pending,
          status: "abandoned",
        });
        continue;
      }

      let receipt: NotificationDeliveryReceipt;
      try {
        const result = await target.deliver(notification);
        receipt = {
          sourceKey: notification.sourceKey,
          channel: target.channel,
          dedupeKey,
          status: "delivered",
          attempts,
          lastAttemptAt: now.toISOString(),
          deliveredAt: now.toISOString(),
          ...(result?.externalId ? { externalId: result.externalId } : {}),
        };
      } catch {
        receipt = {
          sourceKey: notification.sourceKey,
          channel: target.channel,
          dedupeKey,
          status: "failed",
          attempts,
          lastAttemptAt: now.toISOString(),
          nextRetryAt: nextRetryAt(now, attempts),
          lastError: `${target.channel} notification delivery failed`,
        };
      }
      await writeDeliveryAttempt(repoPath, lock.ownerId, receipt);
    } finally {
      await releaseDeliveryLock(lock);
    }
  }
  return listNotificationDeliveryReceipts(repoPath, notification.sourceKey);
}
