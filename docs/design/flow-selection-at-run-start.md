# Choosing the runtime when a run starts

Status: proposal for remaining #708 step 6 work; shared `RunOverrides` core established
by #709 (Instask/nitely-oss#47, merged) · Refs jerryleooo/nitely#708 (step 6,
"Problem B") · Related: jerryleooo/nitely#709, jerryleooo/nitely#710

This document builds on the override mechanism that #709 already shipped. Sections
are split into **existing behavior** (on `main`, from #709) and **proposed behavior**
(remaining step 6 work). It does not define a competing override model.

## Problem

The repository Flow catalog is canonical (#708 steps 1–5): built-ins are seeded into
the per-repository Flow store, edits and enable/disable live there, the Web API and
CLI are repository-scoped, and `resolveRunFlowSource(repoPath, reference)` is the
single way a CLI execution path turns a reference into a document.

Flow documents still carry a literal `runtime` / `model` per agent stage, and their
prompts name the product ("with Grok Build"). That is why
`flows/implement-spec-bootstrap.json` has `-grok`, `-pi` and `-claude` siblings.
#709 made run-time choice possible; step 6 finishes the job so those copies can go.

`configurables` cannot fix this: `applyFlowConfigurationTemplate` only touches
`stage.prompt` and `stage.command`.

## Goals

1. An operator chooses runtime/model/effort (and question policy) at run start from
   CLI, API and Console, without editing or copying the Flow.
2. The Flow document still declares defaults; no override means today's behavior.
3. Source Flow and requested overrides are recorded so the run is reproducible.
4. Overrides go through the same preflight as the Flow's own values.
5. Retire the `implement-spec-bootstrap-{grok,pi,claude}` variants without breaking
   existing work items, runs or labels.
6. One override mechanism for #708, #709 and #710.

## Non-goals

- Per-run editing of arbitrary stage fields (prompts, commands, DAG shape).
- Automatic runtime routing / cost optimization.
- Per-stage overrides (deferred; run-wide only, see Decisions).
- An `allowedRuntimes` policy (deferred).
- Choosing a different Flow for an existing work item at run start (changing a work
  item's Flow identity stays an explicit edit).

## Existing behavior (main, after #43/#45/#47/#48/#49)

- **Catalog / CLI resolution (#708 steps 1–5):** `run`, `doctor`, `run-stage`,
  `rework-pr`, `pr-comments`, `ci-repair` resolve through `resolveRunFlowSource`;
  relative references anchor on `repoPath`; edited built-ins run as edited; disabled
  ones are refused; explicit files still work.
- **Question policy (#710):** Flow- and stage-level `questions` (`ask`/`auto`/`deny`);
  no run-time override yet.
- **Shared override core (#709, `src/flow/overrides.ts`):**
  - `RunOverrides { model?, effort?, runtime? }`; `normalizeRunOverrides()` rejects a
    non-object, unknown fields, empty/non-string `model`/`runtime`, and an `effort`
    outside `off|minimal|low|medium|high|xhigh|max` (`RunOverridesError`).
  - `applyRunOverrides(flow, overrides)` returns a new Flow (the stored one is never
    mutated) and only touches agent, judge and review-gate stages.
  - Applied in `runFlow()` after `resolveRunFlowSource`, in preflight
    (`evaluateRunPreflight`), and on resume from the recorded overrides.
  - Work items/tasks store default `overrides`; a run request merges on top
    field-by-field (`{ ...workItem.overrides, ...run.overrides }`).
  - CLI: `nitely run --runtime/--model/--effort`, `nitely task create
    --runtime/--model/--effort`.
  - API: `POST /api/tasks` and `POST /api/tasks/:id/runs` accept `overrides`.
  - Effort: requested / native / effective effort recorded per attempt
    (`requestedEffort`, `nativeEffort`); `runtime-effort-unsupported` from preflight.
  - Reproducibility and evidence record the overrides and effective selection.

## Options

### A. Extend configurables to `runtime` / `model`
Every Flow becomes a template, per-run choice ends up in persisted configuration,
validation happens after substitution, no `effort`/`questions`. Rejected (also by #709).

### B. Explicit run-level overrides object (chosen; implemented by #709)
A typed `overrides` object applied on top of the resolved source document before
preflight. One validation, lineage and preflight path.

### C. Keep variants, group them in the catalog
Keeps duplication and drift. Rejected.

## Design (Option B)

### Data model

```ts
type RunOverrides = {
  runtime?: string;  // established by #709
  model?: string;    // established by #709
  effort?: Effort;   // established by #709
  questions?: "ask" | "auto" | "deny"; // proposed (step 6, deferred from #710)
};
```

Run-wide only; command stages are untouched.

### Candidate (`runtimes[]`) semantics — existing, from #709

- **Runtime override** replaces the stage's runtime / fallback candidate chain with a
  single candidate. There is **no fallback** to the Flow's previous `runtimes[]`; if
  the chosen runtime fails, the stage fails. When only `runtime` is overridden, the
  model/effort carried over is the stage's own value or the first candidate's value.
- **Model override** applies to **every** existing candidate, preserving order.
- **Effort override** applies to **every** existing candidate, preserving order.
- Preflight then decides which candidates are viable.

Example:

```text
Flow candidates:            override model=new-model     override runtime=openrouter, model=qwen/foo
1. glm   / model-a    ->    1. glm   / new-model    ->   1. openrouter / qwen/foo
2. codex / model-b          2. codex / new-model         (original chain removed)
```

### Precedence — existing, from #709

Per field: per-run override > work-item/task default override > Flow/stage value.
Merge is field-by-field, not whole-object:

```text
task default: runtime=openrouter, effort=medium
run override: model=qwen/foo
effective:    runtime=openrouter, model=qwen/foo, effort=medium
```

`questions` (proposed) follows the same rule.

### Application point

`applyRunOverrides` runs after `resolveRunFlowSource` / catalog resolution and before
preflight, stage extraction and execution. Proposed: every remaining execution entry
point (`doctor`, `run-stage`, `rework-pr`, `pr-comments`, `ci-repair`, scheduler)
passes overrides through the same function rather than re-implementing it.

### Snapshot and lineage — existing, from #709

```text
original stored/source Flow snapshot + recorded RunOverrides = effective execution configuration
```

- `flowDocument` — immutable source Flow snapshot (stored catalog or explicit file);
- `flowDocumentSha256` — `sha256(source Flow snapshot)`;
- `overrides` — immutable run-level override request (merged with task defaults);
- effective runtime/model/effort — recorded in runtime selection events, the run
  projection, `reproducibility.json` and evidence.

Resume reconstructs the effective Flow by applying the recorded `overrides` to the
source snapshot. Run labels stay the Flow label. No `sourceSha256` field is added.
Optional future addition: a derived `effectiveFlowSha256`; it must not change the
meaning of `flowDocument`.

### Surface

Existing (#709): `nitely run`, `nitely task create` (`--runtime/--model/--effort`);
`POST /api/tasks`, `POST /api/tasks/:id/runs` (`overrides`); task default overrides.

Proposed (step 6):
- `--questions <ask|auto|deny>` and `overrides.questions` on the same surfaces.
- Override flags on the remaining execution commands (`doctor`, `run-stage`,
  `rework-pr`, `pr-comments`, `ci-repair`) so `doctor` checks the same effective
  configuration as `run`. No `stage=value` forms.
- **Console:** "Runtime" picker (default "As defined in Flow") on Run / new task that
  sends the shared `overrides` object; run detail shows effective runtime/model/effort.

### Validation and preflight

- **Malformed overrides → HTTP 400** (existing: `RunOverridesError` →
  `WebInputError`): bad shape, unknown field, empty `model`/`runtime`, invalid `effort`.
  Not 422.
- **Well-formed but not executable → preflight report** using the existing
  diagnostics: `runtime-unavailable`, `runtime-model-unsupported`,
  `runtime-effort-unsupported`, and the existing credential diagnostics. No new
  `override-invalid` / `runtime-not-allowed` codes.

### Permissions

- Anyone authorized to start a run (`runs:start` on the target record) may supply
  overrides; no Flow-management permission is needed because the stored Flow is not
  changed. Override use is recorded in the run's lineage.
- `allowedRuntimes` is deferred; any registered runtime may be chosen.

### Compatibility and migration

1. **No-override identity:** with no overrides the source snapshot is unchanged,
   `applyRunOverrides` is semantically the identity, and execution behavior is
   unchanged. This does not depend on serializing a separate post-override document.
2. **Runtime-neutral prompts:** drop "with Grok Build" etc. from base prompts.
3. **Variant aliases:** `implement-spec-bootstrap-{grok,pi,claude}` seeds stay one
   release as deprecated aliases: resolving one yields the base Flow plus
   alias-derived compatibility defaults (e.g. `runtime=claude`), recorded as `aliasOf`.
   Precedence:

   ```text
   base Flow -> alias-derived compatibility defaults -> work-item defaults -> per-run overrides
   ```

   So an alias implying `runtime=claude` run with `--runtime openrouter` runs on
   openrouter. Customized existing variant rows stay independent user-managed Flows
   and never become aliases.
4. **Removal:** one release alias, one release deprecation warning, then fail with a
   hint to use `--runtime`.

## Separate: API-token Flow management

Orthogonal to run overrides. Decision: API tokens may manage Flows (`/api/flows*`
CRUD, enable/disable, reset) in repositories they can write, with security-audit
rows. Implemented in its own PR, not part of the override mechanism.

## Test plan

Existing (#709) coverage to keep: `test/flow/run-overrides.test.ts`,
`test/run/model-effort-overrides.test.ts`, `test/run/model-effort.test.ts`.
Step 6 adds/extends:

- **Candidate semantics:** runtime override replaces the fallback chain; model-only
  and effort-only overrides apply to all candidates preserving order.
- **Precedence:** run override > task default > Flow/stage value; field-by-field merge.
- **Snapshot/reproducibility:** source snapshot unchanged; overrides recorded
  separately; effective runtime/model/effort visible in events/reproducibility/
  evidence; resume reapplies the same overrides; no-override identity.
- **Validation:** malformed overrides → 400; non-executable → existing preflight codes.
- **Questions:** task default policy; per-run override; run override beats default.
- **CLI:** `doctor`/`run`/`run-stage`/`ci-repair` with the same flags agree.
- **Variant compatibility:** legacy alias → base Flow + implicit runtime default;
  explicit `--runtime` beats the alias runtime; customized legacy variant stays
  independent; existing variant work items still run.
- **Console:** picker sends the shared `overrides` object; run detail shows effective
  runtime/model/effort.

## Rollout

Already established by #709: `RunOverrides` (runtime/model/effort),
`applyRunOverrides`, task default + per-run overrides, `nitely run` / `task create`
flags, `POST /api/tasks` and `/api/tasks/:id/runs`, preflight, resume, effort
recording, reproducibility/evidence.

Remaining step 6:
1. Add `questions` to `RunOverrides` (CLI `--questions`, API, task default).
2. Cover remaining CLI execution entry points with override flags.
3. Console runtime picker and effective runtime/model/effort display.
4. Runtime-neutral base prompts.
5. Variants become deprecated aliases.
6. Remove variant seeds on schedule.

## Decisions

1. **No fallback:** an explicit runtime override replaces `runtimes[]`; model/effort
   overrides apply to every candidate in order.
2. **Run-wide only:** per-stage overrides deferred; no `stage=value` CLI forms.
3. **Work-item defaults:** stored default overrides; run override > work-item default
   > Flow/stage value, field-by-field; both recorded.
4. **`allowedRuntimes`:** deferred.
5. **Variant deprecation:** one release alias, one release warning, then removal.
