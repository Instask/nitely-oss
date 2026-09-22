# Issue 98 Spec: Security and Trust Model

## Problem

Nitely's buyer promise depends on control, reviewability, and local execution.
Security claims must be precise enough for engineering leaders to inspect before
trusting future commercial or control-plane products.

## Goals

- Document where source code, worktrees, credentials, logs, and evidence live.
- Distinguish current local implementation from intended future SaaS/control
  plane behavior.
- State clearly that code, secrets, and agent execution remain in the customer's
  environment unless explicitly configured otherwise.
- Document redaction expectations and default retention behavior.
- Provide a threat model for local execution, customer-hosted runners, and cloud
  coordination.

## Non-Goals

- Implement new security controls.
- Promise enterprise certifications.
- Replace repository-specific security review.
- Finalize customer-hosted runner protocol design.

## Acceptance Criteria

- `docs/security-and-trust.md` exists.
- README links to the doc.
- The doc distinguishes current implementation from future SaaS behavior.
- The doc includes the required statement about code, secrets, and agent
  execution staying in the customer's environment unless explicitly configured
  otherwise.
