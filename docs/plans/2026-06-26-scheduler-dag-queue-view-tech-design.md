# Scheduler DAG and Queue View Tech Design

## Context

#195 introduced `dependsOn`, `suggestedDependencies`, completion predicates, and scheduler ordering. #206 adds observability for that state without changing execution behavior.

## Data Model

Add `src/scheduler/view.ts` as a read-only projection layer:

- Input: `TaskRecord[]` plus `EvaluateTaskGraphInput`.
- Uses `evaluateTaskGraph` for blocked reasons.
- Uses `selectRunnableTasks` for runnable ordering.
- Emits:
  - `summary`: counts for top-level operator status.
  - `queue`: running/runnable/blocked/failed/completed/draft task lists.
  - `nodes`: task DAG nodes with display status and blocked reasons.
  - `edges`: confirmed dependency edges and suggested dependency edges.

`displayStatus` is intentionally separate from persisted `task.status` because `blocked` and `runnable` are derived states.

## API

Add `GET /api/scheduler`:

- Authenticated like other Web Console APIs.
- Builds one scheduler projection per configured repository.
- Filters tasks by the current user's visibility.
- Uses the same completion predicate as task run dependency checks.
- Merges repository projections into one response while preserving `repoId`, `repoName`, and `repoPath` on queue items and nodes.

## Console

Add a Scheduler top-level view:

- Navigation item: `Scheduler`.
- Route: `/scheduler`.
- Data source: `/api/scheduler`.
- Layout:
  - Summary strip for running/runnable/blocked/failed/completed.
  - Queue panel grouped by execution state.
  - DAG panel showing nodes and confirmed/suggested edges.
- Responsive behavior: two columns on desktop, single column on narrow screens.

## Tests

- `test/scheduler/view.test.ts`: projection behavior.
- `test/web/server.test.ts`: `/api/scheduler` response and merged PR completion behavior.
- `test/web/console-static.test.ts`: Console route, fetch, and DOM anchors.

## Risk

The main risk is UI disagreement with scheduler execution. This design mitigates it by making the API projection consume the same graph and completion helpers used by scheduling and run gating.
