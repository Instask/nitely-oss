import { describe, expect, it } from "vitest";
import { parseFlowDocument } from "../../src/flow/load.js";
import { applyRunOverrides } from "../../src/flow/overrides.js";

describe("run override fallback handling", () => {
  it("preserves valid fallback candidates and the original flow", () => {
    const flow = parseFlowDocument(JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "evaluate" },
      spec: { stages: [{ id: "implement", type: "agent", prompt: "Implement", outputs: ["result"], runtimes: [{ runtime: "openrouter", model: "old" }, { runtime: "pi", model: "fallback" }] }] },
    })).flow;
    const applied = applyRunOverrides(flow, { model: "selected", effort: "high" });
    expect(applied.spec.stages[0]).toMatchObject({ runtimes: [{ runtime: "openrouter", model: "selected", effort: "high" }, { runtime: "pi", model: "selected", effort: "high" }] });
    expect(() => parseFlowDocument(JSON.stringify(applied))).not.toThrow();
    expect(flow.spec.stages[0]).toMatchObject({ runtimes: [{ model: "old" }, { model: "fallback" }] });
    const selected = applyRunOverrides(flow, { runtime: "codex", model: "new", effort: "low" });
    expect(selected.spec.stages[0]).toMatchObject({ runtime: "codex", model: "new", effort: "low" });
    expect(selected.spec.stages[0]).not.toHaveProperty("runtimes");
    expect(() => parseFlowDocument(JSON.stringify(selected))).not.toThrow();
  });
});
