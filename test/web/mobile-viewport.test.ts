import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { startWebServer } from "../../src/web/server.js";
import { createTask, updateTaskRunState } from "../../src/web/tasks.js";
import { chromeExecutablePath } from "../helpers/chrome.js";

const TASK_ID = "task-mobile-populated-regression";
const RUN_ID = "run-mobile-populated-regression";
const STAGE_ID = "implement-responsive-console-populated-detail-regression";
const TASK_TITLE =
  "Verify populated mobile layouts for a deeply nested customer repository migration with review evidence";
const EVIDENCE_MARKER = "MOBILE-VIEWPORT-EVIDENCE-READY";
const CONTEXT_MARKER = "specification-with-a-long-context-identifier";
const STAGE_LOG_MARKER = "Verified populated layout at";
const LONG_REPOSITORY_PATH =
  "customers/acme-platform/packages/operator-console/src/features/governed-delivery/review-evidence/mobile-layout/very-long-component-name.tsx";

interface ViewportCase {
  width: number;
  height: number;
}

interface OverflowDiagnostic {
  clientWidth: number;
  scrollWidth: number;
  offenders: Array<{
    tag: string;
    className: string;
    left: number;
    right: number;
    width: number;
  }>;
}

function ignoredBrowserResource(url: string): boolean {
  return (
    url.endsWith("/favicon.ico") ||
    url.startsWith("https://fonts.googleapis.com") ||
    url.startsWith("https://fonts.gstatic.com")
  );
}

/**
 * The run detail page opens `/logs/stream` and holds it open on purpose.
 * Moving to the next viewport or surface aborts it, which is the expected end
 * of a live stream rather than a defect in the page.
 *
 * Scoped to the abort: a non-2xx response on the same URL still fails the
 * assertion, because that listener is left alone.
 */
function expectedStreamAbort(url: string, errorText: string): boolean {
  return url.includes("/logs/stream") && errorText === "net::ERR_ABORTED";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createSeededRepository(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-mobile-viewport-"));
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
          prompt: "Implement the approved responsive console change.",
          inputs: ["spec", "tech-design"],
          outputs: ["implementation"],
        },
      ],
    },
  });

  await createTask(
    repoPath,
    {
      title: TASK_TITLE,
      issueUrl: "https://github.com/Instask/nitely/issues/166",
      spec: [
        "# Populated mobile viewport fixture",
        "",
        `Inspect the long source path \`${LONG_REPOSITORY_PATH}\` without page-level overflow.`,
        `Source: https://github.com/Instask/nitely/blob/${"a".repeat(40)}/${LONG_REPOSITORY_PATH}`,
      ].join("\n"),
      techDesign: [
        "# Technical design",
        "",
        "Render long task, context, log, and evidence values inside bounded responsive regions.",
      ].join("\n"),
    },
    {
      createId: () => TASK_ID,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      initialStatus: "completed",
      specStatus: "approved",
      techDesignStatus: "approved",
      source: {
        type: "github-issue",
        uri: "https://github.com/Instask/nitely/issues/166",
        title: TASK_TITLE,
      },
    },
  );
  await updateTaskRunState(repoPath, TASK_ID, {
    status: "completed",
    latestRunId: RUN_ID,
    changeRequestUrl: "https://github.com/Instask/nitely/pull/4166",
  });

  const runDirectory = join(repoPath, ".nitely", "runs", RUN_ID);
  const attemptDirectory = join(runDirectory, "stages", STAGE_ID, "1");
  await mkdir(attemptDirectory, { recursive: true });
  const longCommand =
    "pnpm exec vitest run test/web/mobile-viewport.test.ts --reporter=verbose --configuration=customers/acme-platform/operator-console/mobile-regression.config.ts";
  await Promise.all([
    writeFile(
      join(attemptDirectory, "prompt.md"),
      `Review ${LONG_REPOSITORY_PATH} and preserve every evidence link.\n`,
      "utf8",
    ),
    writeFile(
      join(attemptDirectory, "stdout.log"),
      `Verified ${LONG_REPOSITORY_PATH} with ${longCommand}.\n`,
      "utf8",
    ),
    writeFile(
      join(attemptDirectory, "stderr.log"),
      `Non-fatal diagnostic for ${LONG_REPOSITORY_PATH}.\n`,
      "utf8",
    ),
    writeFile(
      join(attemptDirectory, "output.md"),
      `Implementation evidence for ${LONG_REPOSITORY_PATH}.\n`,
      "utf8",
    ),
    writeFile(
      join(attemptDirectory, "implementation.md"),
      `Changed ${LONG_REPOSITORY_PATH}.\n`,
      "utf8",
    ),
    writeFile(
      join(runDirectory, "evidence.md"),
      [
        `# ${EVIDENCE_MARKER}`,
        "",
        `- Source: \`${LONG_REPOSITORY_PATH}\``,
        `- Command: \`${longCommand}\``,
        "- Result: populated task, stage, context, artifact, and evidence rows rendered.",
      ].join("\n"),
      "utf8",
    ),
  ]);

  await writeJson(join(runDirectory, "context-manifest.json"), {
    version: 1,
    runId: RUN_ID,
    generatedAt: "2026-07-14T00:00:03.000Z",
    entries: [
      {
        id: "specification-with-a-long-context-identifier",
        kind: "external-input",
        connector: "local-file",
        sourceUri: `.nitely/tasks/${TASK_ID}/versions/spec/r1.md`,
        mediaType: "text/markdown",
        filename: "populated-mobile-viewport-specification-with-long-name.md",
        runRelativePath: `inputs/spec/${LONG_REPOSITORY_PATH}`,
        policy: { decision: "allowed" },
      },
      {
        id: "implementation-with-a-long-artifact-identifier",
        kind: "generated-artifact",
        connector: "generated",
        sourceUri: `stages/${STAGE_ID}/1/implementation.md`,
        mediaType: "text/markdown",
        filename: "implementation-with-long-evidence-name.md",
        runRelativePath: `stages/${STAGE_ID}/1/implementation.md`,
        policy: { decision: "allowed" },
      },
    ],
  });
  await writeJson(join(runDirectory, "artifacts.json"), {
    runId: RUN_ID,
    artifacts: [
      {
        id: "implementation-with-a-long-artifact-identifier",
        name: "Populated responsive console implementation evidence artifact",
        type: "implementation",
        description: `Review-grade output for ${LONG_REPOSITORY_PATH}`,
        producer: STAGE_ID,
        mediaType: "text/markdown",
        version: "1",
        path: `stages/${STAGE_ID}/1/implementation.md`,
        filename: "implementation-with-long-evidence-name.md",
        createdAt: "2026-07-14T00:00:08.000Z",
      },
    ],
  });

  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  const store = new EventStore(join(repoPath, ".nitely", "events.db"));
  try {
    store.append({
      runId: RUN_ID,
      type: "run.created",
      createdAt: "2026-07-14T00:00:00.000Z",
      payload: {
        flowName: "implement-spec-bootstrap-with-populated-mobile-evidence",
        flowPath: "flows/implement-spec-bootstrap.json",
        workItemId: TASK_ID,
        workItemType: "dev.pr",
        repoId: "customer-acme-platform-operator-console",
        repoName: "Acme Platform / Governed Delivery Operator Console",
        repoPath: `/srv/customer-repositories/${LONG_REPOSITORY_PATH}`,
        branchName:
          "nitely/run-mobile-populated-regression-with-a-long-responsive-branch-name",
        baseBranch: "main",
        inputs: {
          spec: {
            connector: "local-file",
            sourceUri: `.nitely/tasks/${TASK_ID}/versions/spec/r1.md`,
            mediaType: "text/markdown",
          },
          "tech-design": {
            connector: "local-file",
            sourceUri: `.nitely/tasks/${TASK_ID}/versions/tech-design/r1.md`,
            mediaType: "text/markdown",
          },
        },
        configuration: { verifyCommand: longCommand },
        workflowStages: [
          {
            id: STAGE_ID,
            type: "agent",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation-with-a-long-artifact-identifier"],
            maxAttempts: 2,
          },
        ],
      },
    });
    store.append({
      runId: RUN_ID,
      type: "workspace.created",
      createdAt: "2026-07-14T00:00:01.000Z",
      payload: {
        worktreePath: `/srv/nitely-worktrees/${RUN_ID}/${LONG_REPOSITORY_PATH}`,
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
        runtime: "codex",
        model: "gpt-5-codex-mobile-viewport-regression",
        attemptDirectory,
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "stage.context.usage",
      createdAt: "2026-07-14T00:00:03.000Z",
      payload: {
        promptBytes: 123_456,
        approxTokens: 30_864,
        inputBytesInlined: 98_765,
        inputBytesSaved: 24_691,
        inputCount: 12,
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "stage.runtime.usage",
      createdAt: "2026-07-14T00:00:04.000Z",
      payload: {
        inputTokens: 28_000,
        outputTokens: 4_500,
        totalTokens: 32_500,
        estimatedCostUsd: 1.2345,
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "command.completed",
      createdAt: "2026-07-14T00:00:05.000Z",
      payload: {
        command: longCommand,
        stdout: `Verified populated layout at ${LONG_REPOSITORY_PATH}`,
        stderr: `Bounded diagnostic output for ${LONG_REPOSITORY_PATH}`,
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-07-14T00:00:06.000Z",
      payload: {
        artifact: {
          id: "implementation-with-a-long-artifact-identifier",
          producer: STAGE_ID,
          mediaType: "text/markdown",
          path: `stages/${STAGE_ID}/1/implementation.md`,
          manifestSource: "declared-manifest",
        },
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "gate.completed",
      createdAt: "2026-07-14T00:00:07.000Z",
      payload: {
        gate: {
          id: "populated-mobile-viewport-deterministic-gate",
          stageId: STAGE_ID,
          mode: "deterministic",
          status: "passed",
          command: longCommand,
          stdout: `No page overflow for ${LONG_REPOSITORY_PATH}`,
          stderr: "",
          createdAt: "2026-07-14T00:00:07.000Z",
        },
      },
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "stage.completed",
      createdAt: "2026-07-14T00:00:08.000Z",
      payload: {},
    });
    store.append({
      runId: RUN_ID,
      stageId: STAGE_ID,
      attempt: 1,
      type: "change.published",
      createdAt: "2026-07-14T00:00:09.000Z",
      payload: {
        url: "https://github.com/Instask/nitely/pull/4166",
        branchName:
          "nitely/run-mobile-populated-regression-with-a-long-responsive-branch-name",
        headCommit: "b".repeat(40),
        changeRequest: {
          provider: "github",
          url: "https://github.com/Instask/nitely/pull/4166",
          number: 4166,
          owner: "Instask",
          repository: "nitely",
          baseBranch: "main",
          headBranch:
            "nitely/run-mobile-populated-regression-with-a-long-responsive-branch-name",
          draft: true,
        },
      },
    });
    store.append({
      runId: RUN_ID,
      type: "run.completed",
      createdAt: "2026-07-14T00:00:10.000Z",
      payload: {
        changeRequestUrl: "https://github.com/Instask/nitely/pull/4166",
      },
    });
  } finally {
    store.close();
  }
  return repoPath;
}

async function waitForRenderedFixture(page: Page, marker: string): Promise<void> {
  try {
    await page.waitForFunction(
      (expected) => document.body.innerText.includes(String(expected)),
      marker,
      { timeout: 20_000 },
    );
  } catch (error) {
    const body = (await page.locator("body").innerText()).slice(0, 2_000);
    throw new Error(`fixture marker was not rendered: ${marker}\n${body}`, {
      cause: error,
    });
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function overflowDiagnostic(page: Page): Promise<OverflowDiagnostic> {
  return await page.evaluate(() => {
    const documentElement = document.documentElement;
    const clientWidth = documentElement.clientWidth;
    const offenders = [...document.body.querySelectorAll<HTMLElement>("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className || "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0,
        };
      })
      .filter(
        (entry) => entry.visible && (entry.right > clientWidth + 1 || entry.left < -1),
      )
      .sort(
        (left, right) =>
          Math.max(right.right - clientWidth, -right.left) -
          Math.max(left.right - clientWidth, -left.left),
      )
      .slice(0, 8)
      .map(({ visible: _visible, ...entry }) => entry);
    return {
      clientWidth,
      scrollWidth: documentElement.scrollWidth,
      offenders,
    };
  });
}

describe("seeded Web Console mobile viewports", () => {
  it(
    "renders populated task and run detail surfaces without page-level horizontal overflow",
    async () => {
      const repoPath = await createSeededRepository();
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
        const page = await browser.newPage();
        const browserErrors: string[] = [];
        page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          const location = message.location().url;
          if (ignoredBrowserResource(location)) return;
          browserErrors.push(`console: ${message.text()} (${location || "unknown URL"})`);
        });
        page.on("requestfailed", (request) => {
          const url = request.url();
          if (ignoredBrowserResource(url)) return;
          const errorText = request.failure()?.errorText ?? "failed";
          if (expectedStreamAbort(url, errorText)) return;
          browserErrors.push(`request: ${url} (${errorText})`);
        });
        page.on("response", (response) => {
          if (response.status() < 400 || ignoredBrowserResource(response.url())) return;
          browserErrors.push(`response: ${response.status()} ${response.url()}`);
        });

        const viewports: ViewportCase[] = [
          { width: 360, height: 800 },
          { width: 390, height: 844 },
          { width: 430, height: 932 },
          { width: 1280, height: 900 },
        ];
        const surfaces = [
          { route: "/tasks", markers: [TASK_TITLE], expandStage: false },
          {
            route: `/runs/${RUN_ID}`,
            markers: [EVIDENCE_MARKER, CONTEXT_MARKER],
            expandStage: true,
          },
        ];
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          for (const surface of surfaces) {
            browserErrors.length = 0;
            const response = await page.goto(`${server.url}${surface.route}`, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            expect(response?.status(), `${surface.route} should load`).toBe(200);
            for (const marker of surface.markers) {
              await waitForRenderedFixture(page, marker);
            }
            if (surface.expandStage) {
              await page.locator(`[data-stage="${RUN_ID}:${STAGE_ID}"]`).click();
              await waitForRenderedFixture(page, STAGE_LOG_MARKER);
            }
            const diagnostic = await overflowDiagnostic(page);
            expect(
              browserErrors,
              `${surface.route} at ${viewport.width}px had browser errors`,
            ).toEqual([]);
            expect(
              diagnostic.scrollWidth,
              `${surface.route} at ${viewport.width}px overflowed: ${JSON.stringify(diagnostic)}`,
            ).toBeLessThanOrEqual(diagnostic.clientWidth);
          }
        }
      } finally {
        await browser?.close();
        await server?.close();
        await rm(repoPath, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
