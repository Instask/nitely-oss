import { describe, expect, it } from "vitest";

import { parseEvalCohortManifest, type EvalCase } from "../../src/eval/manifest.js";
import { scoreReviewerCase, type NormalizedReviewerFinding } from "../../src/eval/reviewer.js";
import {
  assessReviewerCorpus,
  buildReviewerScorecard,
  compareReviewerScorecards,
  reviewerScorecardSha256,
  signTestPValue,
  wilsonInterval,
  type ReviewerScorecardCase,
} from "../../src/eval/reviewer-scorecard.js";

const digest = `sha256:${"a".repeat(64)}`;
const SECRET_EVIDENCE = "private-snippet-do-not-publish";

interface Defect {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
}

function evalCase(id: string, defects: Defect[]): EvalCase {
  const manifest = parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: { id: "scorecard" },
    cases: [{
      id,
      baselineRunId: `run-${id}`,
      source: { revision: "b".repeat(40) },
      flow: { path: "flow.json", sha256: digest },
      inputs: [{ id: "patch", path: "patch.diff", sha256: digest }],
      runtime: {
        executionBackend: "local",
        sandboxPolicy: { codex: "read-only" },
        stages: [{ stageId: "review", runtime: "codex", model: "m" }],
      },
      contextPolicy: { sha256: digest },
      expectedGates: [],
      reviewEvaluation: {
        reviewerStageIds: ["review"],
        candidateDiff: { inputId: "patch" },
        deterministicEvidence: [],
        knownGood: defects.length === 0,
        ...(defects.length > 0
          ? { acceptedHumanFindings: [{ defectId: defects[0]!.id, evidence: "accepted" }] }
          : {}),
        expectedDefects: defects.map((defect) => ({
          ...defect,
          description: `${defect.category} defect`,
          provenance: "historical-human-review-finding",
        })),
      },
      allowedNondeterminism: [],
      scoring: { requireReviewablePr: false, requireExpectedGates: false },
    }],
    thresholds: {},
  });
  return manifest.cases[0]!;
}

/** 12 defective cases over two categories plus 12 known-good cases. */
function corpus(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (let index = 0; index < 12; index += 1) {
    const category = index % 2 === 0 ? "authorization" : "concurrency";
    cases.push(evalCase(`defect-${index}`, [{
      id: `d${index}`,
      category,
      severity: index % 3 === 0 ? "high" : "critical",
      file: `src/f${index}.ts`,
    }]));
  }
  for (let index = 0; index < 12; index += 1) cases.push(evalCase(`good-${index}`, []));
  return cases;
}

function finding(id: string, file: string, category: string): NormalizedReviewerFinding {
  return {
    id,
    category,
    severity: "critical",
    file,
    evidence: SECRET_EVIDENCE,
    verdictImpact: "blocking",
  };
}

function review(cases: EvalCase[], reviewer: "strong" | "degraded"): ReviewerScorecardCase[] {
  return cases.map((entry) => {
    const defects = entry.reviewEvaluation!.expectedDefects;
    const known = entry.reviewEvaluation!.knownGood;
    const output = reviewer === "strong"
      ? {
          verdict: known ? "pass" : "fail",
          findings: defects.map((defect) => finding(defect.id, defect.file!, defect.category)),
        }
      : { verdict: "pass", findings: [] };
    const score = scoreReviewerCase({ evalCase: entry, output });
    return {
      evalCase: entry,
      score: {
        ...score,
        provenance: {
          sourceRevision: "b".repeat(40),
          flowSha256: digest,
          contextPolicySha256: digest,
          manifestSha256: digest,
          stages: [{ stageId: "review", runtime: "codex", model: "m" }],
          latencyMs: 1000,
          usage: { totalTokens: 100 },
        },
      },
    };
  });
}

function scorecard(cases: ReviewerScorecardCase[], id: string) {
  return buildReviewerScorecard({
    subject: { id, runtime: "codex", model: "m", flowSha256: digest },
    window: { id: "2026-10-w1", measuredAt: "2026-10-13T00:00:00.000Z" },
    manifestSha256: digest,
    cases,
  });
}

describe("reviewer scorecard statistics", () => {
  it("computes Wilson intervals and leaves empty proportions undefined", () => {
    const interval = wilsonInterval(8, 10)!;
    expect(interval.lower).toBeCloseTo(0.4902, 3);
    expect(interval.upper).toBeCloseTo(0.9433, 3);
    expect(wilsonInterval(0, 0)).toBeUndefined();
    expect(wilsonInterval(0, 5)!.lower).toBe(0);
  });

  it("computes an exact two-sided sign test", () => {
    expect(signTestPValue(0, 0)).toBe(1);
    expect(signTestPValue(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTestPValue(10, 0)).toBeCloseTo(0.001953, 5);
    expect(signTestPValue(3, 3)).toBe(1);
  });
});

describe("reviewer corpus assessment", () => {
  it("accepts a varied 24-case corpus", () => {
    const assessment = assessReviewerCorpus(corpus());
    expect(assessment).toMatchObject({
      sufficient: true,
      caseCount: 24,
      defectiveCaseCount: 12,
      knownGoodCaseCount: 12,
      defectCategories: ["authorization", "concurrency"],
      humanAcceptedCaseCount: 12,
    });
  });

  it("rejects small, one-sided or single-category corpora", () => {
    const small = assessReviewerCorpus(corpus().slice(0, 5));
    expect(small.sufficient).toBe(false);
    expect(small.problems.join("\n")).toMatch(/at least 20/);
    expect(small.problems.join("\n")).toMatch(/no known-good/);
    const oneCategory = assessReviewerCorpus(
      Array.from({ length: 20 }, (_, index) =>
        evalCase(`c${index}`, index < 10
          ? [{ id: `d${index}`, category: "authorization", severity: "critical", file: "a.ts" }]
          : []),
      ),
    );
    expect(oneCategory.problems.join("\n")).toMatch(/1 defect categories/);
  });
});

describe("reviewer scorecard", () => {
  it("records recall, intervals, cost classification and no finding text", () => {
    const card = scorecard(review(corpus(), "strong"), "strong");
    expect(card.metrics.p0DefectRecall).toMatchObject({ successes: 8, trials: 8, value: 1 });
    expect(card.metrics.p0p1DefectRecall).toMatchObject({ successes: 12, trials: 12 });
    expect(card.metrics.p0DefectRecall.interval!.lower).toBeLessThan(1);
    expect(card.metrics.failOnKnownGoodRate).toMatchObject({ successes: 0, trials: 12 });
    expect(card.usage.costClassification).toEqual({ actual: 0, estimated: 0, unknown: 24 });
    expect(card.usage).not.toHaveProperty("actualCostUsd");
    expect(card.corpus.sufficient).toBe(true);
    expect(JSON.stringify(card)).not.toContain(SECRET_EVIDENCE);
    expect(reviewerScorecardSha256(card)).toBe(reviewerScorecardSha256(structuredClone(card)));
  });

  it("keeps critical misses and ambiguous matches visible", () => {
    const entry = evalCase("ambiguous", [
      { id: "a1", category: "authorization", severity: "critical", file: "src/x.ts" },
      { id: "a2", category: "authorization", severity: "critical", file: "src/x.ts" },
    ]);
    const score = scoreReviewerCase({
      evalCase: entry,
      output: { verdict: "fail", findings: [finding("f1", "src/x.ts", "authorization")] },
    });
    const card = scorecard([{ evalCase: entry, score }], "ambiguous");
    expect(card.metrics.ambiguousMatches).toBe(1);
    expect(card.metrics.p0DefectRecall).toMatchObject({ successes: 0, trials: 2 });
    expect(card.criticalMisses).toEqual([{ caseId: "ambiguous", defectIds: ["a1", "a2"] }]);
  });

  it("counts a case without reviewer output as a miss, not a pass", () => {
    const cases = corpus();
    const card = scorecard(cases.map((evalCase) => ({ evalCase })), "silent");
    expect(card.scoredCaseCount).toBe(0);
    expect(card.unscoredCaseIds).toHaveLength(24);
    expect(card.metrics.overallDefectRecall.value).toBe(0);
    expect(card.metrics.failOnKnownGoodRate.value).toBe(1);
    // Silence on a defective case is a wrongful pass, consistent with recall.
    expect(card.metrics.passOnDefectiveRate.value).toBe(1);
    expect(card.metrics.passOnDefectiveRate.trials).toBe(card.corpus.defectiveCaseCount);
  });
});

describe("reviewer scorecard comparison", () => {
  it("flags a deliberately degraded reviewer as an advisory regression", () => {
    const cases = corpus();
    const comparison = compareReviewerScorecards({
      baseline: scorecard(review(cases, "strong"), "strong"),
      candidate: scorecard(review(cases, "degraded"), "degraded"),
    });
    expect(comparison.mode).toBe("advisory");
    expect(comparison.matchedCaseIds).toHaveLength(24);
    expect(comparison.status).toBe("advisory-regression");
    expect(comparison.metrics.find((entry) => entry.metric === "criticalDefectDetection"))
      .toMatchObject({ candidateWorse: 8, candidateBetter: 0, status: "advisory-regression" });
  });

  it("refuses to claim a direction from a tiny sample", () => {
    const cases = corpus().slice(0, 6);
    const comparison = compareReviewerScorecards({
      baseline: scorecard(review(cases, "degraded"), "degraded"),
      candidate: scorecard(review(cases, "strong"), "strong"),
    });
    expect(comparison.status).toBe("insufficient-evidence");
    expect(comparison.reasons.join("\n")).toMatch(/6 matched cases/);
  });

  it("only compares cases with the same gold defects", () => {
    const cases = corpus();
    const changed = cases.map((entry) =>
      entry.id === "defect-0"
        ? evalCase("defect-0", [{ id: "other", category: "authorization", severity: "critical", file: "z.ts" }])
        : entry,
    );
    const comparison = compareReviewerScorecards({
      baseline: scorecard(review(cases, "strong"), "a"),
      candidate: scorecard(review(changed, "strong"), "b"),
    });
    expect(comparison.unmatchedCaseIds).toEqual(["defect-0"]);
    expect(comparison.groundTruthMismatchCaseIds).toEqual(["defect-0"]);
    expect(comparison.matchedCaseIds).toHaveLength(23);
    expect(comparison.status).toBe("insufficient-evidence");
  });

  it.each([
    ["severity", { severity: "low" as const }],
    ["category", { category: "relabelled" }],
  ])("treats a changed defect %s as not comparable", (_field, patch) => {
    const cases = corpus();
    const target = cases.find((entry) => (entry.reviewEvaluation?.expectedDefects.length ?? 0) > 0)!;
    const changed = cases.map((entry) => {
      if (entry !== target) return entry;
      const defects = entry.reviewEvaluation!.expectedDefects.map((defect, index) =>
        index === 0 ? { ...defect, ...patch } : defect);
      return { ...entry, reviewEvaluation: { ...entry.reviewEvaluation!, expectedDefects: defects } };
    });
    const baseline = scorecard(review(cases, "strong"), "a");
    const candidate = scorecard(review(changed, "strong"), "b");
    const before = baseline.cases.find((entry) => entry.caseId === target.id)!;
    const after = candidate.cases.find((entry) => entry.caseId === target.id)!;
    expect(after.defectIds).toEqual(before.defectIds);
    expect(after.groundTruthSha256).not.toBe(before.groundTruthSha256);
    const comparison = compareReviewerScorecards({ baseline, candidate });
    expect(comparison.groundTruthMismatchCaseIds).toEqual([target.id]);
    expect(comparison.matchedCaseIds).not.toContain(target.id);
    expect(comparison.status).toBe("insufficient-evidence");
    expect(comparison.reasons.join("\n")).toMatch(/ground truth .* differs .*not comparable/);
  });
});
