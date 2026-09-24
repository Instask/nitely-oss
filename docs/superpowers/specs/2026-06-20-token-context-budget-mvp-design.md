# Token & Context Budget Harness — MVP (Issue #65)

Date: 2026-06-20
Issue: #65 (follow-up to the closed #62 harness work)
Status: Design approved, pending spec review

## Summary

`renderPrompt` currently inlines up to 64 KB of **every** input artifact's content
into **every** attempt's prompt, even though agents are file-capable CLIs and the
artifacts already exist on disk. With several inputs this wastes tens of thousands
of tokens per attempt.

This MVP does two things:

1. **Context delivery change** — stop pushing full content into prompts. Pass
   metadata + a readable file path + a compact head preview, and (for truncated
   inputs) instruct the agent to read the file. Small artifacts stay fully inline.
2. **Thin observability** — record per-attempt context size (bytes, approximate
   tokens, bytes saved) as an event and surface it per-run / per-stage in the
   Web Console.

### Explicitly deferred (future #65 follow-up)

- Per-stage budget fields in the flow schema (`maxInputTokens`,
  `maxOutputTokens`, `maxToolOutputTokens`, `maxRuntimeMs`).
- Budget enforcement / gates (truncate, pause, or fail on overflow).

### Out of scope

- Repo code indexing / knowledge graph (tracked in #20).
- LLM-based summarization of artifacts (would be lossy; we only do head
  truncation, which defers reading rather than discarding information).

## Background: current layout (verified on `master`)

```
<repo>/.nitely/runs/<runId>/                 # runDirectory — artifacts live here
<repo>/.nitely/runs/<runId>/inputs/<id>/     # flow inputs: content + metadata.json
<repo>/.nitely/runs/<runId>/stages/<s>/<n>/  # generated artifacts, attempt outputs
<repo>/.nitely/runs/<runId>/worktree/        # agent workspace (cwd)
```

- Flow inputs are materialized to `<runDir>/inputs/<id>/content`
  (`run-flow.ts` input-materialization block).
- Generated artifacts (from prior stages) are written under
  `<runDir>/stages/<stage>/<attempt>/`.
- Every input artifact therefore has a real, absolute `contentPath` on disk.
- The agent's cwd is `<runDir>/worktree`, so artifacts sit at `../inputs/...` and
  `../stages/...` — **outside** the git worktree. This means `commitAll` will not
  accidentally commit them, and handing the agent a readable path is safe.

## Information-loss analysis

Two senses of "loss", one of which does not exist:

1. **Is information destroyed?** No — and large files are *more* complete than
   today. The current 64 KB inline cap silently and irrecoverably drops content
   beyond 64 KB. With a path, the full file (including >64 KB) is always available
   for the agent to read. Information moves from *push* to *pull*; nothing is
   deleted.
2. **Inputs ≤ threshold:** zero loss — full content is still inlined, identical to
   today. Most specs / tech-designs / issues are a few KB and fall here.
3. **Real residual risk:** for an input *above* the threshold, output could degrade
   only if the relevant content is beyond the head preview **and** the agent fails
   to read the file. This is an agent-behavior risk, not an information-availability
   one. Mitigations: the full-inline gate (only large artifacts are headed), a
   mandatory read instruction on truncation, and the observability layer (lets us
   detect regressions). The threshold is tunable, and the deferred per-stage budget
   fields can later make "must read full" configurable per stage.

## Design

### 1. Context delivery — `renderInputContext`

Extract the per-input rendering currently embedded in `renderPrompt`
(`src/run/run-flow.ts`, the input-rendering branch) into a focused helper:

```
renderInputContext(input, context) -> { block: string; usage: InputContextUsage }
```

where `InputContextUsage` carries the byte accounting the observability layer
needs (see §2), so counts are produced once and not re-derived.

Rendering rules, in order:

1. **Metadata block** — unchanged (id, name, type, version, description, producer,
   media type, filename, run-relative path, source URI).
2. **Readable path line** — add an explicit, agent-usable absolute path to the
   materialized file:
   `Full content: <absolute contentPath>`.
3. **Content rendering, gated by one constant** `INPUT_INLINE_FULL_LIMIT = 8 KB`:
   - **content ≤ 8 KB** → inline the full content (today's behavior, smaller cap).
     No mandatory-read instruction needed.
   - **content > 8 KB** → inline only the head (first 8 KB, truncated at a line
     boundary), labeled `Content preview (truncated — full content at the path
     above):`, **followed by a mandatory read instruction** (see §1a).
   - **binary / non-text** → no preview; metadata + path only. "Textual" =
     media type starting with `text/`, or a known textual `application/*` type
     (`application/json`, `application/*+json`, `application/xml`,
     `application/*+xml`); everything else is treated as binary.
4. **`omittedByPolicy` inputs** — unchanged (metadata + "Omitted by context
   policy", no content).

All previewed text continues to pass through `redactRuntimeText`. Paths are local
filesystem paths (not secrets) and are also routed through `redactRuntimeText` for
consistency.

#### 1a. Mandatory read instruction (truncated inputs)

When an input is truncated, the block ends with an explicit, forceful instruction,
e.g.:

> The preview above is truncated. You MUST read the full file at `<path>` before
> using this input. Do not rely on the preview alone for this artifact.

### 2. Thin observability

`renderInputContext` returns per-input byte counts; `renderPrompt` aggregates per
attempt into `ContextUsage`:

- `promptBytes` — total assembled prompt size.
- `approxTokens` — `ceil(promptBytes / 4)` (dependency-free, model-agnostic,
  labeled "approx").
- `inputBytesInlined` — bytes actually inlined across inputs.
- `inputBytesSaved` — `sum(fullContentBytes − inlinedBytes)` over inputs (the
  headline "waste avoided" number).
- `inputCount`.

Emit one event per agent / review-gate attempt — `stage.context.usage` — into the
existing `EventStore`, carrying the fields above plus `stageId` and `attempt`. No
new storage; it rides the existing event pipeline.

**Projection (`src/run/project.ts`):** fold `stage.context.usage` events onto each
attempt (`attempt.contextUsage`) and accumulate a per-run total
(`run.contextUsage`). Purely additive; no existing projected field changes. Runs
whose events predate this feature simply have no `contextUsage`.

### 3. Web Console

Surfaced through the existing run-projection payload served by `src/web/runs.ts`
(SPA frontend); no new endpoints.

- **Per-run summary** — a small "Context" readout: total approx tokens, total
  prompt bytes, and bytes saved.
- **Per-attempt** — within each agent / review-gate attempt's detail, show that
  attempt's `contextUsage`.
- **Graceful absence** — when `contextUsage` is missing (older runs), render
  nothing; no errors.

## Testing

Follow existing test patterns; TDD.

- `renderInputContext` units: small input → full inline + path; large input → head
  + truncation label + mandatory-read instruction + path; binary → metadata + path
  only; `omittedByPolicy` unchanged; redaction still applied.
- Observability: assemble a prompt with mixed inputs → assert `stage.context.usage`
  event fields, especially `inputBytesSaved`.
- Projection: events fold onto `attempt.contextUsage` and `run.contextUsage`.
- Update existing `run-flow.test.ts` cases that assert the 64 KB "Content preview"
  with full content (these change legitimately).
- On macOS, run tests with a non-symlinked `TMPDIR` to avoid the
  `/var` → `/private/var` path-escape false failures.

## Risks

1. **Agent skips reading a truncated large input** → possible output degradation.
   Mitigated by the 8 KB full-inline gate, the mandatory-read instruction, and the
   observability layer (detection). Tunable; further control via deferred budget
   fields.
2. **Future Docker backend** — artifacts live outside the worktree; a Docker
   backend must bind-mount the run directory for paths to resolve. The local
   backend (only one today) is unaffected. Noted as future work.
3. **Path exposure in prompts** — absolute local paths appear in prompts;
   acceptable for a local-first tool, still routed through redaction.
