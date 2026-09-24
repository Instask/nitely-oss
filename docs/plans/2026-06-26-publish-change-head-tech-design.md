# Tech Design: Explicit Head Branch For GitHub CLI Publish

## Context

`GitHubCliScmProvider.publishChange()` currently:

1. resolves the GitHub repository from the configured remote,
2. pushes `input.headBranch` to `input.remoteName`,
3. checks for an existing PR,
4. runs `gh pr create`.

Even with the push, `gh pr create` can fail if it does not infer the remote
head from local branch tracking state. Passing `--head` makes the command
independent of that inference.

## Design

In `src/scm/github.ts`, add `--head ${input.headBranch}` to the `gh pr create`
command assembled by `GitHubCliScmProvider.publishChange()`.

Keep the existing push before PR lookup/creation because it guarantees the
remote branch exists and preserves existing behavior for `gh pr list`.

## Test Plan

- Update the GitHub CLI provider body-file test to assert:
  - `git push -u origin <branch>` happens before PR creation.
  - `gh pr create` includes `--head <branch>`.
- Run:
  - `pnpm exec vitest run test/scm/github.test.ts --testNamePattern "body-file"`
  - `pnpm exec tsc --noEmit`
  - `pnpm run check`
  - `pnpm run build`
