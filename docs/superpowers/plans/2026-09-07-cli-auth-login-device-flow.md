# `nitely auth login` Device Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `nitely auth login --server <url>` obtain an API token through a browser approval (RFC 8628 device grant) and write it to `current-instance.json`, so no one has to hand-carry a token through `NITELY_API_TOKEN`.

**Architecture:** A new server-side module stores short-lived device-authorization records (one JSON file per request, addressed by user code, holding only a hash of the device code). Four HTTP surfaces sit on top: an unauthenticated authorize endpoint, a standalone approval page, a session-authenticated admin-only approve/deny endpoint, and an unauthenticated polling endpoint that mints the token at exchange time via the existing `createApiToken`. The CLI side is a protocol module with every side effect injected, wired into a new `auth` command that persists the result through the existing `writeCurrentInstance`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:crypto` / `node:fs/promises`, vitest, no new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-07-cli-auth-login-device-flow-design.md](../specs/2026-09-07-cli-auth-login-device-flow-design.md)

## Global Constraints

- **No new runtime dependencies.** Everything uses the Node standard library and what the repo already imports.
- **ESM import specifiers end in `.js`**, even for TypeScript sources — match every existing file.
- **Tests run on the Linux dev box, not macOS.** The vitest suite does not run correctly on the author's Mac; rsync the worktree over and run there. Every "run the test" step below means running it on that box.
- **Type check with `npm run check`** (`tsc --noEmit`) before each commit; the repo is strict, and `exactOptionalPropertyTypes` is why every optional field is written as `...(value ? { field: value } : {})`.
- **The four new endpoints must never be added to `apiTokenActionForRequest`.** That map is a whitelist; leaving them out is what stops an API token from minting its successor. Task 2 pins this with a test.
- **Never log, print, or store a plaintext device code or API token.** Records store SHA-256 hashes; the CLI prints the token id, never the token.
- **Protocol endpoints use RFC 8628's flat error shape** (`{"error": "authorization_pending"}`), deliberately unlike the repo's internal `{error: {code, message}}`. These are standard OAuth endpoints, and a future move to a real OIDC issuer should not change the CLI. This is an intentional, spec-approved deviation — do not "fix" it for consistency.
- **User code alphabet is `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`** — 32 characters, no `0`, `O`, `1`, `I`, or `L`. Length 8, displayed as `XXXX-XXXX`.
- **Code lifetime is 10 minutes; poll interval is 5 seconds.**

---

### Task 1: Device authorization store

The storage and code-format primitives, with no HTTP involved. Everything later builds on this.

**Files:**
- Create: `src/web/device-authorizations.ts`
- Modify: `src/web/users.ts` (export the existing private `writeJsonAtomic`)
- Test: `test/web/device-authorizations.test.ts`

**Interfaces:**
- Consumes: `ApiTokenCapability` and `API_TOKEN_CAPABILITIES` from `src/web/api-tokens.js`.
- Produces: `DeviceAuthorizationRecord`, `DEVICE_CODE_TTL_MS`, `DEVICE_POLL_INTERVAL_SECONDS`, `deviceAuthorizationsRoot`, `deviceAuthorizationPath`, `normalizeUserCode`, `formatUserCode`, `createDeviceAuthorization`, `readDeviceAuthorization`, `resolveDeviceAuthorization`, `decideDeviceAuthorization`, `recordDevicePoll`, `deleteDeviceAuthorization`.

- [ ] **Step 1: Export `writeJsonAtomic` from `users.ts`**

In `src/web/users.ts`, find `async function writeJsonAtomic(` (around line 340) and add the `export` keyword:

```ts
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
```

Change nothing else in that function.

- [ ] **Step 2: Write the failing test**

Create `test/web/device-authorizations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_CODE_TTL_MS,
  createDeviceAuthorization,
  decideDeviceAuthorization,
  deleteDeviceAuthorization,
  deviceAuthorizationPath,
  formatUserCode,
  normalizeUserCode,
  readDeviceAuthorization,
  recordDevicePoll,
  resolveDeviceAuthorization,
} from "../../src/web/device-authorizations.js";

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-device-auth-"));
}

describe("device authorizations", () => {
  it("issues a user code drawn from the unambiguous alphabet", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      clientName: "cli@dev-box",
    });

    expect(record.userCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(deviceCode.startsWith(`${record.userCode}.`)).toBe(true);
    expect(record.status).toBe("pending");
    expect(formatUserCode(record.userCode)).toBe(
      `${record.userCode.slice(0, 4)}-${record.userCode.slice(4)}`,
    );
  });

  it("stores only a hash, never the device code itself", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    const raw = await readFile(
      deviceAuthorizationPath(repoPath, record.userCode),
      "utf8",
    );
    expect(raw).not.toContain(deviceCode);
    expect(raw).not.toContain(deviceCode.split(".")[1]);
    expect(JSON.parse(raw).deviceCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes user codes typed with separators and lower case", () => {
    expect(normalizeUserCode("bdfh-jkmn")).toBe("BDFHJKMN");
    expect(normalizeUserCode("  BDFH JKMN ")).toBe("BDFHJKMN");
    expect(normalizeUserCode("BDFHJKM")).toBeUndefined();
    expect(normalizeUserCode("BDFHJKM0")).toBeUndefined();
    expect(normalizeUserCode("../../etc/passwd")).toBeUndefined();
  });

  it("resolves a device code only when the secret half matches", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    await expect(
      resolveDeviceAuthorization(repoPath, deviceCode),
    ).resolves.toMatchObject({ userCode: record.userCode });
    await expect(
      resolveDeviceAuthorization(repoPath, `${record.userCode}.wrong-secret`),
    ).resolves.toBeNull();
    await expect(
      resolveDeviceAuthorization(repoPath, "nonsense"),
    ).resolves.toBeNull();
  });

  it("records an approval with the approving user", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read", "runs:start"],
      allowHighImpact: true,
    });

    const decided = await decideDeviceAuthorization(repoPath, record.userCode, {
      decision: "approve",
      userId: "user_1",
    });

    expect(decided.status).toBe("approved");
    expect(decided.approvedByUserId).toBe("user_1");
    await expect(
      readDeviceAuthorization(repoPath, record.userCode),
    ).resolves.toMatchObject({ status: "approved", approvedByUserId: "user_1" });
  });

  it("treats an expired record as absent and deletes it", async () => {
    const repoPath = await createRepo();
    const start = new Date("2026-09-07T00:00:00.000Z");
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      now: () => start,
    });

    const afterExpiry = new Date(start.getTime() + DEVICE_CODE_TTL_MS + 1);
    await expect(
      readDeviceAuthorization(repoPath, record.userCode, { now: () => afterExpiry }),
    ).resolves.toBeNull();
    await expect(
      resolveDeviceAuthorization(repoPath, deviceCode, { now: () => afterExpiry }),
    ).resolves.toBeNull();
  });

  it("remembers the last poll so the caller can throttle", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });
    const polledAt = new Date("2026-09-07T00:00:03.000Z");

    await recordDevicePoll(repoPath, record.userCode, polledAt);

    await expect(
      readDeviceAuthorization(repoPath, record.userCode),
    ).resolves.toMatchObject({ lastPolledAt: polledAt.toISOString() });
  });

  it("deletes a record so a device code is single-use", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    await deleteDeviceAuthorization(repoPath, record.userCode);

    await expect(resolveDeviceAuthorization(repoPath, deviceCode)).resolves.toBeNull();
  });

  it("rejects unknown capabilities and empty capability lists", async () => {
    const repoPath = await createRepo();
    await expect(
      createDeviceAuthorization(repoPath, { capabilities: [] }),
    ).rejects.toThrow("at least one capability is required");
    await expect(
      createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:destroy" as never],
      }),
    ).rejects.toThrow("unknown API token capability: tasks:destroy");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/web/device-authorizations.test.ts`
Expected: FAIL — cannot resolve `../../src/web/device-authorizations.js`.

- [ ] **Step 4: Write the implementation**

Create `src/web/device-authorizations.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  API_TOKEN_CAPABILITIES,
  type ApiTokenCapability,
} from "./api-tokens.js";
import { writeJsonAtomic } from "./users.js";

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_LENGTH = 8;
const DEFAULT_CLIENT_NAME = "nitely cli";
const MAX_CODE_ALLOCATION_ATTEMPTS = 5;

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied";

export interface DeviceAuthorizationRecord {
  version: 1;
  userCode: string;
  deviceCodeHash: string;
  status: DeviceAuthorizationStatus;
  capabilities: ApiTokenCapability[];
  allowHighImpact: boolean;
  clientName: string;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  lastPolledAt?: string;
  approvedByUserId?: string;
}

export interface CreateDeviceAuthorizationInput {
  capabilities: ApiTokenCapability[];
  allowHighImpact?: boolean;
  clientName?: string;
  now?: () => Date;
}

export interface DecideDeviceAuthorizationInput {
  decision: "approve" | "deny";
  userId: string;
  now?: () => Date;
}

export interface ReadDeviceAuthorizationOptions {
  now?: () => Date;
}

export function deviceAuthorizationsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "device-authorizations");
}

export function deviceAuthorizationPath(
  repoPath: string,
  userCode: string,
): string {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) throw new Error("invalid user code");
  return join(deviceAuthorizationsRoot(repoPath), `${normalized}.json`);
}

export function normalizeUserCode(value: string): string | undefined {
  const compact = value.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  if (compact.length !== USER_CODE_LENGTH) return undefined;
  for (const character of compact) {
    if (!USER_CODE_ALPHABET.includes(character)) return undefined;
  }
  return compact;
}

export function formatUserCode(userCode: string): string {
  return `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
}

function randomUserCode(): string {
  // Rejection-free because 256 is a whole multiple of the 32-character alphabet.
  return [...randomBytes(USER_CODE_LENGTH)]
    .map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length])
    .join("");
}

function deviceCodeHash(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

function userCodeFromDeviceCode(deviceCode: string): string | undefined {
  const [head, secret] = deviceCode.split(".");
  if (!head || !secret) return undefined;
  return normalizeUserCode(head);
}

function normalizeCapabilities(
  capabilities: ApiTokenCapability[],
): ApiTokenCapability[] {
  for (const capability of capabilities) {
    if (!API_TOKEN_CAPABILITIES.includes(capability)) {
      throw new Error(`unknown API token capability: ${String(capability)}`);
    }
  }
  const unique = [...new Set(capabilities)];
  if (unique.length === 0) {
    throw new Error("at least one capability is required");
  }
  return unique;
}

function normalizeClientName(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_CLIENT_NAME;
  if (trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("client name must be 1-80 printable characters");
  }
  return trimmed;
}

function isExpired(record: DeviceAuthorizationRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

export async function createDeviceAuthorization(
  repoPath: string,
  input: CreateDeviceAuthorizationInput,
): Promise<{ deviceCode: string; record: DeviceAuthorizationRecord }> {
  const capabilities = normalizeCapabilities(input.capabilities);
  const clientName = normalizeClientName(input.clientName);
  const now = (input.now ?? (() => new Date()))();

  for (let attempt = 0; attempt < MAX_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const userCode = randomUserCode();
    // A live record under this code means a collision; try another.
    if (await readDeviceAuthorization(repoPath, userCode, { now: () => now })) {
      continue;
    }
    const deviceCode = `${userCode}.${randomBytes(32).toString("base64url")}`;
    const record: DeviceAuthorizationRecord = {
      version: 1,
      userCode,
      deviceCodeHash: deviceCodeHash(deviceCode),
      status: "pending",
      capabilities,
      allowHighImpact: input.allowHighImpact ?? false,
      clientName,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS).toISOString(),
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    };
    await writeJsonAtomic(deviceAuthorizationPath(repoPath, userCode), record);
    return { deviceCode, record };
  }
  throw new Error("could not allocate a device authorization code");
}

export async function readDeviceAuthorization(
  repoPath: string,
  userCode: string,
  options: ReadDeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationRecord | null> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  let record: DeviceAuthorizationRecord;
  try {
    record = JSON.parse(
      await readFile(deviceAuthorizationPath(repoPath, normalized), "utf8"),
    ) as DeviceAuthorizationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const now = (options.now ?? (() => new Date()))();
  if (isExpired(record, now)) {
    await deleteDeviceAuthorization(repoPath, normalized).catch(() => {});
    return null;
  }
  return record;
}

export async function resolveDeviceAuthorization(
  repoPath: string,
  deviceCode: string,
  options: ReadDeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationRecord | null> {
  const userCode = userCodeFromDeviceCode(deviceCode);
  if (!userCode) return null;
  const record = await readDeviceAuthorization(repoPath, userCode, options);
  if (!record) return null;
  const actual = Buffer.from(record.deviceCodeHash, "hex");
  const expected = Buffer.from(deviceCodeHash(deviceCode), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? record
    : null;
}

export async function decideDeviceAuthorization(
  repoPath: string,
  userCode: string,
  input: DecideDeviceAuthorizationInput,
): Promise<DeviceAuthorizationRecord> {
  const record = await readDeviceAuthorization(repoPath, userCode, {
    ...(input.now ? { now: input.now } : {}),
  });
  if (!record) throw new Error("device authorization not found");
  if (record.status !== "pending") {
    throw new Error("device authorization already decided");
  }
  const decided: DeviceAuthorizationRecord = {
    ...record,
    status: input.decision === "approve" ? "approved" : "denied",
    approvedByUserId: input.userId,
  };
  await writeJsonAtomic(
    deviceAuthorizationPath(repoPath, record.userCode),
    decided,
  );
  return decided;
}

export async function recordDevicePoll(
  repoPath: string,
  userCode: string,
  polledAt: Date,
): Promise<void> {
  const record = await readDeviceAuthorization(repoPath, userCode, {
    now: () => polledAt,
  });
  if (!record) return;
  await writeJsonAtomic(deviceAuthorizationPath(repoPath, record.userCode), {
    ...record,
    lastPolledAt: polledAt.toISOString(),
  } satisfies DeviceAuthorizationRecord);
}

export async function deleteDeviceAuthorization(
  repoPath: string,
  userCode: string,
): Promise<void> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return;
  await rm(deviceAuthorizationPath(repoPath, normalized), { force: true });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/web/device-authorizations.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Type check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/device-authorizations.ts src/web/users.ts test/web/device-authorizations.test.ts
git commit -m "feat(web): add the device authorization store

Records live 10 minutes, are addressed by their user code, and hold only
a SHA-256 of the device code. The user code is embedded in the device
code so a record is addressable by filename while the secret half stays
unguessable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Authorize and poll endpoints

The two endpoints the CLI talks to. Neither is authenticated — the caller has no credential yet, by definition — so both are rate limited, and an unapproved record grants nothing.

**Files:**
- Modify: `src/web/server.ts` (imports; `handleApiRequest`, after the `/api/session` block around line 6193)
- Test: `test/web/device-flow-api.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced; `createApiToken` from `./api-tokens.js`; `LoginAttemptLimiter` from `./login-throttle.js`; `appendSecurityAuditBestEffort` (already defined in `server.ts`).
- Produces: `POST /api/device-authorization` and `POST /api/device-token`, plus a module-level `deviceAuthorizationLimiter`.

- [ ] **Step 1: Write the failing test**

Create `test/web/device-flow-api.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWebServer, type WebServer } from "../../src/web/server.js";
import {
  decideDeviceAuthorization,
  normalizeUserCode,
} from "../../src/web/device-authorizations.js";
import { createApiToken } from "../../src/web/api-tokens.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-device-flow-"));
}

async function startTestServer(
  repoPath: string,
  options: Partial<Parameters<typeof startWebServer>[0]> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    authMode: "required",
    authEnv: {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "admin password passphrase",
    },
    ...options,
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function authorize(server: WebServer, body: unknown = {
  capabilities: ["tasks:read"],
  clientName: "cli@dev-box",
}) {
  const response = await fetch(`${server.url}/api/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await json(response) };
}

async function exchange(server: WebServer, deviceCode: string) {
  const response = await fetch(`${server.url}/api/device-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  return { response, body: await json(response) };
}

describe("device flow protocol endpoints", () => {
  it("issues codes with a verification URI that prefills the user code", async () => {
    const server = await startTestServer(await createRepo());

    const { response, body } = await authorize(server);

    expect(response.status).toBe(200);
    expect(String(body.user_code)).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    expect(body.verification_uri).toBe(`${server.url}/device`);
    expect(body.verification_uri_complete).toBe(
      `${server.url}/device?code=${body.user_code}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
    expect(String(body.device_code)).toContain(".");
  });

  it("rejects an authorize request with no capabilities", async () => {
    const server = await startTestServer(await createRepo());

    const { response } = await authorize(server, { capabilities: [] });

    expect(response.status).toBe(400);
  });

  it("reports authorization_pending until a decision is recorded", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);

    const pending = await exchange(server, String(body.device_code));

    expect(pending.response.status).toBe(400);
    expect(pending.body).toEqual({ error: "authorization_pending" });
  });

  it("mints a working token once approved, exactly once", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server, {
      capabilities: ["tasks:read"],
      clientName: "cli@dev-box",
    });
    const userCode = normalizeUserCode(String(body.user_code));
    await decideDeviceAuthorization(repoPath, userCode as string, {
      decision: "approve",
      userId: "user_1",
    });

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.name).toBe("cli@dev-box");
    expect(exchanged.body.capabilities).toEqual(["tasks:read"]);

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${String(exchanged.body.access_token)}` },
    });
    expect(listed.status).toBe(200);

    const replay = await exchange(server, String(body.device_code));
    expect(replay.body).toEqual({ error: "expired_token" });
  });

  it("reports access_denied when the request was refused", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    await decideDeviceAuthorization(repoPath, normalizeUserCode(String(body.user_code)) as string, {
      decision: "deny",
      userId: "user_1",
    });

    const denied = await exchange(server, String(body.device_code));

    expect(denied.body).toEqual({ error: "access_denied" });
  });

  it("reports expired_token for an unknown or malformed device code", async () => {
    const server = await startTestServer(await createRepo());

    expect((await exchange(server, "BDFHJKMN.nope")).body).toEqual({
      error: "expired_token",
    });
    expect((await exchange(server, "garbage")).body).toEqual({
      error: "expired_token",
    });
  });

  it("asks a fast poller to slow down", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);

    await exchange(server, String(body.device_code));
    const second = await exchange(server, String(body.device_code));

    expect(second.body).toEqual({ error: "slow_down" });
  });

  it("refuses the flow in local auth mode, where nobody can approve", async () => {
    const server = await startTestServer(await createRepo(), {
      authMode: "local",
      authEnv: {},
    });

    const { response, body } = await authorize(server);

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "device_flow_unavailable" });
  });

  it("keeps API tokens out of both endpoints", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = await createApiToken(repoPath, {
      name: "reader",
      capabilities: ["tasks:read"],
    });

    for (const path of ["/api/device-authorization", "/api/device-token"]) {
      const response = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.token}`,
        },
        body: JSON.stringify({ capabilities: ["tasks:read"], device_code: "x.y" }),
      });
      expect(response.status).toBe(403);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/device-flow-api.test.ts`
Expected: FAIL — the authorize endpoint 404s, because `handleApiRequest` falls through to `throw new WebNotFoundError("endpoint not found")`.

- [ ] **Step 3: Add the imports**

In `src/web/server.ts`, beside the existing `./api-tokens.js` import block (around line 146), add:

```ts
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  createDeviceAuthorization,
  deleteDeviceAuthorization,
  formatUserCode,
  recordDevicePoll,
  resolveDeviceAuthorization,
} from "./device-authorizations.js";
import type { ApiTokenCapability } from "./api-tokens.js";
```

`createApiToken`, `API_TOKEN_CAPABILITIES`, and `LoginAttemptLimiter` are already imported.

- [ ] **Step 4: Add the shared limiter and a response helper**

In `src/web/server.ts`, next to the `authorizedApiTokenRequests` WeakMap declaration (around line 437), add:

```ts
/**
 * The device-flow endpoints take no credential, so the only thing standing
 * between them and an unattended script is the caller's address.
 */
const deviceAuthorizationLimiter = new LoginAttemptLimiter({
  maxFailures: 20,
  windowMs: 60_000,
});

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

/** RFC 8628 uses a flat error body; the CLI state machine reads `error`. */
function sendDeviceFlowError(
  response: ServerResponse,
  status: number,
  error: string,
): void {
  sendJson(response, status, { error });
}
```

- [ ] **Step 5: Add both endpoints**

In `handleApiRequest`, immediately after the `DELETE /api/session` block ends (around line 6210), insert:

```ts
  if (request.method === "POST" && url.pathname === "/api/device-authorization") {
    if (authMode === "local") {
      sendDeviceFlowError(response, 409, "device_flow_unavailable");
      return true;
    }
    if (!(await hasAnyUsers(homeRepoPath))) {
      throw new WebSetupRequiredError();
    }
    const address = clientAddress(request);
    const attempt = deviceAuthorizationLimiter.check(address);
    if (!attempt.allowed) {
      sendJsonWithHeaders(
        response,
        429,
        { error: "slow_down" },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }
    deviceAuthorizationLimiter.recordFailure(address);

    const body = requireObject(await readRequestJson(request));
    const requested = Array.isArray(body.capabilities) ? body.capabilities : [];
    for (const capability of requested) {
      if (
        typeof capability !== "string" ||
        !(API_TOKEN_CAPABILITIES as readonly string[]).includes(capability)
      ) {
        throw new WebInputError(`unknown API token capability: ${String(capability)}`);
      }
    }
    if (requested.length === 0) {
      throw new WebInputError("at least one capability is required");
    }

    const { deviceCode, record } = await createDeviceAuthorization(homeRepoPath, {
      capabilities: requested as ApiTokenCapability[],
      allowHighImpact: body.allowHighImpact === true,
      ...(typeof body.clientName === "string" ? { clientName: body.clientName } : {}),
    });
    const displayCode = formatUserCode(record.userCode);
    const base = publicServerUrl(input);

    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.device.authorize",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: { type: "anonymous" },
    });

    sendJson(response, 200, {
      device_code: deviceCode,
      user_code: displayCode,
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${displayCode}`,
      expires_in: Math.round(
        (new Date(record.expiresAt).getTime() -
          new Date(record.createdAt).getTime()) / 1000,
      ),
      interval: record.intervalSeconds,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/device-token") {
    if (authMode === "local") {
      sendDeviceFlowError(response, 409, "device_flow_unavailable");
      return true;
    }
    const body = requireObject(await readRequestJson(request));
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const record = await resolveDeviceAuthorization(homeRepoPath, deviceCode);
    if (!record) {
      sendDeviceFlowError(response, 400, "expired_token");
      return true;
    }

    const now = new Date();
    if (record.lastPolledAt) {
      const sinceLastPoll = now.getTime() - new Date(record.lastPolledAt).getTime();
      if (sinceLastPoll < record.intervalSeconds * 1000) {
        await recordDevicePoll(homeRepoPath, record.userCode, now);
        sendDeviceFlowError(response, 400, "slow_down");
        return true;
      }
    }
    await recordDevicePoll(homeRepoPath, record.userCode, now);

    if (record.status === "denied") {
      await deleteDeviceAuthorization(homeRepoPath, record.userCode);
      sendDeviceFlowError(response, 400, "access_denied");
      return true;
    }
    if (record.status === "pending") {
      sendDeviceFlowError(response, 400, "authorization_pending");
      return true;
    }

    // Minted here, not at approval, so no plaintext token ever rests on disk.
    const created = await createApiToken(homeRepoPath, {
      name: record.clientName,
      capabilities: record.capabilities,
      allowHighImpact: record.allowHighImpact,
    });
    await deleteDeviceAuthorization(homeRepoPath, record.userCode);
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: "auth.device.exchange",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: { type: "api-token" },
    });

    sendJson(response, 200, {
      access_token: created.token,
      token_id: created.record.id,
      name: created.record.name,
      capabilities: created.record.capabilities,
    });
    return true;
  }
```

- [ ] **Step 6: Add the `publicServerUrl` helper**

The verification URI has to be absolute, and it must carry the port the client
actually reached — **not** `input.port`, which is `0` whenever the server was
told to pick a port (as every test does; `server.url` is built from
`server.address().port` at line 9471, not from the input). The request's `Host`
header is the only thing in `handleApiRequest` that knows the real answer, and
it has the added benefit of being correct behind a reverse proxy.

Beside `clientAddress` from Step 4, add:

```ts
/**
 * The base URL the operator's browser should use. The Host header is what the
 * client actually dialed — `input.port` is 0 whenever the server chose its own
 * port, and it knows nothing about a proxy in front.
 *
 * Host is client-controlled, so this is only ever echoed back to that same
 * client for them to open. Never reuse it for a redirect, an email, or
 * anything a third party will follow.
 */
function publicServerUrl(request: IncomingMessage): string {
  const host = requestHeader(request, "host") ?? "127.0.0.1";
  const forwardedProtocol = requestHeader(request, "x-forwarded-proto");
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}
```

Then in Step 5's authorize block, `const base = publicServerUrl(input);` becomes
`const base = publicServerUrl(request);`.

`requestHeader` is already defined in `server.ts` (it is used for the GitHub
webhook headers).

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/web/device-flow-api.test.ts`
Expected: PASS, 9 tests.

The "keeps API tokens out of both endpoints" case should pass without any new code: `prepareApiTokenRequest` returns `endpoint_not_allowed` for paths absent from `apiTokenActionForRequest`. If it fails, do **not** add the paths to that map — investigate why the bearer path is not rejecting.

- [ ] **Step 8: Run the neighbouring suites and type check**

Run: `npx vitest run test/web/server.test.ts test/web/api-tokens.test.ts && npm run check`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/web/server.ts test/web/device-flow-api.test.ts
git commit -m "feat(web): add device authorize and token endpoints

The token is minted at exchange time rather than at approval, so no
plaintext token rests in the pending record. Neither path is added to
apiTokenActionForRequest, so an API token calling them is rejected as
endpoint_not_allowed and cannot mint its own successor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Admin-only approval endpoint

Where the operator's decision enters the system. Restricted to `role: "admin"` because API tokens are still unowned and resolve to a synthetic admin user.

**Files:**
- Modify: `src/web/server.ts` (`handleApiRequest`, after the Task 2 blocks)
- Test: `test/web/device-flow-api.test.ts` (extend)

**Interfaces:**
- Consumes: `decideDeviceAuthorization`, `readDeviceAuthorization`, `normalizeUserCode` from Task 1; `resolveUserContext` and `securityAuditActorForUser` (already in `server.ts`).
- Produces: `POST /api/device-authorizations/approve`.

- [ ] **Step 1: Write the failing test**

Append to `test/web/device-flow-api.test.ts`, inside the existing `describe` block. Add `createUser` to the imports at the top of the file:

```ts
import { createUser } from "../../src/web/users.js";
```

```ts
  async function login(server: WebServer, email: string, password: string) {
    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  async function decide(
    server: WebServer,
    cookie: string,
    userCode: string,
    decision: "approve" | "deny",
  ) {
    const response = await fetch(`${server.url}/api/device-authorizations/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ userCode, decision }),
    });
    return { response, body: await json(response) };
  }

  it("lets an admin approve, which unblocks the exchange", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const decided = await decide(server, cookie, String(body.user_code), "approve");
    expect(decided.response.status).toBe(200);
    expect(decided.body).toMatchObject({ status: "approved" });

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(200);
    expect(typeof exchanged.body.access_token).toBe("string");
  });

  it("refuses approval from a non-admin session", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const { body } = await authorize(server);
    const cookie = await login(server, "member@example.test", "member password passphrase");

    const decided = await decide(server, cookie, String(body.user_code), "approve");

    expect(decided.response.status).toBe(403);
    expect((await exchange(server, String(body.device_code))).body).toEqual({
      error: "authorization_pending",
    });
  });

  it("refuses approval with no session at all", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);

    const decided = await decide(server, "", String(body.user_code), "approve");

    expect(decided.response.status).toBe(401);
  });

  it("throttles user-code guessing from an authenticated seat", async () => {
    const server = await startTestServer(await createRepo(), {
      loginRateLimit: { maxFailures: 3, windowMs: 60_000 },
    });
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const guess = await decide(server, cookie, "BDFH-JKMN", "approve");
      statuses.push(guess.response.status);
    }

    expect(statuses).toContain(429);
  });

  it("rejects a second decision on the same request", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    await decide(server, cookie, String(body.user_code), "approve");
    const second = await decide(server, cookie, String(body.user_code), "deny");

    expect(second.response.status).toBe(400);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/device-flow-api.test.ts`
Expected: FAIL — the approve endpoint 404s.

- [ ] **Step 3: Add the endpoint**

In `src/web/server.ts`, after the `/api/device-token` block from Task 2, insert:

```ts
  if (
    request.method === "POST" &&
    url.pathname === "/api/device-authorizations/approve"
  ) {
    const actor = await resolveUserContext(request, input, homeRepoPath);
    if (!actor) throw new WebUnauthorizedError();
    if (actor.role !== "admin") {
      // API tokens are unowned and resolve to a synthetic admin, so a token
      // issued here would outrank its requester. Admins only, until tokens
      // carry a userId.
      throw new WebForbiddenError(
        "only an admin can approve a device authorization",
      );
    }

    const body = requireObject(await readRequestJson(request));
    const decision = body.decision === "deny" ? "deny" : "approve";
    const userCode = normalizeUserCode(
      typeof body.userCode === "string" ? body.userCode : "",
    );

    const throttleSubject = `device-approve:${actor.id}`;
    const attempt = loginAttemptLimiter.check(throttleSubject);
    if (!attempt.allowed) {
      sendJsonWithHeaders(
        response,
        429,
        { error: { code: "too_many_attempts", message: "too many attempts; try again later" } },
        { "retry-after": String(attempt.retryAfterSeconds) },
      );
      return true;
    }

    const record = userCode
      ? await readDeviceAuthorization(homeRepoPath, userCode)
      : null;
    if (!record) {
      loginAttemptLimiter.recordFailure(throttleSubject);
      await appendSecurityAuditBestEffort(homeRepoPath, {
        action: "auth.device.approve",
        decision: "deny",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
        actor: securityAuditActorForUser(actor),
      });
      throw new WebNotFoundError("device authorization not found");
    }
    if (record.status !== "pending") {
      throw new WebInputError("device authorization already decided");
    }
    loginAttemptLimiter.clear(throttleSubject);

    const decided = await decideDeviceAuthorization(homeRepoPath, record.userCode, {
      decision,
      userId: actor.id,
    });
    await appendSecurityAuditBestEffort(homeRepoPath, {
      action: decision === "approve" ? "auth.device.approve" : "auth.device.deny",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: securityAuditActorForUser(actor),
    });

    sendJson(response, 200, {
      status: decided.status,
      clientName: decided.clientName,
      capabilities: decided.capabilities,
    });
    return true;
  }
```

Also extend the Task 2 import block with `decideDeviceAuthorization`, `readDeviceAuthorization`, and `normalizeUserCode`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/web/device-flow-api.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Type check and commit**

```bash
npm run check
git add src/web/server.ts test/web/device-flow-api.test.ts
git commit -m "feat(web): add the admin-only device approval endpoint

Approval is restricted to role: admin because API tokens are unowned and
resolve to a synthetic admin user, so a token approved by a lesser role
would outrank its requester. User-code guesses are throttled per acting
user, and approvedByUserId is recorded for the eventual migration to
user-bound tokens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The approval page

A standalone page, deliberately not a route in the 6,612-line console SPA: this is the security-critical surface of the feature and should be reviewable on its own.

**Files:**
- Create: `src/web/static/device.html`
- Modify: `src/web/server.ts` (`handleHtmlRequest`, around line 9166)
- Test: `test/web/device-page.test.ts`

**Interfaces:**
- Consumes: `GET /api/session` (existing) and `POST /api/device-authorizations/approve` (Task 3).
- Produces: `GET /device`.

- [ ] **Step 1: Write the failing test**

Create `test/web/device-page.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWebServer, type WebServer } from "../../src/web/server.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("device approval page", () => {
  it("serves a standalone approval page, not the console shell", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-device-page-"));
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
    });
    servers.push(server);

    const response = await fetch(`${server.url}/device`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Authorize a device");
    expect(html).toContain("/api/device-authorizations/approve");
    // The console shell must not be what answers this route.
    expect(html).not.toContain("work-items");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/device-page.test.ts`
Expected: FAIL — `/device` is not in the HTML route whitelist, so `handleHtmlRequest` returns false and the request 404s.

- [ ] **Step 3: Create the page**

Create `src/web/static/device.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize a device — Nitely</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; background: #f6f7f9; color: #14161a; }
  @media (prefers-color-scheme: dark) { body { background: #101215; color: #e8eaed; } }
  main { width: min(28rem, 92vw); padding: 1.75rem; border-radius: 12px; background: #fff;
         box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  @media (prefers-color-scheme: dark) { main { background: #1a1d21; } }
  h1 { margin: 0 0 .25rem; font-size: 1.15rem; }
  p { margin: .5rem 0; }
  .muted { opacity: .7; font-size: .9em; }
  code { font-family: ui-monospace, monospace; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; font: inherit;
          font-family: ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase;
          border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: transparent; color: inherit; }
  .row { display: flex; gap: .6rem; margin-top: 1rem; }
  button { flex: 1; padding: .6rem 1rem; font: inherit; border-radius: 8px; cursor: pointer;
           border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; }
  button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
  button[disabled] { opacity: .5; cursor: default; }
  ul { margin: .5rem 0; padding-left: 1.2rem; }
  .status { margin-top: 1rem; padding: .7rem .8rem; border-radius: 8px; background: rgba(128,128,128,.12); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Authorize a device</h1>
  <p class="muted">A command line client is asking for an API token for this server.</p>

  <div id="signed-out" hidden>
    <div class="status">You need to sign in as an administrator before you can approve this request.</div>
    <div class="row"><a class="primary" href="/" style="flex:1;text-align:center;padding:.6rem 1rem;border-radius:8px;background:#2f6feb;color:#fff;text-decoration:none;">Sign in</a></div>
  </div>

  <div id="not-admin" hidden>
    <div class="status">Only an administrator can approve a device. You are signed in as <span id="who"></span>.</div>
  </div>

  <form id="form" hidden>
    <p><label for="code">Enter the code shown in your terminal</label></p>
    <input id="code" name="code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX" maxlength="9" required>
    <div class="row">
      <button type="button" id="deny">Deny</button>
      <button type="submit" class="primary" id="approve">Approve</button>
    </div>
  </form>

  <div id="status" class="status" hidden></div>
</main>
<script>
(function () {
  var form = document.getElementById("form");
  var input = document.getElementById("code");
  var status = document.getElementById("status");
  var approve = document.getElementById("approve");
  var deny = document.getElementById("deny");

  input.value = new URLSearchParams(location.search).get("code") || "";

  function show(element) { element.hidden = false; }
  function say(message) { status.textContent = message; status.hidden = false; }

  fetch("/api/session", { headers: { accept: "application/json" } })
    .then(function (response) { return response.json(); })
    .then(function (session) {
      if (!session.user) { show(document.getElementById("signed-out")); return; }
      if (session.user.role !== "admin") {
        document.getElementById("who").textContent = session.user.email;
        show(document.getElementById("not-admin"));
        return;
      }
      show(form);
    })
    .catch(function () { say("Could not reach the server."); });

  function decide(decision) {
    approve.disabled = true;
    deny.disabled = true;
    fetch("/api/device-authorizations/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: input.value, decision: decision })
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok) {
          var error = result.body && result.body.error;
          say((error && error.message) || "That code was not accepted.");
          approve.disabled = false;
          deny.disabled = false;
          return;
        }
        form.hidden = true;
        say(result.body.status === "approved"
          ? "Approved. Your terminal will pick up the token in a few seconds."
          : "Denied. Nothing was issued.");
      })
      .catch(function () {
        say("Could not reach the server.");
        approve.disabled = false;
        deny.disabled = false;
      });
  }

  form.addEventListener("submit", function (event) { event.preventDefault(); decide("approve"); });
  deny.addEventListener("click", function () { decide("deny"); });
})();
</script>
</body>
</html>
```

- [ ] **Step 4: Route `/device` to it**

In `handleHtmlRequest` in `src/web/server.ts`, directly after the `/support.js` block (around line 9168), add:

```ts
  // A standalone page, not a console SPA route: this is the approval surface.
  if (url.pathname === "/device") {
    return serveStaticFile(response, "device.html");
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/web/device-page.test.ts test/web/console-static.test.ts`
Expected: PASS. `console-static.test.ts` is included because it asserts on the contents of the static directory; if it now fails, update its expectations to include `device.html`.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/device.html src/web/server.ts test/web/device-page.test.ts
git commit -m "feat(web): add the standalone device approval page

Kept out of the console SPA on purpose: this is the security-critical
surface of the device flow, and it should be reviewable without reading
the 6,612-line shell.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI protocol module

The polling state machine, with every side effect injected so the tests touch no network, clock, or browser.

**Files:**
- Create: `src/cli/auth-device.ts`
- Test: `test/cli/auth-device.test.ts`

**Interfaces:**
- Consumes: `FetchFunction` from `./io.js`; `normalizeRemoteServerUrl` from `../cli-current-instance.js`.
- Produces: `DeviceAuthorizationResponse`, `DeviceFlowDeps`, `requestDeviceAuthorization`, `pollForDeviceToken`, `openBrowser`, `DeviceFlowError`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/auth-device.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
  openBrowser,
  pollForDeviceToken,
  requestDeviceAuthorization,
} from "../../src/cli/auth-device.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CLI device flow", () => {
  it("requests codes and returns what the operator needs to see", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        device_code: "BDFHJKMN.secret",
        user_code: "BDFH-JKMN",
        verification_uri: "http://127.0.0.1:7777/device",
        verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
        expires_in: 600,
        interval: 5,
      }),
    );

    const authorization = await requestDeviceAuthorization(
      {
        serverUrl: "http://127.0.0.1:7777",
        capabilities: ["tasks:read"],
        allowHighImpact: false,
        clientName: "cli@dev-box",
      },
      { fetchImpl },
    );

    expect(authorization.userCode).toBe("BDFH-JKMN");
    expect(authorization.interval).toBe(5);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/api/device-authorization");
    expect(JSON.parse(String(init.body))).toEqual({
      capabilities: ["tasks:read"],
      allowHighImpact: false,
      clientName: "cli@dev-box",
    });
  });

  it("explains a server that does not offer the flow", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: "device_flow_unavailable" }),
    );

    await expect(
      requestDeviceAuthorization(
        {
          serverUrl: "http://127.0.0.1:7777",
          capabilities: ["tasks:read"],
          allowHighImpact: false,
          clientName: "cli",
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/does not offer browser sign-in/);
  });

  it("waits the interval, then returns the token once approved", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "nitely_api_abc_def",
          token_id: "tok_abc",
          name: "cli@dev-box",
          capabilities: ["tasks:read"],
        }),
      );

    const result = await pollForDeviceToken(
      {
        serverUrl: "http://127.0.0.1:7777",
        deviceCode: "BDFHJKMN.secret",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      },
      {
        fetchImpl,
        sleep: async (ms) => { slept.push(ms); },
        now: () => 0,
      },
    );

    expect(result.accessToken).toBe("nitely_api_abc_def");
    expect(result.tokenId).toBe("tok_abc");
    // RFC 8628: wait before the first poll, not after it.
    expect(slept).toEqual([5000, 5000]);
  });

  it("backs off when the server says slow_down", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "slow_down" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "t",
          token_id: "tok_1",
          name: "cli",
          capabilities: ["tasks:read"],
        }),
      );

    await pollForDeviceToken(
      {
        serverUrl: "http://127.0.0.1:7777",
        deviceCode: "BDFHJKMN.secret",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      },
      { fetchImpl, sleep: async (ms) => { slept.push(ms); }, now: () => 0 },
    );

    expect(slept).toEqual([5000, 10000]);
  });

  it("surfaces a denial and an expiry distinctly", async () => {
    const denied = vi.fn(async () => jsonResponse(400, { error: "access_denied" }));
    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 1, expiresInSeconds: 60 },
        { fetchImpl: denied, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow(/denied in the browser/);

    const expired = vi.fn(async () => jsonResponse(400, { error: "expired_token" }));
    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 1, expiresInSeconds: 60 },
        { fetchImpl: expired, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("gives up once the code's lifetime has passed", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: "authorization_pending" }),
    );

    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 5, expiresInSeconds: 10 },
        {
          fetchImpl,
          sleep: async (ms) => { clock += ms; },
          now: () => clock,
        },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("treats a browser that will not launch as a non-failure", () => {
    const spawnImpl = vi.fn(() => { throw new Error("ENOENT"); });

    expect(openBrowser("http://x", { spawnImpl: spawnImpl as never, platform: "linux" }))
      .toBe(false);
  });

  it("uses the platform's opener", () => {
    const child = { on() {}, unref() {} };
    const spawnImpl = vi.fn(() => child);

    openBrowser("http://x", { spawnImpl: spawnImpl as never, platform: "darwin" });

    expect(spawnImpl.mock.calls[0][0]).toBe("open");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli/auth-device.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/auth-device.js`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/auth-device.ts`:

```ts
/**
 * The client half of the RFC 8628 device grant. Every side effect — the
 * network, the clock, the wait, the browser — is injected, so the state
 * machine is testable without any of them.
 */
import { spawn } from "node:child_process";

import { normalizeRemoteServerUrl } from "../cli-current-instance.js";
import type { FetchFunction } from "./io.js";

const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** However long the server says the code lives, nobody waits longer than this. */
const MAX_LIFETIME_MS = 15 * 60_000;

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResult {
  accessToken: string;
  tokenId: string;
  name: string;
  capabilities: string[];
}

export interface DeviceFlowDeps {
  fetchImpl?: FetchFunction;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCode(payload: unknown): string {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
}

export async function requestDeviceAuthorization(
  input: {
    serverUrl: string;
    capabilities: string[];
    allowHighImpact: boolean;
    clientName: string;
  },
  deps: DeviceFlowDeps = {},
): Promise<DeviceAuthorizationResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const response = await fetchImpl(`${serverUrl}/api/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      capabilities: input.capabilities,
      allowHighImpact: input.allowHighImpact,
      clientName: input.clientName,
    }),
  });
  const payload = await readJson(response);

  if (response.status === 409 || errorCode(payload) === "device_flow_unavailable") {
    throw new DeviceFlowError(
      `${serverUrl} does not offer browser sign-in (the server runs with --auth local). ` +
        "Create a token with nitely mcp token create and use nitely connect instead.",
    );
  }
  if (!response.ok || !isRecord(payload) || typeof payload.device_code !== "string") {
    const detail = isRecord(payload) && payload.error
      ? String(isRecord(payload.error) ? JSON.stringify(payload.error) : payload.error)
      : `HTTP ${response.status}`;
    throw new DeviceFlowError(`Could not start browser sign-in: ${detail}`);
  }

  const verificationUri = String(payload.verification_uri ?? `${serverUrl}/device`);
  return {
    deviceCode: payload.device_code,
    userCode: String(payload.user_code ?? ""),
    verificationUri,
    verificationUriComplete: String(
      payload.verification_uri_complete ?? verificationUri,
    ),
    expiresIn: Number(payload.expires_in ?? 600),
    interval: Number(payload.interval ?? 5),
  };
}

export async function pollForDeviceToken(
  input: {
    serverUrl: string;
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  },
  deps: DeviceFlowDeps = {},
): Promise<DeviceTokenResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep
    ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const now = deps.now ?? Date.now;
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const startedAt = now();
  const lifetimeMs = Math.min(input.expiresInSeconds * 1000, MAX_LIFETIME_MS);
  let intervalSeconds = input.intervalSeconds || 5;

  while (now() - startedAt < lifetimeMs) {
    // RFC 8628: wait the interval before the request, not after it.
    await sleep(intervalSeconds * 1000);
    const response = await fetchImpl(`${serverUrl}/api/device-token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_code: input.deviceCode }),
    });
    const payload = await readJson(response);

    if (response.ok && isRecord(payload) && typeof payload.access_token === "string") {
      return {
        accessToken: payload.access_token,
        tokenId: String(payload.token_id ?? ""),
        name: String(payload.name ?? ""),
        capabilities: Array.isArray(payload.capabilities)
          ? payload.capabilities.map((capability) => String(capability))
          : [],
      };
    }

    const error = errorCode(payload);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }
    if (error === "access_denied") {
      throw new DeviceFlowError("Sign-in was denied in the browser.");
    }
    if (error === "expired_token") {
      throw new DeviceFlowError(
        "The sign-in request expired. Run nitely auth login again.",
      );
    }
    throw new DeviceFlowError(
      error
        ? `Browser sign-in failed: ${error}`
        : `Browser sign-in failed with HTTP ${response.status}`,
    );
  }

  throw new DeviceFlowError(
    "The sign-in request expired before it was approved. Run nitely auth login again.",
  );
}

function openerFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "start";
  return "xdg-open";
}

/**
 * Best effort by design. A headless box has no browser, and that is not a
 * failed login: the URL and the code are already on stderr, and the flow keeps
 * polling.
 */
export function openBrowser(
  url: string,
  deps: { spawnImpl?: typeof spawn; platform?: NodeJS.Platform } = {},
): boolean {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const platform = deps.platform ?? process.platform;
  try {
    const child = spawnImpl(openerFor(platform), [url], {
      stdio: "ignore",
      detached: true,
      shell: platform === "win32",
    });
    // Without this an ENOENT from the opener becomes an unhandled 'error'
    // event and takes the CLI down mid-login.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli/auth-device.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Type check and commit**

```bash
npm run check
git add src/cli/auth-device.ts test/cli/auth-device.test.ts
git commit -m "feat(cli): add the device flow protocol module

Network, clock, wait, and browser launch are all injected, so the polling
state machine is tested without any of them. A browser that will not
launch is explicitly not a login failure — the URL is already on stderr.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The `auth` command, plus docs

Wires the protocol module into a command and persists the result. Documentation lands here because this is the task that makes the feature usable.

**Files:**
- Modify: `src/cli.ts` (imports; `CliDependencies` around line 209; `CLI_COMMANDS` beside `connect` at line 2844)
- Modify: `README.md`, `README.zh-CN.md`, `docs/local-mcp.md`
- Test: `test/cli/auth-login.test.ts`

**Interfaces:**
- Consumes: `requestDeviceAuthorization`, `pollForDeviceToken`, `openBrowser`, `DeviceFlowError` from Task 5; `writeCurrentInstance` and `clearCurrentInstance` from `../cli-current-instance.js` (already imported in `cli.ts`).
- Produces: `nitely auth login` and `nitely auth logout`; a new `openBrowser?` slot on `CliDependencies`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/auth-login.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function configDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-auth-login-"));
}

describe("nitely auth login", () => {
  it("stores the issued token and never prints it", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "BDFHJKMN.secret",
          user_code: "BDFH-JKMN",
          verification_uri: "http://127.0.0.1:7777/device",
          verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "nitely_api_abc_def",
          token_id: "tok_abc",
          name: "cli@dev-box",
          capabilities: ["tasks:read"],
        }),
      );

    const code = await runCli(
      [
        "auth", "login",
        "--server", "http://127.0.0.1:7777",
        "--capability", "tasks:read",
      ],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      {
        env: { NITELY_CONFIG_DIR: dir },
        fetch: fetchImpl,
        sleep: async () => {},
        openBrowser: () => true,
      },
    );

    expect(code).toBe(0);

    const stored = JSON.parse(
      await readFile(join(dir, "current-instance.json"), "utf8"),
    );
    expect(stored).toEqual({
      version: 1,
      serverUrl: "http://127.0.0.1:7777",
      apiToken: "nitely_api_abc_def",
    });
    expect((await stat(join(dir, "current-instance.json"))).mode & 0o777).toBe(0o600);

    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("BDFH-JKMN");
    expect(printed).toContain("tok_abc");
    expect(printed).not.toContain("nitely_api_abc_def");
  });

  it("puts the code and URL on stderr so stdout stays scriptable", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "BDFHJKMN.secret",
          user_code: "BDFH-JKMN",
          verification_uri: "http://127.0.0.1:7777/device",
          verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "t", token_id: "tok_1", name: "cli", capabilities: ["tasks:read"],
        }),
      );

    await runCli(
      ["auth", "login", "--server", "http://127.0.0.1:7777", "--capability", "tasks:read"],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    expect(err.join("\n")).toContain("BDFH-JKMN");
    expect(err.join("\n")).toContain("/device?code=BDFH-JKMN");
  });

  it("does not launch a browser with --no-browser", async () => {
    const dir = await configDir();
    const openBrowser = vi.fn(() => true);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "t", token_id: "tok_1", name: "cli", capabilities: [] }),
      );

    await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read", "--no-browser"],
      { stdout: () => {}, stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser },
    );

    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("requires at least one capability", async () => {
    const err: string[] = [];

    const code = await runCli(
      ["auth", "login", "--server", "http://x"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: await configDir() } },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--capability");
  });

  it("reports a denial without writing anything", async () => {
    const dir = await configDir();
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: "access_denied" }));

    const code = await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("denied");
    await expect(readFile(join(dir, "current-instance.json"), "utf8")).rejects.toThrow();
  });

  it("clears the local instance on logout and says the token still lives", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "t", token_id: "tok_1", name: "cli", capabilities: [] }),
      );
    await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read"],
      { stdout: () => {}, stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    const code = await runCli(
      ["auth", "logout"],
      { stdout: (line) => out.push(line), stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir } },
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("revoke");
    await expect(readFile(join(dir, "current-instance.json"), "utf8")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli/auth-login.test.ts`
Expected: FAIL — `Unknown command: auth`.

- [ ] **Step 3: Add the imports and the dependency slot**

In `src/cli.ts`, beside the other `./cli/` imports (around line 152), add:

```ts
import {
  DeviceFlowError,
  openBrowser as defaultOpenBrowser,
  pollForDeviceToken,
  requestDeviceAuthorization,
} from "./cli/auth-device.js";
```

In `CliDependencies` (around line 212, beside `sleep`), add:

```ts
  openBrowser?: (url: string) => boolean;
```

- [ ] **Step 4: Add the command**

In `src/cli.ts`, insert into `CLI_COMMANDS` immediately before the `connect` entry (line 2844):

```ts
  {
    name: "auth",
    usage: [
      "  auth login --server <url> --capability <cap> [--allow-high-impact] [--no-browser]",
      "  auth logout",
    ],
    run: async ({ argv, io, dependencies }) => {
      const env = dependencies.env ?? process.env;

      if (argv[1] === "logout") {
        if (argv.length > 2) {
          io.stderr(`Unknown auth logout option: ${argv[2]}`);
          return 1;
        }
        try {
          await clearCurrentInstance(env);
          io.stdout("Signed out locally.");
          io.stdout(
            "The API token is still valid on the server; revoke it in the Web Console or with nitely mcp token revoke.",
          );
          return 0;
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      if (argv[1] !== "login") {
        io.stderr(
          "Usage: nitely auth login --server <url> --capability <cap> | nitely auth logout",
        );
        return 1;
      }

      let serverUrl = env.NITELY_SERVER_URL ?? "";
      const capabilities: ApiTokenCapability[] = [];
      let allowHighImpact = false;
      let useBrowser = true;
      let accessToken: string | undefined;

      try {
        for (let index = 2; index < argv.length; index += 1) {
          const arg = argv[index];
          if (arg === "--server") {
            serverUrl = argv[++index] ?? "";
            if (!serverUrl) throw new Error("Missing value for --server");
            continue;
          }
          if (arg === "--capability") {
            const capability = argv[++index] ?? "";
            if (!capability) throw new Error("Missing value for --capability");
            if (!isApiTokenCapability(capability)) {
              throw new Error(`Unknown API token capability: ${capability}`);
            }
            capabilities.push(capability);
            continue;
          }
          if (arg === "--allow-high-impact") {
            allowHighImpact = true;
            continue;
          }
          if (arg === "--no-browser") {
            useBrowser = false;
            continue;
          }
          throw new Error(`Unknown auth login option: ${arg}`);
        }
        if (!serverUrl) throw new Error("Missing --server or NITELY_SERVER_URL");
        if (capabilities.length === 0) {
          throw new Error("At least one --capability is required");
        }

        const clientName = `cli@${hostname()}`;
        const deps = {
          fetchImpl: dependencies.fetch ?? fetch,
          ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        };

        const authorization = await requestDeviceAuthorization(
          { serverUrl, capabilities, allowHighImpact, clientName },
          deps,
        );

        io.stderr(`Open ${authorization.verificationUriComplete}`);
        io.stderr(`and confirm the code ${authorization.userCode}`);
        if (useBrowser) {
          (dependencies.openBrowser ?? defaultOpenBrowser)(
            authorization.verificationUriComplete,
          );
        }
        io.stderr("Waiting for approval...");

        const issued = await pollForDeviceToken(
          {
            serverUrl,
            deviceCode: authorization.deviceCode,
            intervalSeconds: authorization.interval,
            expiresInSeconds: authorization.expiresIn,
          },
          deps,
        );
        accessToken = issued.accessToken;

        const path = await writeCurrentInstance(env, {
          serverUrl,
          apiToken: issued.accessToken,
        });

        io.stdout(`Signed in to ${normalizeRemoteServerUrl(serverUrl)}`);
        io.stdout(`Token: ${issued.tokenId} (${issued.name})`);
        io.stdout(`Capabilities: ${issued.capabilities.join(", ")}`);
        io.stdout(`Saved to ${path}`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(
          error instanceof DeviceFlowError
            ? message
            : redactSecret(message, accessToken, env.NITELY_API_TOKEN),
        );
        return 1;
      }
    },
  },
```

Add `import { hostname } from "node:os";` at the top of `src/cli.ts` if it is not already imported. `isApiTokenCapability`, `redactSecret`, `writeCurrentInstance`, `clearCurrentInstance`, and `normalizeRemoteServerUrl` are already imported for the `mcp token` and `connect` commands.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/cli/auth-login.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the help text and full CLI suite**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS. The help-text test asserts on `buildCliHelp` output; if it pins an exact command list, add the two `auth` lines to its expectation.

- [ ] **Step 7: Document it**

In `docs/local-mcp.md`, replace the line reading "After `nitely connect --server <url>` with `NITELY_API_TOKEN` set, `mcp serve`..." with a paragraph that presents both routes:

```markdown
Point the CLI at a server one of two ways. With a remote server that has
users, sign in through the browser:

    nitely auth login --server https://nitely.example --capability tasks:read --capability runs:start --allow-high-impact

The CLI prints a URL and a short code, opens your browser, and waits. An
administrator approves the request on that page, and the CLI writes the
issued token to `~/.config/nitely/current-instance.json` (0600). No token is
ever printed or pasted.

For a server running with `--auth local`, browser sign-in is unavailable;
create a token from the server's own machine and connect with it instead:

    nitely mcp token create --repo <path> --name laptop --capability tasks:read
    NITELY_API_TOKEN=<token> nitely connect --server <url>

`nitely auth logout` clears the local file. The token stays valid on the
server until it is revoked in the Web Console or with `nitely mcp token revoke`.
```

Add the same `auth login` example to the CLI sections of `README.md` and
`README.zh-CN.md`, beside their existing `NITELY_API_TOKEN` mentions. Keep the
Chinese README in Chinese — translate the prose, leave the commands as-is.

- [ ] **Step 8: Run the whole suite and type check**

Run: `npm run test:run && npm run check`
Expected: PASS with no type errors. This is the first point where the full suite is warranted — run it on the Linux box.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts test/cli/auth-login.test.ts README.md README.zh-CN.md docs/local-mcp.md
git commit -m "feat(cli): add nitely auth login and auth logout

login runs the device flow and persists the issued token through the
existing writeCurrentInstance, so the 0600 file and the NITELY_API_TOKEN
precedence are unchanged. The code and URL go to stderr so stdout stays
scriptable, and the token itself is never printed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the store and code format → Task 1; `POST /api/device-authorization`, `POST /api/device-token`, the `--auth local` and setup-required behaviours, and the "not in `apiTokenActionForRequest`" guarantee → Task 2; the admin-only approve endpoint and its throttle → Task 3; `GET /device` as a standalone page → Task 4; the injected-side-effect CLI protocol module → Task 5; the `auth login` / `auth logout` commands, persistence, and docs → Task 6. The spec's audit actions appear in Tasks 2 and 3. The deferred items (userId binding, token expiry, remote revocation) are implemented nowhere, as intended, with `approvedByUserId` recorded in Task 1 for the eventual migration.

**Known gap, accepted:** the spec's testing section lists "the stored record never contains the plaintext token". Since the token is minted at exchange time and never written to a record, there is nothing to assert beyond the device-code hashing test in Task 1, which covers the same property.

**Type consistency.** `DeviceAuthorizationRecord` field names are used identically in Tasks 1–3. `normalizeUserCode` returns `string | undefined` throughout, which is why Task 2's test casts with `as string` after generating a known-good code. The CLI's `DeviceTokenResult` fields (`accessToken`, `tokenId`, `name`, `capabilities`) are consumed with those exact names in Task 6.
