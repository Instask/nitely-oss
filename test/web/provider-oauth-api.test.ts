import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { startWebServer, type StartWebServerInput, type WebServer } from "../../src/web/server.js";
import { createUser } from "../../src/web/users.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-provider-oauth-"));
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

interface ProviderCall {
  url: string;
  method: string;
  body: string;
  authorization?: string;
}

function githubFetch(options: { exchangeStatus?: number; login?: string } = {}) {
  const calls: ProviderCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
    });
    if (url === "https://github.com/login/oauth/access_token") {
      if (options.exchangeStatus && options.exchangeStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), {
          status: options.exchangeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "gho_access",
          refresh_token: "ghr_refresh",
          expires_in: 28800,
          scope: "repo,read:user",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({ id: 42, login: options.login ?? "octocat", name: "The Octocat" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.github.com/applications/")) {
      return new Response("", { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

async function start(
  repoPath: string,
  options: Partial<StartWebServerInput> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerEnv: {
      NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
      NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
    },
    providerCommandStatus: async () => false,
    ...options,
  });
  servers.push(server);
  return server;
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

async function login(server: WebServer, email: string, password: string) {
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function startFlow(server: WebServer, providerId: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}/api/providers/${providerId}/oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  return { response, body: response.ok ? await json(response) : await json(response) };
}

async function callback(server: WebServer, providerId: string, query: Record<string, string>, headers: Record<string, string> = {}) {
  const url = new URL(`${server.url}/oauth/callback/${providerId}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return await fetch(url, { redirect: "manual", headers });
}

describe("provider OAuth connect flow", () => {
  it("connects GitHub through the redirect flow and stores the account identity without secrets", async () => {
    const repoPath = await createRepo();
    const github = githubFetch();
    const server = await start(repoPath, { providerOAuthFetch: github.fetch });

    const started = await startFlow(server, "github");
    expect(started.response.status).toBe(200);
    const authorize = new URL(started.body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    const state = authorize.searchParams.get("state")!;
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${server.url}/oauth/callback/github`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const response = await callback(server, "github", { code: "code-1", state });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/providers?connected=github");
    const exchange = github.calls.find((c) => c.url === "https://github.com/login/oauth/access_token")!;
    expect(new URLSearchParams(exchange.body).get("code")).toBe("code-1");
    expect(new URLSearchParams(exchange.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const providers = (await json(await fetch(`${server.url}/api/providers`))).providers;
    const status = providers.find((p: { id: string }) => p.id === "github");
    const oauth = status.authMethods.find((m: { method: string }) => m.method === "oauth");
    expect(oauth.configured).toBe(true);
    expect(oauth.connections[0]).toMatchObject({
      state: "active",
      account: { login: "octocat", displayName: "The Octocat" },
      scopes: ["repo", "read:user"],
      refreshable: true,
    });
    expect(oauth.connections[0].expiresAt).toEqual(expect.any(String));
    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain("gho_access");
    expect(serialized).not.toContain("ghr_refresh");
    expect(await readFile(join(repoPath, ".nitely", "connections.json"), "utf8")).not.toContain("gho_access");

    const audit = await listSecurityAuditEvents(repoPath);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["providers.oauth.start", "providers.oauth.connect"]),
    );
  });

  it("rejects a callback whose state was never issued and stores nothing", async () => {
    const repoPath = await createRepo();
    const github = githubFetch();
    const server = await start(repoPath, { providerOAuthFetch: github.fetch });
    const response = await callback(server, "github", { code: "code-1", state: "forged" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/providers?oauthError=unknown_state");
    expect(github.calls).toEqual([]);
    const status = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    expect(status.configured).toBe(false);
  });

  it("rejects a state that was issued to a different signed-in user", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, { email: "alice@example.test", password: "alice password passphrase", role: "admin" });
    await createUser(repoPath, { email: "mallory@example.test", password: "mallory password passphrase", role: "admin" });
    const github = githubFetch();
    // Required auth mode never derives the callback URL from the Host header;
    // the operator declares the public address. The server picks its port, so
    // the shared env object is completed once it is listening.
    const providerEnv: Record<string, string | undefined> = {
      NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
      NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
    };
    const server = await start(repoPath, {
      providerOAuthFetch: github.fetch,
      providerEnv,
      authMode: "required",
      authEnv: {},
    });
    providerEnv.NITELY_WEB_PUBLIC_URL = server.url;
    const alice = await login(server, "alice@example.test", "alice password passphrase");
    const mallory = await login(server, "mallory@example.test", "mallory password passphrase");
    const started = await startFlow(server, "github", { cookie: alice });
    expect(started.response.status).toBe(200);
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const response = await callback(server, "github", { code: "code-1", state }, { cookie: mallory });
    expect(response.headers.get("location")).toBe("/providers?oauthError=user_mismatch");
    expect(github.calls).toEqual([]);
    // The burned state cannot be replayed by its rightful owner either.
    const replay = await callback(server, "github", { code: "code-1", state }, { cookie: alice });
    expect(replay.headers.get("location")).toBe("/providers?oauthError=unknown_state");
  });

  it("rejects a state presented to a different provider's callback", async () => {
    const repoPath = await createRepo();
    const github = githubFetch();
    const server = await start(repoPath, {
      providerOAuthFetch: github.fetch,
      providerEnv: {
        NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
        NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
        NITELY_GOOGLE_OAUTH_CLIENT_ID: "g-client",
        NITELY_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret",
      },
    });
    const started = await startFlow(server, "github");
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const response = await callback(server, "google-drive", { code: "code-1", state });
    expect(response.headers.get("location")).toBe("/providers?oauthError=provider_mismatch");
    expect(github.calls).toEqual([]);
  });

  it("reports a provider denial or failed exchange without storing a connection", async () => {
    const repoPath = await createRepo();
    const github = githubFetch({ exchangeStatus: 400 });
    const server = await start(repoPath, { providerOAuthFetch: github.fetch });
    const denied = await callback(server, "github", {
      error: "access_denied",
      state: new URL((await startFlow(server, "github")).body.authorizeUrl).searchParams.get("state")!,
    });
    expect(denied.headers.get("location")).toBe("/providers?oauthError=access_denied");

    const state = new URL((await startFlow(server, "github")).body.authorizeUrl).searchParams.get("state")!;
    const failed = await callback(server, "github", { code: "bad", state });
    expect(failed.headers.get("location")).toBe("/providers?oauthError=exchange_failed");
    const status = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    expect(status.configured).toBe(false);
  });

  it("refuses to start a flow for a provider without OAuth client configuration", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath, { providerEnv: {} });
    const started = await startFlow(server, "github");
    expect(started.response.status).toBe(400);
    expect(started.body.error.message).toMatch(/NITELY_GITHUB_OAUTH_CLIENT_ID/);
    const notOAuth = await startFlow(server, "glm");
    expect(notOAuth.response.status).toBe(400);
  });

  it("never derives the callback address from the Host header outside local mode", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, { email: "alice@example.test", password: "alice password passphrase", role: "admin" });
    const server = await start(repoPath, {
      providerOAuthFetch: githubFetch().fetch,
      authMode: "required",
      authEnv: {},
    });
    const alice = await login(server, "alice@example.test", "alice password passphrase");
    const started = await startFlow(server, "github", { cookie: alice });
    expect(started.response.status).toBe(400);
    expect(started.body.error.message).toMatch(/NITELY_WEB_PUBLIC_URL/);
  });

  it("reconnect replaces the same connection in place and disconnect is idempotent", async () => {
    const repoPath = await createRepo();
    const github = githubFetch();
    const server = await start(repoPath, { providerOAuthFetch: github.fetch });
    const first = await startFlow(server, "github");
    await callback(server, "github", {
      code: "code-1",
      state: new URL(first.body.authorizeUrl).searchParams.get("state")!,
    });
    const before = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    const connectionId = before.authMethods.find((m: { method: string }) => m.method === "oauth").connections[0].id;

    const reconnect = await fetch(`${server.url}/api/providers/github/oauth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
    const reconnectState = new URL((await json(reconnect)).authorizeUrl).searchParams.get("state")!;
    await callback(server, "github", { code: "code-2", state: reconnectState });
    const after = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    const oauth = after.authMethods.find((m: { method: string }) => m.method === "oauth");
    expect(oauth.connections).toHaveLength(1);
    expect(oauth.connections[0].id).toBe(connectionId);

    const disconnect = await fetch(
      `${server.url}/api/providers/github/connections/${connectionId}/disconnect`,
      { method: "POST" },
    );
    expect(disconnect.status).toBe(200);
    expect(
      github.calls.some((c) => c.method === "DELETE" && c.url.includes("/applications/gh-client/token")),
    ).toBe(true);
    const again = await fetch(
      `${server.url}/api/providers/github/connections/${connectionId}/disconnect`,
      { method: "POST" },
    );
    expect(again.status).toBe(200);
    const final = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    const finalOauth = final.authMethods.find((m: { method: string }) => m.method === "oauth");
    expect(finalOauth.configured).toBe(false);
    expect(finalOauth.connections[0]).toMatchObject({ state: "revoked", reconnectRequired: true });
    expect(final.reconnectRequired).toBe(true);
    const audit = await listSecurityAuditEvents(repoPath);
    expect(audit.map((event) => event.action)).toContain("providers.oauth.disconnect");
  });

  it("refreshes an expiring OAuth token before projecting it into the run environment", async () => {
    const repoPath = await createRepo();
    let now = new Date("2026-09-19T10:00:00Z");
    const github = githubFetch();
    const server = await start(repoPath, {
      providerOAuthFetch: github.fetch,
      providerOAuthNow: () => now,
    });
    const started = await startFlow(server, "github");
    await callback(server, "github", {
      code: "code-1",
      state: new URL(started.body.authorizeUrl).searchParams.get("state")!,
    });
    now = new Date("2026-09-20T10:00:00Z");
    const status = (await json(await fetch(`${server.url}/api/providers`))).providers.find(
      (p: { id: string }) => p.id === "github",
    );
    // Still configured: the refresh token keeps the connection usable.
    expect(status.configured).toBe(true);
    const connectionId = status.authMethods.find((m: { method: string }) => m.method === "oauth").connections[0].id;
    const validated = await fetch(
      `${server.url}/api/providers/github/connections/${connectionId}/validate`,
      { method: "POST" },
    );
    expect(validated.status).toBe(200);
    const body = await json(validated);
    expect(body.ok).toBe(true);
    expect(body.connection.lastValidatedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(JSON.stringify(body)).not.toContain("gho_");
    const refresh = github.calls.filter(
      (c) => c.url === "https://github.com/login/oauth/access_token" && c.body.includes("grant_type=refresh_token"),
    );
    expect(refresh).toHaveLength(1);
  });
});
