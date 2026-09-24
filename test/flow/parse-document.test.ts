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

  it("keeps context.fullReadInputs on an agent stage", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "full-read" },
      spec: {
        stages: [
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt: "Plan.",
            inputs: ["spec"],
            context: { fullReadInputs: ["spec"] },
            outputs: ["task-plan"],
          },
        ],
      },
    });

    const result = parseFlowDocument(flow, { externalInputs: ["spec"] });
    expect(result.flow.spec.stages[0]).toMatchObject({
      context: { fullReadInputs: ["spec"] },
    });
  });

  it("rejects a fullReadInputs id that the stage does not declare as an input", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "full-read-undeclared" },
      spec: {
        stages: [
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt: "Plan.",
            inputs: ["spec"],
            context: { fullReadInputs: ["tech-design"] },
            outputs: ["task-plan"],
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow, { externalInputs: ["spec"] })).toThrow(
      FlowValidationError,
    );
    expect(() => parseFlowDocument(flow, { externalInputs: ["spec"] })).toThrow(
      /fullReadInputs id must be declared in stage plan-tasks inputs: tech-design/,
    );
  });

  it("rejects duplicate fullReadInputs ids on a stage", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "full-read-duplicate" },
      spec: {
        stages: [
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt: "Plan.",
            inputs: ["spec"],
            context: { fullReadInputs: ["spec", "spec"] },
            outputs: ["task-plan"],
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow, { externalInputs: ["spec"] })).toThrow(
      /duplicate fullReadInputs id on stage plan-tasks: spec/,
    );
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

  it("preserves a fully typed agent convergence contract", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "converge", inputs: [{ id: "tasks" }] },
      spec: {
        stages: [
          {
            id: "converge",
            type: "agent",
            runtime: "codex",
            prompt: "Compare the implementation with the feature artifacts.",
            inputs: ["tasks"],
            outputs: [
              {
                id: "convergence-report",
                type: "convergence.report",
                mediaType: "application/vnd.nitely.convergence+json",
              },
              {
                id: "converged-tasks",
                type: "task.converged",
                mediaType: "text/markdown",
              },
            ],
            convergence: {
              tasksInput: "tasks",
              reportOutput: "convergence-report",
              tasksOutput: "converged-tasks",
            },
          },
        ],
      },
    });

    const result = parseFlowDocument(flow);
    expect(result.flow.spec.stages[0]).toMatchObject({
      convergence: {
        tasksInput: "tasks",
        reportOutput: "convergence-report",
        tasksOutput: "converged-tasks",
      },
    });
  });

  it("rejects convergence contracts that do not declare distinct typed inputs and outputs", () => {
    const invalidStage = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "invalid-convergence", inputs: [{ id: "tasks" }] },
        spec: {
          stages: [
            {
              id: "converge",
              type: "agent",
              runtime: "codex",
              prompt: "Converge.",
              inputs: ["tasks"],
              outputs: [
                {
                  id: "convergence-report",
                  type: "convergence.report",
                  mediaType: "application/vnd.nitely.convergence+json",
                },
                {
                  id: "converged-tasks",
                  type: "task.converged",
                  mediaType: "text/markdown",
                },
              ],
              convergence: {
                tasksInput: "tasks",
                reportOutput: "convergence-report",
                tasksOutput: "converged-tasks",
              },
              ...overrides,
            },
          ],
        },
      });

    expect(() =>
      parseFlowDocument(
        invalidStage({
          convergence: {
            tasksInput: "missing-tasks",
            reportOutput: "convergence-report",
            tasksOutput: "converged-tasks",
          },
        }),
      ),
    ).toThrow(/tasksInput must be declared in stage inputs/);
    expect(() =>
      parseFlowDocument(
        invalidStage({
          convergence: {
            tasksInput: "tasks",
            reportOutput: "convergence-report",
            tasksOutput: "convergence-report",
          },
        }),
      ),
    ).toThrow(/tasksInput, reportOutput, and tasksOutput must be distinct/);
    expect(() =>
      parseFlowDocument(
        invalidStage({
          outputs: [
            {
              id: "convergence-report",
              type: "report",
              mediaType: "application/json",
            },
            {
              id: "converged-tasks",
              type: "task.converged",
              mediaType: "text/markdown",
            },
          ],
        }),
      ),
    ).toThrow(/reportOutput must declare type convergence\.report/);
  });

  it("rejects convergence configuration on non-agent stages", () => {
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "command-convergence" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["result"],
            convergence: {
              tasksInput: "tasks",
              reportOutput: "report",
              tasksOutput: "result",
            },
          },
        ],
      },
    });

    expect(() => parseFlowDocument(flow)).toThrow(
      /convergence is only valid on agent stages/,
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
