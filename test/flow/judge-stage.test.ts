import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";

describe("judge Flow stage", () => {
  it("validates criteria, runtime, and bounded rework configuration", () => {
    const loaded = parseFlowDocument(
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "judge-flow" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "codex",
              prompt: "Implement",
              outputs: ["implementation"],
            },
            {
              id: "judge",
              type: "judge",
              runtime: "codex",
              prompt: "Judge",
              criteria: ["scope is correct", "tests are meaningful"],
              onRework: "implement",
              maxRework: 2,
              inputs: ["implementation"],
              outputs: [{ id: "judge-result", type: "judge.result", mediaType: "application/json" }],
            },
          ],
        },
      }),
    );

    expect(loaded.graph.order).toEqual(["implement", "judge"]);
    expect(loaded.flow.spec.stages[1]).toMatchObject({
      type: "judge",
      criteria: ["scope is correct", "tests are meaningful"],
      maxRework: 2,
    });
  });
});
