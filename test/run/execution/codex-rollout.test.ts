import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCodexRolloutCalls,
  CODEX_ROLLOUT_CALL_SOURCE,
  locateCodexRollout,
  toolOutputBytes,
  withCodexRolloutCalls,
} from "../../../src/run/execution/codex-rollout.js";
import { readCodexExecActivity } from "../../../src/run/execution/codex-activity.js";
import type { AgentRuntimeCall, AgentRuntimeUsage } from "../../../src/run/execution/types.js";
import {
  CONTENT_MARKER,
  outputOf,
  PATH_MARKER,
  ROLLOUT_THREAD,
  RolloutBuilder,
  type Usage,
} from "../../fixtures/codex-rollout.js";

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "nitely-codex-rollout-"));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

/** The usage `codex exec --json` reports for a thread whose running total is `total`. */
function execUsage(total: Usage, threadId = ROLLOUT_THREAD): AgentRuntimeUsage {
  const usage = readCodexExecActivity([
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
      },
    }),
  ].join("\n"));
  if (!usage) throw new Error("fixture exec stream did not parse");
  return usage;
}

function llm(calls: AgentRuntimeCall[] | undefined) {
  return (calls ?? []).filter((call) => call.kind === "llm");
}

function tools(calls: AgentRuntimeCall[] | undefined) {
  return (calls ?? []).filter((call) => call.kind === "tool");
}

describe("codex rollout per-call records", () => {
  it("replaces the turn record with one delta record per model call and sizes each tool output", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const rollout = new RolloutBuilder(startedAt + 5)
      .meta()
      .turn()
      .reasoning()
      .call({ input: 15_000, cached: 3_000, output: 120 }, { nullInfo: true })
      .tool("call_read_1", outputOf(36_000))
      .call({ input: 24_000, cached: 14_900, output: 90, reasoning: 40 }, { repeat: true })
      .tool("call_read_2", [
        { type: "input_text", text: outputOf(1_000) },
        { type: "input_text", text: outputOf(24) },
      ], { custom: false, name: "shell" })
      .call({ input: 24_300, cached: 24_000, output: 60 })
      .tool("call_patch", { content: outputOf(10), success: false }, { name: "apply_patch" })
      .call({ input: 24_400, cached: 24_300, output: 300 });
    await rollout.write(codexHome);

    const usage = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), {
      codexHome,
      attemptStartedAtMs: startedAt,
    });

    const calls = usage?.callLog;
    expect(usage?.callLogSource).toBe(CODEX_ROLLOUT_CALL_SOURCE);
    expect(usage?.callLogFallback).toBeUndefined();
    expect(llm(calls)).toHaveLength(4);
    expect(llm(calls).map((call) => call.inputTokens)).toEqual([15_000, 24_000, 24_300, 24_400]);
    for (const call of llm(calls)) {
      expect(call).toMatchObject({ granularity: "call", accounting: "delta", provider: "openai", model: "gpt-5.5-codex" });
    }
    expect(llm(calls)[1]).toMatchObject({ cacheReadInputTokens: 14_900, reasoningOutputTokens: 40 });
    // Per-call records add up to the authoritative turn.completed total.
    const sum = llm(calls).reduce((total, call) => total + call.inputTokens, 0);
    expect(sum).toBe(usage?.inputTokens);
    expect(tools(calls).map((call) => [call.toolName, call.outputBytes, call.isError ?? false])).toEqual([
      ["exec", 36_000, false],
      ["shell", 1_024, false],
      ["apply_patch", 10, true],
    ]);
    // Order is the rollout's: each tool sits between the calls around it.
    expect(calls?.map((call) => call.kind)).toEqual(["llm", "tool", "llm", "tool", "llm", "tool", "llm"]);
    const firstTool = tools(calls)[0];
    expect(Date.parse(firstTool?.endedAt ?? "") - Date.parse(firstTool?.startedAt ?? "")).toBe(200);
    const second = llm(calls)[1];
    expect(Date.parse(second?.startedAt ?? "")).toBe(Date.parse(firstTool?.endedAt ?? ""));
    expect(usage?.raw).toMatchObject({
      threadId: ROLLOUT_THREAD,
      calls: 4,
      toolOutputs: 3,
      usageGranularity: "call",
      usageAccounting: "delta",
      callSource: CODEX_ROLLOUT_CALL_SOURCE,
    });
    // The attempt total is untouched.
    expect(usage).toMatchObject({ inputTokens: rollout.runningTotal.input, outputTokens: rollout.runningTotal.output });
  });

  it("copies no prompt, reasoning, tool input, tool output, or path into the records", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const rollout = new RolloutBuilder(startedAt + 5)
      .meta()
      .turn()
      .reasoning()
      .call({ input: 9_000, cached: 0, output: 10 })
      .tool("call_1", outputOf(5_000))
      .tool("call_2", [{ type: "input_image", image_url: `data:image/png;base64,${CONTENT_MARKER}` }], { custom: false })
      .compacted()
      .call({ input: 9_500, cached: 9_000, output: 10 });
    await rollout.write(codexHome);

    const usage = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), {
      codexHome,
      attemptStartedAtMs: startedAt,
    });

    expect(llm(usage?.callLog)).toHaveLength(2);
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain(CONTENT_MARKER);
    expect(serialized).not.toContain("SEEDED");
    expect(serialized).not.toContain(PATH_MARKER);
    expect(serialized).not.toContain(codexHome);
    expect(serialized).not.toContain("sessions");
    for (const call of usage?.callLog ?? []) {
      const allowed = call.kind === "llm"
        ? ["kind", "granularity", "accounting", "provider", "model", "startedAt", "endedAt", "inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"]
        : ["kind", "toolName", "toolCallId", "startedAt", "endedAt", "isError", "outputBytes", "outputBytesEstimated"];
      expect(Object.keys(call).filter((key) => !allowed.includes(key))).toEqual([]);
    }
  });

  it("counts only the calls a resumed attempt appended to the thread's rollout", async () => {
    const firstStart = Date.parse("2026-10-19T07:00:00.000Z");
    const rollout = new RolloutBuilder(firstStart + 5)
      .meta()
      .turn()
      .call({ input: 10_000, cached: 0, output: 50 })
      .tool("call_old", outputOf(20_000))
      .call({ input: 15_000, cached: 10_000, output: 70 });
    const previousTotal = rollout.runningTotal;
    const resumedAt = rollout.now + 60_000;
    // codex exec resume appends a new task to the same file; the running total continues.
    rollout
      .advanceTo(resumedAt)
      .turn()
      .call({ input: 16_000, cached: 15_000, output: 30 })
      .tool("call_new", outputOf(300))
      .call({ input: 16_400, cached: 16_000, output: 20 });
    await rollout.write(codexHome);

    const cumulative = execUsage(rollout.runningTotal);
    const usage = await applyCodexRolloutCalls(cumulative, { codexHome, attemptStartedAtMs: resumedAt });

    expect(usage?.callLogSource).toBe(CODEX_ROLLOUT_CALL_SOURCE);
    expect(llm(usage?.callLog).map((call) => call.inputTokens)).toEqual([16_000, 16_400]);
    expect(tools(usage?.callLog).map((call) => call.toolCallId)).toEqual(["call_new"]);
    // The usage total stays the thread's cumulative snapshot; projection
    // subtracts the earlier attempt by thread id.
    expect(usage?.inputTokens).toBe(previousTotal.input + 32_400);
  });

  it("keeps the turn record and says why when the rollout is missing", async () => {
    const original = execUsage({ input: 1_000, cached: 0, output: 10 });
    const usage = await applyCodexRolloutCalls(original, { codexHome, attemptStartedAtMs: 0 });
    expect(usage?.callLog).toEqual(original.callLog);
    expect(llm(usage?.callLog)[0]?.granularity).toBe("turn");
    expect(usage?.callLogSource).toBe("codex.exec.json");
    expect(usage?.callLogFallback?.reason).toBe("missing");
    expect(usage?.raw).toMatchObject({ rolloutFallback: "missing" });
    expect(JSON.stringify(usage)).not.toContain(codexHome);
  });

  it("explains a missing CODEX_HOME, a mismatched thread, and a mismatched total", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const noHome = await applyCodexRolloutCalls(execUsage({ input: 1, cached: 0, output: 1 }), {
      unavailableReason: "not passed through",
      attemptStartedAtMs: startedAt,
    });
    expect(noHome?.callLogFallback).toEqual({ reason: "no-codex-home", detail: "not passed through" });

    const other = new RolloutBuilder(startedAt + 5).meta("019bffff-3333-7333-8333-333333333333").turn()
      .call({ input: 100, cached: 0, output: 1 });
    // A file named for the thread whose session_meta says otherwise.
    const misnamed = join(codexHome, "sessions", "2026", "10", "19");
    await mkdir(misnamed, { recursive: true });
    await writeFile(join(misnamed, `rollout-2026-10-19T07-30-24-${ROLLOUT_THREAD}.jsonl`), other.text());
    const mismatch = await applyCodexRolloutCalls(execUsage(other.runningTotal), { codexHome, attemptStartedAtMs: startedAt });
    expect(mismatch?.callLogFallback?.reason).toBe("thread-mismatch");

    const rollout = new RolloutBuilder(startedAt + 5).meta().turn().call({ input: 100, cached: 0, output: 1 });
    await rollout.write(codexHome);
    const total = await applyCodexRolloutCalls(execUsage({ input: 999, cached: 0, output: 1 }), { codexHome, attemptStartedAtMs: startedAt });
    expect(total?.callLogFallback?.reason).toBe("total-mismatch");
    expect(llm(total?.callLog)[0]?.granularity).toBe("turn");

    const late = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), {
      codexHome,
      attemptStartedAtMs: startedAt + 3_600_000,
    });
    expect(late?.callLogFallback?.reason).toBe("no-calls");
  });

  it("falls back and flags a rollout whose calls do not add up to the attempt", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const rollout = new RolloutBuilder(startedAt + 5).meta().turn().call({ input: 100, cached: 0, output: 1 });
    // A token_count whose last_token_usage disagrees with its running total.
    rollout.raw(JSON.stringify({
      timestamp: new Date(startedAt + 10_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 2 },
          last_token_usage: { input_tokens: 150, cached_input_tokens: 0, output_tokens: 1 },
        },
      },
    }));
    await rollout.write(codexHome);
    const usage = await applyCodexRolloutCalls(execUsage({ input: 300, cached: 0, output: 2 }), {
      codexHome,
      attemptStartedAtMs: startedAt,
    });
    expect(usage?.callLogFallback?.reason).toBe("sum-mismatch");
    expect(usage?.callLogFallback?.detail).toContain("add up to input 250");
    expect(llm(usage?.callLog)).toHaveLength(1);
    expect(llm(usage?.callLog)[0]?.granularity).toBe("turn");
  });

  it("measures a tool output line too long to buffer without parsing it", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const big = outputOf(5 * 1024 * 1024);
    const rollout = new RolloutBuilder(startedAt + 5)
      .meta()
      .turn()
      .call({ input: 100, cached: 0, output: 1 })
      .tool("call_big", big)
      .call({ input: 2_000_000, cached: 100, output: 1 });
    await rollout.write(codexHome);
    const usage = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), { codexHome, attemptStartedAtMs: startedAt });
    const tool = tools(usage?.callLog)[0];
    expect(tool).toMatchObject({ toolName: "exec", toolCallId: "call_big", outputBytesEstimated: true });
    expect(tool?.outputBytes).toBeGreaterThanOrEqual(big.length);
    expect(tool?.outputBytes).toBeLessThan(big.length + 1_024);
  });

  it("refuses a rollout path that is a symlink and a rollout over the size limit", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const rollout = new RolloutBuilder(startedAt + 5).meta().turn().call({ input: 100, cached: 0, output: 1 });
    const target = join(codexHome, "elsewhere.jsonl");
    await writeFile(target, rollout.text());
    const directory = join(codexHome, "sessions", "2026", "10", "19");
    await mkdir(directory, { recursive: true });
    await symlink(target, join(directory, `rollout-2026-10-19T07-30-24-${ROLLOUT_THREAD}.jsonl`));
    const linked = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), { codexHome, attemptStartedAtMs: startedAt });
    expect(linked?.callLogFallback?.reason).toBe("unreadable");

    await rm(join(codexHome, "sessions"), { recursive: true });
    await rollout.write(codexHome);
    const large = await applyCodexRolloutCalls(execUsage(rollout.runningTotal), {
      codexHome,
      attemptStartedAtMs: startedAt,
      maxFileBytes: 64,
    });
    expect(large?.callLogFallback?.reason).toBe("too-large");
  });

  it("enriches the partial usage a failed attempt carries and rethrows its error", async () => {
    const startedAt = Date.parse("2026-10-19T07:30:24.000Z");
    const rollout = new RolloutBuilder(startedAt + 5).meta().turn().call({ input: 100, cached: 0, output: 1 });
    await rollout.write(codexHome);
    const failure = Object.assign(new Error("codex exited 1"), { usage: execUsage(rollout.runningTotal) });
    await expect(
      withCodexRolloutCalls(Promise.reject(failure), { codexHome, attemptStartedAtMs: startedAt }),
    ).rejects.toBe(failure);
    expect(failure.usage.callLogSource).toBe(CODEX_ROLLOUT_CALL_SOURCE);
  });

  it("leaves non-Codex usage alone", async () => {
    const usage: AgentRuntimeUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    expect(await applyCodexRolloutCalls(usage, { codexHome, attemptStartedAtMs: 0 })).toBe(usage);
  });

  it("locates a rollout by thread id only, newest day first", async () => {
    await new RolloutBuilder(0).meta().write(codexHome, "2026/10/18");
    expect(await locateCodexRollout(codexHome, ROLLOUT_THREAD)).toContain(join("2026", "10", "18"));
    expect(await locateCodexRollout(codexHome, "../../etc/passwd")).toBeUndefined();
  });

  it("sizes tool outputs by the bytes the model reads", () => {
    expect(toolOutputBytes("héllo")).toBe(6);
    expect(toolOutputBytes([{ type: "input_text", text: "abc" }, { type: "input_image", image_url: "data:x" }])).toBe(9);
    expect(toolOutputBytes({ content: "abcd", success: true })).toBe(4);
    expect(toolOutputBytes(undefined)).toBe(0);
  });
});
