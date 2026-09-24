# Governed Spec-to-PR Golden Path Demo

This is Nitely's primary deterministic product demo. It proves the governed
spec-to-PR claim without relying on a live coding-agent or SCM provider:

1. create a fixture Git repository;
2. create a task with a source issue snapshot, spec, and technical design;
3. materialize the approved planning artifacts as execution inputs;
4. evaluate the initial Work item's Run eligibility through the same deep
   interface used by the Web Console and scheduler;
5. run implementation from the evaluator's runner input, then verify, review,
   reflect, and publish a mocked draft PR;
6. simulate reviewer feedback;
7. run same-PR rework, verification, reflection, and mocked PR update;
8. write evidence for both runs;
9. fail closed unless approved planning, eligible implementation start,
   verification/review, draft PR publication, durable evidence, and controlled
   same-PR rework are all proven.

Run it from the repository root:

```sh
pnpm dev -- smoke golden-path --output /tmp/nitely-golden-path
```

The command recreates the output directory and writes:

- `/tmp/nitely-golden-path/summary.json`
- `/tmp/nitely-golden-path/README.md`
- `/tmp/nitely-golden-path/fixture-repo/.nitely/runs/run-golden-implementation/evidence.md`
- `/tmp/nitely-golden-path/fixture-repo/.nitely/runs/run-golden-rework/evidence.md`

External services are mocked. The demo still uses the real Nitely flow runner,
Run eligibility interface, Git worktrees, command stages, task planning
artifact projection, evidence writer, draft PR publish stage, rework checkout,
and update-change stage. The evaluator receives a demo-only provider store that
marks mocked GitHub publishing as configured; no live credential is used.

The rework Run is intentionally not evaluated as a new Work item Run start. It
is a continuation of the accepted implementation Run and existing pull request,
anchored by `priorRunId` and `changeRequestTarget`. This keeps the exception
local to the continuation seam instead of creating a second admission path for
initial implementation.

The Web Console persists the demo repository with an explicit synthetic marker
and excludes its tasks and runs from live provider lookups performed by the
Manager Dashboard, scheduler, and inbox PR reconciliation. Synthetic data is
also excluded from Manager Dashboard totals and Pilot ROI metrics.

`summary.json` includes a machine-readable `proof` object:

```json
{
  "approvedPlanning": true,
  "eligibleImplementationStart": true,
  "verifiedImplementation": true,
  "draftPullRequest": true,
  "evidenceBacked": true,
  "controlledSamePullRequestRework": true
}
```

The generated README renders the same six checks for a human evaluator. A
false signal aborts the smoke instead of producing a successful-looking demo.
The result demonstrates Nitely's product boundary: declared approved intent to
an evidence-backed draft PR and recoverable rework, not Agent-workforce or
project-management breadth.

Use this smoke after changing task approval, source snapshotting, Run
eligibility, scheduler execution inputs, publish/update-change behavior, or run
evidence projection.
