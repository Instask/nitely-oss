# Factory metrics

Nitely's canonical factory metrics are derived from persisted work-item and run
projections. The Web Console exposes them under `dashboard.factoryMetrics`, and
the CLI exports the same shape with:

```sh
nitely metrics --repo /path/to/repo --json
```

The lifecycle funnel is:

```text
candidate → eligible → queued → run started → PR created → review requested → merged
```

`candidate` is a persisted work item; `eligible` is a non-draft work item;
`queued` is a `ready` work item; run and PR counts come from durable run
projection data. Merge counts use provider status only when it is known.

The report also includes human approval events and measured approval wait time,
agent/Judge/CI attempt counts, rework and escalation counts, runtime cost, and
context tokens. Cost and timing fields carry coverage metadata. Missing provider
cost, queue timestamps, PR creation timestamps, merge history, or manual-edit
signals are reported as unknown/unavailable rather than zero or inferred.

`automationYield` remains unavailable until Nitely can reliably distinguish
governed rework from manual source edits. This prevents a throughput dashboard
from overstating autonomy.
