import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../src/events/store.js";
import { validateSkillDirectory } from "../src/skills/load.js";
import {
  confirmSkillPapercut,
  decideStoredSkillImprovementProposal,
  evaluateStoredSkillImprovementProposal,
  parseSkillPapercutSignals,
  recordAcceptedReviewFeedbackSkillPapercuts,
  recordReflectionSkillPapercuts,
  reconcileSkillImprovementProposals,
  skillImprovementStorePath,
  SkillImprovementStore,
} from "../src/skill-improvement/runtime.js";

async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "nitely-skill-improvement-"));
  await mkdir(join(path, ".nitely"), { recursive: true });
  await mkdir(join(path, ".nitely", "skills", "typescript"), { recursive: true });
  await writeFile(
    join(path, ".nitely", "skills", "typescript", "SKILL.md"),
    "---\nname: typescript\ndescription: Keep TypeScript changes verified\n---\nRun the checks.\n",
    "utf8",
  );
  return path;
}

async function loadedSkillEvent(store: EventStore, runId: string, repoPath: string): Promise<void> {
  const skill = await validateSkillDirectory({
    skillDirectory: join(repoPath, ".nitely", "skills", "typescript"),
    skillId: "typescript",
    stageId: "implement",
  });
  store.append({
    runId,
    type: "run.created",
    payload: { flowName: "flow" },
  });
  store.append({
    runId,
    stageId: "implement",
    type: "stage.skills.loaded",
    payload: { skills: [{ id: "typescript", contentHash: skill.contentHash }] },
  });
}

describe("skill improvement runtime", () => {
  it("parses reflection signals and persists them against the loaded skill snapshot", async () => {
    const repoPath = await repo();
    const events = new EventStore(join(repoPath, ".nitely", "events.db"));
    await loadedSkillEvent(events, "run-reflect", repoPath);
    expect(parseSkillPapercutSignals("```skill-papercut\n[{\"stage\":\"implement\",\"skillId\":\"typescript\",\"category\":\"failure\",\"summary\":\"missed check\",\"deduplicationKey\":\"missing-check\"}]\n```" )).toHaveLength(1);
    const observations = await recordReflectionSkillPapercuts({
      repoPath,
      repository: repoPath,
      flow: "flow",
      runId: "run-reflect",
      stage: "reflect",
      signals: [{
        stage: "implement",
        skillId: "typescript",
        category: "failure",
        summary: "missed check",
        deduplicationKey: "missing-check",
      }],
      eventStore: events,
    });
    events.close();
    expect(observations[0]).toMatchObject({ status: "inferred", skillId: "typescript" });
    const store = new SkillImprovementStore(skillImprovementStorePath(repoPath));
    expect(store.listObservations()).toHaveLength(1);
    store.close();
  });

  it("records accepted feedback as confirmed evidence and audits decisions", async () => {
    const repoPath = await repo();
    const events = new EventStore(join(repoPath, ".nitely", "events.db"));
    await loadedSkillEvent(events, "run-feedback", repoPath);
    const observations = await recordAcceptedReviewFeedbackSkillPapercuts({
      repoPath,
      runId: "run-feedback",
      repository: repoPath,
      feedback: "Always run the type check.",
      evidenceRef: "https://github.com/example/review/1#comment",
      eventStore: events,
    });
    events.close();
    expect(observations[0]?.status).toBe("inferred");
    const store = new SkillImprovementStore(skillImprovementStorePath(repoPath));
    const confirmed = await confirmSkillPapercut({ repoPath, id: observations[0]!.id, actor: "operator" });
    expect(confirmed.status).toBe("operator-confirmed");
    store.close();
  });

  it("uses #429 lineage coverage and keeps weak proposals insufficient", async () => {
    const repoPath = await repo();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      const events = new EventStore(join(repoPath, ".nitely", `events-${runId}.db`));
      await loadedSkillEvent(events, runId, repoPath);
      await recordReflectionSkillPapercuts({
        repoPath,
        repository: repoPath,
        flow: "flow",
        runId,
        stage: "reflect",
        signals: [{ stage: "implement", skillId: "typescript", category: "failure", summary: "missed check", deduplicationKey: "missing-check" }],
        eventStore: events,
      });
      events.close();
      const store = new SkillImprovementStore(skillImprovementStorePath(repoPath));
      store.updateObservationStatus(store.listObservations().find((observation) => observation.runId === runId)!.id, "operator-confirmed");
      store.close();
    }
    const [proposal] = await reconcileSkillImprovementProposals({
      repoPath,
      author: "operator",
      problem: "The skill missed a required check.",
      minimalDiff: "Add the required check.",
      expectedBehavior: "The check is always run.",
      evalCases: [{ id: "case-1", before: "old", after: "new", source: "pinned-#429" }],
    });
    expect(proposal?.status).toBe("pending-approval");
    const accepted = await decideStoredSkillImprovementProposal({ repoPath, proposalId: proposal!.id, decision: "accept", actor: "operator" });
    const result = await evaluateStoredSkillImprovementProposal({
      repoPath,
      proposalId: accepted.id,
      report: {
        schemaVersion: "nitely.eval-report.v1",
        generatedAt: "2026-09-19T00:00:00.000Z",
        status: "passed",
        baselineManifestSha256: "base",
        candidateManifestSha256: "candidate",
        runLineage: { baseline: [], candidate: [] },
        baseline: {} as never,
        candidate: {} as never,
        comparisons: [],
        regressions: [],
        coverage: {} as never,
      },
    });
    expect(result.decision.reason).toBe("insufficient-coverage");
    expect(result.proposal.status).toBe("insufficient_evidence");
  });

  it("reopens a weak proposal when pinned #429 cases are supplied", async () => {
    const repoPath = await repo();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      const events = new EventStore(join(repoPath, ".nitely", `events-${runId}.db`));
      await loadedSkillEvent(events, runId, repoPath);
      await recordReflectionSkillPapercuts({
        repoPath,
        repository: repoPath,
        flow: "flow",
        runId,
        stage: "reflect",
        signals: [{ stage: "implement", skillId: "typescript", category: "failure", summary: "missed check", deduplicationKey: "missing-check" }],
        eventStore: events,
      });
      events.close();
      const store = new SkillImprovementStore(skillImprovementStorePath(repoPath));
      store.updateObservationStatus(store.listObservations().find((observation) => observation.runId === runId)!.id, "operator-confirmed");
      store.close();
    }
    const initial = await reconcileSkillImprovementProposals({
      repoPath,
      author: "operator",
      problem: "The skill missed a required check.",
      minimalDiff: "Add the required check.",
      expectedBehavior: "The check is always run.",
    });
    expect(initial[0]?.status).toBe("insufficient_evidence");
    const reopened = await reconcileSkillImprovementProposals({
      repoPath,
      author: "operator",
      problem: "The skill missed a required check.",
      minimalDiff: "Add the required check.",
      expectedBehavior: "The check is always run.",
      evalCases: [{ id: "case-1", before: "old", after: "new", source: "pinned-#429" }],
    });
    expect(reopened[0]).toMatchObject({ status: "pending-approval", evalCases: [{ id: "case-1" }] });
  });
});
