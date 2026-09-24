import { describe, expect, it } from "vitest";

import {
  evalManifestSha256,
  parseEvalCohortManifest,
  type EvalCohortManifest,
} from "../../src/eval/manifest.js";
import {
  buildModelRoutingRecommendation,
  parseModelRoutingExperiment,
  parseModelRoutingReport,
  type ModelRoutingCandidateInput,
} from "../../src/eval/routing.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BASELINE_DIGEST = `sha256:${"b".repeat(64)}`;

function manifest(id: string, runtime: string, model: string): EvalCohortManifest {
  return parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: { id, baselineCohortId: "baseline" },
    cases: [{
      id: "case-1",
      baselineRunId: "baseline-run-1",
      source: { revision: "c".repeat(40) },
      flow: { path: "flows/eval.json", sha256: DIGEST },
      inputs: [],
      runtime: {
        executionBackend: "oci",
        sandboxPolicy: { codex: "workspace-write" },
        stages: [{ stageId: "implement", runtime, model }],
      },
      contextPolicy: { sha256: DIGEST },
      expectedGates: ["review"],
      allowedNondeterminism: [],
      scoring: { requireReviewablePr: true, requireExpectedGates: true },
    }],
    thresholds: {},
  });
}

function experiment(overrides: Record<string, unknown> = {}) {
  return parseModelRoutingExperiment({
    schemaVersion: "nitely.model-routing-experiment.v1",
    experiment: {
      id: "routing-1",
      flow: { path: "flows/eval.json", sha256: DIGEST },
      stageId: "implement",
      baselineManifestSha256: BASELINE_DIGEST,
    },
    candidates: [
      { id: "fast", runtime: "oci", model: "model-fast", cohortManifestPath: "manifests/fast.json", reportPath: "reports/fast.json" },
      { id: "slow", runtime: "oci", model: "model-slow", cohortManifestPath: "manifests/slow.json", reportPath: "reports/slow.json" },
    ],
    budget: { maxCandidates: 2, maxRuns: 4 },
    policy: { minScoringPassRate: 1, minReviewablePrRate: 1, requireCompleteCases: true, requireKnownCost: true },
    ...overrides,
  });
}

function report(
  candidate: EvalCohortManifest,
  values: {
    latency: number;
    cost?: number;
    score?: number;
    unknownAttempts?: number;
    reviewer?: Record<string, unknown>;
  },
): ReturnType<typeof parseModelRoutingReport> {
  const score = values.score ?? 1;
  const unknownAttempts = values.unknownAttempts ?? 0;
  const summary = {
    schemaVersion: "nitely.eval-cohort-summary.v1" as const,
    cohortId: candidate.cohort.id,
    runCount: 1,
    caseIds: ["case-1"],
    reviewablePrRate: { numerator: 1, denominator: 1, value: score },
    gatePassRate: { numerator: 1, denominator: 1, value: score },
    scoringPassRate: { numerator: 1, denominator: 1, value: score },
    retriesPerRun: { total: 0, samples: 1, missing: 0, value: 0 },
    humanReworkPerRun: { total: 0, samples: 1, missing: 0, value: 0 },
    latencyMs: { total: values.latency, samples: 1, missing: 0, value: values.latency },
    actualCostUsd: values.cost === undefined
      ? { total: 0, samples: 0, missing: 1 }
      : { total: values.cost, samples: 1, missing: 0, value: values.cost },
    estimatedCostUsd: { total: 0, samples: 0, missing: 1 },
    outcomes: { completed: score === 1 ? 1 : 0, failed: score === 1 ? 0 : 1, blocked: 0, cancelled: 0, unknown: 0 },
    usage: { knownAttempts: unknownAttempts === 0 ? 1 : 0, unknownAttempts },
    ...(values.reviewer ? { reviewer: values.reviewer } : {}),
  };
  return parseModelRoutingReport({
    schemaVersion: "nitely.eval-report.v1",
    status: "passed",
    baselineManifestSha256: BASELINE_DIGEST,
    candidateManifestSha256: evalManifestSha256(candidate),
    runLineage: { baseline: [], candidate: [{ caseId: "case-1", runId: `${candidate.cohort.id}-run` }] },
    candidate: summary,
    coverage: {
      baselineMissingCaseIds: [], candidateMissingCaseIds: [],
      baselineDuplicateCaseIds: [], candidateDuplicateCaseIds: [],
      baselineOnlyManifestCaseIds: [], candidateOnlyManifestCaseIds: [], incompatibleCaseIds: [],
    },
  });
}

function candidate(
  id: string,
  runtime: string,
  model: string,
  values: Parameters<typeof report>[1],
): ModelRoutingCandidateInput {
  const manifestValue = manifest(id, runtime, model);
  return {
    id,
    stageId: "implement",
    runtime,
    model,
    manifest: manifestValue,
    manifestSha256: evalManifestSha256(manifestValue),
    report: report(manifestValue, values),
  };
}

describe("model routing recommendations", () => {
  it("selects the unique non-dominated candidate and records config lineage", () => {
    const recommendation = buildModelRoutingRecommendation({
      experiment: experiment(),
      experimentSha256: DIGEST,
      candidates: [
        candidate("fast", "oci", "model-fast", { latency: 50, cost: 0.02 }),
        candidate("slow", "oci", "model-slow", { latency: 100, cost: 0.04 }),
      ],
    });

    expect(recommendation.recommendation).toMatchObject({ status: "recommended", candidateId: "fast" });
    expect(recommendation.frontierCandidateIds).toEqual(["fast"]);
    expect(recommendation.candidates[0].configSha256).toMatch(/^sha256:/);
  });

  // A cohort can score reviewers and route models at once, and the summary then
  // carries a reviewer block this report parser must not reject.
  it("accepts a cohort report that also carries reviewer effectiveness metrics", () => {
    const recommendation = buildModelRoutingRecommendation({
      experiment: experiment(),
      experimentSha256: DIGEST,
      candidates: [
        candidate("fast", "oci", "model-fast", {
          latency: 50,
          cost: 0.02,
          reviewer: { sampleCount: 2, criticalDefectRecall: 1 },
        }),
        candidate("slow", "oci", "model-slow", { latency: 100, cost: 0.04 }),
      ],
    });

    expect(recommendation.recommendation).toMatchObject({
      status: "recommended",
      candidateId: "fast",
    });
  });

  it("does not pick a winner when candidates tie on the frontier", () => {
    const recommendation = buildModelRoutingRecommendation({
      experiment: experiment(),
      experimentSha256: DIGEST,
      candidates: [
        candidate("fast", "oci", "model-fast", { latency: 50, cost: 0.02 }),
        candidate("slow", "oci", "model-slow", { latency: 50, cost: 0.02 }),
      ],
    });

    expect(recommendation.recommendation.status).toBe("insufficient_data");
    expect(recommendation.frontierCandidateIds).toEqual(["fast", "slow"]);
  });

  it("fails closed for unknown cost and forged report lineage", () => {
    const unknown = candidate("fast", "oci", "model-fast", { latency: 50, unknownAttempts: 1 });
    const forged = candidate("slow", "oci", "model-slow", { latency: 100, cost: 0.04 });
    forged.report.candidateManifestSha256 = BASELINE_DIGEST;
    const recommendation = buildModelRoutingRecommendation({
      experiment: experiment(),
      experimentSha256: DIGEST,
      candidates: [unknown, forged],
    });

    expect(recommendation.recommendation.status).toBe("no_feasible_candidate");
    expect(recommendation.candidates.flatMap((entry) => entry.exclusionReasons)).toEqual(
      expect.arrayContaining(["cost coverage is unknown", "candidate report manifest lineage does not match"]),
    );
  });

  it("marks a recommendation as budget exhausted instead of silently using over-budget evidence", () => {
    const recommendation = buildModelRoutingRecommendation({
      experiment: experiment({ budget: { maxCandidates: 2, maxRuns: 1 } }),
      experimentSha256: DIGEST,
      candidates: [
        candidate("fast", "oci", "model-fast", { latency: 50, cost: 0.02 }),
        candidate("slow", "oci", "model-slow", { latency: 100, cost: 0.04 }),
      ],
    });

    expect(recommendation.budget.exhausted).toBe(true);
    expect(recommendation.recommendation.status).toBe("no_feasible_candidate");
  });
});
