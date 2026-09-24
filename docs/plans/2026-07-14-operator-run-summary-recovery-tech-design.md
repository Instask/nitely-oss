# Operator Run Summary And Recovery Artifact Tech Design

Issue: #153

## Goal

Give an operator enough persisted, concise information to understand an active,
failed, interrupted, or published run without SSH, process inspection, or direct
log reads. The implementation extends the existing local event projection and
does not introduce remote telemetry, background daemons, or a claim that a
persisted PID remains authoritative after restart.

## Existing Baseline

Nitely already projects current stage and attempt state, records stage
heartbeats, exposes redacted logs and artifact metadata, detects stale open
attempts, and shows branch and pull-request links. The remaining gaps are:

- the latest-output selector can surface placeholders or bare counters such as
  `79,337`;
- command/runtime, heartbeat liveness, and declared-output readiness are not a
  structured API contract on stage cards;
- a partially modified worktree has no bounded patch checkpoint if the runtime
  or Nitely process is interrupted;
- publish metadata is split across branch, event, and PR fields instead of a
  prominent operator summary.

## Operator Projection Contract

Add structured process, artifact-readiness, publication, and status-summary
fields to the Web run projection.

For the current run and each projected stage, process information includes:

- kind (`agent`, `command`, `gate`, or another stage type);
- the redacted command when the flow declares one, or runtime/model for an
  agent process;
- state (`waiting`, `running`, `finished`, or `interrupted`);
- `alive` when it can be inferred, plus the latest attempt activity timestamp.

`alive: true` has a deliberately narrow meaning: the attempt has no terminal
event and its latest attempt event or heartbeat is newer than the configured
stale threshold. It is not an OS PID probe. A stale open attempt projects as
interrupted with `alive: false`; terminal attempts project as finished. Commands
are stored in the already-redacted `run.created` workflow manifest so list and
detail APIs use the same source even before `command.completed` exists.

Artifact readiness compares the stage's declared output IDs with published
artifacts produced by that stage. It exposes declared, ready, and missing IDs
and one of `not-applicable`, `pending`, `partial`, `ready`, or `missing`.
Readiness describes persisted artifacts, not merely files that happen to exist
in an attempt directory.

The human status summary is state-first. It explains the active stage/process,
runtime fallback, interruption/recovery path, failure, completion, or published
PR in operator terms. The latest log selector remains available but scans
backward for a meaningful redacted line and rejects empty placeholders, stream
labels, and numeric-only counters. If no meaningful line exists, the
state-first status summary replaces it rather than exposing an opaque token.

Publication projection groups branch, head commit, and PR metadata. New publish
events record the branch head after Nitely commits and the provider operation
returns. Older runs degrade to the branch and PR fields already available;
run detail may obtain the commit from the reproducibility manifest.

## Recovery Patch Checkpoint

Add a local recovery snapshot writer that produces:

```text
.nitely/runs/<run-id>/recovery.patch
.nitely/runs/<run-id>/recovery.json
```

The comparison base is the `branchHeadSha` recorded by `stage.started`, so the
snapshot contains the current attempt's work instead of unrelated history.
The patch uses Git without external diff drivers or text conversion and covers
tracked, staged, and committed changes relative to that base. Untracked regular
files and symlinks are added as individual no-index Git patches within strict
file-count and total-byte limits. Unsafe paths, special files, ignored files,
and entries that exceed the limit are recorded as omitted metadata rather than
followed or copied.

Writes use a temporary file plus rename. A valid patch is never byte-truncated:
sections that do not fit are omitted and the metadata reports `partial`; if
there are no changes, a metadata checkpoint reports `clean` and any obsolete
patch is removed. Metadata contains the run/stage/attempt, base and head commit,
capture time, changed/untracked/omitted paths, patch size, and SHA-256 digest.
Patch contents remain local raw evidence and are not added to safe evidence
exports; the Web API exposes metadata and a run-relative path, not patch bytes.

Snapshots refresh on long-running attempt heartbeats and once when the wrapped
command/agent/review process settles. Snapshot failures are best-effort
observability failures: they are reported as unavailable metadata where
possible and never replace the stage's original execution result. This leaves a
recent checkpoint after an external process interruption while avoiding a Git
scan on every output chunk.

## UI

The session list and run header use the human status summary. Expanded pipeline
cards show process state, command or runtime/model, latest meaningful line, and
artifact readiness without requiring the raw log panel. Published branch,
commit, and PR appear together. Interrupted or blocked runs show the recovery
patch path and whether it is complete, partial, clean, or unavailable.

## Compatibility And Safety

- Existing event databases remain readable; all added event payload fields are
  optional.
- Existing `latestOutputSummary`, branch, and PR fields remain present for API
  compatibility.
- Known secrets are redacted before commands/publication metadata enter events,
  and again by Web projection.
- Recovery patch contents can contain source and proprietary text. They remain
  under the local run directory and require the existing explicit raw-export
  path to leave it.
- No remote API call, process signal, or worktree mutation is performed by Web
  reads.

## Validation

- summary tests for meaningful running output, numeric/placeholder fallback,
  runtime fallback, interrupted recovery, and published runs;
- process tests for fresh heartbeat, stale attempt, and terminal state;
- artifact-readiness tests for pending, partial, ready, and missing output sets;
- recovery writer tests for tracked, staged, committed, untracked, clean,
  omitted/oversized, path-safety, hashing, and atomic replacement behavior;
- run-flow tests proving heartbeat/final settlement refresh recovery metadata
  without masking execution failures;
- static-console contract tests for process, readiness, publication, and
  recovery presentation;
- focused Web/run tests, full typecheck/build, full suite, and post-deploy API/UI
  smoke checks on the isolated development runtime before production deploy.

## Rollback

The projection additions are optional and old runs degrade gracefully. Rolling
back code leaves only `recovery.patch` and `recovery.json` inside local run
evidence directories; they can be retained or removed under the evidence policy
without changing the event database schema.
