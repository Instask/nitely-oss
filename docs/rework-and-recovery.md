# Rework And Recovery

How a published pull request is reworked, how a blocked or interrupted run resumes, and how retries stay bounded. Commands use the `nitely` CLI ([install](../README.md#install)) and run in the repository Nitely works on.

## Rework An Existing PR

Use `rework-pr` when review feedback or a follow-up spec should update an
existing pull request branch instead of opening a new PR:

```bash
nitely rework-pr 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
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
nitely pr-comments 22 \
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
nitely rework-pr <pr> \
  --repo . \
  --flow flows/resolve-conflicts-bootstrap.json \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
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
nitely runs --repo .
nitely status <run-id> --repo .
nitely diagnose <run-id> --repo .
nitely logs <run-id> --repo .
nitely logs <run-id> --repo . --stage implement
nitely resume <run-id> --repo .
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
[Runaway Ceiling](flow-authoring-guide.md#runaway-ceiling).

When an agent cannot safely proceed without a human decision, it may write a
validated `question.json`. Nitely blocks with `awaiting_operator_answer`
without recording a failed attempt. Inspect and answer it, then resume:

```bash
nitely questions <run-id> --repo .
nitely answer <run-id> <question-id> --option <option-id> --actor <name> --repo .
# Or provide a free-text alternative:
nitely answer <run-id> <question-id> --text "<answer>" --actor <name> --repo .
nitely resume <run-id> --repo .
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
nitely review-verdict <run-id> \
  --file review.md \
  --actor reviewer@example.com \
  --reviewed-artifact implementation \
  --repo .
nitely resume <run-id> --repo .
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
