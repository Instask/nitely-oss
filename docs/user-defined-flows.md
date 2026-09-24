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

## Artifact-first dependency model

Stages do not declare separate graph edges. The DAG is derived from artifact
contracts:

- `metadata.inputs` declares external artifacts supplied by the operator or
  connector.
- a `metadata.inputs[]` entry may include exactly one default source:
  `source` (`{ "connector": "...", "uri": "..." }`), `sourceUrl`/`source_url`,
  or `artifactUri`/`artifact_uri`;
- each stage declares `outputs`, either as a string id or as an object with
  `id`, `name`, `type`, `description`, `mediaType`, `schema`, and `version`;
- each stage declares `inputs` by artifact id;
- an input that matches an upstream output creates a stage dependency;
- an input that matches `metadata.inputs` is treated as an external input.

Flow validation exposes the derived `artifactGraph` with stage order, stage
edges, artifact producer, and artifact consumers. User-flow detail responses
include the same graph, so the Web Console can preview the producer/consumer
contract without running the flow.

For compatibility with older flows, save-time validation still treats an
unproduced stage input as an implicit external input. Production flows should
declare those inputs in `metadata.inputs`; otherwise the graph marks the
artifact as `implicitExternal`.

Default-source inputs let one flow consume artifacts from outside the current
flow without asking the operator to attach the same input for every run.
`sourceUrl` downloads an `http` or `https` URL at run start. `artifactUri` reads
a previous local run artifact by URI, for example
`nitely-artifact://run-20260708/review`. Explicit run inputs still override the
flow default. Runtime evidence records the imported artifact's source URI,
content hash, fetched timestamp, snapshot path, and previous run/flow origin
when known. The local OSS runner only accesses resources available to that
runner; it does not enforce or imply cross-tenant permissions.

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
policy guard. For production authoring conventions and advisory lint warnings,
see [flow-authoring-guide.md](flow-authoring-guide.md).

- JSON parse, `flowSchema`, duplicate stage ids, duplicate artifact producers,
  cycles, unsupported stage types/runtimes.
- Agent stages and review gates must declare either `runtime` with optional
  `model`, or an ordered non-empty `runtimes` list. The two forms cannot be
  mixed on the same stage.
- Governance: a high-risk, approval-required, denied, or unclassified protected
  `workItemType` is a hard error until `.nitely/work-item-policy.json` and the
  flow gates satisfy policy — the flow cannot be saved or run.
- High-risk agent and review-gate stages must declare `capabilities`; runtime
  and model allow-lists are enforced locally, while path/command/network and
  instruction-source controls are recorded as effective policy for review.
- Production lint warnings are reported separately from errors. Warnings do not
  block saving or running, but they call out broad stages, weak structured
  artifact descriptions, missing command timeouts, secret-like prompt or command
  values, and publish/update stages that lack review or verification evidence.
- The validation report includes `artifactGraph.order`, `artifactGraph.edges`,
  and `artifactGraph.artifacts`. Each artifact entry includes `id`, optional
  descriptive fields, `producer`, and `consumers`.
- Stages that declare `taskPlan` must also list the configured task-plan
  artifact in `inputs`. This keeps the derived graph ordered so
  `execute-current`, `verify-advance`, and `final` roles can coordinate the
  loop.

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
Typed review verdicts can route repair work instead of blindly retrying the
review. Use `Review verdict: needs_fix` with `Target artifact: implementation`
or `Target stage: implement` to route back to code repair; use
`Review verdict: needs_rework_spec` with a planning/spec target stage to route
requirements rework; use `Review verdict: escalate` when the result needs human
judgment. Optional `Reason:`, `Instructions:`, and `path/to/file.ts:12: issue`
lines are preserved in rework evidence and target-stage context.

When every configured runtime for a review gate is unavailable or usage-limited,
a qualified operator can attach the same verdict format with
`nitely review-verdict`. The reviewed artifact list must exactly match the
gate's declared inputs, and Nitely persists operator identity plus the original
blocker in gate evidence. Submission alone does not continue the run. A later
explicit `resume` consumes the manual result on the blocked attempt: pass may
continue to publish, while fail/P0/P1 stops before publish. This is an audited
fallback for completed human review, not a substitute for waiting or configuring
another runtime when no qualified reviewer is available.

Verification-like command and deterministic gate stages are diagnosed before
retry/rework policy runs. Stages whose id, command, or output metadata looks
like verification, tests, E2E, build, lint, typecheck, conformance, acceptance,
or smoke checks emit `verification.failure.diagnosed` on failure. High-confidence
code failures route to the implementation artifact producer; high-confidence
requirements failures route to the spec/planning producer; environment-looking
failures retry the same stage first; repeated low-confidence failures escalate
instead of looping. Run evidence includes a `Verification Diagnoses` section,
and the Web console stage details summarize the classification, confidence,
target stage/artifact, and recommended action.

The Web console summarizes review severities from those finding-shaped lines and
explicit no-issue/pass text, not from incidental prose that merely mentions
labels such as P0 or P1.

Issue-backed flows should declare a non-gating `reflect` agent stage with
`alwaysRun: true`. The runtime skips that stage during the main stage sequence
and runs it as a terminal finalizer after success, failure, or blocker states
when execution context is still available. The stage should consume the
implementation, test report, review output, and `change-request` artifact,
search existing GitHub issues before creating follow-ups, and write a
`reflection` artifact that lists created issues, duplicates, non-actions, or a
clean result. If reflection cannot run, Nitely records a `reflection-skipped`
artifact with the safe reason.

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

## Comment-triggered PR rework

`nitely pr-comments` defaults to `flows/rework-pr-bootstrap.json`. Feedback
routed to implementation uses that flow unless another default is supplied with
`--flow`. Feedback routed to approval-required artifacts can use explicit
route-specific flows after the operator approves those routes:

```sh
nitely pr-comments 123 --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --approve-required-routes \
  --route-flow spec=flows/rework-spec-bootstrap.json \
  --route-flow tech-design=flows/rework-tech-design-bootstrap.json \
  --route-flow workflow=flows/rework-workflow-bootstrap.json
```

When a routed item has no matching `--route-flow`, Nitely falls back to the
default `--flow` path.
If the proposed route is wrong, reprocess the pending comment with
`--route-override <comment-id>=<route>`. For example,
`--route-override 123456789=implementation` changes only that comment's route
before execution while preserving the normalized feedback lineage.

## Permissions

Any logged-in user may create, edit, run, and delete flows. Local mode is
unrestricted.
