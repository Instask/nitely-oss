import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}

describe("canonical artifact model documentation", () => {
  it("documents the Markdown-first artifact chain and ID responsibilities", async () => {
    const doc = await readRepoFile("docs/canonical-artifacts.md");

    expect(doc).toContain("spec -> technical design -> tasks -> run evidence -> PR evidence");
    expect(doc).toContain("source-controlled Markdown is the canonical execution artifact");
    expect(doc).toContain("External documents are collaboration inputs");

    for (const heading of [
      "Spec",
      "Technical Design",
      "Tasks",
      "Run Evidence",
      "PR Evidence",
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    for (const idFamily of ["US-*", "FR-*", "SC-*", "PD-*", "T*"]) {
      expect(doc).toContain(idFamily);
    }
  });

  it("keeps templates wired for upstream and downstream ID traceability", async () => {
    const spec = await readRepoFile("docs/templates/nitely-spec.md");
    const plan = await readRepoFile("docs/templates/nitely-technical-plan.md");
    const tasks = await readRepoFile("docs/templates/nitely-tasks.md");

    expect(spec).toContain("implementation plans and task artifacts should cite");
    expect(spec).toContain("PR evidence and review findings should cite IDs");

    expect(plan).toContain("Trace");
    expect(plan).toContain("PD-001");
    expect(plan).toContain("SC-001");

    for (const id of ["US-001", "FR-001", "SC-001", "PD-001", "T001"]) {
      expect(tasks).toContain(id);
    }
    expect(tasks).toContain("Canonical Inputs");
    expect(tasks).toContain("Downstream Evidence");
  });
});
