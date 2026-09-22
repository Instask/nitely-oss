import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { WebInputError } from "../web/errors.js";
import {
  PREVIEW_VIEWPORT_PRESETS,
  type PreviewCommandConfig,
  type PreviewRepositoryConfig,
  type PreviewViewport,
} from "./types.js";

const commandIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const maxCommandArgs = 64;
const maxEnvEntries = 64;
const maxInheritedEnvEntries = 32;

function isInside(parentPath: string, candidatePath: string): boolean {
  const fromParent = relative(parentPath, candidatePath);
  return (
    fromParent === "" ||
    (!fromParent.startsWith("..") && !isAbsolute(fromParent))
  );
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebInputError(message);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new WebInputError(`${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new WebInputError(`${field} must be an array of non-empty strings`);
    }
    return item.trim();
  });
}

function assertPreviewRoute(value: string, field: string): void {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new WebInputError(`${field} must contain absolute paths`);
  }
}

export function previewRouteAllowed(
  route: string,
  allowedRoutes: string[] = ["/"],
): boolean {
  return allowedRoutes.some((allowed) => {
    const normalizedAllowed = allowed.endsWith("/")
      ? allowed.slice(0, -1) || "/"
      : allowed;
    return (
      route === normalizedAllowed ||
      normalizedAllowed === "/" ||
      route.startsWith(`${normalizedAllowed}/`)
    );
  });
}

function normalizeEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "env must be an object");
  const entries = Object.entries(record);
  if (entries.length > maxEnvEntries) {
    throw new WebInputError(`env must contain at most ${maxEnvEntries} entries`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new WebInputError(`invalid environment variable name: ${key}`);
    }
    if (typeof raw !== "string") {
      throw new WebInputError(`environment variable ${key} must be a string`);
    }
    normalized[key] = raw;
  }
  return normalized;
}

function normalizeReadiness(value: unknown): PreviewCommandConfig["readiness"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "readiness must be an object");
  const timeoutMs = record.timeoutMs;
  const intervalMs = record.intervalMs;
  return {
    ...(typeof record.url === "string" && record.url.trim()
      ? { url: record.url.trim() }
      : {}),
    ...(typeof record.path === "string" && record.path.trim()
      ? { path: record.path.trim() }
      : {}),
    ...(typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs)
      ? { timeoutMs }
      : {}),
    ...(typeof intervalMs === "number" && Number.isSafeInteger(intervalMs)
      ? { intervalMs }
      : {}),
  };
}

function normalizeCommand(value: unknown): PreviewCommandConfig {
  const record = requireRecord(value, "preview command must be an object");
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!commandIdPattern.test(id)) {
    throw new WebInputError("preview command id is invalid");
  }
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) {
    throw new WebInputError(`preview command ${id} is missing command`);
  }
  const args = optionalStringArray(record.args, `preview command ${id} args`);
  if ((args ?? []).length > maxCommandArgs) {
    throw new WebInputError(
      `preview command ${id} args must contain at most ${maxCommandArgs} entries`,
    );
  }
  const inheritEnv = optionalStringArray(
    record.inheritEnv,
    `preview command ${id} inheritEnv`,
  );
  if ((inheritEnv ?? []).length > maxInheritedEnvEntries) {
    throw new WebInputError(
      `preview command ${id} inheritEnv must contain at most ${maxInheritedEnvEntries} entries`,
    );
  }
  const allowedRoutes = optionalStringArray(
    record.allowedRoutes,
    `preview command ${id} allowedRoutes`,
  );
  for (const route of allowedRoutes ?? []) {
    assertPreviewRoute(route, `preview command ${id} allowedRoutes`);
  }
  const readiness = normalizeReadiness(record.readiness);
  return {
    id,
    command,
    ...(args ? { args } : {}),
    ...(typeof record.cwd === "string" && record.cwd.trim()
      ? { cwd: record.cwd.trim() }
      : {}),
    ...(typeof record.targetUrl === "string" && record.targetUrl.trim()
      ? { targetUrl: record.targetUrl.trim() }
      : {}),
    ...(allowedRoutes ? { allowedRoutes } : {}),
    ...(record.env ? { env: normalizeEnvironment(record.env) } : {}),
    ...(inheritEnv ? { inheritEnv } : {}),
    ...(readiness ? { readiness } : {}),
  };
}

export async function loadPreviewRepositoryConfig(
  repoPath: string,
): Promise<PreviewRepositoryConfig> {
  const configPath = join(resolve(repoPath), ".nitely", "preview.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebInputError(
        "preview is not configured for this repository; add .nitely/preview.json",
      );
    }
    throw error;
  }
  const record = requireRecord(parsed, "preview config must be an object");
  if (record.schemaVersion !== "nitely.preview.v1") {
    throw new WebInputError("preview config schemaVersion must be nitely.preview.v1");
  }
  if (!Array.isArray(record.commands) || record.commands.length === 0) {
    throw new WebInputError("preview config must declare at least one command");
  }
  const commands = record.commands.map(normalizeCommand);
  const ids = new Set<string>();
  for (const command of commands) {
    if (ids.has(command.id)) {
      throw new WebInputError(`duplicate preview command id: ${command.id}`);
    }
    ids.add(command.id);
  }
  return { schemaVersion: "nitely.preview.v1", commands };
}

export async function resolvePreviewCommand(
  repoPath: string,
  commandId: string,
): Promise<PreviewCommandConfig> {
  const config = await loadPreviewRepositoryConfig(repoPath);
  const command = config.commands.find((candidate) => candidate.id === commandId);
  if (!command) {
    throw new WebInputError(`preview command is not allowlisted: ${commandId}`);
  }
  return command;
}

export async function resolvePreviewCwd(
  repoPath: string,
  cwd: string | undefined,
): Promise<string> {
  const repoRoot = resolve(repoPath);
  const repoRealPath = await realpath(repoRoot);
  const candidate = resolve(repoRoot, cwd ?? ".");
  const candidateRealPath = await realpath(candidate);
  if (!isInside(repoRealPath, candidateRealPath)) {
    throw new WebInputError("preview command cwd must stay inside the repository");
  }
  return candidateRealPath;
}

export function normalizePreviewViewport(
  viewport: PreviewViewport | undefined,
): PreviewViewport {
  if (!viewport) return PREVIEW_VIEWPORT_PRESETS.desktop;
  if (viewport.preset) {
    const preset = PREVIEW_VIEWPORT_PRESETS[viewport.preset];
    if (!preset) {
      throw new WebInputError(`unknown preview viewport preset: ${viewport.preset}`);
    }
    return preset;
  }
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width < 100 ||
    viewport.height < 100 ||
    viewport.width > 10_000 ||
    viewport.height > 10_000
  ) {
    throw new WebInputError("preview viewport width and height are out of range");
  }
  return {
    width: viewport.width,
    height: viewport.height,
    ...(viewport.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: viewport.deviceScaleFactor }
      : {}),
    ...(viewport.isMobile !== undefined ? { isMobile: viewport.isMobile } : {}),
  };
}

export function resolvePreviewTargetUrl(input: {
  command: PreviewCommandConfig;
  targetUrl?: string;
  route?: string;
}): { targetUrl: string; route?: string; readinessUrl: string } {
  const base = input.targetUrl?.trim() || input.command.targetUrl?.trim();
  const readinessUrl = input.command.readiness?.url?.trim();
  if (!base && !readinessUrl) {
    throw new WebInputError(
      "preview targetUrl is required unless command readiness.url is configured",
    );
  }
  const target = parsePreviewUrl(base || readinessUrl!, "preview targetUrl");
  assertLoopbackHttpUrl(target, "preview targetUrl");
  const route = input.route?.trim();
  if (route !== undefined) {
    assertPreviewRoute(route, "preview route");
    const allowedRoutes = input.command.allowedRoutes ?? ["/"];
    if (!previewRouteAllowed(route, allowedRoutes)) {
      throw new WebInputError("preview route is not allowed by repository config");
    }
    target.pathname = route;
    target.search = "";
    target.hash = "";
  }
  const readiness = parsePreviewUrl(
    readinessUrl || target.toString(),
    "preview readiness.url",
  );
  if (input.command.readiness?.path) {
    assertPreviewRoute(input.command.readiness.path, "preview readiness.path");
    readiness.pathname = input.command.readiness.path;
    readiness.search = "";
    readiness.hash = "";
  }
  assertLoopbackHttpUrl(readiness, "preview readiness.url");
  return {
    targetUrl: target.toString(),
    ...(route ? { route } : {}),
    readinessUrl: readiness.toString(),
  };
}

function parsePreviewUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new WebInputError(`${field} must be an absolute URL`);
  }
}

function assertLoopbackHttpUrl(url: URL, field: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebInputError(`${field} must be http or https`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "[::1]"
  ) {
    throw new WebInputError(`${field} must use a loopback host`);
  }
}
