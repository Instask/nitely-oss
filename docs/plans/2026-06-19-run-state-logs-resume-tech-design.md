# Run State, Logs, and Resume Tech Design

Issue: https://github.com/Instask/nitely/issues/5

## Design

Wire the existing `EventStore` into `runFlow` and add projections in
`src/run/project.ts`.

Important event types:

- `run.created`
- `workspace.created`
- `stage.started`
- `stage.completed`
- `stage.failed`
- `command.completed`
- `approval.requested`
- `approval.resolved`
- `change.published`
- `run.completed`
- `run.failed`

The event log is authoritative. JSON metadata files can remain as convenience
artifacts but should not be the only source of truth.

## CLI

Add command handlers in `src/cli.ts` using dependency injection so tests can
assert formatting without spawning the binary.

## Resume

Resume should not assume an old agent process survived. If projection sees a
stage in `started`, mark it `interrupted` and create a new attempt with failure
context.

## Verification

Run:

```bash
pnpm exec vitest run test/events test/run test/cli.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```

