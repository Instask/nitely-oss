import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTask } from "../../src/web/tasks.js";
import { createWorkItem } from "../../src/work-items/store.js";
import {
  getWorkItemView,
  listWorkItemViews,
} from "../../src/web/work-item-views.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-wi-views-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  await writeFile(join(repo, "flows/autofarm-site.json"), "{}", "utf8");
  return repo;
}

async function writeRun(
  repo: string,
  runId: string,
  record: Record<string, unknown>,
  artifacts?: unknown[],
) {
  const runDirectory = join(repo, ".nitely/runs", runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({ runId, completedStages: [], inputs: {}, ...record }, null, 2),
    "utf8",
  );
  if (artifacts) {
    await writeFile(
      join(runDirectory, "artifacts.json"),
      JSON.stringify({ runId, artifacts }, null, 2),
      "utf8",
    );
  }
}

describe("work item views", () => {
  it("builds list and detail enrichment from a supplied Work item snapshot", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "seed-a.json"), "snapshot A", "utf8");
    await writeFile(join(repo, "seed-b.json"), "persisted B", "utf8");
    const snapshot = await createWorkItem(
      repo,
      {
        title: "Snapshot view",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {
          seed: { connector: "local-file", uri: "seed-a.json" },
        },
      },
      { createId: () => "wi-snapshot" },
    );
    await writeFile(
      join(repo, ".nitely/work-items/wi-snapshot/work-item.json"),
      JSON.stringify(
        {
          ...snapshot,
          status: "running",
          inputs: {
            seed: { connector: "local-file", uri: "seed-b.json" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const views = await listWorkItemViews(repo, undefined, [snapshot]);
    const detail = await getWorkItemView(
      repo,
      snapshot.id,
      undefined,
      [snapshot],
    );

    expect(views[0]).toMatchObject({
      id: snapshot.id,
      status: "ready",
      inputs: { seed: { uri: "seed-a.json" } },
    });
    expect(detail).toMatchObject({
      id: snapshot.id,
      status: "ready",
      inputs: { seed: { uri: "seed-a.json" } },
      inputContents: { seed: "snapshot A" },
    });
  });

  it("lists legacy dev tasks and generic work items with their type", async () => {
    const repo = await createRepo();
    await createTask(
      repo,
      { title: "dev task", spec: "s", techDesign: "d" },
      { createId: () => "task-1", now: () => new Date("2026-06-19T00:00:00.000Z") },
    );
    await createWorkItem(
      repo,
      {
        title: "autofarm",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "wi-1", now: () => new Date("2026-06-20T00:00:00.000Z") },
    );

    const views = await listWorkItemViews(repo);
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get("task-1")?.workItemType).toBe("dev.pr");
    expect(byId.get("wi-1")?.workItemType).toBe("autofarm.site");
  });

  it("aggregates typed artifacts from associated runs grouped by type", async () => {
    const repo = await createRepo();
    await createWorkItem(
      repo,
      {
        title: "autofarm",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "wi-1" },
    );
    await writeRun(
      repo,
      "run-1",
      { workItemId: "wi-1", status: "completed" },
      [
        { id: "site-plan", type: "autofarm.site-plan", producer: "plan", mediaType: "application/json" },
        { id: "approve-plan", type: "gate.approval", producer: "approve-plan", mediaType: "application/vnd.nitely.gate+json", gate: { gateId: "approve-plan", state: "approved" } },
      ],
    );

    const list = await listWorkItemViews(repo);
    expect(list[0]).toMatchObject({ id: "wi-1", runCount: 1 });
    expect(list[0]?.artifacts).toEqual([]);
    expect(list[0]?.artifactsByType).toEqual([]);

    const detail = await getWorkItemView(repo, "wi-1");
    expect(detail.runCount).toBe(1);
    const types = detail.artifactsByType.map((group) => group.type).sort();
    expect(types).toEqual(["autofarm.site-plan", "gate.approval"]);
    const gateGroup = detail.artifactsByType.find(
      (group) => group.type === "gate.approval",
    );
    expect(gateGroup?.artifacts[0]?.gate?.state).toBe("approved");
  });

  it("exposes orphan historical runs as inferred work items", async () => {
    const repo = await createRepo();
    await writeRun(repo, "run-083-b", {
      flowName: "implement-spec-bootstrap",
      inputs: { spec: { sourceUri: ".nitely/task-inputs/083-unified-task-console-rework-spec.md" } },
      status: "failed",
    });
    await writeRun(repo, "run-083-a", {
      flowName: "implement-spec-bootstrap",
      inputs: { spec: { sourceUri: "specs/issues/083-unified-task-console-spec.md" } },
      status: "completed",
    });
    await writeRun(repo, "run-pr-51", {
      flowName: "rework-pr-bootstrap",
      inputs: { spec: { sourceUri: ".nitely/rework-inputs/pr-51-spec.md" } },
      trigger: { prNumber: 51, prUrl: "https://github.com/Instask/nitely/pull/51" },
      changeRequestUrl: "https://github.com/Instask/nitely/pull/51",
      status: "completed",
    });
    await writeRun(repo, "run-no-inputs", {
      flowName: "implement-spec-bootstrap",
      inputs: {},
      status: "incomplete",
    });

    const views = await listWorkItemViews(repo);
    const byId = new Map(views.map((view) => [view.id, view]));

    expect(byId.get("inferred-issue-083")).toMatchObject({
      source: "inferred",
      inferred: true,
      workItemType: "dev.pr",
      runCount: 2,
      latestRun: { runId: "run-083-b" },
    });
    expect(byId.get("inferred-pr-51")).toMatchObject({
      source: "inferred",
      inferred: true,
      runCount: 1,
      changeRequestUrl: "https://github.com/Instask/nitely/pull/51",
    });
    expect(byId.get("inferred-run-run-no-inputs")).toMatchObject({
      source: "inferred",
      inferred: true,
      runCount: 1,
    });

    await expect(getWorkItemView(repo, "inferred-issue-083")).resolves.toMatchObject({
      id: "inferred-issue-083",
      source: "inferred",
      runs: [{ runId: "run-083-b" }, { runId: "run-083-a" }],
    });
  });
});
