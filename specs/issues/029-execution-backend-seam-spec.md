# Issue #29 Specification: Extract an ExecutionBackend seam

GitHub issue: https://github.com/Instask/nitely/issues/29

## Objective

Carve a clean `ExecutionBackend` seam with a single `LocalExecutionBackend`, so a
future `DockerExecutionBackend` becomes an additive drop-in rather than a rewrite.
This issue does **not** implement Docker. It removes the hard-coded "where work
physically runs" decisions from the orchestrator and routes both `runFlow` and
`resumeRun` through one backend interface, eliminating the duplicated execution
mechanics that currently live in both functions.

## Current State

`src/run/run-flow.ts` (1591 lines) inlines and duplicates execution:

- Workspace creation: `git worktree add -b <branch> <worktree> HEAD` in `runFlow`.
  `resumeRun` reuses the existing worktree from the run projection.
- Command execution: `runShellCommand` → `spawn("sh", ["-lc", cmd], { cwd })` at
  two call sites (`runFlow`, `resumeRun`).
- Agent execution: `defaultExecuteAgent` → `spawn("codex", …, { cwd })`, already
  injectable via `dependencies.executeAgent`, at two call sites.
- In-workspace git: `git add .` / `git status --short` / `git commit` before
  publish, at two call sites.
- Codex sandbox flag: `--sandbox danger-full-access` (env-overridable) built in
  `createCodexExecArgs`.

The asymmetry — agent execution is injectable but command and workspace are
hard-coded — and the run/resume duplication are what this seam resolves.

## Guiding Principle

The backend returns bytes (stdout/stderr/exit code) and performs in-workspace
side effects; the orchestrator owns persistence and event emission (attempt
directories, `stdout.log`/`stderr.log`/`output.md`, `prompt.md`, `run.json`,
the event store, evidence rendering, flow-graph traversal, and retry/rework
policy). This keeps the interface small and lets a future Docker backend run
commands in-container while logs still land in host-side `.nitely/runs/...`.

## Interface (`src/run/execution/types.ts`)

```ts
export interface WorkspaceHandle {
  readonly runId: string;
  readonly path: string | undefined; // host-accessible path; Local always sets it
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecutionBackend {
  createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
  }): Promise<WorkspaceHandle>;
  runCommand(ws: WorkspaceHandle, command: string): Promise<CommandResult>;
  runAgent(
    ws: WorkspaceHandle,
    input: { stage: Extract<Stage, { type: "agent" }>; prompt: string },
  ): Promise<void>;
  commitAll(ws: WorkspaceHandle, message: string): Promise<{ committed: boolean }>;
  disposeWorkspace?(ws: WorkspaceHandle): Promise<void>; // no-op today
}
```

### Interface decisions

- **`commitAll` is a first-class method** rather than a raw `runCommand` string.
  The "commit only when `git status` is dirty" logic is in-workspace git that
  must run where the worktree lives, so it belongs in the backend. It returns
  `{ committed }` so the orchestrator can still emit events.
- **`runAgent` returns `void`** and streams stdio live (unchanged behavior). This
  is the one exception to "backend returns bytes," because agent output streams
  to the console and is not captured. The **orchestrator** writes `prompt.md` into
  the attempt directory before calling `runAgent`; the backend only executes.
- **`createWorkspace` receives the orchestrator-chosen `worktreePath`**
  (`<runDirectory>/worktree`), because the orchestrator owns run-directory layout.
- **`WorkspaceHandle.path` is `string | undefined`.** `LocalExecutionBackend`
  always sets it. Documented as possibly undefined for a future Docker backend
  unless bind-mounted, which is why publish (which needs a host worktree path)
  reads `ws.path`.

## LocalExecutionBackend (`src/run/execution/local.ts`)

Wraps the existing logic with no behavior change:

- `createWorkspace` → `git worktree add -b <branchName> <worktreePath> HEAD`,
  returns `{ runId, path: worktreePath }`.
- `runCommand` → `spawn("sh", ["-lc", command], { cwd: ws.path })`, returns
  captured stdout/stderr/exit code.
- `runAgent` → `spawn("codex", createCodexExecArgs(ws.path, stage.model), …)`
  with the prompt on stdin and inherited stdout/stderr (unchanged).
- `commitAll` → `git add .`; if `git status --short` is non-empty, `git commit -m
  <message>` and return `{ committed: true }`, else `{ committed: false }`.
- The codex `--sandbox` flag and the `NITELY_CODEX_SANDBOX` / `NIGHTLY_CODEX_SANDBOX`
  env overrides belong to this backend (in Docker the container is the sandbox).
- `createCodexExecArgs` moves into this file; its existing tests move with it.

## Orchestrator Changes (`src/run/run-flow.ts`)

- Resolve a backend once in each of `runFlow` and `resumeRun`:
  `const backend = resolveBackend(dependencies)`.
- `runFlow`: replace inline `git worktree add` with `backend.createWorkspace`;
  `runShellCommand` with `backend.runCommand`; the `executeAgent` call with
  `backend.runAgent` (orchestrator writes `prompt.md` first); `git add/commit`
  with `backend.commitAll`.
- `resumeRun`: reconstruct a `WorkspaceHandle` from the projected worktree path
  (no `createWorkspace`) and route the same `backend.*` calls.
- Extract small shared helpers (e.g. `executeCommandStage`, `executeAgentStage`)
  used by both paths so the execution mechanics — including attempt-file
  persistence and event emission — exist once. The two top-level loops in
  `runFlow` and `resumeRun` are **not** merged (out of scope, higher risk).

## Backward Compatibility

- Add `dependencies.backend?: ExecutionBackend`.
- Keep `dependencies.executeAgent` as a **deprecated shim**: when `executeAgent`
  is provided and `backend` is not, `resolveBackend` returns a
  `LocalExecutionBackend` whose `runAgent` delegates to `executeAgent`. All
  existing tests that pass `executeAgent` stay green untouched.
- `AgentExecutionInput` and `createCodexExecArgs` remain exported (the latter
  re-exported from its new home if needed) to avoid breaking external callers and
  tests.

## Non-Goals

- Implementing the Docker backend (separate, later issue).
- Cloudflare Workers (architectural mismatch).
- Multi-tenant / shared-server execution.
- Merging the `runFlow` and `resumeRun` top-level loops.

## Acceptance Criteria

1. `src/run/execution/types.ts` defines `ExecutionBackend`, `WorkspaceHandle`,
   and `CommandResult`; `src/run/execution/local.ts` provides
   `LocalExecutionBackend`.
2. For fresh-run workspace creation and stage execution, `runFlow` and
   `resumeRun` go through `backend.*`: no direct `spawn` for commands/agents,
   no inline fresh-run `git worktree add`, and no inline pre-publish
   `git add|commit` remains in the orchestrator's stage logic. SCM/rework
   operations (e.g. the rework PR-branch checkout in `checkoutChangeRequest`,
   push via `ScmProvider`) are out of scope and stay as-is.
3. A custom `dependencies.backend` is honored by **both** `runFlow` and
   `resumeRun` (verified by a recording mock backend).
4. Existing behavior is unchanged: all current `run-flow.test.ts` tests pass with
   no modification, via the `executeAgent` shim.
5. `LocalExecutionBackend` has direct unit tests: `createWorkspace` creates the
   branch and worktree; `runCommand` returns correct stdout/stderr/exit code;
   `commitAll` commits only when the worktree is dirty.
6. `createCodexExecArgs` behavior (with/without model, sandbox env overrides) is
   preserved and still covered by tests in its new location.
7. `vitest run`, `tsc --noEmit`, and the build all pass on Node 24.
