# Tech Design: Customer-Hosted Runner Boundary

## Context

#97 follows the open-core boundary from #94 and the security/trust model from
#98. This is documentation-only architecture work. It should clarify the future
runner/control-plane split without implying that the cloud product is already
implemented.

## Sources

- `docs/open-core-boundary.md`
- `docs/security-and-trust.md`
- `src/run/run-flow.ts`
- `src/run/project.ts`
- `src/run/execution/local.ts`
- `src/scm/github.ts`

## Changes

- Add `docs/customer-hosted-runner-boundary.md`.
- Link the runner boundary from `docs/security-and-trust.md`.
- Link the runner boundary from `docs/open-core-boundary.md`.

## Validation

- `git diff --check`
- Manual review that #97 acceptance criteria are covered.
- Manual review that the document separates current implementation from future
  runner/control-plane design.
