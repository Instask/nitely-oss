import { describe, expect, it } from "vitest";

import { parseJudgeResult } from "../../src/run/judge-result.js";
import { decideStagePolicy } from "../../src/policy/decide.js";

describe("judge results", () => {
  it("parses structured JSON verdicts", () => {
    expect(
      parseJudgeResult(
        JSON.stringify({
          verdict: "REWORK",
          findings: ["missing test"],
          evidence: ["test-report"],
          reworkTarget: "implementation",
          reworkInstructions: "add the regression test",
        }),
      ),
    ).toEqual({
      verdict: "REWORK",
      findings: ["missing test"],
      evidence: ["test-report"],
      reworkTarget: "implementation",
      reworkInstructions: "add the regression test",
    });
  });

  it("stops a judge after its rework budget", () => {
    expect(
      decideStagePolicy({
        stageType: "judge",
        succeeded: false,
        attempt: 3,
        maxAttempts: 5,
        maxRework: 2,
        reworkRequest: {
          targetStage: "implement",
          reason: "still incomplete",
        },
        validReworkTargets: new Set(),
        validReworkStages: new Set(["implement"]),
      }),
    ).toMatchObject({ action: "fail" });
  });
});
