# Nitely Trust and Verification Model

Status: canonical product and architecture doctrine for #588.

Nitely is a **trust and verification layer for AI-generated software changes**.
Its initial wedge is governed spec-to-PR execution: turning approved
engineering intent into a reviewable change with bounded execution,
independent checks, human decisions, and durable evidence.

## The Product Thesis

The durable problem is not whether an agent can produce a patch. Code
generation is becoming interchangeable across Codex, Claude Code, Copilot,
GLM, and future runtimes. The problem is whether a team can decide that a
software change has earned enough trust to move forward.

Nitely therefore has three layers:

```text
WHY       trust AI-generated software changes
WHAT      a trust and verification layer for software changes
WEDGE     governed spec/task-to-reviewable-PR execution
```

Agents and models are replaceable workers inside this system. The primary
product object is an **evidence-backed software change**, not an agent persona,
chat session, or self-reported completion message.

## How Trust Is Earned

Trust comes from independently checkable evidence, not model confidence. A
model saying "done", "safe", or "looks correct" is useful context but is not
verification by itself.

```text
approved intent
      ↓
bounded implementation
      ↓
deterministic verification
      ↓
independent semantic or adversarial review
      ↓
risk and policy evaluation
      ↓
human attention where required
      ↓
evidence-backed software change
```

The layers are complementary:

- deterministic commands, tests, schemas, and policy checks should run before
  semantic judgment where they can answer the question reliably;
- semantic reviewers and Judge stages should produce structured, auditable
  findings rather than opaque confidence scores;
- review should be meaningfully independent from implementation, without
  inheriting implementation-agent reasoning by default;
- high-risk or unresolved changes should escalate to an appropriate human;
- retries and rework must be bounded, recoverable, and visible.

## Dimensions of Trust

Trust is multidimensional; Nitely must not collapse it into one score.

| Dimension | Question |
| --- | --- |
| Intent conformance | Does the change implement the approved spec, design, and task scope? |
| Functional correctness | Do deterministic checks and relevant behavior support the claim? |
| Verification independence | Was the change checked without relying on the implementer's self-report? |
| Security and authorization | Did the change preserve required boundaries and permissions? |
| Scope control | Is unrelated change absent or explicitly justified? |
| Provenance | Can reviewers trace inputs, stages, artifacts, decisions, and external effects? |
| Reviewer effectiveness | Does the configured reviewer detect relevant defects without excessive false positives? |
| Reversibility | Can failure, rework, resume, or rollback happen safely? |
| Human decision need | Is remaining risk or uncertainty explicit enough to route attention? |

A change can be strong on one dimension and unresolved on another. The system
should expose those gaps instead of manufacturing a reassuring aggregate.

## Evidence-Backed Change Contract

An evidence-backed change should let a reviewer answer:

1. What intent was approved, and what source or revision did it come from?
2. What authority did execution have, and what boundaries were enforced?
3. Which stages, commands, artifacts, and checks ran?
4. Which findings, blockers, approvals, and rework decisions occurred?
5. What remains uncertain, and who must decide before publication or merge?

Nitely's durable evidence includes planning artifacts, input snapshots and
hashes, stage attempts, command output, artifact provenance, gate results,
blocker and resume history, reviewer findings, operator decisions, and PR
metadata. Evidence must remain local and customer-controlled by default, with
secrets and raw context protected by policy and redaction boundaries.

## Product Decision Checklist

Use this checklist when evaluating a new feature, flow, or architecture:

1. **Intent clarity:** does it make the approved change and scope explicit?
2. **Execution containment:** does it bound runtime authority, inputs, tools,
   and side effects?
3. **Verifiability:** can the important claim be checked independently?
4. **Independence:** does verification avoid inheriting implementation context
   or conclusions without a deliberate reason?
5. **Evidence and provenance:** can a reviewer reconstruct why the change is
   acceptable?
6. **Risk routing:** does human attention increase with actual risk and
   uncertainty?
7. **Recoverability:** are failure, retry, resume, rework, and rollback safe
   and bounded?
8. **Measurability:** can we evaluate whether the feature improves useful,
   reviewable delivery?

Features should strengthen at least one part of this chain. Features that only
make an agent feel more autonomous, conversational, or human-like should not
be prioritized unless they improve governed delivery or verification.

## Prefer and Be Cautious About

Prefer:

- typed artifacts and explicit contracts;
- deterministic gates before semantic gates;
- structured `PASS`, `REWORK`, and `HUMAN_REVIEW` outcomes;
- bounded retries and rework;
- risk-based escalation;
- provenance-rich evidence;
- reviewer calibration and replayable evaluation;
- repository-owned policy and configuration;
- replaceable runtime and model providers.

Be cautious about:

- treating "the agent said it is correct" as a gate;
- opaque confidence scores;
- same-agent self-review presented as independent verification;
- unbounded autonomous loops;
- auto-merge based only on semantic-model judgment;
- agent personas or workforce features that do not improve delivery trust;
- broad software-factory scope that weakens the core verification thesis.

## Boundaries and Relationships

This model sharpens existing work; it does not replace it:

- [Positioning](positioning.md) describes the governed spec-to-PR wedge and
  boundaries against Agent-workforce products.
- [Approval-First Ticket-to-PR Product Contract](approval-first-ticket-to-pr.md)
  defines the shipped lifecycle and proof contract.
- [Harness and Audit Evidence](harness-and-audit.md) describes enforced
  artifact, command, gate, and timeline evidence.
- [Security and Trust Model](security-and-trust.md) defines local execution,
  secret, redaction, and future control-plane boundaries.
- #467, #471, #570, and #572 cover structured review, independent
  perspectives, Judge stages, and risk-based policy.
- #587 evaluates whether reviewers actually detect defects and control false
  positives; reviewer trust must be earned through that evidence.
- #429 supplies replayable eval cohorts and provenance for comparison.

Nitely should remain a narrow, local-first delivery and verification layer. It
may integrate with GitHub, Jira, Linear, or an Agent-workforce intake system,
but it should not become a general chat, project-management, or persistent
Agent-employee product.

The long-term question is:

> Which AI-generated changes have earned enough trust to move forward, why, and
> based on what evidence?
