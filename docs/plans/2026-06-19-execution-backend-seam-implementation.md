# ExecutionBackend Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract an `ExecutionBackend` seam with a single `LocalExecutionBackend`, and route both `runFlow` and `resumeRun` through it, so a future Docker backend is additive.

**Architecture:** A new `src/run/execution/` module defines the `ExecutionBackend` interface (`types.ts`) and a `LocalExecutionBackend` (`local.ts`) that wraps today's worktree/command/codex/git behavior unchanged. `run-flow.ts` resolves a backend once per run, writes `prompt.md` itself, and calls `backend.{createWorkspace,runCommand,runAgent,commitAll}`. The execution mechanics shared by `runFlow` and `resumeRun` move into two helpers so they exist once. `dependencies.executeAgent` stays as a deprecated shim.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 24 (`node:sqlite`), Vitest, Zod.

**IMPORTANT environment note:** This repo uses `node:sqlite`, which needs Node 24. The user's default is Node 23. Before running tests, activate Node 24:
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
```
Run vitest/tsc via the local binaries (no global pnpm): `node_modules/.bin/vitest`, `node_modules/.bin/tsc`.

---

## File Structure

- Create: `src/run/execution/types.ts` — `ExecutionBackend`, `WorkspaceHandle`, `CommandResult`.
- Create: `src/run/execution/local.ts` — `LocalExecutionBackend`, `createCodexExecArgs` (moved here).
- Create: `test/run/execution/local.test.ts` — unit tests for the local backend.
- Modify: `src/run/run-flow.ts` — resolve a backend, add shared helpers, rewire `runFlow` and `resumeRun`, re-export `createCodexExecArgs`, add `dependencies.backend`.
- Modify: `test/run/run-flow.test.ts` — add a recording-mock-backend test (existing tests untouched).

---

### Task 1: Baseline — confirm tests are green

- [ ] **Step 1: Activate Node 24 and run the full suite**

Run:
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
node_modules/.bin/vitest run
```
Expected: all tests pass (baseline before any change).

---

### Task 2: Define the ExecutionBackend interface

**Files:**
- Create: `src/run/execution/types.ts`

- [ ] **Step 1: Write the interface file**

```ts
import type { Stage } from "../../flow/schema.js";

export interface WorkspaceHandle {
  readonly runId: string;
  // Host-accessible path to the workspace. LocalExecutionBackend always sets
  // this. A future Docker backend may leave it undefined unless bind-mounted.
  readonly path: string | undefined;
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
  commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }>;
  // No-op today (worktrees are kept for human review). Present for Docker later.
  disposeWorkspace?(ws: WorkspaceHandle): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `node_modules/.bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0 (file compiles; no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/run/execution/types.ts
git commit -m "feat: add ExecutionBackend interface (#29)"
```

---

### Task 3: Implement LocalExecutionBackend (TDD)

**Files:**
- Create: `test/run/execution/local.test.ts`
- Create: `src/run/execution/local.ts`

- [ ] **Step 1: Write the failing tests**

`test/run/execution/local.test.ts`:
```ts
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { LocalExecutionBackend, createCodexExecArgs } from "../../../src/run/execution/local.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}
async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-local-be-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("LocalExecutionBackend", () => {
  it("createWorkspace adds a branch and worktree and returns a handle with the path", async () => {
    const repo = await createRepo();
    const worktreePath = join(repo, ".nitely", "runs", "run-1", "worktree");
    const backend = new LocalExecutionBackend();
    const ws = await backend.createWorkspace({
      repoPath: repo,
      branchName: "nitely/run-1",
      runId: "run-1",
      worktreePath,
    });
    expect(ws).toEqual({ runId: "run-1", path: worktreePath });
    await expect(stat(join(worktreePath, "README.md"))).resolves.toBeDefined();
    const { stdout } = await git(worktreePath, ["branch", "--show-current"]);
    expect(stdout.trim()).toBe("nitely/run-1");
  });

  it("runCommand returns captured stdout, stderr, and exit code", async () => {
    const repo = await createRepo();
    const backend = new LocalExecutionBackend();
    const ws = { runId: "run-2", path: repo };
    const ok = await backend.runCommand(ws, "printf hello");
    expect(ok).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
    const bad = await backend.runCommand(ws, "printf oops >&2; exit 3");
    expect(bad.stderr).toBe("oops");
    expect(bad.exitCode).toBe(3);
  });

  it("commitAll commits only when the worktree is dirty", async () => {
    const repo = await createRepo();
    const backend = new LocalExecutionBackend();
    const ws = { runId: "run-3", path: repo };
    expect(await backend.commitAll(ws, "feat: noop")).toEqual({ committed: false });
    await writeFile(join(repo, "feature.txt"), "x\n", "utf8");
    expect(await backend.commitAll(ws, "feat: change")).toEqual({ committed: true });
    const { stdout } = await git(repo, ["status", "--short"]);
    expect(stdout.trim()).toBe("");
  });

  it("createCodexExecArgs includes -m only when a model is given", async () => {
    expect(createCodexExecArgs("/wt")).toEqual([
      "exec", "--sandbox", "danger-full-access", "--cd", "/wt", "-",
    ]);
    expect(createCodexExecArgs("/wt", "gpt-5.3-codex-spark")).toContain("-m");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run test/run/execution/local.test.ts`
Expected: FAIL — cannot resolve `../../../src/run/execution/local.js`.

- [ ] **Step 3: Implement `src/run/execution/local.ts`**

```ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { Stage } from "../../flow/schema.js";
import type {
  CommandResult,
  ExecutionBackend,
  WorkspaceHandle,
} from "./types.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function requirePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("LocalExecutionBackend requires a host workspace path");
  }
  return ws.path;
}

export function createCodexExecArgs(
  worktreePath: string,
  model?: string,
): string[] {
  return [
    "exec",
    "--sandbox",
    process.env.NITELY_CODEX_SANDBOX ??
      process.env.NIGHTLY_CODEX_SANDBOX ??
      "danger-full-access",
    ...(model ? ["-m", model] : []),
    "--cd",
    worktreePath,
    "-",
  ];
}

export class LocalExecutionBackend implements ExecutionBackend {
  async createWorkspace(input: {
    repoPath: string;
    branchName: string;
    runId: string;
    worktreePath: string;
  }): Promise<WorkspaceHandle> {
    await runGit(input.repoPath, [
      "worktree",
      "add",
      "-b",
      input.branchName,
      input.worktreePath,
      "HEAD",
    ]);
    return { runId: input.runId, path: input.worktreePath };
  }

  async runCommand(
    ws: WorkspaceHandle,
    command: string,
  ): Promise<CommandResult> {
    const cwd = requirePath(ws);
    return await new Promise((resolvePromise, reject) => {
      const child = spawn("sh", ["-lc", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
    });
  }

  async runAgent(
    ws: WorkspaceHandle,
    input: { stage: Extract<Stage, { type: "agent" }>; prompt: string },
  ): Promise<void> {
    const cwd = requirePath(ws);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("codex", createCodexExecArgs(cwd, input.stage.model), {
        cwd,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.end(input.prompt);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`codex exited with code ${code}`));
        }
      });
    });
  }

  async commitAll(
    ws: WorkspaceHandle,
    message: string,
  ): Promise<{ committed: boolean }> {
    const cwd = requirePath(ws);
    await runGit(cwd, ["add", "."]);
    const status = await runGit(cwd, ["status", "--short"]);
    if (status.trim().length === 0) {
      return { committed: false };
    }
    await runGit(cwd, ["commit", "-m", message]);
    return { committed: true };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run test/run/execution/local.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/run/execution/local.ts test/run/execution/local.test.ts
git commit -m "feat: add LocalExecutionBackend (#29)"
```

---

### Task 4: Wire runFlow through the backend (with shared helpers + executeAgent shim)

**Files:**
- Modify: `src/run/run-flow.ts`

Context — current touchpoints in `runFlow`:
- Fresh-run worktree add: the `else` branch at ~`src/run/run-flow.ts:624-633`.
- Agent execution: ~`688-693` (`dependencies.executeAgent ?? defaultExecuteAgent`).
- Command execution: ~`706` (`runShellCommand`).
- Pre-publish git add/commit: ~`903-911`.
`defaultExecuteAgent`, `runShellCommand`, and `createCodexExecArgs` currently live in this file.

- [ ] **Step 1: Add imports and a deprecated `backend` dependency**

At the top of `src/run/run-flow.ts`, add:
```ts
import { LocalExecutionBackend } from "./execution/local.js";
import type {
  CommandResult,
  ExecutionBackend,
  WorkspaceHandle,
} from "./execution/types.js";
```
Re-export `createCodexExecArgs` for backward compatibility (existing `run-flow.test.ts` imports it from here):
```ts
export { createCodexExecArgs } from "./execution/local.js";
```
In the `RunFlowDependencies` interface (~`src/run/run-flow.ts:84`), add (keep `executeAgent` and mark it deprecated):
```ts
  backend?: ExecutionBackend;
  /** @deprecated Provide `backend` instead. Honored only when `backend` is unset. */
  executeAgent?: (input: AgentExecutionInput) => Promise<void>;
```

- [ ] **Step 2: Delete the now-moved functions and add helpers**

Remove the local `runShellCommand`, `defaultExecuteAgent`, and `createCodexExecArgs` definitions (now in `execution/local.ts`; `createCodexExecArgs` is re-exported). Keep `runGit` (still used for rework checkout etc.). Add these helpers near the other module-level functions:

```ts
function resolveBackend(dependencies: RunFlowDependencies): ExecutionBackend {
  return dependencies.backend ?? new LocalExecutionBackend();
}

function requireWorkspacePath(ws: WorkspaceHandle): string {
  if (!ws.path) {
    throw new Error("workspace has no host-accessible path");
  }
  return ws.path;
}

async function runAgentInWorkspace(input: {
  backend: ExecutionBackend;
  dependencies: RunFlowDependencies;
  workspace: WorkspaceHandle;
  stage: Extract<Stage, { type: "agent" }>;
  prompt: string;
  attemptDirectory: string;
}): Promise<void> {
  await writeFile(join(input.attemptDirectory, "prompt.md"), input.prompt);
  // Deprecated shim: a directly-injected executeAgent wins only when no
  // explicit backend was supplied, preserving existing test behavior.
  if (!input.dependencies.backend && input.dependencies.executeAgent) {
    await input.dependencies.executeAgent({
      stage: input.stage,
      prompt: input.prompt,
      worktreePath: requireWorkspacePath(input.workspace),
      attemptDirectory: input.attemptDirectory,
    });
    return;
  }
  await input.backend.runAgent(input.workspace, {
    stage: input.stage,
    prompt: input.prompt,
  });
}

async function runCommandInWorkspace(input: {
  backend: ExecutionBackend;
  workspace: WorkspaceHandle;
  command: string;
  attemptDirectory: string;
}): Promise<{
  result: CommandResult;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
}> {
  const result = await input.backend.runCommand(
    input.workspace,
    input.command,
  );
  const paths = await writeCommandAttemptFiles({
    attemptDirectory: input.attemptDirectory,
    command: input.command,
    result,
  });
  return { result, ...paths };
}
```

- [ ] **Step 3: Create the workspace via the backend in `runFlow`**

Add `const backend = resolveBackend(dependencies);` near the top of `runFlow` (after `repoPath`/`runId` are set). Replace the fresh-run `else` branch (`await runGit(repoPath, ["worktree","add",...])` at ~624-633) and capture a handle for both branches:

```ts
  let workspace: WorkspaceHandle;
  if (reworkTarget && reworkProvider) {
    // ... existing checkoutChangeRequest block stays unchanged ...
    workspace = { runId, path: worktreePath };
  } else {
    workspace = await backend.createWorkspace({
      repoPath,
      branchName,
      runId,
      worktreePath,
    });
  }
```
(Keep the existing `worktreePath` variable; for Local, `workspace.path === worktreePath`. Publish/evidence/result keep using `worktreePath`.)

- [ ] **Step 4: Route agent + command execution through the helpers**

Replace the agent block (~681-693) body that calls `dependencies.executeAgent ?? defaultExecuteAgent` with:
```ts
              await runAgentInWorkspace({
                backend,
                dependencies,
                workspace,
                stage,
                prompt,
                attemptDirectory,
              });
```
Replace the command block (~706-712) `runShellCommand` + `writeCommandAttemptFiles` with:
```ts
            const { result, stdoutPath, stderrPath, outputPath } =
              await runCommandInWorkspace({
                backend,
                workspace,
                command: stage.command,
                attemptDirectory,
              });
```
(Leave the surrounding `command.completed` event emission and exit-code handling exactly as-is.)

- [ ] **Step 5: Route pre-publish commit through the backend**

Replace the publish-stage git block (~903-911):
```ts
          await runGit(worktreePath, ["add", "."]);
          const status = await runGit(worktreePath, ["status", "--short"]);
          if (status.trim().length > 0) {
            await runGit(worktreePath, ["commit", "-m", `feat: ${loaded.flow.metadata.name}`]);
          }
```
with:
```ts
          await backend.commitAll(workspace, `feat: ${loaded.flow.metadata.name}`);
```

- [ ] **Step 6: Typecheck and run the suite**

Run:
```bash
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/vitest run
```
Expected: typecheck exit 0; all existing tests pass (executeAgent shim keeps them green).

- [ ] **Step 7: Commit**

```bash
git add src/run/run-flow.ts
git commit -m "refactor: route runFlow execution through ExecutionBackend (#29)"
```

---

### Task 5: Wire resumeRun through the backend

**Files:**
- Modify: `src/run/run-flow.ts`

Context — `resumeRun` (~`src/run/run-flow.ts:1213`) reuses the existing worktree from the projection (`worktreePath` at ~1245) and duplicates the same execution: agent (~1314), command (~1333), git add/commit (~1370-1378).

- [ ] **Step 1: Resolve the backend and reconstruct a handle**

Near the top of `resumeRun`, after `worktreePath` is known, add:
```ts
  const backend = resolveBackend(dependencies);
  const workspace: WorkspaceHandle = { runId, path: worktreePath };
```

- [ ] **Step 2: Route agent + command + commit through the helpers**

Replace the `resumeRun` agent call (`dependencies.executeAgent ?? defaultExecuteAgent`, ~1314) with the same `runAgentInWorkspace({ backend, dependencies, workspace, stage, prompt, attemptDirectory })` call used in `runFlow`.

Replace the `resumeRun` command call (`runShellCommand` + `writeCommandAttemptFiles`, ~1333) with the same `runCommandInWorkspace({ backend, workspace, command: stage.command, attemptDirectory })` destructuring used in `runFlow`.

Replace the `resumeRun` pre-publish git add/status/commit (~1370-1378) with:
```ts
          await backend.commitAll(workspace, `feat: ${loaded.flow.metadata.name}`);
```

- [ ] **Step 3: Typecheck and run the suite**

Run:
```bash
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/vitest run
```
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/run/run-flow.ts
git commit -m "refactor: route resumeRun execution through ExecutionBackend (#29)"
```

---

### Task 6: Prove the backend seam is honored by both paths (TDD)

**Files:**
- Modify: `test/run/run-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("runFlow", ...)` block in `test/run/run-flow.test.ts`. It uses a recording backend and asserts `runFlow` routes workspace/agent/command/commit through it. (Imports `runFlow`, `git`, `createRepo`, `writeJson` already exist in this file; add the type import for `ExecutionBackend` if not present.)

```ts
  it("routes execution through a supplied backend", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs", "change.md"), "Create feature.txt", "utf8");
    const flowPath = join(repo, "flows", "backend.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "backend-flow" },
      spec: {
        stages: [
          { id: "implement", type: "agent", runtime: "codex", prompt: "go", inputs: ["spec"], outputs: ["implementation"] },
          { id: "test", type: "command", command: "true", inputs: ["implementation"], outputs: ["test-report"] },
        ],
      },
    });

    const calls: string[] = [];
    const backend = {
      async createWorkspace(input: { worktreePath: string; runId: string }) {
        calls.push("createWorkspace");
        await git(repo, ["worktree", "add", "-b", "nitely/be", input.worktreePath, "HEAD"]);
        return { runId: input.runId, path: input.worktreePath };
      },
      async runAgent() { calls.push("runAgent"); },
      async runCommand() { calls.push("runCommand"); return { stdout: "", stderr: "", exitCode: 0 }; },
      async commitAll() { calls.push("commitAll"); return { committed: false }; },
    };

    await runFlow(
      { flowPath, repoPath: repo, inputs: { spec: { connector: "local-file", uri: "specs/change.md" } } },
      { createRunId: () => "be", backend },
    );

    expect(calls).toEqual(["createWorkspace", "runAgent", "runCommand"]);
  });
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node_modules/.bin/vitest run test/run/run-flow.test.ts -t "routes execution through a supplied backend"`
Expected: PASS. (If the `backend` object needs a type, annotate it `satisfies ExecutionBackend` with the import from `../../src/run/execution/types.js`.)

- [ ] **Step 3: Add a resume variant assertion (optional but recommended)**

If time permits, extend the test (or add a sibling) that interrupts a run and calls `resumeRun(..., { backend })`, asserting the recording backend's `runCommand`/`runAgent` is invoked on resume. Reuse the interruption setup from the existing "resumes an interrupted stage" test as a template (do not modify that test).

- [ ] **Step 4: Commit**

```bash
git add test/run/run-flow.test.ts
git commit -m "test: verify ExecutionBackend is honored by runFlow and resumeRun (#29)"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run tests, typecheck, build on Node 24**

Run:
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
node_modules/.bin/vitest run
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p tsconfig.build.json
```
Expected: all tests pass; typecheck exit 0; build exit 0.

- [ ] **Step 2: Sanity-check the seam**

Run: `grep -n "spawn(\"sh\"\|spawn(\"codex\"\|worktree\", \"add\"\|\"commit\", \"-m\"" src/run/run-flow.ts`
Expected: no matches in `run-flow.ts` stage-execution paths (these now live in `execution/local.ts`). `runGit` may still appear for rework checkout — that is in scope to keep.

---

## Self-Review Notes

- **Spec AC1** → Tasks 2, 3 (types + LocalExecutionBackend).
- **Spec AC2** → Tasks 4, 5 (workspace/command/agent/commit via backend; rework checkout left as-is) + Task 7 Step 2 grep.
- **Spec AC3** → Task 6 (recording mock honored by runFlow; resume variant).
- **Spec AC4** → Tasks 4–5 keep `executeAgent` shim; Task 1/4/5/7 confirm existing tests stay green.
- **Spec AC5** → Task 3 tests (createWorkspace/runCommand/commitAll).
- **Spec AC6** → `createCodexExecArgs` moved to `local.ts`, re-exported from `run-flow.ts`; covered by Task 3 tests and the existing `run-flow.test.ts` cases (unchanged via re-export).
- **Spec AC7** → Task 7.
- **Type consistency:** helper names `runAgentInWorkspace`, `runCommandInWorkspace`, `resolveBackend`, `requireWorkspacePath`; interface methods `createWorkspace`/`runCommand`/`runAgent`/`commitAll`/`disposeWorkspace` used consistently across tasks.
