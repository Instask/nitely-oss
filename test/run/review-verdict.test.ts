import { describe, expect, it } from "vitest";

import {
  blockingReviewReason,
  parseReviewGateVerdict,
} from "../../src/run/review-verdict.js";

describe("review verdict contract", () => {
  it("parses the canonical pass/fail contract and rework target", () => {
    expect(
      parseReviewGateVerdict(
        "verdict: fail\nreason: missing regression coverage\nreworkTarget: implementation\ninstructions: add the test\n",
      ),
    ).toEqual({
      verdict: "fail",
      reason: "missing regression coverage",
      reworkTarget: "implementation",
      targetArtifact: "implementation",
      instructions: "add the test",
    });
    expect(blockingReviewReason("verdict: pass\n")).toBeUndefined();
  });

  it("does not treat an unknown verdict as a pass", () => {
    expect(parseReviewGateVerdict("verdict: maybe\n")).toBeUndefined();
    expect(blockingReviewReason("verdict: maybe\n")).toBeUndefined();
  });

  it("accepts the verdict line written as a Markdown heading or in bold", () => {
    // Production run 2026-09-21T155807152Z-bcb8f783: the reviewer ended its
    // report with "## Review verdict: pass" and the gate failed on a missing
    // verdict even though the prompt asked for exactly that sentence.
    expect(parseReviewGateVerdict("# Review\n\nNo blocking findings.\n\n## Review verdict: pass\n")).toEqual({
      verdict: "pass",
    });
    expect(parseReviewGateVerdict("**Review verdict: fail**\nreason: broken contract\n")).toMatchObject({
      verdict: "fail",
      reason: "broken contract",
    });
    expect(parseReviewGateVerdict("**Review verdict:** pass\n")).toEqual({ verdict: "pass" });
    expect(blockingReviewReason("### Review verdict: pass\n")).toBeUndefined();
  });
});
