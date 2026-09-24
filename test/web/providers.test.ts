import { describe, expect, it } from "vitest";

import { getProviderStatuses } from "../../src/web/providers.js";

describe("web provider statuses", () => {
  it("reports configured state without exposing secret values", async () => {
    const statuses = await getProviderStatuses({
      env: {
        NITELY_GITHUB_TOKEN: "github-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        ZHIPUAI_API_KEY: "glm-secret",
        XAI_API_KEY: "xai-secret",
        NITELY_GOOGLE_ACCESS_TOKEN: "google-secret",
        NITELY_JIRA_TOKEN: "jira-secret",
      },
      commandStatus: async (command) =>
        command === "codex" || command === "pi",
    });

    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain("github-secret");
    expect(serialized).not.toContain("anthropic-secret");
    expect(serialized).not.toContain("glm-secret");
    expect(serialized).not.toContain("xai-secret");
    expect(serialized).not.toContain("google-secret");
    expect(serialized).not.toContain("jira-secret");
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "github", configured: true }),
        expect.objectContaining({ id: "codex", configured: true }),
        expect.objectContaining({ id: "anthropic", configured: true }),
        expect.objectContaining({ id: "glm", configured: true }),
        expect.objectContaining({ id: "grok", configured: true }),
        expect.objectContaining({ id: "pi", configured: true }),
        expect.objectContaining({ id: "google-drive", configured: true }),
        expect.objectContaining({ id: "jira", configured: true }),
      ]),
    );
  });

  it("reports Grok Build and Pi provider hints", async () => {
    const statuses = await getProviderStatuses({
      env: {},
      commandStatus: async () => false,
    });

    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "grok",
          name: "Grok Build / xAI",
          configured: false,
          hints: expect.arrayContaining([
            "grok login",
            "XAI_API_KEY",
            "NITELY_GROK_COMMAND",
          ]),
        }),
        expect.objectContaining({
          id: "pi",
          name: "Pi Coding Agent",
          configured: false,
          hints: expect.arrayContaining(["pi --version", "NITELY_PI_COMMAND"]),
        }),
      ]),
    );
  });

  it("reports GLM as configured when any supported credential is present", async () => {
    for (const credential of [
      "NITELY_GLM_API_KEY",
      "GLM_API_KEY",
      "ZHIPUAI_API_KEY",
    ]) {
      const statuses = await getProviderStatuses({
        env: { [credential]: "glm-secret" },
        commandStatus: async () => false,
      });

      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "glm",
            name: "GLM / Zhipu",
            configured: true,
            hints: expect.arrayContaining([
              "NITELY_GLM_API_KEY",
              "GLM_API_KEY",
              "ZHIPUAI_API_KEY",
              "NITELY_GLM_COMMAND",
            ]),
          }),
        ]),
      );
    }
  });

  it("does not treat gh authentication as default GitHub API credentials", async () => {
    const statuses = await getProviderStatuses({
      env: {},
      commandStatus: async (command) => command === "gh",
    });

    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "github",
          configured: false,
          message: "Set NITELY_GITHUB_TOKEN or GITHUB_TOKEN.",
        }),
      ]),
    );
  });
});
