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
