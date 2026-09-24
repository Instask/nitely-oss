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
import { PNG } from "pngjs";

import type {
  PreviewDiagnosticEvent,
  PreviewHierarchyNode,
  PreviewProviderCapabilities,
  PreviewRuntimeProvider,
  PreviewRuntimeSession,
  PreviewRuntimeStartInput,
} from "../../src/preview/types.js";
import {
  startWebServer,
  type StartWebServerInput,
  type WebServer,
} from "../../src/web/server.js";

const capabilities: PreviewProviderCapabilities = {
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

function pngPayload(): Buffer {
  const png = new PNG({ width: 1, height: 1 });
  png.data = Buffer.from([255, 255, 255, 255]);
  return PNG.sync.write(png);
}

const screenshotPayload = pngPayload();

class FakeRuntimeSession implements PreviewRuntimeSession {
  readonly provider = "fake-preview";
  readonly capabilities = capabilities;
  clicks: string[] = [];
  typed: Array<{ selector: string; text: string }> = [];
  scrolled: Array<{ deltaX?: number; deltaY?: number }> = [];
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
    return screenshotPayload;
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
          level: "info",
          message: "hydrated",
          url: this.#url,
        },
      ],
      pageErrors: [],
      failedRequests: [],
    };
  }

  async hierarchy(): Promise<PreviewHierarchyNode> {
    return {
      tagName: "main",
      id: "app",
      box: { x: 0, y: 0, width: 390, height: 844 },
      computedStyle: { display: "block" },
    };
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    this.typed.push({ selector, text });
  }

  async scroll(input: { deltaX?: number; deltaY?: number }): Promise<void> {
    this.scrolled.push(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeProvider implements PreviewRuntimeProvider {
  readonly provider = "fake-preview";
  readonly capabilities = capabilities;
  readonly inputs: PreviewRuntimeStartInput[] = [];
  readonly sessions: FakeRuntimeSession[] = [];

  async start(input: PreviewRuntimeStartInput): Promise<PreviewRuntimeSession> {
    this.inputs.push(input);
    const session = new FakeRuntimeSession(input.targetUrl);
    this.sessions.push(session);
    return session;
  }
}

const servers: WebServer[] = [];
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
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

async function createRepo(options: {
  synthetic?: boolean;
} = {}): Promise<{ repoPath: string; port: number }> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-preview-"));
  repositories.push(repoPath);
  const port = await freePort();
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(
    join(repoPath, "preview-server.mjs"),
    `
      import http from "node:http";
      const server = http.createServer((request, response) => {
        if (request.url === "/ready") {
          response.end("ok");
          return;
        }
        if (request.url === "/echo-cookie") {
          response.end(request.headers.cookie || "no-cookie");
          return;
        }
        response.end("<main id='app'>Preview</main>");
      });
      server.listen(Number(process.env.PORT), "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `,
    "utf8",
  );
  await writeFile(
    join(repoPath, ".nitely", "preview.json"),
    JSON.stringify({
      schemaVersion: "nitely.preview.v1",
      commands: [
        {
          id: "web",
          command: process.execPath,
          args: ["preview-server.mjs"],
          cwd: ".",
          env: { PORT: String(port) },
          targetUrl: `http://127.0.0.1:${port}/`,
          allowedRoutes: ["/app"],
          readiness: { path: "/ready", timeoutMs: 2_000, intervalMs: 25 },
        },
      ],
    }),
    "utf8",
  );
  return { repoPath, port };
}

async function start(
  repoPath: string,
  provider: FakeProvider,
  options: Omit<
    Partial<StartWebServerInput>,
    "repoPath" | "host" | "port" | "previewProvider"
  > = {},
): Promise<WebServer> {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    previewProvider: provider,
    createPreviewSessionId: () => "pvs_1111111111111111",
    previewEnv: { PATH: process.env.PATH },
    readRepositoryOrigin: async () => undefined,
    ...options,
    repositories: [
      { id: "home", name: "home", path: repoPath },
      ...(options.repositories ?? []),
    ],
  });
  servers.push(server);
  return server;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function expectWebInputError(
  response: Response,
  message: string,
): Promise<void> {
  expect(response.status).toBe(400);
  await expect(json(response)).resolves.toMatchObject({ error: { message } });
}

async function auditEventCount(repoPath: string): Promise<number> {
  try {
    return (await readFile(
      join(repoPath, ".nitely", "security", "audit.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
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

describe("preview sessions Web API", () => {
  it("starts, lists, inspects, controls, screenshots, and stops a preview session", async () => {
    const { repoPath } = await createRepo();
    const provider = new FakeProvider();
    const server = await start(repoPath, provider);

    const createResponse = await fetch(`${server.url}/api/preview-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "home",
        commandId: "web",
        route: "/app",
        viewport: { preset: "mobile" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await json(createResponse) as {
      session: { id: string; status: string; currentUrl: string; viewport: unknown };
    };
    expect(created.session).toMatchObject({
      id: "pvs_1111111111111111",
      status: "ready",
      currentUrl: expect.stringMatching(/\/app$/),
      viewport: { preset: "mobile", width: 390, height: 844 },
    });

    const listed = await json(await fetch(`${server.url}/api/preview-sessions`)) as {
      sessions: Array<{ id: string }>;
      viewportPresets: Record<string, { width: number; height: number }>;
    };
    expect(listed.sessions.map((session) => session.id)).toEqual([
      created.session.id,
    ]);
    expect(listed.viewportPresets).toMatchObject({
      desktop: { width: 1440, height: 900 },
      tablet: { width: 1024, height: 768 },
      mobile: { width: 390, height: 844 },
    });

    const detail = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}`),
    ) as { session: { id: string } };
    expect(detail.session.id).toBe(created.session.id);

    const navigated = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}/navigate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "/app/settings?tab=preview" }),
      }),
    ) as { session: { currentUrl: string } };
    expect(navigated.session.currentUrl).toContain("/app/settings");

    const deniedNavigation = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/navigate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/" }),
      },
    );
    await expectWebInputError(
      deniedNavigation,
      "preview navigation must stay on the session origin",
    );
    const deniedRoute = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/navigate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "/admin" }),
      },
    );
    await expectWebInputError(
      deniedRoute,
      "preview route is not allowed by repository config",
    );

    const reload = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/reload`,
      { method: "POST" },
    );
    expect(reload.status).toBe(200);

    const screenshotResponse = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/screenshot`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullPage: true }),
      },
    );
    expect(screenshotResponse.status).toBe(201);
    const screenshotBody = await json(screenshotResponse) as {
      screenshot: { id: string; sha256: string; size: number; fullPage: boolean };
      session: { screenshots: unknown[] };
    };
    expect(screenshotBody.screenshot).toMatchObject({
      sha256: createHash("sha256").update(screenshotPayload).digest("hex"),
      size: screenshotPayload.byteLength,
      fullPage: true,
    });
    expect(screenshotBody.session.screenshots).toHaveLength(1);

    const proxied = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/proxy/app`,
    );
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("content-security-policy")).toContain("sandbox");
    expect(proxied.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(await proxied.text()).toContain("<main id='app'>Preview</main>");
    const cookieProbe = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/proxy/echo-cookie`,
      { headers: { cookie: "nitely_session=secret" } },
    );
    expect(cookieProbe.status).toBe(200);
    expect(await cookieProbe.text()).toBe("no-cookie");

    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-preview-evidence",
    );
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-preview-evidence",
        sessionId: "run-preview-evidence",
        status: "completed",
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    const attachmentResponse = await fetch(
      `${server.url}/api/preview-sessions/${created.session.id}/attach-screenshot`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          screenshotId: screenshotBody.screenshot.id,
          runId: "run-preview-evidence",
          note: "acceptance evidence",
        }),
      },
    );
    if (process.platform === "linux") {
      expect(attachmentResponse.status).toBe(201);
      const attachment = await json(attachmentResponse) as {
        attachment: { artifact: { id: string; type: string; mediaType: string } };
      };
      expect(attachment.attachment.artifact).toMatchObject({
        id: `preview-${created.session.id}-${screenshotBody.screenshot.id}`,
        type: "preview-screenshot",
        mediaType: "image/png",
      });
      const registry = JSON.parse(
        await readFile(join(runDirectory, "artifacts.json"), "utf8"),
      ) as { artifacts: Array<{ id: string; sha256: string; path: string }> };
      expect(registry.artifacts).toEqual([
        expect.objectContaining({
          id: `preview-${created.session.id}-${screenshotBody.screenshot.id}`,
          sha256: createHash("sha256").update(screenshotPayload).digest("hex"),
          path: expect.stringContaining("preview-evidence/"),
        }),
      ]);

      await mkdir(join(runDirectory, "inputs"), { recursive: true });
      await writeFile(join(runDirectory, "inputs/reference.png"), screenshotPayload);
      const comparisonResponse = await fetch(
        `${server.url}/api/preview-sessions/${created.session.id}/compare-reference`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "run-preview-evidence",
            comparisonId: "preview-exact",
            reference: { path: "inputs/reference.png" },
            screenshotId: screenshotBody.screenshot.id,
            pixelmatchThreshold: 0,
          }),
        },
      );
      expect(comparisonResponse.status).toBe(201);
      const comparisonBody = await json(comparisonResponse) as {
        comparison: {
          status: string;
          metrics: { changedPixelCount: number };
          artifacts: { diff: { path: string } };
        };
        artifacts: { diff: { sha256: string } };
      };
      expect(comparisonBody.comparison).toMatchObject({
        status: "match",
        metrics: { changedPixelCount: 0 },
        artifacts: {
          diff: { path: "visual-comparisons/preview-exact/diff.png" },
        },
      });
      expect(comparisonBody.artifacts.diff.sha256).toMatch(/^[a-f0-9]{64}$/);
    } else {
      await expectWebInputError(
        attachmentResponse,
        "preview screenshot evidence attach requires Linux run-owned file anchoring",
      );
    }

    const diagnostics = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}/diagnostics`),
    ) as { diagnostics: { console: Array<{ message: string }> } };
    expect(diagnostics.diagnostics.console[0]).toMatchObject({
      message: "hydrated",
    });

    const hierarchy = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}/hierarchy`),
    ) as { hierarchy: { tagName: string; id: string } };
    expect(hierarchy.hierarchy).toMatchObject({ tagName: "main", id: "app" });

    await fetch(`${server.url}/api/preview-sessions/${created.session.id}/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector: "#launch" }),
    });
    await fetch(`${server.url}/api/preview-sessions/${created.session.id}/type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector: "#name", text: "Nitely" }),
    });
    await fetch(`${server.url}/api/preview-sessions/${created.session.id}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deltaX: 5, deltaY: 10 }),
    });
    expect(provider.sessions[0].clicks).toEqual(["#launch"]);
    expect(provider.sessions[0].typed).toEqual([
      { selector: "#name", text: "Nitely" },
    ]);
    expect(provider.sessions[0].scrolled).toEqual([{ deltaX: 5, deltaY: 10 }]);

    const restarted = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}/restart`, {
        method: "POST",
      }),
    ) as { session: { id: string; status: string } };
    expect(restarted.session).toMatchObject({
      id: "pvs_1111111111111111",
      status: "ready",
    });
    expect(provider.sessions[0].closed).toBe(true);
    expect(provider.sessions).toHaveLength(2);

    const stopped = await json(
      await fetch(`${server.url}/api/preview-sessions/${created.session.id}/stop`, {
        method: "POST",
      }),
    ) as { session: { status: string } };
    expect(stopped.session.status).toBe("stopped");
    expect(provider.sessions[1].closed).toBe(true);
    await waitFor(async () => (await auditEventCount(repoPath)) >= 14);
  });

  it("rejects disallowed start routes and synthetic repositories", async () => {
    const { repoPath } = await createRepo();
    const provider = new FakeProvider();
    const server = await start(repoPath, provider, {
      repositories: [
        {
          id: "demo",
          name: "Demo",
          path: repoPath,
          synthetic: true,
        },
      ],
    });

    const disallowedRoute = await fetch(`${server.url}/api/preview-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "home",
        commandId: "web",
        route: "/admin",
      }),
    });
    await expectWebInputError(
      disallowedRoute,
      "preview route is not allowed by repository config",
    );

    const synthetic = await fetch(`${server.url}/api/preview-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "demo",
        commandId: "web",
        route: "/app",
      }),
    });
    await expectWebInputError(
      synthetic,
      "preview sessions require a real repository",
    );
    await waitFor(async () => (await auditEventCount(repoPath)) >= 2);
  });
});
