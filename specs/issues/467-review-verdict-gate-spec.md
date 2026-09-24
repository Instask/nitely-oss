# Issue 467: Structured Review Verdict Gate

## Contract

Review stages must emit a line-shaped structured result:

```text
verdict: pass|fail
reason: <concise explanation>
reworkTarget: <artifact id>   # optional when verdict is fail
targetStage: <stage id>       # optional explicit stage override
instructions: <actionable fix>
```

`approved`, `needs_fix`, `needs_rework_spec`, and `escalate` remain accepted
for existing flows. New flows should use `pass` and `fail`.

## Runtime behavior

- `pass` completes the review stage and allows downstream stages to run.
- `fail` fails the review stage, so publish/update stages cannot run.
- A valid `reworkTarget` or `targetStage` is converted into the existing
  bounded rework policy and routed only to an upstream declared producer.
- An unrecognized or missing verdict fails closed; the review output remains
  recorded as evidence.

## Verification

Focused tests cover canonical parsing, explicit `reworkTarget`, malformed
output fail-closed behavior, policy routing, and schema validation. The full
run-flow path is covered by the existing Linux runtime suite.
