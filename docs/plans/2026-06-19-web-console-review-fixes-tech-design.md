# Web Console Review Fixes Tech Design

Issue: https://github.com/Instask/nitely/issues/12
Related PR: https://github.com/Instask/nitely/pull/11

## Context

PR #11 adds the Web Console MVP. Nitely review found four gaps that should be
fixed before merge:

- run projection hides failed/in-progress run directories when `run.json` does
  not exist yet
- generic API 500 responses can expose raw command stderr
- task detail and spec/technical design previews are missing
- flow path validation does not protect against symlink escape

This work should be implemented as a focused rework on top of PR #11.

## Design

### Run Projection

Extend `src/web/runs.ts` to tolerate incomplete run directories.

- Keep reading `run.json` when present.
- If `run.json` is missing, derive a fallback summary from the run directory:
  - `runId` from the directory name
  - `status` inferred from available metadata:
    - `completed` when `run.json` exists and includes completed publish/run data
    - `running` or `incomplete` when stage directories exist but no terminal
      metadata exists
    - `failed` when a failure marker or stderr-only failed attempt can be
      detected; if no reliable failure signal exists, prefer `incomplete`
  - `completedStages` from stage directories that have logs or known attempt
    files
- Do not silently drop readable run directories merely because `run.json` is
  absent.
- Continue exposing `evidence.md`, `stdout.log`, and `stderr.log` text when
  present.

If status inference cannot be exact with the current runtime files, document the
fallback semantics in code and tests. Do not invent event store dependencies for
this rework unless they are already available on the branch.

### Error Redaction

Update `src/web/server.ts` generic error handling:

- Keep `WebInputError` and `WebNotFoundError` messages as stable API responses.
- For unknown/internal errors, return a generic message such as
  `"internal server error"`.
- Avoid echoing command text, stderr, environment values, or thrown error
  messages in the response body.
- It is acceptable to log details to stderr later, but this rework does not need
  server-side logging if the project does not have a logging pattern yet.

### Task Detail

Extend task APIs and UI.

- Add a task detail data shape that includes:
  - `task`
  - `spec`
  - `techDesign`
- Update `GET /api/tasks/:taskId` to return the detail shape.
- Add an HTML task detail route, for example `/tasks/:taskId`.
- Link task titles from the task list to the task detail route.
- Render task metadata, spec preview, technical design preview, latest run link,
  change request link, and start-run action.
- Escape all rendered text.
- Preserve responsive behavior and long-text wrapping.

### Symlink-Safe Flow Path Validation

Update flow path validation in `src/web/tasks.ts`.

- Continue rejecting lexical path traversal.
- Resolve the repository real path and candidate flow real path before accepting
  an existing flow file.
- Reject candidates whose real path is outside the repository real path.
- If the flow file does not exist at task creation time, decide conservatively:
  reject it with a stable input error unless there is an existing project
  pattern that permits missing flow files.
- Add regression tests using a symlink inside the temporary repo that points to
  a flow file outside the repo.

## Tests

Add or update tests for:

- incomplete run directories are listed and detail pages expose available logs
- `GET /api/runs/:runId` works without `run.json` when logs exist
- generic API 500 responses redact raw thrown messages
- `GET /api/tasks/:taskId` includes spec and technical design text
- task detail HTML route renders previews and links
- symlink flow path escape is rejected
- existing CLI `web` tests still pass

## Verification

Run:

```bash
pnpm exec vitest run test/web test/run test/cli.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```
