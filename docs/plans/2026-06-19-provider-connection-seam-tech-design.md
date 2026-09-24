# Provider Connection Seam Tech Design

Issue: https://github.com/Instask/nitely/issues/47
Spec: `specs/issues/047-provider-connection-seam-spec.md`

## Design

Introduce a credential boundary, `ProviderConnectionStore`, alongside the
existing `ScmProvider`, `ExecutionBackend`, and agent-runtime-registry (#42)
seams. Every credential lookup goes through it; the default is env-backed and
behavior-preserving; a writable file-backed variant lets the Web Console
configure credentials.

Suggested modules:

- `src/providers/types.ts` — interfaces and `MissingConnectionError`.
- `src/providers/descriptors.ts` — the per-provider table (canonical env var,
  read aliases, display metadata) so reads, writes, and status share one source.
- `src/providers/env-store.ts` — `EnvProviderConnectionStore` (read-only).
- `src/providers/file-store.ts` — `FileProviderConnectionStore` (writable,
  layered over an env store).
- `src/providers/index.ts` — `resolveProviderStore(...)` factory + re-exports.

## Core Types (`src/providers/types.ts`)

```ts
export type ProviderId =
  | "github" | "codex" | "anthropic" | "glm" | "google-drive";

export class MissingConnectionError extends Error {
  constructor(public readonly providerId: ProviderId, message: string) {
    super(message);
    this.name = "MissingConnectionError";
  }
}

export interface ProviderConnection {
  readonly providerId: ProviderId;
  getAccessToken(): Promise<string>;
}

export interface ProviderConnectionStatus {
  readonly id: ProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly message: string;
  readonly hints: string[];
}

export interface SetConnectionInput {
  readonly providerId: ProviderId;
  readonly value: string;
}

export interface ProviderConnectionStore {
  getConnection(providerId: ProviderId): Promise<ProviderConnection>;
  resolveEnv(): Promise<Record<string, string | undefined>>;
  listStatuses(): Promise<ProviderConnectionStatus[]>;
  setConnection?(input: SetConnectionInput): Promise<void>;
  clearConnection?(providerId: ProviderId): Promise<void>;
}
```

## Provider Descriptors (`src/providers/descriptors.ts`)

A single table drives reads, writes, status, and the effective-env overlay:

```ts
interface ProviderDescriptor {
  id: ProviderId;
  name: string;             // "GitHub", "GLM / Zhipu", …
  canonicalEnv?: string;    // var to write/overlay; undefined for codex
  readAliases: string[];    // vars to read, in precedence order
  hints: string[];          // shown on the status page
  cliCheck?: { command: string; args: string[] }; // codex --version
  writable: boolean;        // codex = false
}
```

Values come straight from today's `providers.ts` so status output is identical
(github, codex, anthropic, glm, google-drive — same messages/hints).

## EnvProviderConnectionStore (`src/providers/env-store.ts`)

Read-only, constructed with the user/process context:

```ts
new EnvProviderConnectionStore({ env?, commandStatus? })
```

- `getConnection(id)` → for `github`/`google-drive`, a connection whose
  `getAccessToken()` returns the first set `readAliases` value, else throws
  `MissingConnectionError` (reusing `MISSING_GITHUB_TOKEN_MESSAGE` for github).
  For `anthropic`/`glm`/`codex`, `getAccessToken()` throws (these are consumed via
  env by the runtime registry / CLI, not handed out as bearer tokens here).
- `resolveEnv()` → returns the base env unchanged.
- `listStatuses()` → the five rows currently produced by `getProviderStatuses`,
  derived from descriptors, with the `codex --version` check via `commandStatus`.

## FileProviderConnectionStore (`src/providers/file-store.ts`)

Writable, layered over an inner store (default `EnvProviderConnectionStore`):

```ts
new FileProviderConnectionStore({
  path: join(nitelyDir, "connections.json"),
  inner: new EnvProviderConnectionStore({ env, commandStatus }),
})
```

- Loads `connections.json` and merges with the inner store. **A stored value
  overrides env** for that provider; otherwise the inner store wins.
- `setConnection` validates the provider is `writable`, writes the entry, and
  persists atomically (temp file + rename) with mode `0600` (creating the dir).
  `clearConnection` removes the entry.
- `resolveEnv()` → base env overlaid with `{ [descriptor.canonicalEnv]: value }`
  for each stored connection. This is the key integration point: a stored GLM
  secret becomes `NITELY_GLM_API_KEY` in the returned env, so the #42 runtime
  registry's gating and `build({ env })` work with zero changes.
- `getConnection` returns the stored value (if any) ahead of env.
- `listStatuses()` marks stored providers `configured: true` with a
  "Configured in Web Console" message.

File shape:

```json
{
  "version": 1,
  "connections": {
    "glm": { "value": "…" },
    "github": { "value": "…" }
  }
}
```

## Consumer Refactors

### `src/scm/github.ts`

- `GitHubScmProviderOptions` gains `connection?: ProviderConnection` (or
  `store?`). Default: an env-backed github connection. `publishChange`/update call
  `await connection.getAccessToken()` instead of `getGitHubToken(this.#env)`.
  Keep `getGitHubToken` + `MISSING_GITHUB_TOKEN_MESSAGE` exported so the env store
  reuses them and the error text is unchanged.

### `src/connectors/google-drive.ts`

- The connector obtains its token from an injected connection/store; the module
  `getAccessToken()` becomes `connection.getAccessToken()`. Default env-backed.

### `src/run/execution/local.ts`

- `LocalExecutionBackend` already accepts `{ env }`. Add `{ providerStore? }`;
  when present, it resolves its working env via `await store.resolveEnv()` (once
  per run, or lazily before `runAgent`). The runtime registry, `requiredEnv`
  gating, and launcher `build({ env })` are **unchanged**.

### `src/web/providers.ts`

- `getProviderStatuses(options)` becomes a thin wrapper that builds/accepts a
  store and returns `store.listStatuses()`. Keep the `ProviderStatus` export
  (alias `ProviderConnectionStatus`) so `src/web/ui.ts` is otherwise untouched.

## Web Console

- `GET /api/providers` → `store.listStatuses()` (unchanged shape).
- `POST /api/providers/:id/connection` → `{ value }`; validates `id` is writable;
  `store.setConnection(...)`.
- `DELETE /api/providers/:id/connection` → `store.clearConnection(id)`.
- `src/web/ui.ts` provider rows gain a write-only secret input + Save/Clear for
  writable providers; codex stays status-only. The API never echoes stored
  secrets — only `configured` + message.

## Wiring / Injection

Mirror `ExecutionBackend`:

- `RunFlowDependencies` gains `providerStore?: ProviderConnectionStore`;
  `resolveProviderStore(deps) = deps.providerStore ?? defaultStore(nitelyDir)`.
  The resolved store is passed to the `LocalExecutionBackend` it constructs and to
  github/connector credential resolution.
- The web server input gains `providerStore?`, defaulting to a file-backed store
  at the project `.nitely/` dir. Status route, console render, and the new
  connection endpoints use it.
- Default factory: file-backed over env when a `.nitely` dir is known, else
  env-only.

## Error Handling

- `MissingConnectionError` carries `providerId` and a provider-specific message;
  existing consumers surface it exactly as today (github publish fails with
  `MISSING_GITHUB_TOKEN_MESSAGE`).
- File store: malformed/oversized `connections.json` → clear error on read; never
  partially write (temp + rename). Reject `setConnection` for non-writable ids
  (codex) and unknown ids.

## Testing (TDD)

- `providers/env-store.test.ts`: github/google-drive tokens (incl. aliases);
  `MissingConnectionError` for anthropic/glm/codex `getAccessToken`; `resolveEnv`
  returns base env unchanged; `listStatuses()` matches the five current rows with
  injected `commandStatus`.
- `providers/file-store.test.ts`: set/get/clear round-trip; mode `0600`; atomic
  write; stored-over-env precedence; `resolveEnv` overlays the canonical var
  (e.g. stored glm → `NITELY_GLM_API_KEY`); reject non-writable/unknown ids;
  malformed-file error.
- `scm/github.test.ts`: provider uses injected connection; env fallback works;
  unchanged error text.
- `connectors/google-drive.test.ts`: connector uses injected connection.
- `run/execution/local.test.ts`: with a store providing a stored glm/anthropic
  secret, the corresponding runtime passes its `requiredEnv` gate with no process
  env var set; with no store, env and runtime args are unchanged (existing
  codex/claude/glm registry tests stay green).
- `web/providers.test.ts` + web server tests: status via store; POST/DELETE
  set/clear; secrets never returned by the API.

## Rollout Order

1. Types + descriptors + `EnvProviderConnectionStore`; adapt `providers.ts`
   (no behavior change).
2. Refactor github + google-drive consumers onto the store.
3. `FileProviderConnectionStore` + `resolveEnv` + injection wiring (incl.
   `LocalExecutionBackend` sourcing env from the store).
4. Web Console set/clear endpoints + form.

Steps 1–2 are pure refactors; the configure-from-Web-Console value (including
GLM) lands in 3–4.
