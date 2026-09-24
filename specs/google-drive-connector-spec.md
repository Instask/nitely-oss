# Google Drive Connector Specification

Date: 2026-06-19
Status: Ready for Nitely bootstrap

## Objective

Implement a `google-drive` connector for Nitely so run inputs can be fetched
from Google Drive and snapshotted as immutable input artifacts before any stage
executes.

## Current State

`feature/bootstrap` already has:

- `Connector` and `ResourceReference` contracts in `src/connectors/types.ts`.
- `ConnectorRegistry` in `src/connectors/registry.ts`.
- `LocalFileConnector` in `src/connectors/local-file.ts`.
- Connector tests under `test/connectors`.

It does not support Google Drive today. `test/connectors/registry.test.ts`
currently expects a `google-drive` reference to fail with
`unknown connector type: google-drive`.

## Required Behavior

Add `GoogleDriveConnector` with connector type `google-drive`.

The connector must:

- Accept Google Docs URLs, Google Drive file URLs, and raw file IDs.
- Fetch Google Docs-like files through Drive export.
- Fetch binary or already-downloadable files through Drive media download.
- Return the existing `FetchedResource` shape:
  - `sourceUri`
  - `mediaType`
  - `content`
  - optional `revision`
  - sanitized string metadata
- Support an explicit export MIME type through `ResourceReference.options`.
- Default Google Docs export to `text/markdown` only if supported by Drive;
  otherwise use `text/plain`.
- Never persist OAuth access tokens, refresh tokens, authorization headers, or
  connector options into artifact metadata.
- Fail with actionable errors for missing credentials, malformed references,
  HTTP auth failures, missing files, unsupported export types, and non-2xx API
  responses.

## Authentication

Use environment-provided credentials for the first version:

- `NITELY_GOOGLE_ACCESS_TOKEN`

Do not implement OAuth setup or browser-based consent in this task. If the
environment variable is missing, fail before making a network request.

## Non-Goals

- OAuth consent flow.
- Google Drive picker UI.
- Connector configuration UI.
- Background refresh of inputs during a run.
- Writing to Google Drive.
- Sharing or permission management.
- Service account setup automation.

## Implementation Notes

Keep the connector independent from flows, agents, scheduling, and worktrees.
It should only implement `Connector.fetch(reference)`.

Suggested files:

- `src/connectors/google-drive.ts`
- `test/connectors/google-drive.test.ts`

Use Node 24 built-in `fetch`, `URL`, and `Buffer`; do not add a Google SDK
dependency unless the implementation proves the REST surface is not enough.

The tests should mock `fetch` and must not call Google over the network.

## Acceptance Criteria

1. `GoogleDriveConnector.type` is exactly `google-drive`.
2. A Google Docs URL is parsed to a file ID and exported.
3. A raw file ID can be fetched.
4. A downloadable Drive file is fetched as bytes.
5. The connector returns content, media type, revision, source URI, and
   sanitized metadata.
6. Missing `NITELY_GOOGLE_ACCESS_TOKEN` fails clearly.
7. API errors include status code and safe response context.
8. Unit tests pass without network access.
9. `pnpm run check`, `pnpm exec vitest run`, and `pnpm run build` pass.

