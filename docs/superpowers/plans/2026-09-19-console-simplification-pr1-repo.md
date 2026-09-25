# Console Simplification PR 1: Repository Without Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Web Console home directory becomes a pure state directory; repositories are registered by GitHub URL only, the hard-coded `default` repository is retired with an idempotent origin-URL migration, and a repository's server path never leaves the server.

**Architecture:** `src/web/repositories.ts` owns the registry: it derives two non-persisted flags (`home`, `managed`) from each entry's path, resolves omitted/legacy repository ids to the home entry, refuses `path` on registration, and runs a one-time startup migration that registers the home checkout from its `origin` remote. `src/web/json.ts` is the single serialization boundary that drops `repoPath` keys from every API response, and `publicRepository()` strips `path` from repository objects. The console loses its Path column, path form field, and `default` special-cases.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, `node:child_process` `execFile` for git, the `x-dc` template in `src/web/static/console.dc.html`.

**Spec:** `docs/superpowers/specs/2026-09-19-console-simplification-design.md` — sections "2. Home and repository model", "1. Information architecture" (Repos row), "Compatibility", "Testing", "Delivery" (PR 1).

## Global Constraints

- `pnpm run check` (tsc) and `pnpm run test:run` (vitest) are the merge gate; never describe a red check as a pre-existing baseline (AGENTS.md "Verification Boundary").
- Most of the vitest suite cannot pass on macOS (Run-owned file boundary needs Linux). Unit tests named in this plan for `repositories.ts`, `json.ts`, `cli.test.ts`, and `console-static.test.ts` run locally; the full suite runs on the Linux box in Task 10.
- The run model, worktree creation, fresh-remote baselining, per-repository `<repo.path>/.nitely/runs`, `events.db`, and `connections.json` are not changed.
- `StartWebServerInput.repositories` (programmatic registration by path) stays as the embedding/test seam. Only the CLI flag `--repository` is removed.
- Builtin flows keep resolving from `<home>/flows`. This plan does not touch that coupling.
- The synthetic golden-path demo repository (`demo-golden-path`) keeps registering by explicit path with `synthetic: true` through the internal `addStoredWebRepository` call.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- The `origin` remote is `git@github.com:Instask/nitely.git` (a GitHub redirect); `gh pr create` must pass `--repo jerryleooo/nitely --head <branch>`.

---

## File Structure

| File | Responsibility in this PR |
|---|---|
| `src/web/repositories.ts` | Registry model: `WebRepository` gains derived `home`/`managed`; `publicRepository()`; `repositoryById()` legacy-id resolution; `syncStoredWebRepository()` managed-only; `addStoredWebRepository()` URL-only; `migrateHomeRepository()` + `readGitOriginUrl()`; `default` synthesis removed. |
| `src/web/json.ts` (new) | `serializeWebJson()` — the one JSON serializer for API responses; drops `repoPath` keys. |
| `src/web/server.ts` | Uses `serializeWebJson` in `sendJson`/`sendJsonWithHeaders`/SSE; `publicRepository` on repository payloads; `withRepository` and run inputs take `repoId` from the loaded repository; `repositoryVisibleToUser` uses `home`; `repositoryInputFromJson` rejects `path`; `startWebServer` runs the home migration; new `readRepositoryOrigin` input seam. |
| `src/cli.ts` | `web --home <dir>` (with `--repo` alias); `--repository` removed. |
| `src/web/static/console.dc.html` | Repos page without Path column; add-repository form without ID/path fields; Tasks repo strip without path; no `default` special-cases. |
| `test/web/repositories.test.ts` (new) | Unit tests for flags, `publicRepository`, `repositoryById`, `migrateHomeRepository`. |
| `test/web/json.test.ts` (new) | Unit test for `serializeWebJson`. |
| `test/web/repositories-sync.test.ts` | Updated for managed-only sync. |
| `test/web/server.test.ts` + 11 other server-booting test files | Register the home checkout explicitly; `"default"` → `"home"`; drop `path`/`repoPath` response assertions. |
| `test/cli.test.ts` | `--home`, removed `--repository`. |
| `test/web/console-static.test.ts` | Updated template assertions. |
| README, `README.zh-CN.md`, `docs/local-mcp.md`, `docs/enterprise-identity-rbac-and-audit.md`, `skills/nitely/references/{install,cli}.md`, `scripts/nitely-prod-web-systemd-install` | `web --repo` → `web --home`. |

Line numbers below are as of `origin/master` e935cf3 and drift as tasks land; each edit also names the code to search for.

---

### Task 1: Derived `home` / `managed` flags and `publicRepository()`

**Files:**
- Modify: `src/web/repositories.ts:26-34` (`WebRepository`), `:74-92` (`normalizeRepository`), `:282-284` (`checkoutPath`), `:348-372` (`resolveWebRepositories`), `:417-425` (`addStoredWebRepository` normalize call)
- Test: `test/web/repositories.test.ts` (new)

**Interfaces:**
- Produces:
  - `WebRepository.home?: true` — entry whose `path === resolve(home)`.
  - `WebRepository.managed?: true` — entry whose `path` is under `<home>/.nitely/repositories/`.
  - `export type PublicWebRepository = Omit<WebRepository, "path" | "home" | "managed">`
  - `export function publicRepository(repository: WebRepository): PublicWebRepository`
  - `export const LEGACY_DEFAULT_REPOSITORY_ID = "default"`
  - Internal `normalizeRepository(homePath: string, input: WebRepositoryInput): WebRepository` (signature change; two callers in this file).

- [ ] **Step 1: Write the failing tests**

Create `test/web/repositories.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  publicRepository,
  resolveWebRepositories,
} from "../../src/web/repositories.js";

describe("resolveWebRepositories", () => {
  it("derives home and managed flags from each entry's path", () => {
    const repositories = resolveWebRepositories("/srv/nitely", [
      { id: "home", name: "Home", path: "/srv/nitely" },
      {
        id: "app",
        name: "App",
        path: "/srv/nitely/.nitely/repositories/app",
        sourceUrl: "https://github.com/acme/app.git",
      },
      { id: "tree", name: "Tree", path: "/home/someone/tree" },
    ]);

    const home = repositories.find((repository) => repository.id === "home");
    const app = repositories.find((repository) => repository.id === "app");
    const tree = repositories.find((repository) => repository.id === "tree");

    expect(home).toMatchObject({ home: true });
    expect(home).not.toHaveProperty("managed");
    expect(app).toMatchObject({ managed: true });
    expect(app).not.toHaveProperty("home");
    expect(tree).not.toHaveProperty("home");
    expect(tree).not.toHaveProperty("managed");
  });

  it("does not treat a sibling of the managed root as managed", () => {
    const [repository] = resolveWebRepositories("/srv/nitely", [
      { id: "sib", name: "Sib", path: "/srv/nitely/.nitely/repositories-old/sib" },
    ]).filter((candidate) => candidate.id === "sib");

    expect(repository).not.toHaveProperty("managed");
  });
});

describe("publicRepository", () => {
  it("drops the server path and the derived flags", () => {
    expect(
      publicRepository({
        id: "app",
        name: "App",
        path: "/srv/nitely/.nitely/repositories/app",
        defaultBranch: "main",
        sourceUrl: "https://github.com/acme/app.git",
        organizationId: "org-1",
        home: true,
        managed: true,
      }),
    ).toEqual({
      id: "app",
      name: "App",
      defaultBranch: "main",
      sourceUrl: "https://github.com/acme/app.git",
      organizationId: "org-1",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/web/repositories.test.ts`
Expected: FAIL — `publicRepository` is not exported; flag assertions fail.

- [ ] **Step 3: Implement**

In `src/web/repositories.ts`:

Replace the `WebRepository` interface (lines 26–34) with:

```ts
export interface WebRepository {
  id: string;
  name: string;
  /**
   * Checkout location on this server. Internal: stripped from every Web API
   * response by publicRepository() and never rendered by the console.
   */
  path: string;
  defaultBranch?: string;
  sourceUrl?: string;
  synthetic?: boolean;
  organizationId?: string;
  /**
   * Set on the entry whose checkout is the console home directory. Derived
   * from `path` at load time, never stored.
   */
  home?: true;
  /**
   * Set on clones Nitely created under `<home>/.nitely/repositories`. Only a
   * managed clone may be reset to its remote. Derived, never stored.
   */
  managed?: true;
}

export type PublicWebRepository = Omit<WebRepository, "path" | "home" | "managed">;

export function publicRepository(repository: WebRepository): PublicWebRepository {
  const { path: _path, home: _home, managed: _managed, ...rest } = repository;
  return rest;
}

export const LEGACY_DEFAULT_REPOSITORY_ID = "default";
```

Add next to `repositoriesPath` (line ~94):

```ts
function managedCheckoutRoot(homePath: string): string {
  return join(resolve(homePath), ".nitely", "repositories");
}
```

Replace `normalizeRepository` (lines 74–92) with:

```ts
function normalizeRepository(
  homePath: string,
  input: WebRepositoryInput,
): WebRepository {
  const id = input.id?.trim() || LEGACY_DEFAULT_REPOSITORY_ID;
  validateRepoId(id);
  const path = resolve(input.path);
  const name = input.name?.trim() || displayNameForPath(path);
  const managedRoot = managedCheckoutRoot(homePath);
  return {
    id,
    name,
    path,
    ...(input.defaultBranch?.trim()
      ? { defaultBranch: input.defaultBranch.trim() }
      : {}),
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
    ...(input.synthetic === true ? { synthetic: true } : {}),
    ...(input.organizationId?.trim()
      ? { organizationId: input.organizationId.trim() }
      : {}),
    ...(path === resolve(homePath) ? { home: true as const } : {}),
    ...(path.startsWith(`${managedRoot}${sep}`) ? { managed: true as const } : {}),
  };
}
```

Replace `checkoutPath` (lines 282–284) with:

```ts
function checkoutPath(defaultRepoPath: string, id: string): string {
  return join(managedCheckoutRoot(defaultRepoPath), id);
}
```

In `resolveWebRepositories` (lines 348–372) change both `normalizeRepository(` calls to pass the home first:

```ts
  byId.set("default", normalizeRepository(defaultRepoPath, {
    id: "default",
    path: defaultRepoPath,
  }));
  for (const repository of repositories) {
    const normalized = normalizeRepository(
      defaultRepoPath,
      migrateLegacyGoldenPathRepositoryLexically(defaultRepoPath, repository),
    );
```

In `addStoredWebRepository` (line ~417) change `const repository = normalizeRepository({` to `const repository = normalizeRepository(defaultRepoPath, {`.

- [ ] **Step 4: Run the tests and type check**

Run: `pnpm exec vitest run test/web/repositories.test.ts test/web/repositories-sync.test.ts && pnpm run check`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/repositories.ts test/web/repositories.test.ts
git commit -m "feat(web): derive home/managed repository flags and publicRepository()

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `repositoryById` resolves omitted and legacy ids to the home entry

**Files:**
- Modify: `src/web/repositories.ts:482-491` (`repositoryById`)
- Test: `test/web/repositories.test.ts`

**Interfaces:**
- Consumes: `WebRepository.home`, `LEGACY_DEFAULT_REPOSITORY_ID` (Task 1).
- Produces: `repositoryById(repositories: WebRepository[], id: string | undefined): WebRepository` — unchanged signature; `undefined`, `""`, and `"default"` resolve to the `home` entry; a missing home throws `WebInputError("repoId is required")`; an unknown id throws `WebNotFoundError("repository not found")`.

- [ ] **Step 1: Write the failing tests**

Append to `test/web/repositories.test.ts` (add `repositoryById` to the import, and import the error classes):

```ts
import { WebInputError, WebNotFoundError } from "../../src/web/errors.js";
```

```ts
describe("repositoryById", () => {
  const home = { id: "home", name: "Home", path: "/srv/nitely", home: true as const };
  const app = { id: "app", name: "App", path: "/srv/nitely/.nitely/repositories/app" };

  it("returns the entry with the requested id", () => {
    expect(repositoryById([home, app], "app")).toBe(app);
  });

  it("resolves an omitted id to the home entry", () => {
    expect(repositoryById([app, home], undefined)).toBe(home);
    expect(repositoryById([app, home], "")).toBe(home);
  });

  it("resolves the legacy default id to the home entry", () => {
    expect(repositoryById([app, home], "default")).toBe(home);
  });

  it("requires an id when no entry is the home checkout", () => {
    expect(() => repositoryById([app], undefined)).toThrow(WebInputError);
    expect(() => repositoryById([app], "default")).toThrow("repoId is required");
  });

  it("reports unknown ids as not found", () => {
    expect(() => repositoryById([home, app], "nope")).toThrow(WebNotFoundError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/web/repositories.test.ts`
Expected: FAIL — `"resolves an omitted id..."` and `"requires an id..."` fail (today undefined maps to id `"default"` literally).

- [ ] **Step 3: Implement**

Replace `repositoryById` (lines 482–491) with:

```ts
/**
 * Look a repository up by id. An omitted id, or the legacy `default` id that
 * older Work items still carry, means the home checkout: the entry whose
 * `path` is the console home directory. When nothing is registered at the
 * home directory there is no implicit repository, and the caller must name
 * one.
 */
export function repositoryById(
  repositories: WebRepository[],
  id: string | undefined,
): WebRepository {
  const wanted = id?.trim();
  if (wanted && wanted !== LEGACY_DEFAULT_REPOSITORY_ID) {
    const repository = repositories.find((candidate) => candidate.id === wanted);
    if (!repository) {
      throw new WebNotFoundError("repository not found");
    }
    return repository;
  }
  const home = repositories.find((candidate) => candidate.home === true);
  if (!home) {
    throw new WebInputError("repoId is required");
  }
  return home;
}
```

- [ ] **Step 4: Run the tests and type check**

Run: `pnpm exec vitest run test/web/repositories.test.ts && pnpm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/repositories.ts test/web/repositories.test.ts
git commit -m "feat(web): resolve omitted and legacy default repository ids to the home entry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `syncStoredWebRepository` only resets managed clones

The origin migration (Task 6) will register the home checkout with a `sourceUrl`. Today `syncStoredWebRepository` runs `git reset --hard FETCH_HEAD` on any entry with a `sourceUrl`, which would wipe the operator's working tree. Gate on `managed` instead.

**Files:**
- Modify: `src/web/repositories.ts:329-345` (`syncStoredWebRepository` and its doc comment)
- Test: `test/web/repositories-sync.test.ts`

**Interfaces:**
- Consumes: `WebRepository.managed` (Task 1).
- Produces: `syncStoredWebRepository(repository, runGit?)` returns `false` and runs nothing unless `repository.managed === true`.

- [ ] **Step 1: Update the tests**

In `test/web/repositories-sync.test.ts`:

Add `managed: true,` to the repository objects in `"refreshes a checkout Nitely cloned itself"` and `"falls back to HEAD when no default branch is recorded"` (after `sourceUrl`). Then add this test after `"never touches a repository registered by path"`:

```ts
  it("never resets a checkout that merely records a source URL", async () => {
    const calls: string[][] = [];
    const synced = await syncStoredWebRepository(
      {
        id: "acme-nitely",
        name: "acme/nitely",
        path: "~/nitely",
        sourceUrl: "https://github.com/acme/nitely.git",
        home: true,
      },
      async (args) => {
        calls.push(args);
      },
    );

    expect(synced).toBe(false);
    expect(calls).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `pnpm exec vitest run test/web/repositories-sync.test.ts`
Expected: FAIL — `"never resets a checkout that merely records a source URL"` gets `synced === true`.

- [ ] **Step 3: Implement**

Replace the doc comment and first line of `syncStoredWebRepository`:

```ts
/**
 * Refresh a checkout Nitely created itself. Only managed clones — the ones
 * under `<home>/.nitely/repositories` — are touched: those are Nitely's to
 * reset. Anything else, including the home checkout the origin migration
 * registers with a source URL, is somebody's working tree, and discarding
 * uncommitted work there would be unforgivable.
 */
export async function syncStoredWebRepository(
  repository: WebRepository,
  runGit: RunGit = defaultRunGit,
): Promise<boolean> {
  if (repository.managed !== true) return false;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/web/repositories-sync.test.ts test/web/repositories.test.ts && pnpm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/repositories.ts test/web/repositories-sync.test.ts
git commit -m "fix(web): only reset managed clones on repository sync

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: API responses never carry a repository path

**Files:**
- Create: `src/web/json.ts`
- Test: `test/web/json.test.ts` (new)
- Modify: `src/web/server.ts:652-672` (`sendJson`, `sendJsonWithHeaders`), `:10155-10158` (SSE `writeEvent`), `:352-364` (import block), `:1698-1709` (`repositoryVisibleToUser`), `:2930-2946` (`withRepository`), `:3797`, `:5422`, `:5450`, `:5501` (run input `repoId`), `:7508-7511` (demo response), `:7515-7520` (`GET /api/repositories`), `:7844-7851` (`POST /api/repositories`), `:7860` (factory queue repository)
- Modify tests: `test/web/server.test.ts` assertions listed in Step 5

**Interfaces:**
- Consumes: `publicRepository`, `WebRepository.home` (Task 1).
- Produces: `export function serializeWebJson(value: unknown): string` in `src/web/json.ts`.

- [ ] **Step 1: Write the failing unit test**

Create `test/web/json.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { serializeWebJson } from "../../src/web/json.js";

describe("serializeWebJson", () => {
  it("drops repoPath keys at any depth and keeps everything else", () => {
    const payload = {
      task: { id: "t-1", repoId: "app", repoPath: "/srv/app" },
      runs: [{ runId: "r-1", repoPath: "/srv/app", artifacts: [{ path: "out.md" }] }],
      repository: { id: "app", path: "/srv/app" },
    };

    expect(JSON.parse(serializeWebJson(payload))).toEqual({
      task: { id: "t-1", repoId: "app" },
      runs: [{ runId: "r-1", artifacts: [{ path: "out.md" }] }],
      repository: { id: "app", path: "/srv/app" },
    });
  });

  it("serializes scalars and arrays unchanged", () => {
    expect(serializeWebJson([1, "a", null])).toBe('[1,"a",null]');
    expect(serializeWebJson("x")).toBe('"x"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/web/json.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the serializer**

Create `src/web/json.ts`:

```ts
const REDACTED_KEYS: ReadonlySet<string> = new Set(["repoPath"]);

/**
 * Serialize a Web API payload. A repository's checkout location is a server
 * implementation detail, so every `repoPath` key is dropped here, at the one
 * place all JSON responses pass through, rather than at each of the sites
 * that assemble a task, run, skill, or notification view.
 */
export function serializeWebJson(value: unknown): string {
  return JSON.stringify(value, (key, entry) =>
    REDACTED_KEYS.has(key) ? undefined : entry,
  );
}
```

Run: `pnpm exec vitest run test/web/json.test.ts` — Expected: PASS.

- [ ] **Step 4: Wire the server**

In `src/web/server.ts`:

Add to the imports (near line 352):

```ts
import { serializeWebJson } from "./json.js";
```

Add `publicRepository,` to the `./repositories.js` import block (line 356–364, alphabetical after `loadWebRepositories`).

`sendJson` and `sendJsonWithHeaders` (lines 652–672): change both `response.end(JSON.stringify(value));` to `response.end(serializeWebJson(value));`.

SSE `writeEvent` (line ~10157): change to

```ts
      response.write(`event: ${event}\ndata: ${serializeWebJson(data)}\n\n`);
```

`repositoryVisibleToUser` (line ~1705): change `if (repository.id === "default") {` to `if (repository.home === true) {`.

`withRepository` (lines 2930–2946): change `repoId: existing.repoId ?? repository.id,` to `repoId: repository.id,`. Add above the function:

```ts
/**
 * Attach the repository a record was loaded from. That repository is
 * authoritative for `repoId`: records written before the `default`
 * repository was retired still carry `repoId: "default"`, and the view must
 * name the entry they actually live under.
 */
```

The four run-input sites — search for `repoId: workItem.repoId ?? repository.id,` (line ~3797) and the three `repoId: input.task.repoId ?? input.repository.id,` (lines ~5422, ~5450, ~5501) — become `repoId: repository.id,` and `repoId: input.repository.id,` respectively.

Demo response (line ~7510):

```ts
      repositories: (
        await loadWebRepositories(input.repoPath, input.repositories)
      ).map(publicRepository),
```

`GET /api/repositories` (line ~7518):

```ts
      repositories: visibleRepositories(repositories, user).map(publicRepository),
```

`POST /api/repositories` (lines ~7844–7851):

```ts
    sendJson(response, 201, {
      repository: publicRepository(repository),
      repositories: visibleRepositories(
        await loadWebRepositories(input.repoPath, input.repositories),
        user,
      ).map(publicRepository),
    });
```

Factory queue (line ~7860): `repository: { id: repository.id, name: repository.name },`.

- [ ] **Step 5: Update server test assertions that expected paths**

In `test/web/server.test.ts`, remove the `path:` / `repoPath:` expectations from API-response assertions. Search for each and delete only that property line (or the `expect.objectContaining` argument key):

- line ~5360: `repoPath: resolve(docsRepo),` inside `entry: {` (context-kg proposal).
- line ~8832: `expect.objectContaining({ id: "default", name: expect.any(String), path: resolve(defaultRepo) })` → drop `path: ...`; line ~8833 same for `docs`.
- lines ~8854, ~8865, ~8886, ~8897, ~8907: `repoPath: resolve(docsRepo),`.
- lines ~9025, ~9045: `repoPath: expectedRepoPath,` (both in `body.demo` and `body.demo.repository`); also drop `repoPath: string;` from the two type literals at ~8990 and ~9003, and `path: string;` from the `repositories: Array<{...}>` type at ~9009.
- line ~9455: `path: resolve(appRepo),` in `expect(added).toMatchObject({ repository: {...} })`.
- lines ~9481–9482: drop `path: resolve(defaultRepo)` and `path: resolve(appRepo)`.
- line ~9932: `path: expectedPath,` in the clone test's `repository:` expectation.
- line ~9963: `repoPath: expectedPath,`.

Type-literal fields `repoPath?: string` in `as { task: {...} }` casts may stay; they are optional.

- [ ] **Step 6: Run the affected server tests locally where possible**

Run: `pnpm run check && pnpm exec vitest run test/web/json.test.ts test/web/repositories.test.ts`
Then try the repository-focused server tests: `pnpm exec vitest run test/web/server.test.ts -t "repositor"`
Expected: tsc clean; unit tests PASS; server tests PASS on Linux (on macOS, failures citing `UnsafeRunOwnedFileError` are the platform boundary, not this change — anything else is a real failure).

- [ ] **Step 7: Commit**

```bash
git add src/web/json.ts test/web/json.test.ts src/web/server.ts test/web/server.test.ts
git commit -m "feat(web): strip repository paths from every API response

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Registration is GitHub-URL only; the HTTP API refuses `path`

**Files:**
- Modify: `src/web/repositories.ts:36-44` (`AddWebRepositoryInput`), `:405-470` (`addStoredWebRepository`)
- Modify: `src/web/server.ts:2671-2687` (`repositoryInputFromJson`)
- Test: `test/web/server.test.ts` — rewrite `"persists repositories added through the Web API and routes tasks to them"` (~9439), delete `"rejects duplicate repository paths"` (~10004) and `"rejects added repositories whose path does not exist"` (~10037), add `"rejects repository registration by server path"`.

**Interfaces:**
- Produces: `AddWebRepositoryInput.path` is documented as honored only when `synthetic === true`; `addStoredWebRepository` throws `WebInputError("githubUrl is required")` otherwise. `repositoryInputFromJson` throws `WebInputError("repository path is not accepted; register a GitHub URL")` when the body has a `path` key.

- [ ] **Step 1: Write the failing server tests**

In `test/web/server.test.ts`, replace the body of `"persists repositories added through the Web API and routes tasks to them"` so it registers by URL with a clone stub. The new test:

```ts
  it("persists repositories added through the Web API and routes tasks to them", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      cloneRepository: async ({ targetPath }) => {
        await mkdir(join(targetPath, "flows"), { recursive: true });
        await writeFile(
          join(targetPath, "flows/implement-spec-bootstrap.json"),
          "{}",
          "utf8",
        );
      },
    });

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "app",
        name: "App repo",
        githubUrl: "https://github.com/acme/app",
        defaultBranch: "main",
        synthetic: true,
      }),
    });
    expect(addResponse.status).toBe(201);
    const added = (await json(addResponse)) as {
      repository: { synthetic?: boolean; organizationId?: string };
    };
    expect(added).toMatchObject({
      repository: {
        id: "app",
        name: "App repo",
        defaultBranch: "main",
        sourceUrl: "https://github.com/acme/app.git",
      },
    });
    expect(added.repository.synthetic).toBeUndefined();
    expect(added.repository.organizationId).toBeUndefined();
    const repositoriesFile = await readFile(
      join(defaultRepo, ".nitely", "repositories.json"),
      "utf8",
    );
    expect(repositoriesFile).toContain('"id": "app"');
    expect(repositoriesFile).not.toContain('"synthetic"');

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        expect.objectContaining({ id: "default" }),
        expect.objectContaining({ id: "app", name: "App repo" }),
      ],
    });
```

Keep the rest of that test (task creation with `repoId: "app"` and the assertions that follow) as it is, minus the `repoPath` lines already removed in Task 4.

Delete the two tests `"rejects duplicate repository paths"` and `"rejects added repositories whose path does not exist"` entirely.

Add after the clone test (`"clones GitHub repositories from URL input before registering them"`):

```ts
  it("rejects repository registration by server path", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const response = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "app", path: defaultRepo }),
    });

    await expectWebInputError(
      response,
      "repository path is not accepted; register a GitHub URL",
    );
  });

  it("requires a GitHub URL to register a repository", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const response = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "app", name: "App" }),
    });

    await expectWebInputError(response, "githubUrl is required");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/web/server.test.ts -t "repositor"`
Expected: the two new tests FAIL (path is accepted today; missing URL reports "repository id is required" / "repository path is required").

- [ ] **Step 3: Implement**

`src/web/repositories.ts` — `AddWebRepositoryInput` (lines 36–44):

```ts
export interface AddWebRepositoryInput {
  id?: string;
  name?: string;
  /**
   * Explicit checkout location. Honored only for synthetic entries (the
   * mocked golden-path demo registers its fixture this way). Every other
   * registration clones `githubUrl` into the managed checkout root.
   */
  path?: string;
  githubUrl?: string;
  defaultBranch?: string;
  synthetic?: boolean;
  organizationId?: string;
}
```

In `addStoredWebRepository`, replace the block from `const githubUrl = ...` through `if (!repositoryPath) { throw ... }` (lines ~411–416) with:

```ts
  const githubUrl = input.githubUrl?.trim();
  const parsedUrl = githubUrl ? parseGitHubRepositoryUrl(githubUrl) : undefined;
  const syntheticPath =
    input.synthetic === true ? input.path?.trim() || undefined : undefined;
  if (!parsedUrl && !syntheticPath) {
    throw new WebInputError("githubUrl is required");
  }
  const id =
    input.id?.trim() ||
    (parsedUrl ? sanitizeRepoId(`${parsedUrl.owner}-${parsedUrl.repo}`) : "");
  if (!id) {
    throw new WebInputError("repository id is required");
  }
  const repositoryPath = syntheticPath ?? checkoutPath(defaultRepoPath, id);
```

And change the clone condition (line ~449) from `if (parsedUrl && !input.path?.trim()) {` to `if (parsedUrl && !syntheticPath) {`.

`src/web/server.ts` — `repositoryInputFromJson` (lines 2671–2687): after the demo-id guard add

```ts
  if ("path" in record) {
    throw new WebInputError(
      "repository path is not accepted; register a GitHub URL",
    );
  }
```

and delete the `path: typeof record.path === "string" ? record.path : undefined,` line from the returned object.

- [ ] **Step 4: Run tests and type check**

Run: `pnpm run check && pnpm exec vitest run test/web/server.test.ts -t "repositor"`
Expected: tsc clean; PASS (on Linux; macOS: only `UnsafeRunOwnedFileError` failures are the platform boundary).

- [ ] **Step 5: Commit**

```bash
git add src/web/repositories.ts src/web/server.ts test/web/server.test.ts
git commit -m "feat(web): register repositories by GitHub URL only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Startup migration registers the home checkout from its `origin`

**Files:**
- Modify: `src/web/repositories.ts` — add `ReadOriginUrl`, `readGitOriginUrl`, `migrateHomeRepository` after `defaultCloneRepository` (line ~328)
- Modify: `src/web/server.ts:442-444` (`StartWebServerInput`), `:10349-10358` (`startWebServer`), import block
- Test: `test/web/repositories.test.ts`

**Interfaces:**
- Produces:
  - `export type ReadOriginUrl = (path: string) => Promise<string | undefined>`
  - `export async function readGitOriginUrl(path: string): Promise<string | undefined>` — `origin` of the git repository whose top level is exactly `path`; `undefined` otherwise.
  - `export async function migrateHomeRepository(homePath: string, readOriginUrl?: ReadOriginUrl): Promise<WebRepository | undefined>` — appends one stored entry `{ id: sanitizeRepoId(owner-repo), name: owner/repo, path: home, sourceUrl }` when home has a GitHub origin and nothing stored already covers it; returns the entry it wrote, else `undefined`. Idempotent.
  - `StartWebServerInput.readRepositoryOrigin?: ReadOriginUrl` — test seam.

- [ ] **Step 1: Write the failing tests**

Append to `test/web/repositories.test.ts` (extend imports: `migrateHomeRepository`, `readGitOriginUrl`; add `import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";`, `import { tmpdir } from "node:os";`, `import { join, resolve } from "node:path";`, `import { execFile } from "node:child_process";`, `import { promisify } from "node:util";`):

```ts
const execFileAsync = promisify(execFile);

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-repositories-"));
}

async function storedRepositories(home: string) {
  const file = JSON.parse(
    await readFile(join(home, ".nitely", "repositories.json"), "utf8"),
  ) as { repositories: Array<Record<string, unknown>> };
  return file.repositories;
}

describe("migrateHomeRepository", () => {
  it("registers the home checkout from its GitHub origin exactly once", async () => {
    const home = await tempHome();
    const readOriginUrl = async () => "git@github.com:acme/nitely.git";

    const first = await migrateHomeRepository(home, readOriginUrl);
    expect(first).toMatchObject({
      id: "acme-nitely",
      name: "acme/nitely",
      path: resolve(home),
      sourceUrl: "git@github.com:acme/nitely.git",
      home: true,
    });
    expect(first).not.toHaveProperty("managed");

    const second = await migrateHomeRepository(home, readOriginUrl);
    expect(second).toBeUndefined();
    expect(await storedRepositories(home)).toEqual([
      {
        id: "acme-nitely",
        name: "acme/nitely",
        path: resolve(home),
        sourceUrl: "git@github.com:acme/nitely.git",
      },
    ]);
  });

  it("registers nothing when home has no origin", async () => {
    const home = await tempHome();
    expect(await migrateHomeRepository(home, async () => undefined)).toBeUndefined();
    await expect(
      readFile(join(home, ".nitely", "repositories.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers nothing when the origin is not on github.com", async () => {
    const home = await tempHome();
    expect(
      await migrateHomeRepository(home, async () => "https://gitlab.com/acme/nitely.git"),
    ).toBeUndefined();
  });

  it("skips when a stored entry already covers the same source or the home path", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".nitely"), { recursive: true });
    await writeFile(
      join(home, ".nitely", "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [
          {
            id: "already",
            name: "Already",
            path: join(home, ".nitely", "repositories", "already"),
            sourceUrl: "https://github.com/ACME/Nitely.git",
          },
        ],
      }),
      "utf8",
    );
    expect(
      await migrateHomeRepository(home, async () => "git@github.com:acme/nitely.git"),
    ).toBeUndefined();

    await writeFile(
      join(home, ".nitely", "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [{ id: "tree", name: "Tree", path: home }],
      }),
      "utf8",
    );
    expect(
      await migrateHomeRepository(home, async () => "git@github.com:other/repo.git"),
    ).toBeUndefined();
    expect(await storedRepositories(home)).toHaveLength(1);
  });
});

describe("readGitOriginUrl", () => {
  it("reads origin only when the directory is the repository top level", async () => {
    const root = await tempHome();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await execFileAsync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    const nested = join(root, "nested");
    await mkdir(nested);

    expect(await readGitOriginUrl(root)).toBe("https://github.com/acme/app.git");
    expect(await readGitOriginUrl(nested)).toBeUndefined();
  });

  it("returns undefined outside any repository", async () => {
    expect(await readGitOriginUrl(await tempHome())).toBeUndefined();
  });
});
```

(The last `readGitOriginUrl` test relies on `tmpdir()` not living inside a git checkout, which is true on macOS and the Linux box.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/web/repositories.test.ts`
Expected: FAIL — `migrateHomeRepository` / `readGitOriginUrl` are not exported.

- [ ] **Step 3: Implement**

In `src/web/repositories.ts`, after `defaultCloneRepository` (line ~328) add:

```ts
export type ReadOriginUrl = (path: string) => Promise<string | undefined>;

async function gitOutput(args: string[]): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolvePromise) => {
    execFile("git", args, { timeout: 10_000 }, (error, stdout) => {
      resolvePromise(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * The `origin` URL of the git repository rooted exactly at `path`. A
 * directory that merely sits inside some other checkout (a temp directory
 * under a clone, a state directory nested in a project) yields nothing: only
 * a checkout whose top level is `path` itself is the home checkout.
 */
export async function readGitOriginUrl(path: string): Promise<string | undefined> {
  const toplevel = await gitOutput(["-C", path, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return undefined;
  const [realToplevel, realPath] = await Promise.all([
    realpathOrResolve(toplevel),
    realpathOrResolve(path),
  ]);
  if (realToplevel !== realPath) return undefined;
  return await gitOutput(["-C", path, "remote", "get-url", "origin"]);
}

/**
 * One-time, idempotent startup migration for installs that used to treat the
 * console home directory as the implicit `default` repository. When home is
 * a checkout with a GitHub `origin` and nothing stored already covers that
 * source or that path, register it as an ordinary repository whose checkout
 * happens to be home. Runs recorded under `<home>/.nitely/runs` keep their
 * owner that way.
 */
export async function migrateHomeRepository(
  homePath: string,
  readOriginUrl: ReadOriginUrl = readGitOriginUrl,
): Promise<WebRepository | undefined> {
  const home = resolve(homePath);
  const stored = await readStoredRepositories(home);
  if (stored.some((entry) => resolve(entry.path) === home)) return undefined;
  const originUrl = await readOriginUrl(home);
  if (!originUrl) return undefined;
  let parsed: ParsedGitHubUrl;
  try {
    parsed = parseGitHubRepositoryUrl(originUrl);
  } catch {
    return undefined;
  }
  const sourceKey = repositorySourceKey(parsed.cloneUrl);
  if (stored.some((entry) => repositorySourceKey(entry.sourceUrl) === sourceKey)) {
    return undefined;
  }
  const entry: WebRepositoryInput = {
    id: sanitizeRepoId(`${parsed.owner}-${parsed.repo}`),
    name: `${parsed.owner}/${parsed.repo}`,
    path: home,
    sourceUrl: parsed.cloneUrl,
  };
  if (stored.some((candidate) => candidate.id === entry.id)) return undefined;
  await writeJsonAtomic(repositoriesPath(home), {
    version: 1,
    repositories: [...stored, entry],
  });
  return normalizeRepository(home, entry);
}
```

Note `parseGitHubRepositoryUrl` normalizes the SSH form to `git@github.com:acme/nitely.git`, which is what the first test expects as `sourceUrl`.

In `src/web/server.ts`:

Add `migrateHomeRepository,` and `type ReadOriginUrl,` to the `./repositories.js` import block.

`StartWebServerInput` (line 442): after `repositories?: WebRepositoryInput[];` add

```ts
  /** Test seam for the home-checkout migration; defaults to reading git. */
  readRepositoryOrigin?: ReadOriginUrl;
```

In `startWebServer` (line ~10353), right after `const runtimeInput: RuntimeStartWebServerInput = { ... };` add:

```ts
  const migratedHome = await migrateHomeRepository(
    input.repoPath,
    input.readRepositoryOrigin,
  );
  if (migratedHome) {
    console.warn(
      `Registered the home checkout as repository ${migratedHome.id} from ${migratedHome.sourceUrl}`,
    );
  }
```

- [ ] **Step 4: Run tests and type check**

Run: `pnpm exec vitest run test/web/repositories.test.ts && pnpm run check`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/repositories.ts src/web/server.ts test/web/repositories.test.ts
git commit -m "feat(web): register the home checkout from its origin on startup

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Retire the implicit `default` repository (with the test-suite migration)

This task removes the synthesized `default` entry and, in the same commit, makes every test boot register its temp repository explicitly as `home`. They must land together: the suite is red between the two halves.

**Files:**
- Modify: `src/web/repositories.ts` — `normalizeRepository` (empty id), `resolveWebRepositories` (no synthesis, reserved-id guard), `addStoredWebRepository` (reserved-id guard)
- Modify: `test/web/repositories.test.ts` (add the no-synthesis case)
- Modify: `test/web/server.test.ts` (helper + 4 direct boots + `"default"` → `"home"`), `test/web/preview-sessions.test.ts`, `test/web/github-webhook-route.test.ts`, `test/mcp/server.test.ts`, `test/web/security-startup.test.ts`, `test/web/execution-policy.test.ts`, `test/web/device-flow-api.test.ts`, `test/web/device-page.test.ts`, `test/web/flows-api.test.ts`, `test/web/console-sync-indicator.test.ts`, `test/web/mobile-viewport.test.ts`, `test/web/knowledge-repositories.test.ts`

**Interfaces:**
- Consumes: `home` flag (Task 1), `repositoryById` home resolution (Task 2), `readRepositoryOrigin` seam (Task 6).
- Produces: `resolveWebRepositories(home, inputs)` returns only the given inputs; an input with an empty id throws `WebInputError("repository id is required")`; id `default` throws `WebInputError("repository id default is reserved")`.

- [ ] **Step 1: Write the failing unit test**

Append to the `resolveWebRepositories` describe in `test/web/repositories.test.ts`:

```ts
  it("registers nothing for the home directory by itself", () => {
    expect(resolveWebRepositories("/srv/nitely", [])).toEqual([]);
  });

  it("requires an id and reserves the legacy default id", () => {
    expect(() =>
      resolveWebRepositories("/srv/nitely", [{ path: "/srv/nitely" }]),
    ).toThrow("repository id is required");
    expect(() =>
      resolveWebRepositories("/srv/nitely", [{ id: "default", path: "/srv/nitely" }]),
    ).toThrow("repository id default is reserved");
  });
```

Run: `pnpm exec vitest run test/web/repositories.test.ts` — Expected: the first new test FAILS (a `default` entry is returned).

- [ ] **Step 2: Remove the synthesis**

In `src/web/repositories.ts`:

`normalizeRepository`: replace `const id = input.id?.trim() || LEGACY_DEFAULT_REPOSITORY_ID;` with

```ts
  const id = input.id?.trim();
  if (!id) {
    throw new WebInputError("repository id is required");
  }
```

`resolveWebRepositories`: delete the `byId.set("default", normalizeRepository(...))` block and change the guard message:

```ts
    if (normalized.id === LEGACY_DEFAULT_REPOSITORY_ID) {
      throw new WebInputError("repository id default is reserved");
    }
```

`addStoredWebRepository` (line ~426): same guard text: `throw new WebInputError("repository id default is reserved");`.

Run: `pnpm exec vitest run test/web/repositories.test.ts test/web/repositories-sync.test.ts && pnpm run check` — Expected: PASS.

- [ ] **Step 3: Migrate `test/web/server.test.ts`**

Replace `startTestServer` (line ~236) with:

```ts
function homeRepository(path: string) {
  return { id: "home", name: "home", path };
}

async function startTestServer(
  repoPath: string,
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>,
  providerStore?: ProviderConnectionStore,
  options: Partial<Parameters<typeof startWebServer>[0]> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    runFlow,
    providerCommandStatus: async () => false,
    providerStore,
    readRepositoryOrigin: async () => undefined,
    ...options,
    repositories: [homeRepository(repoPath), ...(options.repositories ?? [])],
  });
  servers.push(server);
  return server;
}
```

For the four other direct `startWebServer({` calls in this file (search `await startWebServer({`), add `repositories: [homeRepository(<that call's repoPath variable>)]` (merging with any existing `repositories:` array) and `readRepositoryOrigin: async () => undefined`.

Replace every remaining `"default"` repository id with `"home"` — lines ~6138 (`repoId: "default"`), ~6586, ~8832 (`id: "default"`), ~9281, ~9314, ~9335, ~9347, ~9353, ~9372 (`repoId: "default"` in skill import bodies/expectations), ~9481, ~9657, ~9670, ~9712, ~9860, ~9872 (organization visibility arrays). Confirm with `grep -n '"default"' test/web/server.test.ts` that only non-repository uses remain (there should be none).

Add one end-to-end migration test near the clone test:

```ts
  it("registers the home checkout from its origin and routes unscoped requests to it", async () => {
    const home = await createRepo();
    const server = await startWebServer({
      repoPath: home,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      readRepositoryOrigin: async () => "https://github.com/acme/home.git",
    });
    servers.push(server);

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        { id: "acme-home", name: "acme/home", sourceUrl: "https://github.com/acme/home.git" },
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Unscoped task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { repoId?: string } };
    expect(created.task.repoId).toBe("acme-home");
  });

  it("requires a repoId when nothing is registered at the home directory", async () => {
    const home = await createRepo();
    const server = await startWebServer({
      repoPath: home,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      readRepositoryOrigin: async () => undefined,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Orphan", spec: "s", techDesign: "d" }),
    });
    await expectWebInputError(response, "repoId is required");
  });
```

- [ ] **Step 4: Migrate the other server-booting test files**

For every `startWebServer({` in the files below, add `repositories: [{ id: "home", name: "home", path: <the repoPath variable of that call> }],` unless the call already passes a `repositories:` array, in which case prepend the home entry to it. Then replace repository ids:

- `test/web/preview-sessions.test.ts` — one boot (~229; has a `repositories:` array: prepend); `repoId: "default"` at ~293 and ~568 → `"home"`.
- `test/web/github-webhook-route.test.ts` — six boots; `repositoryId: "default"` in the webhook mapping at ~116, ~179, ~211, ~241 → `"home"` (the mapping must reference a registered id).
- `test/mcp/server.test.ts` — two boots; `repoId: "default"` at ~164 and ~330 → `"home"`.
- `test/web/security-startup.test.ts` (5 boots), `test/web/execution-policy.test.ts` (2), `test/web/device-flow-api.test.ts` (1), `test/web/device-page.test.ts` (3), `test/web/flows-api.test.ts` (1), `test/web/console-sync-indicator.test.ts` (1), `test/web/mobile-viewport.test.ts` (1), `test/web/knowledge-repositories.test.ts` (1) — add the home entry only.

- [ ] **Step 5: Run what runs locally, then type check**

Run: `pnpm run check && pnpm exec vitest run test/web/repositories.test.ts test/web/flows-api.test.ts test/web/console-static.test.ts`
Expected: tsc clean; PASS. (`server.test.ts` and the rest are verified on Linux in Task 10; a quick local `pnpm exec vitest run test/web/server.test.ts -t "repositor"` should show only `UnsafeRunOwnedFileError` failures on macOS.)

- [ ] **Step 6: Commit**

```bash
git add src/web/repositories.ts test/web test/mcp/server.test.ts
git commit -m "feat(web): retire the implicit default repository

The console home directory is a state directory. Repositories come from
repositories.json, the programmatic seam, or the origin migration; an
omitted repoId resolves to whichever entry is checked out at home.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: CLI `web --home`, remove `--repository`, update docs

**Files:**
- Modify: `src/cli.ts:313-322` (`parseRepositoryOption` — delete), `:4667-4746` (`web` command)
- Test: `test/cli.test.ts:4886-5080` (web tests)
- Docs: `README.md` (7 sites), `README.zh-CN.md` (5), `docs/local-mcp.md` (2), `docs/enterprise-identity-rbac-and-audit.md` (1), `skills/nitely/references/install.md:140`, `skills/nitely/references/cli.md:152`, `scripts/nitely-prod-web-systemd-install:191,373`

**Interfaces:**
- Produces: `nitely web --home <dir> --host <host> --port <port> [--auth local|required]`; `--repo` accepted as an alias for `--home`; `--repository` is an unknown option.

- [ ] **Step 1: Update the CLI tests**

In `test/cli.test.ts` replace `"passes additional web repositories to the web server starter"` (~5026) with two tests:

```ts
  it("accepts --home as the state directory and keeps --repo as an alias", async () => {
    for (const flag of ["--home", "--repo"]) {
      const stdout: string[] = [];
      const stderr: string[] = [];

      const code = await runCli(
        ["web", flag, "/state"],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        {
          startWebServer: async (input) => {
            expect(input).toMatchObject({ repoPath: "/state" });
            expect(input).not.toHaveProperty("repositories");
            return {
              url: "http://127.0.0.1:4173",
              close: async () => {},
            };
          },
        },
      );

      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual(["Web Console: http://127.0.0.1:4173"]);
    }
  });

  it("rejects the removed --repository option", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--home", "/state", "--repository", "docs=/repos/docs"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async () => {
          throw new Error("must not start");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Unknown web option: --repository"]);
  });
```

Run: `pnpm exec vitest run test/cli.test.ts -t "web"` — Expected: `"accepts --home..."` FAILS (`--home` is unknown); `"rejects the removed --repository option"` FAILS (it is accepted today).

- [ ] **Step 2: Implement**

In `src/cli.ts`:

Delete `parseRepositoryOption` (lines 313–322).

In the `web` command: usage becomes

```ts
    usage: [
      "  web --home <dir> --host <host> --port <port> [--auth local|required]",
    ],
```

Rename `let repoPath = ".";` to `let homePath = ".";`, delete `const repositories: NonNullable<StartWebServerInput["repositories"]> = [];`, replace the `--repo` and `--repository` branches with

```ts
          if (arg === "--home" || arg === "--repo") {
            homePath = argv[++index] ?? "";
            continue;
          }
```

change `if (!repoPath) { io.stderr("Missing value for --repo"); return 1; }` to `if (!homePath) { io.stderr("Missing value for --home"); return 1; }`, and the `startWebServer` call to

```ts
        const server = await (dependencies.startWebServer ?? startWebServer)({
          repoPath: homePath,
          host,
          port,
          ...(authMode ? { authMode } : {}),
        });
```

If `StartWebServerInput` is no longer referenced elsewhere in `src/cli.ts`, drop it from the import.

- [ ] **Step 3: Update docs and scripts**

Replace `web --repo` with `web --home` in: `README.md`, `README.zh-CN.md`, `docs/local-mcp.md`, `docs/enterprise-identity-rbac-and-audit.md`, `skills/nitely/references/install.md`, `scripts/nitely-prod-web-systemd-install` (both `ExecStart=` lines). In `skills/nitely/references/cli.md:152` the usage line becomes `nitely web --home <dir> --host <host> --port <port> [--auth local|required]`. Leave `evidence search ... --repository <text>` (a different command) untouched.

Check: `grep -rn "web --repo" README.md README.zh-CN.md docs skills scripts` returns nothing.

- [ ] **Step 4: Run tests and type check**

Run: `pnpm run check && pnpm exec vitest run test/cli.test.ts test/docs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts README.md README.zh-CN.md docs/local-mcp.md docs/enterprise-identity-rbac-and-audit.md skills/nitely/references/install.md skills/nitely/references/cli.md scripts/nitely-prod-web-systemd-install
git commit -m "feat(cli): web takes --home; drop --repository

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Console — Repos page and add form without path

**Files:**
- Modify: `src/web/static/console.dc.html` — Repos grid (~1385–1400), Tasks repo strip (~1324), add-repository slide-over (~2619–2627), `createRepository` (~4776–4783), repositories view model (~5769–5777), flow skill picker (~6588–6593)
- Test: `test/web/console-static.test.ts:101, 296-306`

**Interfaces:**
- Consumes: `/api/repositories` entries without `path` (Task 4); `POST /api/repositories` rejecting `path` (Task 5).

- [ ] **Step 1: Update the template assertions**

In `test/web/console-static.test.ts`:

Line ~101: change `expect(html).toContain('skill.repoId === "default"');` to `expect(html).not.toContain('skill.repoId === "default"');`.

In `"contains repository management controls on the task surface"` (~296) add:

```ts
    expect(html).not.toContain('name="path"');
    expect(html).not.toContain('name="id" autocomplete="off" placeholder="instask-nitely"');
    expect(html).not.toContain("{{ repo.path }}");
    expect(html).not.toContain('repo.id === "default"');
```

Run: `pnpm exec vitest run test/web/console-static.test.ts` — Expected: FAIL on the four new `not.toContain` assertions and the flipped line-101 assertion.

- [ ] **Step 2: Edit the template**

In `src/web/static/console.dc.html`:

**Repos grid** (~1385–1400): in both the `.mobile-grid-head` and `.mobile-grid-row` inline styles change `grid-template-columns:minmax(0,1.4fr) minmax(0,2fr) 120px 118px` to `grid-template-columns:minmax(0,1fr) 120px 118px`. Delete the header `<span ...>Path</span>` line and the row line `<div style="font-family:'Geist Mono',monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ repo.path }}</div>`.

**Tasks repo strip** (~1324): delete the line `<div style="font-family:'Geist Mono',monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;">{{ repo.path }}</div>`.

**Add-repository form** (~2619–2627): delete the two `<label>` blocks for `Repository ID` (`name="id"`) and `Existing server path` (`name="path"`). Keep GitHub URL, Name, Default branch.

**`createRepository`** (~4780–4781): replace the two guard lines with

```js
    if (!String(data.githubUrl || "").trim()) { form.querySelector("input[name=githubUrl]").focus(); return; }
    this.setState({ repoStatus: "Cloning repository..." });
```

**Repositories view model** (~5769–5777):

```js
    const repositories = this.state.repositories.map((repo) => ({
      id: repo.id,
      name: repo.name || repo.id,
      defaultBranchLabel: repo.defaultBranch || "—",
      sourceBadge: repo.sourceUrl
        ? { label: "GitHub", style: { fontFamily: "'Geist Mono', monospace", fontSize: "11px", color: "var(--accent)", background: "var(--accent-soft)", borderRadius: "6px", padding: "2px 8px" } }
        : { label: "Local", style: { fontFamily: "'Geist Mono', monospace", fontSize: "11px", color: "var(--muted)", background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: "6px", padding: "2px 8px" } },
    }));
```

**Flow skill picker** (~6588): remove the `.filter((skill) => skill.repoId === "default")` line so every listed skill is offered (`label: skill.id + " · " + skill.repoName` already disambiguates). PR 2 makes skills global; until then the picker must not depend on a retired id.

- [ ] **Step 3: Run the static tests and a visual check**

Run: `pnpm exec vitest run test/web/console-static.test.ts test/web/flows-api.test.ts`
Expected: PASS.

Start the console (`pnpm dev -- web --home . --host 127.0.0.1 --port 4174`), open Repos: columns are Repository / Branch / Source; "Add repository" shows GitHub URL, Name, Default branch only; submitting without a URL focuses the URL field.

- [ ] **Step 4: Commit**

```bash
git add src/web/static/console.dc.html test/web/console-static.test.ts
git commit -m "feat(console): repositories without server paths

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification on the Linux box and PR

**Files:** none new.

- [ ] **Step 1: Sync to the Linux dev box**

```bash
rsync -a --delete --exclude .git --exclude node_modules --exclude .nitely ./ <linux-dev-box>:~/dev/nitely-agent-test/
```

- [ ] **Step 2: Run the merge gate remotely**

```bash
ssh <linux-dev-box> 'export PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH && cd ~/dev/nitely-agent-test && pnpm install --frozen-lockfile && pnpm run check && pnpm run test:run 2>&1 | tail -40'
```

Expected: `check` clean, `test:run` 0 failed. Any failure is a finding for this PR — fix it here; do not label it baseline.

- [ ] **Step 3: Confirm no `default` or path leaks remain**

```bash
grep -rn '"default"' src/web/repositories.ts src/web/server.ts | grep -v LEGACY_DEFAULT_REPOSITORY_ID
grep -rn 'repoPath' src/web/static/console.dc.html
```

Expected: the first shows only the `LEGACY_DEFAULT_REPOSITORY_ID` definition and `dashboard.ts`-style grouping fallbacks (none in these two files); the second shows nothing except the context-knowledge label at ~5898, which the JSON replacer already blanks (`contextKnowledgeEntry.repoPath || ""` renders empty).

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --repo jerryleooo/nitely --head "$(git branch --show-current)" --base master --title "feat(web): repositories without server paths; retire the implicit default repository" --body "$(cat <<'EOF'
## Summary

PR 1 of docs/superpowers/specs/2026-09-19-console-simplification-design.md.

- Console home is a state directory: the hard-coded `default` repository is retired. On startup the home checkout is registered from its GitHub `origin` once (idempotent); an omitted `repoId` resolves to that entry.
- Repositories register by GitHub URL only; `POST /api/repositories` rejects `path`.
- No API response carries a repository path (`serializeWebJson` drops `repoPath`; `publicRepository()` strips `path`).
- Repository sync resets only clones Nitely created under `<home>/.nitely/repositories`.
- `nitely web --home <dir>` (`--repo` kept as alias); `--repository` removed.
- Repos page: no Path column; add form is GitHub URL + optional Name / Default branch.

## Verification

`pnpm run check` and `pnpm run test:run` on the Linux dev box: <paste tail>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage (section 2 + PR 1 delivery line):**
- `--home` rename with `--repo` alias — Task 8.
- `--repository <id>=<path>` removed — Task 8.
- `path` internal, stripped from responses, never rendered — Tasks 1, 4, 9.
- `AddWebRepositoryInput` loses public `path`; HTTP `path` → 400; `githubUrl` required — Task 5.
- `default` retired; idempotent origin migration; home without origin registers nothing — Tasks 6, 7.
- Runs under `<home>/.nitely/runs` keep their owner — migration writes `path: home` (Task 6).
- Duplicate URL after migration errors — existing `duplicate repository source` check, exercised by Task 6's skip test.
- Synthetic demo untouched — Task 5 keeps the synthetic path branch.
- Repos page columns / add form — Task 9. ("Open preview" row action is PR 4 per spec section 1's delivery split.)
- Compatibility: "anything hard-coding `repoId: 'default'` must pass a real id or omit it" — Task 2 keeps `default` as a legacy alias for stored records; callers that omit get the home entry.
- Testing list — Tasks 1, 2, 5, 6, 7 cover registration, 400, migration idempotence, no-origin, duplicate.

**Deviation from spec noted:** the migration does not record `defaultBranch` (the spec's example included it). The home entry is never synced (Task 3), and runs discover `origin/HEAD` themselves, so the field has no consumer for that entry.

**Placeholder scan:** none.

**Type consistency:** `normalizeRepository(homePath, input)` is used with that argument order in Tasks 1, 6; `publicRepository` / `PublicWebRepository` names match between Tasks 1 and 4; `readRepositoryOrigin` on `StartWebServerInput` matches Task 6 and the Task 7 helper; `LEGACY_DEFAULT_REPOSITORY_ID` is defined in Task 1 and used in Tasks 2 and 7; error strings `"repoId is required"`, `"githubUrl is required"`, `"repository path is not accepted; register a GitHub URL"`, `"repository id default is reserved"`, `"repository id is required"` are identical between implementation and tests.
