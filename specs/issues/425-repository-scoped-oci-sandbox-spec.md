# Issue #425 Specification: Repository-scoped OCI sandbox

GitHub issue: https://github.com/Instask/nitely/issues/425

## Problem

Nitely worktrees isolate Git state, but the `local` and `mise` execution
backends still run model- and repository-controlled processes with host process
authority and a broadly inherited environment. A worktree is not a security
boundary.

## First-slice objective

Add an opt-in `oci` execution backend that launches commands and agent runtimes
in a verified rootless Docker engine. The backend must fail before workload
execution whenever the requested policy cannot be represented by this slice.
The existing `local` and `mise` backends remain behavior-compatible trusted
execution modes.

## User-visible behavior

- `NITELY_EXECUTION_BACKEND=oci` selects the backend. `docker` is accepted as a
  compatibility alias and normalizes to `oci`.
- `NITELY_OCI_IMAGE` names an already-present runner image. Workloads use
  `--pull=never`; selecting OCI without an image is an actionable error.
- The Docker daemon must advertise rootless mode before the first workload is
  launched. A missing CLI, unreachable daemon, or rootful daemon fails closed.
- The container receives no host bind mounts except the canonical task
  worktree, the task run/artifact directory read-only, and the current explicit
  output directory read-write. The worktree alias inside the task-run mount is
  masked so path-scoped read policies cannot bypass `/workspace`.
- Host environment values enter the container only when their names appear in
  `NITELY_OCI_ENV_ALLOWLIST` or `NITELY_OCI_SECRET_ALLOWLIST`. Secret values are
  never placed in Docker arguments, policy evidence, or error messages.
- Network defaults to `none`, and advisory/implicit network policy is tightened
  to disabled. Explicit `restricted` network access with domains creates an
  internal-only workload network plus a sidecar CONNECT gateway attached to
  both that network and the external bridge. The workload has no direct
  external route; the gateway enforces the domain allowlist. `allowed` network
  access remains rejected because it has no bounded destination policy.
- Full-worktree or relative path allowlist mounts are enforced. Every allowlist
  path is canonicalized, must already exist, and must remain inside the
  worktree. Symlink and `..` escapes are rejected before Docker is called.
- Agent command `allow-list`, `deny-list`, and `none` policies are rejected. The
  OCI boundary cannot truthfully mediate all descendant runtime tool commands;
  `unrestricted` is accepted only inside the other enforced sandbox controls.
- CPU, memory, PID, tmpfs, maximum-file-size, captured-output, and timeout
  limits are applied. Containers use a read-only root filesystem, no Linux
  capabilities, no-new-privileges, an explicit rootless user-namespace
  identity, and an init process. The default container identity is `0:0`, which
  maps to the unprivileged rootless-daemon owner rather than host root.
- Every attempt uses both `docker run --rm` and a best-effort forced
  `docker rm -f` in `finally`, including failures, timeout, output overflow, and
  cancellation.
- Run evidence records the backend identity and redacted effective policy,
  including allowed environment/secret *names* but never values.

## Stable contracts

`SandboxPolicyV1` describes the container image, mount model, environment-name
allowlists, network mode, user-namespace identity, and resource limits.
`SandboxProcessRunner` is the
injected host-process seam used by unit tests and by the default spawning
implementation. `ExecutionBackend.describeExecution()` exposes a redacted
description for durable run evidence.

## Acceptance checks

1. Factory tests select `oci`/`docker` without changing `local`/`mise`.
2. Command-construction tests prove network-none, root filesystem, privilege,
   user, mount, environment-name, and resource flags.
3. Tests prove host secrets not allowlisted never enter arguments or evidence.
4. Tests reject canonical path/symlink escapes before workload execution.
5. Tests reject unsupported network and command policies before workload
   execution.
6. Tests prove cleanup after success, non-zero exit, thrown runner error,
   timeout, output overflow, and aborted execution.
7. A run-flow integration test records redacted backend/effective-policy
   evidence without requiring Docker.
8. Tests include an optional real-Docker direct-socket negative path, skipped
   unless explicitly enabled with a rootless daemon and runner image.
9. Targeted tests, the complete test suite, typecheck, and build pass on Node 24.

## Non-goals and explicit follow-ups

- Domain-restricted networking uses the OCI sidecar gateway; stronger L3/L4
  policy and hosted fleet isolation remain follow-ups.
- Aggregate bind-mount quota is a permanent non-goal, not a deferred slice:
  rootless Docker plus user namespaces cannot portably enforce project quota on
  bind-mounted worktrees. `NITELY_OCI_DISK_BYTES` remains fail-closed. Use
  per-file `NITELY_OCI_MAX_FILE_BYTES` and captured-output
  `NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES`.
- Command allow/deny mediation needs a runtime tool gateway rather than shell
  string inspection.
- In-container Git is out of scope permanently (host-side commits only), not a
  future opt-in. Linked-worktree Git metadata is never mounted; mounting the
  backing worktree `.git` would let a workload follow the gitdir pointer out of
  the sandbox. Host-side workspace create/commit is the only Git write path;
  Codex continues to receive `--skip-git-repo-check`; in-container Git commands
  may fail.
- Hosted fleets, Kubernetes, microVMs, image building/publishing, and
  autonomous merge/deploy are out of scope.
