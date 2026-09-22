# Issue 413: Governed Issue-To-Production Flow

## Problem

Nitely's built-in production templates stop after publishing a reviewed draft
pull request. A real delivery run must also preserve explicit human approvals,
execute every task in an ordered plan, perform a fail-closed release, prove
production smoke checks, and retain rollback and closeout evidence without
putting environment-specific deployment logic or secret values in the Flow
document.

The Flow contract alone is insufficient. Mandatory approval stages pause
`runFlow`, so all work after an approval continues through `resumeRun`. Fresh
and resumed execution must therefore share the same task-plan, retry, rework,
blocker, artifact, and final-review semantics. Command stages must also
materialize their declared outputs; a successful exit code without the required
typed evidence is not a successful stage.

## User-visible behavior

- Operators can select a built-in `pilot-issue-to-production` Flow.
- The Flow turns an issue into an approved specification and technical design,
  executes an ordered task plan, and reviews every task for specification and
  code-quality compliance before advancing it.
- Approval pauses are transparent to execution semantics: after resume, each
  pending task is still implemented, specification-reviewed, quality-reviewed,
  and recorded before the final review can run.
- Retry, structured rework, agent/review blockers, operator answers, and later
  resumes continue the same logical task-plan loop without duplicating completed
  tasks or skipping the current task.
- A final holistic review runs only when the complete task plan is ready and
  gates draft PR publication.
- Command stages expose a stable, attempt-local output directory and publish
  validated typed artifacts that downstream stages and later resumes can read.
- Production release never starts until an operator approves the release
  candidate and its runbook.
- The release invokes the target repository's fixed
  `./scripts/nitely/release-production` adapter. The adapter owns merge,
  rollback-baseline capture, fail-closed deployment, production smoke checks,
  rollback before it returns a failure, and idempotent reconciliation after an
  interrupted or repeated invocation for the same Nitely run and stage.
- A post-release review and terminal reflection preserve deployment evidence,
  issue closeout, duplicates, and follow-up work.

## In scope

- A built-in Flow JSON document and matching template-catalog entry.
- Typed artifact contracts for specification, technical design, separate
  reviews, verification, release results, and smoke evidence.
- Human approval stages before implementation planning and production release.
- Runtime parity between fresh and resumed execution for task-plan iteration,
  retry, rework, blocker continuation, prompt scoping, and final-stage deferral.
- Resume rehydration of task-plan progress and completed stage artifacts.
- A command-output protocol that supplies trusted run/stage/attempt metadata and
  an attempt-local `NITELY_OUTPUT_DIR` to Local and Mise command execution.
- Fail-closed validation, registration, retry, and resume rehydration for rich
  command output contracts, including multiple outputs.
- A single-output fallback that maps Nitely's redacted command `output.md` to one
  declared `text/markdown` output when the command does not create its own
  artifact file or manifest.
- A release-stage safety contract: one automatic attempt, stable run/stage
  idempotency identity, rollback-before-failure, and reconciliation of an
  already-applied release without repeating merge or deployment.
- Documentation of the repository-owned release adapter and trust boundary.
- Validation, production-lint, catalog-sync, runtime integration,
  command-output, stage-order, release-safety, and documentation regression
  tests.

## Out of scope

- A native Nitely merge, deploy, rollback, compensation, or subflow stage.
- Secret storage or secret values in Flow JSON, prompts, commands, or artifacts.
- Replacing the existing same-PR review/rework Flow.
- Environment-specific Cloudflare, Kubernetes, or host deployment commands in
  Nitely itself.
- Autonomous merge or deployment without an approved release gate.
- Redesigning the existing review-gate artifact representation, where internal
  gate-result JSON may use the declared review output id even when the Flow
  describes review prose as Markdown. This remains a separate compatibility
  issue unless the runtime changes in this issue directly trigger it; any
  necessary compatibility fix must stay narrowly scoped and must not turn into
  a gate-artifact migration.

## Runtime execution contract

Fresh and resumed execution use one logical stage state machine. Once bootstrap
has supplied the run directory, workspace, inputs, projection, and continuation
metadata, both paths must apply the same rules:

1. Before a task-plan-aware stage starts, select or restore the current pending
   task and scope agent/review prompt context to that task.
2. `execute-current` starts at most one new task-plan iteration at a time and
   observes the configured maximum iteration count.
3. Failed agent, command, and review stages follow the same attempt policy and
   structured rework routing on fresh and resumed runs.
4. A blocker or operator question preserves completed task ids, the current
   task id, iteration, history, prior failures, and artifact inputs for resume.
5. `verify-advance` marks the current task complete only after both the
   specification and quality review path has passed, then either loops back to
   `execute-current` or completes the plan.
6. A `final` task-plan stage defers and jumps back to `execute-current` while any
   task remains; it executes once only after the plan is complete.

The built-in Flow limits the generated plan to 12 tasks. Every task-plan role
declares `max_tasks: 12`; the runtime validates the parsed task count and rejects
an oversized plan before loop mutation or task execution. Because `maxAttempts`
is counted globally per stage rather than per task, all repeating task-loop
stages and `max_iterations` use a budget of 24: 12 initial task iterations plus
12 shared retry/rework iterations. Every structured final-review reopen consumes
one of those iterations and fails closed before mutation when the budget is
exhausted.

Task-plan continuation state is rebuilt from the parsed task-plan artifact and
append-only `task.plan.*` events, keyed by task-plan input id. Rehydration must
not depend on a single projected task-plan slot, and it must not rewrite or
discard earlier attempt evidence. A task-plan event without a string `inputId`
is corrupt and fails closed; a future task-plan loop with neither an artifact
nor any matching task-plan event remains inactive and is skipped.

## Command output protocol

For a Nitely-managed command attempt, the execution backend receives trusted
metadata and exposes it to the command with runtime values taking precedence
over inherited environment values:

- `NITELY_OUTPUT_DIR`: absolute attempt-local directory for declared outputs;
- `NITELY_ATTEMPT_DIR`: alias of the same directory for consistency with agent
  runtimes;
- `NITELY_RUN_ID`: Nitely run id;
- `NITELY_STAGE_ID`: Flow stage id; and
- `NITELY_ATTEMPT`: numeric attempt.

The directory is created by Nitely and must remain inside the run directory.
Adapters normally write `<output-id>.md` or `<output-id>.txt`; adapters needing
custom names or media types may write the existing `artifact.json` manifest.
The release adapter therefore writes at least:

```text
$NITELY_OUTPUT_DIR/release-report.md
$NITELY_OUTPUT_DIR/smoke-report.md
```

After exit code zero and before stage completion, Nitely validates every rich
required command output as a complete set. Missing, empty, duplicate,
undeclared, path-escaping, media-type-invalid, or schema-invalid output causes
the attempt to fail through the normal retry policy. Nitely registers outputs
only after the complete set validates, enforces the declared contracts, and
then records stage completion. A new attempt uses a new directory; failed
attempt evidence remains immutable.

For exactly one rich `text/markdown` output, when the command supplied neither a
manifest nor a conventional output file, Nitely may register its redacted
command `output.md` as that artifact. The fallback is forbidden for multiple
outputs, non-Markdown media types, and schema-bearing outputs. Legacy command
stages whose outputs are only bare strings keep their current lenient behavior.

On resume, registered artifacts from completed command and other stage types
are rehydrated from the run artifact registry using only paths contained by the
run directory. Rehydration must not emit duplicate publication events.

## Release safety contract

The release stage sets `maxAttempts: 1`; Nitely must not automatically perform
a second merge or deployment after a non-zero result or an output-contract
failure. Manual continuation after an interruption can still encounter an
ambiguous external state, so the adapter treats `NITELY_RUN_ID` plus
`NITELY_STAGE_ID` as its durable idempotency key and `NITELY_ATTEMPT` as
diagnostic provenance, not as a new release identity.

Before its first mutation the adapter durably records the rollback baseline and
release identity. On a later invocation for the same identity it must inspect
the durable receipt and production state, then do exactly one of the following:

- return the previously successful release and smoke evidence without repeating
  merge or deployment;
- finish a provably safe incomplete step and run smoke checks; or
- restore the rollback baseline before returning non-zero.

The adapter must not return success until both release and smoke reports are
complete in `NITELY_OUTPUT_DIR`. Nitely owns orchestration and evidence
validation; the target repository owns environment credentials, merge/deploy
implementation, durable receipts, reconciliation, rollback, and smoke checks.

## Acceptance checks

1. `pilot-issue-to-production` validates with its declared external inputs.
2. It emits no production-lint warning.
3. Its artifact graph orders implementation, verification, spec review,
   quality review, final review, draft PR publication, release approval,
   atomic release, post-release review, and reflection.
4. Starting the Flow, approving every mandatory pause, and resuming it executes
   every task-plan item exactly once through implement, spec review, and quality
   review before final review.
5. The quality review owns `taskPlan.role = "verify-advance"`; a task cannot be
   marked complete before both review layers pass.
6. The final review owns `taskPlan.role = "final"`, defers while work remains,
   and gates publication only after the full plan completes.
7. A blocker during a later task resumes that task with prior completion
   history, artifacts, attempt policy, and rework semantics intact.
8. Local and Mise command stages receive the trusted output/run/stage/attempt
   environment contract.
9. The verification command publishes one typed Markdown report through the
   safe single-output fallback and downstream reviews receive it.
10. A release adapter can publish both release and smoke reports through
    `NITELY_OUTPUT_DIR`; Nitely fails closed when either report is missing or
    invalid and never registers a partial set.
11. Command output validation failures participate in normal retries, preserve
    each attempt directory, and registered command outputs survive a later
    approval or blocker resume.
12. Bare-string legacy command outputs retain their current lenient behavior.
13. The release stage calls only `./scripts/nitely/release-production`, declares
    an explicit timeout, sets `maxAttempts: 1`, and emits typed release and smoke
    reports.
14. A repeated release invocation for the same run/stage identity reconciles
    durable state and does not repeat merge or deployment.
15. The template catalog and repository JSON remain structurally equivalent
    after JSON parsing.
16. Documentation names the approval, secret, output, idempotency, rollback,
    resume, and adapter boundaries.

## Failure and recovery

- Agent or review-runtime blockers remain resumable through Nitely's blocker,
  operator-answer, and operator-verdict paths without losing task-plan state.
- Denied approvals stop downstream stages.
- Command exit failure and typed-output validation failure use the same bounded
  retry policy. No stage completes and no partial artifact set is exposed when
  validation fails.
- A process restart rehydrates completed command, agent, gate, publish/update,
  and sync artifacts needed by the selected continuation stage.
- The release adapter captures its rollback baseline before mutation and
  completes rollback before returning non-zero. Nitely currently has no failure
  compensation edge that can safely do this in a later stage.
- An interrupted release is reconciled by durable run/stage identity; it is
  never treated as permission to repeat an external side effect blindly.
- Post-release review failure records a failed run and reflection evidence; the
  adapter must already have completed all operational smoke checks before
  returning success.
