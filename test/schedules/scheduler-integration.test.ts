import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFactoryQueue } from "../../src/factory-queue.js";
import { runSchedulerOnce } from "../../src/scheduler/run.js";
import { createSchedule, listScheduleOccurrences } from "../../src/schedules/store.js";
import { listTasks } from "../../src/web/tasks.js";
import type { RunFlowResult } from "../../src/run/run-flow.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-schedule-scheduler-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    "utf8",
  );
  return repo;
}

describe("schedules in the execution scheduler cycle", () => {
  it("a scheduler cycle materializes due schedules and then runs the new task through admission", async () => {
    const repoPath = await createRepo();
    await createSchedule(
      repoPath,
      {
        name: "nightly-maintenance",
        trigger: { type: "cron", expression: "0 2 * * *" },
        timezone: "UTC",
        template: {
          title: "Nightly dependency maintenance",
          spec: "# Spec\n\nUpdate dependencies.",
          techDesign: "# Design\n\nRun the updater.",
        },
      },
      { now: () => new Date("2026-09-19T00:00:00Z"), createId: () => "sch_nightly" },
    );
    const started: string[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-09-19T02:00:00Z"),
      runFlow: async (input, dependencies): Promise<RunFlowResult> => {
        started.push(input.workItemId ?? "missing");
        const runId = dependencies?.createRunId?.() ?? "run-1";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: `/tmp/${runId}`,
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
        };
      },
    });
    const tasks = await listTasks(repoPath);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain("Nightly dependency maintenance");
    expect(summary.startedTaskIds).toEqual([tasks[0].id]);
    expect(started).toEqual([tasks[0].id]);
    const [occurrence] = await listScheduleOccurrences(repoPath);
    expect(occurrence.workItemId).toBe(tasks[0].id);
    // The occurrence entered the Factory Queue rather than bypassing it.
    const queue = await loadFactoryQueue(repoPath);
    expect(queue.candidates.map((c) => c.workItemId)).toEqual([tasks[0].id]);
  });

  it("a cycle limited to explicit candidates does not fire schedules", async () => {
    const repoPath = await createRepo();
    await createSchedule(
      repoPath,
      {
        name: "nightly",
        trigger: { type: "cron", expression: "0 2 * * *" },
        timezone: "UTC",
        template: { title: "Nightly", spec: "spec", techDesign: "td" },
      },
      { now: () => new Date("2026-09-19T00:00:00Z") },
    );
    await runSchedulerOnce({
      repoPath,
      candidateIds: ["task-not-there"],
      now: () => new Date("2026-09-19T02:00:00Z"),
      runFlow: async () => {
        throw new Error("must not run");
      },
    });
    expect(await listTasks(repoPath)).toEqual([]);
  });
});
