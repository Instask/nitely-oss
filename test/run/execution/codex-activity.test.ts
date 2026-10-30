import { describe, expect, it } from "vitest";

import { createCodexExecCapture, readCodexExecActivity } from "../../../src/run/execution/codex-activity.js";
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
    const toolSpan = trace?.spans.find((span) => span.name === "execute_tool command_execution");
    expect(toolSpan?.startTime).toBe(toolSpan?.endTime);
  });

  it("records tool and turn durations from observation times", () => {
    const started = Date.parse("2026-10-15T01:00:02.100Z");
    const ended = Date.parse("2026-10-15T01:00:02.800Z");
    const turnStarted = Date.parse("2026-10-15T01:00:02.000Z");
    const turnEnded = Date.parse("2026-10-15T01:00:02.900Z");
    const usage = readCodexExecActivity(execStream([
      { type: "thread.started", thread_id: THREAD, observedAt: turnStarted },
      { type: "turn.started", observedAt: turnStarted },
      {
        type: "item.started",
        observedAt: started,
        item: { id: "cmd-1", type: "command_execution", status: "in_progress" },
      },
      {
        type: "item.completed",
        observedAt: ended,
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: `echo ${SECRET}`,
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        observedAt: turnEnded,
        usage: { input_tokens: 90, cached_input_tokens: 30, output_tokens: 12 },
      },
    ]));
    expect(usage?.callLog).toEqual([
      {
        kind: "tool",
        toolName: "command_execution",
        toolCallId: "cmd-1",
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString(),
      },
      expect.objectContaining({
        kind: "llm",
        startedAt: new Date(turnStarted).toISOString(),
        endedAt: new Date(turnEnded).toISOString(),
      }),
    ]);
    const events: StoredRunEvent[] = [
      {
        sequence: 1,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.started",
        stageId: "implement",
        attempt: 1,
        payload: {},
        createdAt: "2026-10-15T01:00:01.000Z",
      },
      {
        sequence: 2,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.runtime.selected",
        stageId: "implement",
        attempt: 1,
        payload: { runtime: "codex", model: "gpt-5.6-luna" },
        createdAt: "2026-10-15T01:00:02.000Z",
      },
      {
        sequence: 3,
        runId: "2026-10-15T010000000Z-codex",
        type: "stage.runtime.calls",
        stageId: "implement",
        attempt: 1,
        payload: { calls: usage?.callLog },
        createdAt: "2026-10-15T01:00:03.000Z",
      },
    ];
    const trace = buildRunTraceSpans(events);
    const toolSpan = trace?.spans.find((span) => span.name === "execute_tool command_execution");
    expect(toolSpan?.startTime).toBe(new Date(started).toISOString());
    expect(toolSpan?.endTime).toBe(new Date(ended).toISOString());
    expect(toolSpan?.startTime).not.toBe(toolSpan?.endTime);
  });
});

describe("createCodexExecCapture", () => {
  it("keeps a finished turn when a later command line is cut off", () => {
    let clock = 1_700_000_000_000;
    const capture = createCodexExecCapture({ now: () => (clock += 1_000) });
    const prelude = [
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      {
        type: "item.started",
        item: { id: "cmd-1", type: "command_execution", status: "in_progress" },
      },
    ].map(line).join("\n") + "\n";
    capture.write(prelude);
    const bulky = `${JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: `/bin/bash -lc ${SECRET}`,
        aggregated_output: `${"x".repeat(20_000)}${SECRET}`,
        status: "completed",
      },
    })}\n`;
    capture.write(bulky.slice(0, 9_000));
    expect(capture.size()).toBeLessThan(12_000);
    capture.write(bulky.slice(9_000));
    capture.write(`${line({
      type: "turn.completed",
      usage: {
        input_tokens: 90,
        cached_input_tokens: 10,
        output_tokens: 8,
        reasoning_output_tokens: 3,
        cache_write_input_tokens: 1,
      },
    })}\n`);
    capture.write(`{"type":"item.completed","item":{"id":"cmd-2","type":"command_execution","command":"${SECRET}`);
    const text = capture.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("/bin/bash");
    const usage = readCodexExecActivity(text);
    expect(usage).toMatchObject({
      inputTokens: 90,
      outputTokens: 8,
      raw: { reasoningOutputTokens: 3, cacheWriteInputTokens: 1 },
    });
    const tool = usage?.callLog?.find((call) => call.kind === "tool");
    expect(tool).toMatchObject({
      toolName: "command_execution",
      toolCallId: "cmd-1",
    });
    expect(tool && "startedAt" in tool && tool.startedAt && tool.endedAt
      ? Date.parse(tool.endedAt) - Date.parse(tool.startedAt)
      : 0).toBe(1_000);
    expect(usage?.callLog?.some((call) => call.kind === "tool" && call.toolCallId === "cmd-2")).toBe(false);
  });

  it("does not invent tokens when the turn never completes", () => {
    const capture = createCodexExecCapture();
    capture.write(`${line({ type: "thread.started", thread_id: THREAD })}\n`);
    capture.write(`${line({ type: "turn.started" })}\n`);
    capture.write(`${line({
      type: "item.started",
      item: { id: "cmd-1", type: "command_execution", status: "in_progress" },
    })}\n`);
    capture.write(`{"type":"item.completed","item":{"id":"cmd-1","command":"${SECRET}`);
    const text = capture.text();
    expect(text).not.toContain(SECRET);
    expect(readCodexExecActivity(text)).toBeUndefined();
  });
});

describe("createCodexExecCapture failure reasons", () => {
  function captured(events: unknown[]): Array<Record<string, unknown>> {
    const capture = createCodexExecCapture({ now: () => 1 });
    capture.write(execStream(events));
    return capture.text().trim().split("\n").map((text) => JSON.parse(text));
  }

  it("keeps the message of error and turn.failed events and drops every other field", () => {
    const reason =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    expect(captured([
      {
        type: "error",
        message: reason,
        request: { prompt: "must be dropped" },
        headers: { authorization: "must be dropped" },
        body: "must be dropped",
      },
      { type: "turn.failed", error: { message: reason, codex_error_info: { body: "must be dropped" } } },
    ])).toEqual([
      { type: "error", message: reason, observedAt: 1 },
      { type: "turn.failed", error: { message: reason }, observedAt: 1 },
    ]);
  });

  it("redacts secrets before truncating a long message to 500 characters", () => {
    const [event] = captured([
      {
        type: "error",
        message: `prefix\u0000Authorization: Bearer xyz123secret ${SECRET} ${"x".repeat(5000)}`,
      },
    ]);
    const kept = event?.message as string;
    expect(kept).toContain("[REDACTED]");
    expect(kept).not.toContain("xyz123secret");
    expect(kept).not.toContain(SECRET);
    expect(kept).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(kept).toHaveLength(501);
    expect(kept.endsWith("…")).toBe(true);
  });

  it("drops a message that is not a string", () => {
    expect(captured([
      { type: "error", message: { nested: "drop me" } },
      { type: "turn.failed", error: { message: 42 } },
    ])).toEqual([
      { type: "error", observedAt: 1 },
      { type: "turn.failed", observedAt: 1 },
    ]);
  });

  it("keeps an error item's message and never adds one to other items", () => {
    const [errorItem, commandItem] = captured([
      { type: "item.completed", item: { id: "item_0", type: "error", message: "stream disconnected" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", message: "drop me", status: "completed" } },
    ]);
    expect(errorItem?.item).toEqual({ id: "item_0", type: "error", message: "stream disconnected" });
    expect(commandItem?.item).toEqual({ id: "item_1", type: "command_execution", status: "completed" });
  });

  it("leaves usage accounting unchanged when failure messages are present", () => {
    const turn = [
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 20 } },
    ];
    const plain = createCodexExecCapture({ now: () => 1 });
    plain.write(execStream([{ type: "thread.started", thread_id: THREAD }, ...turn]));
    const withFailure = createCodexExecCapture({ now: () => 1 });
    withFailure.write(execStream([
      { type: "thread.started", thread_id: THREAD },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "reconnecting" } },
      ...turn,
      { type: "error", message: "provider rejected the request" },
      { type: "turn.failed", error: { message: "provider rejected the request" } },
    ]));

    const expected = readCodexExecActivity(plain.text());
    expect(expected).toMatchObject({ inputTokens: 400, outputTokens: 20, cachedInputTokens: 100 });
    const actual = readCodexExecActivity(withFailure.text());
    expect({ ...actual, provenance: undefined }).toEqual({ ...expected, provenance: undefined });
  });
});
