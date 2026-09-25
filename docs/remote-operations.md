# Remote Operations

CLI commands against a running Nitely Web server: connect, list flows, plan a task, approve, start, and watch. Commands are run from the repository root. The stdio MCP server, capability table, and audit files are in [local-mcp.md](local-mcp.md). Console screens are in [web-console.md](web-console.md).

External coding tools can drive the task-to-run slice without shelling out for
each action. Create a least-privilege token, keep its one-time value in the
client environment, and start the built-in stdio server:

Every API token is owned by a user, so the instance needs at least one user
before a token can be minted. If none exist yet, bootstrap the initial admin
once (see [Web Console](web-console.md)) and mint the token against that
account's email:

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-with-a-unique-long-passphrase' \
  pnpm dev -- web --home . --host 127.0.0.1 --port 4173
# stop the server once the admin is created (Ctrl-C), then:
```

```bash
pnpm dev -- mcp token create \
  --repo . \
  --name "Claude Code" \
  --owner <email> \
  --capability tasks:read \
  --capability runs:read

NITELY_API_TOKEN='one-time-token-value' \
  pnpm dev -- mcp serve --server http://127.0.0.1:4173
```

`--owner` names the user the token acts as; the token resolves provider
credentials the way that user's Web Console session does.

Write capabilities (`tasks:write`, `runs:start`, and `spec:approve`) require an
explicit `--allow-high-impact` when the token is created. The raw token is never
shown by list/revoke commands. See [docs/local-mcp.md](local-mcp.md) for
the complete capability table, Claude Code stdio configuration, approval flow,
audit files, and failure behavior.

Approving a generated draft spec updates both task metadata and the persisted
spec Markdown `Status:` line before technical design drafting uses the artifact.

Connect the CLI to a running Nitely server once, then later processes on the
same machine can omit `--server`:

```bash
NITELY_API_TOKEN='nitely_api_...' pnpm dev -- connect --server http://192.0.2.10:4173
pnpm dev -- whoami
```

The saved instance lives in `$NITELY_CONFIG_DIR/current-instance.json`, else
`$XDG_CONFIG_HOME/nitely/current-instance.json`, else
`~/.config/nitely/current-instance.json`. The token is read only from
`NITELY_API_TOKEN` at connect time; there is no `--token` flag. `whoami` prints
whether a token is configured and never prints the token. `nitely disconnect`
clears the saved instance. `nitely scheduler` stays local unless `--server` or
`NITELY_SERVER_URL` is given; a saved instance never switches it to remote.

Instead of hand-carrying a token through `NITELY_API_TOKEN`, sign in through
the browser against a remote server that has users:

```bash
nitely auth login --server https://nitely.example --capability tasks:read --capability runs:start --allow-high-impact
```

The CLI prints a URL and a short code on stderr, opens your browser, and
polls while an administrator approves the request on that page. The issued
token is written straight to the saved instance file and is never printed.
`nitely auth logout` clears it locally; the token itself stays valid on the
server until revoked in the Web Console or with `nitely mcp token revoke`.
See [docs/local-mcp.md](local-mcp.md) for the `--auth local` alternative.

List the Flows the connected instance exposes before choosing one:

```bash
pnpm dev -- flow list
pnpm dev -- flow list --server http://192.0.2.10:4173 --json
```

`flow list` queries `GET /api/flows` on every invocation, so a Flow added,
renamed, or removed on the instance shows up immediately. Each line prints the
Flow id, its source (`builtin` or `user`), whether it is runnable, and its name.
The id is exactly what `task create --flow` accepts. An API token needs the
`tasks:read` capability to read the catalog.

Create a draft task from one intake source, without writing a spec or technical
design first. The intake contract is
[planning-intake.md](planning-intake.md):

```bash
pnpm dev -- task plan --prompt "Let operators import repositories from a pasted GitHub URL."
pnpm dev -- task plan --issue https://github.com/owner/repo/issues/578
pnpm dev -- task plan --jira PLAT-142
pnpm dev -- task plan \
  --document-url https://example.feishu.cn/docx/ABC123 \
  --document-file ./exported-policy.md \
  --document-version rev-42
pnpm dev -- task plan --conversation ./intake.json --title "Repository import"
```

`task plan` posts to `POST /api/draft-specs`, the same endpoint the Web Console
**Plan work** form uses, and prints the task id, its stored source provenance,
the spec and technical-design status, and the next approval command. Exactly one
intake source is accepted per invocation. `--document-url` requires
`--document-file` or `--document-body`, because Nitely stores and hashes the
snapshot it was given rather than fetching the document. `--conversation` takes
a JSON file holding either an array of turns or `{ "turns": [...] }`, where each
turn is `{ "role": "operator" | "agent", "text": "...", "at": "<ISO time>" }`;
the turns are persisted on the task as intake history. When the same source is
submitted twice, the existing task is reused and any drift is reported instead
of silently replacing the approved baseline. An API token needs `tasks:write`.

Create a task on a running Nitely server from local markdown files:

```bash
pnpm dev -- task create \
  --server http://192.0.2.10:4173 \
  --title "Implement ordered runtime fallback" \
  --issue https://github.com/owner/repo/issues/77 \
  --spec ./spec.md \
  --tech-design ./tech-design.md \
  --flow flows/implement-spec-bootstrap.json
```

`--server` can be omitted when `NITELY_SERVER_URL` or a saved instance is set.
Take the `--flow` value from `nitely flow list` so it names a Flow that
actually exists on that instance. The command posts the file contents to
`POST /api/tasks` and prints the task id
plus the Web Console `/tasks/<task-id>` URL. Use `--repo-id <id>` when the
remote console was started with multiple repositories. Remote commands resolve
the server as `--server`, then `NITELY_SERVER_URL`, then the saved instance, and
send `Authorization: Bearer <token>` when `NITELY_API_TOKEN` or a saved token is
present.

Carry that Task through its planning gates and start its Run without the Web
Console:

```bash
pnpm dev -- task approve-spec <task-id>
pnpm dev -- task draft-tech-design <task-id>
pnpm dev -- task approve-tech-design <task-id>
pnpm dev -- task start <task-id>
```

`task approve-spec` and `task approve-tech-design` POST to
`/api/tasks/<task-id>/approve-spec` and `/api/tasks/<task-id>/approve-tech-design`
and print the task id with its resulting artifact status. `task draft-tech-design`
POSTs to `/api/tasks/<task-id>/draft-tech-design`, generates a
repository-grounded technical design from the approved spec without any manual
file preparation, and prints its open questions. `task refresh-source-planning`
POSTs to `/api/tasks/<task-id>/refresh-source-planning` and re-plans a task
whose GitHub issue, Jira ticket, or external document changed. `task start`
POSTs to `/api/tasks/<task-id>/runs` and prints the started run id, its status,
and the `nitely run watch <run-id>` command to follow it. All of them accept
`--json`, which emits the server payload unchanged. An API token needs
`spec:approve` for the two approvals, `tasks:write` for the draft and refresh,
and `runs:start` for `task start`.

`task start` never sends `override=true`, so a Task with run eligibility blockers
is refused rather than force-started; accepting blockers stays a Web Console
decision. The local `approvals`, `approve`, `deny`, `questions`, and `answer`
commands are unrelated to these: they remain repository-scoped and act on
in-Run gates recorded in the local event store.

`POST /api/tasks/:taskId/runs` returns as soon as the run has been accepted and
persisted, instead of waiting for every stage to complete. The response contains
`{ run: { runId, status, taskId, repoId, branchName } }`; use
`GET /api/runs/:runId` to poll final status and artifacts.

List what the connected instance already holds before watching anything:

```bash
pnpm dev -- task list
pnpm dev -- run list
pnpm dev -- run list --status running
pnpm dev -- run list --server http://192.0.2.10:4173 --json
```

`task list` queries `GET /api/tasks` and prints the task id, its display status,
and its title. `run list` queries `GET /api/runs` and prints the run id, status,
task id, and current stage, with `-` where the server reports nothing.
`--status <status>` keeps only matching Runs and accepts `running`, `completed`,
`failed`, `blocked`, `interrupted`, or `cancelled`. `--json` emits the server
array unchanged. An API token needs `tasks:read` for `task list` and `runs:read`
for `run list`. Both take an id you can hand straight to `task watch` or
`run watch`. Local `nitely runs` and `nitely status` are unaffected and keep
reading the repository named by `--repo`.

Watch remote progress without keeping the original start request open:

```bash
pnpm dev -- run watch <run-id> --server http://192.0.2.10:4173
pnpm dev -- task watch <task-id> --server http://192.0.2.10:4173
```

Both commands accept `--interval-ms <n>`, or use `NITELY_SERVER_URL` or the
saved instance when `--server` is omitted. They print one line per
status/stage/output transition and exit zero only when the run completes.

Trigger one scheduler cycle on the remote Nitely server:

```bash
NITELY_SERVER_URL=http://192.0.2.10:4173 pnpm dev -- scheduler --once
# or
pnpm dev -- scheduler --server http://192.0.2.10:4173 --once
```

Run continuous scheduler cycles while the local clock is inside a window:

```bash
pnpm dev -- scheduler --server http://192.0.2.10:4173 \
  --window 22:00-06:00 --interval-ms 60000
```

Use `--max-cycles <n>` for bounded rehearsal or canary runs.

This posts to `POST /api/scheduler/run` and prints the same scheduler summary as
the local command. It is intended for other repositories to integrate with a
deployed Nitely control plane without vendoring Nitely code. The endpoint is
admin-only because it can start queued tasks and execute configured workflows.

`GET /api/runs` and `GET /api/runs/:runId` include Web-facing observability
fields for active and recently active sessions: `currentStage`,
`currentAttempt`, `currentStageState`, `latestOutputSummary`, and
`latestDecision`. They also expose `statusSummary`, `currentProcess`,
`currentArtifactReadiness`, `publication`, and `recoveryArtifact` when
available. Run detail timeline items include explicit `state`, `process`,
`artifactReadiness`, `currentAttempt`, `latestOutput`, `latestDecision`, attempt output summary path,
attempt `artifact.json` path, stdout/stderr log paths, and generated artifact
paths. Run detail responses include `contextUsage` totals when available, and
timeline stages include per-stage `contextUsage` folded from
`stage.context.usage` events. Stable stage state strings are `pending`, `running`, `gate-checking`,
`awaiting-orchestrator`, `retrying`, `reworking`, `escalated`, `failed`,
`completed`, `cancelled`, and `interrupted`. Output summaries are compact,
ignore placeholder/numeric-only lines, and use the same Web redaction as
persisted logs. A `stage.ready` event is exposed
as a pending current stage even before an attempt starts. For failed and
orchestrator-transition states, a later stage failure error takes precedence
over older stdout/stderr output in the compact latest-output fields.

Provider settings show whether local environment variables or CLIs are configured. The console never asks for ChatGPT, Claude, GitHub, or Google passwords and does not return secret values.
