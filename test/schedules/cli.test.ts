import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { listSchedules } from "../../src/schedules/store.js";
import { listTasks } from "../../src/web/tasks.js";

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
