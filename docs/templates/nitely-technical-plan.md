# Technical Plan: Repository Import

## Summary

- **Trace:** US-001, FR-001, FR-002, SC-001
- **Approach:** Add a repository import service that validates GitHub HTTPS
  URLs, clones into a managed directory, and records import metadata for later
  run selection.

## Technical Context

- **Language / runtime:** TypeScript, Node.js 24
- **Dependencies:** Existing `git` CLI; no new npm dependencies
- **Storage:** `.nitely/repositories.json`
- **Target platform:** Local Nitely host
- **Testing:** Vitest unit tests and web API tests

## Files / Modules Touched

- `src/web/repositories.ts`: repository import API
- `src/repositories/store.ts`: repository metadata persistence
- `src/repositories/import.ts`: URL validation and clone orchestration
- `test/web/repositories.test.ts`: API coverage

## Data Model Or Schema Changes

- **PD-001:** Add `RepositoryRecord { id, url, localPath, status, createdAt,
  updatedAt, lastError? }`.
- **Compatibility:** Existing runs keep using explicit `--repo` paths.

## Flow / API / CLI Contract Changes

- **PD-002:** Add `POST /api/repositories/import` with `{ url }` and return the
  created or existing repository record.
- **PD-003:** Keep CLI behavior unchanged for this slice.

## Failure Modes And Recovery Behavior

- Invalid URLs return a 400 with a user-readable error.
- Git clone failures create a failed import record with `lastError`.
- Duplicate URLs return the existing record instead of cloning again.

## Compatibility And Migration Plan

- No migration is required for existing local-only runs.
- Existing Web Console repository selection continues to support manually
  configured repository roots.

## Test Strategy

- **SC-001:** Unit-test valid and invalid URL parsing.
- **SC-002:** Web API test covers clone failure and no partial successful
  record.
- **SC-003:** Regression test existing run creation with explicit repo path.

## Constitution Check

- **Conflict:** none.
- **Evidence:** Code and repository credentials remain on the customer host.
- **Secrets:** Error messages must not include tokens or credential helpers.

## Complexity Tracking

- **PD-001**
  - **Complexity introduced:** A persisted repository record store.
  - **Simpler alternative rejected:** Keeping imported repositories only in
    memory.
  - **Reason:** Future runs need stable repository IDs across server restarts.
- **PD-002**
  - **Complexity introduced:** An import API endpoint.
  - **Simpler alternative rejected:** Requiring operators to clone manually.
  - **Reason:** Paste-to-import is the primary repository onboarding workflow.
