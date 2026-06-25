# Nitely Open-Core Boundary

Nitely uses open source to make agentic software delivery inspectable. The
commercial layer should make team operation easier; it should not hide the
local execution model that users need to trust.

## Principle

One engineer should be able to inspect and run the core locally. A team pays to
operate that core reliably together.

This means the open source project should preserve the primitives that let a
developer answer:

- What inputs did the agent receive?
- What commands ran?
- What changed in the repository?
- What evidence, logs, and artifacts explain the result?
- Where are secrets excluded or redacted?
- How can a failed run be retried, resumed, reviewed, or repaired?

The commercial layer can coordinate these primitives across teams,
repositories, policies, hosted services, and retention requirements.

## Open Source Core

The core should remain available in the public Nitely open source repository:

- CLI/runtime for running flows locally.
- Flow specification, schema, validation, and built-in bootstrap flows.
- Local input connectors and context materialization.
- Local worktree execution and stage orchestration.
- Agent runtime registry and local runtime dispatch.
- Command, gate, approval, sync, publish, update, retry, resume, blocker, and
  reflection primitives.
- Local logs, run events, evidence, context manifests, artifact registry, and
  redaction behavior.
- GitHub draft PR publishing and same-repository PR branch updates for local
  runs.
- Local Web Console basics for tasks, runs, providers, flows, repositories,
  run details, usage, and evidence.
- Documentation for secret boundaries, execution behavior, and evidence
  semantics.

These are trust-bearing capabilities. If they become unavailable or opaque, the
system stops being locally inspectable.

## Paid And Team Layer

The commercial layer should focus on operating Nitely across a team:

- Team task queues and assignment workflows.
- Multi-repo/team dashboards and scope filters.
- GitHub App integration and organization-level repository onboarding.
- Organization-level flow template management.
- Policy, approval, and permission controls across users and repos.
- Evidence retention, search, export, and audit trails.
- SSO, enterprise identity, audit logs, and compliance controls.
- Managed coordination for customer-hosted runners.
- Hosted control plane for scheduling, notifications, run coordination, and
  cross-repo visibility.

These capabilities make Nitely easier to operate in an organization, but they
should build on the public execution model rather than replacing it with an
opaque hosted-only path.

## Services

Paid services can sit beside the product:

- Pilot implementation and onboarding.
- Flow design and migration.
- Repository-specific policy setup.
- Production readiness reviews.
- Team training and support.

Services may produce private customer artifacts, but reusable runtime behavior,
flow semantics, and trust-model documentation should feed back into the open
source core when they are generally applicable.

## Public Trust Artifacts

These artifacts should stay public and inspectable:

- Execution model and stage lifecycle.
- Flow schema and validation rules.
- Secret exclusion and redaction model.
- Input snapshot and context-delivery rules.
- Event, evidence, artifact, and log semantics.
- Retry, rework, resume, blocker, and escalation behavior.
- Data retention defaults for local runs.
- Security model for code, secrets, logs, and generated evidence.

Hosted products can add retention controls and compliance workflows, but the
default local behavior must remain documented.

## Boundary Rules

- Do not paywall local inspectability.
- Do not make the open source CLI depend on a hosted control plane for normal
  local execution.
- Do not hide secret handling, prompt construction, evidence, or artifact
  semantics behind a commercial boundary.
- Keep team coordination, organization policy, hosted retention, and enterprise
  identity in the commercial layer.
- When a paid feature has a local analogue, document the difference as scale
  and operation, not as basic trust versus no trust.
- New SaaS/control-plane issues should reference this boundary before
  implementation.

## Repository Shape

Recommended repository boundaries:

- `nitely`: private/internal product and planning repository.
- `nitely-oss`: public open source core.
- `nitely-control-plane`: commercial/team coordination layer.
- `nitely-cloud`: hosted deployment, infrastructure, and SaaS operations for
  the control plane.
- `nitely-runner`: optional future runner daemon if it needs an independent
  release lifecycle.

Avoid names like `nitely-os`, which can read as operating system, and avoid
using `nitely-ee` as the primary repo name too early. "Enterprise edition" is a
licensing or packaging concept; the product boundary is more accurately a
control plane. `nitely-cloud` should not become a second product surface unless
there is a clear operational reason to separate hosted infrastructure from the
control-plane application.

## Follow-Up Work

- Keep README and product messaging aligned with this boundary.
- Audit new features for paywall risk before moving them out of the open source
  core.
- Link SaaS and commercial backlog work back to this boundary.
- Maintain a public security and trust model for code, secrets, logs, and
  evidence.
- Keep customer-hosted runner design aligned with the public execution model.
