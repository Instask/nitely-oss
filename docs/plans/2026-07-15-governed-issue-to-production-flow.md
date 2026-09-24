# Governed Issue-To-Production Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a built-in Nitely Flow that preserves multi-task execution semantics across mandatory approval resumes, materializes typed command evidence, and delegates one idempotent, fail-closed production release to a repository-owned adapter.

**Architecture:** Keep repository-specific merge, deploy, smoke, rollback, and reconciliation logic behind `./scripts/nitely/release-production`. After fresh or resumed bootstrap, route execution through one task-plan-aware runtime state machine so iteration, retry, rework, blockers, and final-stage deferral cannot drift. Treat command outputs as an attempt-local protocol: Nitely supplies trusted output identity, validates the complete declared set before registration, rehydrates registered artifacts on resume, and permits only one narrow Markdown fallback for ordinary verification commands.

**Tech Stack:** TypeScript, JSON Flow documents, Zod-backed Flow validation, Vitest, SQLite-backed run events, Markdown documentation.

---

### Task 1: Flow and template contract — completed baseline

**Files:**
- Existing: `flows/pilot-issue-to-production.json`
- Existing: `src/flows/templates.ts`
- Existing: `test/flows/validate.test.ts`

The Flow/catalog contract already exists. Preserve its external inputs, approval
ordering, task-plan roles, publish/release ordering, typed output descriptions,
production-lint cleanliness, and catalog/file synchronization while completing
the runtime tasks below. The planner may emit at most 12 tasks; set
`max_tasks: 12` on execute, verify/advance, and final task-plan roles so the
runtime rejects an oversized parsed plan before execution. Configure the loop
and repeating stages for 24 total iterations/attempts so the first 12 task
passes retain 12 shared retry/rework slots under global per-stage attempt
counting. Do not reimplement Task 1.

**Verification:**

```bash
corepack pnpm exec vitest run test/flows/validate.test.ts
```

Expected: PASS. It is acceptable for later tasks to strengthen this test for
`release.maxAttempts = 1`, but the existing contract must remain green.

### Task 2: Resume task-plan and runtime parity

**Files:**
- Modify: `src/run/run-flow.ts`
- Modify only if keyed task-plan projection is required: `src/run/project.ts`
- Create: `test/run/production-flow-runtime.test.ts`
- Modify for focused regression coverage only: `test/run/run-flow.test.ts`

**Step 1: Write the approval-to-resume task-loop integration test**

Create a small production-shaped Flow fixture with a mandatory approval followed
by a two-task plan, `execute-current`, specification review, quality
`verify-advance`, and final review. Start with `runFlow`, approve the pause, then
continue with `resumeRun`.

Assert:

- implementation, specification review, and quality review each run for T001
  and T002 in order;
- each prompt is scoped to only the current task;
- two `task.plan.task.completed` events exist with no duplicate task id;
- final review runs once, after both tasks complete; and
- `task.plan.final.ready` is emitted while premature final execution is absent.

**Step 2: Write the blocker-continuation integration test**

Block during T002 after T001 has completed, then resume again. Assert T001 does
not rerun, T002 remains current, prior artifacts and attempt history are
available, and final review still waits for T002.

Also add a review failure/rework assertion proving that a resumed review uses
the same retry and structured rework policy as a fresh review.

**Step 3: Run the tests to verify RED**

```bash
corepack pnpm exec vitest run test/run/production-flow-runtime.test.ts
```

Expected: FAIL because `resumeRun` currently follows a linear stage loop and
does not prepare, advance, scope, or restore task-plan state.

**Step 4: Extract the shared execution loop**

Refactor the post-bootstrap execution path so both `runFlow` and `resumeRun`
enter one index-based stage state machine. The shared path must own:

```ts
prepareTaskPlanStageStart(...)
execute stage with the normal retry/rework policy
advanceTaskPlanAfterStage(...)
```

Pass continuation metadata into the shared loop for the selected resume stage,
approval-attempt reuse, operator answers/reviews, `resumedFrom`, and starting
attempt counts. Preserve all current special-stage behavior and finalizers.

Do not duplicate the fresh task-plan calls inside a second resume-only loop.

**Step 5: Rehydrate keyed task-plan continuation state**

Parse each task-plan input and replay append-only `task.plan.*` events by input
id to restore completed ids, current task, iteration, maximum iterations, and
history. Do not rely only on `projection.taskPlan`, which represents one loop.
Ensure resumed agent/review calls receive `taskPlanPrompt` and accumulated prior
failures.

**Step 6: Run focused GREEN verification**

```bash
corepack pnpm exec vitest run test/run/production-flow-runtime.test.ts test/run/run-flow.test.ts
```

Expected: PASS, including existing fresh/resume, approval, retry, rework,
operator-question, and task-plan tests.

**Step 7: Commit**

```bash
git add src/run/run-flow.ts src/run/project.ts test/run/production-flow-runtime.test.ts test/run/run-flow.test.ts
git commit -m "fix: preserve task plan semantics after resume"
```

Stage only files actually changed.

### Task 3: Typed command output protocol

**Files:**
- Modify: `src/run/execution/types.ts`
- Modify: `src/run/execution/local.ts`
- Modify only if delegation needs adjustment: `src/run/execution/mise.ts`
- Modify: `src/run/run-flow.ts`
- Modify: `src/run/attempt-outputs.ts`
- Modify: `test/run/production-flow-runtime.test.ts`
- Modify: `test/run/execution/local.test.ts`
- Modify: `test/run/execution/mise.test.ts`
- Modify: `test/run/attempt-outputs.test.ts`

**Step 1: Write failing backend environment tests**

Extend command execution options with optional attempt metadata and assert Local
and Mise command execution receive runtime-owned values for:

```text
NITELY_OUTPUT_DIR
NITELY_ATTEMPT_DIR
NITELY_RUN_ID
NITELY_STAGE_ID
NITELY_ATTEMPT
```

Seed conflicting inherited values and assert the runtime-owned values win.

**Step 2: Write failing command-output integration tests**

Add tests that require:

1. a single rich `text/markdown` command output to use redacted `output.md` as a
   fallback when no explicit artifact exists;
2. a command adapter to write two conventional files through
   `NITELY_OUTPUT_DIR`, after which both outputs are validated and registered;
3. exit code zero with one missing required output to fail closed, retry in a
   new attempt directory, and expose no partial artifact set;
4. registered command outputs to survive a later approval/blocker and resume;
5. an invalid media type, invalid JSON, schema mismatch, path escape, symlink
   escape, duplicate id, and undeclared id to fail validation; and
6. a command whose outputs are only legacy strings to keep its lenient behavior.

**Step 3: Run the tests to verify RED**

```bash
corepack pnpm exec vitest run \
  test/run/production-flow-runtime.test.ts \
  test/run/execution/local.test.ts \
  test/run/execution/mise.test.ts \
  test/run/attempt-outputs.test.ts
```

Expected: FAIL because command options expose no attempt output identity and a
successful command currently completes without materializing declared outputs.

**Step 4: Pass trusted attempt metadata to commands**

Add optional run/stage/attempt/output-directory fields to `RunCommandOptions`.
Have `runCommandInWorkspace` populate them and Local/Mise expose the five
environment variables with runtime values overriding inherited values. Keep
custom backends source-compatible by making the new options optional.

**Step 5: Validate and register outputs before completion**

After exit code zero:

1. identify rich required command contracts while retaining bare-string legacy
   compatibility;
2. validate the entire required set before registry mutation;
3. enforce media type and schema, including failure on invalid JSON;
4. record every validated artifact and persist manifest/registry state; and
5. only then mark the stage completed.

Return output-contract failures through the same `failureError` path as command
exit failures so fresh and resumed attempts use the shared retry policy. Every
retry gets a new attempt directory.

**Step 6: Add the narrow Markdown fallback**

When exactly one rich required output is `text/markdown`, has no schema, and the
command produced no manifest or conventional artifact, synthesize a manifest
entry mapping that output id to Nitely's already-redacted `output.md`. Do not
apply the fallback to multiple, non-Markdown, or schema-bearing outputs.

**Step 7: Generalize resume artifact rehydration**

Replace agent/sync-only restoration with a path-contained artifact-registry
rehydrator for completed command, agent, gate, publish/update, and sync outputs.
Use `rehydrateExisting: true` or equivalent so resume does not emit duplicate
`artifact.published` events.

Do not redesign the existing review-gate internal JSON/media-type representation
in this task. If stronger command validation accidentally reaches gate outputs,
keep enforcement scoped to commands and record the gate issue separately.

**Step 8: Run focused GREEN verification**

```bash
corepack pnpm exec vitest run \
  test/run/production-flow-runtime.test.ts \
  test/run/run-flow.test.ts \
  test/run/execution/local.test.ts \
  test/run/execution/mise.test.ts \
  test/run/attempt-outputs.test.ts
```

Expected: PASS. Command outputs are available immediately and after resume;
missing or invalid rich outputs never complete a stage.

**Step 9: Commit**

```bash
git add src/run/execution/types.ts src/run/execution/local.ts src/run/execution/mise.ts \
  src/run/run-flow.ts src/run/attempt-outputs.ts \
  test/run/production-flow-runtime.test.ts test/run/run-flow.test.ts \
  test/run/execution/local.test.ts test/run/execution/mise.test.ts \
  test/run/attempt-outputs.test.ts
git commit -m "feat: materialize typed command outputs"
```

Stage only files actually changed.

### Task 4: Release safety contract

**Files:**
- Modify: `flows/pilot-issue-to-production.json`
- Modify: `src/flows/templates.ts`
- Modify: `test/flows/validate.test.ts`
- Modify: `test/run/production-flow-runtime.test.ts`
- Modify: `specs/issues/413-governed-issue-to-production-flow-spec.md` only if implementation discoveries require clarification

**Step 1: Write failing release-safety tests**

Require the Flow/catalog release stage to set `maxAttempts: 1`. Add a runtime
adapter fixture that persists a receipt keyed by `NITELY_RUN_ID` plus
`NITELY_STAGE_ID`, records `NITELY_ATTEMPT` as provenance, and counts merge and
deploy mutations.

Simulate an interrupted first invocation followed by operator-driven resume.
The second invocation must reconcile the receipt/production state, emit complete
release and smoke reports, and leave merge/deploy mutation counts at one.

Also assert a normal non-zero release result receives no automatic retry and
that one missing report fails the stage without partial registration.

**Step 2: Run the tests to verify RED**

```bash
corepack pnpm exec vitest run test/flows/validate.test.ts test/run/production-flow-runtime.test.ts
```

Expected: FAIL because release currently inherits the Flow's broader attempt
budget and command attempts do not yet prove durable run/stage reconciliation.

**Step 3: Set the Flow safety boundary**

Set release `maxAttempts` to `1` in both the JSON Flow and template catalog. Keep
the command exactly `./scripts/nitely/release-production` and retain its bounded
timeout and two rich Markdown outputs.

The target adapter contract must use run/stage identity as the durable
idempotency key, capture rollback baseline before mutation, reconcile an
already-applied release without repeating it, roll back before a terminal
failure, and write both reports before returning success. Do not embed
environment-specific deploy code or credentials in Nitely.

**Step 4: Run focused GREEN verification**

```bash
corepack pnpm exec vitest run test/flows/validate.test.ts test/run/production-flow-runtime.test.ts
```

Expected: PASS; JSON/catalog remain structurally identical and repeated logical
release execution does not repeat external mutation.

**Step 5: Commit**

```bash
git add flows/pilot-issue-to-production.json src/flows/templates.ts \
  test/flows/validate.test.ts test/run/production-flow-runtime.test.ts \
  specs/issues/413-governed-issue-to-production-flow-spec.md
git commit -m "fix: make production release idempotent"
```

Stage only files actually changed.

### Task 5: Operator and adapter documentation

**Files:**
- Modify: `docs/pilot-flow-templates.md`
- Create: `test/docs/production-release-flow.test.ts`

**Step 1: Write the failing documentation test**

Require documentation to describe:

- all mandatory approvals and identical task-plan behavior after resume;
- the fixed `./scripts/nitely/release-production` adapter;
- explicit release approval and no autonomous merge/deploy;
- `NITELY_OUTPUT_DIR`, conventional output filenames, the single Markdown
  fallback, and fail-closed multi-output validation;
- `NITELY_RUN_ID` plus `NITELY_STAGE_ID` durable idempotency and reconciliation;
- `maxAttempts: 1`, rollback-baseline capture, and rollback-before-failure;
- secret values staying out of Flow JSON, prompts, commands, and artifacts;
- resumable agent/review blockers and artifact rehydration; and
- same-PR review rework remaining a separate Flow.

**Step 2: Run the test to verify RED**

```bash
corepack pnpm exec vitest run test/docs/production-release-flow.test.ts
```

Expected: FAIL because the complete runtime and adapter protocol is not yet
documented.

**Step 3: Add operator-facing documentation**

Add or update the `pilot-issue-to-production` section in
`docs/pilot-flow-templates.md` with inputs, stage sequence, pause/resume
semantics, evidence, output protocol, release-adapter trust boundary, recovery,
idempotency, and a runnable command example. State that an interrupted release
must reconcile durable state and must not blindly repeat merge/deploy.

**Step 4: Run targeted GREEN verification**

```bash
corepack pnpm exec vitest run test/docs/production-release-flow.test.ts test/flows/validate.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/pilot-flow-templates.md test/docs/production-release-flow.test.ts
git commit -m "docs: document governed production flow"
```

### Task 6: Final verification, review, PR, merge, and deploy

**Files:**
- Verify all files changed by Tasks 1–5; fix findings in the owning task's files.

**Step 1: Run focused production-flow gates**

```bash
corepack pnpm exec vitest run \
  test/flows/validate.test.ts \
  test/run/production-flow-runtime.test.ts \
  test/run/execution/local.test.ts \
  test/run/execution/mise.test.ts \
  test/run/attempt-outputs.test.ts \
  test/docs/production-release-flow.test.ts
```

Expected: all tests pass.

**Step 2: Run repository gates**

```bash
corepack pnpm test:run
corepack pnpm check
corepack pnpm build
git diff --check origin/master...HEAD
node dist/index.js validate flows/pilot-issue-to-production.json
```

Expected: all commands exit zero; the new Flow has 0 validation errors and 0
production-lint warnings.

**Step 3: Perform staged independent reviews**

Review in this order and return each blocking finding to its implementing task:

1. Flow/spec compliance and mandatory approval/resume behavior;
2. task-plan retry/rework/blocker continuation correctness;
3. command output path safety, atomic registration, compatibility, and resume
   rehydration;
4. release idempotency, reconciliation, rollback, secret hygiene, and absence of
   duplicate external effects; and
5. documentation accuracy.

Do not broaden #413 into a review-gate artifact-format migration unless a
change in this branch directly requires a narrow compatibility correction.

**Step 4: Prepare and review the PR**

Push the feature branch and create a PR that closes #413. Include the RED/GREEN
runtime evidence, output protocol, release safety boundary, and full repository
gate results. Wait for required checks and merge only after independent review
finds no blocking issue.

**Step 5: Deploy and smoke test Nitely**

Deploy through the repository's documented production helper. Confirm the
deployed commit, production Web health, CLI Flow validation, template catalog
availability, and a non-mutating approval/pause smoke path. Do not run a real
merge/deploy adapter against an unrelated target repository as a smoke test.

**Step 6: Close out issue #413**

Verify the issue is closed by the merged PR and record the merged PR, deployed
commit, production smoke evidence, and any explicitly deferred review-gate
artifact follow-up.
