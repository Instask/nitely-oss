import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProviderConnectionStore } from "../../src/providers/file-store.js";

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

  const writableProviders = ["github", "anthropic", "glm", "google-drive"];

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
          providerId: id as "github" | "anthropic" | "glm" | "google-drive",
          value: "sk-test-" + id,
        });
        const content = await readFile(storePath, "utf8");
        const parsed = JSON.parse(content);
        expect(parsed.version).toBe(1);
        expect(parsed.connections[id]).toEqual({
          value: "sk-test-" + id,
        });
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
      const content = await readFile(storePath, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.connections.glm.value).toBe("new-value");
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
          providerId: id as "github" | "anthropic" | "glm" | "google-drive",
          value: "val",
        });
        await store.clearConnection(
          id as "github" | "anthropic" | "glm" | "google-drive",
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
    });

    it("does not override codex status", async () => {
      const store = new FileProviderConnectionStore({
        path: storePath,
        env: {},
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      const codex = statuses.find((s) => s.id === "codex");
      expect(codex?.configured).toBe(false);
      expect(codex?.message).not.toBe("Configured in Web Console.");
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
