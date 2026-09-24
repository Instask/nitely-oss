# Issue 164 Spec: Reflection Finalizers

## Problem

Built-in issue execution flows currently place `reflect` at the end of the
normal stage sequence. That captures successful publish/update paths, but it
does not run when the flow stops early because implementation, test, review, or
agent runtime execution fails or blocks.

## Goals

- Let flows mark an agent reflection stage as `alwaysRun`.
- Execute `alwaysRun` reflection after terminal success, failure, or blocker
  states when a workspace and runtime context are available.
- Provide finalizer context with run id, terminal status, completed stages,
  failure/blocker metadata, input sources, and change request metadata.
- Preserve the original run terminal status when reflection runs or skips.
- Record an explicit `reflection-skipped` artifact when the finalizer cannot
  run.
- Move built-in issue execution flows to the finalizer path.

## Non-Goals

- Add a general cleanup framework for every stage type.
- Retry reflection finalizers independently from normal stage policy.
- Upload reflection artifacts to a hosted control plane.

## Acceptance Criteria

- Flow schema accepts `alwaysRun` reflection stages.
- Runtime executes the finalizer after success, failed stages, review blockers,
  usage-limit blockers, and resumed/interrupted completion paths.
- Run evidence distinguishes generated `reflection` artifacts from
  `reflection-skipped` fallback artifacts.
- Built-in issue execution flows use `alwaysRun` for reflection.
