# `nitely auth login` — Browser Device Flow — Design

Date: 2026-09-07
Issue: none filed yet
Status: Design drafted, pending spec review

## Summary

Today, pointing the CLI at a remote Nitely server requires hand-carrying a
token: run `nitely mcp token create` against the server's repo (or copy the
value out of the Web Console), `export NITELY_API_TOKEN=...`, then
`nitely connect --server <url>`. The token only ever reaches the config file
because the operator pasted it into an environment variable first.

This design adds `nitely auth login`, which obtains that token through a
browser approval instead. It follows the **OAuth 2.0 Device Authorization
Grant (RFC 8628)** shape: the CLI asks the server for a pair of codes, prints
a URL, the operator approves in an already-authenticated browser, and the CLI
polls until it can exchange the device code for a freshly issued API token —
which it writes to the existing `current-instance.json` store.

The CLI never handles a password, and never needs to listen on a port, so a
CLI running over SSH on a remote dev box works exactly like a local one.

### In scope

- Four server-side pieces: a device-authorization endpoint, an approval page,
  an approve/deny endpoint, and a device-token polling endpoint.
- A `nitely auth login` command that runs the flow and persists the result via
  the existing `writeCurrentInstance`.
- `nitely auth logout` as a named alias for the existing local `disconnect`.
- Security audit records for each step of the flow.

### Out of scope (deliberately deferred)

- **Binding API tokens to a user.** `ApiTokenRecord` has no `userId`, and an
  authenticated API token currently resolves to a synthetic `role: "admin"`
  user. This design does not change that; it contains the blast radius by
  letting only `role: "admin"` users approve a device request. Revisit when
  the multi-user system lands. See "Known limitation" below.
- **Token expiry.** `ApiTokenRecord` has no `expiresAt`; adding a token
  lifecycle is its own effort.
- **Remote revocation from the CLI.** `logout` clears the local file only; the
  token is revoked from the Web Console or `nitely mcp token revoke`.
- **Refresh tokens / re-authentication.** The issued API token is long-lived,
  exactly as today.
- **OIDC or an external identity provider.** Nitely authenticates users itself
  ([users.ts](../../../src/web/users.ts)); this reuses that, and does not
  introduce a dependency on an external issuer.

## Background — current state

**Persisting a token already works.**
[cli-current-instance.ts](../../../src/cli-current-instance.ts) writes
`~/.config/nitely/current-instance.json` (honouring `NITELY_CONFIG_DIR` and
`XDG_CONFIG_HOME`) with a 0700 directory, a 0600 file, and an atomic
temp-file-plus-rename write. `resolveRemoteApiToken` reads
`NITELY_API_TOKEN` first and the stored file second. None of this needs to
change.

**Obtaining a token is the gap.** `createApiToken`
([api-tokens.ts:249](../../../src/web/api-tokens.ts)) is invoked from exactly
one place — `nitely mcp token create` ([cli.ts:3338](../../../src/cli.ts)) —
which writes the server's repo-local token store directly from the filesystem
and prints the value once. No HTTP endpoint issues a token, so a CLI talking
to a remote server has no way to obtain one on its own.

**The server authenticates users with a session cookie.**
`POST /api/session` ([server.ts:6117](../../../src/web/server.ts)) verifies
email and password, rate-limits per email via `loginAttemptLimiter`
([login-throttle.ts](../../../src/web/login-throttle.ts)), and sets
`nitely_session`. `UserRole` is `"admin" | "user"`.

**API tokens are unowned and run as admin.** After
`authenticateApiToken` succeeds, `prepareApiTokenRequest` synthesises
([server.ts:756](../../../src/web/server.ts)):

```ts
user: { id: `api-token:${token.id}`, email: `api-token:${token.name}`,
        role: "admin", authMode: "local" }
```

Authorization comes solely from the capability list plus the endpoint map in
[api-token-auth.ts](../../../src/web/api-token-auth.ts); an endpoint absent
from that map rejects API tokens outright.

**The Web Console is a single 6,612-line SPA** (`src/web/static/console.dc.html`)
routed by pathname through a whitelist in `handleHtmlRequest`.

## Design

### Why the device grant rather than a localhost redirect

A localhost redirect (CLI opens an ephemeral HTTP listener, browser redirects
back to `127.0.0.1`) avoids the pending-request store and the polling loop, but
requires the browser and the CLI to be on the same machine, and carries the
token back through a URL where it can leak into browser history and proxy
logs. Nitely's CLI is frequently driven over SSH on a remote box, where a
loopback redirect simply cannot reach the operator's browser. The device grant
was designed for that case, at the cost of one short-lived server-side record.

### Flow

```
CLI                          Server                       Browser (operator)
 |  POST /api/device-authorization                              |
 |  {capabilities, allowHighImpact, clientName}                 |
 |----------------------------->|                               |
 |  {device_code, user_code,    | store pending record          |
 |   verification_uri_complete, |                               |
 |   expires_in, interval}      |                               |
 |<-----------------------------|                               |
 |  print URL + user_code, best-effort open browser ----------->|
 |                              |   GET /device?code=XXXX-XXXX  |
 |                              |<------------------------------|
 |                              |   (session required; admin)   |
 |                              |   shows capabilities + client |
 |                              |   POST .../approve            |
 |                              |<------------------------------|
 |                              | mark approved + approvedBy    |
 |  POST /api/device-token      |                               |
 |  {device_code}   (poll)      |                               |
 |----------------------------->| on approved: createApiToken,  |
 |  {access_token, ...}         | delete record (one-shot)      |
 |<-----------------------------|                               |
 |  writeCurrentInstance()      |                               |
```

The token is minted **at exchange time**, not at approval time, so a plaintext
token never rests in the pending record.

### Code format

Reuse the proven shape from `createApiToken`, which already splits a
public locator from a secret:

- `user_code` — 8 characters from a `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
  alphabet (no `0/O/1/I/L`), formatted `XXXX-XXXX` for reading aloud.
  Normalised on input by upper-casing and stripping non-alphanumerics.
- `device_code` — `<user_code_raw>.<43 base64url chars>`. The server splits on
  the dot, locates the record by user code, and compares a SHA-256 of the whole
  device code against the stored hash with `timingSafeEqual` — mirroring
  `authenticateApiToken`.

Storing the user code in the device code is what lets the record be addressed
by a single filename while the secret half stays unguessable.

### Storage

`<homeRepo>/.nitely/device-authorizations/<user_code_raw>.json`, one file per
request, atomic write, following the per-file session model in `users.ts`:

```ts
interface DeviceAuthorizationRecord {
  version: 1;
  userCode: string;
  deviceCodeHash: string;          // sha256 hex, never the plaintext
  status: "pending" | "approved" | "denied";
  capabilities: ApiTokenCapability[];
  allowHighImpact: boolean;
  clientName: string;              // e.g. "cli@dev-box"
  createdAt: string;
  expiresAt: string;               // createdAt + 10 minutes
  intervalSeconds: number;         // 5
  lastPolledAt?: string;           // drives slow_down
  approvedByUserId?: string;
}
```

Expired records are deleted lazily on read, exactly as `readSessionUser`
handles expired sessions. A successful exchange deletes the record, making the
device code one-shot.

### Endpoints

**`POST /api/device-authorization`** — unauthenticated (the caller has no
credential yet, by definition). Body: `capabilities` (required, non-empty,
validated against `API_TOKEN_CAPABILITIES`), `allowHighImpact` (bool),
`clientName` (1–80 printable chars, trimmed, else defaulted). Returns
`device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in`, `interval`.

`verification_uri` is `<serverUrl>/device`; `verification_uri_complete` is
`<serverUrl>/device?code=XXXX-XXXX`, which prefills the code so the operator
usually only has to click Approve.

Because it is unauthenticated, it is rate-limited per client IP with the
existing `LoginAttemptLimiter`, and creating a record grants nothing on its
own — an unapproved record is inert.

**Behaviour under the other two auth states.** When the server runs with
`--auth local`, user authentication is disabled entirely and there is nobody to
approve on behalf of; the endpoint returns 409
`{error: "device_flow_unavailable"}` telling the operator to use
`nitely mcp token create` plus `connect` instead. When no users exist yet, it
raises the existing `WebSetupRequiredError`, matching what `POST /api/session`
already does.

**`GET /device`** — a standalone HTML page served from
`src/web/static/device.html`, *not* a route added to the console SPA. The
approval screen is the security-critical surface of this feature; keeping it
out of the 6,612-line SPA state machine makes it reviewable on its own and
keeps its failure modes independent. It requires a session; when absent it
directs the operator to sign in and return to the same URL.

**`POST /api/device-authorizations/approve`** — session-authenticated,
**requires `role: "admin"`**; a `role: "user"` session gets 403 with an
explanation. Body: `userCode`, `decision: "approve" | "deny"`. Failed user-code
lookups are counted per session by a `LoginAttemptLimiter` instance so the
short code cannot be brute-forced from an authenticated seat.

**`POST /api/device-token`** — unauthenticated, body `device_code`. Responses
follow RFC 8628 error naming so the CLI state machine reads like the
reference implementation:

| Condition | HTTP | Body |
|---|---|---|
| pending | 400 | `{error: "authorization_pending"}` |
| polled faster than `interval` | 400 | `{error: "slow_down"}` |
| denied | 400 | `{error: "access_denied"}` |
| expired or unknown | 400 | `{error: "expired_token"}` |
| approved | 200 | `{access_token, token_id, capabilities, name}` |

**None of these four endpoints is added to `apiTokenActionForRequest`.** That
map is a whitelist, so an API token calling them is rejected with
`endpoint_not_allowed` — a token cannot mint itself a successor. This falls
out of the existing design rather than needing new code, and a test pins it.

### Audit

Reuse `appendSecurityAuditBestEffort`, matching the shape of the existing
`auth.login` records, with actions `auth.device.authorize`,
`auth.device.approve`, `auth.device.deny`, and `auth.device.exchange`. Approve
and deny carry the acting user via `securityAuditActorForUser`. Token issuance
is separately recorded by `createApiToken`'s own `token.created` event.

### CLI

A new `src/cli/auth-device.ts` holds the protocol, with every side effect
injected — `fetchImpl`, `sleep`, `now`, `spawnImpl`, `platform` — so the state
machine is tested without network, clock, or browser. This matches how
`dependencies` is already threaded through `cli.ts`, and follows the structure
of the equivalent module in the `agentaab` CLI.

```
nitely auth login --server <url>
                  --capability <cap>       (repeatable, required)
                  [--allow-high-impact]
                  [--no-browser]
```

Behaviour: request codes → print `verification_uri_complete` and the user code
to **stderr** (so stdout stays clean for scripting) → best-effort
`openBrowser` unless `--no-browser`; a failure to launch is not a login
failure, since the URL is already on screen → poll, honouring `interval` and
`slow_down` → on success call `writeCurrentInstance` and print the stored path
and token id, **never the token itself**.

`clientName` defaults to `cli@<hostname>` so the token is identifiable and
revocable in the Web Console.

Errors route through the existing `redactSecret` before reaching stderr.

`nitely auth logout` clears the local file via `clearCurrentInstance`,
printing a reminder that the server-side token remains valid until revoked.
`connect` / `disconnect` keep working unchanged.

### Known limitation, stated deliberately

An API token issued this way is unowned and resolves to `role: "admin"` at
request time, like every other API token today. Restricting approval to admin
users means the flow cannot *escalate* privilege — only an admin can cause a
token to exist — but it also means the token outlives any change to the
approving user's role. Binding tokens to a user is the fix, and it is deferred
to the multi-user work by explicit decision. The `approvedByUserId` field is
recorded now so that migration has the data it needs.

## Testing

Server, in `test/web/`:
- Full lifecycle: authorize → approve → exchange → token authenticates.
- Deny, expiry, unknown code, and double exchange each produce the right error.
- A `role: "user"` session cannot approve.
- Polling faster than `interval` yields `slow_down`.
- Brute-forcing user codes trips the limiter.
- All four endpoints reject API-token bearer credentials.
- The stored record never contains the plaintext device code or token.
- Under `--auth local` the authorize endpoint returns `device_flow_unavailable`
  rather than issuing codes nobody can approve.

CLI, in `test/cli/`:
- The polling state machine over injected `fetchImpl`/`sleep`/`now`:
  pending → approved, `slow_down` backoff, denial, expiry.
- `openBrowser` failure does not fail the login.
- Success writes `current-instance.json` with 0600, and the token is absent
  from both stdout and stderr.

Per the repo's usual practice these run on the Linux box rather than macOS.

## Open questions

None blocking. Two decisions were taken as defaults and are cheap to revise
during review: the 10-minute code lifetime, and requiring `--capability`
explicitly rather than shipping a default set.
