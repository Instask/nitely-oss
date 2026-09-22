/**
 * The client half of the RFC 8628 device grant. Every side effect — the
 * network, the clock, the wait, the browser — is injected, so the state
 * machine is testable without any of them.
 */
import { spawn } from "node:child_process";

import { normalizeRemoteServerUrl } from "../cli-current-instance.js";
import type { FetchFunction } from "./io.js";

const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** However long the server says the code lives, nobody waits longer than this. */
const MAX_LIFETIME_MS = 15 * 60_000;

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResult {
  accessToken: string;
  tokenId: string;
  name: string;
  capabilities: string[];
}

export interface DeviceFlowDeps {
  fetchImpl?: FetchFunction;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCode(payload: unknown): string {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
}

/**
 * Return `candidate` only if it points at the very server the operator named,
 * and the locally built `fallback` otherwise.
 *
 * The server chooses these URLs, and the CLI prints one and hands it to the
 * operator's browser — so an unpinned value is a URL of the server's choosing
 * opened by the operator's own trusted tool. Three things this closes:
 *
 * - A hostile or MITM'd server answering with `https://evil.example/device?…`
 *   gets the CLI to launch a convincing fake sign-in page, harvesting a
 *   password it could not otherwise reach.
 * - The server derives the scheme from `x-forwarded-proto`, defaulting to
 *   `http`. A TLS-terminating proxy that does not set that header turns an
 *   https deployment's URL into an http one, and the admin's session cookie
 *   then travels in clear.
 * - On Windows the opener runs through `cmd.exe`, which re-parses its command
 *   line; `&`, `|` and `^` survive argument quoting. An origin check keeps
 *   them out before that matters.
 *
 * The honest case always matches, so this costs nothing there.
 */
function pinnedToServer(
  candidate: unknown,
  serverUrl: string,
  fallback: string,
): string {
  if (typeof candidate !== "string" || !candidate) return fallback;
  try {
    return new URL(candidate).origin === new URL(serverUrl).origin
      ? candidate
      : fallback;
  } catch {
    return fallback;
  }
}

export async function requestDeviceAuthorization(
  input: {
    serverUrl: string;
    capabilities: string[];
    allowHighImpact: boolean;
    clientName: string;
  },
  deps: DeviceFlowDeps = {},
): Promise<DeviceAuthorizationResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const response = await fetchImpl(`${serverUrl}/api/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      capabilities: input.capabilities,
      allowHighImpact: input.allowHighImpact,
      clientName: input.clientName,
    }),
  });
  const payload = await readJson(response);

  if (response.status === 409 || errorCode(payload) === "device_flow_unavailable") {
    throw new DeviceFlowError(
      `${serverUrl} does not offer browser sign-in (the server runs with --auth local). ` +
        "Create a token with nitely mcp token create and use nitely connect instead.",
    );
  }
  if (!response.ok || !isRecord(payload) || typeof payload.device_code !== "string") {
    const detail = isRecord(payload) && payload.error
      ? String(isRecord(payload.error) ? JSON.stringify(payload.error) : payload.error)
      : `HTTP ${response.status}`;
    throw new DeviceFlowError(`Could not start browser sign-in: ${detail}`);
  }

  const userCode = String(payload.user_code ?? "");
  const fallbackUri = `${serverUrl}/device`;
  const fallbackUriComplete = `${fallbackUri}?code=${encodeURIComponent(userCode)}`;
  return {
    deviceCode: payload.device_code,
    userCode,
    verificationUri: pinnedToServer(
      payload.verification_uri,
      serverUrl,
      fallbackUri,
    ),
    verificationUriComplete: pinnedToServer(
      payload.verification_uri_complete,
      serverUrl,
      fallbackUriComplete,
    ),
    expiresIn: Number(payload.expires_in ?? 600),
    interval: Number(payload.interval ?? 5),
  };
}

export async function pollForDeviceToken(
  input: {
    serverUrl: string;
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  },
  deps: DeviceFlowDeps = {},
): Promise<DeviceTokenResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep
    ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const now = deps.now ?? Date.now;
  const serverUrl = normalizeRemoteServerUrl(input.serverUrl);
  const startedAt = now();
  const lifetimeMs = Math.min(input.expiresInSeconds * 1000, MAX_LIFETIME_MS);
  const initialIntervalSeconds = input.intervalSeconds || 5;
  let intervalSeconds = initialIntervalSeconds;

  // A circuit breaker independent of the clock. The `while` condition below
  // relies on `now()` advancing; if an injected clock never moves (a bug in
  // a caller's test, say) while the server keeps answering
  // authorization_pending, that condition never trips and this would poll
  // forever. Derived from the lifetime and the starting interval with 10x
  // headroom, so legitimate use — including after `slow_down` has stretched
  // the interval, which only reduces how many attempts are needed — never
  // hits it. The real flow polls a 10-minute lifetime at 5-second intervals,
  // roughly 120 attempts; this cap sits far above that.
  const maxAttempts = Math.max(
    100,
    Math.ceil(lifetimeMs / (initialIntervalSeconds * 1000)) * 10,
  );
  let attempts = 0;

  while (now() - startedAt < lifetimeMs) {
    attempts += 1;
    if (attempts > maxAttempts) break;
    // RFC 8628: wait the interval before the request, not after it.
    await sleep(intervalSeconds * 1000);
    const response = await fetchImpl(`${serverUrl}/api/device-token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_code: input.deviceCode }),
    });
    const payload = await readJson(response);

    if (response.ok && isRecord(payload) && typeof payload.access_token === "string") {
      return {
        accessToken: payload.access_token,
        tokenId: String(payload.token_id ?? ""),
        name: String(payload.name ?? ""),
        capabilities: Array.isArray(payload.capabilities)
          ? payload.capabilities.map((capability) => String(capability))
          : [],
      };
    }

    const error = errorCode(payload);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }
    if (error === "access_denied") {
      throw new DeviceFlowError("Sign-in was denied in the browser.");
    }
    if (error === "expired_token") {
      throw new DeviceFlowError(
        "The sign-in request expired. Run nitely auth login again.",
      );
    }
    throw new DeviceFlowError(
      error
        ? `Browser sign-in failed: ${error}`
        : `Browser sign-in failed with HTTP ${response.status}`,
    );
  }

  throw new DeviceFlowError(
    "The sign-in request expired before it was approved. Run nitely auth login again.",
  );
}

/**
 * The command and args to launch `url` in the platform's browser, chosen so
 * the URL is always passed as a plain argument and never a shell string —
 * see the `shell: true` note on `openBrowser` below.
 */
function openerCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "win32") {
    // `start` is a cmd.exe builtin, not its own executable, so it has to go
    // through cmd — but WITHOUT `shell: true` (see openBrowser). The empty
    // string is the window-title argument `start` requires so it doesn't
    // mistake a quoted URL for the title.
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Best effort by design. A headless box has no browser, and that is not a
 * failed login: the URL and the code are already on stderr, and the flow keeps
 * polling.
 *
 * `url` is server-supplied (`verification_uri_complete` from the device
 * authorization response), so it is untrusted: a malicious or MITM'd server
 * could hand back a string containing shell metacharacters. Two defenses:
 * the URL is validated to be plain http(s) before anything is spawned, and
 * the process is never spawned with `shell: true` (which would let Windows
 * reinterpret the URL as a shell command line) — the URL always travels as
 * a single argv entry.
 */
export function openBrowser(
  url: string,
  deps: { spawnImpl?: typeof spawn; platform?: NodeJS.Platform } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const spawnImpl = deps.spawnImpl ?? spawn;
  const platform = deps.platform ?? process.platform;
  const { command, args } = openerCommand(platform, url);
  try {
    const child = spawnImpl(command, args, {
      stdio: "ignore",
      detached: true,
    });
    // Without this an ENOENT from the opener becomes an unhandled 'error'
    // event and takes the CLI down mid-login.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
