# Agent read-bound enforcement technical design

Use the existing read policy and OCI mount seam. For a required bound on a
read-only stage, copy the worktree to a temporary run-owned snapshot while
filtering denied globs, symlinks, non-regular files, and files larger than the
declared cap. Mount that snapshot read-only at `/workspace`, then remove it in
the backend's `finally` path.

Writable stages do not get a false guarantee: they fail closed for required
bounds. The local/Mise backends keep the same fail-closed contract. Advisory
stages continue to use the existing prompt and evidence policy.

Tests cover filtered small/large files, required writable-stage failure, and
cleanup through the normal OCI teardown path.
