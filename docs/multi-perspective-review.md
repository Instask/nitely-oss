# Multi-Perspective Review

A single reviewer misses things. Independent reviews of the same change
produce findings that barely overlap, so one review gate that passes is weak
evidence that the change is safe. A multi-perspective review runs two or three
reviewers whose job is to *refute* the change from a fixed angle, and collapses
their answers into one gate decision.

The topology stays static: the perspectives are ordinary `review` gates
declared in the flow, and one `review-aggregate` gate consumes their outputs.
There is no dynamic fan-out and no voting configuration.

Use the built-in flow:

```bash
node dist/index.js run flows/pilot-approved-spec-pr-multi-review.json \
  --repo . \
  --input spec=specs/feature.md \
  --input tech-design=docs/plans/feature.md
```

It runs three perspectives — correctness, security, and spec conformance —
before the publish stage, and publishes only when all three approve.

## Perspective Stages

A perspective is a normal review gate with `blocking` set to `false`:

```json
{
  "id": "review-security",
  "type": "gate",
  "mode": "review",
  "runtime": "codex",
  "blocking": false,
  "prompt": "Review only for security. ... Write `Review verdict: approved` only when you found no P0/P1 security defect.",
  "inputs": ["implementation", "verification-report"],
  "outputs": ["review-security"]
}
```

`blocking: false` means this reviewer's own verdict does not stop the run, so
every perspective gets to run and the operator sees every finding at once
instead of one per rework cycle. The verdict is not discarded: it is recorded
on the gate result as `advisoryReason` and shown in run evidence.

`blocking` only downgrades a *verdict*. A perspective that could not run at
all — runtime failure, missing output, an output that is not text — still
fails its stage, because a reviewer that never spoke must never read as a
reviewer with nothing to say.

Give each perspective a narrow brief and tell it which concerns belong to the
other reviewers. Overlapping briefs produce three copies of the same finding
and no independent coverage.

## The Aggregate Gate

```json
{
  "id": "review",
  "type": "gate",
  "mode": "review-aggregate",
  "name": "Aggregated review",
  "perspectives": ["review-correctness", "review-security", "review-spec-conformance"],
  "inputs": [
    "spec",
    "task-plan",
    "implementation",
    "review-correctness",
    "review-security",
    "review-spec-conformance"
  ],
  "outputs": ["review"]
}
```

`perspectives` lists the review outputs to aggregate, at least two, and every
id must also appear in `inputs`. The remaining inputs are the reviewed
artifacts; the gate uses them to route rework at the work rather than at the
reviewers.

The gate writes one Markdown report — the merged verdict, a line per
perspective, and the deduplicated union of every perspective's findings — and
records it as the stage output. Downstream stages consume that one artifact,
so `publish-change` still takes a single review input.

## Aggregation Rules

The decision is intentionally the simplest rule that is still safe:

- Every declared perspective must state `Review verdict: approved`.
- A perspective that produced no output is blocked.
- A perspective whose output states no verdict is blocked.
- A perspective that approves but still raises a P0/P1 finding is demoted to
  `needs_fix`. Merging findings means failing closed on any critical finding,
  including one the reviewer who found it was willing to live with.
- When blocked, the gate routes with the most severe perspective verdict
  (`escalate` > `needs_rework_spec` > `needs_fix`) and carries that
  perspective's `Target stage`, `Target artifact`, and `Instructions` lines.

A blocked aggregate fails its stage through the same gate and verdict
mechanism as a single review gate, so retry, rework, and escalation policy are
unchanged, and publish is blocked by the ordinary stage dependency.

## Why Aggregation Stays Simple

There is no voting DSL in flow JSON — no weights, no quorum, no per-signal
severity thresholds, no tie-breaks. That is a decision, not an omission:

- **Fail-closed is the only defensible default for a release gate.** A quorum
  rule exists to let a change ship while a reviewer objects. Deciding when
  that is acceptable is a human judgment about a specific objection, and the
  flow author writing the JSON is not in the room when it happens. The
  operator override and escalation paths already handle it, with an audit
  trail that a `2/3` in a config file would not leave.
- **A voting rule is a second place where review policy lives.** Coverage is
  already expressed in the topology: which perspectives exist, what each one
  reviews, and what its prompt tells it to refute. Splitting the policy
  between the stage list and a weighting table makes both harder to read and
  lets them disagree.
- **Configuration that is never exercised is not trustworthy.** A quorum
  branch fires on exactly the runs nobody watches. Static topology plus
  "everyone approves" is the path every run takes, so it is the path that
  stays correct.

If a perspective is too noisy to block on, that is a prompt problem or a
perspective that should not exist. Remove it or narrow its brief; do not
give it a smaller vote.

## Related

- `docs/flow-authoring-guide.md` — stage and artifact contracts.
- `docs/risk-based-review-policy.md` — how much human review the resulting
  change request needs.
