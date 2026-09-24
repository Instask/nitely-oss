# Retry and Rework Policy Tech Design

Issue: https://github.com/Instask/nitely/issues/3

## Design

Introduce a pure policy module and wire it into `runFlow` without changing the
flow schema beyond existing `maxAttempts`.

```ts
type PolicyDecision =
  | { action: "complete" }
  | { action: "retry"; reason: string }
  | { action: "rework"; targetArtifact: string; reason: string }
  | { action: "fail"; reason: string };
```

The first implementation should use deterministic inputs only: stage result,
attempt number, max attempts, and optional rework target. Agent review can be
added later as a producer of recommendations, not as policy authority.

## Implementation Notes

- Add `src/policy/decide.ts`.
- Add `test/policy/decide.test.ts`.
- Extend `runFlow` attempt execution so each retry writes a new attempt
  directory.
- Command failures should write `stdout.log`, `stderr.log`, and `output.md`.
- Agent retry prompts should include prior failure summary and tell the agent
  not to repeat the failed approach.
- Keep the scheduler sequential.

## Verification

Run:

```bash
pnpm exec vitest run test/policy test/run
pnpm exec vitest run
pnpm run check
pnpm run build
```

