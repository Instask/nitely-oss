# Issue 97 Spec: Customer-Hosted Runner Boundary

## Problem

Nitely's trust story should not require source code, secrets, worktrees, or raw
agent context to be uploaded to a hosted Nitely service. Future team and cloud
products need a coordination model where execution remains in the customer's
environment while the control plane coordinates tasks, policy, and visibility.

## Goals

- Define customer-hosted runner responsibilities.
- Define control-plane responsibilities.
- Enumerate data that must not leave the customer environment by default.
- Specify a minimal runner/control-plane event protocol.
- Define offline and failure behavior.
- Support both self-hosted control planes and future managed deployments.

## Non-Goals

- Implement the runner protocol.
- Build the cloud control plane.
- Define pricing, packaging, or SSO implementation details.
- Replace the security/trust model in `docs/security-and-trust.md`.

## Acceptance Criteria

- Architecture doc exists with trust boundaries and sequence diagrams.
- Minimal runner/control-plane protocol is specified.
- Security-sensitive data classes are enumerated.
- The design supports both self-hosted and future managed deployments.
