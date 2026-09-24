import { describe, expect, it } from "vitest";

import type { StoredRunEvent } from "../../src/events/types.js";
import { normalizeProviderUsage } from "../../src/eval/usage.js";
import { projectRun } from "../../src/run/project.js";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  payload: unknown,
  options: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence,
    runId: "run-eval-usage",
    type,
    payload,
    createdAt: `2026-07-16T00:00:0${sequence}.000Z`,
    ...options,
  };
}

describe("normalized usage in ordinary run projection", () => {
  it("withholds run-level costs when attempts mix actual and estimated classifications", () => {
    const actual = normalizeProviderUsage({
      provider: "openai",
      model: "gpt-5.1-codex",
      observedAt: "2026-07-16T00:00:02.000Z",
      source: { kind: "provider-reported", reference: "billing.usage" },
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.04 },
    });
    const estimated = normalizeProviderUsage({
      provider: "anthropic",
      model: "claude-opus",
      observedAt: "2026-07-16T00:00:05.000Z",
      source: { kind: "calculated", reference: "price-card-v4" },
      totalTokens: 100,
      cost: {
        classification: "estimated",
        usd: 0.02,
        method: "pinned team price card v4",
      },
    });
    const projection = projectRun([
      event(1, "run.created", {
        workflowStages: [
          { id: "implement", type: "agent", inputs: [], outputs: [] },
          { id: "review", type: "agent", inputs: [], outputs: [] },
        ],
      }),
      event(2, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(3, "stage.runtime.usage", actual, { stageId: "implement", attempt: 1 }),
      event(4, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(5, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(6, "stage.runtime.usage", estimated, { stageId: "review", attempt: 1 }),
      event(7, "stage.completed", {}, { stageId: "review", attempt: 1 }),
      event(8, "run.completed", {}),
    ]);

    expect(projection.stages?.[0].attempts[0].runtimeUsage).toMatchObject({
      cost: { classification: "actual", usd: 0.04 },
      provenance: {
        provider: "openai",
        source: { kind: "provider-reported", reference: "billing.usage" },
      },
    });
    expect(projection.runtimeUsage).toEqual({
      totalTokens: 250,
      knownAttempts: 2,
      unknownAttempts: 0,
    });
  });

  it("withholds run-level cost when a runtime attempt has no usage", () => {
    const actual = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:02.000Z",
      source: { kind: "provider-reported", reference: "billing.usage" },
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.04 },
    });
    const projection = projectRun([
      event(1, "run.created", {
        workflowStages: [
          { id: "implement", type: "agent", inputs: [], outputs: [] },
          { id: "review", type: "agent", inputs: [], outputs: [] },
        ],
      }),
      event(2, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(3, "stage.runtime.usage", actual, { stageId: "implement", attempt: 1 }),
      event(4, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(5, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(6, "stage.completed", {}, { stageId: "review", attempt: 1 }),
      event(7, "run.completed", {}),
    ]);

    expect(projection.runtimeUsage).toEqual({
      totalTokens: 150,
      knownAttempts: 1,
      unknownAttempts: 1,
    });
  });

  it("withholds run-level cost when an observed usage has unknown cost", () => {
    const actual = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:02.000Z",
      source: { kind: "provider-reported", reference: "billing.usage" },
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.04 },
    });
    const unknownCost = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:05.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      totalTokens: 100,
    });
    const projection = projectRun([
      event(1, "run.created", {}),
      event(2, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(3, "stage.runtime.usage", actual, { stageId: "implement", attempt: 1 }),
      event(4, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(5, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(6, "stage.runtime.usage", unknownCost, { stageId: "review", attempt: 1 }),
      event(7, "stage.completed", {}, { stageId: "review", attempt: 1 }),
      event(8, "run.completed", {}),
    ]);

    expect(projection.runtimeUsage).toEqual({
      totalTokens: 250,
      knownAttempts: 2,
      unknownAttempts: 0,
    });
  });

  it("sums actual cost when every attempt has provider-reported provenance", () => {
    const first = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:02.000Z",
      source: { kind: "provider-reported", reference: "billing.usage" },
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.04 },
    });
    const second = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:05.000Z",
      source: { kind: "provider-reported", reference: "billing.usage" },
      totalTokens: 100,
      cost: { classification: "actual", usd: 0.06 },
    });
    const projection = projectRun([
      event(1, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(2, "stage.runtime.usage", first, { stageId: "implement", attempt: 1 }),
      event(3, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(4, "stage.runtime.usage", second, { stageId: "review", attempt: 1 }),
    ]);

    expect(projection.runtimeUsage).toEqual({
      totalTokens: 250,
      actualCostUsd: 0.1,
      knownAttempts: 2,
      unknownAttempts: 0,
    });
  });

  it("sums estimated cost when every attempt has calculated provenance", () => {
    const first = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:02.000Z",
      source: { kind: "calculated", reference: "price-card-v4" },
      totalTokens: 150,
      cost: {
        classification: "estimated",
        usd: 0.04,
        method: "pinned price card v4",
      },
    });
    const second = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:05.000Z",
      source: { kind: "calculated", reference: "price-card-v4" },
      totalTokens: 100,
      cost: {
        classification: "estimated",
        usd: 0.06,
        method: "pinned price card v4",
      },
    });
    const projection = projectRun([
      event(1, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "implement",
        attempt: 1,
      }),
      event(2, "stage.runtime.usage", first, { stageId: "implement", attempt: 1 }),
      event(3, "stage.started", { type: "agent", runtime: "codex" }, {
        stageId: "review",
        attempt: 1,
      }),
      event(4, "stage.runtime.usage", second, { stageId: "review", attempt: 1 }),
    ]);

    expect(projection.runtimeUsage).toEqual({
      totalTokens: 250,
      estimatedCostUsd: 0.1,
      knownAttempts: 2,
      unknownAttempts: 0,
    });
  });

  it("does not count forged cost classifications without matching provenance", () => {
    const projection = projectRun([
      event(1, "run.created", {
        workflowStages: [{ id: "implement", type: "agent", inputs: [], outputs: [] }],
      }),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.runtime.usage", {
        totalTokens: 10,
        cost: { classification: "actual", usd: 99 },
        provenance: {
          provider: "forged",
          observedAt: "2026-07-16T00:00:02.000Z",
          source: { kind: "calculated", reference: "guess" },
        },
      }, { stageId: "implement", attempt: 1 }),
      event(4, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(5, "run.completed", {}),
    ]);

    expect(projection.stages?.[0].attempts[0].runtimeUsage?.cost).toBeUndefined();
    expect(projection.runtimeUsage?.actualCostUsd).toBeUndefined();
    expect(projection.runtimeUsage?.totalTokens).toBe(10);
  });
});
