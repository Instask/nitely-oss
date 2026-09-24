# Governed Spec-to-PR Positioning Tech Design

## Scope

Implement the repository-controlled portion of #397. This is a positioning and
proof change, not a new orchestration subsystem. Existing run, approval,
verification, publish, evidence, and rework primitives remain the product
implementation; this slice makes their combined value explicit and testable.

## Source Of Truth

`docs/positioning.md` remains the reusable buyer-positioning source. Update it
to lead with “governed spec-to-PR execution” and “evidence-backed PRs,” then add:

- an abstraction-level Multica comparison based on the pinned source review in
  #397;
- the platform-native GitLab Duo comparison already captured in #93;
- product and roadmap guardrails that keep collaboration surfaces subordinate
  to governed delivery;
- a layered integration model where GitHub, Jira, Linear, or workforce systems
  can supply approved work and consume a PR/evidence result.

README introductions consume the same message. Technical sections may continue
to use runtime, backend, and orchestrator terminology where it is precise.

## Golden-Path Proof

Extend `GoldenPathDemoResult` with a `proof` object:

```ts
{
  approvedPlanning: boolean;
  verifiedImplementation: boolean;
  draftPullRequest: boolean;
  evidenceBacked: boolean;
  controlledSamePullRequestRework: boolean;
}
```

Compute each signal from durable task/run/change-request state, not hard-coded
success values. Abort the demo if any signal is false. Persist the object in
`summary.json` and render each signal in the generated demo README so both
automation and a human evaluator can verify the product claim.

## Upstream Integration Contract

Add `docs/upstream-integration-contract.md` as a provider-neutral v1 envelope
with a GitHub issue example. The intake side declares:

- contract version and idempotency key;
- source and repository identity;
- selected Nitely flow and work-item type;
- immutable input artifact references;
- optional authenticated callback target.

The callback side declares accepted, running, blocked, completed, failed, and
cancelled states; run and task identity; PR metadata; blocker metadata; and
evidence references. The document must state that this is an adapter contract,
not a claim that a public webhook endpoint ships today.

## Validation Boundary

Update customer-validation guidance to test whether actual failures require
declared contracts/evidence/recovery or workforce collaboration. #397 remains
open until at least three real failed attempts have been evaluated. Repository
tests verify the dependency is stated; they do not substitute for interviews.

## Tests

- Extend positioning documentation tests for Multica, GitLab Duo, product
  guardrails, README alignment, integration contract, and validation dependency.
- Extend the golden-path integration test to assert every proof signal and the
  generated human-readable proof report.
- Run typecheck, build, positioning tests, and the isolated golden-path test.
