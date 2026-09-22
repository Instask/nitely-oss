import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/events/store.js";
import { eventStorePath } from "../src/run/project.js";

import {
  dispatchFactoryQueue,
  getFactoryQueueSnapshot,
  loadFactoryQueue,
  setFactoryQueuePaused,
  upsertFactoryCandidate,
} from "../src/factory-queue.js";

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nitely-factory-queue-"));
}

const source = { type: "github-issue" as const, identity: "Instask/nitely#569", uri: "https://github.com/Instask/nitely/issues/569" };

describe("factory queue", () => {
  it("persists a GitHub candidate, applies deterministic policy, and keeps it out of Runs", async () => {
    const repoPath = await repo();
    const candidate = await upsertFactoryCandidate({
      repoPath,
      title: "Queue work",
      source,
      workItemId: "task-569",
      labels: ["automation"],
      state: "open",
      planning: { specApproved: false, techDesignApproved: false },
    });

    expect(candidate.status).toBe("needs_human");
    expect(candidate.eligibility?.reasons).toEqual([
      "spec approval is required",
      "technical design approval is required",
    ]);
    expect((await loadFactoryQueue(repoPath)).candidates).toHaveLength(1);
    expect((await getFactoryQueueSnapshot(repoPath)).policy.maxConcurrentRuns).toBe(1);
    const events = new EventStore(eventStorePath(repoPath));
    expect(events.list(candidate.id).map((event) => event.type)).toContain("factory.candidate.evaluated");
    events.close();
  });

  it("rejects forbidden work deterministically and deduplicates source identity", async () => {
    const repoPath = await repo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(join(repoPath, ".nitely", "factory-queue-policy.json"), JSON.stringify({
      schemaVersion: "nitely.factory-queue-policy.v1",
      autoQueue: true,
      requiredLabels: ["ready"],
      forbiddenLabels: ["security-sensitive"],
      allowedWorkItemTypes: [],
      allowedStates: ["open"],
      allowedAssignees: [],
      allowedPathPrefixes: [],
      forbiddenPathPrefixes: [],
      requireSpecApproved: false,
      requireTechDesignApproved: false,
      maxRiskClass: "medium",
      maxConcurrentRuns: 2,
    }), "utf8");

    const first = await upsertFactoryCandidate({
      repoPath, title: "Rejected", source, labels: ["security-sensitive"], state: "open",
      planning: { specApproved: true, techDesignApproved: true },
    });
    const second = await upsertFactoryCandidate({
      repoPath, title: "Updated", source, labels: ["ready"], state: "open",
      planning: { specApproved: true, techDesignApproved: true },
    });

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("queued");
    expect(second.id).toBe(first.id);
    expect((await loadFactoryQueue(repoPath)).candidates).toHaveLength(1);
  });

  it("supports durable pause and bounded dispatch transitions", async () => {
    const repoPath = await repo();
    const candidate = await upsertFactoryCandidate({
      repoPath, title: "Dispatch", source, workItemId: "task-1", state: "open",
      planning: { specApproved: true, techDesignApproved: true },
    });
    expect(candidate.status).toBe("queued");
    await setFactoryQueuePaused(repoPath, true);
    let calls = 0;
    const paused = await dispatchFactoryQueue({
      repoPath,
      runScheduler: async (ids) => {
        calls += 1;
        expect(ids).toEqual([]);
        return { startedTaskIds: [], completedTaskIds: [], failedTaskIds: [], blockedTaskIds: [], awaitingApprovalTaskIds: [] };
      },
    });
    expect(calls).toBe(1);
    expect(paused.queue.candidates[0]?.status).toBe("queued");

    await setFactoryQueuePaused(repoPath, false);
    const dispatched = await dispatchFactoryQueue({
      repoPath,
      runScheduler: async (ids) => ({
        startedTaskIds: ids,
        completedTaskIds: ids,
        failedTaskIds: [],
        blockedTaskIds: [],
        awaitingApprovalTaskIds: [],
      }),
    });
    expect(dispatched.queue.candidates[0]?.status).toBe("completed");
    const events = new EventStore(eventStorePath(repoPath));
    expect(events.list(candidate.id).map((event) => event.type)).toContain("factory.queue.dispatched");
    events.close();
  });

  it("marks duplicate work before enqueue", async () => {
    const repoPath = await repo();
    const candidate = await upsertFactoryCandidate({
      repoPath,
      title: "Already published",
      source,
      workItemId: "task-569",
      duplicateReason: "source already has an open change request",
      planning: { specApproved: true, techDesignApproved: true },
    });
    expect(candidate.status).toBe("duplicate");
    expect(candidate.eligibility?.reasons).toEqual(["source already has an open change request"]);
  });
});
