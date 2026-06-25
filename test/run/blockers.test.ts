import { describe, expect, it } from "vitest";

import { classifyAgentRuntimeBlocker } from "../../src/run/blockers.js";

describe("agent runtime blocker classification", () => {
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
