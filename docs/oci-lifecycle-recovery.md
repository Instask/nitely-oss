# OCI lifecycle recovery

Nitely labels every OCI workload and egress gateway with:

- `com.nitely.managed=true`
- run and stage ownership
- creation and expiry timestamps
- the controller instance that created it

Expiry is the stage timeout plus a bounded 30-second cleanup grace period.
When the Web controller starts, and every 60 seconds afterward, it lists only
containers carrying `com.nitely.managed=true`. It removes managed containers
whose expiry has passed. Missing or invalid expiry labels are left untouched so
an uncertain container is never removed by accident.

The reaper uses the local rootless Docker endpoint and passes only `PATH` and
`DOCKER_HOST` to the engine. Diagnostics report container IDs and exit status,
not environment values, command output, or secrets. Normal completion still
uses `--rm` and forced cleanup; the reaper is the crash-recovery safety net.
