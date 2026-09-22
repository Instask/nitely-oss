# Flow-Defined Work Items With Typed Artifacts Tech Design

Spec: `specs/issues/061-flow-defined-work-items-spec.md`

## Design

### Module layout

```text
src/work-items/
  types.ts              # WorkItemRecord, WorkItemStatus, ResourceReference re-export
  store.ts              # generic .nitely/work-items/<id>/work-item.json CRUD
  adapters/
    dev-pr.ts           # dev.pr adapter: spec/tech-design <-> WorkItemRecord + TaskRecord projection
  policy.ts             # built-in work item type policy table
  governance.ts         # allow-list load + high-risk validation
```

The generic store has one purpose: persist and read `WorkItemRecord` values by
id. It depends only on the filesystem and `WebInputError` / `WebNotFoundError`.

The dev.pr adapter is the only place that knows about `spec.md` /
`tech-design.md`. It depends on the store and on the legacy task layout. The web
task surface (`src/web/tasks.ts`) becomes a thin compatibility wrapper over the
adapter so `createTask` / `getTaskDetail` keep their current signatures.

### WorkItemRecord and the store

`store.ts` exposes:

```ts
createWorkItem(repoPath, record): Promise<WorkItemRecord>      // validates id/type, atomic write
getWorkItem(repoPath, id): Promise<WorkItemRecord>             // WebNotFoundError on miss
listWorkItems(repoPath): Promise<WorkItemRecord[]>             // generic store entries only
updateWorkItem(repoPath, id, patch): Promise<WorkItemRecord>   // status/latestRunId/changeRequestUrl
```

Storage path `.nitely/work-items/<id>/work-item.json`. Reuses the existing
`writeJsonAtomic`, `validateTaskId` (renamed conceptually to id validation; the
same `[A-Za-z0-9][A-Za-z0-9_-]{0,127}` pattern), and repo-relative flow path
validation, all lifted from `tasks.ts` into a shared helper or imported.

`workItemType` is validated with the flow `identifierSchema` pattern.

### dev.pr adapter and legacy mapping

`adapters/dev-pr.ts`:

- `createDevPrWorkItem(repoPath, input, options)` — writes `spec.md` /
  `tech-design.md` under the work item directory, builds a `WorkItemRecord` with
  `workItemType: "dev.pr"` and `inputs.spec` / `inputs["tech-design"]` bound to
  those files, persists via the store.
- `devPrTaskProjection(record)` — derives the legacy `TaskRecord`
  (`specPath` / `techDesignPath` from `inputs`) so existing API responses keep
  shape.
- `legacyTaskToWorkItem(taskRecord)` — maps an old `.nitely/tasks/<id>/task.json`
  into a `dev.pr` `WorkItemRecord` at read time. No disk migration.

`listWorkItemsUnified(repoPath)` (in the adapter/aggregation layer) merges
generic store work items with lazily-mapped legacy task records, deduplicated by
id, sorted by `createdAt` descending.

`src/web/tasks.ts` keeps `TaskRecord`, `createTask`, `getTask`, `getTaskDetail`,
`listTasks`, `updateTaskRunState` as wrappers:

- `createTask` delegates to `createDevPrWorkItem` and returns the task
  projection. The on-disk `.nitely/tasks/<id>/` layout is preserved for the
  dev.pr type so legacy tooling and `taskIdFromInputs` source-URI parsing keep
  working — the adapter writes to `.nitely/tasks/<id>/` for `dev.pr` and exposes
  it as a work item, rather than introducing a parallel directory for the
  built-in type.
- `getTask` / `listTasks` read legacy records as today (unchanged path), so no
  behavior regression for existing tasks.

Decision: `dev.pr` continues to live under `.nitely/tasks/`; only *new non-dev*
types use `.nitely/work-items/`. This keeps `taskId` source-URI matching and all
current tests intact while still routing everything through the work item model.

### Flow metadata

`src/flow/schema.ts`: extend `flowSchema.metadata`:

```ts
metadata: z.object({
  name: z.string().min(1),
  workItemType: identifierSchema.optional(),
  inputs: z.array(z.object({
    id: identifierSchema,
    type: identifierSchema.optional(),
  })).optional(),
})
```

Helper `flowWorkItemType(flow): string` returns `metadata.workItemType ?? "dev.pr"`.
Existing flows without the fields stay valid (defaults to `dev.pr`).

### Run association

`src/run/run-flow.ts`:

- `RunFlowInput` gains optional `workItemId?: string` and `workItemType?: string`.
- The `run.json` writer (around line 2428) and the resumed-run writer (line 3055)
  include `workItemId` / `workItemType`.

`src/web/runs.ts`:

- `WebRunSummary` gains `workItemId?` / `workItemType?`; `asRunSummary` and the
  projection path read them from the record (falling back to legacy `taskId`).
- `taskIdFromInputs` stays as the legacy fallback only.

`src/web/work-items.ts` (existing view layer): `runMatchesTask` becomes
`runMatchesWorkItem`, preferring `run.workItemId === workItem.id`, then falling
back to matching declared input binding source URIs (generic, not the hardcoded
`spec` / `tech-design` keys).

`src/web/server.ts` run-start path: build `inputs` from `workItem.inputs`
directly and pass `workItemId` / `workItemType` to the runner, replacing the
hardcoded `{ spec, "tech-design" }` block.

### Gates as first-class artifacts

The approval stage executor in `run-flow.ts` emits a gate artifact:

```ts
{
  id: "<stageId>",
  type: "gate.approval",
  producer: "<stageId>",
  mediaType: "application/vnd.nitely.gate+json",
  // gate payload
}
```

with payload `{ gateId, state: "pending"|"approved"|"rejected", actor?, decidedAt? }`.
The artifact is merged into the run artifact registry (`writeArtifactRegistry`)
and a matching run event is recorded so projected run state surfaces gates. The
existing approval stage semantics (it currently records an approval event) are
preserved; this adds the typed artifact + registry entry alongside.

### Governance

`policy.ts` — built-in table:

```ts
interface WorkItemTypePolicy {
  type: string;            // exact or "prefix.*"
  highRisk: boolean;
  requiredGates: string[]; // approval stage ids that must be present
  paperOnly?: boolean;
}
```

Entries: `dev.pr` (not high-risk); `autofarm.site` (highRisk, requiredGates
`["approve-plan", "approve-preview"]`); `capital-autopilot.*` (highRisk,
requiredGates `["risk-manager"]`, `paperOnly: true`). Prefix match via `.*`.

`governance.ts`:

- `loadWorkItemPolicy(repoPath)` reads optional `.nitely/work-item-policy.json`
  → `{ allowedTypes: string[] }` (missing file → empty allow-list).
- `assertWorkItemTypeAllowed(repoPath, workItemType, flow)`:
  - resolve the policy table entry (exact then prefix);
  - if `highRisk`: require `workItemType` in the allow-list, and require every
    `requiredGates` id to exist as an `approval` stage in the flow; otherwise
    throw `WebInputError` (creation) / a flow validation error (load).
  - non-high-risk / unknown types: allowed.

Called from the work item creation path and from the web run-start path.

### Web Console

`src/web/work-items.ts` / new endpoints in `server.ts`:

- `GET /api/work-items` → unified list with `workItemType`, `inputs`, runs,
  aggregated artifacts.
- `GET /api/work-items/:id` → detail with runs and aggregated typed artifacts
  read from each run's `artifacts.json` via `readArtifactRegistry`.
- Artifact aggregation: collect `RunArtifact[]` across the work item's runs,
  group by `type`, dedupe by `(producer,id,runId)`.

`src/web/ui.ts`: add a generic Work Item list and a typed-artifact browser
section (artifacts grouped by type, showing path / sourceUri / mediaType, plus
gate state). `dev.pr` keeps the existing spec / tech-design view.

`/api/tasks*` endpoints and the existing task UI are unchanged.

## Integration

- `src/flow/schema.ts` — metadata fields + `flowWorkItemType` helper.
- `src/run/run-flow.ts` — `RunFlowInput.workItemId/Type`, persisted to `run.json`;
  approval stage emits gate artifact + event.
- `src/web/runs.ts` — `WebRunSummary` gains `workItemId/Type`.
- `src/web/tasks.ts` — wraps the dev.pr adapter; signatures unchanged.
- `src/web/work-items.ts` — `runMatchesWorkItem`, unified listing, artifact
  aggregation.
- `src/web/server.ts` — `/api/work-items*` routes; run-start uses
  `workItem.inputs` + governance assertion.
- `src/web/ui.ts` — generic work item + artifact browser views.
- `flows/*.json` — unchanged (default to `dev.pr`); a doc-only example
  `autofarm.site` flow is added under docs.

## Verification

- New unit tests:
  - `work-items/store` CRUD + id/type validation.
  - dev.pr adapter create + task projection + legacy mapping round-trip.
  - flow schema accepts `workItemType` / `inputs`; defaults to `dev.pr`.
  - run association by `workItemId` and input-binding fallback.
  - approval stage produces a `gate.approval` artifact in the registry.
  - governance: high-risk type rejected without allow-list / without required
    gates; accepted when both satisfied; `dev.pr` always accepted.
  - `/api/work-items` lists generic + legacy items with aggregated artifacts.
  - a non-dev flow runs end to end with no `spec` / `tech-design` inputs.
- Existing tests must pass unchanged (dev task creation, dev PR flow, run
  projection, `/api/tasks*`).
- `pnpm run build`, `pnpm test`, and the repo lint/typecheck gates pass.
