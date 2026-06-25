import { resolve } from "node:path";

import { createScmProvider } from "../scm/registry.js";
import type {
  ChangeRequestTarget,
  PullRequestDiscussionItem,
  ScmProvider,
} from "../scm/types.js";
import {
  runFlow as defaultRunFlow,
  type RunFlowInput,
  type RunFlowResult,
  type RunTrigger,
} from "../run/run-flow.js";
import { classifyNitelyCommand, type ParsedNitelyCommand } from "./commands.js";
import { materializeCommentTriggerInputs } from "./inputs.js";
import {
  commentBodyHash,
  loadCommentLoopState,
  recordCommentProcess,
  type CommentProcessRecord,
  type CommentStateLocation,
} from "./state.js";

const defaultAllowedAssociations = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export interface ProcessPullRequestCommentsInput {
  repoPath: string;
  target: string;
  flowPath: string;
  dryRun?: boolean;
  allowAuthors?: string[];
  botLogin?: string;
  priorRunId?: string;
  scmProvider?: ScmProvider;
  runFlow?: (input: RunFlowInput) => Promise<RunFlowResult>;
  now?: () => Date;
}

export interface ProcessPullRequestCommentsResult {
  target: ChangeRequestTarget;
  processed: number;
  triggered: Array<{ commentId: string; runId: string }>;
  explained: Array<{ commentId: string; commentUrl?: string }>;
  skipped: Array<{ commentId: string; reason: string }>;
}

function requireResolveTarget(provider: ScmProvider): NonNullable<ScmProvider["resolveChangeRequestTarget"]> {
  if (!provider.resolveChangeRequestTarget) {
    throw new Error(`SCM provider ${provider.type} cannot resolve change request targets`);
  }
  return provider.resolveChangeRequestTarget.bind(provider);
}

function requireListDiscussion(provider: ScmProvider): NonNullable<ScmProvider["listPullRequestDiscussion"]> {
  if (!provider.listPullRequestDiscussion) {
    throw new Error(`SCM provider ${provider.type} cannot list pull request discussion`);
  }
  return provider.listPullRequestDiscussion.bind(provider);
}

function requireCreateComment(provider: ScmProvider): NonNullable<ScmProvider["createPullRequestComment"]> {
  if (!provider.createPullRequestComment) {
    throw new Error(`SCM provider ${provider.type} cannot create pull request comments`);
  }
  return provider.createPullRequestComment.bind(provider);
}

function isAuthorized(input: {
  comment: PullRequestDiscussionItem;
  allowAuthors: Set<string>;
  botLogin?: string;
}): boolean {
  if (
    input.botLogin &&
    input.comment.authorLogin.toLowerCase() === input.botLogin.toLowerCase()
  ) {
    return false;
  }
  if (input.allowAuthors.has(input.comment.authorLogin.toLowerCase())) {
    return true;
  }
  return input.comment.authorAssociation
    ? defaultAllowedAssociations.has(input.comment.authorAssociation)
    : false;
}

function recordFor(input: {
  comment: PullRequestDiscussionItem;
  bodyHash: string;
  command?: ParsedNitelyCommand;
  status: CommentProcessRecord["status"];
  processedAt: string;
  runId?: string;
  reason?: string;
}): CommentProcessRecord {
  return {
    commentId: input.comment.id,
    commentUrl: input.comment.url,
    bodyHash: input.bodyHash,
    action: input.command?.action,
    status: input.status,
    runId: input.runId,
    reason: input.reason,
    processedAt: input.processedAt,
  };
}

function triggerFor(input: {
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  command: ParsedNitelyCommand;
  priorRunId?: string;
}): RunTrigger {
  return {
    type: "github-pr-comment",
    provider: "github",
    owner: input.target.owner,
    repository: input.target.repository,
    prNumber: input.target.number,
    prUrl: input.target.url,
    commentId: input.comment.id,
    commentUrl: input.comment.url,
    authorLogin: input.comment.authorLogin,
    action: input.command.action,
    priorRunId: input.priorRunId,
  };
}

function renderReworkComment(input: {
  runId: string;
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  updatedHeadSha?: string;
}): string {
  return [
    "### Nitely comment-triggered rework",
    "",
    `- Run: \`${input.runId}\``,
    `- Trigger: ${input.comment.url}`,
    `- PR: ${input.target.url}`,
    input.updatedHeadSha ? `- Updated head: \`${input.updatedHeadSha}\`` : undefined,
    `- Verification: see run evidence/test report in \`.nitely/runs/${input.runId}/\``,
    "",
    "This run was triggered by a PR comment.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderExplainComment(input: {
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  command: ParsedNitelyCommand;
  priorRunId?: string;
}): string {
  return [
    "### Nitely explanation",
    "",
    `Question: ${input.command.instruction}`,
    `Source comment: ${input.comment.url}`,
    `PR: ${input.target.url}`,
    input.priorRunId ? `Latest known run: \`${input.priorRunId}\`` : undefined,
    "",
    "This deterministic first-version response records the request without changing the PR branch.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderFailureComment(input: {
  runId?: string;
  comment: PullRequestDiscussionItem;
}): string {
  return [
    "### Nitely comment-triggered rework failed",
    "",
    input.runId ? `- Run: \`${input.runId}\`` : undefined,
    `- Trigger: ${input.comment.url}`,
    "- Summary: The run failed. See local run artifacts for details.",
    input.runId ? `- Artifacts: \`.nitely/runs/${input.runId}/\`` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function processPullRequestComments(
  input: ProcessPullRequestCommentsInput,
): Promise<ProcessPullRequestCommentsResult> {
  const repoPath = resolve(input.repoPath);
  const provider = input.scmProvider ?? createScmProvider("github");
  const resolveTarget = requireResolveTarget(provider);
  const listDiscussion = requireListDiscussion(provider);
  const target = await resolveTarget({
    repoPath,
    remoteName: "origin",
    target: input.target,
  });
  const result: ProcessPullRequestCommentsResult = {
    target,
    processed: 0,
    triggered: [],
    explained: [],
    skipped: [],
  };
  const location: CommentStateLocation = {
    repoPath,
    owner: target.owner,
    repository: target.repository,
    prNumber: target.number,
  };
  const comments = (
    await listDiscussion({ repoPath, remoteName: "origin", target })
  ).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const allowAuthors = new Set(
    (input.allowAuthors ?? []).map((author) => author.toLowerCase()),
  );
  const state = await loadCommentLoopState(location);

  for (const comment of comments) {
    const processedAt = (input.now?.() ?? new Date()).toISOString();
    const bodyHash = commentBodyHash(comment.body, comment.updatedAt);
    const existing = state.comments[comment.id];
    if (existing?.bodyHash === bodyHash) {
      result.skipped.push({ commentId: comment.id, reason: "already processed" });
      continue;
    }
    const classified = classifyNitelyCommand(comment.body);
    if (classified.status === "invalid") {
      result.skipped.push({ commentId: comment.id, reason: classified.reason });
      if (!input.dryRun) {
        await recordCommentProcess(
          location,
          recordFor({
            comment,
            bodyHash,
            status: "skipped",
            processedAt,
            reason: classified.reason,
          }),
        );
      }
      continue;
    }
    const command = classified.command;
    if (
      !isAuthorized({
        comment,
        allowAuthors,
        botLogin: input.botLogin,
      })
    ) {
      result.skipped.push({ commentId: comment.id, reason: "unauthorized author" });
      if (!input.dryRun) {
        await recordCommentProcess(
          location,
          recordFor({
            comment,
            bodyHash,
            command,
            status: "skipped",
            processedAt,
            reason: "unauthorized author",
          }),
        );
        state.comments[comment.id] = recordFor({
          comment,
          bodyHash,
          command,
          status: "skipped",
          processedAt,
          reason: "unauthorized author",
        });
      }
      continue;
    }

    result.processed += 1;
    if (command.action === "explain") {
      if (!input.dryRun) {
        const createComment = requireCreateComment(provider);
        await createComment({
          repoPath,
          remoteName: "origin",
          target,
          body: renderExplainComment({
            target,
            comment,
            command,
            priorRunId: input.priorRunId,
          }),
        });
        const record = recordFor({
          comment,
          bodyHash,
          command,
          status: "processed",
          processedAt,
        });
        await recordCommentProcess(location, record);
        state.comments[comment.id] = record;
      }
      result.explained.push({ commentId: comment.id, commentUrl: comment.url });
      continue;
    }

    if (input.dryRun) {
      result.triggered.push({ commentId: comment.id, runId: "dry-run" });
      continue;
    }

    const materialized = await materializeCommentTriggerInputs({
      location,
      target,
      comment,
      command,
      priorRunId: input.priorRunId,
    });
    let runId: string | undefined;
    try {
      const run = await (input.runFlow ?? defaultRunFlow)({
        flowPath: input.flowPath,
        repoPath,
        inputs: materialized.inputs,
        changeRequestTarget: {
          provider: "github",
          target: input.target,
        },
        trigger: triggerFor({
          target,
          comment,
          command,
          priorRunId: input.priorRunId,
        }),
        priorRunId: input.priorRunId,
      });
      runId = run.runId;
      const createComment = requireCreateComment(provider);
      await createComment({
        repoPath,
        remoteName: "origin",
        target,
        body: renderReworkComment({
          runId: run.runId,
          target,
          comment,
          updatedHeadSha: run.updatedHeadSha,
        }),
      });
      const record = recordFor({
        comment,
        bodyHash,
        command,
        status: "triggered",
        processedAt,
        runId: run.runId,
      });
      await recordCommentProcess(location, record);
      state.comments[comment.id] = record;
      result.triggered.push({ commentId: comment.id, runId: run.runId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const record = recordFor({
        comment,
        bodyHash,
        command,
        status: "failed",
        processedAt,
        runId,
        reason,
      });
      await recordCommentProcess(location, record);
      state.comments[comment.id] = record;
      try {
        const createComment = requireCreateComment(provider);
        await createComment({
          repoPath,
          remoteName: "origin",
          target,
          body: renderFailureComment({ runId, comment }),
        });
      } catch {
        // The state file remains the source of truth if posting the failure comment fails.
      }
      result.skipped.push({ commentId: comment.id, reason });
    }
  }

  return result;
}
