# Authoring And Running Nitely Flows

A Flow is a JSON contract. Nitely validates it before execution, so most
authoring mistakes are caught by `nitely validate <flow>` rather than by a
wasted agent session.

Deeper reference: `docs/flow-authoring-guide.md`, `docs/work-item-model.md`,
`docs/user-defined-flows.md`, and the `flows/` directory in the checkout.

## Shape

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": { "name": "implement-spec-bootstrap" },
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
      }
    ]
  }
}
```

Identifiers (stage ids, artifact ids, skill ids) start with a letter or number
and contain only letters, numbers, dots, underscores, and hyphens.

## Stage types

| Type | Purpose |
| --- | --- |
| `agent` | Runs an agent CLI with a prompt; must declare outputs |
| `command` | Runs a shell command in the worktree |
| `gate` | `mode: "deterministic"` (shell command, pass on exit 0), `mode: "review"` (agent review producing a verdict artifact; `blocking: false` makes its verdict advisory), or `mode: "review-aggregate"` (merges the review outputs named in `perspectives` into one fail-closed decision) |
| `approval` | Blocks for a human approve/deny decision |
| `sync-change` | Merges the base branch into the change branch and reports |
| `publish-change` | Opens the draft PR (`provider: "github"`, or legacy `"github-cli"`) |
| `update-change` | Updates an existing PR branch in place |

Built-in issue execution flows end with a `reflect` agent stage after
publish/update: it audits the execution, searches for duplicate follow-up work,
and records a `reflection` artifact.

## Runtimes

A stage declares either `runtime` (plus optional `model`) or an ordered
`runtimes` list — never both:

```json
"runtimes": [
  { "runtime": "claude" },
  { "runtime": "codex", "model": "gpt-5.3-codex-spark" }
]
```

Fallback happens only when a candidate cannot start or is externally blocked
(usage, rate, quota, capacity, credential, launch errors). A runtime that runs
to completion and then fails validation — missing outputs, failing commands, a
failed review gate — does **not** fall back.

Supported runtimes: `codex`, `claude`, `glm`, `grok`, `pi`. Omit `model` to
keep the CLI default authoritative.

## Outputs and artifacts

Agents write `<output-id>.md` or `<output-id>.txt` into the attempt directory
(also exposed as `NITELY_ATTEMPT_DIR` / `NITELY_OUTPUT_DIR` on the local
backend). An optional `artifact.json` manifest can name paths explicitly:

```json
{
  "version": 1,
  "stageId": "implement",
  "attempt": 1,
  "outputs": [{ "id": "implementation", "path": "implementation.md", "mediaType": "text/markdown" }]
}
```

Manifest paths must stay inside the attempt directory and every manifest output
id must be declared on the stage. Outputs may also be contract objects with
`name`, `type`, `description`, `mediaType`, `schema`, `version`; `schema` is
recorded as opaque JSON and is not validated against file contents.

Convention: declare `pr-title` as an agent output and pass it to
`publish-change`/`update-change` to control the PR title.

## Skills on a stage

Skills are repo-defined instruction packs, discovered only from
`<repo>/.nitely/skills/<skill-id>/SKILL.md`, never selected automatically:

```json
{ "id": "implement", "type": "agent", "runtime": "codex", "skills": ["tdd"], "...": "..." }
```

`SKILL.md` needs frontmatter with a `name` matching the directory, a non-empty
`description`, and a non-empty body. Other files in the directory are bundled
resources, copied into `.nitely/runs/<run-id>/skills/<skill-id>/` and listed in
the prompt's `## Skills` section. Symlinks are rejected. `skills` is valid on
`agent` stages only (review gates also accept `required_mcp_servers` and
`required_connectors`).

Install a skill into a repo with `nitely skill import <path> --repo <path>`.

## Retries, runaway ceiling, timeouts

- Attempt budget resolves as `stage.maxAttempts` → `spec.maxAttempts` → `1`.
  Each attempt writes an immutable
  `.nitely/runs/<run-id>/stages/<stage-id>/<attempt>/` directory.
- Agent stages use `timeouts.sessionMs`; review gates must use it too (not the
  legacy `timeoutMs`, which stays for deterministic gates).
- Every run sits under a 2,000,000 uncached-runtime-token machine-wide ceiling
  (`NITELY_DEFAULT_MAX_RUNTIME_TOKENS`; `0` opts out). Crossing it emits
  `budget.exceeded` and stops the run; raise the env cap above the consumed
  total and `resume`. Flows cannot declare `spec.budgets`.

## Capabilities

Stages can declare `capabilities`, which the `oci` backend enforces and other
backends record:

```json
"capabilities": {
  "commands": { "mode": "allow-list", "allow": ["pnpm test*", "git"], "deny": ["git push*"] },
  "network": { "mode": "restricted", "domains": ["api.anthropic.com"] }
}
```

A stage that forbids writes but allows commands fails closed — a shell command
can mutate the worktree.

## Built-in flows in the checkout

`flows/` holds runnable baselines, among them:

| Flow | Use |
| --- | --- |
| `implement-spec-bootstrap.json` | Spec + tech design → draft PR (Codex baseline) |
| `implement-spec-bootstrap-claude.json` | Same topology on the Claude runtime |
| `implement-spec-bootstrap-grok.json` / `-pi.json` | Grok Build / Pi variants |
| `plan-approve-implement-bootstrap.json` | Plan and approval before implementation |
| `rework-pr-bootstrap.json` | Rework an existing PR |
| `rework-spec-bootstrap.json` / `rework-tech-design-bootstrap.json` | Rework planning artifacts |
| `resolve-conflicts-bootstrap.json` | Resolve PR conflicts |
| `pilot-approved-spec-pr.json`, `pilot-bug-ticket-fix-pr.json`, `pilot-pr-review-rework.json`, `pilot-issue-to-production.json` | Pilot-ready templates |
| `security-fix-pr.json` | Bounded security fix flow |
| `converge-feature-artifacts.json` | Convergence pass over drifted artifacts |

Copy one and edit rather than starting from an empty file; then
`nitely validate` before running.

## Custom flows in the Web Console

The console can create a flow from a template, edit it with live schema-aware
validation, and run a work item from it. Custom flows live in the local
database and run without a flow file. Non-dev flows declare their own
`workItemType`; dev tasks use the built-in `dev.pr` type. See
`docs/user-defined-flows.md` and `docs/work-item-model.md`.
