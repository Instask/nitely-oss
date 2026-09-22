import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResourceReference } from "../connectors/types.js";
import type { NormalizedReviewFeedback } from "../review-feedback/model.js";
import type { ChangeRequestTarget, PullRequestDiscussionItem } from "../scm/types.js";
import type { ParsedNitelyCommand } from "./commands.js";
import { commentTriggerRoot, type CommentStateLocation } from "./state.js";

export interface MaterializeCommentTriggerInputsInput {
  location: CommentStateLocation;
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  command: ParsedNitelyCommand;
  feedback?: NormalizedReviewFeedback;
  priorRunId?: string;
}

export interface MaterializedCommentTriggerInputs {
  directory: string;
  inputs: Record<"spec" | "tech-design", ResourceReference>;
}

function triggerDirectory(location: CommentStateLocation, commentId: string): string {
  return join(commentTriggerRoot(location), commentId);
}

export async function materializeCommentTriggerInputs(
  input: MaterializeCommentTriggerInputsInput,
): Promise<MaterializedCommentTriggerInputs> {
  const directory = triggerDirectory(input.location, input.comment.id);
  await mkdir(directory, { recursive: true });
  const specPath = join(directory, "spec.md");
  const techDesignPath = join(directory, "tech-design.md");
  const triggerPath = join(directory, "trigger.json");
  const feedbackPath = join(directory, "feedback.json");
  const memoryProposalLines = input.feedback?.memoryProposals.length
    ? [
        "",
        "Memory proposals:",
        ...input.feedback.memoryProposals.map(
          (proposal) => `- ${proposal.title}`,
        ),
      ]
    : [];

  await writeFile(
    specPath,
    [
      `# GitHub PR Comment Trigger`,
      "",
      `Source PR: ${input.target.url}`,
      `PR Number: ${input.target.number}`,
      `Source comment: ${input.comment.url}`,
      `Comment ID: ${input.comment.id}`,
      `Author: ${input.comment.authorLogin}`,
      `Author association: ${input.comment.authorAssociation ?? ""}`,
      `Command action: ${input.command.action}`,
      `Instruction: ${input.command.instruction}`,
      ...(input.feedback
        ? [
            `Feedback route: ${input.feedback.route.target}`,
            `Route confidence: ${input.feedback.route.confidence}`,
            `Route reason: ${input.feedback.route.reason}`,
            `Operator approval required: ${input.feedback.route.requiresOperatorApproval ? "yes" : "no"}`,
          ]
        : []),
      `Previous run ID: ${input.priorRunId ?? ""}`,
      "",
      "Update the existing PR branch only. Keep the change scoped to this comment-triggered request.",
      ...memoryProposalLines,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    techDesignPath,
    [
      "# Operational Design",
      "",
      "- Inspect the current PR branch before editing.",
      "- Implement only the requested change from the triggering comment.",
      "- Update tests and docs when behavior changes.",
      "- Run the normal verification suite.",
      "- Preserve existing review evidence and avoid unrelated refactors.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    triggerPath,
    JSON.stringify(
      {
        provider: "github",
        owner: input.location.owner,
        repository: input.location.repository,
        prNumber: input.location.prNumber,
        prUrl: input.target.url,
        commentId: input.comment.id,
        commentUrl: input.comment.url,
        authorLogin: input.comment.authorLogin,
        authorAssociation: input.comment.authorAssociation,
        action: input.command.action,
        instruction: input.command.instruction,
        feedback: input.feedback,
        priorRunId: input.priorRunId,
      },
      null,
      2,
    ),
    "utf8",
  );
  if (input.feedback) {
    await writeFile(feedbackPath, JSON.stringify(input.feedback, null, 2), "utf8");
  }

  return {
    directory,
    inputs: {
      spec: { connector: "local-file", uri: specPath },
      "tech-design": { connector: "local-file", uri: techDesignPath },
    },
  };
}
