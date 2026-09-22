import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listContextKnowledgeEntries } from "../../src/context-kg/store.js";
import {
  feedbackMemoryEntryId,
  materializeFeedbackMemoryProposals,
} from "../../src/review-feedback/memory.js";
import type { NormalizedReviewFeedback } from "../../src/review-feedback/model.js";
import { listNotificationDeliveryReceipts } from "../../src/web/notification-delivery.js";
import { listNotifications } from "../../src/web/notifications.js";

function feedback(): NormalizedReviewFeedback {
  return {
    schemaVersion: 1,
    id: "github:Instask/nitely#15:comment:100",
    source: "github-pr-discussion",
    action: "address",
    instruction: "remember future runs should keep API errors typed",
    raw: {
      provider: "github",
      kind: "review-comment",
      commentId: "100",
      commentUrl: "https://github.com/Instask/nitely/pull/15#discussion_r100",
      body: "@nitely address this remember future runs should keep API errors typed",
      authorLogin: "alice",
      createdAt: "2026-06-20T00:00:00Z",
    },
    route: {
      target: "memory",
      confidence: "inferred",
      reason: "Feedback describes reusable knowledge for future runs.",
      requiresOperatorApproval: true,
    },
    lineage: {
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      prNumber: 15,
      prUrl: "https://github.com/Instask/nitely/pull/15",
      priorRunId: "run-prev",
      triggeredRunId: "run-new",
      ingestedAt: "2026-06-20T00:01:00.000Z",
    },
    memoryProposals: [
      {
        category: "feedback",
        title: "Review feedback: keep API errors typed",
        body: "Reviewer feedback candidate:\n\nkeep API errors typed",
        status: "proposed",
        tags: ["review-feedback", "memory"],
        keywords: ["review", "feedback", "memory", "typed"],
        source: {
          type: "review",
          uri: "https://github.com/Instask/nitely/pull/15#discussion_r100",
        },
      },
    ],
  };
}

describe("review feedback memory materialization", () => {
  it("creates deterministic proposed context-kg entries and links the proposal", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-feedback-memory-"));
    const input = feedback();
    const expectedId = feedbackMemoryEntryId(input, 0);
    const deliveredSourceKeys: string[] = [];
    const notificationDeliveryTargets = [
      {
        channel: "webhook" as const,
        deliver: async (notification: { sourceKey: string }) => {
          deliveredSourceKeys.push(notification.sourceKey);
          return { externalId: "memory-webhook-1" };
        },
      },
    ];

    const first = await materializeFeedbackMemoryProposals({
      repoPath,
      feedback: input,
      notificationDeliveryTargets,
    });
    const [firstNotification] = await listNotifications(repoPath);
    await rm(
      join(
        repoPath,
        ".nitely",
        "notifications",
        `${firstNotification!.id}.json`,
      ),
    );
    const second = await materializeFeedbackMemoryProposals({
      repoPath,
      feedback: first.feedback,
      notificationDeliveryTargets,
    });

    expect(first.entries).toEqual([
      expect.objectContaining({
        proposalIndex: 0,
        entryId: expectedId,
        created: true,
      }),
    ]);
    expect(second.entries).toEqual([
      expect.objectContaining({
        proposalIndex: 0,
        entryId: expectedId,
        created: false,
      }),
    ]);
    expect(first.feedback.memoryProposals[0]).toMatchObject({
      contextKnowledgeEntryId: expectedId,
      source: {
        runId: "run-new",
      },
    });
    await expect(listContextKnowledgeEntries(repoPath)).resolves.toEqual([
      expect.objectContaining({
        id: expectedId,
        category: "feedback",
        status: "proposed",
        source: {
          type: "review",
          uri: "https://github.com/Instask/nitely/pull/15#discussion_r100",
          runId: "run-new",
        },
      }),
    ]);
    await expect(listNotifications(repoPath)).resolves.toEqual([
      expect.objectContaining({
        sourceKey: `context-kg:${expectedId}:proposal`,
        type: "review-memory",
        status: "pending",
        proposalId: expectedId,
        runId: "run-new",
        link: `/context-kg?entry=${encodeURIComponent(expectedId)}`,
      }),
    ]);
    expect(deliveredSourceKeys).toEqual([
      `context-kg:${expectedId}:proposal`,
    ]);
    await expect(
      listNotificationDeliveryReceipts(
        repoPath,
        `context-kg:${expectedId}:proposal`,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        externalId: "memory-webhook-1",
      }),
    ]);
  });
});
