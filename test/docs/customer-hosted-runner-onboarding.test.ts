import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("customer-hosted runner onboarding docs", () => {
  it("documents the pilot setup report", async () => {
    const doc = await readFile(
      join(repositoryRoot, "docs", "customer-hosted-runner-onboarding.md"),
      "utf8",
    );

    expect(doc).toContain("nitely pilot setup-report");
    expect(doc).toContain("## Credential And Data Boundaries");
    expect(doc).toContain("## Setup Report Evidence");
    expect(doc).toContain(".nitely/pilot-setup-report.md");
    expect(doc).toContain("customer-hosted runner boundary");
  });
});
