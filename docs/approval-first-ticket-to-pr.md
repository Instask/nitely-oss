# Approval-First Ticket-to-PR Product Contract

This document is the canonical acceptance contract for Nitely's first product
wedge. It describes the shipped, local-first workflow that turns a GitHub issue
or Jira ticket into an evidence-backed draft pull request, keeps human approval
ahead of implementation, and routes review feedback back into the same change.

The contract is intentionally narrower than a general software factory: coding
agents remain replaceable runtimes inside a governed delivery workflow.

## Acceptance Matrix

### 1. Intake a GitHub issue or Jira ticket

- The Web/CLI/API planning intake accepts GitHub issue, Jira ticket, external
  document, prompt, and conversation sources; see
  [planning-intake.md](planning-intake.md) for the shared contract.
- Source snapshots retain the normalized title, body, URI, fetch time, content
  hash, and provider identity needed for duplicate detection and drift checks.
- GitHub and Jira status sync are optional, customer-controlled side effects;
  local planning remains authoritative when sync is disabled or unavailable.

### 2. Generate and approve planning artifacts

- Nitely generates a source-grounded specification, then a technical design.
- Spec and technical-design revisions are immutable and preserve approval state.
- Readiness gates prevent implementation until both artifacts are explicit,
  current, and human-approved.
- Approval Inbox actions record the actor, action, reason when required, and
  exact task/run/artifact linkage.

### 3. Execute implementation through a draft PR

- Approved task artifacts are materialized as run inputs in an isolated Git
  worktree.
- Versioned Flows run implementation, verification, review, reflection, and
  draft-PR publication under declared artifact and gate contracts.
- A failed or interrupted run remains inspectable and recoverable through
  bounded retry, structured rework, operator questions, and resume.

### 4. Review the pull request

- The draft pull request links back to run evidence and stays a human review
  boundary; Nitely does not autonomously merge it.
- PR review notifications identify their supported actions and can mirror to
  the exact pull request discussion plus optional team delivery channels.
- Review, verification, blocker, approval, and publication outcomes remain
  visible from the task and run surfaces.

### 5. Route feedback into same-PR rework

- GitHub review comments become structured feedback with exact source links.
- Typed verdicts distinguish code fixes, specification rework, and escalation.
- Rework checks out and updates the existing pull-request branch instead of
  creating an unrelated change request.
- The original run, feedback, rework route, child run, and updated PR remain
  linked as one reviewable chain.

### 6. Preserve reusable memory and closeout evidence

- Reflection and reviewer feedback can propose repository context knowledge;
  approval or rejection is explicit and linked to the exact proposal.
- Completion gaps can converge into stable remaining-work tasks and optional
  deduplicated GitHub issues.
- Local evidence supports metadata search, checksummed closeout export, and
  dry-run-first retention cleanup without hosted source-code custody.

## Live And Deterministic Proof Boundaries

The two acceptance paths prove different things and should not be conflated.

- **Live-provider path:** use customer-controlled GitHub or Jira credentials to
  ingest a real ticket, approve the generated artifacts, publish a real draft
  pull request, ingest reviewer feedback, and update that same pull request.
  Provider permissions, repository policy, agent runtimes, and network access
  are checked during customer-hosted runner onboarding.
- **Deterministic proof path:** mock external provider calls while exercising
  the real Nitely task model, planning projection, Flow runner, Git worktrees,
  command stages, review/reflection stages, evidence writer, publish stage,
  rework checkout, and update-change stage. This path is repeatable in CI and
  fails closed when any proof signal is false.

Run the deterministic proof from any directory:

```sh
nitely smoke golden-path --output /tmp/nitely-golden-path
```

The generated `summary.json` must contain:

```json
{
  "proof": {
    "approvedPlanning": true,
    "verifiedImplementation": true,
    "draftPullRequest": true,
    "evidenceBacked": true,
    "controlledSamePullRequestRework": true
  }
}
```

See [golden-path-demo.md](golden-path-demo.md) for the output paths and failure
semantics. The Web Console exposes the same mocked proof through its golden-path
demo action. Synthetic demo repositories and runs are excluded from live
provider lookups performed by the Manager Dashboard, scheduler, and inbox PR
reconciliation. They are also excluded from Manager Dashboard totals and Pilot
ROI metrics, so mocked proof cannot be mistaken for customer-provider evidence.

## Evidence Contract

Every acceptance claim must be reconstructable from local records rather than
from an untraceable dashboard total.

| Claim | Required durable evidence |
| --- | --- |
| Ticket intake | Provider URI and normalized source snapshot, duplicate identity, drift state, and optional sync receipt. |
| Human planning control | Versioned spec and technical design, readiness result, approval state, and notification decisions. |
| Governed execution | Materialized approved inputs, stage attempts, command and gate events, artifact hashes/provenance, blockers, retry/rework decisions, and terminal state. |
| Verification | Declared verification output and review verdict tied to the producing attempt. |
| Draft PR | Branch, commit, change-request URL/state, publication event, and evidence summary. |
| Feedback loop | Exact review source, typed route, same-PR rework history, child-run linkage, verification, and update-change result. |
| Learning | reflection and context knowledge proposal, human decision, linked run/task, and safe source metadata. |

Notification actions and delivery receipts are specified in
[notification-actions-and-delivery.md](notification-actions-and-delivery.md).
Artifact enforcement is described in [harness-and-audit.md](harness-and-audit.md),
and local evidence lifecycle controls are in
[evidence-retention-search-export.md](evidence-retention-search-export.md).

## Metrics And Traceability

The lifecycle dashboard combines local task/run evidence with bounded,
short-lived cached live provider status lookups and projects:

- Reviewable PRs deduplicated across same-PR rework, accepted completed PRs,
  merged PRs, merge rate over status-known PRs, and merge-status lookup coverage;
- average PR cycle time plus planning, execution, review, and rework phase
  durations;
- overall completion, rework, and review-gate pass rates, plus per-Flow
  completed, blocked, failed, acceptance, and evidence-completeness results;
- stopped or blocked work, recoverable failures, rework attempts, and evidence
  completeness;
- estimated cleanup time avoided and repeatable Flow usage.

The dashboard deduplicates same-PR rework before counting PR outcomes. Live
lookups canonicalize GitHub URL variants to a repository and PR number, keep at
most four real provider requests in flight, and stop dashboard waiting after a
five-second batch deadline. Hung requests retain their bounded slot until they
settle; queued lookups and lookup failures remain unknown instead of being
counted as unmerged. Both the merge-rate denominator and lookup coverage stay
explicit. Merge status is a current provider observation rather than immutable
local run telemetry; a pilot closeout should retain the dated dashboard/export
evidence used for its report.

Aggregate rows retain task/run/PR identifiers or evidence links. Estimated
cleanup savings remain explicitly estimated; they are not presented as measured
engineering time. The initial repeatable families and their qualification rules
live in [pilot-flow-templates.md](pilot-flow-templates.md).

## Operating And Trust Boundary

Customer-hosted setup, credential checks, agent runtime checks, repository
policy, and the persisted setup report are documented in
[customer-hosted-runner-onboarding.md](customer-hosted-runner-onboarding.md).
The local execution/evidence loop remains open and inspectable as defined by
[open-core-boundary.md](open-core-boundary.md).

Optional hosted coordination may add shared queues, organization policy, or
fleet operations. It must not make local planning approval, execution,
recovery, evidence, or same-repository PR rework depend on hosted Nitely source
custody.

## Non-Goals

- No broad Factory-style software factory or Agent workforce.
- No claim that Nitely supplies superior coding-model intelligence.
- No autonomous merge or deploy.
- No hosted source-code custody requirement.
- No general chat, project-management, board, or Gantt product.
- No provider-count roadmap; integrations exist only to support governed
  ticket-to-PR delivery.

## Regression Runbook

Use these checks after changing the product contract or its core lifecycle:

```sh
pnpm vitest run test/docs/approval-first-ticket-to-pr.test.ts
pnpm vitest run test/demo/golden-path.test.ts
nitely smoke golden-path --output /tmp/nitely-golden-path
pnpm check
pnpm build
```

The deterministic proof complements, but does not replace, a live-provider
pilot smoke against customer-controlled GitHub or Jira repositories.
