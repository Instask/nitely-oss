import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("customer-hosted runner onboarding docs", () => {
  it("documents the pilot setup report and links it from the paid pilot package", async () => {
    const [doc, paidPilot] = await Promise.all([
      readFile(
        join(repositoryRoot, "docs", "customer-hosted-runner-onboarding.md"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "docs", "paid-pilot-offering.md"), "utf8"),
    ]);

    expect(doc).toContain("nitely pilot setup-report");
    expect(doc).toContain("## Credential And Data Boundaries");
    expect(doc).toContain("## Setup Report Evidence");
    expect(doc).toContain(".nitely/pilot-setup-report.md");
    expect(doc).toContain("customer-hosted runner boundary");
    expect(paidPilot).toContain("customer-hosted-runner-onboarding.md");
  });
});
