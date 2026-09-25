# Nitely Troubleshooting

Work from evidence, not guesses: `nitely status <run-id> --repo <path>` names
the blocker, `nitely logs <run-id> --repo <path> --stage <stage-id>` shows the
captured attempt output, and `nitely diagnose <run-id> --repo <path>` reports
evidence-backed efficiency findings.

## Install and CLI

| Symptom | Cause and fix |
| --- | --- |
| `Unsupported engine` / syntax errors on startup | Node older than 24. `nvm use` inside the checkout (`.nvmrc`), then re-run |
| `nitely: command not found` | Not linked. Run `npm link` in the Nitely checkout, add the wrapper from `install.md`, or call `node dist/index.js` there |
| `Cannot find module .../dist/index.js` | Never built, or built output is stale after a pull. `pnpm install && pnpm run build` |
| A flag the docs mention is rejected | The checkout predates it. `git pull`, rebuild, then check `nitely --help` |

## Runs that will not start

| Symptom | Cause and fix |
| --- | --- |
| Input path rejected | Relative `--input` paths resolve against the **process cwd**, not `--repo`, and must land under `--repo` or the cwd. Pass an absolute path |
| `unknown skill "<id>"` | The skill must exist at `<repo>/.nitely/skills/<id>/SKILL.md`. Import it: `nitely skill import ./<id> --repo <path>` |
| Malformed frontmatter / name mismatch on a skill | `SKILL.md` needs `---` delimiters, simple `key: value` lines, `name` equal to the directory name, a non-empty `description`, and a non-empty body |
| Missing credentials for a known runtime | Export the runtime's key (see `install.md`). A single-runtime stage fails early; an ordered `runtimes` stage records the candidate as unavailable |
| Validation errors on a flow you just edited | `nitely validate <flow> --external-input <name>` for each externally supplied input; validation does not know about them otherwise |
| Publishing fails with a GitHub error | `NITELY_GITHUB_TOKEN` (or `GITHUB_TOKEN`) missing or lacking PR write scope on the target repo |

## Runs that stop mid-flight

| Status / blocker reason | Meaning and next step |
| --- | --- |
| `awaiting-approval` | `nitely approvals <run-id>` → `approve`/`deny --actor <who>` → `resume` |
| `blocked` / `awaiting_operator_answer` | The agent wrote a validated `question.json` and no attempt was burned. `nitely questions <run-id>` → `answer ... --option <id>` or `--text "..."` → `resume`. The answer is injected as an authoritative prompt section |
| `blocked` / `agent_usage_limit` | Provider quota, rate limit, or capacity, with every declared runtime candidate exhausted (each fallback is recorded as `stage.runtime.fallback`). Retries are not spent. Wait, or fix credentials for one of the candidates the run already declared, then `resume`. Adding a candidate to the flow file does not reach this run (see below); that needs a new run. Nitely never buys quota and never uses a runtime the flow did not declare |
| `blocked` / `agent_runtime_unavailable` | The runtime CLI is missing, unauthenticated, or failed to launch. Install/authenticate it (or set `NITELY_<RUNTIME>_COMMAND`), then `resume` |
| `interrupted` | A stage started with no terminal event (killed process, machine sleep). `resume` records the attempt as failed with interruption context and continues in the same worktree |
| budget stopped (`budget.exceeded`) | The uncached runtime-token ceiling was crossed. Raise `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` above the consumed total, then `resume`; resuming without raising it is refused |
| Blocked review gate | Prefer waiting or another configured runtime. With a real human review: `nitely review-verdict <run-id> --file review.md --actor <who> --reviewed-artifact <id>` citing every artifact the gate declared, then `resume` |
| A `running` run that is actually dead | SIGKILL writes no terminal event; after `NITELY_STALE_RUNNING_RUN_MS` (default 5 min) status reports `interrupted`. Then `resume` |

**Editing a flow does not change a run that already exists.** `run.created`
records the complete `flowDocument`, and `resume` initializes from that recorded
copy rather than re-reading `flows/<name>.json`. Stage runtimes, prompts, gates,
and attempt budgets are pinned at creation. The single exception for a
budget-stopped run is the runaway ceiling: `resume` re-reads
`NITELY_DEFAULT_MAX_RUNTIME_TOKENS` from the environment, which is why raising
that cap unblocks it. `spec.verificationBudget` is still re-read from the flow
file. For anything else, repair the environment and `resume`, or start a new
run against the edited flow.

## Stage failures

- **Missing declared output.** The agent must write `<output-id>.md` or
  `<output-id>.txt` in the attempt directory, or list it in `artifact.json`.
  Empty files, unsafe paths escaping the attempt directory, and undeclared
  manifest ids all fail the attempt.
- **Attempts exhausted.** The budget is `stage.maxAttempts` →
  `spec.maxAttempts` → `1`. Read the last attempt's `prompt.md`, `stdout.log`,
  and `stderr.log` under
  `.nitely/runs/<run-id>/stages/<stage-id>/<attempt>/` before raising it.
- **Deterministic gate fails.** It is a real command failure: reproduce the
  gate's `command` in the worktree at
  `.nitely/runs/<run-id>/worktree` before changing the flow.
- **Review gate fails.** The review output contained `Review verdict: fail` or
  a blocking severity marker (`### P1 - ...`, `[P0] ...`). P2/P3 findings are
  advisory and pass.

## Backends

| Backend | Common failure |
| --- | --- |
| `mise` | `mise` not installed or named differently — set `NITELY_MISE_COMMAND`. Repos without `mise.toml`/`.mise.toml`/`.tool-versions` behave like `local` |
| `oci` | The image must already exist on the host (`--pull=never`): build it with `docker/runner/build.sh`. The daemon must be rootless with cgroup v2; remote `DOCKER_HOST`/`DOCKER_CONTEXT` are rejected |
| `oci` networking | Deny-all by default. Agents needing egress require `NITELY_OCI_NETWORK_ALLOWLIST` or stage `capabilities.network.mode: "restricted"` with domains; CLIs that ignore `HTTPS_PROXY` may still fail |

### OCI symptoms seen in production

| Symptom | Cause and fix |
| --- | --- |
| `NITELY_OCI_IMAGE is required for the OCI execution backend` at run start, while `/api/readiness` said `execution: oci`, `ready: true` | Readiness does not check that the backend can launch. Set `NITELY_OCI_IMAGE`, the secret/network allowlists, and build the image; see `references/web-operations.md` §2 |
| Stage stderr: `Error: Cannot find module '/home/<user>/.../claude'` followed by `Node.js v24.x`, under `executionBackend: oci` | `NITELY_<RUNTIME>_COMMAND` is a host path passed verbatim into the container. Set it to the image's command (`claude`, `codex`) for the Web service |
| `Input must be provided either through stdin or as a prompt argument when using --print` from the CLI inside the container | The engine was started without `--interactive`, so the stdin-delivered prompt was dropped (fixed in Nitely; rebuild/redeploy). Every stdin runtime — claude, codex, glm, pi — was affected; grok passes its prompt as an argument and was not |
| `runc run failed: ... unable to join session keyring: unable to create session key: disk quota exceeded` — every container fails, and `docker build` dies on `resolve image config for docker/dockerfile:1` with only `exit code: 1` | The kernel per-user keyring quota is exhausted: `grep '^ *<uid>:' /proc/key-users` shows `200/200` against `kernel.keys.maxkeys` (default 200), usually from leaked `_ses` keyrings of churned containers or stale logins. Needs root: `sysctl -w kernel.keys.maxkeys=20000 kernel.keys.maxbytes=2000000` and persist it under `/etc/sysctl.d/`. Killing processes does not free revoked keyrings |
| `cp: cannot stat '/tmp/nitely-home/.local/share/corepack'` while building the runner image | corepack ≥ 0.36 caches under `$XDG_CACHE_HOME/node/corepack`; the Dockerfile pins `COREPACK_HOME` since the fix. Pull the latest `docker/runner/` before building |
| Test stage fails with a missing `vitest`/`pnpm exec` binary under `oci`, but the same flow passed under `local` | The worktree has no `node_modules` of its own; `local` resolved them from the parent checkout. Install dependencies in an earlier stage (allowlist the registry) or in the test command |

## Claude reports a rate limit

`claude` prints `API Error: Rate limit reached` for more than one condition.
Run the same prompt with `--debug` and read `~/.claude/debug/latest`:

| Debug log shows | Meaning |
| --- | --- |
| `429 rate_limit_error ... "error_code":"credits_required" ... "exhausted_included_allowance":false` | Not quota. The request asked for a long-context (`[1m]`) model that needs usage credits — check `model` in `~/.claude/settings.json` or `ANTHROPIC_MODEL`. Pass `--model opus` (or another non-`[1m]` model) to confirm the credential works |
| `429 ... "exhausted_included_allowance":true` or `You've hit your limit · resets <time>` | Real usage limit. Nitely records it as `agent_usage_limit` with a cooldown and resumes after the reset |
| `401 authentication_error ... OAuth access token is invalid` | The stored `sk-ant-oat…` token is dead. Reconnect it in the Console (Providers → Claude → Update), then validate |
| `Not logged in · Please run /login` with no token in the environment | The host CLI has no login of its own; only matters for the `local` backend |

A host-side `claude -p` reflects the host's `~/.claude/settings.json` and login.
It says nothing about an `oci` run, which never sees the host home.

## Run state and visibility

- `status`/`logs`/`runs` read `<repo>/.nitely/events.db`. "Run not found"
  almost always means the wrong `--repo`; the error itself suggests retrying
  with the path used for `run`.
- Run directories and event history are kept indefinitely unless
  `nitely.evidence.json` sets retention windows. Check with
  `nitely evidence policy --repo <path>`; `evidence prune` is a dry run without
  `--apply` and never selects active or interrupted runs.
- Do not hand-edit or delete `.nitely/runs/<run-id>` or `.nitely/events.db` to
  clear a bad run — that is the audit record. Let the run reach a terminal
  state, or start a new run.

## Context and secrets

- If a needed file never reaches the agent, check `nitely.context.json`
  include/exclude globs and the built-in excludes (`.env`, `.env.*`, keys,
  `.git/**`, `.nitely/providers/**`). With `warnOnly: true`, excluded inputs are
  recorded as warned and their bytes are still omitted.
- Each run writes `.nitely/runs/<run-id>/context-manifest.json` with redacted
  metadata for inputs and generated artifacts — read it to see exactly what the
  run could see.
- Redaction covers prompts, command logs, sync reports, evidence, run events,
  PR bodies, and Web API text. Source snapshots and generated artifacts are not
  rewritten in place, so never let a secret into an artifact in the first
  place.
