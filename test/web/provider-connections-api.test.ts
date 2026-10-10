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

async function start(repoPath: string, providerValidationFetch?: typeof fetch) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerEnv: {},
    providerCommandStatus: async () => false,
    ...(providerValidationFetch ? { providerValidationFetch } : {}),
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

  it("stores a Together AI API key from the Web Console without exposing it", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);

    const saved = await post(server, "/api/providers/together/connection", {
      value: "together-console-key-0123456789",
      authMethod: "api_key",
      label: "Together AI",
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await json(saved))).not.toContain("together-console-key-0123456789");

    const statuses = await json(await fetch(`${server.url}/api/providers`));
    const together = statuses.providers.find((p: { id: string }) => p.id === "together");
    expect(together).toMatchObject({ name: "Together AI", configured: true });
    expect(together.authMethods).toEqual([
      expect.objectContaining({ method: "api_key", env: "TOGETHER_API_KEY", writable: true, configured: true }),
    ]);
    expect(JSON.stringify(statuses)).not.toContain("together-console-key-0123456789");
    const stored = await readFile(join(repoPath, ".nitely", "connections.json"), "utf8");
    expect(stored).not.toContain("together-console-key-0123456789");
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

  it("stores an OpenRouter API key from the Web Console without exposing it", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);

    const saved = await post(server, "/api/providers/openrouter/connection", {
      value: "sk-or-v1-console-key-0123456789",
      authMethod: "api_key",
      label: "OpenRouter",
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await json(saved))).not.toContain("sk-or-v1-console-key-0123456789");

    const statuses = await json(await fetch(`${server.url}/api/providers`));
    const openrouter = statuses.providers.find((p: { id: string }) => p.id === "openrouter");
    expect(openrouter).toMatchObject({ name: "OpenRouter", configured: true });
    expect(openrouter.authMethods).toEqual([
      expect.objectContaining({ method: "api_key", env: "OPENROUTER_API_KEY", writable: true, configured: true }),
    ]);
    expect(JSON.stringify(statuses)).not.toContain("sk-or-v1-console-key-0123456789");
    const stored = await readFile(join(repoPath, ".nitely", "connections.json"), "utf8");
    expect(stored).not.toContain("sk-or-v1-console-key-0123456789");
  });

  it("refuses a value that is not shaped like an OpenRouter key", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);

    const refused = await post(server, "/api/providers/openrouter/connection", {
      value: "ghp_0123456789abcdef0123456789abcdef0123",
      authMethod: "api_key",
    });
    expect(refused.status).toBe(400);
    const body = await json(refused);
    expect(body.error.message).toMatch(/start with "sk-or-"/);
    expect(JSON.stringify(body)).not.toContain("ghp_0123456789abcdef");
  });

  it("stamps lastValidatedAt only after OpenRouter accepts the stored key", async () => {
    const repoPath = await createRepo();
    let status = 401;
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const server = await start(repoPath, (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: { label: "inference", is_management_key: false, is_provisioning_key: false } }), { status });
    }) as typeof fetch);

    const saved = await json(await post(server, "/api/providers/openrouter/connection", {
      value: "sk-or-v1-console-key-0123456789",
      authMethod: "api_key",
    }));
    expect(saved.connection.lastValidatedAt).toBeUndefined();
    const validatePath = `/api/providers/openrouter/connections/${saved.connection.id}/validate`;

    const rejected = await json(await post(server, validatePath, {}));
    expect(rejected).toEqual({ ok: false, checked: "provider", reason: "rejected by OpenRouter (401)" });
    expect(seen).toEqual([
      { url: "https://openrouter.ai/api/v1/key", authorization: "Bearer sk-or-v1-console-key-0123456789" },
    ]);
    const afterReject = await json(await fetch(`${server.url}/api/providers`));
    expect(JSON.stringify(afterReject)).not.toContain("lastValidatedAt");

    status = 200;
    const accepted = await json(await post(server, validatePath, {}));
    expect(accepted).toMatchObject({ ok: true, checked: "provider", connection: { id: saved.connection.id } });
    expect(accepted.connection.lastValidatedAt).toEqual(expect.any(String));
  });

  async function savedOpenRouterKey(server: WebServer, value: string, connectionId?: string) {
    return await json(await post(server, "/api/providers/openrouter/connection", {
      value,
      authMethod: "api_key",
      ...(connectionId ? { connectionId } : {}),
    }));
  }
  async function listedConnection(server: WebServer) {
    const statuses = await json(await fetch(`${server.url}/api/providers`));
    const openrouter = statuses.providers.find((p: { id: string }) => p.id === "openrouter");
    return openrouter.authMethods[0].connections[0];
  }

  it("rejects an OpenRouter management key, which answers /key but cannot run inference", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath, (async () => new Response(JSON.stringify({
      data: { label: "admin", is_management_key: true, is_provisioning_key: true },
    }), { status: 200 })) as typeof fetch);
    const saved = await savedOpenRouterKey(server, "sk-or-v1-management-key-0123456789");

    const result = await json(await post(server, `/api/providers/openrouter/connections/${saved.connection.id}/validate`, {}));
    expect(result).toMatchObject({ ok: false, checked: "provider" });
    expect(result.reason).toMatch(/management key/);
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-management-key");
    expect((await listedConnection(server)).lastValidatedAt).toBeUndefined();
  });

  it.each([
    ["a server error", async () => new Response("upstream", { status: 500 })],
    ["a network failure", async () => { throw new TypeError("fetch failed sk-or-v1-transient-key-0123456789"); }],
    ["a 200 without key details", async () => new Response("not json", { status: 200 })],
  ])("does not stamp a key on %s", async (_label, respond) => {
    const repoPath = await createRepo();
    const server = await start(repoPath, respond as unknown as typeof fetch);
    const saved = await savedOpenRouterKey(server, "sk-or-v1-transient-key-0123456789");

    const result = await json(await post(server, `/api/providers/openrouter/connections/${saved.connection.id}/validate`, {}));
    expect(result).toMatchObject({ ok: false, checked: "provider" });
    expect(result.reason).toMatch(/^unverified: /);
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-transient-key");
    expect((await listedConnection(server)).lastValidatedAt).toBeUndefined();
  });

  it("does not stamp a key rotated in while the previous key was being validated", async () => {
    const repoPath = await createRepo();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    let reached!: () => void;
    const requestReached = new Promise<void>((resolveReached) => { reached = resolveReached; });
    const validatedWith: string[] = [];
    const server = await start(repoPath, (async (_url: string | URL | Request, init?: RequestInit) => {
      validatedWith.push(new Headers(init?.headers).get("authorization") ?? "");
      reached();
      await held;
      return new Response(JSON.stringify({ data: { is_management_key: false } }), { status: 200 });
    }) as typeof fetch);
    const saved = await savedOpenRouterKey(server, "sk-or-v1-key-a-0123456789");

    // Validation of A is in flight with the provider...
    const validation = post(server, `/api/providers/openrouter/connections/${saved.connection.id}/validate`, {});
    await requestReached;
    // ...the operator rotates to B...
    const rotated = await savedOpenRouterKey(server, "sk-or-v1-key-b-0123456789", saved.connection.id);
    expect(rotated.connection.id).toBe(saved.connection.id);
    // ...and then OpenRouter accepts A.
    release();
    const result = await json(await validation);

    expect(validatedWith).toEqual(["Bearer sk-or-v1-key-a-0123456789"]);
    expect(result).toMatchObject({ ok: false, checked: "provider" });
    expect(result.reason).toMatch(/changed while it was being validated/);
    expect((await listedConnection(server)).lastValidatedAt).toBeUndefined();
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
