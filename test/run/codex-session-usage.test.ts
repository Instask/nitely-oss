import { describe, expect, it } from "vitest";

import { normalizeRuntimeUsageForPersistence } from "../../src/eval/usage.js";
import type { StoredRunEvent } from "../../src/events/types.js";
import { diagnoseRun } from "../../src/run/efficiency.js";
import { readCodexExecActivity } from "../../src/run/execution/codex-activity.js";
import { projectRun } from "../../src/run/project.js";
import { buildRunTraceSpans } from "../../src/telemetry/run-trace-otel.js";

const THREAD = "01a14d8a-7d55-7671-82b8-24feba81f30e";
const runId = "2026-10-18T050000000Z-resume1";

interface Snapshot {
  input: number;
  cached: number;
  output: number;
}

// Shaped like `codex exec --json` / `codex exec resume --json` stdout. The
// first two snapshots were measured on codex-cli 0.162.0: a one-word turn on a
// new thread, then a one-word turn after `codex exec resume` on that thread.
const MEASURED: Snapshot[] = [
  { input: 25_993, cached: 8_064, output: 5 },
  { input: 63_186, cached: 33_920, output: 10 },
  { input: 100_000, cached: 60_000, output: 20 },
];

function codexStdout(snapshot: Snapshot, threadId = THREAD): string {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: snapshot.input,
        cached_input_tokens: snapshot.cached,
        cache_write_input_tokens: 0,
        output_tokens: snapshot.output,
        reasoning_output_tokens: 0,
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
}

interface AttemptSpec {
  snapshot: Snapshot;
  /** The session event run-flow writes after a successful attempt. */
  session?: "cold" | "resumed";
  threadId?: string;
  /** Simulate records written before `raw.threadId` existed. */
  legacy?: boolean;
}

function runEvents(attempts: AttemptSpec[]): StoredRunEvent[] {
  let sequence = 0;
  const event = (
    type: StoredRunEvent["type"],
    payload: unknown,
    attempt?: number,
  ): StoredRunEvent => ({
    sequence: ++sequence,
    runId,
    type,
    payload,
    createdAt: new Date(Date.parse("2026-10-18T05:00:00.000Z") + sequence * 1000).toISOString(),
    ...(attempt !== undefined ? { stageId: "implement", attempt } : {}),
  });
  const events: StoredRunEvent[] = [event("run.created", { flowName: "implement-spec" })];
  attempts.forEach((spec, index) => {
    const attempt = index + 1;
    const usage = readCodexExecActivity(codexStdout(spec.snapshot, spec.threadId));
    if (!usage) throw new Error("fixture did not parse");
    const persisted = { ...normalizeRuntimeUsageForPersistence(usage) } as Record<string, unknown>;
    if (spec.legacy) {
      const raw = { ...(persisted.raw as Record<string, unknown>) };
      delete raw.threadId;
      persisted.raw = raw;
    }
    events.push(event("stage.started", { type: "agent", runtime: "codex" }, attempt));
    if (spec.session) {
      events.push(event("stage.runtime.session", {
        mode: spec.session,
        sessionId: spec.threadId ?? THREAD,
      }, attempt));
    }
    events.push(event("stage.runtime.usage", persisted, attempt));
    events.push(event("stage.runtime.calls", { calls: usage.callLog }, attempt));
    events.push(event(attempt === attempts.length ? "stage.completed" : "stage.retrying", {}, attempt));
  });
  events.push(event("run.completed", {}));
  return events;
}

function attemptUsage(events: StoredRunEvent[]) {
  return projectRun(events).stages[0]?.attempts.map((attempt) => attempt.runtimeUsage) ?? [];
}

describe("resumed Codex attempt usage", () => {
  it("records the parsed thread id so a resumed attempt can be tied to its session", () => {
    expect(readCodexExecActivity(codexStdout(MEASURED[0] as Snapshot))?.raw).toMatchObject({
      threadId: THREAD,
    });
  });

  it("keeps each attempt's own share, so the run total equals the last session snapshot", () => {
    // Attempt 3 failed: run-flow wrote its usage but no session event.
    const events = runEvents([
      { snapshot: MEASURED[0] as Snapshot, session: "cold" },
      { snapshot: MEASURED[1] as Snapshot, session: "resumed" },
      { snapshot: MEASURED[2] as Snapshot },
    ]);

    const [first, second, third] = attemptUsage(events);
    expect(first).toMatchObject({ inputTokens: 25_993, cachedInputTokens: 8_064, outputTokens: 5 });
    expect(second).toMatchObject({
      inputTokens: 37_193,
      cachedInputTokens: 25_856,
      outputTokens: 5,
      totalTokens: 37_198,
      raw: {
        threadId: THREAD,
        cachedInputTokens: 25_856,
        usageBaseline: "previous-attempt-on-session",
        sessionCumulative: { inputTokens: 63_186, cachedInputTokens: 33_920, outputTokens: 10 },
      },
    });
    expect(third).toMatchObject({ inputTokens: 36_814, cachedInputTokens: 26_080, outputTokens: 10 });

    expect(projectRun(events).runtimeUsage).toMatchObject({
      inputTokens: 100_000,
      cachedInputTokens: 60_000,
      outputTokens: 20,
      totalTokens: 100_020,
      knownAttempts: 3,
      unknownAttempts: 0,
    });
  });

  it("does not subtract across different threads", () => {
    const events = runEvents([
      { snapshot: MEASURED[0] as Snapshot, session: "cold" },
      {
        snapshot: MEASURED[1] as Snapshot,
        session: "cold",
        threadId: "01a14d8a-7d55-7671-82b8-24feba81f30f",
      },
    ]);
    expect(projectRun(events).runtimeUsage).toMatchObject({ inputTokens: 25_993 + 63_186 });
  });

  it("repairs records written before the thread id existed from the session event", () => {
    const events = runEvents([
      { snapshot: MEASURED[0] as Snapshot, session: "cold", legacy: true },
      { snapshot: MEASURED[1] as Snapshot, session: "resumed", legacy: true },
      // A failed legacy attempt has no session event and cannot be tied to
      // its thread, so it keeps its cumulative snapshot.
      { snapshot: MEASURED[2] as Snapshot, legacy: true },
    ]);
    const [, second, third] = attemptUsage(events);
    expect(second).toMatchObject({ inputTokens: 37_193, outputTokens: 5 });
    expect(third).toMatchObject({ inputTokens: 100_000, outputTokens: 20 });
  });

  it("treats a snapshot below its session baseline as unknown instead of guessing", () => {
    const events = runEvents([
      { snapshot: MEASURED[1] as Snapshot, session: "cold" },
      { snapshot: MEASURED[0] as Snapshot, session: "resumed" },
    ]);
    const [first, second] = attemptUsage(events);
    expect(first).toMatchObject({ inputTokens: 63_186 });
    expect(second).toBeUndefined();
    expect(projectRun(events).runtimeUsage).toMatchObject({
      inputTokens: 63_186,
      knownAttempts: 1,
      unknownAttempts: 1,
    });
  });

  it("exports a resumed attempt's own share on its attempt and turn spans", () => {
    const events = runEvents([
      { snapshot: MEASURED[0] as Snapshot, session: "cold" },
      { snapshot: MEASURED[1] as Snapshot, session: "resumed" },
    ]);
    const spans = buildRunTraceSpans(events)?.spans ?? [];
    const attemptSpan = spans.find((span) => span.key === "attempt:implement:2");
    expect(attemptSpan?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 37_193,
      "gen_ai.usage.cache_read.input_tokens": 25_856,
      "gen_ai.usage.output_tokens": 5,
    });
    const turnSpans = spans.filter(
      (span) => span.parentKey === "attempt:implement:2" && span.kind === "llm",
    );
    expect(turnSpans).toHaveLength(1);
    expect(turnSpans[0]?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 37_193,
      "gen_ai.usage.cache_read.input_tokens": 25_856,
      "nitely.usage.accounting": "delta",
    });
  });

  it("reads a resumed attempt's own share in efficiency findings", () => {
    const events = runEvents([
      { snapshot: MEASURED[0] as Snapshot, session: "cold" },
      { snapshot: MEASURED[1] as Snapshot, session: "resumed" },
    ]);
    const report = diagnoseRun({ projection: projectRun(events), events });
    const shapes = report.findings.filter(
      (finding) => finding.ruleId === "runtime-activity-shape" && finding.evidence.attempt === 2,
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.impact?.inputTokens).toBe(37_193);
  });
});
