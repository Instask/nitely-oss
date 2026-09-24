# Spec-To-PR Positioning Tech Design

Issue: #93

## Context

Nitely already has customer-validation, paid-pilot, open-core, security, and
pilot-flow documents. #93 needs a concise positioning source of truth that those
documents can reuse.

## Design

1. Add `docs/positioning.md` as the buyer-facing positioning package.
2. Keep the framing anchored on "spec-to-PR execution system" and "reviewable
   draft PRs."
3. Include:
   - category;
   - target customer;
   - buyer pain;
   - alternatives replaced;
   - what Nitely is not;
   - differentiators;
   - one-liners;
   - proof points;
   - validation dependency on #92.
4. Update the README opening to avoid leading with "workflow runtime."
5. Link the positioning doc from README alongside customer validation and paid
   pilot material.

## Validation Boundary

This change prepares the positioning package. It does not close the discovery
requirement in #93 because #92 has not yet produced 3 failed-attempt examples
from customer interviews. The issue should remain open until the positioning is
checked against that evidence.

## Tests

No runtime behavior changes. Verification is documentation-focused:

- run markdown/docs-related tests;
- run typecheck/build to ensure repo health is unchanged.
