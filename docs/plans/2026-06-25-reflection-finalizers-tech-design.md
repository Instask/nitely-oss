# Tech Design: Reflection Finalizers

## Context

#164 extends the reflection requirement from #157. The current runtime already
writes evidence on early failure/blocker paths, but it does not execute final
stages once the main stage loop stops.

## Design

- Add `alwaysRun?: boolean` to the flow stage schema.
- Treat `alwaysRun` agent stages as finalizers. The main stage loop skips them;
  a terminal finalizer pass runs them after success, failure, or blocker states.
- Before running finalizers, write a generated `run-finalizer-context` artifact
  that summarizes:
  - run id and flow name;
  - terminal status;
  - completed stages;
  - failure or blocker metadata;
  - change request URL/metadata when available;
  - input artifact sources.
- Execute finalizers with the same agent runtime path as normal agent stages so
  prompt rendering, skills, context budgets, runtime fallback, output
  validation, artifact registry, and evidence all stay consistent.
- If the finalizer cannot run, record a generated `reflection-skipped` markdown
  artifact with the stage id, terminal status, and safe reason.
- Preserve the original run result: successful runs stay completed; failed and
  blocked runs still throw their original error/blocker after the skipped or
  generated reflection evidence is persisted.

## Built-In Flow Changes

- Mark the final `reflect` stage in issue execution flows as `alwaysRun: true`.
- Keep the existing stage inputs so successful paths still include
  implementation/test/review/change request artifacts.

## Validation

- Add regression tests for success, command failure, review blocker,
  usage-limit blocker, resumed interrupted completion, and finalizer skipped
  fallback.
- Run focused run-flow tests plus flow validation tests.
