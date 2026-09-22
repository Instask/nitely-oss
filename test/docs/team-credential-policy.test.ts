import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("team credential policy docs", () => {
  it("documents provider credential ownership, metadata, and vault-ready boundaries", async () => {
    const [doc, paidPilot] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "team-credential-policy.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "paid-pilot-offering.md"), "utf8"),
    ]);

    expect(doc).toContain("## Credential Scopes");
    expect(doc).toContain("user-scoped");
    expect(doc).toContain("repo-scoped");
    expect(doc).toContain("org-scoped");
    expect(doc).toContain("env-only");
    expect(doc).toContain("external-vault-backed");
    expect(doc).toContain("## Safe Metadata");
    expect(doc).toContain("scope, owner, created/updated time, last status check");
    expect(doc).toContain("Raw secret values must never be returned from Web APIs");
    expect(doc).toContain("## Vault-Ready Resolution");
    expect(doc).toContain("## Audit Events");
    expect(doc).toContain("credential set, clear, and status-check actions");
    expect(paidPilot).toContain("team-credential-policy.md");
  });
});
