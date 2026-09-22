import { createHash } from "node:crypto";

import { redactText } from "./context/redaction.js";

export const SKILL_PAPERCUT_SCHEMA_VERSION = "nitely.skill-papercut.v1" as const;
export const SKILL_IMPROVEMENT_PROPOSAL_SCHEMA_VERSION =
  "nitely.skill-improvement-proposal.v1" as const;

export type SkillPapercutCategory = "failure" | "rework" | "reviewer-feedback";
export type SkillPapercutStatus = "operator-confirmed" | "inferred";
export type SkillImprovementProposalStatus =
  | "pending-approval"
  | "accepted"
  | "rejected"
  | "suppressed"
  | "stale"
  | "insufficient_evidence"
  | "blocked"
  | "applied"
  | "rolled-back";

const MAX_TEXT = 2_000;
const MAX_EVIDENCE_REFS = 8;

function bounded(value: string, max = MAX_TEXT): string {
  const redacted = redactText(value.replace(/[\u0000-\u001f\u007f]/g, " ")) ?? "";
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3).trim()}...`;
}

function boundedRefs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => bounded(value, 500)).filter(Boolean))]
    .slice(0, MAX_EVIDENCE_REFS);
}

function proposalId(groupKey: string): string {
  return `skill-proposal-${createHash("sha256").update(groupKey).digest("hex").slice(0, 20)}`;
}

export interface SkillPapercutObservation {
  schemaVersion: typeof SKILL_PAPERCUT_SCHEMA_VERSION;
  id: string;
  repository: string;
  flow: string;
  stage: string;
  skillId: string;
  skillContentHash: string;
  category: SkillPapercutCategory;
  summary: string;
  evidenceRefs: string[];
  status: SkillPapercutStatus;
  confidence: number;
  deduplicationKey: string;
  runId: string;
  author?: string;
  model?: string;
}

export interface SkillImprovementEvalCase {
  id: string;
  before: string;
  after: string;
  source: "pinned-#429" | "generated";
}

export interface SkillImprovementProposal {
  schemaVersion: typeof SKILL_IMPROVEMENT_PROPOSAL_SCHEMA_VERSION;
  id: string;
  repository: string;
  flow: string;
  stage: string;
  skillId: string;
  sourceSkillHash: string;
  deduplicationKey: string;
  problem: string;
  runLineage: string[];
  evidenceRefs: string[];
  minimalDiff: string;
  expectedBehavior: string;
  risks: string[];
  evalCases: SkillImprovementEvalCase[];
  author: string;
  model?: string;
  sourceHash?: string;
  occurrenceCount: number;
  status: SkillImprovementProposalStatus;
  audit: Array<{
    action: "created" | "accepted" | "rejected" | "suppressed" | "applied" | "rolled-back";
    actor: string;
    reason?: string;
    at: string;
  }>;
  appliedRevision?: string;
}

export interface SkillImprovementGenerationInput {
  observations: readonly SkillPapercutObservation[];
  minimalDiff: string;
  problem: string;
  expectedBehavior: string;
  risks?: readonly string[];
  evalCases: readonly SkillImprovementEvalCase[];
  author: string;
  model?: string;
  sourceHash?: string;
  minimumConfirmedOccurrences?: number;
}

function groupKey(observation: SkillPapercutObservation): string {
  return [
    observation.repository,
    observation.flow,
    observation.stage,
    observation.skillId,
    observation.skillContentHash,
    observation.deduplicationKey,
  ].map((part) => part.trim()).join("\0");
}

function normalizeObservation(observation: SkillPapercutObservation): SkillPapercutObservation {
  return {
    ...observation,
    repository: bounded(observation.repository, 500),
    flow: bounded(observation.flow, 500),
    stage: bounded(observation.stage, 200),
    skillId: bounded(observation.skillId, 200),
    skillContentHash: bounded(observation.skillContentHash, 200),
    summary: bounded(observation.summary),
    evidenceRefs: boundedRefs(observation.evidenceRefs),
    deduplicationKey: bounded(observation.deduplicationKey, 300),
    runId: bounded(observation.runId, 200),
    ...(observation.author ? { author: bounded(observation.author, 200) } : {}),
    ...(observation.model ? { model: bounded(observation.model, 200) } : {}),
    confidence: Math.min(1, Math.max(0, observation.confidence)),
  };
}

export function makeSkillPapercutObservation(
  input: Omit<SkillPapercutObservation, "schemaVersion">,
): SkillPapercutObservation {
  return normalizeObservation({
    ...input,
    schemaVersion: SKILL_PAPERCUT_SCHEMA_VERSION,
  });
}

function normalizeEvalCase(value: SkillImprovementEvalCase): SkillImprovementEvalCase {
  return {
    id: bounded(value.id, 200),
    before: bounded(value.before),
    after: bounded(value.after),
    source: value.source,
  };
}

export function generateSkillImprovementProposals(
  input: SkillImprovementGenerationInput,
): SkillImprovementProposal[] {
  const minimum = Math.max(1, input.minimumConfirmedOccurrences ?? 3);
  const groups = new Map<string, SkillPapercutObservation[]>();
  for (const raw of input.observations) {
    const observation = normalizeObservation(raw);
    const key = groupKey(observation);
    const group = groups.get(key) ?? [];
    if (!group.some((candidate) => candidate.id === observation.id)) group.push(observation);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, observations]) =>
      new Set(
        observations
          .filter((observation) => observation.status === "operator-confirmed")
          .map((observation) => observation.runId),
      ).size >= minimum,
    )
    .map(([key, observations]) => {
      const first = observations[0] as SkillPapercutObservation;
      const evalCases = input.evalCases.map(normalizeEvalCase);
      return {
        schemaVersion: SKILL_IMPROVEMENT_PROPOSAL_SCHEMA_VERSION,
        id: proposalId(key),
        repository: first.repository,
        flow: first.flow,
        stage: first.stage,
        skillId: first.skillId,
        sourceSkillHash: first.skillContentHash,
        deduplicationKey: first.deduplicationKey,
        problem: bounded(input.problem),
        runLineage: [...new Set(observations.map((observation) => observation.runId))],
        evidenceRefs: boundedRefs(observations.flatMap((observation) => observation.evidenceRefs)),
        minimalDiff: bounded(input.minimalDiff),
        expectedBehavior: bounded(input.expectedBehavior),
        risks: [...new Set((input.risks ?? []).map((risk) => bounded(risk)).filter(Boolean))].slice(0, 8),
        evalCases,
        author: bounded(input.author, 200),
        ...(input.model ? { model: bounded(input.model, 200) } : {}),
        ...(input.sourceHash ? { sourceHash: bounded(input.sourceHash, 200) } : {}),
        occurrenceCount: observations.length,
        status: "pending-approval",
        audit: [{ action: "created", actor: bounded(input.author, 200), at: new Date().toISOString() }],
      } satisfies SkillImprovementProposal;
    });
}

export function evaluateSkillImprovementApplication(input: {
  proposal: SkillImprovementProposal;
  currentSkillHash: string;
  evaluation?: { passed: boolean; regressed: boolean; coverage: number };
  minimumCoverage?: number;
}): { allowed: boolean; reason: "ready" | "not-approved" | "stale-source-hash" | "eval-failed" | "regression" | "insufficient-coverage" } {
  if (input.proposal.sourceSkillHash !== input.currentSkillHash) {
    return { allowed: false, reason: "stale-source-hash" };
  }
  if (input.proposal.status !== "accepted") return { allowed: false, reason: "not-approved" };
  const evaluation = input.evaluation;
  if (!evaluation || evaluation.coverage < (input.minimumCoverage ?? 1)) {
    return { allowed: false, reason: "insufficient-coverage" };
  }
  if (!evaluation.passed) return { allowed: false, reason: "eval-failed" };
  if (evaluation.regressed) return { allowed: false, reason: "regression" };
  return { allowed: true, reason: "ready" };
}

export function decideSkillImprovementProposal(input: {
  proposal: SkillImprovementProposal;
  decision: "accept" | "reject" | "suppress";
  actor: string;
  reason?: string;
  at?: string;
}): SkillImprovementProposal {
  const status = input.decision === "accept"
    ? "accepted"
    : input.decision === "reject"
      ? "rejected"
      : "suppressed";
  return {
    ...input.proposal,
    status,
    audit: [
      ...input.proposal.audit,
      {
        action: input.decision === "accept" ? "accepted" : input.decision === "reject" ? "rejected" : "suppressed",
        actor: bounded(input.actor, 200),
        ...(input.reason ? { reason: bounded(input.reason) } : {}),
        at: input.at ?? new Date().toISOString(),
      },
    ],
  };
}

export function markSkillImprovementApplied(input: {
  proposal: SkillImprovementProposal;
  revision: string;
  actor: string;
  at?: string;
}): SkillImprovementProposal {
  if (input.proposal.status !== "accepted") throw new Error("skill improvement proposal is not accepted");
  return {
    ...input.proposal,
    status: "applied",
    appliedRevision: bounded(input.revision, 200),
    audit: [...input.proposal.audit, {
      action: "applied",
      actor: bounded(input.actor, 200),
      at: input.at ?? new Date().toISOString(),
    }],
  };
}

export function rollbackSkillImprovementProposal(input: {
  proposal: SkillImprovementProposal;
  actor: string;
  reason: string;
  at?: string;
}): SkillImprovementProposal {
  if (input.proposal.status !== "applied") throw new Error("skill improvement proposal is not applied");
  return {
    ...input.proposal,
    status: "rolled-back",
    audit: [...input.proposal.audit, {
      action: "rolled-back",
      actor: bounded(input.actor, 200),
      reason: bounded(input.reason),
      at: input.at ?? new Date().toISOString(),
    }],
  };
}
