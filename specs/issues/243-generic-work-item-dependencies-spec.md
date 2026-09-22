# Issue 243 Spec: Generic Work Item Dependencies

## Problem

Generic work-items can be scheduled, but they cannot yet carry priority or dependency metadata at creation time, and the dependency APIs only mutate legacy tasks. This prevents batch-created generic work-items from forming an accurate scheduler DAG.

## Requirements

- `/api/work-items` accepts optional `priority`, `dependsOn`, and `suggestedDependencies`.
- Dependency add/remove/dismiss APIs operate on unified work-items, including legacy tasks and persisted generic work-items.
- Cycle detection evaluates the unified mixed graph.
- Scheduler views expose confirmed and suggested edges for generic work-items.

## Acceptance

- Creating a generic work-item with `priority: "P1"` persists and returns that priority.
- Creating a generic work-item with `dependsOn` persists the confirmed edge.
- Adding a dependency from a generic work-item to a legacy task works.
- Adding a dependency that would create a legacy/generic cycle returns `dependency would create a cycle`.
- Removing a generic work-item dependency works.
- `/api/scheduler` includes confirmed DAG edges for generic work-items.
