# Context Delivery And Usage

Nitely snapshots run inputs to disk, then renders a compact prompt view for each
agent and review-gate attempt. The prompt view is an optimization for token and
context size; it does not delete input data that was accepted by context policy.

## Prompt Delivery Strategy

| Input kind | Prompt delivery |
| --- | --- |
| Textual input up to 8 KiB | Metadata, readable path, and full content inline. |
| Textual input larger than 8 KiB | Metadata, readable absolute `Full content` path, an 8 KiB head preview, and a mandatory-read instruction. |
| Binary or non-textual input | Metadata and readable path only; no content preview. |
| Omitted by context policy | Omitted-by-policy metadata and reason; no snapshot bytes and no prompt content. |

Every accepted input artifact is materialized under the run directory, usually
at `.nitely/runs/<run-id>/inputs/<input-id>/content`. For generated artifacts,
the prompt includes the artifact metadata and path recorded in the run artifact
registry.

## When Agents Must Read Files

When a textual input is larger than 8 KiB, Nitely includes only a head preview in
the prompt. The prompt also includes a `Full content` absolute path and an
instruction that the agent must read the full file before using that input.

Agents should treat truncated previews as orientation only. The full artifact
content remains on disk at the path shown in the prompt, so downstream stages can
inspect it directly without relying on the preview.

Binary and non-textual inputs are never previewed. Agents that need their bytes
must use the path shown in the prompt.

## Context Usage Metrics

Each agent or review-gate attempt emits one `stage.context.usage` event. The
payload records:

- `promptBytes`: total assembled prompt size in bytes.
- `approxTokens`: model-agnostic estimate, `ceil(promptBytes / 4)`.
- `inputBytesInlined`: input bytes included directly in the prompt.
- `inputBytesSaved`: input bytes omitted from the prompt because an artifact was
  previewed or referenced by path.
- `inputCount`: number of input artifacts rendered for the attempt.

Run projection attaches these metrics to attempts, folds them into per-stage
totals, and accumulates a run-total `contextUsage`. The Web Console run details
show per-stage and run-total context usage when available. Runs created before
these events existed simply omit the field.

## Context Policy And Redaction

`nitely.context.json` still decides which local inputs can be snapshotted into a
run. Inputs excluded by policy are not written to run snapshots, not included in
prompts, and not sent to providers. In `warnOnly` mode, excluded inputs are
recorded as warned and still have their bytes omitted.

Prompt previews, prompt files, logs, evidence, run events, PR bodies, and Web
API text responses continue to pass through Nitely's runtime/Web redaction
paths. Source snapshots and generated artifacts are not modified in place by
redaction.

## Current Non-Goals

- Nitely records context usage for observability, but it does not enforce
  context budgets yet.
- Nitely does not automatically switch provider, runtime, or model when a prompt
  is large or when a provider reports quota or usage-limit failures.
