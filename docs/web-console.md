# Web Console

The local Web Console: what it shows, and how to start it. Remote CLI commands against that server are in [remote-operations.md](remote-operations.md).

Start the local console from a repository checkout:

```bash
nitely web --home . --host 127.0.0.1 --port 4173
```

The console centers on **Tasks** as the user-facing unit of work. `/tasks`
lists legacy `.nitely/tasks` records, generic `.nitely/work-items` records, and
historical runs that can be inferred as read-only tasks. `/tasks/<task-id>`
opens the canonical task detail view with metadata, input sources, local
specification and technical design content when available, associated sessions,
change request links, and typed artifact groups. Internally, generic
`.nitely/work-items` records remain the extensibility model for custom flows;
`/work-items` aliases back to `/tasks` in the Web Console for compatibility.
The **Plan work** form on `/tasks` creates draft tasks from a GitHub issue URL,
Jira ticket URL or key, an external document, or a rough prompt through the
Planner Agent workflow. On task detail, approve the draft spec, draft the
technical design, review persisted open questions, approve the technical
design, and then start the normal implementation run. Runs remain blocked until
both `specStatus` and `techDesignStatus` are `approved`. The Web Console, the
CLI, and `POST /api/draft-specs` share those transitions; see
[docs/planning-intake.md](planning-intake.md) for the intake contract,
source provenance, and drift behavior.

External document intake carries a document URL plus the snapshot text a
connector fetched, with an optional provider revision. Nitely stores the URL,
snapshot, and a content hash as the planning baseline; it never fetches the
document itself and never stores provider credentials. Re-submitting the same
document URL reuses its task and records drift when the snapshot changed.
GitHub issue intake uses configured Web Console GitHub provider credentials, or
`NITELY_GITHUB_TOKEN` / `GITHUB_TOKEN`, and falls back to unauthenticated fetching
for public issues.

## Visual tour

These screenshots show the main local-first workflow. They come from the current
Web Console and contain no credentials or production data.

| Tasks and planning | Task approval and preflight |
| --- | --- |
| ![Nitely Tasks and Planner Agent form](assets/screenshots/web-console-tasks.png) | ![Nitely task detail with approval and preflight state](assets/screenshots/web-console-task-detail.png) |

| Flow catalog | Provider setup |
| --- | --- |
| ![Nitely built-in and custom flows](assets/screenshots/web-console-flows.png) | ![Nitely provider configuration](assets/screenshots/web-console-providers.png) |

GitHub webhook activation is disabled by default. It accepts fresh, signed
`issues:labeled`, configured `issues:assigned`, configured issue mention, and
configured pull-request review-comment events for an explicitly mapped
repository, allowed sender, optional installation allowlist, and configured
triggers. It durably queues the delivery at `POST /api/github/webhooks`, returns
HTTP 202, and asynchronously creates either an approval-gated draft task or a
pending same-PR task rework request; it never starts a run.
Configure it without putting the webhook secret on the command line:

```bash
NITELY_GITHUB_WEBHOOK_SECRET='replace-with-the-hook-secret' \
NITELY_GITHUB_WEBHOOK_REPOSITORIES='acme/widgets=acme-widgets' \
NITELY_GITHUB_WEBHOOK_ACTORS='trusted-maintainer,nitely-bot' \
NITELY_GITHUB_WEBHOOK_INSTALLATIONS='123456' \
NITELY_GITHUB_WEBHOOK_LABELS='nitely' \
NITELY_GITHUB_WEBHOOK_ASSIGNEES='nitely-bot' \
NITELY_GITHUB_WEBHOOK_MENTIONS='@nitely' \
NITELY_GITHUB_WEBHOOK_FLOW='flows/implement-spec-bootstrap.json' \
NITELY_GITHUB_WEBHOOK_REWORK_FLOW='flows/rework-pr-bootstrap.json' \
nitely web --home . --host 127.0.0.1 --port 4173
```

The right-hand side of each mapping is the repository id shown on the Repos
page; the home checkout registers itself from its `origin` as
`<owner>-<repo>`.

To publish bounded GitHub App callbacks, add App credentials to the same Web
process environment:

```bash
NITELY_GITHUB_APP_ID='12345' \
NITELY_GITHUB_APP_PRIVATE_KEY_BASE64='base64-encoded-pem' \
NITELY_GITHUB_WEBHOOK_STATUS_BASE_URL='https://nitely.example' \
NITELY_GITHUB_WEBHOOK_CHECK_NAME='Nitely' \
nitely web --home . --host 127.0.0.1 --port 4173
```

The secret, repository mapping, actor allowlist, and Flow are required.
`NITELY_GITHUB_WEBHOOK_INSTALLATIONS` is optional; when omitted, only the
installation-id check is skipped. Repository and actor policy never becomes a
wildcard. Labels default to `nitely`. The HMAC secret is not written to disk.
Delivery ids, normalized provenance, immutable source snapshots, and queue state
are stored under `.nitely/github-webhooks/`; duplicate delivery ids cannot start
duplicate work. When the GitHub App publisher is configured, Nitely exchanges a
short-lived per-installation token scoped to the webhook repository and writes
one bounded issue/PR comment; PR review-comment rework deliveries also create or
update one GitHub Check Run on the PR head SHA. The callback does not include
issue body text, reviewer instructions, secrets, or raw provider errors.
Automatic run start remains outside this slice. Webhook delivery processing uses
a delivery-level lease so multiple Web processes sharing a state directory do not
process the same queued delivery concurrently; an expired lease can be reclaimed
after worker death.

Jira ticket intake accepts an Atlassian Cloud browse URL. Bare ticket keys and
self-hosted Jira URLs require an allow-listed `NITELY_JIRA_BASE_URL`. Configure
the token through the Web Console Jira provider or with `NITELY_JIRA_TOKEN` /
`JIRA_API_TOKEN`. Set `NITELY_JIRA_EMAIL` to use Jira Cloud Basic authentication
with `email:token`; without an email, Nitely sends the credential as a Bearer
token for OAuth/PAT deployments. Jira credentials stay in the customer-owned
provider store or process environment and are not copied into task snapshots.

Jira status sync is disabled by default. Selecting **Post current Nitely status
to Jira** during intake stores the current console origin as the link base and
posts a bounded Jira comment. The task detail **Sync to Jira** action publishes
later task/run/PR changes; identical projections are skipped. A failed comment
does not discard the local planning task and can be retried after fixing access.

After changing GitHub provider or draft-spec ingestion behavior, smoke the
configured dev Web path instead of relying only on shell credentials:

```bash
pnpm dev -- web --home ../nitely-runtime --port 4174 &
NITELY_SERVER_URL=http://127.0.0.1:4174 \
  pnpm dev -- smoke github-issue-intake \
  --issue https://github.com/<owner>/<repo>/issues/<number>
```

Configure the GitHub provider through the Web Console provider settings before
running the smoke when the issue requires repository access. If the provider is
not configured, the smoke exits successfully with a skip reason; if configured
credentials are missing access, it fails with the same actionable guidance as
`POST /api/draft-specs`. The command reports only issue/task/source metadata and
does not print token values.
Implementation changes to planning approval endpoints or
`src/work-items/planning.ts` should include deterministic negative transition
tests for the affected state-machine paths.
Session list and detail views include latest execution status, stage progress,
change request links, branch/worktree metadata, context manifests, context
usage, sanitized logs/evidence, review findings, and parent/child rework links
when available. Context manifests prefer safe fetched input metadata from run
snapshots over raw connector references, while timelines preserve known stage
types and lightweight resume/rework markers. `/runs` remains the
backward-compatible route for the Sessions view, and `/runs/<run-id>` opens a
first-class agent session detail page for completed, failed, running,
interrupted, and incomplete runs.

Operator summaries reject placeholder streams and numeric-only counters in
favor of state-first explanations. Active stage cards expose the declared
command or runtime/model, heartbeat-derived process activity, and declared
artifact readiness. `alive: true` means the attempt is open and has recent
persisted activity; it is not a durable OS PID claim. During long-running
command, agent, and review attempts, Nitely checkpoints a bounded
`recovery.patch` plus `recovery.json` relative to the attempt's starting commit.
Interrupted runs surface that run-relative recovery path, while published runs
group branch, head commit, and PR metadata.

By default the console runs in local compatibility mode on a loopback listener.
Requests use a synthetic `local` admin user, legacy tasks and runs without
`ownerId` remain visible, and provider writes continue to use
`.nitely/connections.json`. Nitely refuses local mode in production or on a
non-loopback bind.

For a shared console, require login:

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-with-a-unique-long-passphrase' \
nitely web --home . --host 127.0.0.1 --port 4173 --auth required
```

`NITELY_WEB_AUTH=required` is also supported. On first start, if
`.nitely/users/users.json` is empty and the admin environment variables are set,
Nitely creates the initial admin. Required mode stores users in
`.nitely/users/users.json`, sessions in `.nitely/users/sessions/`, and
Web-saved provider credentials in `.nitely/users/<user-id>/connections.json`.
Passwords are salted `scrypt` hashes. API responses include only public user
fields and provider status; secret values are never returned.
Initial creation is recorded as a metadata-only `auth.bootstrap` security event.
Bootstrap first persists a private recovery intent, then durably commits the
user, default organization, and fixed-ID audit event before marking that intent
complete. An interrupted start replays pending steps without requiring the
plaintext password again and without duplicating the administrator or audit
event. The completed marker retains identifiers only, not password verifier
data.
Production and non-loopback startup fail before listening if no administrator
exists. Bootstrap the first account in a one-time foreground start with explicit
credentials; do not put those credentials in a systemd unit.

New passwords must contain 15–128 Unicode code points and must not match the
built-in or optional `.nitely/users/password-blocklist.txt` deny list. Login
failures are account-keyed and throttled after five failures in 15 minutes by
default. Set `NITELY_WEB_SECURE_COOKIE=true` when the console is served through
HTTPS; leave it unset for plain loopback HTTP.

A non-loopback bind additionally requires an operator-declared TLS reverse-proxy
boundary and either secure cookies or an explicit insecure test-cookie escape
hatch for LAN HTTP dogfood:

```bash
NITELY_WEB_AUTH=required \
NITELY_WEB_TRUSTED_PROXY=true \
NITELY_WEB_SECURE_COOKIE=true \
nitely web --home . --host 0.0.0.0 --port 4173
```

For trusted-proxy production Web over plain LAN HTTP (for example
`http://0.0.0.0:4173`), set `NITELY_WEB_INSECURE_TEST_COOKIE=true` instead of
`NITELY_WEB_SECURE_COOKIE=true`. Prefer secure cookies behind HTTPS.

The proxy/firewall must prevent clients from bypassing that boundary. Nitely
does not terminate TLS in this slice. `GET /api/readiness` and the CLI startup
output report auth, administrator, bind, proxy, cookie, and production controls
without exposing credentials.

Tasks created through the authenticated Web Console include `ownerId`, and runs
started from those tasks inherit it. Organization members see records in their
organizations, with named owner/maintainer/member/viewer permissions; legacy
unowned data remains hidden from normal users. Global admins can inspect it.
Required-auth repository catalog entries are owned by the caller's current
workspace, and organization owners and maintainers can onboard them. The entry
registered from the home checkout's `origin` (the `home` entry) is visible to
every authenticated user; every other repository follows workspace/organization
ownership. Legacy stored catalog entries without an `organizationId` stay
admin-only until assigned.
Security decisions are written as metadata-only events to
`.nitely/security/audit.jsonl`. See
[docs/enterprise-identity-rbac-and-audit.md](enterprise-identity-rbac-and-audit.md)
for the permission matrix, password/session controls, audit schema, admin
session revocation, and future OIDC/SCIM boundary.

The local JSON API exposes:

- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/draft-specs`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/approve-spec`
- `POST /api/tasks/:taskId/draft-tech-design`
- `POST /api/tasks/:taskId/approve-tech-design`
- `POST /api/tasks/:taskId/runs`
- `GET /api/work-items` and `GET /api/work-items/:id` remain compatibility APIs
  for internal/extensible work item clients.
- `GET /api/scheduler`
- `POST /api/scheduler/run`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/resume` for blocked or interrupted runs
- `GET /api/providers`
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session`
- `DELETE /api/users/:userId/sessions` (global admin)
- `GET /api/security/audit` (global admin)

`POST /api/tasks` accepts optional `planningStatus: "draft" | "ready"`.
`ready` is the compatibility default; `draft` marks both supplied planning
artifacts as drafts so an external approval client can approve them before a
run.

### Web-only usage-limit recovery

Set `NITELY_WEB_SCHEDULER_INTERVAL_MS=60000` in the Web service environment to
opt into automatic recovery. The interval must be between 1 second and 24 hours;
absence disables the timer. Each cycle selects at most 20 due usage-limit runs
per repository, resumes them serially through the existing scheduler claims and
cooldown policy, and finishes before another cycle begins. It does not intake
new work. Servers running inside an OCI workload do not start this host timer.

Automatic recovery and the Console's **Resume run** button use the persisted
run owner's current provider and knowledge credentials and the server's selected
execution backend. Deleted owners and revoked organization permissions fail
closed. The button is available for writable blocked/interrupted runs; live or
completed runs cannot be resumed through this endpoint. The API accepts browser
sessions; the existing scheduler endpoint remains admin-session scoped.

### Run history and live updates

`GET /api/runs` returns the newest 50 visible summaries. Use `limit=1..100`
and the returned opaque `nextCursor` in `cursor` to page backwards; cursors
remain stable when newer runs arrive. The Sessions page loads older history
on demand. Task, flow and dashboard associations still use full history.

Live updates request summaries for the currently active ids with repeated
`runId` query parameters (up to 100 per request), including their terminal
transition. They do not reload historical pages or start during the initial
workspace load. Concurrent page and full-history requests share in-flight
summary reads; settled results are discarded so external writes remain visible.

Organization membership administration requires a browser session in required
authentication mode. Members can inspect their own organization's member list;
only an organization owner can manage members or invitations. Global admin status
does not grant access to another organization's membership metadata.

- `GET /api/organizations/:id/members` lists member ids and roles.
- `PATCH /api/organizations/:id/members/:userId` accepts `{ "role": "viewer" }`;
 `DELETE` removes the member. The last owner cannot be removed or demoted.
- `POST /api/organizations/:id/invitations` accepts `email`, `role`, and optional
 `expiresInSeconds` (1 second to 30 days, default 7 days). It returns an opaque
 token once. The caller delivers it to the recipient; Nitely does not send mail.
- `GET /api/organizations/:id/invitations` lists metadata without token hashes.
- `POST /api/organizations/:id/invitations/:invitationId/accept` or `/decline`
 accepts `{ "token": "..." }` from the authenticated recipient. An invitation
 cannot change an existing member's role. Owners can `POST .../revoke`.

Membership writes and invitation consumption share the local cross-process
storage lease and atomic organization-file replacement. Tokens are hashed at
rest, expire at the saved deadline, and cannot be consumed twice. Invalid,
expired, revoked, wrong-recipient, and wrong-organization invitations return the
same not-found response. The existing metadata-only security audit records API
actions without invitation tokens or email addresses; it remains a local audit,
not a compliance delivery guarantee.

OIDC sign-in is available in required authentication mode. An organization owner
can `PUT /api/organizations/:id/sso/oidc` with `issuer`, `clientId`,
`redirectUri`, optional `clientSecretRef`, and optional
`jit: { enabled: false, domains: [] }`. The same endpoint supports owner-only
`GET`. JIT provisioning defaults to disabled; enabling it requires explicit
email domains and a verified IdP email. Existing email matches always require
explicit linking, and new users receive the member role.

The operator must set `NITELY_OIDC_ALLOWED_HOSTS` (comma-separated HTTPS IdP
hosts, including token/JWKS hosts) and `NITELY_OIDC_REDIRECT_ORIGINS`
(comma-separated HTTPS console origins). Discovery and token/JWKS requests
cannot follow redirects or leave those approved hosts. The redirect URI must
point to `/api/organizations/:id/sso/oidc/callback`. A secret reference resolves
only to `NITELY_OIDC_SECRET_<sha256-of-organization-id>_<reference>` in the
server's authentication environment; configuration and API responses contain
the reference, never the secret. References use uppercase letters, digits and
underscores. Public clients can omit the reference.

Open `/api/organizations/:id/sso/oidc/login` in a browser to start sign-in.
Linking a local account requires a browser session and
`POST /api/organizations/:id/sso/oidc/link` with the account's password for
reauthentication. The browser follows the returned authorization redirect;
the callback establishes a new secure session and returns browsers to the Console. PKCE S256, a browser-bound
single-use state, nonce, issuer, audience, expiry and ID-token signatures are
validated using [openid-client](https://github.com/panva/openid-client).
Pending attempts expire after ten minutes and are bounded to 256 per organization.

Issuer/subject identities are persisted separately from email. Email changes
at the IdP do not change account identity, and an existing identity cannot be
rebound to another local user. Sign-in still requires current organization
membership; JIT never restores a removed member. Local password sign-in remains
available. Configuration changes invalidate pending sign-ins. Login, failure,
linking and configuration actions use the existing metadata-only local audit;
ID/access tokens, authorization codes and client secrets are not recorded.

Organization session policy is read with
`GET /api/organizations/:id/security-policy` and replaced by an organization
owner with `PUT` on that path. The complete version 1 record contains
`maxSessionLifetimeSeconds` (1–2592000), `idleTimeoutSeconds` (1–604800 or
`null`), and `ssoRequired` (boolean). Defaults are seven days, no idle timeout,
and optional SSO. The existing seven-day cookie lifetime remains an upper bound.
Unknown fields and invalid limits are rejected.

Policy is checked server-side on every authenticated request. Idle activity is
refreshed across the browser session’s currently permitted organizations; an
idle-expired organization cannot be revived by activity in another. Inspecting a
session for audit does not refresh it. An SSO-required organization accepts only
an OIDC session issued for that organization. Switching the current workspace
cannot reveal its tasks, runs, flows, repositories, notifications, or shared
credentials through another organization. Required-auth policy endpoints enforce
current owner membership; local mode keeps its existing defaults.

Owners can `POST /api/organizations/:id/security-policy/revoke-sessions` with
`{}` to revoke every existing session for that organization, or `{"userId":"…"}`
to revoke one current member's sessions there. Other organizations remain usable.
A fresh sign-in is required; removing and re-adding a member cannot restore an
old session. These browser controls do not revoke separately issued machine API
tokens. A browser session denied in any organization cannot approve a new
instance-wide device token.

For SSO policy recovery, the operator can enable `NITELY_WEB_BREAK_GLASS=true`.
A global administrator must also send `x-nitely-break-glass: true` to the policy
endpoint. This exception applies only to the requested organization's policy
endpoint and requires a successful audit write before access. It cannot bypass
expiry, idle timeout, or revocation. Policy reads, changes, revocations, and
recovery access produce security audit events. Disable the operator switch after
recovery.

Organization provider connections use the same connection/auth-method/secret-ref
model as personal connections. Organization owners create them with
`POST /api/organizations/:org/providers/:provider/connections` (`value`, optional
`authMethod`, `label`, `makeDefault`, and `repositoryId`). Owners alone manage
shared connections; members and maintainers can use them. Instance admin status
alone does not grant access to another organization's secrets.

Members with shared-use permission can list connection metadata with
`GET /api/organizations/:org/providers` or append `/:provider/connections`.
Secret values and secret references are omitted. Owners can `PATCH` a connection
with `repositoryId` (or `null` to unbind) and `label`; a binding must identify a
registered repository in that organization. Append `/rotate`, `/revoke`, or
`/default` to a connection path and `POST` to rotate its value, revoke it, or
change its default; `DELETE` the connection path to remove it. Rotation keeps the
connection id. Revocation removes its secret material and leaves metadata.

Task and work-item run requests can supply `providerConnections`, a provider-to-
connection-id map. Selection order is explicit run binding, repository-bound
organization connection, organization connection, personal connection, then
repository-local/environment fallback. Only one selected connection per provider
is projected in organization contexts; the descriptor's auth-method order breaks
method ties. Invalid, foreign, conflicting, or revoked explicit bindings fail
closed. Switching workspaces does not change the task's organization/repository
context. Saved run bindings also apply when a run resumes.

Connection mutations and use record actor, connection id, scope, and auth method
without secret material. Reproducibility manifests retain the selected connection
id and auth method. Later rotation/revocation leaves old run evidence untouched.
Per-file leases serialize shared mutations and OAuth refreshes.

### Organization audit

Authenticated organization owners and maintainers have
`organizations:audit:view`; maintainers serve as organization auditors. Global
administrator status alone does not grant access to another organization's audit.
`GET /api/organizations/:id/audit` returns newest events first with stable
`eventId` and `createdAt`, and an optional `nextCursor`. Pass that cursor to
retrieve older records. Filters are `from`/`until` (UTC ISO timestamps), `action`,
`actorId`, `source`, `repositoryId`, `taskId`, `runId`, `providerId`, and `result`
(`success` or `error`). Limits are 1–500, default 100. New events do not shift an
existing cursor; a cursor removed by retention returns 404. Individual events use
`GET .../audit/events/:eventId` with the same organization boundary.

The first export format is JSONL: `GET .../audit/export?format=jsonl` accepts the
same filters and limits. Each response is bounded to one page; continue with the
`x-nitely-next-cursor` response header. Export keeps original ids/timestamps and
records `audit.export` before releasing the response. Query and export scan the
local file with bounded retained rows, rather than loading the entire log.

`GET .../audit/retention` returns `{version:1,retentionDays:null}` until configured.
Only organization owners can `PUT` that policy (`null` means retain indefinitely;
integer days range from 1 to 3650). Changing policy does not delete records.
`POST .../audit/prune` explicitly deletes only that organization's events strictly
older than the configured cutoff, returning `deleted` and `cutoff`. Policy changes
and prune requests are audited before mutation. Prune and all appends share a file
lease and pruning uses a synced atomic replacement; other organizations' event
metadata is preserved. Queries continue to include expired records until pruning.

Audit records contain allowlisted metadata, source and organization attribution,
request ids, and session hashes, without session cookies, credentials or run log
payloads. Runtime execution and shared-provider use include resource identifiers
when available. Legacy actor-attributed events remain queryable; unattributed
legacy/local events remain available only through the operator's global audit API.

Local JSONL is owner-only application-managed storage, not a tamper-proof ledger:
file owners can edit it, there is no external signature chain, and retention
intentionally rewrites it. Hosted deployments requiring immutable retention or
multi-host writers must send audit metadata to an access-controlled external
append-only store; the local file lease coordinates processes on one host only.

### Organization SAML SSO

SAML uses the same organization membership, explicit account linking, session
revocation and SSO-required policy as OIDC. Enterprise identities distinguish
protocol plus immutable issuer/subject; SAML identities also bind the organization
because each organization pins its own IdP certificates. Email never automatically
links accounts.
SAML requires persistent NameIDs. JIT is off by default; when enabled, the signed
IdP email attribute must match an explicitly allowed domain. Configure an IdP that
attests that attribute as the user's verified email.

Organization owners can `GET`/`PUT /api/organizations/:id/sso/saml` with `version:1`,
`idpIssuer`, `entryPoint`, `certificates` (one to three public PEM RSA certificates),
`entityId`, `acsUrl`, optional `emailAttribute` (default `email`), and
`jit:{enabled,domains}`. Alternatively, provide manually trusted `metadataXml`
instead of issuer/entry point/certificates; metadata is parsed locally, not fetched.
Operator settings `NITELY_SAML_ALLOWED_HOSTS` and `NITELY_SAML_REDIRECT_ORIGINS`
allowlist HTTPS IdP hosts and browser origins. ACS must be the exact organization's
`.../sso/saml/acs` endpoint. SP metadata is public at `GET .../sso/saml/metadata`.

`GET .../sso/saml/login` starts SP-initiated login. `POST .../sso/saml/link` requires
the existing session and password reauthentication. The IdP posts URL-encoded
`SAMLResponse` and `RelayState` to ACS. Browser state uses an organization-scoped
HttpOnly `SameSite=None; Secure` cookie because ACS is a cross-site POST; TLS is
required. Linking rechecks the originally verified session even when its Lax
session cookie is absent from the IdP POST. State is browser-bound, single-use,
expires after ten minutes, and is invalidated by configuration changes.

Both response and assertion signatures are required, using SHA-256/SHA-512 with
RSA keys of at least 2048 bits. Issuer, audience, destination, recipient, request
correlation, status and finite time bounds are checked; assertion age is capped at
five minutes with 30 seconds of clock skew. Unsolicited IdP-initiated responses,
DTD/entities and encrypted assertions are rejected. Raw XML/assertions are absent
from responses and audit records. A successful browser ACS redirects to `/`.

Certificate rotation uses an explicit overlap: configure old and new valid
certificates, start new requests, then remove the retired certificate. Validation
continues throughout overlap; expired/not-yet-valid certificates cannot verify a
login. Changing configuration invalidates pending requests, which must restart.

### Executable Python Skills

The MCP `execute_skill` tool calls `POST /api/skills/execute` with `runs:start`
authorization and current repository/organization access. The request contains
`repoId`, `skillId`, `entrypoint` (a manifest entrypoint name), optional
`inputs` (relative UTF-8 filenames to content), `outputs` (declared relative
filenames), and `timeoutMs` (100–60,000; default 10,000). Example:

```json
{"repoId":"home","skillId":"summarize","entrypoint":"main","inputs":{"source.txt":"Example text"},"outputs":["summary.txt"]}
```

Packages live in `.nitely/skills/<skillId>` and retain the required `SKILL.md`.
Code and declared inputs are copied using Linux descriptor-relative, no-symlink
reads into a private temporary parent. Only that staged workspace is mounted,
read-only; outputs and scratch storage use separate 32 MiB container tmpfs.
Python reads inputs at `/workspace/inputs` (`NITELY_INPUT_DIR`) and writes declared
outputs under `NITELY_OUTPUT_DIR`. Execution uses Python isolated mode, UID/GID
1000, no capabilities, no Docker socket, no forwarded provider credentials and
no network. The operator must preload a Python 3 image as `NITELY_OCI_IMAGE` and
configure a rootless Docker engine with cgroup v2. The runner command image now
includes Python; no package installation occurs during Skill execution.

Limits are one CPU, 256 MiB memory, 64 processes, 4 MiB per file, 1 MiB combined
stdout/stderr, 16 input/output files and 8 MiB total output artifacts. There is
one active execution per repository. Container startup/capture has five seconds
of additional deadline allowance. The result reports duration, exit code,
bounded logs, structured failure and artifact paths/hashes/sizes. Memory/process
limit failures retain their process exit status; sandbox cleanup failures are
reported explicitly. Exit status zero alone does not accept invalid outputs.

After container removal, declared outputs and `execution.json` are archived at
`.nitely/skill-executions/<executionId>`; evidence includes the package hash,
immutable image identity, resource policy and input hashes rather than input
contents. Temporary host files are removed on success, error and timeout.
A host/controller crash still requires the existing OCI expiry reaper and
operator temporary-directory cleanup. This slice supports Python's standard
library only. For real-container verification, run
`NITELY_OCI_IMAGE=<local-python-image> pnpm exec tsx scripts/verify-python-skills.mts`
on the rootless Linux host; it checks output capture, host/network denial,
timeout, output bounds, symlink rejection, restrictive permissions and memory
limits, including temporary-directory cleanup after each outcome.

#### Execution manifest v1

`skill.yaml` declares requested executable authority; `SKILL.md` supplies instructions only.
Without a manifest a package remains instruction-only. A complete example is:

```yaml
apiVersion: nitely.dev/skill/v1
name: summarize
version: 1.0.0
runtime:
  language: python
  major: 3
entrypoints:
  main: main.py
resources:
  cpus: 1
  memoryBytes: 268435456
  pids: 64
  tmpfsBytes: 33554432
  maxFileBytes: 4194304
  maxCapturedOutputBytes: 1048576
  timeoutMs: 10000
filesystem:
  package: read-only
  inputs: [source.txt]
  outputs: [summary.txt]
network:
  mode: none
dependencies:
  mode: none
secrets: []
```

All fields are required. Unknown fields, YAML aliases/tags, duplicate keys,
unsupported versions/languages and path traversal fail closed with field errors.
The manifest name must match the package id and every requested entrypoint must
exist in the bounded package snapshot. For compatibility, a raw `.py` path is
accepted only if a named entrypoint declares that exact path. Requested input
and output paths must be subsets of the manifest declarations; instructions
cannot expand either set. The manifest and resolved entrypoint enter execution
evidence alongside the package content hash.

Resource values can reduce operator ceilings: CPU 0.1–1, memory 32–256 MiB,
processes 8–64, tmpfs 1–32 MiB, individual files 1 KiB–4 MiB, combined captured
logs 1 KiB–1 MiB, and execution timeout 100–60,000 ms. The shorter request/manifest
timeout wins. The OCI transport separately permits up to 20 MiB of encoded
result/artifact data and five seconds for startup/capture.

The schema also recognizes `network: {mode: allowlist, domains: [...]}`, scoped
secret declarations (`name: NITELY_SKILL_SECRET_<NAME>`, `scope: skill`,
`reference: <credential-id>`), and locked dependency descriptors (`mode: locked`,
`lockFile`, SHA256 `sha256`, `installHooks: false`). This runtime rejects these
requests before provisioning because it has no approved network, secret or
dependency-install capability. A declaration is a request for authority, never
an approval; raw credentials and install commands are not manifest fields.

#### Sandbox provider contract

The controller stages and validates a bounded, read-only snapshot and retains
ownership of host temporary-directory cleanup. `SkillSandboxProvider.execute`
bundles provision, snapshot staging, execution, bounded artifact transport and
workload cleanup as one atomic lifecycle: it must settle only after the workload
and all its descendants are removed. There is no public partially provisioned
sandbox handle that a tool call could leave behind. The reference adapter reuses
the existing OCI backend rather than maintaining separate Docker launch logic.

Provider selection checks the complete capability set on one provider, regardless
of its name. Required guarantees include Python 3, non-root identity, read-only
staging, CPU/memory/process/tmpfs/file/output/deadline bounds, bounded artifact
collection, blocking cleanup, workload expiry, and the requested network policy.
Scoped secrets, locked dependencies and snapshots are separate capabilities;
the OCI reference advertises neither secret/dependency installation nor snapshots.
Missing guarantees fail closed before package code executes. The reference also
probes Python 3 in its pinned image before executing the Skill. Runtime evidence
records the selected provider and capabilities, including sandbox policy on
bounded-output and cleanup failures. Third-party provider adapters are operator
code and must verify their own runtime and enforcement before advertising them;
agent requests and manifest provider names cannot select or upgrade a backend.

#### Package approval

Every executable package starts untrusted, including local imports. The MCP
`inspect_skill` tool (`runs:read`) returns its SHA256 identity, version, manifest
and current approval status. An agent cannot approve a package. An organization
owner must use a browser session and reauthenticate with their password:

```text
POST /api/skills/approve
{"repoId":"home","skillId":"summarize","contentHash":"<inspected SHA256>","password":"<owner password>"}

POST /api/skills/revoke-approval
{"repoId":"home","skillId":"summarize","password":"<owner password>"}
```

API tokens cannot call either approval endpoint, even with an owner cookie.
Approval records are controller-owned files outside the package and bind the
reviewed content hash to the current organization and repository. Execution
checks the hash of the same bounded snapshot that will run. Any changed code,
resource or manifest needs fresh approval; clients may also pin
`expectedContentHash` in `execute_skill`. Revocation blocks future admissions;
it does not interrupt an already admitted execution. Owner approval cannot
enable network access, secrets or dependency installation in this runtime.

Imports use bounded, descriptor-relative snapshots and verify the copied hash
before replacing an existing package. Symlinks, hardlinks and oversized files
are rejected; a failed replacement preserves the previous package. Importing
instructions remains supported without execution approval. No package-provided
install hooks run. Execution evidence includes version/hash, approval identity,
provider and granted authority. Denied attempts record a reason and no granted
authority. Organization audit records approval, revocation and execution
outcomes without passwords, API tokens or input contents.
