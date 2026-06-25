import type { Stage } from "../flow/schema.js";

export type OrchestratorDecision =
  | { action: "complete"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "rework"; targetArtifact: string; reason: string }
  | { action: "escalate"; reason: string }
  | { action: "fail"; reason: string };

export type PolicyDecision = OrchestratorDecision;

export type OrchestratorRecommendation =
  | { action: "rework"; targetArtifact: string; reason?: string }
  | { action: "escalate"; reason?: string };

export interface OrchestratorDecisionEvent {
  stageId: string;
  stageType: Stage["type"];
  attempt: number;
  maxAttempts: number;
  action: OrchestratorDecision["action"];
  reason: string;
  error?: string;
  targetArtifact?: string;
}

export interface DecideStagePolicyInput {
  stageType: Stage["type"];
  succeeded: boolean;
  attempt: number;
  maxAttempts: number;
  error?: string;
  reworkTarget?: string;
  recommendation?: OrchestratorRecommendation;
  validReworkTargets: ReadonlySet<string>;
}

export function decideStagePolicy(input: DecideStagePolicyInput): PolicyDecision {
  if (input.succeeded) {
    return {
      action: "complete",
      reason: `${input.stageType} completed on attempt ${input.attempt}`,
    };
  }

  const error = input.error?.trim() || "unknown error";
  const recommendation =
    input.recommendation ??
    (input.reworkTarget
      ? ({
          action: "rework",
          targetArtifact: input.reworkTarget,
        } satisfies OrchestratorRecommendation)
      : undefined);
  const reworkTarget =
    recommendation?.action === "rework" ? recommendation.targetArtifact : undefined;

  if (reworkTarget && !input.validReworkTargets.has(reworkTarget)) {
    return {
      action: "fail",
      reason: `invalid rework target: ${reworkTarget}`,
    };
  }

  if (recommendation?.action === "escalate") {
    return {
      action: "escalate",
      reason:
        recommendation.reason?.trim() ||
        `escalation requested after attempt ${input.attempt}: ${error}`,
    };
  }

  if (
    reworkTarget &&
    (input.stageType === "agent" ||
      input.stageType === "command" ||
      input.stageType === "gate") &&
    input.attempt < input.maxAttempts
  ) {
    return {
      action: "rework",
      targetArtifact: reworkTarget,
      reason:
        recommendation?.action === "rework" && recommendation.reason?.trim()
          ? recommendation.reason.trim()
          : `rework requested for ${reworkTarget} after attempt ${input.attempt}: ${error}`,
    };
  }

  if (
    (input.stageType === "agent" ||
      input.stageType === "command" ||
      input.stageType === "gate") &&
    input.attempt < input.maxAttempts
  ) {
    return {
      action: "retry",
      reason: `${input.stageType} failed on attempt ${input.attempt} of ${input.maxAttempts}: ${error}`,
    };
  }

  return {
    action: "fail",
    reason: `${input.stageType} failed after ${input.attempt} of ${input.maxAttempts} attempts: ${error}`,
  };
}
