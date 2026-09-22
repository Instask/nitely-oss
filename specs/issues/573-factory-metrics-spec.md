# Issue 573: Factory metrics

## Contract

`dashboard.factoryMetrics` and `nitely metrics --repo <path> --json` expose the
same `nitely.factory-metrics.v1` data model. It contains:

- funnel counts and rates for candidate, eligibility, queue, run, PR, review,
  and merge stages;
- human approval events, measured approval wait, and coverage;
- agent/Judge/CI attempts, Judge rework loops, escalations, and post-publish
  rework;
- runtime cost, context tokens, and cost coverage;
- per-dimension coverage explaining unavailable timing, merge, cost, or manual
  edit data.

The source of truth is persisted work-item/run state and projected run events.
No metric treats missing provider cost as zero. Queue, PR, merge, and human
minutes are omitted or marked unknown when their event boundaries are absent.

## Canonical automation yield

The product definition remains “merged Nitely-produced changes requiring no
manual source edits outside governed Nitely rework divided by runs reaching
implementation.” The first slice deliberately leaves this value unavailable
because manual-edit detection is not yet durable enough to defend.

## Surfaces and verification

The existing Manager Dashboard renders a compact factory funnel card. The API
returns the full dashboard object, while the CLI emits the machine-readable
report for local pilots and future hosted aggregation. Tests cover synthetic
candidate/eligible/queued/PR/merge histories, approval timing, rework/cost
coverage, and CLI export.
