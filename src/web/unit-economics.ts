import { billableRuntimeTokens } from "../run/project.js";
import type { WebRunSummary } from "./runs.js";

export type UnitEconomicsCoverageKind =
  | "actual"
  | "estimated"
  | "partial"
  | "unknown";

export interface UnitEconomicsCoverage {
  classification: UnitEconomicsCoverageKind;
  actualUsd?: number;
  estimatedUsd?: number;
  knownAttempts: number;
  unknownAttempts: number;
  runIds: string[];
}

export interface UnitEconomicsRatio {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  sampleCount: number;
  value?: number;
  coverage: UnitEconomicsCoverage;
  evidenceRunIds: string[];
}

export interface UnitEconomicsBreakdown {
  key: string;
  label: string;
  dimension: "flow" | "runtime" | "model";
  runCount: number;
  costPerCompletedRun: UnitEconomicsRatio;
  evidenceRunIds: string[];
}

export interface OutcomeUnitEconomics {
  costPerCompletedRun: UnitEconomicsRatio;
  costPerReviewablePr: UnitEconomicsRatio;
  costPerAcceptedPr: UnitEconomicsRatio;
  costPerMergedPr: UnitEconomicsRatio;
  costPerSuccessfulReviewGate: UnitEconomicsRatio;
  tokensPerAcceptedOutcome: UnitEconomicsRatio;
  latencyMsPerAcceptedOutcome: UnitEconomicsRatio;
  retryReworkCostShare: UnitEconomicsRatio;
  byFlow: UnitEconomicsBreakdown[];
  byRuntime: UnitEconomicsBreakdown[];
  byModel: UnitEconomicsBreakdown[];
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function reviewableKey(run: WebRunSummary): string {
  return run.changeRequestUrl || run.prUrl || `run:${run.runId}`;
}

function groupReviewable(runs: WebRunSummary[]): WebRunSummary[][] {
  const groups = new Map<string, WebRunSummary[]>();
  for (const run of runs) {
    if (!run.changeRequestUrl && !run.prUrl && !run.prNumber) continue;
    const key = reviewableKey(run);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function costCoverage(runs: WebRunSummary[]): UnitEconomicsCoverage {
  const runIds = unique(runs.map((run) => run.runId));
  let actualUsd = 0;
  let estimatedUsd = 0;
  let hasActual = false;
  let hasEstimated = false;
  let knownAttempts = 0;
  let unknownAttempts = 0;
  for (const run of runs) {
    knownAttempts += run.runtimeUsage?.knownAttempts ?? 0;
    unknownAttempts += run.runtimeUsage?.unknownAttempts ?? 0;
    if (run.runtimeUsage?.actualCostUsd !== undefined) {
      hasActual = true;
      actualUsd += run.runtimeUsage.actualCostUsd;
    }
    if (run.runtimeUsage?.estimatedCostUsd !== undefined) {
      hasEstimated = true;
      estimatedUsd += run.runtimeUsage.estimatedCostUsd;
    }
  }
  if (unknownAttempts > 0 || (!hasActual && !hasEstimated)) {
    return {
      classification: "unknown",
      knownAttempts,
      unknownAttempts,
      runIds,
    };
  }
  if (hasActual && hasEstimated) {
    return {
      classification: "partial",
      actualUsd,
      estimatedUsd,
      knownAttempts,
      unknownAttempts,
      runIds,
    };
  }
  if (hasActual) {
    return {
      classification: "actual",
      actualUsd,
      knownAttempts,
      unknownAttempts,
      runIds,
    };
  }
  return {
    classification: "estimated",
    estimatedUsd,
    knownAttempts,
    unknownAttempts,
    runIds,
  };
}

function completeCostUsd(coverage: UnitEconomicsCoverage): number | undefined {
  if (coverage.classification === "actual") return coverage.actualUsd;
  if (coverage.classification === "estimated") return coverage.estimatedUsd;
  return undefined;
}

function ratio(input: {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  coverage: UnitEconomicsCoverage;
  evidenceRunIds: string[];
}): UnitEconomicsRatio {
  const value =
    input.denominator > 0 && completeCostUsd(input.coverage) !== undefined
      ? input.numerator / input.denominator
      : undefined;
  return {
    ...input,
    sampleCount: input.coverage.runIds.length,
    ...(value !== undefined ? { value } : {}),
  };
}

function tokenTotal(runs: WebRunSummary[]): number {
  return runs.reduce(
    (sum, run) => sum + (billableRuntimeTokens(run.runtimeUsage) ?? 0),
    0,
  );
}

function latencyTotal(runs: WebRunSummary[]): number {
  return runs.reduce((sum, run) => {
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    const completed = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      return sum;
    }
    return sum + (completed - started);
  }, 0);
}

function isRework(run: WebRunSummary): boolean {
  return Boolean(run.priorRunId);
}

function successfulReviewGateRuns(runs: WebRunSummary[]): WebRunSummary[] {
  return runs.filter(
    (run) =>
      run.status === "completed" &&
      run.completedStages.some((stage) => /review|verify/i.test(stage)),
  );
}

function costPerCompleted(runs: WebRunSummary[]): UnitEconomicsRatio {
  const completed = runs.filter((run) => run.status === "completed");
  const coverage = costCoverage(completed);
  const usd = completeCostUsd(coverage) ?? 0;
  return ratio({
    key: "cost-per-completed-run",
    label: "Cost per completed run",
    numerator: usd,
    denominator: completed.length,
    coverage,
    evidenceRunIds: unique(completed.map((run) => run.runId)),
  });
}

function breakdown(
  dimension: UnitEconomicsBreakdown["dimension"],
  key: string,
  label: string,
  runs: WebRunSummary[],
): UnitEconomicsBreakdown {
  return {
    key,
    label,
    dimension,
    runCount: runs.length,
    costPerCompletedRun: costPerCompleted(runs),
    evidenceRunIds: unique(runs.map((run) => run.runId)),
  };
}

export function buildOutcomeUnitEconomics(
  runs: WebRunSummary[],
): OutcomeUnitEconomics {
  const completed = runs.filter((run) => run.status === "completed");
  const reviewableGroups = groupReviewable(runs);
  const reviewableRuns = reviewableGroups.flat();
  const acceptedGroups = reviewableGroups.filter((group) =>
    group.some((run) => run.status === "completed"),
  );
  const acceptedRuns = acceptedGroups.flatMap((group) =>
    group.filter((run) => run.status === "completed"),
  );
  const mergedGroups = reviewableGroups.filter((group) =>
    group.some((run) => run.changeRequestStatus?.merged === true),
  );
  const mergedRuns = mergedGroups.flat();
  const gateRuns = successfulReviewGateRuns(runs);
  const reworkRuns = runs.filter(isRework);
  const completedCoverage = costCoverage(completed);
  const reviewableCoverage = costCoverage(reviewableRuns);
  const acceptedCoverage = costCoverage(acceptedRuns);
  const mergedCoverage = costCoverage(mergedRuns);
  const gateCoverage = costCoverage(gateRuns);
  const reworkCoverage = costCoverage(reworkRuns);
  const acceptedUsd = completeCostUsd(acceptedCoverage) ?? 0;
  const reworkUsd = completeCostUsd(reworkCoverage) ?? 0;
  const completedUsd = completeCostUsd(completedCoverage) ?? 0;
  const reviewableUsd = completeCostUsd(reviewableCoverage) ?? 0;
  const mergedUsd = completeCostUsd(mergedCoverage) ?? 0;
  const gateUsd = completeCostUsd(gateCoverage) ?? 0;

  const byFlow = new Map<string, WebRunSummary[]>();
  const byRuntime = new Map<string, WebRunSummary[]>();
  const byModel = new Map<string, WebRunSummary[]>();
  for (const run of runs) {
    const flowKey = run.flowName ?? run.flowPath ?? "unknown-flow";
    const flowRuns = byFlow.get(flowKey) ?? [];
    flowRuns.push(run);
    byFlow.set(flowKey, flowRuns);
    for (const slice of run.runtimeSlices ?? []) {
      const runtimeKey = slice.runtime ?? "unknown-runtime";
      const runtimeRuns = byRuntime.get(runtimeKey) ?? [];
      runtimeRuns.push(run);
      byRuntime.set(runtimeKey, runtimeRuns);
      const modelKey = slice.model ?? "unknown-model";
      const modelRuns = byModel.get(modelKey) ?? [];
      modelRuns.push(run);
      byModel.set(modelKey, modelRuns);
    }
  }

  return {
    costPerCompletedRun: ratio({
      key: "cost-per-completed-run",
      label: "Cost per completed run",
      numerator: completedUsd,
      denominator: completed.length,
      coverage: completedCoverage,
      evidenceRunIds: unique(completed.map((run) => run.runId)),
    }),
    costPerReviewablePr: ratio({
      key: "cost-per-reviewable-pr",
      label: "Cost per reviewable PR",
      numerator: reviewableUsd,
      denominator: reviewableGroups.length,
      coverage: reviewableCoverage,
      evidenceRunIds: unique(reviewableRuns.map((run) => run.runId)),
    }),
    costPerAcceptedPr: ratio({
      key: "cost-per-accepted-pr",
      label: "Cost per accepted PR",
      numerator: acceptedUsd,
      denominator: acceptedGroups.length,
      coverage: acceptedCoverage,
      evidenceRunIds: unique(acceptedRuns.map((run) => run.runId)),
    }),
    costPerMergedPr: ratio({
      key: "cost-per-merged-pr",
      label: "Cost per merged PR",
      numerator: mergedUsd,
      denominator: mergedGroups.length,
      coverage: mergedCoverage,
      evidenceRunIds: unique(mergedRuns.map((run) => run.runId)),
    }),
    costPerSuccessfulReviewGate: ratio({
      key: "cost-per-successful-review-gate",
      label: "Cost per successful review gate",
      numerator: gateUsd,
      denominator: gateRuns.length,
      coverage: gateCoverage,
      evidenceRunIds: unique(gateRuns.map((run) => run.runId)),
    }),
    tokensPerAcceptedOutcome: {
      key: "tokens-per-accepted-outcome",
      label: "Tokens per accepted outcome",
      numerator: tokenTotal(acceptedRuns),
      denominator: acceptedGroups.length,
      sampleCount: acceptedRuns.length,
      ...(acceptedGroups.length > 0
        ? { value: tokenTotal(acceptedRuns) / acceptedGroups.length }
        : {}),
      coverage: acceptedCoverage,
      evidenceRunIds: unique(acceptedRuns.map((run) => run.runId)),
    },
    latencyMsPerAcceptedOutcome: {
      key: "latency-ms-per-accepted-outcome",
      label: "Latency per accepted outcome",
      numerator: latencyTotal(acceptedRuns),
      denominator: acceptedGroups.length,
      sampleCount: acceptedRuns.length,
      ...(acceptedGroups.length > 0
        ? { value: latencyTotal(acceptedRuns) / acceptedGroups.length }
        : {}),
      coverage: acceptedCoverage,
      evidenceRunIds: unique(acceptedRuns.map((run) => run.runId)),
    },
    retryReworkCostShare: ratio({
      key: "retry-rework-cost-share",
      label: "Retry/rework cost share",
      numerator: reworkUsd,
      denominator: completeCostUsd(costCoverage(runs)) ?? 0,
      coverage: reworkCoverage,
      evidenceRunIds: unique(reworkRuns.map((run) => run.runId)),
    }),
    byFlow: [...byFlow.entries()].map(([key, group]) =>
      breakdown("flow", key, key, group),
    ),
    byRuntime: [...byRuntime.entries()].map(([key, group]) =>
      breakdown("runtime", key, key, group),
    ),
    byModel: [...byModel.entries()].map(([key, group]) =>
      breakdown("model", key, key, group),
    ),
  };
}
