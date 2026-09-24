# Web Console MVP Tech Design

Issue: https://github.com/Instask/nitely/issues/10

## Design

Introduce a small local web server and browser UI inside the existing Nitely
package. Keep the MVP local-first and file-backed so it can be implemented
without introducing external services.

Suggested modules:

- `src/web/server.ts`
- `src/web/api.ts`
- `src/web/tasks.ts`
- `src/web/providers.ts`
- `src/web/static.ts`
- `src/web/ui/*`
- `test/web/*`

The CLI should add:

```text
nitely web --repo <path> --host <host> --port <port>
```

Defaults:

- `repo`: `.`
- `host`: `127.0.0.1`
- `port`: `4173`

## Dependencies

Prefer minimal dependencies for the MVP.

- Use Node's built-in HTTP server unless the implementation becomes
  materially simpler with a small router dependency.
- Use existing TypeScript, Vitest, and Zod patterns.
- Use server-rendered HTML plus small client-side JavaScript for interactions,
  or a Vite-powered frontend only if the added build complexity is justified.

If a new dependency is introduced, the PR must explain why it is needed and keep
the runtime footprint small.

## Data Model

Persist tasks under:

```text
.nitely/tasks/<taskId>/
  task.json
  spec.md
  tech-design.md
```

Task record:

```ts
export interface TaskRecord {
  id: string;
  title: string;
  status: "draft" | "ready" | "running" | "completed" | "failed";
  flowPath: string;
  issueUrl?: string;
  specPath: string;
  techDesignPath: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  createdAt: string;
  updatedAt: string;
}
```

Use collision-resistant IDs compatible with filesystem paths. Write JSON
atomically by writing to a temporary file in the same directory and renaming it.

## API

Implement a small JSON API:

```text
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/runs
GET  /api/runs
GET  /api/runs/:runId
GET  /api/providers
```

Validation:

- Reject empty titles.
- Reject empty spec or tech design content.
- Reject flow paths outside the repository, including paths that are lexically
  inside the repository but resolve through a symlink to a file outside it.
- Reject missing flow files at task creation.
- Reject task IDs with path traversal characters.
- Return stable JSON errors:

```json
{ "error": { "code": "invalid_input", "message": "..." } }
```

`GET /api/tasks/:taskId` returns the task record with the materialized
specification and technical design text:

```ts
{
  task: TaskRecord;
  spec: string;
  techDesign: string;
}
```

Generic internal `500` responses use the stable message
`"internal server error"` instead of echoing thrown command stderr or other raw
error text. Stable input and not-found errors keep their explicit JSON messages.

## Starting Runs

`POST /api/tasks/:taskId/runs` should call `runFlow` with:

```ts
{
  flowPath: task.flowPath,
  repoPath,
  inputs: {
    spec: { connector: "local-file", uri: relativeSpecPath },
    "tech-design": { connector: "local-file", uri: relativeTechDesignPath }
  }
}
```

For the MVP, it is acceptable for the HTTP request to remain open until the run
finishes. The response should include the run ID, branch, worktree path, and
change request URL if available. If asynchronous execution is implemented
instead, persist enough task/run state for the UI to refresh after restart.

## Run Projection

Read `.nitely/runs/<runId>/run.json` for completed run metadata when present.
Run listing and detail must also preserve readable run directories that have
stage logs but no `run.json`, so failed or interrupted runs remain inspectable.
When stage logs or evidence exist, expose them as text fields or safe links in
the detail response.

Expected run detail shape:

```ts
export interface WebRunDetail {
  runId: string;
  status: "completed" | "running" | "failed" | "incomplete";
  flowName?: string;
  branchName?: string;
  worktreePath?: string;
  completedStages: string[];
  inputs: Record<string, unknown>;
  changeRequestUrl?: string;
  evidence?: string;
  logs: Array<{
    stageId: string;
    attempt: string;
    stdout?: string;
    stderr?: string;
  }>;
}
```

When `run.json` exists and does not include a status, the file-backed projection
treats the run as `completed`. Without `run.json`, the projection reports
`failed` only for conservative failure signals such as a failure marker or a
stderr-only attempt; otherwise it reports `incomplete`.

If PR #7 run state/logs/resume lands before this work, prefer the event-backed
projection from that PR. Otherwise keep the file-backed projection narrowly
scoped and easy to replace.

## Provider Status

`GET /api/providers` should report configured/missing state without returning
secret values.

Suggested checks:

- GitHub API token: configured if `NITELY_GITHUB_TOKEN` or `GITHUB_TOKEN` exists.
- GitHub CLI: configured if `gh auth status` exits successfully.
- Codex CLI: configured if `codex --version` exits successfully; report that
  authentication is managed by the local Codex CLI.
- Claude/Anthropic: configured if `ANTHROPIC_API_KEY` exists; otherwise report
  missing/future runtime support.
- Google Drive: report environment configuration hints used by the existing
  connector, without exposing values.

All provider responses must redact secret material.

## UI

Use the actual console as the first screen:

- Left or top navigation with Tasks, Runs, Providers.
- Tasks view:
  - table/list of tasks
  - create task action
  - latest run and change request link
- Task detail:
  - spec and tech design preview
  - start run action
  - latest run summary
- Runs view:
  - run list with status inferred from metadata
  - run detail with stage list, evidence, and logs
- Providers view:
  - status rows for GitHub, Codex/OpenAI, Claude/Anthropic, Google Drive
  - no password fields

Keep the visual system restrained and operational. Use responsive constraints so
long task titles, paths, branch names, and log lines do not break layout.

## CLI Integration

Add `web` to help output and tests. The command should parse:

```text
nitely web --repo . --host 127.0.0.1 --port 4173
```

Expose dependency injection around the server start function so CLI tests do not
bind a real port.

## Testing

Add tests for:

- Task creation, listing, reading, and restart persistence.
- Atomic JSON write behavior or failure-safe write helper.
- API validation and JSON error shape.
- Start-run endpoint calling `runFlow` with local-file spec and tech-design
  inputs.
- Run listing/detail projection from fixture `.nitely/runs` data.
- Provider status redacts secrets.
- CLI `web` argument parsing.
- Basic HTML route rendering or static asset serving.

## Verification

Run:

```bash
pnpm exec vitest run test/web test/run test/cli.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```
