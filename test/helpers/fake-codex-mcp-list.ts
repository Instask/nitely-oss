/**
 * Stands in for `codex mcp list --json`: applies `-c mcp_servers.<name>.enabled=`
 * overrides to a fixed server set and, like codex-cli 0.162.0, fails when an
 * override names a server that is not configured.
 */
export function fakeCodexMcpList(
  servers: Record<string, boolean>,
  options: { ignoreOverrides?: string[] } = {},
): { list: (overrides: readonly string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    list: async (overrides) => {
      calls.push([...overrides]);
      return fakeCodexMcpListOutput(servers, overrides, options);
    },
  };
}

export function fakeCodexMcpListOutput(
  servers: Record<string, boolean>,
  args: readonly string[],
  options: { ignoreOverrides?: string[] } = {},
): string {
  const effective = { ...servers };
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "-c") continue;
    const match = /^mcp_servers\.([^.]+)\.enabled=(true|false)$/.exec(args[index + 1]!);
    if (!match) continue;
    const [, name, value] = match;
    if (!(name! in effective)) {
      throw new Error("Error: failed to load bootstrap configuration");
    }
    if (!options.ignoreOverrides?.includes(name!)) effective[name!] = value === "true";
  }
  return JSON.stringify(
    Object.entries(effective).map(([name, enabled]) => ({ name, enabled, transport: {} })),
  );
}
