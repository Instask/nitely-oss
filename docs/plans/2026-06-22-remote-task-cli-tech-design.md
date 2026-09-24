# Remote Task Creation CLI Tech Design

## Goal

Add a small CLI wrapper around the existing `POST /api/tasks` Web API so local
operators can submit markdown specs and technical designs to a remote Nitely
server.

## Existing Behavior

- `src/web/server.ts` already accepts JSON at `POST /api/tasks`.
- `taskInputFromJson` maps `title`, `spec`, `techDesign`, `repoId`, `issueUrl`,
  and `flowPath`.
- `src/web/tasks.ts` persists submitted spec and tech design text into the active
  repository's `.nitely/tasks/<task-id>/` directory.
- `src/cli.ts` uses manual command parsing with injected dependencies for tests.

## Design

### CLI Shape

Add:

```bash
nitely task create \
  --server http://192.168.50.177:4173 \
  --title "Implement ordered runtime fallback" \
  --issue https://github.com/Instask/nitely/issues/77 \
  --spec specs/issues/077-runtime-fallback-spec.md \
  --tech-design docs/plans/2026-06-21-runtime-fallback-tech-design.md \
  --flow flows/implement-spec-bootstrap.json
```

`--server` is optional when `NITELY_SERVER_URL` is set. `--repo-id` is accepted
for shared consoles with multiple repositories.

### Parsing and Validation

Keep parsing in `src/cli.ts` to match the current CLI style. Validate required
values before reading files or sending network traffic:

- server URL from `--server` or `NITELY_SERVER_URL`
- title
- spec path
- tech design path

Reject unknown options and missing option values with stable messages.

### Request Construction

Read the two local markdown files as UTF-8. Build:

```ts
{
  title,
  spec,
  techDesign,
  repoId?,
  issueUrl?,
  flowPath?
}
```

POST it to `${server}/api/tasks` with `content-type: application/json`.

### Response Handling

On non-2xx:

- Try to parse JSON and extract `error.message` or `message`.
- Fall back to response text.
- Print `remote task create failed (HTTP <status>): <message>`.

On success:

- Parse JSON.
- Require `task.id`.
- Print:
  - `TASK <id> <status>`
  - `Issue: <url>` when available
  - `Web: <server>/tasks/<id>`

### Test Strategy

Add CLI unit tests using an injected `fetch` dependency:

- Successful request verifies URL, method, JSON body, and printed output.
- Missing spec path exits non-zero and does not call `fetch`.
- Server JSON error exits non-zero with HTTP status and remote message.
- `NITELY_SERVER_URL` fallback is used when `--server` is absent.

## Risks

- Auth-required servers may reject the request. This design surfaces the HTTP
  error clearly but does not introduce credential management.
- Server base paths are not supported; the Web Console currently runs at root.
