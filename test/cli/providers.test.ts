import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";

type Call = { url: string; method: string; authorization: string | null };

function server(routes: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const path = new URL(url).pathname;
    if (!(path in routes)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[path]), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const providers = {
  providers: [
    { id: "openrouter", configured: true, reconnectRequired: false, connectionId: "conn-or", message: "OpenRouter key saved" },
    { id: "anthropic", configured: false, reconnectRequired: false, message: "Not connected" },
    { id: "github", configured: true, reconnectRequired: true, connectionId: "conn-gh", message: "Reconnect required" },
  ],
};

async function cli(argv: string[], fetchImpl: typeof fetch, env: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    argv,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { fetch: fetchImpl, env: { HOME: "/nonexistent-nitely-home", ...env } },
  );
  return { code, stdout, stderr };
}

describe("nitely provider", () => {
  it("lists provider status with the connection a run would use", async () => {
    const { calls, fetchImpl } = server({ "/api/providers": providers });
    const result = await cli(["provider", "list", "--server", "http://server.test"], fetchImpl, {
      NITELY_API_TOKEN: "nitely_api_secret_token",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      "openrouter\tconfigured\tconn-or\tOpenRouter key saved",
      "anthropic\tnot-configured\t-\tNot connected",
      "github\treconnect-required\tconn-gh\tReconnect required",
    ]);
    expect(calls).toEqual([
      { url: "http://server.test/api/providers", method: "GET", authorization: "Bearer nitely_api_secret_token" },
    ]);
  });

  it("validates the default connection and exits zero only when it is valid", async () => {
    const valid = server({
      "/api/providers": providers,
      "/api/providers/openrouter/connections/conn-or/validate": { ok: true, checked: "provider" },
    });
    const ok = await cli(["provider", "validate", "openrouter", "--server", "http://server.test"], valid.fetchImpl);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toEqual(["PROVIDER openrouter connection conn-or valid"]);
    expect(valid.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://server.test/api/providers",
      "POST http://server.test/api/providers/openrouter/connections/conn-or/validate",
    ]);

    const rejected = server({
      "/api/providers/openrouter/connections/conn-2/validate": {
        ok: false,
        checked: "provider",
        reason: "rejected by OpenRouter (401)",
      },
    });
    const bad = await cli(
      ["provider", "validate", "openrouter", "--connection", "conn-2", "--server", "http://server.test", "--json"],
      rejected.fetchImpl,
    );
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout.join(""))).toEqual({
      ok: false,
      checked: "provider",
      reason: "rejected by OpenRouter (401)",
    });
    expect(rejected.calls).toHaveLength(1);
  });

  it("does not report a stored-only check as valid unless asked to accept it", async () => {
    // The server checks only OpenRouter API keys live; others answer `stored`,
    // which a key revoked at the provider would still pass.
    const stored = () =>
      server({
        "/api/providers/github/connections/conn-gh/validate": { ok: true, checked: "stored" },
      });

    const strict = await cli(
      ["provider", "validate", "github", "--connection", "conn-gh", "--server", "http://server.test"],
      stored().fetchImpl,
    );
    expect(strict.code).toBe(1);
    expect(strict.stdout).toEqual(["PROVIDER github connection conn-gh unverified"]);

    const strictJson = await cli(
      ["provider", "validate", "github", "--connection", "conn-gh", "--server", "http://server.test", "--json"],
      stored().fetchImpl,
    );
    expect(strictJson.code).toBe(1);
    expect(JSON.parse(strictJson.stdout.join(""))).toEqual({ ok: true, checked: "stored" });

    const lenient = await cli(
      [
        "provider", "validate", "github", "--connection", "conn-gh",
        "--allow-stored-only", "--server", "http://server.test",
      ],
      stored().fetchImpl,
    );
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toEqual(["PROVIDER github connection conn-gh unverified"]);

    const failedStored = await cli(
      [
        "provider", "validate", "github", "--connection", "conn-gh",
        "--allow-stored-only", "--server", "http://server.test",
      ],
      server({
        "/api/providers/github/connections/conn-gh/validate": {
          ok: false,
          checked: "stored",
          reason: "reconnect required",
        },
      }).fetchImpl,
    );
    expect(failedStored.code).toBe(1);
    expect(failedStored.stdout).toEqual([
      "PROVIDER github connection conn-gh invalid: reconnect required",
    ]);
  });

  it("refuses a provider without a connection and redacts the token from errors", async () => {
    const missing = server({ "/api/providers": providers });
    const none = await cli(["provider", "validate", "anthropic", "--server", "http://server.test"], missing.fetchImpl);
    expect(none.code).toBe(1);
    expect(none.stderr).toEqual([
      "provider anthropic has no connection to validate; connect it in the Web Console first",
    ]);

    const denied = server({ "/api/providers": { error: { message: "denied for nitely_api_secret_token" } } }, 403);
    const result = await cli(["provider", "list", "--server", "http://server.test"], denied.fetchImpl, {
      NITELY_API_TOKEN: "nitely_api_secret_token",
    });
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("provider list failed (HTTP 403)");
    expect(result.stderr.join("\n")).not.toContain("nitely_api_secret_token");

    const usage = await cli(["provider", "validate"], missing.fetchImpl);
    expect(usage.code).toBe(1);
    expect(usage.stderr[0]).toMatch(/^Usage: nitely provider validate/);
  });
});
