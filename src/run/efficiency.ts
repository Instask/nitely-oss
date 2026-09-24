import { resolve } from "node:path";

import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import {
  billableRuntimeTokens,
  eventStorePath,
  projectRun,
  type ProjectedRun,
} from "./project.js";

export const EFFICIENCY_REPORT_SCHEMA = "nitely.efficiency-report.v1" as const;
export const EFFICIENCY_RULE_VERSION = 1 as const;

const AMPLIFICATION_MIN_INPUT_TOKENS = 50_000;
const AMPLIFICATION_RATIO = 10;
const RETRY_SHARE_THRESHOLD = 0.3;
const EXPENSIVE_MODEL = /opus|o1|o3|gpt-5|sonnet-4\.5|claude-3-opus/i;

export type EfficiencySeverity = "info" | "warn" | "high";
export type EfficiencyConfidence = "high" | "medium" | "low" | "unknown";

export type EfficiencyRuleId =
  | "runtime-input-amplification"
  | "cold-session-repeat"
  | "retry-rework-share"
  | "expensive-model-non-gate"
  | "repeated-large-payloads"
  | "usage-coverage-missing"
  | "budget-loss-after-outputs";

export interface EfficiencyFinding {
  ruleId: EfficiencyRuleId;
  version: typeof EFFICIENCY_RULE_VERSION;
  severity: EfficiencySeverity;
  confidence: EfficiencyConfidence;
  title: string;
  summary: string;
  impact?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    billableTokens?: number;
    contextTokens?: number;
    ratio?: number;
    retryShare?: number;
    retryTokens?: number;
    totalTokens?: number;
  };
  evidence: {
    runId: string;
    stageIds: string[];
    eventTypes: string[];
    attempt?: number;
  };
  remediation: string;
  relatedIssues: number[];
}

export interface EfficiencyReport {
  schemaVersion: typeof EFFICIENCY_REPORT_SCHEMA;
  runId: string;
  findings: EfficiencyFinding[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function latestRunFailed(events: StoredRunEvent[]): StoredRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "run.failed") return events[index];
  }
  return undefined;
}

function finding(input: Omit<EfficiencyFinding, "version">): EfficiencyFinding {
  return { ...input, version: EFFICIENCY_RULE_VERSION };
}

function runtimeInputAmplification(
  projection: ProjectedRun,
): EfficiencyFinding[] {
  const findings: EfficiencyFinding[] = [];
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      const contextTokens = attempt.contextUsage?.approxTokens;
      const inputTokens = attempt.runtimeUsage?.inputTokens;
      if (contextTokens === undefined || inputTokens === undefined) continue;
      if (
        inputTokens < AMPLIFICATION_MIN_INPUT_TOKENS ||
        inputTokens < contextTokens * AMPLIFICATION_RATIO
      ) {
        continue;
      }
      const ratio = contextTokens > 0 ? inputTokens / contextTokens : undefined;
      const cachedInputTokens = attempt.runtimeUsage?.cachedInputTokens;
      const billableTokens = billableRuntimeTokens(attempt.runtimeUsage);
      const recordedTokens = attempt.runtimeUsage?.totalTokens;
      const cacheClause =
        typeof cachedInputTokens === "number" && billableTokens !== undefined
          ? ` ${cachedInputTokens} of those input tokens were cache reads; billable usage was ${billableTokens} tokens${
              recordedTokens !== undefined ? ` of ${recordedTokens} recorded` : ""
            }.`
          : "";
      findings.push(
        finding({
          ruleId: "runtime-input-amplification",
          severity: "high",
          confidence: "high",
          title: "Runtime input grew far beyond assembled context",
          summary:
            `Stage ${stage.stageId} attempt ${attempt.attempt} sent ${inputTokens} runtime input tokens while Nitely assembled about ${contextTokens} context tokens.${cacheClause} The assembled prompt was not the cost; repository or runtime rereads were.`,
          impact: {
            inputTokens,
            contextTokens,
            ...(typeof cachedInputTokens === "number"
              ? { cachedInputTokens }
              : {}),
            ...(billableTokens !== undefined ? { billableTokens } : {}),
            ...(ratio !== undefined ? { ratio } : {}),
          },
          evidence: {
            runId: projection.runId,
            stageIds: [stage.stageId],
            eventTypes: ["stage.context.usage", "stage.runtime.usage"],
            attempt: attempt.attempt,
          },
          remediation:
            "Bound agent reads and reuse sessions so the runtime does not re-send the repository on every turn (#529, #488).",
          relatedIssues: [517, 529],
        }),
      );
    }
  }
  return findings;
}

function coldSessionRepeat(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): EfficiencyFinding[] {
  const sessionEvents = events.filter(
    (event) => event.type === "stage.runtime.session",
  );
  if (sessionEvents.length === 0) {
    const runtimeAttempts = projection.stages.some((stage) => stage.attempts.length > 0);
    if (!runtimeAttempts) return [];
    return [
      finding({
        ruleId: "cold-session-repeat",
        severity: "info",
        confidence: "unknown",
        title: "Session reuse telemetry is missing",
        summary:
          "No stage.runtime.session events were recorded, so cold vs resumed attempts cannot be proven.",
        evidence: {
          runId: projection.runId,
          stageIds: [],
          eventTypes: [],
        },
        remediation:
          "Record agent session outcomes so later attempts can reuse a session instead of starting cold (#488).",
        relatedIssues: [488],
      }),
    ];
  }

  const byStage = new Map<string, StoredRunEvent[]>();
  for (const event of sessionEvents) {
    if (!event.stageId) continue;
    const list = byStage.get(event.stageId) ?? [];
    list.push(event);
    byStage.set(event.stageId, list);
  }
  const findings: EfficiencyFinding[] = [];
  for (const [stageId, stageEvents] of byStage) {
    let sawSessionId = false;
    let coldAfterSession = 0;
    for (const event of stageEvents) {
      const payload = asRecord(event.payload);
      const mode = asString(payload.mode);
      const sessionId = asString(payload.sessionId);
      if (mode === "cold" && sawSessionId) coldAfterSession += 1;
      if (sessionId) sawSessionId = true;
    }
    if (coldAfterSession === 0) continue;
    findings.push(
      finding({
        ruleId: "cold-session-repeat",
        severity: "warn",
        confidence: "high",
        title: "Later attempts started cold after a session was available",
        summary:
          `Stage ${stageId} started ${coldAfterSession} cold attempt(s) after a session id had already been recorded.`,
        evidence: {
          runId: projection.runId,
          stageIds: [stageId],
          eventTypes: ["stage.runtime.session"],
        },
        remediation:
          "Resume the recorded agent session on later attempts of the same stage (#488).",
        relatedIssues: [488],
      }),
    );
  }
  return findings;
}

function retryReworkShare(projection: ProjectedRun): EfficiencyFinding[] {
  // Ratio of raw totals: cache largely cancels across attempts.
  let firstAttemptTokens = 0;
  let retryTokens = 0;
  const retryStageIds = new Set<string>();
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      const tokens = attempt.runtimeUsage?.totalTokens
        ?? ((attempt.runtimeUsage?.inputTokens ?? 0) + (attempt.runtimeUsage?.outputTokens ?? 0));
      if (!tokens) continue;
      if (attempt.attempt <= 1 && !projection.priorRunId) {
        firstAttemptTokens += tokens;
      } else {
        retryTokens += tokens;
        retryStageIds.add(stage.stageId);
      }
    }
  }
  const totalTokens = firstAttemptTokens + retryTokens;
  if (totalTokens <= 0) {
    return [
      finding({
        ruleId: "retry-rework-share",
        severity: "info",
        confidence: "unknown",
        title: "Retry and rework cost share cannot be measured",
        summary:
          "No runtime token totals were recorded, so retry/rework share is unknown.",
        evidence: {
          runId: projection.runId,
          stageIds: [],
          eventTypes: [],
        },
        remediation: "Record provider usage on each attempt so retry cost can be attributed (#429).",
        relatedIssues: [429, 472],
      }),
    ];
  }
  const retryShare = retryTokens / totalTokens;
  if (retryShare < RETRY_SHARE_THRESHOLD && !projection.priorRunId) return [];
  if (retryShare < RETRY_SHARE_THRESHOLD) return [];
  return [
    finding({
      ruleId: "retry-rework-share",
      severity: "warn",
      confidence: "high",
      title: "Retries consumed a disproportionate share of runtime tokens",
      summary:
        `${Math.round(retryShare * 100)}% of recorded runtime tokens were spent on retries or later attempts (${retryTokens} of ${totalTokens}).`,
      impact: { retryShare, retryTokens, totalTokens },
      evidence: {
        runId: projection.runId,
        stageIds: [...retryStageIds],
        eventTypes: ["stage.retrying", "stage.runtime.usage"],
      },
      remediation:
        "Inspect oscillating stages and tighten retry/rework policy before spending another attempt (#472).",
      relatedIssues: [472],
    }),
  ];
}

function expensiveModelNonGate(projection: ProjectedRun): EfficiencyFinding[] {
  const findings: EfficiencyFinding[] = [];
  let sawModel = false;
  for (const stage of projection.stages) {
    const isGate = stage.stageType === "gate" || /review|verify/i.test(stage.stageId);
    for (const attempt of stage.attempts) {
      const model = attempt.runtimeUsage?.provenance?.model ?? attempt.model;
      if (!model) continue;
      sawModel = true;
      if (isGate || !EXPENSIVE_MODEL.test(model)) continue;
      findings.push(
        finding({
          ruleId: "expensive-model-non-gate",
          severity: "warn",
          confidence: "medium",
          title: "High-cost model used on a non-quality-deciding stage",
          summary:
            `Stage ${stage.stageId} used model ${model} on a ${stage.stageType ?? "agent"} stage rather than a review or verification gate.`,
          evidence: {
            runId: projection.runId,
            stageIds: [stage.stageId],
            eventTypes: ["stage.runtime.usage", "stage.runtime.selected"],
            attempt: attempt.attempt,
          },
          remediation:
            "Reserve frontier models for review gates; use the declared cheaper candidate on implementation stages (#468).",
          relatedIssues: [468],
        }),
      );
    }
  }
  if (sawModel || findings.length > 0) return findings;
  const hasRuntime = projection.stages.some((stage) =>
    stage.attempts.some((attempt) => attempt.runtime || stage.stageType === "agent"),
  );
  if (!hasRuntime) return [];
  return [
    finding({
      ruleId: "expensive-model-non-gate",
      severity: "info",
      confidence: "unknown",
      title: "Model identity is missing",
      summary:
        "Runtime attempts did not record a model, so stage-level model cost cannot be judged.",
      evidence: {
        runId: projection.runId,
        stageIds: [],
        eventTypes: [],
      },
      remediation: "Record the selected model on each runtime attempt (#468, #429).",
      relatedIssues: [468],
    }),
  ];
}

function repeatedLargePayloads(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): EfficiencyFinding[] {
  const toolEvents = events.filter(
    (event) =>
      event.type === "agent.tool.started" || event.type === "agent.tool.completed",
  );
  if (toolEvents.length === 0) {
    return [
      finding({
        ruleId: "repeated-large-payloads",
        severity: "info",
        confidence: "unknown",
        title: "Tool payload telemetry is missing",
        summary:
          "No agent.tool events were recorded, so repeated large tool or artifact payloads cannot be proven.",
        evidence: {
          runId: projection.runId,
          stageIds: [],
          eventTypes: [],
        },
        remediation:
          "Record tool payload sizes when the runtime supplies them; do not invent a cost from the prompt alone.",
        relatedIssues: [517],
      }),
    ];
  }
  return [];
}

function usageCoverageMissing(projection: ProjectedRun): EfficiencyFinding[] {
  const unknownAttempts = projection.runtimeUsage?.unknownAttempts ?? 0;
  const knownAttempts = projection.runtimeUsage?.knownAttempts ?? 0;
  const hasCost =
    projection.runtimeUsage?.actualCostUsd !== undefined ||
    projection.runtimeUsage?.estimatedCostUsd !== undefined;
  if (unknownAttempts === 0 && (knownAttempts === 0 || hasCost)) return [];
  return [
    finding({
      ruleId: "usage-coverage-missing",
      severity: unknownAttempts > 0 ? "warn" : "info",
      confidence: "high",
      title: "Provider usage or cost coverage is missing",
      summary:
        unknownAttempts > 0
          ? `${unknownAttempts} runtime attempt(s) have unknown token usage, so cost totals are incomplete.`
          : "Token usage was recorded without classified actual or estimated cost.",
      evidence: {
        runId: projection.runId,
        stageIds: projection.stages
          .filter((stage) =>
            stage.attempts.some(
              (attempt) =>
                (attempt.runtime !== undefined || stage.stageType === "agent") &&
                !attempt.runtimeUsage,
            ),
          )
          .map((stage) => stage.stageId),
        eventTypes: ["stage.runtime.usage"],
      },
      remediation:
        "Keep missing usage as unknown. Do not fill zeros or mix partial actual cost with unknown attempts (#429).",
      relatedIssues: [429],
    }),
  ];
}

function budgetLossAfterOutputs(
  projection: ProjectedRun,
  events: StoredRunEvent[],
): EfficiencyFinding[] {
  const failed = latestRunFailed(events);
  if (!failed) return [];
  const payload = asRecord(failed.payload);
  if (asString(payload.reason) !== "budget_exceeded") return [];
  const stageId = asString(payload.stageId);
  if (!stageId || !projection.completedStages.includes(stageId)) return [];
  const stageFailed = events.some(
    (event) =>
      event.type === "stage.failed" && event.stageId === stageId,
  );
  if (stageFailed) return [];
  const exceeded = events.find((event) => event.type === "budget.exceeded");
  const consumed = asNumber(asRecord(exceeded?.payload).consumed);
  return [
    finding({
      ruleId: "budget-loss-after-outputs",
      severity: "high",
      confidence: "high",
      title: "Budget exhausted after declared outputs already existed",
      summary:
        `Stage ${stageId} completed and registered its artifacts, then the run failed on a runtime token budget${
          consumed !== undefined ? ` after ${consumed} tokens` : ""
        }. Raise the cap and resume rather than repeating the completed stage (#537).`,
      impact: consumed !== undefined ? { totalTokens: consumed } : undefined,
      evidence: {
        runId: projection.runId,
        stageIds: [stageId],
        eventTypes: ["stage.completed", "budget.exceeded", "run.failed"],
      },
      remediation:
        "Raise NITELY_DEFAULT_MAX_RUNTIME_TOKENS above the consumed total and resume at the first incomplete stage (#537).",
      relatedIssues: [517, 537],
    }),
  ];
}

export function diagnoseRun(input: {
  projection: ProjectedRun;
  events: StoredRunEvent[];
}): EfficiencyReport {
  const { projection, events } = input;
  return {
    schemaVersion: EFFICIENCY_REPORT_SCHEMA,
    runId: projection.runId,
    findings: [
      ...runtimeInputAmplification(projection),
      ...coldSessionRepeat(projection, events),
      ...retryReworkShare(projection),
      ...expensiveModelNonGate(projection),
      ...repeatedLargePayloads(projection, events),
      ...usageCoverageMissing(projection),
      ...budgetLossAfterOutputs(projection, events),
    ],
  };
}

export function diagnoseRepoRun(repoPath: string, runId: string): EfficiencyReport {
  const store = new EventStore(eventStorePath(resolve(repoPath)));
  try {
    const events = store.list(runId);
    if (events.length === 0) {
      throw new Error(
        `run not found: ${runId}; retry with --repo <path used for run>`,
      );
    }
    return diagnoseRun({ projection: projectRun(events), events });
  } finally {
    store.close();
  }
}
