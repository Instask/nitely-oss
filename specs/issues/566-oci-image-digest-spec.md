# Issue #566 — OCI immutable runner image identity

## Contract

Before a normal run uses the OCI backend, Nitely inspects the configured local
image exactly once. It records the configured reference plus an immutable
`sha256` identity, and launches the workload using a repo digest when one is
available or the immutable local image ID otherwise.

## Safety invariants

1. Missing or uninspectable images fail before workload launch.
2. Retagging the configured mutable reference after admission cannot change the
   image used by that run.
3. The human-readable image reference and immutable identity appear in backend
   evidence and `reproducibility.json`.
4. Resume reuses the recorded immutable identity and verifies that identity is
   still locally available instead of following a retagged reference.
5. Image inspect output is never treated as a credential or copied into the
   container environment.
6. Enterprise/shared runners should prefer approved digest-pinned references;
   signature verification remains a later policy layer.

## Verification

- mutable-tag inspection is cached for the run and the launch uses the first
  immutable identity;
- image inspection failure is actionable and fail-closed;
- existing OCI sandbox, evidence, and direct backend behavior remain intact.
