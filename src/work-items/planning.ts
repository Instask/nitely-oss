import { WebInputError } from "../web/errors.js";

export type PlanningArtifactKind = "spec" | "tech-design" | "tasks";

export type PlanningState =
  | "draft_spec"
  | "spec_needs_clarification"
  | "spec_approved"
  | "draft_tech_design"
  | "tech_design_approved"
  | "tasks_generated"
  | "tasks_approved"
  | "ready_for_execution";

export type PlanningDecision = "approve" | "reject" | "request_changes";

export interface PlanningArtifactStatus {
  path: string;
  state: Exclude<PlanningState, "ready_for_execution">;
}

export interface PlanningApprovalEvent {
  artifact: PlanningArtifactKind;
  artifactPath: string;
  decision: PlanningDecision;
  at: string;
  previousState: Exclude<PlanningState, "ready_for_execution">;
  nextState: Exclude<PlanningState, "ready_for_execution">;
  actor?: string;
  reason?: string;
}

export interface PlanningApprovalStatus {
  artifacts: {
    spec?: PlanningArtifactStatus;
    techDesign?: PlanningArtifactStatus;
    tasks?: PlanningArtifactStatus;
  };
  events: PlanningApprovalEvent[];
}

export interface ApplyPlanningDecisionInput {
  artifact: PlanningArtifactKind;
  decision: PlanningDecision;
  at?: string;
  actor?: string;
  reason?: string;
}

type PersistedPlanningState = Exclude<PlanningState, "ready_for_execution">;

export const PLANNING_LIFECYCLE_TRANSITIONS = [
  {
    artifact: "spec",
    from: "draft_spec",
    decision: "approve",
    to: "spec_approved",
  },
  {
    artifact: "spec",
    from: "spec_needs_clarification",
    decision: "approve",
    to: "spec_approved",
  },
  {
    artifact: "spec",
    from: "draft_spec",
    decision: "reject",
    to: "spec_needs_clarification",
  },
  {
    artifact: "spec",
    from: "draft_spec",
    decision: "request_changes",
    to: "spec_needs_clarification",
  },
  {
    artifact: "spec",
    from: "spec_approved",
    decision: "reject",
    to: "spec_needs_clarification",
  },
  {
    artifact: "spec",
    from: "spec_approved",
    decision: "request_changes",
    to: "spec_needs_clarification",
  },
  {
    artifact: "tech-design",
    from: "draft_tech_design",
    decision: "approve",
    to: "tech_design_approved",
  },
  {
    artifact: "tech-design",
    from: "tech_design_approved",
    decision: "reject",
    to: "draft_tech_design",
  },
  {
    artifact: "tech-design",
    from: "tech_design_approved",
    decision: "request_changes",
    to: "draft_tech_design",
  },
  {
    artifact: "tasks",
    from: "tasks_generated",
    decision: "approve",
    to: "tasks_approved",
  },
  {
    artifact: "tasks",
    from: "tasks_approved",
    decision: "reject",
    to: "tasks_generated",
  },
] as const satisfies readonly {
  artifact: PlanningArtifactKind;
  from: PersistedPlanningState;
  decision: PlanningDecision;
  to: PersistedPlanningState;
}[];

const artifactStates = new Set<Exclude<PlanningState, "ready_for_execution">>([
  "draft_spec",
  "spec_needs_clarification",
  "spec_approved",
  "draft_tech_design",
  "tech_design_approved",
  "tasks_generated",
  "tasks_approved",
]);

function artifactKey(
  artifact: PlanningArtifactKind,
): keyof PlanningApprovalStatus["artifacts"] {
  return artifact === "tech-design" ? "techDesign" : artifact;
}

function nextStateForDecision(
  artifact: PlanningArtifactKind,
  current: PersistedPlanningState,
  decision: PlanningDecision,
): PersistedPlanningState {
  const transition = PLANNING_LIFECYCLE_TRANSITIONS.find(
    (candidate) =>
      candidate.artifact === artifact &&
      candidate.from === current &&
      candidate.decision === decision,
  );
  if (transition) {
    return transition.to;
  }
  throw new WebInputError(
    `invalid planning transition for ${artifact}: ${current} -> ${decision}`,
  );
}

function clonePlanningStatus(
  status: PlanningApprovalStatus,
): PlanningApprovalStatus {
  return {
    artifacts: {
      ...(status.artifacts.spec
        ? { spec: { ...status.artifacts.spec } }
        : {}),
      ...(status.artifacts.techDesign
        ? { techDesign: { ...status.artifacts.techDesign } }
        : {}),
      ...(status.artifacts.tasks
        ? { tasks: { ...status.artifacts.tasks } }
        : {}),
    },
    events: status.events.map((event) => ({ ...event })),
  };
}

export function validatePlanningApprovalStatus(
  value: PlanningApprovalStatus,
): PlanningApprovalStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.artifacts !== "object" ||
    value.artifacts === null ||
    !Array.isArray(value.events)
  ) {
    throw new WebInputError("invalid planning approval metadata");
  }
  const cloned = clonePlanningStatus(value);
  for (const [name, artifact] of Object.entries(cloned.artifacts)) {
    if (!artifact) continue;
    if (typeof artifact.path !== "string" || !artifact.path.trim()) {
      throw new WebInputError(`planning ${name} artifact path is required`);
    }
    if (!artifactStates.has(artifact.state)) {
      throw new WebInputError(`invalid planning state: ${artifact.state}`);
    }
  }
  for (const event of cloned.events) {
    if (
      !artifactStates.has(event.previousState) ||
      !artifactStates.has(event.nextState)
    ) {
      throw new WebInputError("invalid planning approval event state");
    }
  }
  return cloned;
}

export function applyPlanningDecision(
  status: PlanningApprovalStatus,
  input: ApplyPlanningDecisionInput,
): PlanningApprovalStatus {
  const cloned = validatePlanningApprovalStatus(status);
  const key = artifactKey(input.artifact);
  const artifact = cloned.artifacts[key];
  if (!artifact) {
    throw new WebInputError(`planning artifact "${input.artifact}" not found`);
  }
  const previousState = artifact.state;
  const nextState = nextStateForDecision(
    input.artifact,
    previousState,
    input.decision,
  );
  cloned.artifacts[key] = { ...artifact, state: nextState };
  cloned.events = [
    ...cloned.events,
    {
      artifact: input.artifact,
      artifactPath: artifact.path,
      decision: input.decision,
      at: input.at ?? new Date().toISOString(),
      previousState,
      nextState,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  ];
  return cloned;
}

export function derivePlanningExecutionState(
  status?: PlanningApprovalStatus,
): PlanningState {
  if (!status) {
    return "ready_for_execution";
  }
  const normalized = validatePlanningApprovalStatus(status);
  if (!normalized.artifacts.spec) {
    return "draft_spec";
  }
  if (normalized.artifacts.spec.state !== "spec_approved") {
    return normalized.artifacts.spec.state;
  }
  if (!normalized.artifacts.techDesign) {
    return "draft_tech_design";
  }
  if (normalized.artifacts.techDesign.state !== "tech_design_approved") {
    return normalized.artifacts.techDesign.state;
  }
  if (
    normalized.artifacts.tasks &&
    normalized.artifacts.tasks.state !== "tasks_approved"
  ) {
    return normalized.artifacts.tasks.state;
  }
  return "ready_for_execution";
}

export function assertPlanningReadyForExecution(
  status?: PlanningApprovalStatus,
): void {
  const state = derivePlanningExecutionState(status);
  if (state === "ready_for_execution") {
    return;
  }
  if (state === "draft_spec" || state === "spec_needs_clarification") {
    throw new WebInputError("spec must be approved before starting a run");
  }
  if (state === "draft_tech_design") {
    if (status && !validatePlanningApprovalStatus(status).artifacts.techDesign) {
      throw new WebInputError(
        "draft technical design is required before starting a run",
      );
    }
    throw new WebInputError(
      "tech design must be approved before starting a run",
    );
  }
  if (state === "tasks_generated") {
    throw new WebInputError("tasks must be approved before starting a run");
  }
  throw new WebInputError(`planning state "${state}" blocks execution`);
}

export function formatPlanningApprovalEvidence(
  status?: PlanningApprovalStatus,
): string {
  if (!status) {
    return "none";
  }
  const normalized = validatePlanningApprovalStatus(status);
  const lines: string[] = [];
  if (normalized.artifacts.spec) {
    lines.push(`- spec: ${normalized.artifacts.spec.state}`);
    lines.push(`  Path: ${normalized.artifacts.spec.path}`);
  }
  if (normalized.artifacts.techDesign) {
    lines.push(`- tech-design: ${normalized.artifacts.techDesign.state}`);
    lines.push(`  Path: ${normalized.artifacts.techDesign.path}`);
  }
  if (normalized.artifacts.tasks) {
    lines.push(`- tasks: ${normalized.artifacts.tasks.state}`);
    lines.push(`  Path: ${normalized.artifacts.tasks.path}`);
  }
  lines.push(`- derived: ${derivePlanningExecutionState(normalized)}`);
  lines.push(`- events: ${normalized.events.length}`);
  return lines.join("\n");
}
