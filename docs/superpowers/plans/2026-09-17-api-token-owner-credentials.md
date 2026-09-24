# Owner-Bound API Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every API token records an owning user, and a request authenticated by a token acts as that owner — so provider credentials the owner entered in the Web Console are used by the runs the owner starts from the CLI or MCP.

**Architecture:** `ownerUserId` is added to the token record and required at both mint sites (device-flow exchange takes the approving admin; `mcp token create` takes `--owner`). `prepareApiTokenRequest` loads the owner and builds a real `WebUserContext` from it instead of a fabricated `authMode: "local"` one, which makes the existing `providerStoreForUser` chain (owner store → repository store) apply to token requests with no further change. Unowned tokens are refused at request time.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, pnpm 11. `pnpm check` = `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-17-api-token-owner-credentials-design.md`

## Global Constraints

- Node.js 24+, pnpm 11; run everything from the worktree root.
- `pnpm check` must stay clean after every task.
- Vitest suites that start a web server without executing a real run work on macOS: `test/web/api-tokens.test.ts`, `test/web/server.test.ts`, `test/web/device-flow-api.test.ts`, `test/web/flows-api.test.ts`, `test/web/users.test.ts`, `test/mcp/server.test.ts`, `test/cli.test.ts`, `test/run/preflight.test.ts`. Anything touching Run-owned files must run on the Linux dev box (`jerry@100.96.111.79:/home/jerry/dev/nitely-agent-test`, see memory `run-tests-on-linux-box`).
- Never print or log a raw token; tests already assert this and must keep passing.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Match surrounding comment density and style; comments explain *why*, not *what*.

---

## File Structure

| File | Responsibility in this plan |
| --- | --- |
| `src/web/api-tokens.ts` | Token record shape, persistence, mint validation (`ownerUserId`) |
| `src/web/users.ts` | `findUserByIdOrEmail` lookup used by the CLI |
| `src/cli.ts` | `mcp token create --owner`, `mcp token list` owner column |
| `src/web/server.ts` | Device exchange sets owner; `prepareApiTokenRequest` resolves owner into the request user; audit `onBehalfOf` |
| `src/providers/types.ts`, `src/providers/file-store.ts` | Optional `describeCredentialSources()` so preflight can name the files it read |
| `src/run/preflight.ts` | `runtime-unavailable` remediation names the actual credential sources |
| `test/helpers/token-owner.ts` | Shared helper: create a user to own test tokens |
| `README.md`, `docs/local-mcp.md` | `--owner` in the documented commands |

---

### Task 1: Token record carries `ownerUserId`

**Files:**
- Modify: `src/web/api-tokens.ts:42-70` (record types, `CreateApiTokenInput`), `:118-155` (`publicRecord`, `parseStoredRecord`), `:260-305` (`createApiToken`)
- Create: `test/helpers/token-owner.ts`
- Test: `test/web/api-tokens.test.ts`
- Modify (call sites that mint tokens): `test/web/server.test.ts`, `test/web/flows-api.test.ts`, `test/web/device-flow-api.test.ts`, `test/mcp/server.test.ts`

**Interfaces:**
- Produces: `ApiTokenRecord.ownerUserId?: string` (optional on read so legacy records still list), `StoredApiTokenRecord.ownerUserId?: string`, `CreateApiTokenInput.ownerUserId: string` (required on mint). `createApiToken` throws `Error("API token owner is required")` on empty/whitespace owner.
- Produces: `createTokenOwner(repoPath: string, email?: string): Promise<{ id: string; email: string; password: string }>` in `test/helpers/token-owner.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("scoped API tokens", ...)` in `test/web/api-tokens.test.ts`:

```ts
  it("requires an owner when minting and round-trips it through the store", async () => {
    const repoPath = await createRepo();
    await expect(
      createApiToken(repoPath, {
        name: "no owner",
        capabilities: ["tasks:read"],
        ownerUserId: "   ",
      }),
    ).rejects.toThrow("API token owner is required");

    const created = await createApiToken(repoPath, {
      name: "owned",
      capabilities: ["tasks:read"],
      ownerUserId: "usr_owner",
    });
    expect(created.record.ownerUserId).toBe("usr_owner");

    const [listed] = await listApiTokens(repoPath);
    expect(listed.ownerUserId).toBe("usr_owner");

    const authenticated = await authenticateApiToken(repoPath, created.token);
    expect(authenticated?.ownerUserId).toBe("usr_owner");

    const stored = JSON.parse(await readFile(apiTokenStorePath(repoPath), "utf8")) as {
      tokens: Record<string, { ownerUserId?: string }>;
    };
    expect(stored.tokens[created.record.id].ownerUserId).toBe("usr_owner");
  });

  it("still lists a legacy record that has no owner", async () => {
    const repoPath = await createRepo();
    const created = await createApiToken(repoPath, {
      name: "legacy",
      capabilities: ["tasks:read"],
      ownerUserId: "usr_owner",
    });
    const path = apiTokenStorePath(repoPath);
    const file = JSON.parse(await readFile(path, "utf8")) as {
      tokens: Record<string, Record<string, unknown>>;
    };
    delete file.tokens[created.record.id].ownerUserId;
    await writeFile(path, JSON.stringify(file));

    const [listed] = await listApiTokens(repoPath);
    expect(listed.id).toBe(created.record.id);
    expect(listed.ownerUserId).toBeUndefined();
  });
```

Add `writeFile` to the `node:fs/promises` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/web/api-tokens.test.ts -t "owner"`
Expected: both FAIL — first because `createApiToken` accepts the whitespace owner (no throw) and TypeScript complains about the unknown property; second because `ownerUserId` is not persisted.

- [ ] **Step 3: Add the field to the record types and mint path**

In `src/web/api-tokens.ts`:

```ts
interface StoredApiTokenRecord {
  id: string;
  name: string;
  capabilities: ApiTokenCapability[];
  createdAt: string;
  tokenHash: string;
  /** Absent only on records minted before tokens carried an owner. */
  ownerUserId?: string;
  revokedAt?: string;
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  capabilities: ApiTokenCapability[];
  createdAt: string;
  ownerUserId?: string;
  revokedAt?: string;
}

export interface CreateApiTokenInput {
  name: string;
  capabilities: ApiTokenCapability[];
  /**
   * The user this token acts as. Callers validate that the user exists; the
   * store only refuses an empty value so no unowned token can be minted.
   */
  ownerUserId: string;
  allowHighImpact?: boolean;
  now?: () => Date;
}
```

`publicRecord`:

```ts
function publicRecord(record: StoredApiTokenRecord): ApiTokenRecord {
  return {
    id: record.id,
    name: record.name,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.ownerUserId ? { ownerUserId: record.ownerUserId } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}
```

`parseStoredRecord`: add to the validation condition

```ts
    (record.ownerUserId !== undefined && typeof record.ownerUserId !== "string") ||
```

and to the returned object

```ts
    ...(typeof record.ownerUserId === "string" && record.ownerUserId
      ? { ownerUserId: record.ownerUserId }
      : {}),
```

`createApiToken`, after the capability checks:

```ts
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("API token owner is required");
  }
```

and include `ownerUserId` in the `stored` object.

- [ ] **Step 4: Create the shared test helper**

Create `test/helpers/token-owner.ts`:

```ts
import { createUser } from "../../src/web/users.js";

/**
 * Tokens must belong to a user, so any test that mints one needs a user to
 * own it. The password is returned so tests that also log in as the owner can.
 */
export async function createTokenOwner(
  repoPath: string,
  email = "owner@example.test",
): Promise<{ id: string; email: string; password: string }> {
  const password = "token owner password passphrase";
  const user = await createUser(repoPath, { email, password, role: "admin" });
  return { id: user.id, email: user.email, password };
}
```

- [ ] **Step 5: Update every test mint site to pass an owner**

In each file, import the helper (`import { createTokenOwner } from "../helpers/token-owner.js";`) and add `ownerUserId: (await createTokenOwner(repoPath)).id` to every `createApiToken(...)` call. Existing tests in `test/web/api-tokens.test.ts` can pass the literal `ownerUserId: "usr_owner"` because they never start a server. Sites:

- `test/web/api-tokens.test.ts` — all existing `createApiToken` calls (6): add `ownerUserId: "usr_owner"`.
- `test/web/server.test.ts:520`, `:694` — use the helper with the test's `repoPath`.
- `test/web/flows-api.test.ts:124`, `:128` — one owner for both tokens: `const owner = await createTokenOwner(repo);` then `ownerUserId: owner.id`.
- `test/mcp/server.test.ts:476`, `:598` — helper with that test's `repoPath`.
- `test/web/device-flow-api.test.ts` — its one direct `createApiToken` call: helper.

Where a test file already has a user with the same default email, pass a different email to `createTokenOwner` (e.g. `"token-owner@example.test"`) so `createUser` does not throw `user already exists`.

- [ ] **Step 6: Run the affected suites**

Run: `pnpm check && pnpm exec vitest run test/web/api-tokens.test.ts test/web/server.test.ts test/web/flows-api.test.ts test/web/device-flow-api.test.ts test/mcp/server.test.ts`
Expected: PASS. (`test/web/server.test.ts` is large; if it is slow, run it once at the end of the task rather than per step.)

- [ ] **Step 7: Commit**

```bash
git add src/web/api-tokens.ts test/helpers/token-owner.ts test/web/api-tokens.test.ts test/web/server.test.ts test/web/flows-api.test.ts test/web/device-flow-api.test.ts test/mcp/server.test.ts
git commit -m "feat(api-tokens): record the owning user on every minted token

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `mcp token create --owner` and the owner column

**Files:**
- Modify: `src/web/users.ts` (new export next to `getPublicUser`, ~line 869)
- Modify: `src/cli.ts:3376-3480` (usage text, `token create` option parsing), `:1199-1210` (`printApiTokens`)
- Modify: `README.md:1088`, `docs/local-mcp.md:25,113`
- Test: `test/web/users.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `CreateApiTokenInput.ownerUserId` (Task 1), `hasAnyUsers(repoPath)` (exists in `src/web/users.ts:335`).
- Produces: `findUserByIdOrEmail(repoPath: string, value: string): Promise<PublicUser | null>` in `src/web/users.ts`.
- Produces: CLI `mcp token create ... --owner <email-or-user-id>` (required); `mcp token list` line format `${id}\t${status}\t${name}\t${capabilities}\t${ownerUserId ?? "unowned"}`.

- [ ] **Step 1: Write the failing lookup test**

Append to `test/web/users.test.ts` (inside its top-level `describe`; reuse its existing temp-repo helper if one exists, otherwise `mkdtemp`):

```ts
  it("finds a user by exact id or case-insensitive email", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-users-lookup-"));
    const created = await createUser(repoPath, {
      email: "Owner@Example.test",
      password: "owner password passphrase",
      role: "user",
    });

    expect((await findUserByIdOrEmail(repoPath, created.id))?.id).toBe(created.id);
    expect((await findUserByIdOrEmail(repoPath, "OWNER@example.TEST"))?.id).toBe(created.id);
    expect(await findUserByIdOrEmail(repoPath, "nobody@example.test")).toBeNull();
    expect(await findUserByIdOrEmail(repoPath, "  ")).toBeNull();
  });
```

Import `findUserByIdOrEmail` alongside the file's existing `users.js` imports, and `mkdtemp`/`tmpdir`/`join` if not already imported.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/web/users.test.ts -t "finds a user"`
Expected: FAIL — `findUserByIdOrEmail` is not exported.

- [ ] **Step 3: Implement the lookup**

In `src/web/users.ts`, after `getPublicUser`:

```ts
/**
 * Resolves an operator-typed owner reference. Ids are matched exactly; emails
 * the way `createUser` stores them, so `Owner@Example.test` finds the user
 * created as `owner@example.test`.
 */
export async function findUserByIdOrEmail(
  repoPath: string,
  value: string,
): Promise<PublicUser | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const users = await readUsers(repoPath);
  const byId = users.users[trimmed];
  if (byId) return await publicUserWithOrganizations(repoPath, byId);
  const email = normalizeEmail(trimmed);
  const byEmail = Object.values(users.users).find((user) => user.email === email);
  return byEmail ? await publicUserWithOrganizations(repoPath, byEmail) : null;
}
```

- [ ] **Step 4: Run the lookup test**

Run: `pnpm exec vitest run test/web/users.test.ts -t "finds a user"`
Expected: PASS

- [ ] **Step 5: Write the failing CLI tests**

In `test/cli.test.ts`, change the existing test `"creates, lists, and revokes scoped MCP API tokens without reprinting secrets"`:

- before the `runCli(["mcp","token","create", ...])` call, add
  ```ts
    const owner = await createTokenOwner(repoPath);
  ```
  and add `"--owner", owner.email,` to the argv after `"--name", "Claude Code",`.
- change the expected `createdOut` length to `6` and insert `expect(createdOut[3]).toBe(\`Owner: ${owner.id}\`);` so the assertions become: `[0]` matches `API TOKEN`, `[1]` Name, `[2]` Capabilities, `[3]` Owner, `[4]` `Token: nitely_api_`, `[5]` the "Store this token now" line. Update `rawToken` to read `createdOut[4]`.
- change both `list` expectations to end with `\t${owner.id}`:
  ```ts
      `${tokenId}\tactive\tClaude Code\ttasks:read,runs:start\t${owner.id}`,
  ```
  and the revoked one likewise.

In the test `"requires high-impact token confirmation and rejects unknown capabilities"`, add `const owner = await createTokenOwner(repoPath);` before the loop and `"--owner", owner.email,` to its argv, so those cases still fail for the reason under test.

Add a new test:

```ts
  it("refuses to mint an MCP API token without a resolvable owner", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-mcp-token-"));
    const base = ["mcp", "token", "create", "--repo", repoPath, "--name", "agent", "--capability", "tasks:read"];

    const noUsers: string[] = [];
    expect(
      await runCli([...base, "--owner", "someone@example.test"], {
        stdout: () => {},
        stderr: (line) => noUsers.push(line),
      }),
    ).toBe(1);
    expect(noUsers).toEqual([
      "No users exist in this instance yet; bootstrap the initial admin with `nitely web --auth required` before minting API tokens",
    ]);

    const owner = await createTokenOwner(repoPath);

    const missingFlag: string[] = [];
    expect(
      await runCli(base, { stdout: () => {}, stderr: (line) => missingFlag.push(line) }),
    ).toBe(1);
    expect(missingFlag).toEqual(["--owner <email-or-user-id> is required"]);

    const unknown: string[] = [];
    expect(
      await runCli([...base, "--owner", "nobody@example.test"], {
        stdout: () => {},
        stderr: (line) => unknown.push(line),
      }),
    ).toBe(1);
    expect(unknown).toEqual(["Unknown API token owner: nobody@example.test"]);

    const out: string[] = [];
    expect(
      await runCli([...base, "--owner", owner.email.toUpperCase()], {
        stdout: (line) => out.push(line),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(out[3]).toBe(`Owner: ${owner.id}`);
  });
```

Import `createTokenOwner` from `"./helpers/token-owner.js"` at the top of `test/cli.test.ts`.

- [ ] **Step 6: Run the CLI tests to verify they fail**

Run: `pnpm exec vitest run test/cli.test.ts -t "MCP API token"`
Expected: FAIL — `Unknown mcp token create option: --owner`.

- [ ] **Step 7: Implement `--owner` and the owner column**

In `src/cli.ts`, extend the `mcp` usage string (line ~3379) to

```
  mcp token create --repo <path> --name <name> --owner <email-or-user-id> --capability <capability> [--capability <capability> ...] [--allow-high-impact]
```

Import `findUserByIdOrEmail` and `hasAnyUsers` from `"./web/users.js"` (add `findUserByIdOrEmail?: typeof findUserByIdOrEmail; hasAnyUsers?: typeof hasAnyUsers;` to the CLI `dependencies` type next to `createApiToken?` at line ~222, following the existing injection pattern).

In the `create` option loop add:

```ts
            if (arg === "--owner") {
              owner = argv[++index] ?? "";
              if (!owner) throw new Error("Missing value for --owner");
              continue;
            }
```

with `let owner = "";` declared beside `name`. After the capability check and before minting:

```ts
          if (!(await (dependencies.hasAnyUsers ?? hasAnyUsers)(repoPath))) {
            throw new Error(
              "No users exist in this instance yet; bootstrap the initial admin with `nitely web --auth required` before minting API tokens",
            );
          }
          if (!owner) throw new Error("--owner <email-or-user-id> is required");
          const ownerUser = await (dependencies.findUserByIdOrEmail ?? findUserByIdOrEmail)(
            repoPath,
            owner,
          );
          if (!ownerUser) throw new Error(`Unknown API token owner: ${owner}`);
```

Pass `ownerUserId: ownerUser.id` to `createApiToken`, and print `io.stdout(\`Owner: ${created.record.ownerUserId}\`);` after the Capabilities line.

`printApiTokens`:

```ts
    io.stdout(
      `${token.id}\t${token.revokedAt ? "revoked" : "active"}\t${token.name}\t${token.capabilities.join(",")}\t${token.ownerUserId ?? "unowned"}`,
    );
```

The order of checks matters for the test: no-users first, then missing `--owner`, then unknown owner.

- [ ] **Step 8: Run the CLI tests**

Run: `pnpm check && pnpm exec vitest run test/cli.test.ts`
Expected: PASS (the whole file, since the help-text test asserts the usage line).

- [ ] **Step 9: Update docs**

`README.md` around line 1088 and `docs/local-mcp.md` lines 25 and 113: add `--owner <email>` to the `mcp token create` examples, and one sentence under the first example: "`--owner` names the user the token acts as; the token resolves provider credentials the way that user's Web Console session does." Run `pnpm exec vitest run test/docs` to confirm no doc test pins the old text.

- [ ] **Step 10: Commit**

```bash
git add src/web/users.ts src/cli.ts README.md docs/local-mcp.md test/web/users.test.ts test/cli.test.ts
git commit -m "feat(cli): require --owner when minting MCP API tokens

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Device-flow exchange mints an owned token

**Files:**
- Modify: `src/web/server.ts:6519-6524` (the `createApiToken` call in the device exchange handler)
- Test: `test/web/device-flow-api.test.ts`

**Interfaces:**
- Consumes: `DeviceAuthorizationRecord.approvedByUserId?: string` (`src/web/device-authorizations.ts:34`), `CreateApiTokenInput.ownerUserId` (Task 1).
- Produces: exchanged tokens have `ownerUserId === approvedByUserId`.

- [ ] **Step 1: Write the failing tests**

Extend the existing test `"links the approving admin to the token their approval minted"` in `test/web/device-flow-api.test.ts`: after `expect(exchanged.response.status).toBe(200);` add

```ts
    const [minted] = await listApiTokens(repoPath);
    expect(minted.id).toBe(exchanged.body.token_id);
    expect(minted.ownerUserId).toBe(approvals[0]?.actor.id);
```

placing it after `approvals` is computed. Import `listApiTokens` from `"../../src/web/api-tokens.js"`.

Add a new test:

```ts
  it("refuses to exchange an approved request that records no approver", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");
    await decide(server, cookie, String(body.user_code), "approve");

    // Simulate a record written by a version that did not link the approver.
    const recordPath = deviceAuthorizationPath(
      repoPath,
      normalizeUserCode(String(body.user_code)) as string,
    );
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete record.approvedByUserId;
    await writeFile(recordPath, JSON.stringify(record));

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(400);
    expect(exchanged.body).toEqual({ error: "access_denied" });
    expect(await listApiTokens(repoPath)).toEqual([]);
  });
```

`deviceAuthorizationPath` and `normalizeUserCode` are exported from `src/web/device-authorizations.ts` (the file already imports `normalizeUserCode`; add `deviceAuthorizationPath` to that import if it is exported — if it is not, export it: it is the `deviceAuthorizationPath(repoPath, userCode)` helper used at `device-authorizations.ts:265`). Import `readFile`/`writeFile` from `node:fs/promises`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/web/device-flow-api.test.ts -t "approv"`
Expected: the first fails on `ownerUserId` being `undefined`; the second fails because the exchange returns 200 (or throws on the empty owner from Task 1 as a 500).

- [ ] **Step 3: Set the owner at exchange, refuse without one**

In `src/web/server.ts`, replace the `createApiToken` call in the exchange handler:

```ts
    // The approver is the only identity this token can act as; a record
    // without one cannot mint, because an unowned token would resolve no
    // user's credentials and be refused on its first request anyway.
    if (!record.approvedByUserId) {
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.exchange",
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "access_denied",
        actor: {
          type: "anonymous",
          subjectHash: securityAuditSubjectFingerprint(record.userCode),
        },
      });
      sendDeviceFlowError(response, 400, "access_denied");
      return true;
    }
    // Minted here, not at approval, so no plaintext token ever rests on disk.
    const created = await createApiToken(homeRepoPath, {
      name: record.clientName,
      capabilities: record.capabilities,
      allowHighImpact: record.allowHighImpact,
      ownerUserId: record.approvedByUserId,
    });
```

Place the approver check **before** `claimDeviceAuthorization` so an approver-less record is not consumed by a refusal — read the surrounding code: the claim is the line `if (!(await claimDeviceAuthorization(homeRepoPath, record.userCode)))`; insert the check immediately above it. The later `...(record.approvedByUserId ? { target: ... } : {})` spread in the success audit can stay as is.

- [ ] **Step 4: Run the device-flow suite**

Run: `pnpm check && pnpm exec vitest run test/web/device-flow-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/device-authorizations.ts test/web/device-flow-api.test.ts
git commit -m "feat(auth): device-flow tokens are owned by the approving admin

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Token requests act as their owner

**Files:**
- Modify: `src/web/server.ts:441-450` (`PreparedApiTokenRequest`), `:742-818` (`prepareApiTokenRequest`), `:819-845` (`auditApiTokenRequest`), `:9933` (call site)
- Modify: `src/web/api-tokens.ts:75-86` (`ApiTokenRequestAuditInput.onBehalfOf`)
- Test: `test/web/server.test.ts`

**Interfaces:**
- Consumes: `ApiTokenRecord.ownerUserId` (Task 1), `getPublicUser(repoPath, userId)` (`src/web/users.ts:869`), `publicContext(user, authMode)` (`server.ts:1275`), `authModeForInput(input)` (`server.ts:1143`).
- Produces: `prepareApiTokenRequest(request, repoPath, authMode: WebAuthMode)`; denial reason codes `"token_unowned"` and `"owner_missing"`; `ApiTokenRequestAuditInput.onBehalfOf?: { userId: string }`; `AuthorizedApiTokenRequest.user` is the owner's real `WebUserContext`.

- [ ] **Step 1: Write the failing tests**

Add to `test/web/server.test.ts` (near the existing scoped-token tests around line 692):

```ts
  it("refuses a token that has no owner and one whose owner is gone", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    const created = await createApiToken(repoPath, {
      name: "orphan",
      capabilities: ["tasks:read"],
      ownerUserId: owner.id,
    });
    const server = await startTestServer(repoPath);

    // Legacy record: strip the owner the way a pre-ownership store looks.
    const storePath = apiTokenStorePath(repoPath);
    const file = JSON.parse(await readFile(storePath, "utf8")) as {
      tokens: Record<string, Record<string, unknown>>;
    };
    const withOwner = { ...file.tokens[created.record.id] };
    delete file.tokens[created.record.id].ownerUserId;
    await writeFile(storePath, JSON.stringify(file));

    const unowned = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(unowned.status).toBe(401);
    await expect(json(unowned)).resolves.toMatchObject({
      error: { message: expect.stringContaining("re-issue it with nitely mcp token create --owner") },
    });

    // Owner deleted after minting.
    file.tokens[created.record.id] = { ...withOwner, ownerUserId: "usr_deleted" };
    await writeFile(storePath, JSON.stringify(file));
    const missing = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(missing.status).toBe(401);

    const audit = (await readFile(apiTokenAuditPath(repoPath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "token.request");
    expect(audit.map((event) => event.reasonCode)).toEqual([
      "token_unowned",
      "owner_missing",
    ]);
    expect(JSON.stringify(audit)).not.toContain(created.token);
  });

  it("acts as the token owner, with the owner's role and an audited on-behalf-of link", async () => {
    const repoPath = await createRepo();
    const member = await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const created = await createApiToken(repoPath, {
      name: "member token",
      capabilities: ["tasks:read"],
      ownerUserId: member.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(listed.status).toBe(200);

    const audit = (await readFile(apiTokenAuditPath(repoPath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "token.request");
    expect(audit).toEqual([
      expect.objectContaining({
        tokenId: created.record.id,
        action: "tasks.list",
        decision: "allow",
        onBehalfOf: { userId: member.id },
      }),
    ]);
  });
```

`apiTokenStorePath` must be added to the `api-tokens.js` import in this file; `createUser` is already imported (line ~2622 uses it) — verify, else import from `"../../src/web/users.js"`. Import `createTokenOwner` from `"../helpers/token-owner.js"` if Task 1 did not already add it.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/web/server.test.ts -t "owner"`
Expected: FAIL — unowned token request returns 200; audit has no `onBehalfOf`.

- [ ] **Step 3: Resolve the owner in `prepareApiTokenRequest`**

In `src/web/api-tokens.ts`, add to `ApiTokenRequestAuditInput`:

```ts
  /** The user the token acted as; absent when the request was denied before an owner resolved. */
  onBehalfOf?: { userId: string };
```

In `src/web/server.ts`:

1. `PreparedApiTokenRequest` gains `onBehalfOf?: { userId: string };`.
2. Change the signature to `async function prepareApiTokenRequest(request: IncomingMessage, repoPath: string, authMode: WebAuthMode)` and update the call at line ~9933 to `prepareApiTokenRequest(request, repoPath, authModeForInput(authInput))` — `authInput` is already in scope there (it is passed to `securityAuditActorForRequest`); if its type does not match `authModeForInput`'s parameter, pass `runtimeInput` instead, which is what `authModeForInput` is called with elsewhere in `startWebServer`.
3. Replace the block that builds `authorized` (from `const authorized: AuthorizedApiTokenRequest = {` to the closing `return`) with:

```ts
  if (!token.ownerUserId) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebUnauthorizedError(
        "API token has no owner; re-issue it with nitely mcp token create --owner <user>",
      ),
      denialReasonCode: "token_unowned",
    };
  }
  const owner = await getPublicUser(repoPath, token.ownerUserId);
  if (!owner) {
    return {
      ...authenticatedCommon,
      tokenId: token.id,
      tokenName: token.name,
      denial: new WebUnauthorizedError("API token owner no longer exists"),
      denialReasonCode: "owner_missing",
    };
  }
  // The token is a credential for its owner, not a fourth kind of principal:
  // everything downstream (organization checks, provider store selection,
  // audit) sees the owner exactly as a browser session of theirs would.
  const authorized: AuthorizedApiTokenRequest = {
    token,
    action: mapped,
    user: publicContext(owner, authMode),
  };
  return {
    ...authenticatedCommon,
    tokenId: token.id,
    tokenName: token.name,
    onBehalfOf: { userId: owner.id },
    authorized,
  };
```

`getPublicUser` is exported from `src/web/users.js`; add it to the existing import from that module if absent.

4. In `auditApiTokenRequest`, add `...(prepared.onBehalfOf ? { onBehalfOf: prepared.onBehalfOf } : {}),` next to the `target` spread.

- [ ] **Step 4: Run the server suite**

Run: `pnpm check && pnpm exec vitest run test/web/server.test.ts test/web/flows-api.test.ts test/mcp/server.test.ts`
Expected: PASS. If an existing token test under `authMode: "local"` now fails because its owner does not exist, that test was not updated in Task 1 — fix it by using `createTokenOwner`.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/api-tokens.ts test/web/server.test.ts
git commit -m "feat(auth): API token requests act as the token's owner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Preflight names the credential files it read; cross-layer proof

**Files:**
- Modify: `src/providers/types.ts:66-72`, `src/providers/file-store.ts` (class body), `src/run/preflight.ts:466-490`
- Test: `test/run/preflight.test.ts`, `test/web/server.test.ts`

**Interfaces:**
- Produces: `ProviderConnectionStore.describeCredentialSources?(): string[]` — the files a store reads, primary first. `FileProviderConnectionStore` implements it as `[path, ...fallbackPaths]`.
- Consumes (test): `POST /api/providers/anthropic/connection` with body `{ value }` (session cookie), `GET /api/tasks/:id` returning `preflight.status`, token `runs:start` capability, Task 4's owner context.

- [ ] **Step 1: Write the failing preflight test**

In `test/run/preflight.test.ts`, add inside `describe("run preflight doctor", ...)`. The file already has `flow(stage)` (a one-stage codex agent flow you can override per field), `repoWithFlow(document)` (writes `flows/preflight.json` and `spec.md` into a temp repo), and `providerStore({...})` (an in-memory store); this test needs a real `FileProviderConnectionStore` instead so the message has file paths to name:

```ts
  it("names every credential file it read when a runtime has no provider", async () => {
    const repoPath = await repoWithFlow(flow({ runtime: "claude" }));
    const ownerPath = join(repoPath, ".nitely", "users", "usr_1", "connections.json");
    const repositoryPath = join(repoPath, ".nitely", "connections.json");
    const store = new FileProviderConnectionStore({
      path: ownerPath,
      fallbackPaths: [repositoryPath],
      env: {},
      commandStatus: async () => false,
    });

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: { spec: { connector: "local-file", uri: "spec.md" } },
      providerStore: store,
    });

    const issue = report.issues.find((candidate) => candidate.code === "runtime-unavailable");
    expect(issue?.remediation).toBe(
      `Configure one of the stage runtime providers before starting a run. Credentials are read from ${ownerPath} then ${repositoryPath}.`,
    );
  });
```

Import `FileProviderConnectionStore` from `"../../src/providers/file-store.js"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/run/preflight.test.ts -t "credential file"`
Expected: FAIL — remediation still says "Credentials are read per repository from ...".

- [ ] **Step 3: Implement `describeCredentialSources`**

`src/providers/types.ts`:

```ts
export interface ProviderConnectionStore {
  getConnection(providerId: ProviderId): Promise<ProviderConnection>;
  resolveEnv(): Promise<Record<string, string | undefined>>;
  listStatuses(): Promise<ProviderConnectionStatus[]>;
  setConnection?(input: SetConnectionInput): Promise<void>;
  clearConnection?(providerId: ProviderId): Promise<void>;
  /** Files consulted for credentials, primary first, for operator-facing messages. */
  describeCredentialSources?(): string[];
}
```

`src/providers/file-store.ts`, in `FileProviderConnectionStore` (it already keeps `this.path` and the fallback list — use whatever field names the constructor stores them under):

```ts
  describeCredentialSources(): string[] {
    return [this.path, ...this.fallbackPaths];
  }
```

`src/run/preflight.ts`: `stageIssues` (line ~385) needs the store. Add `providerStore?: ProviderConnectionStore` to its `input` type and pass `providerStore: input.providerStore` at the call inside `evaluateRunPreflight` (line ~553, the `...(await stageIssues({ repoPath, flow, statuses, requiredProviders }))` spread). Then build the remediation:

```ts
      const sources = input.providerStore?.describeCredentialSources?.() ?? [];
      const remediation = sources.length > 0
        ? `Configure one of the stage runtime providers before starting a run. Credentials are read from ${sources.join(" then ")}.`
        : `Configure one of the stage runtime providers before starting a run. Credentials are read per repository from ${
            join(input.repoPath, ".nitely", "connections.json")
          }, and a signed-in Web Console user may also hold their own under .nitely/users/.`;
```

and use `remediation` in the `issue(...)` call.

- [ ] **Step 4: Run the preflight suite**

Run: `pnpm check && pnpm exec vitest run test/run/preflight.test.ts`
Expected: PASS, including any existing test that pins the old remediation text when no store is injected (the fallback branch keeps it byte-identical).

- [ ] **Step 5: Write the cross-layer test (the one #546 asked for)**

Add to `test/web/server.test.ts`:

```ts
  it("lets a token use the provider credential its owner entered in the Console", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    const stranger = await createUser(repoPath, {
      email: "stranger@example.test",
      password: "stranger password passphrase",
      role: "admin",
    });
    const token = await createApiToken(repoPath, {
      name: "owner laptop",
      capabilities: ["tasks:read", "tasks:write", "runs:start"],
      allowHighImpact: true,
      ownerUserId: owner.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
      providerEnv: {},
    });
    const authorization = `Bearer ${token.token}`;

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          title: "Owner credential task",
          spec: "Spec body",
          techDesign: "Design body",
          flowPath: "flows/implement-spec-bootstrap-claude.json",
        }),
      }),
    )) as { task: { id: string } };
    const detail = async () =>
      (await json(
        await fetch(`${server.url}/api/tasks/${createdTask.task.id}`, {
          headers: { authorization },
        }),
      )) as { preflight: { status: string; issues: Array<{ code: string; remediation: string }> } };

    // Nobody has configured anthropic: blocked, and the message names the owner's file.
    const before = await detail();
    expect(before.preflight.status).toBe("BLOCK");
    expect(
      before.preflight.issues.find((issue) => issue.code === "runtime-unavailable")?.remediation,
    ).toContain(join(repoPath, ".nitely", "users", owner.id, "connections.json"));

    // A different user's credential is invisible to this token.
    const strangerLogin = await login(server, stranger.email, "stranger password passphrase");
    expect(
      (
        await fetch(`${server.url}/api/providers/anthropic/connection`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: strangerLogin.cookie },
          body: JSON.stringify({ value: "sk-ant-oat-stranger" }),
        })
      ).status,
    ).toBe(200);
    expect((await detail()).preflight.status).toBe("BLOCK");

    // The owner's own Console entry is what the token runs with.
    const ownerLogin = await login(server, owner.email, owner.password);
    expect(
      (
        await fetch(`${server.url}/api/providers/anthropic/connection`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerLogin.cookie },
          body: JSON.stringify({ value: "sk-ant-oat-owner" }),
        })
      ).status,
    ).toBe(200);
    const after = await detail();
    expect(after.preflight.issues.map((issue) => issue.code)).not.toContain("runtime-unavailable");
  });
```

`createRepo()` in this file writes `flows/implement-spec-bootstrap.json`; add a sibling `flows/implement-spec-bootstrap-claude.json` in that helper by copying the repository's `flows/implement-spec-bootstrap-claude.json` content, or, if `createRepo` builds its flow inline with `runtime: "codex"`, write a second copy with `runtime: "claude"` on every agent/gate stage. The `providerEnv: {}` option makes sure no `ANTHROPIC_API_KEY` from the developer's shell leaks into the assertion. If `POST /api/tasks` in this file's other tests uses a different field name for the flow (check the test at line ~505), use that name.

- [ ] **Step 6: Run it to verify it passes with Tasks 1–5 in place**

Run: `pnpm exec vitest run test/web/server.test.ts -t "owner entered"`
Expected: PASS. If the "before" assertion fails because the message lacks the owner path, the preflight in `POST/GET /api/tasks/:id` is not receiving `providerStoreForUser(...)` — trace `server.ts:3785` and pass the store through to `evaluateRunPreflight`.

- [ ] **Step 7: Run everything this plan touched**

Run: `pnpm check && pnpm exec vitest run test/web/api-tokens.test.ts test/web/users.test.ts test/web/server.test.ts test/web/flows-api.test.ts test/web/device-flow-api.test.ts test/mcp/server.test.ts test/cli.test.ts test/run/preflight.test.ts test/docs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/providers/types.ts src/providers/file-store.ts src/run/preflight.ts test/run/preflight.test.ts test/web/server.test.ts
git commit -m "feat(preflight): name the credential files consulted for a missing runtime

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Full-suite verification on the Linux box and PR

**Files:** none new.

- [ ] **Step 1: Sync and run the full suite remotely**

```bash
rsync -a --delete --exclude .git --exclude node_modules --exclude .nitely ./ jerry@100.96.111.79:/home/jerry/dev/nitely-agent-test/
ssh jerry@100.96.111.79 'export PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH; cd /home/jerry/dev/nitely-agent-test && pnpm install --frozen-lockfile && pnpm exec vitest run 2>&1 | tail -30'
```

Expected: 0 failures. A failure in a suite this plan did not touch that mints a token (search `createApiToken(` under `test/`) means Task 1 missed a call site — fix it there.

- [ ] **Step 2: Open the PR**

Branch from this worktree; title `feat(auth): owner-bound API tokens resolve the owner's provider credentials`. Body: link the spec, summarize the four behavior changes (owner required at mint, unowned tokens refused, token acts as owner incl. role, remediation names files), list the suites run, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Note in the body that existing tokens must be re-issued (`token_unowned`).
