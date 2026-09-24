import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatFlowGraph } from "../../src/flow/format-graph.js";
import { loadFlow, parseFlowDocument } from "../../src/flow/load.js";

function twoStageFlow() {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "hello" },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          model: "test-model",
          prompt: "Write hello.",
          inputs: ["spec"],
          outputs: ["implementation"],
        },
        {
          id: "test",
          type: "command",
          command: "npm test",
          inputs: ["implementation"],
          outputs: ["test-report"],
        },
      ],
    },
  };
}

describe("formatFlowGraph", () => {
  it("prints one STAGE line per graph order, then artifact EDGE and INPUT lines", () => {
    const { flow, graph } = parseFlowDocument(JSON.stringify(twoStageFlow()), {
      externalInputs: ["spec"],
    });

    const text = formatFlowGraph(flow, graph, { format: "text" });

    expect(text).toBe(
      [
        "STAGE implement agent mock/test-model in:spec out:implementation",
        "STAGE test command npm test in:implementation out:test-report",
        "EDGE implement -[implementation]-> test",
        "INPUT spec",
      ].join("\n"),
    );
  });

  it("emits GitHub-pasteable mermaid with stadium inputs and artifact-labeled edges", () => {
    const { flow, graph } = parseFlowDocument(JSON.stringify(twoStageFlow()), {
      externalInputs: ["spec"],
    });

    const mermaid = formatFlowGraph(flow, graph, { format: "mermaid" });

    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain('spec(["spec"])');
    expect(mermaid).toContain('implement["implement"]');
    expect(mermaid).toContain('test["test"]');
    expect(mermaid).toContain("spec -->|spec| implement");
    expect(mermaid).toContain("implement -->|implementation| test");
    expect(mermaid).not.toContain("implement -->|spec|");
    expect(mermaid).not.toContain("test -->|");
  });

  it("projects json with stage ids, one edge per artifact, and input: sources", () => {
    const { flow, graph } = parseFlowDocument(JSON.stringify(twoStageFlow()), {
      externalInputs: ["spec"],
    });

    const parsed = JSON.parse(
      formatFlowGraph(flow, graph, { format: "json" }),
    ) as {
      name: string;
      stages: Array<Record<string, unknown>>;
      edges: Array<{ from: string; to: string; artifact: string }>;
      externalInputs: string[];
    };

    expect(parsed.name).toBe("hello");
    expect(parsed.externalInputs).toEqual(["spec"]);
    expect(parsed.stages.map((stage) => stage.id)).toEqual(["implement", "test"]);
    expect(parsed.stages[0]).toMatchObject({
      id: "implement",
      type: "agent",
      runtime: "mock",
      model: "test-model",
      inputs: ["spec"],
      outputs: ["implementation"],
    });
    expect(parsed.stages[1]).toMatchObject({
      id: "test",
      type: "command",
      command: "npm test",
      inputs: ["implementation"],
      outputs: ["test-report"],
    });
    expect(parsed.edges).toEqual([
      { from: "input:spec", to: "implement", artifact: "spec" },
      { from: "implement", to: "test", artifact: "implementation" },
    ]);
  });

  it("matches implement-spec-bootstrap artifact edges in mermaid", async () => {
    const { flow, graph } = await loadFlow(
      join(process.cwd(), "flows/implement-spec-bootstrap.json"),
      { externalInputs: ["spec", "tech-design"] },
    );

    const mermaid = formatFlowGraph(flow, graph, { format: "mermaid" });

    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain('spec(["spec"])');
    expect(mermaid).toContain('tech-design(["tech-design"])');
    expect(mermaid).toContain("write-tests -->|tests| implement");
    expect(mermaid).toContain("implement -->|implementation| test");
    expect(mermaid).toContain("implement -->|pr-title| publish");
    expect(mermaid).toContain("test -->|test-report| review");
    expect(mermaid).not.toContain("write-tests -->|implementation|");
    expect(mermaid).not.toContain("write-tests --> test");
  });
});
