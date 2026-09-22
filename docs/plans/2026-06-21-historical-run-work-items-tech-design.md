# Issue 82 Tech Design: Historical Run Work Items

## Approach

Use read-time virtual work items. This avoids mutating `.nitely/work-items`, keeps `/api/runs` unchanged, and makes older runs visible immediately.

## Implementation

Extend `src/web/work-item-views.ts`:

- Load persisted unified work items and run summaries together.
- Associate runs with persisted items using the existing matching logic.
- Track matched run ids.
- Group unmatched runs into inferred work items using a stable inference key:
  - PR number from `prNumber`, `prUrl`, or `changeRequestUrl`;
  - issue number from `specs/issues/<number>-...` or `.nitely/task-inputs/<number>-...`;
  - rework input path when PR metadata is unavailable;
  - docs/plans path stem;
  - run id fallback.
- Build `WorkItemView` records from those inferred groups with `source: "inferred"` and `inferred: true`.
- Resolve `getWorkItemView` by falling back to inferred items if no persisted item exists.

## Data Shape

Inferred work items use stable ids such as:

- `inferred-pr-86`
- `inferred-issue-083`
- `inferred-run-2026-...`

The existing `WorkItemRecord` shape is preserved; `WorkItemView` gains optional `source` and `inferred` fields for UI distinction.

## Tests

Add web work-item view tests that create orphan historical run records and assert:

- inferred groups appear in `listWorkItemViews`;
- issue-path and task-input runs group together;
- PR metadata wins for rework runs;
- no-input runs appear as per-run inferred work items;
- `getWorkItemView` opens inferred detail and returns associated runs newest first.
