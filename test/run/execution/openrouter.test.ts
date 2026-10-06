import { describe, expect, it } from "vitest";

import { classifyAgentRuntimeBlocker } from "../../../src/run/blockers.js";
import {
  OPENROUTER_API_KEY_ENV,
  createOpenRouterAgentArgs,
  describeOpenRouterFailure,
  openRouterModelProblem,
} from "../../../src/run/execution/openrouter.js";

const PI_UNKNOWN_MODEL_WARNING =
  'Warning: Model "openrouter/acme/new-model" not found for provider "openrouter". Using custom model id.';

function blockerFor(stderr: string, model = "qwen/qwen3-coder-next") {
  const explanation = describeOpenRouterFailure({ model, stderr });
  const message = explanation ? `openrouter exited with code 1: ${explanation}` : "openrouter exited with code 1";
  return {
    explanation,
    blocker: classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "openrouter",
      error: Object.assign(new Error(message), { stdout: "", stderr }),
    }),
  };
}

describe("openRouterModelProblem", () => {
  it.each([
    "qwen/qwen3-coder-next",
    "moonshotai/kimi-k3",
    "z-ai/glm-5.3",
    "openai/gpt-5.1-codex",
    "meta-llama/llama-3.3-70b-instruct:free",
    "~deepseek/deepseek-v4-flash-latest",
    "openrouter/auto",
    "  qwen/qwen3-coder-next  ",
  ])("accepts OpenRouter model id %s", (model) => {
    expect(openRouterModelProblem(model)).toBeUndefined();
  });

  it("requires a model because the runtime has no safe default", () => {
    expect(openRouterModelProblem(undefined)).toMatch(
      /runtime openrouter requires a model\..*qwen\/qwen3-coder-next.*https:\/\/openrouter\.ai\/models/,
    );
    expect(openRouterModelProblem("   ")).toMatch(/requires a model/);
  });

  it.each(["qwen3-coder-next", "qwen/", "/qwen3", "qwen/qwen3 coder", "--help", "a/b/c", "qwen/qwen3:"])(
    "rejects %s with the expected id shape",
    (model) => {
      expect(openRouterModelProblem(model)).toMatch(
        /runtime openrouter cannot use model .*<author>\/<model>.*qwen\/qwen3-coder-next/,
      );
    },
  );
});

describe("createOpenRouterAgentArgs", () => {
  it("selects Pi's openrouter provider and passes the exact model id", () => {
    expect(createOpenRouterAgentArgs("qwen/qwen3-coder-next")).toEqual([
      "-p",
      "--provider",
      "openrouter",
      "--model",
      "openrouter/qwen/qwen3-coder-next",
    ]);
  });

  it("keeps OpenRouter's own openrouter/* ids intact behind Pi's provider prefix", () => {
    expect(createOpenRouterAgentArgs("openrouter/auto")).toContain("openrouter/openrouter/auto");
  });

  it("refuses to build a launch without a valid model", () => {
    expect(() => createOpenRouterAgentArgs(undefined)).toThrow(/requires a model/);
  });

  it("never carries the API key", () => {
    expect(OPENROUTER_API_KEY_ENV).toBe("OPENROUTER_API_KEY");
    expect(createOpenRouterAgentArgs("qwen/qwen3-coder-next").join(" ")).not.toMatch(/key|sk-or/i);
  });
});

describe("describeOpenRouterFailure", () => {
  it("explains the key rejection Pi prints and blocks the run for the operator", () => {
    const { explanation, blocker } = blockerFor(
      `${PI_UNKNOWN_MODEL_WARNING}\n401: {"message":"User not found.","code":401}\n`,
    );
    expect(explanation).toMatch(/OpenRouter rejected the API key \(401\)\. Replace OPENROUTER_API_KEY or the OpenRouter connection in the Web Console/);
    expect(blocker?.reason).toBe("agent_credentials_invalid");
  });

  it("explains a missing key reported by Pi", () => {
    expect(
      describeOpenRouterFailure({ stderr: "No API key found for openrouter.\n\nUse /login to log into a provider" }),
    ).toMatch(/Set OPENROUTER_API_KEY or connect OpenRouter in the Web Console/);
  });

  it("treats exhausted credits as a quota block, not a retryable failure", () => {
    const { explanation, blocker } = blockerFor(
      '402: {"message":"This request requires more credits, or fewer max_tokens.","code":402}',
    );
    expect(explanation).toMatch(/OpenRouter quota exceeded.*402.*Add credits/);
    expect(blocker?.reason).toBe("agent_usage_limit");
  });

  it("treats a rate limit as a usage block so ordered candidates can take over", () => {
    const { explanation, blocker } = blockerFor(
      '429: {"message":"Rate limit exceeded: free-models-per-min. ","code":429}',
      "qwen/qwen3-coder-next:free",
    );
    expect(explanation).toMatch(/OpenRouter rate limit reached for model qwen\/qwen3-coder-next:free \(429\)/);
    expect(blocker?.reason).toBe("agent_usage_limit");
  });

  it("explains an unavailable model as an ordinary failure", () => {
    const { explanation, blocker } = blockerFor(
      '404: {"message":"No endpoints found for qwen/qwen3-coder-next.","code":404}',
    );
    expect(explanation).toMatch(/OpenRouter has no available endpoint for model qwen\/qwen3-coder-next\. Check the exact id at https:\/\/openrouter\.ai\/models/);
    expect(blocker).toBeUndefined();
  });

  it.each([
    '502: {"message":"Provider returned error","code":502}',
    '503: {"message":"No allowed providers are available for the selected model.","code":503}',
    "Request timed out.",
  ])("explains upstream provider failure %s without blocking, so retries apply", (stderr) => {
    const { explanation, blocker } = blockerFor(stderr);
    expect(explanation).toMatch(/OpenRouter or its upstream provider failed while serving model qwen\/qwen3-coder-next/);
    expect(blocker).toBeUndefined();
  });

  it("asks for a Pi upgrade when Pi has no openrouter provider", () => {
    expect(
      describeOpenRouterFailure({
        stderr: 'Error: Unknown provider "openrouter". Use --list-models to see available providers/models.',
      }),
    ).toMatch(/Upgrade Pi.*NITELY_PI_COMMAND/);
  });

  it("ignores Pi's unknown-model warning and unrecognised output", () => {
    expect(describeOpenRouterFailure({ stderr: PI_UNKNOWN_MODEL_WARNING })).toBeUndefined();
    expect(describeOpenRouterFailure({ stderr: "something unexpected" })).toBeUndefined();
    expect(describeOpenRouterFailure({ stderr: "" })).toBeUndefined();
  });

  it("never echoes anything resembling the key back", () => {
    const key = "sk-or-v1-0123456789abcdef";
    const explanation = describeOpenRouterFailure({
      stderr: `401: {"message":"User not found.","code":401} ${key}`,
    });
    expect(explanation).not.toContain(key);
  });
});
