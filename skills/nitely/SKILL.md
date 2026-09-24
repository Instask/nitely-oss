---
name: nitely
description: Install, configure, and operate Nitely, the local-first governed spec-to-PR execution system. Use when the user wants to install or set up Nitely, run/validate/author a Nitely flow, turn an approved spec or ticket into an evidence-backed draft PR, inspect runs, logs, status, or evidence, clear approvals, operator questions, or usage-limit blockers, resume a blocked or interrupted run, start the local Web Console or stdio MCP server, or configure agent runtimes such as Codex, Claude, GLM, Grok Build, and Pi.
---

# Nitely

Nitely runs versioned Flows that turn approved engineering intent into
evidence-backed draft pull requests. A Flow declares inputs, outputs, typed
artifacts, gates, verification, and publication; Nitely executes it in an
isolated git worktree and records decisions, commands, blockers, recovery, and
rework as review-grade evidence.

Everything is local-first: state lives under `.nitely/` in the target
repository, and no hosted service is required.

## Before doing anything

1. Find the Nitely checkout. It is the directory containing `flows/` and a
   `package.json` whose `name` is `nitely`. If the user has not installed it,
   see `references/install.md`.
2. Pick the entry point and use it consistently:
   - from a Nitely checkout, source: `pnpm dev -- <args>`
   - from a Nitely checkout, built: `node dist/index.js <args>`
   - linked globally: `nitely <args>`
   In this file the entry point is written as `nitely`.
3. Know the two paths that matter: the **Nitely checkout** (where the CLI
   lives) and the **target repo** (`--repo <path>`, where the run happens and
   `.nitely/` state is written). They are often different directories.
4. Decide which of two situations you are in. **A local checkout** where you
   run flows yourself with `nitely run` — the loop below. **A deployed Web
   instance** with signed-in users, Console-stored credentials, and the `oci`
   backend — `references/web-operations.md`, where the checks are different:
   readiness does not prove the backend can launch, host CLI settings and
   logins do not reach the container, and tasks are created and started
   remotely through a device-code login.

`nitely --help` prints the authoritative command list for the installed
version. Prefer it over memory when a flag looks wrong.

## The normal loop

```bash
nitely validate flows/implement-spec-bootstrap.json --external-input spec --external-input tech-design
nitely graph flows/implement-spec-bootstrap.json --external-input spec --external-input tech-design
nitely doctor flows/implement-spec-bootstrap.json \
  --repo /path/to/target-repo \
  --input spec=./specs/issues/123-thing-spec.md \
  --input tech-design=./docs/plans/2026-06-19-thing-tech-design.md
nitely run flows/implement-spec-bootstrap.json \
  --repo /path/to/target-repo \
  --input spec=./specs/issues/123-thing-spec.md \
  --input tech-design=./docs/plans/2026-06-19-thing-tech-design.md
nitely runs --repo /path/to/target-repo
nitely status <run-id> --repo /path/to/target-repo
nitely logs <run-id> --repo /path/to/target-repo --stage implement
```

`validate` checks the flow contract offline. `graph` prints the artifact-derived
DAG without opening an editor. `doctor` reports `PASS`, `WARN`,
or `BLOCK` over the local preconditions — repo reachable, flow readable and
valid, declared inputs present and readable, providers configured, MCP servers
known, agent runtimes available — before an agent session is spent. Give
`doctor` the same `--input` flags the run will get: a
required input it cannot see is a blocking `missing-input` issue, so a bare
`doctor` on a flow with required inputs always reports `BLOCK`. Run both before
a first run against a new repo or flow; it is the cheapest failure available.

A run creates branch `nitely/<run-id>`, a worktree under
`.nitely/runs/<run-id>/worktree`, appends events to `.nitely/events.db`, and
publishes a draft PR when the publish stage succeeds.

## When a run stops

Read `nitely status <run-id> --repo <path>` first; it names the status and, when
the run is `blocked`, the blocker reason. A stage with an ordered `runtimes`
list has already fallen through every candidate by the time a usage or runtime
blocker surfaces (see `references/flows.md`), so a blocked run means no
candidate remains — not that one is still worth waiting on. Then:

| Status / blocker reason | What to do |
| --- | --- |
| `awaiting-approval` | `nitely approvals <run-id>`, then `approve`/`deny` with `--actor`, then `resume` |
| `blocked` / `awaiting_operator_answer` | `nitely questions <run-id>`, then `answer <run-id> <question-id> --option <id>` (or `--text`), then `resume` |
| `blocked` / `agent_usage_limit` | Every runtime candidate for the stage is exhausted. Restore quota or credentials for one of the candidates the run already declared, then `resume`. Nitely never buys quota |
| `blocked` / `agent_runtime_unavailable` | No candidate could start. Install or authenticate the runtime CLI, or set `NITELY_<RUNTIME>_COMMAND`, then `resume` |
| `interrupted` | `nitely resume <run-id>` — the interrupted attempt is recorded as failed and the next attempt reuses the worktree |
| budget stopped (`budget.exceeded`) | Raise `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` above the consumed total, then `resume` |
| blocked review gate | Prefer waiting or another runtime. Only with a real human review: `nitely review-verdict <run-id> --file review.md --actor <who> --reviewed-artifact <id>`, then `resume` |
| `failed` | `nitely logs <run-id> --stage <stage-id>`, then `nitely diagnose <run-id>` for evidence-backed efficiency findings |

Resume always continues from the first incomplete stage and reuses completed
upstream artifacts. Never delete `.nitely/runs/<run-id>` to "retry cleanly" —
that destroys the evidence the run exists to produce.

**A resume replays the flow the run recorded, not the file on disk.** `run.created`
stores the whole `flowDocument`, and `resume` parses that recorded copy. Editing
`flows/<name>.json` therefore changes nothing about an in-flight run: a stage's
`runtimes` list, prompts, and gates are fixed the moment the run is created. Fix
the environment instead — credentials, quota, an installed CLI,
`NITELY_<RUNTIME>_COMMAND` — and `resume`; to change the flow itself, start a new
run. The one exception is the runaway ceiling: `resume` re-reads
`NITELY_DEFAULT_MAX_RUNTIME_TOKENS` from the environment, which is why raising
that cap unblocks a budget-stopped run. Verification attempt/cost caps on
`spec.verificationBudget` are still re-read from the flow file.

## Common tasks

- **Install or set up Nitely, link the CLI, configure tokens and agent runtimes** → `references/install.md`
- **Full command reference: runs, approvals, evidence, MCP, scheduler, web** → `references/cli.md`
- **Author, validate, or debug flow JSON; stage types, skills, runaway ceiling** → `references/flows.md`
- **A command fails, a run blocks, a provider errors** → `references/troubleshooting.md`
- **Deploy, configure, or drive a running Web instance: OCI backend, service environment, Console credentials, device-code login, remote task create/start** → `references/web-operations.md`

Repository documentation is the deeper source: `docs/product.md` for the four
constraints, `README.md` for install, `docs/running-flows.md`,
`docs/rework-and-recovery.md`, `docs/web-console.md`,
`docs/remote-operations.md`, `docs/local-mcp.md`,
`docs/flow-authoring-guide.md`, `docs/flow-format.md`,
`docs/harness-and-audit.md`, and `docs/user-defined-flows.md`.

## Guardrails

- **Secrets stay in the environment.** Never write tokens or keys into flow
  JSON, specs, prompts, or committed config. Nitely redacts known secret forms
  from prompts, logs, evidence, and PR bodies, but a committed secret is still
  committed.
- **`.nitely/` is local runtime state**, already gitignored in the Nitely repo.
  Do not commit it in target repos either; add it to their `.gitignore`.
- **`evidence export --include-raw` is an explicit sensitive-content opt-in.**
  Default exports are metadata-only. Do not add the flag unless the user asked
  for raw content and understands it carries prompts, logs, and artifact text.
- **Runs write real branches and open real PRs.** Before a first run in a repo
  the user has not used with Nitely, confirm the target repo and flow.
- **Do not hand-edit `.nitely/events.db` or files under `.nitely/runs/`.** They
  are the audit record; change behavior through flows, config, and CLI actions.
