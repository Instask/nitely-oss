import { describe, expect, it } from "vitest";

import { classifyAgentRuntimeBlocker } from "../../src/run/blockers.js";

describe("agent runtime blocker classification", () => {
  it("classifies invalid Claude OAuth credentials as terminal", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: Object.assign(new Error("claude exited with code 1"), {
        stderr:
          'Failed to authenticate. API Error: 401 {"type":"authentication_error","message":"OAuth access token is invalid."}',
      }),
    });

    expect(blocker).toMatchObject({
      reason: "agent_credentials_invalid",
      stageId: "implement",
      runtime: "claude",
      message: expect.stringContaining("refresh or replace the credential"),
    });
    expect(blocker?.retryAfter).toBeUndefined();
  });

  it("classifies invalid API keys without exposing a replacement credential", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "review",
      runtime: "claude",
      error: new Error("401 Unauthorized: invalid API key"),
    });

    expect(blocker).toMatchObject({
      reason: "agent_credentials_invalid",
      runtime: "claude",
    });
    expect(blocker?.message).not.toContain("sk-live-example");
  });

  it("leaves ordinary provider failures retryable", () => {
    expect(
      classifyAgentRuntimeBlocker({
        stageId: "implement",
        runtime: "claude",
        error: new Error("API Error: 500 internal server error; try again later"),
      }),
    ).toBeUndefined();
  });

  it("classifies Codex usage-limit stderr and extracts retry guidance", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "review",
      runtime: "codex",
      error: Object.assign(new Error("codex exited with code 1"), {
        stdout: "",
        stderr:
          "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 21st, 2026 12:37 AM.\n",
      }),
    });

    expect(blocker).toEqual({
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: expect.stringContaining("hit your usage limit"),
      retryAfter: "Jun 21st, 2026 12:37 AM",
    });
  });

  it("classifies Claude reset messages from plain text and JSON output", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: Object.assign(new Error("claude exited with code 1"), {
        stdout: JSON.stringify({
          is_error: true,
          result: "You've hit your limit · resets 12:50am (Asia/Singapore)",
        }),
      }),
    });

    expect(blocker).toEqual({
      reason: "agent_usage_limit",
      stageId: "implement",
      runtime: "claude",
      message: expect.stringContaining("hit your limit"),
      retryAfter: "12:50am (Asia/Singapore)",
    });
  });

  it("classifies a Claude quota envelope that exited 0 as agent_usage_limit", () => {
    const quota = "You've hit your limit · resets 12:50am (Asia/Singapore)";
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: Object.assign(new Error(`claude reported an error: ${quota}`), {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
          result: quota,
        }),
      }),
    });

    expect(blocker).toEqual({
      reason: "agent_usage_limit",
      stageId: "implement",
      runtime: "claude",
      message: expect.stringContaining("hit your limit"),
      retryAfter: "12:50am (Asia/Singapore)",
    });
  });

  it("extracts a 24-hour Claude reset time", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: new Error("You've hit your limit · resets 14:30 (UTC)"),
    });

    expect(blocker).toMatchObject({
      reason: "agent_usage_limit",
      retryAfter: "14:30 (UTC)",
    });
  });

  it("classifies the Claude session-limit variant as a usage limit with its reset time", () => {
    // Production run 2026-09-21T060310151Z-1edf17c7 was marked failed on this
    // envelope instead of blocking with a cooldown.
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "write-tests",
      runtime: "claude",
      error: Object.assign(new Error("claude exited with code 1"), {
        stdout: JSON.stringify({
          type: "result",
          is_error: true,
          api_error_status: 429,
          result: "You've hit your session limit · resets 10:20am (UTC)",
        }),
      }),
    });

    expect(blocker).toMatchObject({
      reason: "agent_usage_limit",
      retryAfter: "10:20am (UTC)",
    });
  });

  it("classifies generic quota and rate-limit output", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "mock",
      error: Object.assign(new Error("provider request failed"), {
        stderr: "Quota exceeded for this account. Please retry after 60 seconds.",
      }),
    });

    expect(blocker).toMatchObject({
      reason: "agent_usage_limit",
      stageId: "implement",
      runtime: "mock",
      retryAfter: "60 seconds",
    });
  });

  it("classifies capacity errors as usage-limit blockers", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: new Error("Provider is at capacity. Try again later."),
    });

    expect(blocker).toMatchObject({
      reason: "agent_usage_limit",
      stageId: "implement",
      runtime: "claude",
    });
  });

  it("classifies missing runtime configuration as runtime unavailable", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: new Error("agent runtime claude is not configured"),
    });

    expect(blocker).toMatchObject({
      reason: "agent_runtime_unavailable",
      stageId: "implement",
      runtime: "claude",
    });
  });

  it("classifies missing runtime commands as runtime unavailable", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "claude",
      error: Object.assign(new Error("spawn claude ENOENT"), {
        code: "ENOENT",
        stderr: "command claude was not found",
      }),
    });

    expect(blocker).toMatchObject({
      reason: "agent_runtime_unavailable",
      stageId: "implement",
      runtime: "claude",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("classifies launch failures as runtime unavailable", () => {
    const blocker = classifyAgentRuntimeBlocker({
      stageId: "review",
      runtime: "mock",
      error: new Error("unable to start agent runtime mock"),
    });

    expect(blocker).toMatchObject({
      reason: "agent_runtime_unavailable",
      stageId: "review",
      runtime: "mock",
    });
  });

  it("does not classify ordinary implementation failures", () => {
    expect(
      classifyAgentRuntimeBlocker({
        stageId: "test",
        runtime: "mock",
        error: Object.assign(new Error("tests failed"), {
          stderr: "expected true to be false",
        }),
      }),
    ).toBeUndefined();
  });
});
