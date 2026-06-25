import { describe, expect, it } from "vitest";

import { EnvProviderConnectionStore } from "../../src/providers/env-store.js";
import { MissingConnectionError } from "../../src/providers/types.js";
import { MissingGitHubTokenError } from "../../src/scm/github.js";

describe("EnvProviderConnectionStore", () => {
  describe("listStatuses", () => {
    it("reports configured when env var is present", async () => {
      const store = new EnvProviderConnectionStore({
        env: { NITELY_GITHUB_TOKEN: "tok" },
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "github", configured: true }),
          expect.objectContaining({ id: "anthropic", configured: false }),
          expect.objectContaining({ id: "glm", configured: false }),
          expect.objectContaining({ id: "google-drive", configured: false }),
          expect.objectContaining({ id: "codex", configured: false }),
        ]),
      );
    });

    it("reports all configured when all env vars set", async () => {
      const store = new EnvProviderConnectionStore({
        env: {
          NITELY_GITHUB_TOKEN: "tok",
          ANTHROPIC_API_KEY: "key",
          ZHIPUAI_API_KEY: "key",
          NITELY_GOOGLE_ACCESS_TOKEN: "tok",
        },
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      const configured = statuses
        .filter((s) => s.configured)
        .map((s) => s.id);
      expect(configured).toEqual(
        expect.arrayContaining(["github", "anthropic", "glm", "google-drive"]),
      );
    });

    it("reports codex as configured when command succeeds", async () => {
      const store = new EnvProviderConnectionStore({
        commandStatus: async () => true,
      });
      const statuses = await store.listStatuses();
      const codex = statuses.find((s) => s.id === "codex");
      expect(codex?.configured).toBe(true);
      expect(codex?.message).toContain("Codex CLI is installed");
    });
  });

  describe("getConnection", () => {
    it("returns github token from NITELY_GITHUB_TOKEN", async () => {
      const store = new EnvProviderConnectionStore({
        env: { NITELY_GITHUB_TOKEN: "gh-secret" },
      });
      const conn = await store.getConnection("github");
      expect(await conn.getAccessToken()).toBe("gh-secret");
    });

    it("returns github token from GITHUB_TOKEN fallback", async () => {
      const store = new EnvProviderConnectionStore({
        env: { GITHUB_TOKEN: "gh-alt" },
      });
      const conn = await store.getConnection("github");
      expect(await conn.getAccessToken()).toBe("gh-alt");
    });

    it("throws MissingConnectionError for github without token", async () => {
      const store = new EnvProviderConnectionStore({ env: {} });
      await expect(store.getConnection("github")).rejects.toThrow();
    });

    it("returns google-drive access token", async () => {
      const store = new EnvProviderConnectionStore({
        env: { NITELY_GOOGLE_ACCESS_TOKEN: "gd-secret" },
      });
      const conn = await store.getConnection("google-drive");
      expect(await conn.getAccessToken()).toBe("gd-secret");
    });

    it("throws MissingConnectionError for google-drive without token", async () => {
      const store = new EnvProviderConnectionStore({ env: {} });
      await expect(store.getConnection("google-drive")).rejects.toThrow(
        MissingConnectionError,
      );
    });

    it("throws MissingConnectionError for unknown provider", async () => {
      const store = new EnvProviderConnectionStore({ env: {} });
      await expect(store.getConnection("glm")).rejects.toThrow(
        MissingConnectionError,
      );
    });
  });

  describe("resolveEnv", () => {
    it("returns a copy of the env", async () => {
      const env = { NITELY_GITHUB_TOKEN: "tok" };
      const store = new EnvProviderConnectionStore({ env });
      const result = await store.resolveEnv();
      expect(result).toEqual(env);
      expect(result).not.toBe(env);
    });
  });
});
