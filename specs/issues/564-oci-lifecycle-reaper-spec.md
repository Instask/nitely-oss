# Issue #564 — OCI lifecycle labels and orphan reaping

## Problem

A controller crash can leave a Nitely OCI workload or egress gateway running
after the normal `--rm`/forced cleanup path is lost.

## Behavior

- Every Nitely-managed workload and OCI egress gateway carries ownership labels:
  managed flag, run/stage IDs, creation time, expiry time, and controller
  instance ID.
- Expiry is the effective workload timeout plus a 30-second cleanup grace
  period by default.
- The Web controller scans only `com.nitely.managed=true` containers at startup
  and every 60 seconds, removing containers whose expiry has passed.
- Missing or malformed expiry metadata is skipped; list/inspect/remove races are
  fail-safe and idempotent. Reaper diagnostics contain IDs and exit status only,
  never environment values or container output.

## Acceptance checks

- Docker launch arguments contain the ownership and expiry labels.
- Expired managed containers are removed; active and unrelated containers are
  not targeted.
- An already-removed container is treated as successfully reaped.
- Lifecycle policy is included in execution evidence without secret values.
- Unit tests cover label expiry, allowlist filtering, malformed metadata, and
  cleanup races.

Out of scope: recovering a workload's in-memory process state or reaping
containers created by operators without Nitely's managed label.
