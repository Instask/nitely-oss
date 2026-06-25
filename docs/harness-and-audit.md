# Harness and Audit Evidence

Nitely flows declare a harness, the runtime enforces it, and policy guards what
flows are not allowed to bypass. This document describes the enforced contracts
and the audit evidence a run records. See [work-item-model.md](work-item-model.md)
for the work item / flow model these build on.

```text
Flow declares the harness.
Nitely runtime enforces the harness.
Policy guards what flows are not allowed to bypass.
```

## Audit evidence

Every run records evidence so it can answer, after the fact, what happened.

### Artifact integrity and provenance

Each artifact in the per-run registry (`.nitely/runs/<id>/artifacts.json`) carries:

- `sha256` — hex digest of the artifact content.
- `size` — byte length.
- `createdByRunId`, `stageId`, `attempt` — provenance.

External inputs are snapshotted and hashed when fetched, so a source file or URL
changing later does not break replay: the registry records the digest of the
snapshot actually used.

### Command execution evidence

`command.completed` / `command.failed` events record `exitCode`, `durationMs`,
`cwd`, and `timeoutMs` (when declared) alongside the command and its output.

### Approval evidence

`approval.resolved` events record `actor`, `decision`, optional `reason`, and the
`reviewedArtifactIds` (the gate stage's declared inputs). Approvals are currently
automatic, so the actor is `system:auto`. Each gate is also a first-class
`gate.approval` artifact.

### Evidence timeline

The run detail API (`GET /api/runs/:id`) exposes an ordered `evidenceTimeline`:

```text
inputs (with sha256)
  -> stage attempts (type, status, duration, command)
  -> artifacts (type, sha256, size, producer)
  -> gates (state, actor)
  -> external effects (PR url, branch)
```

The Web Console run detail view renders this timeline.

## Enforced harness contracts

### Input contracts

A flow's `metadata.inputs` declares required input ids. A run that does not supply
every declared input fails before any stage executes. Flows without declared
inputs impose no constraint.

### Required outputs and schema validation

An output declared as a richer **contract object** (not a bare string) is enforced:

- it must be produced as a non-empty artifact, or the stage fails;
- if it declares a `schema` and its content is JSON, the content is validated
  against a minimal JSON-Schema subset (`type`, `required`, `properties`), and an
  invalid artifact fails the stage and is not consumed downstream.

Bare-string outputs (`outputs: ["implementation"]`) keep lenient legacy
semantics, so existing flows are unaffected. `text`/`markdown` artifacts are
exempt from schema validation.

## Policy guards

Policy is stored per repository: a built-in policy table plus the optional
allow-list `.nitely/work-item-policy.json`.

For high-risk work item types (`autofarm.site`, `capital-autopilot.*`), a
**protected action stage** (`publish-change`, `update-change`, `deploy`) must be
preceded by an approval gate. This is enforced twice:

- **Flow load / creation**: a high-risk flow whose protected stage has no
  preceding approval gate is rejected.
- **Runtime**: before a protected stage runs, the runtime verifies an approved
  gate exists in the run; otherwise the run fails.

So a high-risk stage cannot run even if the flow omits the required gate.

## Out of scope (follow-ups)

- Docker executor (`type: docker`).
- Event hash-chaining / signing.
- Per-stage permission declarations (paths, network, secrets).
- Dedicated verifier stage type.
- Org-level policy configuration.
