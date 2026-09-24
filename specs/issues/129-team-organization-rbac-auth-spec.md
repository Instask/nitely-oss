# Issue 129 Team Organization RBAC Auth Spec

## Background

Nitely already has real email/password users and sessions for required Web auth.
The remaining product gap is multi-user collaboration: work records, provider
connections, and run visibility need a first-class team boundary instead of
only per-owner filtering.

## User Stories

- **US-001:** As an administrator, I can bootstrap a default organization so
  required-auth installations have an explicit team boundary from first login.
- **US-002:** As a team member, I can create and run work inside my team without
  exposing it to users from another team.
- **US-003:** As a team viewer, I can inspect team work but cannot create or
  execute implementation runs.
- **US-004:** As an auditor, I can see which organization owns a task, work
  item, or run.
- **US-005:** As an operator, I can keep existing local-mode and legacy owner
  records working while new required-auth records use team scope.

## Acceptance Scenarios

- **US-001 / SC-001:** Given the initial admin is bootstrapped, when the user is
  created, then a default organization exists and the admin is an owner member.
- **US-002 / SC-002:** Given a member creates a task or work item, when it is
  persisted, then it records the member's current organization id.
- **US-002 / SC-003:** Given users from different organizations, when each lists
  tasks, work items, or runs, then each user only sees records from their own
  organizations.
- **US-003 / SC-004:** Given a viewer member, when they create a task/work item
  or start a run, then the API returns forbidden before mutating records or
  invoking `runFlow`.
- **US-004 / SC-005:** Given a work item run starts from a team-scoped record,
  when run metadata is persisted and projected, then the organization id is
  included.
- **US-005 / SC-006:** Given local auth or legacy owner-scoped data, when APIs
  are used, then existing admin/local visibility and legacy owner fallback
  behavior continue to work.

## Functional Requirements

- **FR-001:** Add an organization model with stable id, name, timestamps, and
  user memberships.
- **FR-002:** Membership roles must support `owner`, `maintainer`, `member`, and
  `viewer`.
- **FR-003:** Public session/user responses must include available memberships
  and current organization context when auth is required.
- **FR-004:** New required-auth tasks and work items must be assigned to the
  current organization.
- **FR-005:** Team-scoped records must be visible to members of that
  organization, regardless of individual owner id.
- **FR-006:** Existing local/admin behavior and legacy owner-only records must
  remain backward compatible.
- **FR-007:** Mutating actions that create work or start runs must require a
  write-capable organization role: `owner`, `maintainer`, or `member`.
- **FR-008:** Viewer members must retain read-only access to visible team
  records.
- **FR-009:** Run metadata and Web run projections must carry organization id
  for team-scoped runs.
- **FR-010:** Provider credentials remain per-user in required-auth mode for
  this slice.

## Success Criteria

- **SC-007:** Unit tests cover organization persistence, default bootstrap, and
  public user membership projection.
- **SC-008:** Web tests cover team-level task/work-item visibility.
- **SC-009:** Web tests cover viewer write/run denial and member write/run
  allowance.
- **SC-010:** Run-flow tests cover organization id persistence in run metadata
  and projected run records.
- **SC-011:** Full `pnpm run check` and `pnpm test:run` pass.

## Edge Cases And Failure Behavior

- Users with no memberships in required-auth mode receive forbidden for
  mutating actions that need team context.
- A record with `organizationId` is hidden from users outside that organization.
- A legacy record without `organizationId` falls back to existing owner/admin
  visibility rules.
- Local auth continues to behave as an admin context and can access all legacy
  and team records.
- Unknown or malformed membership roles are rejected when persisted.

## Assumptions

- The first organization can be a default team named `Default Team`.
- Complete invitation, SCIM, SSO, and organization switching UI can build on the
  persisted model later.
- A user may belong to multiple organizations, but this slice can choose the
  first membership as the current organization.

## Out Of Scope

- Billing seats and subscription enforcement.
- SSO/OIDC/SAML.
- Invite email delivery and team administration screens.
- Shared team provider credentials.
