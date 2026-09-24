# Publish Preflight Tech Design

## Approach

Add a shared GitHub publish preflight used by both providers after existing PR lookup and before PR creation.

The check resolves exact remote branch refs with:

```text
git ls-remote --heads <remote> refs/heads/<branch>
```

It then checks whether the pushed head contains commits not reachable from the base:

```text
git rev-list --count <baseSha>..<headSha>
```

If the count is zero, publish fails before calling GitHub PR creation.

## Ordering

The publish sequence remains:

1. Resolve repository remote.
2. Push the run head branch.
3. Reuse an existing open PR if available.
4. Preflight base/head refs and non-empty diff.
5. Create a draft PR.

This preserves idempotent PR reuse even when a repeated publish has no new diff.

## Failure Messages

Preflight failures are ordinary publish-stage failures with concise operator-facing messages:

- Missing base/head branch: names the missing branch and remote.
- Empty diff: names the base and head branches and suggests committing changes, choosing the correct base, or reusing an existing PR.

## Verification

- Normal REST publish path resolves base/head refs and creates the PR.
- CLI publish path still passes body files and creates the PR when preflight passes.
- CLI publish does not call `gh pr create` when the base branch is missing.
- CLI publish does not call `gh pr create` when base/head have zero commit difference.
