import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { startWebServer } from "../../src/web/server.js";
import { createTask, updateTaskRunState } from "../../src/web/tasks.js";
import { chromeExecutablePath } from "../helpers/chrome.js";

const TASK_ID = "task-sync-indicator";
const RUN_ID = "run-sync-indicator";
const STAGE_ID = "implement-sync-indicator";
const TASK_TITLE = "Sync indicator layout stability probe";

/** Long enough for three polls on the 2s task list and five on the 1s run detail. */
const OBSERVATION_MS = 6_000;
/** Comfortably past the delay the console waits before reporting a slow fetch. */
const SLOW_FETCH_MS = 1_200;

interface ShiftSource {
  node: string;
  previous: number[] | null;
  current: number[] | null;
}

interface Shift {
  value: number;
  at: number;
  sources: ShiftSource[];
}

interface Probe {
  shifts: Shift[];
  pillClasses: string[];
  barClasses: string[];
  contentTops: number[];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Seeds a run that is still open, which is what turns the console's live
 * refresh loop on: `run.created` with no terminal event projects as running.
 */
async function createRunningFixture(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-sync-indicator-"));
  await writeJson(join(repoPath, "flows", "implement-spec-bootstrap.json"), {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "implement-spec-bootstrap" },
    spec: {
      stages: [
        {
          id: STAGE_ID,
          type: "agent",
          runtime: "mock",
          prompt: "Keep the console polling while this stage is open.",
          inputs: ["spec"],
          outputs: ["implementation"],
        },
      ],
    },
  });

  await createTask(
    repoPath,
    {
      title: TASK_TITLE,
      spec: "# Sync indicator fixture\n\nHold a run open so the console polls.\n",
      techDesign: "# Technical design\n\nNo layout may move while polling.\n",
    },
    {
      createId: () => TASK_ID,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      initialStatus: "running",
      specStatus: "approved",
      techDesignStatus: "approved",
    },
  );
  await updateTaskRunState(repoPath, TASK_ID, {
    status: "running",
    latestRunId: RUN_ID,
  });

  const attemptDirectory = join(
    repoPath,
    ".nitely",
    "runs",
    RUN_ID,
    "stages",
    STAGE_ID,
    "1",
  );
  await mkdir(attemptDirectory, { recursive: true });
  await writeFile(join(attemptDirectory, "stdout.log"), "stage in progress\n", "utf8");

  const store = new EventStore(join(repoPath, ".nitely", "events.db"));
  try {
    store.append({
      runId: RUN_ID,
      type: "run.created",
      createdAt: "2026-07-14T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap",
        flowPath: "flows/implement-spec-bootstrap.json",
        workItemId: TASK_ID,
        workItemType: "dev.pr",
        repoId: "sync-indicator",
        repoName: "Sync Indicator",
        repoPath: "/srv/sync-indicator",
        branchName: `nitely/${RUN_ID}`,
        baseBranch: "main",
        inputs: {},
        configuration: {},
        workflowStages: [
          {
            id: STAGE_ID,
            type: "agent",
            inputs: ["spec"],
            outputs: ["implementation"],
            maxAttempts: 2,
          },
        ],
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "stage.started",
      createdAt: "2026-07-14T00:00:02.000Z",
      payload: {
        type: "agent",
        runtime: "mock",
        model: "mock",
        attemptDirectory,
      },
    });
  } finally {
    store.close();
  }
  return repoPath;
}

/**
 * The console pulls a webfont from Google; an empty stylesheet keeps glyph
 * metrics — and so the layout being measured — identical on every machine.
 * React and Babel come from the server itself, so nothing else leaves it.
 */
async function stubExternalAssets(page: Page): Promise<void> {
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
}

async function observe(page: Page, durationMs: number): Promise<Probe> {
  return await page.evaluate(async (windowMs) => {
    const state = window as unknown as { __nitelyShifts: Shift[] };
    state.__nitelyShifts.length = 0;
    const pillClasses = new Set<string>();
    const barClasses = new Set<string>();
    const contentTops = new Set<number>();
    const normalize = (value: string | undefined) =>
      (value ?? "(missing)").trim().replace(/\s+/g, " ");
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const pill = document.querySelector(".nitely-loading-pill");
        const bar = document.querySelector(".nitely-loading-bar");
        const section = document.querySelector(".console-content section");
        pillClasses.add(normalize(pill?.className));
        barClasses.add(normalize(bar?.className));
        if (section) {
          contentTops.add(Math.round(section.getBoundingClientRect().top * 100) / 100);
        }
        if (performance.now() - start >= windowMs) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    return {
      shifts: state.__nitelyShifts.slice(),
      pillClasses: [...pillClasses],
      barClasses: [...barClasses],
      contentTops: [...contentTops],
    };
  }, durationMs);
}

describe("Web Console sync indicator", () => {
  it(
    "keeps the page and the indicator still while live refresh polls",
    async () => {
      const repoPath = await createRunningFixture();
      let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
      let browser: Browser | undefined;
      try {
        server = await startWebServer({
          repoPath,
          host: "127.0.0.1",
          port: 0,
          providerCommandStatus: async () => false,
          repositories: [{ id: "home", name: "home", path: repoPath }],
        });
        browser = await chromium.launch({
          executablePath: await chromeExecutablePath(),
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        await stubExternalAssets(page);
        await page.addInitScript(() => {
          const state = window as unknown as { __nitelyShifts: unknown[] };
          state.__nitelyShifts = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & {
                value: number;
                sources?: Array<{
                  node: Element | null;
                  previousRect: DOMRectReadOnly | null;
                  currentRect: DOMRectReadOnly | null;
                }>;
              };
              const rect = (value: DOMRectReadOnly | null) =>
                value
                  ? [
                      Math.round(value.x),
                      Math.round(value.y),
                      Math.round(value.width),
                      Math.round(value.height),
                    ]
                  : null;
              state.__nitelyShifts.push({
                value: shift.value,
                at: Math.round(shift.startTime),
                sources: (shift.sources ?? []).map((source) => {
                  const node = source.node;
                  const className =
                    node && typeof node.className === "string" ? node.className.trim() : "";
                  return {
                    node: node
                      ? `${node.nodeName.toLowerCase()}${
                          className ? `.${className.split(/\s+/).join(".")}` : ""
                        }`
                      : "(detached)",
                    previous: rect(source.previousRect),
                    current: rect(source.currentRect),
                  };
                }),
              });
            }
          }).observe({ type: "layout-shift", buffered: true });
        });

        let runApiCalls = 0;
        page.on("request", (request) => {
          if (request.url().includes("/api/runs")) runApiCalls += 1;
        });

        for (const route of ["/tasks", `/runs/${RUN_ID}`]) {
          await page.goto(`${server.url}${route}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          await page.waitForFunction(
            () => !!document.querySelector(".nitely-loading-pill"),
            undefined,
            { timeout: 20_000 },
          );
          // Let the first render and its follow-up poll settle before measuring.
          await page.waitForTimeout(1_500);

          const before = runApiCalls;
          const probe = await observe(page, OBSERVATION_MS);
          const polls = runApiCalls - before;

          expect(
            polls,
            `${route} did not poll during the observation window, so the measurement proves nothing`,
          ).toBeGreaterThanOrEqual(2);
          expect(
            probe.shifts,
            `${route} shifted layout while polling: ${JSON.stringify(probe.shifts)}`,
          ).toEqual([]);
          // A poll must not restyle the indicator either: the pill used to grow
          // and shrink once a second as its label mounted and unmounted.
          expect(
            probe.pillClasses,
            `${route} restyled the syncing pill while polling`,
          ).toEqual(["nitely-loading-pill"]);
          expect(
            probe.barClasses,
            `${route} flashed the loading bar while polling`,
          ).toEqual(["nitely-loading-bar"]);
          expect(
            probe.contentTops.length,
            `${route} moved its first section while polling: ${probe.contentTops.join(", ")}`,
          ).toBe(1);
        }

        // The quiet indicator must still be an indicator: a workspace load slow
        // enough to keep the user waiting has to raise it, and lower it after.
        await page.route("**/api/tasks", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, SLOW_FETCH_MS));
          await route.continue();
        });
        await page.goto(`${server.url}/tasks`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.waitForFunction(
          () =>
            !!document.querySelector(".nitely-loading-bar.is-syncing") &&
            !!document.querySelector(".nitely-loading-pill.is-syncing") &&
            document.querySelector(".console-main")?.getAttribute("aria-busy") === "true",
          undefined,
          { timeout: 20_000 },
        );
        await page.unroute("**/api/tasks");
        await page.waitForFunction(
          () =>
            !document.querySelector(".nitely-loading-bar.is-syncing") &&
            document.querySelector(".console-main")?.getAttribute("aria-busy") === "false",
          undefined,
          { timeout: 20_000 },
        );
      } finally {
        await browser?.close();
        await server?.close();
        await rm(repoPath, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
