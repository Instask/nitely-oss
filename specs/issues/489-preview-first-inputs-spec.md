# Issue 489 Spec: Preview-First Input Delivery

## Background

`docs/context-delivery-and-usage.md` documented one contract for every textual
input larger than 8 KiB: an 8 KiB head preview, an absolute `Full content`
path, and an instruction that the agent **must** read the whole file before
using that input.

That contract saves prompt bytes and then orders the model to spend them again.
A dogfood `prompt.md` of ~24 KB produced Codex sessions whose final turn input
reached 2,644,865 tokens. Every implement iteration re-read the spec, the
technical design, and a ~23 KB 16-task plan. `inputBytesSaved` reported those
bytes as saved while the prompt required reading them back.

## User Stories

- **US-001:** As a flow author, a truncated preview is the default contract, so
  a task-plan loop does not re-ingest the same artifacts on every iteration.
- **US-002:** As a flow author, I can declare the specific inputs a stage
  genuinely cannot work from a preview of.
- **US-003:** As an operator, `inputBytesSaved` reflects bytes the model never
  had to take into context.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a textual input larger than 8 KiB and no opt-in,
  when the prompt is assembled, then it contains a head preview declared
  sufficient and neither `Full content` nor a mandatory-read instruction.
- **US-002 / SC-001:** Given a stage with
  `context.fullReadInputs: ["spec"]`, when the prompt is assembled, then the
  `spec` input carries an absolute `Full content` path and a mandatory-read
  instruction.
- **US-002 / SC-002:** Given `context.fullReadInputs` naming an id the stage
  does not declare in `inputs`, then the flow fails validation.
- **US-003 / SC-001:** Given a mandatory-read input, then its `savedBytes`
  contribution is zero.
- **US-003 / SC-002:** Given budget trimming forced an input to path-only, then
  its `savedBytes` contribution is zero, because the prompt orders a full read.

## Functional Requirements

- **FR-001:** Truncated textual inputs are delivered as orientation by default,
  with an absolute `Local path` and no mandatory-read instruction.
- **FR-002:** Add `context.fullReadInputs`, a list of input ids, at flow and
  stage level. Stage level overrides flow level like the other context
  controls.
- **FR-003:** Every `fullReadInputs` id must be declared in that stage's
  `inputs`, and ids must not repeat.
- **FR-004:** Listed ids keep the previous contract: `Full content` absolute
  path plus a mandatory-read instruction.
- **FR-005:** Budget trimming still delivers path-only with a mandatory read,
  because the agent has no content at all.
- **FR-006:** `savedBytes` is zero whenever the prompt orders a full read.
- **FR-007:** Resolved `fullReadInputs` appear in the run evidence
  `Stage Context Controls` section.
- **FR-008:** Built-in flows opt in only where a preview cannot work: planner
  stages, single-attempt implement stages, and technical-design drafting. Loop
  implement stages do not opt in.
- **FR-009:** Update `docs/context-delivery-and-usage.md` and
  `docs/project-instructions.md`.

## Non-Functional Requirements

- **NFR-001:** The on-disk snapshot and the path in the prompt do not change,
  so an agent can still open any input it chooses.

## Out Of Scope

- Bounding how many bytes an agent may read from the worktree (#490).
- Reusing one agent session across loop iterations (#488).
- Deleting snapshots from disk.

## Assumptions

- Flow authors know which stages cannot work from a head preview; that judgment
  belongs in the flow, not in a global default.
