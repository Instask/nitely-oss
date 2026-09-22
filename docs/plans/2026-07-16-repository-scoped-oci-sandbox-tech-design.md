# Repository-scoped OCI sandbox technical design

**Issue:** https://github.com/Instask/nitely/issues/425

**Goal:** Deliver an opt-in, rootless, fail-closed OCI execution boundary while
preserving the trusted `local` and `mise` modes.

**Architecture:** Reuse `LocalExecutionBackend` only for Git worktree creation
and commits. A new `OciExecutionBackend` owns policy translation, canonical
mount construction, runtime launch, rootless-engine verification, timeout and
abort handling, cleanup, and redacted policy description. Docker is an
implementation detail behind an injected `SandboxProcessRunner`, so unit and
run-flow integration tests never require a daemon.

## Contract and files

- `src/run/execution/types.ts`
  - add optional abort signals to execution calls;
  - add `ExecutionBackendDescription` and optional `describeExecution()`.
- `src/run/execution/process-runner.ts`
  - spawn a detached Docker CLI process;
  - cap captured stdout/stderr;
  - terminate the process group on timeout, abort, or output overflow.
- `src/run/execution/oci.ts`
  - define `SandboxPolicyV1` and defaults;
  - translate capability policies into mount/network enforcement or reject;
  - canonicalize all bind sources and generate Docker arguments;
  - launch commands/agents and always force-remove the named container;
  - expose only redacted effective policy metadata.
- `src/run/execution/backend.ts`
  - normalize `oci` and `docker`, parse OCI environment configuration, and
    preserve local/mise behavior.
- `src/run/run-flow.ts`
  - render `ExecutionBackendDescription` into evidence;
  - allow the backend to translate host paths in the actual persisted agent
    prompt so `/nitely/output` and `/nitely/run` are truthful in-container paths.
- `test/run/execution/oci.test.ts`
  - injected-runner unit tests for policy, mounts, environment, limits,
    rootless preflight, process results, cleanup, and failures.
- `test/run/execution/process-runner.test.ts`
  - real local child-process tests for timeout, abort, and output overflow.
- `test/run/run-flow.test.ts`
  - one injected-OCI command-flow test for durable redacted evidence.

## Policy translation

The default deny-all container always has:

- `--pull=never`, `--read-only`, `--network=none`, `--cap-drop=ALL`,
  `no-new-privileges`, an explicit user-namespace identity, `--init`,
  `--ipc=none`, and `--rm`;
- bounded CPU, memory/swap, PIDs, tmpfs, file size, captured output, and host
  wall-clock time;
- a task-run artifact mount read-only and one attempt output mount read-write;
- no host HOME, Docker socket, SSH agent, cloud config, or sibling repository.

An empty repository read allowlist mounts the full worktree read-only. An empty
worktree write allowlist upgrades that mount to read-write. Non-empty path
allowlists use a tmpfs `/workspace` root and nested canonical bind mounts; a
path present in the write list is mounted read-write. A missing path is rejected
instead of widening its parent mount.

The task-run artifact bind contains the worktree directory in the host layout,
so that alias is covered by a read-only tmpfs inside `/nitely/run`. This keeps
artifact paths stable without allowing a restricted read policy to reach the
repository through a second mount path.

`advisory`/implicit network is safely tightened to `none`; explicit disabled is
also supported. A restricted network with domains creates a per-workload
Docker bridge marked `--internal`, binds the host-side CONNECT gateway to that
network's gateway address, and runs the workload only on that network. The
workload therefore has no direct external route; proxy variables select the
allowlisted gateway, but are not the enforcement boundary. `allowed` rejects
before the runner receives a `docker run` call. Agent command modes other than
`unrestricted` reject for the same reason. Runtime/model allowlists continue to
use the existing orchestrator check.

The default identity is container `0:0` under a verified rootless daemon. In
rootless Docker that identity maps to the unprivileged daemon owner, which can
write host-user-owned bind mounts without granting host root authority. An
explicit non-negative UID/GID is supported for images with a compatible
user-namespace and bind-mount ownership setup.

In-container Git is out of scope permanently. Backing linked-worktree Git
metadata is never mounted into the workload; this is the supported model, not a
future opt-in. The `.git` pointer file may be visible but its host-only target
is not. Mounting the backing worktree `.git` would let a workload follow the
gitdir pointer out of the sandbox. Codex therefore receives
`--skip-git-repo-check`; in-container Git commands may be unavailable.
Host-side workspace create/commit through `LocalExecutionBackend` is the only
Git write path.

## Environment and secrets

The Docker CLI control process may use its normal host environment to contact
the local daemon. The workload receives only `--env NAME` for validated names
in the two allowlists plus Nitely-owned non-secret attempt metadata with
container paths. Because Docker expands name-only entries from the client
environment, secret values never appear in argv. Evidence contains sorted names
and the literal marker `values omitted`.

## Cleanup and errors

Each workload gets a sanitized unique container name. After `docker run`
returns or throws, `docker rm -f <name>` runs in `finally`. Cleanup failure is a
hard error when the workload otherwise succeeded; when both fail, the workload
error remains primary and cleanup never masks it. The default
process runner kills the detached Docker CLI process group on timeout, abort, or
captured-output overflow; forced container removal then cleans the daemon-side
process tree.

## TDD sequence

1. RED factory selection; GREEN backend registration/config validation.
2. RED secure command construction/mount tests; GREEN policy builder.
3. RED env/secret and unsupported-policy tests; GREEN fail-closed translation.
4. RED lifecycle/cleanup tests; GREEN backend execution methods.
5. RED timeout/abort/output-runner tests; GREEN default runner.
6. RED run evidence test; GREEN backend description rendering.
7. Refactor only while targeted tests remain green, then run the complete suite,
   typecheck, and build.

The optional daemon-backed write test runs only when
`NITELY_TEST_ROOTLESS_DOCKER=1` and `NITELY_OCI_TEST_IMAGE` names a preloaded
image.

## Rollout and risk

OCI remains opt-in. Selecting it requires an explicit image and a verified
rootless daemon. Existing installations therefore do not change behavior.
Aggregate bind-mount disk quota is a permanent non-support, not a residual
slice gap: rootless Docker plus user namespaces cannot portably enforce
project quota on bind-mounted worktrees. `NITELY_OCI_DISK_BYTES` remains
fail-closed. Operators should use `NITELY_OCI_MAX_FILE_BYTES` and
`NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES`. Restricted network and command
allowlists likewise stop the run with actionable errors.
In-container Git remains out of scope permanently (host-side commits only);
there is no opt-in Git metadata mount.
