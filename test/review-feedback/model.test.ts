import { describe, expect, it } from "vitest";

import { normalizeReviewFeedback } from "../../src/review-feedback/model.js";
import type {
  ChangeRequestTarget,
  PullRequestDiscussionItem,
} from "../../src/scm/types.js";

const target: ChangeRequestTarget = {
  provider: "github",
  owner: "Instask",
  repository: "nitely",
  number: 15,
  url: "https://github.com/Instask/nitely/pull/15",
  baseBranch: "main",
  headBranch: "nitely/pr-15",
  headSha: "abc123",
  headRepository: { owner: "Instask", repository: "nitely" },
  isCrossRepository: false,
};

function comment(body: string): PullRequestDiscussionItem {
  return {
    provider: "github",
    kind: "review-comment",
    id: "100",
    url: `${target.url}#discussion_r100`,
    body,
    authorLogin: "alice",
    authorAssociation: "MEMBER",
    createdAt: "2026-06-20T00:00:00Z",
    path: "src/app.ts",
    line: 42,
  };
}

describe("review feedback normalization", () => {
  it("routes localized code review feedback to implementation and preserves raw evidence", () => {
    const feedback = normalizeReviewFeedback({
      target,
      comment: comment("@nitely rework add a regression test for this branch"),
      action: "rework",
      instruction: "add a regression test for this branch",
      priorRunId: "run-prev",
      ingestedAt: "2026-06-20T00:01:00.000Z",
    });

    expect(feedback).toMatchObject({
      schemaVersion: 1,
      id: "github:Instask/nitely#15:comment:100",
      action: "rework",
      route: {
        target: "implementation",
        confidence: "inferred",
        requiresOperatorApproval: false,
      },
      raw: {
        commentId: "100",
        path: "src/app.ts",
        line: 42,
        body: "@nitely rework add a regression test for this branch",
      },
      lineage: {
        prNumber: 15,
        priorRunId: "run-prev",
      },
    });
    expect(feedback.memoryProposals).toEqual([]);
  });

  it("routes reusable reviewer guidance to proposed memory", () => {
    const feedback = normalizeReviewFeedback({
      target,
      comment: comment("@nitely address this remember future runs should keep API errors typed"),
      action: "address",
      instruction: "remember future runs should keep API errors typed",
      ingestedAt: "2026-06-20T00:01:00.000Z",
    });

    expect(feedback.route).toMatchObject({
      target: "memory",
      confidence: "inferred",
      requiresOperatorApproval: true,
    });
    expect(feedback.memoryProposals).toHaveLength(1);
    expect(feedback.memoryProposals[0]).toMatchObject({
      category: "feedback",
      status: "proposed",
      source: {
        type: "review",
        uri: `${target.url}#discussion_r100`,
      },
    });
    expect(feedback.memoryProposals[0]?.keywords).toContain("memory");
  });
});
