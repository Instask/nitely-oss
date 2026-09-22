# Issue 108: Scoped Implementation Runs

## Context

Nitely now has a Markdown task artifact format from #106, but every implementation run still receives the full task list. Large specs push too much irrelevant context into the agent prompt and make it hard to run one phase or user story at a time.

## Current State

- `src/task-artifacts/parse.ts` parses stable task IDs, phases, story IDs, dependencies, paths, and checkbox state.
- `src/run/run-flow.ts` snapshots every external input and renders each stage input in full unless the global token budget forces path-only rendering.
- CLI `nitely run` and the Web task/work-item run APIs have no way to pass task scope.
- Run evidence does not record which task IDs a run was intended to complete.

## Proposed Change

Add task-scope parameters to run creation. When present, Nitely validates the referenced task artifact before creating the workspace, projects only the selected tasks into the agent prompt, and records the selected task IDs in events, projections, and evidence.

Supported scope expressions:

1. Task range: `T001-T006`
2. Explicit task IDs: `T001,T004,T009`
3. Single task ID: `T003`
4. Phase name: exact case-insensitive phase heading, for example `Phase 1: Foundation`
5. Story ID: `US-001`
6. Next unchecked window: `next`, `next:5`, or `next unchecked 5`

## Acceptance Criteria

1. CLI supports `--task-scope <inputId>:<scope>` for `nitely run`.
2. Web run APIs accept `{ "taskScope": { "inputId": "tasks", "expression": "..." } }`.
3. Invalid task artifacts, unknown task IDs, and empty selections fail before workspace or agent creation.
4. Agent prompts include only the selected task artifact content while other inputs remain available.
5. Run events include `task.scope.selected` and successful runs include `task.scope.completed`.
6. `projectRun()` exposes the selected task scope.
7. `evidence.md` records the scope expression, kind, selected IDs, and run-start checkbox state.
8. Tests cover scope parsing, prompt rendering, invalid-scope failure, CLI params, API params, and completion-state projection.

## Out of Scope

- Editing the source task Markdown checkboxes in place.
- Splitting one task artifact into multiple persistent files.
- Adding UI controls for selecting a scope. This issue only creates the CLI/API and runtime substrate.
