import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreviewSessionManager } from "../../src/preview/manager.js";
import { writePreviewSessionRecord } from "../../src/preview/store.js";
import type {
  PreviewDiagnosticEvent,
  PreviewHierarchyNode,
  PreviewProviderCapabilities,
  PreviewRuntimeProvider,
  PreviewRuntimeSession,
  PreviewRuntimeStartInput,
  PreviewSessionRecord,
} from "../../src/preview/types.js";

const previewCapabilities: PreviewProviderCapabilities = {
  provider: "fake-preview",
  actions: [
    "navigate",
    "reload",
    "screenshot",
    "diagnostics",
    "hierarchy",
    "click",
    "type",
    "scroll",
  ],
  screenshots: { viewport: true, fullPage: true, formats: ["png"] },
  diagnostics: { console: true, pageErrors: true, failedRequests: true },
  hierarchy: { dom: true, layoutBoxes: true, computedStyle: true },
};

const fakeScreenshot = Buffer.from("fake preview screenshot\n", "utf8");

class FakePreviewRuntimeSession implements PreviewRuntimeSession {
  readonly provider = "fake-preview";
  readonly capabilities = previewCapabilities;
  readonly clicks: string[] = [];
  readonly types: Array<{ selector: string; text: string }> = [];
  readonly scrolls: Array<{ deltaX?: number; deltaY?: number }> = [];
  closed = false;
  #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async currentUrl(): Promise<string | undefined> {
    return this.#url;
  }

  async navigate(url: string): Promise<string | undefined> {
    this.#url = url;
    return this.#url;
  }

  async reload(): Promise<string | undefined> {
    return this.#url;
  }

  async screenshot(): Promise<Buffer> {
    return fakeScreenshot;
  }

  async diagnostics(): Promise<{
    console: PreviewDiagnosticEvent[];
    pageErrors: PreviewDiagnosticEvent[];
    failedRequests: PreviewDiagnosticEvent[];
  }> {
    return {
      console: [
        {
          type: "console",
          at: "2026-07-23T00:00:00.000Z",
          level: "log",
          message: "client ready",
          url: this.#url,
        },
      ],
      pageErrors: [],
      failedRequests: [],
    };
  }

  async hierarchy(): Promise<PreviewHierarchyNode> {
    return {
      tagName: "body",
      box: { x: 0, y: 0, width: 390, height: 844 },
      computedStyle: { display: "block", position: "static" },
      children: [{ tagName: "button", id: "launch", text: "Launch" }],
    };
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    this.types.push({ selector, text });
  }

  async scroll(input: { deltaX?: number; deltaY?: number }): Promise<void> {
    this.scrolls.push(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakePreviewProvider implements PreviewRuntimeProvider {
  readonly provider = "fake-preview";
  readonly capabilities = previewCapabilities;
  readonly startInputs: PreviewRuntimeStartInput[] = [];
  readonly sessions: FakePreviewRuntimeSession[] = [];
  failStart?: Error;

  async start(input: PreviewRuntimeStartInput): Promise<PreviewRuntimeSession> {
    this.startInputs.push(input);
    if (this.failStart) throw this.failStart;
    const session = new FakePreviewRuntimeSession(input.targetUrl);
    this.sessions.push(session);
    return session;
  }
}

const managers: PreviewSessionManager[] = [];
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(
    repositories.splice(0).map((repoPath) =>
      rm(repoPath, { recursive: true, force: true }),
    ),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve a TCP port");
  }
  return address.port;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createPreviewRepo(input: {
  commands?: Array<Record<string, unknown>>;
  serverScript?: string;
} = {}): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-preview-manager-"));
  repositories.push(repoPath);
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(
    join(repoPath, "preview-server.mjs"),
    input.serverScript ?? `
      import http from "node:http";
      const port = Number(process.env.PORT);
      console.log("preview server booted " + process.env.SECRET);
      const server = http.createServer((request, response) => {
        if (request.url === "/ready") {
          response.statusCode = process.env.READY === "never" ? 503 : 200;
          response.end(response.statusCode === 200 ? "ok" : "waiting");
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end("<button id='launch'>Launch</button>");
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `,
    "utf8",
  );
  await writeFile(
    join(repoPath, ".nitely", "preview.json"),
    JSON.stringify({
      schemaVersion: "nitely.preview.v1",
      commands: input.commands ?? [],
    }),
    "utf8",
  );
  return repoPath;
}

function createManager(provider: FakePreviewProvider, ids: string[]): PreviewSessionManager {
  const manager = new PreviewSessionManager({
    provider,
    createId: () => {
      const id = ids.shift();
      if (!id) throw new Error("missing test preview session id");
      return id;
    },
    env: { PATH: process.env.PATH },
  });
  managers.push(manager);
  return manager;
}

function startInput(repoPath: string, commandId = "web") {
  return {
    repoId: "default",
    repoPath,
    commandId,
    actor: { id: "operator", email: "operator@example.test" },
    ownerId: "operator",
  };
}

async function createReadyCommand(
  id = "web",
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const port = await freePort();
  return {
    id,
    command: process.execPath,
    args: ["preview-server.mjs"],
    cwd: ".",
    env: { PORT: String(port), SECRET: "top-secret", READY: "yes" },
    targetUrl: `http://127.0.0.1:${port}/`,
    allowedRoutes: ["/app"],
    readiness: { path: "/ready", timeoutMs: 2_000, intervalMs: 25 },
    ...overrides,
  };
}

describe("PreviewSessionManager", () => {
  it("starts an allowlisted command, persists metadata, redacts logs, interacts, screenshots, and stops", async () => {
    const command = await createReadyCommand();
    const repoPath = await createPreviewRepo({ commands: [command] });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, ["pvs_0000000000000001"]);

    const started = await manager.start({
      ...startInput(repoPath),
      route: "/app",
      viewport: { preset: "mobile", width: 0, height: 0 },
    });

    expect(started).toMatchObject({
      id: "pvs_0000000000000001",
      status: "ready",
      provider: "fake-preview",
      route: "/app",
      targetUrl: expect.stringMatching(/\/app$/),
      viewport: { preset: "mobile", width: 390, height: 844 },
    });
    expect(provider.startInputs[0]).toMatchObject({
      sessionId: started.id,
      viewport: { preset: "mobile", width: 390, height: 844 },
    });

    await waitFor(async () => {
      const record = await manager.get(repoPath, started.id);
      return record.server.stdoutTail.includes("[REDACTED]");
    });
    const persisted = await manager.get(repoPath, started.id);
    expect(JSON.stringify(persisted)).not.toContain("top-secret");
    expect(persisted.diagnostics.server.stdoutTail).toContain("[REDACTED]");

    const navigated = await manager.navigate(
      repoPath,
      started.id,
      `${started.targetUrl}/settings`,
    );
    expect(navigated.currentUrl).toContain("/app/settings");
    await manager.reload(repoPath, started.id);
    await manager.click(repoPath, started.id, "#launch");
    await manager.type(repoPath, started.id, "#name", "Nitely");
    await manager.scroll(repoPath, started.id, 10, 25);

    const session = provider.sessions[0];
    expect(session.clicks).toEqual(["#launch"]);
    expect(session.types).toEqual([{ selector: "#name", text: "Nitely" }]);
    expect(session.scrolls).toEqual([{ deltaX: 10, deltaY: 25 }]);

    const screenshot = await manager.screenshot({
      repoPath,
      sessionId: started.id,
      fullPage: true,
    });
    expect(screenshot).toMatchObject({
      mediaType: "image/png",
      fullPage: true,
      size: fakeScreenshot.byteLength,
      sha256: createHash("sha256").update(fakeScreenshot).digest("hex"),
    });
    await expect(
      readFile(join(repoPath, screenshot.path), "utf8"),
    ).resolves.toBe(fakeScreenshot.toString("utf8"));

    const diagnostics = await manager.diagnostics(repoPath, started.id);
    expect(diagnostics.console[0]).toMatchObject({ message: "client ready" });
    expect(diagnostics.server.stdoutTail).toContain("[REDACTED]");

    await expect(manager.hierarchy(repoPath, started.id)).resolves.toMatchObject({
      tagName: "body",
      children: [{ tagName: "button", id: "launch" }],
    });

    const stopped = await manager.stop(repoPath, started.id);
    expect(stopped.status).toBe("stopped");
    expect(session.closed).toBe(true);
  });

  it("records a failed session for a bad start command", async () => {
    const repoPath = await createPreviewRepo({
      commands: [
        {
          id: "web",
          command: "nitely-missing-preview-command",
          targetUrl: "http://127.0.0.1:9/",
          readiness: { timeoutMs: 250, intervalMs: 25 },
        },
      ],
    });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, ["pvs_0000000000000002"]);

    const failed = await manager.start(startInput(repoPath));

    expect(failed.status).toBe("failed");
    expect(failed.failure).toMatch(/ENOENT|preview server exited/i);
    expect(provider.startInputs).toEqual([]);
  });

  it("records readiness timeout and cleans up the process tree", async () => {
    const port = await freePort();
    const repoPath = await createPreviewRepo({
      commands: [
        await createReadyCommand("web", {
          env: { PORT: String(port), SECRET: "timeout-secret", READY: "never" },
          targetUrl: `http://127.0.0.1:${port}/`,
          readiness: { path: "/ready", timeoutMs: 300, intervalMs: 25 },
        }),
      ],
    });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, ["pvs_0000000000000003"]);

    const timedOut = await manager.start(startInput(repoPath));

    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.timedOutAt).toBeDefined();
    expect(provider.startInputs).toEqual([]);
    await waitFor(async () => !(await reachable(`http://127.0.0.1:${port}/ready`)));
  });

  it("cleans up the dev server when the browser provider crashes during startup", async () => {
    const command = await createReadyCommand();
    const targetUrl = String(command.targetUrl);
    const repoPath = await createPreviewRepo({ commands: [command] });
    const provider = new FakePreviewProvider();
    provider.failStart = new Error("browser crashed");
    const manager = createManager(provider, ["pvs_0000000000000004"]);

    const failed = await manager.start(startInput(repoPath));

    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("browser crashed");
    await waitFor(async () => !(await reachable(targetUrl)));
  });

  it("runs concurrent sessions without sharing runtime state", async () => {
    const first = await createReadyCommand("web-a", {
      allowedRoutes: ["/"],
    });
    const second = await createReadyCommand("web-b", {
      allowedRoutes: ["/"],
    });
    const repoPath = await createPreviewRepo({ commands: [first, second] });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, [
      "pvs_0000000000000005",
      "pvs_0000000000000006",
    ]);

    const [a, b] = await Promise.all([
      manager.start(startInput(repoPath, "web-a")),
      manager.start(startInput(repoPath, "web-b")),
    ]);

    expect([a.status, b.status]).toEqual(["ready", "ready"]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(provider.sessions).toHaveLength(2);
    await manager.navigate(repoPath, a.id, `${a.targetUrl}left`);
    await manager.navigate(repoPath, b.id, `${b.targetUrl}right`);
    const urls = await Promise.all(
      provider.sessions.map((session) => session.currentUrl()),
    );
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("left"),
        expect.stringContaining("right"),
      ]),
    );
  });

  it("marks orphaned active sessions stale after restart", async () => {
    const repoPath = await createPreviewRepo();
    const record: PreviewSessionRecord = {
      schemaVersion: "nitely.preview-session.v1",
      id: "pvs_0000000000000007",
      repoId: "default",
      repoPath,
      commandId: "web",
      status: "ready",
      actor: { id: "operator" },
      ownerId: "operator",
      provider: "fake-preview",
      capabilities: previewCapabilities,
      viewport: { width: 1440, height: 900 },
      targetUrl: "http://127.0.0.1:4174/",
      currentUrl: "http://127.0.0.1:4174/",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      server: {
        command: "pnpm",
        args: ["dev"],
        cwd: repoPath,
        readinessUrl: "http://127.0.0.1:4174/",
        stdoutTail: "",
        stderrTail: "",
      },
      diagnostics: {
        sessionId: "pvs_0000000000000007",
        collectedAt: "2026-07-23T00:00:00.000Z",
        console: [],
        pageErrors: [],
        failedRequests: [],
        server: { stdoutTail: "", stderrTail: "" },
      },
      screenshots: [],
    };
    await writePreviewSessionRecord(repoPath, record);
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, []);

    const [stale] = await manager.markStale(repoPath);

    expect(stale).toMatchObject({
      id: record.id,
      status: "stale",
      failure: "preview session was active when Nitely restarted",
    });
    await expect(manager.get(repoPath, record.id)).resolves.toMatchObject({
      status: "stale",
    });
  });

  it("rejects unsafe target URLs and disallowed routes before starting a process", async () => {
    const command = await createReadyCommand();
    const repoPath = await createPreviewRepo({ commands: [command] });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, ["pvs_0000000000000008"]);

    await expect(
      manager.start({
        ...startInput(repoPath),
        targetUrl: "https://example.com",
      }),
    ).rejects.toThrow("loopback");
    await expect(
      manager.start({
        ...startInput(repoPath),
        route: "/admin",
      }),
    ).rejects.toThrow("not allowed");
    expect(provider.startInputs).toEqual([]);
  });

  it("rejects unsafe readiness URLs and invalid route allowlists before starting a process", async () => {
    const unsafeReadinessRepo = await createPreviewRepo({
      commands: [
        await createReadyCommand("web", {
          readiness: {
            url: "https://example.com/ready",
            timeoutMs: 250,
            intervalMs: 25,
          },
        }),
      ],
    });
    const invalidAllowlistRepo = await createPreviewRepo({
      commands: [
        await createReadyCommand("web", {
          allowedRoutes: ["relative"],
        }),
      ],
    });
    const provider = new FakePreviewProvider();
    const manager = createManager(provider, []);

    await expect(manager.start(startInput(unsafeReadinessRepo)))
      .rejects.toThrow("preview readiness.url must use a loopback host");
    await expect(manager.start(startInput(invalidAllowlistRepo)))
      .rejects.toThrow("allowedRoutes must contain absolute paths");
    expect(provider.startInputs).toEqual([]);
  });
});
