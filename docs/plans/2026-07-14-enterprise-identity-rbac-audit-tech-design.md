# Enterprise Identity, RBAC, And Audit Tech Design

## Goal

Close the current gap between Nitely's repo-local users, sessions, and
organization memberships and a credible enterprise identity boundary. The
implementation in this issue remains local and inspectable: it centralizes the
permission model, records metadata-only security decisions, and hardens local
password sessions. It does not add a hosted identity service, OIDC provider, or
SCIM endpoint.

## Current State

Nitely already has useful foundations:

- required Web auth with salted `scrypt` password verifiers and seven-day
  file-backed sessions;
- global `admin` and `user` roles;
- organization roles `owner`, `maintainer`, `member`, and `viewer`;
- organization-scoped visibility for tasks, work items, flows, and runs;
- viewer read-only enforcement, organization owner/maintainer repository
  onboarding, and admin-only scheduler/skill/knowledge actions;
- provider and API-token-specific audit files.

The remaining gaps are structural:

- authorization is expressed through scattered `admin` and generic `canWrite`
  checks instead of named permissions;
- there is no single test-backed matrix for the operations listed in #277;
- browser login, logout, sensitive mutations, and authorization denials do not
  produce a common security audit trail;
- new local passwords have no minimum-length policy, unknown-user verification
  does less work than known-user verification, and failed logins are not
  throttled;
- an administrator cannot invalidate all sessions for a user;
- secure cookies are not configurable for an HTTPS reverse-proxy deployment;
- the OIDC and SCIM integration seam is undocumented.

## Permission Model

Add `src/web/access-control.ts` as the source of truth for named permissions.
The pure evaluator takes auth mode, global role, organization role, and the
requested permission. Local compatibility mode and a global admin retain their
current bootstrap behavior. A normal user receives permissions from the role in
the selected or resource organization.

The matrix preserves current task/run/flow compatibility while separating
operations that were previously hidden inside generic write checks:

| Permission | Owner | Maintainer | Member | Viewer | Global admin only |
| --- | --- | --- | --- | --- | --- |
| view tasks, runs, and evidence | yes | yes | yes | yes | no |
| create/edit tasks and work items | yes | yes | yes | no | no |
| approve planning artifacts | yes | yes | yes | no | no |
| start runs and submit run review input | yes | yes | yes | no | no |
| create/edit/delete local user flows | yes | yes | yes | no | no |
| write a personal provider credential | yes | yes | yes | no | no |
| resolve a visible inbox notification | yes | yes | yes | no | no |
| manage reviewer assignments | yes | yes | no | no | no |
| export evidence metadata | yes | yes | no | no | no |
| write shared organization credentials | yes | no | no | no | alternatively global admin |
| onboard repositories for the current organization | yes | yes | no | no | alternatively global admin |
| run the all-repository scheduler | no | no | no | no | yes |
| import skills | no | no | no | no | yes |
| revoke another user's sessions | no | no | no | no | yes |
| read the security audit | no | no | no | no | yes |

Existing record visibility remains fail-closed:

- organization records require membership in that organization;
- legacy records without an organization remain visible/writable only to their
  owner, local mode, or a global admin;
- required-auth repository catalog entries are workspace-owned; the instance
  `default` repository remains the Web `--repo` home checkout; legacy unowned
  stored catalog entries are admin-only until assigned;
- unauthorized resource lookup keeps returning the same public `404` where it
  currently hides cross-team existence, while the internal audit records a
  denied decision.

Server authorization helpers will accept a named permission and delegate to the
pure evaluator. Flow editability and provider credential writes will use the
same evaluator. This makes tests assert the policy rather than reproduce role
conditionals.

## Security Audit

Add a local append-only JSONL audit at:

```text
.nitely/security/audit.jsonl
```

The directory and file are owner-only (`0700`/`0600`). Each versioned event
contains only bounded metadata:

- event id and timestamp;
- action and required permission;
- allow/deny decision, success/error outcome, HTTP status, and stable reason
  code;
- actor type (`local`, `user`, `api-token`, or `anonymous`), stable actor id,
  global role, and selected organization role when known;
- a validated resource kind/id derived from the URL when available;
- for failed password login, a one-way SHA-256 subject fingerprint rather than
  the submitted email.

The audit must never record cookies, session ids, authorization headers, API
token values, passwords, provider secrets, request/response bodies, prompts,
specifications, designs, logs, or evidence contents. Login, logout, session
revocation, repository onboarding, scheduler execution, task/work-item
mutation, planning approval, run start/review, flow mutation, provider
credential mutation, evidence access, audit access, and corresponding denials
are mapped to stable actions.

`GET /api/security/audit` provides bounded metadata-only inspection to local
mode or a global admin. It supports a small limit plus action/decision/actor
filters. Audit writes are best-effort after the response and emit a stderr
diagnostic on storage failure; this local log is operational evidence, not a
tamper-evident compliance ledger. A future team control plane can stream the
same event contract into durable storage.

## Local Authentication Hardening

### Password Policy

New local passwords use a length-first policy aligned with the current NIST
single-factor guidance:

- minimum 15 Unicode code points;
- maximum 128 code points, while permitting spaces, printing characters, and
  Unicode;
- no character-class composition rules and no periodic expiry;
- reject a small built-in set of common values and any additional exact values
  in an optional local `.nitely/users/password-blocklist.txt` file.

Existing verifiers remain readable and are not silently invalidated. The policy
applies when bootstrapping or creating a new user.

Unknown users execute a dummy `scrypt` verification so the success/failure path
does not expose the most obvious account-existence timing difference. Public
errors remain generic.

### Failed Login Throttling

Use a per-process, account-keyed fixed-window limiter with a one-way normalized
email key. The default permits five failed attempts in 15 minutes; later
attempts return `429` with `Retry-After`. Successful authentication clears the
counter. The limiter is deliberately bounded and injectable for deterministic
tests. It slows local brute force without creating a persistent lockout that an
attacker could use as a long-lived denial of service.

### Sessions And Cookies

- keep random 256-bit session ids and server-side seven-day expiry;
- add an admin-only `DELETE /api/users/:userId/sessions` endpoint that removes
  every active session for the target user;
- continue invalidating an individual session on logout and expired-session
  read;
- retain `HttpOnly`, `SameSite=Lax`, path `/`, and bounded `Max-Age`;
- add `NITELY_WEB_SECURE_COOKIE=true` so HTTPS/reverse-proxy deployments can
  emit the `Secure` flag without breaking the documented loopback HTTP default.

Session ids are never written to the security audit.

## Enterprise Identity Boundary

The future enterprise layer plugs in before `WebUserContext` construction and
must return the same internal principal and permission-evaluation inputs. It
does not replace the local evaluator.

### OIDC

The supported future browser flow is OpenID Connect Authorization Code:

- provider discovery and issuer allow-listing;
- TLS, exact pre-registered redirect URI, `state`, `nonce`, and PKCE S256;
- validation of issuer, audience, signature, time claims, nonce, and code
  exchange response;
- internal identity key `(issuer, subject)`, never mutable email alone;
- explicit organization and role mapping with no automatic global-admin grant;
- a new Nitely server-side session after successful authentication;
- no provider access/refresh-token persistence unless a separately reviewed
  connector needs it.

### SCIM

Future provisioning follows SCIM 2.0 Users and Groups:

- stable SCIM resource ids plus `externalId` mapping;
- `active=false` immediately invalidates local sessions;
- group-to-organization-role mapping is configuration, not an arbitrary claim;
- idempotent create/update/delete semantics and metadata-only provisioning
  audit;
- a separately scoped provisioning credential, never a browser session.

The hosted/team adapter, IdP configuration UI, SCIM endpoints, JIT provisioning,
MFA policy, and compliance export remain out of scope for this issue. The local
permission evaluator and local security evidence remain OSS trust primitives;
federated identity, org administration, centralized policy, and cross-instance
audit remain team/commercial capabilities.

## Validation

- pure permission-matrix tests for every global and organization role;
- user-store tests for 15-code-point policy, Unicode/space acceptance,
  blocklists, constant-work unknown users, and bulk session invalidation;
- audit-store tests for permissions, filters, bounded metadata, and file modes;
- Web tests for successful/failed/throttled login, secure cookie configuration,
  login/logout/session-revoke audit, viewer denial, member run approval, admin
  actions, provider writes, audit read authorization, and secret omission;
- existing team visibility, flow, provider, API-token, and run-flow suites;
- full build, typecheck, production dependency audit, and deployment smoke.

## Rollout And Rollback

All new state is additive. Existing `users.json`, organizations, sessions, API
tokens, and provider audit remain valid. The new password policy affects only
new users. `NITELY_WEB_SECURE_COOKIE` is opt-in so current loopback deployments
continue to work. Rolling back leaves an ignored metadata-only JSONL file and
does not require a state migration.
