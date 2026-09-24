# Issue #554 — Fresh remote run baseline

## Contract

For a normal run without `expectedSourceRevision`, a repository with `origin`
must be admitted from the SHA of the remote default branch fetched at
admission. The SHA is passed to `createWorkspace()` and persisted in both the
`run.created` event and `reproducibility.json`.

## Safety invariants

1. Local branches and uncommitted files are never changed by baseline refresh.
2. Each run fetches through a run-specific temporary ref; `FETCH_HEAD` is not
   used as shared mutable coordination state.
3. Remote discovery or fetch failure stops admission before workspace creation.
4. An explicit 40-character `expectedSourceRevision` skips remote refresh and
   remains the sole source of the run baseline.
5. A repository without an `origin` remote uses its current local branch as a
   standalone-repository fallback.

## Verification

- fetches an advanced remote default branch while preserving local uncommitted
  state;
- records the fetched SHA in run and reproducibility metadata;
- refuses workspace creation when the configured origin is unreachable;
- preserves the existing explicit pinned-revision behavior.
