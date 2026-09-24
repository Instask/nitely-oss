# Issue 112 Draft Technical Design Generation Spec

## Background

Structured specs define product intent, but implementation still needs a
technical plan grounded in the repository. Nitely should help draft that plan
without treating the assistant as an autonomous architecture authority.

## User Stories

- **US-001:** As an operator, I can generate a draft technical design from an
  approved structured spec.
- **US-002:** As a planner, I can see repository-specific file/module and test
  command recommendations in the draft.
- **US-003:** As a reviewer, I can verify that draft technical designs cannot
  start implementation until approved.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a task with an approved spec, draft generation
  writes `tech-design.md` using the standard technical plan format.
- **US-002 / SC-002:** Given repository context, the draft includes likely files,
  modules, and test commands.
- **US-002 / SC-003:** Given insufficient repository context, the draft records
  open questions instead of inventing specifics.
- **US-003 / SC-004:** Starting a run with a draft technical design fails before
  `runFlow` starts.

## Functional Requirements

- **FR-001:** Require an approved spec before generating a draft technical
  design.
- **FR-002:** Read lightweight repository context: package scripts, top-level
  source/test/docs directories, and known templates.
- **FR-003:** Generate Markdown using the standard technical plan format from
  #105.
- **FR-004:** Link plan sections to available `US-###`, `FR-###`, and `SC-###`
  IDs.
- **FR-005:** Persist the generated technical design under the task's
  `tech-design.md` path.
- **FR-006:** Mark generated technical design status as `draft`.
- **FR-007:** Reject implementation runs when task technical design status is
  `draft`.
- **FR-008:** Expose a Web API endpoint for draft technical design generation.

## Success Criteria

- **SC-005:** Tests cover approved-spec requirement.
- **SC-006:** Tests cover repository context recommendations.
- **SC-007:** Tests cover missing-context open questions.
- **SC-008:** Tests cover draft technical design run blocking.

## Edge Cases And Failure Behavior

- Draft spec status blocks generation.
- Missing or invalid spec content returns a validation error.
- Missing repository context produces conservative plan text with open
  questions.

## Assumptions

- This slice uses deterministic drafting.
- Human approval/editing of the technical design is a later workflow.

## Out Of Scope

- LLM architecture drafting.
- Web Console rich plan editor.
- Automatic approval of generated plans.
