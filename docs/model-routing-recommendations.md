# Runtime/model Pareto recommendations

Nitely does not change a Flow or route production traffic automatically from model experiments.

Create a `nitely.model-routing-experiment.v1` document that pins the Flow digest, the baseline cohort manifest digest, one stage, a finite candidate matrix, and bounded runs/cost/time/tokens. Each candidate points to an ordinary eval cohort manifest and its `nitely.eval-report.v1` output. Run:

```sh
nitely eval recommend routing-experiment.json --repo . 
```

The command emits `nitely.model-routing-recommendation.v1`. It rejects forged manifest/run lineage, mismatched task contracts, incomplete case evidence, failed cohort thresholds, unknown cost (unless the policy allows it), and evidence outside the declared budget. It compares scoring and reviewable-PR/gate rates as higher-is-better, and retries, human rework, incomplete outcomes, latency, and cost as lower-is-better. Costs are compared only when their provenance class (actual or estimated) matches.

The result contains every candidate’s config hash, lineage, metrics, coverage, exclusion reason, Pareto membership, and an expiry/re-evaluation condition. A single frontier candidate is a recommendation; ties or insufficient coverage remain `insufficient_data`.
