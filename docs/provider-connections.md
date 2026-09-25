# Provider Connections

Status: connection model and Web connect flows.

A **Provider** is something Nitely authenticates to (GitHub, Anthropic, Google
Drive, …). A **Provider Connection** is one credential for that provider,
established through one **auth method**. The two are separate concepts: a
provider declares which methods it supports, and a user or workspace may hold
more than one connection for the same provider.

## Provider descriptors

`src/providers/descriptors.ts` declares, per provider, the supported auth
methods in precedence order and how each maps to runtime consumption:

| Provider | Methods | Runtime variable |
| --- | --- | --- |
| `github` | `pat` (paste), `oauth` (connect flow) | `NITELY_GITHUB_TOKEN` |
| `anthropic` | `api_key` (paste), `oauth_token` (paste) | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `google-drive` | `oauth` (connect flow), `oauth_token` (paste) | `NITELY_GOOGLE_ACCESS_TOKEN` |
| `glm`, `jira` | `api_key` | provider-specific |
| `grok` | `api_key`, `cli_managed` | `XAI_API_KEY` |
| `codex`, `pi` | `cli_managed` | — |

The mapping from method to variable belongs to the descriptor. Generic store
code never inspects secret prefixes; the only prefix rule left
(`sk-ant-oat` → `oauth_token`) is the descriptor's `legacyAuthMethod`, used
solely to assign a method to records written before methods were explicit.

## Connection records

`.nitely/connections.json` (version 2) holds an array of
`ProviderConnectionRecord`s: id, provider, auth method, label, state
(`active | expired | revoked`), default flag, scopes, account identity,
expiry, ownership metadata (scope / owner / repository / organization) and
timestamps. It holds **no credential bytes**. Each record's `credentialRef`
names an entry in the secret store — locally a `0600`
`connections.secrets.json` beside the metadata file, behind the
`ProviderSecretStore` interface so hosted deployments can substitute a vault.

Version-1 files (one inline `value` per provider) keep resolving. Each entry
projects to one default connection whose method the provider's legacy rule
assigns; the file is rewritten into the version-2 layout, with the secret moved
out, on the next write.

Environment-backed credentials project into the same model as env-only
connections, so status consumers see one shape regardless of source.

## Selection

Runtime resolution is deterministic:

1. an explicit `connectionId` wins;
2. otherwise the requested `authMethod`, or the descriptor's method order when
   none is requested;
3. within a method, the **default** connection. The first connection created
   for a (provider, method) is the default; adding another never steals it,
   `makeDefault` or `POST …/connections/:id/default` moves it, and removing the
   default promotes the oldest remaining connection.

A personal store shadows the shared repository store per provider: if the user
holds any connection for a provider, the shared store's connections for that
provider are not consulted. `resolveEnv()` projects the default connection of
every method that has one and clears the provider's other variables inherited
from the environment, so the stored configuration is the single source of
truth for that provider.

## OAuth lifecycle

`getAccessToken()` remains the runtime boundary. For a connection with an
expiry it refreshes transparently through the configured refresher when a
refresh token exists, rotating the stored material; a rejected refresh marks
the record `revoked` and drops its secret. An expired credential without a
refresh path is marked `expired`. Both surface as a structured
`ReconnectRequiredError` (`reason: expired | revoked`) and as
`reconnectRequired: true` in status, and neither is projected into the runtime
environment. Revoking a connection keeps the record as evidence and removes its
material.

## Audit

`connections.json.audit.jsonl` records `set`, `clear`, `status-check`,
`refresh`, `revoke` and `expired` events with connection id, auth method and
safe ownership metadata. Token bytes never appear in audit events, status
responses, or API responses; `credentialRef` is not exposed either.

## API

- `GET /api/providers` — per provider: `configured`, `reconnectRequired`,
  `authMethods[]` each with its configured flag and connection summaries.
- `POST /api/providers/:id/connection` — `{ value, authMethod?, connectionId?,
  label?, makeDefault?, metadata? }`. Omitting `authMethod` is the legacy path
  and replaces the provider's default of the inferred method. Methods
  established by a connect flow reject pasted values.
- `DELETE /api/providers/:id/connection[?connectionId=|?authMethod=]`.
- `POST /api/providers/:id/connections/:connectionId/default`.

## Connect flows (OAuth)

GitHub and Google Drive connect through a redirect flow implemented by
`src/providers/oauth/adapters.ts` (endpoints, scopes, identity lookup,
refresh, revocation) and `src/web/provider-oauth-flows.ts` (the CSRF
boundary). An adapter exists only when its OAuth client is configured:

| Provider | Client id | Client secret |
| --- | --- | --- |
| `github` | `NITELY_GITHUB_OAUTH_CLIENT_ID` | `NITELY_GITHUB_OAUTH_CLIENT_SECRET` |
| `google-drive` | `NITELY_GOOGLE_OAUTH_CLIENT_ID` | `NITELY_GOOGLE_OAUTH_CLIENT_SECRET` |

Register `<public url>/oauth/callback/<provider>` with the provider. The
public URL comes from `NITELY_WEB_PUBLIC_URL`; only a local-mode server may
derive it from the request's Host header, because that header is
client-controlled.

- `POST /api/providers/:id/oauth/start` (`{ connectionId? }`) issues a
  single-use state and a PKCE verifier bound to the signed-in user and the
  provider, and returns `authorizeUrl`. Passing `connectionId` reconnects that
  connection in place.
- `GET /oauth/callback/:id?code&state` consumes the state before anything
  reaches the provider's token endpoint. An unknown, expired, replayed,
  other-user or other-provider state redirects to
  `/providers?oauthError=<code>` and stores nothing; a mismatch burns the
  state. On success the code is exchanged, the account identity fetched, and an
  `oauth` connection stored with scopes, expiry, refresh token and account,
  then the browser lands on `/providers?connected=<id>`.
- `POST /api/providers/:id/connections/:cid/disconnect` revokes at the
  provider (best effort) and marks the connection revoked; repeating it is a
  no-op success.
- `POST /api/providers/:id/connections/:cid/validate` exercises
  `getAccessToken()` — refreshing if needed — and returns `{ ok }` plus the
  refreshed summary, or `{ ok: false, reason }` when reconnect is required.

Start, connect, disconnect, validate and default changes are recorded in the
security audit log as `providers.oauth.start`, `providers.oauth.connect`,
`providers.oauth.disconnect`, `providers.validate` and `providers.default`.

## Web Console

The Providers page lists each provider's auth methods separately: redirect
methods show **Connect with …** / **Reconnect** / **Disconnect** and the
connected account, scopes and expiry; manual methods show a masked write-only
form with **Update** / **Clear** / **Add another**; CLI-managed methods show
status and remediation only. Expired or revoked connections are badged
"reconnect" and never projected into runs. Stored values are never rendered.
