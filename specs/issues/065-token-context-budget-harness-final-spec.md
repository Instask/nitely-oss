# Issue 65 Token and Context Budget Harness Final Spec

## Scope

Close the remaining observability gap for issue #65 by exposing a run-level budget summary and top token consumers across existing context usage, runtime usage, and tool-output budget events.

Earlier increments already added schema budget fields, context trimming, tool-output caps, runtime usage measurement, and Web Console stage-level usage. This increment does not introduce a new execution backend or a pi-agent routing strategy.

## Requirements

- Projection must summarize token/context budget signals at run level.
- The summary must include approximate prompt/context tokens, runtime token totals, trim counts, exceed counts, and trimmed token totals before and after trimming.
- Projection must identify the largest token consumers by stage, attempt, source kind, and token count.
- Web run detail must expose the summary so the console can show why a run consumed budget.
- The static console must format the run summary and top consumers without requiring raw logs.
- Existing runs that predate budget events must keep omitting budget summary fields.

## Acceptance Criteria

- Runs with `stage.context.usage` contribute to `budgetSummary.contextApproxTokens`.
- Runs with `stage.runtime.usage` contribute to `budgetSummary.runtimeTokens`.
- Runs with `budget.trimmed` contribute to trim counts and before/after token totals.
- Runs with `budget.exceeded` contribute to exceed counts and top-consumer records.
- Web run detail includes `budgetSummary`.
- Console static view references budget summary and top token consumer fields.
