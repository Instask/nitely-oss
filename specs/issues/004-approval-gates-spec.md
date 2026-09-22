# Issue #4 Specification: Interactive Approval Gates

GitHub issue: https://github.com/Instask/nitely/issues/4

## Objective

Add persisted approval gates so protected actions such as publishing can pause
until a human explicitly approves or denies them.

## Current State

The flow schema has an `approval` stage type, but `runFlow` treats approval as
completed immediately. Publish stages run without an approval request.

## Required Behavior

- Persist approval requests under the run directory.
- Approval requests have stable IDs, stage IDs, status, prompt, and timestamps.
- `approval` stages pause the run.
- `publish-change` stages require approval by default before pushing.
- Add CLI commands:
  - `nitely approvals <run-id>`
  - `nitely approve <run-id> <approval-id>`
  - `nitely deny <run-id> <approval-id>`
  - `nitely resume <run-id>`
- Approved runs resume from the paused stage.
- Denied approvals fail the run with a clear message.

## Non-Goals

- Web UI.
- Multi-user authorization.
- Notification delivery.
- Auto-merge.

## Acceptance Criteria

1. A flow with an approval stage pauses and writes an approval request.
2. `nitely approvals` lists pending approvals.
3. `nitely approve` marks the request approved.
4. `nitely deny` marks the request denied.
5. `nitely resume` continues after approval.
6. Publish does not push before approval.

