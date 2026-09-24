import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import {
  evalManifestSha256,
  type EvalCohortManifest,
} from "./manifest.js";
import type { EvalCohortReport, EvalCohortSummary } from "./report.js";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);
const relativePathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) {
    return false;
  }
  return value.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "path must be a contained relative path");

const routingCandidateSchema = z.object({
  id: idSchema,
  runtime: idSchema,
  model: z.string().trim().min(1),
  cohortManifestPath: relativePathSchema,
  reportPath: relativePathSchema,
}).strict();

export const modelRoutingExperimentSchema = z.object({
  schemaVersion: z.literal("nitely.model-routing-experiment.v1"),
  experiment: z.object({
    id: idSchema,
    flow: z.object({ path: relativePathSchema, sha256: sha256Schema }).strict(),
    stageId: idSchema,
    baselineManifestSha256: sha256Schema,
  }).strict(),
  candidates: z.array(routingCandidateSchema).min(2).max(64),
  budget: z.object({
    maxCandidates: z.number().int().positive(),
    maxRuns: z.number().int().positive(),
    maxRuntimeCostUsd: z.number().finite().nonnegative().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    maxRuntimeTokens: z.number().int().positive().optional(),
  }).strict(),
  policy: z.object({
    minScoringPassRate: z.number().min(0).max(1).default(1),
    minReviewablePrRate: z.number().min(0).max(1).default(1),
    requireCompleteCases: z.boolean().default(true),
    requireKnownCost: z.boolean().default(true),
  }).strict(),
  reevaluate: z.object({
    expiresAt: z.string().datetime({ offset: true }).optional(),
    providerVersions: z.record(z.string(), z.string().trim().min(1)).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    if (ids.has(candidate.id)) {
      context.addIssue({ code: "custom", message: `duplicate candidate id: ${candidate.id}`, path: ["candidates", index, "id"] });
    }
    ids.add(candidate.id);
  }
});

export type ModelRoutingExperiment = z.infer<typeof modelRoutingExperimentSchema>;

export function parseModelRoutingExperiment(value: unknown): ModelRoutingExperiment {
  return modelRoutingExperimentSchema.parse(value);
}

export async function loadModelRoutingExperiment(path: string): Promise<{
  experiment: ModelRoutingExperiment;
  document: string;
  sha256: string;
}> {
  const document = await readFile(path, "utf8");
  const experiment = parseModelRoutingExperiment(JSON.parse(document) as unknown);
  return {
    experiment,
    document,
    sha256: `sha256:${createHash("sha256").update(canonicalJson(experiment), "utf8").digest("hex")}`,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`routing experiment contains a non-JSON value: ${typeof value}`);
}

const rateSchema = z.object({ numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative(), value: z.number().finite().min(0).max(1) }).strict();
const averageSchema = z.object({ total: z.number().finite().nonnegative(), samples: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), value: z.number().finite().nonnegative().optional(), overflowed: z.literal(true).optional() }).strict();
const summarySchema = z.object({
  schemaVersion: z.literal("nitely.eval-cohort-summary.v1"),
  cohortId: idSchema,
  runCount: z.number().int().nonnegative(),
  caseIds: z.array(idSchema),
  reviewablePrRate: rateSchema,
  gatePassRate: rateSchema,
  scoringPassRate: rateSchema,
  retriesPerRun: averageSchema,
  humanReworkPerRun: averageSchema,
  latencyMs: averageSchema,
  actualCostUsd: averageSchema,
  estimatedCostUsd: averageSchema,
  outcomes: z.object({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).strict().optional(),
  usage: z.object({
    knownAttempts: z.number().int().nonnegative(),
    unknownAttempts: z.number().int().nonnegative(),
    totalTokens: z.number().finite().nonnegative().optional(),
    attemptCountsOverflowed: z.literal(true).optional(),
  }).strict(),
  // Routing ranks cost and quality rates, not reviewer scores, but a cohort
  // that also evaluates reviewers carries them here and the strict object
  // would otherwise reject the whole report.
  reviewer: z.object({}).passthrough().optional(),
}).strict();

const routingReportSchema = z.object({
  schemaVersion: z.literal("nitely.eval-report.v1"),
  status: z.enum(["passed", "regressed", "insufficient_data"]),
  baselineManifestSha256: sha256Schema,
  candidateManifestSha256: sha256Schema,
  runLineage: z.object({
    candidate: z.array(z.object({ caseId: idSchema, runId: idSchema }).strict()),
  }).passthrough(),
  candidate: summarySchema,
  coverage: z.object({
    baselineMissingCaseIds: z.array(idSchema),
    candidateMissingCaseIds: z.array(idSchema),
    baselineDuplicateCaseIds: z.array(idSchema),
    candidateDuplicateCaseIds: z.array(idSchema),
    baselineOnlyManifestCaseIds: z.array(idSchema),
    candidateOnlyManifestCaseIds: z.array(idSchema),
    incompatibleCaseIds: z.array(idSchema),
  }).strict(),
}).passthrough();

export function parseModelRoutingReport(value: unknown): EvalCohortReport {
  return routingReportSchema.parse(value) as unknown as EvalCohortReport;
}

export interface ModelRoutingCandidateInput {
  id: string;
  stageId: string;
  runtime: string;
  model: string;
  manifest: EvalCohortManifest;
  manifestSha256: string;
  report: EvalCohortReport;
}

type CostKind = "actual" | "estimated";

interface CandidateMetrics {
  scoringPassRate: number;
  reviewablePrRate: number;
  gatePassRate: number;
  retriesPerRun: number;
  humanReworkPerRun: number;
  latencyMs: number;
  costUsd?: number;
  costKind?: CostKind;
  unknownAttemptRate: number;
  incompleteRunRate?: number;
}

interface RoutingCoverage {
  completeCases: boolean;
  costKnown: boolean;
  unknownAttempts: number;
  totalAttempts: number;
}

export interface ModelRoutingRecommendation {
  schemaVersion: "nitely.model-routing-recommendation.v1";
  generatedAt: string;
  experimentId: string;
  experimentSha256: string;
  flow: ModelRoutingExperiment["experiment"]["flow"];
  baselineManifestSha256: string;
  stageId: string;
  budget: {
    configured: ModelRoutingExperiment["budget"];
    observedCandidates: number;
    observedRuns: number;
    observedRuntimeCostUsd?: number;
    observedDurationMs?: number;
    observedRuntimeTokens?: number;
    exhausted: boolean;
  };
  candidates: Array<{
    id: string;
    runtime: string;
    model: string;
    configSha256: string;
    manifestSha256: string;
    runLineage: Array<{ caseId: string; runId: string }>;
    metrics: CandidateMetrics;
    coverage: RoutingCoverage;
    eligible: boolean;
    frontier: boolean;
    exclusionReasons: string[];
    dominatedBy: string[];
  }>;
  frontierCandidateIds: string[];
  recommendation: {
    status: "recommended" | "insufficient_data" | "no_feasible_candidate";
    candidateId?: string;
    rationale: string[];
    expiresAt?: string;
    reevaluateWhen: string[];
  };
}

function averageValue(value: EvalCohortSummary["latencyMs"]): number | undefined {
  return value.missing === 0 && value.value !== undefined ? value.value : undefined;
}

function taskContract(manifest: EvalCohortManifest, stageId: string): string {
  return canonicalJson(manifest.cases.map((entry) => ({
    id: entry.id,
    baselineRunId: entry.baselineRunId,
    source: entry.source,
    flow: entry.flow,
    inputs: entry.inputs,
    configuration: entry.configuration ?? {},
    contextPolicy: entry.contextPolicy,
    expectedGates: entry.expectedGates,
    allowedNondeterminism: entry.allowedNondeterminism,
    scoring: entry.scoring,
    environment: {
      executionBackend: entry.runtime.executionBackend,
      sandboxPolicy: entry.runtime.sandboxPolicy,
      stages: entry.runtime.stages.filter((stage) => stage.stageId !== stageId),
    },
  })));
}

function configSha256(input: ModelRoutingCandidateInput): string {
  return `sha256:${createHash("sha256").update(canonicalJson({
    manifestSha256: input.manifestSha256,
    stageId: input.stageId,
    runtime: input.runtime,
    model: input.model,
  }), "utf8").digest("hex")}`;
}

function candidateMetrics(summary: EvalCohortSummary): CandidateMetrics {
  const totalAttempts = summary.usage.knownAttempts + summary.usage.unknownAttempts;
  const actual = averageValue(summary.actualCostUsd);
  const estimated = averageValue(summary.estimatedCostUsd);
  const incompleteRunRate = summary.outcomes === undefined || summary.runCount === 0
    ? undefined
    : (summary.runCount - summary.outcomes.completed) / summary.runCount;
  return {
    scoringPassRate: summary.scoringPassRate.value,
    reviewablePrRate: summary.reviewablePrRate.value,
    gatePassRate: summary.gatePassRate.value,
    retriesPerRun: averageValue(summary.retriesPerRun) ?? Number.POSITIVE_INFINITY,
    humanReworkPerRun: averageValue(summary.humanReworkPerRun) ?? Number.POSITIVE_INFINITY,
    latencyMs: averageValue(summary.latencyMs) ?? Number.POSITIVE_INFINITY,
    ...(actual !== undefined ? { costUsd: actual, costKind: "actual" as const } : estimated !== undefined ? { costUsd: estimated, costKind: "estimated" as const } : {}),
    unknownAttemptRate: totalAttempts > 0 ? summary.usage.unknownAttempts / totalAttempts : 1,
    ...(incompleteRunRate !== undefined ? { incompleteRunRate } : {}),
  };
}

function dominates(left: CandidateMetrics, right: CandidateMetrics): boolean {
  const comparisons: Array<[number, number, "max" | "min"]> = [
    [left.scoringPassRate, right.scoringPassRate, "max"],
    [left.reviewablePrRate, right.reviewablePrRate, "max"],
    [left.gatePassRate, right.gatePassRate, "max"],
    [left.retriesPerRun, right.retriesPerRun, "min"],
    [left.humanReworkPerRun, right.humanReworkPerRun, "min"],
    [left.latencyMs, right.latencyMs, "min"],
  ];
  if (left.incompleteRunRate !== undefined && right.incompleteRunRate !== undefined) {
    comparisons.push([left.incompleteRunRate, right.incompleteRunRate, "min"]);
  }
  if (left.costKind && left.costKind === right.costKind && left.costUsd !== undefined && right.costUsd !== undefined) {
    comparisons.push([left.costUsd, right.costUsd, "min"]);
  }
  let strict = false;
  for (const [leftValue, rightValue, direction] of comparisons) {
    const noWorse = direction === "max" ? leftValue >= rightValue : leftValue <= rightValue;
    const better = direction === "max" ? leftValue > rightValue : leftValue < rightValue;
    if (!noWorse) return false;
    strict ||= better;
  }
  return strict;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function buildModelRoutingRecommendation(input: {
  experiment: ModelRoutingExperiment;
  experimentSha256: string;
  candidates: readonly ModelRoutingCandidateInput[];
  generatedAt?: string;
}): ModelRoutingRecommendation {
  const expectedContract = input.candidates[0] ? taskContract(input.candidates[0].manifest, input.experiment.experiment.stageId) : "";
  const expectedBaselineManifestSha256 = input.experiment.experiment.baselineManifestSha256;
  const candidateCaseIds = input.candidates[0]?.manifest.cases.map((entry) => entry.id) ?? [];
  const observedRuns = input.candidates.reduce((total, entry) => total + entry.report.candidate.runCount, 0);
  const observedCosts = input.candidates.map((entry) => {
    const metric = candidateMetrics(entry.report.candidate);
    return metric.costUsd === undefined ? undefined : metric.costUsd * entry.report.candidate.runCount;
  });
  const observedRuntimeCostUsd = observedCosts.every((value) => value !== undefined)
    ? observedCosts.reduce((total, value) => total + (value ?? 0), 0)
    : undefined;
  const observedDurationMs = input.candidates.reduce((total, entry) => {
    const value = averageValue(entry.report.candidate.latencyMs);
    return value === undefined ? Number.NaN : total + value * entry.report.candidate.runCount;
  }, 0);
  const observedRuntimeTokens = input.candidates.reduce((total, entry) => {
    const value = entry.report.candidate.usage.totalTokens;
    return value === undefined ? Number.NaN : total + value;
  }, 0);
  const budget = input.experiment.budget;
  const budgetExhausted = input.candidates.length > budget.maxCandidates ||
    observedRuns > budget.maxRuns ||
    (budget.maxRuntimeCostUsd !== undefined && (observedRuntimeCostUsd === undefined || observedRuntimeCostUsd > budget.maxRuntimeCostUsd)) ||
    (budget.maxDurationMs !== undefined && (!Number.isFinite(observedDurationMs) || observedDurationMs > budget.maxDurationMs)) ||
    (budget.maxRuntimeTokens !== undefined && (!Number.isFinite(observedRuntimeTokens) || observedRuntimeTokens > budget.maxRuntimeTokens));

  const candidates = input.candidates.map((entry) => {
    const summary = entry.report.candidate;
    const metrics = candidateMetrics(summary);
    const reportCoverage = entry.report.coverage;
    const expectedCaseIds = entry.manifest.cases.map((candidate) => candidate.id);
    const lineageCaseIds = entry.report.runLineage.candidate.map((lineage) => lineage.caseId);
    const lineageRunIds = entry.report.runLineage.candidate.map((lineage) => lineage.runId);
    const completeCases = sameIds(summary.caseIds, expectedCaseIds) &&
      sameIds(lineageCaseIds, expectedCaseIds) &&
      new Set(lineageRunIds).size === lineageRunIds.length &&
      summary.cohortId === entry.manifest.cohort.id &&
      reportCoverage.baselineMissingCaseIds.length === 0 &&
      reportCoverage.candidateMissingCaseIds.length === 0 &&
      reportCoverage.baselineDuplicateCaseIds.length === 0 &&
      reportCoverage.candidateDuplicateCaseIds.length === 0 &&
      reportCoverage.baselineOnlyManifestCaseIds.length === 0 &&
      reportCoverage.candidateOnlyManifestCaseIds.length === 0 &&
      reportCoverage.incompatibleCaseIds.length === 0;
    const totalAttempts = summary.usage.knownAttempts + summary.usage.unknownAttempts;
    const coverage: RoutingCoverage = {
      completeCases,
      costKnown: metrics.costUsd !== undefined && summary.usage.unknownAttempts === 0,
      unknownAttempts: summary.usage.unknownAttempts,
      totalAttempts,
    };
    const exclusionReasons: string[] = [];
    if (entry.report.candidateManifestSha256 !== entry.manifestSha256) exclusionReasons.push("candidate report manifest lineage does not match");
    if (entry.report.baselineManifestSha256 !== expectedBaselineManifestSha256) exclusionReasons.push("baseline manifest lineage does not match");
    if (taskContract(entry.manifest, input.experiment.experiment.stageId) !== expectedContract) exclusionReasons.push("candidate task contract differs");
    if (entry.manifest.cases.some((candidate) => candidate.flow.sha256 !== input.experiment.experiment.flow.sha256)) exclusionReasons.push("flow digest differs from experiment");
    if (entry.manifest.cases.some((candidate) => {
      const stage = candidate.runtime.stages.find((selection) => selection.stageId === input.experiment.experiment.stageId);
      return !stage || stage.runtime !== entry.runtime || stage.model !== entry.model;
    })) exclusionReasons.push("candidate runtime selection does not match experiment");
    if (!sameIds(summary.caseIds, candidateCaseIds)) exclusionReasons.push("candidate case coverage differs");
    if (input.experiment.policy.requireCompleteCases && !completeCases) exclusionReasons.push("incomplete or duplicate case evidence");
    if (summary.scoringPassRate.value < input.experiment.policy.minScoringPassRate) exclusionReasons.push("scoring pass rate below policy");
    if (summary.reviewablePrRate.value < input.experiment.policy.minReviewablePrRate) exclusionReasons.push("reviewable PR rate below policy");
    if (input.experiment.policy.requireKnownCost && !coverage.costKnown) exclusionReasons.push("cost coverage is unknown");
    if (entry.report.status !== "passed") exclusionReasons.push("cohort report did not pass its declared thresholds");
    for (const [metric, value] of [
      ["retries", averageValue(summary.retriesPerRun)],
      ["human rework", averageValue(summary.humanReworkPerRun)],
      ["latency", averageValue(summary.latencyMs)],
    ] as const) {
      if (value === undefined) exclusionReasons.push(`${metric} coverage is unknown`);
    }
    if (metrics.incompleteRunRate === undefined) exclusionReasons.push("terminal outcome coverage is unknown");
    if (budgetExhausted) exclusionReasons.push("experiment budget exhausted");
    return {
      id: entry.id,
      runtime: entry.runtime,
      model: entry.model,
      configSha256: configSha256(entry),
      manifestSha256: entry.manifestSha256,
      runLineage: entry.report.runLineage.candidate,
      metrics,
      coverage,
      eligible: exclusionReasons.length === 0,
      frontier: false,
      exclusionReasons,
      dominatedBy: [] as string[],
    };
  });
  const eligible = candidates.filter((candidate) => candidate.eligible);
  for (const candidate of eligible) {
    for (const other of eligible) {
      if (candidate === other || !dominates(other.metrics, candidate.metrics)) continue;
      candidate.dominatedBy.push(other.id);
    }
  }
  const frontier = eligible.filter((candidate) => candidate.dominatedBy.length === 0);
  for (const candidate of frontier) candidate.frontier = true;
  const recommendationStatus = frontier.length === 1 && !budgetExhausted
    ? "recommended" as const
    : eligible.length === 0
      ? "no_feasible_candidate" as const
      : "insufficient_data" as const;
  const rationale = budgetExhausted
    ? ["evidence exceeds the declared experiment budget; rerun with a larger bounded budget"]
    : frontier.length === 1
      ? [`${frontier[0].id} is the only non-dominated candidate under the declared metrics and policy`]
      : frontier.length > 1
        ? ["multiple non-dominated candidates remain; keep routing unchanged until more evidence separates them"]
        : ["no candidate satisfies the declared evidence policy"];
  const reevaluateWhen = [
    `flow digest changes from ${input.experiment.experiment.flow.sha256}`,
    "the provider or model version changes",
    ...(input.experiment.reevaluate?.providerVersions ? ["a declared provider version changes"] : []),
  ];
  return {
    schemaVersion: "nitely.model-routing-recommendation.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    experimentId: input.experiment.experiment.id,
    experimentSha256: input.experimentSha256,
    flow: input.experiment.experiment.flow,
    baselineManifestSha256: input.experiment.experiment.baselineManifestSha256,
    stageId: input.experiment.experiment.stageId,
    budget: {
      configured: budget,
      observedCandidates: input.candidates.length,
      observedRuns,
      ...(observedRuntimeCostUsd !== undefined ? { observedRuntimeCostUsd } : {}),
      ...(Number.isFinite(observedDurationMs) ? { observedDurationMs } : {}),
      ...(Number.isFinite(observedRuntimeTokens) ? { observedRuntimeTokens } : {}),
      exhausted: budgetExhausted,
    },
    candidates,
    frontierCandidateIds: frontier.map((candidate) => candidate.id),
    recommendation: {
      status: recommendationStatus,
      ...(recommendationStatus === "recommended" ? { candidateId: frontier[0].id } : {}),
      rationale,
      ...(input.experiment.reevaluate?.expiresAt ? { expiresAt: input.experiment.reevaluate.expiresAt } : {}),
      reevaluateWhen,
    },
  };
}

export { evalManifestSha256 };
