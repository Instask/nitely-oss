# Planning Approval States Tech Design

## Goal

Persist explicit planning artifact approval states and block implementation runs
until required generated planning artifacts are approved.

## Design

### State Model

Add `src/work-items/planning.ts` with:

- `PlanningArtifactKind = "spec" | "tech-design" | "tasks"`
- `PlanningState` union for the states from #113
- `PlanningDecision = "approve" | "reject" | "request_changes"`
- `PlanningApprovalEvent`
- `PlanningApprovalStatus`

The module owns transition validation, readiness derivation, and execution
guards. Keeping this outside the file-backed store lets legacy tasks, generic
work items, CLI paths, and Web API paths share one contract.

### Work Item Metadata

Extend `WorkItemRecord` with optional `planning?: PlanningApprovalStatus`.
Update the generic store to validate planning metadata on create/update. Existing
records with no `planning` remain executable.

### API And CLI Enforcement

Add `assertPlanningReadyForExecution(record)` and call it before run start from:

- Web work-item start path in `src/web/server.ts`
- CLI dependency path when a `workItemId` is supplied to `runFlow` or future
  work-item run commands
- Any generic helper that starts a work-item-backed run

The check is intentionally before `runFlow` so blocked implementation attempts
do not create run directories or stage evidence.

### Approval Updates

Add `applyPlanningDecision(status, input)` for API/CLI callers. It appends an
event and returns updated status. The first implementation can expose the helper
and store support with tests; Web Console controls can be added as a later UI
pass if the server does not yet have a route shape for generic work-item edits.

### Run Evidence

When a work item has planning metadata, copy a snapshot into run metadata under
`planningApproval`. Projected run and Web run details should expose that
snapshot. Evidence generation should include the same snapshot so reviewers can
see which planning state authorized execution.

## Validation

- Unit tests for state transitions and readiness.
- Store tests for persisted planning metadata and event history.
- Web server tests proving unapproved work items reject before `runFlow`.
- Run-flow tests proving planning snapshots are written to run metadata/evidence
  when supplied.
- Full `pnpm test:run` and `pnpm run check`.

## Rollback

Revert the PR. Existing work items without planning metadata are unchanged, and
new metadata is optional.
