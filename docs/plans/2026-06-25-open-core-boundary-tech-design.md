# Tech Design: Open-Core Boundary

## Context

#176 added the feature audit and a draft boundary entrypoint. #94 should turn
that draft into a usable boundary document that future SaaS/control-plane work
can reference.

## Changes

- Expand `docs/open-core-boundary.md` with:
  - OSS core definition;
  - commercial/team layer definition;
  - public trust artifacts;
  - paywall guardrails;
  - links to related SaaS/control-plane issues;
  - relationship to the #176 feature audit.

## Validation

- `git diff --check`
- Manual review that #94 acceptance criteria are represented.
- Manual review that the doc does not promise unavailable SaaS behavior.
