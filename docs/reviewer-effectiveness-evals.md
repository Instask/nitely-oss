# Reviewer-effectiveness evaluations

Nitely can measure a review gate or Judge against replayable cases through the
existing eval/replay cohort machinery. A case adds `reviewEvaluation` to its
`nitely.eval-cohort.v1` entry:

```json
{
  "reviewEvaluation": {
    "reviewerStageIds": ["review"],
    "candidateDiff": {"inputId": "candidate-diff"},
    "approvedSpec": {"inputId": "spec"},
    "technicalDesign": {"inputId": "design"},
    "deterministicEvidence": [{"inputId": "test-output"}],
    "acceptedHumanFindings": [{
      "defectId": "missing-authz",
      "evidence": "human review identified the missing authorization"
    }],
    "knownGood": false,
    "expectedDefects": [{
      "id": "missing-authz",
      "category": "authorization",
      "severity": "critical",
      "description": "the changed endpoint omits authorization",
      "file": "src/api.ts",
      "provenance": "deliberately-seeded"
    }]
  }
}
```

All referenced ids must already be pinned under the case's `inputs`; their
paths and SHA-256 digests are therefore immutable. The reviewer receives the
same production inputs as the replayed Flow. Expected defects are scoring data
and are not supplied to the run.

Run and compare cases with the existing commands:

```text
nitely eval run <manifest> --repo <path> --case <id>
nitely eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path>
```

The resulting case/sample and cohort report retain match evidence, misses,
false positives by known-good and defective case, category counts, critical and
overall recall, pass-on-defective, fail-on-known-good, runtime/model, latency,
and available usage or cost. Configure reviewer comparison thresholds in the
cohort manifest, for
example `reviewerCriticalRecall` with an absolute decrease limit or
`reviewerFalsePositiveRate` with a relative increase limit.

Ambiguous matches are not silently credited. Historical production and human
findings are preferred; realistic seeded or mutation defects supplement them.

## Reviewer scorecards and matched comparison

`src/eval/reviewer-scorecard.ts` builds an operational benchmark on top of the
case scores above. It does not change how a case is scored.

- `assessReviewerCorpus(cases)` reports whether a corpus can serve as a
  baseline: at least 20 review cases, at least one defective and one
  known-good case, and at least two defect categories. It also counts defect
  provenance and how many defective cases carry accepted human findings.
- `buildReviewerScorecard(...)` produces a `nitely.reviewer-scorecard.v1`
  document for one reviewer configuration (runtime, model, Flow sha256 and
  optional prompt sha256) and one measurement window. It reports P0 recall,
  P0+P1 recall, overall recall, false-positive rate, pass-on-defective and
  fail-on-known-good, each with its numerator, denominator and a 95% Wilson
  interval. Empty denominators stay undefined instead of reading as 0 or 1.
  Critical misses and ambiguous matches are listed explicitly; a defective
  case with no reviewer output counts as a miss in recall and as a wrongful
  pass in pass-on-defective, and a known-good case without a pass
  verdict counts as a failure. Cost is classified per case as actual,
  estimated or unknown; unknown cost is never summed as zero.
- The scorecard keeps only ids, counts and hashes. Finding text, evidence
  and file contents are dropped so a scorecard can be published from CI.
  `reviewerScorecardSha256` gives it a stable digest.
- `compareReviewerScorecards(...)` compares two scorecards only on matched
  cases. Each case outcome carries `groundTruthSha256`, a hash of the
  known-good flag and every gold defect's id, severity and category; a case
  is matched only when its id and ground-truth hash agree. If a case present
  in both scorecards has different ground truth, it is listed in
  `groundTruthMismatchCaseIds` and the comparison is `insufficient-evidence`
  with a reason, since the annotations, not the reviewers, changed. Per
  defect and per known-good case it counts discordant pairs and applies an
  exact two-sided sign test. The result is always advisory. It reports
  `insufficient-evidence` below 20 matched cases or 5 discordant pairs, and
  `advisory-regression` / `advisory-improvement` only when the difference is
  significant at 0.05. Human review stays required for high-risk or protected
  diffs regardless of the result.
