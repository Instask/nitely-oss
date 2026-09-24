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

Human actions originating in the Approval Inbox also append a metadata-only
`notification.decision` event when a run is linked and a task-scoped
`notification-decisions.json` evidence file when a task is linked. This covers
approval, denial, requested changes, overrides, cancellation, resolution, and
reviewer assignment without copying notification bodies or provider secrets.
See [notification-actions-and-delivery.md](notification-actions-and-delivery.md).

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

### Rollback decision records

`nitely resume <run-id> --checkpoint <checkpoint-id>` lets an operator choose a
specific resumable `stage-attempt` checkpoint instead of relying on the default
first resumable stage. The selection is recorded as a `resume.selected` event and
is non-destructive: it starts resume execution from the selected stage without
resetting branches, deleting worktrees, mutating artifacts or evidence, or
updating pull requests.

`nitely rollback record <run-id> --repo <path> --checkpoint <checkpoint-id>`
records an operator rollback or retry decision as an append-only
`rollback.recorded` event. The command is record-only: it does not reset
branches, delete worktrees, mutate artifacts or evidence, or update pull
requests.

The event captures the selected checkpoint, actor, optional reason, and policy
choices for worktree (`preserve` or `cleanup`), branch (`preserve` or
`reset-to-checkpoint`), and change request (`preserve-existing-pr`,
`update-existing-pr`, `new-pr`, or `none`). Run trace projection exposes the
event as a `rollback-decision` checkpoint so later resume and rollback execution
can enforce the recorded operator policy instead of inferring intent.

`nitely rollback apply <run-id> --repo <path> [--decision <event-sequence>]`
applies the recorded policy only when the current state makes the mutation
safe. `worktree=cleanup` removes the run worktree only when it is the recorded
`.nitely/runs/<run-id>/worktree`; `branch=reset-to-checkpoint` performs a
`git reset --hard` only when the selected checkpoint recorded a valid branch
head and the worktree is preserved. Reset plus cleanup is rejected because those
mutations are not atomic together. `worktree=preserve`, `branch=preserve`, and
non-mutating change policies are recorded as preserved or skipped.
`change=update-existing-pr` and `change=new-pr` never mutate pull requests
directly from rollback apply. They require preserved worktree and branch state,
then route through `resume <run-id> --checkpoint <checkpoint-id>` so existing
publish/update-change machinery records the resumed execution, evidence, and PR
result. The change policy status is `planned` when resumed execution pauses
before a PR URL exists, `applied` when a PR URL is produced, and `blocked` when
the existing target is missing or resume/change-provider execution fails. Both
success and failure are appended as rollback events; failed apply attempts do not
perform partial mutations.

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

Policy is stored per repository: a built-in policy table plus optional
configuration in `.nitely/work-item-policy.json`. The file keeps the existing
`allowedTypes` allow-list for built-in high-risk families and can also define
`customTypes` plus an `unknownTypeDefault` of `allow`, `require-approval`, or
`deny`.

For high-risk, approval-required, or otherwise unclassified custom work item
types, a **protected action stage** (`publish-change`, `update-change`, `deploy`)
must be preceded by an approval gate unless repository policy explicitly marks
the type low-risk or explicitly allows unknown types. This is enforced twice:

- **Flow load / creation**: a high-risk flow whose protected stage has no
  preceding approval gate is rejected.
- **Runtime**: before a protected stage runs, the runtime verifies an approved
  gate exists in the run; otherwise the run fails.

So a protected stage cannot run even if the flow omits or bypasses the required
gate.

## Agent capability policy

Agent stages and review gates may declare a `capabilities` block that records
what the stage is allowed to do:

```json
{
  "capabilities": {
    "read": { "scope": "approved inputs", "allow": ["docs/", "src/"] },
    "write": { "scope": "worktree", "allow": ["src/", "test/"] },
    "commands": { "mode": "allow-list", "allow": ["pnpm test"] },
    "network": { "mode": "disabled", "advisory": false },
    "allowedRuntimes": ["codex"],
    "allowedModels": ["gpt-5.3-codex-spark"],
    "instructions": { "repo": true, "generated": true, "skills": true },
    "evidence": {
      "prompts": true,
      "toolCalls": true,
      "fileChanges": true,
      "runtimeUsage": true
    }
  }
}
```

Local enforcement checks `allowedRuntimes` and `allowedModels` before spawning
an agent or review gate. Explicit `write.scope` also maps to native controls:
Codex receives `read-only` or `workspace-write`, while Claude receives its
corresponding permission mode. A runtime without a native read-only control is
rejected for a required `write.scope: "none"` stage. Path, command, network,
instruction-source, and tool-action evidence entries are recorded in run
evidence as the effective policy; fields marked advisory depend on the
selected runtime/backend for strict enforcement.

High-risk work item types must declare `capabilities` on every agent stage and
review gate. Existing low-risk local bootstrap flows can omit the block; their
run evidence records an implicit broad local default so reviewers can still see
what was assumed.

On OCI, `write.scope: "none"` mounts the worktree read-only, while
`write.scope: "worktree"` preserves writable worktree mounts and narrows them
to `write.allow` when paths are listed. Unsupported scopes or contradictory
writable paths fail before the workload starts. Network `disabled` and
restricted policies likewise fail closed when the selected runtime or gateway
cannot honor them; the effective stage policy remains in run evidence.

OCI agent stages receive only credentials required by the selected runtime's
`requiredEnv` declaration and present in the configured secret allowlist.
Command stages retain the run-level environment contract; agent stages do not
inherit unrelated provider credentials. Agent artifact mounts are similarly
limited to the stage's admitted input paths plus its own writable output.

## Conformance harness

Flows can ask implementation agents to produce a structured conformance report
before publishing or updating a PR. The report maps approved spec, technical
design, and task IDs back to implementation evidence:

```json
{
  "version": 1,
  "summary": "FR-001 and SC-001 are covered by parser tests.",
  "items": [
    {
      "id": "FR-001",
      "status": "satisfied",
      "evidence": ["parser accepts the new field"],
      "files": ["src/parser.ts"],
      "tests": ["pnpm test"],
      "artifacts": ["implementation", "verification-report"],
      "rationale": "Matches the approved parsing requirement."
    }
  ],
  "scopeDrift": [
    {
      "severity": "warning",
      "description": "Touched adjacent helper for shared parsing.",
      "files": ["src/parser-helper.ts"]
    }
  ]
}
```

Valid item statuses are `satisfied`, `partially_satisfied`, `not_satisfied`,
`not_verified`, and `not_applicable`. Publish and update stages can choose a
policy:

```json
{
  "id": "publish",
  "type": "publish-change",
  "inputs": ["implementation", "conformance-report", "verification-report"],
  "conformance": {
    "mode": "strict",
    "report": "conformance-report",
    "required": ["FR-001", "SC-001", "PD-001"]
  }
}
```

`strict` mode blocks publish/update when the report is missing, invalid, missing
a required ID, includes `partially_satisfied`, `not_satisfied`, or
`not_verified` items, or reports blocking scope drift. `advisory` mode records
the same findings in `evidence.md` and the PR body without blocking publish.
Web run details expose the parsed conformance report, policy, artifact metadata,
and findings for console inspection. The built-in `pilot-approved-spec-pr`
template uses the conformance report as an advisory evidence layer before the
review gate and PR publish step.

## Out of scope (follow-ups)

- Docker executor (`type: docker`).
- Event hash-chaining / signing.
- Per-stage permission declarations (paths, network, secrets).
- Dedicated verifier stage type.
- Org-level policy configuration.
