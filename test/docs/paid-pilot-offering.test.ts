import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("paid pilot offering docs", () => {
  it("defines the first pilot package with scope, metrics, onboarding, and closeout", async () => {
    const doc = await readFile(
      join(repositoryRoot, "docs", "paid-pilot-offering.md"),
      "utf8",
    );

    expect(doc).toContain("$2k-$5k/month");
    expect(doc).toContain("## Qualification Criteria");
    expect(doc).toContain("## Included");
    expect(doc).toContain("## Excluded");
    expect(doc).toContain("## Success Metrics");
    expect(doc).toContain("## Onboarding Checklist");
    expect(doc).toContain("## Pilot Closeout");
    expect(doc).toContain("## Feed Team-Control-Plane Requirements");
  });
});
