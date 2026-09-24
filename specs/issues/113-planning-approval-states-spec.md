# Issue 113 Planning Approval States Spec

## Background

Nitely can draft specs, technical designs, and task breakdowns, but generated
planning artifacts must not silently become implementation authority. Operators
need an explicit approval trail before execution starts.

## User Stories

- **US-001:** As a reviewer, I can see whether each planning artifact is still a
  draft, needs changes, or is approved.
- **US-002:** As an operator, I can approve, reject, or request changes on a
  planning artifact from API or CLI entry points.
- **US-003:** As a reviewer, I can trust that implementation runs are blocked
  until required planning artifacts are approved.
- **US-004:** As an auditor, I can inspect durable approval events and run
  evidence that show the planning state used for execution.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a work item with planning metadata, when it is
  listed or fetched, then its current planning status and history are visible.
- **US-002 / SC-002:** Given a draft spec, when a reviewer approves it, then an
  approval event is appended with timestamp, actor, artifact path, state before,
  state after, and decision.
- **US-002 / SC-003:** Given an approved artifact, when a reviewer requests
  changes, then the artifact state moves back to a non-executable state and the
  reason is recorded.
- **US-003 / SC-004:** Given a work item whose spec, tech design, or tasks are
  not approved, when an implementation run starts through CLI or Web API, then
  the run is rejected before `runFlow` executes.
- **US-004 / SC-005:** Given an allowed implementation run, when run metadata and
  evidence are written, then the planning approval snapshot is included.

## Functional Requirements

- **FR-001:** Define first-class planning states:
  `draft_spec`, `spec_needs_clarification`, `spec_approved`,
  `draft_tech_design`, `tech_design_approved`, `tasks_generated`,
  `tasks_approved`, and `ready_for_execution`.
- **FR-002:** Persist planning status in work-item metadata, including current
  artifact states and an append-only approval event history.
- **FR-003:** Approval events must include decision, timestamp, artifact path,
  actor when known, previous state, next state, and optional reason.
- **FR-004:** The approval state machine must reject invalid transitions.
- **FR-005:** Execution must be blocked unless required artifacts are approved:
  spec is `spec_approved`, tech design is `tech_design_approved`, and tasks are
  either absent or `tasks_approved`.
- **FR-006:** A work item with all required approved artifacts must expose
  `ready_for_execution`.
- **FR-007:** CLI and Web API run-start paths must enforce the same approval
  check before invoking `runFlow`.
- **FR-008:** Run metadata and evidence must include a planning approval
  snapshot when a work item is attached.
- **FR-009:** Existing work items without planning metadata remain executable for
  backward compatibility.

## Success Criteria

- **SC-006:** Tests cover valid approval, rejection, and request-change
  transitions.
- **SC-007:** Tests cover invalid transition rejection.
- **SC-008:** Tests prove unapproved spec and tech design states block
  implementation before `runFlow` is called.
- **SC-009:** Tests prove approved planning states allow implementation.
- **SC-010:** Tests prove run metadata exposes the planning approval snapshot.

## Edge Cases And Failure Behavior

- Missing planning metadata is treated as legacy data and does not block.
- A work item with only spec metadata requires only spec approval.
- Task approval is required only when a task artifact is present in metadata.
- Unknown planning states are rejected while writing metadata and treated as
  blocking during execution.
- Approval events are append-only; state changes create new events instead of
  rewriting history.

## Assumptions

- This slice focuses on persisted state, API/CLI enforcement, and evidence.
- Rich Web Console controls can use the same API in a later visual pass.
- Existing legacy task records and generic work items may both need projection
  compatibility.

## Out Of Scope

- SSO or per-user identity beyond the actor identifier already available.
- Rich diff review of planning artifacts.
- Automatic artifact approval.
- Migration that forces planning metadata onto every existing work item.
