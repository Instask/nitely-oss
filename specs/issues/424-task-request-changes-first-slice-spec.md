# Issue 424: Task Request Changes First Slice

## Problem

Completed Tasks with a published change request have no governed Task-detail
feedback action. Operators can start another run, but they cannot persist a
typed refinement instruction, review the proposed execution route, and launch a
linked same-PR rework run from the Task surface.

## Scope

This slice implements implementation-scoped Task rework requests for completed
Tasks that already have a change request URL.

In scope:

- durable task-scoped rework request records;
- idempotent create and confirm operations;
- immutable instruction, actor, planning baseline, prior run, and change-request
  target metadata;
- confirmation before execution starts;
- linked child run started against the existing PR target with `workItemId` and
  `priorRunId`;
- Task detail API and Web Console rendering for request status/history.

Out of scope for this slice:

- spec, technical-design, and workflow planning refinements;
- queued requests while a Task is running;
- free-form Task chat;
- provider-thread continuity;
- automatic merge or deployment.

## Acceptance Checks

- A completed Task with a change request exposes `canRequestChanges` and a
  rework-request list in Task detail.
- Creating an implementation request persists one durable typed request with an
  actor, timestamp, Task id, planning baseline, prior run id, idempotency key,
  route, instruction, and change-request URL.
- Duplicate create calls with the same idempotency key return the same request.
- Confirming a pending request starts exactly one child run with `workItemId`,
  `priorRunId`, materialized rework inputs, and `changeRequestTarget`.
- Duplicate confirm calls return the existing linked run instead of starting a
  second run.
- Running Tasks reject request creation with an actionable message.
- Unsupported planning/workflow routes fail closed with an explicit first-slice
  limitation.
