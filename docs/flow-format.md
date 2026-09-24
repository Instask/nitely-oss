# Flow Format

The Flow JSON document. Authoring judgment — stage boundaries, test-first topology, capabilities, and the runaway ceiling — is in the [flow authoring guide](flow-authoring-guide.md).

Flows use `apiVersion: "nitely.dev/v1alpha1"` and define a list of stages:

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": {
    "name": "implement-spec-bootstrap"
  },
  "spec": {
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Implement the supplied specification and produce a concise pr-title artifact.",
        "inputs": ["spec"],
        "outputs": ["implementation", "pr-title"]
      },
      {
        "id": "test",
        "type": "gate",
        "mode": "deterministic",
        "command": "pnpm exec vitest run && pnpm run check && pnpm run build",
        "inputs": ["implementation"],
        "outputs": ["test-report"]
      },
      {
        "id": "publish",
        "type": "publish-change",
        "provider": "github",
        "inputs": ["implementation", "test-report", "pr-title"],
        "outputs": ["change-request"]
      },
      {
        "id": "reflect",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Reflect on the finished issue execution and record follow-up issues or a clean result.",
        "inputs": ["implementation", "test-report", "change-request"],
        "outputs": ["reflection"]
      }
    ]
  }
}
```

For built-in issue execution flows, `reflect` is the final stage after
`publish-change` or `update-change`. It is not a publish gate: the PR already
exists, and the reflection artifact records created follow-up issues, duplicate
matches, non-actions, or a clean no-follow-up result. Engine-level failures that
stop before the final stage still require a later finalizer/always-run feature.

Stage `outputs` remain backward compatible with string artifact ids. A stage can
also declare an output contract object when downstream prompts, evidence, or the
Web Console need durable artifact metadata:

```json
"outputs": [
  {
    "id": "implementation",
    "name": "Implementation summary",
    "type": "implementation",
    "description": "Markdown summary of code changes and verification",
    "mediaType": "text/markdown",
    "schema": { "kind": "markdown" },
    "version": "1"
  },
  "pr-title"
]
```

The `id` field uses the same identifier rules as string outputs. `name`,
`type`, `description`, `mediaType`, `schema`, and `version` are optional; Nitely
records `schema` as opaque JSON and does not validate artifact file contents
against it. Accepted output filenames are unchanged: agents still write
`<id>.md` or `<id>.txt`.

Agents may also write an attempt-local `artifact.json` manifest:

```json
{
  "version": 1,
  "stageId": "implement",
  "attempt": 1,
  "outputs": [
    {
      "id": "implementation",
      "path": "implementation.md",
      "mediaType": "text/markdown"
    }
  ]
}
```

Manifest paths must be relative paths inside the same attempt directory, and
each manifest output id must match a declared stage output. If `artifact.json`
is absent, Nitely remains backward compatible by discovering `<id>.md` first and
then `<id>.txt` for each declared output, validating those files, and writing a
synthesized manifest for the successful attempt.

Each run writes `.nitely/runs/<run-id>/artifacts.json` with external input and
generated artifact records. Generated artifact events feed run projection, and
PR evidence includes an `Artifacts` section. The Web Console run detail API also
returns artifact metadata and file paths.
When command stages run, PR evidence also lists the attempt directory with the
command, exit code, `output.md`, `stdout.log`, and `stderr.log` paths so test
execution can be audited from the change request body.

Nitely records each orchestrator policy choice as an
`orchestrator.decision` event before applying the selected action. Decision
payloads include stage id/type, attempt, max attempts, action, reason, error
summary when present, and rework target when present. Evidence includes an
`Orchestrator Decisions` section so retry, rework, escalation, completion, and
failure rationale can be audited from the run directory.

A `gate` stage records a structured `gate.result` JSON artifact and emits a
`gate.completed` event before the stage completes or fails. Deterministic gates
run a shell `command`, honor `timeoutMs` when set, and pass when the exit code
is zero. Review gates run
through an agent `runtime` with a `prompt`, optional `model`, and optional
`skills`, must declare at least one output, use `timeouts.sessionMs` instead of
legacy `timeoutMs`, require the primary declared output file (`<id>.md` or
`<id>.txt`), and record the
reviewed input artifact ids plus a bounded copy of that output in the structured
gate result. Review gates fail when that output contains an explicit failing
verdict such as `Review verdict: fail` or a blocking severity marker at the
start of a heading/line such as `### P1 - ...` or `[P0] ...`. Clean review text,
explicit pass verdicts, and P2/P3 advisory findings continue to pass. PR
evidence includes a `Gates` section with each gate's mode, command or runtime,
review output path, status, and failure reason when present.
The Web console severity summary uses those same finding-shaped review lines and
explicit no-issue/pass text; incidental prose such as "No P0/P1/blocking
findings" is not counted as a finding.

An `agent` stage may set an optional `model` to choose the model for its
`runtime`. When `model` is omitted, the selected CLI default is used. Generated
PR evidence includes an `Agent Runtimes` section with each agent stage id,
runtime, and model or `default`.

An `agent` stage may also opt into local skills with `skills`. Skills are
repository-defined instruction packs discovered only from
`.nitely/skills/<skill-id>/SKILL.md`; they are never selected automatically and
are not global project instructions.

```text
.nitely/skills/tdd/SKILL.md
.nitely/skills/tdd/checklist.md
```

`SKILL.md` must contain frontmatter with a matching `name`, a non-empty
`description`, and a non-empty instruction body:

```markdown
---
name: tdd
description: Write tests before implementation
---

Follow red-green-refactor.
```

Flow stages reference skills by id:

```json
{
  "id": "implement",
  "type": "agent",
  "runtime": "codex",
  "skills": ["tdd"],
  "required_mcp_servers": ["google-drive"],
  "required_connectors": ["github"],
  "prompt": "Implement the supplied specification.",
  "inputs": ["spec"],
  "outputs": ["implementation"]
}
```

Skill ids use the same identifier shape as stages and artifacts: they start with
a letter or number and contain only letters, numbers, dots, underscores, and
hyphens. `skills` is valid only on `agent` stages, while
`required_mcp_servers` and `required_connectors` are valid on `agent` stages and
review gates. Duplicates on the same stage are rejected. Missing skills,
malformed frontmatter, empty bodies, name mismatches, invalid ids, and unsafe
bundled resource paths fail before the agent command starts with an error naming
the stage and skill.

Files under `.nitely/skills/<skill-id>/` other than `SKILL.md` are optional
bundled resources. Nitely does not follow symlinks. Resource files are copied to
`.nitely/runs/<run-id>/skills/<skill-id>/...` and listed in the injected
`## Skills` prompt section so the agent can read a stable run snapshot without
polluting the git worktree. Prompt and evidence text for skills passes through
the same runtime redaction path as other prompts and evidence. Generated PR
evidence includes a `Loaded Skills` section with the stage id, skill id, source
path, description, content hash, and resource snapshot paths. Loaded skill
metadata is also persisted in run events so resumed `publish-change` and
`update-change` stages can include skills loaded by already-completed agent
stages.

Skill improvement observations are kept in `.nitely/skill-improvements.db` and require
operator confirmation. Review them with `skill improvements list`; use `confirm` for a
papercut, `propose` with pinned #429 eval cases, then `decide` and `evaluate`. Nitely
never edits or publishes a skill automatically, and a changed source hash blocks application.

Publish and update stages can consume an agent-produced PR title artifact. By
convention, declare `pr-title` as an agent output and pass it to
`publish-change` or `update-change`. The agent can materialize that artifact as
`pr-title.md` or `pr-title.txt` in its attempt directory. Agent prompts include
the attempt directory and accepted filenames for each declared output, and the
local backend exposes that same directory as `NITELY_ATTEMPT_DIR` and
`NITELY_OUTPUT_DIR`. Nitely trims the title, removes a leading markdown heading
marker, collapses whitespace and line breaks to one space, and bounds the final
PR title to 120 characters. If the artifact is not supplied, missing, or empty
after sanitization, Nitely keeps the fallback title `Nitely: <flow-name>` and
fallback publish commit message `feat: <flow-name>`. Evidence and
`change.published` or `change.updated` events record the resolved title and
whether it came from an artifact or fallback.
