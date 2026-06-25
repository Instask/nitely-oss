import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTask } from "../../src/web/tasks.js";
import { createWorkItem } from "../../src/work-items/store.js";
import {
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  taskRecordToWorkItem,
} from "../../src/work-items/adapters/dev-pr.js";

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
    const workItem = taskRecordToWorkItem({
      id: "task-1",
      title: "Implement console",
      status: "ready",
      flowPath: "flows/implement-spec-bootstrap.json",
      specPath: ".nitely/tasks/task-1/spec.md",
      techDesignPath: ".nitely/tasks/task-1/tech-design.md",
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
    });
    expect("specPath" in workItem).toBe(false);
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
      uri: ".nitely/tasks/task-1/spec.md",
    });
  });
});
