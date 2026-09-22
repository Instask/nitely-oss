# Issue 248: Preserve Terminal Run Status After Finalizers

## Problem

Runs can execute after-stop finalizer stages such as `reflect` after the main workflow has already reached `run.failed`, `run.blocked`, or `run.completed`. The UI and projections must not treat the finalizer's later stage state as the main workflow outcome.

Example failure:

- Main workflow publish stage fails.
- `run.failed` is recorded.
- Reflection finalizer starts and completes.
- The run list shows `reflect completed` as the current stage, hiding the actual failed publish stage.
- A stale approval notification can remain in the inbox even though the associated run is terminal.

## Requirements

- Preserve the terminal run status after `run.completed`, `run.failed`, `run.blocked`, or `run.cancelled`.
- Record the workflow stage that was current when the terminal event occurred.
- Treat stages observed after the terminal event as finalizer stages.
- Web run summaries and details must show the terminal workflow stage as `currentStage`.
- Web run summaries and details may expose the latest finalizer stage separately.
- Approval inbox results must exclude approval notifications whose associated run is no longer `awaiting-approval`.

## Non-Goals

- Changing finalizer execution order.
- Removing finalizer events from timelines.
- Auto-resolving old notification files on disk.
