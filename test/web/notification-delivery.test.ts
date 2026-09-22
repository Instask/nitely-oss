import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configuredHttpNotificationTargets,
  createGitHubIssueNotificationTarget,
  createJiraNotificationTarget,
  dispatchNotificationDeliveries,
  listNotificationDeliveryReceipts,
} from "../../src/web/notification-delivery.js";
import { upsertNotification } from "../../src/web/notifications.js";
import type {
  RepositoryIssueComment,
  ScmProvider,
} from "../../src/scm/types.js";

describe("notification delivery", () => {
  it("reuses a stable marker when mirroring a notification to a GitHub issue", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-github-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t1:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      taskId: "t1",
      link: "/tasks/t1",
    });
    const comments: RepositoryIssueComment[] = [];
    let createCount = 0;
    let updateCount = 0;
    const provider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("not used by notification delivery");
      },
      listRepositoryIssueComments: async () => [...comments],
      createRepositoryIssueComment: async (input) => {
        createCount += 1;
        const comment: RepositoryIssueComment = {
          provider: "github",
          id: "comment-1",
          url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
          body: input.body,
          authorLogin: "nitely-bot",
          createdAt: "2026-07-14T04:00:00.000Z",
        };
        comments.push(comment);
        return comment;
      },
      updateRepositoryIssueComment: async (input) => {
        updateCount += 1;
        comments[0] = { ...comments[0]!, body: input.body };
        return comments[0]!;
      },
    };
    const target = createGitHubIssueNotificationTarget({
      repoPath,
      issueUrl: "https://github.com/acme/widgets/issues/7",
      publicBaseUrl: "https://nitely.example.test",
      provider,
    });

    await target.deliver(notification);
    await target.deliver(notification);

    expect(createCount).toBe(1);
    expect(updateCount).toBe(0);
    expect(comments[0]?.body).toContain("nitely-notification:");
    expect(comments[0]?.body).toContain(
      "https://nitely.example.test/tasks/t1",
    );
  });

  it("mirrors review notifications to a GitHub pull request discussion", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-github-pr-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t-pr:draft-pr:run-1",
      type: "review-pr",
      severity: "info",
      title: "Review pull request",
      taskId: "t-pr",
      runId: "run-1",
      link: "https://github.com/acme/widgets/pull/42",
    });
    const listed: Array<{ owner: string; repository: string; issueNumber: number }> = [];
    const created: Array<{ owner: string; repository: string; issueNumber: number }> = [];
    const provider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("not used by notification delivery");
      },
      listRepositoryIssueComments: async (input) => {
        listed.push({
          owner: input.repository.owner,
          repository: input.repository.repository,
          issueNumber: input.issueNumber,
        });
        return [];
      },
      createRepositoryIssueComment: async (input) => {
        created.push({
          owner: input.repository.owner,
          repository: input.repository.repository,
          issueNumber: input.issueNumber,
        });
        return {
          provider: "github",
          id: "pr-comment-1",
          url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
          body: input.body,
          authorLogin: "nitely-bot",
          createdAt: "2026-07-14T04:00:00.000Z",
        };
      },
      updateRepositoryIssueComment: async () => {
        throw new Error("not used by notification delivery");
      },
    };
    const target = createGitHubIssueNotificationTarget({
      repoPath,
      issueUrl: "https://github.com/acme/widgets/pull/42",
      publicBaseUrl: "https://nitely.example.test",
      provider,
    });

    await expect(target.deliver(notification)).resolves.toEqual({
      externalId: "pr-comment-1",
    });
    expect(listed).toEqual([
      { owner: "acme", repository: "widgets", issueNumber: 42 },
    ]);
    expect(created).toEqual(listed);
  });

  it("publishes a Jira notification with the same stable delivery key", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-jira-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t2:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review Jira draft",
      taskId: "t2",
      link: "/tasks/t2",
    });
    const updates: Array<{ summary: string; links: Array<{ label: string; url: string }> }> = [];
    const target = createJiraNotificationTarget({
      issueUrl: "https://acme.atlassian.net/browse/ENG-42",
      publicBaseUrl: "https://nitely.example.test",
      publisher: async (_reference, update) => {
        updates.push(update);
        return { id: "10001", url: "https://acme.atlassian.net/browse/ENG-42#comment-10001" };
      },
    });

    await expect(target.deliver(notification)).resolves.toEqual({
      externalId: "10001",
    });
    expect(updates).toEqual([
      {
        summary: expect.stringMatching(
          /^\[nitely-notification:[a-f0-9]{64}\] Review Jira draft$/,
        ),
        links: [
          {
            label: "Review in Nitely",
            url: "https://nitely.example.test/tasks/t2",
          },
        ],
      },
    ]);
  });

  it("sends configured Slack, email relay, and signed webhook payloads over HTTPS", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-http-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t1:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      body: "Planning is ready for review.",
      taskId: "t1",
      link: "/tasks/t1",
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response("ok", {
        status: 200,
        headers: { "x-request-id": `request-${requests.length}` },
      });
    };
    const targets = configuredHttpNotificationTargets(
      {
        NITELY_PUBLIC_BASE_URL: "https://nitely.example.test",
        NITELY_NOTIFICATION_SLACK_WEBHOOK_URL:
          "https://hooks.slack.example.test/services/T/B/secret",
        NITELY_NOTIFICATION_EMAIL_RELAY_URL:
          "https://mail.example.test/v1/send",
        NITELY_NOTIFICATION_EMAIL_RELAY_TOKEN: "mail-token",
        NITELY_NOTIFICATION_EMAIL_TO: "alice@example.test,bob@example.test",
        NITELY_NOTIFICATION_WEBHOOK_URL:
          "https://customer.example.test/nitely/events",
        NITELY_NOTIFICATION_WEBHOOK_SECRET: "signing-secret",
      },
      fetchImpl,
    );

    expect(targets.map((target) => target.channel)).toEqual([
      "slack",
      "email",
      "webhook",
    ]);
    await dispatchNotificationDeliveries(repoPath, notification, targets, {
      now: () => new Date("2026-07-14T04:00:00.000Z"),
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://hooks.slack.example.test/services/T/B/secret",
      "https://mail.example.test/v1/send",
      "https://customer.example.test/nitely/events",
    ]);
    for (const request of requests) {
      expect(request.init).toMatchObject({ method: "POST", redirect: "error" });
      expect(new Headers(request.init.headers).get("x-nitely-dedupe-key"))
        .toMatch(/^[a-f0-9]{64}$/);
    }
    const emailHeaders = new Headers(requests[1]!.init.headers);
    expect(emailHeaders.get("authorization")).toBe("Bearer mail-token");
    expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
      to: ["alice@example.test", "bob@example.test"],
      notification: {
        sourceKey: "task:t1:draft-spec",
        link: "https://nitely.example.test/tasks/t1",
      },
    });
    const webhookBody = String(requests[2]!.init.body);
    const webhookHeaders = new Headers(requests[2]!.init.headers);
    expect(webhookHeaders.get("x-nitely-signature")).toBe(
      `sha256=${createHmac("sha256", "signing-secret").update(webhookBody).digest("hex")}`,
    );
    expect(webhookHeaders.get("x-nitely-dedupe-key")).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(webhookBody)).toMatchObject({
      schemaVersion: 1,
      event: "notification.pending",
      notification: {
        title: "Review draft spec",
        link: "https://nitely.example.test/tasks/t1",
      },
    });
  });

  it("rejects insecure or loopback HTTP delivery endpoints before dispatch", () => {
    expect(() =>
      configuredHttpNotificationTargets({
        NITELY_NOTIFICATION_WEBHOOK_URL: "http://127.0.0.1:8080/callback",
      }),
    ).toThrow("notification webhook URL must use public HTTPS");
    expect(() =>
      configuredHttpNotificationTargets({
        NITELY_NOTIFICATION_SLACK_WEBHOOK_URL: "https://localhost/hooks/secret",
      }),
    ).toThrow("notification slack URL must use public HTTPS");
  });

  it("retries a failed channel once and deduplicates after durable success", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-delivery-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t1:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      taskId: "t1",
      link: "/tasks/t1",
    });
    let attempts = 0;
    const target = {
      channel: "webhook" as const,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("request failed with token=should-not-be-persisted");
        }
        return { externalId: "delivery-42" };
      },
    };

    const failed = await dispatchNotificationDeliveries(
      repoPath,
      notification,
      [target],
      { now: () => new Date("2026-07-14T03:00:00.000Z") },
    );
    expect(failed).toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "failed",
        attempts: 1,
        lastError: "webhook notification delivery failed",
        lastAttemptAt: "2026-07-14T03:00:00.000Z",
        nextRetryAt: "2026-07-14T03:01:00.000Z",
      }),
    ]);

    const beforeRetryWindow = await dispatchNotificationDeliveries(
      repoPath,
      notification,
      [target],
      { now: () => new Date("2026-07-14T03:00:30.000Z") },
    );
    expect(beforeRetryWindow).toEqual(failed);
    expect(attempts).toBe(1);

    const delivered = await dispatchNotificationDeliveries(
      repoPath,
      notification,
      [target],
      { now: () => new Date("2026-07-14T03:02:00.000Z") },
    );
    expect(delivered).toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 2,
        externalId: "delivery-42",
        deliveredAt: "2026-07-14T03:02:00.000Z",
      }),
    ]);

    await dispatchNotificationDeliveries(repoPath, notification, [target], {
      now: () => new Date("2026-07-14T03:03:00.000Z"),
    });
    expect(attempts).toBe(2);
    await expect(
      listNotificationDeliveryReceipts(repoPath, notification.sourceKey),
    ).resolves.toEqual(delivered);
  });

  it("serializes concurrent dispatches for the same notification source", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-concurrent-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t-concurrent:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review concurrent draft",
      taskId: "t-concurrent",
      link: "/tasks/t-concurrent",
    });
    let attempts = 0;
    let releaseDelivery: (() => void) | undefined;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const target = {
      channel: "webhook" as const,
      deliver: async () => {
        attempts += 1;
        markStarted?.();
        await deliveryReleased;
        return { externalId: "concurrent-delivery-1" };
      },
    };

    const first = dispatchNotificationDeliveries(repoPath, notification, [target]);
    await deliveryStarted;
    const second = dispatchNotificationDeliveries(repoPath, notification, [target]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseDelivery?.();
    await Promise.all([first, second]);

    expect(attempts).toBe(1);
    await expect(
      listNotificationDeliveryReceipts(repoPath, notification.sourceKey),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 1,
        externalId: "concurrent-delivery-1",
      }),
    ]);
  });

  it("continues independent channels while one channel remains in flight", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-fanout-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t-independent-fanout:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review independent fan-out draft",
      taskId: "t-independent-fanout",
      link: "/tasks/t-independent-fanout",
    });
    let slackAttempts = 0;
    let webhookAttempts = 0;
    let releaseDelivery: (() => void) | undefined;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slackTarget = {
      channel: "slack" as const,
      deliver: async () => {
        slackAttempts += 1;
        markStarted?.();
        await deliveryReleased;
        return { externalId: "fanout-slack-1" };
      },
    };
    const webhookTarget = {
      channel: "webhook" as const,
      deliver: async () => {
        webhookAttempts += 1;
        return { externalId: "fanout-webhook-1" };
      },
    };

    const targets = [slackTarget, webhookTarget];
    const first = dispatchNotificationDeliveries(repoPath, notification, targets);
    await deliveryStarted;

    const second = dispatchNotificationDeliveries(repoPath, notification, targets);
    await second;
    expect(slackAttempts).toBe(1);
    expect(webhookAttempts).toBe(1);
    releaseDelivery?.();
    await first;

    expect(slackAttempts).toBe(1);
    expect(webhookAttempts).toBe(1);
    await expect(
      listNotificationDeliveryReceipts(repoPath, notification.sourceKey),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "slack",
        status: "delivered",
        attempts: 1,
        externalId: "fanout-slack-1",
      }),
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 1,
        externalId: "fanout-webhook-1",
      }),
    ]);
  });

  it("abandons a stale owner generation without overwriting the takeover result", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-notification-fence-"));
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t-fenced-attempt:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review fenced delivery attempt",
      taskId: "t-fenced-attempt",
      link: "/tasks/t-fenced-attempt",
    });
    let deliveryAttempts = 0;
    const target = {
      channel: "webhook" as const,
      deliver: async () => {
        deliveryAttempts += 1;
        return { externalId: "fenced-webhook-1" };
      },
    };
    let releaseOldOwner: (() => void) | undefined;
    const oldOwnerReleased = new Promise<void>((resolve) => {
      releaseOldOwner = resolve;
    });
    let markOldOwnerReady: (() => void) | undefined;
    const oldOwnerReady = new Promise<void>((resolve) => {
      markOldOwnerReady = resolve;
    });

    const first = dispatchNotificationDeliveries(
      repoPath,
      notification,
      [target],
      {
        beforeAttempt: async () => {
          markOldOwnerReady?.();
          await oldOwnerReleased;
        },
      },
    );
    await oldOwnerReady;
    const deliveriesRoot = join(
      repoPath,
      ".nitely",
      "notifications",
      "deliveries",
    );
    const [sourceDirectory] = await readdir(deliveriesRoot);
    expect(sourceDirectory).toBeDefined();
    const ownerPath = join(
      deliveriesRoot,
      sourceDirectory!,
      "webhook.lock",
      "owner",
    );
    const staleAt = new Date(Date.now() - 3 * 60_000);
    await utimes(ownerPath, staleAt, staleAt);

    await dispatchNotificationDeliveries(repoPath, notification, [target]);
    expect(deliveryAttempts).toBe(1);
    releaseOldOwner?.();
    await first;

    expect(deliveryAttempts).toBe(1);
    await expect(
      listNotificationDeliveryReceipts(repoPath, notification.sourceKey),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 1,
        externalId: "fenced-webhook-1",
      }),
    ]);
    const attemptDirectory = join(
      deliveriesRoot,
      sourceDirectory!,
      "webhook",
    );
    const attemptStatuses = await Promise.all(
      (await readdir(attemptDirectory)).map(async (name) => {
        const file = JSON.parse(
          await readFile(join(attemptDirectory, name), "utf8"),
        ) as { receipt: { status: string } };
        return file.receipt.status;
      }),
    );
    expect(attemptStatuses.sort()).toEqual(["abandoned", "delivered"]);
  });
});
