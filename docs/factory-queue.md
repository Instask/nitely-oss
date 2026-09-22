# Factory Queue

The Factory Queue is the durable boundary between upstream work intake and
Nitely execution. A candidate is evaluated and audited before the scheduler
can allocate a Run or workspace.

## State model

```text
candidate → evaluating → rejected | duplicate | needs_human | eligible
eligible → queued → running → completed | blocked | needs_human
```

Queue state is stored per repository in `.nitely/factory-queue/queue.json`.
The optional policy is `.nitely/factory-queue-policy.json` and uses
`nitely.factory-queue-policy.v1`.

The first intake adapter is GitHub Issues. Existing webhook intake keeps the
source snapshot and creates a durable candidate; it does not create a Run.
Explicit candidates can be submitted through `POST /api/factory-queue/candidates`.

Eligibility is deterministic: labels, work-item type, upstream state,
assignees, estimated size, path families, planning approvals, and risk ceiling
are evaluated without an expression language. The source identity is hashed
into a stable candidate ID, so source revisions update one candidate instead
of creating a parallel record. Existing running work or an open change request
is classified as `duplicate`.

Dispatch is bounded by `maxConcurrentRuns`, can be paused per repository, and
only passes dequeued work-item IDs to the scheduler. Queue decisions and
dispatch results are recorded in the existing event store as
`factory.candidate.evaluated` and `factory.queue.dispatched`.

The Web Console Scheduler screen exposes candidate status, reason, repository,
and counts. The API also exposes repository-level queue state for operators.
