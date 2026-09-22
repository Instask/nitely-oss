# Issue #62 Spec: Flow-Declared Harness, Runtime Enforcement, and Stronger Audit Evidence

## Scope

Follow-up to #61. Turn Nitely's soft harness into enforced contracts and add
stronger audit evidence, so a run can prove what happened and the runtime keeps
agents inside the intended operating boundaries.

This spec covers the eight acceptance criteria below. The Docker executor,
event hash-chaining, per-stage permission declarations, and verifier stages from
the issue's proposals are explicitly out of scope and deferred to follow-ups —
they are not required by the acceptance criteria and the Docker executor is a
large standalone unit.

Do not change agent runtime dispatch, retry/rework mechanics, or PR publishing
semantics beyond recording richer evidence.

## Problem

Nitely already has the right foundation: an append-only `EventStore`, run
projection, an artifact registry (#36), a flow schema with typed outputs, and
work-item governance (#61). But much of the harness is still soft:

- Important requirements live in prompts rather than enforced contracts.
- Artifacts have no integrity/provenance fields, so silent later changes are
  undetectable and replay is fragile.
- Command and approval events omit metadata an audit needs.
- A flow can omit a required gate before a high-risk action and still run.

## Goals

1. Validate top-level flow input contracts and richer artifact contracts.
2. Enforce required outputs and schema-compatible artifacts before downstream
   stages consume them.
3. Add integrity and provenance fields to the artifact registry.
4. Record command execution metadata: exit code, duration, cwd, timeout.
5. Record approval metadata: actor, decision, reason, reviewed artifact ids.
6. Enforce at least one policy rule that prevents a high-risk stage from running
   even if the flow omits the required gate.
7. Surface an evidence timeline for one run in the Web Console.
8. Keep existing dev flows backward-compatible.

## Decisions

- **Policy storage**: repository config only. Extend the built-in policy table
  and `.nitely/work-item-policy.json` from #61. No org-level config this issue.
- **Schema validation strictness**: JSON artifacts that declare a `schema` are
  structurally validated; `text`/`markdown` artifacts only enforce the
  required-output rule (must be produced and non-empty), no schema check.
- **Schema validator**: a minimal built-in validator supporting the common
  subset (`type`, `required`, `properties`); no third-party JSON Schema
  dependency.
- **High-risk enforcement (AC6)**: rejected at flow load/creation AND guarded at
  runtime (defense in depth).
- **Protected action stages**: `publish-change`, `update-change`, and any future
  `deploy` stage. High-risk work item types must declare a preceding `approval`
  gate before these stages.

## Artifact Integrity And Provenance (AC3)

`RunArtifact` gains optional fields:

```ts
interface RunArtifact {
  // ...existing...
  sha256?: string;        // hex digest of the artifact content
  size?: number;          // byte length of the content
  createdByRunId?: string;
  stageId?: string;
  attempt?: number;
}
```

- Generated text/markdown/JSON artifacts compute `sha256`/`size` from the bytes
  written, and record `createdByRunId`, `stageId`, `attempt`.
- External inputs are snapshotted and hashed when fetched, so a source file or
  URL changing later does not break replay; the registry entry records the
  digest of the snapshot used.
- Integrity fields persist through `writeArtifactRegistry` and its redaction.

## Command Execution Evidence (AC4)

`command.completed` and `command.failed` event payloads gain:

```ts
{ command, exitCode, durationMs, cwd, timeoutMs?, stdout, stderr, ...paths }
```

Run projection exposes these on each command log entry. `durationMs` is measured
around the backend command call; `cwd` is the run workspace path; `timeoutMs`
comes from the stage declaration when present.

## Approval Evidence (AC5)

`approval.resolved` payload changes from `{ approved: true }` to:

```ts
{ actor, decision: "approved" | "rejected", reason?, reviewedArtifactIds }
```

Approvals are currently automatic, so `actor` is `"system:auto"`, `decision` is
`"approved"`, and `reviewedArtifactIds` is the stage's declared inputs. The
`gate.approval` artifact's `gate` payload carries `actor` and optional `reason`.
Projection surfaces these on gate/approval entries.

## Harness Enforcement (AC1, AC2)

- **Input contracts**: a flow's `metadata.inputs` declares required input ids.
  When a run starts, the supplied inputs must cover every declared input id, or
  the run fails before any stage executes.
- **Required outputs**: after an agent or command stage completes, every output
  id the stage declares must exist as a non-empty artifact produced by that
  stage. A missing or empty required output fails the stage through the existing
  retry/failure path.
- **Schema validation**: a `src/artifacts/validate.ts` minimal validator checks
  JSON artifacts that declare a `schema`. Validation failure fails the stage and
  the artifact is not made available to downstream stages. `text`/`markdown`
  artifacts are exempt from schema checks.

## Stage-Level High-Risk Policy (AC6)

The policy table declares, per high-risk work item type, that protected action
stages require a preceding approval gate.

- **Flow load / creation**: if a high-risk type's flow contains a protected
  stage that is not preceded by the required `approval` stage, creation/load is
  rejected.
- **Runtime guard**: before executing a protected stage, the runtime checks that
  the required gate has been approved in this run (a passed `gate.approval`).
  If not, the stage is blocked and the run fails.

This holds even when the flow omits the gate entirely: the protected stage
cannot run.

## Evidence Timeline (AC7)

The run detail API (`GET /api/runs/:id`) exposes an ordered evidence timeline:

```text
inputs (with sha256)
  -> stage attempts (runtime/model/command, exitCode, durationMs)
  -> artifacts (type, sha256, size, producer)
  -> gates (actor, decision)
  -> external effects (PR url, merge commit, head SHA, branch)
```

External effects from publish/update/sync-change are normalized into timeline
entries. The Web Console run detail view renders an Evidence section presenting
this timeline.

## Backward Compatibility (AC8)

- All new fields are optional. Flows without `metadata.inputs` or without
  declared output `schema` do not trigger new validation failures.
- Events missing new fields project with safe fallbacks.
- Existing dev task creation, dev PR flows, and all current tests keep working.

## Acceptance Criteria

- Flow schema supports top-level input contracts and richer artifact contracts.
- Runtime validates required outputs and schema-compatible artifacts before
  downstream consumption.
- Artifact registry includes integrity and provenance fields.
- Command execution events include exit code, duration, cwd, timeout, and
  command metadata.
- Approval events include actor, decision, reason, and reviewed artifact
  references.
- At least one policy rule prevents a high-risk stage from running even if the
  flow omits the required gate.
- Web Console can show an evidence timeline for one run.
- Existing dev flows remain backward-compatible.

## Out Of Scope

- Docker executor (`type: docker` or `executor: docker`).
- Event hash-chaining / signing.
- Per-stage permission declarations (allowed paths, network mode, secrets).
- Dedicated verifier stage type.
- Org-level policy configuration.
- External state guards beyond the gate-before-protected-stage rule.
