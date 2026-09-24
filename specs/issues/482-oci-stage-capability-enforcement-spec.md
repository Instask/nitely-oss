# Issue 482: OCI stage capability enforcement

## Goal

Make flow-declared stage capability bounds hard OCI boundaries.

## Requirements

- `write.scope: "none"` mounts the task worktree read-only.
- `write.scope: "worktree"` permits the worktree, narrowed to declared
  `write.allow` paths when present.
- Unsupported or contradictory capability declarations fail before container
  launch.
- Required network and command policies fail closed when OCI has no enforcing
  mechanism; advisory policies are labeled as advisory in the prompt/evidence.
- The effective stage policy remains visible in durable run evidence.

## Non-goals

- Network gateway direct-egress hardening (issue #562).
- Secret and run-artifact minimization (issue #565).
