# Draft Spec Generation Tech Design

## Goal

Convert messy intake into a persisted structured draft spec without allowing
implementation to start before approval.

## Design

### Draft Generator

Add `src/spec-artifacts/draft.ts`.

The deterministic generator accepts:

- `prompt`
- `text`
- `github-issue`

It emits:

- `title`
- structured Markdown spec
- source metadata

The output includes `Status: draft` and `Source:` metadata near the top, then
uses the structured spec sections introduced by #103. The first slice keeps the
content conservative and adds open questions instead of inventing details.

### Task Persistence

Extend legacy dev task records with optional:

- `specStatus?: "draft" | "approved"`
- `source?: { type, uri?, title? }`

`createTask()` accepts an initial status/spec status for generated drafts.
Draft generation writes:

- `.nitely/tasks/<id>/spec.md`
- `.nitely/tasks/<id>/tech-design.md` with a pending-design placeholder
- `.nitely/tasks/<id>/task.json`

### Web API

Add `POST /api/draft-specs`.

Request examples:

```json
{ "sourceType": "prompt", "prompt": "Add repo import from GitHub URL" }
```

```json
{ "sourceType": "github-issue", "issue": "https://github.com/Instask/nitely/issues/111" }
```

The server accepts an optional injected GitHub issue fetcher for tests. The
default fetcher uses GitHub's public issue API through `fetch`.

### Approval Blocking

Update legacy task run start so `status: "draft"` or `specStatus: "draft"`
throws before `runFlow()`.

## Validation

Add unit tests for the generator and Web API tests for prompt intake, GitHub
issue intake, artifact persistence, and draft run blocking.

## Rollback

Revert the PR. Existing ready tasks are unaffected.
