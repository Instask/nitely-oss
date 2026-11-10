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
 * The ChatGPT Apps connector. Codex registers it at runtime when the `apps`
 * feature is on and the session has ChatGPT auth; it is in no config layer, so
 * `codex mcp list` never shows it, and it is turned off through the feature.
 */
export const CODEX_APPS_SERVER_NAME = "codex_apps";

/** The `-c` overrides that turn the named Codex MCP servers off. */
export function codexMcpServerDisableOverrides(names: readonly string[]): string[] {
  return names.flatMap((name) =>
    name === CODEX_APPS_SERVER_NAME
      ? ["-c", "features.apps=false"]
      : ["-c", `mcp_servers.${name}.enabled=false`]);
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

/** Argv for `codex features list` under the given config overrides. */
export function codexFeaturesListArgs(overrides: readonly string[]): string[] {
  return [...overrides, "features", "list"];
}

/**
 * Reads one feature's effective state from `codex features list`, whose rows
 * are `<name> <stage> <true|false>`. Undefined when the row is missing.
 */
export function parseCodexFeatureState(stdout: string, feature: string): boolean | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== feature || columns.length < 2) continue;
    const state = columns[columns.length - 1];
    if (state === "true") return true;
    if (state === "false") return false;
  }
  return undefined;
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

async function readCodexAppsFeature(
  features: CodexMcpLister | undefined,
  overrides: readonly string[],
): Promise<{ enabled: boolean } | { problem: string }> {
  if (!features) return { problem: "the effective Codex apps feature cannot be read" };
  let stdout: string;
  try {
    stdout = await features(overrides);
  } catch (error) {
    return { problem: `codex features list failed: ${errorMessage(error)}` };
  }
  const enabled = parseCodexFeatureState(stdout, "apps");
  return enabled === undefined
    ? { problem: "codex features list did not report the apps feature" }
    : { enabled };
}

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
 * every undeclared server off. The ChatGPT Apps connector is registered at
 * runtime and never listed, so unless a stage declares `codex_apps` the
 * launch also carries `features.apps=false`, confirmed off through
 * `codex features list` under the same overrides. Anything less is `partial`, which a required
 * restriction turns into a failure before launch.
 */
export async function restrictCodexMcpServers(input: {
  request: Exclude<AgentMcpServersRequest, { mode: "inherited" }>;
  stageId: string;
  list: CodexMcpLister;
  /**
   * Runs `codex features list` the same way, to confirm the `apps` feature
   * behind the runtime-registered `codex_apps` connector.
   */
  features?: CodexMcpLister;
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
  // `codex mcp list` covers config layers and plugins only. The Apps connector
  // is added at runtime, so it is handled through its feature instead.
  const keepApps = declared.has(CODEX_APPS_SERVER_NAME);
  const appsOff = keepApps ? [] : [CODEX_APPS_SERVER_NAME];
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
    const disable = [
      ...fallback.filter(
        (name) =>
          !declared.has(name) &&
          name !== CODEX_APPS_SERVER_NAME &&
          CODEX_ADDRESSABLE_SERVER_NAME.test(name),
      ),
      ...appsOff,
    ];
    return partial(
      `${listed.problem}, so the effective MCP servers are unknown${
        disable.length > 0 ? "; disabled the user config.toml servers it could read" : ""
      }`,
      { disable },
    );
  }

  const servers = listed.servers.filter((server) => server.name !== CODEX_APPS_SERVER_NAME);
  const present = new Set(servers.map((server) => server.name));
  const unconfigured = input.request.declared.filter(
    (name) => name !== CODEX_APPS_SERVER_NAME && !present.has(name),
  );
  const unwanted = servers
    .filter((server) => server.enabled && !declared.has(server.name))
    .map((server) => server.name);
  const configDisable = unwanted.filter((name) => CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const disable = [...configDisable, ...appsOff];
  const unaddressable = unwanted.filter((name) => !CODEX_ADDRESSABLE_SERVER_NAME.test(name));
  const keptDeclared = servers
    .filter((server) => server.enabled && declared.has(server.name))
    .map((server) => server.name);

  let verified = servers;
  if (disable.length > 0) {
    const check = await listCodexMcpServers(input.list, [
      ...base,
      ...codexMcpServerDisableOverrides(disable),
    ]);
    if ("problem" in check) {
      // The server overrides may be what broke Codex, so the launch carries
      // only the Apps one, a known feature key.
      return partial(`${check.problem} while verifying the disable overrides`, {
        disable: appsOff,
        enabled: [...keptDeclared, ...unwanted],
        unconfigured,
      });
    }
    verified = check.servers.filter((server) => server.name !== CODEX_APPS_SERVER_NAME);
  }
  const apps = await readCodexAppsFeature(input.features, [
    ...base,
    ...codexMcpServerDisableOverrides(disable),
  ]);
  const ignored = configDisable.filter((name) =>
    verified.some((server) => server.name === name && server.enabled));
  const appsProblem = "problem" in apps
    ? (keepApps ? undefined : `${apps.problem}, so the Apps connector (codex_apps) may still load`)
    : !keepApps && apps.enabled
      ? "the Codex apps feature stayed on under features.apps=false, so the Apps connector (codex_apps) may still load"
      : undefined;
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
    ...(appsProblem ? [appsProblem] : []),
  ];
  // A declared codex_apps is reported enabled when the feature is on; whether
  // Codex then registers the connector also depends on ChatGPT auth.
  const appsEnabled = keepApps && !("problem" in apps) && apps.enabled;
  const enabled = [
    ...verified.filter((server) => server.enabled).map((server) => server.name),
    ...(appsEnabled ? [CODEX_APPS_SERVER_NAME] : []),
  ];
  const disabled = [
    ...configDisable.filter((name) => !ignored.includes(name)),
    ...(!keepApps && !appsProblem ? [CODEX_APPS_SERVER_NAME] : []),
  ];
  const finalUnconfigured = keepApps && !appsEnabled
    ? [...unconfigured, CODEX_APPS_SERVER_NAME]
    : unconfigured;
  if (reasons.length > 0) {
    return partial(reasons.join("; "), {
      disable,
      disabled,
      enabled,
      unconfigured: finalUnconfigured,
    });
  }
  return {
    disable,
    outcome: {
      enforcement: "enforced",
      enabled,
      disabled,
      ...(finalUnconfigured.length > 0 ? { unconfigured: finalUnconfigured } : {}),
    },
  };
}

// ---- Claude Code -----------------------------------------------------------

/**
 * Claude Code loads MCP servers from several layers (user `~/.claude.json`,
 * project `.mcp.json`, local project entries, plugins). `--strict-mcp-config`
 * with `--mcp-config` replaces that set for one launch (Claude Code ≥ 2.1.x).
 */

export type ClaudeMcpServerDefinition = Record<string, unknown>;

export interface ClaudeMcpConfigFile {
  mcpServers: Record<string, ClaudeMcpServerDefinition>;
}

/** Shape of the `mcp_servers` field on Claude's stream-json `system/init` event. */
export interface ClaudeInitMcpServer {
  name: string;
  status?: string;
}

/**
 * Reads only each entry's `name` from a Claude stream-json `system/init` line.
 * Returns undefined when no init event is present or `mcp_servers` is missing.
 */
export function parseClaudeInitMcpServers(stdout: string): ClaudeInitMcpServer[] | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as { type?: unknown; subtype?: unknown; mcp_servers?: unknown };
    if (record.type !== "system" || record.subtype !== "init") continue;
    if (!Array.isArray(record.mcp_servers)) return undefined;
    const servers: ClaudeInitMcpServer[] = [];
    for (const entry of record.mcp_servers) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const { name, status } = entry as { name?: unknown; status?: unknown };
      if (typeof name !== "string") return undefined;
      servers.push({
        name,
        ...(typeof status === "string" ? { status } : {}),
      });
    }
    return servers;
  }
  return undefined;
}

/** Argv that produces a `system/init` event without needing a successful model call. */
export function claudeMcpProbeArgs(configPath: string): string[] {
  // `--mcp-config` is variadic, so another flag must follow the path or the
  // prompt is read as a second config file.
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--permission-prompts",
    "none",
    "nitely-mcp-probe",
  ];
}

/** Launch argv with Claude's exclusive MCP config. */
export function withClaudeStrictMcpConfig(
  args: readonly string[],
  configPath: string,
): string[] {
  // Place the restriction flags early so subcommands and trailing `-` prompts stay intact.
  return ["--strict-mcp-config", "--mcp-config", configPath, ...args];
}

/**
 * Picks declared server definitions out of already-loaded Claude config layers.
 * Precedence matches Claude Code: local project entry, then project `.mcp.json`,
 * then user scope. Definitions are returned for `--mcp-config`; callers must not
 * log or persist them beyond the temp file the launch reads.
 */
export function selectClaudeMcpServers(input: {
  declared: readonly string[];
  /** Highest precedence first. */
  layers: ReadonlyArray<Readonly<Record<string, ClaudeMcpServerDefinition>>>;
}): {
  selected: Record<string, ClaudeMcpServerDefinition>;
  available: string[];
  unconfigured: string[];
} {
  const available: string[] = [];
  const seen = new Set<string>();
  for (const layer of input.layers) {
    for (const name of Object.keys(layer)) {
      if (!seen.has(name)) {
        seen.add(name);
        available.push(name);
      }
    }
  }
  const selected: Record<string, ClaudeMcpServerDefinition> = {};
  const unconfigured: string[] = [];
  for (const name of input.declared) {
    let found: ClaudeMcpServerDefinition | undefined;
    for (const layer of input.layers) {
      if (Object.prototype.hasOwnProperty.call(layer, name)) {
        found = layer[name];
        break;
      }
    }
    if (found) selected[name] = found;
    else unconfigured.push(name);
  }
  return { selected, available, unconfigured };
}

/** Builds the JSON document Claude accepts via `--mcp-config`. */
export function claudeMcpConfigDocument(
  servers: Record<string, ClaudeMcpServerDefinition>,
): ClaudeMcpConfigFile {
  return { mcpServers: { ...servers } };
}

/**
 * Leaves exactly the declared MCP servers enabled for a Claude Code launch.
 *
 * Mechanism (Claude Code 2.1.x): write a temp `--mcp-config` that holds only the
 * declared server definitions, pass `--strict-mcp-config` so every other layer
 * is ignored, then confirm through a stream-json `system/init` probe (no
 * successful model call required).
 */
export async function restrictClaudeMcpServers(input: {
  request: Exclude<AgentMcpServersRequest, { mode: "inherited" }>;
  stageId: string;
  /** Runs the Claude CLI with the given argv and returns combined stdout. */
  probe: (args: readonly string[]) => Promise<string>;
  /** Write the exclusive MCP config JSON; returns an absolute path. */
  writeConfig: (document: ClaudeMcpConfigFile) => Promise<string>;
  /** Config layers, highest precedence first (local, project, user). */
  layers: ReadonlyArray<Readonly<Record<string, ClaudeMcpServerDefinition>>>;
}): Promise<{
  disable: string[];
  outcome: AgentMcpServersOutcome;
  applyArgs: (args: readonly string[]) => string[];
  configPath: string;
}> {
  const declared = input.request.declared;
  const { selected, available, unconfigured } = selectClaudeMcpServers({
    declared,
    layers: input.layers,
  });
  const disabled = available.filter((name) => !declared.includes(name));
  const document = claudeMcpConfigDocument(selected);
  const configPath = await input.writeConfig(document);
  const applyArgs = (args: readonly string[]) => withClaudeStrictMcpConfig(args, configPath);

  const failClosed = (reason: string): never => {
    throw new Error(
      `stage ${input.stageId} requires only its declared MCP servers but ${reason}`,
    );
  };
  const partial = (reason: string, enabled: string[]) => {
    if (input.request.mode === "declared-required") failClosed(reason);
    return {
      disable: ["__claude_strict__"],
      outcome: {
        enforcement: "partial" as const,
        enabled,
        disabled,
        ...(unconfigured.length > 0 ? { unconfigured } : {}),
        reason,
      },
      applyArgs,
      configPath,
    };
  };

  let stdout: string;
  try {
    stdout = await input.probe(claudeMcpProbeArgs(configPath));
  } catch (error) {
    // A fake or missing API key still emits system/init before failing; Node's
    // execFile attaches that stdout to the error. Prefer it over failing open.
    const recovered =
      error && typeof error === "object" && "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    if (parseClaudeInitMcpServers(recovered)) {
      stdout = recovered;
    } else {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      return partial(`claude MCP probe failed: ${message}`, Object.keys(selected));
    }
  }
  const listed = parseClaudeInitMcpServers(stdout);
  if (!listed) {
    return partial(
      "claude did not emit a system/init mcp_servers list under --strict-mcp-config",
      Object.keys(selected),
    );
  }
  const listedNames = listed.map((server) => server.name);
  const unexpected = listedNames.filter((name) => !declared.includes(name));
  const missingSelected = Object.keys(selected).filter((name) => !listedNames.includes(name));
  const reasons = [
    ...(unexpected.length > 0
      ? [`undeclared MCP server(s) ${unexpected.join(", ")} still appeared under --strict-mcp-config`]
      : []),
    ...(missingSelected.length > 0
      ? [`declared MCP server(s) ${missingSelected.join(", ")} did not appear under --mcp-config`]
      : []),
  ];
  if (reasons.length > 0) {
    return partial(reasons.join("; "), listedNames);
  }
  return {
    // Non-empty so backends that only call disable() when length > 0 still apply.
    disable: ["__claude_strict__"],
    outcome: {
      enforcement: "enforced",
      enabled: listedNames,
      disabled,
      ...(unconfigured.length > 0 ? { unconfigured } : {}),
    },
    applyArgs,
    configPath,
  };
}
