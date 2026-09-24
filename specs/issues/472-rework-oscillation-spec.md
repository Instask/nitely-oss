# Issue 472: Rework oscillation fail-closed

## Problem

Per-stage `maxAttempts` bounds retries on one stage. It does not stop a
rework pair from thrashing: review sends work back to implement, implement
re-triggers the same review failure, and the pair burns the remaining budget.

## Signal

A proposed rework is oscillating when either:

- the same `fromStage → targetStage` edge appears **3** times (including the
  proposal), or
- the trailing edges form **2** full A↔B cycles (**4** alternating reverse
  edges).

A single legal rework is below both thresholds and must still succeed.

## Runtime

Detection is pure in-process computation at the stage-execution / policy
seam. `decideStagePolicy` returns `{ action: "fail", reason }` instead of
another rework. Diagnostics (`from`, `to`, `count`, `window`, `edges`) ride
on the existing `orchestrator.decision` payload and the `run.failed` reason.
No new event type.

Resume reconstructs prior edges from `stage.rework.requested` so a restarted
run cannot reset the window.

## Non-goals

- A flow-level LLM meta controller
- Graph rewriting or new rework edges

## Acceptance

- A synthetic A↔B rework loop terminates with `fail` before unbounded cost
- A normal single rework still completes within `maxAttempts`
