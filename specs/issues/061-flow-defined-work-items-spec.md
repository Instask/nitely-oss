# Issue #61 Spec: Flow-Defined Work Items With Typed Artifacts

## Scope

Generalize Nitely's Web task model from a dev-only abstraction into a generic,
flow-defined **work item** model with typed artifacts and flow-declared gates.

The current dev PR flow becomes one built-in work item type (`dev.pr`) backed by
an adapter, rather than the core abstraction.

Do not migrate existing on-disk task records; old records map to `dev.pr` work
items lazily at read time. Do not change agent runtime behavior, retry policy,
or PR publishing semantics.

## Problem

Nitely treats a Web task as a development task:

- `TaskRecord` requires `specPath` and `techDesignPath`.
- Task creation requires `spec` and `techDesign` text.
- Run-to-task association is inferred by matching fixed `spec` / `tech-design`
  input source URIs.
- The Web Console only renders dev tasks with a spec / tech-design view.

This is too narrow. A `dev task` should be one built-in task type, not the core
abstraction. Task types should be declared by flows, because different workflows
produce different artifact families and require different gates. Adjacent repos
(`autofarm` content pipeline, `capital-autopilot` research/paper-trading engine)
produce artifact families and gates that do not fit a spec + tech-design shape.

## Goals

1. Introduce a generic `WorkItemRecord` that carries `workItemType` and
   arbitrary typed input bindings instead of fixed `specPath` / `techDesignPath`.
2. Move fixed `specPath` / `techDesignPath` into a `dev.pr` work item adapter.
3. Let flows declare `workItemType` and input contracts in flow metadata, reusing
   the existing typed artifact output contracts from issue #36.
4. Associate runs with work items by an explicit `workItemId` (with input-binding
   fallback), not by fixed `spec` / `tech-design` input names.
5. Represent approval/gate stages as first-class typed artifacts and run events.
6. Enforce governance for high-risk work item types via a built-in policy table
   plus a repository allow-list.
7. Render a generic Work Item list and typed-artifact browser in the Web Console,
   keeping the existing dev task view as a type-specific view.
8. Keep existing dev task creation, existing dev PR flows, tests, and the
   `/api/tasks*` endpoints backward-compatible.

## Work Item Model

```ts
type WorkItemStatus = "draft" | "ready" | "running" | "completed" | "failed";

interface WorkItemRecord {
  id: string;
  title: string;
  status: WorkItemStatus;
  workItemType: string;                       // e.g. "dev.pr", "autofarm.site"
  flowPath: string;
  inputs: Record<string, ResourceReference>;  // typed input bindings
  issueUrl?: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
}
```

- `ResourceReference` is the existing `{ connector, uri }` shape already used for
  run inputs, so a non-dev flow can bind `{ seed: { connector: "local-file",
  uri: "..." } }` with no `spec` or `tech-design`.
- New work items persist to `.nitely/work-items/<id>/work-item.json`.
- `workItemType` and input binding keys are validated with the existing flow
  identifier pattern.

### dev.pr adapter and backward compatibility

- A `dev.pr` adapter owns `specPath` / `techDesignPath`. On creation it writes
  `spec.md` / `tech-design.md` and registers them as `inputs.spec` and
  `inputs["tech-design"]`.
- The adapter exposes a `TaskRecord` / `TaskDetail` projection so the existing
  `createTask`, `getTaskDetail`, and `/api/tasks*` surfaces keep their shape.
- Existing `.nitely/tasks/<id>/task.json` records are mapped lazily at read time
  to `workItemType: "dev.pr"` work items. No on-disk migration is performed, and
  legacy task records remain readable and runnable.

## Flow Contract

Flow metadata gains optional work item declarations. Existing flows stay valid:
an absent `workItemType` defaults to `dev.pr`.

```json
{
  "metadata": {
    "name": "autofarm-site-pipeline",
    "workItemType": "autofarm.site",
    "inputs": [{ "id": "seed", "type": "keyword-seed" }]
  },
  "spec": {
    "stages": [
      { "id": "discover", "outputs": [{ "id": "keyword-set", "type": "seo.keyword-set" }] },
      { "id": "plan", "outputs": [{ "id": "site-plan", "type": "autofarm.site-plan" }] },
      { "id": "approve-plan", "type": "approval", "prompt": "Approve the site plan" },
      { "id": "generate", "outputs": [{ "id": "site-bundle", "type": "web.static-site" }] },
      { "id": "preview", "outputs": [{ "id": "preview-report", "type": "qa.preview-report" }] },
      { "id": "approve-preview", "type": "approval", "prompt": "Approve the preview" },
      { "id": "deploy", "outputs": [{ "id": "deployment", "type": "deploy.record" }] }
    ]
  }
}
```

- `metadata.workItemType` is an optional identifier.
- `metadata.inputs` is an optional array of `{ id, type? }` input contracts.
- Stage typed-artifact output contracts are unchanged from issue #36.

The built-in dev PR flow maps to:

```text
spec + tech-design -> implementation -> test-report -> review -> change-request
```

## Run Association

- `RunFlowInput` gains optional `workItemId` and `workItemType`, persisted into
  `run.json` and projected into run state.
- A run is associated with a work item when `run.workItemId === workItem.id`.
  When `workItemId` is absent (legacy runs), association falls back to matching
  declared input binding source URIs — not the hardcoded `spec` /
  `tech-design` keys.
- The Web Console run-start path passes the work item's `inputs` and
  `workItemId`, instead of hardcoded `spec` / `tech-design` references.

## Gates As First-Class Artifacts

- An `approval` stage produces a `gate` artifact (`type: "gate.approval"`) into
  the per-run artifact registry and records a corresponding run event.
- The gate artifact captures gate id, state (`pending` / `approved` /
  `rejected`), decision actor when known, and timestamp.
- Projected run state and the Web Console expose gates as structured entries,
  not just log lines.

## Governance

- A built-in policy table declares known work item types. `dev.pr` is allowed by
  default and not high-risk. `autofarm.site` and `capital-autopilot.*` are marked
  `highRisk` and declare `requiredGates`:
  - `autofarm.site` requires `approval` stages for plan approval and preview
    approval before a deploy stage.
  - `capital-autopilot.*` requires a risk-manager gate before any executable
    artifact and preserves paper-only defaults.
- An optional repository file `.nitely/work-item-policy.json` provides an
  `allowedTypes` allow-list.
- Creating or running a high-risk work item type is rejected unless: (a) the type
  appears in the allow-list, and (b) the flow declares the gate stages the policy
  table requires. Violations raise a validation error at creation / flow load.
- Unknown (unlisted) types default to non-high-risk and are accepted, keeping the
  model open for extension. High-risk types always go through strict gating.

## Web Console

- New endpoints `GET /api/work-items` and `GET /api/work-items/:id` list work
  items of any type and return `workItemType`, `inputs`, associated runs, and an
  aggregated typed-artifact view collected from each run's `artifacts.json`.
- The UI gains a generic Work Item list plus a typed-artifact browser: artifacts
  grouped by `type`, showing `path` / `sourceUri` / `mediaType`, and gate state.
- The `dev.pr` type keeps its existing spec / tech-design view as a
  type-specific view.
- Existing `/api/tasks*` endpoints and the existing task UI remain.

## Documentation

`docs/` gains a section mapping `dev.pr`, `autofarm.site`, and a
`capital-autopilot.research` flow into the same work item model, with example
flow JSON for each. The README current-status list is updated.

## Acceptance Criteria

- A non-dev flow can create and run a work item without `spec` or `tech-design`
  inputs.
- The Web Console can display generic work items and their typed artifacts.
- Existing dev task creation and existing dev PR flows keep working.
- Run association no longer depends on fixed `spec` / `tech-design` input names.
- Flow metadata can declare a work item type and artifact contracts.
- Approval/gate stages are represented as first-class artifacts/events.
- Documentation explains how `dev.pr`, `autofarm.site`, and a
  `capital-autopilot` research flow map into the same model.
- Existing tests pass and new behavior is covered by tests.

## Out Of Scope

- On-disk migration of legacy task records.
- Cryptographic signing of flow sources (allow-list is the trust mechanism).
- Building actual `autofarm` or `capital-autopilot` flows; only their mapping is
  documented.
- Changes to agent runtimes, retry policy, or PR publishing semantics.
