import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("customer validation docs", () => {
  it("defines the AI coding failure funnel interview workflow", async () => {
    const doc = await readFile(
      join(repositoryRoot, "docs", "customer-validation.md"),
      "utf8",
    );

    expect(doc).toContain("## Target Customers");
    expect(doc).toContain("## Discovery Questions");
    expect(doc).toContain("## Failure Classification");
    expect(doc).toContain("## Interview Notes");
    expect(doc).toContain("## Recommendation Template");
    expect(doc).toContain("Would they pay");
  });
});
