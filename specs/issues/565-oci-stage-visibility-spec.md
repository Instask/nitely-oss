# Issue 565: OCI stage visibility

## Goal

Minimize credentials and run artifacts visible inside an OCI agent container.

## Requirements

- Filter the configured OCI secret allowlist by the selected runtime's
  required environment groups before constructing the agent environment.
- Keep required credential absence fail-closed; never substitute an unrelated
  provider credential.
- Mount only the stage's admitted input artifact paths under `/nitely/run`.
- Keep the stage attempt output as the only writable artifact mount.
- Reject missing or out-of-run artifact paths before container launch.
- Preserve secret-name evidence without persisting secret values.

## Non-goals

- Changing the run-level environment contract for command stages.
- Replacing the capability policy or network gateway.
