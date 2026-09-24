# Running Flows

How to validate, run, and configure a flow from a Nitely checkout. Commands are run from the repository root. Installation is in the [README](../README.md).

## Validate A Flow

```bash
node dist/index.js validate flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
```

## Inspect A Flow Graph

```bash
node dist/index.js graph flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
node dist/index.js graph flows/implement-spec-bootstrap.json --format mermaid \
  --external-input spec \
  --external-input tech-design
```

`graph` prints a read-only projection of the artifact-derived DAG (text by
default; `--format mermaid` is pasteable into GitHub; `--format json` is
structured). Flows are still authored and edited as JSON — there is no visual
DAG editor. Rework back-edges are not shown; the projection is the static
producer/consumer graph.

## Run A Bootstrap Task

The bootstrap flow accepts a specification and a technical design as local-file inputs:

```bash
node dist/index.js run flows/implement-spec-bootstrap.json \
  --repo . \
  --input spec=specs/issues/005-run-state-logs-resume-spec.md \
  --input tech-design=docs/plans/2026-06-19-run-state-logs-resume-tech-design.md
```

### Change-size flows

Choose a static flow tier when starting a run; the JSON topology stays
declarative and does not classify changes at runtime:

- `flows/implement-small.json` runs implement, test, and publish for low-risk
  changes and skips the expensive review gate.
- `flows/implement-medium.json` runs implement, test, review, and publish for
  changes that need an explicit quality gate.

For example:

```bash
nitely run flows/implement-medium.json --repo . \
  --input spec=./spec.md --input tech-design=./tech-design.md
```

Use the small flow only when the operator accepts the reduced review coverage;
use the medium flow when a review verdict must block publishing. A large flow
can be added later as another static file without conditional expressions in
the flow schema.

### Run one stage

Use `run-stage` to inspect or replay one stage without running the rest of a
flow:

```bash
node dist/index.js run-stage flows/implement-spec-bootstrap.json review \
  --dry-run
node dist/index.js run-stage flows/implement-spec-bootstrap.json test \
  --repo . --input-dir .nitely/runs/<run-id>/stages/implement/1
```

`--dry-run` prints the stage type, runtime/model or command, input/output
contract, attempt budget, and action without creating a worktree or contacting
an external provider. For replay, `--input name=path` supplies one artifact;
`--input-dir` supplies files named after artifact ids or a prior attempt
directory containing `artifact.json` with `{ "id", "path" }` output entries.
The selected stage runs in a new Nitely worktree based on `--repo`; point
`--repo` at the checkout or attempt worktree whose code should be tested.
Publish, update, sync, and approval stages are dry-run only through this
command to avoid accidental external side effects.

### Bounded CI Repair

Operators can submit one observed GitHub check failure to a bounded repair cycle:

```bash
node dist/index.js ci-repair submit ./ci-failure.json \
  --repo . --flow flows/rework-pr-bootstrap.json \
  --input spec=./spec.md --input tech-design=./tech-design.md
```

The cycle updates the existing pull request only, runs declared local checks
and the flow review gate, then observes remote checks once. Submissions are
deduplicated by provider/repository/PR/check/head identity and persisted under
`.nitely/ci-repair.db`; redacted evidence is also written to
`.nitely/ci-repair/<idempotency-key>.json`. A second submission of the same
observation returns the stored result without running repair again.
Use `--resume` only after an interrupted submission; it continues from the
persisted local/remote evidence and keeps the two-observation budget.
Human decisions can be recorded without triggering a merge or deploy:

```bash
node dist/index.js ci-repair decide <idempotency-key> \
  --repo . --decision reject --actor leo --reason "Needs manual fix"
```

### Local-file `--input` path resolution

- Relative `--input` paths resolve against the CLI process current working
  directory (`process.cwd()`), not against `--repo`.
- Absolute paths are kept as given.
- A resolved local-file path must land under **either** the target `--repo`
  directory **or** the process cwd (the extra allow-root for multi-repo
  operator use). Paths outside both roots are rejected, including symlinks
  that escape those roots.
- This lets you keep specs next to a Nitely install while running against
  another checkout, for example:
  `nitely run ... --repo /other/repo --input spec=./local-spec.md`.

To dogfood the same bootstrap path with Grok Build instead of Codex, use the
Grok variant. A real run requires the local `grok` CLI (`grok login` or
`XAI_API_KEY`); the flow leaves `model` unset so the CLI default remains
authoritative:

```bash
node dist/index.js run flows/implement-spec-bootstrap-grok.json \
  --repo . \
  --input spec=specs/issues/085-grok-bootstrap-flow-spec.md \
  --input tech-design=docs/plans/2026-08-02-grok-bootstrap-flow-tech-design.md
```

To dogfood the same bootstrap path with Pi instead of Codex, use the Pi variant.
A real run requires the local `pi` CLI (configure model/provider auth through
the Pi CLI); the flow leaves `model` unset so the CLI default remains
authoritative. Spec and tech-design inputs may live under `specs/issues/` and
`docs/plans/`:

```bash
node dist/index.js run flows/implement-spec-bootstrap-pi.json \
  --repo . \
  --input spec=specs/issues/455-pi-bootstrap-flow-spec.md \
  --input tech-design=docs/plans/2026-08-02-pi-bootstrap-flow-tech-design.md
```

To dogfood the same bootstrap path with Claude Code instead of Codex, use the
Claude variant. A real run requires the local `claude` CLI and `ANTHROPIC_API_KEY`;
the flow leaves `model` unset so the CLI default remains authoritative. Unlike
the Grok and Pi variants, this one mirrors the Codex baseline in full: it keeps
the blocking `review` gate and the final `reflect` stage.

```bash
node dist/index.js run flows/implement-spec-bootstrap-claude.json \
  --repo . \
  --input spec=specs/issues/005-run-state-logs-resume-spec.md \
  --input tech-design=docs/plans/2026-06-19-run-state-logs-resume-tech-design.md
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

## Map Task Artifacts To GitHub Issues

Publish a committed Markdown task artifact into the repository configured as
the checkout's `origin`:

```bash
node dist/index.js tasks-to-issues \
  --repo . \
  --tasks specs/example/tasks.md \
  --spec specs/example/spec.md \
  --plan docs/plans/example-tech-design.md \
  --group-by task
```

Use `--group-by phase` to create one issue for each task phase. Nitely scans all
open and closed issues before creating anything, reuses canonical `T001: ...`
titles and its own task-ID markers, and aborts the complete sync when an existing
group is partial or split across issues. The three source files must be tracked
and unchanged from `HEAD`, so created issue bodies can use immutable commit
links.

The command derives the GitHub owner and repository only from `origin`; there is
no independent target-repository flag. A successful sync atomically records
task-to-issue bindings in ignored local state at `.nitely/task-issues.json`.
Runs using `--task-scope` cite those issue URLs and unmapped task IDs in
`evidence.md`; the run event stream preserves that mapping across resume even if
the local registry later changes. At completed, failed, or blocked terminal
status, Nitely adds one
marker-backed run comment per covered issue with the run ID, local evidence
path, and PR URL when available. Retrying reuses that comment; resuming from a
blocked or failed state updates it in place with the latest status and PR rather
than adding another one.

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

## Local Evidence Lifecycle

Nitely retains `.nitely/events.db` and `.nitely/runs` indefinitely by default.
An optional repo-root `nitely.evidence.json` can define separate windows for
whole run directories, event histories, logs, registered artifacts, and
`evidence.md` summaries. Recovery patch checkpoints follow the artifact window.
Inspect the effective policy before cleanup:

```bash
node dist/index.js evidence policy --repo .
node dist/index.js evidence prune --repo .
```

`evidence prune` is a dry-run unless `--apply` is explicitly present, and active
or interrupted runs are never selected. Operators can search run/task/repo/flow,
status, PR, blocker, date, and artifact metadata, then build a checksummed
metadata-only closeout package:

```bash
node dist/index.js evidence search --repo . --status blocked
node dist/index.js evidence export --repo . \
  --run <run-id> \
  --output ./nitely-closeout
```

Default exports reconstruct a structured summary and exclude source, inputs,
worktrees, prompts, raw logs, evidence text, artifact contents, and free-form
gate/blocker output. `--include-raw` is an explicit sensitive-content opt-in,
adds recovery patch checkpoints when present, and adds a warning to the bundle. See
[Local Evidence Retention, Search, And Export](evidence-retention-search-export.md)
for the policy schema, exact data boundary, filters, and prune semantics.

## Project Constitution

Projects may add `.nitely/constitution.md` to define repo-local governing
principles for Nitely runs. When present and non-empty, Nitely injects it into
agent and review-gate prompts as `## Governing Principles`, then records the
constitution path and `sha256:` content hash in run evidence. Missing
constitution files keep existing flows working and are recorded as not loaded.

A starter template is available at
[docs/templates/nitely-constitution.md](templates/nitely-constitution.md).
Copy it to `.nitely/constitution.md` in repositories where agents should follow
explicit non-negotiable execution principles.

## Project Instructions

Projects may add `.nitely/instructions.json` for advisory implementation and
review instructions grouped by stage type and repo-relative glob filters. Nitely
injects matching groups into agent and review-gate prompts and records the
instruction file path, hash, group filters, and resolved stage context controls
in run evidence. Flows can also isolate stages from inherited prompt context or
temporarily disable root `AGENTS.md`/`CLAUDE.md` loading. See
[docs/project-instructions.md](project-instructions.md) and the starter
template at
[docs/templates/nitely-instructions.json](templates/nitely-instructions.json).

Task breakdown artifacts can start from
[docs/templates/nitely-tasks.md](templates/nitely-tasks.md), which uses
stable `T###` task IDs, phase headings, optional `[P]` parallel markers,
`[US-###]` story markers, and dependency metadata for scoped execution.

The canonical artifact chain is documented in
[docs/canonical-artifacts.md](canonical-artifacts.md): spec -> technical
design -> tasks -> run evidence -> PR evidence. Source-controlled Markdown is
the canonical execution artifact; external docs are collaboration inputs or
snapshots until materialized locally.

When implementation and approved artifacts may have drifted, use the
[convergence pass](convergence-pass.md) to classify gaps and generate a
new task artifact with stable appended IDs. The original spec, plan, and tasks
remain unchanged, and a clean pass is byte-for-byte identical.

Feature specs can start from
[docs/templates/nitely-spec.md](templates/nitely-spec.md), which keeps the
authoring format as Markdown while standardizing `US-###`, `FR-###`, and
`SC-###` IDs for flow-forward planning, living-spec updates, and flow-back PR
evidence.

Technical plans can start from
[docs/templates/nitely-technical-plan.md](templates/nitely-technical-plan.md),
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
[docs/context-delivery-and-usage.md](context-delivery-and-usage.md) for
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
- `claude`: runs `claude -p --output-format json` and sends the prompt on
  stdin. Write-capable stages with `commands.mode` none pass
  `--permission-mode acceptEdits`. Stages that may also run commands pass
  `--permission-mode bypassPermissions` (the unattended equivalent of Grok
  `--always-approve`). Read-only stages (`write` none and `commands` none)
  keep Claude's default `-p` mode. A stage that forbids writes but still
  allows commands fails closed, because a shell command can mutate the
  worktree. Declared stage inputs are added with `--add-dir` on each
  `inputs/<id>` directory so `fullReadInputs` paths outside the worktree are
  readable without exposing the rest of the run input tree. Set
  `ANTHROPIC_API_KEY`. `NITELY_CLAUDE_COMMAND` can override the command
  name.
- `glm`: runs `glm chat` and sends the prompt on stdin. Set one of
  `NITELY_GLM_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY`.
  `NITELY_GLM_COMMAND` can override the command name.
- `grok`: runs `grok --no-auto-update --cwd <worktree> --always-approve`
  with `-p <prompt>`. Authenticate with local `grok login` or `XAI_API_KEY`.
  `NITELY_GROK_COMMAND` can override the command name.
- `pi`: runs `pi -p` and sends the prompt on stdin. Configure Pi's model
  provider through the local Pi CLI configuration. `NITELY_PI_COMMAND` can
  override the command name.

The optional `model` field is passed to Codex as `-m <model>` and to Claude,
GLM, Grok Build, and Pi as `--model <model>`. Unknown runtimes fail before
spawning any command. Known runtimes with missing required credentials are
preflighted before spawn: a
single-runtime stage fails early, while an ordered `runtimes` stage records the
candidate as unavailable and continues to the next candidate. Candidate attempts
record the selected runtime/model, stdout/stderr logs, context usage, safe
missing configuration names, and fallback/blocker events in the run evidence.

### Bootstrap model tiers

The primary `flows/implement-spec-bootstrap.json` flow uses explicit model
tiers: `gpt-5.3-codex-spark` for test authoring, `gpt-5.3-codex` for
implementation, and `gpt-5` for review. This keeps cheaper work on the
cheaper model and reserves the more expensive model for the quality-deciding
review gate. The tier names are ordinary runtime/model pairs, not a new schema
or automatic router.

Provider variants may use the same convention with provider-supported model
ids, for example cheap scan/write-tests, mid-tier implementation, and
expensive review. Keep the pair explicit in each flow and verify it against
the repository's runtime capability policy; do not assume model names are
portable across providers. Operators can copy a flow and override the pairs
when their provider account, policy, or cost boundary differs.
