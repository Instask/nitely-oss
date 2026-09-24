# Issue #583 — Shared stage execution lifecycle

## Problem

Fresh and resumed Runs both execute runtime-candidate fallback, but each path
previously owned its own stage cloning, attempt numbering, directory creation,
and `stage.started` metadata. That makes restart behavior drift when the two
paths evolve independently.

## Scope

`stage-execution.ts` owns candidate selection and candidate-attempt lifecycle:

- select the candidate runtime/model;
- compute the effective attempt;
- preserve the first attempt directory;
- create and announce later candidate attempts with resume and branch metadata;
- notify cancellation consumers when an attempt is selected.

Fresh/resumed Run code retains only path-specific context and stage-specific
admission, execution, failure, retry, hook, and event policy.

## Acceptance checks

- Agent and review-gate candidate fallback use the same helper.
- Fresh and resumed agent execution preserve attempt IDs, directories,
  `stage.started` payloads, and cancellation callback ordering.
- Candidate selection remains capability-checked before execution.
- Stage-execution tests cover resumed candidate metadata and the shared helper.

Out of scope: changing retry policy, attempt budgets, hooks, or execution
backend behavior.
