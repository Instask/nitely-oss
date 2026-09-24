# Issue 395 Spec: Structured Question Blockers

## Problem

An agent stage that encounters a genuine product or implementation ambiguity can
only guess or fail. A normal failure consumes retry budget and loses the human
decision that unblocked the work, while guessing makes the resulting pull
request harder to trust.

## Goals

- Let an agent stage pause a run with one validated, structured operator
  question.
- Reuse the existing blocked-run and resume lifecycle without treating the
  question attempt as a failure.
- Preserve the question, answer, actor, and timestamps in run and pull-request
  evidence.
- Let operators inspect and answer the question from both the CLI and Web
  Console.

## User Stories

- **US-001:** As an agent, I can write `question.json` when an unresolved human
  decision prevents me from safely completing the stage.
- **US-002:** As an operator, I can inspect the pending question and choose a
  declared option or provide a free-text answer.
- **US-003:** As an operator, I cannot resume the blocked stage until its pending
  question has an answer.
- **US-004:** As a reviewer, I can see the question and answer provenance in the
  evidence timeline and PR evidence.

## Functional Requirements

- **FR-001:** Agent prompts describe `question.json` as an optional escalation
  file and include its versioned JSON contract.
- **FR-002:** A question has `version: 1`, a non-empty `question`, zero or more
  unique options, and optional context. Each option has a stable id, non-empty
  label, and optional `recommended` marker; at most one option is recommended.
- **FR-003:** A valid `question.json` takes precedence over normal required-output
  validation for that attempt. Invalid question JSON fails normally with a
  precise validation error and does not create a blocker.
- **FR-004:** Nitely publishes the question artifact, appends a `stage.question`
  event, then appends `stage.blocked` and `run.blocked` with reason
  `awaiting_operator_answer` and the question id.
- **FR-005:** The question attempt is blocked, not failed or completed, and does
  not create a retry-policy decision.
- **FR-006:** The run projection exposes pending and answered questions with
  stage, attempt, question text, options, context, actor, and timestamps.
- **FR-007:** CLI commands list and answer questions. `status` prints a pending
  question and its options.
- **FR-008:** The Web run detail renders a pending-question card with option
  actions and a free-text alternative, and submits answers through an
  authenticated run-scoped API.
- **FR-009:** An answer appends one immutable `operator.answer` event. It must
  select a declared option or contain non-empty free text, and it must identify
  the actor.
- **FR-010:** `resume` rejects an unanswered question blocker. After an answer,
  the resumed agent attempt receives the original question, context, selected
  option or free text, actor, and answer timestamp in a dedicated prompt
  section.
- **FR-011:** Question and answer details appear in `evidence.md`, the Web
  evidence timeline, and refreshed PR evidence.
- **FR-012:** Existing usage-limit and runtime-unavailable blockers retain their
  current behavior.

## Edge Cases

- A missing `question.json` has no effect.
- Duplicate option ids, multiple recommended options, an empty question, an
  unsupported version, or malformed JSON are validation failures.
- An option answer must reference an option declared by that question.
- A question cannot be answered twice and an answer cannot target a stale or
  unrelated question.
- Free text and an option id are mutually exclusive.
- Secrets in question and answer text follow the existing runtime/Web redaction
  boundary.

## Non-Goals

- No free-form multi-turn chat.
- No AI-generated operator answers.
- No external notification-channel work in this slice.
- No change to normal failed-attempt retry semantics.

## Success Criteria

- A deterministic test run can write a question, become blocked without a
  `stage.failed` event, accept an answer, resume the same stage with answer
  context, and complete.
- Invalid and duplicate answers fail closed.
- CLI, Web API/UI, projection, and evidence tests cover the new lifecycle.
