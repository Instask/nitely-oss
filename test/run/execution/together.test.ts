import { describe, expect, it } from "vitest";

import { classifyAgentRuntimeBlocker } from "../../../src/run/blockers.js";
import {
  TOGETHER_EXAMPLE_MODEL,
  createTogetherAgentArgs,
  describeTogetherFailure,
  togetherModelProblem,
} from "../../../src/run/execution/together.js";

describe("Together AI runtime helpers", () => {
  it("accepts Together model ids, with or without the provider prefix", () => {
    for (const model of [
      TOGETHER_EXAMPLE_MODEL,
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
      "deepseek-ai/DeepSeek-V3.1",
      "together/moonshotai/Kimi-K3",
      "moonshotai/Kimi-K3:high",
      "my-account/my-finetune-1a2b3c",
    ]) {
      expect(togetherModelProblem(model), model).toBeUndefined();
    }
  });

  it("rejects a missing model with an actionable message instead of using Pi's default", () => {
    for (const model of [undefined, "", "  "]) {
      const problem = togetherModelProblem(model);
      expect(problem).toMatch(/agent runtime together requires a Together AI model id/);
      expect(problem).toContain(TOGETHER_EXAMPLE_MODEL);
      expect(problem).toContain("https://api.together.ai/models");
    }
  });

  it("rejects model values that cannot name a Together model", () => {
    for (const model of ["kimi-k3", "moonshotai/", "/Kimi-K3", "moonshot ai/Kimi K3", "--api-key/x", "together/"]) {
      expect(togetherModelProblem(model), model).toMatch(
        new RegExp(`does not support model "${model.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}".*<organization>/<model>`),
      );
    }
  });

  it("selects Pi's Together provider and passes the model, never a key", () => {
    expect(createTogetherAgentArgs("moonshotai/Kimi-K3")).toEqual([
      "-p",
      "--provider",
      "together",
      "--model",
      "moonshotai/Kimi-K3",
    ]);
    expect(createTogetherAgentArgs()).toEqual(["-p", "--provider", "together"]);
    expect(createTogetherAgentArgs(" moonshotai/Kimi-K3 ")).toContain("moonshotai/Kimi-K3");
  });

  it("explains rejected credentials so the run blocks on credentials", () => {
    const explanation = describeTogetherFailure({
      model: "moonshotai/Kimi-K3",
      // Verbatim Pi 1.0.4 output for a rejected key.
      stderr:
        '401: {"message":"Invalid API key provided. You can find your API key at https://api.together.ai/settings/api-keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}\n',
    });
    expect(explanation).toMatch(/Together AI rejected the API key/);
    expect(explanation).toMatch(/Web Console or set TOGETHER_API_KEY/);
    expect(
      classifyAgentRuntimeBlocker({
        stageId: "implement",
        runtime: "together",
        error: new Error(`together exited with code 1: ${explanation}`),
      }),
    ).toMatchObject({ reason: "agent_credentials_invalid", runtime: "together" });

    expect(
      describeTogetherFailure({
        stderr: "No API key found for together.\n\nUse /login to log into a provider via OAuth or API key.\n",
      }),
    ).toMatch(/Together AI rejected the API key or none reached Pi/);
  });

  it("explains an unavailable model without classifying it as a credential or capacity block", () => {
    const explanation = describeTogetherFailure({
      model: "moonshotai/Kimi-K9",
      stderr:
        'Warning: Model "moonshotai/Kimi-K9" not found for provider "together". Using custom model id.\n' +
        '404: {"message":"Unable to access model moonshotai/Kimi-K9. Please visit https://api.together.ai/models to view the list of supported models.","type":"invalid_request_error","code":"model_not_available"}\n',
    });
    expect(explanation).toMatch(/Together AI could not serve model "moonshotai\/Kimi-K9"/);
    expect(explanation).toContain("https://api.together.ai/models");
    expect(
      classifyAgentRuntimeBlocker({
        stageId: "implement",
        runtime: "together",
        error: new Error(`together exited with code 1: ${explanation}`),
      }),
    ).toBeUndefined();
  });

  it("points at the Pi installation when it has no Together provider", () => {
    expect(
      describeTogetherFailure({
        stderr: 'Unknown provider "together". Use --list-models to see available providers/models.\n',
      }),
    ).toMatch(/installed Pi CLI has no built-in Together AI provider.*NITELY_PI_COMMAND/);
  });

  it("leaves unrecognised failures alone, including Pi's catalog warning", () => {
    expect(describeTogetherFailure({ stderr: "segmentation fault\n" })).toBeUndefined();
    expect(
      describeTogetherFailure({
        stderr:
          'Warning: Model "acme/new-model" not found for provider "together". Using custom model id.\n500: internal server error\n',
      }),
    ).toBeUndefined();
    expect(describeTogetherFailure({ stderr: "" })).toBeUndefined();
  });
});
