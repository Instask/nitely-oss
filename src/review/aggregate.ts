import type {
  ReviewGateSpecificIssue,
  ReviewGateVerdict,
  ReviewGateVerdictRouting,
} from "../artifacts/types.js";
import {
  criticalReviewFindingReason,
  parseReviewGateVerdict,
} from "../run/review-verdict.js";

export type ReviewPerspectiveStatus = "approved" | "blocked" | "missing";

export interface ReviewPerspectiveResult {
  /** Artifact id of the perspective's review output. */
  id: string;
  status: ReviewPerspectiveStatus;
  verdict?: ReviewGateVerdict;
  /** Why this perspective blocks, or how it approved. */
  reason: string;
  findings: ReviewGateSpecificIssue[];
}

export interface AggregatedReviewDecision {
  status: "approved" | "blocked";
  perspectives: ReviewPerspectiveResult[];
  /** Ids of the perspectives that block, in declaration order. */
  blockingPerspectives: string[];
  /** Single-sentence gate reason, present only when blocked. */
  reason?: string;
  /** Routing carried from the most severe blocking perspective. */
  routing?: ReviewGateVerdictRouting;
  /** Deduplicated union of every perspective's specific issues. */
  findings: ReviewGateSpecificIssue[];
}

/**
 * The two verdicts that clear a perspective. `blockingReviewReason` trusts both
 * for a single review, and every checked-in flow prompt asks reviewers for
 * `Review verdict: pass`, so an aggregate that only recognized `approved` would
 * block on a clean review.
 */
function approves(verdict: ReviewGateVerdict | undefined): boolean {
  return verdict === "approved" || verdict === "pass";
}

/**
 * Severity ladder used to pick one routing verdict out of several blocking
 * perspectives. A perspective that approves but raises a critical finding is
 * normalized to `needs_fix` before it is ranked here, so the approving rungs
 * are unreachable in practice and exist only to keep the ladder total.
 *
 * `fail` and `needs_fix` share a rung: both mean "the change is wrong", and
 * `fail` carries its destination in `reworkTarget` rather than in its severity.
 * Equal rungs resolve to the earliest declared perspective, matching the
 * declaration order that `blockingPerspectives` reports.
 */
const VERDICT_SEVERITY: Record<ReviewGateVerdict, number> = {
  approved: 0,
  pass: 0,
  fail: 1,
  needs_fix: 1,
  needs_rework_spec: 2,
  escalate: 3,
};

function findingKey(issue: ReviewGateSpecificIssue): string {
  return `${issue.file ?? ""}:${issue.line ?? ""}:${issue.problem}`;
}

function mergeFindings(
  perspectives: readonly ReviewPerspectiveResult[],
): ReviewGateSpecificIssue[] {
  const merged = new Map<string, ReviewGateSpecificIssue>();
  for (const perspective of perspectives) {
    for (const finding of perspective.findings) {
      const key = findingKey(finding);
      if (!merged.has(key)) {
        merged.set(key, finding);
      }
    }
  }
  return [...merged.values()];
}

function evaluatePerspective(input: {
  id: string;
  content: string | undefined;
}): ReviewPerspectiveResult {
  const content = input.content?.trim() ?? "";
  if (content.length === 0) {
    return {
      id: input.id,
      status: "missing",
      reason: "produced no review output",
      findings: [],
    };
  }
  const routing = parseReviewGateVerdict(content);
  const findings = routing?.specificIssues ?? [];
  if (!routing) {
    return {
      id: input.id,
      status: "blocked",
      reason: "stated no review verdict",
      findings,
    };
  }
  const critical = criticalReviewFindingReason(content);
  if (approves(routing.verdict) && !critical) {
    return {
      id: input.id,
      status: "approved",
      verdict: routing.verdict,
      reason: routing.verdict,
      findings,
    };
  }
  // An approving verdict that still carries a critical finding is demoted
  // instead of trusted: merging findings means failing closed on any critical.
  const verdict = approves(routing.verdict) ? "needs_fix" : routing.verdict;
  const reason = approves(routing.verdict)
    ? `${routing.verdict} with ${critical}`
    : routing.reason
      ? `${verdict}: ${routing.reason}`
      : verdict;
  return {
    id: input.id,
    status: "blocked",
    verdict,
    reason,
    findings,
  };
}

function routingFor(
  perspectives: readonly ReviewPerspectiveResult[],
  routings: ReadonlyMap<string, ReviewGateVerdictRouting>,
): ReviewGateVerdictRouting | undefined {
  let selected: ReviewPerspectiveResult | undefined;
  for (const perspective of perspectives) {
    if (perspective.status === "approved") continue;
    const verdict = perspective.verdict ?? "needs_fix";
    const currentSeverity = selected
      ? VERDICT_SEVERITY[selected.verdict ?? "needs_fix"]
      : -1;
    if (VERDICT_SEVERITY[verdict] > currentSeverity) {
      selected = perspective;
    }
  }
  if (!selected) return undefined;
  const source = routings.get(selected.id);
  const verdict = selected.verdict ?? "needs_fix";
  return {
    verdict,
    reason: `${selected.id} reported ${selected.reason}`,
    ...(source?.targetStage ? { targetStage: source.targetStage } : {}),
    ...(source?.targetArtifact
      ? { targetArtifact: source.targetArtifact }
      : {}),
    // A `fail` verdict states its destination here rather than in
    // target{Stage,Artifact}; dropping it would lose the rework target that
    // `decideReviewRouting` resolves.
    ...(source?.reworkTarget ? { reworkTarget: source.reworkTarget } : {}),
    ...(source?.instructions ? { instructions: source.instructions } : {}),
  };
}

/**
 * Aggregate several independent review perspectives into one gate decision.
 *
 * The rule is deliberately the simplest one that is still safe: every declared
 * perspective must explicitly approve, and any critical finding from any
 * perspective blocks. Missing output, an unreadable verdict, and a blocking
 * verdict are all the same answer — blocked — so a perspective that never ran
 * can never be mistaken for one that passed.
 */
export function aggregateReviewPerspectives(input: {
  /** Declared perspective artifact ids, in flow order. */
  declared: readonly string[];
  /** Perspective artifact id to review output content. */
  outputs: ReadonlyMap<string, string>;
}): AggregatedReviewDecision {
  const routings = new Map<string, ReviewGateVerdictRouting>();
  const perspectives = input.declared.map((id) => {
    const content = input.outputs.get(id);
    const routing = content ? parseReviewGateVerdict(content) : undefined;
    if (routing) {
      routings.set(id, routing);
    }
    return evaluatePerspective({ id, content });
  });
  const blocking = perspectives.filter(
    (perspective) => perspective.status !== "approved",
  );
  const findings = mergeFindings(perspectives);
  if (blocking.length === 0) {
    return {
      status: "approved",
      perspectives,
      blockingPerspectives: [],
      findings,
    };
  }
  const detail = blocking
    .map((perspective) => `${perspective.id} ${perspective.reason}`)
    .join("; ");
  const routing = routingFor(perspectives, routings);
  return {
    status: "blocked",
    perspectives,
    blockingPerspectives: blocking.map((perspective) => perspective.id),
    reason: `${blocking.length} of ${perspectives.length} review perspectives blocked: ${detail}`,
    ...(routing ? { routing } : {}),
    findings,
  };
}

/**
 * A review gate registers its output as the gate-result JSON, so a downstream
 * stage that consumes the review by id receives that record rather than the
 * reviewer's markdown. Unwrap it; anything else is already review text.
 */
export function reviewPerspectiveText(input: {
  content: string;
  mediaType?: string;
}): string {
  if (input.mediaType !== "application/json") {
    return input.content;
  }
  try {
    const parsed = JSON.parse(input.content) as {
      reviewOutput?: { content?: unknown };
    };
    const content = parsed?.reviewOutput?.content;
    return typeof content === "string" ? content : input.content;
  } catch {
    return input.content;
  }
}

function findingLine(issue: ReviewGateSpecificIssue): string {
  const location = issue.file
    ? issue.line !== undefined
      ? `${issue.file}:${issue.line}`
      : issue.file
    : undefined;
  return location ? `- ${location}: ${issue.problem}` : `- ${issue.problem}`;
}

export function renderAggregatedReviewMarkdown(
  decision: AggregatedReviewDecision,
): string {
  const approvedCount = decision.perspectives.filter(
    (perspective) => perspective.status === "approved",
  ).length;
  const lines = [
    "# Aggregated Review",
    "",
    `Review verdict: ${decision.status === "approved" ? "approved" : (decision.routing?.verdict ?? "needs_fix")}`,
    `Perspectives: ${approvedCount} of ${decision.perspectives.length} approved`,
  ];
  if (decision.reason) {
    lines.push(`Reason: ${decision.reason}`);
  }
  if (decision.routing?.targetStage) {
    lines.push(`Target stage: ${decision.routing.targetStage}`);
  }
  if (decision.routing?.targetArtifact) {
    lines.push(`Target artifact: ${decision.routing.targetArtifact}`);
  }
  if (decision.routing?.instructions) {
    lines.push(`Instructions: ${decision.routing.instructions}`);
  }
  lines.push("", "## Perspectives", "");
  for (const perspective of decision.perspectives) {
    lines.push(`- ${perspective.id}: ${perspective.status} (${perspective.reason})`);
  }
  lines.push("", "## Merged findings", "");
  if (decision.findings.length === 0) {
    lines.push("none");
  } else {
    for (const finding of decision.findings) {
      lines.push(findingLine(finding));
    }
  }
  return `${lines.join("\n")}\n`;
}
