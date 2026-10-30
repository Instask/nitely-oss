import { describe, expect, it } from "vitest";
import {
  createCodexExecCapture,
  readCodexExecActivity,
} from "../../../src/run/execution/codex-activity.js";

const capture = (events: unknown[]) => {
  const writer = createCodexExecCapture();
  for (const event of events) writer.write(`${JSON.stringify(event)}\n`);
  return writer.end();
};

describe("Codex failure-event capture", () => {
  it("keeps sanitized messages for error and turn.failed events", () => {
    const errorMessage =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    const result = capture([
      {
        type: "error",
        message: errorMessage,
        request: { prompt: "must be dropped" },
        headers: { authorization: "must be dropped" },
        body: "must be dropped",
      },
      { type: "turn.failed", error: { message: errorMessage } },
    ]);

    expect(result.stdout).toContain(
      JSON.stringify({ type: "error", message: errorMessage }),
    );
    expect(result.stdout).toContain(
      JSON.stringify({ type: "turn.failed", error: { message: errorMessage } }),
    );
    expect(result.stdout).not.toContain("must be dropped");
  });

  it("redacts secrets, collapses control characters, and truncates at 500 characters", () => {
    const secret = "Authorization: Bearer secret-token";
    const result = capture([
      {
        type: "error",
        message: `prefix\u0000${secret} [REDACTED]${"x".repeat(5000)}`,
      },
    ]);
    const kept = JSON.parse(result.stdout.trim()).message as string;

    expect(kept).toContain("[REDACTED]");
    expect(kept).not.toContain("secret-token");
    expect(kept).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(kept.length).toBe(501);
    expect(kept.endsWith("…")).toBe(true);
  });

  it("drops non-string messages and all unspecified failure-event fields", () => {
    const result = capture([
      {
        type: "error",
        message: { nested: "drop me" },
        request: "drop me",
        headers: "drop me",
        body: "drop me",
      },
    ]);

    expect(JSON.parse(result.stdout.trim())).toEqual({ type: "error" });
  });

  it("keeps an error item's identity and message but never adds message to non-error items", () => {
    const result = capture([
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "stream disconnected" },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "command_execution", message: "drop me" },
      },
    ]);
    const lines = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));

    expect(lines[0]).toEqual({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "stream disconnected" },
    });
    expect(lines[1].item).toEqual({ id: "item_1", type: "command_execution" });
  });

  it("preserves usage activity results when failure messages are present", () => {
    const withoutMessage = capture([
      { type: "thread.started", thread_id: "thread_0" },
      { type: "turn.started", turn_id: "turn_0" },
      { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } },
    ]);
    const withMessage = capture([
      { type: "thread.started", thread_id: "thread_0" },
      { type: "turn.started", turn_id: "turn_0" },
      { type: "error", message: "provider rejected the request" },
      { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } },
    ]);

    expect(readCodexExecActivity(withMessage.stdout)).toEqual(
      readCodexExecActivity(withoutMessage.stdout),
    );
  });
});
