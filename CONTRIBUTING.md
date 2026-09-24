# Contributing

Nitely is in bootstrap. The first public contribution path should stay narrow:
small fixes, documentation improvements, tests, flow examples, and issues that
clarify the local-first runtime boundary.

## Local Setup

Requirements:

- Node.js 24 or newer.
- pnpm 11.
- Git.

Install and verify:

```bash
pnpm install
pnpm run check
pnpm run build
pnpm test -- --run
```

If `pnpm` is unavailable in a local environment, `npm install --package-lock=false`
can be used for temporary validation, but package lock changes should not be
committed unless the project intentionally switches package managers.

## Pull Requests

- Keep changes focused and explain the runtime, evidence, provider, or UI
  behavior being changed.
- Add or update tests for behavior changes.
- Do not include local credentials, provider tokens, customer data, generated
  worktrees, `.nitely/runs`, `.nitely/providers`, or private deployment paths.
- Preserve the open-core boundary: local execution semantics belong here;
  team coordination, hosted operations, billing, SSO, and fleet management
  belong outside this repository.

## Security-Sensitive Changes

Changes touching execution, prompt construction, context policy, redaction,
provider credentials, artifacts, evidence, or runner/control-plane protocol
must describe the security boundary being preserved. Follow
[SECURITY.md](SECURITY.md) for vulnerability reporting.
