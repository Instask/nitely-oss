import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function createRepo(): Promise<string> {
  const repo = await fs.mkdtemp(join(tmpdir(), "nitely-run-cache-"));
  await fs.mkdir(join(repo, ".nitely/runs"), { recursive: true });
  return repo;
}

async function writeRun(repo: string, runId: string): Promise<void> {
  const runDirectory = join(repo, ".nitely/runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({ runId, status: "completed", completedStages: [], inputs: {} }),
    "utf8",
  );
}

async function loadRunsModule(counter: { reads: number; runJson?: number }) {
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    return {
      ...actual,
      readdir: async (...args: Parameters<typeof actual.readdir>) => {
        if (String(args[0]).endsWith(`${sep}.nitely${sep}runs`)) {
          counter.reads += 1;
        }
        return await actual.readdir(...args);
      },
      readFile: async (...args: Parameters<typeof actual.readFile>) => {
        if (String(args[0]).endsWith(`${sep}run.json`)) {
          counter.runJson = (counter.runJson ?? 0) + 1;
        }
        return await actual.readFile(...args);
      },
    };
  });
  return await import("../../src/web/runs.js");
}

function paddedRunId(index: number): string {
  return `run-${String(index).padStart(3, "0")}`;
}

describe("run listing scan sharing", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    vi.useRealTimers();
  });

  it("collapses concurrent listings of one repository into a single scan", async () => {
    const repo = await createRepo();
    await writeRun(repo, "run-1");
    const counter = { reads: 0 };
    const { listRuns } = await loadRunsModule(counter);

    const [first, second, third] = await Promise.all([
      listRuns(repo),
      listRuns(repo),
      listRuns(repo),
    ]);

    expect(counter.reads).toBe(1);
    expect(first.map((run) => run.runId)).toEqual(["run-1"]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("rescans once a listing has settled, so writes from outside this process are never hidden", async () => {
    const repo = await createRepo();
    await writeRun(repo, "run-1");
    const counter = { reads: 0 };
    const { listRuns } = await loadRunsModule(counter);

    await listRuns(repo);
    await writeRun(repo, "run-2");
    const second = await listRuns(repo);

    expect(counter.reads).toBe(2);
    expect(second.map((run) => run.runId)).toEqual(["run-2", "run-1"]);
  });

  it("stops sharing a scan that rejected", async () => {
    const repo = await createRepo();
    await fs.rm(join(repo, ".nitely/runs"), { recursive: true, force: true });
    const counter = { reads: 0 };
    const { listRuns } = await loadRunsModule(counter);

    await expect(listRuns(repo)).resolves.toEqual([]);
    await expect(listRuns(repo)).resolves.toEqual([]);

    expect(counter.reads).toBe(2);
  });



  it("keeps separate repositories independent", async () => {
    const repoA = await createRepo();
    const repoB = await createRepo();
    await writeRun(repoA, "run-a");
    await writeRun(repoB, "run-b");
    const counter = { reads: 0 };
    const { listRuns } = await loadRunsModule(counter);

    const [a, b] = await Promise.all([listRuns(repoA), listRuns(repoB)]);

    expect(counter.reads).toBe(2);
    expect(a.map((run) => run.runId)).toEqual(["run-a"]);
    expect(b.map((run) => run.runId)).toEqual(["run-b"]);
  });

  it("lists the full history by default, so entity-scoped callers see old runs", async () => {
    const repo = await createRepo();
    const counter = { reads: 0, runJson: 0 };
    const { listRuns, DEFAULT_RUN_LIST_LIMIT } = await loadRunsModule(counter);
    const total = DEFAULT_RUN_LIST_LIMIT + 3;
    for (let index = 1; index <= total; index += 1) {
      await writeRun(repo, paddedRunId(index));
    }

    const listed = await listRuns(repo);

    // Most callers filter this listing down to one work item, flow or run
    // chain. A default page would drop every entity whose runs are older than
    // the newest page, which is silent data loss rather than a cheaper list.
    expect(listed).toHaveLength(total);
    expect(listed[0]?.runId).toBe(paddedRunId(total));
    expect(listed.at(-1)?.runId).toBe(paddedRunId(1));
  });

  it("hydrates only the requested page when a caller asks for one", async () => {
    const repo = await createRepo();
    const counter = { reads: 0, runJson: 0 };
    const { listRuns, DEFAULT_RUN_LIST_LIMIT } = await loadRunsModule(counter);
    const total = DEFAULT_RUN_LIST_LIMIT + 3;
    for (let index = 1; index <= total; index += 1) {
      await writeRun(repo, paddedRunId(index));
    }

    const listed = await listRuns(repo, { limit: DEFAULT_RUN_LIST_LIMIT });

    expect(listed).toHaveLength(DEFAULT_RUN_LIST_LIMIT);
    expect(listed.map((run) => run.runId)).toEqual(
      Array.from({ length: DEFAULT_RUN_LIST_LIMIT }, (_, offset) =>
        paddedRunId(total - offset),
      ),
    );
    expect(counter.runJson).toBe(DEFAULT_RUN_LIST_LIMIT);
  });
});
