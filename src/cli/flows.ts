import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeRemoteServerUrl, resolveRemoteTarget } from "../cli-current-instance.js";
import {
  CatalogFlowInvalidError,
  catalogFlowSummary,
  deleteCatalogFlow,
  listCatalogFlows,
  resetCatalogFlow,
  resolveCatalogFlow,
  setCatalogFlowEnabled,
  updateCatalogFlowDocument,
  type CatalogFlowSummary,
} from "../flows/catalog.js";
import type { CliIo, FetchFunction } from "./io.js";
import {
  readJsonObject,
  redactSecret,
  remoteErrorMessage,
  remoteRequestHeaders,
  requireRemoteServerUrl,
} from "./remote.js";

/**
 * `nitely flow …`: manage the Flow catalog.
 *
 * With `--repo <path>` the command works on that repository's Flow store
 * directly. Whoever can write the repository's `.nitely/` directory already
 * controls the store, so this is the same as the Web Console's local mode.
 * Otherwise it talks to a running server (`--server`, `NITELY_SERVER_URL`, or
 * the saved instance), where the server applies its own rules: built-in Flows
 * can be changed only by an administrator or in local mode. Flow stores are
 * per repository, so `--repo-id <id>` picks which of the server's
 * repositories every remote subcommand targets (the server's home repository
 * when omitted).
 *
 * The store logic lives in src/flows/catalog.ts; this file only parses
 * arguments, picks a target, and prints.
 */

export const FLOW_CLI_USAGE = [
  "  flow list [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow show <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow enable <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow disable <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow update <id> --file <path> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow reset <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
  "  flow delete <id> [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]",
];

const USAGE_LINE =
  "Usage: nitely flow list|show|enable|disable|update|reset|delete [<id>] [--repo <path> | [--server <url>] [--repo-id <id>]] [--json]";

/** One Flow as the CLI prints it, from either target. */
export interface FlowCliEntry {
  id: string;
  name: string;
  origin?: string;
  source?: string;
  enabled?: boolean;
  edited?: boolean;
  newerShippedVersion?: boolean;
  runnable?: boolean;
  seedKey?: string;
}

interface FlowCliTarget {
  /** Remote `list` keeps returning the server's payload verbatim for --json. */
  list(): Promise<{ entries: FlowCliEntry[]; raw: unknown }>;
  show(id: string): Promise<{ entry: FlowCliEntry; document: string }>;
  setEnabled(id: string, enabled: boolean): Promise<FlowCliEntry>;
  update(id: string, document: string): Promise<FlowCliEntry>;
  reset(id: string): Promise<FlowCliEntry>;
  delete(id: string): Promise<string>;
}

function localEntry(summary: CatalogFlowSummary): FlowCliEntry {
  return { ...summary, source: summary.origin === "system" ? "builtin" : "user" };
}

function localTarget(repoPath: string): FlowCliTarget {
  return {
    list: async () => {
      const summaries = (await listCatalogFlows(repoPath)).map(catalogFlowSummary);
      return { entries: summaries.map(localEntry), raw: { flows: summaries } };
    },
    show: async (id) => {
      const resolved = await resolveCatalogFlow(repoPath, id, { requireEnabled: false });
      return { entry: localEntry(catalogFlowSummary(resolved.record)), document: resolved.document };
    },
    setEnabled: async (id, enabled) =>
      localEntry(catalogFlowSummary(await setCatalogFlowEnabled(repoPath, id, enabled))),
    update: async (id, document) =>
      localEntry(catalogFlowSummary(await updateCatalogFlowDocument(repoPath, id, document))),
    reset: async (id) => localEntry(catalogFlowSummary(await resetCatalogFlow(repoPath, id))),
    delete: async (id) => {
      const record = await deleteCatalogFlow(repoPath, id);
      return record.id;
    },
  };
}

function remoteEntry(value: unknown): FlowCliEntry | undefined {
  const record = readJsonObject(value);
  if (typeof record?.id !== "string" || !record.id) return undefined;
  const builtin = record.source === "builtin" || record.origin === "system";
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : record.id,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.origin === "string" ? { origin: record.origin } : {}),
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.customized === "boolean" ? { edited: record.customized } : {}),
    ...(typeof record.upstreamUpdateAvailable === "boolean"
      ? { newerShippedVersion: record.upstreamUpdateAvailable }
      : {}),
    ...(typeof record.runnable === "boolean" ? { runnable: record.runnable } : {}),
    ...(builtin && record.id.startsWith("flows/") ? { seedKey: record.id } : {}),
  };
}

function remoteTarget(
  serverUrl: string,
  apiToken: string | undefined,
  fetchImpl: FetchFunction,
  repoId?: string,
): FlowCliTarget {
  const base = normalizeRemoteServerUrl(serverUrl);
  const query = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
  const flowUrl = (id: string, suffix = "") =>
    `${base}/api/flows/${encodeURIComponent(id)}${suffix}${query}`;

  async function request(
    action: string,
    url: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const headers = remoteRequestHeaders(
      apiToken,
      init.body !== undefined ? { "content-type": "application/json" } : undefined,
    );
    const response = await fetchImpl(url, {
      ...(init.method ? { method: init.method } : {}),
      ...(headers ? { headers } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (response.status === 422) {
      const payload = readJsonObject(await response.json().catch(() => undefined));
      const report = readJsonObject(payload?.report);
      const errors = Array.isArray(report?.errors) ? report.errors.map(String) : [];
      throw new Error(`invalid flow document: ${errors.join("; ") || "validation failed"}`);
    }
    if (!response.ok) {
      throw new Error(
        `remote flow ${action} failed (HTTP ${response.status}): ${await remoteErrorMessage(response)}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`remote flow ${action} failed: invalid JSON response`);
    }
    const root = readJsonObject(payload);
    if (!root) throw new Error(`remote flow ${action} failed: invalid JSON response`);
    return root;
  }

  async function mutate(
    action: string,
    id: string,
    init: { method: string; body?: unknown },
    suffix = "",
  ): Promise<FlowCliEntry> {
    await request(action, flowUrl(id, suffix), init);
    // Re-read the catalog view so the printed state matches the list.
    return (await this_.show(id)).entry;
  }

  const this_: FlowCliTarget = {
    list: async () => {
      const root = await request("list", `${base}/api/flows${query}`);
      if (!Array.isArray(root.flows)) {
        throw new Error("remote flow list failed: invalid response: missing flows");
      }
      return {
        entries: root.flows.map(remoteEntry).filter((e): e is FlowCliEntry => e !== undefined),
        raw: root,
      };
    },
    show: async (id) => {
      const root = await request("show", flowUrl(id));
      const flow = readJsonObject(root.flow);
      const entry = remoteEntry(flow);
      if (!entry || typeof flow?.document !== "string") {
        throw new Error("remote flow show failed: invalid response: missing flow");
      }
      return { entry, document: flow.document };
    },
    setEnabled: async (id, enabled) =>
      await mutate(enabled ? "enable" : "disable", id, { method: "PUT", body: { enabled } }),
    update: async (id, document) => await mutate("update", id, { method: "PUT", body: { document } }),
    reset: async (id) => await mutate("reset", id, { method: "POST", body: {} }, "/reset"),
    delete: async (id) => {
      await request("delete", flowUrl(id), { method: "DELETE" });
      return id;
    },
  };
  return this_;
}

function stateLabel(entry: FlowCliEntry): string {
  const parts: string[] = [];
  if (entry.enabled !== undefined) parts.push(entry.enabled ? "enabled" : "disabled");
  if (entry.edited !== undefined && (entry.origin === "system" || entry.source === "builtin")) {
    parts.push(entry.edited ? "edited" : "unedited");
  }
  if (entry.newerShippedVersion) parts.push("newer-shipped-version");
  return parts.join(",");
}

function printEntry(io: CliIo, entry: FlowCliEntry, local: boolean): void {
  if (local) {
    const fields = [
      entry.id,
      entry.origin ?? entry.source ?? "unknown",
      stateLabel(entry) || "-",
      entry.name,
    ];
    io.stdout(fields.join("  "));
    return;
  }
  // Remote lines keep their established shape; newer servers add state.
  const runnable = entry.runnable === false ? "blocked" : "runnable";
  const state = stateLabel(entry);
  io.stdout(
    `${entry.id}  ${entry.source ?? "unknown"}  ${runnable}  ${entry.name}${state ? `  [${state}]` : ""}`,
  );
}

function errorText(error: unknown): string {
  if (error instanceof CatalogFlowInvalidError) {
    return `invalid flow document: ${error.report.errors.join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface FlowCliOptions {
  env: Record<string, string | undefined>;
  fetch: FetchFunction;
  cwd?: string;
}

export async function runFlowCli(
  argv: string[],
  io: CliIo,
  options: FlowCliOptions,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const needsId = new Set(["show", "enable", "disable", "update", "reset", "delete"]);
  if (subcommand !== "list" && !needsId.has(subcommand ?? "")) {
    io.stderr(USAGE_LINE);
    return 1;
  }

  let id: string | undefined;
  let repoPath: string | undefined;
  let serverFlag = "";
  let repoId: string | undefined;
  let filePath: string | undefined;
  let asJson = false;
  let apiToken: string | undefined;
  try {
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--json") {
        asJson = true;
      } else if (arg === "--repo") {
        repoPath = rest[++index];
        if (!repoPath) throw new Error("Missing value for --repo");
      } else if (arg === "--repo-id") {
        repoId = rest[++index];
        if (!repoId) throw new Error("Missing value for --repo-id");
      } else if (arg === "--server") {
        serverFlag = rest[++index] ?? "";
        if (!serverFlag) throw new Error("Missing value for --server");
      } else if (arg === "--file" && subcommand === "update") {
        filePath = rest[++index];
        if (!filePath) throw new Error("Missing value for --file");
      } else if (!arg.startsWith("-") && needsId.has(subcommand!) && id === undefined) {
        id = arg;
      } else {
        io.stderr(`Unknown flow ${subcommand} option: ${arg}`);
        return 1;
      }
    }
    if (needsId.has(subcommand!) && !id) throw new Error(`Missing flow id. ${USAGE_LINE}`);
    if (subcommand === "update" && !filePath) throw new Error("Missing --file <path> with the new Flow document");
    if (repoPath && serverFlag) throw new Error("Use either --repo or --server, not both");
    if (repoPath && repoId) {
      throw new Error("--repo-id selects a server repository; use it with --server, not --repo");
    }

    let target: FlowCliTarget;
    const local = repoPath !== undefined;
    if (local) {
      target = localTarget(resolve(options.cwd ?? process.cwd(), repoPath!));
    } else {
      const remote = await resolveRemoteTarget({
        env: options.env,
        ...(serverFlag ? { flag: serverFlag } : {}),
      });
      apiToken = remote.apiToken;
      target = remoteTarget(requireRemoteServerUrl(remote.serverUrl), remote.apiToken, options.fetch, repoId);
    }

    const printResult = (verb: string, entry: FlowCliEntry) => {
      if (asJson) io.stdout(JSON.stringify({ flow: entry }));
      else io.stdout(`${verb} ${entry.id}  ${stateLabel(entry)}`.trimEnd());
    };

    switch (subcommand) {
      case "list": {
        const { entries, raw } = await target.list();
        if (asJson) {
          io.stdout(JSON.stringify(raw));
        } else if (entries.length === 0) {
          io.stdout("No flows");
        } else {
          for (const entry of entries) printEntry(io, entry, local);
          io.stdout("Pass an id above to nitely task create --flow <id>.");
        }
        return 0;
      }
      case "show": {
        const { entry, document } = await target.show(id!);
        if (asJson) {
          io.stdout(JSON.stringify({ flow: entry, document: JSON.parse(document) as unknown }));
        } else {
          io.stdout(JSON.stringify(JSON.parse(document), null, 2));
        }
        return 0;
      }
      case "enable":
      case "disable":
        printResult(subcommand === "enable" ? "ENABLED" : "DISABLED",
          await target.setEnabled(id!, subcommand === "enable"));
        return 0;
      case "update": {
        const document = await readFile(resolve(options.cwd ?? process.cwd(), filePath!), "utf8");
        printResult("UPDATED", await target.update(id!, document));
        return 0;
      }
      case "reset":
        printResult("RESET", await target.reset(id!));
        return 0;
      case "delete": {
        const deleted = await target.delete(id!);
        if (asJson) io.stdout(JSON.stringify({ deleted }));
        else io.stdout(`DELETED ${id}`);
        return 0;
      }
    }
    return 1;
  } catch (error) {
    io.stderr(redactSecret(errorText(error), apiToken, options.env.NITELY_API_TOKEN));
    return 1;
  }
}
