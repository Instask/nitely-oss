# OCI stage capability enforcement technical design

The OCI backend already resolves the flow capability policy before launching a
runtime. Keep enforcement at the existing mount/network/command seams:

1. Derive workspace bind mounts from `write.scope` and `write.allow`; use a
   read-only base mount for `none`, and reject writable paths with that scope.
2. Validate the same mounts during preflight so invalid stage declarations are
   reported before the engine check or workload launch.
3. Preserve the existing fail-closed network and command mediation decisions.
4. Reuse run-flow capability evidence rather than adding a second policy
   serialization format.

Verification covers read-only mounts, contradictory declarations, existing
network-denied behavior, and OCI preflight.
