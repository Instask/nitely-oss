# Issue 484 Spec: Persist The Current CLI Instance

## Background

Issue 81 added `nitely task create` so a local operator can submit spec and
technical design files to a remote Nitely server. The server is still supplied
on every invocation with `--server` or `NITELY_SERVER_URL`. Other coding agents
cannot assume a current instance, and production Web requires a bearer token
that `task create` does not send.

## User Stories

- **US-001:** As an operator, I can connect the CLI to a Nitely server once so
  later processes on the same machine reuse that instance.
- **US-002:** As a coding agent, I can run `nitely task create` without
  `--server` and submit a task to the instance the operator already connected.
- **US-003:** As an operator of an auth-required server, the saved instance can
  carry an API token without printing it or accepting `--token`.

## Acceptance Scenarios

- **US-001 / SC-001:** Given `NITELY_API_TOKEN` is set, when I run
  `nitely connect --server <url>`, then the CLI saves the server URL and token
  under the user config directory and prints that a token is configured without
  printing the token.
- **US-001 / SC-002:** When I run `nitely whoami` after a successful connect,
  then the CLI prints the saved server and whether a token is configured.
- **US-001 / SC-003:** When I run `nitely disconnect`, then later `whoami` and
  remote commands no longer use that saved instance.
- **US-002 / SC-001:** Given a saved instance, when I run `nitely task create`
  without `--server`, then the CLI posts to the saved server.
- **US-002 / SC-002:** Given `--server` or `NITELY_SERVER_URL`, when I omit the
  other, then that explicit value overrides the saved server for this invocation
  only and does not rewrite the saved instance.
- **US-003 / SC-001:** Given a saved token, when I create a remote task, then the
  request includes `Authorization: Bearer <token>`.
- **US-003 / SC-002:** Given `NITELY_API_TOKEN` is set, when a saved token also
  exists, then the environment token is used for this invocation.
- **US-003 / SC-003:** When I pass `--token` to `connect` or `mcp serve`, then
  the command fails and does not write the token to process arguments.

## Functional Requirements

- **FR-001:** Add `connect`, `whoami`, and `disconnect` CLI commands.
- **FR-002:** Persist `{ version: 1, serverUrl, apiToken? }` in
  `$NITELY_CONFIG_DIR/current-instance.json`, else
  `$XDG_CONFIG_HOME/nitely/current-instance.json`, else
  `$HOME/.config/nitely/current-instance.json`.
- **FR-003:** Create the config directory with mode `0700` and the file with
  mode `0600`.
- **FR-004:** Read the API token only from `NITELY_API_TOKEN`. Do not add a
  `--token` flag.
- **FR-005:** Resolve the remote server as `--server`, then `NITELY_SERVER_URL`,
  then the saved instance.
- **FR-005a:** `scheduler` is local by default and only runs remotely when
  `--server` or `NITELY_SERVER_URL` is set. A saved instance must not switch it
  from local to remote.
- **FR-006:** Resolve the remote token as `NITELY_API_TOKEN`, then the saved
  token.
- **FR-007:** Send `Authorization: Bearer <token>` on remote CLI HTTP calls
  when a token is resolved.
- **FR-008:** `mcp serve` uses the same server and token resolution.
- **FR-009:** Never print the token. Redact the resolved token, whether it came
  from `NITELY_API_TOKEN` or the saved instance, in error output.
- **FR-010:** Document the connect flow in both READMEs.

## Non-Functional Requirements

- **NFR-001:** Tests must isolate config through `NITELY_CONFIG_DIR` and must
  not read or write the real user config directory.
- **NFR-002:** Injected CLI `env` objects that omit `HOME`, `XDG_CONFIG_HOME`,
  and `NITELY_CONFIG_DIR` have no saved instance.
- **NFR-003:** Error messages must be stable enough for CLI users and tests.

## Out Of Scope

- Named multi-instance contexts.
- Starting the submitted task run from the CLI.
- Interactive token prompts.
- Changing `POST /api/tasks` server semantics.

## Assumptions

- One current instance per user account on the machine is enough for the first
  slice.
- Operators create scoped API tokens with `nitely mcp token create` on the
  target repository before connecting.
