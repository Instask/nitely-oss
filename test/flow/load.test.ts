import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FlowValidationError, loadFlow } from "../../src/flow/load.js";
import { stageRuntimeCandidates } from "../../src/flow/schema.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

async function writeFlow(flow: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nitely-flow-"));
  const path = join(directory, "flow.json");
  await writeFile(path, JSON.stringify(flow, null, 2), "utf8");
  return path;
}

function baseFlow(stages: unknown[]) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "test-flow" },
    spec: { stages },
  };
}

describe("loadFlow", () => {
  it("loads a valid flow and derives its artifact graph", async () => {
    const result = await loadFlow(join(fixtures, "valid-flow.json"), {
      externalInputs: ["spec"],
    });

    expect(result.flow.metadata.name).toBe("implement-spec");
    expect(result.graph.order).toEqual(["implement", "test"]);
    expect(result.graph.producerByArtifact.get("implementation")).toBe(
      "implement",
    );
  });

  it("accepts output artifact metadata objects and keeps string outputs compatible", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement the change.",
          inputs: ["spec"],
          outputs: [
            {
              id: "implementation",
              name: "Implementation summary",
              type: "implementation",
              description: "Markdown summary of code changes and verification",
              mediaType: "text/markdown",
              schema: { kind: "markdown" },
              version: "1",
            },
            "pr-title",
          ],
        },
        {
          id: "test",
          type: "command",
          command: "true",
          inputs: ["implementation", "pr-title"],
          outputs: ["test-report"],
        },
      ]),
    );

    const result = await loadFlow(path, { externalInputs: ["spec"] });

    expect(result.graph.order).toEqual(["implement", "test"]);
    expect(result.graph.producerByArtifact.get("implementation")).toBe(
      "implement",
    );
    expect(result.graph.producerByArtifact.get("pr-title")).toBe("implement");
    expect(result.flow.spec.stages[0]?.outputs).toEqual([
      {
        id: "implementation",
        name: "Implementation summary",
        type: "implementation",
        description: "Markdown summary of code changes and verification",
        mediaType: "text/markdown",
        schema: { kind: "markdown" },
        version: "1",
      },
      "pr-title",
    ]);
  });

  it("rejects duplicate stage IDs", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "same",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: [],
          outputs: ["one"],
        },
        {
          id: "same",
          type: "agent",
          runtime: "mock",
          prompt: "two",
          inputs: [],
          outputs: ["two"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/duplicate stage id: same/);
  });

  it("rejects duplicate artifact producers", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: [],
          outputs: ["result"],
        },
        {
          id: "two",
          type: "agent",
          runtime: "mock",
          prompt: "two",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /artifact result has multiple producers/,
    );
  });

  it("rejects duplicate artifact producers declared with metadata outputs", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: [],
          outputs: [{ id: "result", type: "summary" }],
        },
        {
          id: "two",
          type: "agent",
          runtime: "mock",
          prompt: "two",
          inputs: [],
          outputs: [{ id: "result", type: "summary" }],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /artifact result has multiple producers/,
    );
  });

  it("rejects unknown consumed artifacts", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: ["missing"],
          outputs: ["result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /stage one consumes unknown artifact: missing/,
    );
  });

  it("rejects unknown consumed artifacts when producers use metadata outputs", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: [],
          outputs: [{ id: "known", type: "summary" }],
        },
        {
          id: "two",
          type: "command",
          command: "true",
          inputs: ["missing"],
          outputs: ["report"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /stage two consumes unknown artifact: missing/,
    );
  });

  it("allows declared external input artifacts", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: ["spec"],
          outputs: ["result"],
        },
      ]),
    );

    const result = await loadFlow(path, { externalInputs: ["spec"] });

    expect(result.graph.order).toEqual(["one"]);
  });

  it("rejects cycles derived from artifact dependencies", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "one",
          type: "agent",
          runtime: "mock",
          prompt: "one",
          inputs: ["two-output"],
          outputs: ["one-output"],
        },
        {
          id: "two",
          type: "agent",
          runtime: "mock",
          prompt: "two",
          inputs: ["one-output"],
          outputs: ["two-output"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/flow contains a cycle/);
  });

  it("requires agent runtime, prompt, and outputs", async () => {
    await expect(
      loadFlow(join(fixtures, "invalid-flow.json")),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(FlowValidationError);
      const validationError = error as FlowValidationError;
      expect(validationError.errors.join("\n")).toMatch(/runtime/);
      expect(validationError.errors.join("\n")).toMatch(/prompt/);
      expect(validationError.errors.join("\n")).toMatch(/outputs/);
      return true;
    });
  });

  it("accepts an optional model on agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          model: "gpt-5.3-codex-spark",
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.model).toBe("gpt-5.3-codex-spark");
    }
  });

  it("accepts ordered runtime candidates on agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtimes: [
            { runtime: "claude" },
            { runtime: "codex", model: "gpt-5.3-codex-spark" },
          ],
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stageRuntimeCandidates(stage)).toEqual([
        { runtime: "claude" },
        { runtime: "codex", model: "gpt-5.3-codex-spark" },
      ]);
    }
  });

  it("accepts deterministic gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "verify",
          type: "gate",
          mode: "deterministic",
          command: "pnpm test",
          inputs: [],
          outputs: ["gate-result"],
          timeoutMs: 10_000,
          maxAttempts: 2,
        },
      ]),
    );

    const result = await loadFlow(path);

    expect(result.graph.order).toEqual(["verify"]);
    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "verify",
      type: "gate",
      mode: "deterministic",
      command: "pnpm test",
      outputs: ["gate-result"],
      timeoutMs: 10_000,
      maxAttempts: 2,
    });
  });

  it("accepts analysis gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "analyze",
          type: "gate",
          mode: "analysis",
          inputs: ["spec", "tasks"],
          outputs: ["analysis-report"],
          blocking: false,
        },
      ]),
    );

    const result = await loadFlow(path, { externalInputs: ["spec", "tasks"] });

    expect(result.graph.order).toEqual(["analyze"]);
    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "analyze",
      type: "gate",
      mode: "analysis",
      inputs: ["spec", "tasks"],
      outputs: ["analysis-report"],
      blocking: false,
    });
  });

  it("accepts timeoutMs on deterministic gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "verify",
          type: "gate",
          mode: "deterministic",
          command: "pnpm test",
          timeoutMs: 5_000,
          inputs: [],
          outputs: ["gate-result"],
        },
      ]),
    );

    const result = await loadFlow(path);

    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "verify",
      type: "gate",
      mode: "deterministic",
      timeoutMs: 5_000,
    });
  });

  it("accepts maxToolOutputTokens on command stages, deterministic gates, and flow spec", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "tool-output-budgeted" },
      spec: {
        maxToolOutputTokens: 400,
        stages: [
          {
            id: "build",
            type: "command",
            command: "pnpm build",
            maxToolOutputTokens: 100,
            inputs: [],
            outputs: ["build-log"],
          },
          {
            id: "verify",
            type: "gate",
            mode: "deterministic",
            command: "pnpm test",
            maxToolOutputTokens: 200,
            inputs: ["build-log"],
            outputs: ["gate-result"],
          },
        ],
      },
    });

    const result = await loadFlow(path);
    expect(result.flow.spec.maxToolOutputTokens).toBe(400);
    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "build",
      maxToolOutputTokens: 100,
    });
    expect(result.flow.spec.stages[1]).toMatchObject({
      id: "verify",
      maxToolOutputTokens: 200,
    });
  });

  it("rejects maxToolOutputTokens on agent stages", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "bad-tool-budget" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "do it",
            maxToolOutputTokens: 100,
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(loadFlow(path)).rejects.toThrow(/maxToolOutputTokens is only valid on command and deterministic gate stages/);
  });

  it("accepts review gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtime: "codex",
          model: "gpt-5.3-codex-spark",
          skills: ["tdd"],
          prompt: "Review the implementation.",
          inputs: [],
          outputs: ["review-result"],
        },
      ]),
    );

    const result = await loadFlow(path);

    expect(result.graph.order).toEqual(["review"]);
    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "review",
      type: "gate",
      mode: "review",
      runtime: "codex",
      model: "gpt-5.3-codex-spark",
      skills: ["tdd"],
      prompt: "Review the implementation.",
      outputs: ["review-result"],
    });
  });

  it("accepts ordered runtime candidates on review gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtimes: [
            { runtime: "claude" },
            { runtime: "codex", model: "gpt-5.3-codex-spark" },
          ],
          prompt: "Review the implementation.",
          inputs: [],
          outputs: ["review-result"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("gate");
    if (stage.type === "gate" && stage.mode === "review") {
      expect(stageRuntimeCandidates(stage)).toEqual([
        { runtime: "claude" },
        { runtime: "codex", model: "gpt-5.3-codex-spark" },
      ]);
    }
  });

  it("rejects stages that declare both runtime and runtimes", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          runtimes: [{ runtime: "claude" }],
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/runtime.*runtimes/);
  });

  it("rejects empty runtime candidate lists", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtimes: [],
          prompt: "Review the implementation.",
          inputs: [],
          outputs: ["review-result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/runtimes/);
  });

  it("rejects timeoutMs on review gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtime: "codex",
          prompt: "Review the implementation.",
          timeoutMs: 5_000,
          inputs: [],
          outputs: ["review-result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/timeoutMs/);
  });

  it.each([
    ["empty", []],
    ["omitted", undefined],
  ])("rejects review gate stages with %s outputs", async (_case, outputs) => {
    const stage: Record<string, unknown> = {
      id: "review",
      type: "gate",
      mode: "review",
      runtime: "codex",
      prompt: "Review the implementation.",
      inputs: [],
    };
    if (outputs !== undefined) {
      stage.outputs = outputs;
    }

    const path = await writeFlow(baseFlow([stage]));

    await expect(loadFlow(path)).rejects.toThrow(/outputs/);
  });

  it("accepts optional skills on agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          skills: ["tdd", "pr-checklist"],
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.skills).toEqual(["tdd", "pr-checklist"]);
    }
  });

  it("defaults agent skills to an empty list", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.skills).toEqual([]);
    }
  });

  it("rejects skills on non-agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "test",
          type: "command",
          command: "true",
          skills: ["tdd"],
          inputs: [],
          outputs: ["report"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/skills/);
  });

  it("strips unrelated unknown keys from non-agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "test",
          type: "command",
          command: "true",
          note: "previously tolerated",
          inputs: [],
          outputs: ["report"],
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("command");
    expect("note" in stage).toBe(false);
  });

  it("rejects duplicate skills on an agent stage", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          skills: ["tdd", "tdd"],
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /duplicate skill id on stage implement: tdd/,
    );
  });

  it("rejects an empty model on agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          model: "",
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/model/);
  });

  it("requires a command for command stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "test",
          type: "command",
          inputs: [],
          outputs: ["report"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/command/);
  });

  it("accepts sync-change stages with a merge strategy", async () => {
    const explicitPath = await writeFlow(
      baseFlow([
        {
          id: "sync",
          type: "sync-change",
          strategy: "merge",
          inputs: [],
          outputs: ["sync-report"],
        },
      ]),
    );
    const defaultPath = await writeFlow(
      baseFlow([
        {
          id: "sync",
          type: "sync-change",
          inputs: [],
          outputs: ["sync-report"],
        },
      ]),
    );

    await expect(loadFlow(explicitPath)).resolves.toMatchObject({
      flow: {
        spec: {
          stages: [
            {
              id: "sync",
              type: "sync-change",
              strategy: "merge",
              outputs: ["sync-report"],
            },
          ],
        },
      },
    });
    await expect(loadFlow(defaultPath)).resolves.toMatchObject({
      flow: {
        spec: {
          stages: [
            {
              id: "sync",
              type: "sync-change",
              strategy: "merge",
            },
          ],
        },
      },
    });
  });

  it("rejects sync-change strategies other than merge", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "sync",
          type: "sync-change",
          strategy: "rebase",
          inputs: [],
          outputs: ["sync-report"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/strategy/);
  });

  it("loads the conflict-resolution bootstrap flow", async () => {
    const result = await loadFlow("flows/resolve-conflicts-bootstrap.json", {
      externalInputs: ["spec", "tech-design"],
    });

    expect(result.flow.metadata.name).toBe("resolve-conflicts-bootstrap");
    expect(result.graph.order).toEqual([
      "sync",
      "resolve",
      "test",
      "review",
      "update",
      "reflect",
    ]);
    expect(result.flow.spec.stages.map((stage) => stage.type)).toEqual([
      "sync-change",
      "agent",
      "command",
      "gate",
      "update-change",
      "agent",
    ]);
  });

  it("uses blocking review gates in bootstrap flows that publish or update changes", async () => {
    const bootstrapFlowFiles = [
      "google-drive-connector-bootstrap.json",
      "implement-spec-bootstrap.json",
      "resolve-conflicts-bootstrap.json",
      "rework-pr-bootstrap.json",
    ];

    for (const file of bootstrapFlowFiles) {
      const result = await loadFlow(join("flows", file), {
        externalInputs: ["spec", "tech-design"],
      });
      const review = result.flow.spec.stages.find((stage) => stage.id === "review");

      expect(review, file).toMatchObject({
        type: "gate",
        mode: "review",
        outputs: ["review"],
      });
      expect(review, file).toMatchObject({
        prompt: expect.stringContaining("Review verdict: pass"),
      });
      expect(review, file).toMatchObject({
        prompt: expect.stringContaining("Review verdict: fail"),
      });
    }
  });

  it("ends bootstrap issue execution flows with reflection", async () => {
    const bootstrapFlowFiles = [
      "google-drive-connector-bootstrap.json",
      "implement-spec-bootstrap.json",
      "resolve-conflicts-bootstrap.json",
      "rework-pr-bootstrap.json",
    ];

    for (const file of bootstrapFlowFiles) {
      const result = await loadFlow(join("flows", file), {
        externalInputs: ["spec", "tech-design"],
      });
      const reflect = result.flow.spec.stages.at(-1);

      expect(reflect, file).toMatchObject({
        id: "reflect",
        type: "agent",
        outputs: ["reflection"],
      });
      expect(reflect, file).toMatchObject({
        inputs: expect.arrayContaining(["review", "change-request"]),
      });
      expect(reflect, file).toMatchObject({
        prompt: expect.stringContaining("Search existing GitHub issues"),
      });
      expect(reflect, file).toMatchObject({
        prompt: expect.stringContaining("Create GitHub issues only for actionable non-duplicate improvements"),
      });
      expect(reflect, file).toMatchObject({
        prompt: expect.stringContaining("clean result"),
      });
    }
  });

  it("does not pin model fields in bootstrap flow stages", async () => {
    const flowDirectory = "flows";
    const bootstrapFlowFiles = (await readdir(flowDirectory)).filter((file) =>
      file.endsWith("bootstrap.json"),
    );

    expect(bootstrapFlowFiles.length).toBeGreaterThan(0);
    expect(bootstrapFlowFiles).toEqual(expect.arrayContaining([
      "google-drive-connector-bootstrap.json",
      "implement-spec-bootstrap.json",
      "resolve-conflicts-bootstrap.json",
      "rework-pr-bootstrap.json",
    ]));

    for (const file of bootstrapFlowFiles) {
      const path = join(flowDirectory, file);
      await loadFlow(path, { externalInputs: ["spec", "tech-design"] });

      const rawFlow = JSON.parse(await readFile(path, "utf8")) as {
        spec: { stages: Array<{ id: string; type: string; model?: string }> };
      };

      for (const stage of rawFlow.spec.stages) {
        expect(stage, `${file}:${stage.id}`).not.toHaveProperty("model");
      }
    }
  });

  it("rejects unsupported publish-change providers during validation", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "publish",
          type: "publish-change",
          provider: "gitlab",
          inputs: [],
          outputs: ["change-request"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/provider/);
  });

  it("rejects path-like stage and artifact identifiers", async () => {
    const unsafeStagePath = await writeFlow(
      baseFlow([
        {
          id: "../../escape",
          type: "command",
          command: "true",
          inputs: [],
          outputs: ["report"],
        },
      ]),
    );
    await expect(loadFlow(unsafeStagePath)).rejects.toThrow(/id/);

    const unsafeArtifactPath = await writeFlow(
      baseFlow([
        {
          id: "test",
          type: "command",
          command: "true",
          inputs: ["../spec"],
          outputs: ["report"],
        },
      ]),
    );
    await expect(loadFlow(unsafeArtifactPath)).rejects.toThrow(/inputs/);
  });

  it("reports invalid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-flow-"));
    const path = join(directory, "flow.json");
    await writeFile(path, '{"apiVersion":', "utf8");

    await expect(loadFlow(path)).rejects.toThrow(/flow is not valid JSON/);
  });

  it("accepts maxInputTokens on agent stages and flow spec", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "budgeted" },
      spec: {
        maxInputTokens: 4000,
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "do it",
            maxInputTokens: 2000,
            inputs: [],
            outputs: ["impl"],
          },
        ],
      },
    });

    const result = await loadFlow(path);
    expect(result.flow.spec.maxInputTokens).toBe(4000);
    const stage = result.flow.spec.stages[0];
    expect("maxInputTokens" in stage && stage.maxInputTokens).toBe(2000);
  });

  it("rejects maxInputTokens on command stages", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "bad" },
      spec: {
        stages: [
          {
            id: "build",
            type: "command",
            command: "make",
            maxInputTokens: 1000,
            inputs: [],
            outputs: ["report"],
          },
        ],
      },
    });

    await expect(loadFlow(path)).rejects.toThrow(/maxInputTokens is only valid on agent and review gate stages/);
  });
});
