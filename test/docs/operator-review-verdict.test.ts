import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("operator review verdict documentation", () => {
  it("documents the audited fallback and safer runtime alternatives", async () => {
    const [readme, authoring, trust] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "rework-and-recovery.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "user-defined-flows.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "security-and-trust.md"), "utf8"),
    ]);

    expect(readme).toContain("review-verdict <run-id>");
    expect(readme).toContain("The run remains blocked until the explicit");
    expect(readme).toContain(
      "Prefer waiting for quota recovery or switching to another",
    );
    expect(authoring).toMatch(
      /reviewed artifact list must exactly match the\s+gate's declared inputs/,
    );
    expect(authoring).toMatch(/pass may\s+continue to publish/);
    expect(trust).toContain("operator review submission/resolution");
  });
});
