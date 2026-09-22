# Issue 250: Avoid Checkout Failures For Branches Owned By Other Worktrees

## Problem

Rework checkout can fail when Nitely runs:

```text
git worktree add --force -B <pr-head-branch> <worktree> FETCH_HEAD
```

If `<pr-head-branch>` is already checked out by another worktree, Git refuses to force-update the branch:

```text
fatal: cannot force update the branch '<branch>' used by worktree '<path>'
```

This can happen after interrupted runs, retries, resumes, or branch reuse.

## Requirements

- Inspect `git worktree list --porcelain` before adding the rework worktree.
- Do not call `git worktree add --force -B <pr-head-branch>` when that branch is owned by another active worktree.
- If the conflicting Nitely worktree is stale and prunable, clean it up with `git worktree prune`.
- If the conflicting Nitely worktree is active, check out `FETCH_HEAD` into a unique local branch for the new run instead of mutating the PR head branch.
- If a non-Nitely worktree owns the branch, fail with an actionable error naming the path and cleanup action.
- Existing update behavior must still push `HEAD:<pr-head-branch>`, so a unique local checkout branch remains publishable.

## Non-Goals

- Automatically deleting active run worktrees.
- Changing same-repository PR update semantics.
- Supporting cross-repository PR rework.
