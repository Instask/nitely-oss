import { describe, expect, it } from "vitest";

import { stageDependencyRequirements } from "../../src/flow/requirements.js";
import type { Stage } from "../../src/flow/schema.js";

describe("stageDependencyRequirements", () => {
  it("maps known MCP server ids to provider ids", () => {
    const stage = {
      id: "implement",
      type: "agent",
      runtime: "codex",
      required_mcp_servers: ["google-docs", "github-cli", "claude", "zhipu", "openai"],
      required_connectors: [],
      prompt: "Implement.",
      inputs: [],
      outputs: ["implementation"],
      skills: [],
    } satisfies Stage;

    expect(stageDependencyRequirements(stage)).toMatchObject({
      mcpServers: ["google-docs", "github-cli", "claude", "zhipu", "openai"],
      connectors: [],
      providerIds: ["google-drive", "github", "anthropic", "glm", "codex"],
      unknownMcpServers: [],
    });
  });

  it("preserves unknown MCP server ids without mapping them to providers", () => {
    const stage = {
      id: "implement",
      type: "agent",
      runtime: "codex",
      required_mcp_servers: ["custom-mcp"],
      required_connectors: [],
      prompt: "Implement.",
      inputs: [],
      outputs: ["implementation"],
      skills: [],
    } satisfies Stage;

    expect(stageDependencyRequirements(stage)).toMatchObject({
      providerIds: [],
      unknownMcpServers: ["custom-mcp"],
    });
  });

  it("deduplicates explicit and mapped provider ids", () => {
    const stage = {
      id: "implement",
      type: "agent",
      runtime: "codex",
      required_mcp_servers: ["google-drive", "google-sheets"],
      required_connectors: ["google-drive"],
      prompt: "Implement.",
      inputs: [],
      outputs: ["implementation"],
      skills: [],
    } satisfies Stage;

    expect(stageDependencyRequirements(stage).providerIds).toEqual(["google-drive"]);
  });
});
