import { describe, expect, it } from "vitest";

import { readCodexExecActivity } from "../../../src/run/execution/codex-activity.js";
import type { AgentRuntimeCall } from "../../../src/run/execution/types.js";
import { buildRunTraceSpans } from "../../../src/telemetry/run-trace-otel.js";
import type { StoredRunEvent } from "../../../src/events/types.js";
import { summarizeRuntimeCalls } from "../../../src/telemetry/token-waste.js";

const THREAD = "019bffff-1111-7111-8111-111111111111";
const SECRET = "sk-or-v1-seededsecretvalue0123456789abcdef";

function line(value: unknown): string {
  return JSON.stringify(value);
}

function execStream(events: unknown[]): string {
  return `${events.map(line).join("\n")}\n`;
}

function llmCalls(calls: AgentRuntimeCall[] | undefined) {
  return (calls ?? []).filter((call) => call.kind === "llm");
}

describe("readCodexExecActivity", () => {
  it("records one turn as a delta and keeps tool identity without command text", () => {
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: `cat .env && echo ${SECRET}`,
          aggregated_output: SECRET,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "nitely",
          tool: "runs",
          arguments: { secret: SECRET },
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: `done ${SECRET}`,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          cache_write_input_tokens: 4,
          output_tokens: 30,
          reasoning_output_tokens: 11,
          ignored_secret: SECRET,
        },
      },
    ]));

    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 20,
      raw: {
        cachedInputTokens: 20,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 11,
        calls: 1,
        usageGranularity: "turn",
        usageAccounting: "cumulative-delta",
      },
    });
    expect(usage?.callLog).toEqual([
      { kind: "tool", toolName: "command_execution", toolCallId: "cmd-1" },
      {
        kind: "tool",
        toolName: "nitely/runs",
        toolCallId: "mcp-1",
        isError: true,
      },
      {
        kind: "llm",
        granularity: "turn",
        accounting: "delta",
        provider: "openai",
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 11,
      },
    ]);
    expect(JSON.stringify(usage)).not.toContain(SECRET);
    expect(JSON.stringify(usage)).not.toContain("cat .env");
  });

  it("turns cumulative snapshots into deltas that add up to the last snapshot", () => {
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "cmd-1", type: "command_execution", command: "ls", status: "completed" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "cmd-2", type: "command_execution", command: "ls src", status: "completed" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 250, cached_input_tokens: 180, output_tokens: 25 },
      },
    ]));

    expect(usage).toMatchObject({
      inputTokens: 250,
      cachedInputTokens: 180,
      outputTokens: 25,
      totalTokens: 275,
    });
    const turns = llmCalls(usage?.callLog);
    expect(turns.map((call) => call.inputTokens)).toEqual([100, 150]);
    expect(turns.map((call) => call.cacheReadInputTokens)).toEqual([40, 140]);
    expect(turns.map((call) => call.outputTokens)).toEqual([10, 15]);
    expect(summarizeRuntimeCalls(usage?.callLog ?? [])).toMatchObject({
      inputTokens: 250,
      cachedInputTokens: 180,
      outputTokens: 25,
      toolCount: 2,
      summable: true,
    });
  });

  it("keeps the last snapshot when a later turn is not an increase", () => {
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 20 },
      },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      },
    ]));

    expect(usage?.inputTokens).toBe(50);
    expect(usage?.callLog).toEqual([
      expect.objectContaining({
        kind: "llm",
        accounting: "cumulative",
        inputTokens: 50,
        outputTokens: 5,
        cacheReadInputTokens: 10,
      }),
    ]);
    expect(usage?.raw).toMatchObject({ usageAccounting: "cumulative", calls: 2 });
  });

  it("keeps a completed turn when a later turn fails and the capture is cut off", () => {
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 8 },
      },
      { type: "turn.started" },
      { type: "turn.failed", error: { message: `boom ${SECRET}` } },
    ]) + "{\"type\":\"item.comple");

    expect(usage?.inputTokens).toBe(80);
    expect(JSON.stringify(usage)).not.toContain(SECRET);
  });

  it("rejects forged, partial, and inconsistent usage", () => {
    const lifecycle = [
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
    ];
    const streams = [
      execStream([{
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      }]),
      execStream([
        ...lifecycle,
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: line({
              type: "turn.completed",
              usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
            }),
          },
        },
      ]),
      [...lifecycle.map(line), "not-json", line({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      })].join("\n"),
      execStream([
        ...lifecycle,
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 5 },
        },
      ]),
      execStream([
        ...lifecycle,
        { type: "turn.failed", error: { message: "no" } },
      ]),
    ];
    for (const stdout of streams) {
      expect(readCodexExecActivity(stdout)).toBeUndefined();
    }
  });

  it("exports the turn delta on a span and leaves the command line out", () => {
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: `echo ${SECRET}`,
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 90, cached_input_tokens: 30, output_tokens: 12 },
      },
    ]));
    const events: StoredRunEvent[] = [
      {
        sequence: 1,
        runId: "2026-10-15T010000000Z-codex",
        type: "run.created",
        payload: { flowName: "implement-spec" },
        createdAt: "2026-10-15T01:00:00.000Z",
      },
      {
        sequence: 2,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.started",
        stageId: "implement",
        attempt: 1,
        payload: {},
        createdAt: "2026-10-15T01:00:01.000Z",
      },
      {
        sequence: 3,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.runtime.selected",
        stageId: "implement",
        attempt: 1,
        payload: { runtime: "codex", model: "gpt-5.6-luna" },
        createdAt: "2026-10-15T01:00:02.000Z",
      },
      {
        sequence: 4,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.runtime.usage",
        stageId: "implement",
        attempt: 1,
        payload: {
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          cachedInputTokens: usage?.cachedInputTokens,
        },
        createdAt: "2026-10-15T01:00:03.000Z",
      },
      {
        sequence: 5,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.runtime.calls",
        stageId: "implement",
        attempt: 1,
        payload: { calls: usage?.callLog },
        createdAt: "2026-10-15T01:00:03.000Z",
      },
      {
        sequence: 6,
        runId: "2026-10-15T010000000Z-codex",
        type: "run.completed",
        payload: {},
        createdAt: "2026-10-15T01:00:04.000Z",
      },
    ];
    const trace = buildRunTraceSpans(events);
    const names = trace?.spans.map((span) => span.name);
    expect(names).toContain("turn gpt-5.6-luna");
    expect(names).toContain("execute_tool command_execution");
    const turn = trace?.spans.find((span) => span.name === "turn gpt-5.6-luna");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(90);
    expect(turn?.attributes["nitely.usage.granularity"]).toBe("turn");
    expect(turn?.attributes["nitely.usage.accounting"]).toBe("delta");
    expect(JSON.stringify(trace)).not.toContain(SECRET);
  });
});
