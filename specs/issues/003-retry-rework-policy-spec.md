# Issue #3 Specification: Bounded Retry and Rework Policy

GitHub issue: https://github.com/Instask/nitely/issues/3

## Objective

Add deterministic retry and upstream rework behavior so Nitely can recover from
failed stages without losing auditability or looping indefinitely.

## Current State

`runFlow` executes stages once in topological order. A failed agent, command, or
publish step rejects the run immediately. There is no attempt projection,
failure context, retry budget, or rework decision path.

## Required Behavior

- Track stage attempts per stage.
- Apply a max attempt budget from stage `maxAttempts`, then flow
  `spec.maxAttempts`, then a default of 1.
- Retry failed `agent` and `command` stages while budget remains.
- Persist attempt directories as immutable records:
  `.nitely/runs/<run-id>/stages/<stage-id>/<attempt>/`.
- Include prior failure context in retry prompts.
- Add a policy function that can return `complete`, `retry`, `rework`, or
  `fail`.
- Validate rework requests before invalidating an upstream artifact.
- Fail clearly when attempts are exhausted.

## Non-Goals

- Multi-process scheduling.
- Parallel retries.
- LLM-controlled policy decisions.
- Full UI for retry history.

## Acceptance Criteria

1. A command stage that fails once and passes on retry completes the run.
2. A command stage that keeps failing stops after the configured attempt limit.
3. An agent stage receives previous failure context on retry.
4. Invalid rework targets fail deterministically.
5. Attempt directories remain immutable.
6. Tests cover retry success, retry exhaustion, and invalid rework.

