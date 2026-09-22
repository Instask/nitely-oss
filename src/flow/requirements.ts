import type { ProviderId } from "../providers/types.js";
import type { Stage } from "./schema.js";

export interface StageDependencyRequirements {
  readonly mcpServers: string[];
  readonly connectors: ProviderId[];
  readonly providerIds: ProviderId[];
  readonly unknownMcpServers: string[];
}

const MCP_PROVIDER_REQUIREMENTS = new Map<string, ProviderId>([
  ["google-drive", "google-drive"],
  ["google-docs", "google-drive"],
  ["google-sheets", "google-drive"],
  ["google-slides", "google-drive"],
  ["github", "github"],
  ["github-cli", "github"],
  ["claude", "anthropic"],
  ["anthropic", "anthropic"],
  ["glm", "glm"],
  ["zhipu", "glm"],
  ["grok", "grok"],
  ["xai", "grok"],
  ["pi", "pi"],
  ["codex", "codex"],
  ["openai", "codex"],
]);

function hasDependencyDeclarations(
  stage: Stage,
): stage is
  | Extract<Stage, { type: "agent" }>
  | Extract<Stage, { type: "judge" }>
  | Extract<Stage, { type: "gate"; mode: "review" }> {
  return stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review");
}

function appendUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

export function stageDependencyRequirements(
  stage: Stage,
): StageDependencyRequirements {
  if (!hasDependencyDeclarations(stage)) {
    return {
      mcpServers: [],
      connectors: [],
      providerIds: [],
      unknownMcpServers: [],
    };
  }

  const mcpServers = [...stage.required_mcp_servers];
  const connectors = [...stage.required_connectors];
  const providerIds: ProviderId[] = [];
  const unknownMcpServers: string[] = [];

  for (const connector of connectors) {
    appendUnique(providerIds, connector);
  }

  for (const mcpServer of mcpServers) {
    const providerId = MCP_PROVIDER_REQUIREMENTS.get(mcpServer);
    if (!providerId) {
      unknownMcpServers.push(mcpServer);
      continue;
    }
    appendUnique(providerIds, providerId);
  }

  return {
    mcpServers,
    connectors,
    providerIds,
    unknownMcpServers,
  };
}
