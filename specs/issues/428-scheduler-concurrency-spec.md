# Issue #428 — Scheduler concurrency, locks, and leases

`runSchedulerOnce` keeps its bounded worker pool and adds an explicit
concurrency policy: global (cycle), repository, and flow limits. A durable
SQLite lease in `.nitely/scheduler-leases.db` gives each task one owner across
concurrent scheduler processes. Leases heartbeat during long runs and expire
only after the configured TTL, allowing a dead worker to be recovered without
duplicating a live run.

Callers may provide conflict resource keys for branch, worktree, path scope,
approval boundary, or change request. Active leases sharing a key serialize;
independent keys can overlap. Admission remains the final idempotency guard,
and the existing stable summary ordering keeps task lineage deterministic even
when run completion order differs. Runner-level cancellation and hard budgets
remain authoritative for cooperative cancellation and bounded execution.
