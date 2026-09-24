import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  commentBodyHash,
  loadCommentLoopState,
  recordCommentProcess,
  saveCommentLoopState,
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

  it("persists rework attempt limits and terminal reasons", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-state-"));
    const location = {
      repoPath,
      owner: "Instask",
      repository: "nitely",
      prNumber: 15,
    };

    await saveCommentLoopState(location, {
      version: 1,
      comments: {},
      reworkAttempts: {
        maxAttempts: 2,
        attemptCount: 2,
        runIds: ["run-1", "run-2"],
        lastAttemptCommentId: "c2",
        lastAttemptAt: "2026-06-20T00:02:00.000Z",
        terminalReason: "rework attempt limit reached (2/2); no run started",
        terminalCommentId: "c3",
        terminalAt: "2026-06-20T00:03:00.000Z",
      },
    });

    await expect(loadCommentLoopState(location)).resolves.toMatchObject({
      reworkAttempts: {
        maxAttempts: 2,
        attemptCount: 2,
        runIds: ["run-1", "run-2"],
        terminalReason: "rework attempt limit reached (2/2); no run started",
      },
    });
  });
});
