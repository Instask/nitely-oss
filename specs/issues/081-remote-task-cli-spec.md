# Issue 81 Spec: Remote Task Creation CLI

## Background

Nitely can create tasks through the Web Console by posting specification and
technical design text to `POST /api/tasks`. Operators who work from a local
checkout still need a fast way to submit those local files to a shared Nitely
server without opening the Web UI or copying large markdown payloads by hand.

## User Stories

- **US-001:** As an operator with a local spec and technical design, I can submit
  a task to a remote Nitely server from the CLI.
- **US-002:** As an operator automating issue work, I can pass the GitHub issue URL
  and desired flow path so the remote task is ready to run from the console.
- **US-003:** As an operator, I get clear command-line failures when files are
  missing, the server URL is absent or invalid, or the remote API rejects the
  request.

## Acceptance Scenarios

- **US-001 / SC-001:** Given valid local spec and technical design files, when I run
  `nitely task create --server <url> --title <title> --spec <path> --tech-design <path>`,
  then Nitely reads both files, posts their contents to `<url>/api/tasks`, and
  prints the task id, status, issue URL when present, and Web Console task URL.
- **US-001 / SC-002:** Given `NITELY_SERVER_URL` is set, when I omit `--server`, then
  the CLI uses the environment value as the remote server base URL.
- **US-002 / SC-001:** Given `--issue` and `--flow`, when the command succeeds, then
  the request body includes `issueUrl` and `flowPath` unchanged.
- **US-003 / SC-001:** Given the spec or tech design path cannot be read, when I run
  the command, then the CLI exits non-zero, prints which option failed, and does
  not call the remote server.
- **US-003 / SC-002:** Given the server returns a non-2xx response with a JSON error,
  when I run the command, then the CLI exits non-zero and prints the HTTP status
  plus the remote error message.
- **US-003 / SC-003:** Given the server returns a malformed success payload, when I
  run the command, then the CLI exits non-zero with an invalid response message.

## Functional Requirements

- **FR-001:** Add a `task create` CLI command.
- **FR-002:** Support `--server`, `--title`, `--issue`, `--spec`, `--tech-design`,
  `--flow`, and `--repo-id`.
- **FR-003:** Use `NITELY_SERVER_URL` when `--server` is omitted.
- **FR-004:** Require server URL, title, spec path, and tech design path.
- **FR-005:** Read spec and technical design as UTF-8 text from local paths.
- **FR-006:** POST JSON to `/api/tasks` with `title`, `spec`, `techDesign`,
  optional `repoId`, optional `issueUrl`, and optional `flowPath`.
- **FR-007:** Treat any non-2xx response as failure and surface useful JSON or text
  error content.
- **FR-008:** Print a concise success summary including task id, status if present,
  issue URL if present, and `/tasks/<task-id>` Web URL.
- **FR-009:** Preserve existing local `run`, `rework-pr`, and Web Console behavior.
- **FR-010:** Document the new command in both English and Chinese READMEs.

## Non-Functional Requirements

- **NFR-001:** Unit tests must cover success, missing file, server error, and
  environment server fallback.
- **NFR-002:** The command must not require the target repository to be checked out
  locally.
- **NFR-003:** Error messages must be stable enough for CLI users and tests.

## Out Of Scope

- Starting the submitted task run from the CLI.
- Uploading arbitrary file attachments.
- Authentication/token management for remote servers.
- Changing `POST /api/tasks` server semantics.

## Assumptions

- The remote server is reachable over the local network or another trusted
  operator-controlled network.
- Existing Web Console auth behavior remains server-side. This first CLI command
  targets servers that allow the current API request.
