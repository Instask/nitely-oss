# Conflict Resolution Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a merge-based PR conflict-resolution stage and bootstrap flow that updates an existing same-repository GitHub PR branch after verification and review.

**Architecture:** Build on the PR rework path introduced for issue #22. `rework-pr` still resolves and checks out the target PR branch; a new `sync-change` stage fetches the PR base branch, attempts a merge into the PR worktree, records clean/conflicted metadata, and lets downstream stages resolve, test, review, and `update-change` the same PR.

**Tech Stack:** TypeScript, Node.js child process APIs, Git worktrees, Vitest, existing Nitely flow/event/projection/SCM abstractions.

---

## Design

### Stage Model

Add a new flow stage:

```json
{
  "id": "sync",
  "type": "sync-change",
  "strategy": "merge",
  "inputs": [],
  "outputs": ["sync-report"]
}
```

For the first version, support only `strategy: "merge"` and default to `merge` when omitted. Reject other strategies with flow validation.

`sync-change` requires `RunFlowInput.changeRequestTarget` or a projected rework target during resume. If no target exists, throw `sync-change requires a change request target`.

### Git Behavior

Use argument-based Git execution, not shell interpolation:

1. `git fetch <remote> <baseBranch>`
2. `git rev-parse FETCH_HEAD` to capture `baseSha`
3. `git rev-parse HEAD` to capture `headShaBefore`
4. `git merge --no-ff --no-edit FETCH_HEAD`

If merge exits `0`, record `result: "clean"` and `headShaAfter`.

If merge exits nonzero, inspect conflict files with:

```bash
git diff --name-only --diff-filter=U
```

If conflict files exist, record `result: "conflicted"` and complete the stage so the next agent stage receives the conflict report and file markers. If merge exits nonzero with no unmerged files, append `run.failed` and fail the run.

### Conflict Report

Write a Markdown report to the stage attempt directory:

```text
.nitely/runs/<run-id>/stages/<sync-stage-id>/<attempt>/sync-report.md
```

Include:

- PR URL and number,
- base branch,
- strategy,
- base SHA,
- head SHA before sync,
- head SHA after sync when available,
- result,
- conflict files,
- Git stdout/stderr paths.

Append structured event payloads:

- `change.sync.completed` for clean sync,
- `change.sync.conflicted` for conflicts.

Both payloads should include the report path and the same structured metadata. Extend projection/evidence only through structured event data; do not parse Markdown.

### Evidence

Extend `writeEvidence()` so rework runs include a `## Sync` section when sync metadata exists. The section should list strategy, result, base branch/SHA, previous head SHA, synced head SHA when available, and conflict files.

`update-change` evidence should include both the sync section and the existing target PR section.

### Bootstrap Flow

Add `flows/resolve-conflicts-bootstrap.json`:

1. `sync`: `sync-change`, outputs `sync-report`.
2. `resolve`: `agent`, inputs `spec`, `tech-design`, `sync-report`; prompt tells the agent to resolve conflict markers if present and leave files unchanged if the sync was clean.
3. `test`: `command`, runs:
   ```bash
   ! git diff --check && test -z "$(git diff --name-only --diff-filter=U)" && pnpm exec vitest run && pnpm run check && pnpm run build
   ```
4. `review`: `agent`, read-only review of conflict resolution.
5. `update`: `update-change`, pushes the same PR branch.

Use `maxAttempts: 2`.

## Tasks

### Task 1: Flow Schema

**Files:**
- Modify: `src/flow/schema.ts`
- Test: `test/flow/load.test.ts`

**Steps:**
1. Add a failing test that a flow with `type: "sync-change"` and `strategy: "merge"` validates.
2. Add a failing test that `strategy: "rebase"` or any unknown strategy is rejected for this version.
3. Implement the schema addition with `strategy: z.literal("merge").default("merge")`.
4. Run `pnpm exec vitest run test/flow/load.test.ts`.

### Task 2: Sync Stage Execution

**Files:**
- Modify: `src/run/run-flow.ts`
- Test: `test/run/run-flow.test.ts`

**Steps:**
1. Add a failing test that `sync-change` without a rework target rejects before pushing.
2. Add a failing test with a real local Git repo where base and PR branch merge cleanly; assert `change.sync.completed`, report path, and updated worktree history.
3. Add a failing test with a real local Git repo where merge conflicts; assert `change.sync.conflicted`, conflict file list, conflict markers remain, and the run can proceed to a mocked agent.
4. Implement an argument-based Git helper that returns exit code/stdout/stderr for Git commands.
5. Implement `sync-change` in `runFlow`.
6. Mirror the same behavior in `resumeRun` for interrupted runs.
7. Run `pnpm exec vitest run test/run/run-flow.test.ts`.

### Task 3: Evidence And Projection

**Files:**
- Modify: `src/events/types.ts`
- Modify: `src/run/project.ts`
- Modify: `src/run/run-flow.ts`
- Test: `test/run/project.test.ts`
- Test: `test/run/run-flow.test.ts`

**Steps:**
1. Add event types `change.sync.completed` and `change.sync.conflicted`.
2. Extend projected run state with optional sync metadata.
3. Add tests that projection exposes the latest sync metadata.
4. Extend `writeEvidence()` to include a sync section for rework runs.
5. Assert evidence includes strategy, result, base SHA, and conflict files.

### Task 4: Bootstrap Flow And Docs

**Files:**
- Create: `flows/resolve-conflicts-bootstrap.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `test/cli.test.ts` or `test/flow/load.test.ts`

**Steps:**
1. Add the bootstrap flow with `sync`, `resolve`, `test`, `review`, and `update` stages.
2. Add a loader test validating the flow with external `spec` and `tech-design` inputs.
3. Document how to run:
   ```bash
   node dist/index.js rework-pr <pr> \
     --repo . \
     --flow flows/resolve-conflicts-bootstrap.json \
     --input spec=specs/issues/023-conflict-resolution-flow-spec.md \
     --input tech-design=docs/plans/2026-06-19-conflict-resolution-flow-tech-design.md
   ```
4. Document that the first version uses merge-based sync, not rebase continuation.

### Task 5: Verification

**Files:**
- No production files.

**Steps:**
1. Run `pnpm exec vitest run test/flow/load.test.ts test/run/run-flow.test.ts test/run/project.test.ts`.
2. Run `pnpm exec vitest run`.
3. Run `pnpm run check`.
4. Run `pnpm run build`.
5. Confirm no `publish-change` path is used by conflict-resolution flow.

