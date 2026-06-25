import { describe, expect, it } from "vitest";

import { WebInputError } from "../../src/web/errors.js";
import {
  applyPlanningDecision,
  assertPlanningReadyForExecution,
  derivePlanningExecutionState,
  PLANNING_LIFECYCLE_TRANSITIONS,
  type PlanningArtifactKind,
  type PlanningApprovalStatus,
  type PlanningDecision,
  type PlanningState,
} from "../../src/work-items/planning.js";

type PersistedPlanningState = Exclude<PlanningState, "ready_for_execution">;

const allArtifacts: PlanningArtifactKind[] = ["spec", "tech-design", "tasks"];
const allPersistedStates: PersistedPlanningState[] = [
  "draft_spec",
  "spec_needs_clarification",
  "spec_approved",
  "draft_tech_design",
  "tech_design_approved",
  "tasks_generated",
  "tasks_approved",
];
const allDecisions: PlanningDecision[] = [
  "approve",
  "reject",
  "request_changes",
];

function statusFor(
  artifact: PlanningArtifactKind,
  state: PersistedPlanningState,
): PlanningApprovalStatus {
  const artifactStatus = { path: `${artifact}.md`, state };
  return {
    artifacts: {
      ...(artifact === "spec" ? { spec: artifactStatus } : {}),
      ...(artifact === "tech-design" ? { techDesign: artifactStatus } : {}),
      ...(artifact === "tasks" ? { tasks: artifactStatus } : {}),
    },
    events: [],
  };
}

const validTransitionKeys = new Set(
  PLANNING_LIFECYCLE_TRANSITIONS.map(
    (transition) =>
      `${transition.artifact}:${transition.from}:${transition.decision}`,
  ),
);

const invalidTransitionCases = allArtifacts.flatMap((artifact) =>
  allPersistedStates.flatMap((from) =>
    allDecisions
      .filter(
        (decision) =>
          !validTransitionKeys.has(`${artifact}:${from}:${decision}`),
      )
      .map((decision) => ({ artifact, from, decision })),
  ),
);

describe("planning approval states", () => {
  it.each(PLANNING_LIFECYCLE_TRANSITIONS)(
    "accepts $artifact $from -> $decision as $to",
    ({ artifact, from, decision, to }) => {
      const updated = applyPlanningDecision(statusFor(artifact, from), {
        artifact,
        decision,
        at: "2026-06-22T00:00:00.000Z",
      });

      expect(
        artifact === "tech-design"
          ? updated.artifacts.techDesign?.state
          : updated.artifacts[artifact]?.state,
      ).toBe(to);
      expect(updated.events[0]).toMatchObject({
        artifact,
        decision,
        previousState: from,
        nextState: to,
      });
    },
  );

  it.each(invalidTransitionCases)(
    "rejects invalid $artifact $from -> $decision transitions",
    ({ artifact, from, decision }) => {
      expect(() =>
        applyPlanningDecision(statusFor(artifact, from), {
          artifact,
          decision,
          at: "2026-06-22T00:02:00.000Z",
        }),
      ).toThrow(
        new WebInputError(
          `invalid planning transition for ${artifact}: ${from} -> ${decision}`,
        ),
      );
    },
  );

  it("approves a draft spec and records an append-only event", () => {
    const initial: PlanningApprovalStatus = {
      artifacts: {
        spec: {
          path: "specs/issues/113.md",
          state: "draft_spec",
        },
      },
      events: [],
    };

    const updated = applyPlanningDecision(initial, {
      artifact: "spec",
      decision: "approve",
      actor: "reviewer@example.test",
      at: "2026-06-22T00:00:00.000Z",
    });

    expect(updated.artifacts.spec?.state).toBe("spec_approved");
    expect(updated.events).toEqual([
      {
        artifact: "spec",
        artifactPath: "specs/issues/113.md",
        decision: "approve",
        actor: "reviewer@example.test",
        at: "2026-06-22T00:00:00.000Z",
        previousState: "draft_spec",
        nextState: "spec_approved",
      },
    ]);
    expect(initial.events).toEqual([]);
  });

  it("moves approved specs back to clarification when changes are requested", () => {
    const updated = applyPlanningDecision(
      {
        artifacts: {
          spec: {
            path: "specs/issues/113.md",
            state: "spec_approved",
          },
        },
        events: [],
      },
      {
        artifact: "spec",
        decision: "request_changes",
        reason: "Acceptance criteria need testable IDs.",
        at: "2026-06-22T00:01:00.000Z",
      },
    );

    expect(updated.artifacts.spec?.state).toBe("spec_needs_clarification");
    expect(updated.events[0]).toMatchObject({
      decision: "request_changes",
      previousState: "spec_approved",
      nextState: "spec_needs_clarification",
      reason: "Acceptance criteria need testable IDs.",
    });
  });

  it("rejects derived ready state as persisted artifact state", () => {
    expect(() =>
      assertPlanningReadyForExecution({
        artifacts: {
          spec: {
            path: "spec.md",
            state: "ready_for_execution" as never,
          },
        },
        events: [],
      }),
    ).toThrow(WebInputError);
  });

  it("blocks execution until required artifacts are approved", () => {
    const cases: Array<{
      name: string;
      status: PlanningApprovalStatus | undefined;
      state: PlanningState;
      message?: RegExp;
    }> = [
      {
        name: "legacy task with no planning metadata",
        status: undefined,
        state: "ready_for_execution",
      },
      {
        name: "draft spec",
        status: {
          artifacts: {
            spec: { path: "spec.md", state: "draft_spec" },
          },
          events: [],
        },
        state: "draft_spec",
        message: /spec must be approved/i,
      },
      {
        name: "approved spec with no technical design",
        status: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
          },
          events: [],
        },
        state: "draft_tech_design",
        message: /draft technical design is required/i,
      },
      {
        name: "approved spec with draft technical design",
        status: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
            techDesign: { path: "tech-design.md", state: "draft_tech_design" },
            tasks: { path: "tasks.md", state: "tasks_approved" },
          },
          events: [],
        },
        state: "draft_tech_design",
        message: /tech design must be approved/i,
      },
      {
        name: "approved design with generated tasks",
        status: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
            techDesign: {
              path: "tech-design.md",
              state: "tech_design_approved",
            },
            tasks: { path: "tasks.md", state: "tasks_generated" },
          },
          events: [],
        },
        state: "tasks_generated",
        message: /tasks must be approved/i,
      },
    ];

    for (const current of cases) {
      expect(derivePlanningExecutionState(current.status), current.name).toBe(
        current.state,
      );
      if (current.message) {
        expect(() =>
          assertPlanningReadyForExecution(current.status),
        ).toThrow(current.message);
      } else {
        expect(() =>
          assertPlanningReadyForExecution(current.status),
        ).not.toThrow();
      }
    }
  });

  it("marks fully approved planning artifacts ready for execution", () => {
    const status: PlanningApprovalStatus = {
      artifacts: {
        spec: { path: "spec.md", state: "spec_approved" },
        techDesign: { path: "tech-design.md", state: "tech_design_approved" },
        tasks: { path: "tasks.md", state: "tasks_approved" },
      },
      events: [],
    };

    expect(derivePlanningExecutionState(status)).toBe("ready_for_execution");
    expect(() => assertPlanningReadyForExecution(status)).not.toThrow();
  });
});
