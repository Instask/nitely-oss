# Local MCP Server And Scoped API Tokens Tech Design

## Scope

Implement issue #396 as a local, stdio MCP server that exposes the existing
Nitely task, planning-approval, and run JSON APIs to process-spawned AI coding
tools. The MCP layer remains a thin HTTP adapter: it does not read task files,
start runs directly, or add a second implementation of any domain operation.

The first slice intentionally excludes a hosted or multi-tenant MCP endpoint,
OAuth/SSO, and consume-side management of the MCP servers declared by agent
stages. Streamable HTTP can be added later without changing the tool or scoped
token contracts.

## Protocol And Dependency

Use the production-recommended v1 line of the official TypeScript MCP SDK and
its `StdioServerTransport`. Nitely targets the latest published MCP protocol
revision supported by that SDK. The SDK owns initialization, capability
negotiation, `tools/list`, `tools/call`, validation, and newline-delimited stdio
framing.

The MCP process writes protocol messages only to stdout. Diagnostics go to
stderr. Each tool validates its arguments with Zod, returns the JSON API payload
as both structured content and serialized text for client compatibility, and
reports API/validation failures as actionable tool errors. A small per-process
rate limiter bounds accidental call loops.

## Tool Contract

| MCP tool | JSON API | Capability | Side-effect annotation |
| --- | --- | --- | --- |
| `list_tasks` | `GET /api/tasks` | `tasks:read` | read-only |
| `get_task` | `GET /api/tasks/:taskId` | `tasks:read` | read-only |
| `create_task` | `POST /api/tasks` | `tasks:write` | write |
| `draft_spec` | `POST /api/draft-specs` | `tasks:write` | write |
| `approve_spec` | `POST /api/tasks/:taskId/approve-spec` | `spec:approve` | high impact |
| `approve_tech_design` | `POST /api/tasks/:taskId/approve-tech-design` | `spec:approve` | high impact |
| `start_run` | `POST /api/tasks/:taskId/runs` | `runs:start` | high impact |
| `list_runs` | `GET /api/runs` | `runs:read` | read-only |
| `get_run` | `GET /api/runs/:runId` | `runs:read` | read-only |

Inputs mirror the existing endpoint bodies and identifiers. `create_task` adds
an optional `planningStatus: "draft" | "ready"` field to the existing API;
`ready` remains the compatibility default. `draft` stores the supplied spec and
technical design as drafts so the same MCP client can exercise the existing
spec/design approval state machine before starting a run. This is an additive
API input mapped onto existing `createTask` options, not a new planning path.
`start_run` also maps `override` to the existing query parameter and keeps the optional reason
and task scope in the existing request body. Responses pass through the same Web
API redaction path used by browser and JSON clients.

## MCP Process And Configuration

The built-in command is:

```text
nitely mcp serve --server <local-web-url>
```

`--server` falls back to `NITELY_SERVER_URL`. The token is read only from
`NITELY_API_TOKEN`; it is deliberately not accepted as a command-line flag so it
does not appear in process listings. A Claude Code, Cursor, or VS Code MCP entry
therefore starts the normal `nitely` executable and supplies the server URL and
token through its local configuration environment.

The Web server remains the source of truth and must already be running. Network
errors and non-JSON responses become sanitized tool errors. The adapter never
logs request headers or token values.

## Scoped Token Store

Token administration is local CLI-only:

```text
nitely mcp token create --repo <path> --name <name> \
  --capability <capability> [--capability <capability> ...] \
  [--allow-high-impact]
nitely mcp token list --repo <path>
nitely mcp token revoke <token-id> --repo <path>
```

The supported capabilities are exactly `tasks:read`, `tasks:write`,
`runs:read`, `runs:start`, and `spec:approve`. Tokens default deny: creation
requires at least one explicit capability, and API-token access to every other
endpoint is rejected. `tasks:write`, `runs:start`, and `spec:approve` require
`--allow-high-impact` at creation time.

The raw token contains a public token id plus a cryptographically random secret.
It is printed once. `.nitely/api-tokens/tokens.json` stores only a SHA-256
verifier, token id, display name, capabilities, creation time, and optional
revocation time. The file and atomic replacements use owner-only permissions.
Authentication uses constant-time verifier comparison. Listing never returns a
raw token or verifier.

Tokens are machine-local operator credentials, independent of browser sessions.
Possession of the repository runtime directory already grants access to the
same local operational state, while endpoint capabilities limit what an
external client can exercise. In required-auth mode, a valid token still has
only its declared endpoint capabilities; it does not inherit a browser user's
cookie or organization identity.

## API Authorization

Before normal JSON API routing, the Web server recognizes the
`Authorization: Bearer <token>` header. A valid token is mapped to a server-owned synthetic operator
identity for the existing record and run code paths. The route-to-capability
table above is evaluated before that identity is installed.

- Missing or malformed credentials return `unauthorized`.
- A revoked or invalid token returns `unauthorized` without exposing which part
  failed.
- A valid token missing the route capability returns HTTP 403 with stable code
  `capability_denied` and names the required capability.
- A valid token presented to an endpoint outside the table is denied by
  default.
- Cookie auth and the existing unauthenticated local-mode behavior remain
  unchanged when no Bearer credential is present.

This placement makes the API boundary authoritative. A custom or modified MCP
client cannot bypass a missing grant by calling the local JSON endpoint itself.

## Audit Contract

`.nitely/api-tokens/audit.jsonl` is append-only and owner-readable. It records:

- token creation with the explicit capability grants;
- token revocation;
- each Bearer-authenticated or token-shaped API attempt, including normalized
  action, required capability, token id when parseable, safe task/run target id,
  allow/deny decision, success/error outcome, HTTP status, timestamp, and a
  stable reason code.

Audit entries never contain raw tokens, token verifiers, Authorization headers,
request/response bodies, prompts, specs, technical designs, override reasons,
or API payloads. Successful requests, capability denials, invalid/revoked-token
attempts, and domain failures after authorization are all distinguishable.

## Failure And Compatibility Behavior

Bearer credentials are handled even in local auth mode; an invalid or
under-scoped Bearer token cannot silently fall back to local-admin access. Calls
without Bearer headers retain current behavior, so the Web Console, existing
CLI commands, and local API clients do not break.

MCP API errors preserve the stable JSON API error code and message but never
include headers or raw transport failures that could contain credentials. Tool
responses use the Web API's already-redacted payload rather than re-reading
unredacted local artifacts.

## Tests

- Token-store tests cover explicit grants, high-impact confirmation, one-time
  secret return, verifier-only persistence, authentication, listing, revocation,
  permissions, and audit metadata safety.
- Web API tests cover every route/capability mapping, local-mode non-fallback,
  required-mode Bearer access, clear `runs:start` denial, default-denied routes,
  revoked/invalid tokens, domain failures, and audit success/denial/error rows.
- MCP adapter tests cover all nine endpoint mappings, Bearer headers, URL/body
  encoding, structured results, sanitized API errors, and rate limiting.
- An SDK-level in-memory integration test performs initialization,
  `tools/list`, and `tools/call` against a real local Web server.
- CLI tests cover token create/list/revoke parsing, high-impact confirmation,
  environment-only token loading, and stdout silence while serving MCP.
- Build, typecheck, focused suites, the full test suite, remote development
  preflight, production smoke, and an MCP client smoke complete the delivery
  loop.
