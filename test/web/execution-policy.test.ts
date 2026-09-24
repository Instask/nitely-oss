import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  startWebServer,
  webExecutionBackendPolicy,
  type WebServer,
} from "../../src/web/server.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Web execution backend policy", () => {
  it("defaults required-auth execution to OCI", () => {
    expect(webExecutionBackendPolicy({ authMode: "required" })).toEqual({
      backend: "oci",
      reason: "required-auth-default",
      unsafeOverride: false,
    });
  });

  it("keeps trusted local mode local by default", () => {
    expect(webExecutionBackendPolicy({ authMode: "local" })).toEqual({
      backend: "local",
      reason: "trusted-local-default",
      unsafeOverride: false,
    });
  });

  it("rejects a required-auth local override without explicit administrator policy", () => {
    expect(() =>
      webExecutionBackendPolicy({
        authMode: "required",
        configuredBackend: "local",
      }),
    ).toThrow(/requires OCI/);
  });

  it("reports an explicitly enabled unsafe override", () => {
    expect(
      webExecutionBackendPolicy({
        authMode: "required",
        configuredBackend: "mise",
        allowUnsafeLocal: true,
      }),
    ).toEqual({
      backend: "mise",
      reason: "unsafe-override",
      unsafeOverride: true,
    });
  });

  it("fails Web startup instead of silently falling back to local execution", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-execution-policy-"));
    await expect(
      startWebServer({
        repoPath,
        host: "127.0.0.1",
        port: 0,
        authMode: "required",
        authEnv: {},
        providerEnv: { NITELY_EXECUTION_BACKEND: "local" },
        repositories: [{ id: "home", name: "home", path: repoPath }],
      }),
    ).rejects.toThrow(/requires OCI/);
  });

  it("exposes the selected backend and reason in readiness", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-execution-policy-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      authMode: "required",
      authEnv: {},
      providerEnv: {},
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);

    expect(server.readiness?.execution).toEqual({
      backend: "oci",
      reason: "required-auth-default",
      unsafeOverride: false,
    });
  });
});
