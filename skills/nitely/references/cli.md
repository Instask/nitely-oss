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
nitely doctor <flow> --repo <path> [--input <name>=<path>]
nitely flow list [--server <url>] [--json]
```

- `validate` checks the flow contract offline. Declare each externally supplied
  input with `--external-input` so validation knows it is provided at run time.
- `graph` prints a read-only artifact-derived DAG (`text` default, `mermaid` for
  GitHub, `json` structured). Flows stay JSON; there is no visual editor. Rework
  back-edges are not projected.
- `doctor` is the preflight: it reports `PASS`, `WARN`, or `BLOCK` with issue
  codes such as `missing-input`, `input-unreadable`, `missing-provider`,
  `unknown-mcp-server`, and `runtime-unavailable`.
- `flow list` talks to a running server (built-in plus user-defined flows).

## Running

```bash
nitely run <flow> --repo <path> \
  --input <name>=<path> [--input ...] \
  [--config <key=value>] [--task-scope <input>:<scope>] \
  [--backend local|mise|oci]
nitely resume <run-id> [--repo <path>] [--checkpoint <checkpoint-id>] [--backend local|mise|oci]
```

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
nitely status <run-id> [--repo <path>]
nitely logs <run-id> [--repo <path>] [--stage <stage-id>]
nitely diagnose <run-id> [--repo <path>] [--json]
nitely run list [--server <url>] [--status <status>] [--json]
nitely run watch <run-id> [--server <url>] [--interval-ms <n>]
```

`status` reports a `running` run whose attempt has been silent past the stale
threshold as `interrupted` (default 5 minutes, `NITELY_STALE_RUNNING_RUN_MS`).
`run list`/`run watch` are server-backed; `runs`/`status`/`logs` read the local
event log.

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
```

`rework-pr` re-enters an existing PR with a rework flow; `pr-comments`
processes reviewer comments into a same-PR rework run. Both need
`NITELY_GITHUB_TOKEN`.

## Planning artifacts

```bash
nitely clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]
nitely tasks-to-issues --repo <path> --tasks <path> --spec <path> --plan <path> [--group-by task|phase]
nitely task create [--server <url>] --title <title> --spec <path> --tech-design <path> [--issue <url>] [--flow <path>] [--repo-id <id>]
nitely task list [--server <url>] [--json]
nitely task approve-spec <task-id> [--server <url>] [--json]
```

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
nitely evidence prune --repo <path> [--apply]
```

`prune` is a dry run unless `--apply`; active or interrupted runs are never
selected. Exports are metadata-only by default — `--include-raw` is an explicit
sensitive-content opt-in that adds prompts, logs, artifact contents, and
recovery checkpoints.

## Skills

```bash
nitely skill import <path> --repo <path> [--overwrite]
```

Imports a validated skill directory (or a single `SKILL.md`) into
`<repo>/.nitely/skills/<skill-id>/`, prints a deterministic content hash, and
refuses to clobber an existing skill without `--overwrite`.

## Server, MCP, scheduler

```bash
nitely web --home <dir> --host <host> --port <port> [--auth local|required]
nitely mcp serve [--server <url>]          # token from NITELY_API_TOKEN
nitely mcp token create --repo <path> --name <name> --capability <cap> [--capability ...] [--allow-high-impact]
nitely mcp token list --repo <path>
nitely connect --server <url>              # token from NITELY_API_TOKEN
nitely whoami
nitely disconnect
nitely auth login --server <url> --capability <cap> [--allow-high-impact] [--no-browser]
nitely auth logout
nitely scheduler [--repo <path>] [--window HH:MM-HH:MM] [--once] [--server <url>] \
  [--interval-ms <n>] [--max-cycles <n>] [--max-concurrent-tasks <n>]
```

There is no `--token` flag anywhere; tokens are read from `NITELY_API_TOKEN`.
`scheduler` stays local unless `--server` or `NITELY_SERVER_URL` is set.

## Repo index, knowledge, eval, pilots

```bash
nitely repo-index build --repo <path>
nitely repo-index query --repo <path> <target> [--limit <n>] [--run <run-id> --stage <stage-id> --attempt <n>]
nitely knowledge-repo attach --repo <path> --id <id> --name <name> --source <path-or-github-url> --ref <ref> [--include <glob>] [--exclude <glob>] [--required]
nitely knowledge-repo list --repo <path> [--json]
nitely knowledge-repo status --repo <path> --id <id> [--json]
nitely eval plan|run <manifest> --repo <path> --case <id> [--json]
nitely eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path> [--output <report.json>]
nitely pilot setup-report --repo <path> --flow <flow> --runtime <id> --verify-command <cmd> [--output <path>]
nitely smoke github-issue-intake [--server <url>] --issue <github-issue-url>
nitely smoke golden-path [--output <dir>]
```

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
