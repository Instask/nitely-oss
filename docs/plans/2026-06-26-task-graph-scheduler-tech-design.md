# Technical Design: Task Graph Scheduler

Spec: [specs/issues/195-task-graph-scheduler-spec.md](../../specs/issues/195-task-graph-scheduler-spec.md)

## Overview

Add a dependency-graph layer over the existing per-task FS store, a pure graph
engine for cycle detection and runnable selection, a PR-merged completion
predicate over the existing GitHub SCM provider, an AI suggestion engine that
reuses the agent runtime registry without a worktree, and a cron-driven
scheduler entrypoint. The manual run-now path gains a dependency gate with an
override.

## Proposed Files

- `src/scheduler/graph.ts` — pure graph engine (cycles, blocked, runnable).
- `src/scheduler/graph.test.ts`
- `src/scheduler/completion.ts` — upstream completion predicate (PR merged +
  safe degrade), with a per-cycle cache.
- `src/scheduler/completion.test.ts`
- `src/scheduler/suggestions.ts` — suggestion generation + JSON parse/validate.
- `src/scheduler/suggestions.test.ts`
- `src/scheduler/run.ts` — scheduler orchestration (load → graph → run window).
- `src/scheduler/run.test.ts`
- `src/run/execution/runtime-prompt.ts` — workspace-free runtime invocation
  helper extracted from `runAgent`.
- Edits: `src/web/tasks.ts` (model + dependency mutation), `src/scm/types.ts` &
  `src/scm/github.ts` (`getChangeRequestStatus`), `src/run/execution/local.ts`
  (use the extracted helper), `src/web/server.ts` (routes + run-now gate),
  `src/web/ui.ts` (dependency/suggestion UI), `src/cli.ts` (`scheduler` command).

## Types

```ts
// src/web/tasks.ts
export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export interface SuggestedDependency {
  dependsOn: string;     // existing task id
  reason: string;
  confidence: number;    // 0..1
  source: string;        // runtime/model that produced it
  suggestedAt: string;
}

export interface TaskRecord {
  // ...existing fields...
  priority?: TaskPriority;              // default "P2"
  dependsOn?: string[];                // confirmed upstream task ids
  suggestedDependencies?: SuggestedDependency[];
}
```

```ts
// src/scheduler/graph.ts
export type BlockedReason =
  | { kind: "missing"; upstreamId: string }
  | { kind: "failed"; upstreamId: string }
  | { kind: "incomplete"; upstreamId: string }; // not completed or PR not merged

export interface GraphNode {
  task: TaskRecord;
  blocked: boolean;
  reasons: BlockedReason[];
}

export interface CycleError {
  cycle: string[]; // task id path forming the cycle
}

// completion predicate: is this upstream id "done" (completed + merged)?
export type CompletionPredicate = (taskId: string) => boolean;

export function detectCycle(tasks: TaskRecord[]): CycleError | undefined;
export function wouldCreateCycle(
  tasks: TaskRecord[], from: string, to: string,
): CycleError | undefined;
export function evaluate(
  tasks: TaskRecord[], isComplete: CompletionPredicate,
): GraphNode[];
export function selectRunnable(
  tasks: TaskRecord[], isComplete: CompletionPredicate,
): TaskRecord[]; // ready + unblocked, ordered by priority then createdAt
```

## Graph Engine

- Edges: downstream `task.id` → each id in `task.dependsOn`. Unknown upstream ids
  produce a `missing` blocked reason (not an edge to a phantom node).
- `detectCycle` / `wouldCreateCycle`: DFS three-color marking
  (white/gray/black); a back-edge to a gray node yields the cycle path. Ignore
  `suggestedDependencies` entirely.
- `evaluate`: a task is blocked if any upstream is missing, `failed`, or not
  `isComplete`. Reasons are collected per upstream.
- `selectRunnable`: tasks with `status === "ready"` and no blocked reasons,
  sorted by `priority` (P0<P1<P2<P3 ordering, P0 first) then `createdAt`
  ascending.

## Completion Predicate

`src/scheduler/completion.ts` builds a `CompletionPredicate` from task records:

```ts
export function createCompletionPredicate(
  tasks: TaskRecord[],
  getStatus: (url: string) => Promise<{ state: string; merged: boolean }>,
): Promise<CompletionPredicate>;
```

- For each task with `status === "completed"` and a `changeRequestUrl`, fetch PR
  status once (cached per call). Complete iff `merged === true`.
- On fetch error, log and treat as not-merged (returns `false`), so downstream
  stays blocked.
- `getChangeRequestStatus` on `GitHubScmProvider` parses the existing
  `GET /pulls/:number` response for `state` and `merged`.

## Suggestion Engine

- `src/run/execution/runtime-prompt.ts` exposes
  `runRuntimePrompt({ registry, runtime, model, prompt, cwd, env, spawn }) =>
  Promise<{ stdout: string }>` — resolves the launcher, validates required env,
  spawns in `cwd` (repo root, no worktree), writes `prompt` to stdin, collects
  stdout. `runAgent` is refactored to call this helper with the worktree path.
- `src/scheduler/suggestions.ts`:
  - `buildPrompt(subject, others)` renders task summaries and requests JSON.
  - `parseSuggestions(stdout)` extracts the JSON array defensively (tolerates
    surrounding prose / code fences).
  - `generateSuggestions(repoPath, subjectId, config)` runs the runtime, parses,
    validates (drop unknown / already-confirmed / cycle-creating), and writes
    `suggestedDependencies` back to the affected tasks via an atomic update.
- Triggered from the create handler in `server.ts` via a fire-and-forget call
  (errors logged, never surfaced to the create response). Also exposed as
  `POST /api/tasks/:id/suggestions:refresh`.

## Web / API Changes

- `POST /api/tasks` — unchanged response shape; schedules background suggestion
  generation after the record is written.
- `POST /api/tasks/:id/dependencies` — body `{ dependsOn }`; cycle-check via
  `wouldCreateCycle`, then move into `dependsOn`, drop matching suggestion.
- `DELETE /api/tasks/:id/dependencies/:upstreamId`.
- `POST /api/tasks/:id/suggestions:refresh`.
- `POST /api/tasks/:id/runs?override=true` — run-now gate: load tasks, evaluate
  the subject; if blocked and not overridden, return a 4xx with the blocking
  reasons.
- `ui.ts` renders `priority`, `dependsOn`, derived blocked badge + reason, and a
  suggestions list with accept/dismiss.

## CLI / Scheduler

- `nitely scheduler [--repo R] [--window HH:MM-HH:MM] [--once]` in `cli.ts`
  delegates to `src/scheduler/run.ts`.
- `run.ts`: load tasks → build completion predicate → `selectRunnable` → for each
  selected task within the window, `runFlow`; on failure, record and continue
  with the remaining runnable set (recompute readiness between tasks so newly
  unblocked work can run). `--once` runs a single pass and exits (cron-friendly).

## Tests

### Graph Engine (`graph.test.ts`)
- Linear chain: only the head is runnable; downstream blocked with `incomplete`.
- Diamond: independent branches both runnable.
- Cycle: `detectCycle` / `wouldCreateCycle` return the cycle path; mutation
  rejected.
- Missing / failed upstream: correct blocked reason.
- Ordering: P0 before P2; same priority ordered by `createdAt`.

### Completion (`completion.test.ts`)
- Completed + merged → complete. Completed + open PR → not complete.
- Fetch error → not complete (safe degrade). Status fetched once per cycle.

### Suggestions (`suggestions.test.ts`)
- `parseSuggestions` tolerates code fences / surrounding prose.
- Validation drops unknown ids, already-confirmed, and cycle-creating entries.
- `runRuntimePrompt` delivers prompt over stdin and returns stdout (fake spawn).

### Scheduler (`run.test.ts`)
- Runs runnable tasks in priority order; skips blocked.
- One task fails → independent branch still runs.
- `--once` exits after a single pass.

### Web (`server` / `tasks` tests)
- Dependency add rejects cycles; accept moves suggestion → confirmed.
- Run-now blocked without override; runs with `override=true`.
- Create returns immediately; suggestion write is observable after the async run.

## Verification

- `pnpm test` green.
- Manual: create two tasks, declare a dependency, confirm downstream is blocked
  in the Web Console; run `nitely scheduler --once` and confirm only the head
  runs; override run-now on the blocked task and confirm it runs.

## Review Checklist

- `suggestedDependencies` never influence `selectRunnable` or `evaluate`.
- `blocked` is never persisted into `task.json`.
- Cycle detection runs on every confirmed-dependency mutation.
- GitHub-unavailable degrades to blocked, never to "runnable".
- Suggestion generation failure never fails task creation.
- Extracted `runRuntimePrompt` preserves existing `runAgent` behavior (codex
  sandbox env, model pass-through, stdin delivery).
