import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { StoredRunEvent } from "../../src/events/types.js";
import {
  evalManifestSha256,
  parseEvalCohortManifest,
  type EvalCase,
} from "../../src/eval/manifest.js";
import {
  aggregateEvalCohort,
  compareEvalCohorts,
  deriveEvalRunSample,
  loadEvalRunSamples,
  type EvalRunSample,
} from "../../src/eval/report.js";
import { eventStorePath } from "../../src/run/project.js";

const EVAL_INVOCATION_ID = "11111111-1111-4111-8111-111111111111";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  payload: unknown = {},
  options: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  const payloadRecord = typeof payload === "object" && payload !== null &&
      !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const eventPayload = type === "run.created"
    ? { evalReplayInvocationId: EVAL_INVOCATION_ID, ...payloadRecord }
    : type === "eval.replay.linked"
      ? { invocationId: EVAL_INVOCATION_ID, ...payloadRecord }
      : payload;
  return {
    sequence,
    runId: "run-candidate",
    type,
    payload: eventPayload,
    createdAt: `2026-07-16T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...options,
  };
}

const evalCase = {
  id: "upgrade-zod",
  baselineRunId: "run-baseline",
  source: { revision: "a".repeat(40) },
  flow: { path: "flows/eval.json", sha256: `sha256:${"b".repeat(64)}` },
  inputs: [],
  runtime: {
    executionBackend: "local",
    sandboxPolicy: { codex: "danger-full-access" },
    stages: [
      { stageId: "implement", runtime: "codex", model: "gpt-5.1-codex" },
      { stageId: "review", runtime: "codex", model: "gpt-5.1-codex" },
      { stageId: "reflect", runtime: "codex", model: "gpt-5.1-codex" },
    ],
  },
  contextPolicy: { sha256: `sha256:${"c".repeat(64)}` },
  expectedGates: ["review"],
  allowedNondeterminism: [],
  scoring: { requireReviewablePr: true, requireExpectedGates: true },
} satisfies EvalCase;

function manifestFor(
  cohortId: string,
  baselineCohortId?: string,
  caseIds: string[] = [evalCase.id],
) {
  return parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: {
      id: cohortId,
      ...(baselineCohortId ? { baselineCohortId } : {}),
    },
    cases: caseIds.map((id) => ({
      ...structuredClone(evalCase),
      id,
      baselineRunId: id === evalCase.id
        ? evalCase.baselineRunId
        : `run-baseline-${id}`,
    })),
    thresholds: baselineCohortId
      ? {
          reviewablePrRate: { maxAbsoluteDecrease: 0.25 },
          gatePassRate: { maxAbsoluteDecrease: 0.5 },
          retriesPerRun: { maxRelativeIncrease: 0.2 },
          humanReworkPerRun: { maxRelativeIncrease: 0.1 },
          latencyMs: { maxRelativeIncrease: 0.2 },
          actualCostUsd: { maxRelativeIncrease: 0.1 },
        }
      : {},
  });
}

describe("eval cohort reporting", () => {
  it("derives delivery, retry, human-rework, latency, and classified-cost metrics from ordinary events", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created", {
        trigger: {
          type: "github-pr-comment",
          authorLogin: "reviewer",
          action: "rework",
        },
      }),
      event(2, "stage.runtime.selected", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {
        totalTokens: 150,
        cost: { classification: "actual", usd: 0.04 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:03.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "implement", attempt: 1 }),
      event(4, "stage.runtime.selected", {}, { stageId: "review", attempt: 1 }),
      event(5, "stage.runtime.usage", {
        totalTokens: 100,
        estimatedCostUsd: 0.02,
      }, { stageId: "review", attempt: 1 }),
      event(6, "stage.runtime.selected", {}, { stageId: "reflect", attempt: 1 }),
      event(6.1, "stage.runtime.usage", {
        cost: { classification: "actual", usd: 99 },
        provenance: {
          provider: "forged",
          observedAt: "2026-07-16T00:00:06.000Z",
          source: { kind: "calculated", reference: "guess" },
        },
      }, { stageId: "reflect", attempt: 1 }),
      event(7, "gate.completed", {
        gate: { id: "review", stageId: "review", mode: "review", status: "passed" },
      }, { stageId: "review", attempt: 1 }),
      event(8, "stage.retrying", { reason: "test failed" }, { stageId: "implement", attempt: 1 }),
      event(9, "stage.rework.requested", { source: "orchestrator" }, { stageId: "review", attempt: 1 }),
      event(10, "stage.rework.requested", {
        source: "human",
        actor: "reviewer@example.test",
      }, { stageId: "review", attempt: 2 }),
      event(11, "change.published", { url: "https://example.test/pr/1" }),
      event(12, "run.completed"),
      event(13, "eval.replay.linked" as StoredRunEvent["type"], {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })).toEqual({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: "run-candidate",
      cohortId: "candidate",
      caseId: "upgrade-zod",
      baselineCohortId: "baseline",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 1,
      humanRework: 3,
      latencyMs: 11_000,
      usage: {
        knownAttempts: 2,
        unknownAttempts: 1,
        totalTokens: 250,
      },
    });
  });

  it("measures latency from the first ordinary run event rather than run.created", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "context.manifest.updated", {
        id: "task",
        kind: "external-input",
      }),
      event(2, "run.created"),
      event(3, "run.completed"),
      event(4, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(
      deriveEvalRunSample({ events, evalCase, manifest })?.latencyMs,
    ).toBe(2_000);
  });

  it("emits a cost metric only when every observed runtime attempt has proven cost", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "stage.runtime.selected", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {
        totalTokens: 10,
        cost: { classification: "actual", usd: 0.04 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:03.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "implement", attempt: 1 }),
      event(4, "stage.runtime.selected", {}, { stageId: "review", attempt: 1 }),
      event(5, "stage.runtime.usage", {
        totalTokens: 20,
        cost: { classification: "actual", usd: 0.06 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:05.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "review", attempt: 1 }),
      event(6, "run.completed"),
      event(7, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })?.usage).toEqual({
      knownAttempts: 2,
      unknownAttempts: 0,
      totalTokens: 30,
      actualCostUsd: 0.1,
    });
  });

  it("keeps cost unknown when a failed runtime invocation falls back to a priced attempt", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "stage.runtime.fallback", {
        failedRuntime: "codex",
        nextRuntime: "claude-code",
      }, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {
        totalTokens: 20,
        cost: { classification: "actual", usd: 0.06 },
        provenance: {
          provider: "anthropic",
          observedAt: "2026-07-16T00:00:03.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "implement", attempt: 2 }),
      event(4, "stage.runtime.selected", {}, { stageId: "implement", attempt: 2 }),
      event(5, "run.completed"),
      event(6, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })?.usage).toEqual({
      knownAttempts: 1,
      unknownAttempts: 1,
      totalTokens: 20,
    });
  });

  it("fails closed when event-derived token or cost sums overflow", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "stage.runtime.selected", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {
        totalTokens: 1e308,
        cost: { classification: "actual", usd: 1e308 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:03.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "implement", attempt: 1 }),
      event(4, "stage.runtime.selected", {}, { stageId: "review", attempt: 1 }),
      event(5, "stage.runtime.usage", {
        totalTokens: 1e308,
        cost: { classification: "actual", usd: 1e308 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:05.000Z",
          source: { kind: "provider-reported", reference: "billing.usage" },
        },
      }, { stageId: "review", attempt: 1 }),
      event(6, "run.completed"),
      event(7, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    const sample = deriveEvalRunSample({ events, evalCase, manifest });

    expect(sample?.usage).toEqual({
      knownAttempts: 2,
      unknownAttempts: 0,
    });
    expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
  });

  it("counts a started runtime attempt with no selection or usage as unknown", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "stage.started", {
        type: "agent",
        runtime: "codex",
      }, { stageId: "implement", attempt: 1 }),
      event(3, "stage.started", {
        type: "agent",
        runtime: "codex",
      }, { stageId: "implement", attempt: 2 }),
      event(4, "stage.runtime.usage", {
        totalTokens: 20,
        cost: { classification: "actual", usd: 0.1 },
        provenance: {
          provider: "openai",
          observedAt: "2026-07-16T00:00:04.000Z",
          source: { kind: "provider-reported", reference: "responses.usage" },
        },
      }, { stageId: "implement", attempt: 2 }),
      event(5, "run.completed"),
      event(6, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })?.usage).toEqual({
      knownAttempts: 1,
      unknownAttempts: 1,
      totalTokens: 20,
    });
  });

  it("keeps empty, invalid, and legacy unproven usage unknown", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "stage.runtime.selected", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {}, { stageId: "implement", attempt: 1 }),
      event(4, "stage.runtime.selected", {}, { stageId: "review", attempt: 1 }),
      event(5, "stage.runtime.usage", {
        estimatedCostUsd: 99,
        cost: { classification: "unknown" },
        provenance: {
          provider: "forged",
          observedAt: "2026-07-16T00:00:05.000Z",
          source: { kind: "forged", reference: "guess" },
        },
      }, { stageId: "review", attempt: 1 }),
      event(6, "run.completed"),
      event(7, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })?.usage).toEqual({
      knownAttempts: 0,
      unknownAttempts: 2,
    });
  });

  it("aggregates metric coverage without treating missing usage or latency as zero", () => {
    const samples: EvalRunSample[] = [
      {
        schemaVersion: "nitely.eval-run-sample.v1",
        runId: "run-1",
        cohortId: "candidate",
        caseId: "case-1",
        baselineRunId: "baseline-1",
        terminalStatus: "completed",
        reviewablePr: true,
        expectedGatesPassed: true,
        scoringPassed: true,
        retries: 1,
        humanRework: 0,
        latencyMs: 100,
        usage: {
          knownAttempts: 1,
          unknownAttempts: 0,
          totalTokens: 100,
          actualCostUsd: 0.04,
        },
      },
      {
        schemaVersion: "nitely.eval-run-sample.v1",
        runId: "run-2",
        cohortId: "candidate",
        caseId: "case-2",
        baselineRunId: "baseline-2",
        terminalStatus: "failed",
        reviewablePr: false,
        expectedGatesPassed: false,
        scoringPassed: false,
        retries: 3,
        humanRework: 2,
        usage: { knownAttempts: 0, unknownAttempts: 1 },
      },
    ];

    expect(aggregateEvalCohort("candidate", samples)).toEqual({
      schemaVersion: "nitely.eval-cohort-summary.v1",
      cohortId: "candidate",
      runCount: 2,
      caseIds: ["case-1", "case-2"],
      reviewablePrRate: { numerator: 1, denominator: 2, value: 0.5 },
      gatePassRate: { numerator: 1, denominator: 2, value: 0.5 },
      scoringPassRate: { numerator: 1, denominator: 2, value: 0.5 },
      retriesPerRun: { total: 4, samples: 2, missing: 0, value: 2 },
      humanReworkPerRun: { total: 2, samples: 2, missing: 0, value: 1 },
      latencyMs: { total: 100, samples: 1, missing: 1, value: 100 },
      actualCostUsd: { total: 0.04, samples: 1, missing: 1, value: 0.04 },
      estimatedCostUsd: { total: 0, samples: 0, missing: 2 },
      outcomes: { completed: 1, failed: 1, blocked: 0, cancelled: 0, unknown: 0 },
      usage: { knownAttempts: 1, unknownAttempts: 1, totalTokens: 100 },
    });
  });

  it("marks overflowing cohort sums not comparable without emitting non-finite JSON", () => {
    const sample = (
      cohortId: string,
      caseId: string,
      value: number,
    ): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `${cohortId}-${caseId}`,
      cohortId,
      caseId,
      baselineRunId: caseId === "upgrade-zod"
        ? "run-baseline"
        : `run-baseline-${caseId}`,
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: {
        knownAttempts: 1,
        unknownAttempts: 0,
        totalTokens: value,
        actualCostUsd: value,
      },
    });
    const baselineManifest = manifestFor(
      "baseline",
      undefined,
      ["upgrade-zod", "upgrade-eslint"],
    );
    const candidateManifest = manifestFor(
      "candidate",
      "baseline",
      ["upgrade-zod", "upgrade-eslint"],
    );

    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [
        sample("baseline", "upgrade-zod", 1e308),
        sample("baseline", "upgrade-eslint", 1e308),
      ],
      candidateSamples: [
        sample("candidate", "upgrade-zod", 1),
        sample("candidate", "upgrade-eslint", 1),
      ],
    });

    expect(report.baseline.actualCostUsd).toEqual({
      total: 0,
      samples: 0,
      missing: 2,
      overflowed: true,
    });
    expect(report.baseline.usage.totalTokens).toBeUndefined();
    expect(report.comparisons).toContainEqual(expect.objectContaining({
      metric: "actualCostUsd",
      status: "not_comparable",
    }));
    expect(report.status).toBe("insufficient_data");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("marks overflowing attempt coverage totals without emitting non-finite JSON", () => {
    const samples: EvalRunSample[] = ["case-1", "case-2"].map((caseId) => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${caseId}`,
      cohortId: "candidate",
      caseId,
      baselineRunId: `baseline-${caseId}`,
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: {
        knownAttempts: 1e308,
        unknownAttempts: 1e308,
      },
    }));

    const summary = aggregateEvalCohort("candidate", samples);

    expect(summary.usage).toEqual({
      knownAttempts: 0,
      unknownAttempts: 0,
      attemptCountsOverflowed: true,
    });
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("marks a non-finite relative change not comparable", () => {
    const sample = (cohortId: string, latencyMs: number): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${cohortId}`,
      cohortId,
      caseId: "upgrade-zod",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const candidateManifest = manifestFor("candidate", "baseline");
    candidateManifest.thresholds = {
      latencyMs: { maxRelativeIncrease: 0.2 },
    };

    const report = compareEvalCohorts({
      baselineManifest: manifestFor("baseline"),
      candidateManifest,
      baselineSamples: [sample("baseline", Number.MIN_VALUE)],
      candidateSamples: [sample("candidate", 1e308)],
    });

    expect(report.comparisons).toContainEqual(expect.objectContaining({
      metric: "latencyMs",
      status: "not_comparable",
    }));
    expect(report.comparisons[0]).not.toHaveProperty("observedChange");
    expect(report.status).toBe("insufficient_data");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("emits machine-readable regressions, honors threshold boundaries, and marks missing cost incomparable", () => {
    const sample = (input: {
      runId: string;
      cohortId: string;
      reviewablePr: boolean;
      expectedGatesPassed: boolean;
      retries: number;
      humanRework: number;
      latencyMs: number;
      actualCostUsd?: number;
      caseId: string;
    }): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: input.runId,
      cohortId: input.cohortId,
      caseId: input.caseId,
      baselineRunId: input.caseId === evalCase.id
        ? evalCase.baselineRunId
        : `run-baseline-${input.caseId}`,
      terminalStatus: "completed",
      reviewablePr: input.reviewablePr,
      expectedGatesPassed: input.expectedGatesPassed,
      scoringPassed: input.reviewablePr && input.expectedGatesPassed,
      retries: input.retries,
      humanRework: input.humanRework,
      latencyMs: input.latencyMs,
      usage: {
        knownAttempts: 1,
        unknownAttempts: 0,
        ...(input.actualCostUsd !== undefined
          ? { actualCostUsd: input.actualCostUsd }
          : {}),
      },
    });
    const baselineSamples = [
      sample({
        runId: "base-1",
        cohortId: "baseline",
        reviewablePr: true,
        expectedGatesPassed: true,
        retries: 1,
        humanRework: 0,
        latencyMs: 100,
        actualCostUsd: 1,
        caseId: "upgrade-zod",
      }),
      sample({
        runId: "base-2",
        cohortId: "baseline",
        reviewablePr: true,
        expectedGatesPassed: true,
        retries: 1,
        humanRework: 0,
        latencyMs: 100,
        actualCostUsd: 1,
        caseId: "upgrade-eslint",
      }),
    ];
    const candidateSamples = [
      sample({
        runId: "candidate-1",
        cohortId: "candidate",
        reviewablePr: true,
        expectedGatesPassed: true,
        retries: 1.2,
        humanRework: 0.1,
        latencyMs: 120,
        caseId: "upgrade-zod",
      }),
      sample({
        runId: "candidate-2",
        cohortId: "candidate",
        reviewablePr: false,
        expectedGatesPassed: false,
        retries: 1.2,
        humanRework: 0.1,
        latencyMs: 120,
        caseId: "upgrade-eslint",
      }),
    ];

    const report = compareEvalCohorts({
      candidateManifest: manifestFor(
        "candidate",
        "baseline",
        ["upgrade-zod", "upgrade-eslint"],
      ),
      baselineManifest: manifestFor(
        "baseline",
        undefined,
        ["upgrade-zod", "upgrade-eslint"],
      ),
      candidateSamples,
      baselineSamples,
      generatedAt: "2026-07-16T01:00:00.000Z",
    });

    expect(report.schemaVersion).toBe("nitely.eval-report.v1");
    expect(report.status).toBe("regressed");
    expect(report.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "reviewablePrRate", status: "regressed" }),
      expect.objectContaining({ metric: "gatePassRate", status: "passed" }),
      expect.objectContaining({ metric: "retriesPerRun", status: "passed" }),
      expect.objectContaining({ metric: "humanReworkPerRun", status: "regressed" }),
      expect.objectContaining({ metric: "latencyMs", status: "passed" }),
      expect.objectContaining({ metric: "actualCostUsd", status: "not_comparable" }),
    ]));
    expect(report.regressions.map((entry) => entry.metric)).toEqual([
      "reviewablePrRate",
      "humanReworkPerRun",
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("loads only linked cohort samples from the ordinary repository event store", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-report-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const manifest = manifestFor("candidate", "baseline");
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-candidate",
      type: "run.created",
      payload: { evalReplayInvocationId: EVAL_INVOCATION_ID },
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    store.append({
      runId: "run-candidate",
      type: "run.completed",
      payload: {},
      createdAt: "2026-07-16T00:00:10.000Z",
    });
    store.append({
      runId: "run-candidate",
      type: "eval.replay.linked",
      payload: {
        schemaVersion: "nitely.eval-replay-link.v1",
        invocationId: EVAL_INVOCATION_ID,
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      },
    });
    store.append({ runId: "ordinary-run", type: "run.created", payload: {} });
    store.append({ runId: "ordinary-run", type: "run.completed", payload: {} });
    for (const [runId, events] of [
      ["awaiting-run", ["run.created"]],
      ["standalone-link", ["run.completed"]],
    ] as const) {
      for (const type of events) {
        store.append({
          runId,
          type,
          payload: type === "run.created"
            ? { evalReplayInvocationId: EVAL_INVOCATION_ID }
            : {},
        });
      }
      store.append({
        runId,
        type: "eval.replay.linked",
        payload: {
          schemaVersion: "nitely.eval-replay-link.v1",
          invocationId: EVAL_INVOCATION_ID,
          cohortId: "candidate",
          caseId: "upgrade-zod",
          baselineCohortId: "baseline",
          baselineRunId: "run-baseline",
          manifestSha256: evalManifestSha256(manifest),
          sourceRevision: "a".repeat(40),
          allowedNondeterminism: [],
          outcome: "completed",
        },
      });
    }
    store.close();

    const samples = loadEvalRunSamples({
      repoPath,
      manifest,
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      runId: "run-candidate",
      cohortId: "candidate",
      caseId: "upgrade-zod",
      latencyMs: 10_000,
    });
  });

  it("keeps a resumed replay after its link-time failure terminal", () => {
    const manifest = manifestFor("candidate", "baseline");
    const events = [
      event(1, "run.created"),
      event(2, "run.blocked"),
      event(3, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "failed",
      }),
      event(4, "resume.selected"),
      event(7, "run.completed"),
    ];

    expect(deriveEvalRunSample({ events, evalCase, manifest })).toMatchObject({
      terminalStatus: "completed",
      latencyMs: 6_000,
    });
  });

  it("requires matching UUID invocation provenance on run creation and replay link", () => {
    const manifest = manifestFor("candidate", "baseline");
    const linkedEvents = (
      createdInvocationId: unknown,
      linkedInvocationId: unknown,
    ) => [
      event(1, "run.created", {
        evalReplayInvocationId: createdInvocationId,
      }),
      event(2, "run.completed"),
      event(3, "eval.replay.linked", {
        schemaVersion: "nitely.eval-replay-link.v1",
        invocationId: linkedInvocationId,
        cohortId: "candidate",
        caseId: "upgrade-zod",
        baselineCohortId: "baseline",
        baselineRunId: "run-baseline",
        manifestSha256: evalManifestSha256(manifest),
        sourceRevision: "a".repeat(40),
        allowedNondeterminism: [],
        outcome: "completed",
      }),
    ];

    expect(deriveEvalRunSample({
      events: linkedEvents(EVAL_INVOCATION_ID, EVAL_INVOCATION_ID),
      evalCase,
      manifest,
    })).toBeDefined();
    for (const [createdInvocationId, linkedInvocationId] of [
      [undefined, EVAL_INVOCATION_ID],
      [EVAL_INVOCATION_ID, undefined],
      ["not-a-uuid", EVAL_INVOCATION_ID],
      [EVAL_INVOCATION_ID, "22222222-2222-4222-8222-222222222222"],
    ]) {
      expect(deriveEvalRunSample({
        events: linkedEvents(createdInvocationId, linkedInvocationId),
        evalCase,
        manifest,
      })).toBeUndefined();
    }
  });

  it("rejects replay links whose manifest, source, or baseline provenance is forged", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-provenance-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const manifest = manifestFor("candidate", "baseline");
    const validLink = {
      schemaVersion: "nitely.eval-replay-link.v1",
      invocationId: EVAL_INVOCATION_ID,
      cohortId: "candidate",
      caseId: "upgrade-zod",
      baselineCohortId: "baseline",
      baselineRunId: "run-baseline",
      manifestSha256: evalManifestSha256(manifest),
      sourceRevision: "a".repeat(40),
      allowedNondeterminism: [],
      outcome: "completed",
    };
    const store = new EventStore(eventStorePath(repoPath));
    for (const [runId, payload] of [
      ["valid", validLink],
      ["wrong-manifest", { ...validLink, manifestSha256: `sha256:${"f".repeat(64)}` }],
      ["wrong-source", { ...validLink, sourceRevision: "f".repeat(40) }],
      ["wrong-baseline", { ...validLink, baselineRunId: "forged-run" }],
      ["wrong-nondeterminism", { ...validLink, allowedNondeterminism: ["forged"] }],
      ["wrong-outcome", { ...validLink, outcome: "failed" }],
    ] as const) {
      store.append({
        runId,
        type: "run.created",
        payload: { evalReplayInvocationId: EVAL_INVOCATION_ID },
      });
      store.append({ runId, type: "run.completed", payload: {} });
      store.append({ runId, type: "eval.replay.linked", payload });
    }
    store.close();

    expect(loadEvalRunSamples({ repoPath, manifest }).map((sample) => sample.runId))
      .toEqual(["valid"]);
  });

  it("uses one deterministic sample per case and marks duplicate or mismatched case coverage insufficient", () => {
    const sample = (
      runId: string,
      cohortId: string,
      caseId: string,
      reviewablePr: boolean,
    ): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId,
      cohortId,
      caseId,
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr,
      expectedGatesPassed: true,
      scoringPassed: reviewablePr,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const baselineManifest = manifestFor("baseline");
    const candidateManifest = manifestFor("candidate", "baseline");
    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [sample("base", "baseline", "upgrade-zod", true)],
      candidateSamples: [
        sample("candidate-a", "candidate", "upgrade-zod", false),
        sample("candidate-z", "candidate", "upgrade-zod", true),
      ],
    });

    expect(report.candidate.runCount).toBe(1);
    expect(report.candidate.reviewablePrRate).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(report.coverage.candidateDuplicateCaseIds).toEqual(["upgrade-zod"]);
    expect(report.status).toBe("insufficient_data");

    const differentBaseline = structuredClone(baselineManifest);
    differentBaseline.cases[0].id = "baseline-only";
    const mismatched = compareEvalCohorts({
      baselineManifest: differentBaseline,
      candidateManifest,
      baselineSamples: [sample("base", "baseline", "baseline-only", true)],
      candidateSamples: [sample("candidate", "other-cohort", "upgrade-zod", true)],
    });
    expect(mismatched.coverage).toMatchObject({
      baselineMissingCaseIds: [],
      candidateMissingCaseIds: ["upgrade-zod"],
      baselineOnlyManifestCaseIds: ["baseline-only"],
      candidateOnlyManifestCaseIds: ["upgrade-zod"],
    });
    expect(mismatched.status).toBe("insufficient_data");
  });

  it("does not compare cohorts whose shared case ids describe different task contracts", () => {
    const sample = (cohortId: string): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${cohortId}`,
      cohortId,
      caseId: "upgrade-zod",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const baselineManifest = manifestFor("baseline");
    const candidateManifest = manifestFor("candidate", "baseline");
    baselineManifest.cases[0].inputs = [{
      id: "ticket",
      path: "fixtures/ticket.md",
      sha256: `sha256:${"d".repeat(64)}`,
    }];
    candidateManifest.cases[0].inputs = [{
      id: "ticket",
      path: "fixtures/renamed-ticket.md",
      sha256: `sha256:${"e".repeat(64)}`,
    }];
    candidateManifest.cases[0].scoring.requireExpectedGates = false;

    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [sample("baseline")],
      candidateSamples: [sample("candidate")],
    });

    expect(report.status).toBe("insufficient_data");
    expect(report.coverage.incompatibleCaseIds).toEqual(["upgrade-zod"]);
    expect(report.baseline.runCount).toBe(0);
    expect(report.candidate.runCount).toBe(0);
  });

  it("treats different case configuration as an incompatible task contract", () => {
    const sample = (cohortId: string): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${cohortId}`,
      cohortId,
      caseId: "upgrade-zod",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const baselineManifest = manifestFor("baseline");
    const candidateManifest = manifestFor("candidate", "baseline");
    baselineManifest.cases[0].configuration = { reviewMode: "strict" };
    candidateManifest.cases[0].configuration = { reviewMode: "lenient" };

    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [sample("baseline")],
      candidateSamples: [sample("candidate")],
    });

    expect(report.status).toBe("insufficient_data");
    expect(report.coverage.incompatibleCaseIds).toEqual(["upgrade-zod"]);
    expect(report.baseline.runCount).toBe(0);
    expect(report.candidate.runCount).toBe(0);
  });

  it("does not compare cost averages assembled from different missing cases", () => {
    const sample = (
      cohortId: string,
      caseId: string,
      actualCostUsd?: number,
    ): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `${cohortId}-${caseId}`,
      cohortId,
      caseId,
      baselineRunId: caseId === "upgrade-zod"
        ? "run-baseline"
        : `run-baseline-${caseId}`,
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: {
        knownAttempts: actualCostUsd === undefined ? 0 : 1,
        unknownAttempts: actualCostUsd === undefined ? 1 : 0,
        ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
      },
    });
    const baselineManifest = manifestFor(
      "baseline",
      undefined,
      ["upgrade-zod", "upgrade-eslint"],
    );
    const candidateManifest = manifestFor(
      "candidate",
      "baseline",
      ["upgrade-zod", "upgrade-eslint"],
    );
    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [
        sample("baseline", "upgrade-zod", 1),
        sample("baseline", "upgrade-eslint"),
      ],
      candidateSamples: [
        sample("candidate", "upgrade-zod"),
        sample("candidate", "upgrade-eslint", 1),
      ],
    });

    expect(report.comparisons).toContainEqual(expect.objectContaining({
      metric: "actualCostUsd",
      status: "not_comparable",
    }));
    expect(report.status).toBe("insufficient_data");
  });

  it("fails closed when a candidate comparison configures no regression thresholds", () => {
    const sample = (cohortId: string): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${cohortId}`,
      cohortId,
      caseId: "upgrade-zod",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const candidateManifest = manifestFor("candidate", "baseline");
    candidateManifest.thresholds = {};

    const report = compareEvalCohorts({
      baselineManifest: manifestFor("baseline"),
      candidateManifest,
      baselineSamples: [sample("baseline")],
      candidateSamples: [sample("candidate")],
    });

    expect(report.comparisons).toEqual([]);
    expect(report.status).toBe("insufficient_data");
  });

  it("records canonical manifest digests and the deterministically selected run lineage", () => {
    const sample = (
      cohortId: string,
      caseId: string,
      runId: string,
    ): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId,
      cohortId,
      caseId,
      baselineRunId: caseId === "upgrade-zod"
        ? "run-baseline"
        : `run-baseline-${caseId}`,
      terminalStatus: "completed",
      reviewablePr: true,
      expectedGatesPassed: true,
      scoringPassed: true,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const baselineManifest = manifestFor(
      "baseline",
      undefined,
      ["upgrade-zod", "upgrade-eslint"],
    );
    const candidateManifest = manifestFor(
      "candidate",
      "baseline",
      ["upgrade-zod", "upgrade-eslint"],
    );

    const report = compareEvalCohorts({
      baselineManifest,
      candidateManifest,
      baselineSamples: [
        sample("baseline", "upgrade-zod", "baseline-zod"),
        sample("baseline", "upgrade-eslint", "baseline-eslint"),
      ],
      candidateSamples: [
        sample("candidate", "upgrade-zod", "candidate-zod-a"),
        sample("candidate", "upgrade-zod", "candidate-zod-z"),
        sample("candidate", "upgrade-eslint", "candidate-eslint"),
      ],
      generatedAt: "2026-07-16T01:00:00.000Z",
    });

    expect(report.baselineManifestSha256).toBe(
      evalManifestSha256(baselineManifest),
    );
    expect(report.candidateManifestSha256).toBe(
      evalManifestSha256(candidateManifest),
    );
    expect(report.runLineage).toEqual({
      baseline: [
        { caseId: "upgrade-eslint", runId: "baseline-eslint" },
        { caseId: "upgrade-zod", runId: "baseline-zod" },
      ],
      candidate: [
        { caseId: "upgrade-eslint", runId: "candidate-eslint" },
        { caseId: "upgrade-zod", runId: "candidate-zod-z" },
      ],
    });
  });
});
