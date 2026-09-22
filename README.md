# Nitely

[中文](README.zh-CN.md)

Nitely is an open, local-first governed spec-to-PR execution system. It turns approved engineering intent into evidence-backed, reviewable draft pull requests. Codex, Claude, GLM, Grok Build, Pi, and future coding agents are interchangeable runtimes for Nitely Flows, not an Agent workforce, chat/inbox, or project-management suite.

The product thesis is: **plan by day, execute by night, review by morning**. Nitely is not an Agent workforce, chat/inbox, or project-management suite.

## Quick Start

Requires Node.js 24 and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev -- flow validate flows/implement-small.json
pnpm dev -- task plan --prompt "Add a health endpoint"
pnpm dev -- task draft-tech-design <task-id>
```

Planning can start from a prompt, a GitHub issue, Jira, or an external document:

```bash
pnpm dev -- task plan --issue owner/repo#123
pnpm dev -- task plan --jira ENG-123
pnpm dev -- task plan --document-url https://example.feishu.cn/docx/ABC123
```

The CLI writes runtime state under `.nitely/`; use the Web Console for reviewing tasks, approvals, runs, evidence, and recovery.

## What It Does

- Creates planning artifacts from declared intake, then requires approval before implementation.
- Runs versioned JSON Flows through a local coding-agent runtime and produces a draft PR with evidence.
- Keeps task artifacts, stage attempts, review feedback, operator decisions, and recovery history auditable.
- Supports controlled same-PR rework rather than silently rerunning unrelated work.

## Documentation

Start with the focused guide for the question at hand instead of a second copy in this README.

### Product and workflow

- [Positioning](docs/positioning.md) and [usage scenarios](docs/usage-scenarios-and-efficiency-thesis.md)
- [Approval-first ticket-to-PR contract](docs/approval-first-ticket-to-pr.md)
- [Planning intake](docs/planning-intake.md) and [canonical artifacts](docs/canonical-artifacts.md)
- [Golden-path demo](docs/golden-path-demo.md) and [pilot flow templates](docs/pilot-flow-templates.md)
- [Review gates and custom Flows](docs/user-defined-flows.md)

### Operating Nitely

- [Flow authoring](docs/flow-authoring-guide.md), [local MCP](docs/local-mcp.md), and [project instructions](docs/project-instructions.md)
- [Provider connections](docs/provider-connections.md), [schedules](docs/schedules.md), and [OCI lifecycle and recovery](docs/oci-lifecycle-recovery.md)
- [Security and trust](docs/security-and-trust.md), [evidence retention](docs/evidence-retention-search-export.md), and [context delivery](docs/context-delivery-and-usage.md)
- [Web preview runtime](docs/web-preview-runtime.md) and [mobile support boundary](docs/mobile-support-boundary.md)

### Boundaries and rollout

- [Open-core boundary](docs/open-core-boundary.md) and [customer-hosted runner onboarding](docs/customer-hosted-runner-onboarding.md)
- [Naming strategy](docs/naming-strategy.md) — Nitely is an internal codename; do not publicly launch it before the stated clearance gate is met.
- [Customer validation](docs/customer-validation.md) and [paid-pilot offering](docs/paid-pilot-offering.md)

## Repository Split

This repository is the open, local-first runtime. The adjacent repositories keep optional hosted responsibilities separate:

- `nitely-runner`: customer-hosted OCI runner image and control-plane protocol seam.
- `nitely-control-plane`: optional coordination and policy boundary.
- `nitely-cloud`: optional hosted operations boundary.

None of those repositories changes the local source-code, credential, or evidence custody model by default.

## Development

```bash
pnpm run check
pnpm run build
pnpm run test:run
```

The full test suite targets Linux because the owned-file guard relies on descriptor-relative path anchoring. Run the same checks in Linux CI when developing on macOS.

## License

Apache-2.0
