# Enterprise Identity, RBAC, And Security Audit

Nitely's current identity boundary is local to one checkout. Required-auth mode
provides file-backed users, sessions, organization memberships, a named
permission evaluator, and a metadata-only security audit. Federated identity
and automated provisioning are future adapters over these local primitives;
they are not implemented OIDC or SCIM endpoints today.

## Enable Required Authentication

Bootstrap the first global administrator on an empty user store:

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-with-a-unique-long-passphrase' \
NITELY_WEB_AUTH=required \
nitely web --home . --host 127.0.0.1 --port 4173
```

The equivalent CLI flag is `--auth required`. After the first user exists, the
bootstrap variables do not replace that user or reset its password.

Required-auth state is stored below `.nitely/users/`. Passwords are salted
`scrypt` verifiers and sessions are random, server-side records with a seven-day
expiry. Existing verifiers remain valid when Nitely is upgraded.

## Permission Model

Global `admin` users and the synthetic administrator in local compatibility
mode can perform every operation. A normal required-auth user is evaluated
against the role in the organization that owns the resource. Cross-organization
lookups remain hidden with `404`; authorization denials are recorded internally.

| Capability | Owner | Maintainer | Member | Viewer |
| --- | --- | --- | --- | --- |
| View tasks, runs, and evidence | yes | yes | yes | yes |
| Create/edit tasks and work items | yes | yes | yes | no |
| Approve planning artifacts | yes | yes | yes | no |
| Start runs and submit run review input | yes | yes | yes | no |
| Create/edit/delete local user flows | yes | yes | yes | no |
| Write personal provider credentials | yes | yes | yes | no |
| Resolve a visible inbox notification | yes | yes | yes | no |
| Manage reviewer assignments | yes | yes | no | no |
| Export evidence metadata | yes | yes | no | no |
| Write shared organization credentials | yes | no | no | no |
| Onboard repositories for the current workspace | yes | yes | no | no |

Scheduler execution, skill import, context-knowledge mutation, session
revocation, and security-audit inspection are global-admin operations. A global
admin may also write shared credentials. Organization owners and maintainers
onboard repositories for **their** workspace; members and viewers can list and
select visible repositories when creating tasks but cannot add catalog entries.

Required-auth catalog entries persist the current writable organization.
The entry registered from the home checkout's `origin` (the `home` entry) is
visible to every authenticated user; every other repository follows
workspace/organization ownership. Legacy stored catalog entries without an
`organizationId` stay hidden from normal users (local mode and global admins can
still see them) until they are assigned to a workspace.

The source of truth is the pure evaluator in `src/web/access-control.ts`.
Resource visibility is checked separately from mutation permission. Legacy
records without an organization remain scoped to their owner, except for local
mode and global admins.

## Local Password And Login Controls

New users and the bootstrap administrator must use passwords from 15 through
128 Unicode code points. Spaces and Unicode are accepted; Nitely does not
require character-class composition or periodic password changes. A small
built-in common-password list is denied. Operators can add exact, case-sensitive
entries to `.nitely/users/password-blocklist.txt`, one value per line; empty
lines and lines beginning with `#` are ignored.

Login failures return the same public error for known and unknown users. The
unknown-user path performs a dummy `scrypt` derivation. By default, five failed
attempts for one normalized account in 15 minutes cause later attempts to
return `429` and `Retry-After`. The limiter is bounded, in memory, and resets on
process restart; it is not a durable account lockout.

Session cookies use `HttpOnly`, `SameSite=Lax`, path `/`, and a bounded
`Max-Age`. Set `NITELY_WEB_SECURE_COOKIE=true` behind an HTTPS reverse proxy to
also emit `Secure`. Do not set it for a browser connecting over plain HTTP.
Trusted reverse-proxy mode normally requires secure cookies; for LAN HTTP
dogfood only, set `NITELY_WEB_INSECURE_TEST_COOKIE=true` as an explicit escape
hatch when `NITELY_WEB_SECURE_COOKIE` is off.

A global admin can invalidate every current session for a user:

```text
DELETE /api/users/:userId/sessions
```

If the target is the caller, the response also clears that browser's cookie.

The local password policy follows the length-first direction in
[NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html). Deployment
choices should also follow the
[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
and
[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
guidance.

## Security Audit

Security decisions are appended to `.nitely/security/audit.jsonl`. Nitely
creates the directory with mode `0700` and the file with mode `0600`. Retention
is local and indefinite until an operator archives or removes it.

Each versioned JSONL event contains bounded metadata:

- event id, timestamp, action, requested permission, decision, outcome, HTTP
  status, and reason code;
- actor type (`local`, `user`, `api-token`, or `anonymous`), stable actor id and
  applicable roles;
- a validated resource type and id when it is safe to derive from the URL;
- for failed login, a one-way normalized-email fingerprint instead of the
  submitted address.

The audit contract does not accept cookies, session ids, authorization headers,
raw API tokens, passwords, provider secrets, request/response bodies, prompts,
specifications, designs, logs, or evidence contents. URL identifiers that fail
the bounded metadata grammar, or equal the current bearer credential, are
omitted. Writes are best effort: an audit-storage failure emits a generic
server diagnostic but does not expose request data.

Local mode and global admins can inspect a bounded newest-first view:

```text
GET /api/security/audit?limit=100&action=runs.start&decision=deny&actorId=usr_...
```

`limit` is capped at 500. This file is useful operational evidence, but it is
not tamper-evident storage or a certified compliance ledger.

## Future OIDC And SCIM Adapter Boundary

An enterprise identity adapter must construct the same internal principal used
by the local permission evaluator. It must not bypass that evaluator or grant a
global role from an untrusted email or arbitrary claim.

The intended browser path is OpenID Connect Authorization Code with provider
discovery, an issuer allow-list, exact redirect URIs, TLS, `state`, `nonce`, and
PKCE S256. Nitely must validate issuer, audience, signature, time claims, nonce,
and token-exchange response, then key the internal identity by `(issuer,
subject)`. See
[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0-18.html),
[OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html), and
[OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html).

The intended provisioning path follows SCIM 2.0
[schemas](https://www.rfc-editor.org/rfc/rfc7643.html) and
[protocol](https://www.rfc-editor.org/rfc/rfc7644.html). Stable SCIM ids and
`externalId` map to local users; group-role mapping is explicit configuration;
and `active=false` must immediately revoke all local sessions. Provisioning
uses a separate scoped credential, never a browser session.

OIDC endpoints, IdP configuration, JIT provisioning, MFA policy, SCIM
endpoints, hosted organization administration, and cross-instance audit export
remain outside the current local implementation.

## Operational Checklist

- Serve required-auth mode through HTTPS before exposing it beyond a trusted
  loopback or private network, and enable secure cookies.
- Keep `.nitely` readable only by the service account and include its identity,
  session, credential, and audit files in the deployment's backup/retention
  policy.
- Use organization roles rather than sharing global-admin accounts.
- Review denied actions and repeated login failures without attempting to
  reverse the login subject fingerprint.
- Revoke a user's sessions when access or organization membership changes.
- Treat OIDC/SCIM support as absent until a reviewed adapter implements the
  validation and lifecycle requirements above.
