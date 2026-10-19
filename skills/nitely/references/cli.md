# Nitely CLI Reference

`nitely --help` (or `nitely help`) prints the authoritative list for the
installed version. This file groups the commands by task and notes the traps.

Substitute the entry point you use: `nitely`, `node dist/index.js`, or
`pnpm dev --`.

`--repo` defaults to `.` (the process working directory) on commands that take
it. When driving another repository, always pass it explicitly — run state is
projected from `<repo>/.nitely/events.db`, so a wrong `--repo` makes runs look
missing.

## Flow checks

```bash
nitely validate <flow> [--external-input <name>]
nitely graph <flow> [--format text|mermaid|json] [--external-input <name>]
nitely doctor <flow> --repo <path> [--input <name>=<path>] [--backend local|mise|oci]
nitely flow list [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
nitely flow show <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
nitely flow enable|disable <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
nitely flow update <id> --file <path> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
nitely flow reset <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
nitely flow delete <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]
```

- `validate` checks the flow contract offline. Declare each externally supplied
  input with `--external-input` so validation knows it is provided at run time.
- `graph` prints a read-only artifact-derived DAG (`text` default, `mermaid` for
  GitHub, `json` structured). Flows stay JSON; there is no visual editor. Rework
  back-edges are not projected.
- `doctor` is the preflight: it reports `PASS`, `WARN`, or `BLOCK` with issue
  codes such as `missing-input`, `input-unreadable`, `missing-provider`,
  `unknown-mcp-server`, and `runtime-unavailable`.
- `flow …` manages the Flow catalog (built-in plus user-defined flows). With
  `--repo` it edits that repository's `.nitely/flows.db` directly; without it, it
  talks to a running server, which allows built-in changes only to an admin or
  in local mode (API tokens cannot change flows).
- Built-in flows are `flows/<name>.json`. Editing one (`update`) stops shipped
  upgrades from overwriting it; `list` then shows "newer-shipped-version" when
  one exists, and `reset` takes the shipped version (discarding the edits). A
  disabled flow blocks new work and runs. Built-in flows cannot be deleted.
- `update` validates the document first and leaves the stored one untouched if
  it is invalid.

## Running

```bash
nitely run <flow> --repo <path> \
  --input <name>=<path> [--input ...] \
  [--config <key=value>] [--task-scope <input>:<scope>] \
  [--backend local|mise|oci] \
  [--runtime <id>] [--model <model>] [--effort <level>] [--questions ask|auto|deny]
nitely run-stage <flow> <stage-id> [--repo <path>] [--input <name>=<path>] [--input-dir <path>] \
  [--dry-run] [--backend local|mise|oci]
nitely resume <run-id> [--repo <path>] [--checkpoint <checkpoint-id>] [--backend local|mise|oci]
```

`--runtime`, `--model`, `--effort`, and `--questions` override every agent,
judge, and review-gate stage for this run without editing the stored Flow. A
runtime override replaces the fallback chain; model and effort apply to every
existing candidate; `--questions` also sets the Flow question policy. Command
and approval stages are unaffected, and there are no per-stage overrides.
`doctor`, `run-stage`, `rework-pr`, `pr-comments`, `ci-repair submit`, and
`task create`/`task plan` accept the same flags, so `doctor` checks the
configuration the run will use.

`run-stage` replays one stage in a new worktree based on `--repo`. `--dry-run`
prints the stage contract without creating a worktree or calling a provider;
`--input-dir` takes a prior attempt directory or files named after artifact ids.

Local-file `--input` path rules:

- Relative paths resolve against the **process working directory**, not
  `--repo`.
- A resolved path must land under either `--repo` or the process cwd; anything
  outside both roots is rejected, including symlinks that escape.

Backends: `local` (default, host worktree), `mise` (per-project toolchain via
`mise.toml`/`.tool-versions`), `oci`/`docker` (rootless Docker, image must
already exist locally — see `docker/runner/`).

## Inspecting runs

```bash
nitely runs [--repo <path>]
nitely status <run-id> [--repo <path>] [--json]
nitely logs <run-id> [--repo <path>] [--stage <stage-id>]
nitely diagnose <run-id> [--repo <path>] [--json]
nitely run list [--server <url>] [--status <status>] [--json]
nitely run watch <run-id> [--server <url>] [--interval-ms <n>]
nitely metrics --repo <path> [--json]
```

`status` reports a `running` run whose attempt has been silent past the stale
threshold as `interrupted` (default 5 minutes, `NITELY_STALE_RUNNING_RUN_MS`).
`run list`/`run watch` are server-backed; `runs`/`status`/`logs` read the local
event log. `run watch` prints one line per status/stage/output transition and
exits zero only when the run completes. `metrics` prints the factory funnel
(candidate → eligible → queued → run started → PR created → review requested →
merged) that the Console shows as `dashboard.factoryMetrics`.

## Unblocking

```bash
nitely approvals <run-id> [--repo <path>]
nitely approve <run-id> <approval-id> [--repo <path>] [--actor <name>]
nitely deny <run-id> <approval-id> [--repo <path>] [--actor <name>]

nitely questions <run-id> [--repo <path>]
nitely answer <run-id> <question-id> (--option <id> | --text <answer>) [--repo <path>] [--actor <name>]

nitely review-verdict <run-id> --file <review.md> --actor <name> \
  --reviewed-artifact <id> [--reviewed-artifact <id> ...] [--repo <path>]
```

Every one of these records a decision and then waits: the run continues only on
an explicit `nitely resume <run-id>`.

Runs on a server are resumed or stopped remotely instead:

```bash
nitely run resume <run-id> [--server <url>] [--json]
nitely run cancel <run-id> [--reason <text>] [--server <url>] [--json]
```

`run resume` is the Console's **Resume run** for a `blocked` or `interrupted`
run; it returns once the server accepts and continues in the background. If that
background resume fails, the run stays resumable and `GET /api/runs/<run-id>`
reports `resumeFailure`. `run cancel` is the Console's **Cancel run**: any run
that is not `completed`, `failed`, or `cancelled` becomes terminal, a process the
server runs for it is aborted, and its Task can be started again. A cancel is
refused with `409` while a resume of the same run is starting. Both need the
`runs:start` capability.

`review-verdict` attaches a human verdict to a blocked **review gate** and must
cite every artifact the gate declared. The file needs a real review signal
(`Review verdict: pass`, `Review verdict: fail`, or a P0/P1 finding). Use it
only when a qualified human actually reviewed the artifacts.

## Change requests and PRs

```bash
nitely rework-pr <pr-url-or-number> --repo <path> --flow <flow> --input <name>=<path>
nitely pr-comments <pr-url-or-number> --repo <path> --flow <flow>
nitely rollback record <run-id> --repo <path> --checkpoint <checkpoint-id> \
  [--actor <name>] [--reason <text>] [--worktree preserve|cleanup] \
  [--branch preserve|reset-to-checkpoint] \
  [--change preserve-existing-pr|update-existing-pr|new-pr|none]
nitely rollback apply <run-id> --repo <path> [--decision <event-sequence>]
nitely ci-repair submit <observation.json> --repo <path> --flow <flow> [--current-head <sha>] \
  [--input <name>=<path>] [--secret <value>] [--resume]
nitely ci-repair decide <idempotency-key> --decision accept|reject [--repo <path>] [--actor <name>] [--reason <text>]
```

`rework-pr` re-enters an existing PR with a rework flow; `pr-comments`
processes reviewer comments into a same-PR rework run. Both need
`NITELY_GITHUB_TOKEN`.

`ci-repair submit` turns a failed-check observation into a repair cycle that
updates the existing PR only. Submissions are deduplicated by
provider/repository/PR/check/head and kept in `.nitely/ci-repair.db`;
`ci-repair decide` records the operator's accept or reject for one of them.

## Planning artifacts

```bash
nitely clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]
nitely tasks-to-issues --repo <path> --tasks <path> --spec <path> --plan <path> [--group-by task|phase]
nitely task plan [--server <url>] (--prompt <text> | --prompt-file <path> | --issue <url> | --jira <ref> | \
  --document-url <url> --document-file <path>) [--conversation <path>] [--title <title>] \
  [--guidance <text>] [--document-version <v>] [--flow <path>] [--template <id>] [--repo-id <id>] [--json]
nitely task create [--server <url>] --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>]
nitely task list [--server <url>] [--json]
nitely task approve-spec <task-id> [--server <url>] [--json]
nitely task draft-tech-design <task-id> [--server <url>] [--json]
nitely task approve-tech-design <task-id> [--server <url>] [--json]
nitely task refresh-source-planning <task-id> [--server <url>] [--json]
nitely task start <task-id> [--server <url>] [--json]
nitely task watch <task-id> [--server <url>] [--interval-ms <n>]
```

`task plan` drafts a Task's spec from a prompt, issue, Jira ticket, or
document; `task create` takes ready-made planning files. `draft-tech-design`
writes a repository-grounded design from the approved spec and prints its open
questions; `refresh-source-planning` re-plans a Task whose issue, ticket, or
document changed. `task start` starts a run and prints the `run watch` command;
it never force-starts a Task with eligibility blockers (that stays a Console
decision). Capabilities: `spec:approve` for the two approvals, `tasks:write` for
the draft and refresh, `runs:start` for `task start`. These are server Tasks;
the local `approvals`/`questions` commands act on in-run gates instead.

`tasks-to-issues` derives the GitHub target only from `origin`; the three
source files must be tracked and unchanged from `HEAD`. It aborts the whole
sync rather than creating a partial/split issue group, and records bindings in
`.nitely/task-issues.json`.

## Evidence

```bash
nitely evidence policy --repo <path> [--json]
nitely evidence search --repo <path> [--run <text>] [--task <text>] [--repository <text>] \
  [--flow <text>] [--status <status>] [--pr <text>] [--blocker <category>] \
  [--from <ISO>] [--to <ISO>] [--artifact <text>] [--json]
nitely evidence export --repo <path> --run <run-id> [--run <run-id> ...] --output <directory> [--include-raw]
nitely evidence prune --repo <path> [--at <ISO>] [--apply] [--json]
```

`prune` is a dry run unless `--apply`; active or interrupted runs are never
selected. Exports are metadata-only by default — `--include-raw` is an explicit
sensitive-content opt-in that adds prompts, logs, artifact contents, and
recovery checkpoints.

## Skills

```bash
nitely skill import <path> --repo <path> [--overwrite]
nitely skill improvements list|confirm|propose|decide|evaluate --repo <path>
```

Imports a validated skill directory (or a single `SKILL.md`) into
`<repo>/.nitely/skills/<skill-id>/`, prints a deterministic content hash, and
refuses to clobber an existing skill without `--overwrite`.

`skill improvements` reviews observations kept in
`.nitely/skill-improvements.db`: `confirm` a papercut, or `propose` with pinned
eval cases, then `decide` and `evaluate`. Nitely never edits or publishes a
skill on its own, and a changed source hash blocks applying one.

## Server, MCP, scheduler

```bash
nitely web --home <dir> --host <host> --port <port> [--auth local|required]
nitely mcp serve [--server <url>]          # token from NITELY_API_TOKEN
nitely mcp token create --repo <path> --name <name> --owner <email-or-user-id> --capability <cap> [--capability ...] [--allow-high-impact]
nitely mcp token list --repo <path>
nitely mcp token revoke <token-id> --repo <path>
nitely connect --server <url>              # token from NITELY_API_TOKEN
nitely whoami
nitely disconnect
nitely auth login --server <url> --capability <cap> [--allow-high-impact] [--no-browser]
nitely auth logout
nitely provider list [--server <url>] [--json]
nitely provider validate <provider-id> [--connection <id>] [--server <url>] [--json]
nitely scheduler [--repo <path>] [--window HH:MM-HH:MM] [--daemon] [--once] [--server <url>] \
  [--interval-ms <n>] [--max-cycles <n>] [--max-concurrent-tasks <n>] [--usage-limit-cooldown-ms <n>]
nitely schedule create --name <name> (--cron <expr> | --every <duration> | --at <iso>) \
  --title <title> --spec-file <path> --tech-design-file <path> [--timezone <iana>] [--flow <path>] \
  [--admission auto|review] [--misfire skip|run_once_now|catch_up] [--catch-up-limit <n>] \
  [--overlap allow|skip|queue] [--repo <path>] [--json]
nitely schedule list [--repo <path>] [--json]
nitely schedule show <schedule-id> [--repo <path>] [--json]
nitely schedule pause|resume|delete <schedule-id> [--repo <path>]
nitely schedule tick [--repo <path>] [--json]
```

There is no `--token` flag anywhere; tokens are read from `NITELY_API_TOKEN`.
`provider validate` is the Console's **Providers → Validate**: it exits non-zero
unless the stored key is valid, and needs the high-impact `providers:validate`
capability. Keys are set only in the Console.
`scheduler` stays local unless `--server` or `NITELY_SERVER_URL` is set.

A `schedule` only decides when work is created: each firing makes one Task and
one Factory Queue candidate, and the queue and `scheduler` decide when it runs.
`--admission review` creates draft Tasks that wait for a human. `schedule tick`
evaluates due firings once; schedules live in `.nitely/schedules/`.

## Repo index, knowledge, eval, pilots

```bash
nitely repo-index build --repo <path>
nitely repo-index query --repo <path> <target> [--limit <n>] [--run <run-id> --stage <stage-id> --attempt <n>]
nitely knowledge-repo attach --repo <path> --id <id> --name <name> --source <path-or-github-url> --ref <ref> \
  [--include <glob>] [--exclude <glob>] [--required] [--embedding-provider <id>] [--embedding-model <model>] [--json]
nitely knowledge-repo list --repo <path> [--json]
nitely knowledge-repo status --repo <path> --id <id> [--json]
nitely knowledge-repo refresh --repo <path> --id <id> [--json]
nitely knowledge-repo query --repo <path> --query <text> [--attachment <id>] [--limit <n>] [--json]
nitely knowledge-repo detach --repo <path> --id <id> [--json]
nitely eval plan|run <manifest> --repo <path> --case <id> [--json]
nitely eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path> [--output <report.json>]
nitely eval recommend <experiment> --repo <path> [--output <recommendation.json>]
nitely benchmark hybrid-retrieval [--fixture <path>] [--output <path>] [--budget <tokens>]
nitely pilot setup-report --repo <path> --flow <flow> --runtime <id> --verify-command <cmd> [--output <path>]
nitely smoke github-issue-intake [--server <url>] --issue <github-issue-url>
nitely smoke golden-path [--output <dir>]
```

`eval recommend` emits a `nitely.model-routing-recommendation.v1` from a routing
experiment, or `insufficient_data` when evidence, coverage, or budget does not
support a single frontier candidate. `benchmark hybrid-retrieval` runs the
conservative lexical/vector retrieval benchmark against a fixture and prints
its report.

## Environment variables worth knowing

| Variable | Effect |
| --- | --- |
| `NITELY_GITHUB_TOKEN` / `GITHUB_TOKEN` | GitHub publishing and PR operations |
| `NITELY_API_TOKEN` | CLI/MCP token for a Nitely server |
| `NITELY_SERVER_URL` | Default `--server` value |
| `NITELY_EXECUTION_BACKEND` | Default backend (`local`, `mise`, `oci`) |
| `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` | Machine-wide runaway ceiling in uncached runtime tokens (`0` opts out; default 2,000,000) |
| `NITELY_STALE_RUNNING_RUN_MS` | When a silent running run is reported as interrupted |
| `NITELY_<RUNTIME>_COMMAND` | Override an agent CLI command name |
| `NITELY_CODEX_SANDBOX` | Codex sandbox value |
