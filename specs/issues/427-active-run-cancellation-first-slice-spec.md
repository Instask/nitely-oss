# Issue #427 First Slice: Active Run Cancellation

## Problem

The Web `cancel-run` action previously made a run look terminal, but the active `runFlow` execution and its child process tree could continue. A late success path could then race with the operator's cancellation intent.

## In scope

- Carry an `AbortSignal` from Web run start dependencies into `runFlow`.
- Forward the signal into command stages, deterministic gate commands, hooks, and local agent runtimes.
- Terminate local command and agent process groups with SIGTERM and a bounded SIGKILL fallback.
- Record cancellation evidence with actor, reason, timestamps, affected stage/attempt, and cleanup metadata.
- Keep cancellation idempotent and prevent late `run.completed` evidence after `run.cancelled`.

## Out of scope for this slice

- Full run/stage token and cost budget admission.
- Retry/resume budget persistence and duplicate accounting guards.
- Billing or chargeback UI.

## Acceptance checks

- Local backend command cancellation kills a process tree and prevents orphan writes.
- Local backend agent cancellation propagates an active signal and records cleanup metadata.
- Web cancel-run aborts an active run controller and writes exactly one `run.cancelled` event.
- TypeScript compile passes.

