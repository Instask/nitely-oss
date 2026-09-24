import type {
  AgentCapabilityPolicy,
  Flow,
  RuntimeCandidate,
  Stage,
} from "./schema.js";

export type CapabilityStage =
  | Extract<Stage, { type: "agent" }>
  | Extract<Stage, { type: "judge" }>
  | Extract<Stage, { type: "gate"; mode: "review" }>;

export interface EffectiveCapabilityPolicy {
  source: "explicit" | "implicit";
  policy: AgentCapabilityPolicy;
}

const IMPLICIT_CAPABILITY_POLICY: AgentCapabilityPolicy = {
  read: { scope: "repository", allow: [] },
  write: { scope: "worktree", allow: [] },
  commands: { mode: "unrestricted", allow: [], deny: [], advisory: true },
  network: { mode: "advisory", advisory: true, domains: [] },
  allowedRuntimes: [],
  allowedModels: [],
  instructions: { repo: true, generated: true, skills: true },
  evidence: {
    prompts: true,
    toolCalls: true,
    fileChanges: true,
    runtimeUsage: true,
  },
};

export function isCapabilityStage(stage: Stage): stage is CapabilityStage {
  return (
    stage.type === "agent" ||
    stage.type === "judge" ||
    (stage.type === "gate" && stage.mode === "review")
  );
}

export function effectiveCapabilityPolicy(
  stage: CapabilityStage,
): EffectiveCapabilityPolicy {
  return stage.capabilities
    ? { source: "explicit", policy: stage.capabilities }
    : { source: "implicit", policy: IMPLICIT_CAPABILITY_POLICY };
}

export function stagesMissingCapabilityPolicy(flow: Pick<Flow, "spec">): string[] {
  return flow.spec.stages
    .filter((stage) => isCapabilityStage(stage) && !stage.capabilities)
    .map((stage) => stage.id);
}

export function assertRuntimeCandidateAllowedByCapabilities(input: {
  stage: CapabilityStage;
  candidate: RuntimeCandidate;
}): void {
  const { policy } = effectiveCapabilityPolicy(input.stage);
  if (
    policy.allowedRuntimes.length > 0 &&
    !policy.allowedRuntimes.includes(input.candidate.runtime)
  ) {
    throw new Error(
      `stage "${input.stage.id}" capability policy does not allow runtime "${input.candidate.runtime}"`,
    );
  }
  const candidateModel = input.candidate.model ?? "default";
  if (
    policy.allowedModels.length > 0 &&
    !policy.allowedModels.includes(candidateModel)
  ) {
    throw new Error(
      `stage "${input.stage.id}" capability policy does not allow model "${candidateModel}"`,
    );
  }
}
