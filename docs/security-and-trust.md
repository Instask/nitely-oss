# Security and Trust Model

Status: current implementation plus intended future boundary.

Nitely is designed around a local-first trust model:

> Code, secrets, and agent execution remain in the customer's environment unless
> explicitly configured otherwise.

The current implementation has no hosted Nitely control plane. Runs execute in
the local repository environment, write local `.nitely` state, and use local
agent CLIs and locally configured provider credentials.

### Execution Backend Trust Modes

Trusted single-user Web/CLI use defaults to host-local execution. A Web server
running with `--auth required` defaults to the OCI backend and records the
selected backend and selection reason in `/api/readiness`. OCI preflight errors
block the run; they never fall back to host-local execution.

An administrator may explicitly accept the weaker boundary for a required-auth
instance by setting `NITELY_ALLOW_UNSAFE_LOCAL_EXECUTION=true` together with
`NITELY_EXECUTION_BACKEND=local` (or `mise`). The readiness response marks that
choice as an unsafe override. The OCI image and engine still need to be
configured separately with `NITELY_OCI_IMAGE` and the documented OCI settings.

## Current Implementation

### Where Source Code Lives

Source code remains in the repository path supplied to Nitely. For each run,
Nitely creates an isolated Git worktree from that repository. It does not upload
repository source code to a Nitely-hosted service.

Local inputs accepted by context policy are snapshotted into the run directory.
Inputs excluded by context policy are not snapshotted, not included in prompts,
and not sent to providers.

### Where Worktrees Are Created

Run state lives under the repository's `.nitely` directory:

- event database: `.nitely/events.db`;
- run directory: `.nitely/runs/<run-id>`;
- run worktree: `.nitely/runs/<run-id>/worktree`;
- run inputs: `.nitely/runs/<run-id>/inputs`;
- stage attempts: `.nitely/runs/<run-id>/stages/<stage-id>/<attempt>`;
- context manifest: `.nitely/runs/<run-id>/context-manifest.json`;
- artifact registry: `.nitely/runs/<run-id>/artifacts.json`.

The Web Console reads these local files and event projections. It does not
change where run data is stored.

### Where Agent Credentials Live

Agent credentials are provided to local agent CLIs or local environment:

- Codex authentication is managed by the local `codex` CLI.
- Claude requires `ANTHROPIC_API_KEY`.
- GLM requires one of `NITELY_GLM_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY`.

Nitely launches agent runtimes locally and sends prompts through stdin. Agent
credential storage and provider-side retention are controlled by the configured
agent CLI/provider, not by a hosted Nitely service.

### GitHub Tokens

GitHub draft PR publishing and PR comment operations require
`NITELY_GITHUB_TOKEN` or `GITHUB_TOKEN`, or a configured GitHub provider
connection. The token is used for GitHub API calls such as pull request lookup,
creation, update, comments, and PR discussion operations.

The current GitHub provider supports same-repository PR operations. It does not
require a Nitely-hosted GitHub App.

### Provider Credentials

Provider status and credentials are resolved through:

- environment variables via `EnvProviderConnectionStore`;
- optional local file-backed connections via `.nitely/connections.json`
  (metadata only) and `.nitely/connections.secrets.json` (credential bytes).

See [docs/provider-connections.md](provider-connections.md) for the connection
model: explicit auth methods, multiple connections per provider, and the OAuth
refresh / expiry / revocation lifecycle.

The file-backed store writes local provider secrets with file mode `0600`. The
context policy has a built-in exclude for `.nitely/providers/**`, and local
provider secrets are redacted before runtime/Web exposure when they are known to
Nitely.

Provider status pages should be treated as local setup visibility. They are not
a hosted credential vault.

### Local Identity And Authorization

Required-auth Web deployments keep salted `scrypt` password verifiers and
server-side session records under `.nitely/users`. New passwords are length
checked and blocklisted, unknown-user login attempts execute a dummy derivation,
and repeated failures are throttled in process. Session cookies can be marked
`Secure` for HTTPS deployments. Global admins can revoke all sessions for a
user.

Organization roles are evaluated through named permissions before sensitive
task, planning, run, flow, provider, notification, evidence, and administrative
operations. Resource visibility remains independently scoped by owner and
organization. The full matrix and operational guidance are in
[enterprise-identity-rbac-and-audit.md](enterprise-identity-rbac-and-audit.md).

Security decisions are appended as bounded metadata to
`.nitely/security/audit.jsonl`. The audit excludes credentials, cookies,
session ids, request/response bodies, prompts, source, specifications, logs, and
evidence contents. It is local operational evidence, not tamper-evident or
hosted compliance storage.

## Logs, Evidence, and Artifacts

Nitely persists local evidence so a human can review what happened:

- run and stage events in `.nitely/events.db`;
- prompt files in attempt directories;
- command stdout/stderr logs;
- agent stdout/stderr logs;
- generated artifacts and artifact manifests;
- gate outputs and approval evidence;
- PR evidence bodies;
- bounded local recovery patch checkpoints and their metadata;
- context usage and runtime usage summaries;
- blocker, retry, resume, operator review submission/resolution, sync, and
  reflection events.

Command and agent logs are redacted before being written through the runtime
paths that know the run's redaction secrets. Web API responses also apply Web
redaction before exposing logs, prompts, events, context manifests, artifacts,
and evidence text.

Source snapshots and generated artifacts are not modified in place by redaction.
That preserves review integrity, but it also means teams must avoid including
secrets in allowed inputs or generated artifacts.

## Context Policy and Redaction

`nitely.context.json` controls which local files may become run context.

Built-in excludes include:

- `.git/**`;
- `.nitely/providers/**`;
- `.nitely/events.db`;
- `.env`, `.env.*`;
- private key file patterns such as `*.pem`, `*.key`, `id_rsa`, and
  `id_ed25519`.

If a file is excluded, Nitely does not snapshot its bytes, include them in
prompts, or send them to providers. In `warnOnly` mode, the exclusion is
recorded as a warning and the bytes are still omitted.

Redaction applies to common token/secret/password/API-key forms, known GitHub
and OpenAI-style token patterns, configured environment secrets, provider
secrets, prompt previews, prompt files, logs, evidence, run events, PR bodies,
and Web API text responses.

Redaction is a defense-in-depth control, not a guarantee. The primary control is
context policy: do not allow sensitive files into run context unless that is an
intentional, reviewed decision.

## Local Retention

Default retention is local and indefinite:

- `.nitely/events.db` keeps run events until manually removed.
- `.nitely/runs/<run-id>` keeps worktrees, inputs, attempts, prompts, logs,
  artifacts, evidence, and manifests until manually removed.
- `.nitely/connections.json` keeps locally configured provider connection
  metadata, and `.nitely/connections.secrets.json` the credential bytes, until
  cleared.
- `.nitely/api-tokens/tokens.json` keeps scoped token verifiers and grants;
  `.nitely/api-tokens/audit.jsonl` keeps metadata-only grant, revocation, allow,
  denial, and request-outcome records. Raw API token values are not persisted.
- `.nitely/security/audit.jsonl` keeps metadata-only login, logout, sensitive
  action, access-denial, and session-revocation events until manually removed.
- `.nitely/users` and `.nitely/repositories.json` keep local Web Console user,
  session, organization, and repository metadata until manually removed.
  In required-auth mode, stored catalog entries carry workspace
  `organizationId` ownership. The entry registered from the home checkout's
  `origin` (the `home` entry) is visible to every authenticated user; every
  other repository follows workspace/organization ownership. Legacy stored
  entries without an `organizationId` remain admin-only until assigned.

Repositories may add `nitely.evidence.json` to configure manual retention
windows for complete run directories, complete per-run event histories, logs,
registered artifacts, and `evidence.md` summaries. `nitely evidence policy`
validates the effective policy. `nitely evidence prune` only previews eligible
terminal-run actions unless the operator explicitly supplies `--apply`; active
and interrupted runs are preserved. Event histories are removed whole rather
than partially truncating a projection.

The log window applies to run-local log files. Sanitized command output can
also exist in event payloads and remains until the event-history window expires.
Prompts, input snapshots, and worktrees remain until whole-run removal.

`nitely evidence search` performs local metadata search, and `nitely evidence
export` builds a checksummed metadata-only package that excludes source,
worktrees, inputs, prompts, logs, evidence text, artifact contents, and free-form
gate/blocker output by default. Raw evidence/log/prompt/output/recovery patch
and registered artifact files require `--include-raw`, are marked sensitive,
and are not guaranteed to be redacted. See
[evidence-retention-search-export.md](evidence-retention-search-export.md).

Nitely does not schedule retention automatically and does not implement secure
erasure. Teams should treat `.nitely` and raw exports as sensitive operational
data and back them up, retain them, or delete them according to their own
policy. Filesystem snapshots, backups, storage media behavior, and provider-side
retention remain outside Nitely's control.

## Future Control Plane Boundary

A future Nitely control plane should coordinate work without requiring source
code, secrets, raw worktrees, or full agent context to leave the customer
environment by default.

Acceptable default uploads:

- run id, status, timestamps, repo id/name, flow id/name;
- stage status, attempt counts, blocker categories, and retry/resume metadata;
- selected evidence summaries and artifact metadata;
- PR URL/number, branch names, and review status;
- context/runtime usage metrics and cost attribution;
- sanitized error summaries and operator-facing recovery state.

Data that must not leave the customer environment by default:

- source code and full worktree contents;
- raw prompts and full agent context;
- agent credentials and provider tokens;
- GitHub tokens;
- `.env` files and private keys;
- raw command stdout/stderr unless explicitly configured for upload;
- generated artifacts that may contain proprietary code or secrets.

Any future upload of raw logs, prompts, generated artifacts, or source excerpts
must be explicit, documented, and governed by policy.

## Threat Model

### Local Execution

Primary threats:

- a flow includes sensitive files as allowed inputs;
- an agent or command prints secrets to stdout/stderr;
- a generated artifact contains proprietary or secret material;
- local `.nitely` state is read by an unauthorized local user;
- local agent CLIs or providers retain prompts according to their own policies;
- broad shell commands mutate the repository or environment beyond intended
  scope.

Controls:

- context policy and built-in excludes;
- local worktree isolation;
- local redaction before logs/events/Web API exposure;
- artifact integrity/provenance metadata;
- approval/gate stages and high-risk work item policy;
- local operator review before landing PRs.

Residual risk:

- local execution is powerful by design;
- redaction is best-effort;
- generated artifacts are not rewritten in place;
- agent provider retention is outside Nitely's direct control.

### Customer-Hosted Runners

Primary threats:

- a compromised runner can access checked-out code and configured credentials;
- runner logs may contain sensitive data;
- a malicious or misconfigured control-plane task could request unsafe actions;
- network interruptions can leave local worktrees or partial state behind.

Controls that the runner design should preserve:

- customer-controlled execution environment;
- least-privilege GitHub and provider credentials;
- policy-controlled task assignment and approval gates;
- explicit upload allow-list for metadata and selected evidence;
- resumable local state and audit trail;
- operator-visible blocker and recovery state.

See [customer-hosted-runner-boundary.md](customer-hosted-runner-boundary.md) for
the runner/control-plane architecture and minimal event protocol.

### Cloud Coordination

Primary threats:

- cloud metadata leaks information about repositories, branches, PRs, costs, or
  incidents;
- uploaded evidence includes more detail than intended;
- centralized policy or queue manipulation causes undesired runs;
- hosted dashboards create retention obligations.

Controls that the control plane should provide:

- tenant isolation;
- explicit data classification and upload policy;
- SSO/RBAC/audit logs;
- retention controls and exports;
- customer-managed runner credentials;
- clear distinction between metadata, summaries, logs, artifacts, and source.

## Operational Guidance

- Add `nitely.context.json` before running Nitely on sensitive repositories.
- Keep `.env`, private keys, and credential stores excluded from context.
- Treat `.nitely` as sensitive local operational data.
- Use least-privilege GitHub tokens for PR publishing and PR comment operations.
- Review generated PRs and evidence before merge.
- Do not enable future control-plane uploads of raw logs, prompts, artifacts, or
  source excerpts without an explicit policy decision.
