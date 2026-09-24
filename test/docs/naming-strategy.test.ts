import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)].map(
    ([, target]) => target,
  );
}

describe("Nitely naming strategy", () => {
  it("records a dated decision, evidence limits, and public-launch gate", async () => {
    const [strategy, readme, chineseReadme, positioning] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "naming-strategy.md"), "utf8"),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "README.zh-CN.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "positioning.md"), "utf8"),
    ]);

    expect(strategy).toContain("# Nitely Naming Strategy");
    expect(strategy).toContain("Decision date: 2026-07-14");
    for (const section of [
      "## Decision",
      "## Options Compared",
      "## Dated Availability And Collision Checks",
      "## Preliminary Trademark Risk",
      "## Public-Launch Gate",
    ]) {
      expect(strategy).toContain(section);
    }
    for (const option of [
      "Keep Nitely",
      "longer commercial brand",
      "Rename before public launch",
    ]) {
      expect(strategy.toLowerCase()).toContain(option.toLowerCase());
    }
    expect(strategy).toMatch(/official|first-party/i);
    expect(strategy).toMatch(/not legal advice/i);
    expect(strategy).toMatch(/not (?:a )?trademark clearance/i);
    expect(strategy).toMatch(/qualified trademark counsel/i);
    expect(strategy).toMatch(/do not (?:publish|launch)/i);
    expect(strategy).toContain("**Rename before public launch.**");
    expect(strategy).toMatch(/temporary internal[\s\S]{0,80}codename/i);
    expect(strategy).toMatch(
      /dry run[\s\S]{0,120}(?:cannot|does not)[\s\S]{0,80}(?:prove|establish)/i,
    );
    expect(strategy).not.toMatch(/authenticated result[\s\S]{0,80}private/i);
    expect(strategy).toContain(
      "All checks in this section were performed on 2026-07-14",
    );
    for (const source of [
      "rdap.verisign.com/com/v1/domain/nitely.com",
      "registry.npmjs.org/nitely",
      "api.github.com/search/repositories",
      "apps.apple.com/us/app/nitely-toronto",
    ]) {
      expect(strategy).toContain(source);
    }
    for (const blockedLaunchSurface of [
      "public landing page",
      "SaaS control plane",
      "paid offer",
      "public package",
    ]) {
      expect(strategy).toContain(blockedLaunchSurface);
    }

    expect(localMarkdownTargets(readme)).toContain("docs/naming-strategy.md");
    expect(localMarkdownTargets(chineseReadme)).toContain(
      "docs/naming-strategy.md",
    );
    expect(localMarkdownTargets(positioning)).toContain("naming-strategy.md");
    await access(join(repositoryRoot, "docs", "naming-strategy.md"));
  });
});
