import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { eventStorePath } from "../../src/run/project.js";

import {
  assertNotificationActionAllowed,
  listTaskNotificationDecisions,
  listNotifications,
  recordNotificationDecision,
  resolveNotificationBySourceKey,
  upsertNotification,
} from "../../src/web/notifications.js";

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-notifications-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  return repoPath;
}

describe("web notifications", () => {
  it("declares type-based actions and enforces required reasons", async () => {
    const repoPath = await createRepo();
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t1:blocked",
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs input",
      taskId: "t1",
      runId: "run-1",
      link: "/tasks/t1",
    });

    expect(notification.supportedActions).toEqual([
      "resolve",
      "override",
      "cancel-run",
      "assign",
    ]);
    expect(notification.requiredReasonActions).toEqual([
      "override",
      "cancel-run",
    ]);
    expect(() =>
      assertNotificationActionAllowed(notification, {
        action: "override",
      }),
    ).toThrow("reason is required for notification action override");
    expect(() =>
      assertNotificationActionAllowed(notification, {
        action: "approve",
        reason: "not supported here",
      }),
    ).toThrow("notification action approve is not supported");
    expect(
      assertNotificationActionAllowed(notification, {
        action: "override",
        reason: "Operator accepted the known transient failure.",
      }),
    ).toEqual({
      action: "override",
      reason: "Operator accepted the known transient failure.",
    });

    const planningReview = await upsertNotification(repoPath, {
      sourceKey: "task:t1:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      taskId: "t1",
      link: "/tasks/t1",
    });
    expect(planningReview.supportedActions).toEqual([
      "approve",
      "deny",
      "request-changes",
      "assign",
    ]);
  });

  it("records a human action in task evidence and an existing run event stream", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-1",
      type: "run.created",
      payload: { flowName: "test" },
    });
    store.close();
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:t1:blocked",
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs input",
      taskId: "t1",
      runId: "run-1",
      proposalId: "proposal-1",
      artifactId: "artifact-1",
      link: "/tasks/t1",
    });

    const decision = await recordNotificationDecision(
      repoPath,
      notification,
      {
        actorId: "operator-1",
        action: "override",
        reason: "Known flaky upstream service; retry is approved.",
      },
      {
        createId: () => "decision-1",
        now: () => new Date("2026-07-14T02:00:00.000Z"),
      },
    );

    expect(decision).toMatchObject({
      schemaVersion: 1,
      id: "decision-1",
      notificationId: notification.id,
      sourceKey: notification.sourceKey,
      taskId: "t1",
      runId: "run-1",
      proposalId: "proposal-1",
      artifactId: "artifact-1",
      actorId: "operator-1",
      action: "override",
      reason: "Known flaky upstream service; retry is approved.",
      createdAt: "2026-07-14T02:00:00.000Z",
    });
    await expect(listTaskNotificationDecisions(repoPath, "t1")).resolves.toEqual([
      decision,
    ]);

    const evidenceStore = new EventStore(eventStorePath(repoPath));
    expect(evidenceStore.list("run-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notification.decision",
          payload: expect.objectContaining({
            decisionId: "decision-1",
            action: "override",
            proposalId: "proposal-1",
            artifactId: "artifact-1",
            reason: "Known flaky upstream service; retry is approved.",
          }),
        }),
      ]),
    );
    evidenceStore.close();
  });

  it("deduplicates pending notifications by source key and resolves them durably", async () => {
    const repoPath = await createRepo();
    const now = new Date("2026-06-26T00:00:00Z");
    const createId = () => "notification-1";

    const first = await upsertNotification(
      repoPath,
      {
        sourceKey: "task:t1:draft-spec",
        type: "review-spec",
        severity: "info",
        title: "Review spec",
        taskId: "t1",
        link: "/tasks/t1",
        targetUserId: "u1",
      },
      { now: () => now, createId },
    );
    const second = await upsertNotification(
      repoPath,
      {
        sourceKey: "task:t1:draft-spec",
        type: "review-spec",
        severity: "info",
        title: "Review updated spec",
        taskId: "t1",
        link: "/tasks/t1",
        targetUserId: "u1",
      },
      {
        now: () => new Date("2026-06-26T00:01:00Z"),
        createId: () => "notification-2",
      },
    );

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Review updated spec");
    expect(await listNotifications(repoPath)).toHaveLength(1);

    const resolved = await resolveNotificationBySourceKey(
      repoPath,
      "task:t1:draft-spec",
      {
        actorId: "u1",
        resolution: "approved",
        reason: "Spec looks ready.",
      },
      { now: () => new Date("2026-06-26T00:02:00Z") },
    );

    expect(resolved).toMatchObject({
      id: "notification-1",
      status: "resolved",
      resolvedBy: "u1",
      resolution: "approved",
      reason: "Spec looks ready.",
    });
    await expect(
      readFile(
        join(repoPath, ".nitely", "notifications", "notification-1.json"),
        "utf8",
      ),
    ).resolves.toContain("\"status\": \"resolved\"");
  });
});
