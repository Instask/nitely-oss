# Runtime Token Usage Measurement Tech Design

## Overview

Issue #65 needs token/context visibility before deeper budget enforcement or agent-routing changes can be evaluated. The first increment adds a structured runtime usage path parallel to existing context usage tracking.

## Event Model

Add `stage.runtime.usage` events with normalized payload fields:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `contextWindow`
- `estimatedCostUsd`
- `raw`

The event is emitted only when the execution backend reports usage. Missing usage is represented later in projection as unknown.

## Runtime Integration

Extend `AgentResult` with optional `usage`. `runAgentInWorkspace` returns usage alongside log paths. Agent and review-gate stages append `stage.runtime.usage` after successful backend execution when usage exists. Deprecated direct `executeAgent` injection remains supported and produces unknown usage.

## Projection

Projection adds:

- attempt-level `runtimeUsage`
- run-level `runtimeUsage`
- `sumRuntimeUsage(...)` for known numeric totals plus `knownAttempts` and `unknownAttempts`

Unknown attempts are runtime attempts with an agent stage type or selected runtime but no usage event.

## Web Console

`src/web/runs.ts` exposes run totals and per-stage totals. `console.dc.html` formats:

- known totals as runtime token counts
- known input/output-only values when total is unavailable
- missing values as `runtime tokens unknown`

## Evidence

`evidence.md` gains a Runtime Usage section summarizing known attempts, unknown attempts, token totals, and estimated cost when available.

## Non-Goals

- Enforcing token budgets.
- Implementing pi-agent routing.
- Estimating real usage from prompt size when backend usage is unavailable.
- Provider-specific pricing tables.
