# Issue 493 Spec: List Flows On The Connected Instance

## Background

`nitely task create --flow <path>` forwards whatever the caller supplies. The
caller has to already know a valid Flow id on the target instance. The Web
Console lists builtin and user-defined Flows through `GET /api/flows`, but that
route is not reachable with an API token and the CLI has no command for it, so
an operator or coding agent on another machine cannot discover which Flows the
connected instance will accept.

## User Stories

- **US-001:** As an operator connected to an instance, I can list the Flows that
  instance exposes and pass one of the printed ids into `task create --flow`.
- **US-002:** As a coding agent driving the CLI or MCP, I can read the Flow
  catalog as JSON and pick a runnable Flow without opening the Web Console.
- **US-003:** As an operator, a failed listing tells me whether no instance is
  configured, the instance is unreachable, or the instance rejected my token.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a saved instance, when I run `nitely flow list`,
  then the CLI prints one line per Flow with its id, source (`builtin` or
  `user`), runnable state, and name.
- **US-001 / SC-002:** When the instance exposes no Flows, then the CLI prints
  `No flows` and exits `0`.
- **US-001 / SC-003:** Each invocation queries the instance, so a Flow added,
  renamed, or removed on the instance is reflected by the next `flow list`.
- **US-002 / SC-001:** When I run `nitely flow list --json`, then the CLI prints
  a single JSON object with a `flows` array carrying the server payload.
- **US-002 / SC-002:** When an MCP client calls `list_flows`, then it receives
  the same catalog through the API token it already holds.
- **US-003 / SC-001:** With no `--server`, no `NITELY_SERVER_URL`, and no saved
  instance, the command fails with `Missing --server or NITELY_SERVER_URL`.
- **US-003 / SC-002:** When the instance answers with a non-2xx status, then the
  CLI prints `remote flow list failed (HTTP <status>): <message>`.
- **US-003 / SC-003:** When the response is not the expected shape, then the CLI
  prints `remote flow list failed: invalid response: missing flows`.
- **US-003 / SC-004:** A resolved API token never appears in stdout or stderr.

## Functional Requirements

- **FR-001:** Add `nitely flow list [--server <url>] [--json]`.
- **FR-002:** Resolve the instance and token exactly as other remote commands do:
  `--server`, then `NITELY_SERVER_URL`, then the saved current instance from
  #484; token from `NITELY_API_TOKEN`, then the saved instance.
- **FR-003:** Fetch `GET /api/flows` on every invocation. Keep no local catalog.
- **FR-004:** Map `GET /api/flows` to the API token action `flows.list` with the
  `tasks:read` capability so tokens that may read tasks may also read the Flow
  catalog they would submit against.
- **FR-005:** Text output prints `<id>  <source>  <runnable|blocked>  <name>` and
  a trailing hint that the id is what `task create --flow` accepts.
- **FR-006:** `--json` prints `{"flows": [...]}` as a single line carrying the
  server's Flow views unchanged.
- **FR-007:** Add an MCP `list_flows` tool that proxies `GET /api/flows`.
- **FR-008:** Redact the resolved API token from error output.
- **FR-009:** Document `flow list` in both READMEs and in the CLI usage text,
  including that `task create --flow` values should come from it.

## Non-Functional Requirements

- **NFR-001:** `flow list` adds no writes to the local config directory.
- **NFR-002:** Error messages stay stable enough for scripts and tests.
- **NFR-003:** The catalog exposes no Flow documents, only summaries the Console
  already returns.

## Out Of Scope

- Authoring, uploading, or editing Flows from the CLI.
- A durable offline Flow replica.
- Changing server-side Flow storage semantics.
- Validating `task create --flow` against the catalog before submitting.

## Assumptions

- `GET /api/flows` already filters to Flows the caller may see, and API-token
  requests act with the token's own user context.
