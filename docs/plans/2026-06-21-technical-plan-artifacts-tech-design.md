# Technical Plan Artifacts Tech Design

## Goal

Standardize Nitely technical plans so task generation and analysis gates can
consume implementation decisions, files/modules, test strategy, constitution
checks, and complexity justification without ad hoc parsing.

## Design

### Template

Add `docs/templates/nitely-technical-plan.md` with required sections:

- Summary
- Technical Context
- Files / Modules Touched
- Data Model Or Schema Changes
- Flow / API / CLI Contract Changes
- Failure Modes And Recovery Behavior
- Compatibility And Migration Plan
- Test Strategy
- Constitution Check
- Complexity Tracking

The template demonstrates stable plan decision IDs as `PD-###`. It also shows
how to cite `US-###`, `FR-###`, and `SC-###` IDs from structured specs.

### Validator

Add `src/plan-artifacts/parse.ts`.

The module exports:

- `parseTechnicalPlan(markdown): ParsedTechnicalPlan`
- `validateTechnicalPlan(markdown): ParsedTechnicalPlan`
- `technicalPlanTemplate`

`ParsedTechnicalPlan` includes:

- `valid`
- `decisions`
- `files`
- `testStrategy`
- `constitutionChecks`
- `complexityItems`
- `diagnostics`

The first validation slice checks:

- missing required sections
- duplicate `PD-###` IDs
- unresolved placeholders
- incomplete complexity tracking rows

### Analysis Gate Integration

Update `src/analysis/spec-plan-task.ts` to validate structured technical plan
artifacts and surface diagnostics as `invalid-plan-artifact` findings. This is
read-only and preserves legacy plan fallback by only enabling plan diagnostics
when the artifact contains structured plan headings.

## Validation

Add unit tests for the plan validator and focused analysis gate tests.

## Rollback

Revert the PR. Existing flows are unaffected because structured plan validation
is additive and only analysis-gate-integrated for structured plan artifacts.
