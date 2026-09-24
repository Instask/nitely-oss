import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  readSchedulerCooldowns,
  SchedulerCooldownStore,
  schedulerCooldownStorePath,
} from "../../src/scheduler/cooldown.js";

describe("scheduler cooldown persistence", () => {
  it("persists runtime reset state and clears it after success", () => {
    const store = new SchedulerCooldownStore(":memory:");
    store.set("claude", new Date("2026-09-18T12:50:00.000Z"));
    expect(store.get("claude")).toEqual({
      runtime: "claude",
      until: "2026-09-18T12:50:00.000Z",
    });
    store.clear("claude");
    expect(store.get("claude")).toBeUndefined();
    store.close();
  });

  it("reads a missing cooldown store without creating one", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cooldown-read-"));
    const path = schedulerCooldownStorePath(repoPath);

    expect(readSchedulerCooldowns(repoPath)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("treats an initializing cooldown database as an empty projection", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cooldown-read-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const database = new DatabaseSync(schedulerCooldownStorePath(repoPath));
    database.close();

    expect(readSchedulerCooldowns(repoPath)).toEqual([]);
  });
});
