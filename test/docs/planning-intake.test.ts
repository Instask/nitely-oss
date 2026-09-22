import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("planning intake contract", () => {
  it("documents the shared intake sources, provenance, drift, and gates", async () => {
    const [contract, readme, chineseReadme] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "planning-intake.md"), "utf8"),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "README.zh-CN.md"), "utf8"),
    ]);

    expect(contract).toContain("# Planning Intake");
    for (const section of [
      "## Intake sources",
      "## External documents are a connector boundary",
      "## Conversation intake",
      "## Source provenance, snapshots, and hashes",
      "## Drift cannot silently invalidate an approved baseline",
      "## Approval gates",
      "## Auditability without provider secrets",
    ]) {
      expect(contract).toContain(section);
    }
    for (const sourceType of [
      "`github-issue`",
      "`jira-ticket`",
      "`external-document`",
      "`prompt`",
      "`text`",
    ]) {
      expect(contract).toContain(sourceType);
    }
    expect(contract).toContain(
      "No caller supplies a spec\nor a technical design to create a Task.",
    );
    expect(contract).toContain("does not hold a Lark/Feishu, Confluence, or Google Docs credential");
    expect(contract).toContain("What intake never persists: provider tokens");

    for (const readmeFile of [readme, chineseReadme]) {
      expect(readmeFile).toContain("docs/planning-intake.md");
      expect(readmeFile).toContain("pnpm dev -- task plan --prompt");
      expect(readmeFile).toContain("pnpm dev -- task plan --issue");
      expect(readmeFile).toContain("pnpm dev -- task plan --jira");
      expect(readmeFile).toContain("--document-url https://example.feishu.cn/docx/ABC123");
      expect(readmeFile).toContain("pnpm dev -- task draft-tech-design <task-id>");
    }
  });
});
