import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { processPullRequestComments } from "../../src/pr-comments/loop.js";
import type { RunFlowInput, RunFlowResult } from "../../src/run/run-flow.js";
import type {
  ChangeRequestTarget,
  CreatePullRequestCommentRequest,
  ScmProvider,
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

function providerWithComments(
  comments: NonNullable<ScmProvider["listPullRequestDiscussion"]> extends (
    input: never,
  ) => Promise<infer T>
    ? T
    : never,
): ScmProvider {
  return {
    type: "github",
    publishChange: async () => {
      throw new Error("publishChange must not be called");
    },
    resolveChangeRequestTarget: async () => target,
    listPullRequestDiscussion: async () => comments,
    createPullRequestComment: async ({ body }) => ({
      provider: "github",
      kind: "issue-comment",
      id: "reply-1",
      url: `${target.url}#issuecomment-reply-1`,
      body,
      authorLogin: "nitely",
      authorAssociation: "MEMBER",
      createdAt: "2026-06-20T00:00:05Z",
    }),
  };
}

describe("processPullRequestComments", () => {
  it("triggers rework for authorized commands and records trigger inputs", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const runInputs: RunFlowInput[] = [];
    const provider = providerWithComments([
      {
        provider: "github",
        kind: "issue-comment",
        id: "100",
        url: `${target.url}#issuecomment-100`,
        body: "@nitely rework fix auth",
        authorLogin: "alice",
        authorAssociation: "MEMBER",
        createdAt: "2026-06-20T00:00:00Z",
        updatedAt: "2026-06-20T00:00:00Z",
      },
    ]);

    const result = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      priorRunId: "run-prev",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async (input): Promise<RunFlowResult> => {
        runInputs.push(input);
        return {
          runId: "run-new",
          branchName: "nitely/pr-15",
          worktreePath: `${repoPath}/.nitely/runs/run-new/worktree`,
          changeRequestUrl: target.url,
        };
      },
    });

    expect(result.triggered).toEqual([{ commentId: "100", runId: "run-new" }]);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).toMatchObject({
      flowPath: "flows/rework-pr-bootstrap.json",
      repoPath,
      inputs: {
        spec: { connector: "local-file" },
        "tech-design": { connector: "local-file" },
      },
      changeRequestTarget: {
        provider: "github",
        target: "15",
      },
      trigger: {
        type: "github-pr-comment",
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        prNumber: 15,
        commentId: "100",
        authorLogin: "alice",
        action: "rework",
        priorRunId: "run-prev",
      },
    });
    await expect(
      readFile(
        join(
          repoPath,
          ".nitely/comment-triggers/github/Instask/nitely/15/100/spec.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("fix auth");
  });

  it("skips unauthorized and duplicate comments without running work", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    let runCalls = 0;
    const provider = providerWithComments([
      {
        provider: "github",
        kind: "issue-comment",
        id: "200",
        url: `${target.url}#issuecomment-200`,
        body: "@nitely address this add coverage",
        authorLogin: "mallory",
        authorAssociation: "NONE",
        createdAt: "2026-06-20T00:00:00Z",
      },
    ]);

    const first = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        runCalls += 1;
        throw new Error("must not run");
      },
    });
    const second = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:02:00Z"),
      runFlow: async () => {
        runCalls += 1;
        throw new Error("must not run");
      },
    });

    expect(first.skipped).toEqual([
      { commentId: "200", reason: "unauthorized author" },
    ]);
    expect(second.skipped).toEqual([
      { commentId: "200", reason: "already processed" },
    ]);
    expect(runCalls).toBe(0);
  });

  it("answers explain commands without invoking rework", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const provider = {
      ...providerWithComments([
        {
          provider: "github" as const,
          kind: "review-comment" as const,
          id: "300",
          url: `${target.url}#discussion_r300`,
          body: "@nitely explain why configured",
          authorLogin: "alice",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "reply-300",
          url: `${target.url}#issuecomment-reply-300`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };

    const result = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        throw new Error("runFlow must not be called");
      },
    });

    expect(result.explained).toEqual([
      { commentId: "300", commentUrl: `${target.url}#discussion_r300` },
    ]);
    expect(postedBodies.join("\n")).toContain("Nitely explanation");
  });

  it("posts sanitized failure comments when comment-triggered rework fails", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const provider = {
      ...providerWithComments([
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "350",
          url: `${target.url}#issuecomment-350`,
          body: "@nitely rework fix secret leak",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "reply-350",
          url: `${target.url}#issuecomment-reply-350`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };

    await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        throw new Error("command failed\nTOKEN=secret-value");
      },
    });

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("Nitely comment-triggered rework failed");
    expect(postedBodies[0]).toContain("The run failed. See local run artifacts for details.");
    expect(postedBodies[0]).not.toContain("command failed");
    expect(postedBodies[0]).not.toContain("TOKEN");
    expect(postedBodies[0]).not.toContain("secret-value");
  });

  it("reports the updated head from the completed rework run when available", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const provider = {
      ...providerWithComments([
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "360",
          url: `${target.url}#issuecomment-360`,
          body: "@nitely rework update branch",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "reply-360",
          url: `${target.url}#issuecomment-reply-360`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };
    const runResult = {
      runId: "run-new",
      branchName: "nitely/pr-15",
      worktreePath: `${repoPath}/.nitely/runs/run-new/worktree`,
      changeRequestUrl: target.url,
      previousHeadSha: "abc123",
      updatedHeadSha: "def456",
    };

    await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => runResult,
    });

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("- Updated head: `def456`");
    expect(postedBodies[0]).not.toContain("- Updated head: `abc123`");
  });

  it("records empty actionable commands with a clear skip reason", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const provider = providerWithComments([
      {
        provider: "github",
        kind: "issue-comment",
        id: "370",
        url: `${target.url}#issuecomment-370`,
        body: "@nitely rework",
        authorLogin: "alice",
        authorAssociation: "MEMBER",
        createdAt: "2026-06-20T00:00:00Z",
        updatedAt: "2026-06-20T00:00:00Z",
      },
    ]);

    const result = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        throw new Error("runFlow must not be called");
      },
    });

    expect(result.skipped).toEqual([{ commentId: "370", reason: "empty instruction" }]);
    await expect(
      readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    ).resolves.toContain('"reason": "empty instruction"');
  });

  it("does not run or post comments during dry runs", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    let sideEffects = 0;
    const provider = {
      ...providerWithComments([
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "400",
          url: `${target.url}#issuecomment-400`,
          body: "@nitely rework dry run",
          authorLogin: "alice",
          authorAssociation: "OWNER",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ]),
      createPullRequestComment: async () => {
        sideEffects += 1;
        throw new Error("must not post");
      },
    };

    const result = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      dryRun: true,
      runFlow: async () => {
        sideEffects += 1;
        throw new Error("must not run");
      },
    });

    expect(result.triggered).toEqual([{ commentId: "400", runId: "dry-run" }]);
    expect(sideEffects).toBe(0);
  });
});
