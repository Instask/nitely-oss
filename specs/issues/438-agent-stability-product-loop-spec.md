# Issue #438 Specification: Agent Stability Product Loop

## Objective

Add a closed-product Agent Stability view to the Nitely Web Console so teams can
see whether agent implementation work is healthy, blocked, failing, or ready for
open-source contract extraction.

## Problem

Nitely already records rich run, task, stage, publication, evidence, and
toolchain state, but operators must inspect several pages and raw run artifacts
to answer basic stability questions:

- Which agent runs are blocked or failing right now?
- Are failures concentrated in a stage, runtime, repository, or missing local
  tool?
- Did the latest implementation attempt create or update a change request?
- Is there enough evidence to trust a completed run?
- Which parts of the closed product are candidates for later OSS extraction?

Without one product loop, it is hard to dogfood Nitely on Nitely work, and later
OSS extraction risks copying private product assumptions instead of stable
contracts.

## User-Visible Behavior

- The Web Console exposes a first-class Agent Stability surface.
- The surface summarizes recent agent work across visible local tasks and runs:
  - active, blocked, failed, incomplete, and completed run counts;
  - aging blocked work and blocker reasons;
  - failure clusters by stage, status, runtime, flow, and repository when those
    dimensions are available;
  - runner readiness based on recorded toolchain/runtime preflight data;
  - recent change records from publication/change-request metadata;
  - self-test and verification evidence from completed runs;
  - OSS extraction candidates that map closed-product signals to future public
    contracts.
- The Web Console exposes the same data through a JSON endpoint for tests and
  future integrations.
- The view is read-only. It must not start, resume, approve, merge, or deploy
  work.

## In Scope

- Add a projection module that derives Agent Stability data from existing local
  task/run/dashboard/evidence projections.
- Add an HTTP endpoint such as `GET /api/agent-stability`.
- Add a Web Console tab or section that renders the projection.
- Include static OSS extraction candidates for:
  - event schema and heartbeat contracts;
  - runner lifecycle, registration, and capability model;
  - audit/evidence metadata protocol;
  - connector interface with local rehearsal and mock/stub support;
  - runner doctor and black-box self-test suite.
- Add targeted unit/API/UI tests for the projection and route/rendering.
- Keep CLI behavior compatible.

## Out of Scope

- Prometheus, paging, email, Slack, or external alert delivery.
- Real canary scheduling or synthetic agent execution.
- Multi-tenant database, billing, or hosted runner fleet management.
- New secret storage or SaaS connector credentials.
- Implementing the separate `nitely-control-plane`, `nitely-runner`,
  `nitely-cloud`, or `nitely-oss` repositories in this change.
- Changing the publish, merge, or deploy workflow.

## Data Rules

- Prefer existing projected state over direct ad hoc artifact parsing.
- Do not expose secret values, environment variables, access tokens, raw
  provider credentials, or full private logs through the new endpoint.
- Treat evidence as metadata-first: expose paths, IDs, media types, readiness,
  counts, and short statuses, not arbitrary full artifact bodies.
- Keep filesystem reads bounded to the same local `.nitely` state already used
  by the Web Console.
- Missing optional data should produce empty sections or `unknown` states rather
  than failing the whole endpoint.

## Acceptance Checks

1. `GET /api/agent-stability` returns valid JSON when the repo has no tasks or
   runs, with zero counts and populated OSS extraction candidates.
2. The projection identifies blocked and failed runs, includes blocker reason
   and age when available, and groups failures by at least status and stage.
3. The projection reports runner/toolchain readiness from recorded preflight
   data without leaking secrets.
4. The projection reports recent change records when run publication or
   change-request metadata exists.
5. The projection reports verification/self-test evidence from completed runs
   when evidence metadata exists, and shows missing/partial evidence otherwise.
6. The Web Console renders the Agent Stability section on desktop and mobile
   without overflowing labels, counters, or table cells.
7. Existing dashboard, run detail, and task APIs continue to work.
8. Targeted tests and the repository build pass.

## Edge Cases

- Empty repo state: show zero-count cards and the OSS extraction roadmap.
- Interrupted run with no current stage: count as incomplete and include it in
  operator attention.
- Failed run without stage metadata: group under `unknown-stage`.
- Local-only branch without a PR URL: show the branch/commit if available and
  mark change request as not published.
- Missing toolchain preflight file: mark runner readiness as unknown, not
  failed.
- Malformed optional metadata: ignore that item and keep the rest of the
  projection usable.

## Likely Files

- `src/web/agent-stability.ts`
- `src/web/server.ts`
- `src/web/static/console.dc.html`
- `test/web/agent-stability.test.ts`
- `test/web/server.test.ts`
- `test/web/console-static.test.ts`
