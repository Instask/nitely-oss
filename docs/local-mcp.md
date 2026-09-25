# Local MCP Server

Nitely exposes its existing local JSON API to AI coding tools through a built-in
stdio [Model Context Protocol](https://modelcontextprotocol.io/) server. The MCP
process is a thin HTTP adapter: the running Web server remains the source of
truth for tasks, planning approvals, runs, authorization, redaction, and audit.

## Start The Web Server

Start Nitely on a loopback address from the repository whose runtime state it
should operate:

```bash
nitely web --home . --host 127.0.0.1 --port 4173
```

The MCP subprocess connects to this server. It does not start a second Web
server and does not read `.nitely` domain records directly.

The SDK is used here for stdio framing, tool schemas, and MCP negotiation. It
does not fetch connector or knowledge-source URLs: the adapter sends requests
only to the configured Nitely server origin and fixed API paths. URL handling
for connectors, knowledge sources, and execution egress remains in Nitely's
own bounded code paths.

## Create A Scoped Token

Every API token is owned by a user, so the instance needs at least one user
before a token can be minted. If none exist yet, bootstrap the initial admin
once (see the [Web Console bootstrap](web-console.md)):

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-with-a-unique-long-passphrase' \
  nitely web --home . --host 127.0.0.1 --port 4173
# stop the server once the admin is created (Ctrl-C), then mint the token
# against that account's email with --owner below.
```

Create a token with only the capabilities needed by the client:

```bash
nitely mcp token create \
  --repo . \
  --name "Claude Code" \
  --owner <email> \
  --capability tasks:read \
  --capability tasks:write \
  --capability runs:read \
  --capability runs:start \
  --capability spec:approve \
  --capability preview:read \
  --capability preview:control \
  --capability preview:compare \
  --allow-high-impact
```

`--owner` names the user the token acts as; the token resolves provider
credentials the way that user's Web Console session does.

The raw token is printed once. `tasks:write`, `runs:start`, `spec:approve`,
`preview:control`, and `preview:compare` require `--allow-high-impact`;
read-only tokens do not. Supported capabilities:

| Capability | Permitted MCP/API actions |
| --- | --- |
| `tasks:read` | list and inspect tasks, and list the instance's flows |
| `tasks:write` | create tasks and draft specs |
| `runs:read` | list and poll runs |
| `runs:start` | start an approved task run |
| `spec:approve` | approve a task spec or technical design |
| `preview:read` | inspect preview sessions, diagnostics, and view hierarchy |
| `preview:control` | start/stop/navigate/reload/click/type/scroll/capture screenshots in preview sessions |
| `preview:compare` | attach preview screenshots to runs and create visual comparison artifacts |

Anything not explicitly granted is denied. In particular, a valid token cannot
access provider credentials, user/session APIs, repository administration, or
other JSON endpoints.

List or revoke tokens without exposing their secret values:

```bash
nitely mcp token list --repo .
nitely mcp token revoke <token-id> --repo .
```

## Configure An MCP Client

Build Nitely when the client will run the checkout directly:

```bash
pnpm build
export NITELY_API_TOKEN='the-one-time-token-value'
```

Use an absolute checkout path in a stdio MCP configuration:

```json
{
  "mcpServers": {
    "nitely": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/nitely/dist/index.js",
        "mcp",
        "serve",
        "--server",
        "http://127.0.0.1:4173"
      ],
      "env": {
        "NITELY_API_TOKEN": "${NITELY_API_TOKEN}"
      }
    }
  }
}
```

If `nitely` is already installed on `PATH`, use `"command": "nitely"` and
`["mcp", "serve", "--server", "http://127.0.0.1:4173"]` as the args.

Point the CLI at a server one of two ways. With a remote server that has
users, sign in through the browser:

    nitely auth login --server https://nitely.example --capability tasks:read --capability runs:start --allow-high-impact

The CLI prints a URL and a short code, opens your browser, and waits. An
administrator approves the request on that page, and the CLI writes the
issued token to `~/.config/nitely/current-instance.json` (0600). No token is
ever printed or pasted.

For a server running with `--auth local`, browser sign-in is unavailable;
create a token from the server's own machine and connect with it instead:

    nitely mcp token create --repo <path> --name laptop --owner <email> --capability tasks:read
    NITELY_API_TOKEN=<token> nitely connect --server <url>

`nitely auth logout` clears the local file. The token stays valid on the
server until it is revoked in the Web Console or with `nitely mcp token revoke`.

After either route, `mcp serve` can omit `--server` and `NITELY_API_TOKEN` and
use the saved instance. Claude Code supports this stdio shape in `.mcp.json`
and environment expansion;
its current setup and scope options are documented in the
[official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

Do not commit a raw token to `.mcp.json`. Keep the `${NITELY_API_TOKEN}`
placeholder and supply the value through the local client environment. The MCP
command deliberately has no `--token` flag, which keeps credentials out of
process listings.

## Tools And Approval Flow

The server exposes:

- `list_tasks`, `list_flows`, `get_task`, `create_task`, and `draft_spec`;
- `approve_spec` and `approve_tech_design`;
- `start_run`, `list_runs`, and `get_run`;
- `preview_start`, `preview_stop`, `preview_navigate`, `preview_reload`,
  `preview_capture_screenshot`, `preview_get_diagnostics`,
  `preview_get_view_hierarchy`, `preview_click`, `preview_type`,
  `preview_scroll`, and `preview_compare_with_reference`.

For a complete external planning/approval flow, have the coding tool construct
the specification and technical design from the user's prompt, then call
`create_task` with `planningStatus: "draft"`. The task remains blocked until the
client calls both approval tools. `start_run` then accepts the task, and
`get_run` polls its status and evidence metadata. Omitting `planningStatus`
preserves the existing `ready` behavior of `POST /api/tasks`.

`draft_spec` is the existing Planner intake endpoint. Source-backed generated
specs can still require human refinement in the Web Console before approval;
the MCP layer does not bypass that readiness gate.

Preview tools are scoped to the Web server's repository/session ownership
checks. Browser-control tools require `preview:control`; read-only inspection
uses `preview:read`; visual comparison evidence uses `preview:compare`.
Screenshot and comparison tools return artifact metadata and typed JSON results,
not raw image bytes. `preview_compare_with_reference` accepts either a captured
preview `screenshotId` or an implementation image already materialized in the
run, plus a reference image artifact/path under the run.

## Storage, Audit, And Failure Behavior

- `.nitely/api-tokens/tokens.json` stores token ids, names, grants, timestamps,
  revocation state, and SHA-256 verifiers. It never stores raw token values.
- `.nitely/api-tokens/audit.jsonl` records token creation/revocation and every
  Bearer request outcome with metadata only.
- Audit rows omit Authorization headers, request/response bodies, prompts,
  specs, designs, override reasons, token values, and verifiers.
- A missing capability returns HTTP 403 / `capability_denied`; invalid or
  revoked tokens return HTTP 401 / `unauthorized`.
- A Bearer credential is always evaluated as a token, including in local auth
  mode. An invalid token cannot fall back to the unauthenticated local admin.
- MCP stdout contains protocol frames only. Diagnostics use stderr.
- `tokens.json` records each token's `ownerUserId`; the token acts as that
  user, with that user's role and provider credentials.
- Request rows in `audit.jsonl` carry `onBehalfOf: { userId }` identifying the
  owner the request was authorized as.
- A token minted before ownership existed is refused with HTTP 401 /
  `token_unowned`; re-issue it with `mcp token create --owner <user>`.
- `mcp token list` shows `unowned` in the last column for such a token.
- A token whose owner has been deleted is refused with HTTP 401 /
  `owner_missing`.

Token files are owner-readable and retained until the operator revokes or
deletes them. Treat `.nitely` as sensitive operational state and use a separate
runtime directory for development and production.
