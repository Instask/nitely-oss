# OCI stage visibility technical design

1. Reuse the runtime registry's `requiredEnv` groups to derive per-agent secret
   names from the configured OCI secret allowlist. Keep the existing command
   stage environment path unchanged.
2. Pass the already-resolved stage input artifact paths from `run-flow` to the
   backend. For agent runs, mount a read-only `/nitely/run` tmpfs and bind only
   those paths; keep `/nitely/output` as the writable attempt mount.
3. Validate artifact paths with the run-root containment check and fail before
   Docker engine inspection or workload launch.
4. Reuse existing redaction and capability evidence; do not add a second secret
   serialization format.

Tests cover two-provider secret filtering, declared-input visibility, missing
artifact failure, and preservation of command-stage behavior.
