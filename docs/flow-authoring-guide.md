# Flow Authoring Guide

Nitely flow validation has two layers:

- **Schema and graph validation** blocks saving or running when the JSON shape,
  stage graph, artifact dependencies, or work-item policy is invalid.
- **Production lint** emits warnings for flows that are runnable but likely hard
  to operate, review, or debug in production.

Production lint warnings are advisory. They should be treated like PR review
comments for flow quality: fix them for customer-facing or long-lived flows, and
document the exception for experiments.

## Stage Boundaries

Keep each stage responsible for one decision or work product. Prefer separate
stages for planning, implementation, verification, review, publishing, and
reflection.

The production lint warns when an agent or review gate has many inputs or many
outputs. This is a signal that the stage may be mixing unrelated
responsibilities or hiding intermediate evidence that reviewers need.

## Test-First Topology

A prompt that says "use TDD" is not a constraint. One agent stage that receives
a specification and returns both the code and the tests can write the code
first and then shape assertions around whatever it produced.

The spec-driven bootstrap flows encode the discipline as artifact edges
instead:

```
spec, tech-design
  -> write-tests   (agent; tests only; outputs `tests`)
  -> implement     (agent; consumes `tests`)
  -> test          (command; the hard green gate)
  -> review -> publish
```

Three properties do the work:

- `write-tests` consumes only `spec` and `tech-design`, so it can never see an
  implementation to write tests around.
- `implement` lists `tests` in `inputs`, so the runner cannot start it until the
  test artifact exists. The order is a dependency, not a convention.
- The `test` command stage is unchanged and still gates review and publish, so a
  red suite blocks the change exactly as before.

The `implement` prompt then treats the supplied tests as a contract: no
deletions, no skips, no loosened expectations. A test that genuinely contradicts
the specification is left failing and reported under a `Test contract change`
heading in the implementation artifact, and the review stage consumes `tests` so
it can check that claim rather than take it on faith.

Copy this shape for any flow that implements an approved specification. Flows
whose implement-like stage starts from a task plan or from review feedback on an
existing change have a different input contract and are not covered by it.

## Stage capabilities

Declare the narrowest capability policy that matches each agent stage. The
bootstrap flows use `write.scope: "none"` and `commands.mode: "none"` for
planning, review, and reflection, `write.allow: ["test/"]` for test creation,
and `write.scope: "worktree"` for implementation:

```json
{
  "capabilities": {
    "write": { "scope": "none" },
    "commands": { "mode": "none" }
  }
}
```

The local backend maps explicit write bounds to native runtime controls where
available: Codex uses `read-only` or `workspace-write`, and Claude uses its
permission mode. A local runtime that cannot enforce a required read-only
stage fails before launch. Path allowlists, network policy, and command
mediation without a native mechanism remain recorded as advisory until the
OCI capability enforcement path is selected. Do not treat an advisory entry
as a security boundary.

## Artifact Contracts

Artifacts are the dependency contract between stages. Nitely derives the flow
DAG from `metadata.inputs`, stage `inputs`, and stage `outputs`; there is no
separate edge list to maintain.

Use these fields consistently for long-lived flows:

- `id`: stable machine-readable artifact id used by downstream `inputs`.
- `name`: short human-readable label for UI previews and evidence.
- `type`: domain type such as `implementation.summary`, `review.verdict`, or
  `verification.report`.
- `description`: concise explanation of what the artifact must contain and why
  downstream stages can rely on it.
- `mediaType`, `schema`, and `version`: optional constraints for structured
  artifacts.

Plain string outputs are fine for small internal drafts, but production
artifacts that declare a `type`, `mediaType`, `schema`, or `version` should also
include a `description`. The validation report's `artifactGraph` shows each
artifact producer and consumers; use it to check that the graph follows from
artifact references rather than from stage declaration order.

Declare operator-supplied artifacts in `metadata.inputs`. Older flows that
consume an unproduced input remain compatible and are reported as implicit
external inputs, but production templates should make the boundary explicit.

### Attempt Output Discovery

An agent writes its declared outputs into the attempt directory. Nitely finds
them in this order:

1. An explicit `artifact.json` manifest, when the attempt wrote one.
2. Otherwise `<output-id>.md`, then `<output-id>.txt`, then `<output-id>.json`.

`artifact.json` needs only `version: 1` and `outputs`. `stageId` and `attempt`
are optional, and the runner's own values win when they are missing or
disagree, because the runner created `<run>/stages/<stage-id>/<attempt>` and
already knows both. An attempt is not failed for getting those two fields
wrong.

Everything else about the manifest stays strict. An attempt still fails on a
`version` other than `1`, malformed JSON, an output path that escapes the
attempt directory, a reference to the reserved `output.md`, a missing or empty
output file, and undeclared or duplicated output ids.

## Cross-Flow Artifact Inputs

Use cross-flow references when one flow intentionally consumes an artifact that
was produced outside the current flow: discovery output feeding implementation,
review evidence feeding a reporting flow, or a previous run artifact feeding a
follow-up run. Keep same-flow dependencies as normal stage `inputs`/`outputs`;
do not use cross-flow references to hide edges that belong in one flow DAG.

External input contracts can declare a default source:

```json
{
  "metadata": {
    "inputs": [
      {
        "id": "spec",
        "type": "spec",
        "sourceUrl": "https://example.test/spec.md"
      },
      {
        "id": "prior-review",
        "artifactUri": "nitely-artifact://run-20260708/review"
      }
    ]
  }
}
```

`sourceUrl` downloads an `http` or `https` resource at run start. `artifactUri`
materializes an artifact snapshot from this repository's `.nitely/runs`
registry. `source_url` and `artifact_uri` are accepted aliases for JSON authors
who prefer snake case. A caller-supplied run input with the same id overrides
the default source.

Runtime evidence records imported artifacts as external inputs with source URI,
content hash, size, fetched timestamp, and run-relative snapshot path. When a
`nitely-artifact://<run-id>/<artifact-id>` reference points to a known previous
run artifact, Nitely also preserves the origin run, producer/stage, and flow
name when available.

The OSS core only materializes references it can access from the local runner.
It does not imply cross-tenant, cross-repository, or hosted control-plane
authorization. Use repository-local paths, authenticated connectors, or
operator-approved URLs that are appropriate for the runner's trust boundary.

## Task-Plan Loops

Use `taskPlan` when a large implementation should be decomposed into an ordered
`task-plan.json` and executed one task at a time. A typical production shape is:

```json
{
  "id": "implement",
  "type": "agent",
  "inputs": ["task-plan"],
  "taskPlan": {
    "input": "task-plan",
    "role": "execute-current",
    "max_iterations": 24,
    "max_tasks": 12
  }
}
```

The planner stage should write `task-plan.json` as an `application/json`
artifact. Default output discovery finds `<output-id>.md`, `<output-id>.txt`,
and `<output-id>.json`, so a plain `task-plan.json` in the attempt directory is
enough. The JSON root must contain a non-empty `tasks` array. Each task
needs `id`, `title`, and optional `status`, `dependencies`, `paths`, and
`notes`. `status` may be `pending`, `in_progress`, `completed`, or `blocked`.

Use these stage roles:

- `execute-current`: replaces the configured task-plan input in the agent
  prompt with only the current pending task plus loop progress.
- `verify-advance`: marks the current task completed when the stage succeeds,
  then routes back to the execute stage while tasks remain.
- `final`: prevents review/publish style gates from running until all tasks in
  the plan are complete.

`max_tasks` bounds the parsed plan itself. Nitely rejects an oversized plan
before it mutates loop state or executes the first task; do not rely on planner
prompt wording as the enforcement boundary. `maxTasks` is the camel-case alias,
and the two spellings must match if both are present.

`max_iterations` bounds the task loop. Stage `maxAttempts` still bounds how many
times that stage can run, so set both values deliberately on execute and verify
stages in long plans. Stage attempts are counted globally across the run rather
than reset for each task. For example, the governed issue-to-production template
sets `max_tasks` to 12 on every task-plan role and sets both loop and
repeating-stage budgets to 24: 12 first-pass iterations plus 12 shared
retry/rework iterations.

## Convergence Stages

Use an agent-stage `convergence` contract when the current implementation must
be compared with a spec, plan, and Markdown task artifact. The configured task
input remains immutable. The agent emits a strict gap report and a non-empty
task placeholder; Nitely validates the report and deterministically overwrites
the placeholder with an appended `task.converged` artifact.

The `tasksInput`, `reportOutput`, and `tasksOutput` IDs must be distinct and
declared in the stage's inputs/typed outputs. Downstream rework can consume the
configured task output through the normal artifact graph. See
[Convergence Pass](convergence-pass.md) for the report schema, stable-ID rules,
clean-pass semantics, and a runnable built-in flow.

## Hooks

Use hooks for deterministic checks or evidence capture that must run around a
flow or a stage. Flow hooks live under `spec.hooks.preRun` and
`spec.hooks.postRun`; stage hooks live under `stage.hooks.pre` and
`stage.hooks.post`.

Hooks execute through the same execution backend and workspace boundary as
command stages. Nitely records stdout, stderr, exit code, duration, output
paths, and environment repairs in run events and evidence. Hook output is
redacted through the normal runtime redaction path, but hook authors should
still avoid printing secrets or dumping whole environments.

Choose the failure policy deliberately:

- `block`: fail the run when the hook exits non-zero. This is the default and
  should be used for safety, policy, and required verification checks.
- `warn`: keep running after a non-zero exit while preserving the warning in
  evidence. Use this for advisory diagnostics.
- `evidence-only`: attach output without treating non-zero exit as a warning or
  blocker. Use this only for best-effort evidence collection.

Keep hook commands local, deterministic, and reviewable. Avoid network shell
pipelines such as `curl ... | sh`, commands that fetch and execute unpinned
remote scripts, broad `env` dumps, and commands that echo tokens, private keys,
or credentials. Prefer small repository scripts with explicit arguments and a
declared timeout.

## Timeout Hygiene

Command and deterministic gate stages that run test, build, deploy, network, or
infrastructure commands should set `timeoutMs`. Built-in production templates use
`600000` milliseconds for verification commands. Custom flows may need a larger
timeout for slow integration suites, but the value should be explicit.

Verification-like command and deterministic gate failures are diagnosed before
the normal retry/rework decision. If the stage id, command, or output metadata
looks like verification, tests, E2E, build, lint, typecheck, conformance,
acceptance, or smoke checks, Nitely emits `verification.failure.diagnosed`.
High-confidence implementation/spec classifications become structured rework
requests to the matching upstream producer; environment-looking failures retry
the same stage first; repeated unclear failures escalate. The diagnosis appears
in run evidence and Web stage details.

New flows can use consolidated `timeouts` controls at `spec.timeouts` or
per-stage `timeouts`. Stage values override flow defaults. Runtime-enforced
fields today are:

- `sessionMs`: hard timeout for agent and review-gate runtime sessions.
- `commandMs`: command-stage timeout, used when legacy `timeoutMs` is absent.
- `gateMs`: deterministic-gate timeout, used when legacy `timeoutMs` is absent.
- `pauseMs`: recorded on approval requests so operators can audit manual pause
  expectations.

`turnMs`, `stallMs`, and `busyIdleMs` are accepted and recorded in evidence for
runner/back-end integrations that can report finer-grained activity. Missing
timeouts keep existing conservative behavior: no agent/review session timeout,
no approval pause expiry, and command/gate timeout only when declared.

## Runaway Ceiling

Runs are bounded by a machine-wide **runaway ceiling**, not by a per-flow
budget. A flow cannot declare `spec.budgets` or stage `budgets`; load rejects
those fields and names `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` as the replacement.
This is a circuit breaker, not an estimate: nobody can forecast what a stage
costs in tokens, and asking authors for a number produced zero uptake.

The ceiling defaults to **2,000,000** uncached runtime tokens because a run
with no cap can spend without limit: two dogfood runs burned about 12.5M Codex
input tokens in roughly 40 minutes before an operator killed the process by
hand. Set `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` to another positive integer to
change the machine-wide cap, or to `0` to opt out.

The ceiling does not fail closed when a runtime reports no token usage.
`grok`, `glm`, and `pi` report none at all; treating unknown usage as a hard
failure would stop those runs for a bound nobody declared.

The ceiling counts **uncached** runtime tokens. Cache reads are excluded; cache
creation and fresh input are charged in full, because providers bill cache
creation at a premium and serve cache reads at a fraction of the price of fresh
input. Counting cache reads at parity measures how much context a stage re-sent
across turns rather than how much work it bought: run
`2026-08-30T142227983Z-022c3249` tripped the 2M default on 2,239,828 tokens of
which 2,062,336 — 93% of its input — were cache reads. The work it actually
bought was 177,492 tokens, so the bundled flows fit the default cap roughly
eleven stages over. A `budget.exceeded` event and the run's `budgetSummary`
report the excluded cache-read total alongside the enforced one. Usage from a
runtime that reports no cache split, and usage recorded before this
distinction existed, keeps counting in full.

When the ceiling is crossed, Nitely emits a terminal `budget.exceeded` event
carrying the cap, the consumed total, the remaining allowance, and the stage
and attempt that crossed it, then fails the run with `reason: budget_exceeded`.
The message names `NITELY_DEFAULT_MAX_RUNTIME_TOKENS`.

A run stopped that way is resumable after the operator raises the ceiling.
Raise `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` above the consumed total, then
`nitely resume <run-id>`. Execution continues at the first incomplete stage;
completed stages are not re-run. Resuming without raising the cap is refused
with the consumed total and the current cap, instead of re-tripping the same
bound at the next admission check.

### Verification economics

Flows may declare a provider-independent verification budget independently of
the runaway ceiling:

```json
{
  "verificationBudget": {
    "maxAgentAttempts": 6,
    "maxJudgeAttempts": 3,
    "maxCiRuns": 2,
    "maxRuntimeCostUsd": 10
  }
}
```

`maxAgentAttempts` counts agent attempts, `maxJudgeAttempts` counts Judge
attempts, and `maxCiRuns` counts expensive (or unclassified) command-stage
verification attempts across retries and resumes. Cheap and moderate command
stages are therefore useful for preflight and targeted checks without consuming
the full-CI allowance. A blocked admission emits a structured `budget.exceeded`
event and the run fails with `reason: budget_exceeded`; no retry can silently
cross the limit. `maxRuntimeCostUsd` reuses the existing actual/estimated cost
accounting and fails closed when any runtime cost is unknown.

Use `costClass` on stages (`cheap`, `moderate`, `expensive`, or `human`) to make
the intended verification ladder visible without making Nitely reorder stages.
Run projection and Web detail report consumed and remaining allowances, unknown
cost attempts, and expensive stages skipped after an earlier failure. Evidence
records the same snapshot. These fields are accounting and guardrails, not an
automatic optimizer: authors still choose the order explicitly.

## Multi-Perspective Review

A `review-aggregate` gate collapses two or more independent review gates into
one blocking decision. Declare the perspectives as ordinary `review` stages
with `blocking: false`, list their output ids in the aggregate stage's
`perspectives`, and give downstream stages the aggregate's output. The rules,
the flow variant, and why aggregation carries no voting configuration are in
`docs/multi-perspective-review.md`.

## Publish Evidence

Any `publish-change` or `update-change` stage should consume both:

- review evidence, usually a blocking review gate output such as `review`, or
  the output of a `review-aggregate` gate;
- verification evidence, usually a command output such as `test-report` or
  `verification-report`.

This keeps PR evidence auditable and prevents publish stages from depending only
on an implementation summary.

## Secret Hygiene

Do not put credentials, private keys, API tokens, or password-like values in
prompts or command strings. Store credentials in the target runtime environment
and refer to safe variable names in the flow.

## Built-In Flow Baseline

The pilot flow templates declare explicit verification timeouts and require
review plus verification evidence before publish or update stages. Smaller
starter templates may still produce advisory warnings when copied because they
are intentionally minimal starting points, not production policy examples.
