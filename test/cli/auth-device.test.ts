import { describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
  openBrowser,
  pollForDeviceToken,
  requestDeviceAuthorization,
} from "../../src/cli/auth-device.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CLI device flow", () => {
  it("requests codes and returns what the operator needs to see", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        device_code: "BDFHJKMN.secret",
        user_code: "BDFH-JKMN",
        verification_uri: "http://127.0.0.1:7777/device",
        verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
        expires_in: 600,
        interval: 5,
      }),
    );

    const authorization = await requestDeviceAuthorization(
      {
        serverUrl: "http://127.0.0.1:7777",
        capabilities: ["tasks:read"],
        allowHighImpact: false,
        clientName: "cli@dev-box",
      },
      { fetchImpl },
    );

    expect(authorization.userCode).toBe("BDFH-JKMN");
    expect(authorization.interval).toBe(5);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/api/device-authorization");
    expect(JSON.parse(String(init.body))).toEqual({
      capabilities: ["tasks:read"],
      allowHighImpact: false,
      clientName: "cli@dev-box",
    });
  });

  it("pins the verification URLs to the server the operator named", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        device_code: "BDFHJKMN.secret",
        user_code: "BDFH-JKMN",
        // A hostile or MITM'd server, or an https deployment behind a proxy
        // that does not set x-forwarded-proto: either way the CLI would print
        // this and hand it to the operator's browser.
        verification_uri: "https://evil.example/device",
        verification_uri_complete: "https://evil.example/device?code=BDFH-JKMN",
        expires_in: 600,
        interval: 5,
      }),
    );

    const authorization = await requestDeviceAuthorization(
      {
        serverUrl: "https://nitely.example",
        capabilities: ["tasks:read"],
        allowHighImpact: false,
        clientName: "cli@dev-box",
      },
      { fetchImpl },
    );

    expect(authorization.verificationUri).toBe("https://nitely.example/device");
    expect(authorization.verificationUriComplete).toBe(
      "https://nitely.example/device?code=BDFH-JKMN",
    );
  });

  it("rejects a same-host URL that downgrades the scheme or bends the port", async () => {
    async function completeUriFor(candidate: string): Promise<string> {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(200, {
          device_code: "BDFHJKMN.secret",
          user_code: "BDFH-JKMN",
          verification_uri_complete: candidate,
          expires_in: 600,
          interval: 5,
        }),
      );
      const authorization = await requestDeviceAuthorization(
        {
          serverUrl: "https://nitely.example",
          capabilities: ["tasks:read"],
          allowHighImpact: false,
          clientName: "cli@dev-box",
        },
        { fetchImpl },
      );
      return authorization.verificationUriComplete;
    }

    const pinned = "https://nitely.example/device?code=BDFH-JKMN";
    // Same host, plaintext: the admin's session cookie would travel in clear.
    await expect(completeUriFor("http://nitely.example/device?code=BDFH-JKMN"))
      .resolves.toBe(pinned);
    // Same host, different port.
    await expect(completeUriFor("https://nitely.example:8443/device?code=X"))
      .resolves.toBe(pinned);
    // Not a URL at all, and a URL carrying cmd.exe metacharacters.
    await expect(completeUriFor("not a url")).resolves.toBe(pinned);
    await expect(completeUriFor("https://evil.example/d?x=a&calc|whoami^"))
      .resolves.toBe(pinned);
    // The honest answer is passed through untouched.
    await expect(completeUriFor(pinned)).resolves.toBe(pinned);
  });

  it("explains a server that does not offer the flow", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: "device_flow_unavailable" }),
    );

    await expect(
      requestDeviceAuthorization(
        {
          serverUrl: "http://127.0.0.1:7777",
          capabilities: ["tasks:read"],
          allowHighImpact: false,
          clientName: "cli",
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/does not offer browser sign-in/);
  });

  it("waits the interval, then returns the token once approved", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "nitely_api_abc_def",
          token_id: "tok_abc",
          name: "cli@dev-box",
          capabilities: ["tasks:read"],
        }),
      );

    const result = await pollForDeviceToken(
      {
        serverUrl: "http://127.0.0.1:7777",
        deviceCode: "BDFHJKMN.secret",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      },
      {
        fetchImpl,
        sleep: async (ms) => { slept.push(ms); },
        now: () => 0,
      },
    );

    expect(result.accessToken).toBe("nitely_api_abc_def");
    expect(result.tokenId).toBe("tok_abc");
    // RFC 8628: wait before the first poll, not after it.
    expect(slept).toEqual([5000, 5000]);
  });

  it("backs off when the server says slow_down", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "slow_down" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "t",
          token_id: "tok_1",
          name: "cli",
          capabilities: ["tasks:read"],
        }),
      );

    await pollForDeviceToken(
      {
        serverUrl: "http://127.0.0.1:7777",
        deviceCode: "BDFHJKMN.secret",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      },
      { fetchImpl, sleep: async (ms) => { slept.push(ms); }, now: () => 0 },
    );

    expect(slept).toEqual([5000, 10000]);
  });

  it("surfaces a denial and an expiry distinctly", async () => {
    const denied = vi.fn(async () => jsonResponse(400, { error: "access_denied" }));
    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 1, expiresInSeconds: 60 },
        { fetchImpl: denied, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow(/denied in the browser/);

    const expired = vi.fn(async () => jsonResponse(400, { error: "expired_token" }));
    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 1, expiresInSeconds: 60 },
        { fetchImpl: expired, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("gives up once the code's lifetime has passed", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: "authorization_pending" }),
    );

    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 5, expiresInSeconds: 10 },
        {
          fetchImpl,
          sleep: async (ms) => { clock += ms; },
          now: () => clock,
        },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("gives up when the clock never advances, instead of polling forever", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: "authorization_pending" }),
    );

    await expect(
      pollForDeviceToken(
        { serverUrl: "http://x", deviceCode: "A.b", intervalSeconds: 5, expiresInSeconds: 600 },
        {
          fetchImpl,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    ).rejects.toThrow(/expired/);
  }, 2000);

  it("treats a browser that will not launch as a non-failure", () => {
    const spawnImpl = vi.fn(() => { throw new Error("ENOENT"); });

    expect(openBrowser("http://x", { spawnImpl: spawnImpl as never, platform: "linux" }))
      .toBe(false);
  });

  it("refuses to launch a non-http(s) or malformed URL", () => {
    const spawnImpl = vi.fn(() => ({ on() {}, unref() {} }));

    expect(
      openBrowser("javascript:alert(1)", { spawnImpl: spawnImpl as never, platform: "linux" }),
    ).toBe(false);
    expect(
      openBrowser("not a url & rm -rf /", { spawnImpl: spawnImpl as never, platform: "win32" }),
    ).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("uses the platform's opener", () => {
    const child = { on() {}, unref() {} };
    const spawnImpl = vi.fn(() => child);

    openBrowser("http://x", { spawnImpl: spawnImpl as never, platform: "darwin" });

    expect(spawnImpl.mock.calls.length).toBeGreaterThan(0);
    expect(((spawnImpl.mock.calls[0] as unknown) as [string])[0]).toBe("open");
  });
});
