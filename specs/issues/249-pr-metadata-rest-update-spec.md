# Issue 249: Avoid gh pr edit For PR Metadata Updates

## Problem

`update-change` refreshes an existing pull request after pushing rework commits. The GitHub CLI provider currently runs `gh pr edit --title ...` after the push.

In production, `gh pr edit` can fail before applying the title update because GitHub CLI internally queries deprecated Projects classic GraphQL fields:

```text
GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience ... (repository.pullRequest.projectCards)
```

This is not a Nitely workflow failure and should not block an otherwise valid rework publish.

## Requirements

- When GitHub REST credentials are available, update PR metadata through `PATCH /repos/{owner}/{repo}/pulls/{pull_number}`.
- The GitHub CLI provider must not call `gh pr edit` for title/body updates when REST credentials are available.
- Keep the legacy `gh pr edit` path as a no-token fallback for explicit GitHub CLI configurations.
- Update-stage evidence must record how metadata was updated.
- Tests must cover the Projects classic GraphQL failure string by proving the REST path avoids the CLI command.

## Non-Goals

- Replacing `gh pr create`.
- Changing change-request target resolution.
- Adding a new user-visible provider configuration screen.
