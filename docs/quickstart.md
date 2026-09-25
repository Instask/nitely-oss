# Quickstart

From a fresh clone to a governed spec-to-PR run in four steps. Steps 1 and 2 need
no coding agent, credentials, or network access; step 3 is the first real run.

Requirements: Node.js 24+, pnpm 11, and Git. Linux is the supported execution
platform; see the [README](../README.md) for the full list.

## 0. Install

```bash
git clone https://github.com/Instask/nitely-oss.git nitely
cd nitely
pnpm install
pnpm run build
```

The CLI is `node dist/index.js` (or `pnpm dev --` to run from source). The
examples below use `node dist/index.js`.

## 1. Watch the whole loop offline

The golden-path demo runs Nitely's real flow runner, worktrees, stages, and
evidence writer against a fixture repository, with the coding agent and GitHub
mocked:

```bash
node dist/index.js smoke golden-path --output /tmp/nitely-golden-path
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
node dist/index.js validate flows/implement-spec-bootstrap-claude.json \
  --external-input spec --external-input tech-design
node dist/index.js graph flows/implement-spec-bootstrap-claude.json \
  --external-input spec --external-input tech-design
```

This flow writes tests, implements, runs your test command, reviews, publishes a
draft PR, and records a reflection. Flows under `flows/` are the built-in
starting points; [flow-format.md](flow-format.md) describes the schema.

## 3. Run it on your repository

A real run needs:

- a Git repository whose `origin` is on GitHub, with a clean working tree;
- `NITELY_GITHUB_TOKEN` (or `GITHUB_TOKEN`) that can push branches and open
  draft PRs there;
- the agent CLI the flow uses. The flow above uses Claude Code with
  `ANTHROPIC_API_KEY`; `flows/implement-spec-bootstrap.json` uses the Codex CLI.

The built-in flows verify with Nitely's own commands
(`pnpm exec vitest run && pnpm run check && pnpm run build`). Copy the flow and
point its `test` stage at your repository's checks:

```bash
cp flows/implement-spec-bootstrap-claude.json /tmp/my-flow.json
# edit the "command" of the stage with "id": "test", e.g. "npm test" or "make check"
node dist/index.js validate /tmp/my-flow.json \
  --external-input spec --external-input tech-design
```

Write down the intent. Start from [templates/nitely-spec.md](templates/nitely-spec.md)
and [templates/nitely-technical-plan.md](templates/nitely-technical-plan.md), and
keep the first change small: one behavior, one test.

```bash
node dist/index.js run /tmp/my-flow.json \
  --repo /path/to/your/repo \
  --input spec=/path/to/spec.md \
  --input tech-design=/path/to/tech-design.md
```

Nitely creates a branch and worktree under `/path/to/your/repo/.nitely/runs/<run-id>/`,
leaves your checkout untouched, and ends with a draft PR whose description is
the run's evidence. If a stage fails or needs a decision, the run stops as
failed or blocked instead of guessing; [rework-and-recovery.md](rework-and-recovery.md)
covers resume, retry, and rework.

## 4. Use the Web Console

```bash
node dist/index.js web --home /path/to/your/repo --host 127.0.0.1 --port 4173
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
