# Issue 107: Spec Plan Task Analysis Gate

## Context

Nitely can now parse task artifacts and run scoped implementation, but it still trusts that the spec, technical design, and tasks agree. When they do not, an implementation agent can burn context on contradictory or unverifiable instructions.

## Proposed Change

Add an optional read-only `gate` stage with `mode: "analysis"`. The gate checks selected input artifacts before implementation and produces a structured report. If configured as blocking, critical findings fail the gate and prevent downstream stages.

## Required Checks

1. Functional requirement IDs (`FR-###`) have task coverage or an explicit out-of-scope note.
2. Success criterion IDs (`SC-###`) have task coverage or an explicit out-of-scope note.
3. Each task maps to a requirement, story (`US-###`), success criterion, plan decision, or maintenance reason.
4. No unresolved placeholders remain (`TBD`, `TODO`, `FIXME`, `{{...}}`, or bracket placeholders).
5. Task artifacts are valid: no duplicate IDs, malformed task lines, or missing task IDs.
6. Task dependencies do not point forward to later task IDs.
7. The plan/spec/tasks do not contradict loaded constitution “must not …” rules.
8. Verification success criteria have at least one task that names the criterion and includes test/check/verify language.

## Flow Schema

```json
{
  "id": "analyze",
  "type": "gate",
  "mode": "analysis",
  "inputs": ["spec", "tech-design", "tasks"],
  "outputs": ["analysis-report"],
  "blocking": true
}
```

`blocking` defaults to `true`. With `blocking: false`, critical findings are recorded but do not fail the run.

## Acceptance Criteria

1. `loadFlow()` accepts analysis gate stages.
2. `runFlow()` executes analysis gates without invoking an agent or command.
3. Blocking analysis gates fail when critical findings exist.
4. Advisory analysis gates pass while recording critical findings.
5. The analysis report is recorded as a gate artifact and appears in run evidence.
6. Tests cover missing coverage, duplicate IDs, placeholder detection, and constitution conflicts.

## Out of Scope

- LLM-based semantic analysis.
- UI for editing analysis findings.
- Automatic task/spec rewriting.
