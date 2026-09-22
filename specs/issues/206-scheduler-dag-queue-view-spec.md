# Issue #206: Scheduler DAG and Execution Queue View

## Problem

After task graph scheduling (#195), operators need to understand why work is waiting, what is currently running, and which tasks will start next. A flat `/tasks` list hides dependency readiness, suggested edges, and blocked reasons, making the overnight "generate code from approved specs and tech designs" workflow hard to trust.

## Goals

- Provide a Web Console scheduler surface that shows both execution queue state and DAG dependency state.
- Derive queue rows and DAG nodes from the same scheduler graph evaluation so the UI cannot disagree with scheduler execution.
- Make running, runnable, blocked, failed, completed, and draft tasks easy to scan.
- Show confirmed dependencies separately from suggested dependencies.
- Show blocked reasons with enough detail for an operator to act.
- Keep the surface useful across multiple repositories.

## Non-Goals

- Do not change scheduler execution order or dependency semantics.
- Do not implement drag-and-drop graph editing.
- Do not start automatic scheduler loops from this UI.

## Requirements

- `GET /api/scheduler` returns a scheduler projection with `summary`, `queue`, `nodes`, and `edges`.
- Queue sections include `running`, `runnable`, `blocked`, `failed`, `completed`, and `draft`.
- Node `displayStatus` is one of `running`, `runnable`, `blocked`, `failed`, `completed`, or `draft`.
- Confirmed edges come from `task.dependsOn`.
- Suggested edges come from `task.suggestedDependencies` and include reason, confidence, and source where available.
- Completed upstream tasks only unblock downstream work when the completion predicate considers them complete, including merged change request validation.
- The Web Console exposes a Scheduler view with a queue panel and a DAG panel.
- The view must remain readable on mobile by collapsing into a single column.

## Acceptance

- Unit tests cover scheduler projection for queue sections, node statuses, blocked reasons, and confirmed/suggested edges.
- Web API tests cover `/api/scheduler` using merged and unmerged PR states.
- Static Console tests cover the Scheduler navigation, route, API fetch, queue panel, and DAG panel.
