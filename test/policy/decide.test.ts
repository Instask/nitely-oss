import { describe, expect, it } from "vitest";

import { decideStagePolicy } from "../../src/policy/decide.js";

describe("decideStagePolicy", () => {
  it("completes a successful stage result", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: true,
        attempt: 1,
        maxAttempts: 2,
        validReworkTargets: new Set(),
      }),
    ).toEqual({
      action: "complete",
      reason: "command completed on attempt 1",
    });
  });

  it("escalates deterministically when escalation is requested", () => {
    expect(
      decideStagePolicy({
        stageType: "gate",
        succeeded: false,
        attempt: 1,
        maxAttempts: 3,
        error: "needs human review",
        recommendation: {
          action: "escalate",
          reason: "manual approval required",
        },
        validReworkTargets: new Set(),
      }),
    ).toEqual({
      action: "escalate",
      reason: "manual approval required",
    });
  });

  it("retries failed agent and command stages while attempts remain", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 2,
        error: "exit 1",
        validReworkTargets: new Set(),
      }),
    ).toEqual({
      action: "retry",
      reason: "command failed on attempt 1 of 2: exit 1",
    });
  });

  it("fails when retryable stage attempts are exhausted", () => {
    expect(
      decideStagePolicy({
        stageType: "agent",
        succeeded: false,
        attempt: 2,
        maxAttempts: 2,
        error: "agent failed",
        validReworkTargets: new Set(),
      }),
    ).toEqual({
      action: "fail",
      reason: "agent failed after 2 of 2 attempts: agent failed",
    });
  });

  it("fails invalid rework targets deterministically", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 2,
        error: "missing implementation",
        reworkTarget: "unknown-artifact",
        validReworkTargets: new Set(["implementation"]),
      }),
    ).toEqual({
      action: "fail",
      reason: "invalid rework target: unknown-artifact",
    });
  });

  it("returns rework for valid upstream artifact targets", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 2,
        error: "tests failed",
        reworkTarget: "implementation",
        validReworkTargets: new Set(["implementation"]),
      }),
    ).toEqual({
      action: "rework",
      targetArtifact: "implementation",
      reason: "rework requested for implementation after attempt 1: tests failed",
    });
  });

  it("fails valid rework requests after attempts are exhausted", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 2,
        maxAttempts: 2,
        error: "tests failed",
        reworkTarget: "implementation",
        validReworkTargets: new Set(["implementation"]),
      }),
    ).toEqual({
      action: "fail",
      reason: "command failed after 2 of 2 attempts: tests failed",
    });
  });
});
