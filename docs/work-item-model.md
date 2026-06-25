# Work Item Model

This page describes Nitely's internal/extensibility model. In the Web Console
and user-facing API, use **Task** for the work Nitely should perform. A generic
work item is one stored instance of a flow that can be projected into that task
experience. The flow declares the work item type, its input contracts, and the
typed artifacts and gates its stages produce. The dev PR workflow is just one
built-in work item type (`dev.pr`); it is not the user-facing console
abstraction.

## Concepts

| Concept | Meaning |
| --- | --- |
| Flow | Declares the work item type, input contracts, stages, typed outputs, and gates. |
| Work item | Internal stored instance of a flow. Carries `workItemType` and typed input bindings and is surfaced as a Task. |
| Artifact | A first-class typed output (or input) recorded in the per-run artifact registry. |
| Gate | A flow-declared decision point (an `approval` stage) recorded as a `gate.*` artifact and run event. |

A `WorkItemRecord` carries:

```ts
interface WorkItemRecord {
  id: string;
  title: string;
  status: "draft" | "ready" | "running" | "completed" | "failed";
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

Runs record the originating `workItemId` and `workItemType`, so run-to-work-item
association no longer depends on fixed `spec` / `tech-design` input names. Legacy
runs without `workItemId` fall back to matching declared input binding source
URIs.

## Storage

- Generic work items live in `.nitely/work-items/<id>/work-item.json`.
- The built-in `dev.pr` type continues to live under `.nitely/tasks/<id>/`, and
  legacy task records are projected into `dev.pr` work items at read time. No
  on-disk migration is performed.
- The Web Console canonical routes are `/tasks` and `/tasks/<id>`. `/work-items`
  and `/api/work-items` remain compatibility surfaces for integrations that
  already speak the generic model.

## Governance

High-risk work item types cannot be declared by arbitrary flows. A built-in
policy table marks families such as `autofarm.site` and `capital-autopilot.*` as
high-risk and lists the gate stages they must declare. A high-risk type is only
accepted when:

1. it is present in the repository allow-list `.nitely/work-item-policy.json`:

   ```json
   { "allowedTypes": ["autofarm.site"] }
   ```

2. its flow declares every required gate stage.

`dev.pr` is the safe built-in and is always allowed. Unknown types default to
non-high-risk and are accepted, keeping the model open for extension.

## Mapping examples

### `dev.pr` — spec to reviewed pull request

```text
spec + tech-design -> implementation -> test-report -> review -> change-request
```

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": { "name": "implement-spec", "workItemType": "dev.pr" },
  "spec": {
    "stages": [
      { "id": "implement", "type": "agent", "runtime": "codex", "prompt": "Implement the spec.",
        "inputs": ["spec", "tech-design"], "outputs": ["implementation"] },
      { "id": "test", "type": "command", "command": "pnpm test", "inputs": ["implementation"], "outputs": ["test-report"] },
      { "id": "publish", "type": "publish-change", "provider": "github", "inputs": ["implementation", "test-report"] }
    ]
  }
}
```

When `workItemType` is omitted it defaults to `dev.pr`, so every existing dev
flow keeps working unchanged.

### `autofarm.site` — keyword demand to deployed site

```text
discover -> plan -> approve plan -> generate -> preview -> approve preview -> deploy
```

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": {
    "name": "autofarm-site-pipeline",
    "workItemType": "autofarm.site",
    "inputs": [{ "id": "seed", "type": "keyword-seed" }]
  },
  "spec": {
    "stages": [
      { "id": "discover", "outputs": [{ "id": "keyword-set", "type": "seo.keyword-set" }], "inputs": ["seed"], "type": "command", "command": "..." },
      { "id": "plan", "outputs": [{ "id": "site-plan", "type": "autofarm.site-plan" }], "type": "command", "command": "..." },
      { "id": "approve-plan", "type": "approval", "prompt": "Approve the site plan" },
      { "id": "generate", "outputs": [{ "id": "site-bundle", "type": "web.static-site" }], "type": "command", "command": "..." },
      { "id": "preview", "outputs": [{ "id": "preview-report", "type": "qa.preview-report" }], "type": "command", "command": "..." },
      { "id": "approve-preview", "type": "approval", "prompt": "Approve the preview" },
      { "id": "deploy", "outputs": [{ "id": "deployment", "type": "deploy.record" }], "type": "command", "command": "..." }
    ]
  }
}
```

`autofarm.site` is high-risk: it must be allow-listed and must declare the
`approve-plan` and `approve-preview` gate stages. Each gate is recorded as a
`gate.approval` artifact so plan and preview approval cannot be skipped silently.

### `capital-autopilot.research` — evidence to research signal

```text
research-engine -> skeptic review -> investment committee -> risk-manager -> paper-broker
```

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": {
    "name": "capital-autopilot-research",
    "workItemType": "capital-autopilot.research",
    "inputs": [{ "id": "research-task", "type": "capital.research-task" }]
  },
  "spec": {
    "stages": [
      { "id": "research", "outputs": [{ "id": "research-report", "type": "capital.research-report" }], "inputs": ["research-task"], "type": "command", "command": "..." },
      { "id": "skeptic", "outputs": [{ "id": "skeptic-review", "type": "capital.skeptic-review" }], "type": "command", "command": "..." },
      { "id": "risk-manager", "type": "approval", "prompt": "Risk manager review before any executable intent" },
      { "id": "paper-broker", "outputs": [{ "id": "paper-order", "type": "capital.paper-order" }], "type": "command", "command": "..." }
    ]
  }
}
```

`capital-autopilot.*` is high-risk and paper-only: it must be allow-listed and
must declare the `risk-manager` gate before any executable artifact. Research
stages produce evidence-bearing artifacts (`capital.research-report`,
`capital.skeptic-review`) and the default broker artifact is a paper order, never
a live trade.
