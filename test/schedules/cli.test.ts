import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import {
  getSchedule,
  listScheduleOccurrencesWithLineage,
  listSchedules,
} from "../../src/schedules/store.js";
import type {
  ScheduleOccurrenceWithLineage,
  ScheduleRecord,
  ScheduleTrigger,
} from "../../src/schedules/types.js";
import { listTasks, updateTaskRunState } from "../../src/web/tasks.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-schedule-cli-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: { stages: [{ id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] }] },
    }),
    "utf8",
  );
  await writeFile(join(repo, "spec.md"), "# Spec\n\nReview.", "utf8");
  await writeFile(join(repo, "design.md"), "# Design\n\nCheck.", "utf8");
  return repo;
}

async function cli(argv: string[], now?: () => Date) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    argv,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    now ? { now } : {},
  );
  return { code, stdout, stderr };
}

// Mirrors the trigger description already used by `nitely schedule list`
// (src/cli.ts `describeTrigger`), which the show subcommand's tech design
// says to reuse rather than reinvent.
function describeTriggerForAssertions(trigger: ScheduleTrigger): string {
  switch (trigger.type) {
    case "cron":
      return `cron ${trigger.expression}`;
    case "interval":
      return `every ${trigger.everyMs / 60_000}m`;
    case "once":
      return `once ${trigger.at}`;
  }
}

// Independent oracle for `nitely schedule show`'s text output, built directly
// from the tech design's literal output template rather than from the CLI
// implementation under test.
function expectedShowLines(
  schedule: ScheduleRecord,
  occurrences: ScheduleOccurrenceWithLineage[],
): string[] {
  const state = schedule.enabled ? (schedule.completedAt ? "completed" : "enabled") : "paused";
  const misfireLimit = schedule.misfire.limit !== undefined ? `(${schedule.misfire.limit})` : "";
  const lines = [
    `${schedule.id}  ${schedule.name}`,
    `trigger: ${describeTriggerForAssertions(schedule.trigger)} ${schedule.timezone}`,
    `state: ${state}   revision: ${schedule.revision}   admission: ${schedule.admission}`,
    `misfire: ${schedule.misfire.policy}${misfireLimit}   overlap: ${schedule.overlap}`,
    `next: ${schedule.nextRunAt ?? "-"} last: ${schedule.lastRunAt ?? "-"}`,
  ];
  if (occurrences.length === 0) {
    lines.push("History: none");
    return lines;
  }
  lines.push(`History (${occurrences.length}):`);
  for (const occurrence of [...occurrences].reverse()) {
    const parts = [
      occurrence.status,
      occurrence.intendedFireAt,
      `materialized ${occurrence.materializedAt}`,
      `rev ${occurrence.scheduleRevision}`,
    ];
    if (occurrence.reason) parts.push(occurrence.reason);
    if (occurrence.workItemId) {
      parts.push(`task ${occurrence.workItemId} (${occurrence.lineage.taskStatus ?? "missing"})`);
    }
    if (occurrence.lineage.runId) parts.push(`run ${occurrence.lineage.runId}`);
    lines.push(`  ${parts.join("\t")}`);
  }
  return lines;
}

describe("nitely schedule", () => {
  it("creates, lists, pauses, resumes, ticks and deletes schedules", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath,
        "--name", "weekly-health",
        "--cron", "0 9 * * 1",
        "--timezone", "Asia/Singapore",
        "--title", "Weekly repository health review",
        "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"),
        "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    expect(created.stderr).toEqual([]);
    expect(created.code).toBe(0);
    const schedule = JSON.parse(created.stdout.join("\n")).schedule;
    expect(schedule).toMatchObject({
      name: "weekly-health",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      nextRunAt: "2026-09-21T01:00:00.000Z",
    });

    const listed = await cli(["schedule", "list", "--repo", repoPath]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.join("\n")).toContain("weekly-health");
    expect(listed.stdout.join("\n")).toContain("2026-09-21T01:00:00.000Z");

    const paused = await cli(["schedule", "pause", schedule.id, "--repo", repoPath]);
    expect(paused.code).toBe(0);
    expect((await listSchedules(repoPath))[0].enabled).toBe(false);
    const resumed = await cli(
      ["schedule", "resume", schedule.id, "--repo", repoPath],
      () => new Date("2026-09-21T00:00:00Z"),
    );
    expect(resumed.code).toBe(0);
    expect((await listSchedules(repoPath))[0].nextRunAt).toBe("2026-09-21T01:00:00.000Z");

    const ticked = await cli(
      ["schedule", "tick", "--repo", repoPath, "--json"],
      () => new Date("2026-09-21T01:00:00Z"),
    );
    expect(ticked.code).toBe(0);
    expect(JSON.parse(ticked.stdout.join("\n")).fired).toHaveLength(1);
    expect(await listTasks(repoPath)).toHaveLength(1);

    const deleted = await cli(["schedule", "delete", schedule.id, "--repo", repoPath]);
    expect(deleted.code).toBe(0);
    expect(await listSchedules(repoPath)).toEqual([]);
  });

  it("supports interval and one-shot triggers and rejects an incomplete definition", async () => {
    const repoPath = await createRepo();
    const interval = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "six-hourly", "--every", "6h",
        "--title", "Six hourly", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    expect(interval.code).toBe(0);
    expect(JSON.parse(interval.stdout.join("\n")).schedule.trigger).toEqual({
      type: "interval",
      everyMs: 6 * 3_600_000,
      anchorAt: "2026-09-19T00:00:00.000Z",
    });
    const once = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "later", "--at", "2026-10-01T09:00:00Z",
        "--title", "Later", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    expect(JSON.parse(once.stdout.join("\n")).schedule.trigger).toEqual({
      type: "once",
      at: "2026-10-01T09:00:00.000Z",
    });
    const missing = await cli(["schedule", "create", "--repo", repoPath, "--name", "x", "--title", "x"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.join("\n")).toMatch(/--cron, --every or --at/);
  });
});

describe("nitely schedule policies", () => {
  it("accepts misfire and overlap policies on create and shows them in list", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "guarded", "--every", "1h",
        "--misfire", "catch_up", "--catch-up-limit", "3", "--overlap", "skip",
        "--title", "Guarded", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    expect(created.stderr).toEqual([]);
    expect(JSON.parse(created.stdout.join("\n")).schedule).toMatchObject({
      misfire: { policy: "catch_up", limit: 3 },
      overlap: "skip",
    });
    const listed = await cli(["schedule", "list", "--repo", repoPath]);
    expect(listed.stdout.join("\n")).toContain("misfire catch_up(3)");
    expect(listed.stdout.join("\n")).toContain("overlap skip");
    const bad = await cli([
      "schedule", "create", "--repo", repoPath, "--name", "bad", "--every", "1h", "--misfire", "maybe",
      "--title", "Bad", "--spec-file", join(repoPath, "spec.md"), "--tech-design-file", join(repoPath, "design.md"),
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr.join("\n")).toMatch(/--misfire must be/);
  });
});

describe("nitely schedule show", () => {
  it("prints the definition block and newest-first occurrence history for a fired schedule", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "hourly-report", "--every", "1h",
        "--title", "Hourly report", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const scheduleId = JSON.parse(created.stdout.join("\n")).schedule.id;

    const firstTick = await cli(
      ["schedule", "tick", "--repo", repoPath, "--json"],
      () => new Date("2026-09-19T01:00:00Z"),
    );
    const firstOccurrence = JSON.parse(firstTick.stdout.join("\n")).fired[0];
    // Simulate the task having run once, so the "run <id>" branch is exercised.
    await updateTaskRunState(repoPath, firstOccurrence.workItemId, {
      status: "completed",
      latestRunId: "run-1",
    });

    const secondTick = await cli(
      ["schedule", "tick", "--repo", repoPath, "--json"],
      () => new Date("2026-09-19T02:00:00Z"),
    );
    const secondOccurrence = JSON.parse(secondTick.stdout.join("\n")).fired[0];

    const schedule = await getSchedule(repoPath, scheduleId);
    const occurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId });
    expect(occurrences).toHaveLength(2);

    const shown = await cli(["schedule", "show", scheduleId, "--repo", repoPath]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toEqual([]);

    expect(shown.stdout[0]).toBe(`${scheduleId}  hourly-report`);
    expect(shown.stdout[1]).toBe("trigger: every 60m UTC");
    expect(shown.stdout[2]).toBe("state: enabled   revision: 1   admission: auto");
    expect(shown.stdout[3]).toBe("misfire: run_once_now   overlap: allow");
    expect(shown.stdout[4]).toBe(`next: ${schedule.nextRunAt} last: ${schedule.lastRunAt}`);
    expect(shown.stdout[5]).toBe("History (2):");
    // Newest occurrence (the second tick) prints first.
    expect(shown.stdout[6]).toContain(secondOccurrence.intendedFireAt);
    expect(shown.stdout[6]).toContain(`task ${secondOccurrence.workItemId} (ready)`);
    expect(shown.stdout[6]).not.toContain("run ");
    expect(shown.stdout[7]).toContain(firstOccurrence.intendedFireAt);
    expect(shown.stdout[7]).toContain(`task ${firstOccurrence.workItemId} (completed)`);
    expect(shown.stdout[7]).toContain("run run-1");
    expect(shown.stdout).toHaveLength(8);
    expect(shown.stdout).toEqual(expectedShowLines(schedule, occurrences));
  });

  it("prints History: none for a schedule with no occurrences", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "future-once", "--at", "2026-12-01T00:00:00Z",
        "--title", "Future once", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const scheduleId = JSON.parse(created.stdout.join("\n")).schedule.id;

    const schedule = await getSchedule(repoPath, scheduleId);
    const occurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId });
    expect(occurrences).toEqual([]);

    const shown = await cli(["schedule", "show", scheduleId, "--repo", repoPath]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toEqual(expectedShowLines(schedule, occurrences));
    expect(shown.stdout.at(-1)).toBe("History: none");
    expect(shown.stdout).toHaveLength(6);
  });

  it("shows a skipped occurrence's misfire reason in the history", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "skip-misfires", "--every", "1h",
        "--misfire", "skip", "--title", "Skip misfires", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const scheduleId = JSON.parse(created.stdout.join("\n")).schedule.id;

    // Due at 01:00:00Z; ticking 10 minutes late exceeds the default 5 minute
    // grace, so the `skip` misfire policy records a skipped occurrence.
    const ticked = await cli(["schedule", "tick", "--repo", repoPath], () => new Date("2026-09-19T01:10:00Z"));
    expect(ticked.code).toBe(0);

    const schedule = await getSchedule(repoPath, scheduleId);
    const occurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId });
    expect(occurrences).toMatchObject([{ status: "skipped", reason: "misfire: skip policy" }]);

    const shown = await cli(["schedule", "show", scheduleId, "--repo", repoPath]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toEqual(expectedShowLines(schedule, occurrences));
    expect(shown.stdout.join("\n")).toContain("misfire: skip policy");
  });

  it("shows paused and completed schedule states", async () => {
    const repoPath = await createRepo();
    const pausableCreated = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "pausable", "--every", "1h",
        "--title", "Pausable", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const pausableId = JSON.parse(pausableCreated.stdout.join("\n")).schedule.id;
    const paused = await cli(["schedule", "pause", pausableId, "--repo", repoPath]);
    expect(paused.code).toBe(0);

    const pausedSchedule = await getSchedule(repoPath, pausableId);
    const pausedOccurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId: pausableId });
    const pausedShown = await cli(["schedule", "show", pausableId, "--repo", repoPath]);
    expect(pausedShown.code).toBe(0);
    expect(pausedShown.stdout).toEqual(expectedShowLines(pausedSchedule, pausedOccurrences));
    expect(pausedShown.stdout.join("\n")).toContain("state: paused");

    const onceCreated = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "one-shot", "--at", "2026-09-19T00:30:00Z",
        "--title", "One shot", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const onceId = JSON.parse(onceCreated.stdout.join("\n")).schedule.id;
    const onceTicked = await cli(["schedule", "tick", "--repo", repoPath], () => new Date("2026-09-19T00:30:00Z"));
    expect(onceTicked.code).toBe(0);

    const completedSchedule = await getSchedule(repoPath, onceId);
    expect(completedSchedule.completedAt).toBeDefined();
    const completedOccurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId: onceId });
    const completedShown = await cli(["schedule", "show", onceId, "--repo", repoPath]);
    expect(completedShown.code).toBe(0);
    expect(completedShown.stdout).toEqual(expectedShowLines(completedSchedule, completedOccurrences));
    expect(completedShown.stdout.join("\n")).toContain("state: completed");
  });

  it("--json prints the schedule and lineage-joined occurrences newest first, without repository fields", async () => {
    const repoPath = await createRepo();
    const created = await cli(
      [
        "schedule", "create", "--repo", repoPath, "--name", "json-report", "--every", "1h",
        "--title", "JSON report", "--spec-file", join(repoPath, "spec.md"),
        "--tech-design-file", join(repoPath, "design.md"), "--json",
      ],
      () => new Date("2026-09-19T00:00:00Z"),
    );
    const scheduleId = JSON.parse(created.stdout.join("\n")).schedule.id;

    await cli(["schedule", "tick", "--repo", repoPath], () => new Date("2026-09-19T01:00:00Z"));
    await cli(["schedule", "tick", "--repo", repoPath], () => new Date("2026-09-19T02:00:00Z"));

    const schedule = await getSchedule(repoPath, scheduleId);
    const occurrences = await listScheduleOccurrencesWithLineage(repoPath, { scheduleId });
    expect(occurrences).toHaveLength(2);
    const expectedOccurrencesNewestFirst = [...occurrences].reverse();

    const shown = await cli(["schedule", "show", scheduleId, "--repo", repoPath, "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toEqual([]);
    const parsed = JSON.parse(shown.stdout.join("\n"));

    expect(parsed.schedule).toEqual(schedule);
    expect(parsed.occurrences).toEqual(expectedOccurrencesNewestFirst);
    expect(parsed.occurrences[0].intendedFireAt).toBe("2026-09-19T02:00:00.000Z");
    expect(parsed.occurrences[1].intendedFireAt).toBe("2026-09-19T01:00:00.000Z");
    // Unlike the Web API's `/api/schedules/:id`, the CLI has no repository
    // wrapper, so it must not add `repoId`/`repoName` to the schedule.
    expect(parsed.schedule.repoId).toBeUndefined();
    expect(parsed.schedule.repoName).toBeUndefined();
  });

  it("exits 1 with 'schedule <id> not found' on stderr and nothing on stdout for an unknown id", async () => {
    const repoPath = await createRepo();
    const shown = await cli(["schedule", "show", "sch_does_not_exist", "--repo", repoPath]);
    expect(shown.code).toBe(1);
    expect(shown.stdout).toEqual([]);
    expect(shown.stderr).toEqual(["schedule sch_does_not_exist not found"]);
  });

  it("exits 1 with a usage line when the <id> argument is missing", async () => {
    const shown = await cli(["schedule", "show"]);
    expect(shown.code).toBe(1);
    expect(shown.stdout).toEqual([]);
    expect(shown.stderr).toHaveLength(1);
    expect(shown.stderr[0]).toMatch(/^Usage: nitely schedule show\b/);
  });
});
