# Flow-Declared Harness, Runtime Enforcement, and Stronger Audit Evidence Tech Design

Spec: `specs/issues/062-flow-declared-harness-audit-spec.md`

## Design

### Module layout

```text
src/artifacts/
  types.ts        # RunArtifact gains sha256/size/createdByRunId/stageId/attempt
  integrity.ts    # computeIntegrity(content) -> { sha256, size }; withProvenance(...)
  validate.ts     # minimal JSON schema subset validator
src/work-items/
  policy.ts       # protectedStages + requiredGateBeforeProtected per type
  governance.ts   # flow-load rejection of protected stage without preceding gate
src/run/
  run-flow.ts     # wire integrity, command/approval evidence, required-output +
                  # schema enforcement, runtime gate guard
  project.ts      # carry command/approval/gate evidence fields
src/web/
  runs.ts         # evidence timeline assembly on run detail
  static/console.dc.html  # Evidence section in run detail
```

### 1. Artifact integrity and provenance (AC3)

`src/artifacts/integrity.ts`:

```ts
export function computeIntegrity(content: Buffer | string): { sha256: string; size: number };
export function withProvenance(
  artifact: RunArtifact,
  content: Buffer | string,
  provenance: { runId: string; stageId?: string; attempt?: number },
): RunArtifact;
```

`sha256` is the hex SHA-256 of the bytes; `size` is `byteLength`. `withProvenance`
merges integrity + `createdByRunId`/`stageId`/`attempt` onto the artifact without
overwriting existing values.

Wire points in `run-flow.ts`:
- `recordGeneratedMarkdownArtifact` and `recordGeneratedStageTextArtifacts`
  already hold the written content, `context.runId`, and `producerStageId`. Add
  the current `attempt` to their inputs and call `withProvenance`.
- External inputs: when an input resource is fetched and snapshotted into the run
  directory, compute its integrity from the fetched buffer and attach it to the
  external-input artifact registry entry.

`RunArtifact` in `src/artifacts/types.ts` gains the optional fields. The web
`webArtifact` reader (runs.ts) passes them through.

### 2. Command execution evidence (AC4)

In the `command` stage handler, wrap the `backend.runCommand` call with a
`Date.now()` measurement. The `command.completed` / `command.failed` payloads add
`durationMs`, `cwd` (the workspace path), and `timeoutMs` (`stage.timeoutMs`).
`project.ts` command-log projection reads these new fields; the web
`WebRedactedLog` carries them for the timeline.

### 3. Approval evidence (AC5)

The `approval.resolved` payload becomes
`{ actor: "system:auto", decision: "approved", reason?, reviewedArtifactIds }`
where `reviewedArtifactIds` is `stage.inputs`. `recordApprovalGate` accepts
`actor`/`reason` and writes them into the `gate` payload. `project.ts` surfaces
approval/gate evidence.

### 4. Harness enforcement (AC1, AC2)

- **Input contracts**: before the stage loop, validate that every
  `flow.metadata.inputs[].id` is present in `input.inputs`. Missing → fail the
  run with a clear error event before any stage runs.
- **Required outputs**: after an agent/command stage completes, for each declared
  output id check the artifact entry produced by this stage exists and is
  non-empty (`size > 0` or non-empty content). Missing/empty → throw, routing
  through the existing retry/failure path.
- **Schema validation** (`src/artifacts/validate.ts`): for each produced artifact
  whose contract declares a `schema` and whose content parses as JSON, run the
  minimal validator. Failure → throw (stage fails, artifact not consumed
  downstream). Text/markdown without parseable JSON is exempt.

The minimal validator supports `{ type, required, properties }` recursively:
- `type`: `object|array|string|number|boolean|null` checked against the value.
- `required`: array of keys that must be present on an object.
- `properties`: per-key sub-schema validated recursively.
Unknown schema keywords are ignored (lenient superset).

### 5. Stage-level high-risk policy (AC6)

`policy.ts` adds to `WorkItemTypePolicy`:

```ts
protectedStages?: string[];   // stage types requiring a preceding gate
```

Defaults: high-risk types (`autofarm.site`, `capital-autopilot.*`) protect
`publish-change`, `update-change`, and `deploy`. `dev.pr` has none.

`governance.ts` `assertWorkItemTypeAllowed` additionally checks: for each
protected stage in the flow, there must be an `approval` stage earlier in
`spec.stages`. Otherwise reject (`WebInputError` / flow validation error). This
runs at work item creation and at the web run-start path.

Runtime guard in `run-flow.ts`: before executing a `publish-change` /
`update-change` (or future `deploy`) stage, when the run's work item type is
high-risk, verify a `gate.approval` with `state: "approved"` exists in the
artifact entries for a required gate; if absent, append a `run.failed` event and
stop. This holds even if governance was bypassed (e.g. direct CLI run).

### 6. Evidence timeline (AC7)

`getRunDetail` in `runs.ts` assembles an ordered `evidence` array from data it
already reads:

```ts
interface RunEvidenceItem {
  kind: "input" | "stage" | "artifact" | "gate" | "external-effect";
  at?: string;
  label: string;
  detail: Record<string, unknown>;  // e.g. sha256, exitCode, durationMs, actor, prUrl
}
```

- `input`: external-input artifacts (with `sha256`).
- `stage`: per stage attempt (runtime/model/command, exitCode, durationMs).
- `artifact`: produced artifacts (type, sha256, size, producer).
- `gate`: `gate.approval` artifacts (actor, decision).
- `external-effect`: normalized from `changeRequest` / sync metadata (PR url,
  merge/head SHA, branch).

`WebRunDetail` gains `evidence: RunEvidenceItem[]`. Ordering: inputs first, then
items sorted by timestamp, with stage/artifact/gate interleaved by `at`.

### 7. Web Console (AC7)

`console.dc.html` run detail view adds an Evidence section rendering the
`evidence` array grouped/ordered as above, mirroring the existing template
engine (`sc-for`, computed rows). Existing stage/log/artifact panels remain.

### 8. Backward compatibility (AC8)

New artifact, command, and approval fields are optional; readers fall back when
absent. Input-contract validation only fires when `metadata.inputs` is declared.
Schema validation only fires when a contract declares `schema` and content is
JSON. Required-output enforcement applies to already-declared outputs, which
existing flows already produce. Protected-stage policy only applies to high-risk
types, so `dev.pr` flows are unaffected.

## Integration

- `src/artifacts/types.ts` — RunArtifact integrity/provenance fields.
- `src/artifacts/integrity.ts`, `src/artifacts/validate.ts` — new modules.
- `src/run/run-flow.ts` — integrity wiring, command/approval evidence,
  input-contract + required-output + schema enforcement, runtime gate guard.
- `src/run/project.ts` — project new command/approval/gate evidence fields.
- `src/work-items/policy.ts`, `governance.ts` — protected-stage policy.
- `src/web/runs.ts` — evidence timeline assembly + RunArtifact pass-through.
- `src/web/server.ts` — run-start protected-stage governance already covered by
  `assertWorkItemTypeAllowed`; no new endpoint.
- `src/web/static/console.dc.html` — Evidence section.

## Verification

- Unit tests:
  - `computeIntegrity` digests; `withProvenance` merges without clobbering.
  - generated + external-input artifacts carry sha256/size/provenance in the
    registry.
  - `command.completed` carries durationMs/cwd/timeoutMs.
  - `approval.resolved` carries actor/decision/reviewedArtifactIds; gate artifact
    carries actor.
  - input-contract validation fails a run missing a declared input.
  - required-output: a stage declaring an unproduced output fails.
  - schema validator: valid/invalid JSON cases; text artifact exempt.
  - governance: high-risk flow with a protected stage and no preceding gate is
    rejected; runtime guard blocks a protected stage without an approved gate.
  - run detail exposes an ordered evidence timeline.
- Existing suite stays green; `pnpm check` and `pnpm build` clean.
