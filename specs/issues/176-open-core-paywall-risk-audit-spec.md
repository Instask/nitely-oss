# Issue 176 Spec: Open-Core Paywall Risk Audit

## Problem

Nitely is being split into an open-source local core plus future commercial
team/control-plane products. The current codebase already contains local
versions of some team-shaped capabilities, including repository management,
users, organizations, provider connection hints, and a manager dashboard. Without
an explicit feature inventory, it will be easy to accidentally move trust-critical
capabilities behind a commercial boundary later.

## Goals

- Inventory the implemented Nitely feature surface.
- Classify each feature as OSS core, commercial/team layer, or boundary decision.
- Mark paywall-risk areas where commercializing the wrong layer would undermine
  trust in the open-source core.
- Distinguish local/basic OSS capabilities from future hosted/team equivalents.
- Link the audit from the open-core boundary doc tracked by #94.

## Non-Goals

- Finalize the entire #94 open-core boundary.
- Change runtime behavior.
- Move code between repositories.
- Define pricing or pilot packaging.

## Acceptance Criteria

- A feature audit doc covers CLI/runtime, flow spec, local execution, Web
  Console, evidence/logging, retry/rework/resume, repository management, team
  dashboard, auth/orgs, provider credentials, and SCM integrations.
- The audit calls out paywall risks and commercial equivalents.
- The #94 boundary doc links to the audit.
