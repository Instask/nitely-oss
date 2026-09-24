# Issue 105 Technical Plan Artifacts Spec

## Background

Nitely stores technical designs in `docs/plans`, but the documents vary in
shape. Task generation and analysis gates need a stable Markdown structure that
separates product intent from implementation decisions, files touched, tests,
constitution checks, and complexity justification.

## User Stories

- **US-001:** As a planner, I can start from a technical plan template that
  records implementation decisions with stable IDs.
- **US-002:** As an operator, I can validate a plan before implementation so
  missing sections and placeholders are caught early.
- **US-003:** As a reviewer, I can inspect constitution and complexity checks
  without reading the whole plan.

## Acceptance Scenarios

- **US-001 / SC-001:** A new template under `docs/templates/` demonstrates
  `PD-###` decisions, files/modules, test strategy, constitution check, and
  complexity tracking.
- **US-002 / SC-002:** Validation reports missing required sections,
  unresolved placeholders, duplicate plan decision IDs, and incomplete
  complexity tracking.
- **US-003 / SC-003:** The analysis gate surfaces structured plan diagnostics
  before implementation runs.

## Functional Requirements

- **FR-001:** Provide a Markdown technical plan template.
- **FR-002:** Define required sections for summary, technical context,
  files/modules, data model, contract changes, failure behavior, compatibility,
  tests, constitution, and complexity.
- **FR-003:** Parse stable plan decision IDs in the `PD-###` format.
- **FR-004:** Validate required sections and unresolved placeholders.
- **FR-005:** Validate duplicate plan decision IDs.
- **FR-006:** Validate that complexity tracking includes introduced
  complexity, simpler alternative, and reason fields.
- **FR-007:** Expose parsed decisions, files/modules, test strategy,
  constitution checks, complexity items, and diagnostics through a reusable
  TypeScript module.
- **FR-008:** Update the spec-plan-task analysis gate to surface plan
  diagnostics.
- **FR-009:** Reference the plan template from README developer docs.

## Success Criteria

- **SC-004:** `validateTechnicalPlan()` accepts the built-in template.
- **SC-005:** Unit tests cover missing sections, duplicate decisions,
  placeholders, and incomplete complexity tracking.
- **SC-006:** Analysis gate tests cover plan diagnostic surfacing.

## Edge Cases And Failure Behavior

- Existing unstructured plans remain Markdown and are not rejected by default
  unless explicitly validated.
- Analysis gate only applies plan diagnostics when an artifact looks like a
  structured technical plan.
- Plans can record `None` for data model, contract, migration, or complexity
  sections when no change is needed.

## Assumptions

- Technical plans stay Markdown-first.
- The first implementation is deterministic validation, not semantic LLM review.

## Out Of Scope

- Web Console plan editor UI.
- Automatic plan generation.
- Dependency risk scoring.
