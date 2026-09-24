# Issue 523 — Runtime/model Pareto recommendations

## Contract

`nitely.model-routing-experiment.v1` is a bounded companion manifest to the existing `nitely.eval-cohort.v1` replay contract. It pins:

- the Flow path and digest, baseline manifest digest, and target stage;
- a finite set of runtime/model candidates, each referencing an ordinary cohort manifest and report;
- maximum candidate count, replay count, runtime cost, duration, and tokens;
- minimum scoring/reviewable-PR policy and cost/completeness policy;
- optional expiry and provider-version re-evaluation metadata.

Candidate cohort manifests must keep the same source, inputs, context, scoring, gates, sandbox, non-target stages, and execution environment. Only the selected runtime/model may vary. Reports must prove candidate and baseline manifest hashes, complete case/run lineage, and clean coverage.

## Recommendation

`nitely.model-routing-recommendation.v1` records candidate configuration hashes, run lineage, scoring/gate/reviewable-PR rates, retries, human rework, incomplete outcomes, latency, cost provenance, unknown-attempt rate, coverage, frontier membership, and exclusion reasons. Dominance is calculated over comparable observed metrics. A unique non-dominated candidate is recommended; ties, budget exhaustion, unknown evidence, and no feasible candidate remain non-automatic statuses.

The CLI only emits a proposal. It never edits a Flow or production routing configuration. Re-run the bounded experiment when the Flow digest, provider/model version, or recommendation expiry changes.
