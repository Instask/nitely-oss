import type { StoredRunEvent } from "../events/types.js";
import { defaultMaxRuntimeTokens } from "./budget-defaults.js";
import {
  billableRuntimeTokens,
  type ProjectedRun,
} from "./project.js";

export interface BudgetResumeBudgets {
  maxAgentAttempts?: number;
  maxJudgeAttempts?: number;
  maxCiRuns?: number;
  maxCostUsd?: number;
}

export type BudgetResumeDecision =
  | { kind: "not-applicable" }
  | { kind: "no-remaining-stage"; message: string }
  | {
      kind: "cap-not-raised";
      message: string;
      consumed: number;
      cap: number;
    }
  | {
      kind: "resume";
      stageId: string;
      consumed: number;
      cap?: number;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function latestRunFailedReason(
  events: StoredRunEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "run.failed") continue;
    const reason = asRecord(event.payload).reason;
    return typeof reason === "string" ? reason : undefined;
  }
  return undefined;
}

function consumedRuntimeTokens(projection: ProjectedRun): number {
  if (projection.budgetSummary?.runtimeTokens) {
    return projection.budgetSummary.runtimeTokens;
  }
  let total = 0;
  for (const stage of projection.stages) {
    for (const attempt of stage.attempts) {
      total += billableRuntimeTokens(attempt.runtimeUsage) ?? 0;
    }
  }
  return total;
}

function latestBudgetExceeded(events: StoredRunEvent[]): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "budget.exceeded") return asRecord(event.payload);
  }
  return undefined;
}

export function decideBudgetStoppedResume(input: {
  projection: ProjectedRun;
  events: StoredRunEvent[];
  graphOrder: readonly string[];
  alwaysRunStageIds?: readonly string[];
  currentBudgets?: BudgetResumeBudgets;
  defaultMaxRuntimeTokens?: number;
}): BudgetResumeDecision {
  if (input.projection.status !== "failed") return { kind: "not-applicable" };
  if (latestRunFailedReason(input.events) !== "budget_exceeded") {
    return { kind: "not-applicable" };
  }

  const completed = new Set(input.projection.completedStages);
  const alwaysRun = new Set(input.alwaysRunStageIds ?? []);
  const stageId = input.graphOrder.find(
    (id) => !completed.has(id) && !alwaysRun.has(id),
  );
  if (!stageId) {
    return {
      kind: "no-remaining-stage",
      message:
        "run stopped on a runtime token budget with no remaining stage to resume",
    };
  }

  const exceeded = latestBudgetExceeded(input.events);
  const budgetKind = exceeded?.budgetKind;
  const capByKind: Record<string, number | undefined> = {
    "agent-attempts": input.currentBudgets?.maxAgentAttempts,
    "judge-attempts": input.currentBudgets?.maxJudgeAttempts,
    "ci-runs": input.currentBudgets?.maxCiRuns,
    cost: input.currentBudgets?.maxCostUsd,
  };
  if (typeof budgetKind === "string" && budgetKind in capByKind) {
    const consumed = typeof exceeded?.consumed === "number" ? exceeded.consumed : 0;
    const cap = capByKind[budgetKind];
    if (cap !== undefined && typeof exceeded?.unknownCostAttempts === "number" && exceeded.unknownCostAttempts > 0) {
      return {
        kind: "cap-not-raised",
        consumed,
        cap: cap ?? 0,
        message:
          "run stopped on a verification cost budget because runtime cost is unknown; resume only after every runtime reports classified cost",
      };
    }
    if (cap !== undefined && consumed >= cap) {
      const setting = budgetKind === "cost"
        ? "spec.verificationBudget.maxRuntimeCostUsd"
        : `spec.verificationBudget.${budgetKind === "agent-attempts"
          ? "maxAgentAttempts"
          : budgetKind === "judge-attempts"
            ? "maxJudgeAttempts"
            : "maxCiRuns"}`;
      return {
        kind: "cap-not-raised",
        consumed,
        cap,
        message: `run stopped on ${budgetKind} after ${consumed} used of ${cap}; raise ${setting} above ${consumed} on the flow before resume`,
      };
    }
  }

  const consumed = consumedRuntimeTokens(input.projection);
  const cap =
    input.defaultMaxRuntimeTokens ??
    defaultMaxRuntimeTokens();
  if (cap !== undefined && consumed >= cap) {
    return {
      kind: "cap-not-raised",
      consumed,
      cap,
      message:
        `run stopped on a runtime token budget after ${consumed} tokens used of ${cap}; raise NITELY_DEFAULT_MAX_RUNTIME_TOKENS above ${consumed} before resume`,
    };
  }
  return {
    kind: "resume",
    stageId,
    consumed,
    ...(cap !== undefined ? { cap } : {}),
  };
}
