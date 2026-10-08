import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";
import {
  normalizeFlowConfiguration,
  FlowConfigurationError,
  FlowConfigurationMissingError,
} from "../../src/flows/configurables.js";

function flowWithConfigurables(configurables: unknown[]) {
  return parseFlowDocument(
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "configured",
        configurables,
      },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    {},
  ).flow;
}

describe("flow configurables", () => {
  it("normalizes submitted values and applies defaults", () => {
    const flow = flowWithConfigurables([
      { key: "scope", type: "text", label: "Scope", required: true },
      { key: "retries", type: "number", label: "Retries", default: 2 },
      { key: "dryRun", type: "boolean", label: "Dry run", default: true },
    ]);

    expect(normalizeFlowConfiguration(flow, { scope: "checkout" })).toEqual({
      scope: "checkout",
      retries: 2,
      dryRun: true,
    });
  });

  it("rejects missing required values", () => {
    const flow = flowWithConfigurables([
      { key: "scope", type: "text", label: "Scope", required: true },
    ]);

    expect(() => normalizeFlowConfiguration(flow, {})).toThrow(
      new FlowConfigurationMissingError("scope"),
    );
  });

  it("rejects unknown configurable keys", () => {
    const flow = flowWithConfigurables([
      { key: "scope", type: "text", label: "Scope" },
    ]);

    expect(() =>
      normalizeFlowConfiguration(flow, { other: "value" }),
    ).toThrow(new FlowConfigurationError("unknown configurable: other"));
  });
});

it("uses repository defaults only for declared keys and lets task values override them", () => {
  const flow = flowWithConfigurables([{ key: "verifyCommand", label: "Verify", type: "text", required: true }]);
  expect(normalizeFlowConfiguration(flow, {}, { verifyCommand: "pytest -q", setupCommand: "uv sync" })).toEqual({ verifyCommand: "pytest -q" });
  expect(normalizeFlowConfiguration(flow, { verifyCommand: "go test ./..." }, { verifyCommand: "pytest -q" })).toEqual({ verifyCommand: "go test ./..." });
  expect(() => normalizeFlowConfiguration(flow, {}, {})).toThrow("missing required configurable: verifyCommand");
  try {
    normalizeFlowConfiguration(flow, {}, {});
  } catch (error) {
    expect(error).toBeInstanceOf(FlowConfigurationMissingError);
    expect(error).toBeInstanceOf(FlowConfigurationError);
    expect((error as FlowConfigurationMissingError).key).toBe("verifyCommand");
  }
});
