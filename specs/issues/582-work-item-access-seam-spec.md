# Issue #582 — Shared Work item access seam

## Problem

Task (`.nitely/tasks`) and generic Work item (`.nitely/work-items`) records
share execution semantics, but callers previously imported the legacy adapter
directly and repeated store resolution before run-state writes.

## Behavior

`src/work-items/access.ts` is the caller-facing seam for:

- unified reads and projections;
- generic/legacy candidate selection;
- legacy candidate preparation/finalization;
- run-state updates with an optional known store to avoid a second lookup.

The adapter remains the compatibility implementation for the legacy `dev.pr`
projection; no storage migration is introduced.

## Acceptance checks

- admission and scheduler update through the same run-state seam;
- Web views, CLI, and webhook projection use the access seam;
- generic and legacy IDs resolve to the correct store and projection;
- same-ID generic preference and stale/ambiguous behavior remain unchanged;
- tests cover both store kinds.
