import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StoredRunEvent } from "../../src/events/types.js";
import { readCodexExecActivity } from "../../src/run/execution/codex-activity.js";
import { applyCodexRolloutCalls } from "../../src/run/execution/codex-rollout.js";
import type { AgentRuntimeUsage } from "../../src/run/execution/types.js";
import { diagnoseRun } from "../../src/run/efficiency.js";
import { projectRun } from "../../src/run/project.js";
import { buildRunTraceSpans } from "../../src/telemetry/run-trace-otel.js";
import { formatModelCallCurve, summarizeResentToolOutputs } from "../../src/telemetry/token-waste.js";
import {
  CONTENT_MARKER,
  outputOf,
  PATH_MARKER,
  ROLLOUT_THREAD,
  RolloutBuilder,
} from "../fixtures/codex-rollout.js";

const RUN = "2026-10-19T073024421Z-synthetic";
const STARTED = Date.parse("2026-10-19T07:30:24.421Z");

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "nitely-codex-surfaces-"));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

/**
 * The shape the production rollout showed (numbers only): seven early
 * exploratory reads of 12–36 KB push the context from ~15k to ~54k tokens,
 * then 44 more calls each add a few hundred bytes and resend the rest.
 */
async function implementAttempt(): Promise<AgentRuntimeUsage> {
  const rollout = new RolloutBuilder(STARTED + 5).meta().turn();
  const reads = [36_000, 30_000, 24_000, 22_000, 20_000, 18_000, 16_000];
  let context = 15_000;
  rollout.call({ input: context, cached: 2_000, output: 200 });
  reads.forEach((bytes, index) => {
    rollout.tool(`call_read_${index}`, outputOf(bytes));
    context += Math.round(bytes / 4) + 150;
    rollout.call({ input: context, cached: context - Math.round(bytes / 4) - 150, output: 150 });
  });
  for (let index = 0; index < 44; index += 1) {
    rollout.tool(`call_small_${index}`, outputOf(300));
    context += 300;
    rollout.call({ input: context, cached: context - 300, output: 120 });
  }
  const path = await rollout.write(codexHome);
  expect(path).toContain(ROLLOUT_THREAD);
  const total = rollout.runningTotal;
  const exec = readCodexExecActivity([
    JSON.stringify({ type: "thread.started", thread_id: ROLLOUT_THREAD }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output },
    }),
  ].join("\n"));
  const usage = await applyCodexRolloutCalls(exec, { codexHome, attemptStartedAtMs: STARTED });
  if (!usage) throw new Error("no usage");
  return usage;
}

function events(usage: AgentRuntimeUsage): StoredRunEvent[] {
  const base = { runId: RUN, stageId: "implement", attempt: 1 };
  return [
    { sequence: 1, runId: RUN, type: "run.created", payload: {}, createdAt: "2026-10-19T07:30:24.000Z" },
    { ...base, sequence: 2, type: "stage.started", payload: {}, createdAt: "2026-10-19T07:30:24.100Z" },
    {
      ...base,
      sequence: 3,
      type: "stage.runtime.selected",
      payload: { runtime: "codex", model: "gpt-5.5-codex" },
      createdAt: "2026-10-19T07:30:24.200Z",
    },
    {
      ...base,
      sequence: 4,
      type: "stage.runtime.usage",
      payload: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cachedInputTokens: usage.cachedInputTokens,
        provenance: usage.provenance,
        raw: usage.raw,
      },
      createdAt: "2026-10-19T07:45:00.000Z",
    },
    {
      ...base,
      sequence: 5,
      type: "stage.runtime.calls",
      payload: { calls: usage.callLog, source: usage.callLogSource },
      createdAt: "2026-10-19T07:45:00.000Z",
    },
    { ...base, sequence: 6, type: "stage.completed", payload: {}, createdAt: "2026-10-19T07:45:01.000Z" },
    { sequence: 7, runId: RUN, type: "run.completed", payload: {}, createdAt: "2026-10-19T07:45:02.000Z" },
  ];
}

describe("Codex per-call records on the operator surfaces", () => {
  it("attributes cached input to early large tool outputs resent on later calls", async () => {
    const usage = await implementAttempt();
    const summary = summarizeResentToolOutputs(usage.callLog ?? [], {
      largeOutputBytes: 8 * 1024,
      tinyNewInputBytes: 1024,
    });
    expect(summary?.modelCalls).toBe(52);
    expect(summary?.largeOutputs).toHaveLength(7);
    // The first read is resent by every call after the one that read it.
    expect(summary?.largeOutputs[0]).toMatchObject({ outputBytes: 36_000, laterCalls: 50 });
    expect(summary?.tinyNewInputCalls).toBe(44);

    const all = events(usage);
    const finding = diagnoseRun({ projection: projectRun(all), events: all }).findings
      .find((entry) => entry.ruleId === "resent-tool-output");
    expect(finding).toMatchObject({ severity: "warn", evidence: { stageIds: ["implement"], attempt: 1 } });
    expect(finding?.summary).toContain("52 model calls");
    expect(finding?.summary).toContain("7 tool outputs");
    expect(finding?.summary).toContain("44 of 51 later calls");
    expect(finding?.impact?.ratio).toBeGreaterThan(0.4);
    expect(finding?.impact?.ratio).toBeLessThan(0.7);
    expect(JSON.stringify(finding)).not.toContain(CONTENT_MARKER);
  });

  it("does not attribute turn-level Codex records", async () => {
    const usage = await implementAttempt();
    const turnOnly = { ...usage, callLog: usage.callLog?.map((call) => call.kind === "llm" ? { ...call, granularity: "turn" as const } : call) };
    expect(summarizeResentToolOutputs(turnOnly.callLog ?? [], { largeOutputBytes: 1, tinyNewInputBytes: 1 })).toBeUndefined();
  });

  it("exports one chat span per model call with the tool output it read first", async () => {
    const usage = await implementAttempt();
    const trace = buildRunTraceSpans(events(usage));
    const chats = trace?.spans.filter((span) => span.name === "chat gpt-5.5-codex") ?? [];
    expect(chats).toHaveLength(52);
    expect(chats[0]?.attributes["nitely.usage.granularity"]).toBe("call");
    expect(chats[0]?.attributes["nitely.call.new_tool_output_bytes"]).toBe(0);
    expect(chats[1]?.attributes["nitely.call.new_tool_output_bytes"]).toBe(36_000);
    expect(chats[1]?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBeGreaterThan(0);
    const tool = trace?.spans.find((span) => span.name === "execute_tool exec");
    expect(tool?.attributes["nitely.tool.output_bytes"]).toBe(36_000);
    const attempt = trace?.spans.find((span) => span.attributes["nitely.span.kind"] === "attempt");
    expect(attempt?.attributes["nitely.usage.call_source"]).toBe("codex.rollout.token_count");
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(CONTENT_MARKER);
    expect(serialized).not.toContain(PATH_MARKER);
  });

  it("summarizes the per-call curve for the Web stage details", async () => {
    const usage = await implementAttempt();
    const line = formatModelCallCurve({ calls: usage.callLog });
    expect(line).toMatch(/^52 model calls · input per call 15k → /);
    expect(line).toContain("51 tool outputs");
    expect(line).toContain("(7 ≥ 8 KB)");
    expect(line).toContain("curve (1 in 3)");
    expect(formatModelCallCurve({
      calls: [{ kind: "llm", granularity: "turn", inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }],
      fallback: { reason: "missing", detail: "no rollout" },
    })).toBe("1 turn record, no per-call split (rollout: missing)");
  });
});
