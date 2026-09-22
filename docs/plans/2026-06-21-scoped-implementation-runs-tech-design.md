# Scoped Implementation Runs Tech Design

## Goal

Reduce prompt size for task-driven implementation runs by projecting a selected subset of a task artifact into agent stages while preserving full input snapshots for traceability.

## Design

### Task Scope Module

Add `src/task-artifacts/scope.ts` on top of the #106 parser. It returns either a `TaskScopeSelection` or diagnostics. It supports task ranges, explicit IDs, phase names, story IDs, and next unchecked windows.

The selector is intentionally Markdown-first and does not mutate files. It uses the parser's task order and metadata, so task IDs remain the stable contract.

### RunFlow Integration

`RunFlowInput` gains:

```ts
taskScope?: {
  inputId: string;
  expression: string;
}
```

After input snapshot and `run.created`, `runFlow` validates and applies the scope before workspace creation. Applying scope clones the selected input artifact in memory and replaces only `resource.content` with scoped Markdown. The original snapshot path and metadata remain available in the run directory.

If scope validation fails, `run.failed` is appended and the run throws before `backend.createWorkspace()` or `executeAgent()`.

### Events And Projection

New events:

- `task.scope.selected`
- `task.scope.completed`

`projectRun()` exposes `taskScope` with selected IDs, pending/completed checkbox state at run start, and completion timestamp for successful runs.

### Evidence

`evidence.md` adds a `Task Scope` section with input ID, expression, scope kind, selected task IDs, run-start completed/pending IDs, and source task count.

### CLI And API

CLI:

```bash
nitely run flows/implement.json --repo . --input tasks=docs/tasks.md --task-scope tasks:T001-T006
```

Web API:

```json
{
  "taskScope": {
    "inputId": "tasks",
    "expression": "US-001"
  }
}
```

The API shape is accepted by both task run and generic work-item run endpoints.

## Rollback

Revert the PR. Existing runs without `taskScope` continue to use the previous full-input behavior.
