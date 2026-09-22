import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listContextKnowledgeEntries } from "../../src/context-kg/store.js";
import { processPullRequestComments } from "../../src/pr-comments/loop.js";
import type { RunFlowInput, RunFlowResult } from "../../src/run/run-flow.js";
import type {
  ChangeRequestTarget,
  CreatePullRequestCommentRequest,
  ScmProvider,
} from "../../src/scm/types.js";
import {
  listNotifications,
  resolveNotification,
} from "../../src/web/notifications.js";

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
        feedback: {
          route: {
            target: "implementation",
          },
        },
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
    await expect(
      readFile(
        join(
          repoPath,
          ".nitely/comment-triggers/github/Instask/nitely/15/100/spec.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Feedback route: implementation");
    const trigger = JSON.parse(
      await readFile(
        join(
          repoPath,
          ".nitely/comment-triggers/github/Instask/nitely/15/100/trigger.json",
        ),
        "utf8",
      ),
    );
    expect(trigger.feedback).toMatchObject({
      id: "github:Instask/nitely#15:comment:100",
      action: "rework",
      route: {
        target: "implementation",
        confidence: "inferred",
      },
      raw: {
        commentId: "100",
        body: "@nitely rework fix auth",
      },
      lineage: {
        priorRunId: "run-prev",
      },
    });
    const state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.comments["100"].feedback).toMatchObject({
      lineage: {
        priorRunId: "run-prev",
        triggeredRunId: "run-new",
      },
    });
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
      priorRunId: "run-prev",
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => runResult,
    });

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain(
      "- Feedback ID: `github:Instask/nitely#15:comment:360`",
    );
    expect(postedBodies[0]).toContain("- Prior run: `run-prev`");
    expect(postedBodies[0]).toContain("- Rework attempt: 1/3");
    expect(postedBodies[0]).toContain("- Updated head: `def456`");
    expect(postedBodies[0]).not.toContain("- Updated head: `abc123`");
  });

  it("materializes memory-routed feedback as proposed context knowledge", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const provider = providerWithComments([
      {
        provider: "github",
        kind: "review-comment",
        id: "365",
        url: `${target.url}#discussion_r365`,
        body: "@nitely address this remember future runs should keep API errors typed",
        authorLogin: "alice",
        authorAssociation: "MEMBER",
        createdAt: "2026-06-20T00:00:00Z",
      },
    ]);

    await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      priorRunId: "run-prev",
      approveRequiredRoutes: true,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async (): Promise<RunFlowResult> => ({
        runId: "run-memory",
        branchName: "nitely/pr-15",
        worktreePath: `${repoPath}/.nitely/runs/run-memory/worktree`,
        changeRequestUrl: target.url,
      }),
    });

    const entries = await listContextKnowledgeEntries(repoPath);
    expect(entries).toEqual([
      expect.objectContaining({
        category: "feedback",
        status: "proposed",
        source: {
          type: "review",
          uri: `${target.url}#discussion_r365`,
          runId: "run-memory",
        },
      }),
    ]);
    const state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.comments["365"].feedback).toMatchObject({
      route: {
        target: "memory",
      },
      memoryProposals: [
        {
          contextKnowledgeEntryId: entries[0]?.id,
          source: {
            runId: "run-memory",
          },
        },
      ],
    });
  });

  it("requires explicit operator approval before running approval-required routes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const comment = {
      provider: "github" as const,
      kind: "issue-comment" as const,
      id: "480",
      url: `${target.url}#issuecomment-480`,
      body: "@nitely rework spec: tighten acceptance criteria",
      authorLogin: "alice",
      authorAssociation: "MEMBER",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
    };
    const provider = {
      ...providerWithComments([comment]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: `reply-${postedBodies.length}`,
          url: `${target.url}#issuecomment-reply-${postedBodies.length}`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };
    const runInputs: RunFlowInput[] = [];

    const pending = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        throw new Error("runFlow must not be called before route approval");
      },
    });

    expect(pending.pendingApprovals).toEqual([
      {
        commentId: "480",
        route: "spec",
        reason: "feedback route spec requires operator approval before execution",
      },
    ]);
    expect(pending.triggered).toEqual([]);
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("Nitely rework route approval required");
    expect(postedBodies[0]).toContain("- Proposed route: `spec` (explicit)");
    let state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.comments["480"]).toMatchObject({
      status: "pending-approval",
      reason: "feedback route spec requires operator approval before execution",
      feedback: {
        route: {
          target: "spec",
          requiresOperatorApproval: true,
        },
      },
    });
    await expect(listNotifications(repoPath)).resolves.toEqual([
      expect.objectContaining({
        sourceKey:
          "review-feedback:github:Instask/nitely#15:comment:480:route",
        type: "review-rework",
        status: "pending",
        proposalId: "github:Instask/nitely#15:comment:480",
        link: comment.url,
      }),
    ]);
    const [routeNotification] = await listNotifications(repoPath);
    await resolveNotification(repoPath, routeNotification!.id, {
      actorId: "operator",
      resolution: "approve",
    });

    const approved = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      routeFlowPaths: {
        spec: "flows/rework-spec-bootstrap.json",
      },
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:02:00Z"),
      runFlow: async (input): Promise<RunFlowResult> => {
        runInputs.push(input);
        return {
          runId: "run-approved-route",
          branchName: "nitely/pr-15",
          worktreePath: `${repoPath}/.nitely/runs/run-approved-route/worktree`,
          changeRequestUrl: target.url,
        };
      },
    });

    expect(approved.pendingApprovals).toEqual([]);
    expect(approved.triggered).toEqual([
      { commentId: "480", runId: "run-approved-route" },
    ]);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]?.flowPath).toBe("flows/rework-spec-bootstrap.json");
    expect(runInputs[0]?.trigger).toMatchObject({
      feedback: {
        route: {
          target: "spec",
          requiresOperatorApproval: true,
        },
      },
    });
    state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.comments["480"]).toMatchObject({
      status: "triggered",
      runId: "run-approved-route",
    });
    expect(postedBodies[1]).toContain("- Flow: `flows/rework-spec-bootstrap.json`");
    await expect(listNotifications(repoPath)).resolves.toEqual([
      expect.objectContaining({
        sourceKey:
          "review-feedback:github:Instask/nitely#15:comment:480:route",
        status: "resolved",
        resolution: "approve",
      }),
    ]);
  });

  it("lets operators override a pending feedback route before execution", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const comment = {
      provider: "github" as const,
      kind: "issue-comment" as const,
      id: "481",
      url: `${target.url}#issuecomment-481`,
      body: "@nitely rework spec: this is actually an implementation-only fix",
      authorLogin: "alice",
      authorAssociation: "MEMBER",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
    };
    const provider = {
      ...providerWithComments([comment]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: `reply-${postedBodies.length}`,
          url: `${target.url}#issuecomment-reply-${postedBodies.length}`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };
    const runInputs: RunFlowInput[] = [];

    const pending = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:01:00Z"),
      runFlow: async () => {
        throw new Error("runFlow must not be called before route approval");
      },
    });

    expect(pending.pendingApprovals).toEqual([
      {
        commentId: "481",
        route: "spec",
        reason: "feedback route spec requires operator approval before execution",
      },
    ]);

    const overridden = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      routeOverrides: {
        "481": "implementation",
      },
      scmProvider: provider,
      now: () => new Date("2026-06-20T00:02:00Z"),
      runFlow: async (input): Promise<RunFlowResult> => {
        runInputs.push(input);
        return {
          runId: "run-overridden-route",
          branchName: "nitely/pr-15",
          worktreePath: `${repoPath}/.nitely/runs/run-overridden-route/worktree`,
          changeRequestUrl: target.url,
        };
      },
    });

    expect(overridden.pendingApprovals).toEqual([]);
    expect(overridden.triggered).toEqual([
      { commentId: "481", runId: "run-overridden-route" },
    ]);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]?.flowPath).toBe("flows/rework-pr-bootstrap.json");
    expect(runInputs[0]?.trigger).toMatchObject({
      feedback: {
        route: {
          target: "implementation",
          confidence: "explicit",
          requiresOperatorApproval: false,
        },
      },
    });
    expect(
      String(
        (runInputs[0]?.trigger as { feedback?: { route?: { reason?: string } } })
          .feedback?.route?.reason,
      ),
    ).toContain("Previous route was spec");
    const state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.comments["481"]).toMatchObject({
      status: "triggered",
      runId: "run-overridden-route",
      feedback: {
        route: {
          target: "implementation",
          requiresOperatorApproval: false,
        },
        memoryProposals: [],
      },
    });
    expect(postedBodies[1]).toContain("- Feedback route: `implementation` (explicit)");
  });

  it("stops repeated rework commands after the configured attempt limit", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-comments-loop-"));
    const postedBodies: string[] = [];
    const provider = {
      ...providerWithComments([
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "500",
          url: `${target.url}#issuecomment-500`,
          body: "@nitely rework first fix",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
          createdAt: "2026-06-20T00:00:00Z",
        },
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "501",
          url: `${target.url}#issuecomment-501`,
          body: "@nitely address this second fix",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
          createdAt: "2026-06-20T00:01:00Z",
        },
        {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: "502",
          url: `${target.url}#issuecomment-502`,
          body: "@nitely rework third fix",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
          createdAt: "2026-06-20T00:02:00Z",
        },
      ]),
      createPullRequestComment: async ({ body }: CreatePullRequestCommentRequest) => {
        postedBodies.push(body);
        return {
          provider: "github" as const,
          kind: "issue-comment" as const,
          id: `reply-${postedBodies.length}`,
          url: `${target.url}#issuecomment-reply-${postedBodies.length}`,
          body,
          authorLogin: "nitely",
          createdAt: "2026-06-20T00:00:05Z",
        };
      },
    };
    const runInputs: RunFlowInput[] = [];

    const result = await processPullRequestComments({
      repoPath,
      target: "15",
      flowPath: "flows/rework-pr-bootstrap.json",
      scmProvider: provider,
      maxReworkAttempts: 2,
      now: () => new Date("2026-06-20T00:03:00Z"),
      runFlow: async (input): Promise<RunFlowResult> => {
        runInputs.push(input);
        const runId = `run-${runInputs.length}`;
        return {
          runId,
          branchName: "nitely/pr-15",
          worktreePath: `${repoPath}/.nitely/runs/${runId}/worktree`,
          changeRequestUrl: target.url,
        };
      },
    });

    expect(result.triggered).toEqual([
      { commentId: "500", runId: "run-1" },
      { commentId: "501", runId: "run-2" },
    ]);
    expect(result.skipped).toEqual([
      {
        commentId: "502",
        reason: "rework attempt limit reached (2/2); no run started",
      },
    ]);
    expect(runInputs).toHaveLength(2);
    expect(postedBodies).toHaveLength(3);
    expect(postedBodies[2]).toContain("Nitely comment-triggered rework stopped");
    expect(postedBodies[2]).toContain("Rework attempts: 2/2");

    const state = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/comment-triggers/github/Instask/nitely/15/state.json"),
        "utf8",
      ),
    );
    expect(state.reworkAttempts).toMatchObject({
      maxAttempts: 2,
      attemptCount: 2,
      runIds: ["run-1", "run-2"],
      lastAttemptCommentId: "501",
      terminalReason: "rework attempt limit reached (2/2); no run started",
      terminalCommentId: "502",
    });
    expect(state.comments["502"]).toMatchObject({
      status: "skipped",
      reason: "rework attempt limit reached (2/2); no run started",
    });
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
