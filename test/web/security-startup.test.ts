import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isLoopbackBindHost,
  startWebServer,
  webListenerUrl,
  type StartWebServerInput,
  type WebServer,
} from "../../src/web/server.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";

const servers: WebServer[] = [];

async function repo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-web-security-startup-"));
}

async function start(
  overrides: Partial<StartWebServerInput> = {},
): Promise<WebServer> {
  const repoPath = overrides.repoPath ?? (await repo());
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    ...overrides,
    repositories: [
      { id: "home", name: "home", path: repoPath },
      ...(overrides.repositories ?? []),
    ],
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Web startup security boundary", () => {
  it("keeps local compatibility mode limited to a loopback listener", async () => {
    const server = await start();

    expect(server.readiness).toEqual({
      schemaVersion: "nitely.web-security-readiness.v1",
      ready: true,
      production: false,
      auth: { mode: "local", adminConfigured: false },
      bind: { host: "127.0.0.1", scope: "loopback" },
      transport: {
        mode: "loopback-http",
        trustedProxy: false,
        secureCookie: false,
      },
      execution: {
        backend: "local",
        reason: "trusted-local-default",
        unsafeOverride: false,
      },
    });

    const response = await fetch(`${server.url}/api/readiness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(server.readiness);
  });

  it("rejects local auth on a non-loopback bind before opening a listener", async () => {
    await expect(start({ host: "0.0.0.0" })).rejects.toThrow(
      /non-loopback.*authentication.*required/i,
    );
  });

  it("requires both an explicit trusted proxy and secure cookies on a network bind", async () => {
    const repoPath = await repo();
    const admin = {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "unique production admin passphrase",
    };

    await expect(startWebServer({
      repoPath,
      host: "0.0.0.0",
      port: 0,
      authMode: "required",
      authEnv: admin,
      repositories: [{ id: "home", name: "home", path: repoPath }],
    })).rejects.toThrow(/NITELY_WEB_TRUSTED_PROXY=true/);

    await expect(startWebServer({
      repoPath,
      host: "0.0.0.0",
      port: 0,
      authMode: "required",
      authEnv: { ...admin, NITELY_WEB_TRUSTED_PROXY: "true" },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    })).rejects.toThrow(
      /NITELY_WEB_SECURE_COOKIE=true.*NITELY_WEB_INSECURE_TEST_COOKIE=true|NITELY_WEB_INSECURE_TEST_COOKIE=true.*NITELY_WEB_SECURE_COOKIE=true/,
    );

    await expect(startWebServer({
      repoPath,
      host: "0.0.0.0",
      port: 0,
      authMode: "required",
      authEnv: {
        ...admin,
        NITELY_WEB_TRUSTED_PROXY: "true",
        NITELY_WEB_INSECURE_TEST_COOKIE: "false",
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    })).rejects.toThrow(
      /NITELY_WEB_SECURE_COOKIE=true.*NITELY_WEB_INSECURE_TEST_COOKIE=true|NITELY_WEB_INSECURE_TEST_COOKIE=true.*NITELY_WEB_SECURE_COOKIE=true/,
    );
  });

  it("starts an authenticated network bind only with the declared proxy boundary", async () => {
    const server = await start({
      host: "0.0.0.0",
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "unique production admin passphrase",
        NITELY_WEB_TRUSTED_PROXY: "true",
        NITELY_WEB_SECURE_COOKIE: "true",
      },
    });

    expect(server.readiness).toMatchObject({
      ready: true,
      auth: { mode: "required", adminConfigured: true },
      bind: { host: "0.0.0.0", scope: "non-loopback" },
      transport: {
        mode: "trusted-reverse-proxy",
        trustedProxy: true,
        secureCookie: true,
      },
    });
  });

  it("allows trusted-proxy non-loopback startup with insecure test cookies for LAN HTTP dogfood", async () => {
    const server = await start({
      host: "0.0.0.0",
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "unique production admin passphrase",
        NITELY_WEB_TRUSTED_PROXY: "true",
        NITELY_WEB_INSECURE_TEST_COOKIE: "true",
      },
    });

    expect(server.readiness).toMatchObject({
      ready: true,
      auth: { mode: "required", adminConfigured: true },
      bind: { host: "0.0.0.0", scope: "non-loopback" },
      transport: {
        mode: "trusted-reverse-proxy",
        trustedProxy: true,
        secureCookie: false,
      },
    });
  });

  it("fails production startup without an administrator and audits explicit first-admin bootstrap", async () => {
    const missingAdminRepo = await repo();
    await expect(startWebServer({
      repoPath: missingAdminRepo,
      host: "127.0.0.1",
      port: 0,
      authMode: "required",
      authEnv: { NODE_ENV: "production" },
      repositories: [{ id: "home", name: "home", path: missingAdminRepo }],
    })).rejects.toThrow(/production.*administrator/i);

    const bootstrappedRepo = await repo();
    const server = await start({
      repoPath: bootstrappedRepo,
      authMode: "required",
      authEnv: {
        NODE_ENV: "production",
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "unique production admin passphrase",
      },
    });
    expect(server.readiness).toMatchObject({
      ready: true,
      production: true,
      auth: { mode: "required", adminConfigured: true },
    });
    expect(await listSecurityAuditEvents(bootstrappedRepo)).toEqual([
      expect.objectContaining({
        action: "auth.bootstrap",
        decision: "allow",
        outcome: "success",
        reasonCode: "explicit_initial_admin",
        actor: { type: "anonymous" },
        target: expect.objectContaining({ type: "user" }),
      }),
    ]);
  });

  it("reports required-auth loopback setup as not ready outside production", async () => {
    const server = await start({ authMode: "required", authEnv: {} });

    expect(server.readiness).toMatchObject({
      ready: false,
      production: false,
      auth: { mode: "required", adminConfigured: false },
    });
    const response = await fetch(`${server.url}/api/readiness`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(server.readiness);
  });

  it("rejects invalid auth and boolean configuration instead of falling back", async () => {
    await expect(start({
      authEnv: { NITELY_WEB_AUTH: "optional" },
    })).rejects.toThrow(/NITELY_WEB_AUTH.*local or required/);
    await expect(start({
      authEnv: { NITELY_WEB_SECURE_COOKIE: "sometimes" },
    })).rejects.toThrow(/NITELY_WEB_SECURE_COOKIE.*boolean/);
    await expect(start({
      authEnv: { NITELY_WEB_TRUSTED_PROXY: "maybe" },
    })).rejects.toThrow(/NITELY_WEB_TRUSTED_PROXY.*boolean/);
    await expect(start({
      authEnv: { NITELY_WEB_INSECURE_TEST_COOKIE: "sometimes" },
    })).rejects.toThrow(/NITELY_WEB_INSECURE_TEST_COOKIE.*boolean/);
  });

  it("freezes validated auth and cookie controls for the lifetime of the listener", async () => {
    const authEnv: Record<string, string | undefined> = {
      NITELY_WEB_AUTH: "required",
      NITELY_WEB_SECURE_COOKIE: "true",
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "unique production admin passphrase",
    };
    const server = await start({ authEnv });

    authEnv.NITELY_WEB_AUTH = "local";
    authEnv.NITELY_WEB_SECURE_COOKIE = "false";

    const unauthenticated = await fetch(`${server.url}/api/tasks`);
    expect(unauthenticated.status).toBe(401);
    const login = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "unique production admin passphrase",
      }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("; Secure");

    expect(Object.isFrozen(server.readiness)).toBe(true);
    expect(Object.isFrozen(server.readiness?.auth)).toBe(true);
    expect(() => {
      (server.readiness?.auth as { adminConfigured: boolean }).adminConfigured = false;
    }).toThrow();
    expect(server.readiness?.auth.adminConfigured).toBe(true);
  });

  it("classifies loopback hosts conservatively and brackets IPv6 listener URLs", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.example.test")).toBe(false);
    expect(isLoopbackBindHost("[::1]")).toBe(true);
    expect(isLoopbackBindHost("0:0:0:0:0::1")).toBe(true);
    expect(isLoopbackBindHost("[::1")).toBe(false);
    expect(isLoopbackBindHost("::1]")).toBe(false);
    expect(webListenerUrl("::1", 4173)).toBe("http://[::1]:4173");
    expect(webListenerUrl("[::1]", 4173)).toBe("http://[::1]:4173");
  });
});
