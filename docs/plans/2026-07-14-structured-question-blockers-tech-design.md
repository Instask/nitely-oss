# Structured Question Blockers Tech Design

## Scope

Implement issue #395 as a narrow operator-decision pause for agent stages. The
feature builds on append-only run events, existing blocker projection, and the
existing resume path. It does not add a conversational runtime or a new stage
type.

## Artifact And Event Contract

An agent may write `<attempt-directory>/question.json`:

```json
{
  "version": 1,
  "question": "Should deleted tasks keep their run history?",
  "options": [
    { "id": "keep", "label": "Keep history", "recommended": true },
    { "id": "purge", "label": "Purge history" }
  ],
  "context": "This changes retention behavior."
}
```

The question id is deterministic for its source attempt:
`<stage-id>-<attempt>`. On detection, Nitely records:

1. `artifact.published` for the JSON file.
2. `stage.question` with the validated question and provenance.
3. `stage.blocked` and `run.blocked` with
   `reason: awaiting_operator_answer` and the question id.

An answer records `operator.answer` with either `optionId` or `text`, plus actor
and event time. Events remain the source of truth; `question.json` is never
rewritten with the answer.

## Implementation Plan

### `src/run/questions.ts`

- Define the versioned question, option, answer, and projected-question types.
- Parse and strictly validate `question.json` with Zod.
- Detect the optional file without weakening normal stage output validation.
- Implement `listQuestions` and `answerQuestion` over the event store.
- Validate pending state, option membership, one-of answer shape, and duplicate
  answers before appending `operator.answer`.
- Render the dedicated resume prompt section.

### Events And Projection

- Add `stage.question` and `operator.answer` event types.
- Extend blocker payloads with an optional `questionId`.
- Project question and answer events into `ProjectedRun.questions` and
  `ProjectedRun.pendingQuestion`.
- Keep the source attempt blocked after answer until resume starts a new attempt.

### Agent Execution And Resume

- Add question escalation instructions to agent prompts only (not review gates).
- After a successful agent runtime call, parse `question.json` before validating
  required outputs.
- Publish the question and throw the existing blocked-run control signal without
  appending any failure/retry decision.
- Before resume, reject an active question blocker whose question is unanswered.
- Pass an answered question for the selected stage into the new attempt prompt.

### CLI

- Add `questions <run-id> --repo <path>`.
- Add `answer <run-id> <question-id> --option <id>|--text <answer>
  [--actor <name>] --repo <path>`.
- Extend `status` with the pending question, context, and option labels.

### Web API And Console

- Add `POST /api/runs/:runId/questions/:questionId/answer`.
- Apply existing run visibility and write-authorization checks.
- Render the pending question on run detail with option buttons and a free-text
  form.
- Refresh run detail after the answer is accepted; normal resume remains an
  explicit lifecycle action.

### Evidence

- Add a Questions And Answers section to `evidence.md`.
- Add question and answer items to the Web evidence timeline.
- Because terminal evidence refresh already updates an existing PR, the same
  section becomes PR evidence without a second publication path.

## Safety And Compatibility

- Question paths remain constrained to the attempt directory.
- Question and answer payloads pass through existing runtime/Web redaction.
- Unknown or malformed files never become blockers.
- Existing blocker reasons, projections, and resume behavior remain compatible.
- Event readers tolerate old runs that have no question events.

## Tests

- Unit tests for schema validation and answer invariants.
- Projection tests for pending, answered, resumed, and terminal states.
- Run-flow integration tests proving block -> answer -> resume -> completion and
  malformed-question failure behavior.
- CLI tests for listing, answering, status output, and invalid one-of arguments.
- Web API tests for authorization and answer validation.
- Static/Web run-detail tests for the question card and evidence timeline.
