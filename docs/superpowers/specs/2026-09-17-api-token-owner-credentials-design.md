# API Tokens Carry an Owner; Token-Triggered Runs Use the Owner's Credentials

Date: 2026-09-17
Status: approved design, slice A of the credential model rework
Related: #546, PR #550 ("Not covered"), #552, #563

## Problem

A credential configured on the Web Console Providers page lands in the
signed-in user's store, `<repo>/.nitely/users/<userId>/connections.json`.
A run started from the browser resolves that store (with the repository store
as fallback, since PR #550). A run started through an API token — `nitely task
start`, the MCP server, anything scripted — does not: the token has no owning
user, so `prepareApiTokenRequest` (`src/web/server.ts:808`) fabricates a
`WebUserContext` with `authMode: "local"`, and `providerStoreForUser` hands
that context the repository store only.

The operator's mental model is "the token I entered on the page is used by the
runs I trigger". Today that holds for one trigger path out of three, and the
failure is reported as `runtime-unavailable` with no hint that the credential
exists one directory over.

## Decision

Every API token has an owner. A request authenticated by a token acts as that
owner: it resolves provider credentials the way the owner's browser session
would (owner store first, repository store as fallback), and audit records say
whose token it was. Ownerless tokens are refused, not tolerated.

## Design

### Token record

`StoredApiTokenRecord` and `ApiTokenRecord` (`src/web/api-tokens.ts`) gain
`ownerUserId: string`. `CreateApiTokenInput` gains `ownerUserId: string`
(required). `createApiToken` refuses an empty or whitespace owner.

Validation that the owner exists is the caller's job, because the two mint
paths know different things:

- **Device authorization exchange** (`src/web/server.ts`, the
  `createApiToken` call after `claimDeviceAuthorization`): the owner is
  `record.approvedByUserId`. A device record that reaches exchange without an
  approver is refused with `sendDeviceFlowError(response, 400,
  "access_denied")` and an audit event; it cannot mint an ownerless token.
- **`nitely mcp token create --repo <path> --owner <email-or-user-id>`**
  (`src/cli.ts`): `--owner` is required. The CLI resolves it against
  `<repo>/.nitely/users/users.json` — exact user id first, then
  case-insensitive email — and refuses when no user matches. `--owner` is
  resolved through a new exported
  `findUserByIdOrEmail(repoPath, value)` in `src/web/users.ts`; the CLI stores
  the id.
- An instance that has never created a user (`hasAnyUsers` is false, i.e.
  `--auth local` with no bootstrap admin) cannot satisfy `--owner`. The CLI
  says so and points at `web --auth required` / initial admin bootstrap. This
  is deliberate: the credential model this slice introduces is per-user, and a
  user-less instance has nothing to bind a token to.

`mcp token list` prints the owner column (`ownerUserId`). Existing stored
records without `ownerUserId` still parse (`readTokens` keeps them) so they can
be listed and revoked; the list marks them `unowned`.

### Request authorization

`prepareApiTokenRequest`:

1. After `authenticateApiToken` succeeds, if `token.ownerUserId` is missing,
   deny with `WebUnauthorizedError("API token has no owner; re-issue it with
   nitely mcp token create --owner <user>")`, `denialReasonCode:
   "token_unowned"`.
2. Otherwise load the owner with `getPublicUser(repoPath, ownerUserId)`. A
   missing owner (user record deleted since the token was minted) denies with
   `denialReasonCode: "owner_missing"`. User records have no disabled state
   today, so that is the only inactive case.
3. Build the request `user` from the real owner: `id`, `email`, `role`, and
   memberships from `getPublicUser`, `authMode` from the server's configured
   mode (`authModeForInput`), not the literal `"local"`. Organization context
   goes through the same `selectOrganizationContext` the session path uses,
   reading `x-nitely-organization-id` off the request so an owner with several
   memberships selects one from the CLI exactly as they do in the console. A
   header naming an organization the owner does not belong to denies with
   `denialReasonCode: "organization_denied"` rather than escaping as an
   unaudited throw, so the refusal lands in the token request audit like any
   other.

`role` comes from the owner record. This is a behavior change: today every
token acts as `role: "admin"`. Capability checks on the token still apply
first, so a token cannot do more than its capabilities allow; the owner's role
additionally bounds what those capabilities reach. Endpoints that check
`role === "admin"` (device approval, user management) are already outside the
token endpoint map, so no currently reachable endpoint changes behavior for an
admin-owned token. A token owned by a non-admin user acts as that user.

The audit record for a token request (`appendApiTokenRequestAudit`) gains
`onBehalfOf: { userId }`. The actor stays `api-token`.

### Credential resolution

No change to `providerStoreForUser`. Given a real owner context with the
server's real `authMode`, it already returns the owner store with the
repository store as fallback under `required` mode, and the repository store
under `local` mode. `task start` preflight (`server.ts:3785`), `draft-specs`,
run redaction, and the run itself therefore all read the same chain the
owner's browser session reads. That is the whole point of the slice: one
resolution path, selected by identity rather than by transport.

### Error surface

`runtime-unavailable` remediation (already names the repository file after
PR #550) additionally names the owner store path when the request has an
owner: "Credentials are read from `<repo>/.nitely/users/<id>/connections.json`
then `<repo>/.nitely/connections.json`."

### Migration

None automatic. Tokens minted before this change have no owner and are refused
at request time with `token_unowned`. Operators re-issue them. `mcp token
list` shows which ones need it. The device-flow login (`nitely auth login`)
mints owned tokens from the first deploy, so the common path needs no manual
step.

## Testing

- `test/web/api-tokens.test.ts`: `createApiToken` requires `ownerUserId`;
  stored record round-trips it; legacy record without owner still lists as
  `unowned`.
- `test/web/device-authorizations*.test.ts` / server device-flow tests: the
  exchanged token's `ownerUserId` equals the approving admin; an approved
  record with no `approvedByUserId` cannot exchange.
- `test/cli.test.ts`: `mcp token create` without `--owner` fails; unknown
  owner fails; email resolves to id; user-less instance fails with the
  bootstrap hint; `mcp token list` shows the owner column and `unowned`.
- `test/web/api-token-auth*.test.ts` or server tests: unowned token request →
  401 `token_unowned`; owner deleted → `owner_missing`; audit carries
  `onBehalfOf`.
- Cross-layer (the test #546 asked for): under `--auth required`, owner
  configures `anthropic` through `POST /api/providers/anthropic/connection` in a browser
  session; the same user's token then gets `PASS` from the task preflight and
  the run backend env contains `CLAUDE_CODE_OAUTH_TOKEN`; with the credential
  only in the repository store, the token request still resolves it (fallback);
  with the credential only in a *different* user's store, the token request
  does not see it.

Run `pnpm check` locally; the affected suites run on macOS except anything
that executes a real run (Run-owned file boundary), which runs on the Linux
dev box.

## Out of scope

- Instance-level ("system") credential store and its admin UI (slice B).
- Running stages in the OCI backend by default and wiring owner credentials
  into `NITELY_OCI_SECRET_ALLOWLIST` (slice C).
- Credential liveness checks in preflight.
- Token ownership transfer.
