# Issue 196: Active Run Projection

## Problem

The web API projected a run as `interrupted` whenever the latest stage attempt
had `stage.started` but no terminal event. That made newly accepted and still
active agent attempts look recovery-needed while their current stage state was
still `running`.

## Goals

- Default run projection should treat an open latest attempt as active/running.
- Web/API summaries and details should not expose top-level `status:
  "interrupted"` for a live attempt solely because no terminal event exists yet.
- Recovery/resume code may still request a recovery-oriented projection that
  treats open attempts as interrupted after a process restart.
- Keep the distinction visible in code so operator projection and recovery
  projection cannot drift accidentally.

## Non-Goals

- Adding process heartbeat detection.
- Inspecting OS process tables from the web API.
- Changing terminal statuses such as completed, failed, blocked, or cancelled.

## Acceptance Criteria

- `projectRun(events)` returns top-level `running` for a run with `run.created`
  and an open `stage.started` attempt.
- `projectRun(events, { openAttemptStatus: "interrupted" })` preserves the
  recovery behavior needed by `resumeRun`.
- `GET /api/runs/:runId` style projections expose `status: "running"` and
  `currentStageState: "running"` for open active attempts.
- Existing resume tests continue to pass by using the recovery projection.
