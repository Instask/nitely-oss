import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FlowValidationError, loadFlow } from "../../src/flow/load.js";
import { stageRuntimeCandidates } from "../../src/flow/schema.js";
import { inferExternalInputs } from "../../src/flows/validate.js";

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
  it("keeps the primary bootstrap flow model tiers explicit", async () => {
    const result = await loadFlow(
      join(
        import.meta.dirname,
        "..",
        "..",
        "flows",
        "implement-spec-bootstrap.json",
      ),
      { externalInputs: ["spec", "tech-design"] },
    );
    const stages = new Map(result.flow.spec.stages.map((stage) => [stage.id, stage]));

    expect(stages.get("write-tests")).toMatchObject({
      runtime: "codex",
      model: "gpt-5.3-codex-spark",
    });
    expect(stages.get("implement")).toMatchObject({
      runtime: "codex",
      model: "gpt-5.3-codex",
    });
    expect(stages.get("review")).toMatchObject({
      runtime: "codex",
      model: "gpt-5",
    });
  });

  it("loads static size-tier flows with distinct topologies", async () => {
    const tiers = [
      {
        file: "flows/implement-small.json",
        name: "implement-small",
        stages: ["implement", "test", "publish"],
      },
      {
        file: "flows/implement-medium.json",
        name: "implement-medium",
        stages: ["implement", "test", "review", "publish"],
      },
    ];

    for (const tier of tiers) {
      const result = await loadFlow(tier.file, {
        externalInputs: ["spec", "tech-design"],
      });

      expect(result.flow.metadata.name).toBe(tier.name);
      expect(result.graph.order).toEqual(tier.stages);
    }
  });

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

  it("accepts task-plan stage loop configuration", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "plan",
          type: "agent",
          runtime: "mock",
          prompt: "Plan.",
          inputs: [],
          outputs: [{ id: "task-plan", mediaType: "application/json" }],
        },
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement.",
          inputs: ["task-plan"],
          outputs: ["implementation"],
          taskPlan: {
            input: "task-plan",
            role: "execute-current",
            max_iterations: 4,
            maxTasks: 12,
            max_tasks: 12,
          },
        },
      ]),
    );

    const result = await loadFlow(path);

    expect(result.graph.order).toEqual(["plan", "implement"]);
    expect(result.flow.spec.stages[1]).toMatchObject({
      taskPlan: {
        input: "task-plan",
        role: "execute-current",
        max_iterations: 4,
        maxTasks: 12,
        max_tasks: 12,
      },
    });
  });

  it("rejects conflicting task-plan task-limit aliases", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "plan",
          type: "agent",
          runtime: "mock",
          prompt: "Plan.",
          inputs: [],
          outputs: [{ id: "task-plan", mediaType: "application/json" }],
        },
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement.",
          inputs: ["task-plan"],
          outputs: ["implementation"],
          taskPlan: {
            input: "task-plan",
            role: "execute-current",
            maxTasks: 12,
            max_tasks: 13,
          },
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /maxTasks and max_tasks must match when both are set/,
    );
  });

  it("rejects task-plan loop config when its input is not a declared stage input", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement.",
          inputs: [],
          outputs: ["implementation"],
          taskPlan: {
            input: "task-plan",
            role: "execute-current",
          },
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(
      /stage implement taskPlan input must be declared in inputs: task-plan/,
    );
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

  it("accepts flow and stage hooks with failure policy defaults", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "hooked-flow" },
      spec: {
        hooks: {
          preRun: [{ id: "flow-pre", command: "true" }],
          postRun: [
            {
              id: "flow-post",
              command: "true",
              onFailure: "evidence-only",
            },
          ],
        },
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["report"],
            hooks: {
              pre: [{ id: "stage-pre", command: "true", onFailure: "warn" }],
              post: [
                {
                  id: "stage-post",
                  command: "true",
                  timeoutMs: 1000,
                  maxToolOutputTokens: 64,
                },
              ],
            },
          },
        ],
      },
    });

    const result = await loadFlow(path);
    const [stage] = result.flow.spec.stages;

    expect(result.flow.spec.hooks?.preRun[0]).toMatchObject({
      id: "flow-pre",
      command: "true",
      onFailure: "block",
    });
    expect(result.flow.spec.hooks?.postRun[0]).toMatchObject({
      id: "flow-post",
      onFailure: "evidence-only",
    });
    expect(stage.hooks?.pre[0]).toMatchObject({
      id: "stage-pre",
      onFailure: "warn",
    });
    expect(stage.hooks?.post[0]).toMatchObject({
      id: "stage-post",
      onFailure: "block",
      timeoutMs: 1000,
      maxToolOutputTokens: 64,
    });
  });

  it("treats metadata inputs as declared external input artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-flow-"));
    const path = join(directory, "flow.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: { name: "metadata-input-flow", inputs: [{ id: "intake" }] },
          spec: {
            stages: [
              {
                id: "draft-spec",
                type: "agent",
                runtime: "mock",
                prompt: "Draft spec.",
                inputs: ["intake"],
                outputs: ["spec"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await loadFlow(path);

    expect(result.graph.order).toEqual(["draft-spec"]);
  });

  it("accepts source URLs and artifact URIs on external input contracts", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "cross-flow-inputs",
        inputs: [
          {
            id: "discovery-spec",
            type: "spec",
            sourceUrl: "https://example.test/spec.md",
          },
          {
            id: "review-evidence",
            artifactUri: "nitely-artifact://run-123/review",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Use prior artifacts.",
            inputs: ["discovery-spec", "review-evidence"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const result = await loadFlow(path);

    expect(result.graph.order).toEqual(["implement"]);
    expect(result.graph.producerByArtifact.has("discovery-spec")).toBe(false);
    expect(result.flow.metadata.inputs).toEqual([
      expect.objectContaining({
        id: "discovery-spec",
        sourceUrl: "https://example.test/spec.md",
      }),
      expect.objectContaining({
        id: "review-evidence",
        artifactUri: "nitely-artifact://run-123/review",
      }),
    ]);
  });

  it("rejects external input contracts with multiple default sources", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "ambiguous-input",
        inputs: [
          {
            id: "spec",
            sourceUrl: "https://example.test/spec.md",
            artifactUri: "nitely-artifact://run-123/spec",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "true",
            inputs: ["spec"],
            outputs: ["test-report"],
          },
        ],
      },
    });

    await expect(loadFlow(path)).rejects.toThrow(/only one of source/);
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

  it("accepts capability policy on agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["result"],
          capabilities: {
            read: { scope: "approved artifacts", allow: ["docs/"] },
            write: { scope: "worktree", allow: ["src/", "test/"] },
            commands: { mode: "allow-list", allow: ["pnpm test"] },
            network: { mode: "restricted" },
            allowedRuntimes: ["codex"],
            allowedModels: ["gpt-5.3-codex-spark"],
            instructions: { repo: true, generated: false, skills: true },
            evidence: { prompts: true, toolCalls: true, fileChanges: true },
          },
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.capabilities).toMatchObject({
        read: { scope: "approved artifacts", allow: ["docs/"] },
        write: { scope: "worktree", allow: ["src/", "test/"] },
        commands: { mode: "allow-list", allow: ["pnpm test"] },
        network: { mode: "restricted" },
        allowedRuntimes: ["codex"],
        allowedModels: ["gpt-5.3-codex-spark"],
        instructions: { repo: true, generated: false, skills: true },
        evidence: {
          prompts: true,
          toolCalls: true,
          fileChanges: true,
          runtimeUsage: true,
        },
      });
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

  it("accepts flow and stage timeout controls", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "timeout-controls" },
      spec: {
        timeouts: { sessionMs: 300_000, turnMs: 120_000, gateMs: 600_000 },
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            timeouts: { sessionMs: 120_000, stallMs: 30_000 },
            inputs: [],
            outputs: ["implementation"],
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm test",
            timeouts: { commandMs: 600_000 },
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the change.",
            timeouts: { sessionMs: 90_000, busyIdleMs: 45_000 },
            inputs: ["test-report"],
            outputs: ["review-result"],
          },
          {
            id: "approve",
            type: "approval",
            prompt: "Approve publish.",
            timeouts: { pauseMs: 86_400_000 },
            inputs: ["review-result"],
            outputs: [],
          },
        ],
      },
    });

    const result = await loadFlow(path);

    expect(result.flow.spec.timeouts).toMatchObject({
      sessionMs: 300_000,
      turnMs: 120_000,
      gateMs: 600_000,
    });
    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "implement",
      timeouts: { sessionMs: 120_000, stallMs: 30_000 },
    });
    expect(result.flow.spec.stages[1]).toMatchObject({
      id: "verify",
      timeouts: { commandMs: 600_000 },
    });
    expect(result.flow.spec.stages[2]).toMatchObject({
      id: "review",
      timeouts: { sessionMs: 90_000, busyIdleMs: 45_000 },
    });
    expect(result.flow.spec.stages[3]).toMatchObject({
      id: "approve",
      timeouts: { pauseMs: 86_400_000 },
    });
  });

  it("rejects a flow that still declares spec.budgets", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "declared-run-budgets" },
      spec: {
        budgets: { maxRuntimeTokens: 50_000 },
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(loadFlow(path)).rejects.toThrow(
      /spec\.budgets.*NITELY_DEFAULT_MAX_RUNTIME_TOKENS/,
    );
  });

  it("rejects a stage that still declares budgets", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "declared-stage-budgets" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the change.",
            budgets: { maxRuntimeTokens: 20_000 },
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    await expect(loadFlow(path)).rejects.toThrow(
      /spec\.stages\.0\.budgets.*NITELY_DEFAULT_MAX_RUNTIME_TOKENS/,
    );
  });

  it("accepts verification budgets and provider-independent stage cost classes", async () => {
    const path = await writeFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "verification-budget" },
      spec: {
        verificationBudget: {
          maxAgentAttempts: 6,
          maxJudgeAttempts: 3,
          maxCiRuns: 2,
          maxRuntimeCostUsd: 10,
        },
        stages: [
          {
            id: "implement",
            type: "agent",
            costClass: "moderate",
            runtime: "codex",
            prompt: "Implement the change.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const result = await loadFlow(path);

    expect(result.flow.spec.verificationBudget).toEqual({
      maxAgentAttempts: 6,
      maxJudgeAttempts: 3,
      maxCiRuns: 2,
      maxRuntimeCostUsd: 10,
    });
    expect(result.flow.spec.stages[0]?.costClass).toBe("moderate");
  });

  it("loads every bundled flow and none declare budgets", async () => {
    const flowDirectory = join(import.meta.dirname, "..", "..", "flows");
    const files = (await readdir(flowDirectory)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const path = join(flowDirectory, file);
      const content = await readFile(path, "utf8");
      const raw = JSON.parse(content) as {
        spec?: { budgets?: unknown; stages?: Array<{ id?: string; budgets?: unknown }> };
      };
      expect(raw.spec?.budgets, file).toBeUndefined();
      for (const stage of raw.spec?.stages ?? []) {
        expect(stage.budgets, `${file}:${stage.id ?? "?"}`).toBeUndefined();
      }
      await expect(
        loadFlow(path, { externalInputs: inferExternalInputs(content) }),
        file,
      ).resolves.toMatchObject({
        flow: { metadata: { name: expect.any(String) } },
      });
    }
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

  it("accepts capability policy on review gate stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtime: "codex",
          prompt: "Review the implementation.",
          inputs: [],
          outputs: ["review-result"],
          capabilities: {
            read: { scope: "review artifacts" },
            write: { scope: "none" },
            commands: { mode: "none" },
            network: { mode: "disabled", advisory: false },
            allowedRuntimes: ["codex"],
          },
        },
      ]),
    );

    const result = await loadFlow(path);
    const stage = result.flow.spec.stages[0];
    expect(stage.type).toBe("gate");
    if (stage.type === "gate" && stage.mode === "review") {
      expect(stage.capabilities).toMatchObject({
        read: { scope: "review artifacts" },
        write: { scope: "none" },
        commands: { mode: "none" },
        network: { mode: "disabled", advisory: false },
        allowedRuntimes: ["codex"],
      });
    }
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

  it("rejects capability policy on non-agent stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "test",
          type: "command",
          command: "true",
          capabilities: { commands: { mode: "none" } },
          inputs: [],
          outputs: ["report"],
        },
      ]),
    );

    await expect(loadFlow(path)).rejects.toThrow(/capabilities/);
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

  it("loads the plan-approve-implement bootstrap flow with spec and tech-design approval gates", async () => {
    const result = await loadFlow("flows/plan-approve-implement-bootstrap.json", {
      externalInputs: ["intake"],
    });

    expect(result.flow.metadata.name).toBe("plan-approve-implement-bootstrap");
    expect(result.graph.order).toEqual([
      "draft-spec",
      "approve-spec",
      "draft-tech-design",
      "approve-tech-design",
      "write-tests",
      "implement",
      "test",
      "review",
      "publish",
      "reflect",
    ]);
    expect(result.flow.spec.stages.map((stage) => [stage.id, stage.type])).toEqual([
      ["draft-spec", "agent"],
      ["approve-spec", "approval"],
      ["draft-tech-design", "agent"],
      ["approve-tech-design", "approval"],
      ["write-tests", "agent"],
      ["implement", "agent"],
      ["test", "command"],
      ["review", "gate"],
      ["publish", "publish-change"],
      ["reflect", "agent"],
    ]);
  });

  it("loads runtime-variant implement-spec bootstrap flows with expected agent runtimes", async () => {
    // Keep all runtime-specific implement-spec bootstrap variants in one place
    // so Codex remains the default while Grok/Pi variants share one regression check.
    const runtimeVariants: Array<{
      file: string;
      name: string;
      runtime: "glm" | "grok" | "pi";
    }> = [
      {
        file: "flows/implement-spec-bootstrap-grok.json",
        name: "implement-spec-bootstrap-grok",
        runtime: "grok",
      },
      {
        file: "flows/implement-spec-bootstrap-pi.json",
        name: "implement-spec-bootstrap-pi",
        runtime: "pi",
      },
    ];

    for (const variant of runtimeVariants) {
      const result = await loadFlow(variant.file, {
        externalInputs: ["spec", "tech-design"],
      });

      expect(result.flow.metadata.name).toBe(variant.name);
      expect(result.graph.order).toEqual([
        "write-tests",
        "implement",
        "test",
        "review",
        "publish",
      ]);

      for (const stage of result.flow.spec.stages) {
        if (stage.type === "agent") {
          expect(stage, `${variant.file}:${stage.id}`).toMatchObject({
            runtime: variant.runtime,
          });
          expect(stage, `${variant.file}:${stage.id}`).not.toHaveProperty("model");
        } else {
          expect(stage, `${variant.file}:${stage.id}`).not.toHaveProperty("runtime");
          expect(stage, `${variant.file}:${stage.id}`).not.toHaveProperty("model");
        }
      }
    }
  });

  it("loads the claude implement-spec bootstrap variant with the full codex-baseline shape", async () => {
    // The Claude variant tracks the Codex baseline instead of the trimmed
    // Grok/Pi variants: Claude Code can render a review verdict and file
    // reflection follow-ups, so it keeps the blocking gate and the reflect
    // stage rather than degrading to plain agent stages.
    const result = await loadFlow("flows/implement-spec-bootstrap-claude.json", {
      externalInputs: ["spec", "tech-design"],
    });

    expect(result.flow.metadata.name).toBe("implement-spec-bootstrap-claude");
    expect(result.flow.spec.stages.map((stage) => [stage.id, stage.type])).toEqual([
      ["write-tests", "agent"],
      ["implement", "agent"],
      ["test", "command"],
      ["review", "gate"],
      ["publish", "publish-change"],
      ["reflect", "agent"],
    ]);

    for (const stage of result.flow.spec.stages) {
      const carriesRuntime =
        stage.type === "agent" || (stage.type === "gate" && stage.mode === "review");
      if (carriesRuntime) {
        expect(stage, stage.id).toMatchObject({ runtime: "claude" });
      } else {
        expect(stage, stage.id).not.toHaveProperty("runtime");
      }
      expect(stage, stage.id).not.toHaveProperty("model");
    }
  });

  it("orders write-tests before implement in every spec-driven bootstrap flow", async () => {
    // TDD lives in the graph, not in a prompt sentence: implement cannot start
    // before the tests artifact exists, and the command gate stays the green bar.
    const specDrivenFlows: Array<{ file: string; externalInputs: string[] }> = [
      {
        file: "flows/implement-spec-bootstrap.json",
        externalInputs: ["spec", "tech-design"],
      },
      {
        file: "flows/implement-spec-bootstrap-claude.json",
        externalInputs: ["spec", "tech-design"],
      },
      {
        file: "flows/implement-spec-bootstrap-grok.json",
        externalInputs: ["spec", "tech-design"],
      },
      {
        file: "flows/implement-spec-bootstrap-pi.json",
        externalInputs: ["spec", "tech-design"],
      },
      {
        file: "flows/plan-approve-implement-bootstrap.json",
        externalInputs: ["intake"],
      },
    ];

    for (const { file, externalInputs } of specDrivenFlows) {
      const result = await loadFlow(file, { externalInputs });
      const stages = new Map(
        result.flow.spec.stages.map((stage) => [stage.id, stage]),
      );

      const writeTests = stages.get("write-tests");
      expect(writeTests, file).toMatchObject({
        type: "agent",
        inputs: ["spec", "tech-design"],
        outputs: ["tests"],
        capabilities: {
          write: { scope: "worktree", allow: ["test/"] },
          commands: { mode: "none" },
        },
      });

      const implement = stages.get("implement");
      expect(implement?.inputs, file).toContain("tests");
      expect(implement, file).toMatchObject({
        capabilities: {
          write: { scope: "worktree" },
          commands: { mode: "unrestricted" },
        },
      });
      expect(
        implement?.type === "agent" ? implement.context?.fullReadInputs : undefined,
        file,
      ).toContain("tests");
      expect(implement, file).toMatchObject({
        prompt: expect.stringContaining("write-tests"),
      });

      const order = result.graph.order;
      expect(order.indexOf("write-tests"), file).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("write-tests"), file).toBeLessThan(
        order.indexOf("implement"),
      );
      expect(order.indexOf("implement"), file).toBeLessThan(order.indexOf("test"));
      expect(order.indexOf("test"), file).toBeLessThan(order.indexOf("review"));

      expect(stages.get("test"), file).toMatchObject({ type: "command" });
      expect(stages.get("review")?.inputs, file).toContain("tests");

      for (const stage of result.flow.spec.stages) {
        if (
          stage.type === "agent" ||
          (stage.type === "gate" && stage.mode === "review")
        ) {
          expect(stage.capabilities, `${file}:${stage.id}`).toBeDefined();
        }
      }

      if (file.includes("plan-approve")) {
        for (const id of ["draft-spec", "draft-tech-design", "review", "reflect"]) {
          expect(stages.get(id), `${file}:${id}`).toMatchObject({
            capabilities: {
              write: { scope: "none" },
              commands: { mode: "none" },
            },
          });
        }
      }
    }
  });

  it("uses blocking review gates in bootstrap flows that publish or update changes", async () => {
    const bootstrapFlowFiles = [
      "google-drive-connector-bootstrap.json",
      "implement-spec-bootstrap-claude.json",
      "implement-spec-bootstrap.json",
      "resolve-conflicts-bootstrap.json",
      "rework-pr-bootstrap.json",
      "rework-spec-bootstrap.json",
      "rework-tech-design-bootstrap.json",
      "rework-workflow-bootstrap.json",
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

  it("declares external inputs on route-specific rework flows", async () => {
    const routeReworkFlowFiles = [
      "rework-spec-bootstrap.json",
      "rework-tech-design-bootstrap.json",
      "rework-workflow-bootstrap.json",
    ];

    for (const file of routeReworkFlowFiles) {
      const result = await loadFlow(join("flows", file));

      expect(result.flow.metadata.inputs?.map((input) => input.id), file).toEqual([
        "spec",
        "tech-design",
      ]);
    }
  });

  it("ends bootstrap issue execution flows with reflection", async () => {
    const bootstrapFlowFiles = [
      "google-drive-connector-bootstrap.json",
      "implement-spec-bootstrap-claude.json",
      "implement-spec-bootstrap.json",
      "resolve-conflicts-bootstrap.json",
      "rework-pr-bootstrap.json",
      "rework-spec-bootstrap.json",
      "rework-tech-design-bootstrap.json",
      "rework-workflow-bootstrap.json",
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

  it("pins model fields only for the primary bootstrap flow tiers", async () => {
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
      "rework-spec-bootstrap.json",
      "rework-tech-design-bootstrap.json",
      "rework-workflow-bootstrap.json",
    ]));

    const primaryModels = {
      "write-tests": "gpt-5.3-codex-spark",
      implement: "gpt-5.3-codex",
      review: "gpt-5",
    };

    for (const file of bootstrapFlowFiles) {
      const path = join(flowDirectory, file);
      await loadFlow(path, { externalInputs: ["spec", "tech-design"] });

      const rawFlow = JSON.parse(await readFile(path, "utf8")) as {
        spec: { stages: Array<{ id: string; type: string; model?: string }> };
      };

      for (const stage of rawFlow.spec.stages) {
        if (file === "implement-spec-bootstrap.json" && stage.id in primaryModels) {
          expect(stage.model, `${file}:${stage.id}`).toBe(
            primaryModels[stage.id as keyof typeof primaryModels],
          );
        } else {
          expect(stage, `${file}:${stage.id}`).not.toHaveProperty("model");
        }
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

  it("accepts conformance policy on publish and update change stages", async () => {
    const path = await writeFlow(
      baseFlow([
        {
          id: "publish",
          type: "publish-change",
          provider: "github",
          inputs: ["implementation", "conformance-report"],
          outputs: ["change-request"],
          conformance: {
            mode: "strict",
            required: ["FR-001", "SC-001"],
          },
        },
        {
          id: "update",
          type: "update-change",
          provider: "github",
          inputs: ["change-request"],
          outputs: ["updated-change-request"],
          conformance: {
            mode: "advisory",
            report: "coverage",
          },
        },
      ]),
    );

    const result = await loadFlow(path, {
      externalInputs: ["implementation", "conformance-report"],
    });

    expect(result.flow.spec.stages[0]).toMatchObject({
      id: "publish",
      conformance: {
        mode: "strict",
        report: "conformance-report",
        required: ["FR-001", "SC-001"],
      },
    });
    expect(result.flow.spec.stages[1]).toMatchObject({
      id: "update",
      conformance: {
        mode: "advisory",
        report: "coverage",
        required: [],
      },
    });
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
