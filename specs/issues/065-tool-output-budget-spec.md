# Issue 65 Tool Output Budget Spec

## Scope

Implement the next token/context budget increment for issue #65 by bounding command and deterministic-gate tool output that Nitely records into events and downstream summaries.

## Requirements

- Flow specs may declare a default `maxToolOutputTokens`.
- Command stages and deterministic gate stages may override `maxToolOutputTokens`.
- Agent, review gate, approval, publish, update, and sync stages must reject `maxToolOutputTokens`.
- Full command stdout/stderr must still be stored in log files for audit and debugging.
- Structured events and command attempt summaries must use capped output summaries when output exceeds the budget.
- A `budget.trimmed` event must be recorded when command output is capped.
- Existing flows without tool-output budgets must keep current behavior.

## Acceptance Criteria

- `loadFlow` preserves flow-level and stage-level `maxToolOutputTokens` for command and deterministic gate stages.
- `loadFlow` rejects `maxToolOutputTokens` on agent-like and non-command stages.
- Command output exceeding the budget is truncated in `command.completed` payloads.
- Full `stdout.log` and `stderr.log` content remains untruncated.
- `output.md` records where full logs live and includes a bounded summary.
- `budget.trimmed` includes `budgetKind: "tool-output"` and before/after token estimates.
