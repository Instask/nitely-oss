# Web Console Support For User-Defined Flows Tech Design

Spec: `specs/issues/063-web-console-user-flows-spec.md`

## Design

### Module layout

```text
src/flow/load.ts          # extract parseFlowDocument(content, options)
src/flows/store.ts        # FlowStore over SQLite (.nitely/flows.db)
src/flows/validate.ts     # validateFlowDocument -> { valid, errors, warnings }
src/flows/templates.ts    # built-in flow templates
src/web/flows.ts          # list/detail aggregation (builtin + user, recent runs)
src/web/server.ts         # /api/flows* endpoints
src/web/static/console.dc.html  # Flows list / detail / editor views
src/run/run-flow.ts       # flowDocument source seam
src/run/project.ts        # surface recorded flowDocument
src/work-items/create.ts  # accept flowId
src/work-items/types.ts   # WorkItemRecord.flowId
```

### 1. parseFlowDocument extraction (src/flow/load.ts)

Split the existing `loadFlow` body:

```ts
export function parseFlowDocument(content: string, options: LoadFlowOptions = {}): LoadedFlow {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new FlowValidationError([`flow is not valid JSON: ${...}`]);
  }
  const parsed = flowSchema.safeParse(document);
  if (!parsed.success) { throw new FlowValidationError(...); }
  return { flow: parsed.data, graph: validateGraph(parsed.data, new Set(options.externalInputs ?? [])) };
}

export async function loadFlow(path, options = {}) {
  return parseFlowDocument(await readFile(path, "utf8"), options);
}
```

No behavior change for existing callers; the JSON/schema/graph logic moves
verbatim into `parseFlowDocument`.

### 2. FlowStore (src/flows/store.ts)

Mirror `EventStore`. SQLite at `.nitely/flows.db`:

```sql
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  work_item_type TEXT,
  document TEXT NOT NULL,
  owner_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
```

API: `createFlow`, `getFlow`, `listFlows`, `updateFlow`, `deleteFlow`. Ids are
generated (`flow-<uuid>`) and validated with the existing id pattern. `document`
is the raw JSON text. A module-level helper `openFlowStore(repoPath)` resolves the
db path and returns a `FlowStore` (callers close it), matching how runs/web open
`EventStore`.

### 3. validateFlowDocument (src/flows/validate.ts)

```ts
export interface FlowValidationReport { valid: boolean; errors: string[]; warnings: string[]; }
export async function validateFlowDocument(repoPath: string, content: string): Promise<FlowValidationReport>;
```

- Run `parseFlowDocument(content, { externalInputs: declaredInputIds })`. Collect
  `FlowValidationError.errors` into `errors`. `declaredInputIds` come from
  `metadata.inputs[].id` so unknown-input checks pass for declared inputs.
- If parse succeeds, run `assertWorkItemTypeAllowed({ repoPath, workItemType, flow })`
  and translate a thrown `WebInputError` into an `errors` entry (the save-time
  hard block).
- `warnings`: advisory checks that do not block (e.g. no declared
  `metadata.inputs` while a stage consumes an external input).

### 4. Runtime flow source seam (src/run/run-flow.ts, project.ts)

- `RunFlowInput` gains `flowDocument?: string`.
- In `runFlow`, replace `const loaded = await loadFlow(input.flowPath, {...})` with
  a resolver: `input.flowDocument ? parseFlowDocument(input.flowDocument, {...}) : await loadFlow(input.flowPath, {...})`.
- The `run.created` event payload records `flowDocument` when present.
- `project.ts` `ProjectedRun` gains `flowDocument?`; projection reads it from
  `run.created`.
- In `resumeRun`, resolve the flow from `projection.flowDocument` when present,
  else `loadFlow(projection.flowPath)`.

`flowPath` stays required on `RunFlowInput` for built-ins (used for branch names,
evidence, and the existing rework path). For user flows the caller passes a stable
synthetic `flowPath` label (the store id) plus the `flowDocument`.

### 5. WorkItem flow reference (src/work-items)

- `WorkItemRecord` gains optional `flowId`. `CreateFlowWorkItemInput` accepts
  `flowId?` as an alternative to `flowPath`.
- `createFlowWorkItem`: when `flowId` is set, load the document from `FlowStore`,
  `parseFlowDocument` it, run governance, and persist the work item with `flowId`
  (and a `flowPath` label of the store id for display/branching). Otherwise the
  existing `flowPath` path is unchanged.

### 6. Web run-start (src/web/server.ts)

`POST /api/work-items/:id/runs` resolves the flow source from the work item:

- `flowId` present → load document from `FlowStore`, pass `flowDocument` +
  a `flowPath` label to the runner.
- else → existing `resolveTaskFlowPath` + `flowPath`.

### 7. /api/flows endpoints (src/web/server.ts, src/web/flows.ts)

`src/web/flows.ts` aggregates:

- `listFlowViews(repoPath)`: built-in flows by reading `flows/*.json`
  (parse each, `source: "builtin"`, id = repo-relative path) + user flows from
  `FlowStore` (`source: "user"`). Each view: `id`, `name`, `workItemType`,
  `stageCount`, `runnable` (valid + governance-clean), `source`.
- `getFlowView(repoPath, id)`: detail with metadata, stages, inputs, outputs,
  gates, and recent runs associated by `flowId`/`flowPath`.

Endpoints in `server.ts`, following the `/api/work-items` patterns
(`requireUserContext`, `sendJson`, `requireObject`):

- `GET /api/flows`, `GET /api/flows/:id`
- `POST /api/flows/validate` (body `{ document }` → report; no persistence)
- `POST /api/flows` (validate → hard block → `FlowStore.createFlow`)
- `PUT /api/flows/:id`, `DELETE /api/flows/:id` (user flows only; reject ids that
  resolve to built-ins)
- `GET /api/flows/templates`

`FlowValidationError` already maps to a 400 via `sendError`; governance
`WebInputError` maps to its status. Invalid create/edit returns the report with a
422/400 so the editor can show errors.

### 8. Templates (src/flows/templates.ts)

A static array of `{ id, name, description, document }` for dev PR, rework PR,
approval pipeline, and research pipeline. `document` is a valid flow JSON string
that passes `validateFlowDocument`.

### 9. SPA (src/web/static/console.dc.html)

Add `flows` and `flow-detail`/`flow-editor` views to the existing SPA:

- Nav entry "Flows" with a count.
- Flows list: built-in (read-only badge) + user flows, with type and stage count.
- Flow detail: metadata, stage list, inputs/outputs/gates, recent runs, Edit
  (user) / Run buttons.
- Flow editor: template picker, a JSON `<textarea>`, a live validation panel
  (debounced `POST /api/flows/validate`), a stage-list preview, Save (user flows).
- Run: a form built from the flow's declared `metadata.inputs`, posting to
  `POST /api/work-items` with `flowId`/`flowPath`.

Routing: `/flows`, `/flows/:id`, `/flows/new`. Mirror the existing
`routeFromPath`/`pathForRoute` and computed `viewData` patterns.

## Integration

- `src/flow/load.ts` — `parseFlowDocument` export.
- `src/flows/*` — new store, validation, templates.
- `src/run/run-flow.ts`, `project.ts` — `flowDocument` seam.
- `src/work-items/create.ts`, `types.ts`, `store.ts` — `flowId`.
- `src/web/flows.ts`, `server.ts` — aggregation + endpoints.
- `src/web/static/console.dc.html` — Flows views.

## Verification

- Unit tests:
  - `parseFlowDocument` parses/validates from content; `loadFlow` still reads
    files and behaves identically (existing flow tests stay green).
  - `FlowStore` CRUD round-trips; id validation.
  - `validateFlowDocument`: valid flow → `{ valid: true }`; schema error, duplicate
    stage id, and high-risk-without-gate → errors.
  - run a flow via `flowDocument` end to end without a flow file; `run.created`
    records the document; resume re-parses it.
  - `createFlowWorkItem` with `flowId` loads from store and persists `flowId`.
  - `/api/flows` lists built-in + user flows; `POST /api/flows/validate` reports
    errors; create rejects an invalid flow; run a user flow from `/api/work-items`.
  - SPA static assertions for the Flows views/routes.
- Existing suite stays green; `pnpm check` and `pnpm build` clean; browser smoke
  of the Flows surface.
