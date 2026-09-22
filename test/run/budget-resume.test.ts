import { describe, expect, it } from "vitest";

import type { StoredRunEvent } from "../../src/events/types.js";
import { decideBudgetStoppedResume } from "../../src/run/budget-resume.js";
import { projectRun } from "../../src/run/project.js";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  payload: unknown,
  options: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence,
    runId: options.runId ?? "run-budget",
    type,
    payload,
    createdAt: options.createdAt ?? `2026-09-07T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    stageId: options.stageId,
    attempt: options.attempt,
  };
}

function budgetStoppedEvents(input?: {
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}): StoredRunEvent[] {
  const usage = input?.usage ?? {
    inputTokens: 150,
    outputTokens: 0,
    totalTokens: 150,
  };
  return [
    event(1, "run.created", { flowName: "budget-after-completion" }),
    event(2, "stage.started", {}, { stageId: "write-tests", attempt: 1 }),
    event(3, "stage.runtime.usage", usage, { stageId: "write-tests", attempt: 1 }),
    event(4, "stage.completed", {}, { stageId: "write-tests", attempt: 1 }),
    event(
      5,
      "budget.exceeded",
      {
        budgetKind: "runtime-tokens",
        scope: "run",
        phase: "consumption",
        budget: 100,
        consumed: 150,
      },
      { stageId: "write-tests", attempt: 1 },
    ),
    event(6, "run.failed", {
      stageId: "write-tests",
      reason: "budget_exceeded",
      error: "run runtime token budget exhausted: 150 tokens used of 100",
    }),
  ];
}

describe("decideBudgetStoppedResume", () => {
  const graphOrder = ["write-tests", "implement"];

  it("is not applicable to a failed run that did not stop on budget", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.failed", { error: "boom" }, { stageId: "implement", attempt: 1 }),
      event(4, "run.failed", { stageId: "implement", error: "boom" }),
    ];

    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder,
        currentBudgets: { maxAgentAttempts: 4 },
      }),
    ).toEqual({ kind: "not-applicable" });
  });

  it("refuses resume when the current cap is still at or below consumed tokens", () => {
    const events = budgetStoppedEvents();

    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder,
        defaultMaxRuntimeTokens: 100,
      }),
    ).toEqual({
      kind: "cap-not-raised",
      consumed: 150,
      cap: 100,
      message:
        "run stopped on a runtime token budget after 150 tokens used of 100; raise NITELY_DEFAULT_MAX_RUNTIME_TOKENS above 150 before resume",
    });
  });

  it("resumes at the first incomplete stage once the cap is above consumed tokens", () => {
    const events = budgetStoppedEvents();

    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder,
        defaultMaxRuntimeTokens: 400,
      }),
    ).toEqual({
      kind: "resume",
      stageId: "implement",
      consumed: 150,
      cap: 400,
    });
  });

  it("applies the same cap-raised rule to verification attempt budgets", () => {
    const events = [
      event(1, "run.created", { flowName: "verification-budget" }),
      event(2, "stage.started", { type: "agent" }, { stageId: "implement", attempt: 1 }),
      event(3, "budget.exceeded", {
        budgetKind: "agent-attempts",
        scope: "run",
        phase: "admission",
        budget: 1,
        consumed: 1,
        remaining: 0,
      }, { stageId: "implement", attempt: 2 }),
      event(4, "run.failed", { reason: "budget_exceeded" }),
    ];

    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder: ["implement"],
        currentBudgets: { maxAgentAttempts: 1 },
      }),
    ).toMatchObject({ kind: "cap-not-raised", consumed: 1, cap: 1 });
    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder: ["implement"],
        currentBudgets: { maxAgentAttempts: 2 },
      }),
    ).toMatchObject({ kind: "resume", stageId: "implement" });
  });

  it("keeps resume conservative when a declared verification cost is unknown", () => {
    const events = [
      event(1, "run.created", { flowName: "verification-cost" }),
      event(2, "stage.started", { type: "agent" }, { stageId: "implement", attempt: 1 }),
      event(3, "budget.exceeded", {
        budgetKind: "cost",
        budget: 10,
        consumed: 0,
        remaining: 10,
        unknownCostAttempts: 1,
      }, { stageId: "implement", attempt: 1 }),
      event(4, "run.failed", { reason: "budget_exceeded" }),
    ];

    expect(
      decideBudgetStoppedResume({
        projection: projectRun(events),
        events,
        graphOrder: ["implement"],
        currentBudgets: { maxCostUsd: 10 },
      }),
    ).toMatchObject({ kind: "cap-not-raised", message: expect.stringContaining("unknown") });
  });
});
