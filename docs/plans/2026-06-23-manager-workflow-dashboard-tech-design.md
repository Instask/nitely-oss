# Tech Design: Manager Workflow Dashboard

## Overview

Add a read-only dashboard projection on top of existing Web Console task/run
data. The server already has multi-repo helpers that filter records by user and
decorate records with repository metadata, so the dashboard should consume those
lists rather than adding a metrics store.

## Backend

- Add `src/web/dashboard.ts` with a pure `buildManagerDashboard` function.
- Inputs: visible work item views, visible run summaries, configured
  repositories, and `now`.
- Outputs:
  - throughput counts by task/run status;
  - blocked task/run rows with age in milliseconds;
  - token/cost totals from `runtimeUsage` and `contextUsage`;
  - outcome quality: completion rate, failure/blocked counts, rework ratio,
    review gate pass rate;
  - repo breakdowns for filtering/attribution.
- Add `GET /api/dashboard` that calls the existing multi-repo list helpers and
  returns `{ dashboard }`.

## Frontend

- Add a Dashboard nav item and `/dashboard` route.
- Fetch `/api/dashboard` with existing console data.
- Render metric cards, repo breakdown, blocked aging list, cost attribution,
  and outcome quality panels.
- Avoid per-person rankings. Submitter remains available only as owner labels on
  blocked rows or future filters.

## Testing

- Unit-test dashboard aggregation.
- API-test `/api/dashboard` across multiple repos and user-visible data.
- Static-test that the console contains the Dashboard view and no default
  individual ranking language.
