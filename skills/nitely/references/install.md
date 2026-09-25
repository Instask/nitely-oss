# Installing And Configuring Nitely

Nitely is installed from a git checkout. There is no published npm package yet
(`package.json` is `private`), so "install" means: clone, build, and make the
CLI reachable.

## 1. Prerequisites

- Node.js 24 or newer (`node --version`). The repo ships `.nvmrc`; `nvm use`
  picks the right version inside the checkout.
- pnpm 11 (`pnpm --version`). `corepack enable` is enough on recent Node.
- git.

## 2. Clone and build

```bash
git clone https://github.com/Instask/nitely-oss.git nitely
cd nitely
pnpm install
pnpm run build
npm link
```

Check it:

```bash
nitely --help
```

`npm link` puts `nitely` on `PATH` (pnpm 11 has no global link). Built-in
`flows/<name>.json` then resolve from this checkout from any directory, unless
the target repository has its own copy.

## 3. Choose an entry point

| Entry point | Command | Use when |
| --- | --- | --- |
| Source | `pnpm dev -- <args>` | Working on Nitely itself; no build step needed |
| Built | `node dist/index.js <args>` | Stable local use from the checkout |
| Global | `nitely <args>` | Driving other repositories from anywhere |

For the global form, `npm link` from step 2 is enough. Where the npm global
prefix is not writable, drop a wrapper on `PATH` instead:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/nitely <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/src/nitely/dist/index.js" "$@"
EOF
chmod +x ~/.local/bin/nitely
```

Replace `$HOME/src/nitely` with the real checkout path, and make sure
`~/.local/bin` is on `PATH`. Rebuild (`pnpm run build`) after pulling changes.

## 4. Credentials

Nitely never stores provider secrets in flows; they are read from the process
environment (or, for the Web Console, the customer-owned provider store).

**GitHub (draft PR publishing, PR comment operations, issue intake):**

```bash
export NITELY_GITHUB_TOKEN=ghp_...   # GITHUB_TOKEN is accepted as a fallback
```

The token needs repository read/write and pull-request scope on the target
repo. `gh` is only needed for the legacy `provider: "github-cli"` publish path.

**Agent runtimes** — install and authenticate only the CLIs the flows use:

| Runtime | Local CLI | Credentials | Command override |
| --- | --- | --- | --- |
| `codex` | `codex` | `codex` CLI login | `NITELY_CODEX_COMMAND` |
| `claude` | `claude` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | `NITELY_CLAUDE_COMMAND` |
| `glm` | `glm` | `NITELY_GLM_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY` | `NITELY_GLM_COMMAND` |
| `grok` | `grok` | `grok login` or `XAI_API_KEY` | `NITELY_GROK_COMMAND` |
| `pi` | `pi` | Pi CLI model/provider config | `NITELY_PI_COMMAND` |

Either Claude credential satisfies the `claude` runtime: use
`CLAUDE_CODE_OAUTH_TOKEN` (an `sk-ant-oat…` subscription token from
`claude setup-token`) when the account is a Claude subscription rather than a
pay-as-you-go API key. The Web Console provider store accepts both under the
`anthropic` provider.

Missing credentials for a known runtime are caught before the CLI is spawned: a
single-runtime stage fails early, an ordered `runtimes` stage records the
candidate as unavailable and tries the next one.

## 5. Prepare a target repository

The repository Nitely runs against (`--repo`) needs nothing mandatory, but
these are worth setting up once:

```bash
cd /path/to/target-repo
printf '.nitely/\n' >> .gitignore          # run state, worktrees, event log
```

Optional, all repo-root or `.nitely/` files:

| File | Purpose |
| --- | --- |
| `nitely.context.json` | Include/exclude globs and `redactEnv` for what may enter run context |
| `nitely.evidence.json` | Retention windows for runs, events, logs, artifacts, evidence |
| `.nitely/constitution.md` | Non-negotiable governing principles injected into agent and review prompts |
| `.nitely/instructions.json` | Advisory per-stage-type, per-glob instructions |
| `.nitely/skills/<id>/SKILL.md` | Repo-defined skill packs an `agent` stage can opt into with `skills` |

Starter templates live in `docs/templates/` (`nitely-constitution.md`,
`nitely-instructions.json`, `nitely-spec.md`, `nitely-technical-plan.md`,
`nitely-tasks.md`).

## 6. Verify end to end

```bash
nitely validate flows/implement-spec-bootstrap.json \
  --external-input spec --external-input tech-design
nitely doctor flows/implement-spec-bootstrap.json \
  --repo /path/to/target-repo \
  --input spec=./specs/issues/123-thing-spec.md \
  --input tech-design=./docs/plans/2026-06-19-thing-tech-design.md
```

`doctor` needs the same `--input` flags the run will get; a required input it
cannot see is a blocking `missing-input` issue on its own.

`doctor` reports `PASS`, `WARN`, or `BLOCK` with the specific issue codes —
`repo-unavailable`, `flow-invalid`, `missing-input`, `input-unreadable`,
`missing-provider`, `unknown-mcp-server`, `runtime-unavailable`, and friends —
before any agent session is spent. Clear every blocking issue before the first
`nitely run`.

## 7. Optional surfaces

**Web Console** (tasks, planner, runs, provider settings):

```bash
nitely web --home . --host 127.0.0.1 --port 4173
```

**Local stdio MCP server** for external AI coding tools — scoped,
default-deny tokens:

```bash
nitely mcp token create --repo . --name "Claude Code" \
  --capability tasks:read --capability runs:read
NITELY_API_TOKEN='one-time-token-value' nitely mcp serve --server http://127.0.0.1:4173
```

Write capabilities (`tasks:write`, `runs:start`, `spec:approve`) require an
explicit `--allow-high-impact` at token creation. See `docs/local-mcp.md`.

**Connect the CLI to a running server** once, so later commands can omit
`--server`:

```bash
NITELY_API_TOKEN='nitely_api_...' nitely connect --server http://127.0.0.1:4173
nitely whoami
```

Or sign in through the browser against a remote server with users:

```bash
nitely auth login --server https://nitely.example \
  --capability tasks:read --capability runs:start --allow-high-impact
```

The saved instance lives in `$NITELY_CONFIG_DIR/current-instance.json`, else
`$XDG_CONFIG_HOME/nitely/current-instance.json`, else
`~/.config/nitely/current-instance.json`. Tokens are never printed back.

## 8. Updating

```bash
cd /path/to/nitely
git pull
pnpm install
pnpm run build
```

Run state under each target repo's `.nitely/` is forward-compatible event data;
it is not rebuilt by an update.
