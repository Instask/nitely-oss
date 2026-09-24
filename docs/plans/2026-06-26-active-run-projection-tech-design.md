# Active Run Projection Tech Design

Issue: #196

## Context

`projectRun` is used by both operator-facing API/UI projection and recovery
logic. Before this change, it finalized any latest `started` attempt without a
terminal event into `interrupted`. That was useful for resume after process
restart, but wrong for live API views where an agent may still be running.

## Design

Introduce a small projection option:

```ts
projectRun(events, { openAttemptStatus: "interrupted" })
```

Default behavior:

- open latest attempts remain `started`;
- the run remains `running` unless a terminal event changes it;
- web projection maps an open attempt to `currentStageState: "running"`.

Recovery behavior:

- `resumeRun` calls `projectRun(events, { openAttemptStatus: "interrupted" })`;
- existing resume logic still finds resumable interrupted stages;
- the old recovery semantics are explicit at the call site.

## Tradeoffs

The original #196 slice did not solve stale process detection. The #209 follow-up
adds `stage.heartbeat` events while long-running command, agent, and review-gate
attempts are awaiting their execution backend. Web projection treats open attempts
whose latest event is older than the stale threshold as interrupted, while recent
heartbeats keep legitimately active attempts visible as running.

## Tests

- Unit test default `projectRun` behavior for open attempts.
- Unit test recovery projection behavior.
- Web run projection test asserts top-level `running` plus stage `running`.
- Existing resume tests verify recovery projection still works.
