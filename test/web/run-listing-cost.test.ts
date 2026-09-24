import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventStore } from "../../src/events/store.js";

/**
 * What one Run costs a listing (#518).
 *
 * `/api/runs`, `/api/dashboard`, `/api/agent-stability` and `/api/tasks` all
 * walk the Run history, so a listing must not read a Run's logs in full or
 * open the event store per Run. These tests pin the cost and the answer
 * together: bounding the read is only correct if the summary is unchanged.
 */

interface Counter {
  logReadFiles: number;
  bytesRead: number;
  storeOpens: number;
}

function newCounter(): Counter {
  return { logReadFiles: 0, bytesRead: 0, storeOpens: 0 };
}

function isLogPath(path: unknown): boolean {
  const value = String(path);
  return value.endsWith("stdout.log") || value.endsWith("stderr.log");
}

async function loadRunsModule(counter: Counter) {
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    return {
      ...actual,
      readFile: async (...args: Parameters<typeof actual.readFile>) => {
        if (isLogPath(args[0])) counter.logReadFiles += 1;
        return await actual.readFile(...args);
      },
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        return new Proxy(handle, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "read") {
              return async (...readArgs: unknown[]) => {
                const result = await (
                  value as (...input: unknown[]) => Promise<{ bytesRead: number }>
                ).apply(target, readArgs);
                counter.bytesRead += result.bytesRead;
                return result;
              };
            }
            return value.bind(target);
          },
        });
      },
    };
  });
  vi.doMock("../../src/events/store.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/events/store.js")
    >("../../src/events/store.js");
    return {
      ...actual,
      EventStore: class CountingEventStore extends actual.EventStore {
        constructor(path: string) {
          counter.storeOpens += 1;
          super(path);
        }
      },
    };
  });
  return await import("../../src/web/runs.js");
}

async function createRepo(): Promise<string> {
  const repo = await fs.mkdtemp(join(tmpdir(), "nitely-run-cost-"));
  await fs.mkdir(join(repo, ".nitely/runs"), { recursive: true });
  return repo;
}

async function writeRunJson(
  repo: string,
  runId: string,
  summary: Record<string, unknown> = {},
): Promise<string> {
  const runDirectory = join(repo, ".nitely/runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({
      runId,
      status: "completed",
      completedStages: [],
      inputs: {},
      ...summary,
    }),
    "utf8",
  );
  return runDirectory;
}

async function writeAttemptLog(
  repo: string,
  runId: string,
  stageId: string,
  attempt: string,
  logs: { stdout?: string; stderr?: string },
): Promise<void> {
  const attemptDirectory = join(
    repo,
    ".nitely/runs",
    runId,
    "stages",
    stageId,
    attempt,
  );
  await fs.mkdir(attemptDirectory, { recursive: true });
  if (logs.stdout !== undefined) {
    await fs.writeFile(join(attemptDirectory, "stdout.log"), logs.stdout, "utf8");
  }
  if (logs.stderr !== undefined) {
    await fs.writeFile(join(attemptDirectory, "stderr.log"), logs.stderr, "utf8");
  }
}

/** A log far larger than the tail a summary is allowed to read. */
function bulkyLog(finalLine: string): string {
  const filler = Array.from(
    { length: 12_000 },
    (_, index) => `filler line ${index}`,
  ).join("\n");
  return `${filler}\n${finalLine}\n`;
}

describe("run listing cost", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("../../src/events/store.js");
    vi.resetModules();
  });

  it("summarizes a run from a bounded tail instead of its whole log", async () => {
    const repo = await createRepo();
    await writeRunJson(repo, "run-1");
    const stdout = bulkyLog("implementation finished");
    await writeAttemptLog(repo, "run-1", "implement", "1", { stdout });
    const counter = newCounter();
    const { listRuns } = await loadRunsModule(counter);

    const [run] = await listRuns(repo);

    expect(run?.latestOutputSummary).toBe("implementation finished");
    expect(run?.currentStage).toBe("implement");
    expect(run?.currentAttempt).toBe(1);
    // The answer is the same one a full read produces; only the cost differs.
    expect(stdout.length).toBeGreaterThan(200_000);
    expect(counter.logReadFiles).toBe(0);
    expect(counter.bytesRead).toBeLessThan(200_000);
  });

  it("falls back to an older attempt when the newest tail holds nothing meaningful", async () => {
    const repo = await createRepo();
    await writeRunJson(repo, "run-1", { status: "failed" });
    await writeAttemptLog(repo, "run-1", "implement", "1", {
      stdout: "first attempt output\n",
    });
    await writeAttemptLog(repo, "run-1", "implement", "2", {
      stdout: "stdout not captured\n12345\n",
    });
    const counter = newCounter();
    const { listRuns } = await loadRunsModule(counter);

    const [run] = await listRuns(repo);

    expect(run?.latestOutputSummary).toBe("first attempt output");
    expect(run?.currentStage).toBe("implement");
    expect(run?.currentAttempt).toBe(2);
    expect(run?.currentStageState).toBe("failed");
  });

  it("keeps the stage and attempt of a run whose logs are all noise", async () => {
    const repo = await createRepo();
    await writeRunJson(repo, "run-1", { status: "running" });
    await writeAttemptLog(repo, "run-1", "implement", "3", { stdout: "\n" });
    const counter = newCounter();
    const { listRuns } = await loadRunsModule(counter);

    const [run] = await listRuns(repo);

    expect(run?.currentStage).toBe("implement");
    expect(run?.currentAttempt).toBe(3);
    expect(run?.currentStageState).toBe("running");
    expect(run?.latestOutputSummary).toBeUndefined();
  });

  it("opens the event store a fixed number of times for the whole listing", async () => {
    const repo = await createRepo();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      const runDirectory = await writeRunJson(repo, runId);
      await writeAttemptLog(repo, runId, "implement", "1", {
        stdout: bulkyLog(`${runId} finished`),
      });
      const store = new EventStore(join(repo, ".nitely/events.db"));
      store.append({
        runId,
        type: "run.created",
        payload: { flowName: "implement-spec", inputs: {} },
      });
      store.append({
        runId,
        type: "stage.started",
        stageId: "implement",
        attempt: 1,
        payload: {
          attemptDirectory: join(runDirectory, "stages/implement/1"),
        },
      });
      store.append({
        runId,
        type: "stage.completed",
        stageId: "implement",
        attempt: 1,
        payload: {
          attemptDirectory: join(runDirectory, "stages/implement/1"),
        },
      });
      store.close();
    }
    const counter = newCounter();
    const { listRuns } = await loadRunsModule(counter);

    const runs = await listRuns(repo);

    expect(runs.map((run) => run.runId)).toEqual(["run-3", "run-2", "run-1"]);
    expect(runs[0]?.latestOutputSummary).toBe("run-3 finished");
    // One open projects every Run, a second reads the events of the Runs on
    // this page. Per-Run opens are what made a listing pay two SQLite opens
    // and a second projection for every Run in the history.
    expect(counter.storeOpens).toBe(2);
    expect(counter.logReadFiles).toBe(0);
    expect(counter.bytesRead).toBeLessThan(200_000);
  });

  it("reports the same current stage and output as the run detail view", async () => {
    const repo = await createRepo();
    const runDirectory = await writeRunJson(repo, "run-1");
    await writeAttemptLog(repo, "run-1", "implement", "1", {
      stdout: bulkyLog("implement finished"),
    });
    await writeAttemptLog(repo, "run-1", "review", "1", {
      stdout: bulkyLog("review verdict: pass"),
    });
    const store = new EventStore(join(repo, ".nitely/events.db"));
    store.append({
      runId: "run-1",
      type: "run.created",
      payload: { flowName: "implement-spec", inputs: {} },
    });
    for (const stageId of ["implement", "review"]) {
      store.append({
        runId: "run-1",
        type: "stage.started",
        stageId,
        attempt: 1,
        payload: {
          attemptDirectory: join(runDirectory, "stages", stageId, "1"),
        },
      });
      store.append({
        runId: "run-1",
        type: "stage.completed",
        stageId,
        attempt: 1,
        payload: {
          attemptDirectory: join(runDirectory, "stages", stageId, "1"),
        },
      });
    }
    store.close();
    const counter = newCounter();
    const { listRuns, getRunDetail } = await loadRunsModule(counter);

    const [listed] = await listRuns(repo);
    const detail = await getRunDetail(repo, "run-1");

    expect(listed?.currentStage).toBe(detail.currentStage);
    expect(listed?.currentAttempt).toBe(detail.currentAttempt);
    expect(listed?.currentStageState).toBe(detail.currentStageState);
    expect(listed?.latestOutputSummary).toBe(detail.latestOutputSummary);
    expect(listed?.latestOutputSummary).toBe("review verdict: pass");
  });
});
