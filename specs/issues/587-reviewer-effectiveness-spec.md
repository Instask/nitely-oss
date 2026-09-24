# Issue 587: Reviewer-effectiveness replay

## Contract

`nitely.eval-cohort.v1` cases may declare `reviewEvaluation`. The declaration
references pinned ordinary eval inputs for the candidate diff, approved spec,
technical design, and deterministic evidence. It also pins one or more
reviewer stage ids and keeps the expected defects in the eval manifest only.

Expected defects contain a stable id, category, severity, description,
optional path/line and requirement, and provenance. A case may be marked
`knownGood`; a known-good case has no expected defects and is used to measure
false positives.

Cases may also retain `acceptedHumanFindings`, each tied to an expected defect
with its human evidence. This preserves historical calibration evidence
without exposing the finding to the reviewer.

The replay planner validates every review input id and requires each reviewer
stage to be a review gate or Judge. The ordinary `RunFlowInput` contains only
the pinned production inputs. Gold findings, historical conclusions, and
implementation-agent reasoning are never added to reviewer context.

## Scoring

The report reader reuses `gate.completed` review output and `judge.completed`
structured output. It normalizes findings to id, category, severity,
location, requirement, evidence, and verdict impact. Matching is conservative:
explicit defect ids win; unique path/category/requirement hints are retained as
deterministic matches; ambiguous and unmatched findings remain visible.

Each case records the matches, missed defect ids, false positives, verdict, and
provenance for source revision, Flow/context digests, manifest digest,
reviewer runtime/model, latency, and available usage/cost.

Cohort summaries keep separate dimensions for critical-defect recall, overall
defect recall, false-positive count/rate, pass-on-defective rate, fail-on-
known-good rate, category counts, sample coverage, and reviewer samples.
Optional cohort thresholds compare these dimensions without collapsing them
into one quality score. Missing usage remains unknown under the existing #429
rules.

## Non-goals

- semantic model matching without retained evidence;
- automatic reviewer switching or production policy changes;
- arbitrary mutation generation;
- replacing deterministic verification or human review.
