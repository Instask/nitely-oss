# Nitely Open-Core Boundary

Status: source of truth for #94.

Nitely's open-source core should let one engineer inspect, run, verify, recover,
and trust local spec-to-PR execution. Commercial products should help teams
operate that core reliably across repositories, people, policies, and hosted or
customer-hosted runners.

## Boundary Principle

One engineer should be able to run the core locally and understand what code,
credentials, prompts, logs, worktrees, and evidence Nitely touches. Teams pay
for coordination: shared queues, multi-repo visibility, policy, retention,
permissions, SSO, audit trails, and managed operations.

## Open Source Core

The OSS core is the local spec-to-PR execution loop:

approved input -> validated flow -> local worktree -> local agent/command/gate
execution -> local logs/evidence -> draft PR or rework -> retry/resume/recovery.

These capabilities must remain open source:

- CLI/runtime.
- Flow specs, validation, and built-in bootstrap flows.
- Local-file input connector and transparent connector interfaces.
- Local worktree creation and execution backend.
- Agent runtime registry and local CLI dispatch.
- Context policy, source/input materialization, and redaction basics.
- Local logs, event store, artifact registry, evidence timeline, retry, resume,
  bounded recovery patch checkpoints, blockers, and reflection artifacts.
- Local evidence-retention policy inspection, metadata search, source-free
  checksummed export, and explicit dry-run/apply cleanup.
- Local Web Console basics for inspecting repositories, tasks, runs, providers,
  flows, work items, evidence, and context usage.
- Local stdio MCP and capability-scoped API tokens for driving the inspectable
  task, planning-approval, and run surface from external coding tools.
- GitHub draft PR publishing, same-repository PR branch updates, PR comment
  rework, and merge-based PR branch sync.
- Local repository registration and local multi-repo operation.
- Local provider credential discovery/status and secret-boundary visibility.
- The local named-permission evaluator and metadata-only security audit needed
  to inspect access decisions on one Nitely instance.
- User-defined flows, flow validation, and local high-risk gating.

The core does not need to be easy for a whole organization to operate, but it
must be possible for one engineer to inspect and run it without a hosted Nitely
service.

## Commercial And Team Layer

Paid products should improve team operation and reliability, not hide the core
execution model.

Good commercial boundaries include:

- team task queues and assignment workflows;
- multi-repo/team dashboards and cost attribution;
- GitHub App installation management and org-level repository onboarding;
- organization-approved flow templates and rollout policy;
- policy and approval controls across teams;
- centralized multi-repo retention policy, shared search, long-term evidence
  storage, governed/compliance exports, and durable audit pipelines;
- SSO, SCIM, federated identity, centralized policy/RBAC, and organization
  administration;
- managed coordination for customer-hosted runners;
- cloud-visible runner health, scheduling, retries, and fleet operations;
- high-touch paid pilot and flow implementation services.

These features can be commercial because they coordinate people, repositories,
retention, policy, or hosted operations. They should not require customers to
upload source code, secrets, raw worktrees, or full agent context unless
explicitly configured.

## Public Trust Artifacts

The following trust artifacts must stay public and engineer-reviewable:

- **Execution model**: flow schema, stage semantics, worktree lifecycle, agent
  runtime invocation, command/gate execution, retry/rework/resume behavior, and
  PR publishing semantics.
- **Secret boundaries**: where agent credentials, GitHub tokens, provider
  credentials, local inputs, source snapshots, and generated artifacts live.
- **Logging model**: what events, command logs, agent outputs, evidence,
  artifacts, blocker states, and reflection outputs are persisted locally.
- **Data retention defaults**: local `.nitely` storage defaults, evidence paths,
  event database behavior, provider store behavior, and future control-plane
  upload boundaries.
- **Redaction model**: default redaction, context policy, omitted inputs,
  prompt/log redaction, and browser-safe API exposure.

See [security-and-trust.md](security-and-trust.md) for the detailed security and
data-boundary model.

## Paywall Guardrails

Do not paywall capabilities required to trust local execution:

- flow specifications and validation;
- local worktree execution;
- local agent runtime dispatch;
- source/input context policy and redaction basics;
- local run logs, events, evidence, retry, resume, and blocker state;
- local retention-policy inspection, metadata search, source-free export, and
  explicit dry-run/apply evidence cleanup;
- local Web Console basics for inspecting tasks, runs, repositories, providers,
  and evidence;
- local MCP/API-token access to the same inspectable task and run basics;
- GitHub draft PR publishing and PR rework basics.

Commercial versions may add hosted/team-scale centralized retention policy,
shared multi-repo search, governed/compliance exports, analytics, SSO,
organization administration, and managed coordination, but the local
transparent version must remain inspectable.

## Boundary Decisions

Some current local/basic features have future commercial equivalents. The rule
is to keep the local inspectable version in OSS and commercialize the team-scale
version:

- repository management: local repo registry remains OSS; org repo catalogs and
  GitHub App onboarding can be commercial;
- dashboards: local run/task visibility remains OSS; cross-team dashboards,
  cost centers, and exports can be commercial;
- users/orgs: local user/session support, the local named-permission evaluator,
  and a metadata-only local audit remain OSS; SSO/SCIM, centralized policy,
  hosted organization administration, compliance retention/export, and
  cross-instance audit are commercial;
- provider credentials: local env/file status and secret-boundary transparency
  remain OSS; vault integrations and org credential policy can be commercial;
- SCM integrations: same-repo draft PR publishing and rework remain OSS;
  org-level GitHub App management and multi-repo PR queues can be commercial.

## Feature Audit

The current feature inventory and paywall-risk review lives in
[open-core-feature-audit.md](open-core-feature-audit.md).

That audit is the source of truth for which implemented features are:

- OSS core;
- commercial/team layer;
- boundary decisions that need careful handling before SaaS work.

## Related Issues

Future commercial, SaaS, and control-plane work should reference this boundary.
Current related issues include:

- #95 Package the first paid pilot offering.
- #97 Design customer-hosted runners with a cloud coordination boundary.
- #98 Write the security and trust model for code, secrets, logs, and evidence.
- #99 Extract SaaS control-plane requirements from paid pilots.
- #177 Link SaaS and commercial backlog items to the open-core boundary.

The customer-hosted runner boundary is described in
[customer-hosted-runner-boundary.md](customer-hosted-runner-boundary.md).
