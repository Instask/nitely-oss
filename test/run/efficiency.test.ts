import { describe, expect, it } from "vitest";

import type { StoredRunEvent } from "../../src/events/types.js";
import { diagnoseRun } from "../../src/run/efficiency.js";
import { projectRun } from "../../src/run/project.js";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  payload: unknown,
  options: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence,
    runId: options.runId ?? "run-517",
    type,
    payload,
    createdAt: options.createdAt ?? `2026-08-30T14:22:${String(sequence).padStart(2, "0")}.000Z`,
    stageId: options.stageId,
    attempt: options.attempt,
  };
}

function findingIds(events: StoredRunEvent[]): string[] {
  return diagnoseRun({ projection: projectRun(events), events }).findings.map(
    (finding) => finding.ruleId,
  );
}

describe("diagnoseRun", () => {
  it("identifies repository/runtime read amplification and budget loss on a #517-shaped run", () => {
    const events = [
      event(1, "run.created", { flowName: "implement-spec-bootstrap" }),
      event(2, "stage.started", {}, { stageId: "write-tests", attempt: 1 }),
      event(
        3,
        "stage.context.usage",
        {
          promptBytes: 9200,
          approxTokens: 2300,
          inputBytesInlined: 4000,
          inputBytesSaved: 0,
          inputCount: 1,
        },
        { stageId: "write-tests", attempt: 1 },
      ),
      event(
        4,
        "stage.runtime.usage",
        {
          inputTokens: 2_216_578,
          outputTokens: 23_250,
          totalTokens: 2_239_828,
          cachedInputTokens: 2_062_336,
        },
        { stageId: "write-tests", attempt: 1 },
      ),
      event(5, "stage.completed", {}, { stageId: "write-tests", attempt: 1 }),
      event(
        6,
        "budget.exceeded",
        { budgetKind: "runtime-tokens", consumed: 177_492, budget: 2_000_000 },
        { stageId: "write-tests", attempt: 1 },
      ),
      event(7, "run.failed", {
        stageId: "write-tests",
        reason: "budget_exceeded",
      }),
    ];

    const report = diagnoseRun({ projection: projectRun(events), events });
    const amplification = report.findings.find(
      (finding) => finding.ruleId === "runtime-input-amplification",
    );
    const budgetLoss = report.findings.find(
      (finding) => finding.ruleId === "budget-loss-after-outputs",
    );

    expect(amplification?.confidence).toBe("high");
    expect(amplification?.summary).toContain("2300");
    expect(amplification?.summary).not.toMatch(/prompt was (too )?large/i);
    expect(amplification?.summary).toContain("2239828");
    expect(amplification?.summary).toContain("2062336");
    expect(amplification?.summary).toContain("177492");
    expect(amplification?.summary).toMatch(/cache/i);
    expect(amplification?.impact).toMatchObject({
      inputTokens: 2_216_578,
      contextTokens: 2300,
      cachedInputTokens: 2_062_336,
      billableTokens: 177_492,
    });
    expect(budgetLoss?.relatedIssues).toEqual(expect.arrayContaining([517, 537]));
    expect(budgetLoss?.evidence.stageIds).toEqual(["write-tests"]);
  });

  it("marks session reuse unknown when no session events exist", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(3, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(4, "run.completed", {}),
    ];
    const finding = diagnoseRun({
      projection: projectRun(events),
      events,
    }).findings.find((entry) => entry.ruleId === "cold-session-repeat");
    expect(finding?.confidence).toBe("unknown");
  });

  it("flags later cold attempts after a session id was recorded", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(
        3,
        "stage.runtime.session",
        { mode: "cold", sessionId: "ses_1" },
        { stageId: "implement", attempt: 1 },
      ),
      event(4, "stage.failed", { error: "retry" }, { stageId: "implement", attempt: 1 }),
      event(5, "stage.started", {}, { stageId: "implement", attempt: 2 }),
      event(
        6,
        "stage.runtime.session",
        { mode: "cold" },
        { stageId: "implement", attempt: 2 },
      ),
      event(7, "run.failed", { stageId: "implement" }),
    ];
    const finding = diagnoseRun({
      projection: projectRun(events),
      events,
    }).findings.find((entry) => entry.ruleId === "cold-session-repeat");
    expect(finding?.confidence).toBe("high");
    expect(finding?.summary).toContain("cold");
  });

  it("measures retry token share from later attempts", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(
        3,
        "stage.runtime.usage",
        { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
        { stageId: "implement", attempt: 1 },
      ),
      event(4, "stage.failed", { error: "retry" }, { stageId: "implement", attempt: 1 }),
      event(5, "stage.retrying", {}, { stageId: "implement", attempt: 1 }),
      event(6, "stage.started", {}, { stageId: "implement", attempt: 2 }),
      event(
        7,
        "stage.runtime.usage",
        { inputTokens: 400, outputTokens: 0, totalTokens: 400 },
        { stageId: "implement", attempt: 2 },
      ),
      event(8, "run.failed", { stageId: "implement" }),
    ];
    const finding = diagnoseRun({
      projection: projectRun(events),
      events,
    }).findings.find((entry) => entry.ruleId === "retry-rework-share");
    expect(finding?.impact).toMatchObject({
      retryTokens: 400,
      totalTokens: 500,
      retryShare: 0.8,
    });
  });

  it("flags a frontier model on a non-gate stage", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", { type: "agent" }, { stageId: "implement", attempt: 1 }),
      event(
        3,
        "stage.runtime.usage",
        {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          provenance: {
            provider: "anthropic",
            model: "claude-opus-4",
            observedAt: "2026-08-30T14:22:03.000Z",
            source: { kind: "provider-reported", reference: "claude" },
          },
        },
        { stageId: "implement", attempt: 1 },
      ),
      event(4, "run.completed", {}),
    ];
    expect(findingIds(events)).toContain("expensive-model-non-gate");
  });

  it("reports unknown tool-payload telemetry instead of inventing a claim", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(3, "run.completed", {}),
    ];
    const finding = diagnoseRun({
      projection: projectRun(events),
      events,
    }).findings.find((entry) => entry.ruleId === "repeated-large-payloads");
    expect(finding?.confidence).toBe("unknown");
  });

  it("flags missing usage coverage rather than treating it as zero cost", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", { runtime: "grok" }, { stageId: "implement", attempt: 1 }),
      event(3, "stage.completed", {}, { stageId: "implement", attempt: 1 }),
      event(4, "run.completed", {}),
    ];
    const finding = diagnoseRun({
      projection: projectRun(events),
      events,
    }).findings.find((entry) => entry.ruleId === "usage-coverage-missing");
    expect(finding?.summary).toMatch(/unknown/i);
    expect(finding?.summary).not.toMatch(/cost \$0/);
  });

  it("does not cite raw secret-bearing usage payloads", () => {
    const events = [
      event(1, "run.created", {}),
      event(2, "stage.started", {}, { stageId: "implement", attempt: 1 }),
      event(
        3,
        "stage.runtime.usage",
        {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          raw: { credential: "runtime-private-credential-123" },
        },
        { stageId: "implement", attempt: 1 },
      ),
      event(4, "run.completed", {}),
    ];
    const serialized = JSON.stringify(
      diagnoseRun({ projection: projectRun(events), events }),
    );
    expect(serialized).not.toContain("runtime-private-credential-123");
  });
});
