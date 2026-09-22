# Issue 505 Spec: CLI Remote Task And Run Listing

## Background

After `nitely connect`, the CLI can submit a Task and watch one known id, but it
cannot enumerate what a connected instance already holds. `nitely runs` and
`nitely status` read the local repository event store under `--repo <path>`, so
an operator working against a shared server has to open the Web Console to find
a Run id before `nitely run watch` is usable.

`GET /api/tasks` (`tasks.list`, `tasks:read`) and `GET /api/runs` (`runs.list`,
`runs:read`) already exist and are already reachable with an API token. Only the
CLI side is missing.

## User Stories

- **US-001:** As an operator connected to an instance, I can list that instance's
  Tasks so I can find the Task I care about without the Web Console.
- **US-002:** As an operator connected to an instance, I can list that instance's
  Runs and narrow them to one status, so I can find a Run id to watch.
- **US-003:** As an agent driving the CLI, I can take machine-readable output from
  both listings.
- **US-004:** As an operator, I get clear failures when no instance is configured,
  the instance is unreachable, or auth is rejected.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a connected instance with Tasks, when I run
  `nitely task list`, then the CLI calls `GET /api/tasks` and prints one line per
  Task with id, status, and title.
- **US-001 / SC-002:** Given an instance with no Tasks, when I run
  `nitely task list`, then the CLI prints `No tasks` and exits zero.
- **US-002 / SC-001:** Given a connected instance with Runs, when I run
  `nitely run list`, then the CLI calls `GET /api/runs` and prints one line per
  Run with run id, status, task id when present, and current stage when present.
- **US-002 / SC-002:** Given Runs in several statuses, when I run
  `nitely run list --status running`, then only Runs whose status matches are
  printed.
- **US-002 / SC-003:** Given `--status` with a value that is not a Run status,
  when I run the command, then the CLI exits non-zero and names the accepted
  statuses without calling the remote server.
- **US-003 / SC-001:** Given `--json`, when either listing succeeds, then the CLI
  prints the server's array unchanged under its original key and prints no
  human-readable summary lines.
- **US-004 / SC-001:** Given no `--server`, no `NITELY_SERVER_URL`, and no saved
  current instance, when I run either command, then the CLI exits non-zero and
  says no instance is configured.
- **US-004 / SC-002:** Given the server returns a non-2xx response, when I run
  either command, then the CLI exits non-zero and prints the HTTP status plus the
  remote error message, with the resolved API token redacted.

## Functional Requirements

- **FR-001:** Add a `task list` CLI command calling `GET /api/tasks`.
- **FR-002:** Add a `run list` CLI command calling `GET /api/runs`.
- **FR-003:** Both resolve the instance exactly as `flow list` does: `--server`,
  then `NITELY_SERVER_URL`, then the saved current instance.
- **FR-004:** Support `--json` on both commands, emitting the server payload
  array unchanged.
- **FR-005:** Support `--status <status>` on `run list`, filtering client-side and
  rejecting values outside the known Run statuses.
- **FR-006:** Treat any non-2xx response as failure and surface JSON or text error
  content from the response.
- **FR-007:** Treat a payload without the expected array as an invalid response.
- **FR-008:** Redact the resolved API token from every error message.
- **FR-009:** Preserve local `runs`, `status`, `run <flow>`, `run watch`,
  `task create`, and `task watch` behavior unchanged.
- **FR-010:** Document both commands in `nitely help` and in both READMEs.

## Non-Functional Requirements

- **NFR-001:** Unit tests must cover success, empty listing, `--json`, status
  filtering, invalid status, missing instance, and remote error for both commands.
- **NFR-002:** Neither command may require a local repository checkout.
