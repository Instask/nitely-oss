# Tech Design: Single-Stage Dry-Run and Replay

Issue: #470
Spec: `specs/issues/470-run-stage-replay-spec.md`

## Summary

`nitely run-stage` reuses the Flow parser and runner by deriving a Flow document
whose `spec.stages` contains only the requested stage. This keeps stage schema,
backend selection, attempts, artifact validation, and execution behavior on the
same production path as a normal run.

## Stage Resolution

The CLI reads the requested Flow JSON, locates the stage by exact id, and copies
the Flow metadata and spec into an in-memory single-stage document. Its name is
suffixed with `<stage-id>-replay`. The selected stage's inputs are declared as
external inputs while parsing because their original producers are intentionally
absent. A missing stage or malformed Flow fails before execution.

## Dry-Run Projection

The parsed single-stage Flow is projected as line-oriented output:

```text
FLOW <derived-flow-name>
STAGE <stage-id>
TYPE <stage-type>
RUNTIME <runtime[/model][, ...]>  # stages with a runtime
COMMAND <command>                 # command stages
INPUTS <ids|none>
OUTPUTS <ids|none>
ATTEMPTS <stage-or-flow-budget>
INPUT <id> <uri|instruction>      # one per input
ACTION dry-run only; no worktree, publish, or external PR will be created
```

The dry-run branch returns before `runFlow`, so it does not create a run,
worktree, runtime session, or external change.

## Input Resolution

Repeated `--input name=path` options use the existing local-file input parser.
`--input-dir` supplements missing inputs in either of two forms:

1. A plain directory containing files named by artifact id.
2. A prior attempt directory containing `artifact.json`; each output's `id`
   maps to its `path`, for example
   `.nitely/runs/<run-id>/stages/<stage>/<attempt>/artifact.json`.

Explicit inputs take precedence. Manifest paths are resolved against the input
directory and rejected if an absolute or `..` path lexically escapes it. Files
discovered through `--input-dir` are read before their references are accepted;
normal runner validation remains responsible for explicit `--input` references.
Execution rejects any unresolved input.

## Execution and Side Effects

For an executable stage, the CLI passes the derived document, resolved inputs,
repository, and optional backend to the existing `runFlow` entry point. Normal
attempt directories and output handling therefore remain authoritative.

Stages whose purpose is approval, publish, update, or sync are rejected before
the runner call. They may be inspected with `--dry-run`, preserving the command's
no-unintended-external-side-effects boundary.

## Verification

`test/cli.test.ts` verifies that dry-run does not call the runner and prints the
type, runtime, inputs, attempt budget, and no-side-effects action. It also verifies
that a command stage is passed as the only stage and receives an artifact mapped
from a prior attempt-style manifest. The full typecheck and Linux test suite cover
the reused Flow parser, runner, and artifact behavior.
