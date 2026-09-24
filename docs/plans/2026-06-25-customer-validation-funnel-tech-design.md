# Tech Design: Customer Validation Funnel

## Context

#92 requires external customer interviews. The repository can provide the
repeatable interview workflow, note templates, classification taxonomy, and
recommendation report format, but it cannot honestly complete the issue without
real customer conversations.

## Design

- Add `docs/customer-validation.md` as the operator guide for running the 5
  interviews.
- Include:
  - target customer profile;
  - discovery questions from #92;
  - failure classification taxonomy;
  - interview notes storage path;
  - failed-attempt reconstruction fields;
  - recommendation template.
- Add `docs/templates/customer-discovery-interview.md` for one interview note.
- Add `docs/templates/customer-validation-recommendation.md` for the final
  continue/narrow/pause recommendation.
- Link the guide from `README.md`, #95 paid pilot docs, and #96 pilot flow docs
  so commercialization artifacts point to the same validation source.
- Add a focused docs test that locks the required sections.

## Validation

- `pnpm exec vitest run test/docs/customer-validation.test.ts`
- `pnpm run check`
- `pnpm test:run`
- `git diff --check`
