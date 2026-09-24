import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { loadFactoryQueue } from "../../src/factory-queue.js";
import { eventStorePath } from "../../src/run/project.js";
import { materializeDueSchedules } from "../../src/schedules/materialize.js";
import {
  createSchedule,
  getSchedule,
  listScheduleOccurrences,
  listScheduleOccurrencesWithLineage,
  setScheduleEnabled,
} from "../../src/schedules/store.js";
import { createTask, getTask, listTasks, updateTaskRunState } from "../../src/web/tasks.js";

async function repo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-schedule-reliability-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: { stages: [{ id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] }] },
    }),
    "utf8",
  );
  return repoPath;
}

const template = { title: "Hourly check", spec: "# Spec\n\nCheck.", techDesign: "# Design\n\nDo it." };
const clock = (iso: string) => () => new Date(iso);
const hourly = { type: "interval" as const, everyMs: 3_600_000, anchorAt: "2026-09-19T00:00:00Z" };

async function hourlySchedule(repoPath: string, extra: Record<string, unknown> = {}) {
  return createSchedule(
    repoPath,
    { name: "hourly", trigger: hourly, timezone: "UTC", template, ...extra } as Parameters<typeof createSchedule>[1],
    { now: clock("2026-09-19T00:30:00Z"), createId: () => "sch_hourly" },
  );
}

describe("idempotent, crash-safe firing", () => {
  it("repeated scans at the same instant never duplicate an occurrence, task or candidate", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath);
    const first = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    const second = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    expect(first.fired).toHaveLength(1);
    expect(second.fired).toEqual([]);
    expect(await listTasks(repoPath)).toHaveLength(1);
    expect((await loadFactoryQueue(repoPath)).candidates).toHaveLength(1);
    expect(await listScheduleOccurrences(repoPath)).toHaveLength(1);
  });

  it("the occurrence is persisted before its task, and the task id is derived from it", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath);
    let calls = 0;
    // Crash right after the task has been written but before anything else.
    await expect(
      materializeDueSchedules({
        repoPath,
        now: clock("2026-09-19T01:00:00Z"),
        createTask: async (path, input, options) => {
          calls += 1;
          const task = await createTask(path, input, options);
          throw new Error("power loss");
        },
      }),
    ).rejects.toThrow(/power loss/);
    expect(calls).toBe(1);
    const [pending] = await listScheduleOccurrences(repoPath);
    expect(pending).toMatchObject({ status: "pending", intendedFireAt: "2026-09-19T01:00:00.000Z" });
    expect(await listTasks(repoPath)).toHaveLength(1);
    // The schedule did not advance, so the next scan recovers the same occurrence.
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-09-19T01:00:00.000Z");

    const recovered = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:05:00Z") });
    expect(recovered.fired).toHaveLength(1);
    expect(recovered.fired[0]).toMatchObject({ id: pending.id, status: "materialized" });
    const tasks = await listTasks(repoPath);
    expect(tasks).toHaveLength(1);
    expect(recovered.fired[0].workItemId).toBe(tasks[0].id);
    expect(tasks[0].id).toBe(`task-${pending.id}`);
    expect((await loadFactoryQueue(repoPath)).candidates).toHaveLength(1);
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-09-19T02:00:00.000Z");
  });

  it("a crash after the candidate but before the schedule advanced is repaired without new work", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath);
    await expect(
      materializeDueSchedules({
        repoPath,
        now: clock("2026-09-19T01:00:00Z"),
        upsertCandidate: async (input) => {
          const { upsertFactoryCandidate } = await import("../../src/factory-queue.js");
          const candidate = await upsertFactoryCandidate(input);
          throw Object.assign(new Error("crash after candidate"), { candidate });
        },
      }),
    ).rejects.toThrow(/crash after candidate/);
    const recovered = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:01:00Z") });
    expect(recovered.fired).toHaveLength(1);
    expect(await listTasks(repoPath)).toHaveLength(1);
    expect((await loadFactoryQueue(repoPath)).candidates).toHaveLength(1);
    expect(await listScheduleOccurrences(repoPath)).toHaveLength(1);
  });
});

describe("misfire policy", () => {
  it("fires normally when the scan is only slightly late", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { misfire: { policy: "skip" } });
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:02:00Z") });
    expect(fired).toHaveLength(1);
    expect(fired[0].intendedFireAt).toBe("2026-09-19T01:00:00.000Z");
  });

  it("skip records every missed occurrence as skipped and creates no work", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { misfire: { policy: "skip" } });
    const { fired, skipped } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T04:30:00Z") });
    expect(fired).toEqual([]);
    expect(skipped.map((o) => [o.intendedFireAt, o.status, o.reason])).toEqual([
      ["2026-09-19T01:00:00.000Z", "skipped", "misfire: skip policy"],
      ["2026-09-19T02:00:00.000Z", "skipped", "misfire: skip policy"],
      ["2026-09-19T03:00:00.000Z", "skipped", "misfire: skip policy"],
      ["2026-09-19T04:00:00.000Z", "skipped", "misfire: skip policy"],
    ]);
    expect(await listTasks(repoPath)).toEqual([]);
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-09-19T05:00:00.000Z");
  });

  it("run_once_now (the default) fires one occurrence for the latest missed time and skips the rest", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath);
    const { fired, skipped } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T04:30:00Z") });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      intendedFireAt: "2026-09-19T04:00:00.000Z",
      materializedAt: "2026-09-19T04:30:00.000Z",
      status: "materialized",
      reason: "misfire: run_once_now policy",
    });
    expect(skipped.map((o) => o.intendedFireAt)).toEqual([
      "2026-09-19T01:00:00.000Z",
      "2026-09-19T02:00:00.000Z",
      "2026-09-19T03:00:00.000Z",
    ]);
    expect(await listTasks(repoPath)).toHaveLength(1);
  });

  it("catch_up materializes at most its limit, oldest first, and skips the remainder", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { misfire: { policy: "catch_up", limit: 2 } });
    const { fired, skipped } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T04:30:00Z") });
    expect(fired.map((o) => o.intendedFireAt)).toEqual([
      "2026-09-19T01:00:00.000Z",
      "2026-09-19T02:00:00.000Z",
    ]);
    expect(skipped.map((o) => o.intendedFireAt)).toEqual([
      "2026-09-19T03:00:00.000Z",
      "2026-09-19T04:00:00.000Z",
    ]);
    expect(await listTasks(repoPath)).toHaveLength(2);
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-09-19T05:00:00.000Z");
  });

  it("never records an unbounded backlog after long downtime", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { misfire: { policy: "skip" } });
    const { fired, skipped } = await materializeDueSchedules({ repoPath, now: clock("2026-10-19T00:30:00Z") });
    expect(fired).toEqual([]);
    expect(skipped.length).toBeLessThanOrEqual(26);
    expect(skipped.at(-1)?.reason).toMatch(/further occurrences/);
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-10-19T01:00:00.000Z");
  });

  it("rejects an unbounded catch-up limit", async () => {
    const repoPath = await repo();
    await expect(hourlySchedule(repoPath, { misfire: { policy: "catch_up", limit: 500 } })).rejects.toThrow(/limit/);
  });
});

describe("overlap policy", () => {
  async function fireAndStart(repoPath: string) {
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    await updateTaskRunState(repoPath, fired[0].workItemId!, { status: "running", latestRunId: "run-prev" });
    return fired[0];
  }

  it("skip does not materialize while the previous occurrence is still active", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { overlap: "skip" });
    await fireAndStart(repoPath);
    const { fired, skipped } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T02:00:00Z") });
    expect(fired).toEqual([]);
    expect(skipped[0]).toMatchObject({ intendedFireAt: "2026-09-19T02:00:00.000Z", reason: "overlap: previous occurrence still active" });
    expect(await listTasks(repoPath)).toHaveLength(1);
    expect((await getSchedule(repoPath, "sch_hourly")).nextRunAt).toBe("2026-09-19T03:00:00.000Z");
  });

  it("queue materializes the next occurrence behind the active one", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { overlap: "queue" });
    const previous = await fireAndStart(repoPath);
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T02:00:00Z") });
    expect(fired).toHaveLength(1);
    const task = await getTask(repoPath, fired[0].workItemId!);
    expect(task.dependsOn).toEqual([previous.workItemId]);
  });

  it("allow materializes regardless of the previous occurrence", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { overlap: "allow" });
    await fireAndStart(repoPath);
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T02:00:00Z") });
    expect(fired).toHaveLength(1);
    expect((await getTask(repoPath, fired[0].workItemId!)).dependsOn).toEqual([]);
  });
});

describe("history and lineage", () => {
  it("records schedule → task → run lineage and emits events", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath, { misfire: { policy: "skip" } });
    const { fired } = await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    await updateTaskRunState(repoPath, fired[0].workItemId!, { status: "completed", latestRunId: "run-42" });
    await materializeDueSchedules({ repoPath, now: clock("2026-09-19T03:30:00Z") });
    const history = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId: "sch_hourly" });
    expect(history[0]).toMatchObject({
      status: "materialized",
      scheduleRevision: 1,
      intendedFireAt: "2026-09-19T01:00:00.000Z",
      workItemId: fired[0].workItemId,
      candidateId: fired[0].candidateId,
      lineage: { taskStatus: "completed", runId: "run-42", candidateStatus: expect.any(String) },
    });
    expect(history.filter((o) => o.status === "skipped")).toHaveLength(2);
    const store = new EventStore(eventStorePath(repoPath));
    try {
      const types = store.list(fired[0].id).map((event) => event.type);
      expect(types).toContain("schedule.occurrence.materialized");
      const skippedId = history.find((o) => o.status === "skipped")!.id;
      expect(store.list(skippedId).map((event) => event.type)).toContain("schedule.occurrence.skipped");
    } finally {
      store.close();
    }
  });

  it("disabling a schedule keeps its history", async () => {
    const repoPath = await repo();
    await hourlySchedule(repoPath);
    await materializeDueSchedules({ repoPath, now: clock("2026-09-19T01:00:00Z") });
    await setScheduleEnabled(repoPath, "sch_hourly", false);
    expect(await listScheduleOccurrences(repoPath)).toHaveLength(1);
    expect(await listTasks(repoPath)).toHaveLength(1);
  });
});
