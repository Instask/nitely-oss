# Issue 94 Spec: Open-Core Boundary

## Problem

Nitely's commercialization depends on trust. If users cannot inspect local
execution, secret handling, logs, retries, worktrees, and PR evidence, then the
open-source core does not create enough confidence for teams to adopt the
commercial layer.

The boundary between OSS core and paid/team capabilities must be explicit before
more SaaS/control-plane work starts.

## Goals

- Define what remains open source.
- Define what belongs in paid/team products.
- Explain why the boundary supports customer trust.
- Identify trust artifacts that must stay public.
- Link current and future SaaS/control-plane work back to the boundary.

## Non-Goals

- Implement SaaS/control-plane functionality.
- Define final pricing.
- Move code between repositories.
- Close every follow-up boundary decision from the feature audit.

## Acceptance Criteria

- `docs/open-core-boundary.md` explains the OSS core, commercial/team layer,
  trust artifacts, and paywall guardrails.
- The README links to the boundary and frames Nitely as inspectable local
  spec-to-PR execution.
- Follow-up SaaS/control-plane issues can reference the boundary as their source
  of truth.
