# Team Credential Policy

Status: provider credential policy package.

Nitely's local-first trust model must still answer team questions: who owns a
provider credential, which repositories it can touch, how it is rotated, and
which runs used it. This document defines the credential policy language for
paid pilots and future team products without requiring a hosted vault.

## Credential Scopes

Use these scopes consistently in setup reports, Web Console provider status, and
pilot closeout notes:

- **user-scoped:** a personal credential owned by one user. This is the default
  Web Console write path and is stored under `.nitely/users/<user-id>/`.
- **repo-scoped:** a credential approved for one repository checkout or repo id.
  It may be personal or shared, but the repository boundary must be explicit.
- **org-scoped:** a shared team credential approved by an organization owner or
  admin. Non-admin users must not create or replace org-scoped credentials.
- **env-only:** a credential supplied only by the customer environment, such as
  `NITELY_GITHUB_TOKEN` or `ANTHROPIC_API_KEY`. Nitely can report metadata, but
  it does not persist the secret.
- **external-vault-backed:** a credential resolved through a customer-managed
  vault reference. Nitely stores only the metadata and vault reference needed to
  ask the resolver for a token.

Local compatibility mode may behave as admin for bootstrap, but paid pilots
should record whether each credential is personal, repo-approved, org-approved,
env-only, or external-vault-backed before the first run.

## Safe Metadata

Provider status and setup evidence may record safe metadata: scope, owner, created/updated time, last status check, source, rotation hint, repository id, organization id, and vault reference.

Raw secret values must never be returned from Web APIs, PR evidence, setup
reports, run logs, or dashboard responses. Status responses should be
metadata-only even when a credential is configured through the Web Console.

## Vault-Ready Resolution

The open-source core should keep a credential resolution abstraction:

1. resolve environment-backed credentials from the process environment;
2. resolve Web Console credentials from local encrypted or permissioned storage
   when available;
3. resolve external-vault-backed credentials through a customer-supplied resolver
   using a vault reference;
4. return only safe metadata to Web/API callers.

The first implementation can keep file-backed local storage with `0600`
permissions, but the interface must not assume plaintext JSON is the long-term
team storage backend.

## Write Policy

Credential writes should fail closed:

- Web Console writes require an authenticated user or local admin compatibility
  mode.
- User-scoped credentials can be written by the owning user.
- Repo-scoped credentials require an explicit repository owner or policy
  decision before they are treated as shared.
- Org-scoped and external-vault-backed credentials require admin or organization
  owner authority.
- Non-writable providers, such as local CLI-only runtimes, must reject Web
  credential writes.

The local Web implementation enforces these paths through the named
`providers:write:personal` and `providers:write:shared` permissions. A personal
write is owned by the caller; shared organization or external-vault-backed
metadata is bound to the caller's current organization and requires its owner
or a global admin.

## Audit Events

Team mode should record credential set, clear, and status-check actions without
secret values. Audit records should include:

- provider id;
- scope and source;
- actor id;
- owner/repository/organization id when present;
- timestamp;
- action type: set, clear, status-check, rotation-reminder, or vault-resolution;
- result: success, rejected, missing, or failed;
- safe reason or remediation text.

These events can feed future hosted audit exports, but they should also be
useful in local paid-pilot evidence.

## Paid Pilot Checklist

Before a paid pilot starts:

- choose the least-privilege credential for GitHub draft PR publishing;
- decide whether agent runtime credentials are personal, env-only, or shared;
- record rotation expectations and the person responsible for each credential;
- confirm raw credentials stay in the customer environment by default;
- confirm which metadata can be included in setup reports and weekly closeouts;
- document any credential that must eventually move to a customer vault.
