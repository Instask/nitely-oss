import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WebInputError, WebNotFoundError } from "../../src/web/errors.js";
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
} from "../../src/work-items/store.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-work-items-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(join(repo, "flows/autofarm-site.json"), "{}", "utf8");
  return repo;
}

describe("work item store", () => {
  it("creates, persists, and reads a non-dev work item without spec or tech-design", async () => {
    const repoPath = await createRepo();

    const created = await createWorkItem(
      repoPath,
      {
        title: "Build affiliate site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {
          seed: { connector: "local-file", uri: "seeds/keywords.json" },
        },
      },
      {
        createId: () => "wi-test",
        now: () => new Date("2026-06-20T00:00:00.000Z"),
      },
    );

    expect(created).toMatchObject({
      id: "wi-test",
      title: "Build affiliate site",
      status: "ready",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: { seed: { connector: "local-file", uri: "seeds/keywords.json" } },
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    expect("specPath" in created).toBe(false);

    const persisted = JSON.parse(
      await readFile(
        join(repoPath, ".nitely/work-items/wi-test/work-item.json"),
        "utf8",
      ),
    );
    expect(persisted.workItemType).toBe("autofarm.site");

    await expect(getWorkItem(repoPath, "wi-test")).resolves.toMatchObject({
      id: "wi-test",
      workItemType: "autofarm.site",
    });
  });

  it("rejects an invalid work item type", async () => {
    const repoPath = await createRepo();

    await expect(
      createWorkItem(repoPath, {
        title: "Bad",
        workItemType: "not a type",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("throws WebNotFoundError for a missing work item", async () => {
    const repoPath = await createRepo();
    await expect(getWorkItem(repoPath, "missing")).rejects.toBeInstanceOf(
      WebNotFoundError,
    );
  });

  it("lists generic work items sorted by creation time descending", async () => {
    const repoPath = await createRepo();
    await createWorkItem(
      repoPath,
      {
        title: "first",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "wi-1", now: () => new Date("2026-06-20T00:00:00.000Z") },
    );
    await createWorkItem(
      repoPath,
      {
        title: "second",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
      },
      { createId: () => "wi-2", now: () => new Date("2026-06-20T01:00:00.000Z") },
    );

    const items = await listWorkItems(repoPath);
    expect(items.map((item) => item.id)).toEqual(["wi-2", "wi-1"]);
  });

  it("updates run state without dropping inputs", async () => {
    const repoPath = await createRepo();
    await createWorkItem(
      repoPath,
      {
        title: "first",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "s.json" } },
      },
      { createId: () => "wi-1" },
    );

    const updated = await updateWorkItem(repoPath, "wi-1", {
      status: "completed",
      latestRunId: "run-1",
      changeRequestUrl: "https://example.com/pr/1",
    });

    expect(updated.status).toBe("completed");
    expect(updated.latestRunId).toBe("run-1");
    expect(updated.inputs).toEqual({
      seed: { connector: "local-file", uri: "s.json" },
    });
  });

  it("persists planning approval metadata on generic work items", async () => {
    const repoPath = await createRepo();
    const created = await createWorkItem(
      repoPath,
      {
        title: "planned work",
        workItemType: "dev.pr",
        flowPath: "flows/autofarm-site.json",
        inputs: {},
        planning: {
          artifacts: {
            spec: { path: "spec.md", state: "draft_spec" },
          },
          events: [],
        },
      },
      { createId: () => "wi-planned" },
    );

    expect(created.planning?.artifacts.spec?.state).toBe("draft_spec");
    await expect(getWorkItem(repoPath, "wi-planned")).resolves.toMatchObject({
      planning: {
        artifacts: {
          spec: { path: "spec.md", state: "draft_spec" },
        },
      },
    });
  });
});
