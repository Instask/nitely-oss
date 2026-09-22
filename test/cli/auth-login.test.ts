import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function configDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-auth-login-"));
}

describe("nitely auth login", () => {
  it("stores the issued token and never prints it", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "BDFHJKMN.secret",
          user_code: "BDFH-JKMN",
          verification_uri: "http://127.0.0.1:7777/device",
          verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "nitely_api_abc_def",
          token_id: "tok_abc",
          name: "cli@dev-box",
          capabilities: ["tasks:read"],
        }),
      );

    const code = await runCli(
      [
        "auth", "login",
        "--server", "http://127.0.0.1:7777",
        "--capability", "tasks:read",
      ],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      {
        env: { NITELY_CONFIG_DIR: dir },
        fetch: fetchImpl,
        sleep: async () => {},
        openBrowser: () => true,
      },
    );

    expect(code).toBe(0);

    const stored = JSON.parse(
      await readFile(join(dir, "current-instance.json"), "utf8"),
    );
    expect(stored).toEqual({
      version: 1,
      serverUrl: "http://127.0.0.1:7777",
      apiToken: "nitely_api_abc_def",
    });
    expect((await stat(join(dir, "current-instance.json"))).mode & 0o777).toBe(0o600);

    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("BDFH-JKMN");
    expect(printed).toContain("tok_abc");
    expect(printed).not.toContain("nitely_api_abc_def");
  });

  it("puts the code and URL on stderr so stdout stays scriptable", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "BDFHJKMN.secret",
          user_code: "BDFH-JKMN",
          verification_uri: "http://127.0.0.1:7777/device",
          verification_uri_complete: "http://127.0.0.1:7777/device?code=BDFH-JKMN",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "t", token_id: "tok_1", name: "cli", capabilities: ["tasks:read"],
        }),
      );

    await runCli(
      ["auth", "login", "--server", "http://127.0.0.1:7777", "--capability", "tasks:read"],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    expect(err.join("\n")).toContain("BDFH-JKMN");
    expect(err.join("\n")).toContain("/device?code=BDFH-JKMN");
  });

  it("does not launch a browser with --no-browser", async () => {
    const dir = await configDir();
    const openBrowser = vi.fn(() => true);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "t", token_id: "tok_1", name: "cli", capabilities: [] }),
      );

    await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read", "--no-browser"],
      { stdout: () => {}, stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser },
    );

    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("requires at least one capability", async () => {
    const err: string[] = [];

    const code = await runCli(
      ["auth", "login", "--server", "http://x"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: await configDir() } },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--capability");
  });

  it("reports a denial without writing anything", async () => {
    const dir = await configDir();
    const err: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: "access_denied" }));

    const code = await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("denied");
    await expect(readFile(join(dir, "current-instance.json"), "utf8")).rejects.toThrow();
  });

  it("redacts a secret out of a device-flow error before printing it", async () => {
    const dir = await configDir();
    const err: string[] = [];
    const existingToken = "nitely_api_existing_secret";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      // DeviceFlowError quotes the server's error code straight into its
      // message, so the server chooses part of what reaches stderr. Nothing
      // constructs one around a token today, which is exactly why the
      // redaction has to be unconditional rather than re-audited per edit.
      .mockResolvedValueOnce(jsonResponse(400, { error: existingToken }));

    const code = await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      {
        env: { NITELY_CONFIG_DIR: dir, NITELY_API_TOKEN: existingToken },
        fetch: fetchImpl,
        sleep: async () => {},
        openBrowser: () => true,
      },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).not.toContain(existingToken);
    expect(err.join("\n")).toContain("[REDACTED]");
  });

  it("clears the local instance on logout and says the token still lives", async () => {
    const dir = await configDir();
    const out: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "A.b", user_code: "BDFH-JKMN",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?code=BDFH-JKMN",
          expires_in: 600, interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "t", token_id: "tok_1", name: "cli", capabilities: [] }),
      );
    await runCli(
      ["auth", "login", "--server", "http://x", "--capability", "tasks:read"],
      { stdout: () => {}, stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir }, fetch: fetchImpl, sleep: async () => {}, openBrowser: () => true },
    );

    const code = await runCli(
      ["auth", "logout"],
      { stdout: (line) => out.push(line), stderr: () => {} },
      { env: { NITELY_CONFIG_DIR: dir } },
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("revoke");
    await expect(readFile(join(dir, "current-instance.json"), "utf8")).rejects.toThrow();
  });
});
