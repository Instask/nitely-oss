import { describe, expect, it } from "vitest";

import { classifyAgentRuntimeBlocker } from "../../../src/run/blockers.js";
import { createCodexExecCapture, describeCodexFailure } from "../../../src/run/execution/codex-activity.js";
import { agentRuntimeExitMessage, createDefaultAgentRuntimeRegistry } from "../../../src/run/execution/local.js";

function stream(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** The stdout a failed attempt persists: Codex's stream through the bounded capture. */
function capturedStdout(events: unknown[]): string {
  const capture = createCodexExecCapture();
  capture.write(stream(events));
  return capture.text();
}

function codexExit(stdout: string): string {
  return agentRuntimeExitMessage({
    runtime: createDefaultAgentRuntimeRegistry().resolve("codex"),
    launchRuntime: "codex",
    exitCode: 1,
    model: "gpt-5.3-codex",
    stdout,
    stderr: "",
  });
}

function block(stdout: string) {
  return classifyAgentRuntimeBlocker({
    stageId: "implement",
    runtime: "codex",
    error: Object.assign(new Error(codexExit(stdout)), { stdout, stderr: "" }),
  });
}

describe("describeCodexFailure", () => {
  it("prefers the last turn.failed reason, then error, then error item", () => {
    const stdout = stream([
      { type: "item.completed", item: { id: "item_0", type: "error", message: "item error" } },
      { type: "error", message: "first error" },
      { type: "error", message: "last error" },
      { type: "turn.failed", error: { message: "first turn failure" } },
      { type: "turn.failed", error: { message: "last turn failure" } },
    ]);
    expect(describeCodexFailure({ stdout })).toBe("last turn failure");
    expect(describeCodexFailure({
      stdout: stream([
        { type: "item.completed", item: { id: "item_0", type: "error", message: "item error" } },
        { type: "error", message: "stream error" },
      ]),
    })).toBe("stream error");
    expect(describeCodexFailure({
      stdout: stream([{ type: "item.completed", item: { id: "item_0", type: "error", message: "item error" } }]),
    })).toBe("item error");
  });

  it("skips malformed lines", () => {
    const stdout = [
      JSON.stringify({ type: "turn.started" }),
      "{not json",
      JSON.stringify({ type: "turn.failed", error: { message: "usable" } }),
    ].join("\n");
    expect(describeCodexFailure({ stdout })).toBe("usable");
  });

  it("sanitizes a reason read from an uncompacted stream", () => {
    const reason = describeCodexFailure({
      stdout: stream([{ type: "error", message: `token=abc123secret ${"y".repeat(900)}` }]),
    });
    expect(reason).not.toContain("abc123secret");
    expect(reason).toHaveLength(501);
  });
});

describe("Codex runtime exit message and blocker", () => {
  it("names a model rejection and leaves it an ordinary failure", () => {
    const reason =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    const stdout = capturedStdout([
      { type: "thread.started", thread_id: "019bffff-1111-7111-8111-111111111111" },
      { type: "turn.started" },
      { type: "error", message: reason },
      { type: "turn.failed", error: { message: reason } },
    ]);
    expect(codexExit(stdout)).toBe(`codex exited with code 1: ${reason}`);
    expect(block(stdout)).toBeUndefined();
  });

  it("blocks on a usage limit with its retry time", () => {
    const stdout = capturedStdout([
      { type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 3:05 PM." } },
    ]);
    expect(block(stdout)).toMatchObject({
      reason: "agent_usage_limit",
      stageId: "implement",
      runtime: "codex",
      retryAfter: "3:05 PM",
    });
  });

  it("blocks on a rejected credential", () => {
    const stdout = capturedStdout([
      { type: "error", message: "401 Unauthorized: invalid access token" },
    ]);
    expect(block(stdout)).toMatchObject({ reason: "agent_credentials_invalid", runtime: "codex" });
  });

  it("keeps the bare exit message when stdout has no failure event and stderr is empty", () => {
    const stdout = capturedStdout([
      { type: "thread.started", thread_id: "019bffff-1111-7111-8111-111111111111" },
      { type: "turn.started" },
    ]);
    expect(codexExit(stdout)).toBe("codex exited with code 1");
    expect(block(stdout)).toBeUndefined();
  });
});
