# Issue 195: Task Graph Scheduler for Nightly Execution

## Objective

Upgrade Nitely from a flat task queue into a dependency-aware scheduler. Users
draft specs and technical designs during the day, add them to the queue, and let
Nitely execute the dependency-ready batch at night. An explicit task dependency
graph is the source of truth; AI-generated dependency suggestions are advisory
and never affect scheduling until a human accepts them.

## Problem

`TaskRecord` ([src/web/tasks.ts](../../src/web/tasks.ts)) has no notion of
dependencies, priority, or readiness. The only execution path is a manual
`POST /api/tasks/:id/runs` that runs a task immediately with no gating. There is
no scheduler entrypoint and no way to express that one task must wait for another
to land first. A FIFO queue cannot express "spec B builds on PR A", so unattended
nightly execution would run work that is not yet ready.

## Goals

- Add confirmed dependencies (`dependsOn`, Nitely task ids) to task records.
- Store AI-generated `suggestedDependencies` separately as non-authoritative
  metadata that never affects scheduling until accepted.
- Add `priority` (`P0`–`P3`, default `P2`) as a runnable-ordering key.
- Reject dependency cycles when dependencies are created, accepted, or updated,
  with a cycle path in the error.
- Derive a `blocked` state from dependency readiness (not persisted into
  `status`) with an actionable blocking reason.
- Treat an upstream task as complete only when it is `completed` **and** its pull
  request is merged. Degrade safely (treat as not-merged) when GitHub is
  unreachable.
- Select runnable tasks by dependency readiness, then `priority`, then
  `createdAt`.
- Generate dependency suggestions by reusing the existing agent runtime registry
  (configurable `codex`/`claude`), triggered asynchronously on task creation and
  on demand.
- Add a scheduler entrypoint runnable by cron/launchd/systemd, with a nightly
  window and a `--once` mode.
- Respect dependency blocks on the manual run-now path, with an explicit
  override.
- Expose dependency state, blocking reasons, and suggestions (accept/dismiss) in
  the Web Console.

## Non-Goals

- Fully automatic dependency mutation from AI suggestions (human accept required).
- Multi-run parallelism beyond what the existing runtime already supports safely.
- Cross-repository dependency execution.
- Automatic merge/land orchestration for completed upstream PRs.
- Dependencies targeting GitHub issue/PR URLs (only Nitely task ids in v1).
- An always-on daemon (cron/launchd/systemd entrypoint first).

## Functional Requirements

### Data Model

- Extend `TaskRecord` with:
  - `dependsOn?: string[]` — confirmed upstream task ids.
  - `suggestedDependencies?: SuggestedDependency[]` — advisory only.
  - `priority?: "P0" | "P1" | "P2" | "P3"` — default `P2`.
- `SuggestedDependency` = `{ dependsOn: string; reason: string; confidence: number; source: string; suggestedAt: string }` where `source` records the runtime/model that produced it.
- Persistence stays per-task in `.nitely/tasks/<id>/task.json` (atomic write).
  The graph is reconstructed in memory from all task records; there is no
  separate graph file.
- `blocked` is never written to `task.json`; it is derived at scheduling and
  display time.

### Graph Engine

- Pure functions with no IO. Input: task records plus a per-upstream completion
  predicate. Output: graph judgments.
- Build a directed graph where an edge points from a downstream task to each
  `dependsOn` upstream. `suggestedDependencies` are excluded from the graph.
- Cycle detection via DFS three-color marking. Run it whenever a dependency is
  added/accepted/updated, and reject with the offending cycle path. Re-check
  defensively at scheduling time.
- A `ready` task is runnable iff every `dependsOn` upstream is complete. If any
  upstream is missing, `failed`, or incomplete, the task is `blocked` with an
  actionable reason naming the upstream and cause.
- Runnable selection returns `ready`, fully-unblocked tasks ordered by
  `priority` (P0 highest) then `createdAt` ascending.

### Completion Predicate (PR merged)

- Add `getChangeRequestStatus(url) => { state, merged }` to `ScmProvider`
  ([src/scm/types.ts](../../src/scm/types.ts)), implemented over the existing
  `GET /pulls/:number` call.
- An upstream task is complete iff `status === "completed"` **and** its
  `changeRequestUrl` resolves to a merged PR.
- Degrade safely: if the status cannot be fetched (offline, rate limit, missing
  token), treat the upstream as not-merged so downstream stays blocked. Cache
  results within a single scheduling cycle.

### Suggestion Engine

- Extract the runtime invocation in `runAgent`
  ([src/run/execution/local.ts](../../src/run/execution/local.ts)) — spawn the
  resolved launcher, deliver the prompt over stdin, collect stdout — into a
  workspace-free helper reused by both stage execution and suggestion
  generation. Suggestion runtime/model is configurable the same way a stage
  declares `runtime`/`model` (default configurable, e.g. `codex`/`claude`).
- Trigger asynchronously after `POST /api/tasks` succeeds: the create response
  returns immediately; suggestion generation runs in the background and writes
  results back to the relevant tasks' `suggestedDependencies`. Generation
  failure is logged and never fails creation.
- Provide on-demand regeneration: `POST /api/tasks/:id/suggestions:refresh`.
- The prompt includes the subject task's title and spec summary plus the id,
  title, and summary of existing tasks, and asks for JSON
  `[{ from, to, reason, confidence }]`. Analysis is bidirectional (what the new
  task depends on, and what should depend on the new task).
- Validate parsed output: drop entries referencing unknown tasks, entries
  already confirmed, and entries that would create a cycle. Write surviving
  entries to the appropriate tasks' `suggestedDependencies`.

### Dependency Mutation API

- `POST /api/tasks/:id/dependencies` accepts a suggestion or adds a manual
  `dependsOn`. On success, cycle-check, then move into `dependsOn` and remove the
  matching `suggestedDependencies` entry. Reject cycles with the cycle path.
- `DELETE /api/tasks/:id/dependencies/:upstreamId` removes a confirmed
  dependency.
- Dismissing a suggestion removes it from `suggestedDependencies` without
  confirming it.

### Scheduler Entrypoint

- `nitely scheduler [--repo R] [--window HH:MM-HH:MM] [--once]`, runnable by
  cron/launchd/systemd.
- Load all tasks, build the graph, select runnable tasks, and run them in order
  via `runFlow` within the configured window.
- On task failure, mark it, leave its downstream blocked, and continue running
  other independent runnable branches (do not stop the whole night).

### Run-Now Gate

- `POST /api/tasks/:id/runs` respects `blocked` by default: a blocked task is
  rejected with its blocking reason.
- `POST /api/tasks/:id/runs?override=true` bypasses the dependency gate and runs
  immediately.

### Web Console

- Task list and detail surface `dependsOn`, derived `blocked` state with reason,
  `priority`, and `suggestedDependencies` with accept/dismiss controls.

## Acceptance Criteria

- Users can declare dependencies between queued tasks (manual and by accepting a
  suggestion).
- Nitely identifies runnable tasks and never executes blocked work in nightly or
  run-now modes (unless overridden).
- Nitely detects and rejects cycles on dependency creation/acceptance, reporting
  the cycle path.
- AI dependency suggestions are visible but do not affect execution until
  accepted.
- Nightly execution and manual run-now share the same readiness rules.
- A failed or unmerged upstream clearly blocks downstream tasks with an
  actionable reason.
- Nightly execution continues independent branches after a single task failure.
- Upstream completion requires a merged PR, degrading safely to blocked when
  GitHub status is unavailable.
- Suggestion generation reuses the configurable agent runtime and never blocks
  task creation.
