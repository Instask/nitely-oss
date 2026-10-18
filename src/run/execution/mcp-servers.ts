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
  const overrides = names.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
  const at = args[0] === "exec" ? 1 : 0;
  return [...args.slice(0, at), ...overrides, ...args.slice(at)];
}

/**
 * Decides which configured servers an attempt keeps. Exactly the declared ones
 * stay enabled; everything else configured is disabled unless it cannot be
 * addressed, in which case a required restriction fails closed.
 */
export function planMcpServerRestriction(input: {
  request: Exclude<AgentMcpServersRequest, { mode: "inherited" }>;
  configured: readonly string[];
  stageId: string;
  /** Why some configured servers may be invisible to the scan, if any. */
  incompleteReason?: string;
}): { disable: string[]; outcome: AgentMcpServersOutcome } {
  const declared = new Set(input.request.declared);
  const enabled = input.configured.filter((name) => declared.has(name));
  const unwanted = input.configured.filter((name) => !declared.has(name));
  const disabled = unwanted.filter((name) => CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const unaddressable = unwanted.filter((name) => !CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const reasons = [
    ...(unaddressable.length > 0
      ? [`codex cannot address MCP server name(s) ${unaddressable.join(", ")} in a config override, so they stay enabled`]
      : []),
    ...(input.incompleteReason ? [input.incompleteReason] : []),
  ];
  if (reasons.length > 0 && input.request.mode === "declared-required") {
    throw new Error(
      `stage ${input.stageId} requires only its declared MCP servers but ${reasons.join("; ")}`,
    );
  }
  const unconfigured = input.request.declared.filter(
    (name) => !input.configured.includes(name),
  );
  return {
    disable: disabled,
    outcome: {
      restricted: true,
      enabled: [...enabled, ...unaddressable],
      disabled,
      ...(unconfigured.length > 0 ? { unconfigured } : {}),
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    },
  };
}
