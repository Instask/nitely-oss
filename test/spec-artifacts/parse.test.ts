import { describe, expect, it } from "vitest";

import {
  structuredSpecTemplate,
  validateStructuredSpec,
} from "../../src/spec-artifacts/parse.js";

describe("structured spec artifacts", () => {
  it("accepts the built-in structured spec template", () => {
    const result = validateStructuredSpec(structuredSpecTemplate);

    expect(result.valid).toBe(true);
    expect(result.stories.map((story) => story.id)).toEqual(["US-001", "US-002"]);
    expect(result.requirements.map((requirement) => requirement.id)).toEqual([
      "FR-001",
      "FR-002",
      "FR-003",
    ]);
    expect(result.successCriteria.map((criterion) => criterion.id)).toEqual([
      "SC-001",
      "SC-002",
      "SC-003",
    ]);
  });

  it("reports duplicate story, requirement, and success criterion ids", () => {
    const result = validateStructuredSpec(`# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** First story.
- **US-001:** Duplicate story.

## Acceptance Scenarios
- **US-001 / SC-001:** Scenario.

## Functional Requirements
- **FR-001:** First requirement.
- **FR-001:** Duplicate requirement.

## Success Criteria
- **SC-001:** First success.
- **SC-001:** Duplicate success.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-id", id: "US-001" }),
        expect.objectContaining({ code: "duplicate-id", id: "FR-001" }),
        expect.objectContaining({ code: "duplicate-id", id: "SC-001" }),
      ]),
    );
  });

  it("reports missing required sections and unresolved placeholders", () => {
    const result = validateStructuredSpec(`# Feature Spec

## Background
TBD
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-section", section: "User Stories" }),
        expect.objectContaining({ code: "placeholder", line: 4 }),
      ]),
    );
  });

  it("reports list items without the required section id prefix", () => {
    const result = validateStructuredSpec(`# Feature Spec

## Background
Problem.

## User Stories
- As an operator, I can do the thing.

## Acceptance Scenarios
- **US-001 / SC-001:** Scenario.

## Functional Requirements
- The system must do the thing.

## Success Criteria
- The thing works.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-id",
          section: "User Stories",
        }),
        expect.objectContaining({
          code: "missing-id",
          section: "Functional Requirements",
        }),
        expect.objectContaining({
          code: "missing-id",
          section: "Success Criteria",
        }),
      ]),
    );
  });
});
