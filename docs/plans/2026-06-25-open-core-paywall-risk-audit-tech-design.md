# Tech Design: Open-Core Paywall Risk Audit

## Context

Issue #176 is a documentation/audit task split from #94. The implementation
should not change product behavior. It should make the current feature boundary
explicit enough to guide future SaaS/control-plane work.

## Approach

Add two docs:

- `docs/open-core-feature-audit.md`: detailed inventory and paywall-risk audit.
- `docs/open-core-boundary.md`: draft #94 boundary entrypoint that links to the
  audit. This does not close #94; it gives the audit a stable home and a place
  for later boundary docs to reference.

Add a spec file for traceability:

- `specs/issues/176-open-core-paywall-risk-audit-spec.md`

## Classification Model

Use three classes:

- **OSS core**: required for one engineer to inspect, run, verify, recover, and
  trust Nitely locally.
- **Commercial/team layer**: multi-user, multi-repo, hosted, policy, retention,
  SSO, audit, and operational coordination features.
- **Boundary decision**: current local/basic capabilities that may have future
  commercial hosted/team equivalents, but whose local transparency must not be
  removed from the OSS core.

## Validation

- `git diff --check`
- Manual review that issue #176 acceptance categories are present.
- Manual review that #94 boundary doc links to the audit.
