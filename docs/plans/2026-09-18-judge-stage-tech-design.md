# Judge Stage — Technical Design

Add `type: "judge"` as a runtime-backed Flow stage with `criteria`, an optional
`onRework` stage id, and a `maxRework` budget. The stage reuses the existing
agent execution path for context delivery, redaction, capability checks,
runtime fallback, usage accounting, retries, resume, and output registration.

After outputs are registered, the runner parses the first output with
`parseJudgeResult`. A PASS records normal stage completion. REWORK produces an
existing structured `ReworkRequest`; its target is checked against the graph
and `decideStagePolicy` enforces the judge budget. HUMAN_REVIEW escalates and
does not invoke a downstream publish stage.

The verdict is emitted as `judge.completed` and included in stage detail event
summaries. The output artifact remains the source of full findings/evidence,
so no parallel judge storage model is needed.
