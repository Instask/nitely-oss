# Issue 198: Command Toolchain Environment

## Problem

Nitely final command/test stages can fail under a different toolchain environment
than the implementation agent used. In the reported Capital Autopilot run, the
implementation stage verified `make test` by adding a temporary `python` shim to
`PATH`, but the final command stage later ran plain `make test` and failed with
`python: not found`.

This makes a run look successful during implementation and then fail at the
terminal test boundary for an environment mismatch rather than a code problem.

## Goals

- Command and deterministic gate stages must execute with the backend's resolved
  environment.
- Command stages must avoid login-shell profile mutation that can overwrite the
  resolved environment.
- If a command fails because `python` is missing but `python3` is available, the
  backend should retry once with an explicit workspace-local compatibility shim.
- The retry must leave an observable stderr note so operators can see that Nitely
  repaired a project toolchain alias mismatch.
- The shim must live outside the source worktree so it cannot be committed to
  customer repositories.

## Non-Goals

- General package manager or runtime installation.
- Inferring arbitrary environment edits from agent transcripts.
- Changing flow schema or requiring projects to add a toolchain file.

## Acceptance Criteria

- A command stage launched with a custom backend `PATH` uses that `PATH`.
- Command stages use a non-login shell so user profile scripts do not rewrite
  backend-provided environment values.
- `python --version` succeeds in a workspace where only `python3` exists on the
  backend `PATH`, by using a temporary `python` compatibility shim.
- Applying the shim leaves the target repository with a clean git status.
- Existing mise command wrapping continues to work and wraps `sh -c`.
- Full test suite passes.
