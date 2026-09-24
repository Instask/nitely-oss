# Convergence Pass Technical Design

Issue: [#109](https://github.com/Instask/nitely/issues/109)

## Outcome

Nitely gains an opt-in convergence contract for agent stages. The agent compares
the current worktree with the supplied spec, plan, and Markdown task artifact and
emits a structured gap report. Nitely validates that report and deterministically
creates a new task artifact by appending remaining-work tasks. The source spec,
plan, and tasks remain immutable.

The generated report and converged task list are ordinary typed run artifacts.
They therefore appear in the artifact registry and `evidence.md`, and a later
stage can consume the converged task artifact for rework or PR update.

## Flow Contract

An agent stage may declare:

```json
{
  "convergence": {
    "tasksInput": "tasks",
    "reportOutput": "convergence-report",
    "tasksOutput": "converged-tasks"
  }
}
```

The task input must be listed in `inputs`; both outputs must be distinct and
listed in `outputs`. The built-in `converge-feature-artifacts` template supplies
`spec`, `plan`, and `tasks`, produces described artifact contracts, and can be
extended by making a rework stage consume `converged-tasks`.

The agent must write:

- a `nitely.convergence.v1` JSON report;
- a non-empty placeholder for the converged task output, preferably an exact
  copy of the input tasks; and
- the normal `artifact.json` attempt manifest.

Nitely always replaces the placeholder with its own deterministic result before
registering either artifact. Agent-authored changes to existing task text can
therefore never enter the converged artifact.

## Report Contract

Each gap contains:

- `classification`: `missing`, `partial`, `contradicts`, or `unrequested`;
- an inline `title` suitable for a task;
- one or more `sourceRefs` such as `FR-001`, `SC-002`, `US-001/AC-002`,
  `PD-001`, `plan:<slug>`, or `constitution:<slug>`;
- one or more evidence statements grounded in the current worktree; and
- optional repository-relative paths.

The parser rejects unknown fields, empty evidence, invalid references, absolute
or parent-traversing paths, duplicate semantic gaps, and unsupported versions.
Titles and evidence are normalized to a single line before they can be rendered
into Markdown.

## Deterministic Append

`src/task-artifacts/convergence.ts` validates the source with the canonical task
parser, then computes a SHA-256 fingerprint from each gap's normalized
classification, title, sorted source references, and sorted paths. Evidence text
is deliberately excluded so line-number or wording changes do not create a new
task for the same semantic gap.

For gaps not already represented by a `nitely-convergence:<fingerprint>` marker:

1. Sort by fingerprint so agent output order cannot change task IDs.
2. Start after the greatest existing `Tnnn` value; never fill holes or reuse an
   earlier ID.
3. Append a `## Convergence` section containing unchecked tasks with
   classification, source references, paths, and an HTML fingerprint marker.
4. Fail closed if a new ID would exceed `T999`.

The original bytes are always the exact prefix of a changed artifact. If the
report is clean, or every reported gap already has a marker, the original task
buffer is written byte-for-byte unchanged. Re-running against a prior converged
artifact is therefore idempotent and preserves assigned IDs.

## Runtime And Evidence

After normal attempt-output path containment checks, the runner:

1. locates the configured report and task outputs and rejects aliased paths;
2. parses the report;
3. reads the configured input task buffer;
4. writes the deterministic converged result to the validated task-output path;
5. registers both typed outputs through the existing artifact pipeline; and
6. includes convergence counts and appended task IDs in the stage-completion
   payload.

Because both outputs use the existing artifact publisher, `evidence.md` records
their IDs, types, producer stage, and run-relative paths without a parallel
evidence store.

## Safety And Failure Semantics

- All agent output paths must already resolve inside the attempt directory.
- Report and task output paths must resolve to different files.
- Source inputs are read only; only the validated generated-output path is
  written.
- Invalid reports, invalid source task artifacts, duplicate semantic gaps, and
  ID exhaustion fail the stage through its normal retry policy.
- A failed convergence never records a completed stage.
- Resume rehydrates already-generated artifacts through the existing completed
  agent-stage path; it does not append a second time.

## Verification

Focused tests cover:

- missing, partial, contradicting, and unrequested gap classification;
- source-reference and path validation;
- stable sequential IDs without reuse or renumbering;
- deterministic ordering, fingerprint deduplication, and rerun idempotence;
- exact byte preservation for a clean pass;
- invalid reports and invalid task artifacts;
- flow-schema wiring for convergence inputs and outputs;
- an agent-stage run that overwrites the placeholder, publishes both artifacts,
  records them in evidence, and exposes `converged-tasks` to a downstream stage;
- the built-in template and checked-in flow document.

Repository checks, the full Vitest suite, build, and production audit run before
the PR is merged and deployed.
