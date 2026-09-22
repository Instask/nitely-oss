import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("usage scenarios and efficiency thesis docs", () => {
  it("defines the day-planning to night-execution thesis and demo scripts", async () => {
    const [doc, readme] = await Promise.all([
      readFile(
        join(repositoryRoot, "docs", "usage-scenarios-and-efficiency-thesis.md"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
    ]);

    expect(doc).toContain(
      "Turn daytime human judgment into an overnight executable engineering queue.",
    );
    expect(doc).toContain(
      "issue -> conversation -> spec -> tech design -> approval -> scheduled execution -> PR -> review -> deploy -> reflection",
    );
    expect(doc).toContain("## Solo Founder Scenario");
    expect(doc).toContain("## Small Team Scenario");
    expect(doc).toContain("## Where Efficiency Improves");
    expect(doc).toContain("## Where Efficiency Does Not Automatically Improve");
    expect(doc).toContain("## Solo Founder Demo Script");
    expect(doc).toContain("## Small Team Demo Script");
    expect(doc).toContain("plan by day, execute by night, review by morning");
    expect(readme).toContain("plan by day, execute by night, review by morning");
    expect(readme).toContain("docs/usage-scenarios-and-efficiency-thesis.md");
  });
});
