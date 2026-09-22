import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("operator review verdict documentation", () => {
  it("documents the audited fallback and safer runtime alternatives", async () => {
    const [readme, authoring, design, trust] = await Promise.all([
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "user-defined-flows.md"), "utf8"),
      readFile(
        join(
          repositoryRoot,
          "docs",
          "plans",
          "2026-07-14-operator-review-verdict-tech-design.md",
        ),
        "utf8",
      ),
      readFile(join(repositoryRoot, "docs", "security-and-trust.md"), "utf8"),
    ]);

    expect(readme).toContain(
      "[Review gates and custom Flows](docs/user-defined-flows.md)",
    );
    expect(authoring).toMatch(
      /reviewed artifact list must exactly match the\s+gate's declared inputs/,
    );
    expect(authoring).toMatch(/pass may\s+continue to publish/);
    expect(design).toContain("operator.review.submitted");
    expect(design).toContain("rerunning any upstream stage");
    expect(trust).toContain("operator review submission/resolution");
  });
});
