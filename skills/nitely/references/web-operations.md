# Operating a Deployed Web Instance

This is the path where the local-run loop in `SKILL.md` does not apply: a
Nitely Web server runs as a service, users sign in, provider credentials live
in the Console's store, and runs execute through the OCI backend. Read this
before deploying, checking a credential, or submitting a task against such an
instance.

## 1. Know how the instance is configured before trusting it

Under `--auth required` the Web server defaults to the `oci` execution backend
and `/api/readiness` reports `execution.backend: "oci"`. **Readiness does not
verify that the backend can launch anything.** It reads `ready: true` even when
no runner image exists and `NITELY_OCI_IMAGE` is unset; the first run then
fails at launch with `NITELY_OCI_IMAGE is required for the OCI execution backend`.
Before relying on readiness, check the service environment and the engine:

```bash
systemctl --user show <unit> -p Environment | tr ' ' '\n' | grep -E 'NITELY_(OCI|EXECUTION|CLAUDE|CODEX)'
docker images --format '{{.Repository}}:{{.Tag}}' | grep nitely-runner
docker info | grep -i rootless
```

Also check which backend earlier runs actually used —
`"executionBackend"` in `.nitely/runs/<run-id>/reproducibility.json` — because
a run started from the CLI on the host may have used `local` while the Web
default was `oci`, and their failure modes differ.

## 2. OCI backend checklist

Everything the runner needs must be declared; nothing leaks in from the host.

| Item | Where | Notes |
| --- | --- | --- |
| Runner image | `docker/runner/build.sh --variant agent --tag nitely-runner-agent:local --agent-clis "@anthropic-ai/claude-code@latest" --verify` | `--pull=never`: the image must exist locally. Rebuild after Nitely or CLI upgrades |
| `NITELY_OCI_IMAGE` | service environment | e.g. `nitely-runner-agent:local` |
| `NITELY_OCI_SECRET_ALLOWLIST` | service environment | Names only, e.g. `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY,NITELY_GITHUB_TOKEN`. Console-stored credentials reach the container only through this list |
| `NITELY_OCI_NETWORK_ALLOWLIST` | service environment | Hosts the agent may reach, e.g. `api.anthropic.com,github.com,api.github.com,registry.npmjs.org`. Agent stages refuse to start under the deny-all default |
| `NITELY_OCI_ENV_ALLOWLIST` | service environment | Plain env names, typically `LANG,CI` |
| `NITELY_<RUNTIME>_COMMAND` | service environment | Must resolve **inside the image** (`claude`, `codex`). A host path such as `/home/me/.nvm/.../claude` is passed through verbatim and fails with `Cannot find module` |

The container never mounts the operator's home: `~/.claude/settings.json`,
`~/.codex`, and CLI logins on the host do not apply. That is a feature — a
host-level `model: "opus[1m]"` or a stale host login cannot affect runs — but it
also means a `claude -p` check on the host says nothing about what the
container will do.

**Worktree dependencies.** Under `local` the run worktree sits inside the
repository checkout, so `pnpm exec vitest` resolves `node_modules` from the
parent. Under `oci` only the worktree is mounted. A flow whose command stage
runs the test suite needs the dependencies installed first — an agent stage
with `registry.npmjs.org` allowlisted and a tech design that says to run
`pnpm install --frozen-lockfile`, or a dedicated command stage — or the test
stage fails on a missing binary.

## 3. Deploying a new build

Follow the repository's `AGENTS.md` for the exact paths. The shape is:

```bash
cd <production checkout> && git pull --ff-only && pnpm install --frozen-lockfile && pnpm run build
# restart the service, then:
curl -s http://127.0.0.1:<port>/api/readiness
tail -n 3 <production>/.nitely/web.log
```

Production runs `main`; deploy a branch only when the operator says so.
Service environment changes go in a systemd drop-in
(`~/.config/systemd/user/<unit>.service.d/*.conf`) followed by
`systemctl --user daemon-reload` and a restart — later drop-ins override
earlier ones, which is how an OCI-specific `NITELY_CLAUDE_COMMAND=claude` wins
over a host-path setting.

## 4. Checking a Console-stored credential

Under required auth the Anthropic/GitHub credentials are in
`<production>/.nitely/users/<user-id>/connections.json` (metadata) and
`connections.secrets.json` (bytes), or the repository-wide `connections.json`.
Read the metadata to learn the auth method and state; never print the secret.

The authoritative check is the Console's own validation, which exercises the
same resolution the run uses (including refresh):

```
POST /api/providers/anthropic/connections/<connection-id>/validate   → { ok } or { ok: false, reason }
```

That needs a signed-in session. From the server itself, sign the CLI in with a
device code — the operator approves it in the Console — and then use the
CLI's remote task commands:

```bash
nitely auth login --server http://<host>:<port> --no-browser \
  --capability tasks:read --capability tasks:write \
  --capability runs:read --capability runs:start --allow-high-impact
# prints: Open http://<host>:<port>/device?code=XXXX-XXXX and confirm the code
nitely whoami
nitely task create --title "..." --spec spec.md --tech-design design.md \
  --flow flows/implement-spec-bootstrap-claude.json --repo-id <repo-id>
nitely task start <task-id> --json
```

If you must test a Claude token by hand, export it from the store into the
environment of one `claude -p` call, pass an explicit non-`[1m]` model, and do
not echo it:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude -p "Reply with exactly: OK" --model opus --output-format json --max-turns 1
```

Interpret the result with `references/troubleshooting.md` ("Claude reports a
rate limit"): `401 OAuth access token is invalid` means reconnect;
`credits_required` is not quota exhaustion.

## 5. Which flow runs which runtime

Flow files with the same stem differ in runtime:
`implement-spec-bootstrap.json` runs its agent stages on `codex`,
`implement-spec-bootstrap-claude.json` on `claude`, `-grok` and `-pi`
likewise. When the point of a run is to exercise a particular provider's
credential, pick the variant explicitly; the base name does not mean "default
runtime".
