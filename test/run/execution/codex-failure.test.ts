import { describe, expect, it } from "vitest";
import { describeCodexFailure } from "../../../src/run/execution/codex-activity.js";
import { agentRuntimeExitMessage } from "../../../src/run/execution/local.js";
import { classifyAgentRuntimeBlocker } from "../../../src/run/blockers.js";

describe("Codex failure descriptions", () => {
  it("prefers the last turn.failed reason, then error, then error item", () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "first error" }),
      JSON.stringify({ type: "error", message: "last error" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "item error" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "first turn failure" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "last turn failure" },
      }),
    ].join("\n");

    expect(describeCodexFailure({ stdout, stderr: "" })).toBe(
      "last turn failure",
    );
  });

  it("skips malformed lines and returns undefined when no failure event exists", () => {
    expect(
      describeCodexFailure({
        stdout: [
          JSON.stringify({ type: "thread.started" }),
          "not json",
          JSON.stringify({ type: "turn.failed", error: { message: "usable" } }),
        ].join("\n"),
        stderr: "",
      }),
    ).toBe("usable");

    expect(
      describeCodexFailure({
        stdout: JSON.stringify({ type: "turn.started" }),
        stderr: "",
      }),
    ).toBeUndefined();
  });

  it("does not use stderr as a failure reason", () => {
    expect(
      describeCodexFailure({ stdout: "", stderr: "provider secret" }),
    ).toBeUndefined();
  });
});

describe("Codex runtime failure messages", () => {
  const exit = (stdout: string) =>
    agentRuntimeExitMessage({
      runtime: "codex",
      exitCode: 1,
      stdout,
      stderr: "",
    });

  it("includes a model rejection reason and remains an ordinary failure", () => {
    const reason =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    const message = exit(
      JSON.stringify({ type: "error", message: reason }) + "\n",
    );

    expect(message).toBe(`codex exited with code 1: ${reason}`);
    expect(classifyAgentRuntimeBlocker(message)).toBeUndefined();
  });

  it("classifies usage-limit failures and extracts the retry time", () => {
    const message = exit(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit. Try again at 3:05 PM." },
      }),
    );

    expect(classifyAgentRuntimeBlocker(message)).toMatchObject({
      reason: "agent_usage_limit",
      retryAfter: "3:05 PM",
    });
  });

  it("classifies invalid credential failures", () => {
    const message = exit(
      JSON.stringify({
        type: "error",
        message: "401 Unauthorized: invalid access token",
      }),
    );

    expect(classifyAgentRuntimeBlocker(message)).toMatchObject({
      reason: "agent_credentials_invalid",
    });
  });

  it("does not append a reason when stdout has no failure event", () => {
    expect(
      exit(
        [
          JSON.stringify({ type: "thread.started" }),
          JSON.stringify({ type: "turn.started" }),
        ].join("\n"),
      ),
    ).toBe("codex exited with code 1");
  });
});
