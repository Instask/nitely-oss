export interface ArtifactContract {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  mediaType?: string;
  schema?: unknown;
  version?: string;
}

export const SKILL_PAPERCUT_ARTIFACT_TYPE = "nitely.skill-papercut.v1" as const;
export const SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_TYPE =
  "nitely.skill-improvement-proposal.v1" as const;

export const SKILL_PAPERCUT_ARTIFACT_CONTRACT: ArtifactContract = {
  id: "skill-papercuts",
  name: "Skill papercut observations",
  type: SKILL_PAPERCUT_ARTIFACT_TYPE,
  description: "Operator-confirmation candidates linked to the skill snapshot used by a run.",
  mediaType: "application/json",
  version: "v1",
};

export const SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_CONTRACT: ArtifactContract = {
  id: "skill-improvement-proposals",
  name: "Skill improvement proposals",
  type: SKILL_IMPROVEMENT_PROPOSAL_ARTIFACT_TYPE,
  description: "Operator-reviewed, data-only proposals; Nitely never applies them automatically.",
  mediaType: "application/json",
  version: "v1",
};

export type GateStateValue = "pending" | "approved" | "rejected";

export interface GateState {
  gateId: string;
  state: GateStateValue;
  actor?: string;
  reason?: string;
  decidedAt?: string;
}

export type ReviewGateVerdict =
  | "pass"
  | "fail"
  | "approved"
  | "needs_fix"
  | "needs_rework_spec"
  | "escalate";

export interface ReviewGateSpecificIssue {
  file?: string;
  line?: number;
  problem: string;
}

export interface ReviewGateVerdictRouting {
  verdict: ReviewGateVerdict;
  reason?: string;
  targetStage?: string;
  targetArtifact?: string;
  reworkTarget?: string;
  instructions?: string;
  specificIssues?: ReviewGateSpecificIssue[];
}

export interface GateReviewOutput {
  id: string;
  path: string;
  filename: string;
  mediaType: "text/markdown" | "text/plain";
  content: string;
  truncated: boolean;
  verdict?: ReviewGateVerdictRouting;
}

export interface OperatorReviewBlockerSnapshot {
  reason: string;
  stageId: string;
  runtime?: string;
  message?: string;
  retryAfter?: string;
}

export interface OperatorReviewProvenance {
  actor: string;
  submittedAt: string;
  reviewedArtifactIds: string[];
  blocker: OperatorReviewBlockerSnapshot;
}

export interface GateResult {
  id: string;
  stageId: string;
  name?: string;
  mode:
    | "deterministic"
    | "review"
    | "review-aggregate"
    | "analysis"
    | "security";
  status: "passed" | "failed";
  command?: string;
  runtime?: string;
  reviewedArtifacts?: string[];
  reviewOutput?: GateReviewOutput;
  operatorReview?: OperatorReviewProvenance;
  reason?: string;
  /**
   * Why a non-blocking gate would have blocked. Recorded so an advisory review
   * perspective stays visible in evidence without stopping the run; the
   * aggregating gate owns the blocking decision.
   */
  advisoryReason?: string;
  stdout?: string;
  stderr?: string;
  attempt?: number;
  createdAt: string;
}

export interface RunArtifact extends ArtifactContract {
  producer: string;
  mediaType: string;
  path?: string;
  sourceUri?: string;
  filename?: string;
  manifestSource?: "declared-manifest" | "discovered";
  createdAt?: string;
  gate?: GateState;
  gateResult?: GateResult;
  sha256?: string;
  size?: number;
  createdByRunId?: string;
  stageId?: string;
  attempt?: number;
}

export interface ArtifactRegistry {
  runId: string;
  generation?: number;
  privatePathRef?: string;
  artifacts: RunArtifact[];
}
