# Issue 111 Draft Spec Generation Spec

## Background

Nitely now has structured spec artifacts, but intake still often starts as a
GitHub issue, a Web Console prompt, or pasted notes. Requiring users to hand
write a perfect spec before Nitely can help wastes time and agent context.

## User Stories

- **US-001:** As an operator, I can generate a draft structured spec from a
  GitHub issue number or URL.
- **US-002:** As an operator, I can generate a draft structured spec from a Web
  Console prompt or pasted plain text.
- **US-003:** As a reviewer, I can see that generated specs are drafts and
  cannot start implementation until approved.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a GitHub issue URL, draft generation fetches the
  issue title/body, writes a structured Markdown spec, and records the source
  URL.
- **US-002 / SC-002:** Given a prompt, draft generation writes a structured
  Markdown spec and records prompt intake metadata.
- **US-003 / SC-003:** Starting a run from a draft task returns a validation
  error before `runFlow` is invoked.

## Functional Requirements

- **FR-001:** Accept draft spec source input from GitHub issue number/URL,
  prompt, or pasted text.
- **FR-002:** Generate Markdown using Nitely's structured spec format with
  draft status, source reference, background, stories, requirements, success
  criteria, assumptions, edge cases, out of scope, and open questions.
- **FR-003:** Persist generated specs under `.nitely/tasks/<id>/spec.md`.
- **FR-004:** Persist task metadata linking the original source and generated
  draft spec.
- **FR-005:** Mark generated task/spec status as `draft`.
- **FR-006:** Reject implementation run starts for draft tasks.
- **FR-007:** Expose a Web API endpoint for draft generation.

## Success Criteria

- **SC-004:** Unit tests cover prompt/text draft generation.
- **SC-005:** Web API tests cover GitHub issue intake with an injected fetcher.
- **SC-006:** Web API tests cover prompt intake, artifact persistence, and draft
  run blocking.

## Edge Cases And Failure Behavior

- Empty prompt/text input is rejected.
- Invalid GitHub issue references are rejected.
- GitHub fetch failures return a Web validation error.

## Assumptions

- First slice uses deterministic drafting to avoid hidden LLM cost.
- Human approval/editing is a later workflow; this slice only prevents draft
  implementation.

## Out Of Scope

- LLM planner agent.
- Web Console rich spec editor.
- Automatic draft approval.
