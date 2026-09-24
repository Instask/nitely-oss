import { describe, expect, it } from "vitest";

import { createProviderOAuthAdapters } from "../../src/providers/oauth/adapters.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  handler: (call: Call) => { status?: number; json?: unknown; text?: string },
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    const body = result.json !== undefined ? JSON.stringify(result.json) : result.text ?? "";
    return new Response(body, {
      status,
      headers: { "content-type": result.json !== undefined ? "application/json" : "text/plain" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("provider OAuth adapters", () => {
  it("only exposes adapters whose client credentials are configured", () => {
    const adapters = createProviderOAuthAdapters({
      env: {
        NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
        NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      },
      fetch: fakeFetch(() => ({})).fetch,
    });
    expect(adapters.get("github")).toBeDefined();
    expect(adapters.get("google-drive")).toBeUndefined();
    expect(adapters.get("anthropic")).toBeUndefined();
  });

  it("builds a GitHub authorize URL with state and PKCE and never the client secret", () => {
    const adapters = createProviderOAuthAdapters({
      env: {
        NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
        NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      },
      fetch: fakeFetch(() => ({})).fetch,
    });
    const url = new URL(
      adapters.get("github")!.authorizeUrl({
        state: "state-123",
        redirectUri: "https://nitely.example/oauth/callback/github",
        codeChallenge: "challenge-abc",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("gh-client");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nitely.example/oauth/callback/github",
    );
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("repo");
    expect(url.toString()).not.toContain("gh-secret");
  });

  it("exchanges a GitHub code for tokens and reads the account identity", async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url === "https://github.com/login/oauth/access_token") {
        return {
          json: {
            access_token: "gho_access",
            refresh_token: "ghr_refresh",
            expires_in: 28800,
            scope: "repo,read:user",
            token_type: "bearer",
          },
        };
      }
      if (call.url === "https://api.github.com/user") {
        return { json: { id: 42, login: "octocat", name: "The Octocat", email: null } };
      }
      return { status: 404 };
    });
    const adapter = createProviderOAuthAdapters({
      env: {
        NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
        NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      },
      fetch,
      now: () => new Date("2026-09-19T10:00:00Z"),
    }).get("github")!;
    const tokens = await adapter.exchangeCode({
      code: "code-1",
      redirectUri: "https://nitely.example/oauth/callback/github",
      codeVerifier: "verifier-1",
    });
    expect(tokens).toEqual({
      accessToken: "gho_access",
      refreshToken: "ghr_refresh",
      expiresAt: "2026-09-19T18:00:00.000Z",
      scopes: ["repo", "read:user"],
    });
    const exchange = calls[0];
    expect(exchange.method).toBe("POST");
    expect(exchange.headers.accept).toBe("application/json");
    const form = new URLSearchParams(exchange.body);
    expect(form.get("client_id")).toBe("gh-client");
    expect(form.get("client_secret")).toBe("gh-secret");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("code_verifier")).toBe("verifier-1");

    const identity = await adapter.fetchIdentity("gho_access");
    expect(identity).toEqual({ id: "42", login: "octocat", displayName: "The Octocat" });
    expect(calls[1].headers.authorization).toBe("Bearer gho_access");
  });

  it("refreshes a Google token and keeps the old refresh token when none is returned", async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url === "https://oauth2.googleapis.com/token") {
        return { json: { access_token: "ya29.fresh", expires_in: 3600, scope: "openid" } };
      }
      return { status: 404 };
    });
    const adapter = createProviderOAuthAdapters({
      env: {
        NITELY_GOOGLE_OAUTH_CLIENT_ID: "g-client",
        NITELY_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret",
      },
      fetch,
      now: () => new Date("2026-09-19T10:00:00Z"),
    }).get("google-drive")!;
    const tokens = await adapter.refresh("1//refresh");
    expect(tokens).toEqual({
      accessToken: "ya29.fresh",
      expiresAt: "2026-09-19T11:00:00.000Z",
      scopes: ["openid"],
    });
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("1//refresh");
  });

  it("surfaces a rejected token exchange as an error without echoing the response body verbatim into the message", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      json: { error: "bad_verification_code", error_description: "The code passed is incorrect" },
    }));
    const adapter = createProviderOAuthAdapters({
      env: {
        NITELY_GITHUB_OAUTH_CLIENT_ID: "gh-client",
        NITELY_GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      },
      fetch,
    }).get("github")!;
    await expect(
      adapter.exchangeCode({ code: "x", redirectUri: "https://n/cb", codeVerifier: "v" }),
    ).rejects.toThrow(/github token exchange failed \(bad_verification_code\)/);
  });

  it("requests a Google authorization with offline access and Drive read scope", () => {
    const adapter = createProviderOAuthAdapters({
      env: {
        NITELY_GOOGLE_OAUTH_CLIENT_ID: "g-client",
        NITELY_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret",
      },
      fetch: fakeFetch(() => ({})).fetch,
    }).get("google-drive")!;
    const url = new URL(
      adapter.authorizeUrl({
        state: "s",
        redirectUri: "https://n/oauth/callback/google-drive",
        codeChallenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    );
  });
});
