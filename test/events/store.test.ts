import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";

const stores: EventStore[] = [];

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("EventStore", () => {
  it("assigns increasing sequence numbers and filters by run", () => {
    const store = new EventStore(":memory:");
    stores.push(store);

    const first = store.append({
      runId: "run-1",
      type: "run.created",
      payload: { flowName: "self-improve" },
    });
    const otherRun = store.append({
      runId: "run-2",
      type: "run.created",
      payload: { flowName: "other" },
    });
    const second = store.append({
      runId: "run-1",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { runtime: "mock" },
    });

    expect(first.sequence).toBe(1);
    expect(otherRun.sequence).toBe(2);
    expect(second.sequence).toBe(3);
    expect(store.list("run-1")).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "run.created",
        payload: { flowName: "self-improve" },
      }),
      expect.objectContaining({
        sequence: 3,
        stageId: "implement",
        attempt: 1,
        type: "stage.started",
        payload: { runtime: "mock" },
      }),
    ]);
  });

  it("returns the latest event for a run", () => {
    const store = new EventStore(":memory:");
    stores.push(store);
    store.append({
      runId: "run-1",
      type: "run.created",
      payload: {},
    });
    store.append({
      runId: "run-1",
      type: "run.completed",
      payload: { result: "success" },
    });

    expect(store.latest("run-1")).toEqual(
      expect.objectContaining({
        type: "run.completed",
        payload: { result: "success" },
      }),
    );
    expect(store.latest("missing")).toBeUndefined();
  });

  it("preserves events when a file database is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-events-"));
    const path = join(directory, "nitely.db");
    const firstStore = new EventStore(path);
    firstStore.append({
      runId: "run-1",
      type: "run.created",
      payload: { nested: { value: 42 } },
    });
    firstStore.close();

    const reopened = new EventStore(path);
    stores.push(reopened);

    expect(reopened.list("run-1")).toEqual([
      expect.objectContaining({
        sequence: 1,
        payload: { nested: { value: 42 } },
      }),
    ]);
  });

  it("lists persisted run ids by most recent event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-events-"));
    const path = join(directory, "nitely.db");
    const firstStore = new EventStore(path);
    firstStore.append({
      runId: "run-older",
      type: "run.created",
      payload: {},
      createdAt: "2026-06-19T00:00:00.000Z",
    });
    firstStore.append({
      runId: "run-newer",
      type: "run.created",
      payload: {},
      createdAt: "2026-06-19T00:01:00.000Z",
    });
    firstStore.append({
      runId: "run-older",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      payload: {},
      createdAt: "2026-06-19T00:02:00.000Z",
    });
    firstStore.close();

    const reopened = new EventStore(path);
    stores.push(reopened);

    expect(reopened.listRunIds()).toEqual(["run-older", "run-newer"]);
  });
});
