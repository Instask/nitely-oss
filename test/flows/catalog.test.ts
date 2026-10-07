import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CatalogFlowDisabledError,
  CatalogFlowNotFoundError,
  catalogFlowId,
  listCatalogFlows,
  resolveCatalogFlow,
  syncSystemFlows,
} from "../../src/flows/catalog.js";
import {
  FlowStore,
  flowDocumentHash,
  flowRecordCustomized,
  openFlowStore,
} from "../../src/flows/store.js";
import { evaluateWorkItemRunStarts } from "../../src/run/eligibility.js";
import { evaluateWorkItemRunPreflight } from "../../src/run/preflight.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

function flowDocument(name: string, prompt = "Do the work."): string {
  return JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name, workItemType: "example.work" },
    spec: {
      stages: [
        { id: "execute", type: "agent", runtime: "mock", prompt, inputs: [], outputs: ["result"] },
      ],
    },
  });
}

async function createRepo(): Promise<{ repoPath: string; bundledRoot: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-flow-catalog-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(join(repoPath, "flows/shipped.json"), flowDocument("shipped", "v1"), "utf8");
  const bundledRoot = await mkdtemp(join(tmpdir(), "nitely-flow-bundled-"));
  await mkdir(join(bundledRoot, "flows"), { recursive: true });
  await writeFile(join(bundledRoot, "flows/bundled-only.json"), flowDocument("bundled-only"), "utf8");
  return { repoPath, bundledRoot };
}

function workItem(patch: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "item-1",
    title: "item",
    status: "ready",
    workItemType: "example.work",
    flowPath: "flows/shipped.json",
    inputs: {},
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...patch,
  };
}

function seed(key: string, document: string) {
  return { key, name: key, document, source: "repository" as const };
}

describe("FlowStore seed reconciliation", () => {
  it("migrates a pre-catalog database and keeps its rows as user Flows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitely-flow-migrate-"));
    const path = join(dir, "flows.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, work_item_type TEXT,
        document TEXT NOT NULL, owner_id TEXT, organization_id TEXT,
        template_id TEXT, template_version TEXT, template_source TEXT,
        template_source_flow_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO flows (id, name, document, owner_id, created_at, updated_at)
      VALUES ('flow-old', 'old', '${flowDocument("old")}', 'usr_1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new FlowStore(path);
    try {
      expect(store.getFlow("flow-old")).toMatchObject({
        id: "flow-old",
        origin: "user",
        enabled: true,
        ownerId: "usr_1",
      });
      expect(store.getFlow("flow-old").seed).toBeUndefined();
    } finally {
      store.close();
    }
    // Reopening an already migrated database is a no-op.
    new FlowStore(path).close();
  });

  it("inserts, upgrades untouched, preserves customized, and retires and restores seeds", () => {
    const store = new FlowStore(":memory:");
    const v1 = flowDocument("a", "v1");
    const v2 = flowDocument("a", "v2");
    const v3 = flowDocument("a", "v3");

    expect(store.reconcileSeeds([seed("flows/a.json", v1), seed("flows/b.json", flowDocument("b"))]))
      .toMatchObject({ inserted: ["flows/a.json", "flows/b.json"] });
    const a = store.findBySeedKey("flows/a.json")!;
    expect(a).toMatchObject({ origin: "system", enabled: true, document: v1 });
    expect(a.seed).toMatchObject({ key: "flows/a.json", hash: flowDocumentHash(v1) });
    expect(flowRecordCustomized(a)).toBe(false);

    // Untouched and disabled: upgraded, and stays disabled.
    store.updateFlow(a.id, { enabled: false });
    expect(store.reconcileSeeds([seed("flows/a.json", v2), seed("flows/b.json", flowDocument("b"))]))
      .toMatchObject({ upgraded: ["flows/a.json"] });
    expect(store.findBySeedKey("flows/a.json")).toMatchObject({ document: v2, enabled: false });

    // Customized: never overwritten, upstream change recorded.
    const custom = flowDocument("a", "mine");
    store.updateFlow(a.id, { document: custom });
    expect(store.reconcileSeeds([seed("flows/a.json", v3), seed("flows/b.json", flowDocument("b"))]))
      .toMatchObject({ preserved: ["flows/a.json"], upgraded: [] });
    const preserved = store.findBySeedKey("flows/a.json")!;
    expect(preserved.document).toBe(custom);
    expect(flowRecordCustomized(preserved)).toBe(true);
    expect(preserved.seed?.availableHash).toBe(flowDocumentHash(v3));

    // A seed that disappears is kept and marked, then restored when it returns.
    expect(store.reconcileSeeds([seed("flows/a.json", v3)])).toMatchObject({ removed: ["flows/b.json"] });
    const b = store.findBySeedKey("flows/b.json")!;
    expect(b.seed?.removedAt).toBeDefined();
    expect(store.reconcileSeeds([seed("flows/a.json", v3), seed("flows/b.json", flowDocument("b"))]))
      .toMatchObject({ restored: ["flows/b.json"] });
    expect(store.findBySeedKey("flows/b.json")!.seed?.removedAt).toBeUndefined();

    expect(() => store.deleteFlow(b.id)).toThrow(/disable them instead/);
    store.close();
  });
});

describe("Flow catalog", () => {
  it("seeds repository and bundled Flows and lists them by seed key", async () => {
    const { repoPath, bundledRoot } = await createRepo();
    const flows = await listCatalogFlows(repoPath, { bundledRoot });
    expect(flows.map(catalogFlowId).sort()).toEqual(["flows/bundled-only.json", "flows/shipped.json"]);
    const store = openFlowStore(repoPath);
    try {
      expect(store.findBySeedKey("flows/shipped.json")?.seed?.source).toBe("repository");
      expect(store.findBySeedKey("flows/bundled-only.json")?.seed?.source).toBe("bundled");
    } finally {
      store.close();
    }
  });

  it("hides an untouched Flow whose file was removed, but keeps a customized one", async () => {
    const { repoPath, bundledRoot } = await createRepo();
    await listCatalogFlows(repoPath, { bundledRoot });
    await rm(join(repoPath, "flows/shipped.json"));
    await expect(resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot }))
      .rejects.toBeInstanceOf(CatalogFlowNotFoundError);

    await writeFile(join(repoPath, "flows/shipped.json"), flowDocument("shipped", "v1"), "utf8");
    const restored = await resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot });
    const store = openFlowStore(repoPath);
    store.updateFlow(restored.record.id, { document: flowDocument("shipped", "mine") });
    store.close();
    await rm(join(repoPath, "flows/shipped.json"));
    await expect(resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot }))
      .resolves.toMatchObject({ document: flowDocument("shipped", "mine") });
  });

  it("rejects a disabled Flow unless the caller only reads it", async () => {
    const { repoPath, bundledRoot } = await createRepo();
    const { record } = await resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot });
    const store = openFlowStore(repoPath);
    store.updateFlow(record.id, { enabled: false });
    store.close();
    await expect(resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot }))
      .rejects.toBeInstanceOf(CatalogFlowDisabledError);
    await expect(
      resolveCatalogFlow(repoPath, "flows/shipped.json", { bundledRoot, requireEnabled: false }),
    ).resolves.toMatchObject({ id: "flows/shipped.json" });
    await expect(resolveCatalogFlow(repoPath, "flows/missing.json", { bundledRoot }))
      .rejects.toBeInstanceOf(CatalogFlowNotFoundError);
  });
});

describe("runtime Flow lookups from the store", () => {
  async function customizeShipped(repoPath: string, patch: { document?: string; enabled?: boolean }) {
    const { record } = await resolveCatalogFlow(repoPath, "flows/shipped.json");
    const store = openFlowStore(repoPath);
    store.updateFlow(record.id, patch);
    store.close();
  }

  it("runs the stored, customized document of a built-in Flow and keeps the file label", async () => {
    const { repoPath } = await createRepo();
    const custom = flowDocument("shipped", "customized prompt");
    await customizeShipped(repoPath, { document: custom });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [workItem()],
      intent: { kind: "automatic" },
    });
    expect(starts.eligibility["item-1"]?.decision).toBe("eligible");
    expect(starts.runInputs["item-1"]).toMatchObject({
      flowPath: join(repoPath, "flows/shipped.json"),
      flowDocument: custom,
    });

    const report = await evaluateWorkItemRunPreflight({ repoPath, workItem: workItem() });
    expect(report).toMatchObject({ flowPath: join(repoPath, "flows/shipped.json") });
    expect(report.issues.map((item) => item.code)).not.toContain("flow-disabled");
  });

  it("blocks Runs and preflight for a disabled Flow", async () => {
    const { repoPath } = await createRepo();
    await customizeShipped(repoPath, { enabled: false });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [workItem()],
      intent: { kind: "automatic" },
    });
    expect(starts.eligibility["item-1"]).toMatchObject({
      decision: "blocked",
      blockers: [expect.objectContaining({ code: "preflight.flow-disabled" })],
    });
    expect(starts.runInputs).not.toHaveProperty("item-1");

    const report = await evaluateWorkItemRunPreflight({ repoPath, workItem: workItem() });
    expect(report.status).toBe("BLOCK");
    expect(report.issues[0]?.code).toBe("flow-disabled");
  });
});
