import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  commentBodyHash,
  loadCommentLoopState,
  recordCommentProcess,
} from "../../src/pr-comments/state.js";

describe("comment loop state", () => {
  it("stores processed comments and treats the same body hash as duplicate", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-state-"));
    const location = {
      repoPath,
      owner: "Instask",
      repository: "nitely",
      prNumber: 15,
    };
    const bodyHash = commentBodyHash("body", "2026-06-20T00:00:00Z");

    await recordCommentProcess(location, {
      commentId: "c1",
      commentUrl: "https://github.com/Instask/nitely/pull/15#issuecomment-1",
      bodyHash,
      action: "rework",
      status: "triggered",
      runId: "run-1",
      processedAt: "2026-06-20T00:01:00.000Z",
    });

    const state = await loadCommentLoopState(location);
    expect(state.comments.c1).toMatchObject({
      commentId: "c1",
      bodyHash,
      status: "triggered",
      runId: "run-1",
    });
    expect(state.comments.c1?.bodyHash).toBe(
      commentBodyHash("body", "2026-06-20T00:00:00Z"),
    );
    expect(commentBodyHash("body", "2026-06-20T00:05:00Z")).not.toBe(bodyHash);
  });
});
