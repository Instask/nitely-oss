import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCurrentInstance,
  currentInstanceConfigPath,
  readCurrentInstance,
  resolveRemoteApiToken,
  resolveRemoteServerUrl,
  writeCurrentInstance,
} from "../src/cli-current-instance.js";

async function isolatedEnv(
  extra: Record<string, string | undefined> = {},
): Promise<Record<string, string | undefined>> {
  const directory = await mkdtemp(join(tmpdir(), "nitely-current-instance-"));
  return { NITELY_CONFIG_DIR: directory, ...extra };
}

describe("current CLI instance", () => {
  it("resolves the config file from NITELY_CONFIG_DIR, then XDG, then HOME", () => {
    expect(
      currentInstanceConfigPath({ NITELY_CONFIG_DIR: "/tmp/nitely-config" }),
    ).toBe("/tmp/nitely-config/current-instance.json");
    expect(
      currentInstanceConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg-config" }),
    ).toBe("/tmp/xdg-config/nitely/current-instance.json");
    expect(currentInstanceConfigPath({ HOME: "/tmp/home" })).toBe(
      "/tmp/home/.config/nitely/current-instance.json",
    );
    expect(currentInstanceConfigPath({})).toBeUndefined();
  });

  it("writes, reads, and clears a saved instance without echoing the token", async () => {
    const env = await isolatedEnv();
    const path = await writeCurrentInstance(env, {
      serverUrl: "http://192.0.2.10:4173/",
      apiToken: "nitely_api_secret",
    });

    expect(path).toBe(join(env.NITELY_CONFIG_DIR!, "current-instance.json"));
    const directoryMode = (await stat(env.NITELY_CONFIG_DIR!)).mode & 0o777;
    const fileMode = (await stat(path)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({
      version: 1,
      serverUrl: "http://192.0.2.10:4173",
      apiToken: "nitely_api_secret",
    });

    await expect(readCurrentInstance(env)).resolves.toEqual({
      serverUrl: "http://192.0.2.10:4173",
      apiToken: "nitely_api_secret",
    });

    expect(await clearCurrentInstance(env)).toBe(true);
    await expect(readCurrentInstance(env)).resolves.toBeUndefined();
    expect(await clearCurrentInstance(env)).toBe(false);
  });

  it("omits the token from disk when connect has no token", async () => {
    const env = await isolatedEnv();
    await writeCurrentInstance(env, { serverUrl: "http://server.test" });
    await expect(readCurrentInstance(env)).resolves.toEqual({
      serverUrl: "http://server.test",
    });
  });

  it("rejects an invalid saved instance file", async () => {
    const env = await isolatedEnv();
    const path = currentInstanceConfigPath(env);
    expect(path).toBeDefined();
    await writeFile(path!, "{", "utf8");
    await expect(readCurrentInstance(env)).rejects.toThrow(
      "invalid current instance file:",
    );
  });

  it("resolves server and token with flag, env, then saved instance", async () => {
    const saved = {
      serverUrl: "http://saved.test",
      apiToken: "saved-token",
    };
    expect(
      resolveRemoteServerUrl({
        flag: "http://flag.test/",
        env: { NITELY_SERVER_URL: "http://env.test" },
        saved,
      }),
    ).toBe("http://flag.test");
    expect(
      resolveRemoteServerUrl({
        env: { NITELY_SERVER_URL: "http://env.test/" },
        saved,
      }),
    ).toBe("http://env.test");
    expect(resolveRemoteServerUrl({ env: {}, saved })).toBe("http://saved.test");
    expect(resolveRemoteServerUrl({ env: {} })).toBeUndefined();

    expect(
      resolveRemoteApiToken({
        env: { NITELY_API_TOKEN: "env-token" },
        saved,
      }),
    ).toBe("env-token");
    expect(resolveRemoteApiToken({ env: {}, saved })).toBe("saved-token");
    expect(resolveRemoteApiToken({ env: {} })).toBeUndefined();
  });
});
