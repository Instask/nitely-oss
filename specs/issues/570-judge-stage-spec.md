# Issue 570: First-class Judge Stage

## Flow contract

```json
{
  "id": "judge",
  "type": "judge",
  "inputs": ["spec", "implementation", "test-report"],
  "criteria": ["requested behavior is implemented", "changed behavior is tested"],
  "onRework": "implement",
  "maxRework": 2,
  "outputs": [{ "id": "judge-result", "type": "judge.result", "mediaType": "application/json" }]
}
```

The stage is provider-independent and uses the same runtime/capability/context
controls as an agent stage. Its output must contain one verdict: `PASS`,
`REWORK`, or `HUMAN_REVIEW`, plus findings/evidence and, for rework, actionable
instructions.

## Guarantees

- deterministic stages remain upstream of the judge;
- only an explicitly configured earlier stage or its produced artifact can be
  a rework target;
- `maxRework` is persisted through judge attempts and resume, and exhaustion
  fails closed;
- every verdict is recorded in the judge artifact and `judge.completed` event;
- rework requests reuse existing orchestrator evidence and stage attempt
  history; no arbitrary graph cycles are introduced.
