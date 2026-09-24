# Issue 93: Spec-To-PR Positioning

## Problem

Nitely should not lead with buyer-facing language like "agent runtime" or
"workflow runtime." Those terms invite comparison with wrappers, CI systems,
cloud IDEs, PR bots, and generic automation infrastructure.

The stronger commercial position is that Nitely turns approved engineering work
into reviewable draft PRs while preserving traceability, recovery, local
execution, and human review.

## Goals

- Define the buyer-facing category as a spec-to-PR execution system.
- Define the target customer, primary pain, alternatives, differentiators, and
  disqualifiers.
- Provide landing-page one-liners and proof points that can be reused without
  inventing new messaging.
- Update README lead copy so the first impression matches the positioning.
- Explicitly mark the customer-validation dependency from #92.

## Non-Goals

- Claiming customer validation that has not happened yet.
- Rewriting every technical reference to runtime/backend internals.
- Creating a marketing landing page or pricing page.

## Acceptance Criteria

- `docs/positioning.md` exists with category, target customer, alternatives,
  differentiators, disqualifiers, one-liners, and proof points.
- README lead copy uses the spec-to-PR framing instead of leading with
  "workflow runtime."
- The positioning doc identifies #92 as the validation dependency before #93 can
  be closed.
