# Product Definition

Four constraints define Nitely. A proposal that breaks one of them is a different product.

- **Intent is explicit.**
- **Execution is constrained.**
- **Results require evidence.**
- **Humans retain authority.**

## Intent is explicit

A run starts from an approved artifact: a spec, a technical design, a ticket
snapshot, or another declared input. The artifact names the scope, and the run
records which revision it consumed. A conversation can produce that artifact.
The conversation itself is not the intent the run executes.

## Execution is constrained

A versioned Flow declares stage order, inputs, outputs, tools, gates, and
publication. Worktrees, retries, sandboxes, and agent runtimes stay inside that
declaration. Capability a model happens to have is not authority the run has
granted.

## Results require evidence

A diff or a line that says done is not a result. Someone who was not in the
session must be able to reconstruct which commands, gates, artifacts, blockers,
and decisions produced the change. A claim without that record is unresolved.

## Humans retain authority

Approval, review, draft publication, and merge stay with a person. The system
routes attention by risk and records the decision. When the remaining question
is whether the change should ship, a person answers it.

## What the constraints produce

Today those constraints show up as an open, local-first governed spec-to-PR
execution system. Approved engineering intent becomes an evidence-backed,
reviewable draft pull request. Codex, Claude, GLM, Grok Build, Pi, and later
coding agents are interchangeable runtimes inside the Flow. The product is the
constraint and the evidence around them.

The operating rhythm is plan by day, execute by night, review by morning. See
[usage scenarios and the efficiency thesis](usage-scenarios-and-efficiency-thesis.md).

## Decision test

Before adding a surface, ask which line it serves:

1. Does it make the approved intent and its revision more explicit?
2. Does it state or tighten an execution bound?
3. Does it make the result checkable after the fact?
4. Does the consequential decision stay with a person?

A feature that only makes an agent more autonomous, more conversational, or
more like an employee has to earn its place by strengthening one of the four.
Otherwise it waits.

## Where the other documents sit

- [Trust and verification model](trust-and-verification-model.md) — how a change earns trust inside these constraints.
- [Approval-first ticket-to-PR](approval-first-ticket-to-pr.md) — the shipped lifecycle.
- [Harness and audit](harness-and-audit.md) — the evidence the third line requires.
- [Security and trust](security-and-trust.md) — where code, secrets, logs, and execution are allowed to go.
