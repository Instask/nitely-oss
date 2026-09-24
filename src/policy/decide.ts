import type { Stage } from "../flow/schema.js";
import {
  detectReworkOscillation,
  type ReworkEdge,
  type ReworkOscillationDiagnostics,
} from "../run/rework-oscillation.js";

export type { ReworkEdge, ReworkOscillationDiagnostics };

export interface ReworkSpecificIssue {
  file?: string;
  line?: number;
  problem: string;
}

export interface ReworkRequest {
  targetStage: string;
  reason: string;
  targetArtifact?: string;
  instructions?: string;
  context?: string;
  specificIssues?: ReworkSpecificIssue[];
  sourceStage?: string;
  sourceAttempt?: number;
}

export type OrchestratorDecision =
  | { action: "complete"; reason: string }
  | { action: "retry"; reason: string }
  | {
      action: "rework";
      targetStage: string;
      targetArtifact?: string;
      reason: string;
      reworkRequest: ReworkRequest;
    }
  | { action: "escalate"; reason: string }
  | {
      action: "fail";
      reason: string;
      oscillation?: ReworkOscillationDiagnostics;
    };

export type PolicyDecision = OrchestratorDecision;

export type OrchestratorRecommendation =
  | ({
      action: "rework";
      reason?: string;
      instructions?: string;
      context?: string;
      specificIssues?: ReworkSpecificIssue[];
    } & (
      | { targetStage: string; targetArtifact?: string }
      | { targetArtifact: string; targetStage?: string }
    ))
  | { action: "escalate"; reason?: string };

export interface OrchestratorDecisionEvent {
  stageId: string;
  stageType: Stage["type"];
  attempt: number;
  maxAttempts: number;
  action: OrchestratorDecision["action"];
  reason: string;
  error?: string;
  targetStage?: string;
  targetArtifact?: string;
  reworkRequest?: ReworkRequest;
  oscillation?: ReworkOscillationDiagnostics;
}

export interface DecideStagePolicyInput {
  stageType: Stage["type"];
  succeeded: boolean;
  attempt: number;
  maxAttempts: number;
  maxRework?: number;
  error?: string;
  reworkRequest?: ReworkRequest;
  reworkTarget?: string;
  recommendation?: OrchestratorRecommendation;
  validReworkTargets: ReadonlySet<string>;
  validReworkStages?: ReadonlySet<string>;
  sourceStage?: string;
  sourceAttempt?: number;
  reworkEdges?: readonly ReworkEdge[];
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSpecificIssues(
  issues: ReworkSpecificIssue[] | undefined,
): ReworkSpecificIssue[] | undefined {
  const normalized = issues
    ?.map((issue) => {
      const problem = optionalText(issue.problem);
      if (!problem) return undefined;
      return {
        ...(optionalText(issue.file) ? { file: optionalText(issue.file) } : {}),
        ...(typeof issue.line === "number" ? { line: issue.line } : {}),
        problem,
      };
    })
    .filter((issue): issue is ReworkSpecificIssue => issue !== undefined);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeReworkRequest(
  request: ReworkRequest,
  fallback: {
    sourceStage?: string;
    sourceAttempt?: number;
    error: string;
  },
): ReworkRequest | undefined {
  const targetStage = optionalText(request.targetStage);
  if (!targetStage) return undefined;
  const reason =
    optionalText(request.reason) ??
    `rework requested for ${targetStage}: ${fallback.error}`;
  return {
    targetStage,
    reason,
    ...(optionalText(request.targetArtifact)
      ? { targetArtifact: optionalText(request.targetArtifact) }
      : {}),
    ...(optionalText(request.instructions)
      ? { instructions: optionalText(request.instructions) }
      : {}),
    ...(optionalText(request.context)
      ? { context: optionalText(request.context) }
      : {}),
    ...(normalizeSpecificIssues(request.specificIssues)
      ? { specificIssues: normalizeSpecificIssues(request.specificIssues) }
      : {}),
    ...(optionalText(request.sourceStage ?? fallback.sourceStage)
      ? { sourceStage: optionalText(request.sourceStage ?? fallback.sourceStage) }
      : {}),
    ...(request.sourceAttempt ?? fallback.sourceAttempt
      ? { sourceAttempt: request.sourceAttempt ?? fallback.sourceAttempt }
      : {}),
  };
}

function recommendationReworkRequest(
  recommendation: OrchestratorRecommendation | undefined,
  fallback: {
    sourceStage?: string;
    sourceAttempt?: number;
    error: string;
  },
): ReworkRequest | undefined {
  if (recommendation?.action !== "rework") return undefined;
  const targetStage =
    optionalText(recommendation.targetStage) ??
    optionalText(recommendation.targetArtifact);
  if (!targetStage) return undefined;
  return normalizeReworkRequest(
    {
      targetStage,
      reason: recommendation.reason ?? "",
      targetArtifact: recommendation.targetArtifact,
      instructions: recommendation.instructions,
      context: recommendation.context,
      specificIssues: recommendation.specificIssues,
    },
    fallback,
  );
}

function legacyReworkRequest(
  target: string | undefined,
  fallback: {
    sourceStage?: string;
    sourceAttempt?: number;
    error: string;
  },
): ReworkRequest | undefined {
  const reworkTarget = optionalText(target);
  if (!reworkTarget) return undefined;
  return normalizeReworkRequest(
    {
      targetStage: reworkTarget,
      targetArtifact: reworkTarget,
      reason: "",
    },
    fallback,
  );
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
  const reworkRequest =
    (input.reworkRequest
      ? normalizeReworkRequest(input.reworkRequest, {
          sourceStage: input.sourceStage,
          sourceAttempt: input.sourceAttempt,
          error,
        })
      : undefined) ??
    recommendationReworkRequest(recommendation, {
      sourceStage: input.sourceStage,
      sourceAttempt: input.sourceAttempt,
      error,
    }) ??
    legacyReworkRequest(input.reworkTarget, {
      sourceStage: input.sourceStage,
      sourceAttempt: input.sourceAttempt,
      error,
    });
  const reworkTarget = reworkRequest?.targetArtifact;
  const reworkStage = reworkRequest?.targetStage;

  if (reworkTarget && !input.validReworkTargets.has(reworkTarget)) {
    return {
      action: "fail",
      reason: `invalid rework target: ${reworkTarget}`,
    };
  }
  if (
    reworkStage &&
    input.validReworkStages &&
    !input.validReworkStages.has(reworkStage)
  ) {
    return {
      action: "fail",
      reason: `invalid rework target stage: ${reworkStage}`,
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
    reworkRequest &&
    (input.stageType === "agent" ||
      input.stageType === "command" ||
      input.stageType === "gate" ||
      input.stageType === "judge") &&
    (input.stageType !== "judge" ||
      input.maxRework === undefined ||
      input.attempt <= input.maxRework) &&
    input.attempt < input.maxAttempts
  ) {
    const fromStage =
      optionalText(input.sourceStage) ?? optionalText(reworkRequest.sourceStage);
    if (fromStage) {
      const detection = detectReworkOscillation({
        priorEdges: input.reworkEdges ?? [],
        nextEdge: { from: fromStage, to: reworkRequest.targetStage },
      });
      if (detection.oscillating) {
        return {
          action: "fail",
          reason: detection.reason,
          oscillation: {
            from: detection.from,
            to: detection.to,
            count: detection.count,
            window: detection.window,
            edges: detection.edges,
          },
        };
      }
    }
    const reason =
      reworkRequest.reason ||
      (reworkTarget
        ? `rework requested for ${reworkTarget} after attempt ${input.attempt}: ${error}`
        : `rework requested for stage ${reworkRequest.targetStage} after attempt ${input.attempt}: ${error}`);
    return {
      action: "rework",
      targetStage: reworkRequest.targetStage,
      targetArtifact: reworkTarget,
      reason,
      reworkRequest: {
        ...reworkRequest,
        reason,
      },
    };
  }

  if (
    (input.stageType === "agent" ||
      input.stageType === "command" ||
      input.stageType === "gate" ||
      input.stageType === "judge") &&
    (input.stageType !== "judge" ||
      input.maxRework === undefined ||
      input.attempt <= input.maxRework) &&
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
