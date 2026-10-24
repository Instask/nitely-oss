import { createHash } from "node:crypto";

import type { EvalCase } from "./manifest.js";
import type { ReviewerCaseScore } from "./reviewer.js";

/**
 * Operational reviewer benchmark on top of the replayable reviewer scoring.
 *
 * The scoring engine (reviewer.ts / report.ts) decides, per case, which gold
 * defects a reviewer found. This module turns a set of those case scores into
 * a sanitized scorecard with sample sizes and confidence intervals, checks
 * whether a corpus is large and varied enough to mean anything, and compares
 * two reviewer configurations on matched cases. It never fails a build on its
 * own: comparisons are advisory and stay "insufficient-evidence" until the
 * matched sample and the observed difference are large enough.
 */

export const REVIEWER_SCORECARD_SCHEMA = "nitely.reviewer-scorecard.v1";
export const REVIEWER_SCORECARD_COMPARISON_SCHEMA =
  "nitely.reviewer-scorecard-comparison.v1";

/** Minimum corpus the benchmark accepts as a baseline. */
export const REVIEWER_CORPUS_MINIMUMS = {
  cases: 20,
  defectiveCases: 1,
  knownGoodCases: 1,
  defectCategories: 2,
} as const;

/** Minimum matched cases before a comparison may report a regression. */
export const DEFAULT_MIN_MATCHED_CASES = 20;
/** Minimum discordant pairs before a paired comparison is considered. */
export const DEFAULT_MIN_DISCORDANT_PAIRS = 5;
/** Two-sided significance level for the paired sign test. */
export const DEFAULT_SIGNIFICANCE = 0.05;

export interface ReviewerScorecardCase {
  evalCase: EvalCase;
  /** Absent when the run produced no reviewer output at all. */
  score?: ReviewerCaseScore;
}

export interface ReviewerScorecardSubject {
  /** Stable label, for example "default-review@2026-10". */
  id: string;
  runtime: string;
  model: string;
  /** sha256 of the reviewer Flow document. */
  flowSha256: string;
  /** sha256 of the reviewer prompt, when it is tracked separately. */
  promptSha256?: string;
}

export interface ProportionEstimate {
  successes: number;
  trials: number;
  /** Undefined when there are no trials; never reported as 0 or 1. */
  value?: number;
  /** 95% Wilson score interval. */
  interval?: { lower: number; upper: number };
}

export interface ReviewerScorecard {
  schemaVersion: typeof REVIEWER_SCORECARD_SCHEMA;
  subject: ReviewerScorecardSubject;
  window: { id: string; measuredAt: string };
  manifestSha256: string;
  corpus: ReviewerCorpusAssessment;
  caseCount: number;
  scoredCaseCount: number;
  /** Cases where the reviewer produced nothing to score. Counted as misses. */
  unscoredCaseIds: string[];
  metrics: {
    p0DefectRecall: ProportionEstimate;
    p0p1DefectRecall: ProportionEstimate;
    overallDefectRecall: ProportionEstimate;
    falsePositiveRate: ProportionEstimate;
    passOnDefectiveRate: ProportionEstimate;
    failOnKnownGoodRate: ProportionEstimate;
    ambiguousMatches: number;
  };
  /** Critical (P0) defects that were not detected, by case. */
  criticalMisses: Array<{ caseId: string; defectIds: string[] }>;
  latencyMs: { samples: number; median?: number; p90?: number };
  usage: {
    totalTokens?: number;
    actualCostUsd?: number;
    estimatedCostUsd?: number;
    /** Cases with actual / estimated / unknown cost. Unknown is never zero. */
    costClassification: { actual: number; estimated: number; unknown: number };
  };
  /** Per-case outcome, without finding text, for matched comparison. */
  cases: ReviewerScorecardCaseOutcome[];
}

export interface ReviewerScorecardCaseOutcome {
  caseId: string;
  knownGood: boolean;
  scored: boolean;
  defectIds: string[];
  detectedDefectIds: string[];
  criticalDefectIds: string[];
  falsePositives: number;
  ambiguousMatches: number;
  passed?: boolean;
  /**
   * sha256 over the ground truth that drives the metrics: the known-good flag
   * and each gold defect's id, severity and category. Two scorecards only
   * compare a case when this matches.
   */
  groundTruthSha256: string;
}

/** Hash of the case ground truth that recall, P0/P1 and pass rates depend on. */
export function reviewerCaseGroundTruthSha256(evalCase: EvalCase): string {
  const review = evalCase.reviewEvaluation;
  const truth = {
    knownGood: review?.knownGood ?? false,
    defects: [...(review?.expectedDefects ?? [])]
      .map((defect) => ({ id: defect.id, severity: defect.severity, category: defect.category }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
  return `sha256:${createHash("sha256").update(stableJson(truth)).digest("hex")}`;
}

export interface ReviewerCorpusAssessment {
  sufficient: boolean;
  caseCount: number;
  defectiveCaseCount: number;
  knownGoodCaseCount: number;
  defectCategories: string[];
  provenance: Record<string, number>;
  /** Defective cases whose ground truth was accepted by a human reviewer. */
  humanAcceptedCaseCount: number;
  problems: string[];
}

/** 95% Wilson score interval for a binomial proportion. */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.959963984540054,
): { lower: number; upper: number } | undefined {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error("wilsonInterval expects integer counts");
  }
  if (trials <= 0) return undefined;
  if (successes < 0 || successes > trials) {
    throw new Error("successes must be between 0 and trials");
  }
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

function proportion(successes: number, trials: number): ProportionEstimate {
  return {
    successes,
    trials,
    ...(trials > 0
      ? { value: successes / trials, interval: wilsonInterval(successes, trials) }
      : {}),
  };
}

/** Checks that a reviewer corpus is big and varied enough for a baseline. */
export function assessReviewerCorpus(
  cases: readonly EvalCase[],
): ReviewerCorpusAssessment {
  const reviewCases = cases.filter((entry) => entry.reviewEvaluation);
  const problems: string[] = [];
  const provenance: Record<string, number> = {};
  const categories = new Set<string>();
  let defective = 0;
  let knownGood = 0;
  let humanAccepted = 0;
  for (const entry of reviewCases) {
    const review = entry.reviewEvaluation!;
    if (review.knownGood) {
      knownGood += 1;
      continue;
    }
    defective += 1;
    if (review.expectedDefects.length === 0) {
      problems.push(`defective case ${entry.id} declares no expected defects`);
    }
    for (const defect of review.expectedDefects) {
      categories.add(defect.category);
      provenance[defect.provenance] = (provenance[defect.provenance] ?? 0) + 1;
    }
    if ((review.acceptedHumanFindings ?? []).length > 0) humanAccepted += 1;
  }
  if (reviewCases.length < REVIEWER_CORPUS_MINIMUMS.cases) {
    problems.push(
      `corpus has ${reviewCases.length} review cases; at least ${REVIEWER_CORPUS_MINIMUMS.cases} are required`,
    );
  }
  if (defective < REVIEWER_CORPUS_MINIMUMS.defectiveCases) {
    problems.push("corpus has no defective cases");
  }
  if (knownGood < REVIEWER_CORPUS_MINIMUMS.knownGoodCases) {
    problems.push("corpus has no known-good cases");
  }
  if (categories.size < REVIEWER_CORPUS_MINIMUMS.defectCategories) {
    problems.push(
      `corpus covers ${categories.size} defect categories; at least ${REVIEWER_CORPUS_MINIMUMS.defectCategories} are required`,
    );
  }
  return {
    sufficient: problems.length === 0,
    caseCount: reviewCases.length,
    defectiveCaseCount: defective,
    knownGoodCaseCount: knownGood,
    defectCategories: [...categories].sort(),
    provenance,
    humanAcceptedCaseCount: humanAccepted,
    problems,
  };
}

function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function passedVerdict(verdict: string | undefined): boolean | undefined {
  if (verdict === undefined) return undefined;
  const normalized = verdict.toLowerCase().replace(/[ -]+/g, "_");
  return normalized === "pass" || normalized === "passed" || normalized === "approved";
}

/**
 * Builds a sanitized scorecard. Finding text, evidence and file contents are
 * dropped; only ids, counts and hashes are kept so the scorecard can be
 * published from CI without exposing the reviewed code.
 */
export function buildReviewerScorecard(input: {
  subject: ReviewerScorecardSubject;
  window: { id: string; measuredAt: string };
  manifestSha256: string;
  cases: readonly ReviewerScorecardCase[];
}): ReviewerScorecard {
  const reviewCases = input.cases.filter((entry) => entry.evalCase.reviewEvaluation);
  const outcomes: ReviewerScorecardCaseOutcome[] = [];
  let p0Total = 0;
  let p0Hit = 0;
  let p01Total = 0;
  let p01Hit = 0;
  let defectTotal = 0;
  let defectHit = 0;
  let findingTotal = 0;
  let falsePositiveTotal = 0;
  let ambiguous = 0;
  let defectiveCases = 0;
  let defectivePasses = 0;
  let knownGoodCases = 0;
  let knownGoodFailures = 0;
  const latencies: number[] = [];
  let totalTokens: number | undefined;
  let actualCostUsd: number | undefined;
  let estimatedCostUsd: number | undefined;
  const costClassification = { actual: 0, estimated: 0, unknown: 0 };
  const criticalMisses: ReviewerScorecard["criticalMisses"] = [];
  const unscored: string[] = [];

  for (const { evalCase, score } of reviewCases) {
    const review = evalCase.reviewEvaluation!;
    const defects = review.expectedDefects;
    const detected = new Set(
      score?.matches.flatMap((match) =>
        match.status === "matched" && match.defectId ? [match.defectId] : [],
      ) ?? [],
    );
    const critical = defects.filter((defect) => defect.severity === "critical");
    const p01 = defects.filter(
      (defect) => defect.severity === "critical" || defect.severity === "high",
    );
    p0Total += critical.length;
    p0Hit += critical.filter((defect) => detected.has(defect.id)).length;
    p01Total += p01.length;
    p01Hit += p01.filter((defect) => detected.has(defect.id)).length;
    defectTotal += defects.length;
    defectHit += defects.filter((defect) => detected.has(defect.id)).length;
    const missedCritical = critical
      .filter((defect) => !detected.has(defect.id))
      .map((defect) => defect.id);
    if (missedCritical.length > 0) {
      criticalMisses.push({ caseId: evalCase.id, defectIds: missedCritical });
    }
    const caseAmbiguous =
      score?.matches.filter((match) => match.status === "ambiguous").length ?? 0;
    ambiguous += caseAmbiguous;
    const falsePositives = score?.metrics.falsePositiveCount ?? 0;
    falsePositiveTotal += falsePositives;
    findingTotal += score?.findings.length ?? 0;
    const passed = passedVerdict(score?.verdict);
    if (review.knownGood) {
      knownGoodCases += 1;
      // No verdict on a known-good case is not a pass.
      if (passed !== true) knownGoodFailures += 1;
    } else {
      defectiveCases += 1;
      // No reviewer output on a defective case lets the defect through, the
      // same way it counts as a miss in recall.
      if (passed === true || !score) defectivePasses += 1;
    }
    if (!score) unscored.push(evalCase.id);
    const provenance = score?.provenance;
    if (provenance?.latencyMs !== undefined) latencies.push(provenance.latencyMs);
    if (provenance?.usage?.totalTokens !== undefined) {
      totalTokens = (totalTokens ?? 0) + provenance.usage.totalTokens;
    }
    if (provenance?.usage?.actualCostUsd !== undefined) {
      actualCostUsd = (actualCostUsd ?? 0) + provenance.usage.actualCostUsd;
      costClassification.actual += 1;
    } else if (provenance?.usage?.estimatedCostUsd !== undefined) {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + provenance.usage.estimatedCostUsd;
      costClassification.estimated += 1;
    } else {
      costClassification.unknown += 1;
    }
    outcomes.push({
      caseId: evalCase.id,
      knownGood: review.knownGood,
      scored: score !== undefined,
      defectIds: defects.map((defect) => defect.id),
      detectedDefectIds: defects
        .filter((defect) => detected.has(defect.id))
        .map((defect) => defect.id),
      criticalDefectIds: critical.map((defect) => defect.id),
      falsePositives,
      ambiguousMatches: caseAmbiguous,
      ...(passed !== undefined ? { passed } : {}),
      groundTruthSha256: reviewerCaseGroundTruthSha256(evalCase),
    });
  }
  latencies.sort((left, right) => left - right);
  const median = quantile(latencies, 0.5);
  const p90 = quantile(latencies, 0.9);
  return {
    schemaVersion: REVIEWER_SCORECARD_SCHEMA,
    subject: input.subject,
    window: input.window,
    manifestSha256: input.manifestSha256,
    corpus: assessReviewerCorpus(reviewCases.map((entry) => entry.evalCase)),
    caseCount: reviewCases.length,
    scoredCaseCount: reviewCases.length - unscored.length,
    unscoredCaseIds: unscored,
    metrics: {
      p0DefectRecall: proportion(p0Hit, p0Total),
      p0p1DefectRecall: proportion(p01Hit, p01Total),
      overallDefectRecall: proportion(defectHit, defectTotal),
      falsePositiveRate: proportion(falsePositiveTotal, findingTotal),
      passOnDefectiveRate: proportion(defectivePasses, defectiveCases),
      failOnKnownGoodRate: proportion(knownGoodFailures, knownGoodCases),
      ambiguousMatches: ambiguous,
    },
    criticalMisses,
    latencyMs: {
      samples: latencies.length,
      ...(median !== undefined ? { median } : {}),
      ...(p90 !== undefined ? { p90 } : {}),
    },
    usage: {
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      costClassification,
    },
    cases: outcomes,
  };
}

/** Stable sha256 of a scorecard, for tying published results to inputs. */
export function reviewerScorecardSha256(scorecard: ReviewerScorecard): string {
  return `sha256:${createHash("sha256").update(stableJson(scorecard)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Exact two-sided sign test p-value for `worse` vs `better` discordant pairs. */
export function signTestPValue(worse: number, better: number): number {
  const n = worse + better;
  if (n === 0) return 1;
  const k = Math.min(worse, better);
  let tail = 0;
  let coefficient = 1;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    tail += coefficient;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type ReviewerComparisonStatus =
  | "insufficient-evidence"
  | "no-significant-change"
  | "advisory-regression"
  | "advisory-improvement";

export interface ReviewerPairedMetricComparison {
  metric: "defectDetection" | "criticalDefectDetection" | "knownGoodPass";
  /** Units where baseline succeeded and candidate failed. */
  candidateWorse: number;
  /** Units where candidate succeeded and baseline failed. */
  candidateBetter: number;
  pValue: number;
  status: ReviewerComparisonStatus;
}

export interface ReviewerScorecardComparison {
  schemaVersion: typeof REVIEWER_SCORECARD_COMPARISON_SCHEMA;
  /** Always advisory; a human decides whether to act on a regression. */
  mode: "advisory";
  baseline: { subjectId: string; windowId: string; manifestSha256: string };
  candidate: { subjectId: string; windowId: string; manifestSha256: string };
  matchedCaseIds: string[];
  unmatchedCaseIds: string[];
  /** Cases present in both scorecards whose ground truth differs. */
  groundTruthMismatchCaseIds: string[];
  status: ReviewerComparisonStatus;
  reasons: string[];
  metrics: ReviewerPairedMetricComparison[];
}

/**
 * Compares two scorecards on the cases both of them scored against the same
 * gold defects. Only matched units count, so a different corpus cannot look
 * like a better reviewer. Small samples report "insufficient-evidence" instead
 * of a direction.
 */
export function compareReviewerScorecards(input: {
  baseline: ReviewerScorecard;
  candidate: ReviewerScorecard;
  minMatchedCases?: number;
  minDiscordantPairs?: number;
  significance?: number;
}): ReviewerScorecardComparison {
  const minMatched = input.minMatchedCases ?? DEFAULT_MIN_MATCHED_CASES;
  const minDiscordant = input.minDiscordantPairs ?? DEFAULT_MIN_DISCORDANT_PAIRS;
  const alpha = input.significance ?? DEFAULT_SIGNIFICANCE;
  const reasons: string[] = [];
  const baselineCases = new Map(input.baseline.cases.map((entry) => [entry.caseId, entry]));
  const candidateCases = new Map(input.candidate.cases.map((entry) => [entry.caseId, entry]));
  const matched: Array<[ReviewerScorecardCaseOutcome, ReviewerScorecardCaseOutcome]> = [];
  const unmatched = new Set<string>();
  const truthMismatch: string[] = [];
  for (const [caseId, baseline] of baselineCases) {
    const candidate = candidateCases.get(caseId);
    if (!candidate) {
      unmatched.add(caseId);
      continue;
    }
    if (
      !baseline.groundTruthSha256 ||
      candidate.groundTruthSha256 !== baseline.groundTruthSha256 ||
      candidate.knownGood !== baseline.knownGood ||
      !sameIds(candidate.defectIds, baseline.defectIds)
    ) {
      unmatched.add(caseId);
      truthMismatch.push(caseId);
      continue;
    }
    matched.push([baseline, candidate]);
  }
  truthMismatch.sort();
  for (const caseId of candidateCases.keys()) {
    if (!baselineCases.has(caseId)) unmatched.add(caseId);
  }
  if (input.baseline.manifestSha256 !== input.candidate.manifestSha256) {
    reasons.push("scorecards come from different manifests; only matched cases are compared");
  }

  const paired = (
    metric: ReviewerPairedMetricComparison["metric"],
    units: Array<[boolean, boolean]>,
  ): ReviewerPairedMetricComparison => {
    let worse = 0;
    let better = 0;
    for (const [baselineHit, candidateHit] of units) {
      if (baselineHit && !candidateHit) worse += 1;
      if (!baselineHit && candidateHit) better += 1;
    }
    const pValue = signTestPValue(worse, better);
    let status: ReviewerComparisonStatus;
    if (matched.length < minMatched || worse + better < minDiscordant) {
      status = worse + better === 0 && matched.length >= minMatched
        ? "no-significant-change"
        : "insufficient-evidence";
    } else if (pValue >= alpha) {
      status = "no-significant-change";
    } else {
      status = worse > better ? "advisory-regression" : "advisory-improvement";
    }
    return { metric, candidateWorse: worse, candidateBetter: better, pValue, status };
  };

  const defectUnits: Array<[boolean, boolean]> = [];
  const criticalUnits: Array<[boolean, boolean]> = [];
  const knownGoodUnits: Array<[boolean, boolean]> = [];
  for (const [baseline, candidate] of matched) {
    const baselineHits = new Set(baseline.detectedDefectIds);
    const candidateHits = new Set(candidate.detectedDefectIds);
    for (const defectId of baseline.defectIds) {
      const unit: [boolean, boolean] = [baselineHits.has(defectId), candidateHits.has(defectId)];
      defectUnits.push(unit);
      if (baseline.criticalDefectIds.includes(defectId)) criticalUnits.push(unit);
    }
    if (baseline.knownGood) {
      knownGoodUnits.push([baseline.passed === true, candidate.passed === true]);
    }
  }
  const metrics = [
    paired("criticalDefectDetection", criticalUnits),
    paired("defectDetection", defectUnits),
    paired("knownGoodPass", knownGoodUnits),
  ];
  if (matched.length < minMatched) {
    reasons.push(
      `${matched.length} matched cases; at least ${minMatched} are needed before a direction is reported`,
    );
  }
  if (truthMismatch.length > 0) {
    reasons.push(
      `ground truth (known-good flag, defect ids, severity or category) differs for ${truthMismatch.length} shared case(s): ${truthMismatch.join(", ")}; the scorecards are not comparable until the annotations agree`,
    );
  }
  const metricStatus: ReviewerComparisonStatus = metrics.some((entry) => entry.status === "advisory-regression")
    ? "advisory-regression"
    : metrics.some((entry) => entry.status === "insufficient-evidence")
      ? "insufficient-evidence"
      : metrics.some((entry) => entry.status === "advisory-improvement")
        ? "advisory-improvement"
        : "no-significant-change";
  const status: ReviewerComparisonStatus =
    truthMismatch.length > 0 ? "insufficient-evidence" : metricStatus;
  return {
    schemaVersion: REVIEWER_SCORECARD_COMPARISON_SCHEMA,
    mode: "advisory",
    baseline: {
      subjectId: input.baseline.subject.id,
      windowId: input.baseline.window.id,
      manifestSha256: input.baseline.manifestSha256,
    },
    candidate: {
      subjectId: input.candidate.subject.id,
      windowId: input.candidate.window.id,
      manifestSha256: input.candidate.manifestSha256,
    },
    matchedCaseIds: matched.map(([baseline]) => baseline.caseId),
    unmatchedCaseIds: [...unmatched].sort(),
    groundTruthMismatchCaseIds: truthMismatch,
    status,
    reasons,
    metrics,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((entry, index) => entry === sorted[index]);
}
