# Together AI Models

Status: supported through the `together` agent runtime.

The `together` runtime runs Nitely `agent`, `judge`, and review-gate stages on
models hosted by [Together AI](https://www.together.ai/). Nitely has no agent
loop of its own, so the runtime drives the [Pi coding agent](https://pi.dev/)
CLI through Pi's built-in `together` provider. Stages keep Pi's file and shell
tools; Nitely owns the credential and the model selection.

## Setup

1. Install the Pi CLI on the host that executes stages (or in the OCI runner
   image) so `pi --version` works. `NITELY_PI_COMMAND` overrides the command
   name, exactly as for the `pi` runtime.
2. Create a Together AI API key and give it to Nitely in one of two ways:
   - **Web Console:** Providers → Together AI → API key. The key is stored in
     the provider secret store; API responses, status, and audit records show
     only connection metadata.
   - **Environment:** export `TOGETHER_API_KEY` for the Nitely process.
3. Select the runtime and a Together model id in the flow.

`nitely doctor` / run preflight reports the `together` provider as missing
until one of the credential sources is configured.

## Flow configuration

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": { "name": "implement-with-together" },
  "spec": {
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "together",
        "model": "moonshotai/Kimi-K3",
        "prompt": "Implement the approved spec.",
        "inputs": [],
        "outputs": ["implementation"]
      }
    ]
  }
}
```

Nitely launches `pi -p --provider together --model <model>` in the stage
worktree and sends the prompt on stdin. `together` also works as an ordered
`runtimes` candidate, for example
`[{ "runtime": "together", "model": "moonshotai/Kimi-K3" }, { "runtime": "codex" }]`.

`model` is required. Use a chat model id from
<https://api.together.ai/models>, in the form `<organization>/<model>`; a
`together/` prefix is accepted. Nitely does not fall back to whatever default
the local Pi installation would choose.

## Credential precedence

From highest to lowest:

1. An explicit run connection binding, then the user's own Web Console
   connection, then the repository/organization connection, following the
   normal [provider connection](provider-connections.md) selection rules. A
   stored connection replaces any `TOGETHER_API_KEY` inherited from the
   environment.
2. `TOGETHER_API_KEY` in the Nitely process environment.

Nitely hands the selected key to Pi only as `TOGETHER_API_KEY` in the child
environment. It never passes `--api-key`, so the key does not appear in argv
or launch evidence, and Nitely's evidence redaction treats `TOGETHER_API_KEY`
as a secret like every other `*_API_KEY` value.

Pi itself prefers a Together credential stored in its own `auth.json`
(`pi /login`) or a `models.json` provider `apiKey` over the environment. Do not
configure a Together key inside Pi on hosts that run Nitely, or that key will
be used instead of the one Nitely selected.

## Failures

| Situation | Where it surfaces | Message |
| --- | --- | --- |
| No key configured | preflight and before spawn | `agent runtime together is not configured. Set TOGETHER_API_KEY.` |
| Missing or malformed `model` | run preflight (`runtime-model-unsupported`), agent preflight, and before spawn | names the problem, an example id, and the Together model list |
| Key rejected by Together AI | stage exit | `together exited with code 1: Together AI rejected the API key…`; the run blocks with `agent_credentials_invalid` so it can be resumed after the key is replaced |
| Model not served by Together AI | stage exit | `together exited with code 1: Together AI could not serve model "…"…` |
| Pi not installed | before spawn | `unable to start agent runtime together: command pi was not found` |
| Pi has no Together provider | stage exit | `together exited with code 1: The installed Pi CLI has no built-in Together AI provider…` |

An ordered `runtimes` stage treats a missing key, a missing model, or a missing
Pi CLI as an unavailable candidate and moves to the next one.

## OCI backend

- Install `pi` in the runner image.
- Add `TOGETHER_API_KEY` to `NITELY_OCI_SECRET_ALLOWLIST`; preflight fails
  with `Allow TOGETHER_API_KEY` otherwise.
- Allow `api.together.ai` (and `api.together.xyz` if your Pi version uses it)
  in `NITELY_OCI_NETWORK_ALLOWLIST` or the stage's restricted network domains.

## Limitations

- Execution depends on the Pi CLI's Together provider. The integration was
  checked against Pi 1.0.4 (`@earendil-works/pi-coding-agent`); older Pi
  versions without the built-in `together` provider fail at stage exit as
  described above.
- Model validation in Nitely is syntactic. Whether Together serves a model is
  only known when Pi calls the API; that failure is reported at stage exit.
- Pi does not report token usage to Nitely, so `together` stages record no
  runtime usage (the same as `pi`, `glm`, and `grok`).
- Like `pi`, the local backend has no read-only enforcement for this runtime;
  stages with `capabilities.write.scope: none` must use OCI.
- Pi reads the operator's Pi settings and extensions; Nitely has no global
  skill isolation for Pi.
