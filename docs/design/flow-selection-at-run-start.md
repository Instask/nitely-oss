# Choosing the Flow and runtime when a run starts

Status: proposal · Refs jerryleooo/nitely#708 (step 6, "Problem B") · Related: jerryleooo/nitely#709, jerryleooo/nitely#710

## Problem

The repository Flow catalog is now canonical (#708 steps 1–5): built-ins are seeded
into the per-repository Flow store, edits and enable/disable live there, the Web API
and CLI are repository-scoped, and `resolveRunFlowSource(repoPath, reference)` is the
single way any CLI execution path turns a reference into a document.

What has not changed is that the **agent runtime is baked into the Flow document**.
Each agent / review-gate stage carries a literal `runtime` (and `model`) string, and the
only way to run the same Flow on another runtime is to copy it. That is why
`flows/implement-spec-bootstrap.json` has `-grok`, `-pi` and `-claude` siblings that
differ only in `runtime`/`model` and in prompts that name the product ("with Grok
Build"). Moving Flows into the store turned "copy a file per runtime" into "copy a row
per runtime" — the drift is the same.

`configurables` cannot fix this: `applyFlowConfigurationTemplate` is applied only to
`stage.prompt` and `stage.command`, never to `runtime` or `model`.

## Goals

1. An operator chooses the runtime (and optionally model) for a run when starting it,
   from CLI, API and Console, without editing or copying the Flow.
2. The Flow document still declares defaults; no override means today's behavior.
3. The exact effective choice is recorded in the run snapshot / reproducibility data.
4. Overrides go through the same validation and preflight as the Flow's own values
   (unknown runtime, invalid model, missing provider credentials).
5. Retire the `implement-spec-bootstrap-{grok,pi,claude}` variants without breaking
   existing work items, runs, or labels that reference them.
6. Share one override mechanism with #709 (model/effort for evaluation) and the
   deferred `--questions` override from #710.

## Non-goals

- Per-run editing of arbitrary stage fields (prompts, commands, DAG shape).
- Automatic runtime routing / cost optimization.
- The `effort` schema field and runtime argv mapping themselves (owned by #709); this
  design only reserves the slot in the shared override object.
- Choosing a *different Flow* at run start for an existing work item (work items keep
  their `flowId` / template lineage; changing it stays an explicit edit).

## Current behavior (main, after #43/#45/#48/#49)

- **Catalog:** `src/flows/catalog.ts` — seeds from repo `flows/` then bundled seeds,
  `resolveCatalogFlow`, enable/disable, reset, edited/upstream-update metadata,
  `flowStoredMetadata()` derives metadata from the stored document.
- **Templates / work items:** template inputs are declared ∪ inferred; work items keep
  `templateId` lineage and `template:<id>` compatibility; `POST /api/work-items`
  authorizes `flowId` against the target repository; disabled Flows block new and
  existing template work.
- **CLI:** `run`, `doctor`, `run-stage`, `rework-pr`, `pr-comments`, `ci-repair` all go
  through `resolveRunFlowSource`; relative references anchor on `repoPath`; edited
  built-ins run as edited; disabled ones are refused; explicit files still work.
- **Repo scoping:** all `/api/flows*` routes go through `flowRequestScope` (query
  `repoId` wins over body `repoId`); Console carries `repoId` in the route.
- **Runtime choice:** stage `runtime`/`model`, plus an optional `runtimes[]` candidate
  list that expresses *fallback* (emits `stage.runtime.fallback`), not operator choice.
- **Question policy (#710):** Flow- and stage-level `questions` policy; run-time
  override was deferred to #709's mechanism.

## Options

### A. Extend configurables to `runtime` / `model`
`"runtime": "{{config.runtime}}"`. Small change, reuses the configuration UI.
Cons: every Flow becomes a template; per-run choice ends up in persisted Flow
configuration; schema validation of `runtime` happens only after substitution; does not
cover `effort` or `questions`. #709 already rejected this for model/effort.

### B. Explicit run-level overrides object (recommended)
A typed `overrides` object supplied at run start and applied on top of the resolved
stored document before preflight. Covers runtime, model, effort (#709) and questions
(#710) with one validation/snapshot path.
Cons: new surface on CLI/API/Console; must define precedence vs `runtimes[]`.

### C. Keep variants, add a "runtime family" grouping in the catalog
Catalog groups `-grok/-pi/-claude` under one entry with a picker.
Cons: keeps the duplication and drift; every new runtime adds N rows. Rejected.

## Recommended design (Option B)

### Data model

```ts
type RunOverrides = {
  runtime?: string;                       // flow-wide
  model?: string;
  effort?: Effort;                        // reserved for #709
  questions?: "ask" | "auto" | "deny";    // #710 deferred override
  stages?: Record<string, {               // per-stage, wins over flow-wide
    runtime?: string; model?: string; effort?: Effort;
  }>;
};
```

- Applies only to agent, judge and review-gate stages; command stages ignore it.
- Precedence per stage: `stages[id]` → flow-wide override → stage field → Flow default.
- `runtimes[]` interaction: an explicit runtime override **replaces** the candidate
  list for that stage (operator choice beats authored fallback). A model-only override
  applies to the primary candidate only. Rationale: silently falling back off an
  explicitly chosen runtime would defeat evaluation (#709).
- Setting `model` without `runtime` keeps the stage's runtime; a model invalid for that
  runtime fails validation.
- Unknown stage ids in `stages` fail validation (no silent typos).

### Application point

One pure function, `applyRunOverrides(document, overrides) → { document, effective }`,
called after `resolveRunFlowSource` / `resolveCatalogFlow` and **before** preflight,
stage extraction and execution, in every entry point (`run`, `run-stage`, `rework-pr`,
`pr-comments`, `ci-repair`, Web task/run creation, scheduler). The stored catalog
document is never mutated.

### Snapshot and lineage

`run.created` already snapshots the document actually executed and its sha256. Add:
- `flow.sourceSha256` — stored/explicit document before overrides;
- `overrides` — the request as given;
- `effective` — per-stage `{ runtime, model, effort? }` after resolution;
- the existing snapshot sha stays the sha of the *post-override* document.

`reproducibility.json` and evidence list the effective per-stage runtime/model. Run
labels remain the Flow label (no runtime suffix), so labels stay stable.

### Surface

- **CLI:** `nitely run <flow> --runtime <id> [--model <id>]`, per-stage
  `--runtime implement=claude` (repeatable); same flags on `run-stage`, `rework-pr`,
  `pr-comments`, `ci-repair`, `task create`. `--questions` lands here too.
  `doctor` accepts the same flags so it checks the same effective document.
- **API:** `POST /api/tasks`, `POST /api/tasks/:id/runs`, `POST /api/work-items`
  (stored as the work item's default overrides) accept `{ "overrides": RunOverrides }`.
  Validation errors return 422 with the same report shape as Flow validation.
- **Work items:** may store default `overrides`; a run request's overrides merge over
  them field-by-field. Retries/reworks reuse the previous run's overrides unless the
  request replaces them.
- **Console:** a "Runtime" picker (default "As defined in Flow") on Run / new task,
  listing runtimes registered on the server with credential status; advanced per-stage
  disclosure. Run detail shows effective runtime/model per stage.

### Validation and preflight

Overrides are validated with the same schema rules as stage fields (`validateModel`,
known runtime registry). Preflight then runs on the effective document, so missing
provider credentials surface as the existing runtime/credential diagnostics — no
separate check. New diagnostic codes: `override-invalid` (bad shape / unknown stage)
and `runtime-unavailable` (runtime not installed/registered). These are distinct from
`flow-invalid`, consistent with the decision to give configuration problems their own
codes (the `verifyCommand` case moves to its own code in the same spirit).

### Permissions

- Starting a run with overrides needs the same permission as starting the run
  (`runs:execute` in the target repository); no Flow-management permission required,
  because the stored Flow is not changed.
- Organizations can restrict the allowed set via an optional repository/org policy
  `allowedRuntimes` (default: all registered). Disallowed → `runtime-not-allowed`.
- **API tokens:** per the decision to let API tokens manage Flows, tokens with
  `flows:manage` can use all `/api/flows*` operations (create/update/enable/reset/
  delete) in repositories the token's owner can write; tokens with run permission can
  pass overrides. Admin-only, interactive-only actions elsewhere are unchanged. All
  token-driven Flow mutations and override use are written to the security audit log
  with the token id.

### Compatibility and migration

1. No overrides → byte-identical effective document → identical behavior and sha.
2. Variants: keep `implement-spec-bootstrap-{grok,pi,claude}` seeds for one release as
   **deprecated aliases**: resolving one yields the base Flow plus an implicit
   `runtime` override (recorded in the snapshot as `aliasOf`). Existing work items,
   CLI invocations and run labels keep working. Customized variant rows are left
   untouched and become ordinary user Flows on removal.
3. Make the base prompts runtime-neutral (drop "with Grok Build" etc.) in the same
   change so the alias is behaviour-equivalent apart from wording.
4. After one release: remove the variant seeds; the catalog shows the upstream seed as
   removed for untouched rows; the aliases resolve with a deprecation warning for one
   more release, then fail with a hint to use `--runtime`.

## Relation to #709

#709 needs exactly this object for `model`/`effort` across a batch of runs; #710
deferred `--questions` to it. Step 6 should **implement the shared `RunOverrides`
mechanism** (types, `applyRunOverrides`, snapshot fields, CLI/API plumbing) with
`runtime`, `model` and `questions`. #709 then adds the `effort` schema field, argv
mapping and `runtime-effort-unsupported`, plugging into the reserved slot. Order:
step 6 core → #709 effort → variant removal.

## Test plan

- Unit: `applyRunOverrides` precedence (stage > flow-wide > field > default),
  `runtimes[]` replacement, model-only override, unknown stage id, non-agent stages
  ignored, no-override identity (same sha).
- Preflight: override to runtime without credentials → existing credential
  diagnostic; unknown runtime → `runtime-unavailable`; not `flow-invalid`.
- CLI: `run`/`doctor`/`run-stage`/`ci-repair` with `--runtime` agree on the effective
  document; per-stage flag parsing.
- API: task/run creation with overrides, 422 on invalid, repo-scoped; API token with
  run scope can override; API token with `flows:manage` can mutate Flows; audit rows.
- Snapshot: `sourceSha256`, `overrides`, `effective` recorded; retry reuses overrides.
- Compatibility: variant alias resolves to base + override; existing variant work
  items still run; customized variant rows untouched.
- Console: picker sends `overrides`; run detail shows effective runtime.

## Rollout

1. `RunOverrides` type, `applyRunOverrides`, snapshot fields, CLI flags (`run`,
   `doctor`, `run-stage`, `rework-pr`, `pr-comments`, `ci-repair`), `--questions`.
2. API + work-item default overrides + API-token Flow management + audit.
3. Console picker and run-detail display.
4. Runtime-neutral prompts; variants become deprecated aliases.
5. #709 adds `effort`.
6. Remove variant seeds after one release.

## Open questions

1. Should an explicit runtime override replace `runtimes[]` fallback (proposed) or
   keep fallback after the chosen runtime?
2. Is per-stage override needed in the first cut, or flow-wide only (simpler)?
3. Should work items store default overrides, or only individual runs?
4. Do we want an `allowedRuntimes` policy now, or later?
5. Deprecation window for the `-grok/-pi/-claude` variants (proposed: one release as
   aliases, one release with warnings).
