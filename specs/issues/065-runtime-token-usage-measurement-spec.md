# Issue 65 Runtime Token Usage Measurement Spec

## Scope

Implement the first measurement increment for issue #65 by recording token usage reported by agent execution backends at stage-attempt granularity. This increment does not implement budget enforcement or a pi-agent token reduction strategy.

## Requirements

- Agent execution backends may return normalized runtime usage with input, output, total tokens, context window, estimated USD cost, and provider raw metadata.
- Runtime usage must be persisted as structured run events, not inferred only from raw logs.
- Projection must expose usage on attempts, aggregate it to stage and run totals, and preserve unknown attempts separately from zero-token usage.
- Web Console run details must show run-total and per-stage runtime token usage when known, and show unknown when usage is unavailable.
- PR evidence must include a runtime usage summary for the run.
- Existing flows and execution backends must continue to work when usage is unavailable.

## Acceptance Criteria

- A backend result with usage emits a `stage.runtime.usage` event for the matching stage attempt.
- Projection folds `stage.runtime.usage` onto the attempt and run total.
- Projection counts runtime attempts without usage as unknown, not zero.
- Web run detail includes run-total `runtimeUsage` and timeline per-stage `runtimeUsage`.
- Console static view formats known usage and unknown usage distinctly.
- Existing context usage behavior remains unchanged.
