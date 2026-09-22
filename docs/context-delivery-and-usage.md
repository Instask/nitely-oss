# Context Delivery And Usage

Nitely snapshots run inputs to disk, then renders a compact prompt view for each
agent and review-gate attempt. The prompt view is an optimization for token and
context size; it does not delete input data that was accepted by context policy.

## Prompt Delivery Strategy

| Input kind | Prompt delivery |
| --- | --- |
| Textual input up to 8 KiB | Metadata, readable path, and full content inline. |
| Textual input larger than 8 KiB | Metadata, readable absolute `Local path`, and an 8 KiB head preview that the prompt declares sufficient. |
| Textual input larger than 8 KiB listed in `context.fullReadInputs` | Metadata, readable absolute `Full content` path, an 8 KiB head preview, and a mandatory-read instruction. |
| Binary or non-textual input | Metadata and readable path only; no content preview. |
| Omitted by context policy | Omitted-by-policy metadata and reason; no snapshot bytes and no prompt content. |

Every accepted input artifact is materialized under the run directory, usually
at `.nitely/runs/<run-id>/inputs/<input-id>/content`. For generated artifacts,
the prompt includes the artifact metadata and path recorded in the run artifact
registry.

## When Agents Must Read Files

A truncated preview is the default contract. When a textual input is larger than
8 KiB, Nitely includes an 8 KiB head preview plus an absolute `Local path`, and
tells the agent to treat the preview as sufficient and to open the path only if
the task genuinely needs more. Nothing is mandatory-read by default.

Mandatory reads are opt-in per stage. A flow or stage can declare:

```json
{
  "id": "plan-tasks",
  "type": "agent",
  "inputs": ["spec", "tech-design"],
  "context": { "fullReadInputs": ["spec", "tech-design"] }
}
```

Listed ids get a `Full content` absolute path and an explicit instruction to
read the whole file before using that input. Every id must be declared in the
stage's own `inputs`. Stage-level `fullReadInputs` overrides the flow-level
list, matching the other `context` controls.

Reach for it when a stage cannot do its job from a head preview — a planner
decomposing a whole specification, or a single-attempt implement stage. Do not
put it on a task-plan loop stage: each iteration would re-ingest the same
artifacts, which is what makes a loop cost millions of tokens.

The full artifact content always remains on disk at the path shown in the
prompt, whether or not the read is mandatory.

Binary and non-textual inputs are never previewed. Agents that need their bytes
must use the path shown in the prompt.

Budget trimming is separate. When `budgets.maxPromptTokens` forces an input out
of the prompt entirely, that input is delivered as path-only with a mandatory
read, because the agent has no content at all.

## Global Runtime Skills

`context.instructionFiles` hides repository instruction files (`AGENTS.md`,
`CLAUDE.md`) while a stage runs. It says nothing about the skill packs an agent
runtime loads from the operator's own home directory: `~/.codex/skills`,
`~/.codex/superpowers`, the Codex plugin cache, `~/.agents/skills`. Those are
loaded by the runtime, not the repository, and they arrive before the Nitely
prompt does.

By default an attempt now runs without them. Nitely gives the runtime a
run-owned home directory under `.nitely/runtime-homes/<run-id>/<runtime>/`,
containing symlinks to only the credentials and configuration the runtime needs
— for Codex that is `auth.json` and `config.toml`, pointed to by `CODEX_HOME`.
Everything else is deliberately absent, and the directory is rebuilt for each
attempt so a stale entry cannot come back. Isolated homes live next to the runs
directory rather than inside it, because they link to operator credentials and
must never travel with exported run evidence.

`context.globalSkills` selects the behavior:

| Value | Behavior |
| --- | --- |
| unset (default) | Isolate on runtimes that support it; run unchanged on runtimes that do not, and record why. |
| `false` | Isolation is required. A runtime with no mechanism fails the stage instead of silently loading the packs. |
| `true` | Opt back into the operator's packs. |

Runtime support today: `codex` isolates through `CODEX_HOME`. The OCI backend
isolates every runtime, because the container never mounts an operator home.
`claude`, `glm`, `grok`, and `pi` have no isolation mechanism on the local
backend yet; they run unchanged under the default and fail closed under
`globalSkills: false`.

`instructionFiles` keeps its `true` default. A repository's `AGENTS.md` is
project-owned guidance that the team chose and that travels with the code being
changed, which is the opposite of an operator's personal skill packs leaking
into every customer run.

Nitely's own `stage.skills` are unaffected: those are declared by the flow,
content-hash checked, and rendered into the prompt.

## Agent Session Reuse

A task-plan loop re-runs one stage in one worktree over and over. Every
iteration used to start a cold `codex exec`, so the spec, the technical design,
and the whole task plan were re-ingested each time. Six dogfood implement
attempts ended their sessions at 594k, 1.68M, 1.02M, 2.02M, 2.20M, and 2.64M
input tokens for the same work.

Nitely now continues the runtime's previous session for a repeated execution of
the same stage in the same worktree. The first execution sends the full prompt;
later ones send a delta:

- the stage prompt,
- the updated task-plan context for this iteration,
- where to write this attempt's outputs,
- previous-failure context, when that channel is enabled.

Everything the cold prompt already delivered stays in the runtime's session, and
the resume prompt says so explicitly.

`context.sessionReuse` controls it, at flow or stage level. Unset means on for
stages that declare `taskPlan` and off for everything else: a stage that runs
once gains nothing from a warm session and keeps a self-contained prompt.
`false` forces every execution cold; `true` opts a repeating non-loop stage in.

Runtime support: `codex` continues a session with `codex exec resume
<thread-id>`, reading the thread id from its `--json` stream. A runtime with no
resume mechanism starts cold and records why, so nothing fails because a runtime
cannot resume. Each attempt emits a `stage.runtime.session` event carrying
`cold` or `resumed`, the session id, and the reason a requested resume did not
happen.

Session ids are held in memory for the life of the `runFlow` call and are
deliberately not persisted. A resumed Nitely run starts its next stage
execution cold rather than reaching for a session it cannot prove is still
alive.

## Repository Read Policy

Everything above bounds what Nitely puts in the prompt. It says nothing about
what the agent reads on its own once the stage is running, which is where a
large repository does the real damage: a dogfood implement attempt ran `rg` over
a gateway migration tree and pulled 365,809 characters into one Codex session,
against sources of 17,220 and 20,494 lines.

Every agent and review-gate stage now carries a declared read bound:

```json
{
  "id": "implement",
  "type": "agent",
  "reads": {
    "maxFileBytes": 262144,
    "deny": ["**/node_modules/**", "**/*.lock"],
    "enforcement": "advisory"
  }
}
```

`reads` resolves stage over flow, like `context` and `timeouts`. Defaults:

| Stage kind | `maxFileBytes` |
| --- | --- |
| agent | 262144 (256 KiB) |
| review gate | 32768 (32 KiB) |

A review gate reads to judge and should never need a multi-megabyte file. An
implement stage edits real sources and gets a larger but still finite cap. The
default `deny` list covers `**/node_modules/**`, `**/.git/**`, `**/dist/**`,
`**/*.lock`, `**/pnpm-lock.yaml`, and `**/package-lock.json`.

The resolved policy is rendered into the prompt as a `Repository Read Policy`
section and recorded in run evidence under `Stage Read Policies`.

### Enforcement boundaries

`enforcement` is `advisory` by default, and **advisory means advisory**: the
bound is stated to the agent and recorded in evidence, and nothing stops a
runtime from reading more.

Nitely deliberately does not fake enforcement with a `PATH` shim over `cat`,
`rg`, and friends. Truncating those commands would silently corrupt ordinary
work — `cat big.json > out.json` inside an agent's own shell would write a
truncated file — and a shim is trivially bypassed by `node -e` or `python -c`
anyway. Real enforcement needs the execution sandbox to bound reads; the OCI
read-only path provides that boundary, while write-preserving mediation remains
future work.

For OCI read-only stages, `enforcement: "required"` creates a filtered
read-only workspace: denied globs and files larger than `maxFileBytes` are not
mounted into the workload. A required bound on a writable worktree fails
closed because preserving writes while filtering arbitrary reads needs a
filesystem mediation layer that Nitely does not ship. Local and Mise backends
also fail closed for required bounds. This keeps advisory bounds honest rather
than claiming enforcement that a runtime cannot provide.

## Context Usage Metrics

Each agent or review-gate attempt emits one `stage.context.usage` event. The
payload records:

- `promptBytes`: total assembled prompt size in bytes.
- `approxTokens`: model-agnostic estimate, `ceil(promptBytes / 4)`.
- `inputBytesInlined`: input bytes included directly in the prompt.
- `inputBytesSaved`: input bytes kept out of the model's context. Bytes are only
  counted as saved when the prompt does not order the agent to read them back,
  so a mandatory-read input contributes zero regardless of how small its preview
  was.
- `inputCount`: number of input artifacts rendered for the attempt.

Run projection attaches these metrics to attempts, folds them into per-stage
totals, and accumulates a run-total `contextUsage`. The Web Console run details
show per-stage and run-total context usage when available. Runs created before
these events existed simply omit the field.

## Context Policy And Redaction

`nitely.context.json` still decides which local inputs can be snapshotted into a
run. Inputs excluded by policy are not written to run snapshots, not included in
prompts, and not sent to providers. In `warnOnly` mode, excluded inputs are
recorded as warned and still have their bytes omitted.

Prompt previews, prompt files, logs, evidence, run events, PR bodies, and Web
API text responses continue to pass through Nitely's runtime/Web redaction
paths. Source snapshots and generated artifacts are not modified in place by
redaction.

## Current Non-Goals

- Nitely records context usage for observability, but it does not enforce
  context budgets yet.
- Required read bounds are enforced only for OCI read-only stages; writable
  stages and local/Mise backends fail closed until they have filesystem
  mediation.
- Nitely does not automatically switch provider, runtime, or model when a prompt
  is large or when a provider reports quota or usage-limit failures.
