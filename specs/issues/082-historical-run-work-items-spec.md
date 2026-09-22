# Issue 82 Spec: Historical Run Work Items

## Problem

The Web Console can list historical runs, but older runs created before first-class tasks/work-items are invisible from the work-item surfaces. Users can inspect `/api/runs`, yet `/api/work-items` only shows persisted legacy tasks or generic work items.

## Goal

Expose orphan historical runs as read-time inferred work items without changing existing run storage or migrating files on disk.

## Requirements

- Keep `/api/runs` behavior unchanged.
- Preserve persisted task and work-item behavior.
- Synthesize virtual work items for runs that do not match an existing task/work-item.
- Group orphan runs by stable signals:
  - PR metadata or change request URL;
  - issue-numbered `specs/issues/...` inputs;
  - issue-numbered `.nitely/task-inputs/...` inputs;
  - `.nitely/rework-inputs/...` inputs, preferring PR metadata when present;
  - otherwise by the individual run id.
- Make inferred work-item detail resolvable through the same `getWorkItemView` path.
- Mark inferred items so the UI/API can distinguish them from persisted records.

## Acceptance Criteria

1. Persisted work items still appear exactly once.
2. Orphan runs from `specs/issues/...` and `.nitely/task-inputs/...` with the same issue number are grouped together.
3. Rework runs with PR metadata are grouped by PR.
4. Runs with no useful inputs appear as individual inferred work items.
5. Inferred work-item detail returns all associated runs newest first.
6. Tests cover the inferred grouping and detail behavior.
