# Approval Gates Tech Design

Issue: https://github.com/Instask/nitely/issues/4

## Design

Represent approvals as event-backed records in the run event store. The event
store is already the durable source of truth for run state, so approval CLI
commands append `approval.resolved` rather than maintaining a separate JSON
state file.

Each record contains:

- `id`
- `runId`
- `stageId`
- `attempt`
- `status`: `pending`, `approved`, or `denied`
- `prompt`
- `createdAt`
- `resolvedAt`

## Runtime Flow

When an `approval` stage or protected `publish-change` stage is reached:

1. Append `approval.requested` with a stable approval ID.
2. Project the stage and run as `awaiting-approval`.
3. Return a run result with status `awaiting-approval`.

`resume` reloads the event projection, checks the approval status, and either
continues from the same approval attempt or fails the run on denial.

## CLI

Extend `src/cli.ts` with approval commands and dependency injection for tests.
Keep output plain text and stable for assertions.

## Verification

Run:

```bash
pnpm exec vitest run test/approval test/run test/cli.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```
