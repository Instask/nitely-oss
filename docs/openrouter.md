# OpenRouter Models

Status: supported through the `openrouter` agent runtime.

The `openrouter` runtime runs Nitely `agent`, `judge`, and review-gate stages on
any model [OpenRouter](https://openrouter.ai/) routes to, such as
`qwen/qwen3-coder-next`, `moonshotai/kimi-k3`, or `z-ai/glm-5.3`, with one
API key. Nitely has no agent loop of its own, so the runtime drives the
[Pi coding agent](https://pi.dev/) CLI through Pi's built-in `openrouter`
provider. Stages keep Pi's file-edit and shell tools; Nitely owns the
credential and the model selection.

## Why Pi

Of the coding-agent CLIs Nitely already runs, Pi is the one whose OpenRouter
path keeps tool use working for non-Anthropic, non-OpenAI models:

- **Pi** ships an `openrouter` provider that talks to
  `https://openrouter.ai/api/v1` with OpenAI-compatible chat completions and
  function tools, reads `OPENROUTER_API_KEY`, and carries OpenRouter-specific
  handling for reasoning, provider routing, and prompt caching.
- **Claude Code** can be pointed at OpenRouter's Anthropic-compatible endpoint,
  but OpenRouter only guarantees that for Anthropic's own models; tool use with
  other model families may fail, which defeats the point of a gateway.
- **Codex** speaks only the OpenAI Responses API. OpenRouter's Responses
  endpoint still rejects some of the tool types Codex sends, and Nitely's
  isolated `CODEX_HOME` keeps the operator's `config.toml`, so a config written
  for OpenAI would also apply to OpenRouter runs.

## Setup

1. Install the Pi CLI (`npm install -g @earendil-works/pi-coding-agent`) on
   the host that executes stages, or in the OCI runner image, so
   `pi --version` works. `NITELY_PI_COMMAND` overrides the command name,
   exactly as for the `pi` runtime.
2. Create an OpenRouter API key at <https://openrouter.ai/settings/keys> and
   give it to Nitely in one of two ways:
   - **Web Console:** Providers → OpenRouter → API key. The key is kept in the
     provider secret store (`connections.secrets.json`, mode `0600`), never in
     `connections.json`; API responses, provider status, run events, and
     artifacts show only connection metadata.
   - **Environment:** export `OPENROUTER_API_KEY` for the Nitely process.
3. Select the runtime and an OpenRouter model id in the flow.

`nitely doctor` and run preflight report the `openrouter` provider as missing
until one of the credential sources is configured, and block a lone
`openrouter` stage that has no usable model id.

## Flow configuration

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": { "name": "implement-with-openrouter" },
  "spec": {
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "openrouter",
        "model": "qwen/qwen3-coder-next",
        "prompt": "Implement the approved spec.",
        "inputs": [],
        "outputs": ["implementation"]
      }
    ]
  }
}
```

Nitely launches `pi -p --provider openrouter --model openrouter/<model>` in
the stage worktree and sends the prompt on stdin. Pi strips exactly one
`openrouter/` prefix, so the id OpenRouter receives is the stage's `model`
unchanged, including OpenRouter's own `openrouter/...` ids such as
`openrouter/auto`.

`model` is required: OpenRouter routes to hundreds of models and a silent
default would bill the wrong one. Use an id from <https://openrouter.ai/models>
in the form `<author>/<model>`. A `~` "latest" alias prefix
(`~deepseek/deepseek-v4-flash-latest`) and `:variant` suffixes (`:free`,
`:batch`) are accepted.

`openrouter` works as an ordered `runtimes` candidate too, which is how to fall
back between models:

```json
"runtimes": [
  { "runtime": "openrouter", "model": "qwen/qwen3-coder-next:free" },
  { "runtime": "openrouter", "model": "qwen/qwen3-coder-next" },
  { "runtime": "codex" }
]
```

## Reasoning effort and evaluation runs

Set optional `effort` on a stage or runtime candidate, or supply `--model` and
`--effort` to `nitely run` / `nitely task create`. Add `--runtime openrouter`
when the stored Flow uses a different runtime. API callers use
`{ "overrides": { "model": "openai/gpt-oss-120b", "effort": "high" } }`.
See [running flows](running-flows.md#model-and-effort-overrides) for scope and
snapshot behavior.

For applicable models, Nitely passes a separate `--thinking <level>` to Pi,
using the Nitely level when Pi accepts it. Do not append `:high` to a model
id: OpenRouter's `:free` and `:batch` variants are part of the model id and
are preserved. The model string passed to Pi is not rewritten for capability
lookup.

The bundled capability metadata identifies `qwen/qwen3-coder-next` as not
supporting reasoning, based on OpenRouter's
[model catalog](https://openrouter.ai/api/v1/models). Capability matching
canonicalizes an id by stripping one leading `openrouter/` prefix, one leading
`~` alias, and a `:variant` suffix. These ids therefore share one capability
id, `qwen/qwen3-coder-next`:

- `qwen/qwen3-coder-next`
- `qwen/qwen3-coder-next:free`
- `~qwen/qwen3-coder-next`
- `~qwen/qwen3-coder-next:free`
- `openrouter/qwen/qwen3-coder-next:free`

The leading `openrouter/` form is recognized only for capability identity. A
stage model remains an author/slug id, optionally with `~` or `:variant`.

For that capability, effort is optional. A requested effort stays in
`requestedEffort`, `--thinking` is omitted, no native effort is sent, and
`effortStatus` is `not-applicable`. Other models use the requested level, or
the CLI default when effort is omitted. The bundled capability entry is a
snapshot, rather than a live catalog lookup.

## Credential precedence

From highest to lowest:

1. A stored OpenRouter connection, selected by the normal
   [provider connection](provider-connections.md#selection) rules: an
   explicit connection binding wins, otherwise the default connection; a user's
   personal connections shadow the shared repository store. A stored
   connection replaces any `OPENROUTER_API_KEY` inherited from the
   environment, so a run never authenticates as something the operator did not
   configure.
2. `OPENROUTER_API_KEY` in the Nitely process environment.

Nitely hands the selected key to Pi only as `OPENROUTER_API_KEY` in the child
environment. It never passes it on the command line or in the prompt, so it
does not appear in argv or launch evidence, and run redaction treats
`OPENROUTER_API_KEY` (like every `*_API_KEY`) and `sk-…` values as secrets in
events, logs, and artifacts.

Pi itself prefers an OpenRouter credential stored in its own `auth.json`
(`pi /login`, including OpenRouter OAuth) or a `models.json` provider `apiKey`
over the environment. Do not configure OpenRouter inside Pi on hosts that run
Nitely, or that credential will be used instead of the one Nitely selected.

## Failures

Nitely reads Pi's stderr after a non-zero exit and appends an explanation to
`openrouter exited with code N`. Pi already retries transient 429/5xx
responses itself (three times with exponential backoff by default) before it
exits.

| Situation | Where it surfaces | Outcome |
| --- | --- | --- |
| No key configured | run preflight, agent preflight, before spawn | `agent runtime openrouter is not configured. Set OPENROUTER_API_KEY.` An ordered `runtimes` stage moves to the next candidate. |
| Missing or malformed `model` | run preflight (`runtime-model-unsupported`), agent preflight, before spawn | Names the problem, an example id, and the model list. Run preflight warns when another candidate can still run and blocks when none can; at execution an ordered stage moves to the next candidate. |
| Key rejected (401) | stage exit | `OpenRouter rejected the API key (401)…`; the run blocks with `agent_credentials_invalid` and can be resumed after the key is replaced. |
| Out of credits or key limit reached (402) | stage exit | `OpenRouter quota exceeded…`; blocks with `agent_usage_limit` (or falls back to the next candidate). |
| Rate limited (429) | stage exit | `OpenRouter rate limit reached for model …`; blocks with `agent_usage_limit` (or falls back to the next candidate). |
| Model unknown or no endpoint (404) | stage exit | `OpenRouter has no available endpoint for model …`; an ordinary stage failure that follows `maxAttempts`. |
| Upstream provider error, overload, or timeout (5xx/408) | stage exit | `OpenRouter or its upstream provider failed…`; an ordinary stage failure that follows `maxAttempts`. |
| Pi not installed | before spawn | `unable to start agent runtime openrouter: command pi was not found`. |
| Pi too old to have an `openrouter` provider | stage exit | Asks to upgrade Pi or point `NITELY_PI_COMMAND` at a current Pi. |

## OCI backend

- Install `pi` in the runner image.
- Add `OPENROUTER_API_KEY` to `NITELY_OCI_SECRET_ALLOWLIST`; preflight fails
  with `Allow OPENROUTER_API_KEY` otherwise. The key enters the container by
  name (`--env OPENROUTER_API_KEY`), never as a value in the `docker run`
  arguments.
- Allow `openrouter.ai` in `NITELY_OCI_NETWORK_ALLOWLIST` or in the stage's
  restricted network domains. Like every built-in runtime, `openrouter`
  requires the allowlist gateway.

## Limitations

- Execution depends on the Pi CLI's OpenRouter provider. The integration was
  checked against Pi 1.0.4 (`@earendil-works/pi-coding-agent`), including the
  real 401 output for a rejected key; no paid end-to-end run against a live
  OpenRouter key is part of the test suite.
- Model validation in Nitely is syntactic. Whether OpenRouter serves a model is
  only known when Pi calls the API; that failure is reported at stage exit.
- Pi resolves `--model` against its bundled model catalog before falling back
  to the literal id. An id that is missing from the installed Pi's catalog but
  is a substring of a catalog id (for example a truncated
  `qwen/qwen3-cod`) can resolve to that catalog model instead. Use exact ids,
  keep Pi current, and check `pi --list-models <id>` or OpenRouter's Activity
  page when in doubt.
- OpenRouter presets (`@preset/...`) and request-level routing options
  (provider order, data policy) are not exposed in the flow; set them on the
  OpenRouter account or key.
- Pi does not report token usage or cost to Nitely, so `openrouter` stages
  record no runtime usage (the same as `pi`, `glm`, and `grok`). Use the
  OpenRouter dashboard for spend.
- Like `pi`, the local backend has no read-only enforcement for this runtime;
  stages with `capabilities.write.scope: none` must use OCI.
- Pi reads the operator's Pi settings and extensions; Nitely has no global
  skill isolation for Pi.
