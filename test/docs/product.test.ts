import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

const constraints = [
  "Intent is explicit.",
  "Execution is constrained.",
  "Results require evidence.",
  "Humans retain authority.",
];

describe("product definition", () => {
  it("states the four constraints on the front door and in the definition docs", async () => {
    const [readme, chineseReadme, product, chineseProduct, trust] =
      await Promise.all([
        readFile(join(repositoryRoot, "README.md"), "utf8"),
        readFile(join(repositoryRoot, "README.zh-CN.md"), "utf8"),
        readFile(join(repositoryRoot, "docs", "product.md"), "utf8"),
        readFile(join(repositoryRoot, "docs", "product.zh-CN.md"), "utf8"),
        readFile(
          join(repositoryRoot, "docs", "trust-and-verification-model.md"),
          "utf8",
        ),
      ]);

    for (const line of constraints) {
      expect(readme).toContain(line);
      expect(chineseReadme).toContain(line);
      expect(product).toContain(line);
      expect(chineseProduct).toContain(line);
      expect(trust).toContain(line);
    }
    expect(readme.indexOf("Intent is explicit.")).toBeLessThan(
      readme.indexOf("governed spec-to-PR"),
    );
    expect(readme).toContain("docs/product.md");
    expect(chineseReadme).toContain("docs/product.zh-CN.md");
    expect(chineseReadme).toContain("意图必须明确。");
    expect(chineseReadme).toContain("人保留决定权。");
    expect(product).toContain("## Decision test");

    for (const manual of [
      "docs/running-flows.md",
      "docs/execution-backends.md",
      "docs/rework-and-recovery.md",
      "docs/web-console.md",
      "docs/remote-operations.md",
      "docs/flow-format.md",
      "docs/deployment.md",
      "docs/status.md",
    ]) {
      expect(readme).toContain(manual);
    }
  });
});
