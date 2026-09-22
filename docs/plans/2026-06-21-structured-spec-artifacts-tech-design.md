# Structured Spec Artifacts Tech Design

## Goal

Make Nitely feature specs Markdown-first but machine-readable enough for
planning, task coverage, analysis gates, and PR evidence.

## Design

### Template

Add `docs/templates/nitely-spec.md` with:

- required section headings
- `US-###`, `FR-###`, and `SC-###` examples
- acceptance scenarios tied to stories
- stability rules for IDs
- flow-forward, living-spec, and flow-back guidance

The README links to the template next to the existing constitution and task
templates.

### Validator

Add `src/spec-artifacts/parse.ts`.

The module exports:

- `parseStructuredSpec(markdown): ParsedStructuredSpec`
- `validateStructuredSpec(markdown): ParsedStructuredSpec`
- `structuredSpecTemplate`

`ParsedStructuredSpec` includes:

- `valid`
- `stories`
- `requirements`
- `successCriteria`
- `diagnostics`

Diagnostics include code, severity, message, line, and optional ID. The first
slice checks:

- missing required sections
- duplicate `US-###`, `FR-###`, and `SC-###` IDs
- list items in required ID sections without the expected ID
- unresolved placeholders

### Analysis Gate Integration

Update `src/analysis/spec-plan-task.ts` to call `validateStructuredSpec()` for
spec-like artifacts. The gate uses parsed FR/SC/US IDs for coverage checks and
surfaces spec diagnostics as analysis findings. This gives later PR evidence a
single source of structured spec truth instead of ad hoc ID scanning.

## Validation

Add focused unit tests for the validator and keep the existing analysis gate
tests passing.

## Rollback

Revert the PR. Existing flows remain unaffected because the validator is only
called by the optional analysis gate and tests.
