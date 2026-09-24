# Web Preview Runtime

Nitely preview sessions start a repository-owned dev server and attach a
Playwright Chromium runtime to it. The feature is intentionally separate from
provider credentials and agent stage execution: a preview session is an
operator-controlled runtime with explicit ownership, capabilities, artifacts,
diagnostics, and cleanup.

## Repository Configuration

Add `.nitely/preview.json` to a real repository:

```json
{
  "schemaVersion": "nitely.preview.v1",
  "commands": [
    {
      "id": "web",
      "command": "pnpm",
      "args": ["dev", "--host", "127.0.0.1", "--port", "4174"],
      "cwd": ".",
      "targetUrl": "http://127.0.0.1:4174/",
      "allowedRoutes": ["/"],
      "readiness": {
        "path": "/",
        "timeoutMs": 30000,
        "intervalMs": 250
      }
    }
  ]
}
```

Only configured commands can be started. `cwd` is resolved through realpath and
must stay inside the repository. Targets must be HTTP(S) loopback URLs
(`localhost`, `127.0.0.1`, or `::1`). Requested routes must be absolute paths
and must match the command's `allowedRoutes`.

Command `env` values are explicit and are redacted from captured stdout/stderr
tails. `inheritEnv` defaults to `["PATH"]`; add specific environment variable
names only when the preview command needs them.

## API Shape

- `GET /api/preview-sessions?repoId=...` lists visible sessions and viewport
  presets.
- `POST /api/preview-sessions` starts a session with `repoId`, `commandId`,
  optional `route`, optional loopback `targetUrl`, optional `viewport`, and
  optional `workItemId` / `runId` scope metadata.
- `GET /api/preview-sessions/:id` returns session metadata.
- `GET /api/preview-sessions/:id/proxy/...` renders same-origin preview
  content through Nitely's server-side proxy.
- `GET /api/preview-sessions/:id/diagnostics` returns console/page/server
  diagnostics.
- `GET /api/preview-sessions/:id/hierarchy` returns basic DOM/layout metadata.
- `POST /api/preview-sessions/:id/navigate` accepts same-origin absolute or
  relative URLs.
- `POST /api/preview-sessions/:id/reload`, `restart`, `click`, `type`,
  `scroll`, `screenshot`, `attach-screenshot`, and `stop` perform runtime or
  evidence actions.

Viewer roles can inspect preview sessions. Member and above can control them.
Synthetic demo repositories are rejected.

## Web Console

The Web Console includes a top-level `/preview` page for the first operator
workflow slice. It can start a configured session, list/select sessions, run
bounded interactions, capture full-page screenshots, refresh diagnostics, and
render the basic DOM hierarchy returned by the provider. Ready sessions also
show a live preview frame backed by `/api/preview-sessions/:id/proxy/...`.

The live frame is deliberately isolated. Nitely fetches preview content
server-side from the session's loopback target, never forwards browser cookies
or arbitrary request headers to the preview app, and only follows redirects that
stay on the session origin. Proxy responses carry a CSP `sandbox` directive, and
the Console iframe sandbox omits `allow-same-origin`, so untrusted app content
does not become same-origin trusted Console UI.

## Runtime State And Evidence

Session metadata is stored under `.nitely/preview-sessions/*.json`. Screenshot
artifacts are written under `.nitely/preview-sessions/:id/artifacts/*.png` with
SHA-256 integrity metadata. Operators can attach captured screenshots to a run
artifact registry with `attach-screenshot`; when a work item is provided, Nitely
uses that work item's latest run. The attachment copies the PNG into the run's
`preview-evidence/` directory and registers it as a `preview-screenshot`
artifact with SHA-256 and size metadata. When Nitely restarts, sessions that were
`starting`, `ready`, or `stopping` are marked `stale`; operators can start a new
session rather than relying on an orphaned process handle.

The first provider is Playwright Chromium. It advertises capabilities before use
so callers do not infer support from optional methods.

## Native Provider Status

iOS Simulator and Android Emulator support has been validated only as a provider
contract spike. The current production runtime remains Playwright Chromium.
Native providers must not be enabled until their host preflight, app
build/install/launch configuration, capability negotiation, cleanup, artifact,
and security boundaries are implemented.

See `specs/issues/420-native-visual-devtools-provider-spike.md` for the native
capability matrix, reproducible blocked POC result, and scoped follow-up issues.
