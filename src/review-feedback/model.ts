import type {
  ChangeRequestTarget,
  PullRequestDiscussionItem,
} from "../scm/types.js";

export type ReviewFeedbackAction = "rework" | "address" | "explain";

export type ReviewFeedbackRouteTarget =
  | "implementation"
  | "spec"
  | "tech-design"
  | "workflow"
  | "memory"
  | "explanation";

export type ReviewFeedbackRouteConfidence = "explicit" | "inferred";

export interface ReviewFeedbackRoute {
  target: ReviewFeedbackRouteTarget;
  confidence: ReviewFeedbackRouteConfidence;
  reason: string;
  requiresOperatorApproval: boolean;
}

export interface RawReviewFeedbackEvidence {
  provider: "github";
  kind: PullRequestDiscussionItem["kind"];
  commentId: string;
  commentUrl: string;
  body: string;
  authorLogin: string;
  authorAssociation?: string;
  createdAt: string;
  updatedAt?: string;
  path?: string;
  line?: number;
  inReplyToId?: string;
}

export interface ReviewFeedbackLineage {
  provider: "github";
  owner: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  priorRunId?: string;
  triggeredRunId?: string;
  ingestedAt: string;
}

export interface ReviewFeedbackMemoryProposal {
  contextKnowledgeEntryId?: string;
  contextKnowledgeStatus?: "approved" | "proposed" | "rejected";
  contextKnowledgeVersion?: number;
  category: "feedback";
  title: string;
  body: string;
  status: "proposed";
  tags: string[];
  keywords: string[];
  source: {
    type: "review";
    uri: string;
    runId?: string;
  };
}

export interface NormalizedReviewFeedback {
  schemaVersion: 1;
  id: string;
  source: "github-pr-discussion";
  action: ReviewFeedbackAction;
  instruction: string;
  raw: RawReviewFeedbackEvidence;
  route: ReviewFeedbackRoute;
  lineage: ReviewFeedbackLineage;
  memoryProposals: ReviewFeedbackMemoryProposal[];
}

export interface NormalizeReviewFeedbackInput {
  target: ChangeRequestTarget;
  comment: PullRequestDiscussionItem;
  action: ReviewFeedbackAction;
  instruction: string;
  priorRunId?: string;
  ingestedAt: string;
}

const explicitRoutePrefixes: Array<{
  target: ReviewFeedbackRouteTarget;
  pattern: RegExp;
  reason: string;
}> = [
  {
    target: "spec",
    pattern: /^(?:spec|requirements?|acceptance criteria|user stor(?:y|ies))\s*:/i,
    reason: "Instruction explicitly targets the specification artifact.",
  },
  {
    target: "tech-design",
    pattern: /^(?:tech(?:nical)? design|design|architecture|api contract|data model)\s*:/i,
    reason: "Instruction explicitly targets the technical design artifact.",
  },
  {
    target: "workflow",
    pattern: /^(?:workflow|flow|template|runner|harness|approval|review gate)\s*:/i,
    reason: "Instruction explicitly targets workflow behavior.",
  },
  {
    target: "memory",
    pattern: /^(?:memory|remember|convention|lesson|pitfall)\s*:/i,
    reason: "Instruction explicitly targets reusable project memory.",
  },
  {
    target: "implementation",
    pattern: /^(?:implementation|code|fix|tests?)\s*:/i,
    reason: "Instruction explicitly targets implementation work.",
  },
];

const inferredRoutePatterns: Array<{
  target: ReviewFeedbackRouteTarget;
  pattern: RegExp;
  reason: string;
}> = [
  {
    target: "memory",
    pattern: /\b(?:remember|future runs?|always|never|convention|lesson|pitfall)\b/i,
    reason: "Feedback describes reusable knowledge for future runs.",
  },
  {
    target: "spec",
    pattern: /\b(?:spec|requirement|acceptance criteria|user stor(?:y|ies)|functional requirement)\b/i,
    reason: "Feedback refers to product requirements or acceptance criteria.",
  },
  {
    target: "tech-design",
    pattern: /\b(?:technical design|architecture|api contract|data model|migration|interface)\b/i,
    reason: "Feedback refers to design or architecture decisions.",
  },
  {
    target: "workflow",
    pattern: /\b(?:workflow|flow template|nitely|runner|harness|evidence|approval|review gate|orchestrator)\b/i,
    reason: "Feedback refers to workflow, evidence, or orchestration behavior.",
  },
];

function routeRequiresApproval(target: ReviewFeedbackRouteTarget): boolean {
  return (
    target === "spec" ||
    target === "tech-design" ||
    target === "workflow" ||
    target === "memory"
  );
}

function classifyFeedbackRoute(
  action: ReviewFeedbackAction,
  instruction: string,
  comment: PullRequestDiscussionItem,
): ReviewFeedbackRoute {
  if (action === "explain") {
    return {
      target: "explanation",
      confidence: "explicit",
      reason: "The reviewer asked Nitely for an explanation instead of a rework run.",
      requiresOperatorApproval: false,
    };
  }

  const text = instruction;
  for (const candidate of explicitRoutePrefixes) {
    if (candidate.pattern.test(instruction)) {
      return {
        target: candidate.target,
        confidence: "explicit",
        reason: candidate.reason,
        requiresOperatorApproval: routeRequiresApproval(candidate.target),
      };
    }
  }
  for (const candidate of inferredRoutePatterns) {
    if (candidate.pattern.test(text)) {
      return {
        target: candidate.target,
        confidence: "inferred",
        reason: candidate.reason,
        requiresOperatorApproval: routeRequiresApproval(candidate.target),
      };
    }
  }

  return {
    target: "implementation",
    confidence: "inferred",
    reason: "Default route for code, tests, or localized PR review feedback.",
    requiresOperatorApproval: false,
  };
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function extractKeywords(value: string, target: ReviewFeedbackRouteTarget): string[] {
  const seen = new Set<string>(["review", "feedback", target]);
  const keywords = ["review", "feedback", target];
  for (const token of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= 10) break;
  }
  return keywords;
}

function memoryProposal(input: {
  instruction: string;
  commentUrl: string;
  route: ReviewFeedbackRoute;
  runId?: string;
}): ReviewFeedbackMemoryProposal | undefined {
  if (input.route.target !== "memory") {
    return undefined;
  }
  const title = `Review feedback: ${truncate(input.instruction, 72)}`;
  return {
    category: "feedback",
    title,
    body: [
      `Reviewer feedback candidate from ${input.commentUrl}:`,
      "",
      input.instruction,
    ].join("\n"),
    status: "proposed",
    tags: ["review-feedback", input.route.target],
    keywords: extractKeywords(input.instruction, input.route.target),
    source: {
      type: "review",
      uri: input.commentUrl,
      ...(input.runId ? { runId: input.runId } : {}),
    },
  };
}

export function normalizeReviewFeedback(
  input: NormalizeReviewFeedbackInput,
): NormalizedReviewFeedback {
  const instruction = input.instruction.trim();
  const route = classifyFeedbackRoute(input.action, instruction, input.comment);
  const proposal = memoryProposal({
    instruction,
    commentUrl: input.comment.url,
    route,
  });
  return {
    schemaVersion: 1,
    id: `github:${input.target.owner}/${input.target.repository}#${input.target.number}:comment:${input.comment.id}`,
    source: "github-pr-discussion",
    action: input.action,
    instruction,
    raw: {
      provider: "github",
      kind: input.comment.kind,
      commentId: input.comment.id,
      commentUrl: input.comment.url,
      body: input.comment.body,
      authorLogin: input.comment.authorLogin,
      ...(input.comment.authorAssociation
        ? { authorAssociation: input.comment.authorAssociation }
        : {}),
      createdAt: input.comment.createdAt,
      ...(input.comment.updatedAt ? { updatedAt: input.comment.updatedAt } : {}),
      ...(input.comment.path ? { path: input.comment.path } : {}),
      ...(typeof input.comment.line === "number" ? { line: input.comment.line } : {}),
      ...(input.comment.inReplyToId ? { inReplyToId: input.comment.inReplyToId } : {}),
    },
    route,
    lineage: {
      provider: "github",
      owner: input.target.owner,
      repository: input.target.repository,
      prNumber: input.target.number,
      prUrl: input.target.url,
      ...(input.priorRunId ? { priorRunId: input.priorRunId } : {}),
      ingestedAt: input.ingestedAt,
    },
    memoryProposals: proposal ? [proposal] : [],
  };
}

export function overrideReviewFeedbackRoute(
  feedback: NormalizedReviewFeedback,
  target: ReviewFeedbackRouteTarget,
): NormalizedReviewFeedback {
  if (target === "explanation") {
    throw new Error("review feedback rework routes cannot be overridden to explanation");
  }
  const route: ReviewFeedbackRoute = {
    target,
    confidence: "explicit",
    reason: [
      `Operator override selected the ${target} route.`,
      `Previous route was ${feedback.route.target} (${feedback.route.confidence}): ${feedback.route.reason}`,
    ].join(" "),
    requiresOperatorApproval: routeRequiresApproval(target),
  };
  const proposal = memoryProposal({
    instruction: feedback.instruction,
    commentUrl: feedback.raw.commentUrl,
    route,
  });
  return {
    ...feedback,
    route,
    memoryProposals: proposal ? [proposal] : [],
  };
}

export function withTriggeredRunId(
  feedback: NormalizedReviewFeedback,
  runId: string,
): NormalizedReviewFeedback {
  return {
    ...feedback,
    lineage: {
      ...feedback.lineage,
      triggeredRunId: runId,
    },
    memoryProposals: feedback.memoryProposals.map((proposal) => ({
      ...proposal,
      source: {
        ...proposal.source,
        runId,
      },
    })),
  };
}
