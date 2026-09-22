# Current Status

Implemented behavior on `master`. The product definition is [product.md](product.md). Installation and the documentation map are in the [README](../README.md).

Implemented on `master`:

- JSON flow loading and validation.
- Local-file and Google Drive input connectors.
- Isolated Git worktrees per run.
- Agent, command, gate, approval, sync-change, publish-change, and update-change stage types.
- Built-in issue execution flows finish with a reflection artifact that records
  follow-up issues, duplicates, non-actions, or a clean result.
- Agent runtime dispatch for Codex, Claude, GLM, Grok Build, and Pi through local CLIs.
- Bounded retries for failed agent, command, and gate stages.
- GitHub draft pull request publishing, same-repository PR branch updates,
  operator-driven PR comment rework, and merge-based PR branch sync.
- Local Web Console backed by `.nitely/tasks` and `.nitely/runs`.
- Local stdio MCP server for external AI coding tools, backed by scoped,
  default-deny API tokens and metadata-only action audit. See
  [docs/local-mcp.md](local-mcp.md).
- Planner Agent MVP in the Web Console: draft a spec from a GitHub issue, Jira
  ticket, or prompt, approve the spec, draft and approve a technical design,
  then start the implementation run. Jira intake preserves normalized source
  snapshots, duplicate prevention, drift detection, and optional status sync.
- The canonical approval-first ticket-to-PR product contract maps ticket
  intake, planning approval, governed execution, PR review/rework, evidence,
  metrics, and trust boundaries to shipped surfaces and repeatable proof. See
  [docs/approval-first-ticket-to-pr.md](approval-first-ticket-to-pr.md).
- Persistent event-backed run status, logs, and resume.
- Bootstrap flows for letting Nitely implement Nitely issues.
- Pilot-ready production flow templates for approved specs, bug tickets, and
  PR review rework, plus a bounded security-fix flow for supported vulnerability
  classes. See [docs/pilot-flow-templates.md](pilot-flow-templates.md) and
  [docs/security-fix-flow.md](security-fix-flow.md).
- The primary deterministic golden-path demo for approved task implementation,
  verification, evidence-backed draft PR publication, reviewer feedback, and
  controlled same-PR rework. See
  [docs/golden-path-demo.md](golden-path-demo.md).
- First paid pilot package for high-touch customer pilots. See
  [docs/paid-pilot-offering.md](paid-pilot-offering.md).
- Customer validation workflow for interviewing teams already using AI coding
  tools. See [docs/customer-validation.md](customer-validation.md).
- Buyer-facing positioning package for explaining Nitely as a governed
  spec-to-PR execution system rather than an Agent-workforce platform, plus a
  GitHub-first upstream intake/result contract. See
  [docs/positioning.md](positioning.md) and
  [docs/upstream-integration-contract.md](upstream-integration-contract.md).
- Canonical trust-and-verification model: evidence-backed software changes,
  independent verification, risk-based human attention, and bounded recovery.
  See [docs/trust-and-verification-model.md](trust-and-verification-model.md).
- Flow-defined work items with typed artifacts: dev tasks are the built-in
  `dev.pr` work item type, non-dev flows declare their own `workItemType`, and
  high-risk or protected custom types are governed by repo policy. See
  [docs/work-item-model.md](work-item-model.md).
- Risk-based review policy driven by the actual diff: an effective risk class is
  computed from the declared work-item baseline plus deterministic diff signals
  (protected paths, migrations, dependency manifests, deletions, size,
  CODEOWNERS), recorded as run evidence with the exact signals that raised it,
  recomputed after rework, and mapped by repo policy to the required human
  review. See
  [docs/risk-based-review-policy.md](risk-based-review-policy.md).
- Static multi-perspective review: two or three fixed review gates (correctness,
  security, spec conformance) run independently and a `review-aggregate` gate
  merges their findings into one fail-closed decision before publish. See
  [docs/multi-perspective-review.md](multi-perspective-review.md).
- User-defined flows in the Web Console: list built-in and custom flows, create
  from a template, edit JSON with live schema-aware validation, and run a work
  item from a flow. Custom flows are stored in a local database and run without a
  flow file. See [docs/user-defined-flows.md](user-defined-flows.md).
- Enforced flow harness and audit evidence: artifact integrity/provenance
  (`sha256`, provenance), command/approval evidence, required-output and JSON
  schema validation, stage-level high-risk gating, and a run evidence timeline.
  See [docs/harness-and-audit.md](harness-and-audit.md).
- Context delivery optimized for large inputs: small textual artifacts are
  inlined, large textual artifacts are previewed with a mandatory read path, and
  binary artifacts are referenced by metadata/path. Agent and review-gate
  attempts record `stage.context.usage`, and the Web Console shows per-stage and
  run-total context usage. See
  [docs/context-delivery-and-usage.md](context-delivery-and-usage.md).
- Resumable agent usage-limit blockers: provider quota and rate-limit failures
  are projected as `agent_usage_limit` blockers instead of normal attempt
  failures, and active blocker banners clear after resumed terminal runs.
- Structured operator-question blockers: agent stages can pause with a validated
  `question.json`, operators can answer from the CLI or Web Console, and resume
  injects the auditable decision into the next attempt.
- Advanced Approval Inbox actions and optional notification delivery: sources
  declare supported actions and mandatory reasons, human decisions are copied
  to task/run evidence, and durable source-key receipts deduplicate GitHub,
  Jira, Slack, HTTPS email-relay, and signed customer-webhook mirrors. See
  [docs/notification-actions-and-delivery.md](notification-actions-and-delivery.md).

In progress / planned:

- Provider connection setup beyond local environment and CLI checks where it
  supports governed execution; provider count is not a roadmap goal.
