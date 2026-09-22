import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTask } from "../../src/web/tasks.js";
import { createWorkItem } from "../../src/work-items/store.js";
import {
  finalizeWorkItemRunCandidate,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  prepareWorkItemRunCandidate,
  prepareWorkItemRunCandidates,
  projectWorkItem,
  resolveWorkItemCandidate,
} from "../../src/work-items/access.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-dev-pr-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  await writeFile(join(repo, "flows/autofarm-site.json"), "{}", "utf8");
  return repo;
}

describe("dev.pr work item adapter", () => {
  it("maps a legacy task record into a dev.pr work item with typed input bindings", () => {
    const workItem = projectWorkItem({
      id: "task-1",
      title: "Implement console",
      status: "ready",
      flowPath: "flows/implement-spec-bootstrap.json",
      specPath: ".nitely/tasks/task-1/spec.md",
      techDesignPath: ".nitely/tasks/task-1/tech-design.md",
      sourceDriftOverride: {
        acknowledgedAt: "2026-06-19T01:00:00.000Z",
        actor: "local",
        reason: "operator acknowledged source drift and started with override=true",
        changedFields: ["body"],
      },
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(workItem).toMatchObject({
      id: "task-1",
      workItemType: "dev.pr",
      inputs: {
        spec: { connector: "local-file", uri: ".nitely/tasks/task-1/spec.md" },
        "tech-design": {
          connector: "local-file",
          uri: ".nitely/tasks/task-1/tech-design.md",
        },
      },
      specPath: ".nitely/tasks/task-1/spec.md",
      techDesignPath: ".nitely/tasks/task-1/tech-design.md",
      sourceDriftOverride: {
        acknowledgedAt: "2026-06-19T01:00:00.000Z",
        actor: "local",
        reason: "operator acknowledged source drift and started with override=true",
        changedFields: ["body"],
      },
    });
  });

  it("lists legacy dev tasks and generic work items together", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "dev task", spec: "spec text", techDesign: "design text" },
      { createId: () => "task-1", now: () => new Date("2026-06-19T00:00:00.000Z") },
    );
    await createWorkItem(
      repoPath,
      {
        title: "autofarm site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "wi-1", now: () => new Date("2026-06-20T00:00:00.000Z") },
    );

    const items = await listUnifiedWorkItems(repoPath);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("task-1")?.workItemType).toBe("dev.pr");
    expect(byId.get("wi-1")?.workItemType).toBe("autofarm.site");
    // newest first
    expect(items[0]?.id).toBe("wi-1");
  });

  it("resolves a single work item from either store", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "dev task", spec: "spec text", techDesign: "design text" },
      { createId: () => "task-1" },
    );

    const item = await getUnifiedWorkItem(repoPath, "task-1");
    expect(item.workItemType).toBe("dev.pr");
    expect(item.inputs.spec).toEqual({
      connector: "local-file",
      uri: ".nitely/tasks/task-1/versions/spec/r1.md",
    });
  });

  it("uses one candidate seam for generic and legacy store selection", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "legacy", spec: "spec", techDesign: "design" },
      { createId: () => "legacy-1" },
    );
    await createWorkItem(
      repoPath,
      {
        title: "generic",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "generic-1" },
    );

    await expect(resolveWorkItemCandidate(repoPath, "legacy-1")).resolves.toMatchObject({
      store: "legacy-dev-pr",
      workItem: { workItemType: "dev.pr" },
    });
    await expect(resolveWorkItemCandidate(repoPath, "generic-1")).resolves.toMatchObject({
      store: "generic",
      workItem: { workItemType: "autofarm.site" },
    });
  });

  it("isolates generated execution inputs by candidate content", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      {
        title: "Isolate contenders",
        spec: "approved spec",
        techDesign: "approved design",
      },
      {
        createId: () => "isolated-candidate",
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    const prepared = await prepareWorkItemRunCandidate(
      repoPath,
      task.id,
      "manual",
    );
    expect(prepared.store).toBe("legacy-dev-pr");
    if (prepared.store !== "legacy-dev-pr") throw new Error("expected legacy candidate");
    const winner = await finalizeWorkItemRunCandidate(repoPath, prepared, {
      ...prepared.task,
      sourceDriftOverride: {
        acknowledgedAt: "2026-07-15T01:00:00.000Z",
        reason: "winner",
        changedFields: ["body"],
      },
    });
    const repeatedWinner = await finalizeWorkItemRunCandidate(
      repoPath,
      prepared,
      {
        ...prepared.task,
        sourceDriftOverride: {
          acknowledgedAt: "2026-07-15T01:00:00.000Z",
          reason: "winner",
          changedFields: ["body"],
        },
      },
    );
    const loser = await finalizeWorkItemRunCandidate(repoPath, prepared, {
      ...prepared.task,
      sourceDriftOverride: {
        acknowledgedAt: "2026-07-15T01:00:01.000Z",
        reason: "loser",
        changedFields: ["title"],
      },
    });

    expect(winner.executionInputs.workflowMetadataUri).toBe(
      repeatedWinner.executionInputs.workflowMetadataUri,
    );
    expect(loser.executionInputs.workflowMetadataUri).not.toBe(
      winner.executionInputs.workflowMetadataUri,
    );
    expect(winner.executionInputs.workflowMetadataUri).toMatch(
      /^\.nitely\/tasks\/isolated-candidate\/execution\/candidates\/[a-f0-9]{64}\/workflow-metadata\.json$/,
    );
    const winnerMetadata = JSON.parse(
      await readFile(
        join(repoPath, winner.executionInputs.workflowMetadataUri),
        "utf8",
      ),
    ) as { status: string; sourceDriftOverride: { reason: string } };
    const loserMetadata = JSON.parse(
      await readFile(
        join(repoPath, loser.executionInputs.workflowMetadataUri),
        "utf8",
      ),
    ) as { sourceDriftOverride: { reason: string } };
    expect(winnerMetadata).toMatchObject({
      status: "running",
      sourceDriftOverride: { reason: "winner" },
    });
    expect(loserMetadata.sourceDriftOverride.reason).toBe("loser");
  });

  it("prepares and finalizes a generic candidate without legacy branching", async () => {
    const repoPath = await createRepo();
    await createWorkItem(
      repoPath,
      {
        title: "generic",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "generic-1" },
    );

    const prepared = await prepareWorkItemRunCandidate(
      repoPath,
      "generic-1",
      "manual",
    );
    const finalized = await finalizeWorkItemRunCandidate(repoPath, prepared);

    expect(prepared.store).toBe("generic");
    expect(finalized).toMatchObject({
      store: "generic",
      workItem: { id: "generic-1", workItemType: "autofarm.site" },
    });
  });

  it("prepares mixed candidate stores through one collection seam", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "legacy", spec: "spec", techDesign: "design" },
      { createId: () => "legacy-1", initialStatus: "ready" },
    );
    await createWorkItem(
      repoPath,
      {
        title: "generic",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "generic-1" },
    );
    const workItems = await listUnifiedWorkItems(repoPath);

    const prepared = await prepareWorkItemRunCandidates(
      repoPath,
      workItems,
      ["legacy-1", "generic-1"],
      "automatic",
    );

    expect(prepared.candidates.get("legacy-1")?.store).toBe("legacy-dev-pr");
    expect(prepared.candidates.get("generic-1")?.store).toBe("generic");
  });
});
