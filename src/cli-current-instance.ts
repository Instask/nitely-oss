import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface CurrentInstance {
  serverUrl: string;
  apiToken?: string;
}

export interface ResolveRemoteServerInput {
  flag?: string;
  env: Record<string, string | undefined>;
  saved?: CurrentInstance;
}

export interface ResolveRemoteTokenInput {
  env: Record<string, string | undefined>;
  saved?: CurrentInstance;
}

interface CurrentInstanceFile {
  version: 1;
  serverUrl: string;
  apiToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRemoteServerUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("server URL must use http or https");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "server URL must use http or https") {
      throw error;
    }
    throw new Error(`invalid server URL: ${value}`);
  }
  return trimmed;
}

export function currentInstanceConfigPath(
  env: Record<string, string | undefined>,
): string | undefined {
  const explicit = env.NITELY_CONFIG_DIR?.trim();
  if (explicit) return join(resolve(explicit), "current-instance.json");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(resolve(xdg), "nitely", "current-instance.json");
  const home = env.HOME?.trim();
  if (home) return join(resolve(home), ".config", "nitely", "current-instance.json");
  return undefined;
}

function parseCurrentInstanceFile(value: unknown): CurrentInstance {
  if (!isRecord(value)) {
    throw new Error("invalid current instance file: root must be an object");
  }
  if (value.version !== 1) {
    throw new Error("invalid current instance file: version must be 1");
  }
  if (typeof value.serverUrl !== "string" || !value.serverUrl.trim()) {
    throw new Error("invalid current instance file: serverUrl must be a non-empty string");
  }
  const instance: CurrentInstance = {
    serverUrl: normalizeRemoteServerUrl(value.serverUrl),
  };
  if (typeof value.apiToken === "string" && value.apiToken.trim()) {
    instance.apiToken = value.apiToken.trim();
  } else if (value.apiToken !== undefined) {
    throw new Error("invalid current instance file: apiToken must be a string");
  }
  return instance;
}

export async function readCurrentInstance(
  env: Record<string, string | undefined>,
): Promise<CurrentInstance | undefined> {
  const path = currentInstanceConfigPath(env);
  if (!path) return undefined;
  try {
    return parseCurrentInstanceFile(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof Error && error.message.startsWith("invalid current instance file:")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid current instance file: ${message}`);
  }
}

export async function writeCurrentInstance(
  env: Record<string, string | undefined>,
  instance: CurrentInstance,
): Promise<string> {
  const path = currentInstanceConfigPath(env);
  if (!path) {
    throw new Error("Missing NITELY_CONFIG_DIR, XDG_CONFIG_HOME, or HOME");
  }
  const file: CurrentInstanceFile = {
    version: 1,
    serverUrl: normalizeRemoteServerUrl(instance.serverUrl),
    ...(instance.apiToken?.trim() ? { apiToken: instance.apiToken.trim() } : {}),
  };
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}

export async function clearCurrentInstance(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const path = currentInstanceConfigPath(env);
  if (!path) return false;
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveRemoteServerUrl(input: ResolveRemoteServerInput): string | undefined {
  const raw = firstNonEmpty([
    input.flag,
    input.env.NITELY_SERVER_URL,
    input.saved?.serverUrl,
  ]);
  return raw ? normalizeRemoteServerUrl(raw) : undefined;
}

export function resolveRemoteApiToken(input: ResolveRemoteTokenInput): string | undefined {
  return firstNonEmpty([input.env.NITELY_API_TOKEN, input.saved?.apiToken]);
}

export function remoteAuthorizationHeaders(
  token: string | undefined,
): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function resolveRemoteTarget(input: {
  flag?: string;
  env: Record<string, string | undefined>;
}): Promise<{ serverUrl?: string; apiToken?: string }> {
  const saved = await readCurrentInstance(input.env);
  return {
    serverUrl: resolveRemoteServerUrl({
      flag: input.flag,
      env: input.env,
      ...(saved ? { saved } : {}),
    }),
    apiToken: resolveRemoteApiToken({
      env: input.env,
      ...(saved ? { saved } : {}),
    }),
  };
}
