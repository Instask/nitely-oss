# Tech Design: Security and Trust Model

## Context

#98 is documentation-only. It should be grounded in the current codebase and in
the open-core boundary from #94/#176.

## Sources Reviewed

- `docs/open-core-boundary.md`
- `docs/context-delivery-and-usage.md`
- `docs/harness-and-audit.md`
- `src/context/policy.ts`
- `src/context/redaction.ts`
- `src/providers/env-store.ts`
- `src/providers/file-store.ts`
- `src/run/project.ts`
- `src/run/run-flow.ts`
- `src/run/execution/local.ts`
- `src/scm/github.ts`
- `src/web/runs.ts`
- `src/web/server.ts`

## Changes

- Add `docs/security-and-trust.md`.
- Link it from README.
- Link it from the public trust artifacts section of
  `docs/open-core-boundary.md`.

## Validation

- `git diff --check`
- Manual review that #98 requirements are covered.
- Manual review that the doc separates current behavior from intended future
  SaaS/control-plane behavior.
