# The Nitely Agent Skill

`skills/nitely/` is an agent skill that teaches a coding agent how to install,
configure, and operate Nitely: the install path, the validate → doctor → run →
inspect loop, how to clear approvals, operator questions, and usage-limit
blockers, how to author flow JSON, and where the evidence lives.

It exists so a new user does not have to read 1,500 lines of `README.md` before
their first run: they install the skill, then ask their agent to set Nitely up.

## Install

From a Nitely checkout:

```bash
scripts/install-nitely-skill
```

Without a checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/Instask/nitely-oss/master/scripts/install-nitely-skill | bash
```

Both install the personal Claude Code skill at
`${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nitely`. Start a new agent session
afterwards so it is picked up.

## Install targets

| Command | Target | Use |
| --- | --- | --- |
| `scripts/install-nitely-skill` | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nitely` | Available in every project on the machine |
| `scripts/install-nitely-skill --project [PATH]` | `PATH/.claude/skills/nitely` | Checked in or kept local to one repository |
| `scripts/install-nitely-skill --nitely-repo PATH` | `PATH/.nitely/skills/nitely` | Loaded by Nitely runs themselves (see below) |
| `scripts/install-nitely-skill --dest PATH` | `PATH` | Any other agent's skill directory |

Other options: `--force` replaces an existing install, `--ref REF` and
`--repo OWNER/NAME` choose what the network mode downloads
(`NITELY_SKILL_REF`, `NITELY_SKILL_REPO` do the same).

The installer copies the files from the checkout when it can find them next to
itself, and downloads them from GitHub otherwise. An existing skill directory
is never replaced without `--force`, and a failed replace restores the previous
one.

## The same skill inside Nitely runs

The skill is written to the format Nitely itself loads, so
`--nitely-repo PATH` (or `nitely skill import skills/nitely --repo PATH`)
installs it at `PATH/.nitely/skills/nitely`, where an `agent` stage can opt into
it:

```json
{ "id": "implement", "type": "agent", "runtime": "codex", "skills": ["nitely"] }
```

That is only useful for flows whose agent operates Nitely itself — meta-flows,
self-hosting bootstrap work, support automation. Ordinary implementation flows
should not load it.

## Contents

```text
skills/nitely/SKILL.md                        entry point: orientation, loop, guardrails
skills/nitely/references/install.md           prerequisites, build, entry points, credentials, per-repo setup
skills/nitely/references/cli.md               command reference grouped by task
skills/nitely/references/flows.md             flow format, stage types, runtimes, skills, runaway ceiling
skills/nitely/references/troubleshooting.md   failures, blockers, backends, context and secrets
skills/nitely/references/web-operations.md    deployed Web instance: OCI checklist, deploy, Console credentials, device login
```

`SKILL.md` stays short on purpose: the agent reads it first and pulls in a
reference file only when the task needs it.

## Maintaining it

The skill restates CLI behavior, so it drifts when commands change. When you
add or change a command, flag, environment variable, stage type, or blocker
status, update the matching reference file in the same PR.

When adding or removing a file under `skills/nitely/`, also update the
`SKILL_FILES` array in `scripts/install-nitely-skill`.
`test/skills/bundled-nitely-skill.test.ts` fails when they drift, and also
checks that the skill passes the same validation Nitely applies to imported and
run-time skills.
