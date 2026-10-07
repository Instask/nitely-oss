import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateRunPreflight,
  evaluateWorkItemRunPreflight,
} from "../../src/run/preflight.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import type {
  ProviderConnectionStore,
  ProviderId,
  ProviderConnectionStatus,
} from "../../src/providers/types.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

function providerStore(
  configured: Partial<Record<ProviderId, boolean>>,
): ProviderConnectionStore {
  const providerIds: ProviderId[] = [
    "github",
    "codex",
    "anthropic",
    "glm",
    "grok",
    "openrouter",
    "pi",
    "together",
    "google-drive",
  ];
  return {
    getConnection: async () => {
      throw new Error("unused");
    },
    resolveEnv: async () => ({}),
    listStatuses: async (): Promise<ProviderConnectionStatus[]> =>
      providerIds.map((id) => ({
        id,
        name: id,
        configured: configured[id] ?? false,
        message: configured[id] ? "configured" : `missing ${id}`,
        hints: [`configure ${id}`],
        reconnectRequired: false,
        authMethods: [],
      })),
  };
}

function flow(stage: Record<string, unknown> = {}) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "preflight", inputs: [{ id: "spec" }] },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          prompt: "Implement.",
          inputs: ["spec"],
          outputs: ["implementation"],
          ...stage,
        },
      ],
    },
  };
}

function flowWithPublish(provider?: "github" | "github-cli") {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "preflight", inputs: [{ id: "spec" }] },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          prompt: "Implement.",
          inputs: ["spec"],
          outputs: ["implementation"],
        },
        {
          id: "publish",
          type: "publish-change",
          inputs: ["implementation"],
          ...(provider ? { provider } : {}),
        },
      ],
    },
  };
}

async function repoWithFlow(document: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-preflight-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/preflight.json"),
    JSON.stringify(document, null, 2),
    "utf8",
  );
  await writeFile(join(repo, "spec.md"), "Spec body", "utf8");
  return repo;
}

describe("run preflight doctor", () => {
  it("passes for a valid flow with configured runtime and present inputs", async () => {
    const repoPath = await repoWithFlow(flow());

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ codex: true }),
    });

    expect(report).toMatchObject({
      status: "PASS",
      summary: "run preflight passed",
      flowName: "preflight",
      stageCount: 1,
      requiredInputs: ["spec"],
      requiredProviders: ["codex"],
      issues: [],
    });
  });

  it("blocks when a declared flow input is missing", async () => {
    const repoPath = await repoWithFlow(flow());

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {},
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "blocking",
          code: "missing-input",
          inputId: "spec",
        }),
      ]),
    );
  });

  it("does not block when a declared flow input has a default source", async () => {
    const repoPath = await repoWithFlow({
      ...flow(),
      metadata: {
        name: "preflight",
        inputs: [
          {
            id: "spec",
            source: { connector: "local-file", uri: "spec.md" },
          },
        ],
      },
    });

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {},
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("PASS");
    expect(report.requiredInputs).toEqual(["spec"]);
    expect(report.issues).toEqual([]);
  });

  it("blocks local-file inputs that the connector cannot resolve", async () => {
    const repoPath = await repoWithFlow(flow());
    const outside = await mkdtemp(join(tmpdir(), "nitely-preflight-outside-"));
    const outsideSpec = join(outside, "spec.md");
    await writeFile(outsideSpec, "Outside spec", "utf8");

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: outsideSpec },
      },
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "input-unreadable",
          inputId: "spec",
          path: outsideSpec,
        }),
      ]),
    );
  });

  it("blocks invalid flow DAGs before runtime execution", async () => {
    // An unproduced stage input is an external input, so make the DAG invalid
    // with two producers of the same artifact instead.
    const repoPath = await repoWithFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "preflight" },
      spec: {
        stages: [
          { id: "a", type: "command", command: "true", inputs: [], outputs: ["out"] },
          { id: "b", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    });

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {},
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues[0]).toMatchObject({
      severity: "blocking",
      code: "flow-invalid",
    });
    expect(report.issues[0]?.message).toMatch(/out/);
  });

  it("reports an unproduced stage input as a missing input, not an invalid flow", async () => {
    const repoPath = await repoWithFlow(
      flow({ inputs: ["unknown-artifact"] }),
    );

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {},
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues.map((entry) => entry.code)).not.toContain("flow-invalid");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-input", message: "required input is missing: unknown-artifact" }),
    ]));
  });

  it("blocks missing mapped MCP/provider requirements", async () => {
    const repoPath = await repoWithFlow(
      flow({
        required_mcp_servers: ["github", "private-mcp"],
      }),
    );

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-provider",
          providerId: "github",
          stageId: "implement",
        }),
        expect.objectContaining({
          code: "unknown-mcp-server",
          mcpServer: "private-mcp",
          stageId: "implement",
        }),
      ]),
    );
  });

  it("blocks unavailable runtime candidates", async () => {
    const repoPath = await repoWithFlow(flow());

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ codex: false }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "runtime-unavailable",
          providerId: "codex",
          stageId: "implement",
        }),
      ]),
    );
  });

  it("names every credential file it read when a runtime has no provider", async () => {
    const repoPath = await repoWithFlow(flow({ runtime: "claude" }));
    const ownerPath = join(repoPath, ".nitely", "users", "usr_1", "connections.json");
    const repositoryPath = join(repoPath, ".nitely", "connections.json");
    const store = new FileProviderConnectionStore({
      path: ownerPath,
      fallbackPaths: [repositoryPath],
      env: {},
      commandStatus: async () => false,
    });

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: { spec: { connector: "local-file", uri: "spec.md" } },
      providerStore: store,
    });

    const issue = report.issues.find((candidate) => candidate.code === "runtime-unavailable");
    expect(issue?.remediation).toBe(
      `Configure one of the stage runtime providers before starting a run. Credentials are read from ${ownerPath} then ${repositoryPath}.`,
    );
  });

  it("maps OpenRouter stages to the openrouter provider and checks the model", async () => {
    const inputs = { spec: { connector: "local-file" as const, uri: "spec.md" } };
    const evaluate = async (stage: Record<string, unknown>, configured: Partial<Record<ProviderId, boolean>>) =>
      await evaluateRunPreflight({
        repoPath: await repoWithFlow(flow(stage)),
        flowPath: "flows/preflight.json",
        inputs,
        providerStore: providerStore(configured),
      });

    const ready = await evaluate({ runtime: "openrouter", model: "qwen/qwen3-coder-next" }, { openrouter: true });
    expect(ready.status).toBe("PASS");
    expect(ready.requiredProviders).toEqual(["openrouter"]);

    const unconfigured = await evaluate({ runtime: "openrouter", model: "qwen/qwen3-coder-next" }, { openrouter: false });
    expect(unconfigured.status).toBe("BLOCK");
    expect(unconfigured.issues).toEqual([
      expect.objectContaining({ code: "runtime-unavailable", providerId: "openrouter" }),
    ]);

    const withoutModel = await evaluate({ runtime: "openrouter" }, { openrouter: true });
    expect(withoutModel.status).toBe("BLOCK");
    expect(withoutModel.issues).toEqual([
      expect.objectContaining({
        severity: "blocking",
        code: "runtime-model-unsupported",
        stageId: "implement",
        runtime: "openrouter",
        message: expect.stringMatching(/runtime openrouter requires a model/),
      }),
    ]);

    const fallback = await evaluate(
      { runtime: undefined, runtimes: [{ runtime: "openrouter", model: "qwen3-coder" }, { runtime: "codex" }] },
      { openrouter: true, codex: true },
    );
    expect(fallback.status).toBe("WARN");
    expect(fallback.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "runtime-model-unsupported",
        message: expect.stringMatching(/cannot use model "qwen3-coder"/),
      }),
    ]);
  });

  it("maps Grok Build and Pi runtime candidates to provider checks", async () => {
    const repoPath = await repoWithFlow(
      flow({
        runtime: undefined,
        runtimes: [
          { runtime: "grok", model: "grok-4.5" },
          { runtime: "pi", model: "openai/gpt-4o" },
        ],
      }),
    );

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ grok: true, pi: false }),
    });

    expect(report.status).toBe("PASS");
    expect(report.requiredProviders).toEqual(["grok", "pi"]);
    expect(report.issues).toEqual([]);
  });

  it("maps Together AI stages to the together provider and checks the model", async () => {
    const inputs = { spec: { connector: "local-file" as const, uri: "spec.md" } };
    const configured = await evaluateRunPreflight({
      repoPath: await repoWithFlow(flow({ runtime: "together", model: "moonshotai/Kimi-K3" })),
      flowPath: "flows/preflight.json",
      inputs,
      providerStore: providerStore({ together: true }),
    });
    expect(configured.status).toBe("PASS");
    expect(configured.requiredProviders).toEqual(["together"]);

    const unconfigured = await evaluateRunPreflight({
      repoPath: await repoWithFlow(flow({ runtime: "together", model: "moonshotai/Kimi-K3" })),
      flowPath: "flows/preflight.json",
      inputs,
      providerStore: providerStore({ together: false }),
    });
    expect(unconfigured.status).toBe("BLOCK");
    expect(unconfigured.issues).toEqual([
      expect.objectContaining({ code: "runtime-unavailable", providerId: "together" }),
    ]);

    const withoutModel = await evaluateRunPreflight({
      repoPath: await repoWithFlow(flow({ runtime: "together" })),
      flowPath: "flows/preflight.json",
      inputs,
      providerStore: providerStore({ together: true }),
    });
    expect(withoutModel.status).toBe("BLOCK");
    expect(withoutModel.issues).toEqual([
      expect.objectContaining({
        severity: "blocking",
        code: "runtime-model-unsupported",
        stageId: "implement",
        runtime: "together",
        message: expect.stringMatching(/requires a Together AI model id/),
      }),
    ]);

    const fallback = await evaluateRunPreflight({
      repoPath: await repoWithFlow(
        flow({
          runtime: undefined,
          runtimes: [{ runtime: "together", model: "kimi-k3" }, { runtime: "codex" }],
        }),
      ),
      flowPath: "flows/preflight.json",
      inputs,
      providerStore: providerStore({ together: true, codex: true }),
    });
    expect(fallback.status).toBe("WARN");
    expect(fallback.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "runtime-model-unsupported",
        message: expect.stringMatching(/does not support model "kimi-k3"/),
      }),
    ]);
  });

  it("blocks publish-change stages when the GitHub provider is unavailable", async () => {
    const repoPath = await repoWithFlow(flowWithPublish("github"));

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ codex: true, github: false }),
    });

    expect(report.status).toBe("BLOCK");
    expect(report.requiredProviders).toEqual(["codex", "github"]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-provider",
          providerId: "github",
          stageId: "publish",
        }),
      ]),
    );
  });

  it("warns instead of blocking for GitHub CLI publish providers", async () => {
    const repoPath = await repoWithFlow(flowWithPublish("github-cli"));

    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("WARN");
    expect(report.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "provider-unchecked",
        stageId: "publish",
      }),
    ]);
  });

  it("evaluates generic work items without starting a run", async () => {
    const repoPath = await repoWithFlow(flow());
    const workItem: WorkItemRecord = {
      id: "wi-1",
      title: "Work item",
      status: "ready",
      workItemType: "dev.pr",
      flowPath: "flows/preflight.json",
      inputs: {
        spec: { connector: "local-file", uri: "spec.md" },
      },
      priority: "P2",
      dependsOn: [],
      suggestedDependencies: [],
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };

    const report = await evaluateWorkItemRunPreflight({
      repoPath,
      workItem,
      providerStore: providerStore({ codex: true }),
    });

    expect(report.status).toBe("PASS");
  });
});

it("checks repository command configuration before task admission", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-preflight-command-"));
  const document = flow({ runtime: "mock" });
  const flowDocument = JSON.stringify({ ...document, metadata: { ...document.metadata,
    configurables: [{ key: "verifyCommand", label: "Verify", type: "text", required: true }] } });
  const input = { repoPath, flowPath: "fixture.json", flowDocument, inputs: { spec: { connector: "local-file" as const, uri: "spec.md" } } };
  await writeFile(join(repoPath, "spec.md"), "Spec");
  expect((await evaluateRunPreflight(input)).issues).toContainEqual(expect.objectContaining({ code: "flow-invalid", message: "missing required configurable: verifyCommand" }));
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(join(repoPath, ".nitely/instructions.json"), JSON.stringify({ configuration: { verifyCommand: "go test ./..." } }));
  expect((await evaluateRunPreflight(input)).issues.filter((issue) => issue.code === "flow-invalid")).toEqual([]);
});

it("blocks OCI doctor preflight on an unset image", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-preflight-oci-"));
  const report = await evaluateRunPreflight({
    repoPath, flowPath: "fixture.json", flowDocument: JSON.stringify(flow()),
    executionBackend: "oci", env: {}, providerStore: providerStore({ codex: true }),
  });
  expect(report.status).toBe("BLOCK");
  expect(report.issues).toContainEqual(expect.objectContaining({ severity: "blocking", code: "oci.image.missing" }));
});

describe("preflight external inputs", () => {
  const doc = (stages: unknown[], inputs?: unknown[]) => JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "ext", ...(inputs ? { inputs } : {}) },
    spec: { stages },
  });

  it("parses with the Flow's own external inputs, independent of supplied inputs", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-preflight-ext-"));
    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/ext.json",
      flowDocument: doc(
        [{ id: "build", type: "command", command: "true", inputs: ["spec", "tech-design"], outputs: ["out"] }],
        [{ id: "spec" }],
      ),
      inputs: {},
    });
    const codes = report.issues.map((entry) => entry.code);
    expect(codes).not.toContain("flow-invalid");
    expect(report.issues.filter((entry) => entry.code === "missing-input").map((entry) => entry.message).sort())
      .toEqual(["required input is missing: spec", "required input is missing: tech-design"]);
  });

  it("still reports a genuinely invalid graph as flow-invalid", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-preflight-ext-"));
    const report = await evaluateRunPreflight({
      repoPath,
      flowPath: "flows/ext.json",
      flowDocument: doc([
        { id: "a", type: "command", command: "true", inputs: [], outputs: ["out"] },
        { id: "b", type: "command", command: "true", inputs: [], outputs: ["out"] },
      ]),
      inputs: {},
    });
    expect(report.issues.map((entry) => entry.code)).toContain("flow-invalid");
  });
});
