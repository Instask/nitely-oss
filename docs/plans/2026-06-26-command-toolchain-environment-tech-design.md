# Command Toolchain Environment Tech Design

Issue: #198

## Context

Nitely has a `LocalExecutionBackend` for command stages and a `MiseExecutionBackend`
that wraps local execution when a workspace declares `mise.toml`, `.mise.toml`,
or `.tool-versions`. Agent stages already receive backend environment values, but
command stages were launched without an explicit `env` and through `sh -lc`.

`sh -lc` can invoke login-shell behavior and source user profile files. That makes
command behavior depend on the host user's shell profile instead of Nitely's
resolved backend environment.

## Design

1. Pass the backend environment to command-stage child processes.
2. Run command stages with `sh -c` instead of `sh -lc`.
3. Detect command failures that report `python` as missing.
4. On that specific failure shape, create a temporary `python` shim outside the
   source worktree. The shim delegates to `python3`.
5. Retry the same command once with the shim directory prepended to `PATH`.
6. Return the retry result while preserving an stderr notice that the shim was
   applied.

## Why This Shape

- The command backend is the shared boundary for final tests and deterministic
  gates, so fixing it avoids flow-specific behavior.
- The compatibility shim is intentionally narrow: it addresses the common
  Python 2-era `python` command alias without pretending to resolve every
  missing tool.
- Keeping the shim outside the source worktree avoids source tree churn even for
  customer repositories that do not ignore `.nitely/`.
- `sh -c` makes command-stage behavior more deterministic and lets explicit
  backend or mise environment setup win over host profile side effects.

## Tests

- Add a local backend test where `PATH` contains `sh` and `python3` but no
  `python`; `python --version` succeeds through the compatibility shim.
- Assert the target repository remains clean after the shim is applied.
- Update mise tests to expect command wrapping around `sh -c`.
- Run typecheck, build, and full Vitest suite.
