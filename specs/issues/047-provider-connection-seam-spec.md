# Issue #47 Specification: Extract a ProviderConnection seam

GitHub issue: https://github.com/Instask/nitely/issues/47

Related: #42 (agent runtime registry, already merged — codex/claude/glm),
#30 (agent-stage model, merged), #14 (multiple users), #18 (secret redaction),
#10 (Web Console provider connections).

## Objective

Carve a `ProviderConnectionStore` seam that owns "where a provider credential
comes from," replacing scattered `process.env` reads with one injectable, and now
**writable**, boundary — mirroring the `ExecutionBackend` seam (#29).

The concrete value this unlocks: the Web Console provider page becomes able to
**configure** credentials, not just display read-only status. The seam also makes
two later directions additive rather than rewrites:

- Per-user, isolated connections for a future hosted/multi-user Nitely (#14).
- OAuth-backed connections (GitHub/Google) behind a stable token accessor.

This issue does **not** implement OAuth, encryption-at-rest, or user identity.

## Current State (on `master`)

Credentials are read from `process.env` in four independent places, and the Web
Console can only *report* status, never set it:

- `src/scm/github.ts:113` — `getGitHubToken(env)` reads `NITELY_GITHUB_TOKEN ??
  GITHUB_TOKEN`.
- `src/connectors/google-drive.ts:71` — reads `NITELY_GOOGLE_ACCESS_TOKEN ??
  NIGHTLY_GOOGLE_ACCESS_TOKEN`.
- `src/run/execution/local.ts` — the agent **runtime registry**
  (`createDefaultAgentRuntimeRegistry`) gates and configures runtimes from `env`:
  `claude` requires `ANTHROPIC_API_KEY`; `glm` requires one of
  `NITELY_GLM_API_KEY | GLM_API_KEY | ZHIPUAI_API_KEY`; `codex` is managed by its
  own CLI. `LocalExecutionBackend` reads `this.env` for these.
- `src/web/providers.ts` — `getProviderStatuses()` independently re-reads all of
  the above (5 providers: github, codex, anthropic, glm, google-drive) for the
  status page.

So "is this provider configured / what is its credential" is implemented four
times, the runtime registry and the status page each have their own copy, and
none of it is configurable from the Web Console.

> Note: GLM is **not** a special case. #42 already added it as a first-class agent
> runtime (`runtime: "glm"`, a `glm` CLI, key via `NITELY_GLM_API_KEY`). Today GLM
> works by exporting that env var. The gap this issue closes is **writing** that
> credential (and the others) from the Web Console through one store.

## Guiding Principle

The store is the single source of truth for provider credentials. It answers:

1. **Get a credential** for providers Nitely calls directly over HTTP
   (`github`, `google-drive`) via a connection object.
2. **Contribute credentials to the agent runtime registry** without the registry
   changing shape — by producing an *effective environment* the backend uses.
3. **Report status** for every provider, for the Web Console page.
4. **Set / clear** a stored credential (the new write path).

Consumers stop reading `process.env` for credentials and ask the store. OAuth,
encryption, and user identity live behind the store and are out of scope.

## Connection Model

```ts
export type ProviderId =
  | "github"
  | "codex"
  | "anthropic"
  | "glm"
  | "google-drive";

export class MissingConnectionError extends Error {
  constructor(public readonly providerId: ProviderId, message: string) {
    super(message);
    this.name = "MissingConnectionError";
  }
}

export interface ProviderConnection {
  readonly providerId: ProviderId;
  // Returns a usable token, refreshing internally in future OAuth impls.
  // Throws MissingConnectionError when there is no usable credential.
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
  readonly value: string; // the secret/token
}

export interface ProviderConnectionStore {
  getConnection(providerId: ProviderId): Promise<ProviderConnection>;
  // Effective env = process/base env overlaid with stored secrets, keyed by the
  // canonical env var each provider uses. LocalExecutionBackend uses this so the
  // existing runtime-registry env gating (#42) keeps working unchanged.
  resolveEnv(): Promise<Record<string, string | undefined>>;
  listStatuses(): Promise<ProviderConnectionStatus[]>;
  // Present only on writable stores; the Web Console connection form uses these.
  setConnection?(input: SetConnectionInput): Promise<void>;
  clearConnection?(providerId: ProviderId): Promise<void>;
}
```

### Decisions

- **Connection object, not a bare token string** (design Q1): `getAccessToken()`
  lets a future OAuth store refresh transparently. Used by github/google-drive.
- **Runtime credentials integrate via `resolveEnv()`, not per-call rewrites.**
  The #42 runtime registry already reads keys from `env` (`ANTHROPIC_API_KEY`,
  `NITELY_GLM_API_KEY`, …). Rather than rewrite each launcher, the store overlays
  stored secrets onto the env the backend passes in. A stored GLM credential
  simply sets `NITELY_GLM_API_KEY` in the effective env. This keeps the seam from
  leaking into runtime-specific code.
- **User context is bound at construction** (design Q2), not threaded per call.
  Multi-user later = a different store instance per request; signatures unchanged.
- **All providers are modeled and the status page derives from the store**
  (design Q3): `providers.ts` stops re-reading env and adapts to
  `store.listStatuses()`. `codex` stays CLI-managed (status via `codex --version`,
  `getAccessToken` throws `MissingConnectionError`).

## Persistence

- Default read path: env-backed, read-only, preserving today's behavior exactly
  (including legacy `NIGHTLY_`/alternate aliases).
- Writable store for the Web Console: a file layer over env that reads and writes
  `.nitely/connections.json` (mode `0600`), consistent with `.nitely/tasks` and
  `.nitely/runs`. A stored credential overrides env for that provider; absent a
  stored entry, env is used.
- **Secrets are stored in plaintext for this local-first increment.** OS keychain
  / encryption-at-rest is future work (#18).

## Per-Provider Canonical Env Var

The store maps each provider to the canonical env var it writes/overlays:

| Provider      | Canonical env var            | Consumed by                |
| ------------- | ---------------------------- | -------------------------- |
| github        | `NITELY_GITHUB_TOKEN`        | SCM provider (HTTP)        |
| google-drive  | `NITELY_GOOGLE_ACCESS_TOKEN` | connector (HTTP)           |
| anthropic     | `ANTHROPIC_API_KEY`          | runtime registry (`claude`)|
| glm           | `NITELY_GLM_API_KEY`         | runtime registry (`glm`)   |
| codex         | — (CLI-managed)              | codex CLI                  |

Reads still honor the existing fallback aliases; writes use the canonical var.

## Web Console

The provider page gains, per writable provider, a small form to set and clear the
credential. The secret input is write-only; the API returns status, never stored
secret values. `codex` shows status only (no form — CLI-managed).

## Backward Compatibility

- `GitHubScmProvider` keeps working with `options.env`; it gains an injected
  connection/store and defaults to env-backed.
- The google-drive connector keeps reading the same env via the default store.
- `LocalExecutionBackend` keeps its `env` option; when given a store, it sources
  `env` from `store.resolveEnv()`. With no stored connections, the effective env
  equals the process env, so runtime behavior is unchanged.
- `ProviderStatus`/`getProviderStatuses` exports remain so `src/web/ui.ts` only
  changes to add the form.
- With no `.nitely/connections.json` and no new wiring, every behavior is
  identical to today.

## Non-Goals

- OAuth authorization flows, callbacks, refresh tokens (later issue).
- Encryption-at-rest / OS keychain (#18).
- User identity, login, sessions, multi-tenant storage (#14).
- Changing the agent runtime registry contract (#42) — the seam feeds it env, it
  does not restructure it.
- Configuring codex authentication (remains CLI-managed).

## Acceptance Criteria

1. `src/providers/types.ts` defines `ProviderId`, `ProviderConnection`,
   `ProviderConnectionStatus`, `ProviderConnectionStore`, `SetConnectionInput`,
   and `MissingConnectionError`.
2. An env-backed store reproduces current behavior: `getConnection` returns
   env-backed tokens for `github`/`google-drive` (incl. aliases) and throws
   otherwise; `resolveEnv()` returns the process env unchanged when nothing is
   stored; `listStatuses()` returns the same five rows `providers.ts` returns
   today (codex via injected `commandStatus`).
3. `GitHubScmProvider` and the google-drive connector obtain credentials through
   an injected connection/store with an env-backed default; existing SCM and
   connector tests pass unmodified.
4. `src/web/providers.ts` derives statuses from the store; `ProviderStatus`
   export and existing web tests stay green.
5. A writable file-backed store persists and clears credentials in
   `.nitely/connections.json` (mode `0600`), overlaying env, for github,
   google-drive, anthropic, and glm.
6. `LocalExecutionBackend`, given a store, sources its `env` from
   `resolveEnv()`; a stored GLM/anthropic credential makes the corresponding
   runtime pass its `requiredEnv` gate without any process env var set. With no
   store/stored connections, the effective env and runtime behavior are unchanged.
7. The Web Console can set and clear github/google-drive/anthropic/glm
   credentials; the API never returns stored secret values.
8. The store is injectable into `runFlow`/`resumeRun`
   (`dependencies.providerStore`) and the web server, defaulting to an env-backed
   store, mirroring `ExecutionBackend`.
9. `vitest run`, `tsc --noEmit`, and the build all pass on Node 24.
