/**
 * Stands in for `codex mcp list --json` and `codex features list`: applies
 * `-c mcp_servers.<name>.enabled=` and `-c features.apps=` overrides to a fixed
 * server set and apps feature and, like codex-cli 0.162.0, fails when an
 * override names a server that is not configured.
 */
export interface FakeCodexOptions {
  ignoreOverrides?: string[];
  /** The apps feature before overrides. Codex 0.162.0 defaults it on. */
  apps?: boolean;
  /** Ignore features.apps overrides, as if a higher layer pinned it. */
  pinApps?: boolean;
}

export function fakeCodexMcpList(
  servers: Record<string, boolean>,
  options: FakeCodexOptions = {},
): {
  list: (overrides: readonly string[]) => Promise<string>;
  features: (overrides: readonly string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    list: async (overrides) => {
      calls.push([...overrides]);
      return fakeCodexMcpListOutput(servers, overrides, options);
    },
    features: async (overrides) =>
      fakeCodexProbeOutput(servers, [...overrides, "features", "list"], options),
  };
}

function applyOverrides(
  servers: Record<string, boolean>,
  args: readonly string[],
  options: FakeCodexOptions,
): { servers: Record<string, boolean>; apps: boolean } {
  const effective = { ...servers };
  let apps = options.apps ?? true;
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "-c") continue;
    const value = args[index + 1]!;
    const feature = /^features\.apps=(true|false)$/.exec(value);
    if (feature) {
      if (!options.pinApps) apps = feature[1] === "true";
      continue;
    }
    const match = /^mcp_servers\.([^.]+)\.enabled=(true|false)$/.exec(value);
    if (!match) continue;
    const [, name, state] = match;
    if (!(name! in effective)) {
      throw new Error("Error: failed to load bootstrap configuration");
    }
    if (!options.ignoreOverrides?.includes(name!)) effective[name!] = state === "true";
  }
  return { servers: effective, apps };
}

export function fakeCodexMcpListOutput(
  servers: Record<string, boolean>,
  args: readonly string[],
  options: FakeCodexOptions = {},
): string {
  const effective = applyOverrides(servers, args, options).servers;
  return JSON.stringify(
    Object.entries(effective).map(([name, enabled]) => ({ name, enabled, transport: {} })),
  );
}

/** Answers either probe, the way the runtime CLI would for these args. */
export function fakeCodexProbeOutput(
  servers: Record<string, boolean>,
  args: readonly string[],
  options: FakeCodexOptions = {},
): string {
  const featuresAt = args.indexOf("features");
  if (featuresAt !== -1 && args[featuresAt + 1] === "list") {
    const { apps } = applyOverrides(servers, args, options);
    return [
      `apps                                     stable             ${apps}`,
      "apps_mcp_path_override                   removed            false",
      "",
    ].join("\n");
  }
  return fakeCodexMcpListOutput(servers, args, options);
}
