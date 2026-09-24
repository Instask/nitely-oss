import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTask } from "../../src/web/tasks.js";
import {
  getTaskWorkItemDetail,
  listRunsForTask,
  listTaskWorkItems,
} from "../../src/web/work-items.js";

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-work-items-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  return repoPath;
}

async function writeRun(
  repoPath: string,
  runId: string,
  value: Record<string, unknown>,
  stdout?: string,
) {
  const runDirectory = join(repoPath, ".nitely/runs", runId);
  await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({ runId, completedStages: ["implement"], inputs: {}, ...value }, null, 2),
    "utf8",
  );
  if (stdout !== undefined) {
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      stdout,
      "utf8",
    );
  }
}

describe("web task work-item projection", () => {
  it("associates runs through task inputs and latestRunId newest first", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      { title: "Unify work items", spec: "Spec", techDesign: "Design" },
      { createId: () => "task-work-item" },
    );

    await writeRun(repoPath, "run-001", {
      inputs: { spec: { sourceUri: task.specPath } },
      changeRequestUrl: "https://github.com/example/repo/pull/1",
    });
    await writeRun(repoPath, "run-003", {
      inputs: { "tech-design": { sourceUri: task.techDesignPath } },
      status: "failed",
    });
    await writeRun(repoPath, "run-002", {
      inputs: { spec: { sourceUri: ".nitely/tasks/other/spec.md" } },
    });

    const taskWithLatestOnly = { ...task, latestRunId: "run-002" };

    await expect(listRunsForTask(repoPath, taskWithLatestOnly)).resolves.toMatchObject([
      { runId: "run-003" },
      { runId: "run-002" },
      { runId: "run-001" },
    ]);
  });

  // A task's runs are derived by filtering the repository-wide listing, so any
  // page cap on that listing empties the run list of every task whose runs are
  // not among the newest. #518's scan cost has to be paid per run, not by
  // hiding older ones.
  it("keeps an older task's runs visible as newer unrelated runs accumulate", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      { title: "Long lived", spec: "Spec", techDesign: "Design" },
      { createId: () => "task-long-lived" },
    );

    await writeRun(repoPath, "run-000", { workItemId: "task-long-lived" });
    for (let index = 0; index < 60; index += 1) {
      await writeRun(repoPath, `run-${String(100 + index)}`, {
        workItemId: "task-unrelated",
      });
    }

    await expect(listRunsForTask(repoPath, task)).resolves.toMatchObject([
      { runId: "run-000" },
    ]);
  });

  it("associates a run by work item id without spec or tech-design inputs", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      { title: "By id", spec: "Spec", techDesign: "Design" },
      { createId: () => "task-by-id" },
    );

    await writeRun(repoPath, "run-id-1", {
      workItemId: "task-by-id",
      inputs: { seed: { sourceUri: "seeds/keywords.json" } },
    });

    await expect(listRunsForTask(repoPath, task)).resolves.toMatchObject([
      { runId: "run-id-1" },
    ]);
  });

  it("enriches task list and detail with run attempts and latest execution fields", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      {
        title: "Expose task runs",
        spec: "Spec body",
        techDesign: "Design body",
      },
      { createId: () => "task-enriched" },
    );
    await writeRun(
      repoPath,
      "run-010",
      {
        inputs: { spec: { sourceUri: task.specPath } },
        changeRequestUrl: "https://github.com/example/repo/pull/10",
      },
      "Preparing worktree\npnpm run check passed\n",
    );

    const items = await listTaskWorkItems(repoPath);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "task-enriched",
      runCount: 1,
      latestRun: {
        runId: "run-010",
        currentStage: "implement",
        recentLogSummary: "pnpm run check passed",
      },
      currentStage: "implement",
      latestChangeRequestUrl: "https://github.com/example/repo/pull/10",
      recentLogSummary: "pnpm run check passed",
    });

    await expect(getTaskWorkItemDetail(repoPath, task.id)).resolves.toMatchObject({
      task: { id: "task-enriched" },
      spec: "Spec body",
      techDesign: "Design body",
      runs: [
        {
          runId: "run-010",
          currentStage: "implement",
          recentLogSummary: "pnpm run check passed",
        },
      ],
    });
  });
});
