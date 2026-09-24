# Nitely

[中文](./README.zh-CN.md)

Nitely is an open, local-first governed spec-to-PR execution system. It turns
approved engineering intent into evidence-backed, reviewable draft pull
requests.

Versioned Flows declare inputs, outputs, typed artifacts, gates, verification,
and publication. Nitely runs those contracts in isolated Git worktrees and
preserves decisions, commands, blockers, recovery, and rework as review-grade
evidence.

Codex, Claude, GLM, Grok Build, Pi, and future coding agents are
interchangeable runtimes for Nitely Flows. Nitely is not an Agent workforce,
chat/inbox, or project-management
suite; it is the governed delivery and evidence layer between approved work and
a PR.

The product thesis is: plan by day, execute by night, review by morning. See
[docs/usage-scenarios-and-efficiency-thesis.md](docs/usage-scenarios-and-efficiency-thesis.md)
for the solo-founder and small-team scenarios behind that framing.

`Nitely` is a temporary internal codename. The public brand must be renamed and
professionally cleared before any public landing page, SaaS control plane, paid
offer, or package launch. See the dated
[naming strategy](docs/naming-strategy.md) for the decision and launch gate.

The project is currently in bootstrap. The CLI/runtime exists, and a local Web Console MVP is available for creating tasks, starting runs, inspecting run metadata, and checking provider configuration hints.

## Open-Core Boundary

Nitely's open-source core is the inspectable local spec-to-PR execution system:
flow validation, local worktrees, local agent runtime dispatch, context/redaction
policy, logs, evidence, retry/resume, and draft PR publishing stay visible and
runnable without a hosted Nitely service.

Commercial and team products should help organizations operate that core
reliably across repositories, people, policies, retention, SSO, audit trails, and
customer-hosted runners. They should not make core reliability, evidence, local
execution, or secret-boundary transparency commercial-only.

See [docs/open-core-boundary.md](docs/open-core-boundary.md) for the boundary
and [docs/open-core-feature-audit.md](docs/open-core-feature-audit.md) for the
current feature inventory. See [docs/security-and-trust.md](docs/security-and-trust.md)
for code, secret, log, evidence, retention, and future control-plane data
boundaries. See [docs/trust-and-verification-model.md](docs/trust-and-verification-model.md)
for the canonical product and architecture thesis. See [docs/positioning.md](docs/positioning.md)
for the buyer-facing positioning package. See
[docs/mobile-support-boundary.md](docs/mobile-support-boundary.md) for the iOS
and Android support boundary.

## Current Status

Implemented on `master`:

- JSON flow loading and validation.
- Local-file and Google Drive input connectors.
- Isolated Git worktrees per run.
- Agent, command, gate, approval, sync-change, publish-change, and update-change stage types.
- Built-in issue execution flows finish with a reflection artifact that records
  follow-up issues, duplicates, non-actions, or a clean result.
- Agent runtime dispatch for Codex, Claude, GLM, Grok Build, and Pi through local CLIs.
- Bounded retries for failed agent, command, and gate stages.
- GitHub draft pull request publishing, same-repository PR branch updates,
  operator-driven PR comment rework, and merge-based PR branch sync.
- Local Web Console backed by `.nitely/tasks` and `.nitely/runs`.
- Local stdio MCP server for external AI coding tools, backed by scoped,
  default-deny API tokens and metadata-only action audit. See
  [docs/local-mcp.md](docs/local-mcp.md).
- Planner Agent MVP in the Web Console: draft a spec from a GitHub issue, Jira
  ticket, or prompt, approve the spec, draft and approve a technical design,
  then start the implementation run. Jira intake preserves normalized source
  snapshots, duplicate prevention, drift detection, and optional status sync.
- The canonical approval-first ticket-to-PR product contract maps ticket
  intake, planning approval, governed execution, PR review/rework, evidence,
  metrics, and trust boundaries to shipped surfaces and repeatable proof. See
  [docs/approval-first-ticket-to-pr.md](docs/approval-first-ticket-to-pr.md).
- Persistent event-backed run status, logs, and resume.
- Bootstrap flows for letting Nitely implement Nitely issues.
- Pilot-ready production flow templates for approved specs, bug tickets, and
  PR review rework, plus a bounded security-fix flow for supported vulnerability
  classes. See [docs/pilot-flow-templates.md](docs/pilot-flow-templates.md) and
  [docs/security-fix-flow.md](docs/security-fix-flow.md).
- The primary deterministic golden-path demo for approved task implementation,
  verification, evidence-backed draft PR publication, reviewer feedback, and
  controlled same-PR rework. See
  [docs/golden-path-demo.md](docs/golden-path-demo.md).
- First paid pilot package for high-touch customer pilots. See
  [docs/paid-pilot-offering.md](docs/paid-pilot-offering.md).
- Customer validation workflow for interviewing teams already using AI coding
  tools. See [docs/customer-validation.md](docs/customer-validation.md).
- Buyer-facing positioning package for explaining Nitely as a governed
  spec-to-PR execution system rather than an Agent-workforce platform, plus a
  GitHub-first upstream intake/result contract. See
  [docs/positioning.md](docs/positioning.md) and
  [docs/upstream-integration-contract.md](docs/upstream-integration-contract.md).
- Canonical trust-and-verification model: evidence-backed software changes,
  independent verification, risk-based human attention, and bounded recovery.
  See [docs/trust-and-verification-model.md](docs/trust-and-verification-model.md).
- Flow-defined work items with typed artifacts: dev tasks are the built-in
  `dev.pr` work item type, non-dev flows declare their own `workItemType`, and
  high-risk or protected custom types are governed by repo policy. See
  [docs/work-item-model.md](docs/work-item-model.md).
- Risk-based review policy driven by the actual diff: an effective risk class is
  computed from the declared work-item baseline plus deterministic diff signals
  (protected paths, migrations, dependency manifests, deletions, size,
  CODEOWNERS), recorded as run evidence with the exact signals that raised it,
  recomputed after rework, and mapped by repo policy to the required human
  review. See
  [docs/risk-based-review-policy.md](docs/risk-based-review-policy.md).
- Static multi-perspective review: two or three fixed review gates (correctness,
  security, spec conformance) run independently and a `review-aggregate` gate
  merges their findings into one fail-closed decision before publish. See
  [docs/multi-perspective-review.md](docs/multi-perspective-review.md).
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
- Structured operator-question blockers: agent stages can pause with a validated
  `question.json`, operators can answer from the CLI or Web Console, and resume
  injects the auditable decision into the next attempt.
- Advanced Approval Inbox actions and optional notification delivery: sources
  declare supported actions and mandatory reasons, human decisions are copied
  to task/run evidence, and durable source-key receipts deduplicate GitHub,
  Jira, Slack, HTTPS email-relay, and signed customer-webhook mirrors. See
  [docs/notification-actions-and-delivery.md](docs/notification-actions-and-delivery.md).

In progress / planned:

- Provider connection setup beyond local environment and CLI checks where it
  supports governed execution; provider count is not a roadmap goal.

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
  `ANTHROPIC_API_KEY`, GLM requires one of `NITELY_GLM_API_KEY`, `GLM_API_KEY`,
  or `ZHIPUAI_API_KEY`, Grok Build uses local `grok login` or `XAI_API_KEY`,
  and Pi uses the local Pi CLI/model configuration.

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

## Install The Nitely Agent Skill

`skills/nitely/` is an agent skill that teaches a coding agent how to install,
configure, and operate Nitely, so a new user can ask their agent to set it up
instead of reading this whole README first.

```bash
scripts/install-nitely-skill
```

Without a checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/jerryleooo/nitely/master/scripts/install-nitely-skill | bash
```

Both install the personal Claude Code skill at
`${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nitely`. Use `--project [PATH]` for a
single repository, `--nitely-repo PATH` to install it as a Nitely run skill at
`PATH/.nitely/skills/nitely`, `--dest PATH` for any other agent, and `--force`
to replace an existing install. See [docs/nitely-skill.md](docs/nitely-skill.md).

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
[Local Evidence Retention, Search, And Export](docs/evidence-retention-search-export.md)
for the policy schema, exact data boundary, filters, and prune semantics.

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

## Project Instructions

Projects may add `.nitely/instructions.json` for advisory implementation and
review instructions grouped by stage type and repo-relative glob filters. Nitely
injects matching groups into agent and review-gate prompts and records the
instruction file path, hash, group filters, and resolved stage context controls
in run evidence. Flows can also isolate stages from inherited prompt context or
temporarily disable root `AGENTS.md`/`CLAUDE.md` loading. See
[docs/project-instructions.md](docs/project-instructions.md) and the starter
template at
[docs/templates/nitely-instructions.json](docs/templates/nitely-instructions.json).

Task breakdown artifacts can start from
[docs/templates/nitely-tasks.md](docs/templates/nitely-tasks.md), which uses
stable `T###` task IDs, phase headings, optional `[P]` parallel markers,
`[US-###]` story markers, and dependency metadata for scoped execution.

The canonical artifact chain is documented in
[docs/canonical-artifacts.md](docs/canonical-artifacts.md): spec -> technical
design -> tasks -> run evidence -> PR evidence. Source-controlled Markdown is
the canonical execution artifact; external docs are collaboration inputs or
snapshots until materialized locally.

When implementation and approved artifacts may have drifted, use the
[convergence pass](docs/convergence-pass.md) to classify gaps and generate a
new task artifact with stable appended IDs. The original spec, plan, and tasks
remain unchanged, and a clean pass is byte-for-byte identical.

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

## Execution Backends

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

## Rework An Existing PR

Use `rework-pr` when review feedback or a follow-up spec should update an
existing pull request branch instead of opening a new PR:

```bash
node dist/index.js rework-pr 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --input spec=specs/issues/022-pr-rework-flow-spec.md \
  --input tech-design=docs/plans/2026-06-19-pr-rework-flow-tech-design.md
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
  --input spec=specs/issues/023-conflict-resolution-flow-spec.md \
  --input tech-design=docs/plans/2026-06-19-conflict-resolution-flow-tech-design.md
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

Run state is projected from the persisted SQLite event log under the target
`--repo`, so runs remain visible after the Nitely process exits. Default
`--repo` is `.` (process cwd). When a `run` finishes (or pauses), the CLI
prints copy-pastable multi-repo status hints:

```text
Status command: nitely status <run-id> --repo <absolute-repo-path>
Run directory: <absolute-repo-path>/.nitely/runs/<run-id>
```

```bash
node dist/index.js runs --repo .
node dist/index.js status <run-id> --repo .
node dist/index.js diagnose <run-id> --repo .
node dist/index.js logs <run-id> --repo .
node dist/index.js logs <run-id> --repo . --stage implement
node dist/index.js resume <run-id> --repo .
```

If `status` cannot find a run under the selected repo, the error mentions
retrying with `--repo` set to the path used for `run`.

A runner killed with SIGKILL writes no terminal event. `status` therefore
reports a `running` run whose open attempt has been silent for longer than the
stale threshold as `interrupted`, matching the Web Console, so a dead run does
not look alive forever. The threshold defaults to 5 minutes and is set with
`NITELY_STALE_RUNNING_RUN_MS`.

Runs are also bounded. Every run sits under a machine-wide runaway ceiling of
2,000,000 uncached runtime tokens; crossing it fails the run with a
`budget.exceeded` event naming the cap, the consumed total, and the stage and
attempt that crossed it. Set `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` to another
positive integer to change the ceiling, or to `0` to opt out. Flows cannot
declare `spec.budgets`; load rejects that field and names this env var as the
replacement. The cap counts uncached runtime tokens: cache reads are excluded
and reported separately, while cache creation and fresh input are charged in
full. After a budget stop, raise `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` above the
consumed total and `nitely resume` continues at the first incomplete stage;
resuming without raising the cap is refused with that total instead of
re-tripping the same bound. See
[Runaway Ceiling](docs/flow-authoring-guide.md#runaway-ceiling).

When an agent cannot safely proceed without a human decision, it may write a
validated `question.json`. Nitely blocks with `awaiting_operator_answer`
without recording a failed attempt. Inspect and answer it, then resume:

```bash
node dist/index.js questions <run-id> --repo .
node dist/index.js answer <run-id> <question-id> --option <option-id> --actor <name> --repo .
# Or provide a free-text alternative:
node dist/index.js answer <run-id> <question-id> --text "<answer>" --actor <name> --repo .
node dist/index.js resume <run-id> --repo .
```

The next attempt receives the question and answer as an authoritative prompt
section. Both events remain visible in Web and PR evidence.

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

For a blocked **review gate** only, a qualified human reviewer may instead
attach a manual verdict to the exact artifacts declared by that gate:

```bash
node dist/index.js review-verdict <run-id> \
  --file review.md \
  --actor reviewer@example.com \
  --reviewed-artifact implementation \
  --repo .
node dist/index.js resume <run-id> --repo .
```

The review file must contain the normal review signal, such as
`Review verdict: pass`, `Review verdict: fail`, or a P0/P1 finding. Nitely
records the actor, timestamp, reviewed artifact ids, original blocker, review
text, and gate result before resume. The run remains blocked until the explicit
`resume`; a passing manual verdict reuses the blocked attempt without launching
the review runtime or rerunning upstream stages, while a failing verdict stops
before publish. Prefer waiting for quota recovery or switching to another
configured runtime when no qualified human has actually reviewed every declared
artifact.

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
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

The console centers on **Tasks** as the user-facing unit of work. `/tasks`
lists legacy `.nitely/tasks` records, generic `.nitely/work-items` records, and
historical runs that can be inferred as read-only tasks. `/tasks/<task-id>`
opens the canonical task detail view with metadata, input sources, local
specification and technical design content when available, associated sessions,
change request links, and typed artifact groups. Internally, generic
`.nitely/work-items` records remain the extensibility model for custom flows;
`/work-items` aliases back to `/tasks` in the Web Console for compatibility.
The **Plan work** form on `/tasks` creates draft tasks from a GitHub issue URL,
Jira ticket URL or key, an external document, or a rough prompt through the
Planner Agent workflow. On task detail, approve the draft spec, draft the
technical design, review persisted open questions, approve the technical
design, and then start the normal implementation run. Runs remain blocked until
both `specStatus` and `techDesignStatus` are `approved`. The Web Console, the
CLI, and `POST /api/draft-specs` share those transitions; see
[docs/planning-intake.md](docs/planning-intake.md) for the intake contract,
source provenance, and drift behavior.

External document intake carries a document URL plus the snapshot text a
connector fetched, with an optional provider revision. Nitely stores the URL,
snapshot, and a content hash as the planning baseline; it never fetches the
document itself and never stores provider credentials. Re-submitting the same
document URL reuses its task and records drift when the snapshot changed.
GitHub issue intake uses configured Web Console GitHub provider credentials, or
`NITELY_GITHUB_TOKEN` / `GITHUB_TOKEN`, and falls back to unauthenticated fetching
for public issues.

### Visual tour

These screenshots show the main local-first workflow. They come from the current
Web Console and contain no credentials or production data.

| Tasks and planning | Task approval and preflight |
| --- | --- |
| ![Nitely Tasks and Planner Agent form](docs/assets/screenshots/web-console-tasks.png) | ![Nitely task detail with approval and preflight state](docs/assets/screenshots/web-console-task-detail.png) |

| Flow catalog | Provider setup |
| --- | --- |
| ![Nitely built-in and custom flows](docs/assets/screenshots/web-console-flows.png) | ![Nitely provider configuration](docs/assets/screenshots/web-console-providers.png) |

GitHub webhook activation is disabled by default. It accepts fresh, signed
`issues:labeled`, configured `issues:assigned`, configured issue mention, and
configured pull-request review-comment events for an explicitly mapped
repository, allowed sender, optional installation allowlist, and configured
triggers. It durably queues the delivery at `POST /api/github/webhooks`, returns
HTTP 202, and asynchronously creates either an approval-gated draft task or a
pending same-PR task rework request; it never starts a run.
Configure it without putting the webhook secret on the command line:

```bash
NITELY_GITHUB_WEBHOOK_SECRET='replace-with-the-hook-secret' \
NITELY_GITHUB_WEBHOOK_REPOSITORIES='acme/widgets=acme-widgets' \
NITELY_GITHUB_WEBHOOK_ACTORS='trusted-maintainer,nitely-bot' \
NITELY_GITHUB_WEBHOOK_INSTALLATIONS='123456' \
NITELY_GITHUB_WEBHOOK_LABELS='nitely' \
NITELY_GITHUB_WEBHOOK_ASSIGNEES='nitely-bot' \
NITELY_GITHUB_WEBHOOK_MENTIONS='@nitely' \
NITELY_GITHUB_WEBHOOK_FLOW='flows/implement-spec-bootstrap.json' \
NITELY_GITHUB_WEBHOOK_REWORK_FLOW='flows/rework-pr-bootstrap.json' \
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

The right-hand side of each mapping is the repository id shown on the Repos
page; the home checkout registers itself from its `origin` as
`<owner>-<repo>`.

To publish bounded GitHub App callbacks, add App credentials to the same Web
process environment:

```bash
NITELY_GITHUB_APP_ID='12345' \
NITELY_GITHUB_APP_PRIVATE_KEY_BASE64='base64-encoded-pem' \
NITELY_GITHUB_WEBHOOK_STATUS_BASE_URL='https://nitely.example' \
NITELY_GITHUB_WEBHOOK_CHECK_NAME='Nitely' \
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

The secret, repository mapping, actor allowlist, and Flow are required.
`NITELY_GITHUB_WEBHOOK_INSTALLATIONS` is optional; when omitted, only the
installation-id check is skipped. Repository and actor policy never becomes a
wildcard. Labels default to `nitely`. The HMAC secret is not written to disk.
Delivery ids, normalized provenance, immutable source snapshots, and queue state
are stored under `.nitely/github-webhooks/`; duplicate delivery ids cannot start
duplicate work. When the GitHub App publisher is configured, Nitely exchanges a
short-lived per-installation token scoped to the webhook repository and writes
one bounded issue/PR comment; PR review-comment rework deliveries also create or
update one GitHub Check Run on the PR head SHA. The callback does not include
issue body text, reviewer instructions, secrets, or raw provider errors.
Automatic run start remains outside this slice. Webhook delivery processing uses
a delivery-level lease so multiple Web processes sharing a state directory do not
process the same queued delivery concurrently; an expired lease can be reclaimed
after worker death.

Jira ticket intake accepts an Atlassian Cloud browse URL. Bare ticket keys and
self-hosted Jira URLs require an allow-listed `NITELY_JIRA_BASE_URL`. Configure
the token through the Web Console Jira provider or with `NITELY_JIRA_TOKEN` /
`JIRA_API_TOKEN`. Set `NITELY_JIRA_EMAIL` to use Jira Cloud Basic authentication
with `email:token`; without an email, Nitely sends the credential as a Bearer
token for OAuth/PAT deployments. Jira credentials stay in the customer-owned
provider store or process environment and are not copied into task snapshots.

Jira status sync is disabled by default. Selecting **Post current Nitely status
to Jira** during intake stores the current console origin as the link base and
posts a bounded Jira comment. The task detail **Sync to Jira** action publishes
later task/run/PR changes; identical projections are skipped. A failed comment
does not discard the local planning task and can be retried after fixing access.

After changing GitHub provider or draft-spec ingestion behavior, smoke the
configured dev Web path instead of relying only on shell credentials:

```bash
/home/jerry/bin/nitely-dev-web-start
NITELY_SERVER_URL=http://127.0.0.1:4174 \
  pnpm dev -- smoke github-issue-intake \
  --issue https://github.com/Instask/nitely/issues/296
```

Configure the GitHub provider through the Web Console provider settings before
running the smoke when the issue requires repository access. If the provider is
not configured, the smoke exits successfully with a skip reason; if configured
credentials are missing access, it fails with the same actionable guidance as
`POST /api/draft-specs`. The command reports only issue/task/source metadata and
does not print token values.
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

Operator summaries reject placeholder streams and numeric-only counters in
favor of state-first explanations. Active stage cards expose the declared
command or runtime/model, heartbeat-derived process activity, and declared
artifact readiness. `alive: true` means the attempt is open and has recent
persisted activity; it is not a durable OS PID claim. During long-running
command, agent, and review attempts, Nitely checkpoints a bounded
`recovery.patch` plus `recovery.json` relative to the attempt's starting commit.
Interrupted runs surface that run-relative recovery path, while published runs
group branch, head commit, and PR metadata.

By default the console runs in local compatibility mode on a loopback listener.
Requests use a synthetic `local` admin user, legacy tasks and runs without
`ownerId` remain visible, and provider writes continue to use
`.nitely/connections.json`. Nitely refuses local mode in production or on a
non-loopback bind.

For a shared console, require login:

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-with-a-unique-long-passphrase' \
pnpm dev -- web --home . --host 127.0.0.1 --port 4173 --auth required
```

`NITELY_WEB_AUTH=required` is also supported. On first start, if
`.nitely/users/users.json` is empty and the admin environment variables are set,
Nitely creates the initial admin. Required mode stores users in
`.nitely/users/users.json`, sessions in `.nitely/users/sessions/`, and
Web-saved provider credentials in `.nitely/users/<user-id>/connections.json`.
Passwords are salted `scrypt` hashes. API responses include only public user
fields and provider status; secret values are never returned.
Initial creation is recorded as a metadata-only `auth.bootstrap` security event.
Bootstrap first persists a private recovery intent, then durably commits the
user, default organization, and fixed-ID audit event before marking that intent
complete. An interrupted start replays pending steps without requiring the
plaintext password again and without duplicating the administrator or audit
event. The completed marker retains identifiers only, not password verifier
data.
Production and non-loopback startup fail before listening if no administrator
exists. Bootstrap the first account in a one-time foreground start with explicit
credentials; do not put those credentials in a systemd unit.

New passwords must contain 15–128 Unicode code points and must not match the
built-in or optional `.nitely/users/password-blocklist.txt` deny list. Login
failures are account-keyed and throttled after five failures in 15 minutes by
default. Set `NITELY_WEB_SECURE_COOKIE=true` when the console is served through
HTTPS; leave it unset for plain loopback HTTP.

A non-loopback bind additionally requires an operator-declared TLS reverse-proxy
boundary and either secure cookies or an explicit insecure test-cookie escape
hatch for LAN HTTP dogfood:

```bash
NITELY_WEB_AUTH=required \
NITELY_WEB_TRUSTED_PROXY=true \
NITELY_WEB_SECURE_COOKIE=true \
pnpm dev -- web --home . --host 0.0.0.0 --port 4173
```

For trusted-proxy production Web over plain LAN HTTP (for example
`http://0.0.0.0:4173`), set `NITELY_WEB_INSECURE_TEST_COOKIE=true` instead of
`NITELY_WEB_SECURE_COOKIE=true`. Prefer secure cookies behind HTTPS.

The proxy/firewall must prevent clients from bypassing that boundary. Nitely
does not terminate TLS in this slice. `GET /api/readiness` and the CLI startup
output report auth, administrator, bind, proxy, cookie, and production controls
without exposing credentials.

Tasks created through the authenticated Web Console include `ownerId`, and runs
started from those tasks inherit it. Organization members see records in their
organizations, with named owner/maintainer/member/viewer permissions; legacy
unowned data remains hidden from normal users. Global admins can inspect it.
Required-auth repository catalog entries are owned by the caller's current
workspace, and organization owners and maintainers can onboard them. The entry
registered from the home checkout's `origin` (the `home` entry) is visible to
every authenticated user; every other repository follows workspace/organization
ownership. Legacy stored catalog entries without an `organizationId` stay
admin-only until assigned.
Security decisions are written as metadata-only events to
`.nitely/security/audit.jsonl`. See
[docs/enterprise-identity-rbac-and-audit.md](docs/enterprise-identity-rbac-and-audit.md)
for the permission matrix, password/session controls, audit schema, admin
session revocation, and future OIDC/SCIM boundary.

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
- `GET /api/scheduler`
- `POST /api/scheduler/run`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/providers`
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session`
- `DELETE /api/users/:userId/sessions` (global admin)
- `GET /api/security/audit` (global admin)

`POST /api/tasks` accepts optional `planningStatus: "draft" | "ready"`.
`ready` is the compatibility default; `draft` marks both supplied planning
artifacts as drafts so an external approval client can approve them before a
run.

## Local MCP Server

External coding tools can drive the task-to-run slice without shelling out for
each action. Create a least-privilege token, keep its one-time value in the
client environment, and start the built-in stdio server:

Every API token is owned by a user, so the instance needs at least one user
before a token can be minted. If none exist yet, bootstrap the initial admin
once (see [Web Console](#web-console) above) and mint the token against that
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
shown by list/revoke commands. See [docs/local-mcp.md](docs/local-mcp.md) for
the complete capability table, Claude Code stdio configuration, approval flow,
audit files, and failure behavior.

Approving a generated draft spec updates both task metadata and the persisted
spec Markdown `Status:` line before technical design drafting uses the artifact.

Connect the CLI to a running Nitely server once, then later processes on the
same machine can omit `--server`:

```bash
NITELY_API_TOKEN='nitely_api_...' pnpm dev -- connect --server http://192.168.50.177:4173
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
See [docs/local-mcp.md](docs/local-mcp.md) for the `--auth local` alternative.

List the Flows the connected instance exposes before choosing one:

```bash
pnpm dev -- flow list
pnpm dev -- flow list --server http://192.168.50.177:4173 --json
```

`flow list` queries `GET /api/flows` on every invocation, so a Flow added,
renamed, or removed on the instance shows up immediately. Each line prints the
Flow id, its source (`builtin` or `user`), whether it is runnable, and its name.
The id is exactly what `task create --flow` accepts. An API token needs the
`tasks:read` capability to read the catalog.

Create a draft task from one intake source, without writing a spec or technical
design first:

```bash
pnpm dev -- task plan --prompt "Let operators import repositories from a pasted GitHub URL."
pnpm dev -- task plan --issue https://github.com/Instask/nitely/issues/578
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
  --server http://192.168.50.177:4173 \
  --title "Implement ordered runtime fallback" \
  --issue https://github.com/Instask/nitely/issues/77 \
  --spec specs/issues/077-runtime-fallback-spec.md \
  --tech-design docs/plans/2026-06-21-runtime-fallback-tech-design.md \
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
pnpm dev -- run list --server http://192.168.50.177:4173 --json
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
pnpm dev -- run watch <run-id> --server http://192.168.50.177:4173
pnpm dev -- task watch <task-id> --server http://192.168.50.177:4173
```

Both commands accept `--interval-ms <n>`, or use `NITELY_SERVER_URL` or the
saved instance when `--server` is omitted. They print one line per
status/stage/output transition and exit zero only when the run completes.

Trigger one scheduler cycle on the remote Nitely server:

```bash
NITELY_SERVER_URL=http://192.168.50.177:4173 pnpm dev -- scheduler --once
# or
pnpm dev -- scheduler --server http://192.168.50.177:4173 --once
```

Run continuous scheduler cycles while the local clock is inside a window:

```bash
pnpm dev -- scheduler --server http://192.168.50.177:4173 \
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
When command stages run, PR evidence also lists the attempt directory with the
command, exit code, `output.md`, `stdout.log`, and `stderr.log` paths so test
execution can be audited from the change request body.

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
`skills`, must declare at least one output, use `timeouts.sessionMs` instead of
legacy `timeoutMs`, require the primary declared output file (`<id>.md` or
`<id>.txt`), and record the
reviewed input artifact ids plus a bounded copy of that output in the structured
gate result. Review gates fail when that output contains an explicit failing
verdict such as `Review verdict: fail` or a blocking severity marker at the
start of a heading/line such as `### P1 - ...` or `[P0] ...`. Clean review text,
explicit pass verdicts, and P2/P3 advisory findings continue to pass. PR
evidence includes a `Gates` section with each gate's mode, command or runtime,
review output path, status, and failure reason when present.
The Web console severity summary uses those same finding-shaped review lines and
explicit no-issue/pass text; incidental prose such as "No P0/P1/blocking
findings" is not counted as a finding.

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

Skill improvement observations are kept in `.nitely/skill-improvements.db` and require
operator confirmation. Review them with `skill improvements list`; use `confirm` for a
papercut, `propose` with pinned #429 eval cases, then `decide` and `evaluate`. Nitely
never edits or publishes a skill automatically, and a changed source hash blocks application.

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

The deployed server should stay on `master`. Nitely-generated branches and
worktrees are execution artifacts for review and should not become the deployed
checkout until their PRs are merged.

Use the production deploy helper from a clean local checkout after the target PR
has merged:

```bash
scripts/nitely-prod-web-deploy
```

The helper deploys `origin/master` on `jerry@100.96.111.79` from
`/home/jerry/nitely`, builds the checkout, and calls
`/home/jerry/bin/nitely-prod-web-restart`. It prepends the production Node bin
directory to `PATH` before installing and building. Before pulling, it reports
dirty tracked and untracked files in the remote production checkout. By default
it preserves that state with a named stash and prints the stash hash plus the
exact commit deployed in the release summary. Use `--dirty-mode abort` when you
want the deploy to stop instead of stashing remote local changes.

Production Web can also be managed by a user-systemd unit while keeping the same
deploy entrypoint:

```bash
scripts/nitely-prod-web-systemd-install
```

The installer writes `~/.config/systemd/user/nitely-web.service` on
`jerry@100.96.111.79`, binds to `127.0.0.1:4173` with required authentication,
and rewrites
`/home/jerry/bin/nitely-prod-web-restart` as a small
`systemctl --user restart nitely-web.service` wrapper. After installation,
`scripts/nitely-prod-web-deploy` still works the same way, but restart is owned
by systemd instead of manual PID replacement. Use `--print-unit` to inspect the
unit without opening an SSH connection, and `--no-start` when you only want to
install the unit and wrapper.
No administrator credential is written to the unit. Bootstrap the first admin
explicitly before starting the production unit. A non-loopback `--host` is
rejected unless `--trusted-proxy` is also present; that option renders the
trusted-proxy declaration and secure-cookie control.
On upgrade, the installer preserves an existing unit only when its supported
effective auth, bind, proxy, and cookie settings classify as secure. It refuses
insecure or unclassifiable units—including units with drop-ins or environment
files—without changing them. After review, `--replace-existing` backs up the
unit and any user drop-ins before installing the secure generated unit. If
systemd reports a different effective fragment or a drop-in outside that user
unit, the installer refuses replacement because it cannot safely neutralize
that external configuration.

## License

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
