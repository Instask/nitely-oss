# Nitely Positioning

Status: positioning source of truth for #93 and #397. This document is ready for
buyer-facing copy, but neither issue should be closed until #92 validates it
against at least 3 real failed AI coding attempts from customer discovery.

Naming boundary: `Nitely` is a temporary internal codename, not the approved
public commercial brand. The dated [naming strategy](naming-strategy.md) requires
a replacement and professional trademark clearance before public launch.

## Category

Nitely is an open, local-first governed spec-to-PR execution system.

It turns approved engineering intent into evidence-backed, reviewable draft PRs
through declared flows, typed artifacts, verification, policy gates, durable
recovery, and human review.

Codex, Claude Code, GLM, and future coding agents are interchangeable execution
runtimes. Nitely's product is the contract and evidence path around them: what
was approved, what each stage consumed and produced, what passed, what blocked,
who decided, and how the same pull request was recovered or reworked.

## Primary Buyer Pain

Teams already get useful code from Codex, Claude, GLM, and similar tools, but
AI coding is still hard to operationalize in team engineering workflows.

The common failure is not "the model cannot write code." The failure is that the
attempt does not become a reviewable PR:

- the spec is unclear or detached from implementation context;
- prompts, logs, test output, and decisions are scattered across terminals;
- runtime or quota failures leave no clean recovery point;
- reviewers cannot see why the change is safe;
- senior engineers spend expensive cleanup time turning partial output into a
  branch, tests, evidence, and a PR.

## Target Customer

Start with teams where reviewable PR throughput has direct value:

- AI-heavy agencies and dev shops where delivery speed maps to revenue;
- small high-output engineering teams already using coding agents for
  production work;
- teams with repeated task families: approved specs, bug tickets, dependency
  upgrades, API migrations, security fixes, review rework, or recurring
  engineering chores.

Defer teams that only want exploratory chat assistance, broad autonomous
engineering, or hosted IDE replacement.

## Alternatives Replaced

Nitely replaces or reduces:

- senior engineers manually turning approved specs into branches, tests, and
  PRs;
- copy/paste workflows inside Codex or Claude followed by manual cleanup;
- ad hoc shell scripts and lost terminal sessions;
- PR bots that publish diffs without enough execution evidence;
- CI-only automation that verifies code after the hard context and recovery
  work has already been lost.

## What Nitely Is Not

Nitely is not:

- a generic CI replacement;
- a cloud IDE;
- another agent wrapper;
- an Agent workforce, squad-routing, or project-management suite;
- a chat, inbox, board, or Gantt product;
- a platform-native AI suite locked to one source-control or DevSecOps vendor;
- a fully autonomous engineer;
- a hosted service that needs your source code, secrets, or agent execution by
  default;
- a promise that all generated code should merge without human review.

## Differentiators

- **Approved intent, not conversational assignment:** Nitely starts from an
  approved spec, technical plan, or bounded work item and carries it into a
  reviewable change.
- **Execution contracts, not Agent improvisation:** versioned Flows declare
  stage order, required inputs and outputs, typed artifacts, gates, approvals,
  verification, and publication behavior.
- **Evidence-backed PRs, not prompt-to-diff:** artifact integrity, run/stage/
  attempt provenance, commands, gate results, blocker/resume history, and
  reviewer decisions travel with the change.
- **Local-first trust boundary:** source code, worktrees, raw prompts, logs,
  secrets, and agent execution stay in the customer's environment by default.
- **Policy and recovery:** protected actions require approved gates; bounded
  retries, structured blockers, resume, rework routing, and reflection convert
  abandoned attempts into inspectable states.
- **Platform and model neutrality:** GitHub is the first change-request target,
  while flow contracts and local runtime selection remain independent of one
  coding-agent or DevSecOps vendor.
- **Human review remains central:** draft PRs, approval gates, review gates, and
  rework loops keep engineers in control.

## Competitor Learnings

Use this as internal positioning guidance. The comparison should sharpen the
buyer-facing story without turning Nitely into a broad AI coding platform.

| Competitor | Learn | Do not copy | Nitely implication |
| --- | --- | --- | --- |
| Factory.ai | Package the product around workflow throughput, operational metrics, a clear planning-to-release system map, and enterprise governance. | Do not position Nitely as a broad software factory or full SDLC automation platform. | Lead with a narrow, local-first repeatable PR workflow wedge instead of an everything-across-the-SDLC narrative. |
| Devin / Cognition | Lead with repeated task families, case studies, evals, scripts, and run history that improve over time. | Do not claim Nitely is an AI engineer replacement. | Show how approved specs, bugs, review rework, migrations, and CI failures become reviewable PRs with evidence. |
| Coder | Use enterprise trust language: customer-hosted, self-hosted, network-isolated, source-control boundaries, policy, and audit. | Do not compete as a developer workspace or VDI product. | Make code, prompts, logs, credentials, worktrees, and artifacts boundaries explicit. |
| GitHub Copilot coding agent | Treat GitHub-native issue-to-PR as the default buyer comparison; draft PRs, branch updates, logs, rework, and branch protection are table stakes. | Do not build a thin clone of GitHub's coding agent UX. | Explain why teams need a workflow layer outside GitHub-native automation: repeatable flows, local execution, richer recovery, and evidence continuity across tools. |
| GitLab Duo Agent Platform | Platform-native suites can bundle issue-to-MR, review, chat, IDE, security, and external coding agents with installed-base distribution. | Do not compete on DevSecOps breadth, IDE chat, enterprise distribution, or a closed platform's native surface. | Own the neutral, open, locally inspectable path: declared execution contracts and evidence that can operate across coding runtimes and outside one DevSecOps platform. |
| Multica | Agent-native project management can make workspaces, members, Agents, Squads, Issues, comments, tasks, chat, inbox, and clients one collaborative control plane. | Do not copy persistent Agent employees, squad routing, chat/inbox, board/Gantt depth, native clients, or provider-count competition. | Make the abstraction difference explicit: Multica coordinates an Agent workforce; Nitely governs versioned Flows, typed artifacts, gates, approvals, recovery, and PR evidence. Treat workforce or ticket systems as possible upstream intake layers, not a surface Nitely must replace. |
| OpenAI Codex and Claude Code | Codex, Claude Code, GLM, and future agents are runtimes whose background runs, worktrees, schedules, skills, hooks, MCP, and PR creation capabilities will keep improving. | Do not compete on model or agent capability, or on parallel AI execution alone. | Position Nitely as the workflow system that selects, runs, recovers, audits, and packages those runtimes into reviewable PRs. |
| Temporal | Durable execution is a stronger technical analogy than chat: run state, retries, resume, blockers, gates, provenance, evidence, rerun, and rework matter. | Do not become a generic workflow engine. | Stay focused on engineering work that ends in reviewable PRs, while borrowing durable-run language for reliability. |

Multica is materially broader today in collaboration, Agent profiles, Squads,
chat/inbox, automation triggers, provider coverage, desktop/mobile clients, and
self-hosting operations. Nitely should not imply parity on those surfaces. The
credible claim is narrower: its primary objects and proof are declared delivery
contracts and evidence-backed pull requests, not an Agent workforce.

This comparison is pinned to Multica commit
[`45ff984`](https://github.com/multica-ai/multica/tree/45ff984518788b33b8e98f74ffcdc9310e0bc02d),
reviewed on 2026-07-13; it is not a claim about future Multica versions. At that
commit, multi-stage work is Agent-driven rather than backed by a
[declarative workflow model](https://github.com/multica-ai/multica/blob/45ff984518788b33b8e98f74ffcdc9310e0bc02d/server/internal/handler/issue_child_done.go#L443-L455).
The checkout remains local, while the daemon
[sends Agent transcript and bounded tool-result excerpts](https://github.com/multica-ai/multica/blob/45ff984518788b33b8e98f74ffcdc9310e0bc02d/server/internal/daemon/daemon.go#L4220-L4370)
to the server before
[server-side redaction and persistence](https://github.com/multica-ai/multica/blob/45ff984518788b33b8e98f74ffcdc9310e0bc02d/server/internal/handler/daemon.go#L3160-L3225).
That is a different data boundary from Nitely's current customer-controlled
`.nitely` state. Nitely's standard Apache-2.0 license is also more permissive
for hosted or embedded derivatives than Multica's
[modified license](https://github.com/multica-ai/multica/blob/45ff984518788b33b8e98f74ffcdc9310e0bc02d/LICENSE).

## Product And Roadmap Guardrails

Use these constraints when accepting roadmap work:

- Agent profiles may describe runtime capability, but must not become persistent
  employee personas or an organizational hierarchy.
- Scheduling and queues may execute approved Flows, but must not become dynamic
  Squads or general Agent routing.
- Notifications may deliver blocker, approval, or result actions, but must not
  grow into a general chat or inbox product.
- The Web Console may expose task approval, run state, evidence, policy, and
  rework; board/Gantt/project-management depth belongs in upstream systems.
- Mobile browser support may review or approve customer-hosted runs; native
  desktop/mobile clients are not a current product goal.
- Runtime and provider support exists for customer choice and recovery;
  provider count is not a success metric.
- A future control plane must earn scope through pilot needs for policy,
  multi-repo operation, retention, audit, and customer-hosted runners—not by
  reproducing a workforce collaboration suite.

Features that cross these boundaries require explicit evidence that they
improve governed delivery, PR reviewability, or recovery. Competitive feature
parity alone is not justification.

## Layered Integration Model

Nitely should fit into an existing planning or workforce stack rather than
replace it:

```text
GitHub / Linear / Jira / Agent-workforce intake
  -> Nitely governed Flow
  -> draft PR + verification + evidence + blocker/result callback
```

GitHub is the first concrete contract. The provider-neutral v1 intake and result
envelopes are defined in
[upstream-integration-contract.md](upstream-integration-contract.md). They are
an adapter boundary for future integrations, not a claim that Nitely currently
ships a public webhook service.

## First Task Families

Start with flows that are repeated, bounded, and reviewable:

- **approved spec to reviewable PR:** take an approved spec and technical design
  through implementation, verification, review, and draft PR publication;
- **bug ticket to verified PR:** create or update the regression test, implement
  the smallest fix, verify it, and publish the evidence;
- **PR review feedback to same-PR rework:** apply reviewer feedback on the
  existing branch, re-run verification, and update the same change request;
- **dependency migration:** move a dependency, API, or framework version with
  scoped verification and migration notes;
- **CI failure repair:** reproduce a failing job, fix the failure, and preserve
  command output so reviewers can see what changed.

## Dashboard And Evidence Concepts

Competitive positioning should show throughput and reliability, not just agent
activity. Product planning should make these concepts visible in the Web Console
or pilot closeout reports:

- **PRs in review:** count draft or updated PRs currently waiting for humans;
- **cycle time:** measure time from approved input to reviewable PR or blocker;
- **pass rate:** show how often configured gates pass without manual cleanup;
- **blocked runs:** surface runs blocked by missing inputs, quota, policy, tests,
  or review findings;
- **recovery rate:** track failures converted into retry, resume, blocker,
  reflection, or same-PR rework evidence;
- **cleanup time saved:** estimate senior-engineer time avoided when a run lands
  as a reviewable PR instead of a partial terminal session;
- **repeated-flow usage:** identify task families used enough times to justify
  packaging, dashboards, policy, or customer-hosted runner support.

## Landing Page One-Liners

Use these as the first copy bank:

- Turn approved engineering intent into evidence-backed, reviewable draft PRs.
- Govern AI coding with declared inputs, outputs, gates, verification, and
  recovery—not another Agent workforce.
- Ship more AI-assisted PRs without losing traceability, recovery, or control.
- Run AI coding workflows in your environment, with logs, retries, worktrees,
  verification, and human review built in.
- Convert repeatable engineering chores into local flows that produce PRs your
  team can actually review.

## Proof Points

Use 3-5 depending on page length:

- Validates versioned Flows with declared stages, inputs, outputs, artifact
  contracts, and policy gates before execution.
- Creates isolated Git worktrees per run, so generated code is inspectable
  before it becomes a PR.
- Captures durable run evidence: inputs, prompts, logs, command output,
  artifacts, gates, decisions, blockers, recovery, and PR metadata.
- Publishes draft PRs through GitHub while preserving branch, verification, and
  rework history.
- Projects runtime failures, provider limits, and blocked stages as explicit
  states instead of disappearing terminal sessions.
- Keeps local execution and secret boundaries inspectable in the open-source
  core.

## Positioning Guardrails

Prefer:

- "governed spec-to-PR execution system";
- "evidence-backed PRs";
- "approved engineering tasks";
- "reviewable draft PRs";
- "local/customer-controlled execution";
- "traceability, recovery, and human review."

Avoid as buyer-facing lead terms:

- "agent runtime";
- "workflow runtime";
- "orchestrator";
- "Agent workforce";
- "AI project management";
- "autonomous engineer";
- "CI replacement";
- "cloud IDE."

Technical docs can still use runtime/backend/orchestrator terms when describing
implementation details.

## Validation Dependency

Before closing #93 or #397, compare this positioning against at least 3 failed
AI coding attempts collected through
[customer-validation.md](customer-validation.md):

- Does "spec-to-PR execution system" describe the pain better than "agent
  runtime"?
- Do the alternatives match what customers currently do?
- Do the proof points map to artifacts customers asked for?
- Are any disqualifiers missing or too late in the narrative?
- Did the failure require declared execution/evidence/recovery, or would
  workforce collaboration have solved the actual problem?
- Do customers want Nitely to replace their planning system, or integrate with
  it as a governed executor?

If validation fails, revise this document before updating landing-page copy.
