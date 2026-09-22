# Issue 488 Spec: Agent Session Reuse Across Loop Iterations

## Background

`taskPlan.role = execute-current` re-runs one stage in one worktree for every
task in the plan, and each iteration launched a cold `codex exec`. Dogfood ran
six implement attempts whose sessions ended at 594k, 1.68M, 1.02M, 2.02M, 2.20M,
and 2.64M input tokens. The spec, the technical design, and the whole task plan
were re-ingested each time.

Nitely already snapshots inputs to disk. What was missing is a warm runtime
session, so iteration N+1 does not re-ingest iteration N's context.

## User Stories

- **US-001:** As an operator, a task-plan loop sends the full prompt once and a
  delta on every later iteration.
- **US-002:** As a flow author, I can force a stage to run cold, and opt a
  repeating non-loop stage into reuse.
- **US-003:** As an operator on a runtime that cannot resume, my runs keep
  working and the evidence says why they ran cold.
- **US-004:** As an operator, killing and resuming a Nitely run never reaches
  for a session it cannot prove is alive.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a `taskPlan.role = execute-current` stage, when
  the second iteration runs, then the backend receives a resume request with
  the session id the first iteration reported.
- **US-001 / SC-002:** The second iteration's prompt contains the continued
  session header and the updated task-plan input, and does not contain the
  full `Available Inputs` section.
- **US-002 / SC-001:** Given `context.sessionReuse: false`, every iteration
  runs cold with a full prompt.
- **US-003 / SC-001:** Given a runtime with no resume mechanism, a resume
  request runs cold and the outcome reason names the runtime.
- **US-003 / SC-002:** Given a runtime that reports no session id, the next
  iteration runs cold with a full prompt.
- **US-004 / SC-001:** A resumed Nitely run holds no session ids from the
  earlier process.

## Functional Requirements

- **FR-001:** `runAgent` accepts an optional session request and returns an
  outcome carrying `cold` or `resumed`, the session id, and a reason when a
  requested resume did not happen.
- **FR-002:** A runtime declares session reuse as a pair: how to read the
  session id from its output, and how to launch a continuation. Codex uses
  `codex exec resume <thread-id>`, which inherits the sandbox and working
  directory from the session it continues.
- **FR-003:** Add `context.sessionReuse` at flow and stage level. Unset means
  on for stages that declare `taskPlan`, off otherwise.
- **FR-004:** A resumed execution sends a delta prompt: the stage prompt, the
  updated task-plan context, this attempt's output location, and
  previous-failure context when enabled.
- **FR-005:** Session ids live in memory for one `runFlow` call, keyed by stage
  id, and are not persisted.
- **FR-006:** Emit `stage.runtime.session` per attempt.
- **FR-007:** The isolated runtime home from #491 must keep runtime-written
  state across attempts, so a session survives to be resumed. Relink the
  preserved entries instead of deleting the directory.
- **FR-008:** Per-iteration attempts, artifacts, and token usage are recorded
  exactly as before.

## Non-Functional Requirements

- **NFR-001:** A backend caller that supplies no session request keeps the
  previous behavior and makes no claim in the result.

## Out Of Scope

- Sharing a session across different stages, runs, or worktrees.
- Persisting sessions across a Nitely restart.
- Removing the mandatory full re-read of unchanged inputs, which #489 already
  did.

## Assumptions

- A runtime that reports a session id can continue it as long as the process
  that owns its state is the same machine and the same runtime home.
