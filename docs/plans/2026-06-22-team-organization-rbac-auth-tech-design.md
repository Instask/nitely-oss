# Team Organization RBAC Auth Tech Design

## Goal

Introduce a durable organization and membership model for required-auth Web
sessions, then enforce team-scoped read/write authorization on tasks, work
items, and runs.

## Design

### Organization Store

Add `src/web/organizations.ts` with a JSON-backed file under
`.nitely/users/organizations.json`.

The file stores:

- `organizations: Record<string, OrganizationRecord>`
- each organization has `id`, `name`, `createdAt`, `updatedAt`
- each organization has `members: Record<userId, OrganizationMemberRecord>`
- member roles are `owner`, `maintainer`, `member`, and `viewer`

The module owns role validation, public membership projection, current
organization selection, and write-role checks. It also exposes
`ensureDefaultOrganizationForUser(repoPath, user, role)` so user bootstrap and
manual user creation can create a usable team boundary without a separate admin
flow.

### User Projection

Extend `PublicUser` with optional organization context:

- `memberships`
- `currentOrganizationId`
- `currentOrganizationRole`

`publicUser` stays synchronous and can keep returning the base user shape for
legacy callers. New async user/session helpers enrich users by loading
organization memberships before returning Web session data.

### Record Ownership

Add optional `organizationId` to:

- `TaskRecord`
- `WorkItemRecord`
- run-flow input and run metadata/projection types

Required-auth create paths set `organizationId` to the user's current
organization. Local mode leaves it absent unless data already has one.

### Authorization

Replace owner-only visibility with:

- local auth or user role `admin`: visible
- record has `organizationId`: visible when user is a member of that org
- record has no `organizationId`: fall back to existing `ownerId` match

Mutating task/work-item creation and run start require write access to the
target organization. Viewer members get read-only access.

### Run Metadata

When starting a team-scoped task/work item run, pass `organizationId` into
`runFlow`. Persist it in `run.json`, expose it in projected Web runs, and keep
older runs without the field valid.

### Frontend

The current login form already uses email/password. Update only the signed-in
identity text so it can show current organization role when provided by the
session API.

## Validation

- Unit tests for default organization creation and public membership projection.
- Web server tests for cross-team visibility and role-based mutation checks.
- Run-flow tests for organization id persistence.
- Static console tests for session rendering if needed.
- Full `pnpm run check` and `pnpm test:run`.

## Rollback

Revert the PR. New records with `organizationId` are optional JSON fields, so
older code can ignore them, and legacy owner-scoped records remain readable by
the existing admin/local paths.
