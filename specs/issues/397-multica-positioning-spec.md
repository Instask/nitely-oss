# Issue 397 Spec: Governed Spec-to-PR Positioning

## Problem

Nitely and agent-workforce products can both be summarized as issue-to-PR
automation. If buyer-facing copy leads with agents, orchestration, or a generic
workflow layer, Nitely can reasonably be read as a smaller collaboration and
agent-management platform.

The product needs to lead with its actual abstraction: approved intent enters a
declared execution contract and leaves as an evidence-backed, reviewable pull
request with controlled recovery and rework.

## Goals

- Make governed spec-to-PR execution and evidence-backed PRs the primary
  category and outcome in buyer-facing copy.
- Explain the abstraction-level difference from Multica and platform-native AI
  suites without claiming feature breadth Nitely does not have.
- Turn agent-workforce and project-management features into explicit product
  non-goals.
- Make the deterministic golden-path demo prove the primary product claim in a
  machine-readable result.
- Define a minimal GitHub-first upstream intake and result-callback contract
  without claiming that a hosted webhook endpoint already exists.
- Preserve customer-validation evidence as a prerequisite for final positioning
  closure.

## User Stories

- **US-001:** As a buyer, I can understand in the first screen that Nitely
  governs approved engineering work into evidence-backed PRs.
- **US-002:** As a product planner, I can reject roadmap work that turns Nitely
  into a generic AI workforce or project-management product.
- **US-003:** As a technical evaluator, I can run one deterministic demo and see
  explicit proof of approval, verification, draft publication, evidence, and
  same-PR rework.
- **US-004:** As an integration author, I can map a GitHub issue into a minimal
  Nitely intake envelope and map terminal or blocked results back upstream.

## Functional Requirements

- **FR-001:** English and Chinese README introductions lead with governed
  spec-to-PR execution and evidence-backed, reviewable draft PRs.
- **FR-002:** Buyer-facing copy explicitly says Nitely is not an agent workforce,
  project-management suite, chat/inbox product, or platform-native AI suite.
- **FR-003:** The positioning source of truth compares Nitely with Multica at
  the abstraction level: workspaces/agents/squads/issues versus flows/artifacts/
  gates/evidence.
- **FR-004:** The positioning source of truth preserves honest Multica
  advantages and avoids unverified superiority claims.
- **FR-005:** Product guardrails cover agent profiles, squads, chat/inbox,
  board/Gantt depth, native desktop/mobile clients, and provider-count
  competition.
- **FR-006:** The golden-path result and generated report expose named proof
  signals for approved planning, verification, draft PR publication, evidence,
  and controlled same-PR rework.
- **FR-007:** The integration contract defines versioning, idempotency,
  repository/source identity, flow selection, typed input references, callback
  authentication, terminal/blocked status, change-request metadata, blocker
  metadata, and evidence references.
- **FR-008:** The integration contract distinguishes the documented adapter
  contract from currently shipped network endpoints.
- **FR-009:** Customer-validation guidance adds Multica-positioning questions and
  requires at least three real failed AI-coding attempts before #397 is closed.

## Non-Goals

- Implementing a hosted webhook or callback server.
- Adding Linear, Jira, or Multica adapters in this slice.
- Building chat, inbox, agent profiles, squads, or project-management views.
- Claiming completion of customer interviews or inventing validation evidence.
- Reproducing competitor source or making claims beyond the pinned comparison
  recorded in #397.

## Success Criteria

- README copy cannot reasonably be summarized as a smaller agent-workforce
  platform.
- The golden-path smoke fails closed unless all five product proof signals are
  true.
- Documentation tests lock the category, competitive distinction, guardrails,
  integration boundary, and external validation dependency.
- The implementation can be merged and deployed independently while #397 stays
  open only for the explicitly documented customer-evidence gate.
