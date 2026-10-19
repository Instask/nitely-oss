import { normalizeRemoteServerUrl, resolveRemoteTarget } from "../cli-current-instance.js";
import type { CliIo, FetchFunction } from "./io.js";
import {
  fetchRemoteJson,
  listRemoteCollection,
  readJsonObject,
  redactSecret,
  remoteRequestHeaders,
  requireRemoteServerUrl,
} from "./remote.js";

export const PROVIDER_LIST_USAGE = "Usage: nitely provider list [--server <url>] [--json]";
export const PROVIDER_VALIDATE_USAGE =
  "Usage: nitely provider validate <provider-id> [--connection <id>] [--server <url>] [--json]";

interface RemoteTarget {
  serverUrl: string;
  apiToken?: string;
}

function providerStatusWord(provider: Record<string, unknown>): string {
  if (provider.reconnectRequired === true) return "reconnect-required";
  return provider.configured === true ? "configured" : "not-configured";
}

function printProviderList(io: CliIo, providers: unknown[]): void {
  if (providers.length === 0) {
    io.stdout("No providers.");
    return;
  }
  for (const value of providers) {
    const provider = readJsonObject(value);
    if (!provider || typeof provider.id !== "string") continue;
    const connection = typeof provider.connectionId === "string" ? provider.connectionId : "-";
    const message = typeof provider.message === "string" ? provider.message : "";
    io.stdout(
      [provider.id, providerStatusWord(provider), connection, message].join("\t").trimEnd(),
    );
  }
}

/**
 * The connection a provider's runtime would select, as `GET /api/providers`
 * reports it. Validating it checks the key a run would actually use.
 */
async function defaultConnectionId(
  target: RemoteTarget,
  providerId: string,
  fetchImpl: FetchFunction,
): Promise<string> {
  const providers = await listRemoteCollection(
    target,
    fetchImpl,
    "/api/providers",
    "providers",
    "provider list",
  );
  const provider = providers
    .map(readJsonObject)
    .find((candidate) => candidate?.id === providerId);
  if (!provider) {
    throw new Error(`unknown provider: ${providerId}`);
  }
  if (typeof provider.connectionId !== "string" || !provider.connectionId) {
    throw new Error(`provider ${providerId} has no connection to validate; connect it in the Web Console first`);
  }
  return provider.connectionId;
}

async function validateRemoteConnection(
  target: RemoteTarget,
  providerId: string,
  connectionId: string,
  fetchImpl: FetchFunction,
): Promise<Record<string, unknown>> {
  const headers = remoteRequestHeaders(target.apiToken, { "content-type": "application/json" });
  const payload = await fetchRemoteJson(
    `${normalizeRemoteServerUrl(target.serverUrl)}/api/providers/${encodeURIComponent(providerId)}/connections/${encodeURIComponent(connectionId)}/validate`,
    fetchImpl,
    "provider validate",
    { method: "POST", body: "{}", ...(headers ? { headers } : {}) },
  );
  const result = readJsonObject(payload);
  if (!result || typeof result.ok !== "boolean") {
    throw new Error("provider validate failed: invalid response: missing ok");
  }
  return result;
}

/**
 * `nitely provider list|validate`: the Console's provider status and
 * **Validate** button. Setting or clearing a key stays in the Console, so this
 * command never sends or prints a provider secret.
 */
export async function runProviderCommand(input: {
  argv: string[];
  env: Record<string, string | undefined>;
  fetchImpl: FetchFunction;
  io: CliIo;
}): Promise<number> {
  const { argv, env, fetchImpl, io } = input;
  const action = argv[1];
  if (action !== "list" && action !== "validate") {
    io.stderr(PROVIDER_LIST_USAGE);
    io.stderr(PROVIDER_VALIDATE_USAGE);
    return 1;
  }
  const usage = action === "list" ? PROVIDER_LIST_USAGE : PROVIDER_VALIDATE_USAGE;
  let startIndex = 2;
  let providerId = "";
  if (action === "validate") {
    providerId = argv[2] ?? "";
    if (!providerId || providerId.startsWith("--")) {
      io.stderr(usage);
      return 1;
    }
    startIndex = 3;
  }
  let serverFlag = "";
  let connectionId = "";
  let asJson = false;
  let resolvedApiToken: string | undefined;
  try {
    for (let index = startIndex; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--server") {
        serverFlag = argv[++index] ?? "";
        if (!serverFlag) throw new Error("Missing value for --server");
        continue;
      }
      if (action === "validate" && arg === "--connection") {
        connectionId = argv[++index] ?? "";
        if (!connectionId) throw new Error("Missing value for --connection");
        continue;
      }
      if (arg === "--json") {
        asJson = true;
        continue;
      }
      io.stderr(`Unknown option: ${arg}. ${usage}`);
      return 1;
    }
    const remote = await resolveRemoteTarget({
      env,
      ...(serverFlag ? { flag: serverFlag } : {}),
    });
    resolvedApiToken = remote.apiToken;
    const target: RemoteTarget = {
      serverUrl: requireRemoteServerUrl(remote.serverUrl),
      ...(remote.apiToken ? { apiToken: remote.apiToken } : {}),
    };

    if (action === "list") {
      const providers = await listRemoteCollection(
        target,
        fetchImpl,
        "/api/providers",
        "providers",
        "provider list",
      );
      if (asJson) io.stdout(JSON.stringify({ providers }));
      else printProviderList(io, providers);
      return 0;
    }

    const connection = connectionId || await defaultConnectionId(target, providerId, fetchImpl);
    const result = await validateRemoteConnection(target, providerId, connection, fetchImpl);
    if (asJson) {
      io.stdout(JSON.stringify(result));
    } else {
      const checked = typeof result.checked === "string" ? ` (checked ${result.checked})` : "";
      const reason = typeof result.reason === "string" && result.reason ? `: ${result.reason}` : "";
      io.stdout(
        `PROVIDER ${providerId} connection ${connection} ${result.ok ? "valid" : "invalid"}${checked}${reason}`,
      );
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(redactSecret(message, resolvedApiToken, env.NITELY_API_TOKEN));
    return 1;
  }
}
