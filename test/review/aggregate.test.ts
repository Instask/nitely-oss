import { describe, expect, it } from "vitest";

import {
  aggregateReviewPerspectives,
  renderAggregatedReviewMarkdown,
} from "../../src/review/aggregate.js";

const approved = "Review verdict: approved\nReason: no blocking findings\n";
/**
 * The vocabulary every checked-in flow prompt actually asks for, as opposed to
 * the `approved` the multi-perspective pilot flow uses.
 */
const passVerdict = "Review verdict: pass\nReason: no blocking findings\n";

function aggregate(outputs: Record<string, string>, declared?: string[]) {
  return aggregateReviewPerspectives({
    declared: declared ?? Object.keys(outputs),
    outputs: new Map(Object.entries(outputs)),
  });
}

describe("review perspective aggregation", () => {
  it("approves only when every declared perspective approves", () => {
    const decision = aggregate({
      "review-correctness": approved,
      "review-security": approved,
      "review-spec-conformance": approved,
    });

    expect(decision.status).toBe("approved");
    expect(decision.blockingPerspectives).toEqual([]);
    expect(decision.reason).toBeUndefined();
  });

  it("blocks on a single non-approving perspective and names it", () => {
    const decision = aggregate({
      "review-correctness": approved,
      "review-security":
        "Review verdict: needs_fix\nReason: unsanitized path join\nsrc/web/server.ts:42: path traversal in upload root\n",
      "review-spec-conformance": approved,
    });

    expect(decision.status).toBe("blocked");
    expect(decision.blockingPerspectives).toEqual(["review-security"]);
    expect(decision.reason).toContain("1 of 3 review perspectives blocked");
    expect(decision.reason).toContain("review-security");
    expect(decision.findings).toEqual([
      {
        file: "src/web/server.ts",
        line: 42,
        problem: "path traversal in upload root",
      },
    ]);
  });

  it("fails closed when a declared perspective produced no output", () => {
    const decision = aggregate(
      { "review-correctness": approved },
      ["review-correctness", "review-security"],
    );

    expect(decision.status).toBe("blocked");
    expect(decision.blockingPerspectives).toEqual(["review-security"]);
    expect(decision.perspectives[1]).toMatchObject({
      id: "review-security",
      status: "missing",
      reason: "produced no review output",
    });
  });

  it("fails closed when a perspective states no verdict at all", () => {
    const decision = aggregate({
      "review-correctness": approved,
      "review-security": "The implementation looks reasonable to me.\n",
    });

    expect(decision.status).toBe("blocked");
    expect(decision.perspectives[1]).toMatchObject({
      status: "blocked",
      reason: "stated no review verdict",
    });
  });

  it("demotes an approving perspective that still raised a critical finding", () => {
    const decision = aggregate({
      "review-correctness": approved,
      "review-security":
        "Review verdict: approved\n\n## P0 secret written to the run log\n",
    });

    expect(decision.status).toBe("blocked");
    expect(decision.perspectives[1]).toMatchObject({
      status: "blocked",
      verdict: "needs_fix",
    });
    expect(decision.routing?.verdict).toBe("needs_fix");
  });

  it("treats `pass` as approving, like every checked-in flow prompt asks for", () => {
    const decision = aggregate({
      "review-correctness": passVerdict,
      "review-security": passVerdict,
      "review-spec-conformance": approved,
    });

    expect(decision.status).toBe("approved");
    expect(decision.blockingPerspectives).toEqual([]);
    expect(decision.perspectives.map((perspective) => perspective.verdict))
      .toEqual(["pass", "pass", "approved"]);
  });

  it("demotes a `pass` perspective that still raised a critical finding", () => {
    const decision = aggregate({
      "review-correctness": approved,
      "review-security":
        "Review verdict: pass\n\n## P0 secret written to the run log\n",
    });

    expect(decision.status).toBe("blocked");
    expect(decision.perspectives[1]).toMatchObject({
      status: "blocked",
      verdict: "needs_fix",
    });
    expect(decision.perspectives[1]?.reason).toContain("pass with");
    expect(decision.routing?.verdict).toBe("needs_fix");
  });

  it("routes a `fail` perspective and carries its rework target", () => {
    const decision = aggregate({
      "review-correctness": passVerdict,
      "review-security":
        "Review verdict: fail\nReason: token logged\nRework target: implementation\n",
    });

    expect(decision.status).toBe("blocked");
    expect(decision.blockingPerspectives).toEqual(["review-security"]);
    expect(decision.routing).toMatchObject({
      verdict: "fail",
      reworkTarget: "implementation",
    });
    expect(decision.routing?.reason).toContain("review-security");
  });

  it("still escalates ahead of a `fail` verdict", () => {
    const decision = aggregate({
      "review-correctness": "Review verdict: fail\nReason: off-by-one\n",
      "review-security": "Review verdict: escalate\nReason: needs a human\n",
    });

    expect(decision.routing?.verdict).toBe("escalate");
  });

  it("merges and deduplicates findings across perspectives", () => {
    const shared = "src/run/run-flow.ts:10: unchecked attempt index";
    const decision = aggregate({
      "review-correctness": `Review verdict: needs_fix\n${shared}\n`,
      "review-security": `Review verdict: needs_fix\n${shared}\nsrc/scm/github.ts:7: token logged\n`,
    });

    expect(decision.findings).toEqual([
      {
        file: "src/run/run-flow.ts",
        line: 10,
        problem: "unchecked attempt index",
      },
      { file: "src/scm/github.ts", line: 7, problem: "token logged" },
    ]);
  });

  it("routes with the most severe blocking verdict and carries its target", () => {
    const decision = aggregate({
      "review-correctness": "Review verdict: needs_fix\nReason: off-by-one\n",
      "review-spec-conformance":
        "Review verdict: needs_rework_spec\nReason: requirement FR-002 is unimplementable\nTarget artifact: spec\nInstructions: restate FR-002\n",
    });

    expect(decision.routing).toMatchObject({
      verdict: "needs_rework_spec",
      targetArtifact: "spec",
      instructions: "restate FR-002",
    });
    expect(decision.routing?.reason).toContain("review-spec-conformance");
  });

  it("escalates ahead of any rework verdict", () => {
    const decision = aggregate({
      "review-correctness": "Review verdict: needs_fix\n",
      "review-security": "Review verdict: escalate\nReason: needs a human\n",
    });

    expect(decision.routing?.verdict).toBe("escalate");
  });

  it("renders a report a downstream stage and a human can both read", () => {
    const blocked = renderAggregatedReviewMarkdown(
      aggregate({
        "review-correctness": approved,
        "review-security":
          "Review verdict: needs_fix\nReason: token logged\nsrc/scm/github.ts:7: token logged\n",
      }),
    );

    expect(blocked).toContain("Review verdict: needs_fix");
    expect(blocked).toContain("- review-correctness: approved");
    expect(blocked).toContain("- review-security: blocked");
    expect(blocked).toContain("- src/scm/github.ts:7: token logged");

    const passed = renderAggregatedReviewMarkdown(
      aggregate({
        "review-correctness": approved,
        "review-security": approved,
      }),
    );

    expect(passed).toContain("Review verdict: approved");
    expect(passed).toContain("Perspectives: 2 of 2 approved");
    expect(passed).toContain("none");
  });
});
