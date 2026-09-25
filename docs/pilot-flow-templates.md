# Pilot Flow Templates

Status: built-in customer-hosted pilot template catalog.

These templates assume customer-hosted execution against a local repository
checkout. Source code, secrets, worktrees, raw prompts, logs, and generated
artifacts stay in the customer environment unless the operator explicitly
configures otherwise.

## Discovery-Call Mapping

Collect and classify real failed AI coding attempts before choosing a pilot
template.

| Failure mode heard in discovery | Template | Why it fits |
| --- | --- | --- |
| "Specs are approved, but implementation stalls or lands without evidence." | `pilot-approved-spec-pr` | Turns approved spec/design into implementation, verification, review, PR evidence, and reflection. |
| "Bug tickets bounce because nobody writes the failing test first." | `pilot-bug-ticket-fix-pr` | Splits reproduction from fix, then verifies and publishes one reviewable PR. |
| "Review feedback takes multiple loops and loses context." | `pilot-pr-review-rework` | Applies feedback on the existing PR branch and updates the same change request. |
| "Approved work still needs a controlled path through production." | `pilot-issue-to-production` | Adds mandatory spec, design, and release approvals around task-by-task implementation and one repository-owned release adapter. |
| "Security findings need fixes, but unsupported classes should not be auto-edited." | `security-fix-pr` | Deterministically classifies supported findings before any agent edits code, then verifies and reviews the fix. |

## Template: `pilot-approved-spec-pr`

Use when the buyer already has a clear, approved spec and wants a repeatable
spec-to-PR workflow.

Expected inputs:

- `spec`: approved product/engineering specification.
- `tech-design`: approved implementation plan or technical design.

Stages:

1. `plan-tasks`: agent decomposes the spec/design into `task-plan.json`.
2. `implement`: agent runs with `taskPlan.role = "execute-current"` and
   implements only the current pending task, then writes `implementation`,
   `pr-title`, and a structured `conformance-report` JSON artifact mapping
   `US-*`, `FR-*`, `SC-*`, `PD-*`, and task IDs to implementation evidence.
3. `verify`: runs `pnpm exec vitest run && pnpm run check` with
   `taskPlan.role = "verify-advance"` so a passing verification marks the
   current task complete and loops back while tasks remain.
4. `review`: review gate uses `taskPlan.role = "final"` so it runs only after
   all required tasks are complete. It checks correctness, tests,
   security-sensitive handling, conformance coverage, and PR evidence.
5. `publish`: creates a draft PR through `github-cli` and includes the
   conformance matrix in PR evidence as advisory findings.
6. `reflect`: `alwaysRun` finalizer writes `reflection` or records
   `reflection-skipped`.

PR evidence:

- task-plan artifact and loop history;
- implementation summary artifact;
- conformance matrix with requirement/design/task status and cited evidence;
- verification report;
- review gate output;
- generated change request artifact;
- terminal reflection artifact.

Failure and retry behavior:

- implementation and verification stages set `maxAttempts` high enough for the
  task-plan loop and enforce `max_iterations`;
- verification failures are diagnosed before retry/rework so code-like failures
  return to implementation, spec-like failures return to planning, and repeated
  unclear failures escalate;
- review uses `maxAttempts: 2`;
- P0/P1 review findings block publish;
- usage-limit or runtime blockers preserve local state and still attempt
  reflection when possible.

Example run:

```bash
nitely run flows/pilot-approved-spec-pr.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
```

## Template: `pilot-bug-ticket-fix-pr`

Use when the buyer's bug queue lacks reproducible tests or fixes ship without
regression coverage.

Expected inputs:

- `bug-ticket`: bug report, reproduction notes, or support ticket.
- `repo-notes`: repository-specific test commands, affected modules, or
  customer constraints.

Stages:

1. `reproduce`: agent writes the smallest failing regression test and a
   `regression-test` artifact.
2. `fix`: agent implements the smallest fix and writes `implementation` plus
   `pr-title`.
3. `verify`: runs `pnpm exec vitest run && pnpm run check`.
4. `review`: review gate checks that the regression test proves the bug and the
   fix is scoped.
5. `publish`: creates a draft PR through `github-cli`.
6. `reflect`: `alwaysRun` finalizer captures reproducibility and follow-up
   improvements.

PR evidence:

- regression-test artifact;
- implementation summary;
- verification report;
- review gate output;
- change request artifact;
- reflection artifact.

Failure and retry behavior:

- reproduction and fix are separate so a bad fix does not erase reproduction
  evidence;
- verification failures are diagnosed before retry/rework so code-like failures
  return to the fix stage and repeated unclear failures escalate;
- if the bug is not reproducible, the run fails with evidence instead of
  publishing a speculative fix.

Example run:

```bash
nitely run flows/pilot-bug-ticket-fix-pr.json \
  --repo . \
  --input bug-ticket=docs/examples/sample-bug-ticket.md \
  --input repo-notes=docs/examples/sample-repo-notes.md
```

## Template: `pilot-pr-review-rework`

Use when the buyer spends too much time applying reviewer feedback or updating
long-lived PR branches.

Expected inputs:

- `review-feedback`: blocking review comments, requested changes, or maintainer
  instructions.
- `implementation-notes`: original implementation notes, spec links, or known
  constraints.

Stages:

1. `rework`: agent applies requested changes on the existing PR branch and
   writes `implementation` plus `pr-title`.
2. `verify`: runs `pnpm exec vitest run && pnpm run check`.
3. `review`: review gate checks feedback coverage and scope control.
4. `update`: updates the existing PR through `github-cli`.
5. `reflect`: `alwaysRun` finalizer captures repeat review patterns and
   follow-up issues.

PR evidence:

- implementation/rework summary;
- verification report;
- review output;
- updated change request artifact;
- reflection artifact.

Failure and retry behavior:

- runs require an existing change request target;
- the template uses `update-change`, not `publish-change`, so it updates the same
  PR branch;
- unresolved P0/P1 findings stop before update;
- reflection still records skipped/manual follow-up state when the finalizer
  cannot run.

Example run:

```bash
nitely rework-pr https://github.com/owner/repo/pull/182 \
  --repo . \
  --flow flows/pilot-pr-review-rework.json \
  --input review-feedback=docs/examples/sample-review-feedback.md \
  --input implementation-notes=docs/examples/sample-implementation-notes.md
```

## Template: `security-fix-pr`

Use when the buyer has a supported security finding that should become a
minimal, reviewed PR with tests or explicit verification evidence. See
[security-fix-flow.md](security-fix-flow.md) for supported classes and
unsupported-finding behavior.

Expected inputs:

- `finding`: GitHub issue text, static-analysis output, or task text describing
  the security finding.
- `repo-notes`: repository-specific test commands, branch policy, affected
  modules, or reviewer constraints.

Stages:

1. `triage`: deterministic security gate classifies the finding and writes
   `security-assessment`. Unsupported classes fail here before code changes.
2. `fix`: agent applies the minimal supported fix and writes `implementation`
   plus `pr-title`.
3. `verify`: runs `pnpm exec vitest run && pnpm run check`.
4. `review`: review gate checks scope, regression evidence, affected files, and
   new security risks.
5. `publish`: creates a draft PR through `github-cli`.
6. `reflect`: finalizer records assumptions, unsupported classes, and follow-up
   workflow/tooling issues.

Example run:

```bash
nitely run flows/security-fix-pr.json \
  --repo . \
  --input finding=security/finding.md \
  --input repo-notes=docs/examples/sample-repo-notes.md
```

## Template: `pilot-issue-to-production`

Use this Flow when one issue is allowed to reach production only after its
specification, technical design, task evidence, draft pull request, release
readiness, and production result have all passed their declared controls. It is
the governed issue-to-production path; it is not a general-purpose deployment
engine.

Expected inputs:

- `issue`: the issue, ticket, or approved problem statement.
- `repo-notes`: repository-specific implementation and verification guidance.
- `release-runbook`: the repository's merge, deploy, smoke, rollback, and
  recovery expectations. It describes policy for the adapter; it cannot replace
  or interpolate the adapter command.

### Stage and approval sequence

1. `draft-spec` creates the specification candidate. `approve-spec` is a
   mandatory human approval before technical design.
2. `draft-tech-design` creates the repository-grounded design.
   `approve-tech-design` is a mandatory human approval before planning or code
   changes.
3. `plan-tasks` creates the ordered task plan. For each pending task,
   `implement` uses `taskPlan.role = "execute-current"`; `verify`, `spec-review`,
   and `quality-review` inspect only that task; and `quality-review` uses
   `taskPlan.role = "verify-advance"` to complete it or route it back for rework.
4. Once all planned tasks pass, `final-review` evaluates the converged plan with
   `taskPlan.role = "final"`. A passing verdict allows `publish` to create the
   draft pull request.
5. `release-readiness-review` evaluates the draft pull request and runbook.
   `approve-release` is the third mandatory human approval and the explicit
   `approve-release` approval before invoking the adapter.
6. `release` invokes the fixed repository-owned command, then
   `post-release-review` checks both production reports against the runbook.
   `reflect` preserves closeout and follow-up evidence even on a terminal path.

Each approval pauses the run. Inspect the reported approval id, approve it, and
resume explicitly; an approval decision does not itself start the next stage.
Fresh execution and resume use the same task-plan state machine, so completed
task ids, the current task, iteration count, review retry/rework policy, and
final-stage deferral behave identically after any approval or blocker. A resume
does not restart already completed tasks unless later, structured final-review
rework explicitly reopens one.

The built-in planner creates at most 12 tasks. All three task-plan roles set
`max_tasks: 12`, so the runtime rejects a 13th task before loop state changes or
task execution; the prompt is guidance, not the enforcement boundary. Its loop
and every stage that can repeat inside that loop use a budget of 24: 12
first-pass task iterations plus a shared pool of 12 retry/rework iterations.
`maxAttempts` is global per stage for the run, not reset per task, so this
explicit headroom prevents a valid 12-task plan from exhausting its stage budget
on the first retry or reopened task.

Review rework before `publish` remains inside this Flow and returns to the
affected current task. `final-review` may reopen one uniquely identified
completed task when its structured rework verdict names that task. Nitely then
runs that task through implementation, verification, and per-task reviews again
before rerunning final review. Ambiguous or unidentifiable final-review rework
fails closed before `publish`; it does not guess which completed task to reopen.

Same-PR review rework remains the separate
`pilot-pr-review-rework` Flow: use it for feedback received on an already
published pull request so that it updates the existing change request instead
of starting another production release run.

### Command output and evidence protocol

For every command attempt, Nitely owns and exports these values after resolving
the execution environment:

- `NITELY_OUTPUT_DIR` and `NITELY_ATTEMPT_DIR`: the attempt-local directory in
  which the command may write declared evidence;
- `NITELY_RUN_ID` and `NITELY_STAGE_ID`: stable logical run and stage identity;
  and
- `NITELY_ATTEMPT`: provenance for this invocation, not release identity.

A command may declare outputs explicitly in `artifact.json`, or use the
conventional `<output-id>.md` and `<output-id>.txt` filenames inside
`NITELY_OUTPUT_DIR`. The production adapter declares two Markdown outputs, so it
must write `release-report.md` and `smoke-report.md` before returning success.
An explicit manifest must identify the current stage and attempt and map every
declared id to an attempt-contained regular file, for example:

```json
{
  "version": 1,
  "stageId": "release",
  "attempt": 1,
  "outputs": [
    {
      "id": "release-report",
      "path": "release-report.md",
      "mediaType": "text/markdown"
    },
    {
      "id": "smoke-report",
      "path": "smoke-report.md",
      "mediaType": "text/markdown"
    }
  ]
}
```

The single Markdown fallback applies only when a command declares exactly one
rich, schema-free `text/markdown` output and writes neither a manifest nor a
conventional artifact. In that narrow case Nitely may register its redacted,
runtime-owned `output.md`. The fallback never applies to the two release
reports; multi-output sets fail closed: Nitely validates the complete declared
set before registering any artifact. A missing report, wrong media type,
schema failure, path escape, symlink, duplicate id, or reused physical file
therefore exposes no partial release evidence.

Completed registered artifacts are rehydrated without republishing them when a
run resumes. Rehydration applies regular-file and path-containment checks,
stored size and digest, media type, and schema; changed, escaped, or non-regular
evidence fails closed rather than silently becoming a new input.

### Release adapter trust boundary

The release command is exactly `./scripts/nitely/release-production` with
`maxAttempts: 1` and a bounded timeout. The Flow does not accept a command as an
input. Nitely does not autonomously merge or deploy: after release-readiness
review it still requires explicit `approve-release` approval before invoking
the adapter. The repository owner supplies and reviews that script, which alone
owns provider-specific merge, deployment, production smoke, and rollback
operations. Nitely supplies execution identity and validates evidence; it does
not embed an environment-specific deploy procedure or credential.

Secret values must stay out of Flow JSON, prompts, command strings, and
artifacts. Resolve credentials inside the customer-hosted adapter from the host
environment or an external secret manager. Do not place values in command-line
arguments or the release reports, and redact any provider output before writing
declared evidence. The `NITELY_*` values above are paths and provenance, not a
secret transport.

The adapter must persist a durable receipt keyed by
`NITELY_RUN_ID` + `NITELY_STAGE_ID`; `NITELY_ATTEMPT` may be recorded only as
invocation provenance. The receipt must survive the Nitely attempt directory
and record, at minimum, the rollback baseline, observed production state,
completed merge/deploy transitions, smoke outcome, and report completion. On
the first invocation, capture the rollback baseline before mutation. Before a
successful exit, write both reports. If a safe release cannot be completed,
roll back before returning a terminal failure and preserve enough receipt state
for an operator to audit the outcome.

An interrupted adapter invocation may already have changed external state. On
explicit resume, the adapter must load the same receipt, inspect production,
and reconcile durable state instead of blindly repeating merge or deploy. This
is why the durable identity excludes the attempt number. A second invocation
may finish smoke checks and reports, but it must not repeat an already-recorded
merge or deployment mutation.

### Recovery and operator commands

Agent and review blockers remain resumable after the operator answers a
structured question, restores quota, or resolves the reported condition. An
open attempt is projected as interrupted after restart and requires explicit
resume. Only an open release attempt projected as interrupted can be resumed
and reconciled. A normal non-zero release result is terminal and is not
automatically retried because the release stage has `maxAttempts: 1`. A
terminal run after a normal non-zero release cannot be resumed; do not treat it
as an ordinary agent blocker. Resuming an interrupted attempt is recovery, not
permission to repeat side effects.

Start a run with repository-local input files:

```bash
nitely run flows/pilot-issue-to-production.json \
  --repo . \
  --input issue=issue.md \
  --input repo-notes=repo-notes.md \
  --input release-runbook=release-runbook.md
```

At each reported approval pause, inspect and resolve the exact approval before
resuming:

```bash
nitely approvals <run-id> --repo .
nitely approve <run-id> <approval-id> \
  --repo . \
  --actor human:release-operator
nitely resume <run-id> --repo .
```
