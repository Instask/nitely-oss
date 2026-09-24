import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWebServer, type WebServer } from "../../src/web/server.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("device approval page", () => {
  it("serves a standalone approval page, not the console shell", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-device-page-"));
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);

    const response = await fetch(`${server.url}/device`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Authorize a device");
    expect(html).toContain("/api/device-authorizations/approve");
    // The console shell must not be what answers this route.
    expect(html).not.toContain("work-items");
  });

  it("keys its high-impact warning off the capabilities asked for", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-device-page-"));
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);

    const html = await (await fetch(`${server.url}/device`)).text();

    // allowHighImpact only says the client would permit a high-impact
    // capability; warning off it fires on read-only requests too, and a banner
    // that fires on everything teaches admins to click past it.
    expect(html).toContain("record.highImpactCapabilities");
    expect(html).not.toContain("if (record.allowHighImpact) show(");
    // Capability names still reach the DOM as text, never as markup.
    expect(html).not.toContain("innerHTML");
  });

  it("cannot be framed: it carries X-Frame-Options and a frame-ancestors CSP", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-device-page-"));
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);

    const response = await fetch(`${server.url}/device`);
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
  });
});
