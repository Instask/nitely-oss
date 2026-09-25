# Nitely

[中文](./README.zh-CN.md)

- **Intent is explicit.**
- **Execution is constrained.**
- **Results require evidence.**
- **Humans retain authority.**

These four lines are the product. [docs/product.md](docs/product.md) says what
each one requires. Nitely is an open, local-first governed spec-to-PR execution
system. It turns approved engineering intent into evidence-backed, reviewable
draft pull requests.

Codex, Claude, GLM, Grok Build, Pi, and future coding agents are
interchangeable runtimes for Nitely Flows. Nitely is not an Agent workforce,
chat/inbox, or project-management suite; it is the governed delivery and
evidence layer between approved work and a PR.

The operating rhythm is: plan by day, execute by night, review by morning. See
[docs/usage-scenarios-and-efficiency-thesis.md](docs/usage-scenarios-and-efficiency-thesis.md).

`Nitely` is a temporary internal codename. The public brand must be renamed and
professionally cleared before any public landing page, SaaS control plane, paid
offer, or package launch.

The project is in bootstrap. Implemented behavior on `main` is listed in
[docs/status.md](docs/status.md). The shipped lifecycle is the
[approval-first ticket-to-PR contract](docs/approval-first-ticket-to-pr.md).

## Open-Core Boundary

Nitely's open-source core is the inspectable local spec-to-PR execution system:
flow validation, local worktrees, local agent runtime dispatch, context/redaction
policy, logs, evidence, retry/resume, and draft PR publishing stay visible and
runnable without a hosted Nitely service.

Commercial and team products should help organizations operate that core
reliably across repositories, people, policies, retention, SSO, audit trails, and
customer-hosted runners. They should not make core reliability, evidence, local
execution, or secret-boundary transparency commercial-only.

See [docs/open-core-boundary.md](docs/open-core-boundary.md) for the boundary
and [docs/open-core-feature-audit.md](docs/open-core-feature-audit.md) for the
current feature inventory. See [docs/security-and-trust.md](docs/security-and-trust.md)
for code, secret, log, evidence, retention, and future control-plane data
boundaries. See [docs/trust-and-verification-model.md](docs/trust-and-verification-model.md)
for how a change earns trust under the product definition. See
[docs/mobile-support-boundary.md](docs/mobile-support-boundary.md) for the iOS
and Android support boundary.

## Requirements

- Node.js 24 or newer.
- pnpm 11.
- Git.
- `NITELY_GITHUB_TOKEN` or `GITHUB_TOKEN` for GitHub draft PR publishing and
  PR comment operations.
- Optional: GitHub CLI (`gh`) authenticated only when using the explicit
  `provider: "github-cli"` legacy fallback.
- Local agent CLI and credentials for each `agent` stage runtime you use. Codex
  uses the local `codex` CLI authentication, Claude requires
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, GLM requires one of `NITELY_GLM_API_KEY`, `GLM_API_KEY`,
  or `ZHIPUAI_API_KEY`, Grok Build uses local `grok login` or `XAI_API_KEY`,
  and Pi uses the local Pi CLI/model configuration.

## Install

Nitely is not published to a package registry yet; install it from source and
link the `nitely` command:

```bash
git clone https://github.com/Instask/nitely-oss.git nitely
cd nitely
pnpm install
pnpm run build
npm link
nitely --help
```

`nitely` then works from any directory. Built-in flows such as
`flows/implement-small.json` resolve from this checkout unless the repository
you run in has its own copy. After pulling updates, run `pnpm run build` again.

**New here? Start with the [Quickstart](docs/quickstart.md)**: an offline demo of
the whole loop, then a first real run on your own repository.

## Install The Nitely Agent Skill

`skills/nitely/` is an agent skill that teaches a coding agent how to install,
configure, and operate Nitely, so a new user can ask their agent to set it up
instead of reading this whole README first.

```bash
scripts/install-nitely-skill
```

Without a checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/Instask/nitely-oss/main/scripts/install-nitely-skill | bash
```

Both install the personal Claude Code skill at
`${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nitely`. Use `--project [PATH]` for a
single repository, `--nitely-repo PATH` to install it as a Nitely run skill at
`PATH/.nitely/skills/nitely`, `--dest PATH` for any other agent, and `--force`
to replace an existing install. See [docs/nitely-skill.md](docs/nitely-skill.md).

## Documentation

This file is the front door. The operator manual is split by job:

- [Quickstart](docs/quickstart.md) — offline demo, then a first real run.
- [Product definition](docs/product.md) — the four constraints and the decision test.
- [Current status](docs/status.md) — what is implemented on `main`.
- [Running flows](docs/running-flows.md) — validate, run, inputs, evidence, agent runtimes.
- [Execution backends](docs/execution-backends.md) — local, mise, and OCI.
- [Rework and recovery](docs/rework-and-recovery.md) — rework, resume, and retry.
- [Web Console](docs/web-console.md).
- [Remote operations](docs/remote-operations.md) — CLI against a running server.
- [Local MCP server](docs/local-mcp.md).
- [Flow format](docs/flow-format.md) and the [flow authoring guide](docs/flow-authoring-guide.md).
- [Deployment](docs/deployment.md).

## Development

Run the CLI from source without building:

```bash
pnpm dev -- --help
```

CI runs these on Linux for every pull request; see [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md):

```bash
pnpm run check
pnpm run test:run
pnpm run build
```

## License

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
