# Issue 106 Task Breakdown Artifact Spec

## Scope

Introduce a Markdown-first task breakdown artifact format and parser. This increment makes task files machine-readable so later scoped execution can run a task range, phase, or story without handing an entire feature to one agent invocation.

## Requirements

- Provide a human-editable task artifact template.
- Parse stable task IDs such as `T001`.
- Parse Markdown checkbox completion state.
- Parse optional parallel markers `[P]`.
- Parse story markers such as `[US-001]`, either on the task line or inherited from the current phase heading.
- Parse phase headings.
- Parse task dependencies from `(depends: T001,T002)` style metadata.
- Parse file paths from backticked task text.
- Validate duplicate task IDs, missing task IDs, and malformed task lines.

## Acceptance Criteria

- A task artifact template exists under `docs/templates/`.
- `parseTaskArtifact` returns phases, tasks, metadata, completion state, and diagnostics.
- `validateTaskArtifact` reports duplicate, missing, and malformed task IDs.
- Tests cover a realistic task file with phase, story, parallel, dependency, path, and checkbox metadata.
