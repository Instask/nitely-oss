# Worktree Branch Collision Tech Design

## Approach

Replace the previous "remove clean Nitely worktree" checkout preparation with an ownership-aware branch selection step.

Before `git worktree add`, parse `git worktree list --porcelain` and inspect entries whose branch is the PR head branch:

- Same target worktree: ignore.
- Prunable Nitely worktree: run `git worktree prune`, then keep using the PR head branch locally.
- Active Nitely worktree: keep the existing worktree untouched and use a unique local checkout branch for the new run.
- External worktree: fail before checkout with an actionable remediation message.

## Unique Branch Fallback

For active Nitely collisions, checkout uses:

```text
<pr-head-branch>-checkout-<run-id>
```

The rework update stage already pushes with:

```text
git push origin HEAD:<pr-head-branch>
```

So the local branch name does not need to equal the remote PR head branch.

## Operator Evidence

External branch ownership errors include:

- PR head branch name.
- Conflicting worktree path.
- Recommended action: remove or detach the conflicting worktree, then retry.

## Verification

- Checkout with no collision still uses the PR head branch.
- Active Nitely collision uses a unique local branch and does not remove the old worktree.
- Prunable Nitely collision runs `git worktree prune`.
- External worktree collision fails with an actionable message.
