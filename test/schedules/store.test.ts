import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFactoryQueue } from "../../src/factory-queue.js";
import { materializeDueSchedules } from "../../src/schedules/materialize.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleOccurrences,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
} from "../../src/schedules/store.js";
import { getTask, listTasks } from "../../src/web/tasks.js";

async function repo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-schedules-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    }),
    "utf8",
  );
  return repoPath;
}

const template = {
  title: "Weekly repository health review",
  spec: "# Spec\n\nReview repository health.",
  techDesign: "# Design\n\nRun the health checks.",
};

const clock = (iso: string) => () => new Date(iso);

describe("schedule store", () => {
  it("creates a cron schedule with a durable next_run_at in its timezone", async () => {
    const repoPath = await repo();
    const schedule = await createSchedule(
      repoPath,
      {
        name: "weekly-health",
        trigger: { type: "cron", expression: "0 9 * * 1" },
        timezone: "Asia/Singapore",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_weekly" },
    );
    expect(schedule).toMatchObject({
      id: "sch_weekly",
      enabled: true,
      revision: 1,
      admission: "auto",
      nextRunAt: "2026-09-21T01:00:00.000Z",
    });
    // A fresh process reads the same state back from disk.
    const stored = JSON.parse(await readFile(join(repoPath, ".nitely", "schedules", "schedules.json"), "utf8"));
    expect(stored.schedules[0].nextRunAt).toBe("2026-09-21T01:00:00.000Z");
    expect((await getSchedule(repoPath, "sch_weekly")).nextRunAt).toBe("2026-09-21T01:00:00.000Z");
  });

  it("rejects invalid triggers and timezones", async () => {
    const repoPath = await repo();
    await expect(
      createSchedule(repoPath, {
        name: "bad-cron",
        trigger: { type: "cron", expression: "0 9 * *" },
        timezone: "UTC",
        template,
      }),
    ).rejects.toThrow(/five fields/);
    await expect(
      createSchedule(repoPath, {
        name: "bad-zone",
        trigger: { type: "cron", expression: "0 9 * * *" },
        timezone: "Mars/Olympus",
        template,
      }),
    ).rejects.toThrow(/timezone/);
    await expect(
      createSchedule(repoPath, {
        name: "bad-interval",
        trigger: { type: "interval", everyMs: 1000, anchorAt: "2026-01-01T00:00:00Z" },
        timezone: "UTC",
        template,
      }),
    ).rejects.toThrow(/at least/);
  });

  it("editing bumps the revision and recomputes next_run_at without touching history", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "nightly",
        trigger: { type: "cron", expression: "0 2 * * *" },
        timezone: "UTC",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_nightly" },
    );
    await materializeDueSchedules({ repoPath, now: clock("2026-09-19T02:00:00Z") });
    const updated = await updateSchedule(
      repoPath,
      "sch_nightly",
      { trigger: { type: "cron", expression: "30 3 * * *" } },
      { now: clock("2026-09-19T05:00:00Z") },
    );
    expect(updated.revision).toBe(2);
    expect(updated.nextRunAt).toBe("2026-09-20T03:30:00.000Z");
    const [occurrence] = await listScheduleOccurrences(repoPath, { scheduleId: "sch_nightly" });
    expect(occurrence.scheduleRevision).toBe(1);
    expect(occurrence.intendedFireAt).toBe("2026-09-19T02:00:00.000Z");
  });

  it("deleting a schedule keeps its occurrences and generated tasks", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "once",
        trigger: { type: "once", at: "2026-09-19T01:00:00Z" },
        timezone: "UTC",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_once" },
    );
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    expect(fired).toHaveLength(1);
    await deleteSchedule(repoPath, "sch_once");
    expect(await listSchedules(repoPath)).toEqual([]);
    expect(await listScheduleOccurrences(repoPath, { scheduleId: "sch_once" })).toHaveLength(1);
    expect(await getTask(repoPath, fired[0].workItemId!)).toMatchObject({ title: expect.stringContaining(template.title) });
  });
});

describe("schedule materialization", () => {
  it("each firing produces a distinct task and factory candidate, entered through queue admission", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "every-6h",
        trigger: { type: "interval", everyMs: 6 * 3_600_000, anchorAt: "2026-09-19T00:00:00Z" },
        timezone: "UTC",
        template: { ...template, riskClass: "low" },
      },
      { now: clock("2026-09-19T00:30:00Z"), createId: () => "sch_6h" },
    );
    const first = await materializeDueSchedules({ repoPath, repoId: "repo-1", now: clock("2026-09-19T06:00:00Z") });
    expect(first.fired).toHaveLength(1);
    expect(first.fired[0]).toMatchObject({
      scheduleId: "sch_6h",
      scheduleRevision: 1,
      intendedFireAt: "2026-09-19T06:00:00.000Z",
      materializedAt: "2026-09-19T06:00:00.000Z",
      status: "materialized",
    });
    const task = await getTask(repoPath, first.fired[0].workItemId!);
    expect(task.status).toBe("ready");
    expect(task.specStatus).toBe("approved");
    expect(task.repoId).toBe("repo-1");
    const queue = await loadFactoryQueue(repoPath);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]).toMatchObject({
      id: first.fired[0].candidateId,
      status: "queued",
      workItemId: task.id,
      // The queue normalizes identities to a lower-cased, type-prefixed key.
      source: { type: "schedule", identity: "schedule:sch_6h@2026-09-19t06:00:00.000z" },
    });

    const second = await materializeDueSchedules({ repoPath, repoId: "repo-1", now: clock("2026-09-19T12:00:00Z") });
    expect(second.fired).toHaveLength(1);
    expect(second.fired[0].workItemId).not.toBe(first.fired[0].workItemId);
    expect(second.fired[0].id).not.toBe(first.fired[0].id);
    expect(await listTasks(repoPath)).toHaveLength(2);
    expect((await getSchedule(repoPath, "sch_6h")).nextRunAt).toBe("2026-09-19T18:00:00.000Z");
  });

  it("does not fire before next_run_at, while disabled, or while paused", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "hourly",
        trigger: { type: "interval", everyMs: 3_600_000, anchorAt: "2026-09-19T00:00:00Z" },
        timezone: "UTC",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_hourly" },
    );
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T00:59:00Z") })).fired).toEqual([]);
    await setScheduleEnabled(repoPath, "sch_hourly", false, { now: clock("2026-09-19T00:59:30Z") });
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") })).fired).toEqual([]);
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T05:00:00Z") })).fired).toEqual([]);
    // Resuming recomputes the next firing from now instead of replaying the pause.
    const resumed = await setScheduleEnabled(repoPath, "sch_hourly", true, { now: clock("2026-09-19T05:10:00Z") });
    expect(resumed.nextRunAt).toBe("2026-09-19T06:00:00.000Z");
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T05:20:00Z") })).fired).toEqual([]);
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T06:00:00Z") })).fired).toHaveLength(1);
  });

  it("a one-shot schedule completes after its single occurrence", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "once",
        trigger: { type: "once", at: "2026-09-19T01:00:00Z" },
        timezone: "UTC",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_once" },
    );
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") })).fired).toHaveLength(1);
    const schedule = await getSchedule(repoPath, "sch_once");
    expect(schedule.nextRunAt).toBeUndefined();
    expect(schedule.completedAt).toBe("2026-09-19T01:00:00.000Z");
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-20T01:00:00Z") })).fired).toEqual([]);
    expect(await listTasks(repoPath)).toHaveLength(1);
  });

  it("review admission materializes a draft task that needs a human before it can run", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "reviewed",
        trigger: { type: "once", at: "2026-09-19T01:00:00Z" },
        timezone: "UTC",
        template,
        admission: "review",
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_review" },
    );
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    const task = await getTask(repoPath, fired[0].workItemId!);
    expect(task.status).toBe("draft");
    expect(task.specStatus).toBe("draft");
    const queue = await loadFactoryQueue(repoPath);
    expect(queue.candidates[0].status).toBe("needs_human");
  });

  it("survives a restart between firing and the next scan", async () => {
    const repoPath = await repo();
    await createSchedule(
      repoPath,
      {
        name: "hourly",
        trigger: { type: "interval", everyMs: 3_600_000, anchorAt: "2026-09-19T00:00:00Z" },
        timezone: "UTC",
        template,
      },
      { now: clock("2026-09-19T00:00:00Z"), createId: () => "sch_hourly" },
    );
    await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    // Nothing is held in memory: a new scan reads next_run_at from disk.
    const schedules = await listSchedules(repoPath);
    expect(schedules[0].nextRunAt).toBe("2026-09-19T02:00:00.000Z");
    expect(schedules[0].lastRunAt).toBe("2026-09-19T01:00:00.000Z");
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:30:00Z") })).fired).toEqual([]);
    expect((await materializeDueSchedules({ repoPath, now: clock("2026-09-19T02:00:00Z") })).fired).toHaveLength(1);
  });
});
