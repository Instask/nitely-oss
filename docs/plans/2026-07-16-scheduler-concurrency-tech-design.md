# Controlled Scheduler Concurrency Technical Design

Spec: `specs/issues/428-scheduler-concurrency-spec.md`

## Existing patterns to reuse

- `evaluateWorkItemRunStarts` remains the eligibility and dependency boundary.
- `admitWorkItemRun` remains the durable single-owner/CAS boundary.
- `settleWorkItemRun` and terminal Run events remain authoritative outcomes.
- The outer scheduler loop continues to reload persisted graph state after a
  runnable batch settles.

## Design

Add `maxConcurrentTasks?: number` to `RunSchedulerOnceInput`, normalized once at
the start of a cycle. Default it to `1` and cap it at a conservative constant.

Extract the existing per-runnable-item body into a function whose only mutable
shared outputs are the existing summary and attempted set. Execute that function
with a small index-based worker pool. JavaScript's single-threaded mutation
semantics make individual set/array operations atomic, while durable admission
protects cross-process ownership.

Before returning a summary, normalize task-id arrays according to the original
scheduler candidate rank. This prevents completion timing from becoming an API
contract. Diagnostic maps remain keyed by Work item id.

Each runnable item is an error-ownership boundary after the evaluated and
prepared-candidate invariants have been checked. Preparation finalization,
admission, runner dispatch, and settlement exceptions belong to that Work item:
the scheduler marks it attempted for the current cycle, records a bounded
`scheduler_task_processing_failed` diagnostic in `taskErrors`, and lets that
worker claim the next queue entry. Raw exception text is deliberately excluded
from API and CLI summaries. Missing evaluated input or prepared candidate data
is a batch invariant violation and still rejects the cycle because continuing
would make scheduler bookkeeping unsafe.

Dependencies are not locked manually: a dependant is ineligible in the current
evaluation batch and becomes eligible only after the outer loop reloads the
settled graph. Repository/path conflict keys remain a follow-up because the
current Work item model does not declare a reliable path ownership contract.

## Failure and rollout behavior

- Invalid limits fail before listing/admitting candidates.
- A worker catches and settles its own Run error through the existing path.
- A task-local exception outside the runner is attributed in `taskErrors`; it
  does not retire the worker or strand later runnable items.
- Batch invariant violations still reject the pool because scheduler
  bookkeeping is unsafe.
- Default concurrency one preserves existing deployments.

## Test plan

Add focused scheduler tests that first fail against the serial loop:

- explicit overlap at concurrency two;
- maximum in-flight bound;
- default serial compatibility;
- dependency serialization;
- deterministic summaries after forcing exact `d -> c -> b -> a` completion;
- failure isolation with the independent Run durably settled as completed;
- task-local exception attribution while the worker drains later work;
- invalid configuration with the Work item, admission database, and event store
  unchanged.

Run `test/scheduler/run.test.ts`, TypeScript check, build, and the Linux full
suite before opening the PR.
