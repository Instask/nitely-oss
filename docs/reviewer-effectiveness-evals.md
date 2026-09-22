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
