# Context Budget Enforcement — Design (Issue #65, enforcement layer)

Date: 2026-06-21
Issue: #65 (token & context budget harness) — enforcement increment
Builds on: the #65 MVP (context delivery + thin observability), PR #74
Status: Design approved, pending spec review

## Summary

The #65 MVP made input-artifact context cheaper to deliver (path + head preview
instead of full inline) and made per-attempt context usage observable. This
increment adds the **enforceable** half: an opt-in, self-healing **per-stage
context budget**.

A prompt-bearing stage (agent or review-gate) may declare `maxInputTokens`. When
the assembled prompt's `approxTokens` exceeds it, the runtime **auto-shrinks** the
largest input artifacts — dropping their inline preview, leaving metadata + path +
a mandatory-read instruction — until the prompt fits, recording a `budget.trimmed`
event. If even the minimal context (all inputs path-only) still exceeds the budget
(the fixed parts — instructions, output contracts, skills — alone are too big), the
attempt **fails** with a `budget.exceeded` event.

### In scope

- `maxInputTokens` schema field + stage→flow resolution.
- The shrink-or-fail budget gate at prompt assembly.
- `budget.trimmed` / `budget.exceeded` events, projection, and console surfacing.

### Out of scope (still deferred / belongs elsewhere)

- Output / tool-token caps — the agent is a black-box CLI; its own output and
  internal tool tokens are not observable before execution and can't be prevented.
  (Could be parsed post-hoc from raw logs in a separate effort.)
- Agent runtime timeouts (`maxRuntimeMs`) — a separate mechanism (killing a running
  process), orthogonal to context budgeting.
- Repo knowledge cache / code indexing — tracked in #20.
- No global default budget: existing flows are untouched unless they opt in.

## Background (current state after the MVP)

- `renderInputContext(input, context)` (`src/run/run-flow.ts`) renders one input:
  metadata + readable `Full content:` path + a size-gated preview (≤ 8 KB inlined
  full; > 8 KB → 8 KB head + mandatory-read; binary → path only). Returns
  `{ block, usage: { inlinedBytes, savedBytes } }`.
- `renderPrompt(...)` assembles the whole prompt and returns
  `{ prompt, contextUsage }` where `contextUsage.approxTokens = ceil(promptBytes/4)`.
- Three call sites assemble prompts: the agent stage in `runFlow`, the review-gate
  stage, and the agent stage in `resumeRun`. Each already emits `stage.context.usage`.
- The flow schema (`src/flow/schema.ts`) has `maxAttempts` (flow + stage) and
  `timeoutMs` (command / deterministic-gate stages only — `.never()` elsewhere).

## Design

### 1. Schema & resolution

Add optional `maxInputTokens` (`z.number().int().positive().optional()`) to:

- the flow `spec` (flow-level default), and
- **agent** and **review-gate** stage schemas only.

Reject it on stage types where it is meaningless (command, publish-change,
update-change, sync-change, approval) using the same `.never()` pattern as
`timeoutMs`, so declarations stay honest.

Resolution mirrors `maxAttempts`:
`resolvedBudget = stage.maxInputTokens ?? spec.maxInputTokens`.
When `resolvedBudget` is `undefined`, the budget gate is a no-op (opt-in: existing
flows unchanged).

### 2. The shrink-or-fail gate

A new step, `fitPromptToBudget`, wraps prompt assembly at the three call sites.
Inputs: the stage, its scoped input artifacts, the render context, and the resolved
budget. Output: the final prompt string, its `ContextUsage`, and a budget outcome
(`ok` | `trimmed` | `exceeded` with details).

Algorithm (greedy, by largest inlined input):

1. Render the prompt as today and compute `approxTokens`.
2. If `resolvedBudget` is unset or `approxTokens ≤ resolvedBudget` → outcome `ok`,
   no event.
3. Otherwise, repeatedly select the input currently contributing the **most inlined
   bytes** and force it to **path-only** (drop the inline preview; keep metadata +
   path + the mandatory-read instruction). Re-render and re-measure. Stop as soon as
   `approxTokens ≤ resolvedBudget` → outcome `trimmed`.
4. If all inputs are already path-only and the prompt still exceeds the budget →
   outcome `exceeded`.

Rendering support: `renderInputContext` gains a per-input `forcePathOnly` flag (a
small extension). When set on a textual input, it renders metadata + path + the
mandatory-read instruction and reports `inlinedBytes: 0`, `savedBytes:` the full
byte count — identical in spirit to the binary branch. The gate decides which
inputs receive the flag; re-rendering a handful of inputs a few times is cheap.

Rationale for path-only as the only shrink lever: the full file is always
referenced on disk, so dropping the inline preview defers reading rather than losing
information. Discrete full→path-only is simpler than a continuous per-input byte
allowance and matches the delivery model. A finer "shrink the head to N KB" tier is
a possible future refinement (YAGNI now).

### 3. Events

Add to `RunEventType` (`src/events/types.ts`):

- `budget.trimmed` — payload `{ budget, approxTokensBefore, approxTokensAfter,
  trimmedInputIds: string[] }` (plus `stageId`/`attempt` on the event). Emitted once
  when trimming brings the prompt under budget.
- `budget.exceeded` — payload `{ budget, approxTokens }`. Emitted immediately before
  the attempt fails because minimal context still overflows.

Both payloads pass through `redactRuntimeUnknown`.

On `exceeded`, the attempt fails with a clear error
(`stage "<id>" minimal context <N> tokens exceeds budget <M>`) and enters the normal
retry/escalation path — the same path for both agent and review-gate stages. The
throw is a `BudgetExceededError`; at the review-gate site it is re-thrown out of the
gate's own try/catch so the overflow is not swallowed into a fabricated soft gate
result, but it then reaches the same stage-failure/`decideStagePolicy` handling as an
agent overflow (it does not bypass retry). A deterministic overflow retries
identically, so attempts exhaust and the run fails with that reason — the honest
outcome of a mis-set budget or genuinely oversized fixed context.

### 4. Projection & console

`fitPromptToBudget` returns an internal outcome of `ok | trimmed | exceeded`; only
`trimmed` and `exceeded` emit events. Projection (`src/run/project.ts`) folds those
two events onto the attempt as `attempt.budget`, so the stored status is exactly the
two event-bearing cases:

```
{ status: "trimmed" | "exceeded";
  budget: number;
  approxTokensBefore?: number;   // trimmed
  approxTokensAfter?: number;    // trimmed
  approxTokens?: number;         // exceeded
  trimmedInputIds?: string[] }   // trimmed
```

`attempt.budget` is therefore present only when a budget acted (`ok` leaves no
trace). No run-level rollup; the existing run-level `contextUsage` already aggregates
usage.

Web view model (`src/web/runs.ts`) carries the per-stage attempt budget status; the
SPA (`src/web/static/console.dc.html`) extends the existing per-stage context chip:
`budget: trimmed (N→M tok)` when trimmed, `budget exceeded` alongside the failure.
Graceful absence when no budget data is present.

## Testing

- `fitPromptToBudget` units: under budget → untouched, no event; over budget →
  largest inputs forced path-only until it fits, `budget.trimmed` payload correct;
  minimal context still over → `exceeded` outcome.
- `renderInputContext` `forcePathOnly`: textual input renders metadata + path +
  mandatory-read instruction, `inlinedBytes: 0`.
- Schema: `maxInputTokens` accepted on agent / review-gate / flow spec; rejected on
  command / approval / etc.; stage→flow resolution.
- Integration (`run-flow`, with the macOS non-symlinked `TMPDIR` workaround): tiny
  `maxInputTokens` + oversized input → run completes, `budget.trimmed` recorded,
  prompt contains the path not the content; fixed instructions exceeding a tiny
  budget → attempt fails with `budget.exceeded`.
- Projection + web view model: `attempt.budget` folds; console marker present.

## Risks

1. **Trimming hurts output** if the agent doesn't read the dropped file. Mitigated by
   the mandatory-read instruction (same as the MVP > 8 KB case); the budget is opt-in,
   so only flows that choose it accept the trade-off; `budget.trimmed` makes it
   observable.
2. **`budget.exceeded` → unproductive retries** (a deterministic overflow retries
   identically). Accepted: the error is explicit and attempts exhaust quickly. A
   future refinement could skip retries for budget failures (YAGNI now).
3. **`approxTokens` is coarse** (`bytes/4`); a budget near a real model limit may be
   slightly off. Accepted and labeled `~`; the budget is a guardrail, not a
   billing-exact meter.
