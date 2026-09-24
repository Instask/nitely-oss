import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createContextKnowledgeEntry,
  linkContextKnowledgeEntries,
  listContextKnowledgeEntries,
  selectContextKnowledgeEntries,
  updateContextKnowledgeEntry,
} from "../../src/context-kg/store.js";

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-context-kg-"));
}

describe("context-kg store", () => {
  it("creates, lists, and edits versioned context entries", async () => {
    const repoPath = await createRepo();

    const created = await createContextKnowledgeEntry(
      repoPath,
      {
        category: "conventions",
        title: "Use focused Vitest files",
        body: "Run the narrow Vitest file before the wider suite.",
        tags: ["testing"],
        keywords: ["vitest", "tests"],
      },
      {
        createId: () => "ctx-testing",
        now: () => "2026-07-07T00:00:00.000Z",
      },
    );

    expect(created).toMatchObject({
      id: "ctx-testing",
      category: "conventions",
      status: "approved",
      version: 1,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });

    const updated = await updateContextKnowledgeEntry(
      repoPath,
      "ctx-testing",
      {
        body: "Run the focused Vitest file before the wider suite.",
        status: "proposed",
      },
      { now: () => "2026-07-07T00:10:00.000Z" },
    );

    expect(updated).toMatchObject({
      id: "ctx-testing",
      status: "proposed",
      version: 2,
      updatedAt: "2026-07-07T00:10:00.000Z",
    });
    await expect(listContextKnowledgeEntries(repoPath)).resolves.toEqual([updated]);

    const stored = JSON.parse(
      await readFile(join(repoPath, ".nitely/context-kg/entries.json"), "utf8"),
    ) as { version: number; entries: unknown[] };
    expect(stored.version).toBe(1);
    expect(stored.entries).toHaveLength(1);
  });

  it("selects approved entries by keyword relevance", async () => {
    const repoPath = await createRepo();
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "pitfalls",
        title: "Preflight should not fetch remote branches",
        body: "Task detail refreshes must stay deterministic and local.",
        keywords: ["preflight", "task-detail"],
      },
      { createId: () => "ctx-preflight" },
    );
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "feedback",
        title: "Draft dashboard metrics",
        body: "Operator requested weekly pilot metrics.",
        keywords: ["dashboard"],
        status: "proposed",
      },
      { createId: () => "ctx-dashboard" },
    );
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "modules",
        title: "Flow store module",
        body: "Custom flows are stored in .nitely/flows.",
        keywords: ["flow"],
      },
      { createId: () => "ctx-flow" },
    );

    const selected = await selectContextKnowledgeEntries({
      repoPath,
      query: ["run preflight doctor", "task detail"],
    });

    expect(selected.map((entry) => entry.id)).toEqual(["ctx-preflight"]);
  });

  it("links injected entries to runs and tasks without duplicating links", async () => {
    const repoPath = await createRepo();
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "decisions",
        title: "Keep context local",
        body: "Repo knowledge is stored under .nitely and injected locally.",
        keywords: ["context"],
      },
      { createId: () => "ctx-local" },
    );

    await linkContextKnowledgeEntries(repoPath, ["ctx-local"], {
      runId: "run-1",
      taskId: "task-1",
      now: () => "2026-07-07T00:20:00.000Z",
    });
    await linkContextKnowledgeEntries(repoPath, ["ctx-local"], {
      runId: "run-1",
      taskId: "task-1",
      now: () => "2026-07-07T00:25:00.000Z",
    });

    await expect(listContextKnowledgeEntries(repoPath)).resolves.toEqual([
      expect.objectContaining({
        id: "ctx-local",
        linkedRunIds: ["run-1"],
        linkedTaskIds: ["task-1"],
        updatedAt: "2026-07-07T00:20:00.000Z",
      }),
    ]);
  });
});
