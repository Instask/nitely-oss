# Fresh remote run baselines

Normal runs on repositories with an `origin` remote are based on the remote's
current default branch, not on a possibly stale local branch. At admission,
Nitely discovers `origin/HEAD`, fetches that branch into a run-specific
temporary ref, resolves the ref to a commit SHA, and passes the SHA to the
execution backend's worktree creation.

The fetch never checks out, pulls, resets, or rewrites the user's working
branch. Temporary refs are deleted after the SHA is resolved, so concurrent
runs do not share `FETCH_HEAD` or race on a mutable local branch.

The resolved branch and SHA are recorded in `run.created` and the run's
`reproducibility.json` manifest. A failed remote discovery or fetch fails run
admission before workspace creation instead of silently using stale code.

Runs with an explicit `expectedSourceRevision` remain deterministic and do not
fetch or rebase. Standalone repositories without an `origin` remote retain
their local branch baseline because there is no configured upstream to refresh.
