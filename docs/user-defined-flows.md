# User-Defined Flows

The Web Console lets any logged-in user create, edit, validate, and run custom
flows without editing repository files. Runs created from custom flows appear as
Tasks in the console. Generic work-items remain the internal/extensibility model
behind those tasks (see [work-item-model.md](work-item-model.md)).

## Flow sources

- **Built-in flows**: the JSON files under `flows/`. They are read-only in the
  Web Console and always visible and runnable. Built-in Web/API ids are limited
  to discovered `flows/*.json` entries; absolute paths, `..` traversal, nested
  paths, non-JSON files, and symlinks that resolve outside `flows/` are rejected.
- **User flows**: stored in a local SQLite database (`.nitely/flows.db`), not as
  repository files and not committed to Git. They are created and edited from the
  page.

## Flows decoupled from files

Flow parsing and the artifact graph are derived from the flow *document*, not a
file. `parseFlowDocument(content, options)` parses JSON, validates the schema,
and builds the graph from a string; `loadFlow(path)` is just "read file →
`parseFlowDocument`". A stored flow therefore runs directly from its document:
the runtime accepts a `flowDocument`, records it on the `run.created` event for
resume and audit, and never materializes a flow file.

## Web Console surface

```text
Flows (built-in + user)
  -> New flow (choose a template or start blank)
  -> JSON editor with a live validation panel
  -> stage list preview
  -> Save (user flows)
  -> Run: create a task from the flow, filling its declared inputs
```

Templates: Dev PR, Rework PR, Approval pipeline, Research pipeline.

## Validation

The editor validates with the same logic the runtime uses, plus a save-time
policy guard:

- JSON parse, `flowSchema`, duplicate stage ids, duplicate artifact producers,
  cycles, unsupported stage types/runtimes.
- Agent stages and review gates must declare either `runtime` with optional
  `model`, or an ordered non-empty `runtimes` list. The two forms cannot be
  mixed on the same stage.
- Governance: a high-risk `workItemType` that is not allow-listed or omits a
  required gate is a hard error — the flow cannot be saved or run.

When a stage uses `runtimes`, candidates are attempted in order. Nitely advances
to the next candidate only for external runtime blockers such as usage limits,
missing credentials, missing CLI commands, or launch/setup failures. Normal
stage failures after a runtime completes, including missing declared outputs and
failed review gates, do not trigger runtime fallback.

Review gates are blocking decision points. A review gate fails when its declared
text output starts a line with an explicit failing verdict such as
`Review verdict: fail` or a P0/P1 severity marker such as `### P1 - ...` or
`[P0] ...`. Clean text, `Review verdict: pass`, and P2/P3 advisory findings
pass. Use a plain `agent` review stage instead when the review is intended only
as non-blocking evidence.

Issue-backed flows should end with a non-gating `reflect` agent stage after
`publish-change` or `update-change`. The stage should consume the implementation,
test report, review output, and `change-request` artifact, search existing
GitHub issues before creating follow-ups, and write a `reflection` artifact that
lists created issues, duplicates, non-actions, or a clean result. This final
stage only runs when the flow reaches it; interrupted or failed runs still need a
future finalizer/always-run stage to guarantee reflection after early stops.

Agent runtime credentials are preflighted before spawning the external process.
An unavailable candidate is recorded on that attempt with the runtime id and
safe missing configuration names, then fallback continues when another candidate
is available. If every candidate is unavailable, the stage fails with an
actionable configuration message.

External inputs are inferred as every declared `metadata.inputs` id plus any
stage input that no stage produces, matching how the runtime supplies inputs at
run time. A flow with any validation error is not saveable or runnable.

## API

- `GET /api/flows`, `GET /api/flows/:id`
- `POST /api/flows/validate` — validate a document without persisting.
- `POST /api/flows`, `PUT /api/flows/:id`, `DELETE /api/flows/:id` — user flows.
- `GET /api/flows/templates`
- Running a flow currently reuses the compatibility `POST /api/work-items`
  endpoint, which persists an internal generic work item and surfaces it through
  `/tasks`. The endpoint accepts a built-in `flowPath` such as
  `flows/rework-pr-bootstrap.json` or a stored user `flowId`.

## Permissions

Any logged-in user may create, edit, run, and delete flows. Local mode is
unrestricted.
