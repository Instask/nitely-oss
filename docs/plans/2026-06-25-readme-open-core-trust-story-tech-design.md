# Tech Design: README Open-Core Trust Story

## Context

#175 is the README-facing part of #94. The README should keep its current
implementation-focused structure, but add a short section near the top so
readers understand the open-core boundary before reading feature status.

## Changes

- Add a README section named `Open-Core Boundary`.
- Link to `docs/open-core-boundary.md`.
- State that local execution, evidence, recovery, and secret-boundary
  transparency are OSS core capabilities.
- State that future commercial products focus on team operation and reliability.

## Validation

- `git diff --check`
- Manual review that #175 acceptance criteria are represented.
- Manual review that the README does not describe planned SaaS features as
  implemented.
