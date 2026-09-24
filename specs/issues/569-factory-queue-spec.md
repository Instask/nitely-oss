# Issue #569 — Factory Queue

## Contract

Nitely must persist candidate intake separately from Runs. Candidate identity
is `source.type + source.identity` and is stable across source revisions.

An evaluation returns exactly one of `eligible`, `rejected`, `duplicate`, or
`needs_human`, with human-readable reasons. `eligible` candidates become
`queued` only when repository policy has `autoQueue: true`. Policy is limited
to deterministic labels, work-item types, upstream state, assignees, change
size, path families, planning approvals, risk class, and concurrency.

## Safety invariants

1. GitHub intake preserves the normalized source snapshot.
2. Candidate persistence is atomic and restart-safe.
3. No scheduler candidate IDs are admitted until dispatch dequeues them.
4. A running task or open change request for the same source is duplicate work.
5. A failed dispatch returns candidates to `queued` rather than losing them.
6. Pause prevents dispatch while retaining candidates.
7. Evaluation and dispatch are auditable through the existing event store.

## Operator surface

- `GET /api/factory-queue` returns repository queue documents and status counts.
- `POST /api/factory-queue/candidates` evaluates an explicit candidate.
- `POST /api/factory-queue/pause` pauses or resumes one repository.
- `POST /api/factory-queue/dispatch` dispatches queued candidates subject to
  repository concurrency policy.

The Web Console renders the same candidate details and counts on the Scheduler
screen.
