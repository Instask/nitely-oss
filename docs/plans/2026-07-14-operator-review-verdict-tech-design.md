# Operator Review Verdict Tech Design

## Scope

Implement issue #162 for a review gate that is blocked because every configured
agent runtime is unavailable or usage-limited. An operator may attach a manual
review verdict to that exact blocked attempt and then explicitly resume the run.
The feature reuses the existing review-gate verdict grammar and downstream
resume path; it does not make arbitrary failed gates overridable and it does not
turn an operator verdict into an approval gate.

## Verdict Contract

The supplied review output is UTF-8 Markdown or plain text and must contain an
existing typed verdict, for example:

```markdown
Review verdict: pass
Reason: The reviewed implementation and verification evidence satisfy the spec.
```

`pass`, `approved`, and their existing aliases map to `approved`. Existing
`needs_fix`, `needs_rework_spec`, and `escalate` values remain non-passing. A
typed approved verdict remains authoritative, matching existing review-gate
behavior. Without one, explicit `fail`/`blocked` lines and P0/P1 finding headings
remain blocking. A manual submission is invalid when it has neither a typed
verdict nor one of those existing blocking signals; unlike an agent review,
unstructured clean text never implicitly passes.

Every submission requires:

- a non-empty actor;
- all declared input artifact ids for the blocked review gate, with no unknown
  ids;
- a run whose active blocker is `agent_usage_limit` or
  `agent_runtime_unavailable` on that review-gate stage;
- the latest blocked attempt for that stage; and
- no verdict already submitted for that active blocker.

## Persistence And Provenance

Submission writes the redacted review text beneath the blocked attempt
directory and records an immutable `operator.review.submitted` event. The event
contains the parsed verdict, actor, event timestamp, reviewed artifact ids, and
a snapshot of the blocker being resolved. It also records `artifact.published`
and `gate.completed` for a normal `gate.result` artifact whose
`operatorReview` provenance makes the manual source explicit.

The artifact registry and context manifest receive the gate result. The gate
result records integrity, run/stage/attempt provenance, `runtime: operator`, and
the original blocked attempt number. Existing projections remain compatible
because older gate results simply omit `operatorReview`.

Submitting evidence does not append `stage.completed`, `stage.failed`, or a new
terminal run event. The run therefore remains visibly blocked until an operator
chooses to resume it.

## Resume Semantics

On resume, Nitely matches the active blocker to the manual verdict by stage and
blocked attempt. It reuses that attempt and gate result instead of:

- starting a new review attempt;
- running review pre-hooks;
- launching or probing an agent runtime; or
- rerunning any upstream stage.

A passing result appends the ordinary successful stage completion and continues
with the next stage, including publish stages. A non-passing result enters the
ordinary gate-failure path, records failure evidence, and never reaches publish.
Resume is rejected when the manual provenance is absent or mismatched.

## CLI And API

CLI:

```text
nitely review-verdict <run-id> --file <review.md> --actor <name> \
  --reviewed-artifact <id> [--reviewed-artifact <id> ...] [--repo <path>]
```

The command prints the stage, attempt, normalized verdict, status, actor, and
artifact path. `--actor`, `--file`, and at least one reviewed artifact are
required.

API:

```text
POST /api/runs/:runId/review-verdict
```

The JSON body contains `content`, optional `mediaType`, and
`reviewedArtifactIds`. The authenticated user id is the actor; callers cannot
forge it. The route uses the existing repository scope, run visibility, CSRF,
and run-write authorization checks.

## Evidence And Guidance

`evidence.md`, CLI status, and the Web projection identify an operator review
with actor, timestamp, reviewed artifacts, and the overridden blocker. User
documentation recommends manual review only when a qualified human actually
reviewed the declared artifacts. Waiting for quota reset or switching to another
configured runtime remains preferable when no qualified reviewer is available.

## Tests

- Verdict parser tests cover pass, typed failure, explicit fail, P0/P1 findings,
  and missing verdicts.
- Submission tests cover valid provenance, wrong blocker/stage/artifacts,
  duplicate submissions, redaction, and persisted registry/context evidence.
- Run-flow tests prove manual pass resumes through publish without runtime or
  upstream reruns, while manual fail stops before publish.
- CLI tests cover required flags, successful attachment, and output.
- Web API tests cover authentication/authorization, server-owned actor
  provenance, validation failures, and the accepted response.
- Projection/evidence tests prove the manual source remains explicit.
