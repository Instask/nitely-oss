# Issue #12 Specification: Web Console Review Fixes

GitHub issue: https://github.com/Instask/nitely/issues/12
Related PR: https://github.com/Instask/nitely/pull/11

## Objective

Address the Web Console MVP review findings from PR #11 before the feature is
merged. Keep the issue #10 Web Console behavior intact while closing the
correctness and safety gaps found by review.

## Required Behavior

- Show failed and in-progress runs in Web Console run lists even when
  `.nitely/runs/<runId>/run.json` has not been written yet.
- Preserve access to available stage logs for incomplete or failed runs.
- Include a run status in the web run summary/detail projection.
- Avoid returning raw internal error messages from generic API 500 responses.
  Stable input errors may keep their existing JSON error message behavior.
- Add a task detail page linked from the task list.
- The task detail page must show:
  - task metadata
  - specification preview
  - technical design preview
  - latest run summary when available
  - start-run action when appropriate
- `GET /api/tasks/:taskId` must expose the task record plus the materialized
  specification and technical design text.
- Reject flow paths that are lexically inside the repository but resolve through
  a symlink to a file outside the repository.
- Keep existing CLI behavior compatible, including `pnpm dev -- web --repo .`.

## Non-Goals

- Full async run execution.
- Multi-user authentication.
- OAuth or browser-based provider login.
- Replacing the file-backed task store.
- Reworking the whole UI framework.

## Acceptance Criteria

1. Failed or incomplete run directories with stage logs appear in `GET /api/runs`
   and run detail output.
2. Run detail renders available logs for failed or incomplete runs.
3. Generic API 500 JSON responses do not expose raw command stderr or secret
   text.
4. Task detail HTML route renders spec and technical design previews.
5. `GET /api/tasks/:taskId` returns spec and technical design text without
   requiring callers to read files directly.
6. Symlink flow paths resolving outside the repository are rejected.
7. New regression tests cover each review finding.
8. Existing Web Console tests, CLI tests, type check, and build continue to pass.
