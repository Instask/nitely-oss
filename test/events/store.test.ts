import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";

const stores: EventStore[] = [];

function assertSynchronousTransactionTypes(store: EventStore): void {
  // @ts-expect-error EventStore transactions must not accept async callbacks.
  store.transaction(async () => undefined);
  const thenable = undefined as unknown as PromiseLike<void>;
  // @ts-expect-error EventStore transactions must not accept PromiseLike results.
  store.transaction(() => thenable);
  const maybePromise = undefined as unknown as void | Promise<void>;
  // @ts-expect-error A PromiseLike union member must make the callback invalid.
  store.transaction(() => maybePromise);
}
void assertSynchronousTransactionTypes;

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

  it("commits and rolls back synchronous callbacks atomically", () => {
    const store = new EventStore(":memory:");
    stores.push(store);

    const result = store.transaction(() => {
      store.append({ runId: "run-sync", type: "run.created", payload: {} });
      store.append({ runId: "run-sync", type: "run.completed", payload: {} });
      return "committed";
    });

    expect(result).toBe("committed");
    expect(store.list("run-sync").map((event) => event.type)).toEqual([
      "run.created",
      "run.completed",
    ]);
    expect(() =>
      store.transaction(() => {
        store.append({
          runId: "run-rolled-back",
          type: "run.created",
          payload: {},
        });
        throw new Error("rollback the synchronous transaction");
      }),
    ).toThrow("rollback the synchronous transaction");
    expect(store.list("run-rolled-back")).toEqual([]);
  });

  it.each(["async", "thenable"] as const)(
    "rejects a %s callback, rolls it back, and leaves the connection usable",
    async (kind) => {
      const store = new EventStore(":memory:");
      stores.push(store);
      let callbackInvocations = 0;
      const callback = kind === "async"
        ? async () => {
            callbackInvocations += 1;
            store.append({
              runId: "run-rolled-back",
              type: "run.created",
              payload: {},
            });
            await Promise.resolve();
          }
        : () => {
            callbackInvocations += 1;
            store.append({
              runId: "run-rolled-back",
              type: "run.created",
              payload: {},
            });
            return { then(resolve: () => void) { resolve(); } };
          };
      let invocationError: unknown;
      let unexpectedPending: unknown;
      try {
        unexpectedPending = store.transaction(
          callback as unknown as () => void,
        );
      } catch (error) {
        invocationError = error;
      }
      if (unexpectedPending instanceof Promise) {
        await unexpectedPending;
      }

      expect(invocationError).toEqual(
        new Error("EventStore transaction callback must be synchronous"),
      );
      expect(callbackInvocations).toBe(kind === "async" ? 0 : 1);
      expect(store.list("run-rolled-back")).toEqual([]);
      store.append({
        runId: "run-independent",
        type: "run.created",
        payload: {},
      });
      expect(store.list("run-independent")).toHaveLength(1);
    },
  );

  it("observes a rejected Promise erased behind a void callback", async () => {
    const store = new EventStore(":memory:");
    stores.push(store);
    const innerError = new Error("inner async rejection");
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandledRejection);
    try {
      const callback: () => void = () => {
        store.append({
          runId: "run-rolled-back",
          type: "run.created",
          payload: {},
        });
        return Promise.reject(innerError);
      };

      expect(() => store.transaction(callback)).toThrow(
        "EventStore transaction callback must be synchronous",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
      expect(store.list("run-rolled-back")).toEqual([]);
      store.append({
        runId: "run-independent",
        type: "run.created",
        payload: {},
      });
      expect(store.list("run-independent")).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", captureUnhandledRejection);
    }
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

  it("deletes one run's complete event history without affecting other runs", () => {
    const store = new EventStore(":memory:");
    stores.push(store);
    store.append({ runId: "run-delete", type: "run.created", payload: {} });
    store.append({ runId: "run-delete", type: "run.completed", payload: {} });
    store.append({ runId: "run-keep", type: "run.created", payload: {} });

    expect(store.deleteRun("run-delete")).toBe(2);
    expect(store.deleteRun("run-delete")).toBe(0);
    expect(store.list("run-delete")).toEqual([]);
    expect(store.list("run-keep")).toHaveLength(1);
  });
});
