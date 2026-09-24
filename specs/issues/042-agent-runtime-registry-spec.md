# Issue 42: Agent Runtime Registry

## Objective

Make Nitely agent execution select a real runtime by each agent stage's `runtime` field instead of always spawning Codex. Support Codex, Claude, and GLM through a small local runtime registry, preserve Codex backward compatibility, pass through per-stage models, report provider configuration, and include runtime/model evidence in generated PRs.

## Problem

The flow schema already requires `runtime` on `agent` stages and accepts an optional `model`, but `LocalExecutionBackend.runAgent` currently ignores `stage.runtime` and always runs `codex`. The Web Console already reports Codex and Anthropic provider status, and issue #30 added Codex model pass-through. Without runtime dispatch, flows cannot target Claude or GLM and unknown runtime names silently run with the wrong tool.

## Goals

- Add an agent runtime registry in the local execution layer.
- Resolve `stage.runtime` for every agent stage before execution.
- Keep `runtime: "codex"` behavior compatible with today, including sandbox env handling and `-m <model>` pass-through.
- Add a Claude runtime launcher using the local `claude` CLI by default and requiring `ANTHROPIC_API_KEY`.
- Add a GLM runtime launcher using a local GLM command by default and requiring a GLM/Zhipu credential environment variable.
- Allow runtime command overrides through environment variables so early users can adapt local CLI names without code changes.
- Pass optional `stage.model` through to each runtime's arg builder.
- Fail with clear errors for unknown runtime ids and known runtimes that are not configured.
- Record declared/resolved agent runtime and model information in run evidence.
- Add GLM to `getProviderStatuses()` and the Web Console provider list.
- Document runtime configuration in README.md and README.zh-CN.md.
- Add versioned spec and technical design files for this issue:
  - `specs/issues/042-agent-runtime-registry-spec.md`
  - `docs/plans/2026-06-19-agent-runtime-registry-tech-design.md`

## Non-Goals

- Remote, Docker, or hosted execution backends.
- Automatic runtime selection or provider benchmarking.
- Rewriting prompt rendering.
- Adding SDK dependencies for Claude or GLM in this first version.
- Guaranteeing that every third-party CLI has identical flags forever; use env overrides and tests to keep the registry contract explicit.

## Functional Requirements

### Runtime Registry

- Provide a registry that maps runtime ids to launchers.
- At minimum support `codex`, `claude`, and `glm`.
- Runtime ids should be matched exactly after trimming; unsupported ids must throw an error listing supported runtimes.
- Each launcher must define:
  - command selection,
  - argument construction,
  - prompt delivery method,
  - required environment variables, if any,
  - command/env override behavior where applicable.

### Runtime Launchers

- Codex:
  - Default command: `codex`.
  - Preserve current args from `createCodexExecArgs(worktreePath, model)`.
  - Preserve `NITELY_CODEX_SANDBOX` and legacy `NIGHTLY_CODEX_SANDBOX` behavior.
  - Prompt delivery stays stdin.
- Claude:
  - Default command: `claude`, overridable by `NITELY_CLAUDE_COMMAND`.
  - Require `ANTHROPIC_API_KEY` unless a test/custom registry overrides the runtime.
  - Pass `model` using a documented `--model <model>` style arg.
  - Deliver prompt through stdin unless the registry abstraction explicitly defines a different delivery.
- GLM:
  - Default command may be `glm`, overridable by `NITELY_GLM_COMMAND`.
  - Require one of `NITELY_GLM_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY`.
  - Pass `model` using a documented model arg.
  - Deliver prompt through stdin unless the registry abstraction explicitly defines a different delivery.

### Errors

- Unknown runtime should throw `unsupported agent runtime: <id>` and include supported ids.
- Known runtime missing required environment should throw an actionable error naming the missing env vars.
- Missing executable should produce an actionable error naming the command and runtime.
- Nonzero process exit should mention the runtime id and exit code.

### Evidence

- PR evidence must include a section listing agent stage ids with runtime and model/default model information.
- Evidence should be generated for both publish-change and update-change paths.

### Provider Status

- `getProviderStatuses()` must include GLM.
- GLM status must be configured when one of the GLM credential env vars is set.
- Existing GitHub, Codex, Claude, and Google Drive status behavior must remain compatible.

## Acceptance Criteria

1. `runtime: "codex"` still invokes Codex with the same args as today, including optional `model` as `-m <model>`.
2. `runtime: "claude"` resolves to the Claude launcher, validates `ANTHROPIC_API_KEY`, and passes optional `model` through.
3. `runtime: "glm"` resolves to the GLM launcher, validates GLM/Zhipu credentials, and passes optional `model` through.
4. Unknown runtime ids fail before spawning an unrelated runtime.
5. Known-but-unconfigured runtimes fail with actionable errors.
6. Tests cover registry resolution, command/args/prompt delivery, codex backward compatibility, model pass-through, unknown runtime errors, and missing-env errors.
7. `getProviderStatuses()` reports GLM with meaningful hints.
8. PR evidence includes agent runtime/model information.
9. Existing run flow, resume, Web Console, and provider tests continue to pass.
10. `pnpm exec vitest run`, `pnpm run check`, and `pnpm run build` pass.
