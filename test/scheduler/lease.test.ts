import { describe, expect, it } from "vitest";

import { SchedulerLeaseStore } from "../../src/scheduler/lease.js";

describe("scheduler leases", () => {
  it("limits repository/flow ownership and serializes shared resource keys", () => {
    const store = new SchedulerLeaseStore(":memory:");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const base = { repositoryLimit: 2, flowLimit: 2, now, ttlMs: 60_000 };
    expect(store.acquire({ ...base, taskId: "a", owner: "a", flowKey: "flow", resourceKeys: ["branch:main"] })).toBeTruthy();
    expect(store.acquire({ ...base, taskId: "b", owner: "b", flowKey: "flow", resourceKeys: ["branch:main"] })).toBeUndefined();
    expect(store.acquire({ ...base, taskId: "b", owner: "b", flowKey: "flow", resourceKeys: ["branch:feature"] })).toBeTruthy();
    expect(store.acquire({ ...base, taskId: "c", owner: "c", flowKey: "flow", resourceKeys: ["branch:other"] })).toBeUndefined();
    store.close();
  });

  // Two schedulers reaching the same task is the case leases exist for, so the
  // loser has to be told no rather than hit the primary key.
  it("declines a second owner for a task that is already leased", () => {
    const store = new SchedulerLeaseStore(":memory:");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const base = {
      taskId: "a",
      flowKey: "flow",
      resourceKeys: [] as string[],
      repositoryLimit: 4,
      flowLimit: 4,
      now,
      ttlMs: 60_000,
    };

    expect(store.acquire({ ...base, owner: "owner-a" })).toBeTruthy();
    expect(store.acquire({ ...base, owner: "owner-b" })).toBeUndefined();
    expect(
      store.heartbeat({ taskId: "a", owner: "owner-a", now, ttlMs: 60_000 }),
    ).toBe(true);
    store.close();
  });

  it("recovers an expired lease and renews live ownership", () => {
    const store = new SchedulerLeaseStore(":memory:");
    const acquiredAt = new Date("2026-01-01T00:00:00.000Z");
    expect(store.acquire({
      taskId: "a", owner: "owner-a", flowKey: "flow", resourceKeys: [],
      repositoryLimit: 1, flowLimit: 1, now: acquiredAt, ttlMs: 1_000,
    })).toBeTruthy();
    expect(store.heartbeat({ taskId: "a", owner: "owner-a", now: new Date("2026-01-01T00:00:00.500Z"), ttlMs: 1_000 })).toBe(true);
    expect(store.acquire({
      taskId: "b", owner: "owner-b", flowKey: "flow", resourceKeys: [],
      repositoryLimit: 1, flowLimit: 1, now: new Date("2026-01-01T00:00:01.400Z"), ttlMs: 1_000,
    })).toBeUndefined();
    expect(store.acquire({
      taskId: "b", owner: "owner-b", flowKey: "flow", resourceKeys: [],
      repositoryLimit: 1, flowLimit: 1, now: new Date("2026-01-01T00:00:01.501Z"), ttlMs: 1_000,
    })).toBeTruthy();
    store.close();
  });
});
