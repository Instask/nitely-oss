# Nitely

[中文](./README.zh-CN.md)

Nitely is a local-first workflow runtime for turning software specifications into reviewed pull requests.

It reads a versioned flow, snapshots the supplied inputs, creates an isolated Git worktree, runs agent, command, and gate stages, and publishes the resulting change for human review.

The project is currently in bootstrap. The CLI/runtime exists, and a local Web Console MVP is available for creating tasks, starting runs, inspecting run metadata, and checking provider configuration hints.

## Open-Core Boundary

Nitely's open source core is the inspectable local execution system: flow
schema, local runtime, worktree orchestration, retry/resume, evidence, logs,
redaction, and local Web Console basics. One engineer should be able to inspect
and run this core locally.

The commercial layer is for operating that core reliably across teams:
organization workflows, multi-repo dashboards, GitHub App integration, hosted
coordination, evidence retention/search, policy controls, SSO, audit logs, and
customer-hosted runner coordination.

See [docs/open-core-boundary.md](docs/open-core-boundary.md) for the boundary
used by future SaaS and control-plane work.
See [docs/repository-split.md](docs/repository-split.md) for the planned
multi-repository shape and [docs/public-release-roadmap.md](docs/public-release-roadmap.md)
for the gates before making this repository public.
See [docs/runner-control-plane-protocol.md](docs/runner-control-plane-protocol.md)
for the first public runner/control-plane protocol stub.
See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for public project hygiene.

## Current Status

Implemented on `master`:

- JSON flow loading and validation.
- Local-file and Google Drive input connectors.
- Isolated Git worktrees per run.
- Agent, command, gate, approval, sync-change, publish-change, and update-change stage types.
- Built-in issue execution flows finish with a reflection artifact that records
  follow-up issues, duplicates, non-actions, or a clean result.
- Agent runtime dispatch for Codex, Claude, and GLM through local CLIs.
- Bounded retries for failed agent, command, and gate stages.
- GitHub draft pull request publishing, same-repository PR branch updates,
  operator-driven PR comment rework, and merge-based PR branch sync.
- Local Web Console backed by `.nitely/tasks` and `.nitely/runs`.
- Planner Agent MVP in the Web Console: draft a spec from a GitHub issue or
  prompt, approve the spec, draft and approve a technical design, then start the
  implementation run.
- Persistent event-backed run status, logs, and resume.
- Bootstrap flows for letting Nitely implement Nitely issues.
- Flow-defined work items with typed artifacts: dev tasks are the built-in
  `dev.pr` work item type, non-dev flows declare their own `workItemType`, and
  high-risk types are governed by an allow-list. See
  [docs/work-item-model.md](docs/work-item-model.md).
- User-defined flows in the Web Console: list built-in and custom flows, create
  from a template, edit JSON with live schema-aware validation, and run a work
  item from a flow. Custom flows are stored in a local database and run without a
  flow file. See [docs/user-defined-flows.md](docs/user-defined-flows.md).
- Enforced flow harness and audit evidence: artifact integrity/provenance
  (`sha256`, provenance), command/approval evidence, required-output and JSON
  schema validation, stage-level high-risk gating, and a run evidence timeline.
  See [docs/harness-and-audit.md](docs/harness-and-audit.md).
- Context delivery optimized for large inputs: small textual artifacts are
  inlined, large textual artifacts are previewed with a mandatory read path, and
  binary artifacts are referenced by metadata/path. Agent and review-gate
  attempts record `stage.context.usage`, and the Web Console shows per-stage and
  run-total context usage. See
  [docs/context-delivery-and-usage.md](docs/context-delivery-and-usage.md).
- Resumable agent usage-limit blockers: provider quota and rate-limit failures
  are projected as `agent_usage_limit` blockers instead of normal attempt
  failures, and active blocker banners clear after resumed terminal runs.
- Runner/control-plane protocol helpers and a file-backed local stub for testing
  runner assignment, heartbeat, evidence metadata, and idempotent event replay.

In progress / planned:

- Interactive approval gates.
- Richer PR evidence reports.
- Provider connection setup beyond local environment and CLI checks.

## Requirements

- Node.js 24 or newer.
- pnpm 11.
- Git.
- `NITELY_GITHUB_TOKEN` or `GITHUB_TOKEN` for GitHub draft PR publishing and
  PR comment operations.
- Optional: GitHub CLI (`gh`) authenticated only when using the explicit
  `provider: "github-cli"` legacy fallback.
- Local agent CLI and credentials for each `agent` stage runtime you use. Codex
  uses the local `codex` CLI authentication, Claude requires
  `ANTHROPIC_API_KEY`, and GLM requires one of `NITELY_GLM_API_KEY`,
  `GLM_API_KEY`, or `ZHIPUAI_API_KEY`.

## Install

```bash
pnpm install
pnpm run build
```

Run the CLI from source:

```bash
pnpm dev -- --help
```

Run the built CLI:

```bash
node dist/index.js --help
```

## Validate A Flow

```bash
node dist/index.js validate flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
```

## Run A Bootstrap Task

The bootstrap flow accepts a specification and a technical design as local-file inputs:

```bash
node dist/index.js run flows/implement-spec-bootstrap.json \
  --repo . \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

Nitely will:

1. Create a branch named `nitely/<run-id>`.
2. Create a worktree under `.nitely/runs/<run-id>/worktree`.
3. Append run, workspace, stage, command, gate, approval, publish, reflection,
   and terminal events to `.nitely/events.db`.
4. Run the configured stages, retrying failed agent, command, and gate stages up to
   their configured attempt budget.
5. Push the branch and open a draft pull request when the publish stage succeeds.
6. Run a final reflection agent that audits the issue execution, searches for
   duplicate follow-up work, creates actionable GitHub issues when needed, and
   records the result as a `reflection` artifact.

By default, `publish-change` uses Nitely's GitHub provider and creates draft pull
requests through the GitHub API. Set `NITELY_GITHUB_TOKEN` for this provider;
`GITHUB_TOKEN` is accepted as a compatibility fallback. To use the old GitHub CLI
path during bootstrap, set the publish stage provider to `github-cli`.

## Context Policy And Redaction

Projects may add `nitely.context.json` at the repository root to control which
local files can be materialized into run context:

```json
{
  "version": 1,
  "include": ["**/*"],
  "exclude": [".env", ".env.*", "**/*.pem", "**/*.key"],
  "warnOnly": false,
  "redactEnv": ["NITELY_*", "GITHUB_TOKEN", "OPENAI_API_KEY"]
}
```

Missing policy files keep existing flows working, with built-in excludes for
common secret paths such as `.env`, private keys, `.git/**`, and
`.nitely/providers/**`. Each run writes
`.nitely/runs/<run-id>/context-manifest.json` with browser-safe input and
generated artifact metadata, with manifest string metadata redacted before disk
or Web API exposure. When `warnOnly` is true, excluded local inputs are recorded
as warned in the manifest and events, but their file bytes are omitted from
snapshots, prompts, evidence, and provider requests. Nitely redacts known secret
forms and configured environment/provider secret values before writing prompts,
command logs, sync-change reports, evidence, run events, PR bodies, and Web API
text responses; source snapshots and generated artifacts are not
modified in place.

## Project Constitution

Projects may add `.nitely/constitution.md` to define repo-local governing
principles for Nitely runs. When present and non-empty, Nitely injects it into
agent and review-gate prompts as `## Governing Principles`, then records the
constitution path and `sha256:` content hash in run evidence. Missing
constitution files keep existing flows working and are recorded as not loaded.

A starter template is available at
[docs/templates/nitely-constitution.md](docs/templates/nitely-constitution.md).
Copy it to `.nitely/constitution.md` in repositories where agents should follow
explicit non-negotiable execution principles.

Task breakdown artifacts can start from
[docs/templates/nitely-tasks.md](docs/templates/nitely-tasks.md), which uses
stable `T###` task IDs, phase headings, optional `[P]` parallel markers,
`[US-###]` story markers, and dependency metadata for scoped execution.

Feature specs can start from
[docs/templates/nitely-spec.md](docs/templates/nitely-spec.md), which keeps the
authoring format as Markdown while standardizing `US-###`, `FR-###`, and
`SC-###` IDs for flow-forward planning, living-spec updates, and flow-back PR
evidence.

Technical plans can start from
[docs/templates/nitely-technical-plan.md](docs/templates/nitely-technical-plan.md),
which standardizes `PD-###` implementation decisions, files/modules, test
strategy, constitution checks, and complexity tracking.

## Context Delivery And Usage

Nitely snapshots every supplied input artifact to disk before a stage consumes
it, but it no longer always inlines all input bytes into agent prompts. Prompt
delivery is optimized by artifact type and size:

- Textual inputs up to 8 KiB are fully inlined in the prompt.
- Textual inputs larger than 8 KiB are represented by metadata, a readable
  absolute `Full content` path, an 8 KiB head preview, and an explicit
  instruction that the agent must read the full file before using that input.
- Binary or non-textual inputs are represented by metadata and path only.
- Inputs omitted by `nitely.context.json` policy are represented as omitted by
  policy; their bytes are not snapshotted or sent to prompts.

Large input content remains available on disk at the shown path. This is a
token/context optimization, not data deletion. See
[docs/context-delivery-and-usage.md](docs/context-delivery-and-usage.md) for
the full delivery table and non-goals.

Each agent or review-gate attempt records one `stage.context.usage` event with:

- `promptBytes`: total assembled prompt size in bytes.
- `approxTokens`: dependency-free estimate, `ceil(promptBytes / 4)`.
- `inputBytesInlined`: input bytes actually inlined into the prompt.
- `inputBytesSaved`: input bytes kept out of the prompt because the artifact was
  previewed or referenced by path.
- `inputCount`: number of input artifacts rendered for the attempt.

Run projection folds these events onto attempt, stage, and run context usage.
The Web Console run details expose per-stage context usage and run-total context
usage when the run has these events; older runs simply omit the fields.

## Agent Runtime Configuration

Each `agent` stage or review gate must declare either a single `runtime` with
an optional `model`, or an ordered non-empty `runtimes` list:

```json
{
  "id": "implement",
  "type": "agent",
  "runtimes": [
    { "runtime": "claude" },
    { "runtime": "codex", "model": "gpt-5.3-codex-spark" }
  ],
  "prompt": "Implement the supplied specification.",
  "inputs": ["spec"],
  "outputs": ["implementation"]
}
```

The single-runtime form remains supported. A stage cannot declare both
`runtime`/`model` and `runtimes`. Nitely tries ordered candidates exactly as
listed and falls back only when the runtime cannot start or is externally
blocked by usage, rate, quota, capacity, credential, command, or launch/setup
errors. It does not fall back after the runtime completes and the stage fails
normal validation, such as missing outputs, failing commands, or failed review
gates.

Nitely trims the configured runtime value and resolves it through the local
runtime registry. Supported runtimes are:

- `codex`: runs `codex exec --sandbox <sandbox> --cd <worktree> -` and sends the
  prompt on stdin. `NITELY_CODEX_SANDBOX` overrides the sandbox value, with
  `NIGHTLY_CODEX_SANDBOX` accepted as a legacy fallback. `NITELY_CODEX_COMMAND`
  can override the command name.
- `claude`: runs `claude -p` and sends the prompt on stdin. Set
  `ANTHROPIC_API_KEY`. `NITELY_CLAUDE_COMMAND` can override the command name.
- `glm`: runs `glm chat` and sends the prompt on stdin. Set one of
  `NITELY_GLM_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY`.
  `NITELY_GLM_COMMAND` can override the command name.

The optional `model` field is passed to Codex as `-m <model>` and to Claude/GLM
as `--model <model>`. Unknown runtimes fail before spawning any command. Known
runtimes with missing required credentials are preflighted before spawn: a
single-runtime stage fails early, while an ordered `runtimes` stage records the
candidate as unavailable and continues to the next candidate. Candidate attempts
record the selected runtime/model, stdout/stderr logs, context usage, safe
missing configuration names, and fallback/blocker events in the run evidence.

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
`github-cli`, `claude`, `anthropic`, `glm`, `zhipu`, `codex`, and `openai`.
Known identifiers map to Nitely providers and fail fast when the corresponding
provider is not configured. `required_connectors` names provider ids directly:
`google-drive`, `github`, `anthropic`, `glm`, or `codex`. Missing-provider
failures name the stage, provider id, and setup hints such as
`NITELY_GOOGLE_ACCESS_TOKEN`. Unknown MCP ids are preserved in run events for
observability but do not block execution. This first slice validates known
provider availability; it does not launch MCP servers.

## Rework An Existing PR

Use `rework-pr` when review feedback or a follow-up spec should update an
existing pull request branch instead of opening a new PR:

```bash
node dist/index.js rework-pr 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

The target may be a PR number or a GitHub PR URL. Nitely resolves the PR through
the configured SCM provider, rejects fork or cross-repository heads, checks out
the PR head branch into `.nitely/runs/<run-id>/worktree` on that branch, and the
final `update-change` stage pushes commits back to that same PR branch. Rework
flows must use `update-change`; Nitely rejects rework-targeted flows that still
contain `publish-change` to avoid accidentally opening a second PR. Rework
evidence records the PR URL and number, base and head branches, previous and
updated head SHAs, triggering input sources, agent runtime/model declarations,
and completed stages.

## Process PR Comments

Use `pr-comments` to scan a PR for explicit `@nitely` commands without running a
webhook server or daemon:

```bash
node dist/index.js pr-comments 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --allow-author trusted-login
```

Supported commands are `@nitely rework <instruction>`, `@nitely address this
<instruction>`, and `@nitely explain <question>`. By default, actionable rework
only runs for GitHub authors with `OWNER`, `MEMBER`, or `COLLABORATOR`
association; `--allow-author` can add explicit trusted logins for local
operation. Duplicate comment bodies are recorded under
`.nitely/comment-triggers/github/<owner>/<repo>/<pr-number>/state.json` and do
not trigger duplicate runs.

Rework-producing comments create local `spec.md`, `tech-design.md`, and
`trigger.json` files under `.nitely/comment-triggers/.../<comment-id>/`, start a
same-PR rework run, and post a concise PR comment with the new run id and
evidence path. `@nitely explain` posts a deterministic response and does not
change the branch. Use `--dry-run` to see planned actions without creating runs,
comments, or state files.

## Resolve PR Conflicts

Use `resolve-conflicts-bootstrap` when an existing same-repository PR branch is
stale or conflicts with its base branch:

```bash
node dist/index.js rework-pr <pr> \
  --repo . \
  --flow flows/resolve-conflicts-bootstrap.json \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

`<pr>` may be a PR number or GitHub PR URL. The first version uses
`sync-change` with a merge strategy: Nitely fetches the PR base branch, merges it
into the checked-out PR worktree, writes `.nitely/runs/<run-id>/stages/sync/1/sync-report.md`,
and records structured sync evidence. Clean syncs continue through verification
and `update-change`; conflicted syncs leave Git conflict markers in the worktree
for the agent stage. Before `update-change`, verification checks tracked
unstaged changes, staged changes, unmerged index entries, and untracked
non-ignored files for conflict markers. The final stage updates the same PR
branch and does not use `publish-change`. Rebase continuation is not supported
yet.

## Inspect And Resume Runs

Run state is projected from the persisted SQLite event log, so runs remain
visible after the Nitely process exits:

```bash
node dist/index.js runs --repo .
node dist/index.js status <run-id> --repo .
node dist/index.js logs <run-id> --repo .
node dist/index.js logs <run-id> --repo . --stage implement
node dist/index.js resume <run-id> --repo .
```

If a stage has a `stage.started` event without a terminal stage event, status
projects it as `interrupted`. `resume` records that interrupted attempt as
failed with interruption context and starts the next attempt in the existing
worktree. For rework flows that already completed `sync-change`, resume also
reloads the generated `sync-report.md` from the run directory so downstream
agent prompts keep the same sync report input.

If an agent runtime or review gate reports provider capacity exhaustion, such as
Codex `hit your usage limit`, `quota exceeded`, or rate-limit text, Nitely
projects the run as `blocked` with reason `agent_usage_limit` instead of
spending retry attempts. `status` shows the blocked stage, runtime, original
sanitized provider message, and any extracted retry guidance; `logs` still show
the captured attempt stdout/stderr. After quota returns, credentials are fixed,
or the operator deliberately changes runtime configuration, run
`resume <run-id>` to continue from the blocked stage while reusing completed
upstream artifacts. Nitely does not purchase quota, refresh credentials, or
switch model/provider automatically.
After a resumed or fallback run completes or fails, current status, watch
output, and Web Console banners stop showing old blocker/error text from earlier
candidate attempts; those attempts still keep their diagnostics in run history.

## Retry Policy

Agent and command stages use a bounded retry budget. Nitely reads the budget
from `stage.maxAttempts`, then `spec.maxAttempts`, then defaults to `1`.
Each attempt writes an immutable directory under:

```text
.nitely/runs/<run-id>/stages/<stage-id>/<attempt>/
```

Command attempts write `stdout.log`, `stderr.log`, and `output.md`. Agent and
review-gate attempts write `prompt.md`, redacted `stdout.log` and `stderr.log`
when the execution backend can capture streams, `output.md`, `artifact.json`,
and one materialized file for every declared output. If a backend cannot capture
a stream, Nitely still writes the log file with a short explanatory line.

Agent output validation runs after the agent exits and before `stage.completed`
or a review gate pass is recorded. Missing declared outputs, malformed
`artifact.json`, unsafe paths that escape the attempt directory, undeclared
manifest output ids, and empty selected output files fail the attempt and enter
the normal retry/rework/escalation policy path. Failed agent retries receive a
prompt section with prior failure context and an instruction not to repeat the
failed approach. When the budget is exhausted, the run fails with an explicit
attempts-exhausted message.

## Web Console

Start the local console from a repository checkout:

```bash
pnpm dev -- web --repo . --host 127.0.0.1 --port 4173
```

The console centers on **Tasks** as the user-facing unit of work. `/tasks`
lists legacy `.nitely/tasks` records, generic `.nitely/work-items` records, and
historical runs that can be inferred as read-only tasks. `/tasks/<task-id>`
opens the canonical task detail view with metadata, input sources, local
specification and technical design content when available, associated sessions,
change request links, and typed artifact groups. Internally, generic
`.nitely/work-items` records remain the extensibility model for custom flows;
`/work-items` aliases back to `/tasks` in the Web Console for compatibility.
The **Plan work** form on `/tasks` creates draft tasks from a GitHub issue URL or
rough prompt through the Planner Agent workflow. On task detail, approve the
draft spec, draft the technical design, review persisted open questions, approve
the technical design, and then start the normal implementation run. Runs remain
blocked until both `specStatus` and `techDesignStatus` are `approved`.
Implementation changes to planning approval endpoints or
`src/work-items/planning.ts` should include deterministic negative transition
tests for the affected state-machine paths.
Session list and detail views include latest execution status, stage progress,
change request links, branch/worktree metadata, context manifests, context
usage, sanitized logs/evidence, review findings, and parent/child rework links
when available. Context manifests prefer safe fetched input metadata from run
snapshots over raw connector references, while timelines preserve known stage
types and lightweight resume/rework markers. `/runs` remains the
backward-compatible route for the Sessions view, and `/runs/<run-id>` opens a
first-class agent session detail page for completed, failed, running,
interrupted, and incomplete runs.

By default the console runs in local compatibility mode. Requests use a synthetic
`local` admin user, legacy tasks and runs without `ownerId` remain visible, and
provider writes continue to use `.nitely/connections.json`.

For a shared console, require login:

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-me' \
pnpm dev -- web --repo . --host 127.0.0.1 --port 4173 --auth required
```

`NITELY_WEB_AUTH=required` is also supported. On first start, if
`.nitely/users/users.json` is empty and the admin environment variables are set,
Nitely creates the initial admin. Required mode stores users in
`.nitely/users/users.json`, sessions in `.nitely/users/sessions/`, and
Web-saved provider credentials in `.nitely/users/<user-id>/connections.json`.
Passwords are salted `scrypt` hashes. API responses include only public user
fields and provider status; secret values are never returned.

Tasks created through the authenticated Web Console include `ownerId`, and runs
started from those tasks inherit it. Normal users see only their own tasks, runs,
and provider connection status. Admins can inspect legacy unowned tasks and runs,
but existing unowned data remains hidden from normal users in required mode.

The local JSON API exposes:

- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/draft-specs`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/approve-spec`
- `POST /api/tasks/:taskId/draft-tech-design`
- `POST /api/tasks/:taskId/approve-tech-design`
- `POST /api/tasks/:taskId/runs`
- `GET /api/work-items` and `GET /api/work-items/:id` remain compatibility APIs
  for internal/extensible work item clients.
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/providers`
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session`

Create a task on a running Nitely server from local markdown files:

```bash
pnpm dev -- task create \
  --server http://127.0.0.1:4173 \
  --title "Implement example feature" \
  --issue https://github.com/Instask/nitely-oss/issues/1 \
  --spec docs/templates/nitely-spec.md \
  --tech-design docs/templates/nitely-technical-plan.md \
  --flow flows/implement-spec-bootstrap.json
```

`--server` can be omitted when `NITELY_SERVER_URL` is set. The command posts the
file contents to `POST /api/tasks` and prints the task id plus the Web Console
`/tasks/<task-id>` URL. Use `--repo-id <id>` when the remote console was started
with multiple repositories.

`POST /api/tasks/:taskId/runs` returns as soon as the run has been accepted and
persisted, instead of waiting for every stage to complete. The response contains
`{ run: { runId, status, taskId, repoId, branchName } }`; use
`GET /api/runs/:runId` to poll final status and artifacts.

Watch remote progress without keeping the original start request open:

```bash
pnpm dev -- run watch <run-id> --server http://127.0.0.1:4173
pnpm dev -- task watch <task-id> --server http://127.0.0.1:4173
```

Both commands accept `--interval-ms <n>`, or use `NITELY_SERVER_URL` when
`--server` is omitted. They print one line per status/stage/output transition and
exit zero only when the run completes.

`GET /api/runs` and `GET /api/runs/:runId` include Web-facing observability
fields for active and recently active sessions: `currentStage`,
`currentAttempt`, `currentStageState`, `latestOutputSummary`, and
`latestDecision`. Run detail timeline items also include explicit `state`,
`currentAttempt`, `latestOutput`, `latestDecision`, attempt output summary path,
attempt `artifact.json` path, stdout/stderr log paths, and generated artifact
paths. Run detail responses include `contextUsage` totals when available, and
timeline stages include per-stage `contextUsage` folded from
`stage.context.usage` events. Stable stage state strings are `pending`, `running`, `gate-checking`,
`awaiting-orchestrator`, `retrying`, `reworking`, `escalated`, `failed`,
`completed`, `cancelled`, and `interrupted`. Output summaries are compact and
use the same Web redaction as persisted logs. A `stage.ready` event is exposed
as a pending current stage even before an attempt starts. For failed and
orchestrator-transition states, a later stage failure error takes precedence
over older stdout/stderr output in the compact latest-output fields.

Provider settings show whether local environment variables or CLIs are configured. The console never asks for ChatGPT, Claude, GitHub, or Google passwords and does not return secret values.

## Flow Format

Flows use `apiVersion: "nitely.dev/v1alpha1"` and define a list of stages:

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": {
    "name": "implement-spec-bootstrap"
  },
  "spec": {
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Implement the supplied specification and produce a concise pr-title artifact.",
        "inputs": ["spec"],
        "outputs": ["implementation", "pr-title"]
      },
      {
        "id": "test",
        "type": "gate",
        "mode": "deterministic",
        "command": "pnpm exec vitest run && pnpm run check && pnpm run build",
        "inputs": ["implementation"],
        "outputs": ["test-report"]
      },
      {
        "id": "publish",
        "type": "publish-change",
        "provider": "github",
        "inputs": ["implementation", "test-report", "pr-title"],
        "outputs": ["change-request"]
      },
      {
        "id": "reflect",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Reflect on the finished issue execution and record follow-up issues or a clean result.",
        "inputs": ["implementation", "test-report", "change-request"],
        "outputs": ["reflection"]
      }
    ]
  }
}
```

For built-in issue execution flows, `reflect` is the final stage after
`publish-change` or `update-change`. It is not a publish gate: the PR already
exists, and the reflection artifact records created follow-up issues, duplicate
matches, non-actions, or a clean no-follow-up result. Engine-level failures that
stop before the final stage still require a later finalizer/always-run feature.

Stage `outputs` remain backward compatible with string artifact ids. A stage can
also declare an output contract object when downstream prompts, evidence, or the
Web Console need durable artifact metadata:

```json
"outputs": [
  {
    "id": "implementation",
    "name": "Implementation summary",
    "type": "implementation",
    "description": "Markdown summary of code changes and verification",
    "mediaType": "text/markdown",
    "schema": { "kind": "markdown" },
    "version": "1"
  },
  "pr-title"
]
```

The `id` field uses the same identifier rules as string outputs. `name`,
`type`, `description`, `mediaType`, `schema`, and `version` are optional; Nitely
records `schema` as opaque JSON and does not validate artifact file contents
against it. Accepted output filenames are unchanged: agents still write
`<id>.md` or `<id>.txt`.

Agents may also write an attempt-local `artifact.json` manifest:

```json
{
  "version": 1,
  "stageId": "implement",
  "attempt": 1,
  "outputs": [
    {
      "id": "implementation",
      "path": "implementation.md",
      "mediaType": "text/markdown"
    }
  ]
}
```

Manifest paths must be relative paths inside the same attempt directory, and
each manifest output id must match a declared stage output. If `artifact.json`
is absent, Nitely remains backward compatible by discovering `<id>.md` first and
then `<id>.txt` for each declared output, validating those files, and writing a
synthesized manifest for the successful attempt.

Each run writes `.nitely/runs/<run-id>/artifacts.json` with external input and
generated artifact records. Generated artifact events feed run projection, and
PR evidence includes an `Artifacts` section. The Web Console run detail API also
returns artifact metadata and file paths.

Nitely records each orchestrator policy choice as an
`orchestrator.decision` event before applying the selected action. Decision
payloads include stage id/type, attempt, max attempts, action, reason, error
summary when present, and rework target when present. Evidence includes an
`Orchestrator Decisions` section so retry, rework, escalation, completion, and
failure rationale can be audited from the run directory.

A `gate` stage records a structured `gate.result` JSON artifact and emits a
`gate.completed` event before the stage completes or fails. Deterministic gates
run a shell `command`, honor `timeoutMs` when set, and pass when the exit code
is zero. Review gates run
through an agent `runtime` with a `prompt`, optional `model`, and optional
`skills`, must declare at least one output, do not accept `timeoutMs`, require
the primary declared output file (`<id>.md` or `<id>.txt`), and record the
reviewed input artifact ids plus a bounded copy of that output in the structured
gate result. Review gates fail when that output contains an explicit failing
verdict such as `Review verdict: fail` or a blocking severity marker at the
start of a heading/line such as `### P1 - ...` or `[P0] ...`. Clean review text,
explicit pass verdicts, and P2/P3 advisory findings continue to pass. PR
evidence includes a `Gates` section with each gate's mode, command or runtime,
review output path, status, and failure reason when present.

An `agent` stage may set an optional `model` to choose the model for its
`runtime`. When `model` is omitted, the selected CLI default is used. Generated
PR evidence includes an `Agent Runtimes` section with each agent stage id,
runtime, and model or `default`.

An `agent` stage may also opt into local skills with `skills`. Skills are
repository-defined instruction packs discovered only from
`.nitely/skills/<skill-id>/SKILL.md`; they are never selected automatically and
are not global project instructions.

```text
.nitely/skills/tdd/SKILL.md
.nitely/skills/tdd/checklist.md
```

`SKILL.md` must contain frontmatter with a matching `name`, a non-empty
`description`, and a non-empty instruction body:

```markdown
---
name: tdd
description: Write tests before implementation
---

Follow red-green-refactor.
```

Flow stages reference skills by id:

```json
{
  "id": "implement",
  "type": "agent",
  "runtime": "codex",
  "skills": ["tdd"],
  "required_mcp_servers": ["google-drive"],
  "required_connectors": ["github"],
  "prompt": "Implement the supplied specification.",
  "inputs": ["spec"],
  "outputs": ["implementation"]
}
```

Skill ids use the same identifier shape as stages and artifacts: they start with
a letter or number and contain only letters, numbers, dots, underscores, and
hyphens. `skills` is valid only on `agent` stages, while
`required_mcp_servers` and `required_connectors` are valid on `agent` stages and
review gates. Duplicates on the same stage are rejected. Missing skills,
malformed frontmatter, empty bodies, name mismatches, invalid ids, and unsafe
bundled resource paths fail before the agent command starts with an error naming
the stage and skill.

Files under `.nitely/skills/<skill-id>/` other than `SKILL.md` are optional
bundled resources. Nitely does not follow symlinks. Resource files are copied to
`.nitely/runs/<run-id>/skills/<skill-id>/...` and listed in the injected
`## Skills` prompt section so the agent can read a stable run snapshot without
polluting the git worktree. Prompt and evidence text for skills passes through
the same runtime redaction path as other prompts and evidence. Generated PR
evidence includes a `Loaded Skills` section with the stage id, skill id, source
path, description, content hash, and resource snapshot paths. Loaded skill
metadata is also persisted in run events so resumed `publish-change` and
`update-change` stages can include skills loaded by already-completed agent
stages.

Publish and update stages can consume an agent-produced PR title artifact. By
convention, declare `pr-title` as an agent output and pass it to
`publish-change` or `update-change`. The agent can materialize that artifact as
`pr-title.md` or `pr-title.txt` in its attempt directory. Agent prompts include
the attempt directory and accepted filenames for each declared output, and the
local backend exposes that same directory as `NITELY_ATTEMPT_DIR` and
`NITELY_OUTPUT_DIR`. Nitely trims the title, removes a leading markdown heading
marker, collapses whitespace and line breaks to one space, and bounds the final
PR title to 120 characters. If the artifact is not supplied, missing, or empty
after sanitization, Nitely keeps the fallback title `Nitely: <flow-name>` and
fallback publish commit message `feat: <flow-name>`. Evidence and
`change.published` or `change.updated` events record the resolved title and
whether it came from an artifact or fallback.

## Development

```bash
pnpm exec vitest run
pnpm run check
pnpm run build
```

## Deployment Note

The deployed server should stay on `master`. Nitely-generated branches and worktrees are execution artifacts for review and should not become the deployed checkout until their PRs are merged.

## License

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
