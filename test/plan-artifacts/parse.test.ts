import { describe, expect, it } from "vitest";

import {
  technicalPlanTemplate,
  validateTechnicalPlan,
} from "../../src/plan-artifacts/parse.js";

describe("technical plan artifacts", () => {
  it("accepts the built-in technical plan template", () => {
    const result = validateTechnicalPlan(technicalPlanTemplate);

    expect(result.valid).toBe(true);
    expect(result.decisions.map((decision) => decision.id)).toEqual([
      "PD-001",
      "PD-002",
      "PD-003",
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        "src/web/repositories.ts",
        "src/repositories/store.ts",
        "test/web/repositories.test.ts",
      ]),
    );
    expect(result.testStrategy.join("\n")).toContain("SC-001");
    expect(result.constitutionChecks.join("\n")).toContain("Conflict");
    expect(result.complexityItems.map((item) => item.decisionId)).toEqual([
      "PD-001",
      "PD-002",
    ]);
  });

  it("reports missing required sections and unresolved placeholders", () => {
    const result = validateTechnicalPlan(`# Technical Plan

## Summary

TBD
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-section",
          section: "Technical Context",
        }),
        expect.objectContaining({ code: "placeholder", line: 5 }),
      ]),
    );
  });

  it("reports duplicate plan decision ids", () => {
    const result = validateTechnicalPlan(`# Technical Plan

## Summary
Plan.

## Technical Context
TypeScript.

## Files / Modules Touched
- \`src/example.ts\`

## Data Model Or Schema Changes
- **PD-001:** Add a schema.

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
None.
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-decision-id",
          id: "PD-001",
        }),
      ]),
    );
  });

  it("reports incomplete complexity tracking", () => {
    const result = validateTechnicalPlan(`# Technical Plan

## Summary
Plan.

## Technical Context
TypeScript.

## Files / Modules Touched
- \`src/example.ts\`

## Data Model Or Schema Changes
- **PD-001:** Add a schema.

## Flow / API / CLI Contract Changes
None.

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
  - **Complexity introduced:** A new schema.
  - **Simpler alternative rejected:** Reusing a string field.
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "incomplete-complexity-tracking",
          id: "PD-001",
        }),
      ]),
    );
  });
});
