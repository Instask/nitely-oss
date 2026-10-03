# Quickstart

From a fresh clone to a governed spec-to-PR run in four steps. Steps 1 and 2 need
no coding agent, credentials, or network access; step 3 is the first real run.

Requirements: Node.js 24+, pnpm 11, and Git. Linux is the supported execution
platform; see the [README](../README.md) for the full list.

## Repository commands

Built-in verification flows use your repository's commands. Create
`.nitely/instructions.json` in the target repository:

```json
{
  "version": 1,
  "configuration": {
    "setupCommand": "uv sync --frozen",
    "verifyCommand": "uv run pytest"
  }
}
```

Use commands appropriate to your project; for Node projects, for example,
`pnpm install --frozen-lockfile` and `pnpm test`. Nitely's own check/test/build
sequence is configured in this repository's instructions file. Task flow
configuration overrides repository defaults. Missing required commands block
preflight with a configuration error. The command recorded in stage evidence
is the resolved command. Resumed runs retain their saved configuration.
For OCI setup, edit the setup stage's `networkDomains` to match your registries.

## 0. Install

```bash
git clone https://github.com/Instask/nitely-oss.git nitely
cd nitely
pnpm install
pnpm run build
npm link
nitely --help
```

`npm link` puts `nitely` on your `PATH`; the rest of this guide runs it from
anywhere. Built-in flows (`flows/<name>.json`) resolve from this checkout unless
the repository you run in has its own copy.

## 1. Watch the whole loop offline

The golden-path demo runs Nitely's real flow runner, worktrees, stages, and
evidence writer against a fixture repository, with the coding agent and GitHub
mocked:

```bash
nitely smoke golden-path --output /tmp/nitely-golden-path
```

It plans a task, approves it, implements it in an isolated worktree, verifies and
reviews the change, publishes a (mocked) draft PR, then reworks that PR from
reviewer feedback. Look at what it left behind:

```bash
cat /tmp/nitely-golden-path/summary.json
cat /tmp/nitely-golden-path/fixture-repo/.nitely/runs/run-golden-implementation/evidence.md
```

`summary.json` reports a `proof` object; every field is `true` when the loop
held. The evidence file is what a reviewer reads next to a real PR. See
[golden-path-demo.md](golden-path-demo.md) for what each step proves.

## 2. Read a flow before running it

A Flow is a declared sequence of stages. Validate one and print its stage graph:

```bash
nitely validate flows/implement-spec-bootstrap-claude.json \
  --external-input spec --external-input tech-design
nitely graph flows/implement-spec-bootstrap-claude.json \
  --external-input spec --external-input tech-design
```

This flow writes tests, implements, runs your test command, reviews, publishes a
draft PR, and records a reflection. Flows under `flows/` are the built-in
starting points; [flow-format.md](flow-format.md) describes the schema.

## 3. Run it on your repository

A real run needs:

- a Git repository whose `origin` is on GitHub (runs start from its latest
  default branch, not from your working tree);
- `NITELY_GITHUB_TOKEN` (or `GITHUB_TOKEN`) that can push branches and open
  draft PRs there;
- the agent CLI the flow uses. The flow above uses Claude Code with
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; `flows/implement-spec-bootstrap.json` uses the Codex CLI.

Configure your repository commands as shown above, then validate and check
the selected flow before running:

```bash
cd /path/to/your/repo
nitely validate flows/implement-spec-bootstrap-claude.json \
  --external-input spec --external-input tech-design
nitely doctor flows/implement-spec-bootstrap-claude.json --repo . \
  --input spec=spec.md --input tech-design=tech-design.md
```

Write down the intent. Start from [templates/nitely-spec.md](templates/nitely-spec.md)
and [templates/nitely-technical-plan.md](templates/nitely-technical-plan.md), and
keep the first change small: one behavior, one test.

```bash
nitely run flows/implement-spec-bootstrap-claude.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
```

Nitely creates a branch and worktree under `.nitely/runs/<run-id>/`,
leaves your checkout untouched, and ends with a draft PR whose description is
the run's evidence. If a stage fails or needs a decision, the run stops as
failed or blocked instead of guessing; [rework-and-recovery.md](rework-and-recovery.md)
covers resume, retry, and rework.

## 4. Use the Web Console

```bash
nitely web --home . --host 127.0.0.1 --port 4173
```

Open <http://127.0.0.1:4173>. Tasks are where planned work, approvals, runs,
and PRs meet; runs show every stage's logs and evidence. Plan a task from a
prompt or GitHub issue, approve its spec and technical design, then start it.
See [web-console.md](web-console.md).

## Next

- [Running flows](running-flows.md): inputs, change-size flows, single stages.
- [Execution backends](execution-backends.md): run stages in containers (OCI).
- [Remote operations](remote-operations.md): drive a shared server from the CLI.
- [Nitely agent skill](nitely-skill.md): let your coding agent set Nitely up.
