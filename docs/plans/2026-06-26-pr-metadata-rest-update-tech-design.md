# PR Metadata REST Update Tech Design

## Approach

Centralize GitHub pull request metadata updates behind a small REST helper:

- Input: target pull request, token, optional title/body.
- Request: `PATCH /repos/{owner}/{repo}/pulls/{number}`.
- Result: metadata update evidence containing transport, outcome, and fields.

The first-party GitHub provider uses this helper for update-change metadata refreshes.

## GitHub CLI Provider

The CLI provider keeps its existing git push and checkout behavior. After pushing the rework branch:

1. Try to resolve a GitHub token from the configured provider connection or `NITELY_GITHUB_TOKEN`.
2. If a token exists, call the REST helper and return without invoking `gh pr edit`.
3. If no token exists, keep the existing `gh pr edit --title ...` fallback.

This preserves compatibility for users who explicitly select the legacy GitHub CLI provider while removing the production failure mode when REST credentials are configured.

## Evidence

`UpdateChangeRequestResult` includes optional `metadataUpdate`:

- `transport`: `github-rest-api` or `github-cli`
- `outcome`: `updated`
- `fields`: metadata fields sent to the provider

`change.updated` events and generated change-request artifacts include this value so run evidence shows whether metadata used REST or CLI.

## Verification

- GitHub REST provider update-change test asserts PATCH request and metadata evidence.
- GitHub CLI provider no-token test keeps `gh pr edit` fallback coverage.
- GitHub CLI provider token test makes `gh pr edit` throw the Projects classic GraphQL error if called, then verifies the REST path succeeds without invoking it.
