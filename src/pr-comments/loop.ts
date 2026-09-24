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
import {
  normalizeReviewFeedback,
  overrideReviewFeedbackRoute,
  withTriggeredRunId,
  type NormalizedReviewFeedback,
  type ReviewFeedbackRouteTarget,
} from "../review-feedback/model.js";
import { materializeFeedbackMemoryProposals } from "../review-feedback/memory.js";
import { classifyNitelyCommand, type ParsedNitelyCommand } from "./commands.js";
import { materializeCommentTriggerInputs } from "./inputs.js";
import {
  commentBodyHash,
  loadCommentLoopState,
  recordCommentProcess,
  saveCommentLoopState,
  type CommentLoopStateFile,
  type CommentProcessRecord,
  type CommentStateLocation,
} from "./state.js";
import {
  listNotifications,
  recordNotificationDecision,
  resolveNotification,
  upsertNotification,
} from "../web/notifications.js";

const defaultMaxReworkAttempts = 3;
const defaultAllowedAssociations = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export interface ProcessPullRequestCommentsInput {
  repoPath: string;
  target: string;
  flowPath: string;
  routeFlowPaths?: Partial<Record<ReviewFeedbackRouteTarget, string>>;
  routeOverrides?: Partial<Record<string, ReviewFeedbackRouteTarget>>;
  dryRun?: boolean;
  allowAuthors?: string[];
  botLogin?: string;
  priorRunId?: string;
  maxReworkAttempts?: number;
  approveRequiredRoutes?: boolean;
  scmProvider?: ScmProvider;
  runFlow?: (input: RunFlowInput) => Promise<RunFlowResult>;
  now?: () => Date;
}

export interface ProcessPullRequestCommentsResult {
  target: ChangeRequestTarget;
  processed: number;
  triggered: Array<{ commentId: string; runId: string }>;
  explained: Array<{ commentId: string; commentUrl?: string }>;
  pendingApprovals: Array<{ commentId: string; route: string; reason: string }>;
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
  feedback?: NormalizedReviewFeedback;
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
    feedback: input.feedback,
    reason: input.reason,
    processedAt: input.processedAt,
  };
}

function triggerFor(input: {
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  command: ParsedNitelyCommand;
  feedback?: NormalizedReviewFeedback;
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
    feedback: input.feedback,
    priorRunId: input.priorRunId,
  };
}

function renderReworkComment(input: {
  runId: string;
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  feedback?: NormalizedReviewFeedback;
  flowPath: string;
  updatedHeadSha?: string;
  reworkAttempt?: { attemptCount: number; maxAttempts: number };
}): string {
  return [
    "### Nitely comment-triggered rework",
    "",
    `- Run: \`${input.runId}\``,
    `- Trigger: ${input.comment.url}`,
    `- PR: ${input.target.url}`,
    `- Flow: \`${input.flowPath}\``,
    input.feedback ? `- Feedback ID: \`${input.feedback.id}\`` : undefined,
    input.feedback?.lineage.priorRunId
      ? `- Prior run: \`${input.feedback.lineage.priorRunId}\``
      : undefined,
    input.feedback
      ? `- Feedback route: \`${input.feedback.route.target}\` (${input.feedback.route.confidence})`
      : undefined,
    input.reworkAttempt
      ? `- Rework attempt: ${input.reworkAttempt.attemptCount}/${input.reworkAttempt.maxAttempts}`
      : undefined,
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

function renderReworkLimitComment(input: {
  comment: PullRequestDiscussionItem;
  maxAttempts: number;
  attemptCount: number;
  reason: string;
}): string {
  return [
    "### Nitely comment-triggered rework stopped",
    "",
    `- Trigger: ${input.comment.url}`,
    `- Summary: ${input.reason}`,
    `- Rework attempts: ${input.attemptCount}/${input.maxAttempts}`,
    "",
    "No rework run was started for this comment.",
  ].join("\n");
}

function routeApprovalReason(feedback: NormalizedReviewFeedback): string {
  return `feedback route ${feedback.route.target} requires operator approval before execution`;
}

function renderRouteApprovalComment(input: {
  comment: PullRequestDiscussionItem;
  feedback: NormalizedReviewFeedback;
  reason: string;
}): string {
  return [
    "### Nitely rework route approval required",
    "",
    `- Trigger: ${input.comment.url}`,
    `- Feedback ID: \`${input.feedback.id}\``,
    `- Proposed route: \`${input.feedback.route.target}\` (${input.feedback.route.confidence})`,
    `- Route reason: ${input.feedback.route.reason}`,
    `- Summary: ${input.reason}`,
    "",
    "No rework run was started. Re-run the comment processor with explicit route approval and a route-specific flow when this route is acceptable. If the route is wrong, pass `--route-override <comment-id>=<route>` before reprocessing.",
  ].join("\n");
}

function flowPathForFeedback(
  input: Pick<ProcessPullRequestCommentsInput, "flowPath" | "routeFlowPaths">,
  feedback: NormalizedReviewFeedback,
): string {
  return input.routeFlowPaths?.[feedback.route.target] ?? input.flowPath;
}

function routeOverrideForComment(
  input: Pick<ProcessPullRequestCommentsInput, "routeOverrides">,
  commentId: string,
): ReviewFeedbackRouteTarget | undefined {
  const route = input.routeOverrides?.[commentId];
  if (route === "explanation") {
    throw new Error(`invalid route override for comment ${commentId}: explanation`);
  }
  return route;
}

function maxReworkAttemptsFor(value: number | undefined): number {
  if (value === undefined) return defaultMaxReworkAttempts;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`maxReworkAttempts must be a positive integer`);
  }
  return value;
}

function isReworkTriggerAction(action: ParsedNitelyCommand["action"]): boolean {
  return action === "rework" || action === "address";
}

function recordedReworkAttempts(state: CommentLoopStateFile): number {
  if (state.reworkAttempts) return state.reworkAttempts.attemptCount;
  return Object.values(state.comments).filter(
    (record) =>
      record.action !== undefined &&
      isReworkTriggerAction(record.action) &&
      (record.status === "triggered" || record.status === "failed"),
  ).length;
}

function recordedReworkRunIds(state: CommentLoopStateFile): string[] {
  const explicit = state.reworkAttempts?.runIds;
  if (explicit) return explicit;
  return Object.values(state.comments)
    .map((record) => record.runId)
    .filter((runId): runId is string => Boolean(runId));
}

function reworkLimitReason(attemptCount: number, maxAttempts: number): string {
  return `rework attempt limit reached (${attemptCount}/${maxAttempts}); no run started`;
}

function beginReworkAttempt(input: {
  state: CommentLoopStateFile;
  maxAttempts: number;
  commentId: string;
  processedAt: string;
}): void {
  input.state.reworkAttempts = {
    maxAttempts: input.maxAttempts,
    attemptCount: recordedReworkAttempts(input.state) + 1,
    runIds: recordedReworkRunIds(input.state),
    lastAttemptCommentId: input.commentId,
    lastAttemptAt: input.processedAt,
  };
}

function finishReworkAttempt(input: {
  state: CommentLoopStateFile;
  runId: string;
}): void {
  const attempts = input.state.reworkAttempts;
  if (!attempts) return;
  input.state.reworkAttempts = {
    ...attempts,
    runIds: attempts.runIds.includes(input.runId)
      ? attempts.runIds
      : [...attempts.runIds, input.runId],
  };
}

function recordTerminalReworkAttempt(input: {
  state: CommentLoopStateFile;
  maxAttempts: number;
  attemptCount: number;
  commentId: string;
  processedAt: string;
  reason: string;
}): void {
  input.state.reworkAttempts = {
    maxAttempts: input.maxAttempts,
    attemptCount: input.attemptCount,
    runIds: recordedReworkRunIds(input.state),
    lastAttemptCommentId: input.state.reworkAttempts?.lastAttemptCommentId,
    lastAttemptAt: input.state.reworkAttempts?.lastAttemptAt,
    terminalReason: input.reason,
    terminalCommentId: input.commentId,
    terminalAt: input.processedAt,
  };
}

export async function processPullRequestComments(
  input: ProcessPullRequestCommentsInput,
): Promise<ProcessPullRequestCommentsResult> {
  const repoPath = resolve(input.repoPath);
  const maxReworkAttempts = maxReworkAttemptsFor(input.maxReworkAttempts);
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
    pendingApprovals: [],
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
    const routeOverride = routeOverrideForComment(input, comment.id);
    const routeNotification =
      existing?.status === "pending-approval" && existing.feedback?.id
        ? (await listNotifications(repoPath)).find(
            (candidate) =>
              candidate.sourceKey ===
              `review-feedback:${existing.feedback?.id}:route`,
          )
        : undefined;
    const approvedFromInbox =
      routeNotification?.status === "resolved" &&
      (routeNotification.resolution === "approve" ||
        routeNotification.resolution === "override");
    const canApprovePending =
      (input.approveRequiredRoutes ||
        routeOverride !== undefined ||
        approvedFromInbox) &&
      existing?.bodyHash === bodyHash &&
      existing.status === "pending-approval";
    if (existing?.bodyHash === bodyHash && !canApprovePending) {
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
    const normalizedFeedback = normalizeReviewFeedback({
      target,
      comment,
      action: command.action,
      instruction: command.instruction,
      priorRunId: input.priorRunId,
      ingestedAt: processedAt,
    });
    const feedback =
      routeOverride && isReworkTriggerAction(command.action)
        ? overrideReviewFeedbackRoute(normalizedFeedback, routeOverride)
        : normalizedFeedback;
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
            feedback,
            status: "skipped",
            processedAt,
            reason: "unauthorized author",
          }),
        );
        state.comments[comment.id] = recordFor({
          comment,
          bodyHash,
          command,
          feedback,
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
          feedback,
          status: "processed",
          processedAt,
        });
        await recordCommentProcess(location, record);
        state.comments[comment.id] = record;
      }
      result.explained.push({ commentId: comment.id, commentUrl: comment.url });
      continue;
    }

    if (
      feedback.route.requiresOperatorApproval &&
      !input.approveRequiredRoutes &&
      !canApprovePending
    ) {
      const reason = routeApprovalReason(feedback);
      if (!input.dryRun) {
        const record = recordFor({
          comment,
          bodyHash,
          command,
          feedback,
          status: "pending-approval",
          processedAt,
          reason,
        });
        state.comments[comment.id] = record;
        await saveCommentLoopState(location, state);
        await upsertNotification(repoPath, {
          sourceKey: `review-feedback:${feedback.id}:route`,
          type: "review-rework",
          severity: "warning",
          title: `Review proposed ${feedback.route.target} rework route`,
          body: reason,
          link: comment.url,
          proposalId: feedback.id,
          ...(input.priorRunId ? { runId: input.priorRunId } : {}),
        });
        try {
          const createComment = requireCreateComment(provider);
          await createComment({
            repoPath,
            remoteName: "origin",
            target,
            body: renderRouteApprovalComment({
              comment,
              feedback,
              reason,
            }),
          });
        } catch {
          // The state file remains the source of truth if posting the approval comment fails.
        }
      }
      result.pendingApprovals.push({
        commentId: comment.id,
        route: feedback.route.target,
        reason,
      });
      continue;
    }

    if (input.dryRun) {
      if (isReworkTriggerAction(command.action)) {
        const attemptCount = recordedReworkAttempts(state);
        if (attemptCount >= maxReworkAttempts) {
          result.skipped.push({
            commentId: comment.id,
            reason: reworkLimitReason(attemptCount, maxReworkAttempts),
          });
          continue;
        }
      }
      result.triggered.push({ commentId: comment.id, runId: "dry-run" });
      continue;
    }

    if (isReworkTriggerAction(command.action)) {
      const attemptCount = recordedReworkAttempts(state);
      if (attemptCount >= maxReworkAttempts) {
        const reason = reworkLimitReason(attemptCount, maxReworkAttempts);
        const record = recordFor({
          comment,
          bodyHash,
          command,
          feedback,
          status: "skipped",
          processedAt,
          reason,
        });
        state.comments[comment.id] = record;
        recordTerminalReworkAttempt({
          state,
          maxAttempts: maxReworkAttempts,
          attemptCount,
          commentId: comment.id,
          processedAt,
          reason,
        });
        await saveCommentLoopState(location, state);
        try {
          const createComment = requireCreateComment(provider);
          await createComment({
            repoPath,
            remoteName: "origin",
            target,
            body: renderReworkLimitComment({
              comment,
              maxAttempts: maxReworkAttempts,
              attemptCount,
              reason,
            }),
          });
        } catch {
          // The state file remains the source of truth if posting the terminal comment fails.
        }
        result.skipped.push({ commentId: comment.id, reason });
        continue;
      }
    }

    const materialized = await materializeCommentTriggerInputs({
      location,
      target,
      comment,
      command,
      feedback,
      priorRunId: input.priorRunId,
    });
    if (isReworkTriggerAction(command.action)) {
      beginReworkAttempt({
        state,
        maxAttempts: maxReworkAttempts,
        commentId: comment.id,
        processedAt,
      });
      await saveCommentLoopState(location, state);
    }
    let runId: string | undefined;
    try {
      const selectedFlowPath = flowPathForFeedback(input, feedback);
      const run = await (input.runFlow ?? defaultRunFlow)({
        flowPath: selectedFlowPath,
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
          feedback,
          priorRunId: input.priorRunId,
        }),
        priorRunId: input.priorRunId,
      });
      runId = run.runId;
      finishReworkAttempt({ state, runId });
      const createComment = requireCreateComment(provider);
      await createComment({
        repoPath,
        remoteName: "origin",
        target,
        body: renderReworkComment({
          runId: run.runId,
          target,
          comment,
          feedback,
          flowPath: selectedFlowPath,
          updatedHeadSha: run.updatedHeadSha,
          reworkAttempt: state.reworkAttempts
            ? {
                attemptCount: state.reworkAttempts.attemptCount,
                maxAttempts: state.reworkAttempts.maxAttempts,
              }
            : undefined,
        }),
      });
      const feedbackWithRun = withTriggeredRunId(feedback, run.runId);
      const materializedFeedback = await materializeFeedbackMemoryProposals({
        repoPath,
        feedback: feedbackWithRun,
      });
      const record = recordFor({
        comment,
        bodyHash,
        command,
        feedback: materializedFeedback.feedback,
        status: "triggered",
        processedAt,
        runId: run.runId,
      });
      state.comments[comment.id] = record;
      await saveCommentLoopState(location, state);
      if (canApprovePending) {
        const sourceKey = `review-feedback:${feedback.id}:route`;
        const notification = (await listNotifications(repoPath)).find(
          (candidate) =>
            candidate.sourceKey === sourceKey && candidate.status === "pending",
        );
        if (notification) {
          const action = routeOverride ? "override" : "approve";
          const reason = routeOverride
            ? `Operator selected the ${feedback.route.target} rework route.`
            : undefined;
          await recordNotificationDecision(repoPath, notification, {
            actorId: "operator",
            action,
            ...(reason ? { reason } : {}),
          });
          await resolveNotification(repoPath, notification.id, {
            actorId: "operator",
            resolution: action,
            ...(reason ? { reason } : {}),
          });
        }
      }
      result.triggered.push({ commentId: comment.id, runId: run.runId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const record = recordFor({
        comment,
        bodyHash,
        command,
        feedback: runId ? withTriggeredRunId(feedback, runId) : feedback,
        status: "failed",
        processedAt,
        runId,
        reason,
      });
      if (runId) {
        finishReworkAttempt({ state, runId });
      }
      state.comments[comment.id] = record;
      await saveCommentLoopState(location, state);
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
