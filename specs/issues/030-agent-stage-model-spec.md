# Issue #30 Specification: Per-stage model selection for agent stages

## Goal

Let a flow choose which model an `agent` stage uses, so a stage can run on a
specific Codex model instead of always relying on the CLI default.

## Requirements

- Add an optional `model` string to agent stages.
- Reject an empty `model` string during flow validation.
- For the local Codex execution backend, pass the model to Codex CLI as
  `-m <model>` when it is present.
- Preserve current Codex CLI arguments when `model` is omitted.
- Document the field in both English and Chinese READMEs.

## Non-goals

- Web Console model selection UI.
- A hardcoded Nitely default model.
- Provider-specific model validation.

## Acceptance Criteria

- A flow with an agent stage `model` loads successfully.
- A flow with an empty agent stage `model` fails validation.
- `createCodexExecArgs` includes `-m <model>` only when a model is supplied.
- Existing flow execution behavior is unchanged when no model is supplied.
