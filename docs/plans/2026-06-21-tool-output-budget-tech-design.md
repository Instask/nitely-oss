# Tool Output Budget Tech Design

## Overview

The previous #65 increment added runtime token usage measurement. This increment enforces a concrete budget boundary that Nitely can control directly: command and deterministic-gate output captured by the orchestrator.

## Flow Schema

Add `maxToolOutputTokens` to:

- flow spec defaults
- command stages
- deterministic gate stages

Reject the field on stages where Nitely does not directly own tool output capture yet, including agent and review-gate stages.

## Runtime Behavior

Command execution continues to write full stdout and stderr to `stdout.log` and `stderr.log`. After redaction, Nitely derives bounded summaries from those full logs when `maxToolOutputTokens` is exceeded.

The bounded summary is used in:

- `command.completed` event payloads
- deterministic gate result stdout/stderr fields
- command attempt `output.md`

The full logs remain addressable by path for explicit inspection.

## Budget Events

When output is capped, append `budget.trimmed` with:

- `budgetKind: "tool-output"`
- `budget`
- `approxTokensBefore`
- `approxTokensAfter`

This keeps the event stream compatible with existing budget projections while distinguishing output trimming from input-context trimming.

## Non-Goals

- Capturing internal agent tool calls from Codex/Claude/Pi.
- Provider-specific token accounting.
- Failing a run solely because command output exceeded the budget.
- Summarizing arbitrary generated artifacts with an LLM.
