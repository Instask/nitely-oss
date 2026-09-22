# Issue 466 Spec: Split TDD Into Write-Tests And Implement Stages

## Background

`implement-spec-bootstrap` and its runtime variants encode TDD only inside the
implement agent's prompt. One stage receives the specification and the technical
design, writes production code and tests together, and reports success. Nothing
in the topology stops that stage from writing code first and then shaping tests
around whatever it produced, or from relaxing an assertion to reach green. The
discipline lives in a sentence, not in the graph.

## User Stories

- **US-001:** As an operator reading a bootstrap Flow, I can see that tests are a
  separate stage that runs before implementation.
- **US-002:** As a reviewer, I receive the test contract the implementation was
  supposed to satisfy, so I can tell whether it was weakened.
- **US-003:** As an operator, a run that reaches review or publish still proves
  the suite is green through the same deterministic command stage.

## Acceptance Scenarios

- **US-001 / SC-001:** The bootstrap Flows declare a `write-tests` agent stage
  producing a `tests` artifact, and `implement` lists `tests` in its inputs, so
  the runner cannot start implementation before the test artifact exists.
- **US-001 / SC-002:** `write-tests` consumes only `spec` and `tech-design`, so
  it cannot be handed an implementation to write tests around.
- **US-002 / SC-001:** The review stage consumes `tests` alongside the
  implementation and the test report.
- **US-002 / SC-002:** The `implement` prompt forbids deleting, skipping, or
  weakening a supplied assertion, and requires an unmet or wrong test to be
  reported in the implementation artifact instead of edited silently.
- **US-003 / SC-001:** The `test` command stage still runs the full suite and
  still gates review and publish; a red suite blocks both exactly as before.
- **US-003 / SC-002:** Every changed Flow still validates and still lints clean
  under `nitely validate`.

## Functional Requirements

- **FR-001:** Add a `write-tests` agent stage to `implement-spec-bootstrap`,
  `implement-spec-bootstrap-grok`, `implement-spec-bootstrap-pi`, and
  `plan-approve-implement-bootstrap`, each on that Flow's own runtime.
- **FR-002:** `write-tests` inputs are `spec` and `tech-design`; its single
  output is `tests`.
- **FR-003:** `write-tests` writes tests only. Its prompt forbids production
  code and does not ask for a green suite.
- **FR-004:** `implement` lists `tests` in `inputs` and in
  `context.fullReadInputs`, so the artifact edge orders the two stages and the
  implement agent reads the whole contract.
- **FR-005:** The `implement` prompt treats supplied tests as a contract: no
  deletion, no skips, no loosened expectations. A test that contradicts the
  specification is left in place and reported under a `Test contract change`
  heading in the implementation artifact.
- **FR-006:** The review stage consumes `tests` and treats an unjustified
  weakening as a blocking finding.
- **FR-007:** The `test` command stage is unchanged and remains the hard gate
  before review and publish.
- **FR-008:** Mirror the split in the `dev-pr` and `plan-approve-implement` Flow
  templates, which the Console presents as copies of these Flows.
- **FR-009:** Document the two-stage shape in the flow authoring guide.

## Non-Functional Requirements

- **NFR-001:** The change stays declarative. No runtime, schema, or execution
  semantics change.
- **NFR-002:** Each Flow stays readable at a glance: no stage crosses the
  production lint thresholds for inputs or outputs.
- **NFR-003:** A repository test asserts the topology so a later edit cannot
  quietly collapse the two stages back into one.

## Out Of Scope

- Red-then-green detection beyond the existing command success or failure.
- Dynamic fan-out or conditional expressions in the Flow schema.
- Pilot Flows and rework Flows, whose implement-like stages start from a task
  plan or existing review feedback rather than from a specification.
- Pinning a cheaper model on `write-tests`. Model ids are operator and runtime
  specific; the per-stage `model` field is already available to anyone who wants
  it.

## Assumptions

- Stages of one run share a worktree, so test files written by `write-tests`
  are present for `implement` and for the `test` command stage.
- An agent stage with a single markdown output satisfies it by writing
  `tests.md` into its attempt directory, which the runner already discovers.
