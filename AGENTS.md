# Nitely Development Boundary

This repository is the source of truth for Nitely's code. Every change to the
runtime, CLI, Web Console, flows, skills, and docs lands here through a PR
against the default branch, and deployments build from this repository.

- Deployment-specific values (hosts, paths, Node locations, credentials) never
  belong here. Scripts such as `scripts/nitely-prod-web-deploy` take them as
  arguments; keep them in the deployment's own runbook.
- Some work is tracked in a private issue tracker. Reference it by full
  `owner/repo#number` so closing keywords and links still resolve; do not copy
  private issue text into this repository.
- Domain language lives in [CONTEXT.md](CONTEXT.md). Contribution rules live in
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Verification Boundary

`.github/workflows/ci.yml` runs `pnpm run check` and `pnpm run test:run` on
Linux for every PR and every push to the default branch. It is the merge gate.

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
