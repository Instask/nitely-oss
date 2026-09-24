# Technical Design: Agent Runtime Registry

## Overview

Implement runtime dispatch inside `src/run/execution/local.ts`, because the `ExecutionBackend` seam already concentrates local process execution there. Keep the public flow schema unchanged: `agent` stages already carry `runtime` and optional `model`.

The implementation should be small and testable: extract pure arg/env resolution helpers, inject spawn/env/registry for tests, and keep Codex behavior byte-for-byte compatible where possible.

## Proposed Files

- Add or modify: `src/run/execution/local.ts`
- Optionally add: `src/run/execution/runtimes.ts` if separation keeps tests cleaner.
- Modify: `src/run/execution/types.ts` only if needed for typed runtime metadata.
- Modify: `src/run/run-flow.ts` for evidence runtime/model sections.
- Modify: `src/web/providers.ts` for GLM provider status.
- Modify tests:
  - `test/run/execution/local.test.ts`
  - `test/run/run-flow.test.ts`
  - `test/web/providers.test.ts`
- Modify docs:
  - `README.md`
  - `README.zh-CN.md`
- Add docs generated from this issue:
  - `specs/issues/042-agent-runtime-registry-spec.md`
  - `docs/plans/2026-06-19-agent-runtime-registry-tech-design.md`

## Runtime Types

Define a runtime launcher shape similar to:

```ts
export interface AgentRuntimeLaunchInput {
  worktreePath: string;
  model?: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface AgentRuntimeLaunchSpec {
  runtime: string;
  command: string;
  args: string[];
  promptDelivery: "stdin" | "arg";
  env?: NodeJS.ProcessEnv;
}

export interface AgentRuntimeLauncher {
  id: string;
  requiredEnv?: string[] | string[][];
  build(input: AgentRuntimeLaunchInput): AgentRuntimeLaunchSpec;
}
```

For env requirements, support alternatives for GLM (`NITELY_GLM_API_KEY` OR `GLM_API_KEY` OR `ZHIPUAI_API_KEY`). A helper like `assertRuntimeConfigured(runtime, env)` can keep errors consistent.

## Default Runtimes

### Codex

Reuse the existing helper:

```ts
createCodexExecArgs(worktreePath, model)
```

Keep this helper exported for existing tests. Codex command should remain `codex`, with optional `NITELY_CODEX_COMMAND` only if it does not break current behavior. Do not remove `NITELY_CODEX_SANDBOX` / `NIGHTLY_CODEX_SANDBOX`.

### Claude

Use a default local CLI launcher:

```txt
command: env.NITELY_CLAUDE_COMMAND ?? "claude"
args: ["-p", ...(model ? ["--model", model] : [])]
promptDelivery: "stdin"
required env: ANTHROPIC_API_KEY
```

If the code chooses prompt-as-arg instead, tests must verify that explicitly. Prefer stdin for long prompts.

### GLM

Use a default local CLI launcher:

```txt
command: env.NITELY_GLM_COMMAND ?? "glm"
args: ["chat", ...(model ? ["--model", model] : [])]
promptDelivery: "stdin"
required env: one of NITELY_GLM_API_KEY, GLM_API_KEY, ZHIPUAI_API_KEY
```

This keeps first-version support dependency-free and lets users adapt real local commands via env overrides.

## LocalExecutionBackend Changes

Add an options object:

```ts
export interface LocalExecutionBackendOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  runtimeRegistry?: AgentRuntimeRegistry;
  spawn?: typeof spawn;
}
```

`runAgent` should:

1. Resolve the workspace path.
2. Resolve `stage.runtime` through the registry.
3. Validate required env before spawning.
4. Build command/args with `stage.model`.
5. Spawn the resolved command.
6. Deliver prompt according to `promptDelivery`.
7. Convert spawn `ENOENT` into a clear runtime configuration error.
8. Convert nonzero exit into `<runtime> exited with code <n>`.

## Evidence Changes

Extend `writeEvidence()` to accept the loaded stages or a precomputed list of agent runtime entries. Add a section:

```md
## Agent Runtimes

- implement: runtime codex, model default
- review: runtime claude, model claude-sonnet-4-5
```

Include this section for both publish and update evidence. Use declared `stage.runtime` plus `stage.model ?? "default"`; that is the resolved runtime contract for this first version.

## Provider Status Changes

Extend `ProviderStatus.id` union with `glm` and add a GLM row:

- name: `GLM / Zhipu`
- configured: any of `NITELY_GLM_API_KEY`, `GLM_API_KEY`, `ZHIPUAI_API_KEY`
- hints include all credential env vars and `NITELY_GLM_COMMAND`

Keep existing Anthropic status unchanged, but update the message if runtime support is now implemented rather than future-tense.

## Tests

### Runtime Registry / Local Execution

In `test/run/execution/local.test.ts`:

- Assert `createCodexExecArgs()` remains unchanged for default and model cases.
- Add tests for default registry resolving `codex`, `claude`, `glm`.
- Add tests for unknown runtime error.
- Add tests for missing Claude/GLM env errors.
- Use injected fake spawn to verify:
  - codex command/args/stdin prompt,
  - claude command/model args/stdin prompt,
  - glm command/model args/stdin prompt,
  - custom env command overrides.

### Evidence

In `test/run/run-flow.test.ts`, add or extend a publish/update test to assert evidence contains `## Agent Runtimes` and stage runtime/model lines.

### Provider Status

In `test/web/providers.test.ts`, assert GLM appears and is configured when a GLM env var is present.

## Verification

Run:

```bash
pnpm exec vitest run test/run/execution/local.test.ts test/run/run-flow.test.ts test/web/providers.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```

## Review Checklist

- No flow schema breaking changes.
- `codex` runtime remains backward compatible.
- Unknown runtime cannot silently run Codex.
- Missing runtime credentials fail with clear messages.
- Prompt delivery is tested and does not drop prompts.
- Evidence includes runtime/model for audit.
- Provider list includes GLM without regressing existing provider statuses.
