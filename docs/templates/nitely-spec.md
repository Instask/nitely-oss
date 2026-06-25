# Feature Spec: Repository Import

## Background

Describe the problem, who is affected, and why the change matters now. Keep
this section factual enough for a planner to derive implementation boundaries.

## User Stories

- **US-001:** As an operator, I can paste a repository URL so Nitely can create
  a local managed repository record.
- **US-002:** As a reviewer, I can see whether a repository import succeeded or
  failed without reading run logs.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a valid GitHub repository URL, when the operator
  submits it, then Nitely clones the repository and shows it in the repository
  list.
- **US-002 / SC-002:** Given an invalid repository URL, when the operator
  submits it, then Nitely records a clear failure message and does not create a
  partial repository record.

## Functional Requirements

- **FR-001:** Nitely must accept HTTPS GitHub repository URLs as repository
  import input.
- **FR-002:** Nitely must clone imported repositories into a managed local
  directory.
- **FR-003:** Nitely must persist repository metadata so future runs can target
  the imported repository.

## Success Criteria

- **SC-001:** A valid repository URL can be imported and selected for a run.
- **SC-002:** Invalid URLs fail with a visible error and no partial repository
  record.
- **SC-003:** Existing flows and locally configured repositories continue to
  work.

## Edge Cases And Failure Behavior

- Network failures leave a failed import record with a retryable error.
- Duplicate URLs resolve to the existing repository record.
- Private repositories surface authentication failures without exposing tokens.

## Assumptions

- Git is available on the host running Nitely.
- Authentication setup for private repositories is handled outside this spec.

## Out Of Scope

- Git provider account management.
- Repository deletion UI.
- Automatic migration of existing unmanaged local repositories.

## ID Stability Rules

- `US-###`, `FR-###`, and `SC-###` IDs are stable once referenced by a plan,
  task artifact, run, or PR.
- Do not renumber IDs after review starts. Mark removed behavior as out of scope
  or superseded instead.
- New behavior gets the next unused ID in the matching family.

## Usage Guidance

- Flow-forward: implementation plans and task artifacts should cite relevant
  `US-###`, `FR-###`, and `SC-###` IDs.
- Living spec: update the spec when scope changes, but keep existing IDs stable.
- Flow-back: PR evidence and review findings should cite IDs from this spec
  instead of quoting long prose blocks.
