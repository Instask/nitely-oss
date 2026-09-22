# Issue 239 Spec: Make GitHub CLI PR Publishing Explicit About Head Branch

## Problem

`publish-change` can fail after implementation, test, and review succeed when
`gh pr create` cannot infer the current branch's remote head:

```text
aborted: you must first push the current branch to a remote, or use the --head flag
```

Nitely already has a run branch and evidence artifact at this point, so the
publish stage should not depend on GitHub CLI branch inference.

## Requirements

- The GitHub CLI SCM provider must push the run branch before creating a PR.
- `gh pr create` must pass an explicit `--head <branch>` argument after the
  remote branch has been pushed.
- Existing PR reuse behavior must remain unchanged.
- Evidence body handling through `--body-file` must remain unchanged.
- Tests must assert the push and explicit head arguments.

## Non-Goals

- Replace the GitHub CLI provider with the GitHub API provider.
- Change `update-change` behavior.
- Add retry policy changes for publish stages.

## Acceptance Criteria

- A new or updated test fails without `--head` and passes after the fix.
- `pnpm exec vitest run test/scm/github.test.ts --testNamePattern "body-file"` passes.
- Full typecheck and build pass before merge.
