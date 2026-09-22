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
        reworkRequest: {
          targetStage: "unknown-stage",
          targetArtifact: "unknown-artifact",
          reason: "missing implementation",
        },
        validReworkTargets: new Set(["implementation"]),
        validReworkStages: new Set(["implement"]),
      }),
    ).toEqual({
      action: "fail",
      reason: "invalid rework target: unknown-artifact",
    });
  });

  it("fails invalid rework target stages deterministically", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 2,
        error: "missing implementation",
        reworkRequest: {
          targetStage: "publish",
          reason: "verification cannot repair this downstream stage",
        },
        validReworkTargets: new Set(["implementation"]),
        validReworkStages: new Set(["verify", "implement"]),
      }),
    ).toEqual({
      action: "fail",
      reason: "invalid rework target stage: publish",
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
        reworkRequest: {
          targetStage: "implement",
          targetArtifact: "implementation",
          reason: "verification failed",
          instructions: "Repair the implementation.",
          context: "grep fixed feature.txt failed",
          specificIssues: [{ file: "feature.txt", line: 1, problem: "missing fixed" }],
          sourceStage: "test",
          sourceAttempt: 1,
        },
        validReworkTargets: new Set(["implementation"]),
        validReworkStages: new Set(["implement", "test"]),
      }),
    ).toEqual({
      action: "rework",
      targetStage: "implement",
      targetArtifact: "implementation",
      reason: "verification failed",
      reworkRequest: {
        targetStage: "implement",
        targetArtifact: "implementation",
        reason: "verification failed",
        instructions: "Repair the implementation.",
        context: "grep fixed feature.txt failed",
        specificIssues: [{ file: "feature.txt", line: 1, problem: "missing fixed" }],
        sourceStage: "test",
        sourceAttempt: 1,
      },
    });
  });

  it("still reworks after a single prior matching edge", () => {
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 12,
        error: "tests failed",
        reworkRequest: {
          targetStage: "implement",
          targetArtifact: "implementation",
          reason: "verification failed",
        },
        validReworkTargets: new Set(["implementation"]),
        validReworkStages: new Set(["implement", "test"]),
        sourceStage: "test",
        reworkEdges: [{ from: "test", to: "implement" }],
      }),
    ).toMatchObject({
      action: "rework",
      targetStage: "implement",
    });
  });

  it("fails closed when the same rework edge repeats three times", () => {
    const edge = { from: "test", to: "implement" };
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 12,
        error: "tests failed",
        reworkRequest: {
          targetStage: "implement",
          targetArtifact: "implementation",
          reason: "verification failed",
        },
        validReworkTargets: new Set(["implementation"]),
        validReworkStages: new Set(["implement", "test"]),
        sourceStage: "test",
        sourceAttempt: 3,
        reworkEdges: [edge, edge],
      }),
    ).toEqual({
      action: "fail",
      reason:
        "rework oscillation: test→implement repeated 3 times in window 3",
      oscillation: {
        from: "test",
        to: "implement",
        count: 3,
        window: 3,
        edges: [edge, edge, edge],
      },
    });
  });

  it("fails closed on two A↔B ping-pong cycles before another rework", () => {
    const ab = { from: "A", to: "B" };
    const ba = { from: "B", to: "A" };
    expect(
      decideStagePolicy({
        stageType: "command",
        succeeded: false,
        attempt: 1,
        maxAttempts: 12,
        error: "looped",
        reworkRequest: {
          targetStage: "A",
          reason: "send back",
        },
        validReworkTargets: new Set(),
        validReworkStages: new Set(["A", "B"]),
        sourceStage: "B",
        reworkEdges: [ab, ba, ab],
      }),
    ).toMatchObject({
      action: "fail",
      reason: "rework oscillation: B↔A ping-pong 2 cycles in window 4",
      oscillation: {
        from: "B",
        to: "A",
        count: 2,
        window: 4,
      },
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
