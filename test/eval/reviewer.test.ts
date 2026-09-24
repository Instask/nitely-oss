import { describe, expect, it } from "vitest";

import {
  evalManifestSha256,
  parseEvalCohortManifest,
  type EvalCase,
} from "../../src/eval/manifest.js";
import {
  aggregateReviewerMetrics,
  normalizeReviewerOutput,
  scoreReviewerCase,
} from "../../src/eval/reviewer.js";
import {
  compareEvalCohorts,
  deriveEvalRunSample,
} from "../../src/eval/report.js";
import type { StoredRunEvent } from "../../src/events/types.js";

const digest = `sha256:${"a".repeat(64)}`;

function reviewCase(overrides: Record<string, unknown> = {}): EvalCase {
  const manifest = parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: { id: "reviewer-fixtures" },
    cases: [{
      id: "case",
      baselineRunId: "run-baseline",
      source: { revision: "b".repeat(40) },
      flow: { path: "flow.json", sha256: digest },
      inputs: [{ id: "patch", path: "patch.diff", sha256: digest }],
      runtime: {
        executionBackend: "local",
        sandboxPolicy: { codex: "read-only" },
        stages: [{ stageId: "review", runtime: "codex", model: "test-model" }],
      },
      contextPolicy: { sha256: digest },
      expectedGates: [],
      reviewEvaluation: {
        reviewerStageIds: ["review"],
        candidateDiff: { inputId: "patch" },
        deterministicEvidence: [],
        knownGood: false,
        expectedDefects: [{
          id: "auth-bypass",
          category: "authorization",
          severity: "critical",
          description: "missing authorization check",
          file: "src/auth.ts",
          provenance: "deliberately-seeded",
        }],
      },
      allowedNondeterminism: [],
      scoring: { requireReviewablePr: false, requireExpectedGates: false },
    }],
    thresholds: {},
  });
  const value = structuredClone(manifest.cases[0]);
  Object.assign(value, overrides);
  return value;
}

function reviewManifest() {
  const evalCase = reviewCase();
  return parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: { id: "reviewer-fixtures" },
    cases: [evalCase],
    thresholds: {
      reviewerCriticalRecall: { maxAbsoluteDecrease: 0.1 },
      reviewerFalsePositiveRate: { maxRelativeIncrease: 0.2 },
    },
  });
}

describe("reviewer effectiveness evaluation", () => {
  it("normalizes structured judge findings and exact defect matches", () => {
    const output = normalizeReviewerOutput({
      stageId: "judge",
      content: JSON.stringify({
        verdict: "REWORK",
        findings: [{
          id: "auth-bypass",
          category: "authorization",
          severity: "critical",
          file: "src/auth.ts",
          evidence: "authorization is not checked",
        }],
      }),
    });
    const score = scoreReviewerCase({
      evalCase: reviewCase(),
      output,
    });

    expect(score.matches).toMatchObject([{
      status: "matched",
      method: "exact-id",
      defectId: "auth-bypass",
    }]);
    expect(score.metrics.criticalDefectsDetected).toBe(1);
    expect(score.missedDefectIds).toEqual([]);
  });

  it("leaves ambiguous and missed defects visible", () => {
    const ambiguous = reviewCase({
      reviewEvaluation: {
        reviewerStageIds: ["review"],
        candidateDiff: { inputId: "patch" },
        deterministicEvidence: [],
        knownGood: false,
        expectedDefects: [
          {
            id: "one",
            category: "security",
            severity: "high",
            description: "one",
            file: "src/auth.ts",
            provenance: "historical-human-review-finding",
          },
          {
            id: "two",
            category: "security",
            severity: "high",
            description: "two",
            file: "src/auth.ts",
            provenance: "deliberately-seeded",
          },
        ],
      },
    });
    const score = scoreReviewerCase({
      evalCase: ambiguous,
      output: normalizeReviewerOutput({
        stageId: "review",
        content: "Review verdict: fail\n- src/auth.ts:12: security issue",
      }),
    });

    expect(score.matches[0]).toMatchObject({ status: "ambiguous" });
    expect(score.missedDefectIds).toEqual(["one", "two"]);
  });

  it("counts false positives, pass-on-defective, and fail-on-known-good separately", () => {
    const defective = scoreReviewerCase({
      evalCase: reviewCase(),
      output: normalizeReviewerOutput({ stageId: "review", content: "Review verdict: pass" }),
    });
    const knownGood = reviewCase({
      reviewEvaluation: {
        reviewerStageIds: ["review"],
        candidateDiff: { inputId: "patch" },
        deterministicEvidence: [],
        knownGood: true,
        expectedDefects: [],
      },
    });
    const falsePositive = scoreReviewerCase({
      evalCase: knownGood,
      output: normalizeReviewerOutput({
        stageId: "review",
        content: JSON.stringify({ verdict: "REWORK", findings: [{ category: "scope", evidence: "unrelated" }] }),
      }),
    });
    const metrics = aggregateReviewerMetrics([defective, falsePositive]);

    expect(defective.metrics.passOnDefective).toBe(true);
    expect(falsePositive.metrics.failOnKnownGood).toBe(true);
    expect(metrics.falsePositiveCount).toBe(1);
    expect(metrics.passOnDefectiveRate).toBe(1);
    expect(metrics.failOnKnownGoodRate).toBe(1);
  });

  it("derives the auditable reviewer score from ordinary replay events", () => {
    const manifest = reviewManifest();
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const events: StoredRunEvent[] = [
      {
        sequence: 1,
        runId: "eval-run",
        type: "run.created",
        payload: { evalReplayInvocationId: invocationId },
        createdAt: "2026-09-18T00:00:01.000Z",
      },
      {
        sequence: 2,
        runId: "eval-run",
        stageId: "review",
        attempt: 1,
        type: "gate.completed",
        payload: {
          gate: {
            status: "failed",
            reviewOutput: {
              content: JSON.stringify({
                verdict: "REWORK",
                findings: [{
                  id: "auth-bypass",
                  category: "authorization",
                  severity: "critical",
                  file: "src/auth.ts",
                  evidence: "missing authorization",
                }],
              }),
            },
          },
        },
        createdAt: "2026-09-18T00:00:02.000Z",
      },
      {
        sequence: 3,
        runId: "eval-run",
        type: "run.completed",
        payload: {},
        createdAt: "2026-09-18T00:00:03.000Z",
      },
      {
        sequence: 4,
        runId: "eval-run",
        type: "eval.replay.linked",
        payload: {
          schemaVersion: "nitely.eval-replay-link.v1",
          cohortId: manifest.cohort.id,
          caseId: "case",
          manifestSha256: evalManifestSha256(manifest),
          sourceRevision: "b".repeat(40),
          baselineRunId: "run-baseline",
          invocationId,
          allowedNondeterminism: [],
          outcome: "completed",
        },
        createdAt: "2026-09-18T00:00:04.000Z",
      },
    ];

    const sample = deriveEvalRunSample({
      events,
      evalCase: manifest.cases[0]!,
      manifest,
    });
    expect(sample?.reviewer).toMatchObject({
      metrics: { criticalDefectsDetected: 1, falsePositiveCount: 0 },
      provenance: {
        sourceRevision: "b".repeat(40),
        stages: [{ stageId: "review", runtime: "codex", model: "test-model" }],
      },
    });
  });

  it("compares reviewer recall through the existing cohort report", () => {
    const baseline = reviewManifest();
    const candidate = parseEvalCohortManifest({
      ...baseline,
      cohort: { id: "candidate", baselineCohortId: baseline.cohort.id },
    });
    const baselineScore = scoreReviewerCase({
      evalCase: baseline.cases[0]!,
      output: normalizeReviewerOutput({
        stageId: "review",
        content: JSON.stringify({
          verdict: "REWORK",
          findings: [{ id: "auth-bypass", category: "authorization", severity: "critical" }],
        }),
      }),
    });
    const candidateScore = scoreReviewerCase({
      evalCase: candidate.cases[0]!,
      output: normalizeReviewerOutput({ stageId: "review", content: "Review verdict: pass" }),
    });
    const sample = (cohortId: string, runId: string, reviewer: typeof baselineScore) => ({
      schemaVersion: "nitely.eval-run-sample.v1" as const,
      runId,
      cohortId,
      caseId: "case",
      baselineRunId: "run-baseline",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      usage: { knownAttempts: 0, unknownAttempts: 0 },
      reviewer,
    });
    const report = compareEvalCohorts({
      baselineManifest: baseline,
      candidateManifest: candidate,
      baselineSamples: [sample(baseline.cohort.id, "baseline-run", baselineScore)],
      candidateSamples: [sample(candidate.cohort.id, "candidate-run", candidateScore)],
      generatedAt: "2026-09-18T00:00:00.000Z",
    });

    expect(report.regressions).toEqual([
      expect.objectContaining({
        metric: "reviewerCriticalRecall",
        status: "regressed",
      }),
    ]);
    expect(report.status).toBe("regressed");
  });
});
