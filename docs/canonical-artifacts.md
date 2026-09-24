# Canonical Artifact Model

Nitely's execution chain is:

spec -> technical design -> tasks -> run evidence -> PR evidence

source-controlled Markdown is the canonical execution artifact for a run.
External documents are collaboration inputs or snapshots that must be
materialized as local snapshots or repo Markdown before execution.

This keeps the durable state reviewable in Git, readable in a worktree, and
traceable through stable IDs without requiring a hosted document system or a
database-backed artifact model.

## Spec

The spec defines product scope and reviewable behavior. It owns:

- user stories with `US-*` IDs;
- functional requirements with `FR-*` IDs;
- success criteria with `SC-*` IDs;
- explicit assumptions, failure behavior, and out-of-scope boundaries.

`US-*`, `FR-*`, and `SC-*` IDs are stable once referenced by a technical design,
task artifact, run, or PR. Do not renumber them after review starts; mark removed
behavior as superseded or out of scope instead.

External Google Docs, Lark documents, Drive files, issue bodies, or chat notes
can inform the spec, but they are not canonical run state. Before execution,
Nitely should consume either repo Markdown or a snapshotted input artifact whose
source URI and content hash can be recorded.

## Technical Design

The technical design explains how the approved spec will be implemented. It
owns:

- upstream references to relevant `US-*`, `FR-*`, and `SC-*` IDs;
- product or implementation decisions with `PD-*` IDs;
- files/modules touched, contracts, data model changes, compatibility, tests,
  and complexity tracking.

`PD-*` IDs are stable once a task, run, or PR references them. If a decision is
replaced, keep the old ID visible and add a new `PD-*` entry for the replacement.

## Tasks

The task artifact turns the spec and technical design into executable slices. It
owns:

- stable `T*` task IDs, normally `T001`, `T002`, and so on;
- dependency ordering such as `(depends: T001)`;
- optional `[P]` markers for tasks that can run in parallel;
- upstream references to `US-*`, `FR-*`, `SC-*`, and `PD-*` IDs where practical.

Each task should be small enough to verify and should name the concrete files,
tests, or docs it expects to touch when that is known.

## Run Evidence

Run evidence records what Nitely consumed and produced during execution. It
should reference:

- consumed spec, technical design, and task artifacts by artifact ID, path,
  source URI, and hash when available;
- the relevant `US-*`, `FR-*`, `SC-*`, `PD-*`, and `T*` IDs for the stage or
  finding;
- prompts, command output, generated artifacts, gates, blockers, approvals, and
  runtime decisions needed for review.

Run evidence is downstream of the Markdown artifacts. It proves what happened;
it does not redefine the approved product scope.

## PR Evidence

PR evidence summarizes the run for reviewers. It should cite:

- the consumed spec/design/task artifacts and their source paths;
- relevant `US-*`, `FR-*`, `SC-*`, `PD-*`, and `T*` IDs;
- verification commands, gate outcomes, blocker resolution, generated artifact
  paths, and publication metadata.

Review comments and follow-up rework should reference stable IDs instead of
quoting long prose blocks. If the PR changes scope, update the canonical Markdown
artifact first or create a new follow-up task before treating the PR evidence as
complete.
