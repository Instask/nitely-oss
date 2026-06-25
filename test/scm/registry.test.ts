import { describe, expect, it } from "vitest";

import { createScmProvider } from "../../src/scm/registry.js";

describe("SCM provider registry", () => {
  it("uses the GitHub API provider by default", () => {
    const provider = createScmProvider();

    expect(provider.type).toBe("github");
  });

  it("uses the legacy gh provider only when explicitly selected", () => {
    const provider = createScmProvider("github-cli");

    expect(provider.type).toBe("github-cli");
  });

  it("rejects unsupported SCM providers", () => {
    expect(() => createScmProvider("gitlab")).toThrow(
      "unsupported SCM provider: gitlab",
    );
  });
});
