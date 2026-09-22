# Tech Design: Production Flow Template Set

## Context

#96 packages repeatable pilot workflows on top of the existing flow schema,
publish/update stages, review gates, and reflection finalizers.

## Design

- Add three built-in flow templates in `src/flows/templates.ts`:
  - approved spec to PR;
  - bug ticket to failing test and fix PR;
  - PR review feedback to updated PR branch.
- Each template declares metadata inputs, agent implementation/rework stages,
  command verification, review gate, publish/update stage, and `alwaysRun`
  reflection.
- Add `docs/pilot-flow-templates.md` as the operator guide. It includes:
  - use case and discovery-call failure mode;
  - expected inputs;
  - stage outline;
  - verification command;
  - PR/evidence outputs;
  - failure/retry behavior;
  - one example run command.
- Extend flow template tests so pilot templates are validated and checked for
  PR evidence, verification, and reflection finalizers.

## Validation

- `pnpm check`
- `pnpm exec vitest run test/flows/validate.test.ts`
- `pnpm test:run`
