# Public Release Roadmap

This repository is the candidate public open source core for Nitely. It should
be made public only after the trust-bearing runtime is easy to inspect and the
commercial boundary is explicit.

## Release Goal

Publish a local-first spec-to-PR runtime that a single engineer can install,
run, and audit locally.

The first public release should demonstrate:

- A validated Flow document.
- Input snapshotting and context policy enforcement.
- Isolated worktree execution.
- Agent, command, gate, approval, retry, resume, blocker, and publish stages.
- Local evidence, logs, artifacts, and redaction.
- A local Web Console for task/run inspection.

## Release Gates

### Repository Hygiene

- Confirm all source files are intended for public distribution.
- Remove private customer names, unpublished strategy, credentials, local
  deployment paths, and internal-only planning artifacts.
- Keep `LICENSE`, `NOTICE`, `README.md`, and `README.zh-CN.md` current.
- Add `SECURITY.md`, `CONTRIBUTING.md`, and a minimal Code of Conduct if public
  contribution is desired at launch.

### Build And Test

- `pnpm install`
- `pnpm run check`
- `pnpm run build`
- Targeted runtime and Web Console tests that pass on macOS and Linux.
- Document any Linux-only descriptor-relative filesystem tests separately so the
  first public CI matrix is honest.

### Trust Documentation

- Document prompt construction and context delivery.
- Document where secrets are excluded, redacted, persisted, or never persisted.
- Document event, evidence, artifact, and log semantics.
- Document known local execution risks: agent CLIs run with user authority,
  generated code is untrusted until reviewed, and provider CLIs may have their
  own credential stores.

### Product Boundary

- Link `docs/open-core-boundary.md` from the README.
- Keep the open source repository runnable without `nitely-control-plane` or
  `nitely-cloud`.
- Explain that hosted/team coordination is a scale and operations layer, not a
  replacement for local inspectability.

## First Public Milestones

### M0: Private Release Candidate

- Keep repository private.
- Finish docs, CI, and security scrub.
- Produce a sample end-to-end run with evidence.

### M1: Public Read-Only Launch

- Make repository public.
- Accept issues and discussions.
- Avoid promising external contribution throughput until maintainership is
  staffed.

### M2: Contribution-Ready OSS

- Add a labeled issue backlog.
- Add contribution tests and local setup docs.
- Publish a minimal release artifact or npm package if installation from source
  becomes friction.

## Non-Goals For First Release

- Hosted multi-tenant control plane.
- Billing, SSO, enterprise policy management.
- Remote runner fleet management.
- Cloud deployment automation.
- Marketplace/plugin ecosystem.

Those belong in `nitely-control-plane`, `nitely-runner`, or `nitely-cloud` after
the local trust model is stable.
