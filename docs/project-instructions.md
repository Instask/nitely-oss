# Project Instructions

Nitely can load advisory repository instructions from
`.nitely/instructions.json`. The file is repo-local and is read at run start and
resume time. Instructions are added to agent and review prompts and summarized in
run evidence.

Project instructions do not replace tests, gates, or policy checks. Treat them
as durable team guidance for implementation and review stages.

## Format

```json
{
  "version": 1,
  "instructions": [
    {
      "id": "frontend",
      "title": "Frontend conventions",
      "appliesTo": "both",
      "include": ["src/web/**"],
      "exclude": ["src/web/**/*.test.ts"],
      "text": "Keep UI copy short and use existing dashboard components."
    }
  ]
}
```

Fields:

- `version`: must be `1`.
- `instructions`: array of instruction groups.
- `id`: stable group id. Use letters, numbers, dots, underscores, or hyphens.
- `title`: optional display title.
- `appliesTo`: `agent`, `review`, or `both`; defaults to `both`.
- `include`: optional glob list; defaults to `["**/*"]`.
- `exclude`: optional glob list.
- `text`: required advisory instruction text.

Glob filters match repo-relative input artifact source paths. Unfiltered groups
with the default `["**/*"]` apply even when a stage has no path-like inputs.
Filtered groups apply only when at least one candidate path matches `include`
and no `exclude` pattern matches that path.

## Prompt And Evidence

For matching agent and review stages, Nitely adds a `Project Instructions`
section to `prompt.md` with the source file, file hash, matching group metadata,
matched paths, and instruction text.

Run evidence includes a `Project Instructions` section showing whether the file
was loaded, the source path, file hash, and instruction group ids/filters. The
full instruction text is kept in prompts, not repeated in evidence.

## Flow Context Controls

Flows can disable inherited prompt context at the flow or stage level:

```json
{
  "spec": {
    "context": { "isolated": true },
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Implement the change.",
        "inputs": ["spec"],
        "outputs": ["implementation"]
      },
      {
        "id": "review",
        "type": "gate",
        "mode": "review",
        "runtime": "codex",
        "prompt": "Review the implementation.",
        "inputs": ["implementation"],
        "outputs": ["review-gate"],
        "context": { "isolated": false, "instructionFiles": false }
      }
    ]
  }
}
```

`isolated: true` disables inherited prompt-only context by default for that
scope: project instructions, context knowledge, and previous failure context.
Declared `inputs` and generated artifact contracts still work normally; use
them when an isolated stage should consume upstream work.

Stage-level `context` overrides the flow default. Set `isolated: false` on a
stage when it should keep continuity, or enable specific channels such as
`projectInstructions`, `contextKnowledge`, or `previousFailures`.

`fullReadInputs` lists input ids whose truncated preview is not enough. Only
those inputs get an absolute `Full content` path plus an instruction to read the
whole file; every other truncated input is delivered as orientation. Each id
must be declared in that stage's own `inputs`. See
[Context Delivery And Usage](context-delivery-and-usage.md) for the full
contract.

`globalSkills` controls the operator's user-global runtime skill packs. Leave
it unset and Nitely isolates them wherever the runtime supports it. Set it to
`false` to demand isolation, which fails the stage on a runtime that offers no
mechanism. Set it to `true` to opt back into the operator's packs. This is
independent of `instructionFiles`, which covers repository files. See
[Context Delivery And Usage](context-delivery-and-usage.md) for the mechanism
per runtime.

`sessionReuse` decides whether a repeated execution of this stage in the same
worktree continues the runtime's previous session instead of starting cold. It
defaults to on for stages that declare `taskPlan`. See
[Context Delivery And Usage](context-delivery-and-usage.md) for the delta-prompt
contract.

`instructionFiles: false` temporarily hides root repository instruction files
that agent runtimes may auto-load, currently `AGENTS.md` and `CLAUDE.md`, while
that stage runs. Nitely restores those files after the stage. If the stage
recreates one of those paths while it is hidden, the run fails instead of
silently overwriting either file.

Run evidence includes a `Stage Context Controls` section with the resolved
settings for each agent and review-gate stage. Each agent attempt also emits a
`stage.runtime.global-skills` event recording whether the operator's global
packs were actually isolated, and why not when they were not.

## Errors

Invalid JSON, duplicate ids, missing `text`, or invalid field types fail the run
before execution with an actionable `invalid .nitely/instructions.json: ...`
message.
