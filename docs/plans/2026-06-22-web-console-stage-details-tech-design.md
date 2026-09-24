# Web Console Stage Details Tech Design

## Goal

Make every Web Console pipeline stage expandable by returning structured stage
details from the run detail API and rendering those details in the static console.

## Existing Behavior

- `src/web/runs.ts` returns `timeline` items with base stage metadata, paths,
  usage, and `hasLogs`.
- `src/web/static/console.dc.html` decorates timeline items into UI stages.
- `toggleStage` currently returns early unless the stage has stdout/stderr.
- The UI only renders stdout/stderr inside the expanded panel.

## Design

### API Shape

Extend `WebSessionTimelineItem` with:

```ts
details?: {
  fields: { label: string; value: string; href?: string; mono?: boolean }[];
  prompt?: string;
  stdout?: string;
  stderr?: string;
  artifacts?: { id: string; label: string; path?: string }[];
  events?: { type: string; at: string; attempt?: number; summary?: string }[];
}
hasDetails: boolean;
```

The structure is intentionally presentation-friendly but still typed and stable.
It lets the client render stage details without inferring from raw logs.

### Detail Sources

For projected runs:

- Use `ProjectedStage` and latest `ProjectedAttempt` for stage id/type/status,
  attempts, timestamps, paths, runtime/model, budget, and usage.
- Aggregate existing projected logs per stage for command/stdout/stderr details.
- Read `prompt.md` from the latest attempt directory when present.
- Include artifacts from the run artifact registry whose producer matches the
  stage id.
- Read raw run events from the event store for stage-scoped summaries. Include
  command, gate, orchestrator, and change publication/update events.

For fallback filesystem-only runs:

- Keep the existing timeline and logs behavior.
- Mark stages as expandable and return basic fields plus stdout/stderr where
  available.

### UI Behavior

- Always show a chevron for pipeline rows with `hasDetails`.
- `toggleStage` toggles any stage that has details.
- Expanded panels show:
  - metadata fields in a compact grid;
  - prompt in a scrollable markdown/text block;
  - stdout/stderr in the existing terminal blocks;
  - produced artifacts;
  - event summaries.

### Testing

Add `test/web/runs.test.ts` coverage for an event-projected agent stage with:

- no stdout/stderr logs;
- a `prompt.md`;
- runtime/model metadata;
- a generated artifact.

Assert the returned timeline item has `hasDetails`, prompt text, runtime/model
fields, and artifact detail data.

Update static console tests to lock in the client behavior that `toggleStage`
does not require stdout/stderr.
