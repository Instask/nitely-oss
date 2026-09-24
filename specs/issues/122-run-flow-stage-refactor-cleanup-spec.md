# Issue 122 Run Flow Stage Refactor And Cleanup Spec

## Background

`src/run/run-flow.ts` contains two large execution paths, `runFlow` and
`resumeRun`, that both dispatch stage types and both manage agent-memory file
injection cleanup. The current behavior is covered by tests, but the duplicated
dispatch and scattered cleanup calls make future drift likely.

## User Stories

- **US-001:** As a maintainer, I can add cross-cutting run behavior without
  updating two independent stage dispatch implementations.
- **US-002:** As a user, I can trust that injected agent-memory files are removed
  even when a run fails, blocks, resumes, or exits early.
- **US-003:** As a contributor on macOS, I can run the Vitest suite without
  manually overriding `TMPDIR`.
- **US-004:** As a contributor, I can discover the required Node major version
  before dependency install or test execution.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a stage type implementation is changed, when both
  fresh runs and resumed runs execute that stage type, then shared executor code
  is used instead of two independent copies.
- **US-002 / SC-002:** Given agent memory files are injected, when execution
  throws from an agent path, then injected `AGENTS.md` and `CLAUDE.md` files are
  removed before the run exits.
- **US-002 / SC-003:** Given agent memory files are injected, when execution
  blocks on provider usage limits or output contracts, then cleanup still runs.
- **US-003 / SC-004:** Given `TMPDIR` resolves through a symlink, when Vitest
  starts, then the process temp directory environment is normalized to a real
  path.
- **US-004 / SC-005:** Given a developer opens the repo, when they use a Node
  version manager, then Node 24 is selected from repository metadata.

## Functional Requirements

- **FR-001:** Agent-memory cleanup must be centralized behind a scoped helper or
  `try/finally`, not scattered across individual exit branches.
- **FR-002:** Cleanup must be idempotent so multiple callers cannot remove the
  same injected files twice.
- **FR-003:** Stage execution must have a documented shared executor boundary
  that fresh and resumed runs can migrate through incrementally.
- **FR-004:** macOS `TMPDIR` normalization must happen automatically in Vitest
  setup and must not affect non-test runtime behavior.
- **FR-005:** The repository must include `.nvmrc` set to Node 24.
- **FR-006:** Existing run behavior, evidence, event projection, redaction, and
  resume semantics must remain unchanged.

## Success Criteria

- **SC-006:** A targeted test proves injected memory files are cleaned up on a
  thrown execution path.
- **SC-007:** A targeted test proves temp directory normalization resolves
  symlinked `TMPDIR`.
- **SC-008:** Existing run-flow regression tests remain green.
- **SC-009:** `pnpm run check` and `pnpm test:run` pass.

## Edge Cases And Failure Behavior

- Cleanup failures should not hide the original run failure unless cleanup is
  the only failing operation.
- Missing injected files are treated as already cleaned up.
- Non-macOS environments with already-real `TMPDIR` remain unchanged.
- The stage executor migration can be staged as long as cleanup hardening is
  fully enforced in the first slice.

## Assumptions

- This issue is structural debt paydown; the first implementation should avoid
  behavior changes.
- A full extraction of every stage type can happen incrementally after cleanup
  lifecycle safety is in place.

## Out Of Scope

- Changing stage semantics.
- Changing artifact, evidence, or event schemas.
- Replacing the execution backend abstraction.
