import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findDescriptor } from "../../src/providers/descriptors.js";
import { EnvProviderConnectionStore } from "../../src/providers/env-store.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import { ReconnectRequiredError } from "../../src/providers/types.js";

describe("provider connection model", () => {
  let tmpDir: string;
  let storePath: string;
  let secretsPath: string;
  let auditPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nitely-conn-model-"));
    storePath = join(tmpDir, "connections.json");
    secretsPath = join(tmpDir, "connections.secrets.json");
    auditPath = join(tmpDir, "connections.json.audit.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeStore(
    options: Partial<ConstructorParameters<typeof FileProviderConnectionStore>[0]> = {},
  ): FileProviderConnectionStore {
    return new FileProviderConnectionStore({
      path: storePath,
      env: {},
      commandStatus: async () => false,
      ...options,
    });
  }

  describe("provider descriptors", () => {
    it("declare more than one supported auth method for Anthropic", () => {
      const anthropic = findDescriptor("anthropic");
      expect(anthropic.authMethods.map((m) => m.method)).toEqual([
        "api_key",
        "oauth_token",
      ]);
      expect(anthropic.authMethods.find((m) => m.method === "api_key")?.env).toBe(
        "ANTHROPIC_API_KEY",
      );
      expect(
        anthropic.authMethods.find((m) => m.method === "oauth_token")?.env,
      ).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("declare CLI-managed providers without a writable method", () => {
      const codex = findDescriptor("codex");
      expect(codex.authMethods.map((m) => m.method)).toEqual(["cli_managed"]);
      expect(codex.writable).toBe(false);
    });

    it("declare GitHub and Google Drive as OAuth-capable", () => {
      expect(findDescriptor("github").authMethods.map((m) => m.method)).toContain(
        "oauth",
      );
      expect(
        findDescriptor("google-drive").authMethods.map((m) => m.method),
      ).toContain("oauth");
    });
  });

  describe("explicit auth method", () => {
    it("persists the declared auth method instead of inspecting the secret", async () => {
      const store = makeStore();
      const record = await store.setConnection({
        providerId: "anthropic",
        authMethod: "api_key",
        // Looks like an OAuth token, but the operator said it is an API key.
        value: "sk-ant-oat-but-declared-api-key",
      });
      expect(record.authMethod).toBe("api_key");
      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-oat-but-declared-api-key");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("rejects an auth method the provider does not support", async () => {
      const store = makeStore();
      await expect(
        store.setConnection({
          providerId: "glm",
          authMethod: "oauth_token",
          value: "x",
        }),
      ).rejects.toThrow(/glm does not support auth method oauth_token/);
    });

    it("keeps secret material out of connections.json", async () => {
      const store = makeStore();
      const secret = "sk-ant-api03-secret-material";
      await store.setConnection({
        providerId: "anthropic",
        authMethod: "api_key",
        value: secret,
      });
      const metadata = await readFile(storePath, "utf8");
      expect(metadata).not.toContain(secret);
      const parsed = JSON.parse(metadata);
      expect(parsed.version).toBe(2);
      expect(parsed.connections).toHaveLength(1);
      expect(parsed.connections[0]).toMatchObject({
        providerId: "anthropic",
        authMethod: "api_key",
        state: "active",
        isDefault: true,
      });
      expect(parsed.connections[0].credentialRef).toEqual(expect.any(String));
      expect(parsed.connections[0].value).toBeUndefined();
      const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
      expect(secrets.secrets[parsed.connections[0].credentialRef].accessToken).toBe(
        secret,
      );
    });
  });

  describe("multiple connections per provider", () => {
    it("stores an API key and an OAuth token for Anthropic side by side", async () => {
      const store = makeStore();
      const apiKey = await store.setConnection({
        providerId: "anthropic",
        authMethod: "api_key",
        value: "sk-ant-api03-metered",
      });
      const oauth = await store.setConnection({
        providerId: "anthropic",
        authMethod: "oauth_token",
        value: "sk-ant-oat-subscription",
      });
      expect(apiKey.id).not.toBe(oauth.id);
      const connections = await store.listConnections("anthropic");
      expect(connections.map((c) => c.authMethod).sort()).toEqual([
        "api_key",
        "oauth_token",
      ]);
      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-metered");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-subscription");
    });

    it("keeps two connections of the same method without overwriting", async () => {
      const store = makeStore();
      const personal = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        label: "personal",
        value: "ghp_personal",
      });
      const bot = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        label: "release bot",
        value: "ghp_bot",
      });
      expect(personal.id).not.toBe(bot.id);
      const connections = await store.listConnections("github");
      expect(connections.map((c) => c.label).sort()).toEqual([
        "personal",
        "release bot",
      ]);
    });

    it("updates an existing connection in place when its id is given", async () => {
      const store = makeStore();
      const first = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_old",
      });
      const rotated = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        connectionId: first.id,
        value: "ghp_new",
      });
      expect(rotated.id).toBe(first.id);
      expect(await store.listConnections("github")).toHaveLength(1);
      expect(
        await (await store.getConnection("github")).getAccessToken(),
      ).toBe("ghp_new");
    });
  });

  describe("deterministic selection", () => {
    it("selects by explicit connection id", async () => {
      const store = makeStore();
      await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_first",
      });
      const second = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_second",
      });
      const connection = await store.getConnection("github", {
        connectionId: second.id,
      });
      expect(connection.connectionId).toBe(second.id);
      expect(await connection.getAccessToken()).toBe("ghp_second");
    });

    it("selects by requested auth method", async () => {
      const store = makeStore();
      await store.setConnection({
        providerId: "anthropic",
        authMethod: "api_key",
        value: "sk-ant-api03-metered",
      });
      await store.setConnection({
        providerId: "anthropic",
        authMethod: "oauth_token",
        value: "sk-ant-oat-subscription",
      });
      const connection = await store.getConnection("anthropic", {
        authMethod: "oauth_token",
      });
      expect(connection.authMethod).toBe("oauth_token");
      expect(await connection.getAccessToken()).toBe("sk-ant-oat-subscription");
    });

    it("the first connection of a method is the default; later ones do not steal it", async () => {
      const store = makeStore();
      const first = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_first",
      });
      await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_second",
      });
      const connection = await store.getConnection("github");
      expect(connection.connectionId).toBe(first.id);
      expect((await store.resolveEnv()).NITELY_GITHUB_TOKEN).toBe("ghp_first");
    });

    it("makeDefault moves the default explicitly", async () => {
      const store = makeStore();
      await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_first",
      });
      const second = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_second",
        makeDefault: true,
      });
      const connections = await store.listConnections("github");
      expect(connections.filter((c) => c.isDefault).map((c) => c.id)).toEqual([
        second.id,
      ]);
      expect((await store.resolveEnv()).NITELY_GITHUB_TOKEN).toBe("ghp_second");
    });

    it("clearing the default promotes the oldest remaining connection", async () => {
      const store = makeStore();
      const first = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_first",
      });
      const second = await store.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_second",
      });
      await store.clearConnection("github", { connectionId: first.id });
      const remaining = await store.listConnections("github");
      expect(remaining.map((c) => c.id)).toEqual([second.id]);
      expect(remaining[0].isDefault).toBe(true);
      const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
      expect(JSON.stringify(secrets)).not.toContain("ghp_first");
    });

    it("prefers the primary store over a shared fallback for the same provider", async () => {
      const sharedPath = join(tmpDir, "shared", "connections.json");
      const shared = new FileProviderConnectionStore({
        path: sharedPath,
        env: {},
        commandStatus: async () => false,
      });
      await shared.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_shared",
      });
      const personal = makeStore({ fallbackPaths: [sharedPath] });
      expect(
        await (await personal.getConnection("github")).getAccessToken(),
      ).toBe("ghp_shared");
      await personal.setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_personal",
      });
      expect(
        await (await personal.getConnection("github")).getAccessToken(),
      ).toBe("ghp_personal");
    });
  });

  describe("ownership isolation", () => {
    it("does not resolve a connection stored in another user's store", async () => {
      const otherPath = join(tmpDir, "users", "other", "connections.json");
      await new FileProviderConnectionStore({
        path: otherPath,
        env: {},
        commandStatus: async () => false,
      }).setConnection({
        providerId: "github",
        authMethod: "pat",
        value: "ghp_other",
        metadata: { scope: "user", ownerId: "other" },
      });
      const mine = makeStore();
      await expect(mine.getConnection("github")).rejects.toThrow();
      expect(await mine.listConnections("github")).toEqual([]);
    });
  });

  describe("legacy connections.json migration", () => {
    it("assigns explicit auth methods to legacy records by provider rules", async () => {
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          connections: {
            anthropic: {
              value: "sk-ant-oat-legacy",
              metadata: { scope: "user", source: "web-console", ownerId: "u1" },
            },
            github: { value: "ghp_legacy" },
            glm: { value: "glm-legacy" },
          },
        }),
      );
      const store = makeStore();
      const byProvider = Object.fromEntries(
        (await store.listConnections()).map((c) => [c.providerId, c]),
      );
      expect(byProvider.anthropic.authMethod).toBe("oauth_token");
      expect(byProvider.anthropic.credential).toMatchObject({
        scope: "user",
        ownerId: "u1",
      });
      expect(byProvider.github.authMethod).toBe("pat");
      expect(byProvider.glm.authMethod).toBe("api_key");
      expect(
        await (await store.getConnection("github")).getAccessToken(),
      ).toBe("ghp_legacy");
      const env = await store.resolveEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-legacy");
      expect(env.NITELY_GLM_API_KEY).toBe("glm-legacy");
    });

    it("rewrites a legacy file into the split metadata/secret layout on first write", async () => {
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          connections: { github: { value: "ghp_legacy" } },
        }),
      );
      const store = makeStore();
      await store.setConnection({
        providerId: "glm",
        authMethod: "api_key",
        value: "glm-new",
      });
      const metadata = await readFile(storePath, "utf8");
      expect(metadata).not.toContain("ghp_legacy");
      expect(JSON.parse(metadata).version).toBe(2);
      expect(
        await (await store.getConnection("github")).getAccessToken(),
      ).toBe("ghp_legacy");
    });

    it("infers the legacy method when a write omits authMethod", async () => {
      const store = makeStore();
      const oauth = await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-oat-legacy-write",
      });
      expect(oauth.authMethod).toBe("oauth_token");
      const apiKey = await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-api03-legacy-write",
      });
      expect(apiKey.authMethod).toBe("api_key");
    });

    it("a write without authMethod or id replaces the provider's default of that method", async () => {
      const store = makeStore();
      await store.setConnection({ providerId: "glm", value: "glm-old" });
      await store.setConnection({ providerId: "glm", value: "glm-new" });
      expect(await store.listConnections("glm")).toHaveLength(1);
      expect((await store.resolveEnv()).NITELY_GLM_API_KEY).toBe("glm-new");
    });
  });

  describe("OAuth credential lifecycle", () => {
    it("refreshes an expired OAuth credential transparently and rotates the refresh token", async () => {
      const refreshCalls: Array<{ providerId: string; refreshToken: string }> = [];
      let now = new Date("2026-09-19T10:00:00Z");
      const store = makeStore({
        now: () => now,
        oauth: {
          refresh: async (input) => {
            refreshCalls.push({
              providerId: input.providerId,
              refreshToken: input.refreshToken,
            });
            return {
              accessToken: "gho_fresh",
              refreshToken: "ghr_rotated",
              expiresAt: "2026-09-19T12:00:00Z",
            };
          },
        },
      });
      const record = await store.setConnection({
        providerId: "github",
        authMethod: "oauth",
        value: "gho_stale",
        refreshToken: "ghr_original",
        expiresAt: "2026-09-19T10:30:00Z",
        scopes: ["repo", "read:user"],
        account: { login: "octocat" },
      });
      expect(record.refreshable).toBe(true);
      const connection = await store.getConnection("github");
      expect(await connection.getAccessToken()).toBe("gho_stale");
      now = new Date("2026-09-19T11:00:00Z");
      expect(await connection.getAccessToken()).toBe("gho_fresh");
      expect(refreshCalls).toEqual([
        { providerId: "github", refreshToken: "ghr_original" },
      ]);
      // A fresh store sees the rotated material.
      const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
      expect(JSON.stringify(secrets)).not.toContain("ghr_original");
      expect(JSON.stringify(secrets)).toContain("ghr_rotated");
      const [updated] = await store.listConnections("github");
      expect(updated.expiresAt).toBe("2026-09-19T12:00:00Z");
      expect(updated.state).toBe("active");
    });

    it("reports reconnect-required when an expired credential cannot be refreshed", async () => {
      const store = makeStore({ now: () => new Date("2026-09-19T11:00:00Z") });
      await store.setConnection({
        providerId: "google-drive",
        authMethod: "oauth",
        value: "ya29.stale",
        expiresAt: "2026-09-19T10:30:00Z",
      });
      const connection = await store.getConnection("google-drive");
      const error = await connection.getAccessToken().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReconnectRequiredError);
      expect(error).toMatchObject({
        providerId: "google-drive",
        authMethod: "oauth",
        reason: "expired",
      });
      const status = (await store.listStatuses()).find((s) => s.id === "google-drive");
      expect(status?.reconnectRequired).toBe(true);
      expect(status?.configured).toBe(false);
      expect(JSON.stringify(status)).not.toContain("ya29.stale");
      expect((await store.resolveEnv()).NITELY_GOOGLE_ACCESS_TOKEN).toBeUndefined();
    });

    it("marks a credential revoked when the refresh is rejected", async () => {
      const store = makeStore({
        now: () => new Date("2026-09-19T11:00:00Z"),
        oauth: {
          refresh: async () => {
            throw new Error("invalid_grant");
          },
        },
      });
      await store.setConnection({
        providerId: "github",
        authMethod: "oauth",
        value: "gho_stale",
        refreshToken: "ghr_revoked",
        expiresAt: "2026-09-19T10:30:00Z",
      });
      const connection = await store.getConnection("github");
      await expect(connection.getAccessToken()).rejects.toMatchObject({
        name: "ReconnectRequiredError",
        reason: "revoked",
      });
      const [record] = await store.listConnections("github");
      expect(record.state).toBe("revoked");
      // Once revoked, the store does not try to refresh again.
      await expect(
        (await store.getConnection("github")).getAccessToken(),
      ).rejects.toMatchObject({ reason: "revoked" });
    });

    it("an explicit revoke produces the reconnect-required state without deleting the record", async () => {
      const store = makeStore();
      const record = await store.setConnection({
        providerId: "github",
        authMethod: "oauth",
        value: "gho_live",
        refreshToken: "ghr_live",
      });
      await store.revokeConnection("github", { connectionId: record.id });
      const [after] = await store.listConnections("github");
      expect(after.state).toBe("revoked");
      const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
      expect(JSON.stringify(secrets)).not.toContain("gho_live");
      expect(JSON.stringify(secrets)).not.toContain("ghr_live");
    });

    it("the audit log records refresh and revocation without token bytes", async () => {
      const store = makeStore({
        auditPath,
        now: () => new Date("2026-09-19T11:00:00Z"),
        oauth: {
          refresh: async () => ({ accessToken: "gho_fresh", refreshToken: "ghr_rotated" }),
        },
      });
      await store.setConnection({
        providerId: "github",
        authMethod: "oauth",
        value: "gho_stale",
        refreshToken: "ghr_original",
        expiresAt: "2026-09-19T10:30:00Z",
      });
      await (await store.getConnection("github")).getAccessToken();
      const log = await readFile(auditPath, "utf8");
      for (const secret of ["gho_stale", "gho_fresh", "ghr_original", "ghr_rotated"]) {
        expect(log).not.toContain(secret);
      }
      const events = log.trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "set", authMethod: "oauth" }),
          expect.objectContaining({ action: "refresh", result: "success" }),
        ]),
      );
    });
  });

  describe("status projection", () => {
    it("exposes auth methods and connection summaries without credential material", async () => {
      const store = makeStore();
      await store.setConnection({
        providerId: "anthropic",
        authMethod: "oauth_token",
        value: "sk-ant-oat-subscription",
        label: "Claude Max",
      });
      const status = (await store.listStatuses()).find((s) => s.id === "anthropic");
      expect(status?.configured).toBe(true);
      expect(status?.authMethods.map((m) => m.method)).toEqual([
        "api_key",
        "oauth_token",
      ]);
      const oauth = status?.authMethods.find((m) => m.method === "oauth_token");
      expect(oauth?.configured).toBe(true);
      expect(oauth?.connections).toHaveLength(1);
      expect(oauth?.connections[0]).toMatchObject({
        label: "Claude Max",
        state: "active",
        isDefault: true,
      });
      expect(status?.authMethods.find((m) => m.method === "api_key")?.configured).toBe(
        false,
      );
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain("sk-ant-oat-subscription");
      expect(serialized).not.toContain("credentialRef");
      expect(status?.credential).toMatchObject({ scope: "user", source: "web-console" });
    });

    it("projects environment credentials into the same auth method model", async () => {
      const store = new EnvProviderConnectionStore({
        env: {
          ANTHROPIC_API_KEY: "sk-ant-api03-env",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-env",
        },
        commandStatus: async () => false,
      });
      const status = (await store.listStatuses()).find((s) => s.id === "anthropic");
      expect(status?.configured).toBe(true);
      for (const method of ["api_key", "oauth_token"]) {
        const entry = status?.authMethods.find((m) => m.method === method);
        expect(entry?.configured).toBe(true);
        expect(entry?.connections[0]).toMatchObject({
          state: "active",
          credential: { scope: "env-only", source: "environment" },
        });
      }
      expect(JSON.stringify(status)).not.toContain("sk-ant-");
    });
  });
});
