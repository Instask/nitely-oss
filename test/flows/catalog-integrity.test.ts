import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (failure.path && String(args[0]).endsWith(failure.path)) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return await actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const {
  catalogFlowSummary,
  listCatalogFlows,
  resolveCatalogFlow,
  setCatalogFlowEnabled,
  syncSystemFlows,
  updateCatalogFlowDocument,
} = await import("../../src/flows/catalog.js");
const { openFlowStore } = await import("../../src/flows/store.js");
const {
  flowTemplateDocumentForCopy,
  getFlowTemplate,
  listFlowTemplates,
  requiredFlowTemplateInputIds,
} = await import("../../src/flows/templates.js");
const { validateFlowDocument } = await import("../../src/flows/validate.js");
const { createFlowWorkItem } = await import("../../src/work-items/create.js");

function flow(metadata: Record<string, unknown>, stages: unknown[]): string {
  return JSON.stringify({ apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata, spec: { stages } });
}

const mixedInputsFlow = flow({ name: "example", inputs: [{ id: "spec" }] }, [
  { id: "build", type: "command", command: "true", inputs: ["spec", "tech-design"], outputs: ["result"] },
]);

async function createRepo(): Promise<{ repoPath: string; bundledRoot: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-catalog-integrity-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/shipped.json"),
    flow({ name: "shipped", workItemType: "example.work" }, [
      { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
    ]),
    "utf8",
  );
  await writeFile(join(repoPath, "spec.md"), "spec", "utf8");
  await writeFile(join(repoPath, "design.md"), "design", "utf8");
  const bundledRoot = await mkdtemp(join(tmpdir(), "nitely-catalog-integrity-bundled-"));
  await mkdir(join(bundledRoot, "flows"), { recursive: true });
  return { repoPath, bundledRoot };
}

describe("template external inputs", () => {
  it("exposes declared and undeclared external inputs, all required, for create and copy", async () => {
    const { repoPath } = await createRepo();
    expect((await validateFlowDocument(repoPath, mixedInputsFlow)).valid).toBe(true);

    // Edit a built-in Flow behind a template into the mixed-inputs shape.
    await updateCatalogFlowDocument(repoPath, "flows/research-pipeline.json", mixedInputsFlow);
    const template = (await getFlowTemplate(repoPath, "research-pipeline"))!;
    expect(template.edited).toBe(true);
    expect(template.inputs).toEqual([
      { id: "spec", required: true },
      { id: "tech-design", required: true },
    ]);
    expect(requiredFlowTemplateInputIds(template)).toEqual(["spec", "tech-design"]);

    await expect(
      createFlowWorkItem(repoPath, {
        title: "missing one",
        templateId: "research-pipeline",
        inputs: { spec: { connector: "local-file", uri: "spec.md" } },
      }),
    ).rejects.toThrow(/tech-design/);
    const created = await createFlowWorkItem(repoPath, {
      title: "both",
      templateId: "research-pipeline",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
        "tech-design": { connector: "local-file", uri: "design.md" },
      },
    });
    expect(created.flowPath).toBe("template:research-pipeline");

    const copy = flowTemplateDocumentForCopy(template, { name: "copied" });
    expect(JSON.parse(copy).metadata.name).toBe("copied");
    expect((await validateFlowDocument(repoPath, copy)).valid).toBe(true);
  });

  it("keeps a declared input's type without duplicating ids", async () => {
    const { repoPath } = await createRepo();
    await updateCatalogFlowDocument(
      repoPath,
      "flows/research-pipeline.json",
      flow({ name: "typed", inputs: [{ id: "spec", type: "spec" }] }, [
        { id: "build", type: "command", command: "true", inputs: ["spec", "extra"], outputs: ["result"] },
        { id: "check", type: "command", command: "true", inputs: ["extra", "result"], outputs: ["checked"] },
      ]),
    );
    const template = (await getFlowTemplate(repoPath, "research-pipeline"))!;
    expect(template.inputs).toEqual([
      { id: "spec", type: "spec", required: true },
      { id: "extra", required: true },
    ]);
  });
});

describe("document replacement keeps stored metadata in sync", () => {
  it("updates the name, clears a removed workItemType, and keeps it across enable/disable", async () => {
    const { repoPath, bundledRoot } = await createRepo();
    const options = { bundledRoot };
    const before = await resolveCatalogFlow(repoPath, "flows/shipped.json", options);
    expect(catalogFlowSummary(before.record).workItemType).toBe("example.work");

    const replaced = await updateCatalogFlowDocument(
      repoPath,
      "flows/shipped.json",
      flow({ name: "renamed" }, [{ id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] }]),
      options,
    );
    expect(replaced.name).toBe("renamed");
    expect(replaced.workItemType).toBeUndefined();
    expect(catalogFlowSummary(replaced).workItemType).toBe("dev.pr");

    const disabled = await setCatalogFlowEnabled(repoPath, "flows/shipped.json", false, options);
    expect(disabled).toMatchObject({ name: "renamed", enabled: false });
    expect(disabled.workItemType).toBeUndefined();

    const typed = await updateCatalogFlowDocument(
      repoPath,
      "flows/shipped.json",
      flow({ name: "renamed", workItemType: "report.generation" }, [
        { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
      ]),
      options,
    );
    expect(typed).toMatchObject({ workItemType: "report.generation", enabled: false });

    await setCatalogFlowEnabled(repoPath, "flows/shipped.json", true, options);
    await updateCatalogFlowDocument(
      repoPath,
      "flows/shipped.json",
      flow({ name: "untyped" }, [{ id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] }]),
      options,
    );
    const item = await createFlowWorkItem(repoPath, { title: "x", flowPath: "flows/shipped.json", inputs: {} });
    const listed = (await listCatalogFlows(repoPath, options)).find((r) => r.seed?.key === "flows/shipped.json")!;
    expect(item.workItemType).toBe("dev.pr");
    expect(catalogFlowSummary(listed).workItemType).toBe(item.workItemType);
  });
});

describe("listFlowTemplates error handling", () => {
  it("surfaces an unexpected template failure instead of hiding the template", async () => {
    const { repoPath } = await createRepo();
    const { record } = await resolveCatalogFlow(repoPath, "flows/research-pipeline.json");
    const store = openFlowStore(repoPath);
    try {
      store.updateFlow(record.id, { document: "{ not json" });
    } finally {
      store.close();
    }
    await expect(listFlowTemplates(repoPath)).rejects.toThrow();
  });

  it("still hides only a disabled built-in Flow's template", async () => {
    const { repoPath } = await createRepo();
    await setCatalogFlowEnabled(repoPath, "flows/research-pipeline.json", false);
    const ids = (await listFlowTemplates(repoPath)).map((template) => template.id);
    expect(ids).not.toContain("research-pipeline");
    expect(ids).toContain("dev-pr");
  });
});

describe("seed read failures", () => {
  it("fails the sync and does not retire a seed it could not read", async () => {
    const { repoPath, bundledRoot } = await createRepo();
    const options = { bundledRoot };
    await listCatalogFlows(repoPath, options);

    failure.path = join("flows", "shipped.json");
    try {
      const store = openFlowStore(repoPath);
      try {
        await expect(syncSystemFlows(store, repoPath, options)).rejects.toThrow(/EACCES/);
      } finally {
        store.close();
      }
      await expect(listCatalogFlows(repoPath, options)).rejects.toThrow(/EACCES/);
    } finally {
      failure.path = undefined;
    }

    const store = openFlowStore(repoPath);
    try {
      const record = store.findBySeedKey("flows/shipped.json")!;
      expect(record.seed?.removedAt).toBeUndefined();
    } finally {
      store.close();
    }
    expect((await resolveCatalogFlow(repoPath, "flows/shipped.json", options)).record.enabled).toBe(true);
  });
});
