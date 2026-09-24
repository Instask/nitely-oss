# Open-Core Feature Audit

Status: completed for #176.

This audit inventories the implemented Nitely feature surface and classifies
what should remain open-source core, what belongs in a commercial/team layer, and
what needs careful boundary handling.

## Classification

- **OSS core**: required for one engineer to inspect, run, recover, and trust
  local spec-to-PR execution.
- **Commercial/team layer**: useful for teams operating Nitely across people,
  repositories, policies, retention, and hosted or customer-hosted runners.
- **Boundary decision**: local/basic capability exists today and should stay
  inspectable, but a hosted/team equivalent may become commercial.

## Inventory

| Area | Current implementation | Boundary | Paywall risk | Future paid/team equivalent |
| --- | --- | --- | --- | --- |
| CLI/runtime | `src/cli.ts`, `src/index.ts`, `src/run/run-flow.ts` run flows from local inputs and repositories. | OSS core | High: paywalling the execution path would make the open source project non-functional. | Managed queues, hosted scheduling, fleet orchestration. |
| Flow spec and validation | `src/flow/*`, `flows/*.json`, `docs/user-defined-flows.md`, `src/flows/*`. | OSS core | High: users must inspect and validate what agents/commands/gates will run. | Organization-approved template catalogs and policy-managed rollout. |
| Local execution/worktrees | `src/run/run-flow.ts`, `src/run/execution/local.ts` create isolated worktrees and execute local agent/command/gate stages. | OSS core | High: local-first trust depends on visible worktree behavior. | Customer-hosted runner management, remote execution coordination, runner health. |
| Agent runtime registry | Local Codex, Claude, and GLM dispatch through local CLIs and local credentials. | OSS core | High: execution transparency and credential locality are core trust claims. | Central runtime policy, usage governance, allowed model catalogs. |
| Connectors | Local-file and Google Drive connectors via `src/connectors/*`. | OSS core for connector interface and local-file; boundary decision for cloud connectors. | Medium: input provenance must remain transparent, but commercial connectors may require hosted credentials. | Managed connector credentials, enterprise source integrations, org-level connector policy. |
| Context policy/redaction | `src/context/*` controls included files, redacts known secret forms, records context usage. | OSS core | High: source, prompt, and secret boundaries must stay inspectable. | Central policy distribution, compliance templates, org-wide redaction reporting. |
| Evidence/logging/audit basics | `src/events/*`, `src/artifacts/*`, and `src/evidence/*` record run events and artifacts, validate local retention, search local metadata, create no-source exports, and dry-run/apply local cleanup. | OSS core | High: moving basic evidence handling behind SaaS would undermine reviewability and safe local operation. | Centralized multi-repo retention policy, shared search, long-term storage, governed/compliance exports, durable audit trails. |
| Retry/rework/resume/blockers | Runtime retry policy, PR rework flows, usage-limit blockers, resume state. | OSS core | High: recovery is part of the local trust story and should not require SaaS. | Team-level blocked-run queues, SLA dashboards, guided escalation, cross-run analytics. |
| GitHub SCM integration | `src/scm/github.ts` publishes/updates draft PRs and handles same-repo PR rework/comment flows. | OSS core for same-repo draft PR publishing and update basics. | High: spec-to-PR output should work locally without commercial control plane. | GitHub App installation management, multi-repo permissions, org policy, hosted PR lifecycle dashboards. |
| Provider credentials/status | `src/providers/*`, `src/web/providers.ts` read env/file stores and expose local status hints. | OSS core for local credential discovery/status; boundary decision for managed credential UX. | High if local credential inspection or secret-boundary transparency is hidden. | Team credential inventory, rotation reminders, vault integrations, policy enforcement. |
| Web Console task/run basics | `src/web/tasks.ts`, `src/web/runs.ts`, `src/web/work-items.ts`, `src/web/ui.ts` operate local `.nitely/tasks` and `.nitely/runs`. | OSS core | Medium-high: local visibility into runs/tasks is needed to trust and debug execution. | Shared web app, collaboration, notifications, assignment workflows. |
| Local MCP/API-token integration | `src/mcp/*`, `src/web/api-tokens.ts`, and `docs/local-mcp.md` expose the local task/run API through stdio with capability-scoped machine tokens and metadata-only audit. | OSS core | High: external-tool integration must remain inspectable and usable without a hosted Nitely control plane. | Hosted MCP endpoints, OAuth/SSO, org identities, centrally managed grants, and cross-run compliance audit. |
| Planner/spec/design artifacts | `src/spec-artifacts/*`, `src/plan-artifacts/*`, planning approval states, templates. | OSS core | Medium: local planning artifacts are part of inspectable execution, but hosted collaboration may be paid. | Collaborative planning reviews, approvals, templates, and history across teams. |
| Repository management | `src/web/repositories.ts` stores local repository registry and can clone GitHub URLs into `.nitely/repositories`. | Boundary decision | Medium: users need local multi-repo operation, but hosted org-wide repo inventory is commercial. | Organization repo catalog, GitHub App repo discovery, permissions, fleet onboarding. |
| Team/manager dashboard | `src/web/dashboard.ts` summarizes local tasks, runs, cost, outcomes, blockers, and repo breakdowns. | Boundary decision | Medium: local visibility should remain, but cross-team dashboards are commercial. | Multi-user dashboards, portfolio metrics, cost attribution, executive/manager views. |
| Local auth/users/orgs | `src/web/users.ts`, `src/web/organizations.ts`, `src/web/access-control.ts`, and `src/web/security-audit.ts` implement repo-local users, hardened sessions, memberships, named permissions, and metadata-only access audit. | Boundary decision | Medium: local access decisions must remain inspectable, but federated identity and compliance operations belong commercial. | SSO, SCIM, centralized RBAC/policy, organization administration, durable cross-instance compliance audit. |
| Work item model/governance | `src/work-items/*`, `docs/work-item-model.md` define typed work items and high-risk allow-lists. | OSS core | Medium-high: local high-risk gating must remain inspectable. | Org policy, approval workflows, compliance packs, shared queues. |
| User-defined flows | Local flow creation/editing and schema-aware validation in Web Console. | OSS core for local/custom flows; boundary decision for shared template administration. | Medium: users need local custom flow control to trust automation. | Shared flow catalogs, org review/approval, template analytics. |
| Repository knowledge graph | `src/repo-index/index.ts` indexes repository knowledge for local context. | OSS core for local indexing. | Medium-high: context selection and index contents affect prompt trust. | Hosted index refresh coordination, multi-repo search, policy-aware retrieval. |
| Reflection/follow-up issue generation | Built-in issue execution flows generate reflection artifacts and follow-up issues. | OSS core for local reflection artifacts. | Medium: reflection improves local process learning; hosted triage may be commercial. | Cross-team reflection aggregation, duplicate detection across orgs, backlog routing. |

## Paywall-Risk Areas

These areas must remain locally inspectable even if paid hosted/team equivalents
are later built:

1. **Execution transparency**: flow validation, stage definitions, local
   worktrees, command/agent invocation, runtime fallback, retry, resume, and
   blockers.
2. **Data boundary transparency**: context policy, redaction basics, prompt/input
   delivery, source snapshots, credential locality, and provider status.
3. **Reviewability**: local logs, event history, artifact provenance, evidence
   timeline, gate output, and draft PR publishing.
4. **Local operability**: CLI/runtime and a local Web Console sufficient to run,
   inspect, recover, and understand a task without a hosted product.
5. **Policy basics**: local high-risk gating and user-defined flow validation.

If any of these become commercial-only, users cannot independently verify the
core spec-to-PR workflow.

## Boundary Decisions

### Repository Management

Keep local repository registration and GitHub URL cloning in OSS. A commercial
control plane can add organization repo catalogs, GitHub App installation
management, permission-aware discovery, onboarding workflows, and fleet status.

### Team Dashboard

Keep local run/task/repo visibility in OSS. A commercial layer can aggregate
across users, teams, repos, historical windows, cost centers, and managed
customer-hosted runners.

### Auth And Organizations

Keep the repo-local user/session/org model, named-permission evaluator, and
metadata-only local security audit needed by the local Web Console in OSS.
Commercial identity should focus on SSO, SCIM, centrally managed policy/RBAC,
organization administration, hosted access control, compliance retention and
export, and cross-instance audit aggregation.

### Provider Credentials

Keep local provider detection, file/env stores, and secret-boundary transparency
in OSS. Commercial capabilities can include vault integrations, org credential
policy, rotation reminders, and centralized status dashboards, but not secret
exfiltration by default.

### SCM Integrations

Keep same-repository GitHub draft PR publishing, updates, PR comment rework, and
merge-based sync in OSS. Commercial layers can add GitHub App installation
management, org permission policy, multi-repo PR queues, and hosted lifecycle
visibility.

## Current Local/Basic vs Future Paid Hosted/Team

| Capability | Current local/basic form | Paid hosted/team form |
| --- | --- | --- |
| Web Console | Local tasks, runs, providers, repos, flow editing, planning artifacts. | Shared approval/run/evidence console, action notifications, permissions; not general chat/inbox or project management. |
| Repository scope | Local registry and GitHub URL clone into `.nitely/repositories`. | Org repo catalog, GitHub App repo discovery, onboarding state. |
| Dashboard | Local manager dashboard over local tasks/runs/repos. | Cross-repo governed-delivery metrics, cost, evidence, blockers, recovery, history, and exports; not board/Gantt depth. |
| Users/orgs | Repo-local users, hardened sessions, organization roles, named permissions, and metadata-only local security audit. | SSO, SCIM, centrally managed policy/RBAC, organization administration, and durable cross-instance compliance audit. |
| Evidence | Local events/artifacts/timeline, retention inspection and cleanup, metadata search, no-source export, and PR evidence. | Centralized multi-repo policy/search, durable storage, governed sharing, and compliance packages. |
| Providers | Local env/file status and credentials. | Vault integrations, org policy, rotation, and centralized health where required by governed execution; provider count is not a product metric. |
| Flows/templates | Local built-in/custom flows and validation. | Organization-approved catalogs, policy rollout, analytics. |
| Runners | Local process and worktree execution. | Customer-hosted runner fleet management and cloud coordination. |

## Recommendation

Keep Nitely's local spec-to-PR execution loop fully OSS:

approved input -> validated flow -> local worktree -> local agent/command/gate
execution -> local evidence/logs -> draft PR/rework -> recovery/reflection.

Commercialization should start at team operation and reliability:

shared queues, customer-hosted runner coordination, permissions, SSO,
centralized multi-repo retention/search, governed compliance export, org-level
template governance, multi-repo dashboards, and high-touch pilot
implementation.
