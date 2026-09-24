# Issue #120 Spec: Manager Workflow Dashboard

## Background

Managers need team workflow visibility across Nitely tasks and runs: what is in
progress, what is blocked, how much token usage is attributable to the work, and
how reliably work completes. This is not an individual productivity scoreboard.

## Goals

- Show a team-level dashboard across configured repositories.
- Surface throughput, blocked work aging, token/cost attribution, and outcome
  quality.
- Reuse existing task/run projections and usage events.
- Keep submitter as a filter/attribution dimension, not a default ranking.

## Non-goals

- Per-member productivity rankings.
- A new metrics store or warehouse.
- Provider-specific pricing configuration beyond existing runtime usage
  `estimatedCostUsd` values.

## Acceptance Criteria

- Web API exposes a dashboard aggregate over visible tasks/runs.
- Dashboard includes throughput, blocked/aging tasks, token/cost attribution,
  and outcome quality.
- Aggregation is multi-repo aware.
- UI has a first-class Dashboard view.
- Default UI groups by workflow/repo/status, not by individual output volume.
