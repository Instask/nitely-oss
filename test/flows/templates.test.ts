import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCatalogFlow, readFlowSeeds } from "../../src/flows/catalog.js";
import { openFlowStore } from "../../src/flows/store.js";
import {
  FLOW_TEMPLATE_ENTRIES,
  getFlowTemplate,
  listFlowTemplates,
} from "../../src/flows/templates.js";
import type { ProviderConnectionStore } from "../../src/providers/types.js";
import { evaluateWorkItemRunStarts } from "../../src/run/eligibility.js";
import { evaluateWorkItemRunPreflight } from "../../src/run/preflight.js";
import { createFlowWorkItem } from "../../src/work-items/create.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-templates-"));
  await writeFile(join(repoPath, "research.md"), "Research Nitely.", "utf8");
  return repoPath;
}

const providerStore: ProviderConnectionStore = {
  getConnection: async (providerId) => ({ providerId, getAccessToken: async () => "token" }),
  resolveEnv: async () => ({}),
  listStatuses: async () => [
    {
      id: "codex",
      name: "Codex",
      configured: true,
      message: "configured",
      hints: [],
      reconnectRequired: false,
      authMethods: [],
    },
  ],
};

/** A work item exactly as a pre-catalog template creation stored it. */
function legacyTemplateWorkItem(): WorkItemRecord {
  return {
    id: "legacy-template-item",
    title: "legacy",
    status: "ready",
    workItemType: "dev.pr",
    flowPath: "template:research-pipeline",
    template: { templateId: "research-pipeline", templateVersion: "1.0.0", source: "builtin" },
    inputs: { "research-task": { connector: "local-file", uri: "research.md" } },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

async function editBuiltin(repoPath: string, key: string, patch: { document?: string; enabled?: boolean }) {
  const { record } = await resolveCatalogFlow(repoPath, key, { requireEnabled: false });
  const store = openFlowStore(repoPath);
  try {
    store.updateFlow(record.id, patch);
  } finally {
    store.close();
  }
}

describe("flow templates over the Flow catalog", () => {
  it("resolves every existing template id to its seeded built-in Flow document", async () => {
    const repoPath = await createRepo();
    const ids = FLOW_TEMPLATE_ENTRIES.map((entry) => entry.id);
    expect(ids).toEqual([
      "plan-approve-implement",
      "dev-pr",
      "rework-pr",
      "converge-feature-artifacts",
      "pilot-approved-spec-pr",
      "pilot-issue-to-production",
      "pilot-bug-ticket-fix-pr",
      "pilot-pr-review-rework",
      "approval-pipeline",
      "research-pipeline",
    ]);
    const seeds = new Map((await readFlowSeeds(repoPath)).map((seed) => [seed.key, seed]));
    for (const entry of FLOW_TEMPLATE_ENTRIES) {
      const template = (await getFlowTemplate(repoPath, entry.id))!;
      expect(template, entry.id).toBeDefined();
      const stored = await resolveCatalogFlow(repoPath, entry.flowPath);
      expect(template.document).toBe(stored.document);
      expect(template.document).toBe(seeds.get(entry.flowPath)?.document);
      expect(template).toMatchObject({ flowPath: entry.flowPath, version: "1.0.0", edited: false });
    }
    expect(await getFlowTemplate(repoPath, "no-such-template")).toBeUndefined();
  });

  it("keeps the required inputs of templates whose Flow does not declare them", async () => {
    const repoPath = await createRepo();
    const devPr = (await getFlowTemplate(repoPath, "dev-pr"))!;
    expect(devPr.inputs.filter((input) => input.required).map((input) => input.id).sort())
      .toEqual(["spec", "tech-design"]);
    expect(devPr.taskFamily).toBe("dev.pr");
  });

  it("runs a legacy template work item from the stored document, including edits", async () => {
    const repoPath = await createRepo();
    const original = (await resolveCatalogFlow(repoPath, "flows/research-pipeline.json")).document;
    const edited = original.replace("Research the task and cite evidence.", "Research carefully.");
    expect(edited).not.toBe(original);
    await editBuiltin(repoPath, "flows/research-pipeline.json", { document: edited });

    const item = legacyTemplateWorkItem();
    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
      providerStore,
    });
    expect(starts.eligibility[item.id]?.decision).toBe("eligible");
    expect(starts.runInputs[item.id]).toMatchObject({
      flowPath: "template:research-pipeline",
      flowDocument: edited,
    });
    expect((await getFlowTemplate(repoPath, "research-pipeline"))).toMatchObject({
      document: edited,
      edited: true,
    });
  });

  it("applies a disabled built-in Flow to template work items and template creation", async () => {
    const repoPath = await createRepo();
    await editBuiltin(repoPath, "flows/research-pipeline.json", { enabled: false });

    const item = legacyTemplateWorkItem();
    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
      providerStore,
    });
    expect(starts.eligibility[item.id]).toMatchObject({
      decision: "blocked",
      blockers: [expect.objectContaining({ code: "preflight.flow-disabled" })],
    });
    const report = await evaluateWorkItemRunPreflight({ repoPath, workItem: item, providerStore });
    expect(report).toMatchObject({ status: "BLOCK", flowPath: "template:research-pipeline" });
    expect(report.issues[0]?.code).toBe("flow-disabled");

    await expect(
      createFlowWorkItem(repoPath, {
        title: "from disabled template",
        templateId: "research-pipeline",
        inputs: { "research-task": { connector: "local-file", uri: "research.md" } },
      }),
    ).rejects.toThrow(/flow is disabled/);
    expect((await listFlowTemplates(repoPath)).map((template) => template.id))
      .not.toContain("research-pipeline");
  });

  it("creates template work items with stable lineage", async () => {
    const repoPath = await createRepo();
    const created = await createFlowWorkItem(repoPath, {
      title: "from template",
      templateId: "research-pipeline",
      inputs: { "research-task": { connector: "local-file", uri: "research.md" } },
    });
    expect(created).toMatchObject({
      flowPath: "template:research-pipeline",
      template: {
        templateId: "research-pipeline",
        templateVersion: "1.0.0",
        source: "builtin",
        sourceFlowPath: "flows/research-pipeline.json",
      },
    });
  });

  it("has no Flow documents of its own", async () => {
    const source = await readFile(join(import.meta.dirname, "../../src/flows/templates.ts"), "utf8");
    expect(source).not.toContain("apiVersion");
    expect(source).not.toMatch(/kind:\s*"Flow"/);
    expect(source).not.toMatch(/document:\s*asDocument\(/);
  });
});
