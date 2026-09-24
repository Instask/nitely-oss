# Convergence Pass

A convergence pass compares the current worktree with an approved spec,
technical plan, and Markdown task artifact. It turns implementation gaps into
new traceable tasks without changing the source artifacts or pretending partial
work is complete.

Use the built-in flow:

```bash
node dist/index.js run flows/converge-feature-artifacts.json \
  --repo . \
  --input spec=specs/feature.md \
  --input plan=docs/plans/feature.md \
  --input tasks=docs/tasks/feature.md
```

The run produces:

- `convergence-report`, a strict structured report recorded in run evidence;
- `converged-tasks`, a generated Markdown task artifact whose unchanged prefix
  is the exact source task content.

The source files supplied to the run remain read-only inputs.

## Agent Stage Contract

Custom flows enable the behavior on an agent stage:

```json
{
  "id": "converge",
  "type": "agent",
  "runtime": "codex",
  "prompt": "Assess the current implementation against the feature artifacts.",
  "inputs": ["spec", "plan", "tasks"],
  "outputs": [
    {
      "id": "convergence-report",
      "type": "convergence.report",
      "mediaType": "application/vnd.nitely.convergence+json"
    },
    {
      "id": "converged-tasks",
      "type": "task.converged",
      "mediaType": "text/markdown"
    }
  ],
  "convergence": {
    "tasksInput": "tasks",
    "reportOutput": "convergence-report",
    "tasksOutput": "converged-tasks"
  }
}
```

All three configured IDs must be distinct. The task input and both typed output
contracts must also appear in the stage's `inputs` and `outputs`.

## Report Shape

The report uses this shape:

```json
{
  "version": "nitely.convergence.v1",
  "summary": "Recovery remains incomplete.",
  "gaps": [
    {
      "classification": "partial",
      "title": "Finish bounded recovery after a stalled agent attempt",
      "sourceRefs": ["FR-004", "SC-002", "PD-003"],
      "evidence": [
        "src/run/recovery.ts records the snapshot but does not restore it."
      ],
      "paths": ["src/run/recovery.ts", "test/run/recovery.test.ts"]
    }
  ]
}
```

Classifications are `missing`, `partial`, `contradicts`, and `unrequested`.
Supported source references are `FR-###`, `SC-###`, `US-###`, `AC-###`,
`US-###/AC-###`, `PD-###`, `D-###`, `plan:<slug>`, and
`constitution:<slug>`. Every gap requires at least one source reference and one
worktree evidence statement. Paths must be repository-relative.

Use `"gaps": []` for a clean pass.

## Stable Append Semantics

Nitely, not the agent, appends the tasks:

- Existing task bytes and IDs are never rewritten or renumbered.
- New IDs start after the greatest existing `T###`; unused holes are not reused.
- Semantic gap fingerprints make repeated passes idempotent.
- Gap ordering cannot affect IDs because new gaps are fingerprint-sorted.
- A clean or already-converged pass is byte-for-byte unchanged.
- Invalid reports, invalid source task artifacts, unsafe paths, duplicate gaps,
  aliased outputs, and exhausted `T999` space fail the stage before completion.

## Feeding Rework

`converged-tasks` is a normal generated artifact. Add it to a later agent,
verification, review, or `update-change` stage's `inputs` to continue the same
flow. A separate run can also import it with a
`nitely-artifact://<run-id>/converged-tasks` input reference.

Both convergence outputs appear in `artifacts.json` and the Artifacts section
of `evidence.md`, including their type, producer, media type, and run-relative
path.
