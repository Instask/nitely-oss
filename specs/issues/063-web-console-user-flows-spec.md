# Issue #63 Spec: Web Console Support For User-Defined Flows

## Scope

Follow-up to #61 (work item model) and #62 (harness/policy). Add a first-class
Web Console surface for creating, editing, validating, and running custom flows,
so flow-defined work item types are usable from the page instead of being a
file-only power-user feature.

Built-in repository flows under `flows/` remain read-only in the UI. User-defined
flows are stored in a local database and run without being materialized to a flow
file. No visual DAG builder is required for this version.

This issue builds on `master` and does not depend on the in-flight #62 branch.

## Problem

Today flows are repository JSON files under `flows/`, and the task creation
experience is oriented around the built-in dev flow. Users cannot define a new
flow type from the page, inspect its contracts, or know whether a flow is
runnable before starting a work item. Flow loading is also coupled to files: the
runtime reads a flow path, parses it, and builds the artifact graph. The parse
and graph build actually only need the flow document, not a file.

## Decisions

- **Format**: JSON only. No YAML.
- **Storage**: user-defined flows are stored in a local SQLite database
  (`.nitely/flows.db`), not as repository files and not committed to Git.
- **Permission**: any logged-in user may create, edit, and run flows. Local mode
  is unrestricted.
- **Policy timing**: a high-risk flow that omits a required gate is hard-blocked
  at save time, not only at run time.

## Flow Loading Decoupled From Files

Extract `parseFlowDocument(content, options)` from `loadFlow`:

- `parseFlowDocument(content, options)` parses JSON, validates against
  `flowSchema`, and builds/validates the artifact graph — all from the document
  string. No file access.
- `loadFlow(path, options)` becomes "read file → `parseFlowDocument`", so every
  existing caller keeps its behavior.

The artifact DAG is derived from the parsed document; files were never essential.

## Flow Storage: FlowStore

A `FlowStore` over SQLite (`.nitely/flows.db`), mirroring `EventStore`:

```text
flows(id, name, work_item_type, document TEXT, owner_id, created_at, updated_at)
```

CRUD: create, get, list, update, delete. `document` is the flow JSON text.

## Runtime Flow Source Seam

So a database flow runs without being written to a file:

- `RunFlowInput` gains optional `flowDocument?: string`. `runFlow` resolves the
  flow: when `flowDocument` is present it calls `parseFlowDocument(flowDocument)`,
  otherwise `loadFlow(flowPath)` (built-in repo flows).
- The `run.created` event records `flowDocument` when present, so resume and
  audit have the exact flow that ran. `resumeRun` re-parses the recorded document
  when present, otherwise falls back to `loadFlow(projection.flowPath)`.
- `WorkItemRecord` gains optional `flowId`. `createFlowWorkItem` accepts either a
  built-in `flowPath` or a user `flowId`; for `flowId` it loads the document from
  `FlowStore`, validates, and records the reference. The web run-start path passes
  `flowDocument` (resolved from `flowId`) for user flows and `flowPath` for
  built-ins.

## Validation

`validateFlowDocument(repoPath, content)` returns
`{ valid: boolean, errors: string[], warnings: string[] }`:

- `errors`: JSON parse failures, `flowSchema` violations, duplicate stage ids,
  duplicate artifact producers, unknown input artifacts, unsupported stage
  types/runtimes (all via `parseFlowDocument`), and governance hard blocks (a
  high-risk `workItemType` that is not allow-listed or omits a required gate, via
  `assertWorkItemTypeAllowed`).
- `warnings`: non-blocking advisories (e.g. a flow declares no stages metadata
  that downstream UI would surface).

The same logic backs the editor's live validation panel and the save/run guard.
A flow with any `errors` cannot be saved or run.

## API

- `GET /api/flows` — built-in flows (read from `flows/*.json`, `source: "builtin"`)
  plus user flows (`source: "user"`), each with `id`, `name`, `workItemType`,
  `stageCount`, `runnable`.
- `GET /api/flows/:id` — flow detail: metadata, stages, inputs, outputs, gates,
  and recent runs. Built-in ids are the repo-relative path; user ids are the
  store id.
- `POST /api/flows/validate` — validate a flow document body without persisting.
- `POST /api/flows` — create a user flow (validate, hard-block on errors, store).
- `PUT /api/flows/:id` — edit a user flow (validate, hard-block, store). Built-in
  flows are not editable.
- `DELETE /api/flows/:id` — delete a user flow.
- `GET /api/flows/templates` — known templates: dev PR, rework PR, approval
  pipeline, research pipeline.
- Running a flow reuses `POST /api/work-items`, which accepts a built-in
  `flowPath` or a user `flowId`.

## Web Console

A Flows surface in the SPA (no DAG builder):

```text
Flows (list: built-in + user)
  -> New Flow (choose template or blank)
  -> JSON editor with a live validation panel
  -> stage list preview
  -> Save (user flows only)
  -> Run: create a work item from this flow, filling declared input fields
```

Built-in flows show as read-only. The validation panel shows errors/warnings
before save or run.

## Acceptance Criteria

- Web Console lists repository flows from `flows/`.
- User can create a new flow from at least one template.
- User can edit and save a user flow from the page.
- Flow validation errors are shown before save/run.
- User can start a work item from a selected flow using the flow's declared
  inputs.
- Existing built-in dev flows remain visible and runnable.
- No visual DAG builder is required.
- Existing flows, runs, and tests stay backward-compatible.

## Backward Compatibility

- `parseFlowDocument` extraction keeps `loadFlow` behavior identical for existing
  callers.
- `flowDocument` and `flowId` are optional; runs without them use `flowPath` as
  today.
- Built-in flows and existing work item / run flows are unchanged.

## Out Of Scope

- YAML support.
- Visual DAG / node-graph builder.
- Saving flows as repository files or opening PRs for flow edits.
- Org-level flow sharing or flow versioning history.
- Admin-only restrictions (any logged-in user may manage flows).
