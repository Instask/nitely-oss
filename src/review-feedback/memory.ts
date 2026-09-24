import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  createContextKnowledgeEntry,
  listContextKnowledgeEntries,
  type ContextKnowledgeEntry,
} from "../context-kg/store.js";
import type { NormalizedReviewFeedback } from "./model.js";
import {
  type NotificationDeliveryTarget,
} from "../web/notification-delivery.js";
import { ensureContextKnowledgeProposalNotification } from "../web/context-knowledge-notifications.js";
import { EventStore } from "../events/store.js";
import { eventStorePath } from "../run/project.js";
import { recordAcceptedReviewFeedbackSkillPapercuts } from "../skill-improvement/runtime.js";

export interface MaterializedFeedbackMemoryProposal {
  proposalIndex: number;
  entryId: string;
  created: boolean;
  entry?: ContextKnowledgeEntry;
}

export interface MaterializeFeedbackMemoryProposalsResult {
  feedback: NormalizedReviewFeedback;
  entries: MaterializedFeedbackMemoryProposal[];
}

export function feedbackMemoryEntryId(
  feedback: Pick<NormalizedReviewFeedback, "id">,
  proposalIndex: number,
): string {
  const digest = createHash("sha256")
    .update(feedback.id)
    .update("\0")
    .update(String(proposalIndex))
    .digest("hex")
    .slice(0, 20);
  return `ctx-review-${digest}`;
}

export async function materializeFeedbackMemoryProposals(input: {
  repoPath: string;
  feedback: NormalizedReviewFeedback;
  notificationDeliveryTargets?: NotificationDeliveryTarget[];
}): Promise<MaterializeFeedbackMemoryProposalsResult> {
  const entries: MaterializedFeedbackMemoryProposal[] = [];
  const proposals = [...input.feedback.memoryProposals];
  for (const [proposalIndex, proposal] of proposals.entries()) {
    const entryId =
      proposal.contextKnowledgeEntryId ??
      feedbackMemoryEntryId(input.feedback, proposalIndex);
    let entry: ContextKnowledgeEntry;
    let created = true;
    try {
      entry = await createContextKnowledgeEntry(
        input.repoPath,
        {
          category: proposal.category,
          title: proposal.title,
          body: proposal.body,
          status: proposal.status,
          tags: proposal.tags,
          keywords: proposal.keywords,
          source: {
            ...proposal.source,
            ...(proposal.source.runId
              ? {}
              : input.feedback.lineage.triggeredRunId
                ? { runId: input.feedback.lineage.triggeredRunId }
                : {}),
          },
        },
        {
          createId: () => entryId,
          now: () => input.feedback.lineage.ingestedAt,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) {
        throw error;
      }
      created = false;
      const existing = (await listContextKnowledgeEntries(input.repoPath)).find(
        (candidate) => candidate.id === entryId,
      );
      if (!existing) throw error;
      entry = existing;
    }
    entries.push({ proposalIndex, entryId, created, entry });
    await ensureContextKnowledgeProposalNotification({
      repoPath: input.repoPath,
      entry,
      body: "Reviewer feedback proposed reusable repository knowledge.",
      ...(input.notificationDeliveryTargets
        ? { deliveryTargets: input.notificationDeliveryTargets }
        : {}),
    });
    proposals[proposalIndex] = {
      ...proposal,
      contextKnowledgeEntryId: entryId,
      source: {
        ...proposal.source,
        ...(proposal.source.runId
          ? {}
          : input.feedback.lineage.triggeredRunId
            ? { runId: input.feedback.lineage.triggeredRunId }
            : {}),
      },
    };
  }

  const triggeredRunId = input.feedback.lineage.triggeredRunId;
  const eventPath = eventStorePath(input.repoPath);
  if (triggeredRunId && existsSync(eventPath)) {
    const eventStore = new EventStore(eventPath);
    try {
      await recordAcceptedReviewFeedbackSkillPapercuts({
        repoPath: input.repoPath,
        runId: triggeredRunId,
        repository: resolve(input.repoPath),
        feedback: input.feedback.instruction,
        evidenceRef: input.feedback.raw.commentUrl,
        eventStore,
      });
    } finally {
      eventStore.close();
    }
  }

  return {
    feedback: {
      ...input.feedback,
      memoryProposals: proposals,
    },
    entries,
  };
}
