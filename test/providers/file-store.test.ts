import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import type { ProviderId } from "../../src/providers/types.js";

describe("FileProviderConnectionStore", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nightly-test-"));
    storePath = join(tmpDir, "connections.json");
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });

  const writableProviders: ProviderId[] = [
    "github",
    "anthropic",
    "glm",
    "grok",
    "google-drive",
    "jira",
  ];

  describe("setConnection", () => {
    it.each(writableProviders)(
      "writes %s value to the file",
      async (id) => {
        const store = new FileProviderConnectionStore({
          path: storePath,
          env: {},
          commandStatus: async () => false,
        });
        await store.setConnection({
          providerId: id,
          value: "sk-test-" + id,
          metadata: {
            scope: "repo",
            ownerId: "repo-owner",
            source: "web-console",
            rotationHint: "Rotate every 30 days",
          },
        });
        const content = await readFile(storePath, "utf8");
        // Secret bytes live in the sibling secret store, never in metadata.
        expect(content).not.toContain("sk-test-" + id);
        const parsed = JSON.parse(content);
        expect(parsed.version).toBe(2);
        expect(parsed.connections).toHaveLength(1);
        const [record] = parsed.connections;
        expect(record.providerId).toBe(id);
        expect(record.credential).toMatchObject({
          scope: "repo",
          ownerId: "repo-owner",
          source: "web-console",
          rotationHint: "Rotate every 30 days",
        });
        expect(record.credential.createdAt).toEqual(expect.any(String));
        expect(record.credential.updatedAt).toEqual(expect.any(String));
        const secrets = JSON.parse(
          await readFile(join(tmpDir, "connections.secrets.json"), "utf8"),
        );
        expect(secrets.secrets[record.credentialRef].accessToken).toBe("sk-test-" + id);
      },
    );

    it("overwrites existing value for the same provider", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "glm",
        value: "old-value",
      });
      await store.setConnection({
        providerId: "glm",
        value: "new-value",
      });
      expect(await store.listConnections("glm")).toHaveLength(1);
      expect((await store.resolveEnv()).NITELY_GLM_API_KEY).toBe("new-value");
    });

    it("throws for non-writable provider codex", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(
        store.setConnection({ providerId: "codex", value: "x" }),
      ).rejects.toThrow("cannot be configured via Web Console");
    });

    it("throws for non-writable provider pi", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(
        store.setConnection({ providerId: "pi", value: "x" }),
      ).rejects.toThrow("cannot be configured via Web Console");
    });
  });

  describe("clearConnection", () => {
    it.each(writableProviders)(
      "removes %s from the file",
      async (id) => {
        const store = new FileProviderConnectionStore({
          path: storePath,
          env: {},
          commandStatus: async () => false,
        });
        await store.setConnection({
          providerId: id,
          value: "val",
        });
        await store.clearConnection(
          id,
        );
        const content = await readFile(storePath, "utf8");
        const parsed = JSON.parse(content);
        expect(parsed.connections[id]).toBeUndefined();
      },
    );

    it("throws for non-writable provider codex", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(store.clearConnection("codex")).rejects.toThrow(
        "cannot be configured via Web Console",
      );
    });

    it("throws for non-writable provider pi", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(store.clearConnection("pi")).rejects.toThrow(
        "cannot be configured via Web Console",
      );
    });
  });

  describe("getConnection", () => {
    it("prefers stored value over env var", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { ANTHROPIC_API_KEY: "env-key" },
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "anthropic",
        value: "stored-key",
      });
      const conn = await store.getConnection("anthropic");
      expect(await conn.getAccessToken()).toBe("stored-key");
    });

    it("falls through to env when no stored value", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { NITELY_GITHUB_TOKEN: "env-token" },
        commandStatus: async () => false,
      });
      const conn = await store.getConnection("github");
      expect(await conn.getAccessToken()).toBe("env-token");
    });

    it("throws when neither stored nor env provides credentials", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(store.getConnection("github")).rejects.toThrow();
    });
  });

  describe("listStatuses", () => {
    it("reports stored providers as configured", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({ providerId: "glm", value: "sk-glm" });
      const statuses = await store.listStatuses();
      const glm = statuses.find((s) => s.id === "glm");
      expect(glm?.configured).toBe(true);
      expect(glm?.message).toBe("Configured in Web Console.");
      expect(glm?.credential).toMatchObject({
        scope: "user",
        source: "web-console",
      });
      expect(glm?.credential?.lastStatusCheckedAt).toEqual(expect.any(String));
      expect(JSON.stringify(glm)).not.toContain("sk-glm");
    });

    it("does not override non-writable CLI provider status", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      const codex = statuses.find((s) => s.id === "codex");
      expect(codex?.configured).toBe(false);
      expect(codex?.message).not.toBe("Configured in Web Console.");
      const pi = statuses.find((s) => s.id === "pi");
      expect(pi?.configured).toBe(false);
      expect(pi?.message).not.toBe("Configured in Web Console.");
    });

    it("normalizes legacy credential scope labels in status metadata", async () => {
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          connections: {
            github: {
              value: "sk-github",
              metadata: { scope: "env", source: "environment" },
            },
            glm: {
              value: "sk-glm",
              metadata: {
                scope: "external-vault",
                source: "external-vault",
                vaultRef: "vault://team/glm",
              },
            },
          },
        }),
        "utf8",
      );
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });

      const statuses = await store.listStatuses();
      const github = statuses.find((status) => status.id === "github");
      const glm = statuses.find((status) => status.id === "glm");
      expect(github?.credential).toMatchObject({ scope: "env-only" });
      expect(glm?.credential).toMatchObject({
        scope: "external-vault-backed",
        vaultRef: "vault://team/glm",
      });
    });
  });

  describe("audit events", () => {
    it("writes metadata-only audit events for set, status-check, and clear", async () => {
      const auditPath = join(tmpDir, "credential-audit.jsonl");
      const store = new FileProviderConnectionStore({
        path: storePath,
        auditPath,
        env: {},
        commandStatus: async () => false,
      });
      const secret = "sk-audit-secret";

      await store.setConnection({
        providerId: "github",
        value: secret,
        metadata: {
          scope: "org",
          source: "web-console",
          ownerId: "engineering",
          rotationHint: "Rotate monthly",
        },
      });
      await store.listStatuses();
      await store.clearConnection("github");

      const auditLog = await readFile(auditPath, "utf8");
      expect(auditLog).not.toContain(secret);
      const events = auditLog.trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "set",
            providerId: "github",
            result: "success",
            scope: "org",
            ownerId: "engineering",
          }),
          expect.objectContaining({
            action: "status-check",
            providerId: "github",
            result: "configured",
            scope: "org",
          }),
          expect.objectContaining({
            action: "clear",
            providerId: "github",
            result: "success",
            scope: "org",
          }),
        ]),
      );
    });
  });

  describe("fallback paths", () => {
    it("falls back to a shared store for a provider the primary does not hold", async () => {
      const sharedPath = join(tmpDir, "shared-connections.json");
      await writeFile(
        sharedPath,
        JSON.stringify({
          version: 1,
          connections: {
            anthropic: {
              value: "sk-ant-api03-shared",
              metadata: { scope: "user", source: "web-console" },
            },
          },
        }),
        "utf8",
      );
      const store = new FileProviderConnectionStore({
        path: storePath,
        fallbackPaths: [sharedPath],
        env: {},
        commandStatus: async () => false,
      });

      const statuses = await store.listStatuses();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "anthropic", configured: true }),
        ]),
      );
      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-shared");
    });

    it("prefers the primary store over the shared one", async () => {
      const sharedPath = join(tmpDir, "shared-connections.json");
      await writeFile(
        sharedPath,
        JSON.stringify({
          version: 1,
          connections: {
            anthropic: {
              value: "sk-ant-api03-shared",
              metadata: { scope: "user", source: "web-console" },
            },
          },
        }),
        "utf8",
      );
      const store = new FileProviderConnectionStore({
        path: storePath,
        fallbackPaths: [sharedPath],
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-api03-mine",
      });

      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-mine");

      // The shared file is read, never rewritten, by a store that writes elsewhere.
      const shared = JSON.parse(await readFile(sharedPath, "utf8"));
      expect(shared.connections.anthropic.value).toBe("sk-ant-api03-shared");
      const primary = await readFile(storePath, "utf8");
      expect(primary).not.toContain("sk-ant-api03-mine");
      expect(JSON.parse(primary).connections[0].providerId).toBe("anthropic");
    });
  });

  describe("empty stored credentials", () => {
    it("does not report a provider as configured when its stored value is empty", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          connections: {
            anthropic: {
              value: "",
              metadata: { scope: "user", source: "web-console" },
            },
          },
        }),
        "utf8",
      );
      const statuses = await store.listStatuses();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "anthropic", configured: false }),
        ]),
      );
    });

    it("refuses to store a blank credential", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await expect(
        store.setConnection({ providerId: "anthropic", value: "   " }),
      ).rejects.toThrow(/empty/i);
    });
  });

  describe("resolveEnv", () => {
    it("overlays stored values onto base env", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { SOME_OTHER_VAR: "keep" },
        commandStatus: async () => false,
      });
      await store.setConnection({ providerId: "glm", value: "sk-glm" });
      const env = await store.resolveEnv();
      expect(env.NITELY_GLM_API_KEY).toBe("sk-glm");
      expect(env.SOME_OTHER_VAR).toBe("keep");
    });

    it("an empty stored value never overwrites the inherited environment", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { ANTHROPIC_API_KEY: "inherited-and-working" },
        commandStatus: async () => false,
      });
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          connections: {
            anthropic: {
              value: "",
              metadata: { scope: "user", source: "web-console" },
            },
          },
        }),
        "utf8",
      );
      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("inherited-and-working");
    });

    it("overlays a stored Anthropic OAuth token onto CLAUDE_CODE_OAUTH_TOKEN", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-oat01-subscription",
      });
      const env = await store.resolveEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-subscription");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("overlays a stored Anthropic API key onto ANTHROPIC_API_KEY", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-api03-metered",
      });
      const env = await store.resolveEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-metered");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("a stored credential clears the other Anthropic variable inherited from the environment", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { ANTHROPIC_API_KEY: "inherited-api-key" },
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "anthropic",
        value: "sk-ant-oat01-subscription",
      });
      const env = await store.resolveEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-subscription");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("overlays stored Grok value onto XAI_API_KEY", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({ providerId: "grok", value: "xai-secret" });
      const env = await store.resolveEnv();
      expect(env.XAI_API_KEY).toBe("xai-secret");
    });

    it("stored value wins over env var for canonical key", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: { NITELY_GITHUB_TOKEN: "env-token" },
        commandStatus: async () => false,
      });
      await store.setConnection({
        providerId: "github",
        value: "stored-token",
      });
      const env = await store.resolveEnv();
      expect(env.NITELY_GITHUB_TOKEN).toBe("stored-token");
    });
  });

  describe("atomic write", () => {
    it("writes to tmp file then renames", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      await store.setConnection({ providerId: "glm", value: "sk-glm" });
      const files = await (
        await import("node:fs/promises")
      ).readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.startsWith("connections.json.tmp."));
      expect(tmpFiles).toHaveLength(0);
      expect(files).toContain("connections.json");
    });
  });

  describe("missing file", () => {
    it("treats missing connections.json as empty", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      const configured = statuses.filter((s) => s.configured);
      expect(configured).toHaveLength(0);
    });
  });

  describe("invalid file", () => {
    it("rejects malformed connections.json with a clear error", async () => {
      await writeFile(
        storePath,
        JSON.stringify({ version: 1, connections: { glm: { value: 42 } } }),
        "utf8",
      );
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });

      await expect(store.resolveEnv()).rejects.toThrow(
        "invalid connections.json: connections.glm.value must be a string",
      );
    });
  });
});
