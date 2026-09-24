# Issue 22: PR Rework Flow

## Objective

Add a first-class rework flow that updates an existing GitHub pull request branch
instead of creating a new pull request whenever review feedback, comments, or a
follow-up spec asks for changes.

## Problem

Nitely can create draft pull requests, but the review loop still falls back to
manual orchestration. When a generated PR needs changes, the operator must check
out the PR branch, apply fixes, push, and re-run verification by hand. This
blocks self-bootstrapping because Nitely cannot yet repair its own generated PRs.

## Goals

- Accept an existing GitHub PR URL or number as a rework target.
- Resolve PR metadata through the GitHub SCM provider.
- Reject unsupported targets safely, including cross-repository forks in the
  first version.
- Check out the existing PR head branch into an isolated Nitely worktree.
- Materialize a rework instruction as a normal run input.
- Run agent, command, review, and publish/update stages against the PR branch.
- Push commits back to the existing PR branch instead of opening a new PR.
- Persist evidence that links the rework run to the original PR, trigger input,
  previous head SHA, updated head SHA, and verification result.
- Provide a bootstrap flow file that can rework a Nitely-generated PR from a
  spec and tech design.

## Non-Goals

- GitHub webhook ingestion.
- Automatic natural-language parsing of every review thread shape.
- Cross-repository fork PR updates.
- Resolving merge conflicts with base branch changes; that is covered by issue
  #23.
- Full GitHub review-thread synchronization; issue #15 covers comment/review
  loop automation.

## Requirements

- The CLI exposes a deterministic way to run a rework against an existing PR,
  such as `nitely rework-pr <pr-url-or-number> ...` or an equivalent `run`
  option.
- The rework target must be recorded in `run.created` or an equivalent event.
- The worktree must be created from the PR head branch, not from current
  `master`.
- The rework run must refuse to operate when the PR head repository is not the
  configured repository.
- The final publish/update step must push to the existing PR head branch and
  return the existing PR URL/number.
- Evidence must include:
  - target PR URL and number,
  - base branch,
  - head branch,
  - previous head SHA,
  - updated head SHA,
  - triggering instruction source,
  - completed stages.
- Existing `publish-change` behavior for new PR creation must keep working.

## Acceptance Criteria

1. A CLI command or documented run option can target an existing GitHub PR by URL
   or number.
2. Nitely resolves the target PR and checks out its head branch into
   `.nitely/runs/<run-id>/worktree`.
3. A rework run pushes updates to the existing PR branch and does not open a new
   PR.
4. The generated evidence links the rework run to the original PR and both old
   and new head SHAs.
5. Unsupported cross-repository PRs fail before creating a worktree.
6. Tests cover PR target parsing/resolution, safe checkout, update push behavior,
   evidence output, and preservation of new-PR publishing.

