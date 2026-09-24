import { describe, expect, it } from "vitest";

import { buildOutcomeUnitEconomics } from "../../src/web/unit-economics.js";
import type { WebRunSummary } from "../../src/web/runs.js";

function run(overrides: Partial<WebRunSummary> & { runId: string }): WebRunSummary {
  return {
    sessionId: overrides.runId,
    status: "completed",
    completedStages: ["implement"],
    inputs: {},
    ...overrides,
  };
}

describe("buildOutcomeUnitEconomics", () => {
  it("omits a value when the denominator is zero", () => {
    const economics = buildOutcomeUnitEconomics([]);
    expect(economics.costPerCompletedRun.denominator).toBe(0);
    expect(economics.costPerCompletedRun.value).toBeUndefined();
    expect(economics.costPerReviewablePr.value).toBeUndefined();
  });

  it("counts duplicate same-PR rework as one reviewable PR", () => {
    const economics = buildOutcomeUnitEconomics([
      run({
        runId: "run-1",
        changeRequestUrl: "https://github.com/acme/app/pull/9",
        runtimeUsage: {
          estimatedCostUsd: 1,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
      run({
        runId: "run-2",
        priorRunId: "run-1",
        changeRequestUrl: "https://github.com/acme/app/pull/9",
        runtimeUsage: {
          estimatedCostUsd: 2,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
    ]);
    expect(economics.costPerReviewablePr.denominator).toBe(1);
    expect(economics.costPerReviewablePr.numerator).toBe(3);
    expect(economics.costPerReviewablePr.evidenceRunIds).toEqual(["run-1", "run-2"]);
  });

  it("does not treat partial actual plus unknown attempts as complete cost", () => {
    const economics = buildOutcomeUnitEconomics([
      run({
        runId: "run-actual",
        runtimeUsage: {
          actualCostUsd: 4,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
      run({
        runId: "run-unknown",
        runtimeUsage: {
          knownAttempts: 0,
          unknownAttempts: 2,
        },
      }),
    ]);
    expect(economics.costPerCompletedRun.coverage.classification).toBe("unknown");
    expect(economics.costPerCompletedRun.value).toBeUndefined();
  });

  it("keeps a resumed run as a single sample", () => {
    const economics = buildOutcomeUnitEconomics([
      run({
        runId: "run-resumed",
        completedStages: ["write-tests", "implement"],
        runtimeUsage: {
          estimatedCostUsd: 1.5,
          knownAttempts: 2,
          unknownAttempts: 0,
        },
      }),
    ]);
    expect(economics.costPerCompletedRun.denominator).toBe(1);
    expect(economics.costPerCompletedRun.evidenceRunIds).toEqual(["run-resumed"]);
  });

  it("breaks down cost by flow, runtime, and model without ranking people", () => {
    const economics = buildOutcomeUnitEconomics([
      run({
        runId: "run-a",
        flowName: "implement-spec",
        ownerId: "user-a",
        runtimeSlices: [{ runtime: "codex", model: "gpt-5" }],
        runtimeUsage: {
          estimatedCostUsd: 1,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
      run({
        runId: "run-b",
        flowName: "implement-spec",
        ownerId: "user-b",
        runtimeSlices: [{ runtime: "claude", model: "opus" }],
        runtimeUsage: {
          estimatedCostUsd: 3,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
    ]);
    expect(economics.byFlow).toEqual([
      expect.objectContaining({ key: "implement-spec", runCount: 2 }),
    ]);
    expect(economics.byRuntime.map((entry) => entry.key).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(economics.byModel.map((entry) => entry.key).sort()).toEqual([
      "gpt-5",
      "opus",
    ]);
    expect(JSON.stringify(economics)).not.toContain("user-a");
  });

  it("uses billable tokens, not cache-inflated totals, per accepted outcome", () => {
    const economics = buildOutcomeUnitEconomics([
      run({
        runId: "2026-08-30T142227983Z-022c3249",
        changeRequestUrl: "https://github.com/acme/app/pull/517",
        runtimeUsage: {
          inputTokens: 2_216_578,
          outputTokens: 23_250,
          totalTokens: 2_239_828,
          cachedInputTokens: 2_062_336,
          knownAttempts: 1,
          unknownAttempts: 0,
        },
      }),
    ]);
    expect(economics.tokensPerAcceptedOutcome.numerator).toBe(177_492);
    expect(economics.tokensPerAcceptedOutcome.numerator).not.toBe(2_239_828);
    expect(economics.tokensPerAcceptedOutcome.value).toBe(177_492);
  });
});
