import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function createRepo() {
  const repo = await fs.mkdtemp(join(tmpdir(), "nitely-wi-perf-"));
  await fs.mkdir(join(repo, "flows"), { recursive: true });
  await fs.writeFile(join(repo, "flows/implement-spec-bootstrap.json"), "{}", "utf8");
  await fs.writeFile(join(repo, "flows/autofarm-site.json"), "{}", "utf8");
  return repo;
}

async function writeRun(repo: string, runId: string, record: Record<string, unknown>) {
  const runDirectory = join(repo, ".nitely/runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({ runId, completedStages: [], inputs: {}, ...record }, null, 2),
    "utf8",
  );
}

describe("work item view performance", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("lists persisted work items using one run directory read", async () => {
    const repo = await createRepo();
    let runDirectoryReads = 0;
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      return {
        ...actual,
        readdir: async (...args: Parameters<typeof actual.readdir>) => {
          if (String(args[0]).endsWith(`${sep}.nitely${sep}runs`)) {
            runDirectoryReads += 1;
          }
          return await actual.readdir(...args);
        },
      };
    });
    const { createTask } = await import("../../src/web/tasks.js");
    const { createWorkItem } = await import("../../src/work-items/store.js");
    const { listWorkItemViews } = await import("../../src/web/work-item-views.js");

    await createTask(
      repo,
      { title: "task one", spec: "s", techDesign: "d" },
      { createId: () => "task-1" },
    );
    await createTask(
      repo,
      { title: "task two", spec: "s", techDesign: "d" },
      { createId: () => "task-2" },
    );
    await createWorkItem(repo, {
      title: "generic work",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: {},
    });
    await writeRun(repo, "run-1", {
      status: "completed",
      inputs: { spec: { sourceUri: ".nitely/task-inputs/091-example-spec.md" } },
    });

    await expect(listWorkItemViews(repo)).resolves.toHaveLength(4);
    expect(runDirectoryReads).toBe(1);
  });
});
