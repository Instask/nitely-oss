# Schedules

Status: first-class time triggers for #623; reliability and operations for #624.

A **Schedule** decides *when work is created*. It never runs anything itself:
each firing materializes one new Task plus one Factory Queue candidate, and
the queue and the execution scheduler decide when that work actually runs.

```text
Schedule / time trigger → Task + Candidate → Factory Queue → Execution scheduler → Run
```

## Model

Schedules live per repository in `.nitely/schedules/schedules.json`; their
occurrences in `.nitely/schedules/occurrences.json`.

| Field | Meaning |
| --- | --- |
| `trigger` | `{ type: "once", at }`, `{ type: "cron", expression }` or `{ type: "interval", everyMs, anchorAt }` |
| `timezone` | IANA zone the cron expression is evaluated in (explicit, never the host zone) |
| `template` | `title`, `spec`, `techDesign`, optional `flowPath`, `riskClass`, `labels` — the task each occurrence is created from |
| `admission` | `auto` (planning artifacts approved, candidate can queue on its own) or `review` (draft task, candidate `needs_human`) |
| `misfire` | `{ policy: "skip" \| "run_once_now" \| "catch_up", limit?, graceMs? }` — what to do with firings that should already have happened (default `run_once_now`, grace 5 min, catch-up limit ≤ 50) |
| `overlap` | `allow` \| `skip` \| `queue` — what to do when the previous occurrence's task is still ready or running (default `allow`) |
| `revision` | bumped on every edit; each occurrence records the revision it used |
| `nextRunAt` / `lastRunAt` / `lastOccurrenceId` / `completedAt` | durable firing state; a restart reads it back from disk |

Cron expressions are the five standard fields (`minute hour day-of-month
month day-of-week`) with `*`, steps, ranges and lists. DST is deterministic:
a wall-clock time that does not exist on a spring-forward day is skipped, and
a time that occurs twice on a fall-back day fires at its first instant only.
Interval triggers are anchored (`anchorAt + k × everyMs`), so a restart or a
late scan never drifts the grid. A one-shot schedule records `completedAt`
after its single occurrence.

## Firing

`materializeDueSchedules` runs at the start of every general execution
scheduler cycle (`nitely scheduler`, `POST /api/scheduler/run`) and on
`nitely schedule tick`. A cycle limited to explicit candidates (Factory Queue
dispatch) does not fire schedules. For each enabled schedule whose
`nextRunAt` has passed it:

1. creates a Task from the template (approved or draft per `admission`);
2. upserts a Factory Queue candidate with `source.type: "schedule"` and
   identity `<scheduleId>@<intendedFireAt>` — the candidate id is a hash of
   that identity, so one intended firing can only ever produce one candidate;
3. records an occurrence (`intendedFireAt`, `materializedAt`, revision,
   task and candidate ids) under a deterministic id;
4. advances `nextRunAt` from the scan time.

### Idempotent, crash-safe firing

An occurrence's id is derived from the schedule id and the intended fire
time, and the task it creates is `task-<occurrence id>`. The occurrence is
written as `pending` **before** the task or candidate exists; a crash at any
later point leaves a pending record that the next scan completes, finding the
task by its derived id and the candidate by its identity instead of creating
either again. The schedule only advances after the occurrence is complete.
Repeated scans of the same instant therefore cannot duplicate work, and a
restart after firing is safe.

### Misfire policy

A scan finds every instant the trigger should have fired at between the
stored `nextRunAt` and now. One instant within `graceMs` of now is a normal
firing. Anything older is a misfire and follows the schedule's policy:

- `skip` — every missed instant is recorded as a skipped occurrence; nothing
  is created.
- `run_once_now` (default) — one occurrence fires for the latest missed
  instant, the others are recorded as skipped.
- `catch_up` — up to `limit` missed instants fire, oldest first; the rest are
  recorded as skipped.

The backlog is always bounded: enumeration stops at 1000 instants, at most 25
skipped occurrences are recorded individually, and the remainder is summarized
in one record (`… N further occurrences skipped`).

### Overlap policy

Before firing, the previous occurrence's task is checked. If it is still
`ready` or `running`: `allow` fires anyway, `skip` records a skipped
occurrence (`overlap: previous occurrence still active`), and `queue` fires but
makes the new task depend on the previous one so the execution scheduler
orders them. Queue concurrency (`maxConcurrentRuns`) still applies on top.

### History and lineage

`occurrences.json` records for every decision: intended fire time, actual
materialization time, occurrence id, status (`pending`, `materialized`,
`skipped`), reason, schedule revision, task and candidate ids, and whether it
was manual. Lineage to the current task status, latest Run id and queue status
is read live (`listScheduleOccurrencesWithLineage`), and every occurrence
also emits a `schedule.occurrence.materialized` / `schedule.occurrence.skipped`
event in the event store under its occurrence id.

Pausing clears `nextRunAt`; resuming recomputes it from now. Editing bumps
the revision and recomputes the next firing without rewriting historical
occurrences. Deleting removes the definition only — occurrences, tasks and
runs stay.

## Entrypoints

CLI:

```bash
nitely schedule create --name weekly-health --cron "0 9 * * 1" --timezone Asia/Singapore \
  --title "Weekly repository health review" --spec-file spec.md --tech-design-file design.md
nitely schedule create --name six-hourly --every 6h --title … --spec-file … --tech-design-file …
nitely schedule create --name later --at 2026-10-01T09:00:00Z --title … --spec-file … --tech-design-file …
nitely schedule create … --misfire catch_up --catch-up-limit 3 --overlap skip
nitely schedule list | pause <id> | resume <id> | delete <id> | tick
```

Web API (`scheduler:run` for mutations):

- `GET /api/schedules[?repoId=]` — each schedule carries `lastOccurrence` and
  `lastMaterializedOccurrence` with lineage; `GET /api/schedules/:id` adds the
  full occurrence history, newest first
- `POST /api/schedules` `{ repoId?, name, trigger, timezone, template, admission? }`
- `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`
- `POST /api/schedules/:id/pause|resume|run-now` — `run-now` materializes a
  manual occurrence immediately and leaves the regular `nextRunAt` untouched.

All mutations are recorded in the security audit log as `schedules.*`.

## Web Console

The Schedules view lists every schedule with its enabled/paused/completed
state, trigger and timezone, next run, last occurrence and result, policies,
and links to the last generated task and run. Pause, resume, run-now, delete
and trigger/timezone edits are available inline; opening a schedule shows its
occurrence history with intended vs. materialized time, reason, revision and
task / queue / run lineage. Deleting a schedule never deletes its history,
tasks, runs or evidence.
