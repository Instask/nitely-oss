# Issue #160 Spec: Idempotent GitHub Publish

## Background

Nitely publish can fail when a retry attempts to create a GitHub pull request
for a branch/base pair that already has an open PR. GitHub rejects the duplicate
create request even though the existing PR is the desired published state.

## Goals

- Re-running publish for a branch with an existing PR succeeds.
- Publish evidence identifies whether the PR was created or reused.
- Existing draft PRs are reused without losing their draft state.
- Existing first-publish behavior remains unchanged when no PR exists.

## Non-goals

- Reworking an existing PR is already covered by update-change and is not
  changed here.
- Closing, reopening, or retargeting PRs is out of scope.
- Cross-repository fork publish support is out of scope.

## Acceptance Criteria

- GitHub API publish checks for an open PR matching the pushed head branch and
  base branch before creating a new draft PR.
- Legacy GitHub CLI publish reuses an existing PR for the same head/base
  instead of surfacing `gh pr create` duplicate failures.
- `ChangeRequest` records outcome as `created`, `reused`, or `updated`.
- The publish event and `change-request.md` artifact include that outcome when
  known.
- Tests cover first publish, retry publish with an existing PR, and existing
  draft PR behavior.
