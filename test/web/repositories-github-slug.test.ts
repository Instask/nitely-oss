import { describe, expect, it } from "vitest";

import { githubRepositorySlug } from "../../src/web/repositories.js";

describe("githubRepositorySlug", () => {
  it("derives owner/repo from SSH and HTTPS GitHub source URLs", () => {
    expect(githubRepositorySlug({ sourceUrl: "git@github.com:acme/app.git" })).toBe(
      "acme/app",
    );
    expect(
      githubRepositorySlug({ sourceUrl: "https://github.com/acme/app.git" }),
    ).toBe("acme/app");
  });

  it("returns nothing for missing or non-GitHub source URLs", () => {
    expect(githubRepositorySlug({})).toBeUndefined();
    expect(
      githubRepositorySlug({ sourceUrl: "https://gitlab.com/acme/app.git" }),
    ).toBeUndefined();
  });
});
