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
  it("blocks as a model rejection", () => {
    const reason =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    const stdout = capturedStdout([
      { type: "thread.started", thread_id: "019bffff-1111-7111-8111-111111111111" },
      { type: "turn.started" },
      { type: "error", message: reason },
      { type: "turn.failed", error: { message: reason } },
    ]);
    expect(codexExit(stdout)).toBe(`codex exited with code 1: ${reason}`);
    expect(block(stdout)).toMatchObject({ reason: "agent_runtime_unavailable", runtime: "codex" });
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

describe("provider error envelopes", () => {
  it("unwraps the production Codex model rejection and blocks as a model rejection", () => {
    const message =
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    const stdout = stream([
      { type: "turn.failed", error: {
        message: `  ${JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message, code: "model_not_found" },
        })}  `,
      } },
    ]);

    expect(describeCodexFailure({ stdout })).toBe(
      `model_not_found (400): ${message}`,
    );
    expect(block(stdout)).toMatchObject({ reason: "agent_runtime_unavailable", runtime: "codex" });
  });

  it("unwraps a usage-limit envelope and preserves its retry time for blocking", () => {
    const stdout = capturedStdout([
      { type: "turn.failed", error: {
        message: JSON.stringify({
          status: 429,
          error: {
            type: "usage_limit_reached",
            message: "You've hit your usage limit. Try again at 3:05 PM.",
          },
        }),
      } },
    ]);

    expect(describeCodexFailure({ stdout })).toBe(
      "usage_limit_reached (429): You've hit your usage limit. Try again at 3:05 PM.",
    );
    expect(block(stdout)).toMatchObject({
      reason: "agent_usage_limit",
      retryAfter: "3:05 PM",
    });
  });

  it("unwraps and redacts an API-key envelope while classifying credentials as invalid", () => {
    const stdout = capturedStdout([
      { type: "error", message: JSON.stringify({
        status: 401,
        error: {
          code: "invalid_api_key",
          message: "Incorrect API key provided: sk-live-example-secret",
        },
      }) },
    ]);

    const reason = describeCodexFailure({ stdout });
    expect(reason).toMatch(/^invalid_api_key \(401\): Incorrect API key provided:/);
    expect(reason).toContain("[REDACTED]");
    expect(reason).not.toContain("sk-live-example-secret");
    expect(block(stdout)).toMatchObject({ reason: "agent_credentials_invalid" });
  });

  it("formats envelopes with either code or status and omits absent labels", () => {
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        error: { code: "server_error", message: "boom" },
      }) }]),
    })).toBe("server_error: boom");
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        error: { message: "boom" },
        status: 503,
      }) }]),
    })).toBe("503: boom");
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        error: { message: "boom" },
      }) }]),
    })).toBe("boom");
  });

  it("uses a valid error type when code is invalid and drops invalid labels", () => {
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        status: 400,
        error: {
          code: "has spaces",
          type: "invalid_request_error",
          message: "bad request",
        },
      }) }]),
    })).toBe("invalid_request_error (400): bad request");
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        status: 99,
        error: { code: "has spaces", type: "also invalid", message: "bad request" },
      }) }]),
    })).toBe("bad request");
  });

  it("returns non-envelope messages unchanged apart from the existing sanitizer", () => {
    const cases = [
      "plain text",
      '{"error":',
      JSON.stringify({ error: { message: 42 } }),
      JSON.stringify({ error: { message: "" } }),
      "[1,2]",
    ];
    for (const message of cases) {
      expect(describeCodexFailure({
        stdout: stream([{ type: "error", message }]),
      })).toBe(message);
    }
    expect(describeCodexFailure({
      stdout: stream([{ type: "error", message: "plain\ntext\u0007" }]),
    })).toBe("plain\ntext");
  });

  it("keeps failure-event precedence unchanged while unwrapping the selected reason", () => {
    const stdout = stream([
      { type: "item.completed", item: { type: "error", message: JSON.stringify({
        error: { code: "item_error", message: "item" },
      }) } },
      { type: "error", message: JSON.stringify({
        error: { code: "stream_error", message: "stream" },
      }) },
      { type: "turn.failed", error: { message: JSON.stringify({
        error: { code: "turn_error", message: "turn" },
      }) } },
    ]);

    expect(describeCodexFailure({ stdout })).toBe("turn_error: turn");
  });

  it("excludes unrelated envelope fields and sanitizes the formatted result to 500 characters", () => {
    const message = `line\u0007${"x".repeat(600)}`;
    const reason = describeCodexFailure({
      stdout: stream([{ type: "error", message: JSON.stringify({
        status: 500,
        request_id: "req-secret",
        param: "model",
        headers: { authorization: "Bearer secret" },
        error: { code: "server_error", message },
      }) }]),
    });

    expect(reason).toHaveLength(501);
    expect(reason).toMatch(/^server_error \(500\): line x/);
    expect(reason).not.toContain("request_id");
    expect(reason).not.toContain("req-secret");
    expect(reason).not.toContain("authorization");
    expect(reason).not.toContain("Bearer secret");
    expect(reason).not.toContain("\u0007");
  });
});
