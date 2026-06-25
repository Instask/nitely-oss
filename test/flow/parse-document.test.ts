import { describe, expect, it } from "vitest";

import { FlowValidationError, parseFlowDocument } from "../../src/flow/load.js";

const validFlow = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "from-content" },
  spec: {
    stages: [
      { id: "build", type: "command", command: "true", inputs: ["seed"], outputs: ["out"] },
    ],
  },
});

describe("parseFlowDocument", () => {
  it("parses, validates, and builds the graph from a content string", () => {
    const result = parseFlowDocument(validFlow, { externalInputs: ["seed"] });
    expect(result.flow.metadata.name).toBe("from-content");
    expect(result.graph.order).toEqual(["build"]);
    expect(result.graph.producerByArtifact.get("out")).toBe("build");
  });

  it("preserves dependency requirements on agent stages", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "requirements" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            required_mcp_servers: ["google-docs"],
            required_connectors: ["github"],
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const result = parseFlowDocument(flow, {});
    const stage = result.flow.spec.stages[0];
    expect(stage).toMatchObject({
      id: "implement",
      required_mcp_servers: ["google-docs"],
      required_connectors: ["github"],
    });
  });

  it("rejects duplicate MCP server requirements on a stage", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "duplicate-mcp" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            required_mcp_servers: ["google-drive", "google-drive"],
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow, {})).toThrow(
      /duplicate required_mcp_servers id on stage implement: google-drive/,
    );
  });

  it("rejects duplicate connector requirements on a stage", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "duplicate-connector" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            required_connectors: ["github", "github"],
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow, {})).toThrow(
      /duplicate required_connectors id on stage implement: github/,
    );
  });

  it("rejects dependency requirements on command stages", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-requirements" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            required_mcp_servers: ["google-drive"],
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow, {})).toThrow(
      /required_mcp_servers are only valid on agent and review gate stages/,
    );
  });

  it("throws FlowValidationError for invalid JSON", () => {
    expect(() => parseFlowDocument("{ not json", {})).toThrow(FlowValidationError);
  });

  it("throws FlowValidationError for a schema violation", () => {
    const bad = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "bad" },
      spec: { stages: [] },
    });
    expect(() => parseFlowDocument(bad, {})).toThrow(FlowValidationError);
  });

  it("reports unknown input artifacts as a graph error", () => {
    expect(() => parseFlowDocument(validFlow, { externalInputs: [] })).toThrow(
      FlowValidationError,
    );
  });
});
