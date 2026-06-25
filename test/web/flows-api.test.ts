import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { describe, expect, it } from "vitest";

import { startWebServer, type WebServer } from "../../src/web/server.js";
import type {
  RunFlowInput,
  RunFlowResult,
} from "../../src/run/run-flow.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-flows-api-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    }),
    "utf8",
  );
  return repo;
}

async function start(
  repo: string,
  runFlow?: (input: RunFlowInput) => Promise<RunFlowResult>,
) {
  const server = await startWebServer({
    repoPath: repo,
    host: "127.0.0.1",
    port: 0,
    runFlow,
    providerCommandStatus: async () => false,
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

const userFlow = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "report", workItemType: "report.generation", inputs: [{ id: "brief" }] },
  spec: {
    stages: [
      { id: "build", type: "command", command: "true", inputs: ["brief"], outputs: ["out"] },
    ],
  },
});

describe("flows API", () => {
  it("lists built-in repository flows", async () => {
    const repo = await createRepo();
    const server = await start(repo);
    const body = (await json(await fetch(`${server.url}/api/flows`))) as {
      flows: Array<{ id: string; source: string; name: string }>;
    };
    const builtin = body.flows.find((f) => f.source === "builtin");
    expect(builtin?.name).toBe("implement-spec-bootstrap");
  });

  it("returns details for a legitimate built-in repository flow", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const response = await fetch(
      `${server.url}/api/flows/${encodeURIComponent("flows/implement-spec-bootstrap.json")}`,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as { flow: { id: string; source: string } };
    expect(body.flow).toMatchObject({
      id: "flows/implement-spec-bootstrap.json",
      source: "builtin",
    });
  });

  it("does not read repository files through encoded built-in flow traversal", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "package.json"), "repo-root-secret", "utf8");
    const server = await start(repo);

    const response = await fetch(
      `${server.url}/api/flows/flows%2F..%2Fpackage.json`,
    );

    expect(response.status).toBe(404);
    const body = await json(response);
    expect(JSON.stringify(body)).not.toContain("repo-root-secret");
  });

  it("returns templates that the editor can start from", async () => {
    const repo = await createRepo();
    const server = await start(repo);
    const body = (await json(
      await fetch(`${server.url}/api/flows/templates`),
    )) as { templates: Array<{ id: string }> };
    expect(body.templates.length).toBeGreaterThan(0);
  });

  it("validates a flow document without persisting", async () => {
    const repo = await createRepo();
    const server = await start(repo);
    const body = (await json(
      await fetch(`${server.url}/api/flows/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: "{ not json" }),
      }),
    )) as { report: { valid: boolean } };
    expect(body.report.valid).toBe(false);
  });

  it("rejects creating an invalid flow and creates a valid one", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const invalid = await fetch(`${server.url}/api/flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: '{"kind":"Flow"}' }),
    });
    expect(invalid.status).toBe(422);

    const created = await fetch(`${server.url}/api/flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: userFlow }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await json(created)) as { flow: { id: string } };
    expect(createdBody.flow.id).toMatch(/^flow-/);

    const list = (await json(await fetch(`${server.url}/api/flows`))) as {
      flows: Array<{ id: string; source: string }>;
    };
    expect(list.flows.some((f) => f.source === "user")).toBe(true);
  });

  it("runs a work item from a stored user flow without a flow file", async () => {
    const repo = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await start(repo, async (input) => {
      runInput = input;
      return {
        runId: "run-flow-1",
        branchName: "nitely/run-flow-1",
        worktreePath: join(repo, ".nitely/runs/run-flow-1/worktree"),
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: userFlow }),
      }),
    )) as { flow: { id: string } };

    const workItem = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run report",
          flowId: created.flow.id,
          inputs: { brief: { connector: "local-file", uri: "briefs/x.md" } },
        }),
      }),
    )) as { workItem: { id: string; flowId: string } };
    expect(workItem.workItem.flowId).toBe(created.flow.id);

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.workItem.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runInput?.flowDocument).toBe(userFlow);
  });
});
