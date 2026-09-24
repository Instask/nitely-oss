# Nitely Runner Images

The OCI execution backend runs with `--pull=never`, so the image named by
`NITELY_OCI_IMAGE` has to be present on the host before a run starts. This
directory is the in-repo baseline for building one.

## Variants

| Variant | Contains | Use for |
| --- | --- | --- |
| `command` | Debian slim, Node 24, pnpm, git, bash, ca-certificates | offline `command` stages |
| `agent` | `command` plus the agent CLIs you name | `agent` stages and review gates |

The `agent` variant installs nothing by default. Name the CLIs you want and the
versions you want them pinned at, so the image is yours rather than a moving
target.

## Build

```bash
# command baseline
docker/runner/build.sh --tag nitely-runner:local

# agent variant with the CLIs you use
docker/runner/build.sh \
  --variant agent \
  --tag nitely-runner-agent:local \
  --agent-clis "@openai/codex@latest @anthropic-ai/claude-code@latest"

# agent variant plus the Debian packages the target repository's verification
# needs; chromium is the usual one (browser-backed tests find /usr/bin/chromium)
docker/runner/build.sh \
  --variant agent \
  --tag nitely-runner-agent:local \
  --agent-clis "@anthropic-ai/claude-code@latest" \
  --apt "chromium"

# build, then smoke the image the way Nitely runs it
docker/runner/build.sh --verify
```

The image is where a repository's verification toolchain lives: CI runners
come with a browser, `mise`, and a large `/tmp`; the slim base image comes
with nothing beyond node, pnpm, git, and bash. When a command stage fails
inside the sandbox on a tool the suite takes for granted, add the package
here rather than skipping the test.

`--print` shows the engine argv without running it. `--engine podman` builds
with Podman. `--node-image` and `--pnpm-version` pin the base and the pnpm
release; the defaults track this repository's `engines.node` and
`packageManager`.

`--verify` runs the image read-only, with `--network=none`, an unprivileged
uid, and `/tmp` on tmpfs, then checks that `sh`, `git`, `bash`, `node`, and
`pnpm` all resolve. That is the shape Nitely itself launches, so a build that
verifies is a build that will start. The image includes `git`, but linked-worktree
Git metadata is never mounted into the workload. Host-side workspace
create/commit is the only Git write path; in-container `git` against the
workspace repo may fail, and Codex continues to receive `--skip-git-repo-check`.
Mounting the backing worktree `.git` would let a workload follow the gitdir
pointer out of the sandbox.

Nitely resolves `NITELY_OCI_IMAGE` once before each normal run and records the
immutable image ID or repo digest in run evidence and `reproducibility.json`.
Tags remain useful for local development, but shared or enterprise runners
should configure an approved digest-pinned reference (for example,
`registry.example/nitely-runner@sha256:<digest>`) and retain the corresponding
image approval record.

## Use it

```bash
NITELY_EXECUTION_BACKEND=oci \
NITELY_OCI_IMAGE=nitely-runner-agent:local \
NITELY_OCI_ENV_ALLOWLIST=LANG,CI \
NITELY_OCI_SECRET_ALLOWLIST=OPENAI_API_KEY \
NITELY_OCI_NETWORK_ALLOWLIST=api.openai.com,chatgpt.com \
nitely run flows/implement-spec-bootstrap.json --repo .
```

### Allowlist tips

- `NITELY_OCI_ENV_ALLOWLIST` and `NITELY_OCI_SECRET_ALLOWLIST` carry **names**,
  not values. Nothing enters the container unless its name is listed and the
  host process actually has it set. Evidence records the names only.
- Start from the runtime's `requiredEnv`. Codex needs its OpenAI credential,
  Claude needs `ANTHROPIC_API_KEY`, GLM accepts `NITELY_GLM_API_KEY`,
  `GLM_API_KEY`, or `ZHIPUAI_API_KEY`. A missing name fails preflight with the
  names it wanted, so you can add exactly those.
- Keep `LANG` and `CI` in the plain env allowlist and credentials in the secret
  allowlist. Only secret-allowlist values are redacted out of captured output.
- Every agent runtime in the built-in registry declares `networkAccess:
  "required"`, so an agent stage will not start under `--network=none`. Set
  `NITELY_OCI_NETWORK_ALLOWLIST`, or stage `capabilities.network` with
  `mode: "restricted"` and `domains`, and Nitely creates an internal-only
  workload network plus an HTTP CONNECT allowlist sidecar attached to that
  network and the external bridge. It injects
  `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`; a CLI that ignores proxy environment
  variables still cannot bypass the network boundary.
- Command stages need no egress. Leave them on the deny-all default.

### Sizing the sandbox for a real test suite

The defaults (1 CPU, 1 GiB memory, 128 pids, 256 MiB `/tmp`, `/tmp` mounted
`noexec`, 10 minute timeout) suit a single agent turn or a small command. A
repository's full test suite usually needs more, and Nitely's own suite is the
worked example: vitest workers exceed 128 pids, fixtures overflow 256 MiB of
tmpfs, and tests that write helper scripts or shims to `os.tmpdir()` and run
them fail with `EACCES`/exit 126 under `noexec`.

```bash
NITELY_OCI_PIDS=1024
NITELY_OCI_TMPFS_BYTES=1073741824
NITELY_OCI_TMPFS_EXEC=true      # /tmp mounted rw,exec,nosuid,nodev
NITELY_OCI_TIMEOUT_MS=3600000
```

`NITELY_OCI_TMPFS_EXEC` is an explicit opt-in recorded in evidence
(`tmpfs.exec`); the engine's own tmpfs default is `noexec`, so the flag has to
be spelled out. The workspace bind mount is already writable and executable
for command stages, so this widens the sandbox by one directory, not by a
class.

## No credentials in the image

Nothing in this Dockerfile bakes a credential, and nothing should. Image layers
are readable by anyone who can pull the tag, so a token added at build time — as
an `ARG`, an `ENV`, a `COPY`ed config file, or by running a `login` command — is
published with the image even if a later layer deletes the file.

Agent CLIs read their tokens from the environment at run time. That is what
`NITELY_OCI_SECRET_ALLOWLIST` is for. The `agent` target asserts the point: the
build fails if `/root/.codex/auth.json`, `/root/.claude.json`, or
`/root/.config/gh/hosts.yml` exists in the image.

The build script never passes a credential to the engine either. If you add a
private registry, use a build secret mount rather than a build argument.

## Read-only by design

Nitely runs this image read-only, as an arbitrary uid, with `/tmp` on tmpfs and
`HOME=/tmp/nitely-home`. The image therefore points every tool cache
(`PNPM_HOME`, `XDG_CACHE_HOME`, `npm_config_cache`, …) under `/tmp`. A tool that
insists on writing somewhere else will fail at run time, not at build time — so
add it to `--verify` when you add it to the image.

Raise `NITELY_OCI_TMPFS_BYTES` when a stage's install or build needs more than
the 256 MiB default.

## Keeping it fresh

There is no CI in this repository yet, so nothing rebuilds this Dockerfile on a
schedule. `test/docker/runner-image.test.ts` guards the parts that rot quietly:
the variants the build script accepts, the caches the image relocates, and the
absence of anything credential-shaped. Rebuild with `--verify` after changing
the Dockerfile.
