import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizePiJsonResult, readPiJsonStream } from "../../../src/run/execution/pi-json.js";

const fixturePath = join(process.cwd(), "test/fixtures/pi-json/openrouter-two-calls.jsonl");

describe("readPiJsonStream", () => {
  it("sums usage and cost over every model call and keeps text mode's answer", async () => {
    const stream = await readFile(fixturePath, "utf8");
    const outcome = readPiJsonStream(stream, {
      provider: "openrouter",
      model: "qwen/qwen3-coder-next",
      observedAt: new Date("2026-10-08T09:00:00.000Z"),
    });

    expect(outcome.isJsonStream).toBe(true);
    expect(outcome.error).toBeUndefined();
    // Text blocks of the final assistant message, one per line, thinking left out.
    expect(outcome.text).toBe("Done: implemented the spec.\nTests pass.\n");
    expect(outcome.usage).toMatchObject({
      inputTokens: 9_800,
      cachedInputTokens: 4_800,
      outputTokens: 100,
      totalTokens: 9_900,
      provenance: {
        provider: "openrouter",
        model: "qwen/qwen3-coder-next-20260901",
        source: { kind: "provider-reported", reference: "pi.json.message_end.usage" },
      },
      raw: { calls: 2, uncachedInputTokens: 5_000, cacheReadInputTokens: 4_800, cacheWriteInputTokens: 0 },
    });
    expect(outcome.usage?.cost).toMatchObject({ classification: "estimated", method: "pi-model-pricing" });
    expect((outcome.usage?.cost as { usd: number }).usd).toBeCloseTo(0.000778, 9);
  });

  it("keeps the partial usage of a run cut off mid-call, without an answer", async () => {
    const stream = await readFile(fixturePath, "utf8");
    const lines = stream.split("\n");
    // Stop inside the second call: after its first update, plus half a record.
    const cut = lines.findIndex((line) => line.includes('"delta":"Done"'));
    const truncated = `${lines.slice(0, cut + 1).join("\n")}\n{"type":"message_up`;

    const outcome = readPiJsonStream(truncated);

    expect(outcome.text).toBe("");
    expect(outcome.error).toBeUndefined();
    expect(outcome.usage).toMatchObject({
      inputTokens: 4_800 + 200 + 4_800,
      outputTokens: 40 + 30,
      raw: { calls: 2 },
    });
    expect((outcome.usage?.cost as { usd: number }).usd).toBeCloseTo(0.000716, 9);
  });

  it("reports a final error message the way text mode did", () => {
    const stream = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: '402: {"message":"Insufficient credits","code":402}',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
    ].join("\n");

    expect(normalizePiJsonResult({ runtime: "openrouter", stdout: stream, stderr: "warn\n", exitCode: 0 })).toMatchObject({
      stdout: "",
      stderr: 'warn\n402: {"message":"Insufficient credits","code":402}\n',
      exitCode: 1,
      usage: { inputTokens: 0, outputTokens: 0, raw: { calls: 1 } },
    });
  });

  it("leaves output that is not a Pi JSON stream untouched", () => {
    expect(normalizePiJsonResult({ runtime: "pi", stdout: "plain answer\n", stderr: "", exitCode: 0 })).toEqual({
      stdout: "plain answer\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
