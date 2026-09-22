# Issue 175 Spec: README Open-Core Trust Story

## Problem

The README currently describes Nitely as local-first, but it does not explicitly
explain the open-core principle: one engineer can inspect and run the core
locally; teams pay to operate it reliably together.

Potential users and pilot prospects need to understand that local execution,
evidence, recovery, and secret-boundary transparency are not commercial-only
promises.

## Goals

- Add a concise README section that explains the open-core trust story.
- Link the README to `docs/open-core-boundary.md`.
- Avoid presenting unavailable SaaS/control-plane features as implemented.
- Avoid implying that core reliability, evidence, local execution, or
  secret-boundary transparency will be paywalled.

## Non-Goals

- Rewrite the whole README.
- Add marketing copy for a SaaS product.
- Translate the README update into every language in this issue.

## Acceptance Criteria

- README explains the local-core/team-layer principle.
- README links to the open-core boundary doc.
- README language distinguishes current local capabilities from future
  commercial/team operation.
