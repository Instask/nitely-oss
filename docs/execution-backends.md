# Execution Backends

Where a run executes: the host, a mise toolchain, or an OCI sandbox. Commands are run from the repository root. How to start a run is in [running-flows.md](running-flows.md).

Nitely defaults to the `local` execution backend: each run uses a host git
worktree and executes command stages and agent CLIs directly on the host.

For repositories that declare per-project toolchains, Nitely can use a
lightweight `mise` backend:

```bash
NITELY_EXECUTION_BACKEND=mise pnpm dev -- web --home . --host 127.0.0.1 --port 4173
nitely run flows/implement-spec-bootstrap.json --repo . --backend mise
```

The `mise` backend looks for `mise.toml`, `.mise.toml`, or `.tool-versions` in
the execution worktree. When one is present, it runs `mise install` once for the
workspace and then executes command stages and agent runtimes through
`mise exec -- ...`. Repositories without a toolchain file continue to run like
the local backend. Workspaces remain normal host git worktrees, so this backend
does not provide Docker-style isolation; it only provisions the declared
toolchain. Set `NITELY_MISE_COMMAND` if `mise` is installed under a non-standard
command name or path. Missing `mise` or failed runtime installation produces an
actionable run error before the stage command is executed.

For an opt-in process boundary, Nitely can run commands and agent CLIs in an
already-present image through a verified rootless Docker daemon:

```bash
NITELY_EXECUTION_BACKEND=oci \
NITELY_OCI_IMAGE=nitely-runner:local \
NITELY_OCI_ENV_ALLOWLIST=LANG,CI \
NITELY_OCI_SECRET_ALLOWLIST=OPENAI_API_KEY \
NITELY_OCI_NETWORK_ALLOWLIST=api.openai.com,api.anthropic.com \
nitely run flows/implement-spec-bootstrap.json --repo .
```

**Build the runner image first.** `--pull=never` means the image has to be on
the host before a run starts. `docker/runner/` holds the in-repo baseline:

```bash
# command baseline: node, pnpm, git, bash
docker/runner/build.sh --tag nitely-runner:local --verify

# agent variant: the same, plus the agent CLIs you name and pin
docker/runner/build.sh --variant agent --tag nitely-runner-agent:local \
  --agent-clis "@openai/codex@latest @anthropic-ai/claude-code@latest"
```

Each OCI run resolves the configured image tag to an immutable local image ID
or repo digest before launch and records both identities in evidence. For
shared or enterprise runners, prefer an approved digest-pinned reference such
as `registry.example/nitely-runner@sha256:<digest>`.

`--verify` runs the freshly built image read-only, with `--network=none`, an
unprivileged uid, and `/tmp` on tmpfs, the way Nitely launches it. The agent
target installs nothing by default, so the CLI set and its versions are yours.
No credential is baked into either variant: agent CLIs read their tokens from
the environment at run time through `NITELY_OCI_SECRET_ALLOWLIST`, and the agent
target fails the build if an agent credential file is present in the image. See
`docker/runner/README.md` for the allowlist and egress notes.

`docker` is accepted as a backend alias. The OCI backend uses `--pull=never`,
drops all capabilities, applies no-new-privileges and a read-only root
filesystem, and mounts only capability-scoped worktree paths, read-only run
artifacts, and the current attempt output. The image must contain `sh` plus
every selected agent runtime CLI. Host environment values enter the workload
only when their names appear in `NITELY_OCI_ENV_ALLOWLIST` or
`NITELY_OCI_SECRET_ALLOWLIST`; evidence records those names, never their values.
The Docker client itself receives only those explicitly allowed values plus
`PATH` and a fixed local `unix://` endpoint. Remote `DOCKER_HOST` values and
`DOCKER_CONTEXT` are rejected. The endpoint must be a canonical Unix socket
owned by the Nitely process uid, and the daemon must report both rootless mode
and cgroup v2 without warnings that CPU, memory, swap, cpuset, or PID limits are
unsupported.

**Network policy (default deny-all):** command stages and offline agents keep
`--network=none`. Built-in agent runtimes that require egress
(Codex/Claude/GLM/Grok/Pi) need an allowlist:

- Set `NITELY_OCI_NETWORK_ALLOWLIST` to a comma-separated domain list
  (`api.openai.com`, `*.anthropic.com`, …), and/or
- Set stage `capabilities.network` to `mode: "restricted"` with `domains: [...]`.

When an allowlist is active, Nitely creates an **internal-only Docker network**
(`docker network create --internal`) and a sidecar HTTP CONNECT gateway. The
sidecar joins both that internal network and the external bridge; the workload
joins only the internal network. Proxy environment variables
(`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`) point at the sidecar so approved
CLIs can reach allowlisted hosts, but they are not the enforcement boundary: a
process that ignores them has no direct Internet route. Non-allowlisted CONNECT
requests receive `403`. If the host cannot create that topology, the run fails
closed. Evidence records `allowlist(domains) via http-connect-allowlist`
without secret values. Open `network.mode: "allowed"` remains fail-closed.
`--network=host` and workload attachment to docker bridge are never used.

Container UID/GID default to `0:0` inside the rootless user namespace. This maps
to the unprivileged daemon owner on the host and preserves bind-mount writes; it
does not grant host root authority. Advanced images can override them with
`NITELY_OCI_UID` and `NITELY_OCI_GID`. Limits can be tuned with
`NITELY_OCI_CPUS`, `NITELY_OCI_MEMORY_BYTES`, `NITELY_OCI_PIDS`,
`NITELY_OCI_TMPFS_BYTES`, `NITELY_OCI_MAX_FILE_BYTES`,
`NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES`, and `NITELY_OCI_TIMEOUT_MS`.

**Agent command policy:** a stage declares which commands its agent may spawn
with `capabilities.commands`:

```json
{
  "commands": {
    "mode": "allow-list",
    "allow": ["pnpm test*", "git"],
    "deny": ["git push*"],
    "advisory": true
  }
}
```

`mode` is `unrestricted`, `allow-list`, `deny-list`, or `none`. A rule is a bare
program name (`git`, matched by program or basename), an explicit path
(`/usr/bin/git`), or an argv pattern with `*` and `?` wildcards (`pnpm test*`).
A `deny` match always wins. The runtime CLI Nitely launches is the agent itself,
not one of its commands, and is never matched against the policy.

Container isolation bounds the filesystem and the network; it does not mediate
which binaries run inside the image. So the policy resolves one of three ways:

- `unrestricted`: no mediation, as before.
- `advisory: true`: the allow and deny rules are stated to the agent in its
  prompt and recorded in evidence, and the stage runs.
- `advisory: false`: enforcement is demanded, no mechanism provides it, and the
  stage **fails closed** at preflight rather than running unmediated.

The local and mise backends run the agent as an ordinary child process and
mediate nothing it spawns, so they fail closed on `advisory: false` the same
way. Evidence records the mode, the advisory flag, and the rule names only.

Aggregate bind-mount disk quota (`NITELY_OCI_DISK_BYTES`) is not supported and
will not be; setting it fails closed. Use per-file `NITELY_OCI_MAX_FILE_BYTES`
and captured-output `NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES`.
**Host-only Git is the permanent sandbox model:** backing linked-worktree Git
metadata is never mounted; host-side workspace create/commit is the only Git
write path; Codex uses `--skip-git-repo-check` and in-container Git commands
may be unavailable. Mounting the backing worktree `.git` would let a workload
follow the gitdir pointer out of the sandbox.

Agent stages and review gates can declare connector requirements that must be
configured before the agent runtime starts:

```json
{
  "id": "implement",
  "type": "agent",
  "runtime": "codex",
  "required_mcp_servers": ["google-drive"],
  "required_connectors": ["github"],
  "prompt": "Implement the supplied specification.",
  "inputs": ["spec"],
  "outputs": ["implementation"]
}
```

`required_mcp_servers` preserves MCP server/tool identifiers such as
`google-drive`, `google-docs`, `google-sheets`, `google-slides`, `github`,
`github-cli`, `claude`, `anthropic`, `glm`, `zhipu`, `grok`, `xai`, `pi`,
`codex`, and `openai`.
Known identifiers map to Nitely providers and fail fast when the corresponding
provider is not configured. `required_connectors` names provider ids directly:
`google-drive`, `github`, `anthropic`, `glm`, `grok`, `pi`, or `codex`. Missing-provider
failures name the stage, provider id, and setup hints such as
`NITELY_GOOGLE_ACCESS_TOKEN`. Unknown MCP ids are preserved in run events for
observability but do not block execution. This first slice validates known
provider availability; it does not launch MCP servers.
