# Technical Design: Agent Stability Product Loop

## Goal

Implement the first closed-product Agent Stability loop in Nitely's Web Console.
The result should make Nitely useful for monitoring its own agent runs while
leaving future OSS extraction as a contract-driven follow-up.

## Existing Patterns To Reuse

- Use the Web Console's existing local-first projection style.
- Reuse run projection APIs from `src/run/project.ts` through the Web layer
  rather than reparsing event logs in the UI.
- Reuse dashboard/work-item helpers from `src/web/dashboard.ts`,
  `src/web/runs.ts`, and related Web modules when practical.
- Reuse existing JSON error handling, redaction helpers, and HTTP route shape in
  `src/web/server.ts`.
- Keep the UI in `src/web/static/console.dc.html` consistent with the current
  console: dense operational cards, tables, status chips, and responsive grids.

## Projection Module

Add `src/web/agent-stability.ts` with exported types and a builder function,
for example:

```ts
export interface AgentStabilityProjection {
  generatedAt: string;
  summary: AgentStabilitySummary;
  attention: AgentStabilityAttentionItem[];
  failureClusters: AgentStabilityFailureCluster[];
  runnerReadiness: AgentStabilityRunnerReadiness[];
  changeRecords: AgentStabilityChangeRecord[];
  verification: AgentStabilityVerificationSummary;
  ossExtraction: AgentStabilityOssCandidate[];
}
```

The builder should accept explicit inputs where possible so unit tests can feed
fixtures without creating a full server:

```ts
buildAgentStabilityProjection({
  runs,
  tasks,
  repositories,
  now,
})
```

If existing Web helpers already provide richer `WebRunSummary` or
`WebRunDetail` objects, use those instead of inventing new parsing. If some
data is only available in detailed run projection, load details lazily and
bounded by the recent-run window used by the Web Console.

## Summary And Attention

Compute counts for:

- active: `running`, `awaiting-approval`;
- blocked: `blocked`;
- failed: `failed`;
- incomplete: `incomplete`, `interrupted`, `cancelled`;
- completed: `completed`;
- total visible runs.

Attention items should include blocked, failed, and incomplete runs. Include
run id, task id/title when known, repo name when known, status, current stage,
blocker reason, age label, and link target that the console can route to.

## Failure Clusters

Group operator-facing failures by these dimensions when available:

- status;
- current or failing stage;
- runtime;
- flow template;
- repository.

Use stable keys such as `status:failed`, `stage:implement`, and
`runtime:grok`. Unknown dimensions should be grouped under explicit unknown
keys instead of being dropped.

## Runner Readiness

Derive runner readiness from recorded run/process/toolchain metadata:

- runtime (`codex`, `grok`, `glm`, or unknown);
- model when recorded;
- command/tool status when preflight data exists;
- last observed run id and timestamp;
- missing tools or warnings from preflight diagnostics;
- readiness state: `ready`, `degraded`, `missing`, or `unknown`.

Do not execute runtime CLIs from the Web request path. This view reflects
recorded evidence only.

## Change Records

Expose recent change records from existing publication/change-request metadata:

- run id and task id;
- branch/head commit when available;
- change request URL and PR number when available;
- publication state (`published`, `updated`, `local-only`, `unknown`);
- latest publish/update error if the projected run already records it.

Keep this read-only. Do not call GitHub from the request path.

## Verification And Evidence

Summarize completed and failed verification outcomes using existing stage and
artifact readiness metadata:

- total verification stages observed;
- passed, failed, missing, partial, and unknown counts;
- latest evidence-ready run ids;
- self-test candidates, initially inferred from flow/stage names containing
  `test`, `verify`, `self-test`, or `doctor`.

Return metadata and counts only. Do not expose arbitrary stdout/stderr bodies or
full artifact contents.

## OSS Extraction Candidates

Return a static, versioned candidate list in the projection so the closed UI
keeps future OSS boundaries visible:

- `protocol`: event schema, heartbeat, and run projection contract;
- `runner-lifecycle`: registration and capability model;
- `evidence-metadata`: audit/evidence metadata protocol;
- `connector-interface`: local rehearsal, mock, and stub contracts;
- `doctor`: `nitely-runner doctor` and black-box self-test suite.

Each candidate should include status (`candidate` for now), closed-product
source signal, intended public contract, and extraction notes. This is product
roadmap metadata, not a claim that the OSS packages already exist.

## API

Add `GET /api/agent-stability` to `src/web/server.ts`.

Expected response:

```json
{
  "agentStability": {
    "generatedAt": "2026-08-02T00:00:00.000Z",
    "summary": {},
    "attention": [],
    "failureClusters": [],
    "runnerReadiness": [],
    "changeRecords": [],
    "verification": {},
    "ossExtraction": []
  }
}
```

Follow existing server conventions for repository resolution, status codes, and
JSON error payloads.

## UI

Update `src/web/static/console.dc.html`:

- add an Agent Stability navigation item/tab/section;
- fetch `/api/agent-stability` along with the other dashboard data;
- render compact cards for summary counts;
- render tables/lists for attention, failure clusters, runner readiness, change
  records, verification, and OSS candidates;
- keep labels short and responsive;
- show empty states without instructional marketing copy.

Avoid nested cards and avoid changing unrelated console layout behavior.

## Tests

Add `test/web/agent-stability.test.ts` covering:

- empty projection;
- blocked/failed/incomplete attention items;
- failure grouping with unknown dimensions;
- runner readiness from preflight metadata without secret leakage;
- change records from publication metadata;
- verification evidence summary;
- static OSS extraction candidates.

Extend existing Web server/static tests, depending on local conventions:

- route test for `GET /api/agent-stability`;
- static console test that confirms the Agent Stability section and fetch hook
  exist.

## Verification Commands

Run the narrow tests first, then the repository checks:

```bash
pnpm exec vitest run test/web/agent-stability.test.ts test/web/server.test.ts test/web/console-static.test.ts
pnpm run check
pnpm run build
```

If the repo does not have one of the listed test files, use the nearest existing
Web Console test file and document the substitution in the PR.

## Rollout And Risk

- This is read-only and projection-based, so rollback is a UI/API removal.
- No database migration is needed.
- Request-time work must stay bounded; avoid scanning unbounded artifact bodies.
- The main security risk is accidental secret/log exposure, so use existing
  redaction helpers and metadata-only evidence fields.
- Do not implement external alerts or live runner probes in this issue.
