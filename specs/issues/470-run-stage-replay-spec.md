# Issue 470 Spec: Single-Stage Dry-Run and Replay

## Goal

Let an operator inspect or replay one existing Flow stage without executing
the rest of the Flow. The command documents the selected stage before work is
started and accepts artifacts captured by a previous attempt.

## Command

```text
nitely run-stage <flow> <stage-id> [--repo <path>]
  [--input <name>=<path>] [--input-dir <path>] [--dry-run]
  [--backend local|mise|oci]
```

The command resolves `<stage-id>` from `spec.stages` and builds an in-memory
Flow document containing that stage only. Normal Flow parsing, validation, and
execution then apply to the single-stage document. The source Flow is not
modified.

## Dry-Run Contract

`--dry-run` prints a stable, line-oriented description using these prefixes:

- `FLOW`, `STAGE`, and `TYPE` identify the derived Flow and selected stage.
- `RUNTIME` describes a stage runtime/model when present; `COMMAND` describes
  a command stage.
- `INPUTS`, `OUTPUTS`, and `ATTEMPTS` show the artifact contract and budget.
- One `INPUT` line per required input shows its supplied URI or the instruction
  to provide it.
- `ACTION` states that the operation is dry-run only.

Dry-run does not invoke the runner, create a worktree, contact a runtime, or
create/update an external pull request.

## Artifact Injection

- `--input name=path` supplies one artifact through the existing `local-file`
  connector. It may be repeated.
- `--input-dir path` fills any inputs not supplied explicitly. Without a
  manifest, each input id resolves to a same-named file in the directory. With
  `artifact.json`, `{ "id", "path" }` output entries map ids to files, matching
  a prior `.nitely/runs/<run-id>/stages/<stage>/<attempt>` directory.
- Explicit `--input` values win over entries discovered through `--input-dir`.
- A manifest path containing an absolute or `..` escape that resolves outside
  the input directory is rejected.
- Execution fails before the runner starts if a required input is missing.

## Safety

Approval, publish-change, update-change, and sync-change stages cannot execute
through `run-stage`; they remain inspectable with `--dry-run`. This keeps the
command useful for diagnosis and focused replay without adding a second path
for external side effects. Replay uses the current state of `--repo`; the
operator must select the original checkout or attempt worktree when revision
identity matters.

## Acceptance Criteria

- An existing stage is resolved by id and validated as a one-stage Flow.
- Dry-run emits the documented output contract and has no side effects.
- A stage can consume explicit inputs or artifacts from a prior attempt.
- Missing inputs and manifest paths lexically escaping an input directory fail
  closed.
- Only the selected non-side-effect stage is passed to the normal runner.

## Non-Goals

- Redesigning Flow execution or artifact manifests.
- Replaying an entire run or preserving the original run id.
- Bypassing normal backend, input, or output validation.
- Executing stages that mutate external review or publication state.
