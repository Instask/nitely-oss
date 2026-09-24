# Tech Design: Paid Pilot Offering

## Context

#95 is a documentation and packaging issue. It should give the first commercial
conversations a concrete paid pilot offer without changing runtime behavior or
implying a hosted SaaS product exists.

## Design

- Add `docs/paid-pilot-offering.md` as the source-of-truth one-pager.
- Include:
  - qualification criteria;
  - price and duration;
  - included and excluded scope;
  - success metrics;
  - onboarding checklist;
  - weekly operating rhythm;
  - pilot closeout decisions;
  - how learnings feed team-control-plane requirements.
- Add `docs/templates/paid-pilot-onboarding-checklist.md` as a reusable
  customer-specific checklist that can be copied into a pilot workspace.
- Link the one-pager from `README.md` and `docs/open-core-boundary.md` so the
  paid services boundary remains visible next to the open-core boundary.
- Add a focused docs test that locks the required one-pager sections.

## Validation

- `pnpm exec vitest run test/docs/paid-pilot-offering.test.ts`
- `pnpm run check`
- `pnpm test:run`
- `git diff --check`
