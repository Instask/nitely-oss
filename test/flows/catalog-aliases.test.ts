import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlowDocument } from "../../src/flow/load.js";
import {
  applyCatalogAliasDefaults, applyResolvedFlowSelection, CatalogFlowDisabledError, catalogFlowSummary,
  resolveCatalogFlow, resolveRunFlowSource, setCatalogFlowEnabled, syncSystemFlows,
} from "../../src/flows/catalog.js";
import { evaluateWorkItemRunStarts } from "../../src/run/eligibility.js";
import { evaluateRunPreflight } from "../../src/run/preflight.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";
import { openFlowStore } from "../../src/flows/store.js";

const baseKey = "flows/implement-spec-bootstrap.json";
const tempPaths: string[] = [];
afterEach(async () => { await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-alias-"));
  const bundledRoot = await mkdtemp(join(tmpdir(), "nitely-alias-bundle-"));
  tempPaths.push(repoPath, bundledRoot);
  await mkdir(join(repoPath, "flows"));
  for (const suffix of ["", "-grok", "-pi", "-claude"]) {
    const key = `flows/implement-spec-bootstrap${suffix}.json`;
    await writeFile(join(repoPath, key), await readFile(new URL(`../../${key}`, import.meta.url), "utf8"));
  }
  return { repoPath, options: { bundledRoot } };
}

describe("deprecated bootstrap variant aliases", () => {
  it.each([
    ["grok", { runtime: "grok" }],
    ["claude", { runtime: "claude" }],
    ["pi", { runtime: "openrouter", model: "qwen/qwen3-coder-next" }],
  ])("resolves existing %s references to the base snapshot with compatibility defaults", async (variant, overrides) => {
    const { repoPath, options } = await fixture();
    const reference = `flows/implement-spec-bootstrap-${variant}.json`;
    const source = await resolveRunFlowSource(repoPath, reference, options);
    const baseDocument = await readFile(join(repoPath, baseKey), "utf8");
    expect(source).toEqual({ flowPath: reference, catalogId: reference, flowDocument: baseDocument, aliasOf: baseKey, overrides });
    const catalog = await resolveCatalogFlow(repoPath, reference, options);
    expect(catalogFlowSummary(catalog.record)).toMatchObject({ aliasOf: baseKey, deprecated: true, edited: false });
    const byStoreId = await resolveCatalogFlow(repoPath, catalog.record.id, options);
    expect(byStoreId.document).toBe(baseDocument);
    expect(byStoreId.overrides).toEqual(overrides);
    const flow = parseFlowDocument(source.flowDocument, { externalInputs: ["spec", "tech-design"] }).flow;
    // All deprecated variants migrate to the current base DAG, including review gate and reflection.
    expect(flow.spec.stages.find((stage) => stage.id === "review")).toMatchObject({ type: "gate", mode: "review" });
    expect(flow.spec.stages.some((stage) => stage.id === "reflect")).toBe(true);
    const compatible = applyResolvedFlowSelection(flow, { aliasOf: source.aliasOf, overrides: source.overrides });
    expect(compatible.spec.stages.filter((stage) => stage.type === "agent" || (stage.type === "gate" && stage.mode === "review")))
      .toEqual(expect.arrayContaining([expect.objectContaining(overrides)]));
    if (variant !== "pi") expect(compatible.spec.stages.find((stage) => stage.id === "implement")).not.toHaveProperty("model");
    expect(JSON.stringify(flow)).toBe(JSON.stringify(parseFlowDocument(baseDocument, { externalInputs: ["spec", "tech-design"] }).flow));
  });

  it("gives explicit selections precedence over alias defaults without changing source", async () => {
    const { repoPath, options } = await fixture();
    const source = await resolveRunFlowSource(repoPath, "flows/implement-spec-bootstrap-pi.json", options);
    const flow = parseFlowDocument(source.flowDocument, { externalInputs: ["spec", "tech-design"] }).flow;
    const effective = applyResolvedFlowSelection(flow, {
      aliasOf: source.aliasOf,
      overrides: { ...source.overrides, runtime: "mock", model: "chosen-model", effort: "high" },
    });
    expect(effective.spec.stages.find((stage) => stage.id === "implement")).toMatchObject({ runtime: "mock", model: "chosen-model", effort: "high" });
    expect(flow.spec.stages.find((stage) => stage.id === "implement")).toMatchObject({ runtime: "codex", model: "gpt-5.3-codex" });
  });

  it("preserves customized legacy rows as independent flows across seed upgrades", async () => {
    const { repoPath, options } = await fixture();
    const reference = "flows/implement-spec-bootstrap-claude.json";
    const original = await resolveCatalogFlow(repoPath, reference, options);
    const custom = JSON.parse(original.record.document);
    custom.spec.stages[0].prompt = "My custom workflow";
    const document = JSON.stringify(custom);
    const store = openFlowStore(repoPath);
    try { store.updateFlow(original.record.id, { document }); } finally { store.close(); }
    await writeFile(join(repoPath, reference), original.record.document + "\n");
    const source = await resolveRunFlowSource(repoPath, reference, options);
    expect(source.flowDocument).toBe(document);
    expect(source.aliasOf).toBeUndefined();
    expect(source.overrides).toBeUndefined();
    const resolved = await resolveCatalogFlow(repoPath, reference, options);
    expect(catalogFlowSummary(resolved.record)).toMatchObject({ edited: true, newerShippedVersion: true });
    expect(catalogFlowSummary(resolved.record).deprecated).toBeUndefined();
  });

  it("honors both alias and base enable flags and keeps management edits on the alias row", async () => {
    const { repoPath, options } = await fixture();
    const reference = "flows/implement-spec-bootstrap-grok.json";
    await setCatalogFlowEnabled(repoPath, reference, false, options);
    await expect(resolveRunFlowSource(repoPath, reference, options)).rejects.toBeInstanceOf(CatalogFlowDisabledError);
    await setCatalogFlowEnabled(repoPath, reference, true, options);
    await setCatalogFlowEnabled(repoPath, baseKey, false, options);
    await expect(resolveRunFlowSource(repoPath, reference, options)).rejects.toBeInstanceOf(CatalogFlowDisabledError);
    const management = await resolveCatalogFlow(repoPath, reference, { ...options, requireEnabled: false, resolveAliases: false });
    expect(management.document).toBe(management.record.document);
    expect(management.aliasOf).toBeUndefined();
  });

  it("leaves the base without overrides as the exact source identity", async () => {
    const { repoPath, options } = await fixture();
    const store = openFlowStore(repoPath);
    try { await syncSystemFlows(store, repoPath, options); } finally { store.close(); }
    const source = await resolveRunFlowSource(repoPath, baseKey, options);
    expect(source.flowDocument).toBe(await readFile(join(repoPath, baseKey), "utf8"));
    expect(source.overrides).toBeUndefined();
    expect(source.aliasOf).toBeUndefined();
    const flow = parseFlowDocument(source.flowDocument, { externalInputs: ["spec", "tech-design"] }).flow;
    expect(applyCatalogAliasDefaults(flow)).toBe(flow);
    expect(applyResolvedFlowSelection(flow)).toEqual(flow);
  });

  it("checks the alias runtime in preflight and lets an explicit runtime replace it", async () => {
    const { repoPath } = await fixture();
    const reference = "flows/implement-spec-bootstrap-grok.json";
    const alias = await evaluateRunPreflight({ repoPath, flowPath: reference, inputs: {}, env: {} });
    expect(alias.requiredProviders).toContain("grok");
    expect(alias.requiredProviders).not.toContain("codex");
    const selected = await evaluateRunPreflight({
      repoPath, flowPath: reference, inputs: {}, env: {}, overrides: { runtime: "mock" },
    });
    expect(selected.requiredProviders).not.toContain("grok");
    expect(selected.requiredProviders).not.toContain("codex");
  });

  it("starts an existing variant work item from the base snapshot and alias defaults", async () => {
    const { repoPath } = await fixture();
    const spec = join(repoPath, "spec.md");
    const design = join(repoPath, "design.md");
    await writeFile(spec, "Spec\n");
    await writeFile(design, "Design\n");
    const item: WorkItemRecord = {
      id: "variant-task",
      title: "variant-task",
      status: "ready",
      workItemType: "dev.pr",
      flowPath: "flows/implement-spec-bootstrap-grok.json",
      inputs: {
        spec: { connector: "local-file", uri: spec },
        "tech-design": { connector: "local-file", uri: design },
      },
      configuration: { setupCommand: "true", verifyCommand: "true" },
      overrides: { runtime: "mock", model: "chosen-model", questions: "deny" },
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
      env: {},
    });
    expect(starts.eligibility[item.id].decision).toBe("eligible");
    expect(starts.runInputs[item.id]).toMatchObject({
      flowPath: join(repoPath, "flows/implement-spec-bootstrap-grok.json"),
      flowDocument: await readFile(join(repoPath, baseKey), "utf8"),
      aliasOf: baseKey,
      overrides: { runtime: "mock", model: "chosen-model", questions: "deny" },
    });
  });
});
