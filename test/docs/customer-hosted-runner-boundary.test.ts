import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("customer-hosted runner boundary docs", () => {
  it("documents the executable local protocol stub without claiming hosted control-plane support", async () => {
    const doc = await readFile(
      join(repositoryRoot, "docs", "customer-hosted-runner-boundary.md"),
      "utf8",
    );

    expect(doc).toContain("minimal local protocol stub");
    expect(doc).toContain("src/runner-control-plane/protocol.ts");
    expect(doc).toContain("src/runner-control-plane/file-stub.ts");
    expect(doc).toContain("Default uploads are metadata-only");
    expect(doc).toContain("production hosted control plane is still future work");
  });
});
