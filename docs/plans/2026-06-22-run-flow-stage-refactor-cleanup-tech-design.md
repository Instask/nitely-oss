# Run Flow Stage Refactor And Cleanup Tech Design

## Goal

Reduce the highest-risk structural debt in `run-flow.ts` without changing run
behavior: guarantee injected agent-memory cleanup, document the shared stage
executor boundary, and fix local DX failures called out in #122.

## Design

### Cleanup Lifecycle

Introduce a scoped helper around injected agent-memory files:

- `createInjectedAgentMemoryScope(...)` prepares and injects files.
- The returned scope exposes `cleanup()` and tracks whether cleanup already ran.
- Fresh and resumed run paths create the scope once and clean it in a top-level
  `finally`.
- Existing branch-level cleanup calls are removed or reduced to calls through
  the idempotent scope.

This gives every throw, return, blocked state, and resume exit path the same
cleanup guarantee.

### Stage Executor Boundary

Define a shared `executeRunStage(...)` boundary in the design and code comments
before moving stage bodies wholesale. The safe migration order is:

1. Move lifecycle-only concerns, such as cleanup, outside the duplicated stage
   branches.
2. Extract pure helpers for common event/evidence writes.
3. Move one stage type at a time behind the shared executor, guarded by existing
   fresh-run and resume tests.

The first PR focuses on step 1 because it has the highest leak risk and the
lowest behavior-change risk.

### Vitest TMPDIR Setup

Add a Vitest setup file that resolves `process.env.TMPDIR`, `TMP`, and `TEMP`
through `realpathSync` when set. Configure `vitest.config.ts` to load it before
tests. This fixes macOS `/var` to `/private/var` path comparisons without
changing production code.

### Node Version

Add `.nvmrc` with `24` to match `package.json` engines and the `node:sqlite`
runtime requirement.

## Validation

- Unit or integration test for injected memory cleanup on a thrown agent path.
- Unit test for temp environment realpath normalization.
- Existing `agent memory files` run-flow tests.
- Full `pnpm run check` and `pnpm test:run`.

## Rollback

Revert the PR. Cleanup changes are internal lifecycle changes, `.nvmrc` is
metadata-only, and Vitest setup only affects test execution.
