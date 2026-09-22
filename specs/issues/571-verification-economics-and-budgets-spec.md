# Issue 571: Verification Economics and Bounded Verification Budgets

## Decision

Verification order remains explicit in the Flow. Nitely records cost classes,
accounts for verification attempts and runtime cost, and stops conservatively
when a declared bound is exhausted. It does not reorder or optimize stages.

## Contract

`spec.verificationBudget` may declare:

- `maxAgentAttempts`
- `maxJudgeAttempts`
- `maxCiRuns` (expensive or unclassified command-stage verification runs)
- `maxRuntimeCostUsd`

Stage declarations may add `costClass: cheap | moderate | expensive | human`.
Attempt counts are reconstructed from persisted `stage.started` events, so
retries and resume cannot reset the ledger. Unknown runtime cost fails closed
for a declared cost budget. Admission exhaustion emits `budget.exceeded` with
the dimension, phase, cap, consumed value, remaining value, and blocker text.

Run projection and Web detail expose consumed/remaining values and the
expensive stages not started after a failed earlier stage. Evidence includes
the same snapshot for offline review.

## Pilot

`flows/pilot-judge-implement-pr.json` demonstrates the intended explicit
ladder: cheap static checks, targeted verification, Judge, then expensive full
CI capped at two runs. No automatic ordering or model-cost optimizer is part of
this issue.

## Verification

Coverage includes schema acceptance, event projection, retry enforcement,
resume-safe accounting through persisted events, and conservative unknown-cost
handling inherited from the hard cost budget path.
