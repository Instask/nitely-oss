import { parseReviewGateVerdict } from "../run/review-verdict.js";
import type { EvalCase } from "./manifest.js";

export type ReviewerFindingSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface NormalizedReviewerFinding {
  id: string;
  category: string;
  severity: ReviewerFindingSeverity;
  file?: string;
  line?: number;
  lineEnd?: number;
  requirement?: string;
  evidence: string;
  verdictImpact: "blocking" | "advisory";
}

export interface ReviewerFindingMatch {
  findingId: string;
  defectId?: string;
  status: "matched" | "ambiguous" | "unmatched";
  method: "exact-id" | "path-category" | "path" | "category" | "none";
  evidence: string;
}

export interface ReviewerCaseScore {
  schemaVersion: "nitely.reviewer-case-score.v1";
  knownGood: boolean;
  provenance?: {
    sourceRevision: string;
    flowSha256: string;
    contextPolicySha256: string;
    manifestSha256: string;
    stages: Array<{ stageId: string; runtime: string; model: string }>;
    latencyMs?: number;
    usage?: {
      totalTokens?: number;
      actualCostUsd?: number;
      estimatedCostUsd?: number;
    };
  };
  verdict?: string;
  findings: NormalizedReviewerFinding[];
  matches: ReviewerFindingMatch[];
  missedDefectIds: string[];
  metrics: {
    criticalDefectCount: number;
    criticalDefectsDetected: number;
    defectCount: number;
    defectsDetected: number;
    falsePositiveCount: number;
    falsePositiveRate: number;
    passOnDefective: boolean;
    failOnKnownGood: boolean;
  };
}

export interface ReviewerCohortMetrics {
  sampleCount: number;
  coveredCaseCount: number;
  criticalDefectCount: number;
  criticalDefectsDetected: number;
  defectCount: number;
  defectsDetected: number;
  falsePositiveCount: number;
  knownGoodFalsePositiveCount: number;
  defectiveFalsePositiveCount: number;
  findingCount: number;
  knownGoodCaseCount: number;
  knownGoodFailures: number;
  defectiveCaseCount: number;
  defectivePasses: number;
  criticalDefectRecall: number;
  overallDefectRecall: number;
  falsePositiveRate: number;
  knownGoodFalsePositiveRate: number;
  defectiveFalsePositiveRate: number;
  passOnDefectiveRate: number;
  failOnKnownGoodRate: number;
  findingsByCategory: Record<string, number>;
}

interface RawFinding {
  id?: unknown;
  category?: unknown;
  severity?: unknown;
  file?: unknown;
  path?: unknown;
  line?: unknown;
  lineEnd?: unknown;
  requirement?: unknown;
  evidence?: unknown;
  rationale?: unknown;
  problem?: unknown;
  verdictImpact?: unknown;
}

type ReviewEvaluation = NonNullable<EvalCase["reviewEvaluation"]>;
type ExpectedDefect = ReviewEvaluation["expectedDefects"][number];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function severity(value: unknown, evidence: string): ReviewerFindingSeverity {
  const normalized = text(value)?.toLowerCase();
  if (normalized === "critical" || normalized === "p0") return "critical";
  if (normalized === "high" || normalized === "p1") return "high";
  if (normalized === "medium" || normalized === "p2") return "medium";
  if (normalized === "low" || normalized === "p3") return "low";
  if (/\bP0\b/i.test(evidence)) return "critical";
  if (/\bP1\b/i.test(evidence)) return "high";
  if (/\bP2\b/i.test(evidence)) return "medium";
  if (/\bP3\b/i.test(evidence)) return "low";
  return "unknown";
}

function verdictImpact(value: unknown, severityValue: ReviewerFindingSeverity): "blocking" | "advisory" {
  const normalized = text(value)?.toLowerCase();
  if (normalized === "advisory" || normalized === "non-blocking") return "advisory";
  return normalized === "blocking" || severityValue === "critical" || severityValue === "high"
    ? "blocking"
    : "advisory";
}

function rawFindingsFromContent(content: string): {
  verdict?: string;
  findings: RawFinding[];
} {
  try {
    const parsed = record(JSON.parse(content));
    const findings: RawFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.map((finding): RawFinding =>
          typeof finding === "string"
            ? { evidence: finding, problem: finding }
            : record(finding),
        )
      : [];
    const parsedVerdict = text(parsed.verdict);
    if (findings.length > 0 || parsedVerdict) {
      return { verdict: parsedVerdict, findings };
    }
  } catch {
    // Existing Markdown review output is parsed below.
  }

  const routing = parseReviewGateVerdict(content);
  const findings = routing?.specificIssues?.map((issue, index) => ({
    id: `review-finding-${index + 1}`,
    file: issue.file,
    line: issue.line,
    problem: issue.problem,
    evidence: issue.problem,
  })) ?? [];
  return { verdict: routing?.verdict, findings };
}

export function normalizeReviewerOutput(input: {
  stageId: string;
  content?: string;
  judge?: { verdict?: unknown; findings?: unknown };
}): { verdict?: string; findings: NormalizedReviewerFinding[] } {
  const parsed = input.content !== undefined
    ? rawFindingsFromContent(input.content)
    : {
        verdict: text(input.judge?.verdict),
          findings: Array.isArray(input.judge?.findings)
          ? input.judge.findings.map((finding): RawFinding => ({
              evidence: typeof finding === "string" ? finding : JSON.stringify(finding),
              problem: typeof finding === "string" ? finding : JSON.stringify(finding),
            }))
          : [],
      };
  const findings = parsed.findings.map((finding, index) => {
    const evidence = text(finding.evidence) ?? text(finding.rationale) ??
      text(finding.problem) ?? "reviewer finding";
    const findingSeverity = severity(finding.severity, evidence);
    return {
      id: text(finding.id) ?? `${input.stageId}-finding-${index + 1}`,
      category: text(finding.category) ?? "unspecified",
      severity: findingSeverity,
      ...(text(finding.file ?? finding.path) ? { file: text(finding.file ?? finding.path) } : {}),
      ...(positiveInteger(finding.line) ? { line: positiveInteger(finding.line) } : {}),
      ...(positiveInteger(finding.lineEnd) ? { lineEnd: positiveInteger(finding.lineEnd) } : {}),
      ...(text(finding.requirement) ? { requirement: text(finding.requirement) } : {}),
      evidence,
      verdictImpact: verdictImpact(finding.verdictImpact, findingSeverity),
    };
  });
  return { ...(parsed.verdict ? { verdict: parsed.verdict } : {}), findings };
}

function matchingCandidates(
  finding: NormalizedReviewerFinding,
  defects: ReviewEvaluation["expectedDefects"],
): ExpectedDefect[] {
  return defects.filter((defect) => {
    const pathMatches = finding.file !== undefined && defect.file !== undefined &&
      finding.file === defect.file;
    const categoryMatches = finding.category !== "unspecified" &&
      finding.category === defect.category;
    const requirementMatches = finding.requirement !== undefined &&
      defect.requirement !== undefined && finding.requirement === defect.requirement;
    return pathMatches || categoryMatches || requirementMatches;
  });
}

export function scoreReviewerCase(input: {
  evalCase: EvalCase;
  output: { verdict?: string; findings: NormalizedReviewerFinding[] };
}): ReviewerCaseScore {
  const review = input.evalCase.reviewEvaluation;
  if (!review) throw new Error(`eval case has no reviewEvaluation: ${input.evalCase.id}`);
  const defects = review.expectedDefects;
  const matched = new Set<string>();
  const matches = input.output.findings.map((finding) => {
    const exact = defects.find((defect) => defect.id === finding.id);
    if (exact && !matched.has(exact.id)) {
      matched.add(exact.id);
      return {
        findingId: finding.id,
        defectId: exact.id,
        status: "matched" as const,
        method: "exact-id" as const,
        evidence: `finding id ${finding.id} exactly names defect ${exact.id}`,
      };
    }
    const candidates = matchingCandidates(finding, defects).filter(
      (defect) => !matched.has(defect.id),
    );
    if (candidates.length > 1) {
      return {
        findingId: finding.id,
        status: "ambiguous" as const,
        method: "none" as const,
        evidence: `finding matches multiple unclaimed defects: ${candidates.map((entry) => entry.id).join(", ")}`,
      };
    }
    const candidate = candidates[0];
    if (candidate) {
      matched.add(candidate.id);
      const pathMatches = finding.file !== undefined && finding.file === candidate.file;
      const categoryMatches = finding.category !== "unspecified" && finding.category === candidate.category;
      return {
        findingId: finding.id,
        defectId: candidate.id,
        status: "matched" as const,
        method: pathMatches && categoryMatches ? "path-category" as const : pathMatches ? "path" as const : "category" as const,
        evidence: `deterministic ${pathMatches && categoryMatches ? "path and category" : pathMatches ? "path" : "category"} hint matched defect ${candidate.id}`,
      };
    }
    return {
      findingId: finding.id,
      status: "unmatched" as const,
      method: "none" as const,
      evidence: "no unique deterministic gold defect match",
    };
  });
  const detected = new Set(
    matches.flatMap((match) => match.status === "matched" && match.defectId ? [match.defectId] : []),
  );
  const criticalDefectCount = defects.filter((defect) => defect.severity === "critical").length;
  const criticalDefectsDetected = defects.filter(
    (defect) => defect.severity === "critical" && detected.has(defect.id),
  ).length;
  const falsePositiveCount = matches.filter((match) => match.status !== "matched").length;
  const verdict = input.output.verdict?.toLowerCase().replace(/[ -]+/g, "_");
  const passed = verdict === "pass" || verdict === "passed" || verdict === "approved";
  return {
    schemaVersion: "nitely.reviewer-case-score.v1",
    knownGood: review.knownGood,
    ...(input.output.verdict ? { verdict: input.output.verdict } : {}),
    findings: input.output.findings,
    matches,
    missedDefectIds: defects.filter((defect) => !detected.has(defect.id)).map((defect) => defect.id),
    metrics: {
      criticalDefectCount,
      criticalDefectsDetected,
      defectCount: defects.length,
      defectsDetected: detected.size,
      falsePositiveCount,
      falsePositiveRate: input.output.findings.length === 0
        ? 0
        : falsePositiveCount / input.output.findings.length,
      passOnDefective: !review.knownGood && passed,
      failOnKnownGood: review.knownGood && !passed,
    },
  };
}

export function aggregateReviewerMetrics(
  scores: readonly ReviewerCaseScore[],
): ReviewerCohortMetrics {
  const knownGoodScores = scores.filter((score) => score.knownGood);
  const defectiveScores = scores.filter((score) => !score.knownGood);
  const criticalDefectCount = scores.reduce((sum, score) => sum + score.metrics.criticalDefectCount, 0);
  const criticalDefectsDetected = scores.reduce((sum, score) => sum + score.metrics.criticalDefectsDetected, 0);
  const defectCount = scores.reduce((sum, score) => sum + score.metrics.defectCount, 0);
  const defectsDetected = scores.reduce((sum, score) => sum + score.metrics.defectsDetected, 0);
  const falsePositiveCount = scores.reduce((sum, score) => sum + score.metrics.falsePositiveCount, 0);
  const knownGoodFalsePositiveCount = knownGoodScores.reduce(
    (sum, score) => sum + score.metrics.falsePositiveCount,
    0,
  );
  const defectiveFalsePositiveCount = defectiveScores.reduce(
    (sum, score) => sum + score.metrics.falsePositiveCount,
    0,
  );
  const findingCount = scores.reduce((sum, score) => sum + score.findings.length, 0);
  const knownGoodFindingCount = knownGoodScores.reduce((sum, score) => sum + score.findings.length, 0);
  const defectiveFindingCount = defectiveScores.reduce((sum, score) => sum + score.findings.length, 0);
  const findingsByCategory: Record<string, number> = {};
  for (const score of scores) {
    for (const finding of score.findings) {
      findingsByCategory[finding.category] = (findingsByCategory[finding.category] ?? 0) + 1;
    }
  }
  return {
    sampleCount: scores.length,
    coveredCaseCount: scores.length,
    criticalDefectCount,
    criticalDefectsDetected,
    defectCount,
    defectsDetected,
    falsePositiveCount,
    knownGoodFalsePositiveCount,
    defectiveFalsePositiveCount,
    findingCount,
    knownGoodCaseCount: knownGoodScores.length,
    knownGoodFailures: knownGoodScores.filter((score) => score.metrics.failOnKnownGood).length,
    defectiveCaseCount: defectiveScores.length,
    defectivePasses: defectiveScores.filter((score) => score.metrics.passOnDefective).length,
    criticalDefectRecall: criticalDefectCount === 0 ? 1 : criticalDefectsDetected / criticalDefectCount,
    overallDefectRecall: defectCount === 0 ? 1 : defectsDetected / defectCount,
    falsePositiveRate: findingCount === 0 ? 0 : falsePositiveCount / findingCount,
    knownGoodFalsePositiveRate: knownGoodFindingCount === 0
      ? 0
      : knownGoodFalsePositiveCount / knownGoodFindingCount,
    defectiveFalsePositiveRate: defectiveFindingCount === 0
      ? 0
      : defectiveFalsePositiveCount / defectiveFindingCount,
    passOnDefectiveRate: defectiveScores.length === 0 ? 0 : defectiveScores.filter((score) => score.metrics.passOnDefective).length / defectiveScores.length,
    failOnKnownGoodRate: knownGoodScores.length === 0 ? 0 : knownGoodScores.filter((score) => score.metrics.failOnKnownGood).length / knownGoodScores.length,
    findingsByCategory,
  };
}
