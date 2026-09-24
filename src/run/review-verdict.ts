import type {
  ReviewGateSpecificIssue,
  ReviewGateVerdict,
  ReviewGateVerdictRouting,
} from "../artifacts/types.js";

export function blockingReviewReason(content: string): string | undefined {
  const verdict = parseReviewGateVerdict(content);
  if (verdict?.verdict === "approved" || verdict?.verdict === "pass") {
    return undefined;
  }
  if (verdict?.verdict === "fail") {
    return verdict.reworkTarget
      ? `a failing verdict targeting ${verdict.reworkTarget}`
      : "a failing verdict";
  }
  if (verdict?.verdict === "needs_fix") {
    return "a needs_fix verdict";
  }
  if (verdict?.verdict === "needs_rework_spec") {
    return "a needs_rework_spec verdict";
  }
  if (verdict?.verdict === "escalate") {
    return "an escalation verdict";
  }
  return criticalReviewFindingReason(content);
}

/**
 * Blocking markers that stand on their own, independent of any declared
 * verdict. `blockingReviewReason` trusts an `approved` verdict and stops
 * early; an aggregation of several perspectives must not, because merging
 * findings means failing closed on any critical finding even when the
 * perspective that raised it still called the change approved.
 */
export function criticalReviewFindingReason(
  content: string,
): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (
      /^\s*(review\s+verdict|verdict)\s*:\s*(fail|failed|block|blocked)\b/i.test(
        line,
      )
    ) {
      return "a failing verdict";
    }
    if (/^\s*#{1,6}\s*P[01]\b/i.test(line)) {
      return "blocking findings";
    }
    if (/^\s*(?:#{1,6}\s*)?\[P[01]\]\b/i.test(line)) {
      return "blocking findings";
    }
  }
  return undefined;
}

function normalizeReviewVerdict(value: string): ReviewGateVerdict | undefined {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pass", "passed"].includes(normalized)) {
    return "pass";
  }
  if (["approved", "approve"].includes(normalized)) {
    return "approved";
  }
  if (["fail", "failed", "block", "blocked"].includes(normalized)) {
    return "fail";
  }
  if (
    [
      "needs_fix",
      "need_fix",
      "fix",
      "code_fix",
      "needs_code_fix",
      "needs_implementation_fix",
    ].includes(normalized)
  ) {
    return "needs_fix";
  }
  if (
    [
      "needs_rework_spec",
      "needs_spec_rework",
      "spec_rework",
      "needs_rework_plan",
      "needs_plan_rework",
      "planning_rework",
    ].includes(normalized)
  ) {
    return "needs_rework_spec";
  }
  if (["escalate", "escalated", "manual", "needs_human"].includes(normalized)) {
    return "escalate";
  }
  return undefined;
}

/**
 * Reads `<field>: <value>` from one line. Reviewers write the contract line
 * as prose, as a list item, as a Markdown heading (`## Review verdict: pass`)
 * or in bold (`**Review verdict:** pass`); all of those carry the same
 * field, so the markup around it is stripped before matching.
 */
function reviewFieldValue(line: string, field: string): string | undefined {
  const stripped = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+$/, "");
  const match = stripped.match(
    new RegExp(`^\\s*(?:[-*]\\s*)?${field}\\s*:\\s*(.+)$`, "i"),
  );
  return match?.[1]?.trim() || undefined;
}

function parseReviewSpecificIssue(
  line: string,
): ReviewGateSpecificIssue | undefined {
  const match = line.match(
    /^\s*(?:[-*]\s*)?([A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]+):(\d+):\s*(.+)$/,
  );
  if (!match) return undefined;
  return {
    file: match[1],
    line: Number(match[2]),
    problem: match[3]!.trim(),
  };
}

export function parseReviewGateVerdict(
  content: string,
): ReviewGateVerdictRouting | undefined {
  let verdict: ReviewGateVerdict | undefined;
  let reason: string | undefined;
  let targetStage: string | undefined;
  let targetArtifact: string | undefined;
  let reworkTarget: string | undefined;
  let instructions: string | undefined;
  const specificIssues: ReviewGateSpecificIssue[] = [];

  for (const line of content.split(/\r?\n/)) {
    const verdictText =
      reviewFieldValue(line, "review\\s+verdict") ??
      reviewFieldValue(line, "verdict");
    if (verdictText) {
      verdict = normalizeReviewVerdict(verdictText) ?? verdict;
    }
    reason = reviewFieldValue(line, "reason") ?? reason;
    targetStage =
      reviewFieldValue(line, "target\\s+stage") ??
      reviewFieldValue(line, "target_stage") ??
      targetStage;
    targetArtifact =
      reviewFieldValue(line, "target\\s+artifact") ??
      reviewFieldValue(line, "target_artifact") ??
      targetArtifact;
    reworkTarget =
      reviewFieldValue(line, "reworkTarget") ??
      reviewFieldValue(line, "rework\\s+target") ??
      reworkTarget;
    instructions =
      reviewFieldValue(line, "instructions") ??
      reviewFieldValue(line, "instruction") ??
      instructions;
    const issue = parseReviewSpecificIssue(line);
    if (issue) {
      specificIssues.push(issue);
    }
  }

  if (!verdict) return undefined;
  return {
    verdict,
    ...(reason ? { reason } : {}),
    ...(targetStage ? { targetStage } : {}),
    ...(targetArtifact ? { targetArtifact } : {}),
    ...(reworkTarget ? { reworkTarget, targetArtifact: targetArtifact ?? reworkTarget } : {}),
    ...(instructions ? { instructions } : {}),
    ...(specificIssues.length > 0 ? { specificIssues } : {}),
  };
}

export function hasManualReviewDecision(content: string): boolean {
  return (
    parseReviewGateVerdict(content) !== undefined ||
    blockingReviewReason(content) !== undefined
  );
}
