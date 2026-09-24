# Google Drive Connector Tech Design

Date: 2026-06-19
Status: Proposed bootstrap input

## Summary

Add Google Drive as a Nitely input connector by implementing the existing
`Connector` interface. The connector fetches a remote Drive resource once at run
startup, returns bytes plus sanitized metadata, and lets the existing input
snapshot layer persist an immutable artifact.

This keeps Google-specific behavior outside the scheduler, agent runtime, and
artifact graph.

## Architecture

```text
ResourceReference
  connector: google-drive
  uri: Google Docs URL | Drive file URL | raw file ID
  options:
    exportMimeType?: string
        |
        v
ConnectorRegistry
        |
        v
GoogleDriveConnector
        |
        v
Drive REST API
        |
        v
FetchedResource
```

The connector does not write files. It only returns `FetchedResource`. Snapshot
storage remains responsible for writing `.nitely/runs/<run-id>/inputs/...`.

## Resource Parsing

Support these input forms:

```text
https://docs.google.com/document/d/<file-id>/edit
https://docs.google.com/spreadsheets/d/<file-id>/edit
https://docs.google.com/presentation/d/<file-id>/edit
https://drive.google.com/file/d/<file-id>/view
https://drive.google.com/open?id=<file-id>
<file-id>
```

Reject empty IDs and IDs containing path separators, whitespace, query syntax,
or URL fragments after parsing.

## Fetch Strategy

1. Read `NITELY_GOOGLE_ACCESS_TOKEN`.
2. Fetch metadata for the file.
3. If the file is a Google Workspace document, call Drive export with the
   requested export MIME type.
4. Otherwise call Drive media download.
5. Return bytes and sanitized metadata.

Default export MIME types:

- Google Docs: `text/plain`
- Google Sheets: `text/csv`
- Google Slides: `text/plain`
- Other Google Workspace MIME types: require `options.exportMimeType`

`options.exportMimeType` overrides the default.

## Metadata

Return only safe string metadata:

- `id`
- `name`
- `driveMimeType`
- `exportMimeType` when export was used

Use file revision-like fields as `revision` when available, preferring a stable
Drive version or modified timestamp. Never include access tokens, request
headers, raw connector options, owner emails, sharing information, or permission
lists.

## Error Handling

Errors should be explicit and safe:

- Missing token: `missing NITELY_GOOGLE_ACCESS_TOKEN for google-drive connector`
- Invalid URI or ID: `invalid google-drive resource uri: <safe value>`
- 401 or 403: `google-drive authentication failed with status <code>`
- 404: `google-drive resource not found: <file-id>`
- Export failure: include status and export MIME type.
- Media download failure: include status and file ID.

Response bodies may be included only after truncation and only if they do not
contain request headers or tokens.

## Test Plan

Add `test/connectors/google-drive.test.ts` using a mocked `fetch`.

Cover:

- Parses Google Docs URL and calls export endpoint.
- Parses Drive file URL and calls media endpoint for binary files.
- Parses raw file ID.
- Applies `options.exportMimeType`.
- Returns `FetchedResource` with bytes, media type, revision, and sanitized
  metadata.
- Fails before network access when token is missing.
- Handles 401, 403, 404, and unsupported export errors.

Update registry tests so a `google-drive` connector can be registered and
resolved, instead of only asserting that the type is unknown.

## Verification

Run:

```bash
pnpm exec vitest run test/connectors/google-drive.test.ts test/connectors/registry.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```

Expected:

- Connector tests pass without network access.
- Full test suite passes.
- Type checking passes.
- Build succeeds.

