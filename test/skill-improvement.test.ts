import { describe, expect, it } from "vitest";

import {
  decideSkillImprovementProposal,
  evaluateSkillImprovementApplication,
  generateSkillImprovementProposals,
  makeSkillPapercutObservation,
  markSkillImprovementApplied,
  rollbackSkillImprovementProposal,
} from "../src/skill-improvement.js";

function observation(input: Partial<Parameters<typeof makeSkillPapercutObservation>[0]> = {}) {
  return makeSkillPapercutObservation({
    id: input.id ?? "paper-1",
    repository: input.repository ?? "repo",
    flow: input.flow ?? "flow",
    stage: input.stage ?? "implement",
    skillId: input.skillId ?? "typescript",
    skillContentHash: input.skillContentHash ?? "hash-a",
    category: input.category ?? "failure",
    summary: input.summary ?? "skill missed a required check",
    evidenceRefs: input.evidenceRefs ?? [".nitely/runs/run-1/evidence.json"],
    status: input.status ?? "operator-confirmed",
    confidence: input.confidence ?? 1,
    deduplicationKey: input.deduplicationKey ?? "missing-check",
    runId: input.runId ?? "run-1",
  });
}

function generate(observations: ReturnType<typeof observation>[]) {
  return generateSkillImprovementProposals({
    observations,
    problem: "The skill omits the required check.",
    minimalDiff: "- old\n+ new",
    expectedBehavior: "The skill explicitly requires the check.",
    evalCases: [{ id: "case-1", before: "old", after: "new", source: "pinned-#429" }],
    author: "operator",
  });
}

describe("skill improvement proposals", () => {
  it("deduplicates three confirmed runs into one bounded proposal", () => {
    const proposals = generate([
      observation({ id: "paper-1", runId: "run-1" }),
      observation({ id: "paper-2", runId: "run-2", evidenceRefs: ["secret=sk-test"] }),
      observation({ id: "paper-3", runId: "run-3" }),
      observation({ id: "paper-3-duplicate", runId: "run-3" }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ occurrenceCount: 4, status: "pending-approval" });
    expect(proposals[0]?.evidenceRefs.join(" ")).not.toContain("sk-test");
  });

  it("does not merge repositories, skill versions, or inferred-only evidence", () => {
    expect(generate([
      observation({ runId: "run-1", status: "inferred" }),
      observation({ id: "paper-2", runId: "run-2", status: "inferred" }),
      observation({ id: "paper-3", runId: "run-3", repository: "other" }),
      observation({ id: "paper-4", runId: "run-4", skillContentHash: "hash-b" }),
    ])).toHaveLength(0);
  });

  it("requires approval, current source, passing coverage, and no regression", () => {
    const proposal = generate([
      observation({ runId: "run-1" }),
      observation({ id: "paper-2", runId: "run-2" }),
      observation({ id: "paper-3", runId: "run-3" }),
    ])[0]!;
    expect(evaluateSkillImprovementApplication({ proposal, currentSkillHash: "hash-a", evaluation: { passed: true, regressed: false, coverage: 1 } }).reason).toBe("not-approved");
    const accepted = decideSkillImprovementProposal({ proposal, decision: "accept", actor: "reviewer", at: "2026-01-01T00:00:00.000Z" });
    expect(evaluateSkillImprovementApplication({ proposal: accepted, currentSkillHash: "hash-old", evaluation: { passed: true, regressed: false, coverage: 1 } }).reason).toBe("stale-source-hash");
    expect(evaluateSkillImprovementApplication({ proposal: accepted, currentSkillHash: "hash-a", evaluation: { passed: true, regressed: false, coverage: 0 } }).reason).toBe("insufficient-coverage");
    expect(evaluateSkillImprovementApplication({ proposal: accepted, currentSkillHash: "hash-a", evaluation: { passed: true, regressed: true, coverage: 1 } }).reason).toBe("regression");
    expect(evaluateSkillImprovementApplication({ proposal: accepted, currentSkillHash: "hash-a", evaluation: { passed: true, regressed: false, coverage: 1 } })).toEqual({ allowed: true, reason: "ready" });
  });

  it("keeps approval, application, and rollback auditable", () => {
    const proposal = generate([
      observation({ runId: "run-1" }),
      observation({ id: "paper-2", runId: "run-2" }),
      observation({ id: "paper-3", runId: "run-3" }),
    ])[0]!;
    const accepted = decideSkillImprovementProposal({ proposal, decision: "accept", actor: "reviewer", reason: "confirmed" });
    const applied = markSkillImprovementApplied({ proposal: accepted, revision: "abc123", actor: "operator" });
    const rolledBack = rollbackSkillImprovementProposal({ proposal: applied, actor: "operator", reason: "eval regression" });
    expect(rolledBack.status).toBe("rolled-back");
    expect(rolledBack.audit.map((entry) => entry.action)).toEqual(["created", "accepted", "applied", "rolled-back"]);
  });
});
