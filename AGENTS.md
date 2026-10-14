# Nitely Development Boundary

This repository is the source of truth for Nitely's code. Every change to the
runtime, CLI, Web Console, flows, skills, and docs lands here through a PR
against the default branch, and deployments build from this repository.

- Deployment-specific values (hosts, paths, Node locations, credentials) never
  belong here. Scripts such as `scripts/nitely-prod-web-deploy` take them as
  arguments; keep them in the deployment's own runbook.
- Some work is tracked in a private issue tracker. Reference it by full
  `owner/repo#number` so closing keywords and links still resolve; do not copy
  private issue text into this repository. Per-issue specs, technical designs,
  and agent working plans for that tracker stay with it; do not commit them
  under `specs/`, `docs/plans/`, or `docs/superpowers/` here.
- Domain language lives in [CONTEXT.md](CONTEXT.md). Contribution rules live in
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Verification Boundary

`.github/workflows/ci.yml` runs three Linux jobs for every PR and every push
to the default branch. All three are the merge gate.

- `Typecheck and tests` runs `pnpm run check` and `pnpm run test:run`.
- `Built package smoke` runs `pnpm run build`, packs the tarball users
  install, and runs `pnpm run package:smoke` against that install. The smoke
  covers the CLI, the public API and runner-control-plane exports, the static
  Web assets, and `nitely smoke golden-path` with mocked providers. A broken
  `bin` or `exports` path fails this job. On failure it uploads command logs
  and golden-path proof flags, not the fixture repository or run evidence.
- `Rootless OCI integration` starts a real rootless dockerd on a GitHub-hosted
  x86_64 VM, builds the runner image, and runs the OCI tests that need a real
  daemon: bind mounts, the egress boundary, command mediation for Claude and
  Pi workflows, supervisor-crash cleanup, and fail-closed admission. The job
  fails if any of those tests is skipped rather than passed.

- **Never describe a failure as a pre-existing baseline and merge past it.** If
  `pnpm run check` is red, either the fix belongs in your PR or your PR waits.
  A type error recorded as "baseline noise" across many PRs has previously hidden
  a live bug in review verdict routing.
- **A failure you did not cause is still a finding.** Say what it is, who owns
  it, and open an issue. Restating it in a Verification section is not a
  handoff.
- **Verify on Linux before merging.** A large part of the suite asserts Linux
  descriptor-relative path anchoring and cannot pass on macOS. A macOS run that
  stops at those failures has not verified the change.
- **Do not close an issue with a seam.** A module that no production code path
  imports does not satisfy an acceptance criterion written in terms of observed
  behavior. Land the seam, say it is a seam, and leave the issue open.
