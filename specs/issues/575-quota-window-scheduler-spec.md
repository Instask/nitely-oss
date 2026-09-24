# Issue #575 — Quota-window-aware scheduling

Usage-limit blockers are a durable scheduler resource. A parsed provider reset
time is persisted under `.nitely/scheduler-cooldowns.db`; if a provider gives no
parseable reset, the scheduler records a bounded configurable fallback (five
minutes by default, `--usage-limit-cooldown-ms` to override). While a runtime is
cooling down, ready work routed to that runtime remains ready and is reported
in `cooldownTaskIds`/`cooldownUntil`; other runtimes continue to dispatch.

The scheduler resumes due usage-limit runs before admitting new work. A
successful resume clears that runtime cooldown, while a new blocker records a
new reset. Each cooldown decision is also written as a `scheduler.cooldown`
run event so CLI/API summaries and run evidence have an auditable reason.

Continuous CLI operation supports `scheduler --daemon` without a clock window.
Windowed operation remains unchanged. Each cycle sleeps for the smaller of the
configured interval and the next known reset delay, so a daemon wakes at the
quota boundary and then fills available work.
