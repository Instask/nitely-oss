import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateFlowDocument } from "../../src/flows/validate.js";
import { flowTemplates } from "../../src/flows/templates.js";

async function createRepo(allowedTypes?: string[]) {
  const repo = await mkdtemp(join(tmpdir(), "nitely-flow-validate-"));
  if (allowedTypes) {
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely/work-item-policy.json"),
      JSON.stringify({ allowedTypes }),
      "utf8",
    );
  }
  return repo;
}

const devFlow = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "dev", workItemType: "dev.pr", inputs: [{ id: "spec" }] },
  spec: {
    stages: [
      { id: "implement", type: "agent", runtime: "codex", prompt: "x", inputs: ["spec"], outputs: ["implementation"] },
    ],
  },
});

describe("validateFlowDocument", () => {
  it("reports a valid flow", async () => {
    const repo = await createRepo();
    const report = await validateFlowDocument(repo, devFlow);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("reports invalid JSON as an error", async () => {
    const repo = await createRepo();
    const report = await validateFlowDocument(repo, "{ not json");
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("reports a schema violation (empty stages)", async () => {
    const repo = await createRepo();
    const bad = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "bad" },
      spec: { stages: [] },
    });
    const report = await validateFlowDocument(repo, bad);
    expect(report.valid).toBe(false);
  });

  it("hard-blocks a high-risk type that omits its required gate", async () => {
    const repo = await createRepo(["autofarm.site"]);
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "af", workItemType: "autofarm.site" },
      spec: {
        stages: [
          { id: "deploy", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    });
    const report = await validateFlowDocument(repo, flow);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/gate|approval/i);
  });
});

describe("flowTemplates", () => {
  it("provides templates whose documents validate", async () => {
    const repo = await createRepo();
    expect(flowTemplates.length).toBeGreaterThan(0);
    for (const template of flowTemplates) {
      const report = await validateFlowDocument(repo, template.document);
      expect(report.valid, `${template.id}: ${report.errors.join("; ")}`).toBe(true);
    }
  });
});
