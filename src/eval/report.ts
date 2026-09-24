import { existsSync } from "node:fs";

import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { eventStorePath } from "../run/project.js";
import {
  evalManifestSha256,
  type EvalCase,
  type EvalCohortManifest,
} from "./manifest.js";
import {
  aggregateReviewerMetrics,
  normalizeReviewerOutput,
  scoreReviewerCase,
  type ReviewerCaseScore,
  type ReviewerCohortMetrics,
} from "./reviewer.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EvalRunSample {
  schemaVersion: "nitely.eval-run-sample.v1";
  runId: string;
  cohortId: string;
  caseId: string;
  baselineCohortId?: string;
  baselineRunId: string;
  terminalStatus?: "completed" | "failed" | "blocked" | "cancelled";
  reviewablePr: boolean;
  expectedGatesPassed: boolean;
  scoringPassed: boolean;
  retries: number;
  humanRework: number;
  latencyMs?: number;
  usage: {
    knownAttempts: number;
    unknownAttempts: number;
    totalTokens?: number;
    actualCostUsd?: number;
    estimatedCostUsd?: number;
  };
  reviewer?: ReviewerCaseScore;
}

export interface EvalRateMetric {
  numerator: number;
  denominator: number;
  value: number;
}

export interface EvalAverageMetric {
  total: number;
  samples: number;
  missing: number;
  value?: number;
  overflowed?: true;
}

export interface EvalCohortSummary {
  schemaVersion: "nitely.eval-cohort-summary.v1";
  cohortId: string;
  runCount: number;
  caseIds: string[];
  reviewablePrRate: EvalRateMetric;
  gatePassRate: EvalRateMetric;
  scoringPassRate: EvalRateMetric;
  retriesPerRun: EvalAverageMetric;
  humanReworkPerRun: EvalAverageMetric;
  latencyMs: EvalAverageMetric;
  actualCostUsd: EvalAverageMetric;
  estimatedCostUsd: EvalAverageMetric;
  outcomes: {
    completed: number;
    failed: number;
    blocked: number;
    cancelled: number;
    unknown: number;
  };
  usage: {
    knownAttempts: number;
    unknownAttempts: number;
    totalTokens?: number;
    attemptCountsOverflowed?: true;
  };
  reviewer?: ReviewerCohortMetrics;
}

export type EvalComparisonMetric =
  | "reviewablePrRate"
  | "gatePassRate"
  | "retriesPerRun"
  | "humanReworkPerRun"
  | "latencyMs"
  | "actualCostUsd"
  | "estimatedCostUsd"
  | "reviewerCriticalRecall"
  | "reviewerOverallRecall"
  | "reviewerFalsePositiveRate"
  | "reviewerPassOnDefectiveRate"
  | "reviewerFailOnKnownGoodRate";

export interface EvalMetricComparison {
  metric: EvalComparisonMetric;
  status: "passed" | "regressed" | "not_comparable";
  baselineValue?: number;
  candidateValue?: number;
  threshold:
    | { maxAbsoluteDecrease: number }
    | { maxRelativeIncrease: number };
  observedChange?: number;
  unboundedIncrease?: true;
}

export interface EvalRunLineageEntry {
  caseId: string;
  runId: string;
}

export interface EvalCohortReport {
  schemaVersion: "nitely.eval-report.v1";
  generatedAt: string;
  status: "passed" | "regressed" | "insufficient_data";
  baselineManifestSha256: string;
  candidateManifestSha256: string;
  runLineage: {
    baseline: EvalRunLineageEntry[];
    candidate: EvalRunLineageEntry[];
  };
  baseline: EvalCohortSummary;
  candidate: EvalCohortSummary;
  comparisons: EvalMetricComparison[];
  regressions: EvalMetricComparison[];
  coverage: {
    baselineMissingCaseIds: string[];
    candidateMissingCaseIds: string[];
    baselineDuplicateCaseIds: string[];
    candidateDuplicateCaseIds: string[];
    baselineOnlyManifestCaseIds: string[];
    candidateOnlyManifestCaseIds: string[];
    incompatibleCaseIds: string[];
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function addNonNegativeFinite(left: number, right: number): number | undefined {
  const total = left + right;
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function sumNonNegativeFinite(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const nextTotal = addNonNegativeFinite(total, value);
    if (nextTotal === undefined) return undefined;
    total = nextTotal;
  }
  return total;
}

function sumNonNegativeSafeIntegers(
  values: readonly number[],
): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    const nextTotal = total + value;
    if (!Number.isSafeInteger(nextTotal)) return undefined;
    total = nextTotal;
  }
  return total;
}

function attemptKey(event: StoredRunEvent): string | undefined {
  return event.stageId && event.attempt
    ? `${event.stageId}:${event.attempt}`
    : undefined;
}

function gatePassed(event: StoredRunEvent): boolean {
  const payload = asRecord(event.payload);
  const gate = asRecord(payload.gate);
  return gate.status === "passed";
}

function humanReworkEvent(event: StoredRunEvent): boolean {
  if (event.type === "run.created") {
    const trigger = asRecord(asRecord(event.payload).trigger);
    return trigger.type === "github-pr-comment" &&
      asString(trigger.authorLogin) !== undefined &&
      (trigger.action === "rework" || trigger.action === "address");
  }
  if (event.type === "operator.review.resolved") return true;
  return event.type === "stage.rework.requested";
}

function terminalRunEvent(event: StoredRunEvent): boolean {
  return event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.blocked" ||
    event.type === "run.cancelled";
}

export function deriveEvalRunSample(input: {
  events: StoredRunEvent[];
  evalCase: EvalCase;
  manifest: EvalCohortManifest;
}): EvalRunSample | undefined {
  const allEvents = [...input.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const link = allEvents.findLast(
    (event) => event.type === "eval.replay.linked",
  );
  if (!link) return undefined;
  const events = allEvents.filter((event) => event.runId === link.runId);
  const linkPayload = asRecord(link.payload);
  const created = events.find((event) => event.type === "run.created");
  if (!created) return undefined;
  const firstOrdinaryEvent = events.find(
    (event) => event.type !== "eval.replay.linked",
  );
  if (!firstOrdinaryEvent) return undefined;
  const createdInvocationId = asRecord(created.payload).evalReplayInvocationId;
  const linkedInvocationId = linkPayload.invocationId;
  const evalCase = input.manifest.cases.find(
    (candidate) => candidate.id === input.evalCase.id,
  );
  if (!evalCase) return undefined;
  const baselineCohortId = input.manifest.cohort.baselineCohortId;
  const expectedAllowedNondeterminism = evalCase.allowedNondeterminism.map(
    (entry) => entry.id,
  );
  const linkedAllowedNondeterminism = Array.isArray(
      linkPayload.allowedNondeterminism
    ) && linkPayload.allowedNondeterminism.every(
      (entry): entry is string => typeof entry === "string",
    )
    ? linkPayload.allowedNondeterminism
    : undefined;
  const linkOutcome = linkPayload.outcome;
  if (
    linkPayload.schemaVersion !== "nitely.eval-replay-link.v1" ||
    typeof createdInvocationId !== "string" ||
    !UUID_V4_PATTERN.test(createdInvocationId) ||
    typeof linkedInvocationId !== "string" ||
    !UUID_V4_PATTERN.test(linkedInvocationId) ||
    linkedInvocationId !== createdInvocationId ||
    linkPayload.cohortId !== input.manifest.cohort.id ||
    linkPayload.caseId !== evalCase.id ||
    linkPayload.manifestSha256 !== evalManifestSha256(input.manifest) ||
    linkPayload.sourceRevision !== evalCase.source.revision ||
    linkPayload.baselineRunId !== evalCase.baselineRunId ||
    linkPayload.baselineCohortId !== baselineCohortId ||
    linkedAllowedNondeterminism === undefined ||
    linkedAllowedNondeterminism.length !== expectedAllowedNondeterminism.length ||
    linkedAllowedNondeterminism.some(
      (entry, index) => entry !== expectedAllowedNondeterminism[index],
    ) ||
    (linkOutcome !== "completed" &&
      linkOutcome !== "failed" &&
      linkOutcome !== "awaiting-approval")
  ) {
    return undefined;
  }
  const cohortId = input.manifest.cohort.id;

  const linkIndex = events.lastIndexOf(link);
  const terminalAtLink = events
    .slice(0, linkIndex + 1)
    .findLast(terminalRunEvent);
  const terminal = events.findLast(terminalRunEvent);
  if (!terminal) return undefined;
  if (
    (linkOutcome === "completed" && terminalAtLink?.type !== "run.completed") ||
    (linkOutcome === "failed" &&
      (terminalAtLink === undefined || terminalAtLink.type === "run.completed")) ||
    (linkOutcome === "awaiting-approval" && terminalAtLink !== undefined)
  ) {
    return undefined;
  }
  const latency = Date.parse(terminal.createdAt) -
    Date.parse(firstOrdinaryEvent.createdAt);
  const terminalStatus = terminal?.type.slice("run.".length) as
    | EvalRunSample["terminalStatus"]
    | undefined;

  const gateEvents = new Map<string, StoredRunEvent>();
  for (const event of events) {
    if (event.type === "gate.completed" && event.stageId) {
      gateEvents.set(event.stageId, event);
    }
  }
  const expectedGatesPassed = evalCase.expectedGates.every((gateId) => {
    const event = gateEvents.get(gateId);
    return event !== undefined && gatePassed(event);
  });
  const reviewablePr = events.some(
    (event) => event.type === "change.published" || event.type === "change.updated",
  );

  const runtimeAttempts = new Set<string>();
  const knownAttempts = new Set<string>();
  const usageEvents = new Map<string, StoredRunEvent>();
  const actualCostAttempts = new Set<string>();
  const estimatedCostAttempts = new Set<string>();
  let totalTokens: number | undefined;
  let actualCostUsd: number | undefined;
  let estimatedCostUsd: number | undefined;
  let totalTokensOverflowed = false;
  let actualCostOverflowed = false;
  let estimatedCostOverflowed = false;
  for (const event of events) {
    const key = attemptKey(event);
    const payload = asRecord(event.payload);
    if (
      key &&
      ((event.type === "stage.started" &&
          (payload.type === "agent" ||
            (payload.type === "gate" && payload.mode === "review") ||
            asString(payload.runtime) !== undefined)) ||
        event.type === "stage.runtime.selected" ||
        event.type === "stage.runtime.fallback" ||
        event.type === "stage.runtime.unavailable" ||
        event.type === "stage.runtime.usage")
    ) {
      runtimeAttempts.add(key);
    }
    if (event.type === "stage.runtime.usage" && key) {
      usageEvents.set(key, event);
    }
  }
  for (const [key, event] of usageEvents) {
    const usage = asRecord(event.payload);
    const inputTokens = asNonNegativeInteger(usage.inputTokens);
    const outputTokens = asNonNegativeInteger(usage.outputTokens);
    const explicitTotalTokens = asNonNegativeInteger(usage.totalTokens);
    const tokenFieldMalformed = [
      [usage.inputTokens, inputTokens],
      [usage.outputTokens, outputTokens],
      [usage.totalTokens, explicitTotalTokens],
    ].some(([raw, parsed]) => raw !== undefined && parsed === undefined);
    const tokenTotalInconsistent =
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      explicitTotalTokens !== undefined &&
      inputTokens + outputTokens !== explicitTotalTokens;
    const validTokenObservation = !tokenFieldMalformed &&
      !tokenTotalInconsistent &&
      (inputTokens !== undefined ||
        outputTokens !== undefined ||
        explicitTotalTokens !== undefined);
    const tokens = validTokenObservation
      ? explicitTotalTokens ?? (
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined
        )
      : undefined;
    if (tokens !== undefined && !totalTokensOverflowed) {
      const nextTotal = addNonNegativeFinite(totalTokens ?? 0, tokens);
      if (nextTotal === undefined) {
        totalTokens = undefined;
        totalTokensOverflowed = true;
      } else {
        totalTokens = nextTotal;
      }
    }
    const cost = asRecord(usage.cost);
    const usd = asNonNegativeNumber(cost.usd);
    const provenance = asRecord(usage.provenance);
    const source = asRecord(provenance.source);
    const validProvenance =
      asString(provenance.provider) !== undefined &&
      asString(provenance.observedAt) !== undefined &&
      Number.isFinite(Date.parse(String(provenance.observedAt))) &&
      asString(source.reference) !== undefined &&
      (source.kind === "provider-reported" || source.kind === "calculated");
    const validActualCost =
      cost.classification === "actual" &&
      usd !== undefined &&
      validProvenance &&
      source.kind === "provider-reported";
    const validEstimatedCost =
      cost.classification === "estimated" &&
      usd !== undefined &&
      validProvenance &&
      source.kind === "calculated" &&
      asString(cost.method) !== undefined;
    const validUnknownCost =
      cost.classification === "unknown" &&
      cost.usd === undefined &&
      cost.method === undefined &&
      validProvenance;
    if (validTokenObservation || validActualCost || validEstimatedCost || validUnknownCost) {
      knownAttempts.add(key);
    }
    if (validActualCost) {
      actualCostAttempts.add(key);
      if (!actualCostOverflowed) {
        const nextTotal = addNonNegativeFinite(actualCostUsd ?? 0, usd);
        if (nextTotal === undefined) {
          actualCostUsd = undefined;
          actualCostOverflowed = true;
        } else {
          actualCostUsd = nextTotal;
        }
      }
    } else if (validEstimatedCost) {
      estimatedCostAttempts.add(key);
      if (!estimatedCostOverflowed) {
        const nextTotal = addNonNegativeFinite(estimatedCostUsd ?? 0, usd);
        if (nextTotal === undefined) {
          estimatedCostUsd = undefined;
          estimatedCostOverflowed = true;
        } else {
          estimatedCostUsd = nextTotal;
        }
      }
    }
  }

  const scoringPassed =
    (!evalCase.scoring.requireReviewablePr || reviewablePr) &&
    (!evalCase.scoring.requireExpectedGates || expectedGatesPassed);

  let reviewer: ReviewerCaseScore | undefined;
  if (evalCase.reviewEvaluation) {
    const outputs = evalCase.reviewEvaluation.reviewerStageIds.flatMap((stageId) => {
      const event = events.findLast((candidate) =>
        candidate.stageId === stageId &&
        (candidate.type === "gate.completed" || candidate.type === "judge.completed"),
      );
      if (!event) return [];
      const payload = asRecord(event.payload);
      if (event.type === "judge.completed") {
        return [normalizeReviewerOutput({
          stageId,
          judge: { verdict: payload.verdict, findings: payload.findings },
        })];
      }
      const reviewOutput = asRecord(asRecord(payload.gate).reviewOutput);
      const content = asString(reviewOutput.content);
      return content ? [normalizeReviewerOutput({ stageId, content })] : [];
    });
    const score = scoreReviewerCase({
      evalCase,
      output: {
        verdict: outputs.findLast((output) => output.verdict)?.verdict,
        findings: outputs.flatMap((output) => output.findings),
      },
    });
    reviewer = {
      ...score,
      provenance: {
        sourceRevision: evalCase.source.revision,
        flowSha256: evalCase.flow.sha256,
        contextPolicySha256: evalCase.contextPolicy.sha256,
        manifestSha256: evalManifestSha256(input.manifest),
        stages: evalCase.runtime.stages.filter((stage) =>
          evalCase.reviewEvaluation?.reviewerStageIds.includes(stage.stageId),
        ),
        ...(latency !== undefined && Number.isFinite(latency) && latency >= 0
          ? { latencyMs: latency }
          : {}),
        usage: {
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
          ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        },
      },
    };
  }

  return {
    schemaVersion: "nitely.eval-run-sample.v1",
    runId: link.runId,
    cohortId,
    caseId: evalCase.id,
    ...(baselineCohortId
      ? { baselineCohortId }
      : {}),
    baselineRunId: evalCase.baselineRunId,
    ...(terminalStatus ? { terminalStatus } : {}),
    reviewablePr,
    expectedGatesPassed,
    scoringPassed,
    retries: events.filter((event) => event.type === "stage.retrying").length,
    humanRework: events.filter(humanReworkEvent).length,
    ...(latency !== undefined && Number.isFinite(latency) && latency >= 0
      ? { latencyMs: latency }
      : {}),
    usage: {
      knownAttempts: knownAttempts.size,
      unknownAttempts: Math.max(runtimeAttempts.size - knownAttempts.size, 0),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(runtimeAttempts.size > 0 &&
          actualCostAttempts.size === runtimeAttempts.size &&
          actualCostUsd !== undefined
        ? { actualCostUsd }
        : {}),
      ...(runtimeAttempts.size > 0 &&
          estimatedCostAttempts.size === runtimeAttempts.size &&
          estimatedCostUsd !== undefined
        ? { estimatedCostUsd }
        : {}),
    },
    ...(reviewer ? { reviewer } : {}),
  };
}

function rate(values: readonly boolean[]): EvalRateMetric {
  const numerator = values.filter(Boolean).length;
  return {
    numerator,
    denominator: values.length,
    value: values.length > 0 ? numerator / values.length : 0,
  };
}

function average(
  values: ReadonlyArray<number | undefined>,
): EvalAverageMetric {
  const present = values.filter((value): value is number => value !== undefined);
  const total = sumNonNegativeFinite(present);
  if (total === undefined) {
    return {
      total: 0,
      samples: 0,
      missing: values.length,
      overflowed: true,
    };
  }
  return {
    total,
    samples: present.length,
    missing: values.length - present.length,
    ...(present.length > 0 ? { value: total / present.length } : {}),
  };
}

function selectCohortSamples(
  cohortId: string,
  samples: readonly EvalRunSample[],
): EvalRunSample[] {
  const selectedByCase = new Map<string, EvalRunSample>();
  for (const sample of samples.filter((entry) => entry.cohortId === cohortId)) {
    const selected = selectedByCase.get(sample.caseId);
    if (!selected || stableSampleKey(sample) > stableSampleKey(selected)) {
      selectedByCase.set(sample.caseId, sample);
    }
  }
  return [...selectedByCase.values()].sort((left, right) =>
    left.caseId.localeCompare(right.caseId)
  );
}

export function aggregateEvalCohort(
  cohortId: string,
  samples: readonly EvalRunSample[],
): EvalCohortSummary {
  const cohortSamples = selectCohortSamples(cohortId, samples);
  const tokenValues = cohortSamples
    .map((sample) => sample.usage.totalTokens)
    .filter((value): value is number => value !== undefined);
  const totalTokens = sumNonNegativeFinite(tokenValues);
  const knownAttempts = sumNonNegativeSafeIntegers(
    cohortSamples.map((sample) => sample.usage.knownAttempts),
  );
  const unknownAttempts = sumNonNegativeSafeIntegers(
    cohortSamples.map((sample) => sample.usage.unknownAttempts),
  );
  const outcomes = {
    completed: cohortSamples.filter((sample) => sample.terminalStatus === "completed").length,
    failed: cohortSamples.filter((sample) => sample.terminalStatus === "failed").length,
    blocked: cohortSamples.filter((sample) => sample.terminalStatus === "blocked").length,
    cancelled: cohortSamples.filter((sample) => sample.terminalStatus === "cancelled").length,
    unknown: cohortSamples.filter((sample) => sample.terminalStatus === undefined).length,
  };
  const reviewerScores = cohortSamples
    .map((sample) => sample.reviewer)
    .filter((score): score is ReviewerCaseScore => score !== undefined);
  return {
    schemaVersion: "nitely.eval-cohort-summary.v1",
    cohortId,
    runCount: cohortSamples.length,
    caseIds: [...new Set(cohortSamples.map((sample) => sample.caseId))].sort(),
    reviewablePrRate: rate(cohortSamples.map((sample) => sample.reviewablePr)),
    gatePassRate: rate(
      cohortSamples.map((sample) => sample.expectedGatesPassed),
    ),
    scoringPassRate: rate(cohortSamples.map((sample) => sample.scoringPassed)),
    retriesPerRun: average(cohortSamples.map((sample) => sample.retries)),
    humanReworkPerRun: average(
      cohortSamples.map((sample) => sample.humanRework),
    ),
    latencyMs: average(cohortSamples.map((sample) => sample.latencyMs)),
    actualCostUsd: average(
      cohortSamples.map((sample) => sample.usage.actualCostUsd),
    ),
    estimatedCostUsd: average(
      cohortSamples.map((sample) => sample.usage.estimatedCostUsd),
    ),
    outcomes,
    usage: {
      knownAttempts: knownAttempts ?? 0,
      unknownAttempts: unknownAttempts ?? 0,
      ...(tokenValues.length > 0 && totalTokens !== undefined
        ? { totalTokens }
        : {}),
      ...(knownAttempts === undefined || unknownAttempts === undefined
        ? { attemptCountsOverflowed: true as const }
        : {}),
    },
    ...(reviewerScores.length > 0
      ? { reviewer: aggregateReviewerMetrics(reviewerScores) }
      : {}),
  };
}

const COMPARISON_METRICS: EvalComparisonMetric[] = [
  "reviewablePrRate",
  "gatePassRate",
  "retriesPerRun",
  "humanReworkPerRun",
  "latencyMs",
  "actualCostUsd",
  "estimatedCostUsd",
  "reviewerCriticalRecall",
  "reviewerOverallRecall",
  "reviewerFalsePositiveRate",
  "reviewerPassOnDefectiveRate",
  "reviewerFailOnKnownGoodRate",
];

function metricValue(
  summary: EvalCohortSummary,
  metric: EvalComparisonMetric,
): number | undefined {
  if (metric === "reviewablePrRate" || metric === "gatePassRate") {
    const rateMetric = summary[metric];
    return rateMetric.denominator > 0 ? rateMetric.value : undefined;
  }
  if (
    metric === "reviewerCriticalRecall" ||
    metric === "reviewerOverallRecall" ||
    metric === "reviewerFalsePositiveRate" ||
    metric === "reviewerPassOnDefectiveRate" ||
    metric === "reviewerFailOnKnownGoodRate"
  ) {
    const reviewer = summary.reviewer;
    if (!reviewer) return undefined;
    return {
      reviewerCriticalRecall: reviewer.criticalDefectRecall,
      reviewerOverallRecall: reviewer.overallDefectRecall,
      reviewerFalsePositiveRate: reviewer.falsePositiveRate,
      reviewerPassOnDefectiveRate: reviewer.passOnDefectiveRate,
      reviewerFailOnKnownGoodRate: reviewer.failOnKnownGoodRate,
    }[metric];
  }
  const averageMetric = summary[metric as
    | "retriesPerRun"
    | "humanReworkPerRun"
    | "latencyMs"
    | "actualCostUsd"
    | "estimatedCostUsd"];
  return averageMetric.missing === 0 ? averageMetric.value : undefined;
}

function compareMetric(input: {
  metric: EvalComparisonMetric;
  baselineValue: number | undefined;
  candidateValue: number | undefined;
  threshold: NonNullable<EvalCohortManifest["thresholds"][EvalComparisonMetric]>;
}): EvalMetricComparison {
  const base = {
    metric: input.metric,
    threshold: input.threshold,
    ...(input.baselineValue !== undefined
      ? { baselineValue: input.baselineValue }
      : {}),
    ...(input.candidateValue !== undefined
      ? { candidateValue: input.candidateValue }
      : {}),
  };
  if (input.baselineValue === undefined || input.candidateValue === undefined) {
    return { ...base, status: "not_comparable" };
  }
  if ("maxAbsoluteDecrease" in input.threshold) {
    const decrease = input.baselineValue - input.candidateValue;
    if (!Number.isFinite(decrease)) {
      return { ...base, status: "not_comparable" };
    }
    return {
      ...base,
      status: decrease <= input.threshold.maxAbsoluteDecrease + Number.EPSILON
        ? "passed"
        : "regressed",
      observedChange: decrease,
    };
  }
  const unboundedIncrease = input.baselineValue === 0 && input.candidateValue > 0;
  const increase = input.baselineValue === 0
    ? 0
    : (input.candidateValue - input.baselineValue) / input.baselineValue;
  if (!Number.isFinite(increase)) {
    return { ...base, status: "not_comparable" };
  }
  return {
    ...base,
    status: !unboundedIncrease &&
        increase <= input.threshold.maxRelativeIncrease + Number.EPSILON
      ? "passed"
      : "regressed",
    ...(unboundedIncrease
      ? { unboundedIncrease: true }
      : { observedChange: increase }),
  };
}

function missingCaseIds(
  manifest: EvalCohortManifest,
  samples: readonly EvalRunSample[],
): string[] {
  const present = new Set(
    samples
      .filter((sample) => sample.cohortId === manifest.cohort.id)
      .map((sample) => sample.caseId),
  );
  return manifest.cases
    .map((evalCase) => evalCase.id)
    .filter((caseId) => !present.has(caseId))
    .sort();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function stableSampleKey(sample: EvalRunSample): string {
  return `${sample.runId}\0${stableJson(sample)}`;
}

function duplicateCaseIds(
  manifest: EvalCohortManifest,
  samples: readonly EvalRunSample[],
): string[] {
  const manifestIds = new Set(manifest.cases.map((evalCase) => evalCase.id));
  const counts = new Map<string, number>();
  for (const sample of samples) {
    if (
      sample.cohortId !== manifest.cohort.id ||
      !manifestIds.has(sample.caseId)
    ) continue;
    counts.set(sample.caseId, (counts.get(sample.caseId) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([caseId]) => caseId)
    .sort();
}

function manifestCaseDifference(
  left: EvalCohortManifest,
  right: EvalCohortManifest,
): string[] {
  const rightIds = new Set(right.cases.map((evalCase) => evalCase.id));
  return left.cases
    .map((evalCase) => evalCase.id)
    .filter((caseId) => !rightIds.has(caseId))
    .sort();
}

function comparableTaskContract(evalCase: EvalCase): unknown {
  return {
    configuration: evalCase.configuration ?? {},
    inputs: [...evalCase.inputs]
      .map((entry) => ({ id: entry.id, sha256: entry.sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    expectedGates: [...evalCase.expectedGates].sort(),
    allowedNondeterminism: [...evalCase.allowedNondeterminism]
      .map((entry) => ({ id: entry.id, description: entry.description }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    scoring: evalCase.scoring,
    reviewEvaluation: evalCase.reviewEvaluation ?? null,
  };
}

function incompatibleManifestCaseIds(
  baseline: EvalCohortManifest,
  candidate: EvalCohortManifest,
): string[] {
  const baselineById = new Map(
    baseline.cases.map((evalCase) => [evalCase.id, evalCase]),
  );
  return candidate.cases
    .filter((evalCase) => {
      const baselineCase = baselineById.get(evalCase.id);
      return baselineCase !== undefined &&
        stableJson(comparableTaskContract(baselineCase)) !==
          stableJson(comparableTaskContract(evalCase));
    })
    .map((evalCase) => evalCase.id)
    .sort();
}

export function compareEvalCohorts(input: {
  candidateManifest: EvalCohortManifest;
  baselineManifest: EvalCohortManifest;
  candidateSamples: readonly EvalRunSample[];
  baselineSamples: readonly EvalRunSample[];
  generatedAt?: string;
}): EvalCohortReport {
  const expectedBaseline = input.candidateManifest.cohort.baselineCohortId;
  if (!expectedBaseline) {
    throw new Error("candidate cohort must declare baselineCohortId");
  }
  if (input.baselineManifest.cohort.id !== expectedBaseline) {
    throw new Error(
      `baseline cohort mismatch: expected ${expectedBaseline}, received ${input.baselineManifest.cohort.id}`,
    );
  }
  const baselineOnlyManifestCaseIds = manifestCaseDifference(
    input.baselineManifest,
    input.candidateManifest,
  );
  const candidateOnlyManifestCaseIds = manifestCaseDifference(
    input.candidateManifest,
    input.baselineManifest,
  );
  const incompatibleCaseIds = incompatibleManifestCaseIds(
    input.baselineManifest,
    input.candidateManifest,
  );
  const incompatibleCases = new Set(incompatibleCaseIds);
  const candidateCaseIds = new Set(
    input.candidateManifest.cases.map((evalCase) => evalCase.id),
  );
  const sharedCaseIds = new Set(
    input.baselineManifest.cases
      .map((evalCase) => evalCase.id)
      .filter((caseId) =>
        candidateCaseIds.has(caseId) && !incompatibleCases.has(caseId)
      ),
  );
  const baselineSamples = input.baselineSamples.filter((sample) =>
    sharedCaseIds.has(sample.caseId)
  );
  const candidateSamples = input.candidateSamples.filter((sample) =>
    sharedCaseIds.has(sample.caseId)
  );
  const baseline = aggregateEvalCohort(
    input.baselineManifest.cohort.id,
    baselineSamples,
  );
  const candidate = aggregateEvalCohort(
    input.candidateManifest.cohort.id,
    candidateSamples,
  );
  const comparisons = COMPARISON_METRICS.flatMap((metric) => {
    const threshold = input.candidateManifest.thresholds[metric];
    return threshold
      ? [compareMetric({
          metric,
          baselineValue: metricValue(baseline, metric),
          candidateValue: metricValue(candidate, metric),
          threshold,
        })]
      : [];
  });
  const regressions = comparisons.filter(
    (comparison) => comparison.status === "regressed",
  );
  const coverage = {
    baselineMissingCaseIds: missingCaseIds(
      input.baselineManifest,
      input.baselineSamples,
    ),
    candidateMissingCaseIds: missingCaseIds(
      input.candidateManifest,
      input.candidateSamples,
    ),
    baselineDuplicateCaseIds: duplicateCaseIds(
      input.baselineManifest,
      input.baselineSamples,
    ),
    candidateDuplicateCaseIds: duplicateCaseIds(
      input.candidateManifest,
      input.candidateSamples,
    ),
    baselineOnlyManifestCaseIds,
    candidateOnlyManifestCaseIds,
    incompatibleCaseIds,
  };
  const coverageInsufficient =
    coverage.baselineMissingCaseIds.length > 0 ||
    coverage.candidateMissingCaseIds.length > 0 ||
    coverage.baselineDuplicateCaseIds.length > 0 ||
    coverage.candidateDuplicateCaseIds.length > 0 ||
    coverage.baselineOnlyManifestCaseIds.length > 0 ||
    coverage.candidateOnlyManifestCaseIds.length > 0 ||
    coverage.incompatibleCaseIds.length > 0;
  const metricInsufficient = comparisons.length === 0 || comparisons.some(
    (comparison) => comparison.status === "not_comparable",
  );
  return {
    schemaVersion: "nitely.eval-report.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: coverageInsufficient
      ? "insufficient_data"
      : regressions.length > 0
        ? "regressed"
        : metricInsufficient
          ? "insufficient_data"
          : "passed",
    baselineManifestSha256: evalManifestSha256(input.baselineManifest),
    candidateManifestSha256: evalManifestSha256(input.candidateManifest),
    runLineage: {
      baseline: selectCohortSamples(
        input.baselineManifest.cohort.id,
        baselineSamples,
      ).map(({ caseId, runId }) => ({ caseId, runId })),
      candidate: selectCohortSamples(
        input.candidateManifest.cohort.id,
        candidateSamples,
      ).map(({ caseId, runId }) => ({ caseId, runId })),
    },
    baseline,
    candidate,
    comparisons,
    regressions,
    coverage,
  };
}

export function loadEvalRunSamples(input: {
  repoPath: string;
  manifest: EvalCohortManifest;
}): EvalRunSample[] {
  const path = eventStorePath(input.repoPath);
  if (!existsSync(path)) return [];
  const store = new EventStore(path);
  try {
    const cases = new Map(
      input.manifest.cases.map((evalCase) => [evalCase.id, evalCase]),
    );
    const samples: EvalRunSample[] = [];
    for (const runId of store.listRunIds()) {
      const events = store.list(runId);
      const link = events.findLast((event) => event.type === "eval.replay.linked");
      if (!link) continue;
      const payload = asRecord(link.payload);
      if (payload.cohortId !== input.manifest.cohort.id) continue;
      const caseId = asString(payload.caseId);
      const evalCase = caseId ? cases.get(caseId) : undefined;
      if (!evalCase) continue;
      const sample = deriveEvalRunSample({
        events,
        evalCase,
        manifest: input.manifest,
      });
      if (sample) samples.push(sample);
    }
    return samples.sort((left, right) => left.runId.localeCompare(right.runId));
  } finally {
    store.close();
  }
}
