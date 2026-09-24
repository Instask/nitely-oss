# Issue 529: Enforce declared agent read bounds

## Goal

Turn `reads.maxFileBytes`, `reads.deny`, and `reads.enforcement` into an
honest execution boundary where the backend can enforce them.

## Requirements

- OCI read-only stages with `enforcement: "required"` run against a filtered
  workspace that excludes denied paths and files over the byte cap.
- OCI writable stages fail closed for required bounds until a write-preserving
  filesystem mediation layer exists.
- Local and Mise backends fail closed for required bounds.
- Advisory bounds retain the existing prompt/evidence behavior.
- Temporary filtered workspaces are removed after the stage, including failure.

## Non-goals

- A shell `PATH` shim that truncates `cat`/`rg` output.
- Silent truncation or mutation of repository files.
