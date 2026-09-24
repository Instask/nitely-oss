# Tech Design: Split TDD Into Write-Tests And Implement Stages

Issue: #466
Spec: `specs/issues/466-tdd-graph-stages-spec.md`

## Summary

Move TDD from the implement agent's prompt into the flow graph. A new
`write-tests` agent stage produces a `tests` artifact from `spec` and
`tech-design`; `implement` consumes that artifact, which makes the ordering a
dependency the runner enforces rather than an instruction the agent may reorder.
The existing `test` command stage stays the hard green gate.

## Change Surface

Declarative only. No schema, runtime, or execution semantics change.

- `flows/implement-spec-bootstrap.json` (codex)
- `flows/implement-spec-bootstrap-grok.json`
- `flows/implement-spec-bootstrap-pi.json`
- `flows/plan-approve-implement-bootstrap.json`
- `src/flows/templates.ts`: the `dev-pr` and `plan-approve-implement` templates,
  which the Console presents as copies of the first and last of those flows.
- `docs/flow-authoring-guide.md`: a "Test-First Topology" section.
- `test/flow/load.test.ts`: updated stage orders plus one topology regression.

## Why The Artifact Edge Is Enough

`loadFlow` derives the DAG from `metadata.inputs`, stage `inputs`, and stage
`outputs`. A stage is eligible only once every input artifact exists. Listing
`tests` in `implement.inputs` therefore means:

- `write-tests` runs first, always, on the green path.
- A run cannot reach `implement` with no test artifact, so "tests exist before
  implementation is considered complete" is a graph property, not a prompt hope.
- `write-tests` sees only `spec` and `tech-design`, so it cannot be handed an
  implementation to fit tests around.

Stages of a run share a worktree, so the test files `write-tests` writes are on
disk for `implement` and for the `test` command stage. `write-tests` satisfies
its single markdown output by writing `tests.md` into its attempt directory,
which `validateAttemptOutputs` already discovers without a manifest.

## What Is Still Prompt-Level

Whether the implement agent weakens a supplied assertion cannot be decided by
the graph today. Two things narrow it:

1. The `implement` prompt forbids deleting, skipping, or loosening supplied
   tests, and gives one explicit alternative: leave the test failing and record
   the disagreement under a `Test contract change` heading in the implementation
   artifact, quoting the specification text that justifies it.
2. The review stage now consumes `tests`, so a reviewer holds the contract and
   the result side by side. An unjustified weakening is a blocking finding.

Deterministic red-then-green detection (running the new tests before implement
and requiring a failure, then a pass) is a larger change to command stage
semantics and is deliberately left as follow-up, matching the issue's non-goals.

## Cost

One extra agent stage per run of these flows. `write-tests` reads only the
specification and the technical design and writes tests, so its context is
smaller than the combined stage it replaces part of. The `model` field stays
available per stage for anyone who wants to pin a cheaper model on it; no model
is pinned here because model ids are operator and runtime specific.

## Risks

- A `write-tests` stage that writes shallow or tautological tests raises cost
  without raising confidence. The prompt demands asserting the values the spec
  demands rather than restating current behavior, and the review stage sees the
  artifact.
- Flows copied from the templates before this change keep the old single-stage
  shape. They stay valid; the authoring guide documents the shape to adopt.

## Verification

- `test/flow/load.test.ts` asserts, for all four flows, that `write-tests`
  exists with the right input and output contract, that `implement` consumes
  `tests` and reads it fully, that graph order is write-tests → implement →
  test → review, and that `review` consumes `tests`.
- `nitely validate` passes on each changed flow.
