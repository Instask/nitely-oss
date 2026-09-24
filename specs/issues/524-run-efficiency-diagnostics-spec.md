# Issue 524 Spec: Run Efficiency Diagnostics and Outcome Unit Economics

## Background

Nitely already shows aggregate tokens/cost (#120 / #230) and eval cohorts
compare cost (#429). It does not explain why one run was wasteful or
denominate cost by accepted outcomes. #517 recorded a small task whose first
stage consumed 2.2M input tokens while assembled context was about 2.3K.

## First slice

- CLI diagnostic for one run, derived from that run's events and projection.
- Read-only dashboard unit economics by Flow / runtime / model, from existing
  run summaries. The Web request path does not load unbounded raw logs.

## Diagnostic findings

Each finding has a stable `ruleId` and `version`, severity, measured impact,
confidence, cited events/artifacts, and a concrete remediation or linked
issue. Missing telemetry is `unknown`, not zero.

Initial rules:

- `runtime-input-amplification` — runtime input grew far beyond assembled
  context (#517 / #529).
- `cold-session-repeat` — later attempts started cold when a session id was
  already recorded (#488).
- `retry-rework-share` — retries, rework, or oscillation consumed a
  disproportionate share (#472).
- `expensive-model-non-gate` — a high-cost model on a non-quality-deciding
  stage relative to recorded runtime/model (#468).
- `repeated-large-payloads` — repeated large tool/artifact payloads when
  telemetry supports the claim; otherwise unknown.
- `usage-coverage-missing` — provider usage or cost coverage missing (#429).
- `budget-loss-after-outputs` — budget exhaustion after declared outputs
  already existed (#517 / #537).

## Outcome unit economics

Where evidence and coverage permit, report cost (or tokens/latency) per:

- completed run
- reviewable PR
- accepted or merged PR
- successful review gate
- accepted outcome
- retry/rework share

Every ratio exposes numerator, denominator, sample count, coverage
classification (`actual` / `estimated` / `partial` / `unknown`), and evidence
run IDs. Partial actual cost is never combined with unknown attempts as if it
were complete. Same-PR rework is one reviewable PR. A resumed run is one run.

## Non-goals

- Billing or employee chargeback.
- A provider price table presented as exact actual cost.
- Automatic model/Flow changes.
- Ranking individual engineers by spend or output.
