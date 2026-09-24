# Issue #8 Specification: GitHub Connector for PR Publishing

GitHub issue: https://github.com/Instask/nitely/issues/8

## Objective

Move GitHub pull request publishing behind a first-class Nitely connector or
SCM provider instead of calling `gh pr create` directly from `runFlow`.

## Current State

`publish-change` currently pushes the generated branch and shells out to the
GitHub CLI. This is acceptable for early bootstrap, but it means PR creation
depends on an ambient interactive `gh` session rather than an explicit Nitely
connection.

## Required Behavior

- Add a GitHub provider boundary owned by Nitely.
- Publish draft pull requests through the GitHub API with configured
  credentials.
- Return structured change request metadata:
  - URL
  - PR number
  - provider
  - owner
  - repository
  - base branch
  - head branch
  - draft state
- Keep branch push behavior explicit and testable.
- Make missing credentials fail with an actionable error.
- Wire `publish-change` through provider selection instead of directly calling
  `gh pr create`.
- Preserve a legacy `gh` fallback only when explicitly configured.

## Configuration

The initial credential source should be environment based:

- `NITELY_GITHUB_TOKEN`
- `GITHUB_TOKEN` as a compatibility fallback

The implementation must not ask users to enter GitHub passwords in a browser.
Future UI work should manage provider connections and store secrets server-side.

## Non-Goals

- GitHub App installation flow.
- OAuth browser login.
- Webhook ingestion.
- GitHub issue management beyond what PR publishing needs.
- Multi-tenant secret storage.

## Acceptance Criteria

1. `publish-change` no longer calls `gh pr create` directly by default.
2. GitHub draft PR creation works through the GitHub API using a configured
   token.
3. Unit tests cover API request construction without calling the real GitHub
   API.
4. Unit tests cover missing token errors.
5. Integration tests cover `publish-change` provider selection with a stubbed
   provider.
6. PR evidence still appears in the created PR body.
7. Existing CLI behavior remains compatible for bootstrap flows.
