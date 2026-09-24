# Issue #6 Specification: Rich PR Evidence Reports

GitHub issue: https://github.com/Instask/nitely/issues/6

## Objective

Improve draft PR evidence so a reviewer can understand what Nitely did without
digging through run directories.

## Current State

`evidence.md` includes run ID, branch, inputs, completed stages, and a generic
generated-by note. It does not include command results, changed files, retry
history, approvals, or review outcome.

## Required Behavior

Evidence must include:

- Flow name.
- Run ID.
- Source repo and base branch.
- Generated branch.
- Input artifacts with source URI, media type, revision, and snapshot path.
- Stage attempt summary.
- Command gate results with log paths.
- Changed file list.
- Diff summary.
- Retry, rework, and approval history when present.
- Review summary when a review artifact exists.
- Safety note that the PR is draft and not auto-merged.

## Non-Goals

- Full HTML report.
- External artifact hosting.
- Automatic merge.

## Acceptance Criteria

1. PR body uses the generated evidence file.
2. Evidence includes changed files and diff summary.
3. Evidence includes command gate status and log paths.
4. Evidence remains useful when optional sections are absent.
5. Tests cover evidence generation with and without retry/approval data.

