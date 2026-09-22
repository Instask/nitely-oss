# Issue 487 Spec: Default-Enforced Runtime Token Budgets

## Background

`spec.budgets.maxRuntimeTokens` exists and is enforced when set. It was opt-in,
and the docs said so. Dogfood `implement-agentaab-cli` set no budget: two runs
consumed about 12.5M Codex input tokens in roughly 40 minutes, the operator had
to SIGKILL the process, and `nitely status` still reported `running` afterwards.

Two separate holes: nothing bounded an unbudgeted run, and a killed runner left
a run that looked alive forever.

## User Stories

- **US-001:** As an operator, a run that declares no token budget still stops
  at a bound instead of spending without limit.
- **US-002:** As an operator, killing the runner leaves a run that reads as
  needing recovery, not as running.
- **US-003:** As a flow author, preflight tells me a `dev.pr` flow declares no
  token budget, and what default will apply.
- **US-004:** As an operator on a runtime that reports no token usage, the new
  default does not fail my runs.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a flow with no `budgets.maxRuntimeTokens`, when
  recorded runtime usage passes 2,000,000 tokens, then the run fails with a
  `budget.exceeded` event carrying the cap, consumed total, remaining
  allowance, and the stage and attempt that crossed it.
- **US-001 / SC-002:** The failure message names
  `NITELY_DEFAULT_MAX_RUNTIME_TOKENS`, so the operator can see the cap was a
  default rather than something the flow chose.
- **US-001 / SC-003:** `NITELY_DEFAULT_MAX_RUNTIME_TOKENS=0` disables the
  default.
- **US-002 / SC-001:** Given a `running` run whose open attempt has had no
  event for longer than the stale threshold, then `nitely status` reports
  `interrupted`.
- **US-002 / SC-002:** A terminal run is never rewritten by staleness, however
  old it is.
- **US-003 / SC-001:** Preflight on a `dev.pr` flow with no
  `maxRuntimeTokens` returns `WARN` with a `missing-token-budget` issue naming
  the default.
- **US-004 / SC-001:** Given a runtime that reports no usage, a defaulted cap
  completes the run instead of failing closed.

## Functional Requirements

- **FR-001:** Apply `DEFAULT_MAX_RUNTIME_TOKENS = 2_000_000` at run scope when
  the flow declares no `budgets.maxRuntimeTokens`.
- **FR-002:** `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` overrides the default; `0`
  disables it.
- **FR-003:** The default applies at run scope only. A per-stage default would
  fail long single stages the operator never bounded, and the run cap already
  bounds the whole run.
- **FR-004:** A declared budget keeps failing closed on unknown runtime usage.
  A defaulted budget does not, because `grok`, `glm`, and `pi` report no usage.
- **FR-005:** The exhaustion message distinguishes a defaulted cap.
- **FR-006:** Add a `missing-token-budget` preflight warning for `dev.pr` flows
  with no declared `maxRuntimeTokens`.
- **FR-007:** `nitely status` downgrades a `running` run whose open attempt has
  gone quiet past the stale threshold to `interrupted`, using the same
  threshold and logic as the Web Console.
- **FR-008:** Document the default and the stale threshold in both READMEs and
  the flow authoring guide.

## Non-Functional Requirements

- **NFR-001:** Retries and resume keep reusing the persisted token ledger; the
  default changes the cap, not the accounting.
- **NFR-002:** The stale threshold logic lives in one place shared by the CLI
  and the Web Console.

## Out Of Scope

- USD cost budgets as a default.
- Automatic model downgrade at the cap.
- Declaring budgets on the built-in flows: a declared budget also fails closed
  on runtimes that report no usage, which would break the bundled `grok` and
  `pi` bootstrap flows.

## Assumptions

- 2,000,000 runtime tokens is high enough not to interrupt healthy runs and low
  enough to stop the failure mode observed in dogfood.
