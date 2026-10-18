import type { AgentMcpServersOutcome, AgentMcpServersRequest } from "./types.js";

/**
 * Codex splits a `-c` key path on every dot and fails its bootstrap when an
 * override names a server it has no configuration for, so only names it can
 * address are ever disabled.
 */
const CODEX_ADDRESSABLE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function unquoteTomlKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Splits a dotted TOML key, keeping dots inside quoted segments. */
function splitTomlKey(key: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of key) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (char === ".") {
      parts.push(unquoteTomlKey(current));
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(unquoteTomlKey(current));
  return parts;
}

/** The key on the left of `key = value`, or undefined for any other line. */
function assignmentKey(line: string): string | undefined {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "=") {
      return line.slice(0, index).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Names the MCP servers a Codex `config.toml` defines, in file order. This is
 * a scan, not a TOML parser: it reads `[mcp_servers.<name>]` headers, keys
 * under a bare `[mcp_servers]` table, and top-level `mcp_servers.<name>.*`
 * keys, and skips multi-line strings. A server it cannot see stays enabled,
 * which costs tokens but never breaks the launch.
 */
export function codexConfiguredMcpServers(configToml: string): string[] {
  const names: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !names.includes(name)) names.push(name);
  };
  let table: string[] = [];
  let multiLineDelimiter: string | undefined;
  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (multiLineDelimiter) {
      if (line.includes(multiLineDelimiter)) multiLineDelimiter = undefined;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header && !line.startsWith("[[")) {
      table = splitTomlKey(header[1]);
      if (table[0] === "mcp_servers" && table.length > 1) add(table[1]);
      continue;
    }
    if (line.startsWith("[[")) {
      table = [];
      continue;
    }
    const key = assignmentKey(line);
    if (key) {
      const path = [...table, ...splitTomlKey(key)];
      if (path[0] === "mcp_servers" && path.length > 1) add(path[1]);
      const value = line.slice(line.indexOf("=", key.length) + 1);
      for (const delimiter of ['"""', "'''"]) {
        const first = value.indexOf(delimiter);
        if (first !== -1 && value.indexOf(delimiter, first + 3) === -1) {
          multiLineDelimiter = delimiter;
        }
      }
    }
  }
  return names;
}

/** The `-c` overrides that turn the named Codex MCP servers off. */
export function codexMcpServerDisableOverrides(names: readonly string[]): string[] {
  return names.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

/**
 * Turns the named Codex MCP servers off for one launch with `-c` overrides,
 * placed right after the `exec` subcommand where both `codex exec` and
 * `codex exec resume` accept them. The config file itself is never rewritten,
 * so auth, provider, and model settings reach Codex untouched.
 */
export function withCodexMcpServersDisabled(
  args: readonly string[],
  names: readonly string[],
): string[] {
  if (names.length === 0) return [...args];
  const at = args[0] === "exec" ? 1 : 0;
  return [...args.slice(0, at), ...codexMcpServerDisableOverrides(names), ...args.slice(at)];
}

/** Every `-c <value>` pair in a launch, in order, so a probe sees the same config. */
export function codexConfigOverrides(args: readonly string[]): string[] {
  const overrides: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === "-c" || args[index] === "--config") {
      overrides.push("-c", args[index + 1]!);
      index++;
    }
  }
  return overrides;
}

/** Argv for `codex mcp list --json` under the given config overrides. */
export function codexMcpListArgs(overrides: readonly string[]): string[] {
  return [...overrides, "mcp", "list", "--json"];
}

export interface McpServerListing {
  name: string;
  enabled: boolean;
}

/**
 * Reads only `name` and `enabled` from `codex mcp list --json`. The rest of
 * each entry carries server env, args, and headers, so it is never kept.
 * Returns undefined for anything that is not that shape.
 */
export function parseCodexMcpList(stdout: string): McpServerListing[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const servers: McpServerListing[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { name, enabled } = entry as { name?: unknown; enabled?: unknown };
    if (typeof name !== "string" || typeof enabled !== "boolean") return undefined;
    servers.push({ name, enabled });
  }
  return servers;
}

/**
 * Runs `codex mcp list --json` with the attempt's environment, working
 * directory, and the given extra overrides, and resolves its stdout. It must
 * see the same config layers the launch will: system, user, trusted project,
 * and `-c` session flags.
 */
export type CodexMcpLister = (overrides: readonly string[]) => Promise<string>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

async function listCodexMcpServers(
  list: CodexMcpLister,
  overrides: readonly string[],
): Promise<{ servers: McpServerListing[] } | { problem: string }> {
  let stdout: string;
  try {
    stdout = await list(overrides);
  } catch (error) {
    return { problem: `codex mcp list failed: ${errorMessage(error)}` };
  }
  const servers = parseCodexMcpList(stdout);
  return servers ? { servers } : { problem: "codex mcp list did not print a server list" };
}

/**
 * Leaves exactly the declared MCP servers enabled for a Codex launch.
 *
 * Codex merges MCP servers from several config layers (system, user, every
 * trusted project `.codex/config.toml` from the working directory up to the
 * repository root, and `-c` flags), so the effective set is read from Codex
 * itself rather than from any one file. Every enabled server the stage did not
 * declare gets a disable override, and the list is read again under those
 * overrides: the restriction is `enforced` only if that second listing shows
 * every undeclared server off. Anything less is `partial`, which a required
 * restriction turns into a failure before launch.
 */
export async function restrictCodexMcpServers(input: {
  request: Exclude<AgentMcpServersRequest, { mode: "inherited" }>;
  stageId: string;
  list: CodexMcpLister;
  /** The launch's own `-c` overrides, so the probe resolves the same config. */
  baseOverrides?: readonly string[];
  /**
   * Best-effort server names to disable when Codex cannot list them, such as
   * the user config.toml's tables. Never used for a required restriction.
   */
  fallbackServers?: () => Promise<string[]>;
}): Promise<{ disable: string[]; outcome: AgentMcpServersOutcome }> {
  const declared = new Set(input.request.declared);
  const base = input.baseOverrides ?? [];
  const failClosed = (reason: string): never => {
    throw new Error(
      `stage ${input.stageId} requires only its declared MCP servers but ${reason}`,
    );
  };
  const partial = (
    reason: string,
    fields: {
      disable?: string[];
      disabled?: string[];
      enabled?: string[];
      unconfigured?: string[];
    } = {},
  ) => {
    if (input.request.mode === "declared-required") failClosed(reason);
    const disable = fields.disable ?? [];
    return {
      disable,
      outcome: {
        enforcement: "partial" as const,
        ...(fields.enabled ? { enabled: fields.enabled } : {}),
        disabled: fields.disabled ?? disable,
        ...(fields.unconfigured && fields.unconfigured.length > 0
          ? { unconfigured: fields.unconfigured }
          : {}),
        reason,
      },
    };
  };

  const listed = await listCodexMcpServers(input.list, base);
  if ("problem" in listed) {
    if (input.request.mode === "declared-required") failClosed(listed.problem);
    let fallback: string[] = [];
    try {
      fallback = (await input.fallbackServers?.()) ?? [];
    } catch {
      fallback = [];
    }
    const disable = fallback.filter(
      (name) => !declared.has(name) && CODEX_ADDRESSABLE_SERVER_NAME.test(name),
    );
    return partial(
      `${listed.problem}, so the effective MCP servers are unknown${
        disable.length > 0 ? "; disabled the user config.toml servers it could read" : ""
      }`,
      { disable },
    );
  }

  const present = new Set(listed.servers.map((server) => server.name));
  const unconfigured = input.request.declared.filter((name) => !present.has(name));
  const unwanted = listed.servers
    .filter((server) => server.enabled && !declared.has(server.name))
    .map((server) => server.name);
  const disable = unwanted.filter((name) => CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const unaddressable = unwanted.filter((name) => !CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const keptDeclared = listed.servers
    .filter((server) => server.enabled && declared.has(server.name))
    .map((server) => server.name);

  let verified = listed.servers;
  if (disable.length > 0) {
    const check = await listCodexMcpServers(input.list, [
      ...base,
      ...codexMcpServerDisableOverrides(disable),
    ]);
    if ("problem" in check) {
      // The overrides themselves may be what broke Codex, so the launch does
      // not carry them.
      return partial(`${check.problem} while verifying the disable overrides`, {
        enabled: [...keptDeclared, ...unwanted],
        unconfigured,
      });
    }
    verified = check.servers;
  }
  const ignored = disable.filter((name) =>
    verified.some((server) => server.name === name && server.enabled));
  const missingDeclared = input.request.declared.filter(
    (name) => present.has(name) && !verified.some((server) => server.name === name),
  );
  const reasons = [
    ...(unaddressable.length > 0
      ? [`codex cannot address MCP server name(s) ${unaddressable.join(", ")} in a config override`]
      : []),
    ...(ignored.length > 0
      ? [`MCP server(s) ${ignored.join(", ")} stayed enabled under the disable overrides`]
      : []),
    ...(missingDeclared.length > 0
      ? [`declared MCP server(s) ${missingDeclared.join(", ")} disappeared under the disable overrides`]
      : []),
  ];
  const enabled = verified
    .filter((server) => server.enabled)
    .map((server) => server.name);
  const disabled = disable.filter((name) => !ignored.includes(name));
  if (reasons.length > 0) {
    return partial(reasons.join("; "), { disable, disabled, enabled, unconfigured });
  }
  return {
    disable,
    outcome: {
      enforcement: "enforced",
      enabled,
      disabled,
      ...(unconfigured.length > 0 ? { unconfigured } : {}),
    },
  };
}
