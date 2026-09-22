# Issue #5 Specification: Run State, Logs, and Resume

GitHub issue: https://github.com/Instask/nitely/issues/5

## Objective

Make Nitely operational after process restarts by persisting run events,
projecting status, exposing logs, and resuming interrupted runs.

## Current State

Nitely writes run metadata and stage files, but `status`, `logs`, and `resume`
are still placeholders. The event store exists separately and is not wired into
the run engine.

## Required Behavior

- Append events for run creation, workspace creation, stage start, attempt
  completion, command gate result, approval request, publish result, and run
  completion/failure.
- Reconstruct run and stage status from persisted events.
- Implement:
  - `nitely runs`
  - `nitely status <run-id>`
  - `nitely logs <run-id> [--stage <stage-id>]`
  - `nitely resume <run-id>`
- Mark a stage left in `started` state as interrupted after restart.
- Resume interrupted work by starting a new attempt.

## Non-Goals

- Distributed workers.
- Durable agent process resurrection.
- Web UI.
- Database migrations beyond the existing SQLite store.

## Acceptance Criteria

1. A run can be listed after the process exits.
2. Status shows run and stage states from event history.
3. Logs show stage attempt output and command logs.
4. Interrupted stage projection is deterministic.
5. Resume creates a new attempt for interrupted stages.

