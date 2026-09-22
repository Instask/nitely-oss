# Issue #525 — Skill improvement proposals

Nitely records recurring, skill-linked run papercuts as
`nitely.skill-papercut.v1` observations. A proposal is generated only when at
least three distinct runs are operator-confirmed for the same repository, flow,
stage, exact skill id, exact skill content hash, and deduplication key.

The generated `nitely.skill-improvement-proposal.v1` contains bounded evidence,
run lineage, a minimal diff, expected behavior, risks, and before/after eval
cases. Pinned #429 cases can be used as the eval source. Observations from
different repositories or skill versions never merge, and inferred-only or
single-run evidence cannot trigger a proposal.

Proposals are data only: Nitely never edits or publishes a skill automatically.
An operator decision is recorded in the audit trail. Application additionally
requires the exact current skill hash, sufficient eval coverage, passing evals,
and no regression; stale source, weak coverage, failed eval, or regression
blocks application. Applied proposals can be explicitly rolled back, also with
an audit entry. Evidence fields are bounded and redacted before persistence.
