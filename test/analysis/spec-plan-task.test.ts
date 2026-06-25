import { describe, expect, it } from "vitest";

import { analyzeSpecPlanTasks } from "../../src/analysis/spec-plan-task.js";

describe("spec plan task analysis", () => {
  it("flags missing requirement and success criterion task coverage", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "spec",
          content: `# Spec

FR-001 Users can import repositories.
SC-001 Import completes with a visible run record.
`,
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 [US-001] Implement unrelated workflow
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          code: "missing-requirement-coverage",
          relatedIds: ["FR-001"],
        }),
        expect.objectContaining({
          severity: "critical",
          code: "missing-success-coverage",
          relatedIds: ["SC-001"],
        }),
      ]),
    );
  });

  it("flags duplicate task IDs and unresolved placeholders", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "spec",
          content: "FR-001 Build {{FEATURE_NAME}}\n",
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 FR-001 Implement feature
- [ ] T001 FR-001 Duplicate task
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-task-artifact", relatedIds: ["T001"] }),
        expect.objectContaining({ code: "placeholder", artifactIds: ["spec"] }),
      ]),
    );
  });

  it("flags constitution must-not conflicts", () => {
    const report = analyzeSpecPlanTasks({
      constitution: "The system must not expose secrets.",
      artifacts: [
        {
          id: "plan",
          content: "Plan decision D-001: expose secrets in evidence for debugging.",
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 D-001 Implement evidence change
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "constitution-conflict",
          artifactIds: ["plan"],
        }),
      ]),
    );
  });

  it("flags dependency ordering contradictions", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 FR-001 Implement first task (depends: T002)
- [ ] T002 FR-001 Implement second task
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency-order",
          relatedIds: ["T001", "T002"],
        }),
      ]),
    );
  });

  it("uses structured spec definitions for coverage checks", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "spec",
          content: `# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** Import a repository.

## Acceptance Scenarios
- **US-001 / SC-999:** This reference is not a success criterion definition.

## Functional Requirements
- **FR-001:** Import valid repositories.
- **FR-002:** Persist imported repositories.

## Success Criteria
- **SC-001:** Import can be verified with a test.
- **SC-002:** Persistence can be verified with a test.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`,
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 FR-001 SC-001 Add import path and verification test
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-requirement-coverage",
          relatedIds: ["FR-002"],
        }),
        expect.objectContaining({
          code: "missing-success-coverage",
          relatedIds: ["SC-002"],
        }),
      ]),
    );
    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relatedIds: ["SC-999"] }),
      ]),
    );
  });

  it("surfaces structured spec validation diagnostics", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "spec",
          content: `# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** First story.
- **US-001:** Duplicate story.

## Acceptance Scenarios
- **US-001 / SC-001:** Scenario.

## Functional Requirements
- **FR-001:** Build {{FEATURE_NAME}}.

## Success Criteria
- **SC-001:** It works.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`,
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 FR-001 SC-001 Add implementation and verification test
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-spec-artifact",
          relatedIds: ["US-001"],
        }),
        expect.objectContaining({
          code: "invalid-spec-artifact",
          message: expect.stringContaining("unresolved placeholder"),
        }),
      ]),
    );
  });

  it("surfaces structured technical plan validation diagnostics", () => {
    const report = analyzeSpecPlanTasks({
      artifacts: [
        {
          id: "spec",
          content: `# Spec

FR-001 Build import support.
SC-001 Import support is verified.
`,
        },
        {
          id: "tech-design",
          content: `# Technical Plan

## Summary
Plan.

## Technical Context
TypeScript.

## Files / Modules Touched
- \`src/example.ts\`

## Data Model Or Schema Changes
- **PD-001:** Add a schema for {{FEATURE_NAME}}.

## Flow / API / CLI Contract Changes
- **PD-001:** Duplicate decision.

## Failure Modes And Recovery Behavior
None.

## Compatibility And Migration Plan
None.

## Test Strategy
- **SC-001:** Test it.

## Constitution Check
- **Conflict:** none.

## Complexity Tracking
- **PD-001**
  - **Complexity introduced:** A schema.
`,
        },
        {
          id: "tasks",
          content: `# Tasks

## Phase 1

- [ ] T001 FR-001 SC-001 PD-001 Add implementation and verification test
`,
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-plan-artifact",
          relatedIds: ["PD-001"],
        }),
        expect.objectContaining({
          code: "invalid-plan-artifact",
          message: expect.stringContaining("unresolved placeholder"),
        }),
        expect.objectContaining({
          code: "invalid-plan-artifact",
          message: expect.stringContaining("complexity tracking"),
        }),
      ]),
    );
  });
});
