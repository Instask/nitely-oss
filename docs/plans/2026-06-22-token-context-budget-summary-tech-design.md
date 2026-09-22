# Token and Context Budget Summary Tech Design

## Overview

Issue #65 already records the primitive events needed for token/context accounting:

- `stage.context.usage`
- `stage.runtime.usage`
- `budget.trimmed`
- `budget.exceeded`

The final increment adds a projection-level summary that turns those events into a compact budget view for API and console consumers.

## Projection

`ProjectedRun` gains `budgetSummary` with:

- aggregate approximate context tokens
- aggregate runtime tokens
- trim and exceed event counts
- aggregate trimmed tokens before and after trimming
- top token consumers sorted by token count

Top consumers are normalized records containing `stageId`, `attempt`, `kind`, and `approxTokens`, plus optional budget metadata. Runtime consumers use provider-reported `totalTokens` when available and fall back to input plus output tokens.

## Web API

`getRunDetail` and projected run summaries pass through `budgetSummary` when it exists. Historical runs without the source events continue to omit the field.

## Console

The run detail header formats:

- a compact run-level budget summary
- a monospace top-consumer line that identifies the largest stage/attempt contributors

Stage-level context/runtime/budget labels remain unchanged.

## Tests

Add focused coverage for:

- projection summary aggregation and top-consumer ordering
- Web run detail serialization
- static console references for budget summary and top-consumer fields
