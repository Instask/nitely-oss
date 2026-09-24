import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startWebServer, type WebServer } from "../../src/web/server.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-provider-conn-api-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    }),
    "utf8",
  );
  return repo;
}

async function start(repoPath: string) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerEnv: {},
    providerCommandStatus: async () => false,
  });
  servers.push(server);
  return server;
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

async function post(server: WebServer, path: string, body: unknown) {
  return await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider connections API", () => {
  it("stores an explicit auth method and reports it without the secret", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);

    const saved = await post(server, "/api/providers/anthropic/connection", {
      value: "sk-ant-oat-subscription",
      authMethod: "oauth_token",
      label: "Claude Max",
    });
    expect(saved.status).toBe(200);
    const savedBody = await json(saved);
    expect(savedBody.ok).toBe(true);
    expect(savedBody.connection).toMatchObject({
      authMethod: "oauth_token",
      label: "Claude Max",
      state: "active",
      isDefault: true,
    });
    expect(JSON.stringify(savedBody)).not.toContain("sk-ant-oat-subscription");
    expect(JSON.stringify(savedBody)).not.toContain("credentialRef");

    const statuses = await json(await fetch(`${server.url}/api/providers`));
    const anthropic = statuses.providers.find((p: { id: string }) => p.id === "anthropic");
    expect(anthropic.configured).toBe(true);
    expect(anthropic.authMethods.map((m: { method: string }) => m.method)).toEqual([
      "api_key",
      "oauth_token",
    ]);
    const oauth = anthropic.authMethods.find((m: { method: string }) => m.method === "oauth_token");
    expect(oauth.configured).toBe(true);
    expect(oauth.connections[0]).toMatchObject({ label: "Claude Max", isDefault: true });
    expect(JSON.stringify(statuses)).not.toContain("sk-ant-oat-subscription");

    // Metadata on disk carries no secret bytes.
    const stored = await readFile(join(repoPath, ".nitely", "connections.json"), "utf8");
    expect(stored).not.toContain("sk-ant-oat-subscription");
  });

  it("rejects an auth method the provider does not support or cannot paste", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const unsupported = await post(server, "/api/providers/glm/connection", {
      value: "x",
      authMethod: "oauth_token",
    });
    expect(unsupported.status).toBe(400);
    expect((await json(unsupported)).error.message).toMatch(/does not support auth method/);

    const redirectOnly = await post(server, "/api/providers/github/connection", {
      value: "gho_pasted",
      authMethod: "oauth",
    });
    expect(redirectOnly.status).toBe(400);
    expect((await json(redirectOnly)).error.message).toMatch(/connect flow/i);
  });

  it("keeps multiple connections, selects a default, and clears one by id", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const personal = await json(await post(server, "/api/providers/github/connection", {
      value: "ghp_personal",
      authMethod: "pat",
      label: "personal",
    }));
    const bot = await json(await post(server, "/api/providers/github/connection", {
      value: "ghp_bot",
      authMethod: "pat",
      label: "release bot",
    }));
    expect(personal.connection.id).not.toBe(bot.connection.id);

    const promoted = await post(
      server,
      `/api/providers/github/connections/${bot.connection.id}/default`,
      {},
    );
    expect(promoted.status).toBe(200);
    let github = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    const pat = github.authMethods.find((m: { method: string }) => m.method === "pat");
    expect(pat.connections).toHaveLength(2);
    expect(
      pat.connections.find((c: { isDefault: boolean }) => c.isDefault).id,
    ).toBe(bot.connection.id);

    const cleared = await fetch(
      `${server.url}/api/providers/github/connection?connectionId=${bot.connection.id}`,
      { method: "DELETE" },
    );
    expect(cleared.status).toBe(200);
    github = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    const remaining = github.authMethods.find((m: { method: string }) => m.method === "pat").connections;
    expect(remaining.map((c: { id: string }) => c.id)).toEqual([personal.connection.id]);
    expect(remaining[0].isDefault).toBe(true);
  });

  it("updates an existing connection in place by id", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const first = await json(await post(server, "/api/providers/glm/connection", {
      value: "glm-old",
      authMethod: "api_key",
    }));
    const rotated = await json(await post(server, "/api/providers/glm/connection", {
      value: "glm-new",
      authMethod: "api_key",
      connectionId: first.connection.id,
    }));
    expect(rotated.connection.id).toBe(first.connection.id);
    const glm = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "glm",
    );
    expect(glm.authMethods[0].connections).toHaveLength(1);
  });

  it("a legacy write without authMethod still resolves and reports the inferred method", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    await post(server, "/api/providers/anthropic/connection", { value: "sk-ant-api03-legacy" });
    const anthropic = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "anthropic",
    );
    expect(
      anthropic.authMethods.find((m: { method: string }) => m.method === "api_key").configured,
    ).toBe(true);
  });
});
