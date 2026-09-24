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
    "pi",
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
    expect(report.issues[0]).toMatchObject({
      severity: "blocking",
      code: "flow-invalid",
    });
    expect(report.issues[0]?.message).toContain(
      "stage implement consumes unknown artifact",
    );
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
