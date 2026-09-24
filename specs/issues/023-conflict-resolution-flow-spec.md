# Issue 23: Conflict Resolution Flow

## Objective

Add a first-class conflict-resolution flow so Nitely can update a stale same-repository GitHub pull request branch against its current base branch, expose merge conflicts to an agent, verify the resolved branch, and push the result back to the same PR.

## Problem

Nitely can now create PRs and rework an existing PR branch. When multiple generated PRs touch nearby files, an older PR can become stale or conflict with `master`. Today the operator must manually fetch base, merge or rebase, inspect conflict markers, resolve files, run verification, and push the PR branch. That breaks the bootstrap loop once multiple Nitely PRs are active.

## Goals

- Accept an existing same-repository GitHub PR as the conflict-resolution target through the rework target path.
- Fetch the PR head and latest base branch.
- Attempt a deterministic branch sync using a merge-based strategy in the first version.
- Preserve clean no-conflict updates without opening a second PR.
- When conflicts occur, write structured conflict metadata and leave conflict markers in the worktree for an agent stage.
- Let normal agent, command, review, and `update-change` stages resolve, verify, review, and push the same PR branch.
- Persist evidence for sync strategy, base branch, base SHA, head SHA before sync, head SHA after sync when available, conflict files, verification, and PR URL.
- Add a bootstrap flow for resolving conflicts on a Nitely-generated PR.

## Non-Goals

- Merging the PR into `master`.
- Cross-repository fork PR support.
- A rebase-based conflict continuation flow in the first version.
- GitHub webhook ingestion or automatic conflict-triggering from GitHub events.
- Semantic conflict resolution without tests or review.

## Requirements

- Add a `sync-change` stage type that requires a rework target.
- `sync-change` must fail clearly when used in a non-rework run.
- `sync-change` must fetch the target base branch and attempt to merge it into the PR worktree.
- Clean sync behavior:
  - no conflict markers remain,
  - the stage records a clean sync event/report,
  - downstream verification and `update-change` can push the updated PR branch.
- Conflicting sync behavior:
  - the stage must not discard conflict markers,
  - the stage records conflict files from Git's unmerged index,
  - the stage completes so an agent stage can resolve the files,
  - downstream verification must fail if conflicts remain.
- Failed or aborted sync behavior:
  - non-conflict Git errors must append `run.failed`,
  - no push should happen after an unresolved sync failure.
- Evidence must include:
  - target PR URL and number,
  - base branch,
  - sync strategy,
  - base SHA,
  - previous head SHA,
  - sync result (`clean` or `conflicted`),
  - conflict files,
  - completed stages,
  - updated PR URL and head SHA.
- Existing `publish-change`, `rework-pr`, and `update-change` behavior must keep working.

## Acceptance Criteria

1. A documented flow can resolve a stale PR by PR URL or number.
2. A clean same-repository PR branch can be synchronized with its base and pushed back to the same PR.
3. A conflicting PR branch leaves conflict markers for an agent stage and records affected files.
4. Verification fails before push if conflict markers remain unresolved.
5. The final update uses `update-change`, not `publish-change`, and returns the existing PR URL/number.
6. Tests cover clean merge sync, conflicting merge sync, use without rework target, failed verification/no push, and existing rework/new-PR behavior.

