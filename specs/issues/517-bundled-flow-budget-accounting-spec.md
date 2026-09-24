# Issue 517 Spec: Budget Accounting Excludes Cache Reads

## Background

A Task against the bundled `flows/implement-spec-bootstrap.json` died at its
first stage on the default runtime token cap, before completing a single stage.
Run `2026-08-30T142227983Z-022c3249` failed at `write-tests` attempt 1 with
`2239828 tokens used of 2000000`. The stage had already written `tests.md`,
added 18 tests, confirmed they fail red, and passed `tsc`. The work was lost to
the cap, not to an error.

#487 shipped that 2M default deliberately and it fired exactly as designed. The
question was whether the bundled flows are simply too expensive for it. The
recorded usage event answers that:

```
inputTokens        2,216,578
cachedInputTokens  2,062,336   (93.0% of input)
outputTokens          23,250
totalTokens        2,239,828
```

Uncached input plus output is **177,492** tokens — 7.9% of the number that
tripped the cap. The stage did not overspend. `runtimeTokenCountForBudget`
charges cache reads at full weight, so `maxRuntimeTokens` measures how much
context was re-sent across turns rather than how much work was bought. Cache
reads are the cheapest tokens a provider sells; counting them at parity with
fresh input makes a long, healthy, well-cached stage indistinguishable from a
runaway one.

Both adapters already record the split and both discard it before the budget
sees it. `parseCodexUsage` keeps `cached_input_tokens` in `raw` only.
`parseClaudeUsage` sums `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` into a single `inputTokens`.

A second, independent defect surfaced in the same run. `completedStages` was
empty even though the stage had produced its artifacts, because
`assertHardBudgetConsumption` runs immediately after runtime usage is recorded
and throws before `recordGeneratedMarkdownArtifact` and
`persistArtifactRegistry` ever run. Raising a budget and resuming therefore
repeats work that was already finished and paid for.

## User Stories

- **US-001:** As an operator, a stage whose cost is mostly cached context is
  not stopped as if it had spent that much on fresh work.
- **US-002:** As an operator reading a budget failure, I can see both the
  billable total that was enforced and the cached total that was excluded, so
  the number is interpretable without opening the event store.
- **US-003:** As an operator on a runtime that reports no cache split, my
  budgets keep behaving exactly as they do today.
- **US-004:** As an operator whose run stopped on a budget, an agent stage that
  had already produced its declared artifacts stays recorded as complete, so
  the completion is not silently withdrawn from the run's history.
- **US-005:** As a flow author, the documented meaning of `maxRuntimeTokens`
  matches what the runtime enforces.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a stage reporting 2,216,578 input tokens of which
  2,062,336 are cache reads, and 23,250 output tokens, when the run budget is
  2,000,000, then the run does not fail: the enforced total is 177,492.
- **US-001 / SC-002:** Cache **creation** tokens stay inside the enforced
  total. They are billed at a premium, not a discount.
- **US-002 / SC-001:** A `budget.exceeded` event for runtime tokens carries the
  enforced total and the excluded cache-read total.
- **US-002 / SC-002:** The run's `budgetSummary` reports both totals.
- **US-003 / SC-001:** Given usage with no recorded cache-read figure — an
  older run's persisted event, or a runtime that does not report one — the
  enforced total is unchanged from today's behaviour.
- **US-003 / SC-002:** A runtime reporting no usage at all keeps failing closed
  under a declared budget and keeps not failing closed under a defaulted one,
  exactly as #487 specified.
- **US-004 / SC-001:** Given an agent stage that produces its declared
  artifacts and then crosses a hard budget on the consumption check, then the
  artifacts are registered and the stage is recorded complete before the run
  fails.
- **US-004 / SC-002:** No `stage.failed` is emitted for that stage. `projectRun`
  deletes a stage from `completedStages` on `stage.failed`, so emitting one
  would withdraw the completion the stage earned.
- **US-004 / SC-003:** The run still fails, with `run.failed` carrying
  `reason: "budget_exceeded"`. The stage did not fail; the run did.

## Functional Requirements

- **FR-001:** Add `cachedInputTokens` as a first-class optional field on
  `AgentRuntimeUsage`, distinct from the adapter-specific `raw` payload.
- **FR-002:** `parseCodexUsage` populates it from `cached_input_tokens`.
  `parseClaudeUsage` populates it from `cache_read_input_tokens`. Both keep
  their existing `raw` payloads unchanged.
- **FR-003:** `runtimeTokenCountForBudget` subtracts `cachedInputTokens` from
  the token total it returns, flooring at zero. Cache creation is not
  subtracted.
- **FR-004:** When `cachedInputTokens` is absent, the enforced total is the
  current `totalTokens`-or-`inputTokens + outputTokens` figure. Persisted
  events written before this change keep the meaning they were written with.
- **FR-005:** Runtime-token `budget.exceeded` events and the run's
  `budgetSummary` carry the excluded cache-read total alongside the enforced
  total.
- **FR-006:** Register an agent stage attempt's artifacts before the
  consumption-phase hard budget check can fail the run, so a stage that
  finished its work is recorded as complete. The breach is still detected, and
  its `budget.exceeded` event still appended, at the moment it happens; only
  the throw is deferred.
- **FR-007:** When a budget breach is raised after the stage completed, neither
  `stage.failed` nor `invalidateCompletedStagesFrom` runs for it, in both the
  initial-run and resume paths.
- **FR-008:** Document in both READMEs and the flow authoring guide that
  `maxRuntimeTokens` bounds uncached runtime tokens, and record the measured
  per-stage cost of the bundled flows.

## Non-Functional Requirements

- **NFR-001:** The bundled flows keep declaring no `budgets`. #487 put this out
  of scope because a declared budget fails closed on `grok`, `glm`, and `pi`,
  which report no usage; that reasoning still holds. With FR-003 in place the
  2M default already accommodates roughly eleven stages of the measured size,
  so no declaration is needed.
- **NFR-002:** The cache-read exclusion is computed in one place, shared by the
  budget check, the budget summary, and the evidence surfaces.

## Out Of Scope

- Removing or raising `DEFAULT_MAX_RUNTIME_TOKENS`. #487's fail-closed default
  is the reason this was visible at all, and the measured cost does not
  justify moving it.
- Weighting cache reads by a provider price ratio. That puts pricing
  assumptions in the runtime; exclusion is provider-neutral.
- Enforcing #490's declared read bounds, which is the lever that would reduce
  the 2.2M of re-sent context rather than account for it correctly. Tracked in
  #529.
- Resuming a run that stopped on a budget. FR-006 and FR-007 keep the stage's
  completion in the run's history, which is a precondition for resuming past
  it. Resume of a budget-stopped run is specified in #537.
- Gate and command stages. Both still raise a consumption breach before their
  caller records completion, so both can lose finished work the same way. The
  gate path returns its result to a caller that performs the completion, so
  deferring there means threading the failure through the return value rather
  than reusing the agent path's local defer. Tracked in #538.
- Model tiering (#468) and rework oscillation (#472).

## Assumptions

- Cache reads are materially cheaper than fresh input on every runtime Nitely
  supports, so excluding them cannot understate spend enough to matter.
- A runaway agent grows uncached input and cache creation as it pulls new
  content into context, so the cap still bounds the failure mode #487 was
  opened against.
