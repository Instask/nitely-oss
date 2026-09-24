# Issue 429: Executable Eval/Replay Cohorts

## Problem

Nitely preserves run evidence and a reproducibility snapshot, but the snapshot
is descriptive. Operators cannot validate a pinned corpus before replaying it,
run that corpus through the ordinary Flow engine, or compare a candidate cohort
with a baseline using delivery outcomes already present in the event log.
Provider usage is also optional and cost provenance is ambiguous: an estimated
price and a provider-reported charge must never be compared as if they were the
same observation.

## User-visible behavior

- Operators define a versioned cohort manifest made of immutable eval cases.
- Every case pins a full source commit, Flow document hash, input content hashes,
  selected runtime/model candidates, execution backend, Codex sandbox policy,
  and the canonical effective context-policy hash.
- Replay planning validates all pinned files and the repository revision before
  execution. Missing, mutated, diagnostic-only, undeclared-nondeterministic, or
  otherwise incompatible inputs are rejected with deterministic findings.
- Planner reads of the pinned Flow, inputs, and baseline reproducibility file
  are bounded and descriptor-safe on supported platforms. They reject path
  escape plus identity or metadata changes during access. Flow and input reads
  also reject consumed-byte digest mismatches; the baseline read requires a
  non-symbolic path and a single-linked regular file.
- Replay execution delegates to the ordinary `runFlow` path and records an
  `eval.replay.linked` event on that ordinary run. It does not create a second
  runner, event database, or analytics store. A fresh invocation UUID is
  recorded by both `run.created` and the eval link, so unrelated or raced
  evidence with the same run id cannot be claimed by the replay. The
  `run.created` copy also keeps eval resume fail-closed if the process crashes
  before the link event is appended.
- Provider usage observations are normalized with provider/source provenance.
  Provider-reported charges are classified as `actual`; calculated charges are
  classified as `estimated`; missing usage stays unknown rather than zero.
- Built-in local Codex and Claude launchers populate this seam from their
  machine-readable success envelopes. Codex contributes provider-reported token
  counts; Claude contributes provider-reported token counts and actual cost when
  supplied. GLM has no trusted adapter and remains unknown.
- Secret detection treats unrecognized keys containing `token`, including
  plural or suffixed forms such as `accessTokensList`, as sensitive by default.
  Only explicitly allowlisted usage-counter names paired with non-negative safe
  integers, such as `inputTokens`, `outputTokens`, and `cachedInputTokens`,
  remain visible.
- A cohort report derives reviewable-PR rate, expected-gate pass rate, retries,
  human rework, terminal latency, and actual/estimated cost from ordinary run
  events. Raw provider metadata is redacted before it can enter a run event or
  report.
- Comparing a candidate cohort with its baseline emits versioned JSON and a
  non-passing regression status when configured thresholds are exceeded. The
  report carries both canonical manifest digests and the selected case-to-run
  lineage, and a replay that completes after an approval resume remains part of
  the cohort.
- `--output` is restricted to an explicit `.nitely/evals/<name>.json` path in
  the evaluated repository. The CLI refuses directories, links, repository
  source files, and existing non-report files, and publishes reports atomically
  through a Linux descriptor-relative directory chain. Explicit file output
  fails closed where that anchor is unavailable; stdout JSON remains portable.

## Manifest contract

`nitely.eval-cohort.v1` contains:

- a stable cohort id and optional baseline cohort id;
- one or more uniquely identified cases;
- a 40-character Git source revision;
- a Flow path plus `sha256:` digest;
- local task input paths plus `sha256:` digests;
- the canonical digest of Nitely's effective context policy;
- an exact runtime plus non-empty model selection for every Agent or
  review-gate stage;
- optional non-secret scalar Flow configuration, covered by the canonical
  cohort-manifest digest and checked against the baseline configuration digest;
- expected gate stage ids, allowed non-determinism declarations, and scoring
  rules; and
- explicit cohort regression thresholds.

Unknown keys and unsafe ids/paths fail schema validation. Secret-bearing
configuration keys, credentials, environment captures, and mutable branch
names are not valid manifest fields. Token-suffixed configuration keys follow
the same default-sensitive rule; only the explicit token-counter allowlist is
accepted.

## Baseline compatibility contract

The baseline reader accepts version-1 reproducibility documents created before
new eval pins were added. Newly added fields remain optional at the parse layer
so an older `version: 1` document is still intelligible. Parse compatibility is
not replay compatibility: an eval plan is explicitly `incompatible` when the
baseline lacks any required Flow/configuration digest, input digest, project
instructions identity, runtime selection, execution backend, sandbox policy, or
skill pin. The planner never fills a missing pin from mutable ambient state.

## Replay safety contract

A case is runnable only when:

1. its schema is valid;
2. the current repository `HEAD` equals its pinned source revision;
3. the Flow and every input exist and match their digest, and the effective
   context policy, constitution, project instructions, and stage skills match
   their pinned identities;
4. its baseline reproducibility manifest exists, matches the pinned case, and
   is either `replayable` or has only explicitly declared nondeterminism; and
5. the Flow's declared runtime/model candidates, execution backend, and Codex
   sandbox policy match the pinned selection, and normalized Flow configuration
   matches the baseline configuration digest.

The planner returns all findings and never invokes the runner for an
incompatible case. The executor re-runs compatibility checks immediately before
delegation, supplies the verified Flow document and digest-bearing input
references to `runFlow`, chooses the ordinary run id up front, and appends the
eval link only to ordinary evidence created by that invocation. The executor
generates a UUIDv4 invocation id, passes it into `runFlow`, requires exactly one
matching `run.created` event, and persists the same id on
`eval.replay.linked`. `runFlow` creates the workspace from the exact source
commit, revalidates the effective context-policy digest, passes the pinned
sandbox policy to the runtime backend, and requires local-file connectors to
validate the bytes they actually consume.

Only a run carrying `evalReplayInvocationId` writes the normalized configuration
to the run-owned `configuration.json` snapshot. That write uses Linux
descriptor-relative anchoring, a mode-`0600` temporary file, identity/link
checks, sync, and atomic rename. An ordinary run records its normalized
configuration and digest on `run.created` but does not create the raw snapshot.
Eval execution on a non-Linux host fails before workspace or runtime execution
when this anchoring is unavailable.

Resuming an approval-blocked eval run fails closed unless it can recover and
verify the original Flow document and digest, run-owned configuration snapshot
and digest, execution backend, sandbox, local-input digests, context-policy
digest, constitution/project-instructions identities, and per-stage skill
hashes. A valid eval invocation UUID on `run.created` activates these checks even
when `eval.replay.linked` is missing after a crash; malformed invocation ids are
rejected. Snapshot verification uses the same Linux descriptor-relative
boundary, so non-Linux eval resume also fails closed. Eval output never edits a
Flow, skill, prompt, configuration, or model setting.

## Metrics and regression contract

Each linked run contributes at most one sample after it has both an ordinary
`run.created` event and a terminal run event:

- `reviewablePr`: at least one `change.published` or `change.updated` event;
- `expectedGatesPassed`: every case-declared gate has a passing
  `gate.completed` event;
- `retries`: count of `stage.retrying` events;
- `humanRework`: count of `stage.rework.requested`, operator review resolution,
  or human-authored review trigger events, without counting generated advice;
- `latencyMs`: first run event to terminal run event;
- `actualCostUsd` and `estimatedCostUsd`: summed separately from normalized
  runtime usage and exposed only when every observed runtime attempt has proven
  cost in that same classification; and
- missing usage: reported as unknown coverage, never a zero-dollar run.

Rate regressions use absolute allowed decreases. Count, latency, and cost
regressions use allowed relative increases. A metric with no comparable data is
reported as `not_comparable` and cannot silently pass a required threshold.
Every `nitely.eval-report.v1` document also records canonical baseline and
candidate manifest digests plus deterministic baseline/candidate
`{ caseId, runId }` lineage. Link-time outcome checks use the terminal evidence
available when the link was written; later resume events may supply the final
terminal state and latency without losing the sample.

## In scope

- Zod-backed manifest parsing and path-contained file loading.
- Fail-closed replay planning, commit-pinned workspace creation, digest-checked
  local input consumption, and a thin ordinary-run execution seam.
- Codex sandbox and context-policy enforcement across initial execution and
  resume.
- Eval-only, Linux descriptor-relative configuration snapshot persistence and
  resume verification; ordinary runs retain only normalized configuration event
  state and its digest.
- Normalized usage observations with provenance, cost classification, and
  redaction.
- Trusted built-in usage extraction for completed Codex JSONL turns and Claude
  JSON result envelopes.
- Event-derived cohort aggregation, baseline comparison, and versioned
  machine-readable regression output.
- CLI commands for validation/planning, replay execution, and report comparison.
- Descriptor-safe, atomic report output under `.nitely/evals/`.
- Deterministic unit/integration fixtures for missing usage, incompatible
  replay, thresholds, and redaction.

## Out of scope

- Training or fine-tuning models.
- Automatically modifying Flow documents, skills, prompts, or runtime choices.
- A new analytics database, queue, runner implementation, or pricing catalog.
- Fetching missing commits or remote repositories during replay; the pinned
  commit must already exist in the local repository.
- Pinning an OCI image or execution-host policy. The first slice pins the Codex
  sandbox mode, effective context policy, and execution-backend id.
- Portable non-Linux eval execution or resume until an equivalent
  descriptor-relative run-owned file boundary exists.
- A GLM usage adapter or inferred provider pricing. GLM usage remains unknown,
  and Codex cost remains unknown unless a future trusted source reports it.
- Claiming deterministic model output; declared non-determinism remains visible
  in the case and report.

## Acceptance checks

1. Invalid, mutable, duplicated, or path-escaping manifest fields fail schema
   validation.
2. A mutated input/Flow/policy/prompt/skill/configuration, mismatched `HEAD`,
   missing baseline snapshot or required legacy-v1 pin, undeclared baseline
   nondeterminism, or sandbox mismatch prevents runner invocation.
3. A compatible plan maps pinned artifacts to one ordinary `RunFlowInput`.
   The ordinary runner consumes the pinned commit, input digests, context-policy
   digest, and sandbox policy rather than mutable ambient state.
4. Execution records cohort, case, baseline, canonical manifest digest,
   invocation UUID, and outcome on the ordinary run event log only when the
   ordinary runner has created matching invocation evidence, including terminal
   failure paths. Resume still recognizes the eval invocation when a crash
   prevents the link event from being appended.
5. Usage normalization preserves provider/source provenance, separates actual
   and estimated cost, treats missing usage as unknown, redacts unrecognized
   singular/plural token fields, and preserves only explicitly allowlisted token
   counters.
6. Cohort aggregation derives all required metrics from deterministic ordinary
   run events and case scoring rules.
7. Regression thresholds produce stable pass/regressed/not-comparable results
   and a versioned JSON document with manifest digests and selected run lineage.
   Approval-resumed linked runs use their later terminal evidence.
8. CLI comparison exits non-zero on a material regression or invalid cohort and
   writes only a safe `.nitely/evals/*.json` destination when `--output` is used.
9. Eval code contains no path that writes Flow or skill files.
10. Resuming an eval run rejects missing or changed Flow/config snapshots,
    backend, sandbox, input digests, context policy, prompt context, or skill
    hashes, including when only the `run.created` invocation UUID survived a
    link-append crash.
11. Valid Codex and Claude machine-readable result envelopes produce normalized
    provider usage; malformed, incomplete, or model-forged payloads and all GLM
    runs remain unknown.
12. Only eval invocations create `configuration.json`; ordinary runs record
    normalized configuration plus its digest without a raw snapshot. Eval
    execution and resume fail closed off Linux at the descriptor-relative file
    boundary.
