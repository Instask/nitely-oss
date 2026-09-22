# Agent Memory File Generator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate and cache repo-scoped `AGENTS.md`/`CLAUDE.md` memory content, inject it into run worktrees before agent execution, and remove injected files before publishing.

**Architecture:** Add a focused `src/run/knowledge.ts` module for structural fingerprinting, skeleton generation, cache read/write, injection, and cleanup. `runFlow` and `resumeRun` call that module after workspace creation and before any agent stages; publish/update stages clean injected files before any `git add .` path. Runtime launcher tests guard that Claude does not use `--bare`.

**Tech Stack:** TypeScript, Node `fs/promises`, Node `crypto`, existing `EventStore`, Vitest.

---

### Task 1: Fingerprint and Skeleton Cache Module

**Files:**
- Create: `src/run/knowledge.ts`
- Create: `test/run/knowledge.test.ts`

**Step 1: Write failing tests**

Cover:
- fingerprint changes when `package.json` changes;
- fingerprint does not change when a non-structural source file changes;
- `prepareAgentMemory` writes `.nitely/knowledge/agent-memory.json` and `agent-memory.md` on a miss;
- cache hit reuses the prior generated timestamp and content path.

**Step 2: Run tests to verify RED**

Run:

```bash
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm test:run test/run/knowledge.test.ts
```

Expected: fails because `src/run/knowledge.ts` does not exist.

**Step 3: Implement minimal module**

Implement:
- `computeStructuralFingerprint(repoPath)`;
- `generateAgentMemorySkeleton(repoPath)`;
- `prepareAgentMemory({ repoPath, runtime, model, now })`;
- cache layout under `.nitely/knowledge/agent-memory.json` and `agent-memory.md`.

**Step 4: Verify GREEN**

Run the same focused test and confirm PASS.

### Task 2: Injection and Cleanup

**Files:**
- Modify: `src/run/knowledge.ts`
- Modify: `test/run/knowledge.test.ts`

**Step 1: Write failing tests**

Cover:
- `injectAgentMemoryFiles` writes both `AGENTS.md` and `CLAUDE.md` when absent;
- existing user files are not overwritten and are not returned as injected;
- `removeInjectedAgentMemoryFiles` removes only paths it injected.

**Step 2: Run tests to verify RED**

Run focused knowledge tests. Expected: new tests fail because injection helpers do not exist.

**Step 3: Implement helpers**

Add:
- `injectAgentMemoryFiles({ worktreePath, content })`;
- `removeInjectedAgentMemoryFiles(injectedFiles)`.

**Step 4: Verify GREEN**

Run focused knowledge tests.

### Task 3: Wire Run Lifecycle

**Files:**
- Modify: `src/events/types.ts`
- Modify: `src/run/run-flow.ts`
- Modify: `test/run/run-flow.test.ts`

**Step 1: Write failing tests**

Cover:
- a run generates knowledge, emits `knowledge.generated`, and agent execution sees `AGENTS.md`/`CLAUDE.md`;
- a second run with unchanged structure reuses cache and does not append another `knowledge.generated` event;
- injected files are removed before `publish-change` commit/publish;
- a tracked `AGENTS.md` in the repository is preserved.

**Step 2: Run tests to verify RED**

Run:

```bash
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm test:run test/run/run-flow.test.ts -t "agent memory"
```

Expected: fails because run lifecycle does not prepare or inject memory yet.

**Step 3: Implement run wiring**

In fresh `runFlow`:
- after workspace creation, call `prepareAgentMemory` using the first agent/review-gate runtime candidate;
- append `knowledge.generated` only on cache miss;
- inject files and keep returned paths;
- call cleanup before `commitAll` and before `updateChangeRequest`.

In `resumeRun`:
- prepare/inject before resumed stages;
- cleanup before publish/update.

All knowledge failures are caught and ignored so runs continue.

**Step 4: Verify GREEN**

Run the agent memory focused tests.

### Task 4: Claude `--bare` Regression Guard

**Files:**
- Modify: `test/run/execution/local.test.ts`

**Step 1: Write failing/guarding test**

Assert the Claude runtime args do not contain `--bare`.

**Step 2: Run focused test**

Run:

```bash
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm test:run test/run/execution/local.test.ts -t "Claude"
```

Expected: PASS with current launcher, and it will catch future regressions.

### Task 5: Validation and PR Update

**Files:**
- All changed implementation, tests, spec, and plan files.

**Step 1: Run focused tests**

```bash
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm test:run test/run/knowledge.test.ts test/run/run-flow.test.ts test/run/execution/local.test.ts
```

**Step 2: Run full validation**

```bash
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm check
TMPDIR=/private/tmp /Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm test:run
/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm run build
```

**Step 3: Commit and push**

```bash
git status --short
git add docs/plans/2026-06-21-agent-memory-file-generator-tech-design.md specs/issues/087-agent-memory-file-spec.md src/events/types.ts src/run/knowledge.ts src/run/run-flow.ts test/run/knowledge.test.ts test/run/run-flow.test.ts test/run/execution/local.test.ts
git commit -m "feat: generate repo agent memory files"
git push origin worktree-repo-knowledge-cache
```
