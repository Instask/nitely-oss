# Nitely Bootstrap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local TypeScript CLI that validates artifact-driven flows, executes stages in an isolated Git worktree, persists events in SQLite, retries failed stages, and opens a draft PR for Nitely's own changes.

**Architecture:** Use one Node.js process with strict internal adapters for agent runtimes, workspaces, gates, and SCM. Store durable state as append-only events in built-in `node:sqlite`; keep logs and immutable artifacts under `.nitely/runs`. Build the vertical slice with a mock runtime first, then replace it with a Codex CLI adapter.

**Tech Stack:** Node.js 24, TypeScript, npm, `node:sqlite`, `node:child_process`, `node:util.parseArgs`, Zod, YAML, Vitest.

---

## Constraints

- Use TDD for every behavior.
- Keep execution sequential.
- Use Git worktrees, not directory copies, for repository isolation.
- Do not add a Web UI, HTTP server, authentication, Docker, Redis, or PostgreSQL.
- Do not add Claude or Pi until the Codex bootstrap flow works.
- Do not automatically merge a PR.
- Do not run agents in the checkout containing the currently executing Nitely process.

### Task 1: Initialize the TypeScript CLI project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Create: `test/cli.test.ts`

**Step 1: Initialize Git**

Run:

```bash
git init
```

Expected: an empty Git repository is created in the Nitely directory.

**Step 2: Write the failing CLI smoke test**

```ts
// test/cli.test.ts
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli", () => {
  it("prints help when no command is provided", async () => {
    const lines: string[] = [];
    const code = await runCli([], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nitely");
    expect(lines.join("\n")).toContain("validate");
  });
});
```

**Step 3: Run the test and verify it fails**

Run:

```bash
npm test -- --run test/cli.test.ts
```

Expected: FAIL because the project and `runCli` do not exist.

**Step 4: Add project configuration**

Use these scripts and dependencies:

```json
{
  "name": "nitely",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "nitely": "./dist/index.js"
  },
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "dev": "tsx src/index.ts",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "yaml": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

Configure TypeScript for NodeNext modules, strict mode, `src` as root, and `dist` as output.

**Step 5: Implement the minimal CLI**

```ts
// src/cli.ts
export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const HELP = `nitely

Commands:
  validate <flow>
  run <flow> --repo <path>
  status <run-id>
  logs <run-id>
  resume <run-id>
  cancel <run-id>`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    io.stdout(HELP);
    return 0;
  }

  io.stderr(`Unknown command: ${argv[0]}`);
  return 1;
}
```

```ts
// src/index.ts
#!/usr/bin/env node
import { runCli } from "./cli.js";

const code = await runCli(process.argv.slice(2), {
  stdout: console.log,
  stderr: console.error,
});
process.exitCode = code;
```

**Step 6: Install dependencies and run checks**

Run:

```bash
npm install
npm test -- --run test/cli.test.ts
npm run check
npm run build
```

Expected: all commands pass.

**Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test
git commit -m "chore: initialize nitely typescript cli"
```

### Task 2: Define and validate the flow schema

**Files:**
- Create: `src/flow/schema.ts`
- Create: `src/flow/load.ts`
- Create: `test/flow/load.test.ts`
- Create: `test/fixtures/valid-flow.yaml`
- Create: `test/fixtures/invalid-flow.yaml`
- Modify: `src/cli.ts`

**Step 1: Write failing schema tests**

Cover:

- A valid `nitely.dev/v1alpha1` flow loads.
- Duplicate stage IDs fail.
- Duplicate artifact producers fail.
- Unknown consumed artifacts fail unless supplied as external inputs.
- A cycle derived from artifacts fails.
- An agent stage requires `runtime`, `prompt`, and at least one output.
- A command stage requires `command`.

Use this public API:

```ts
const result = await loadFlow(path);
expect(result.flow.metadata.name).toBe("implement-spec");
expect(result.graph.order).toEqual(["implement", "test"]);
```

**Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run test/flow/load.test.ts
```

Expected: FAIL because `loadFlow` does not exist.

**Step 3: Implement the Zod schema**

Define discriminated stage types:

```ts
type AgentStage = {
  id: string;
  type: "agent";
  runtime: string;
  prompt: string;
  inputs: string[];
  outputs: string[];
  maxAttempts?: number;
};

type CommandStage = {
  id: string;
  type: "command";
  command: string;
  inputs: string[];
  outputs: string[];
  timeoutMs?: number;
  maxAttempts?: number;
};

type ApprovalStage = {
  id: string;
  type: "approval";
  prompt: string;
  inputs: string[];
  outputs: string[];
};

type PublishChangeStage = {
  id: string;
  type: "publish-change";
  provider?: "github" | "gitlab";
  inputs: string[];
  outputs: string[];
};
```

Keep `inputs` and `outputs` explicit in every stage. Treat CLI `--input` names as external artifact producers.

**Step 4: Implement graph derivation**

Build:

```ts
interface FlowGraph {
  predecessors: Map<string, Set<string>>;
  successors: Map<string, Set<string>>;
  producerByArtifact: Map<string, string>;
  order: string[];
}
```

Use Kahn's algorithm for topological ordering. Return readable validation errors rather than throwing the first error.

**Step 5: Add `nitely validate`**

Expected output:

```text
VALID implement-spec: 2 stages, 3 artifacts
```

Invalid flow output must list every detected error and return exit code `1`.

**Step 6: Run tests**

Run:

```bash
npm test -- --run test/flow/load.test.ts test/cli.test.ts
npm run check
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/flow src/cli.ts test/flow test/fixtures
git commit -m "feat: validate artifact-driven flow definitions"
```

### Task 3: Add the append-only SQLite event store

**Files:**
- Create: `src/events/types.ts`
- Create: `src/events/store.ts`
- Create: `test/events/store.test.ts`

**Step 1: Write failing event store tests**

Test:

- Events receive increasing sequence numbers.
- Events can be filtered by run.
- Payloads round-trip through JSON.
- Reopening the database preserves events.
- Event types are strongly typed at compile time.

Example:

```ts
store.append({
  runId: "run-1",
  type: "run.created",
  payload: { flowName: "self-improve" },
});

expect(store.list("run-1")).toEqual([
  expect.objectContaining({ sequence: 1, type: "run.created" }),
]);
```

**Step 2: Run and verify failure**

Run:

```bash
npm test -- --run test/events/store.test.ts
```

Expected: FAIL because the event store does not exist.

**Step 3: Implement with built-in `node:sqlite`**

Create a `STRICT` table:

```sql
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  attempt INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

Enable WAL for file databases:

```sql
PRAGMA journal_mode = WAL;
```

Expose:

```ts
append(event: NewRunEvent): StoredRunEvent;
list(runId: string): StoredRunEvent[];
latest(runId: string): StoredRunEvent | undefined;
close(): void;
```

**Step 4: Run tests**

Run:

```bash
npm test -- --run test/events/store.test.ts
npm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/events test/events
git commit -m "feat: persist run events in sqlite"
```

### Task 4: Create isolated Git workspaces

**Files:**
- Create: `src/process/run.ts`
- Create: `src/workspace/git-worktree.ts`
- Create: `test/workspace/git-worktree.test.ts`

**Step 1: Write failing workspace tests**

Create a temporary Git repository in the test. Verify:

- The provider rejects a path that is not a Git repository.
- It creates `.nitely/runs/<run-id>/worktree`.
- It creates a unique `nitely/<run-id>` branch.
- A file changed in the worktree does not change the source checkout.
- Cleanup removes the registered worktree.

**Step 2: Run and verify failure**

Run:

```bash
npm test -- --run test/workspace/git-worktree.test.ts
```

Expected: FAIL because `GitWorktreeProvider` does not exist.

**Step 3: Implement a bounded child-process helper**

`runProcess` must:

- Accept command, args, cwd, environment, timeout, and abort signal.
- Capture stdout/stderr with a configurable byte limit.
- Kill the full child process group on timeout or cancellation.
- Return exit code and captured output.
- Never use `shell: true`.

**Step 4: Implement the worktree provider**

Use:

```bash
git rev-parse --show-toplevel
git worktree add -b nitely/<run-id> <run-dir>/worktree <base-ref>
git worktree remove --force <run-dir>/worktree
git branch -D nitely/<run-id>
```

Write workspace metadata to:

```text
.nitely/runs/<run-id>/workspace.json
```

Do not delete a worktree automatically after a failed run.

**Step 5: Run tests**

Run:

```bash
npm test -- --run test/workspace/git-worktree.test.ts
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/process src/workspace test/workspace
git commit -m "feat: isolate runs with git worktrees"
```

### Task 5: Define normalized agent events and a mock runtime

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/registry.ts`
- Create: `src/agents/mock.ts`
- Create: `test/agents/mock.test.ts`

**Step 1: Write failing runtime tests**

Verify that:

- A runtime returns an async event stream.
- The mock runtime writes configured files inside the worktree.
- It writes valid `output.md` and `artifacts.json`.
- It can fail the first N attempts for retry tests.
- It cannot write outside its provided working directory.

Normalize these events:

```ts
type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; tool: string; input?: unknown }
  | { type: "tool.completed"; tool: string; ok: boolean; output?: string }
  | { type: "session.completed"; sessionId: string }
  | { type: "session.failed"; sessionId: string; error: string };
```

**Step 2: Run and verify failure**

Run:

```bash
npm test -- --run test/agents/mock.test.ts
```

Expected: FAIL.

**Step 3: Implement the runtime registry**

The scheduler must resolve a runtime by name:

```ts
registry.register("mock", mockRuntime);
registry.get("mock");
```

Unknown runtimes produce a clear configuration error before execution starts.

**Step 4: Implement the mock runtime**

Allow flow fixtures to provide test-only mock behavior:

```yaml
mock:
  failAttempts: 1
  writeFiles:
    greeting.txt: hello
```

Keep mock configuration out of the production stage schema by injecting it directly in tests or through a test-only extension field.

**Step 5: Run tests**

Run:

```bash
npm test -- --run test/agents/mock.test.ts
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/agents test/agents
git commit -m "feat: add normalized agent runtime protocol"
```

### Task 6: Add artifact publication and bounded context assembly

**Files:**
- Create: `src/artifacts/schema.ts`
- Create: `src/artifacts/store.ts`
- Create: `src/context/assemble.ts`
- Create: `test/artifacts/store.test.ts`
- Create: `test/context/assemble.test.ts`

**Step 1: Write failing artifact tests**

Verify:

- `artifacts.json` must match the schema.
- Declared stage outputs must be present.
- Undeclared output IDs fail validation.
- Published snapshots are immutable.
- A retry publishes a new attempt directory.

**Step 2: Write failing context tests**

Verify:

- Context includes flow prompt, stage prompt, and declared input artifacts only.
- Single-file and total character budgets are enforced.
- Truncation is explicitly marked.
- Paths point agents to full artifact files when text is truncated.

Start with:

```ts
const TOTAL_INPUT_CHARS = 100_000;
const PER_FILE_CHARS = 20_000;
```

**Step 3: Run tests and verify failure**

Run:

```bash
npm test -- --run test/artifacts test/context
```

Expected: FAIL.

**Step 4: Implement artifact storage**

Use:

```text
.nitely/runs/<run-id>/
├── artifacts/<artifact-id>/<attempt>/
├── stages/<stage-id>/<attempt>/
│   ├── output.md
│   ├── artifacts.json
│   └── events.jsonl
└── worktree/
```

Copy metadata and small documents. Workspace artifacts may reference the run worktree plus a Git commit SHA instead of copying the repository.

**Step 5: Implement context assembly**

Return one prompt string with stable headings and artifact IDs. Never inject artifacts that are not declared as stage inputs.

**Step 6: Run tests**

Run:

```bash
npm test -- --run test/artifacts test/context
npm run check
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/artifacts src/context test/artifacts test/context
git commit -m "feat: publish immutable artifacts and bounded context"
```

### Task 7: Implement command stages

**Files:**
- Create: `src/stages/command.ts`
- Create: `test/stages/command.test.ts`

**Step 1: Write failing command-stage tests**

Verify:

- Commands run in the worktree.
- Exit code `0` completes the stage.
- Non-zero exit records stdout/stderr and fails the stage.
- Timeout terminates the command.
- Command output is stored under the stage attempt directory.
- Shell interpolation is not applied by Nitely.

Represent commands as:

```yaml
type: command
command:
  executable: npm
  args: [test, --, --run]
```

Do not use a single shell string in the production schema.

**Step 2: Update the schema test**

Change the earlier temporary string command representation to executable plus argument array.

**Step 3: Implement command execution**

Write:

```text
command.stdout.log
command.stderr.log
output.md
artifacts.json
```

The generated artifact summary includes command, exit code, duration, and log paths.

**Step 4: Run tests**

Run:

```bash
npm test -- --run test/stages/command.test.ts test/flow/load.test.ts
npm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/stages src/flow/schema.ts test/stages test/flow
git commit -m "feat: execute deterministic command stages"
```

### Task 8: Build the sequential workflow engine

**Files:**
- Create: `src/engine/types.ts`
- Create: `src/engine/run.ts`
- Create: `src/engine/project.ts`
- Create: `test/engine/run.test.ts`

**Step 1: Write the failing happy-path integration test**

Use a flow:

```text
external spec
→ mock agent implementation
→ command verification
```

Verify:

- A worktree is created.
- Events occur in deterministic order.
- The implementation artifact unlocks the command stage.
- The final run status is completed.
- `status` can be reconstructed from stored events.

**Step 2: Run and verify failure**

Run:

```bash
npm test -- --run test/engine/run.test.ts
```

Expected: FAIL.

**Step 3: Implement stage projections**

Project event history to:

```ts
type StageStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "awaiting-approval";
```

The event log remains authoritative.

**Step 4: Implement sequential execution**

The engine:

1. Appends `run.created`.
2. Creates the workspace.
3. Publishes external inputs.
4. Selects the next ready stage in topological order.
5. Creates an attempt directory.
6. Executes the stage.
7. Publishes and validates outputs.
8. Appends completion events.
9. Repeats until no stages remain.

**Step 5: Run tests**

Run:

```bash
npm test -- --run test/engine/run.test.ts
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/engine test/engine
git commit -m "feat: execute sequential artifact workflows"
```

### Task 9: Add retry, interruption, and resume

**Files:**
- Create: `src/policy/decide.ts`
- Create: `test/policy/decide.test.ts`
- Create: `test/engine/retry.test.ts`
- Modify: `src/engine/run.ts`
- Modify: `src/engine/project.ts`

**Step 1: Write failing policy tests**

Verify:

- Success returns `complete`.
- Failure below `maxAttempts` returns `retry`.
- Exhausted attempts return `fail`.
- Invalid requested upstream target returns `fail`.
- Repeated rework beyond the configured window returns `fail`.

Use a pure function:

```ts
decidePolicy(input: PolicyInput): PolicyDecision;
```

**Step 2: Write the failing retry integration test**

Configure the mock runtime to fail once. Verify:

- Attempt one emits failure and retry events.
- Attempt two starts from the accepted upstream snapshot.
- Attempt one remains immutable.
- The run completes after attempt two.

**Step 3: Write the failing resume test**

Seed a run ending with `stage.started`. Reopen Nitely and verify the projection marks it `interrupted`. Calling resume creates a new attempt instead of pretending the old subprocess survived.

**Step 4: Implement policy and recovery**

Keep policy deterministic. Failure context passed to a retry includes:

- Previous attempt number.
- Failure category.
- Gate or process output reference.
- Explicit instruction not to repeat the failed approach.

**Step 5: Run tests**

Run:

```bash
npm test -- --run test/policy test/engine/retry.test.ts
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/policy src/engine test/policy test/engine
git commit -m "feat: resume interrupted runs with bounded retries"
```

### Task 10: Complete the operational CLI

**Files:**
- Create: `src/app/create-app.ts`
- Create: `src/config/load.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `test/cli/integration.test.ts`

**Step 1: Write failing CLI integration tests**

Test:

- `nitely init`
- `nitely validate`
- `nitely run`
- `nitely runs`
- `nitely status`
- `nitely logs`
- `nitely resume`
- `nitely cancel`

Inject application dependencies into `runCli`; do not spawn the CLI binary in every unit test.

**Step 2: Implement configuration**

`nitely init` creates:

```text
.nitely/config.yaml
.nitely/runs/
flows/
specs/
```

Configuration:

```yaml
version: 1
defaultRuntime: mock
database: .nitely/nitely.db
```

Do not store access tokens in this file. Read credentials from environment variables or existing CLI authentication.

**Step 3: Implement commands**

Use `node:util.parseArgs`. Every command returns a numeric exit code and supports injected I/O for tests.

`status` should show:

```text
RUN run-123 completed
✓ implement attempt 2
✓ test attempt 1
```

**Step 4: Run tests**

Run:

```bash
npm test -- --run test/cli
npm run check
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/app src/config src/cli.ts src/index.ts test/cli
git commit -m "feat: expose local workflow operations through cli"
```

### Task 11: Add the real Codex runtime

**Files:**
- Create: `src/agents/codex.ts`
- Create: `src/agents/codex-events.ts`
- Create: `test/agents/codex-events.test.ts`
- Create: `test/agents/codex.integration.test.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/config/load.ts`

**Step 1: Write failing event parser tests**

Capture representative `codex exec --json` JSONL fixtures. Verify:

- Session identifiers map to `session.started`.
- Text deltas map to `message.delta`.
- Command/tool events map to normalized tool events.
- Completion and failure map correctly.
- Unknown future events are retained as debug events rather than crashing the run.

Do not require Codex authentication for parser unit tests.

**Step 2: Implement the Codex process adapter**

Execute Codex without a shell:

```text
codex exec --json --sandbox workspace-write <prompt>
```

Requirements:

- `cwd` is the run worktree.
- Prompt is passed through stdin when supported, avoiding shell quoting.
- JSONL is parsed incrementally.
- Cancellation terminates the process group.
- Raw JSONL is persisted in the attempt directory.
- Network access is disabled by default.
- The adapter verifies `output.md` and `artifacts.json` after completion.

**Step 3: Add an opt-in integration test**

Skip unless:

```text
NITELY_TEST_CODEX=1
```

Use a temporary Git repository and ask Codex to create one harmless text file. Assert the source checkout remains unchanged.

**Step 4: Run tests**

Run:

```bash
npm test -- --run test/agents/codex-events.test.ts
NITELY_TEST_CODEX=1 npm test -- --run test/agents/codex.integration.test.ts
npm run check
```

Expected: parser tests always pass; integration test passes when Codex is installed and authenticated.

**Step 5: Commit**

```bash
git add src/agents src/app src/config test/agents
git commit -m "feat: execute coding stages with codex"
```

### Task 12: Add approval and GitHub draft PR publishing

**Files:**
- Create: `src/approval/store.ts`
- Create: `src/scm/types.ts`
- Create: `src/scm/github-cli.ts`
- Create: `src/stages/approval.ts`
- Create: `src/stages/publish-change.ts`
- Create: `test/scm/github-cli.test.ts`
- Create: `test/engine/approval.test.ts`
- Modify: `src/engine/run.ts`
- Modify: `src/cli.ts`

**Step 1: Write failing approval tests**

Verify:

- A publish stage pauses with `approval.requested`.
- `nitely approve` appends `approval.resolved`.
- Resume continues from the publish stage.
- A denied approval fails the run.

**Step 2: Write failing GitHub command construction tests**

The adapter should use existing `gh` authentication:

```bash
git push -u origin nitely/<run-id>
gh pr create --draft --title <title> --body-file <evidence.md>
```

Test arguments as arrays. Never build one shell command string.

**Step 3: Implement evidence generation**

Create:

```text
.nitely/runs/<run-id>/evidence.md
```

Include:

- Source flow.
- Input specification.
- Stage attempts.
- Tests and command gates.
- Review summary.
- Changed files.
- Retry history.
- Explicit statement that the change was agent-generated.

**Step 4: Implement publishing**

Before pushing:

- Confirm the workspace has commits.
- Confirm the branch starts with `nitely/`.
- Confirm the target repository matches the run metadata.
- Require approval by default.

**Step 5: Run tests**

Run:

```bash
npm test -- --run test/scm test/engine/approval.test.ts
npm run check
```

Expected: PASS without making network calls.

**Step 6: Commit**

```bash
git add src/approval src/scm src/stages src/engine src/cli.ts test/scm test/engine
git commit -m "feat: publish approved runs as draft github pull requests"
```

### Task 13: Add the self-improvement flow

**Files:**
- Create: `flows/self-improve.yaml`
- Create: `specs/example-change.md`
- Create: `AGENTS.md`
- Create: `test/e2e/self-improve.test.ts`
- Modify: `README.md`

**Step 1: Write the failing end-to-end test using the mock runtime**

The flow must:

1. Consume a `spec`.
2. Implement a change.
3. Run formatting.
4. Run type checking.
5. Run tests.
6. Produce review evidence.
7. Pause before publishing.

Verify the original checkout remains unchanged and the run worktree contains the change.

**Step 2: Add the flow**

Use sequential stages:

```text
implement
→ format
→ typecheck
→ test
→ review
→ approval
→ publish
```

Use Codex for `implement`. Initially use Codex with read-only review instructions for `review`; introduce a second provider only after this vertical slice is reliable.

**Step 3: Add repository instructions**

`AGENTS.md` must require:

- TDD.
- No weakening tests to make a change pass.
- No edits outside the worktree.
- No automatic merge.
- Update design and implementation documents when architecture changes.

**Step 4: Document the bootstrap command**

```bash
npm run build
node dist/index.js run flows/self-improve.yaml \
  --repo . \
  --input spec=specs/example-change.md
```

**Step 5: Run verification**

Run:

```bash
npm test -- --run
npm run check
npm run build
node dist/index.js validate flows/self-improve.yaml
```

Expected: all tests pass and the flow is valid.

Run the real bootstrap only after reviewing its specification:

```bash
node dist/index.js run flows/self-improve.yaml \
  --repo . \
  --input spec=specs/example-change.md
```

Expected: the run reaches approval with a reviewable diff in an isolated worktree.

**Step 6: Commit**

```bash
git add flows specs AGENTS.md README.md test/e2e
git commit -m "feat: bootstrap nitely through its own workflow"
```

### Task 14: Add GitLab publishing after bootstrap succeeds

**Files:**
- Create: `src/scm/gitlab-cli.ts`
- Create: `test/scm/gitlab-cli.test.ts`
- Modify: `src/stages/publish-change.ts`
- Modify: `src/config/load.ts`
- Modify: `README.md`

**Step 1: Write failing GitLab adapter tests**

Construct:

```bash
git push -u origin nitely/<run-id>
glab mr create --draft --title <title> --description-file <evidence.md>
```

Test missing `glab`, unauthenticated state, and returned MR URL.

**Step 2: Implement provider selection**

Select from:

1. Explicit stage provider.
2. Repository remote hostname.
3. Configured default.

Fail on ambiguity.

**Step 3: Run tests**

Run:

```bash
npm test -- --run test/scm
npm run check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/scm src/stages src/config README.md test/scm
git commit -m "feat: publish approved runs as gitlab merge requests"
```

## Final Verification

Run:

```bash
npm test -- --run
npm run check
npm run build
node dist/index.js --help
node dist/index.js validate flows/self-improve.yaml
```

Expected:

- All tests pass.
- Type checking passes.
- Build succeeds.
- CLI help lists operational commands.
- The self-improvement flow validates.

Then execute one real Codex bootstrap against a deliberately small specification. Inspect:

- The source checkout remains clean.
- The run worktree contains only intended changes.
- Every stage has events and artifacts.
- Retry history is understandable.
- Publishing waits for approval.
- The draft PR/MR contains evidence and is not merged.
