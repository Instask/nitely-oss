import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeRunEvent,
  EventStore,
  openRunEventStore,
  withRunEventStore,
  type StoredRunEvent,
} from "../../src/events/run-events.js";

function stored(
  type: StoredRunEvent["type"],
  payload: unknown,
  fields: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence: 1,
    runId: "run-1",
    type,
    payload,
    createdAt: "2026-10-28T00:00:00.000Z",
    ...fields,
  };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return files.flat();
}

describe("Run events module", () => {
  it("decodes what a typed writer appended", () => {
    const store = new EventStore(":memory:");
    try {
      store.append({
        runId: "run-1",
        stageId: "review",
        attempt: 2,
        type: "approval.requested",
        payload: { approvalId: "review-2", prompt: "Ship it?", reviewedArtifactIds: ["plan"] },
      });
      store.append({
        runId: "run-1",
        stageId: "review",
        attempt: 2,
        type: "approval.resolved",
        payload: {
          approvalId: "review-2",
          approved: false,
          decision: "denied",
          actor: "operator",
          reviewedArtifactIds: ["plan"],
        },
      });
      store.append({
        runId: "run-1",
        type: "run.failed",
        payload: { error: "approval review-2 denied" },
      });
      const [requested, resolved, failed] = store.list("run-1");

      expect(decodeRunEvent(requested!, "approval.requested")).toEqual({
        approvalId: "review-2",
        prompt: "Ship it?",
        reviewedArtifactIds: ["plan"],
      });
      expect(decodeRunEvent(resolved!, "approval.resolved")).toEqual({
        approvalId: "review-2",
        approved: false,
        decision: "denied",
        actor: "operator",
        reviewedArtifactIds: ["plan"],
      });
      expect(decodeRunEvent(failed!, "run.failed")).toEqual({
        error: "approval review-2 denied",
      });
    } finally {
      store.close();
    }
  });

  it("returns nothing for an event of another type", () => {
    expect(decodeRunEvent(stored("run.failed", { error: "x" }), "run.completed")).toBeUndefined();
  });

  it("reads older approval payloads", () => {
    const requested = stored("approval.requested", { prompt: "ok?" }, {
      stageId: "gate",
      attempt: 1,
    });
    expect(decodeRunEvent(requested, "approval.requested")?.approvalId).toBe("gate-1");

    const resolved = stored("approval.resolved", { decision: "approved" }, {
      stageId: "gate",
      attempt: 1,
    });
    expect(decodeRunEvent(resolved, "approval.resolved")).toMatchObject({
      approvalId: "gate-1",
      approved: true,
      decision: "approved",
    });

    expect(
      decodeRunEvent(stored("approval.requested", {}), "approval.requested"),
    ).toBeUndefined();
  });

  it("rejects a blocker without a reason", () => {
    expect(decodeRunEvent(stored("run.blocked", { message: "?" }), "run.blocked")).toBeUndefined();
    expect(
      decodeRunEvent(
        stored("stage.blocked", { reason: "approval_required", stageId: "s", extra: 1 }),
        "stage.blocked",
      ),
    ).toEqual({ reason: "approval_required", stageId: "s" });
  });

  it("drops a task plan history that has a malformed entry", () => {
    const event = stored("task.plan.task.completed", {
      inputId: "plan",
      completedTaskIds: ["a"],
      history: [
        { taskId: "a", status: "completed" },
        { taskId: "b", status: "unknown" },
      ],
    });
    const decoded = decodeRunEvent(event, "task.plan.task.completed");
    expect(decoded?.inputId).toBe("plan");
    expect(decoded?.completedTaskIds).toEqual(["a"]);
    expect(decoded?.history).toBeUndefined();
  });

  it("reuses a handle the caller already holds", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-run-events-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const held = openRunEventStore(repo);
    try {
      withRunEventStore(repo, (store) => {
        expect(store).toBe(held);
        store.append({ runId: "run-1", type: "run.created", payload: {} });
      }, held);
      // The held handle is still open.
      expect(held.list("run-1")).toHaveLength(1);
      const count = withRunEventStore(repo, (store) => store.list("run-1").length);
      expect(count).toBe(1);
    } finally {
      held.close();
    }
  });

  it("is the only module that opens an event store", async () => {
    const root = join(import.meta.dirname, "../../src");
    const offenders: string[] = [];
    for (const file of await sourceFiles(root)) {
      const path = relative(root, file);
      if (path.startsWith("events/")) continue;
      if ((await readFile(file, "utf8")).includes("new EventStore(")) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
