# Issue 506 Spec: CLI Remote Planning Approval And Run Start

## Background

The CLI's governance commands are repository-local. `approvals`, `approve`,
`deny`, `questions`, and `answer` take a run id plus `--repo <path>` and read or
append to the local event store. Against a connected instance there is no CLI
equivalent, so an operator who submits a Task with `nitely task create` must open
the Web Console to approve its spec, approve its technical design, and start its
Run.

`POST /api/tasks/:id/approve-spec` and `POST /api/tasks/:id/approve-tech-design`
(`spec:approve`) and `POST /api/tasks/:id/runs` (`runs:start`) already exist and
are already reachable with an API token. Only the CLI side is missing.

## User Stories

- **US-001:** As an operator connected to an instance, I can approve a Task's spec
  from the CLI.
- **US-002:** As an operator connected to an instance, I can approve a Task's
  technical design from the CLI.
- **US-003:** As an operator connected to an instance, I can start a Run for a
  Task from the CLI and get the run id to watch.
- **US-004:** As an operator, I get clear failures when the token lacks the
  capability, no instance is configured, or the instance rejects the request.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a connected instance, when I run
  `nitely task approve-spec <task-id>`, then the CLI POSTs to
  `/api/tasks/<task-id>/approve-spec` and prints the task id with its resulting
  spec status.
- **US-002 / SC-001:** Given a connected instance, when I run
  `nitely task approve-tech-design <task-id>`, then the CLI POSTs to
  `/api/tasks/<task-id>/approve-tech-design` and prints the task id with its
  resulting technical design status.
- **US-003 / SC-001:** Given a connected instance, when I run
  `nitely task start <task-id>`, then the CLI POSTs a JSON object body to
  `/api/tasks/<task-id>/runs` and prints the started run id and status.
- **US-003 / SC-002:** Given a started Run, when the command succeeds, then the
  output names `nitely run watch <run-id>` as the next step.
- **US-003 / SC-003:** Given the server returns a payload without `run.runId`,
  when I run the command, then the CLI exits non-zero with an invalid response
  message.
- **US-004 / SC-001:** Given a token without the required capability, when I run
  any of the three commands, then the CLI exits non-zero and prints the HTTP
  status plus the remote capability message.
- **US-004 / SC-002:** Given no configured instance, when I run any of the three
  commands, then the CLI exits non-zero, says no instance is configured, and does
  not call the remote server.
- **US-004 / SC-003:** Given any failure, when the CLI prints the error, then the
  resolved API token is redacted.

## Functional Requirements

- **FR-001:** Add `task approve-spec <task-id>`, `task approve-tech-design
  <task-id>`, and `task start <task-id>` CLI commands.
- **FR-002:** All three resolve the instance exactly as `task list` does:
  `--server`, then `NITELY_SERVER_URL`, then the saved current instance.
- **FR-003:** `task start` sends a JSON object body, because the route requires
  one, and sends `content-type: application/json`.
- **FR-004:** The CLI never sets `override=true`; run eligibility blockers stay a
  Web Console decision.
- **FR-005:** Support `--json` on all three, emitting the server payload
  unchanged.
- **FR-006:** Require a task id, and reject unknown options with the command's
  usage line.
- **FR-007:** Treat any non-2xx response as failure and surface JSON or text error
  content from the response.
- **FR-008:** Redact the resolved API token from every error message.
- **FR-009:** Preserve local `approvals`, `approve`, `deny`, `questions`, and
  `answer` behavior unchanged, and keep `nitely help` free of a `cancel` command.
- **FR-010:** Document all three commands in `nitely help` and in both READMEs.

## Non-Functional Requirements

- **NFR-001:** Unit tests must cover success, `--json`, missing task id, missing
  instance, capability denial, and invalid response for the new commands.
- **NFR-002:** None of the commands may require a local repository checkout.
