# Issue 96 Spec: Production Flow Template Set

## Problem

Paid pilot conversations need concrete, repeatable workflows rather than generic
agent execution. Buyers should be able to map a common engineering failure mode
to a narrow Nitely flow that produces a reviewable PR and durable evidence.

## Goals

- Add at least three pilot-ready flow templates.
- Make the templates available through the built-in flow template catalog.
- Document expected inputs, stages, verification, PR evidence, failure/retry
  behavior, and example run commands for each template.
- Map templates to discovery-call failure modes.
- Assume customer-hosted execution against a local repository checkout.

## Non-Goals

- Add hosted control-plane features.
- Guarantee that the example commands pass in every customer repository without
  operator adjustment.
- Create pricing or sales collateral beyond the operator guide.

## Acceptance Criteria

- At least three pilot-ready flow templates exist.
- Each template has a short operator guide.
- Each template has one example run against Nitely or a sample repo.
- Templates are mapped to discovery-call failure modes.
