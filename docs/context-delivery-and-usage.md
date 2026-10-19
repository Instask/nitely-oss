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

## Stage MCP Servers

Every MCP server a runtime loads adds its tool definitions to the fixed prefix
the runtime resends on each model call inside a turn. Isolating global skills
keeps Codex's `config.toml`, so before this policy every `[mcp_servers.*]` the
operator configured globally loaded into every stage: a short Codex stage
measured about 24k cached prefix tokens against a 3k-token Nitely prompt, and a
reflect stage called MCP servers it never declared.

A stage now loads exactly the MCP servers it lists in `required_mcp_servers`.
An empty list means no MCP servers at all. `context.globalMcpServers` selects
the behavior, flow-wide or per stage:

| Value | Behavior |
| --- | --- |
| unset (default) | Load only the declared servers on runtimes that can restrict them; run unchanged on runtimes that cannot, and record why. |
| `false` | The restriction is required. A runtime with no mechanism, or a restriction Nitely cannot complete, fails the stage. |
| `true` | Opt back into every server the operator configured. |

Codex merges MCP servers from several config layers: the system
`/etc/codex/config.toml`, the user `config.toml` in `CODEX_HOME`, every trusted
project `.codex/config.toml` from the working directory up to the repository
root, and `-c` flags. A linked worktree inherits the trust entry of the
repository it belongs to, and that entry lives in the user `config.toml` Nitely
preserves, so a repository's committed `.codex/config.toml` servers load into
its stages. No single file names the effective set, so Nitely asks Codex:

1. Run `codex mcp list --json` exactly where the launch will run: same command,
   environment and `CODEX_HOME`, the worktree as working directory, and the
   launch's own `-c` overrides. Nitely reads only each entry's `name` and
   `enabled`; the rest of the output carries server env, args, and headers and
   is never logged or stored.
2. Turn off every enabled, undeclared server with
   `-c mcp_servers.<name>.enabled=false`. The config files are never rewritten,
   so auth, model provider, and model settings reach Codex unchanged.
3. Run the list again under those overrides. The restriction is **enforced**
   only if every undeclared server now reports `enabled: false` and the declared
   ones are still there.

Anything short of that is **partial**: the listing failed or did not parse, the
verification failed, an override was ignored, or a server name contains a dot,
which Codex's `-c` key path cannot address. Codex 0.162.0 also fails to start
when an override names a server it has no configuration for, so Nitely only
ever disables names Codex itself listed. Under `globalMcpServers: false` a
partial restriction fails the stage before launch. Under the default the stage
launches best-effort: if the listing failed it disables the user `config.toml`
servers it can read, and if verification failed it launches without the
overrides, since they may be what broke Codex.

Runtime support today:

- `codex` on the local backend: the probe above, run as a child process.
- `codex` on the OCI backend: the probe runs in its own offline container with
  the stage's image, mounts, and environment, so a system config baked into the
  image is seen too. The container's `HOME` is an empty throwaway path, so
  usually nothing is configured and the restriction is enforced trivially; a
  declared server is then reported as unconfigured.
- `claude`, `glm`, `grok`, and the Pi-based runtimes have no restriction
  mechanism; they run unchanged under the default (`unsupported`) and fail
  closed under `globalMcpServers: false`.

Each agent attempt emits a `stage.runtime.mcp-servers` event with an
`enforcement` of `enforced`, `partial`, `unsupported`, or `inherited`, the
`enabled` and `disabled` server names, any declared server Codex did not list
(`unconfigured`), and a `reason` whenever the restriction is not enforced. Run
evidence lists the resolved mode under `Stage Context Controls` as
`MCP servers`, followed by one `MCP servers, attempt N` line per attempt with
the same fields. Only `enforced` means the undeclared servers are confirmed off.

The regression suite `test/run/execution/codex-mcp-servers.real.test.ts` runs
the real Codex CLI against a trusted-project fixture; CI installs a pinned
`@openai/codex` for it.

`required_mcp_servers` keeps its admission role too: a declared server that
maps to a provider still requires that provider to be configured before the
stage starts.

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

A resumed Codex attempt reports the session's cumulative usage, not its own:
`codex exec resume` keeps the thread's token total, so the attempt's final
`turn.completed` snapshot includes every earlier attempt on that thread. Run
projection subtracts the latest snapshot recorded earlier on the same thread
before it totals attempts. That subtraction feeds the runtime-token ceiling,
the budget summary, efficiency findings, the Console, evidence, and traces.
The attempt's `stage.runtime.usage` record keeps the cumulative snapshot as
written. Without the subtraction, a loop of N resumed iterations would count
about N(N+1)/2 iterations' worth of tokens. An attempt whose snapshot is
below that baseline is reported as unknown rather than guessed.

### Per-call Codex usage

`codex exec --json` reports one cumulative total per turn, so an implement
turn that ran fifty commands shows as one record of millions of mostly cached
input tokens. Codex's rollout file under `CODEX_HOME/sessions` has the usage of
every model call. After each Codex attempt Nitely reads it and writes one
`stage.runtime.calls` record per model call, plus each tool output's size. That
shows how the cached input builds up. Large tool outputs read early are resent
on every later call. Late calls that add a few hundred bytes of new tool output
still reread the whole context.

The attempt total stays the `turn.completed` snapshot. A resumed attempt only
counts the calls appended after it started. When the rollout is missing,
unreadable, or does not add up to that total, the turn records stay and the
reason is recorded. Only numbers and identifiers are read from the rollout.
[Tracing](tracing.md) has the record format, the fallback reasons, and how the
OCI backend finds the rollout.

The Web Console stage details show the per-call curve under "Model calls", and
`nitely diagnose` reports `resent-tool-output` when large early outputs account
for a large share of an attempt's cached input.

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
