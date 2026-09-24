# Issue 473: Per-stage capability policy

## Goal

Make stage privileges part of the flow contract so planning and review stages
cannot silently inherit implementation-stage write access.

## Requirements

- Agent stages and review gates may declare the existing `capabilities` block.
- Bootstrap flows declare read-only policies for planning, review, and
  reflection; `write-tests` may write only `test/`; `implement` may write the
  worktree.
- Local execution maps the broad write boundary to native runtime controls:
  Codex `read-only`/`workspace-write` and Claude permission modes.
- A local runtime without native read-only enforcement fails closed for a
  stage requiring `write.scope: "none"`.
- Path allowlists and other backend-specific controls remain explicit in run
  evidence and are not presented as locally enforced until OCI enforcement is
  available.

## Non-goals

- OCI path, secret, network, or artifact-mount enforcement (tracked by the
  follow-up capability enforcement issues).
- Dynamic privilege escalation during a stage.

## Acceptance

- All checked-in spec-driven bootstrap flows parse with explicit stage
  capability declarations.
- Local capability mapping has regression coverage for Codex and Claude, and
  unsupported read-only runtimes fail before spawning.
- Flow-authoring and harness documentation state the enforcement/degradation
  boundary.
