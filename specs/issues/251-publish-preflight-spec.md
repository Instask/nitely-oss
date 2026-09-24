# Issue 251: Preflight Publish Refs And Diff Before PR Creation

## Problem

Publish can discover deterministic GitHub PR input failures only after invoking PR creation:

- Base branch is not a branch.
- Base or head SHA cannot resolve.
- There are no commits between base and head.

These conditions can be checked locally/remotely before calling GitHub PR creation.

## Requirements

- Push the run head branch before PR lookup/creation.
- Reuse an existing open PR if one already exists for the base/head pair.
- Before creating a new PR, verify the remote base branch resolves to a SHA.
- Before creating a new PR, verify the remote head branch resolves to a SHA.
- Before creating a new PR, verify `git rev-list --count <baseSha>..<headSha>` is greater than zero.
- Do not call `gh pr create` when any preflight check fails.
- Error messages must include the invalid branch or empty diff reason and a short remediation.

## Non-Goals

- Replacing broader flow preflight/doctor checks.
- Changing existing PR reuse semantics.
- Automatically retargeting the base branch.
