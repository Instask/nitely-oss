# Issue 537 Spec: Resume a Run Stopped on a Hard Budget

## Background

#517's fourth requirement has two halves. #528 records a stage that produced
its declared artifacts as complete before the run fails with
`reason: "budget_exceeded"`. Resume still rejected that run: `resumeRun`
accepted only a stage in `interrupted`, `blocked`, or `awaiting-approval`, and
a budget stop has none.

#487 made budget exhaustion terminal. This change makes that terminal state
recoverable only when the operator raises the cap first. It does not weaken
the cap.

## User Stories

- **US-001:** As an operator, I can raise `maxRuntimeTokens` on a
  budget-stopped run's flow, resume, and continue at the first incomplete
  stage.
- **US-002:** As an operator, a stage that already completed is not
  re-executed on that resume.
- **US-003:** As an operator, resuming without raising the cap fails with an
  explanation instead of re-tripping the same cap at admission.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a two-stage flow whose first stage completes and
  then crosses a hard runtime-token cap, when the operator raises
  `spec.budgets.maxRuntimeTokens` above consumed tokens and resumes, then
  execution starts at the second stage and the run can complete.
- **US-002 / SC-001:** The first stage is not invoked again.
- **US-003 / SC-001:** Given the same budget-stopped run, when the operator
  resumes without raising the cap, then resume throws naming the consumed
  total and instructing them to raise `spec.budgets.maxRuntimeTokens` above
  it. No `run.resumed` event is appended and no later stage starts.
- **US-003 / SC-002:** A failed run whose `run.failed` reason is not
  `budget_exceeded` still throws `run is not resumable`.

## Functional Requirements

- **FR-001:** A run whose latest `run.failed` reason is `budget_exceeded` is
  a resume candidate even when no stage is `interrupted`, `blocked`, or
  `awaiting-approval`.
- **FR-002:** The resume target is the first stage in graph order that is not
  in `completedStages` and is not `alwaysRun`.
- **FR-003:** Resume reloads `spec.budgets` from the current flow file on
  disk (except eval replay, which stays pinned). Stage graph and prompts stay
  the recorded document.
- **FR-004:** If the effective cap is still at or below consumed billable
  runtime tokens, resume refuses before starting a stage.
- **FR-005:** A successful budget resume appends `run.resumed` with
  `reason: "budget_exceeded"` and the selected stage, then continues the same
  run. Projection treats the run as running again so later stages are not
  finalizers.
- **FR-006:** Declared budgets and the defaulted cap both count. Raising the
  default via `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` is enough when the flow
  still declares no `maxRuntimeTokens`.

## Non-Functional Requirements

- **NFR-001:** The refusal message names the consumed total and the current
  cap so the operator does not have to open the event store.
- **NFR-002:** Eval replay resume stays fail-closed on its pinned Flow
  document; it does not pick up a mutated budget from disk.

## Out Of Scope

- Automatically raising the cap.
- Resuming a budget-stopped eval replay against a different Flow digest.
- Gate and command stages that still lose completion to the cap (#538).
