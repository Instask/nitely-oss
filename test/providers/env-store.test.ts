import { describe, expect, it } from "vitest";

import { EnvProviderConnectionStore } from "../../src/providers/env-store.js";
import { MissingConnectionError } from "../../src/providers/types.js";

describe("EnvProviderConnectionStore", () => {
  describe("listStatuses", () => {
    it("reports anthropic configured from a Claude subscription OAuth token", async () => {
      const store = new EnvProviderConnectionStore({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscription" },
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "anthropic", configured: true }),
        ]),
      );
    });

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
          expect.objectContaining({ id: "grok", configured: false }),
          expect.objectContaining({ id: "pi", configured: false }),
          expect.objectContaining({ id: "google-drive", configured: false }),
          expect.objectContaining({ id: "jira", configured: false }),
          expect.objectContaining({ id: "codex", configured: false }),
        ]),
      );
      const github = statuses.find((status) => status.id === "github");
      expect(github?.credential).toMatchObject({
        scope: "env-only",
        source: "environment",
      });
      expect(github?.credential?.lastStatusCheckedAt).toEqual(expect.any(String));
    });

    it("reports all configured when all env vars set", async () => {
      const store = new EnvProviderConnectionStore({
        env: {
          NITELY_GITHUB_TOKEN: "tok",
          ANTHROPIC_API_KEY: "key",
          ZHIPUAI_API_KEY: "key",
          XAI_API_KEY: "key",
          NITELY_GOOGLE_ACCESS_TOKEN: "tok",
          NITELY_JIRA_TOKEN: "jira-token",
        },
        commandStatus: async () => false,
      });
      const statuses = await store.listStatuses();
      const configured = statuses
        .filter((s) => s.configured)
        .map((s) => s.id);
      expect(configured).toEqual(
        expect.arrayContaining([
          "github",
          "anthropic",
          "glm",
          "grok",
          "google-drive",
          "jira",
        ]),
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

    it("reports Grok Build as configured from CLI install or XAI_API_KEY", async () => {
      const cliStore = new EnvProviderConnectionStore({
        env: {},
        commandStatus: async (command, args) =>
          command === "grok" && args.join(" ") === "version",
      });
      const cliStatuses = await cliStore.listStatuses();
      expect(cliStatuses.find((s) => s.id === "grok")).toMatchObject({
        configured: true,
        message:
          "Grok Build CLI is installed. Authentication is managed by the local CLI or XAI_API_KEY.",
      });

      const envStore = new EnvProviderConnectionStore({
        env: { XAI_API_KEY: "xai-secret" },
        commandStatus: async () => false,
      });
      const envStatuses = await envStore.listStatuses();
      const grok = envStatuses.find((s) => s.id === "grok");
      expect(grok).toMatchObject({
        configured: true,
        message: "xAI API key environment variable is configured.",
        credential: {
          scope: "env-only",
          source: "environment",
        },
      });
      expect(grok?.credential?.lastStatusCheckedAt).toEqual(expect.any(String));
      expect(JSON.stringify(envStatuses)).not.toContain("xai-secret");
    });

    it("reports Pi as configured when the CLI is installed", async () => {
      const store = new EnvProviderConnectionStore({
        env: {},
        commandStatus: async (command, args) =>
          command === "pi" && args.join(" ") === "--version",
      });
      const statuses = await store.listStatuses();
      expect(statuses.find((s) => s.id === "pi")).toMatchObject({
        configured: true,
        message:
          "Pi CLI is installed. Model provider configuration is managed by Pi.",
      });
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

    it("returns Jira token without exposing it through status metadata", async () => {
      const store = new EnvProviderConnectionStore({
        env: { NITELY_JIRA_TOKEN: "jira-secret" },
        commandStatus: async () => false,
      });
      const conn = await store.getConnection("jira");
      expect(await conn.getAccessToken()).toBe("jira-secret");
      expect(JSON.stringify(await store.listStatuses())).not.toContain("jira-secret");
    });

    it("throws MissingConnectionError for Jira without token", async () => {
      const store = new EnvProviderConnectionStore({ env: {} });
      await expect(store.getConnection("jira")).rejects.toThrow(
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
