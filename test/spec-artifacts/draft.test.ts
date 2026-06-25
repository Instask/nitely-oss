import { describe, expect, it } from "vitest";

import {
  generateDraftSpec,
  parseGitHubIssueReference,
} from "../../src/spec-artifacts/draft.js";
import { validateStructuredSpec } from "../../src/spec-artifacts/parse.js";

describe("draft spec generation", () => {
  it("generates a structured draft spec from prompt intake", () => {
    const draft = generateDraftSpec({
      type: "prompt",
      title: "Import GitHub repositories",
      body: "Allow operators to paste a GitHub URL and clone it into Nitely.",
    });

    expect(draft.title).toBe("Import GitHub repositories");
    expect(draft.markdown).toContain("Status: draft");
    expect(draft.markdown).toContain("Source: prompt");
    expect(draft.markdown).toContain("FR-001");
    expect(draft.markdown).toContain("SC-003");
    expect(validateStructuredSpec(draft.markdown).valid).toBe(true);
  });

  it("parses GitHub issue URLs and issue numbers", () => {
    expect(
      parseGitHubIssueReference("https://github.com/Instask/nitely/issues/111"),
    ).toMatchObject({
      owner: "Instask",
      repo: "nitely",
      number: 111,
      url: "https://github.com/Instask/nitely/issues/111",
    });
    expect(parseGitHubIssueReference("42")).toMatchObject({
      owner: "Instask",
      repo: "nitely",
      number: 42,
    });
  });
});
