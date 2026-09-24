# Executable Eval/Replay Cohorts Technical Design

## Goal

Add a production-usable, fail-closed eval slice that replays pinned cases
through Nitely's existing Flow engine and compares ordinary run evidence without
introducing a parallel runner or analytics store.

## Architecture

The new `src/eval` domain has four narrow layers:

1. `manifest.ts` owns the strict `nitely.eval-cohort.v1` schema, file parsing,
   key-sorted canonical JSON digest, safe paths, and immutable-reference
   validation.
2. `replay.ts` compares a case with repository state and its existing
   `reproducibility.json`, builds an ordinary `RunFlowInput`, and delegates to
   `runFlow`. `reproducibility-schema.ts` parses the version-1 baseline contract.
   An `eval.replay.linked` event associates the ordinary run with the cohort and
   baseline.
3. `usage.ts` converts explicit provider observations into one normalized
   structure with token provenance and `actual`, `estimated`, or `unknown` cost.
   It redacts raw metadata before persistence.
4. `report.ts` reads existing run events, derives per-case samples, aggregates
   cohorts, applies manifest thresholds, and emits `nitely.eval-report.v1` JSON.

`src/eval/cli.ts` parses the three eval actions and calls these domain functions;
the main `src/cli.ts` only routes `eval`. Neither implements scoring or replay
logic. The executor injects a chosen run id through the existing
`RunFlowDependencies.createRunId` seam. `run-flow.ts` accepts explicit source,
Flow/configuration, context-policy, prompt-context, skill, backend, and sandbox
pins so the ordinary runner can enforce the eval contract at the point of
consumption and again on resume.

## Ordinary-run integration

`executeEvalReplay` generates a run id before delegation and invokes:

```ts
runFlow(plan.runInput, { createRunId: () => runId })
```

Before delegation, `executeEvalReplay` generates a UUIDv4 invocation id and
adds it to `RunFlowInput.evalReplayInvocationId`. `runFlow` validates that UUID
and stores it on `run.created`. After the ordinary invocation returns or fails,
the executor appends `eval.replay.linked` with the same `invocationId` to the
repository's existing `EventStore`. The link also contains stable cohort/case
ids, manifest digest, pinned revision, optional baseline cohort id, baseline run
id, allowed nondeterminism, and outcome classification.

Link admission requires exactly one `run.created` event carrying the generated
invocation id. Completed and failed outcomes additionally require matching
ordinary terminal evidence. A reused run id, pre-linked evidence, evidence
created by another invocation, missing required terminal evidence, and
link-persistence failures are rejected without replacing the original operation
error. An approval-blocked invocation may link with `awaiting-approval` before
it has a terminal event; its later resume events stay on the same ordinary run.
Report-time provenance validation rejects an awaiting link that already had a
terminal event. The ordinary run keeps ownership of workspace, artifacts,
evidence, retries, blockers, and terminal state.

Resume does not rely on the link as the only eval marker. A valid
`evalReplayInvocationId` on `run.created` classifies the run as an eval replay
even if the process crashed before `eval.replay.linked` was persisted. This
closes the link-append crash window: resume still requires every eval pin, while
a malformed invocation id fails before recovery begins.

No eval-owned event database or copy of run evidence is created.

## Replay compatibility

Planning performs I/O but no mutation. It verifies the supplied canonical
manifest digest, reads `git rev-parse HEAD`, the pinned Flow and inputs, computes
the canonical effective context policy and effective constitution/project
instructions, then reads the baseline run's existing `reproducibility.json`.
Flow, input, and baseline reads use the portable `LocalFileConnector` path: a
bounded `O_NOFOLLOW` descriptor read with pre/open/post identity and metadata
checks, containment checks, and consumed-byte digest computation. Flow and input
reads also compare that digest with their expected value. Baseline reads require
a non-symbolic path and a single-linked regular file. None of these checks
depends on Linux-only `/proc` paths.

The dedicated baseline schema preserves the existing `version: 1` read
contract. Pins added after the first v1 writer, including configuration,
project-instructions, execution-backend, and sandbox fields, remain optional at
the parse layer. The planner does not treat their absence as permission to use
ambient state: it emits an incompatibility finding when any Flow/configuration,
input, prompt-context, runtime, backend, sandbox, or skill identity required for
eval replay is absent or differs. Findings have stable codes such as:

- `source_revision_mismatch`
- `content_digest_mismatch`
- `baseline_manifest_missing`
- `baseline_not_replayable`
- `runtime_selection_mismatch`
- `context_policy_mismatch`
- `prompt_context_mismatch`
- `skill_content_mismatch`
- `baseline_configuration_mismatch`
- `manifest_digest_mismatch`

Any finding makes the plan incompatible and the executor refuses to call
`runFlow`. The executor repeats planning immediately before delegation. The
ordinary runner then creates its workspace from the pinned commit SHA, checks
the context-policy and prompt-context identities again, and overlays the pinned
Codex sandbox on the resolved backend environment. Local-file references carry
`expectedSha256`, so the connector validates the bytes actually consumed. The
verified Flow document and normalized configuration are passed by value, while
per-stage expected skill hashes are checked when skills load. These checks move
enforcement from planning to actual consumption instead of relying on a narrow
recheck window.

Every `run.created` records the normalized configuration through the ordinary
event-redaction boundary plus its digest. For an eval invocation, the same event
is also the replay pin ledger: Flow document digest, backend, sandbox,
digest-bearing input references, context-policy digest,
constitution/project-instructions identities, and expected skill hashes.
Ordinary runs do not write a raw `configuration.json` snapshot and leave
`configurationSnapshotPath` absent.

When `RunFlowInput.evalReplayInvocationId` is present, `runFlow` additionally
writes the exact normalized configuration to the run-owned
`configuration.json` and records that path on `run.created`. The atomic writer
anchors the parent through Linux `/proc/self/fd`, rejects symbolic or multiply
linked files, writes and syncs a mode-`0600` exclusive temporary file, validates
directory/file identity, then renames and syncs the parent. If descriptor-relative
anchoring is unavailable, eval execution fails before workspace creation or any
runtime call. This Linux requirement is intentionally narrower than portable
planner reads; ordinary runs remain able to proceed without the snapshot.

An eval resume requires every pin above plus the snapshot path. It loads the
Flow from the existing worktree with its recorded digest, reads the configuration
snapshot through the same descriptor-relative run-owned boundary and checks its
digest, revalidates ambient prompt context and context policy, reuses the pinned
backend/sandbox, verifies local-input digests, and checks skill hashes at stage
execution. Missing or changed state fails before the resumed runtime is called.
On non-Linux hosts, snapshot access cannot establish that boundary and resume
fails closed.

## Usage model

The normalized record contains tokens, provider, model, observed-at timestamp,
source kind/reference, a redacted raw payload, and a discriminated cost:

```ts
{ classification: "actual", usd: number }
{ classification: "estimated", usd: number, method: string }
{ classification: "unknown" }
```

An observation cannot provide actual and estimated cost simultaneously.
Token counts are finite non-negative integers. `totalTokens` must equal input
plus output when all three are supplied. Missing observations are represented
as missing coverage, not synthesized zeroes. This slice deliberately has no
provider price table. Raw metadata is converted to bounded JSON-safe data before
redaction, with explicit circular and truncation markers.

Redaction treats unrecognized structured keys ending in `token` or `tokens` as
secret-bearing by default, including plural and compound names such as
`accessTokens`, `refresh_tokens`, and `accessInputTokens`. A closed allowlist of
known usage-counter names, including `inputTokens`, `outputTokens`,
`cachedInputTokens`, and their supported cache/limit variants, is exempt so
numeric observability survives. The same distinction applies to configuration
schema checks and token assignments embedded in text.

Eval scoring ignores legacy `estimatedCostUsd` fields without calculated
provenance and an explicit method. Empty or malformed usage events remain
unknown. A run-level actual or estimated cost is emitted only when every
observed runtime attempt has proven cost in that classification, preventing a
partial sum from appearing to be a complete cost metric.

The runtime result and event projection preserve this normalized seam. The local
backend has two trusted built-in adapters:

- Codex runs with `codex exec --json`. Usage is accepted only from a complete
  JSONL lifecycle with one valid `thread.started`, one `turn.started`, no
  top-level error or failed turn, and one final `turn.completed`. The adapter
  reads that final event's `input_tokens`, `cached_input_tokens`, and
  `output_tokens`, reports provider `openai` with source
  `codex.exec.turn.completed.usage`, and retains only the cached-input count in
  bounded raw metadata. Codex cost remains unknown.
- Claude runs with `-p --output-format json`. Usage is accepted only from a
  successful result envelope with a valid session UUID. Input tokens are the
  sum of uncached, cache-creation, and cache-read inputs; output tokens and
  `total_cost_usd` are included when present. The adapter reports provider
  `anthropic`, source `claude.print.result`, and classifies the reported cost as
  `actual`. Optional usage or cost fields may be absent without invalidating the
  rest of a valid envelope.

Malformed, incomplete, failed, or model-authored lookalike payloads do not
produce usage. The original stdout/stderr remains ordinary runtime evidence.
GLM has no trusted adapter and therefore remains unknown.

## Report derivation

The reporter lists existing run ids, selects `eval.replay.linked` events for the
requested cohort, and derives metrics from each run's ordinary events. Expected
gate ids and scoring rules come from the pinned cohort manifest. Aggregates
include numerator/denominator or sample count so missing coverage is explicit.
Links without both `run.created` and a terminal event are not samples yet.

Candidate and baseline cases are paired by case id. Exactly one deterministic
sample is selected per case; duplicate samples make coverage insufficient
rather than weighting that case more heavily. Unpaired cases, foreign-cohort
samples, and forged replay-link provenance remain in coverage findings or are
rejected and are not silently used for threshold comparisons.
Threshold evaluation uses small pure functions:

- rates: candidate may decrease by at most the configured absolute amount;
- retries/rework/latency/cost: candidate may increase by at most the configured
  ratio; and
- missing candidate or baseline values: `not_comparable`.

The report status is `regressed` if any required comparable metric breaches its
threshold, `insufficient_data` when required comparisons are unavailable, and
`passed` otherwise.

Every report also carries `baselineManifestSha256` and
`candidateManifestSha256`, computed from canonical manifests, plus deterministic
baseline and candidate `runLineage` entries mapping each selected case id to its
run id. `deriveEvalRunSample` verifies the matching UUID on `run.created` and
`eval.replay.linked`, validates the link provenance against the supplied
manifest, and checks that the link-time outcome agrees with evidence available
at link time. It then uses the run's latest terminal event. Consequently an
approval-blocked replay that later resumes and completes remains a sample, with
latency and terminal status extending through the continuation.

## CLI

```text
nitely eval plan <manifest> --repo <path> --case <id> [--json]
nitely eval run <manifest> --repo <path> --case <id>
nitely eval compare <candidate-manifest> --baseline <baseline-manifest> \
  --repo <path> [--output <repo>/.nitely/evals/<name>.json]
```

`plan` and `run` return non-zero for incompatibility. `compare` writes versioned
JSON and returns non-zero for `regressed` or `insufficient_data`, making it
usable as a CI gate. Without `--output`, JSON goes to stdout. An explicit output
must be a direct `.json` child of the evaluated repository's `.nitely/evals/`
directory. The writer rejects symbolic links, hard links, directories,
symlinked output directories, and existing files that are not
`nitely.eval-report.v1`. It writes a mode-`0600` same-directory temporary file,
publishes a new destination without clobbering a raced path, and atomically
replaces only a descriptor-validated existing eval report. On Linux, the writer
opens the canonical repository and each `.nitely/evals` directory hop with
`O_DIRECTORY | O_NOFOLLOW`; inspection, temporary-file operations, replacement,
cleanup, and directory sync all use `/proc/self/fd/<fd>/<child>` paths rooted in
those handles. This closes parent-directory swaps as well as leaf races. An
explicit file output fails closed on platforms without that descriptor-relative
anchor; stdout JSON remains available there.

## Test plan and TDD order

1. RED/GREEN strict manifest parsing, duplicate ids, unsafe paths, and immutable
   digest/source validation.
2. RED/GREEN compatible planning followed by source/hash/replayability/runtime
   incompatibility cases, portable descriptor races, legacy-v1 missing pins,
   prompt/configuration/skill pins, eval-only Linux snapshot persistence,
   non-Linux fail-closed behavior, and UUID-bound crash-window evidence that
   prove the runner or reporter cannot claim unrelated state.
3. RED/GREEN usage normalization, missing usage, cost classification,
   provenance, plural-token secret defaults, counter allowlisting, and raw-secret
   redaction.
4. RED/GREEN event-derived samples, aggregate coverage, expected gates,
   retries/rework/latency/cost, and threshold boundary behavior.
5. RED/GREEN CLI wiring, safe-output link/race cases, resumed-run reporting, and
   an execution integration using a deterministic injected ordinary runner plus
   a real `EventStore`.
6. Run focused eval/CLI tests, the complete suite, TypeScript check, and build.

## Risks and rollout

- Older runs lack normalized cost provenance. Reports keep their cost unknown
  unless an event explicitly classifies it; legacy `estimatedCostUsd` may be
  imported only as estimated with event provenance.
- Older version-1 reproducibility files remain parseable, but an eval stays
  incompatible until every pin needed for replay is present. This is an
  intentional fail-closed migration boundary rather than an implicit upgrade.
- The pinned commit must already exist locally; replay does not fetch missing
  objects or remote repositories. A future runner pool must preserve the same
  commit, digest, context, and sandbox enforcement.
- Eval execution and resume currently require Linux for descriptor-relative
  access to `configuration.json`. Non-Linux hosts fail closed at that boundary;
  ordinary runs avoid the restriction because they do not persist the snapshot.
- Model output remains nondeterministic. Cases declare allowed sources and the
  report scores delivery outcomes rather than byte-identical output.
- `eval.replay.linked` adds an event type but does not affect existing run
  projection state.

## Follow-up boundary

Future increments may add scheduled cohort execution, hosted checkout fetching,
portable descriptor-relative run-owned storage, OCI/host policy pinning,
additional trusted provider adapters including GLM, or richer dashboards. They
must continue to use ordinary runs, explicit provenance, and explicit approval
for proposed Flow/skill changes.
