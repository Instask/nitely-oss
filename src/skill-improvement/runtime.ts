import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../context/redaction.js";
import type { EvalCohortReport } from "../eval/report.js";
import {
  SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT,
  SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_TYPE,
} from "../artifacts/types.js";
import { EventStore } from "../events/store.js";
import type { StoredRunEvent } from "../events/types.js";
import { validateSkillDirectory } from "../skills/load.js";
import {
  decideSkillImprovementProposal,
  evaluateSkillImprovementApplication,
  generateSkillImprovementProposals,
  makeSkillPapercutObservation,
  type SkillImprovementEvalCase,
  type SkillImprovementProposal,
  type SkillPapercutObservation,
} from "../skill-improvement.js";

export interface SkillSnapshot {
  id: string;
  contentHash: string;
}

export interface SkillPapercutSignal {
  stage: string;
  skillId?: string;
  category: SkillPapercutObservation["category"];
  summary: string;
  deduplicationKey: string;
  evidenceRefs?: string[];
}

export function parseSkillPapercutSignals(markdown: string): SkillPapercutSignal[] {
  const signals: SkillPapercutSignal[] = [];
  for (const block of markdown.matchAll(/```skill-papercut\s*([\s\S]*?)```/gi)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : recordFromUnknown(parsed).entries;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const record = recordFromUnknown(raw);
      const stage = stringValue(record.stage);
      const summary = stringValue(record.summary);
      const deduplicationKey = stringValue(record.deduplicationKey);
      const category = stringValue(record.category);
      if (
        !stage || !summary || !deduplicationKey ||
        (category !== "failure" && category !== "rework" && category !== "reviewer-feedback")
      ) continue;
      const evidenceRefs = Array.isArray(record.evidenceRefs)
        ? record.evidenceRefs.filter((value): value is string => typeof value === "string")
        : undefined;
      signals.push({
        stage,
        ...(stringValue(record.skillId) ? { skillId: stringValue(record.skillId) } : {}),
        category,
        summary,
        deduplicationKey,
        ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
      });
    }
  }
  return signals;
}

export interface RecordSkillPapercutsInput {
  repoPath: string;
  repository: string;
  flow: string;
  runId: string;
  status: SkillPapercutObservation["status"];
  signals: readonly SkillPapercutSignal[];
  skills: readonly (SkillSnapshot & { stage: string })[];
  eventStore?: EventStore;
}

interface StoredSuppression {
  proposalId: string;
  actor: string;
  reason: string;
  at: string;
}

interface SkillImprovementRow {
  id: string;
  payload_json: string;
}

function observationId(input: {
  repository: string;
  flow: string;
  runId: string;
  stage: string;
  skillId: string;
  skillContentHash: string;
  deduplicationKey: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24);
  return `skill-papercut-${digest}`;
}

export function skillImprovementStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "skill-improvements.db");
}

export class SkillImprovementStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS skill_papercuts (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_improvement_proposals (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_improvement_suppressions (
        proposal_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT;
    `);
  }

  saveObservation(observation: SkillPapercutObservation): void {
    this.#database.prepare(`
      INSERT INTO skill_papercuts (id, payload_json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(observation.id, JSON.stringify(observation));
  }

  listObservations(): SkillPapercutObservation[] {
    const rows = this.#database.prepare(
      "SELECT id, payload_json FROM skill_papercuts ORDER BY id",
    ).all() as unknown as SkillImprovementRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as SkillPapercutObservation);
  }

  updateObservationStatus(
    id: string,
    status: SkillPapercutObservation["status"],
  ): SkillPapercutObservation {
    const observation = this.listObservations().find((candidate) => candidate.id === id);
    if (!observation) throw new Error(`skill papercut not found: ${id}`);
    const updated = { ...observation, status };
    this.saveObservation(updated);
    return updated;
  }

  saveProposal(proposal: SkillImprovementProposal): void {
    this.#database.prepare(`
      INSERT INTO skill_improvement_proposals (id, payload_json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(proposal.id, JSON.stringify(proposal));
  }

  listProposals(): SkillImprovementProposal[] {
    const rows = this.#database.prepare(
      "SELECT id, payload_json FROM skill_improvement_proposals ORDER BY id",
    ).all() as unknown as SkillImprovementRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as SkillImprovementProposal);
  }

  getProposal(id: string): SkillImprovementProposal | undefined {
    return this.listProposals().find((proposal) => proposal.id === id);
  }

  saveSuppression(suppression: StoredSuppression): void {
    this.#database.prepare(`
      INSERT INTO skill_improvement_suppressions (proposal_id, actor, reason, at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET actor = excluded.actor, reason = excluded.reason, at = excluded.at
    `).run(
      suppression.proposalId,
      suppression.actor,
      suppression.reason,
      suppression.at,
    );
  }

  close(): void {
    this.#database.close();
  }
}

async function openStore(repoPath: string): Promise<SkillImprovementStore> {
  const path = skillImprovementStorePath(repoPath);
  await mkdir(dirname(path), { recursive: true });
  return new SkillImprovementStore(path);
}

function appendSkillEvent(
  eventStore: EventStore | undefined,
  event: Parameters<EventStore["append"]>[0],
): void {
  eventStore?.append(event);
}

export async function recordSkillPapercuts(
  input: RecordSkillPapercutsInput,
): Promise<SkillPapercutObservation[]> {
  if (input.signals.length === 0 || input.skills.length === 0) return [];
  const store = await openStore(input.repoPath);
  const observations: SkillPapercutObservation[] = [];
  try {
    for (const signal of input.signals) {
      const skills = input.skills.filter((skill) =>
        skill.stage === signal.stage &&
        (signal.skillId === undefined || signal.skillId === skill.id),
      );
      for (const skill of skills) {
        const observation = makeSkillPapercutObservation({
          id: observationId({
            repository: input.repository,
            flow: input.flow,
            runId: input.runId,
            stage: signal.stage,
            skillId: skill.id,
            skillContentHash: skill.contentHash,
            deduplicationKey: signal.deduplicationKey,
          }),
          repository: input.repository,
          flow: input.flow,
          stage: signal.stage,
          skillId: skill.id,
          skillContentHash: skill.contentHash,
          category: signal.category,
          summary: signal.summary,
          evidenceRefs: signal.evidenceRefs ?? [`run:${input.runId}`, `stage:${signal.stage}`],
          status: input.status,
          confidence: input.status === "operator-confirmed" ? 1 : 0.5,
          deduplicationKey: signal.deduplicationKey,
          runId: input.runId,
        });
        store.saveObservation(observation);
        observations.push(observation);
        appendSkillEvent(input.eventStore, {
          runId: input.runId,
          stageId: signal.stage,
          type: "skill-papercut.proposed",
          payload: observation,
        });
      }
    }
    return observations;
  } finally {
    store.close();
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedAuditText(value: string, max = 2_000): string {
  const redacted = redactText(value) ?? "";
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3).trim()}...`;
}

async function currentSkillHash(repoPath: string, skillId: string): Promise<string> {
  const skill = await validateSkillDirectory({
    skillDirectory: join(resolve(repoPath), ".nitely", "skills", skillId),
    skillId,
    stageId: "skill-improvement",
  });
  return skill.contentHash;
}

function skillsFromEvents(events: readonly StoredRunEvent[]): Array<SkillSnapshot & { stage: string }> {
  const skills: Array<SkillSnapshot & { stage: string }> = [];
  for (const event of events) {
    if (event.type !== "stage.skills.loaded" || !event.stageId) continue;
    const payload = recordFromUnknown(event.payload);
    if (!Array.isArray(payload.skills)) continue;
    for (const item of payload.skills) {
      const record = recordFromUnknown(item);
      const id = stringValue(record.id);
      const contentHash = stringValue(record.contentHash);
      if (id && contentHash) skills.push({ id, contentHash, stage: event.stageId });
    }
  }
  return skills;
}

function flowFromEvents(events: readonly StoredRunEvent[]): string {
  const created = events.find((event) => event.type === "run.created");
  const payload = recordFromUnknown(created?.payload);
  return stringValue(payload.flowName) ?? stringValue(payload.flowPath) ?? "unknown-flow";
}

export async function recordReflectionSkillPapercuts(input: {
  repoPath: string;
  runId: string;
  repository: string;
  flow: string;
  stage: string;
  signals: readonly SkillPapercutSignal[];
  eventStore: EventStore;
}): Promise<SkillPapercutObservation[]> {
  const skills = skillsFromEvents(input.eventStore.list(input.runId));
  return recordSkillPapercuts({
    ...input,
    status: "inferred",
    skills,
  });
}

export async function recordAcceptedReviewFeedbackSkillPapercuts(input: {
  repoPath: string;
  runId: string;
  repository: string;
  feedback: string;
  evidenceRef: string;
  eventStore: EventStore;
}): Promise<SkillPapercutObservation[]> {
  const events = input.eventStore.list(input.runId);
  const skills = skillsFromEvents(events);
  const explicitlyLinkedSkills = skills.filter((skill) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${skill.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_.-])`, "i")
      .test(input.feedback),
  );
  const linkedSkills = explicitlyLinkedSkills.length > 0
    ? explicitlyLinkedSkills
    : skills.length === 1 ? skills : [];
  const digest = createHash("sha256").update(input.feedback).digest("hex").slice(0, 16);
  const observations = await recordSkillPapercuts({
    repoPath: input.repoPath,
    repository: input.repository,
    flow: flowFromEvents(events),
    runId: input.runId,
    status: "inferred",
    skills,
    eventStore: input.eventStore,
    signals: linkedSkills.map((skill) => ({
      stage: skill.stage,
      skillId: skill.id,
      category: "reviewer-feedback",
      summary: input.feedback,
      deduplicationKey: `review-feedback:${digest}`,
      evidenceRefs: [input.evidenceRef],
    })),
  });
  if (observations.length > 0) {
    await reconcileSkillImprovementProposals({
      repoPath: input.repoPath,
      author: "review-feedback",
      problem: input.feedback,
      minimalDiff: "Update the linked skill guidance to address the recurring reviewer feedback.",
      expectedBehavior: input.feedback,
      risks: ["Review the proposal against pinned #429 cases before applying it."],
      eventStore: input.eventStore,
    });
  }
  return observations;
}

export async function confirmSkillPapercut(input: {
  repoPath: string;
  id: string;
  actor: string;
  eventStore?: EventStore;
}): Promise<SkillPapercutObservation> {
  const store = await openStore(input.repoPath);
  let observation: SkillPapercutObservation;
  try {
    observation = store.updateObservationStatus(input.id, "operator-confirmed");
    appendSkillEvent(input.eventStore, {
      runId: observation.runId,
      type: "skill-papercut.confirmed",
      payload: { id: observation.id, actor: boundedAuditText(input.actor, 200) },
    });
  } finally {
    store.close();
  }
  await reconcileSkillImprovementProposals({
    repoPath: input.repoPath,
    author: input.actor,
    problem: observation.summary,
    minimalDiff: "Update the linked skill guidance to address the recurring papercut.",
    expectedBehavior: observation.summary,
    risks: ["Review the proposal against pinned #429 cases before applying it."],
    eventStore: input.eventStore,
  });
  return observation;
}

export async function reconcileSkillImprovementProposals(input: {
  repoPath: string;
  author: string;
  minimalDiff: string;
  problem: string;
  expectedBehavior: string;
  risks?: readonly string[];
  evalCases?: readonly SkillImprovementEvalCase[];
  eventStore?: EventStore;
}): Promise<SkillImprovementProposal[]> {
  const store = await openStore(input.repoPath);
  try {
    const generated = generateSkillImprovementProposals({
      observations: store.listObservations(),
      minimalDiff: input.minimalDiff,
      problem: input.problem,
      expectedBehavior: input.expectedBehavior,
      risks: input.risks,
      evalCases: input.evalCases ?? [],
      author: input.author,
    });
    const existing = new Map(store.listProposals().map((proposal) => [proposal.id, proposal]));
    for (const proposal of generated) {
      const prior = existing.get(proposal.id);
      if (prior) {
        if (prior.status !== "insufficient_evidence" || prior.evalCases.length > 0 || proposal.evalCases.length === 0) continue;
        const reopened = {
          ...prior,
          evalCases: proposal.evalCases,
          status: "pending-approval" as const,
          audit: [...prior.audit, {
            action: "created" as const,
            actor: input.author,
            reason: "Pinned #429 eval cases supplied.",
            at: new Date().toISOString(),
          }],
        };
        store.saveProposal(reopened);
        appendSkillEvent(input.eventStore, {
          runId: reopened.runLineage[0] ?? "skill-improvement",
          type: "skill-improvement.proposed",
          payload: { type: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_TYPE, proposal: reopened },
        });
        continue;
      }
      const persisted = proposal.evalCases.length === 0
        ? {
          ...proposal,
          status: "insufficient_evidence" as const,
          audit: [...proposal.audit, {
            action: "created" as const,
            actor: input.author,
            reason: "No pinned #429 eval cases were supplied.",
            at: new Date().toISOString(),
          }],
        }
        : proposal;
      store.saveProposal(persisted);
      appendSkillEvent(input.eventStore, {
        runId: persisted.runLineage[0] ?? "skill-improvement",
        type: "skill-improvement.proposed",
        payload: { type: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_TYPE, proposal: persisted },
      });
    }
    const proposals = store.listProposals();
    if (proposals.length > 0) {
      await writeFile(
        join(resolve(input.repoPath), ".nitely", "skill-improvement-proposals.json"),
        `${JSON.stringify({
          type: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT.type,
          id: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT.id,
          proposals,
        }, null, 2)}\n`,
        "utf8",
      );
      appendSkillEvent(input.eventStore, {
        runId: proposals[0]?.runLineage[0] ?? "skill-improvement",
        type: "artifact.published",
        payload: {
          id: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT.id,
          type: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT.type,
          path: ".nitely/skill-improvement-proposals.json",
          proposalCount: proposals.length,
        },
      });
    }
    return proposals;
  } finally {
    store.close();
  }
}

export async function evaluateStoredSkillImprovementProposal(input: {
  repoPath: string;
  proposalId: string;
  report: EvalCohortReport;
  /** @deprecated retained for callers compiled against the original seam; the value is ignored. */
  currentSkillHash?: string;
  eventStore?: EventStore;
}): Promise<{ proposal: SkillImprovementProposal; decision: ReturnType<typeof evaluateSkillImprovementApplication> }> {
  const store = await openStore(input.repoPath);
  try {
    const proposal = store.getProposal(input.proposalId);
    if (!proposal) throw new Error(`skill improvement proposal not found: ${input.proposalId}`);
    const expected = proposal.evalCases.filter((entry) => entry.source === "pinned-#429");
    const baselineIds = new Set(input.report.runLineage.baseline.map((entry) => entry.caseId));
    const candidateIds = new Set(input.report.runLineage.candidate.map((entry) => entry.caseId));
    const covered = expected.filter((entry) => baselineIds.has(entry.id) && candidateIds.has(entry.id)).length;
    const evaluation = {
      passed: input.report.status === "passed",
      regressed: input.report.status === "regressed",
      coverage: expected.length > 0 ? covered / expected.length : 0,
    };
    const resolvedCurrentSkillHash = await currentSkillHash(input.repoPath, proposal.skillId);
    const decision = evaluateSkillImprovementApplication({
      proposal,
      currentSkillHash: resolvedCurrentSkillHash,
      evaluation,
    });
    const status = input.report.status === "insufficient_data" || decision.reason === "insufficient-coverage"
      ? "insufficient_evidence"
      : decision.reason === "stale-source-hash"
        ? "stale"
        : decision.reason === "eval-failed" || decision.reason === "regression"
          ? "blocked"
          : proposal.status;
    const updated = status === proposal.status ? proposal : {
      ...proposal,
      status,
      audit: [...proposal.audit, {
        action: "created" as const,
        actor: "eval",
        reason: decision.reason,
        at: new Date().toISOString(),
      }],
    };
    store.saveProposal(updated);
    appendSkillEvent(input.eventStore, {
      runId: updated.runLineage[0] ?? "skill-improvement",
      type: "skill-improvement.evaluated",
      payload: { proposalId: updated.id, decision, reportStatus: input.report.status },
    });
    return { proposal: updated, decision };
  } finally {
    store.close();
  }
}

export async function decideStoredSkillImprovementProposal(input: {
  repoPath: string;
  proposalId: string;
  decision: "accept" | "reject" | "suppress";
  actor: string;
  reason?: string;
  eventStore?: EventStore;
}): Promise<SkillImprovementProposal> {
  const store = await openStore(input.repoPath);
  try {
    const proposal = store.getProposal(input.proposalId);
    if (!proposal) throw new Error(`skill improvement proposal not found: ${input.proposalId}`);
    const updated = decideSkillImprovementProposal({
      proposal,
      decision: input.decision,
      actor: input.actor,
      reason: input.reason,
    });
    store.saveProposal(updated);
    if (input.decision !== "accept") {
      store.saveSuppression({
        proposalId: updated.id,
        actor: boundedAuditText(input.actor, 200),
        reason: boundedAuditText(input.reason ?? input.decision),
        at: new Date().toISOString(),
      });
    }
    appendSkillEvent(input.eventStore, {
      runId: updated.runLineage[0] ?? "skill-improvement",
      type: "skill-improvement.decided",
      payload: {
        proposalId: updated.id,
        decision: input.decision,
        actor: boundedAuditText(input.actor, 200),
        ...(input.reason ? { reason: boundedAuditText(input.reason) } : {}),
      },
    });
    return updated;
  } finally {
    store.close();
  }
}
