# Issue 491 Spec: Isolate Global Runtime Skills

## Background

Nitely already hides worktree `AGENTS.md` and `CLAUDE.md` when
`context.instructionFiles` is false. That covers repository files only. A
dogfood run still opened every implement attempt with:

```
sed -n '1,240p' /home/jerry/.codex/superpowers/skills/using-superpowers/SKILL.md
sed -n '1,260p' /home/jerry/.codex/plugins/cache/openai-curated/.../SKILL.md
```

Those are the operator's user-global Codex skill packs. `codex exec --cd
<worktree>` loads them from `$CODEX_HOME` regardless of what the repository
contains, so an attempt's first tokens are the operator's personal tooling
rather than the Nitely prompt. Grok loads `~/.agents/skills` the same way.

## User Stories

- **US-001:** As an operator, an agent attempt's first tokens are the Nitely
  prompt and its declared inputs, not my personal skill packs.
- **US-002:** As a flow author, I can demand isolation and have the stage fail
  rather than silently load an operator's packs on a runtime that cannot
  isolate.
- **US-003:** As a flow author, I can opt a stage back into the operator's
  packs when that is genuinely what the stage needs.
- **US-004:** As an operator, run evidence tells me whether isolation actually
  happened.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a Codex stage with no `globalSkills` setting, when
  the attempt runs, then the runtime is launched with `CODEX_HOME` pointing at
  a run-owned directory that contains only `auth.json` and `config.toml`.
- **US-001 / SC-002:** Given a stale entry in that directory from an earlier
  attempt, when the next attempt runs, then the directory is rebuilt and the
  stale entry is gone.
- **US-002 / SC-001:** Given a stage with `context.globalSkills: false` and a
  runtime with no isolation mechanism, then the stage fails with a message
  naming the runtime.
- **US-003 / SC-001:** Given `context.globalSkills: true`, then the runtime is
  launched with the operator's own home untouched.
- **US-004 / SC-001:** Each agent attempt emits a
  `stage.runtime.global-skills` event recording `isolated` and, when false, a
  reason; run evidence shows the resolved setting per stage.

## Functional Requirements

- **FR-001:** Add `context.globalSkills` (boolean) at flow and stage level.
  Unset means isolate where supported; `false` means isolation is required;
  `true` means inherit the operator's packs.
- **FR-002:** A runtime declares its isolation mechanism as the environment
  variable that relocates its per-user home plus the entries to preserve.
  Codex declares `CODEX_HOME` preserving `auth.json` and `config.toml`.
- **FR-003:** The isolated home is rebuilt from scratch per attempt, with mode
  `0700`, and holds symlinks to preserved entries only.
- **FR-004:** Isolated homes live under `.nitely/runtime-homes/<run-id>/`,
  outside the run directory, because they link to operator credentials.
- **FR-005:** `required-isolated` on a runtime without a mechanism fails the
  stage.
- **FR-006:** The OCI backend reports isolation unconditionally: its container
  never mounts an operator home.
- **FR-007:** Emit `stage.runtime.global-skills` per agent attempt and show the
  resolved setting in the evidence `Stage Context Controls` section.
- **FR-008:** `instructionFiles` keeps its `true` default, documented as a
  deliberate difference: repository instructions are project-owned.
- **FR-009:** A backend caller that supplies no request keeps the previous
  behavior and makes no claim in the result.

## Non-Functional Requirements

- **NFR-001:** Nitely's own `stage.skills` are untouched.
- **NFR-002:** No credential value is written into an isolated home; only
  symlinks to the operator's existing files.

## Out Of Scope

- Changing interactive `codex` outside Nitely.
- Reimplementing skill packs inside Nitely.
- An isolation mechanism for `claude`, `glm`, `grok`, or `pi`, which expose no
  equivalent switch today.

## Assumptions

- A runtime that supports relocation of its per-user home does not need any
  other entry from that home to authenticate.
