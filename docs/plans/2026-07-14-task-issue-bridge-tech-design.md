# Task Artifact To GitHub Issue Bridge Technical Design

Issue: [#110](https://github.com/Instask/nitely/issues/110)

## Outcome

Nitely gains an explicit `tasks-to-issues` command that publishes a validated
Markdown task artifact into the GitHub repository configured as the checkout's
`origin`. A run that selects those task IDs can then cite their GitHub issues in
`evidence.md` and add one idempotent terminal-run comment to each covered issue.

Issue creation remains an operator-invoked planning action. Normal runs never
create issues implicitly; they only consume the local mapping produced by a
successful bridge sync.

## CLI Contract

```text
nitely tasks-to-issues \
  --repo <path> \
  --tasks <repository-relative-path> \
  --spec <repository-relative-path> \
  --plan <repository-relative-path> \
  [--group-by task|phase]
```

`task` is the default and creates one issue for each task. `phase` creates one
issue for each canonical task-artifact phase, with unphased tasks collected into
one explicit `Ungrouped` group. Every task belongs to exactly one desired group.

All three source artifacts must be regular files inside the repository, tracked
at `HEAD`, and byte-identical to their `HEAD` versions. The command therefore
creates immutable GitHub blob links at the current commit instead of links that
silently drift with a branch. Task links include the source line anchor.

## Repository Safety

The bridge has no target-repository option. It parses `origin` and derives the
only allowed `{owner, repository}` pair from that remote. Every SCM issue read or
write request carries that derived identity, and the GitHub provider re-reads
the current remote and rejects a mismatch before the first HTTP request.

Unsupported or non-GitHub remotes, a moved checkout, a registry for another
repository, and malformed issue URLs all fail closed. Tokens are loaded through
the existing GitHub provider connection store and are never persisted in the
task-issue registry or run evidence.

## Issue Identity And Bodies

Task-mode titles use the canonical form `T001: <task title>`. Phase-mode titles
use the first task ID followed by the phase name and task count. Created issue
bodies contain:

- the task IDs, titles, completion state, phase/story, dependencies, and paths;
- immutable links to the source spec, plan, and tasks artifact;
- the source commit and selected grouping mode; and
- a machine-readable `nitely-task-ids` HTML marker.

Legacy/manual issues are recognized only when their title begins with a
canonical `Tnnn:` prefix. Nitely-created grouped issues are recognized by the
strict body marker. Arbitrary task-ID mentions elsewhere in a title or body do
not claim a task and cannot suppress creation.

## Complete-Scan Deduplication

Before any mutation, the GitHub provider paginates through `state=all` issues,
filters pull requests from the GitHub issues endpoint, and indexes both open and
closed issues by claimed task ID. Nitely then plans every desired group:

1. If none of its IDs exist, the group is eligible for creation.
2. If every ID belongs to one existing issue, that issue is reused.
3. If only part of a group exists, an ID is claimed by multiple issues, or a
   group is split across existing issues, the entire sync aborts before any
   issue is created.

This makes reruns idempotent and prevents switching grouping modes from creating
overlapping issues. API failure after creation is recoverable: the next run
rescans GitHub, reuses completed writes, and continues with the remaining
groups.

## Local Mapping

After all eligible creations finish, Nitely atomically updates
`.nitely/task-issues.json` using schema `nitely.task-issues.v1`. The ignored
runtime file stores the GitHub repository identity and one binding per stable
task ID: issue number, URL, title/state, source artifact paths and commit, and
sync time. Bindings from other task artifacts remain intact; bindings for the
current artifact are replaced by the authoritative scan result.

If issue creation succeeds but the local write is interrupted, no remote
duplicate is possible because the next invocation reconstructs the mapping from
the complete GitHub scan.

## Run Evidence And Issue Backlinks

At task-scope selection, the runner loads only bindings whose repository still
matches `origin`. `evidence.md` gains a `Task Issues` section listing each unique
issue, its covered selected IDs, and any selected IDs without a mapping. The
same structured mapping is recorded in the run event stream and terminal run
metadata. Resume uses that original run-scoped snapshot even if the mutable
local registry changes later, so a prior terminal comment cannot migrate to a
different issue.

For `completed`, `failed`, and `blocked` terminal outcomes, the runner lists
comments on each unique mapped issue before writing. It looks for a stable
marker derived from repository, run ID, and issue number. An identical existing
comment is reused; when a blocked or failed run later completes on resume, that
same comment is updated in place with the latest terminal status and PR URL.
Only a missing marker creates a new comment. The comment contains:

- the Nitely run ID and terminal status;
- the selected task IDs covered by that issue;
- the local run-evidence path; and
- the pull-request URL when one was published.

Comment-link failures are recorded as `task.issue.run_link_failed` events but do
not replace the run's real terminal result. Created, updated, or reused comments
emit `task.issue.run_linked`. The marker makes resume/retry safe and prevents
duplicate comments without leaving stale blocked-state evidence behind.

## SCM Boundary

The existing `ScmProvider` contract gains optional repository-issue operations:
resolve repository identity, list all issues, create an issue, list issue
comments, and create or update an issue comment. The GitHub REST provider
implements the operations with the existing token, pagination, error
classification, and same-repository checks. Providers without these
capabilities remain valid for PR-only flows; the task bridge reports an
actionable unsupported-capability error.

The task grouping, marker parsing, conflict detection, body rendering, registry
validation, and run-comment rendering live outside the provider and are testable
without network access.

## Verification

Focused tests cover:

- canonical per-task and per-phase grouping and source metadata;
- complete open/closed pagination with pull-request filtering;
- rerun reuse without POST requests;
- partial, split, and duplicate claims aborting before all writes;
- current-remote mismatch rejection before network access;
- strict registry validation and repository matching;
- task-issue URLs and unmapped IDs in run evidence;
- immutable run-scoped mappings across registry changes and resume;
- one terminal comment per unique issue, including grouped task scopes;
- comment-marker reuse and in-place terminal-status updates across retry/resume;
  and
- CLI parsing, defaults, output, and actionable validation failures.

Repository type checks, focused tests, the full Vitest suite, build, CLI
validation, and production dependency audit run before merge and deployment.
