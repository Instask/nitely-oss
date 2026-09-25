import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { describe, expect, it } from "vitest";

import {
  startWebServer,
  type StartWebServerInput,
  type WebServer,
} from "../../src/web/server.js";
import type {
  RunFlowDependencies,
  RunFlowInput,
  RunFlowResult,
} from "../../src/run/run-flow.js";
import { createApiToken } from "../../src/web/api-tokens.js";
import { createUser } from "../../src/web/users.js";
import { createTokenOwner } from "../helpers/token-owner.js";
import {
  addOrganizationMember,
  listPublicMemberships,
} from "../../src/web/organizations.js";

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
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>,
  options: Omit<
    Partial<StartWebServerInput>,
    "repoPath" | "host" | "port" | "runFlow"
  > = {},
) {
  const server = await startWebServer({
    repoPath: repo,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    ...options,
    ...(runFlow ? { runFlow } : {}),
    repositories: [
      { id: "home", name: "home", path: repo },
      ...(options.repositories ?? []),
    ],
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function login(server: WebServer, email: string, password: string) {
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    body: await json(response),
  };
}

function flowDocument(name: string): string {
  return JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: {
      name,
      workItemType: "report.generation",
      inputs: [{ id: "brief" }],
    },
    spec: {
      stages: [
        { id: "build", type: "command", command: "true", inputs: ["brief"], outputs: ["out"] },
      ],
    },
  });
}

const userFlow = flowDocument("report");

describe("flows API", () => {
  it("lists built-in repository flows", async () => {
    const repo = await createRepo();
    const server = await start(repo);
    const body = (await json(await fetch(`${server.url}/api/flows`))) as {
      flows: Array<{ id: string; source: string; name: string }>;
    };
    const builtin = body.flows.find(
      (f) => f.id === "flows/implement-spec-bootstrap.json",
    );
    expect(builtin).toMatchObject({
      source: "builtin",
      name: "implement-spec-bootstrap",
    });
    // Flows shipped with the installation are listed even when the
    // repository does not carry them.
    expect(body.flows).toContainEqual(
      expect.objectContaining({ id: "flows/implement-small.json", source: "builtin" }),
    );
  });

  it("lets a tasks:read API token read the flow catalog and nothing else", async () => {
    const repo = await createRepo();
    const server = await start(repo);
    const owner = await createTokenOwner(repo);
    const reader = await createApiToken(repo, {
      name: "flow reader",
      capabilities: ["tasks:read"],
      ownerUserId: owner.id,
    });
    const runsOnly = await createApiToken(repo, {
      name: "run reader",
      capabilities: ["runs:read"],
      ownerUserId: owner.id,
    });

    const listed = await fetch(`${server.url}/api/flows`, {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    expect(listed.status).toBe(200);
    const body = (await json(listed)) as {
      flows: Array<{ id: string; source: string; runnable: boolean }>;
    };
    expect(body.flows.some((flow) => flow.source === "builtin")).toBe(true);

    const denied = await fetch(`${server.url}/api/flows`, {
      headers: { authorization: `Bearer ${runsOnly.token}` },
    });
    expect(denied.status).toBe(403);
    await expect(json(denied)).resolves.toEqual({
      error: {
        code: "capability_denied",
        message: "API token capability denied: tasks:read is required",
      },
    });

    const detail = await fetch(
      `${server.url}/api/flows/${encodeURIComponent("flows/implement-spec-bootstrap.json")}`,
      { headers: { authorization: `Bearer ${reader.token}` } },
    );
    expect(detail.status).toBe(403);

    const created = await fetch(`${server.url}/api/flows`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reader.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: userFlow }),
    });
    expect(created.status).toBe(403);
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

  it("describes stage dependencies and artifact provenance for the flow detail graph", async () => {
    const repo = await createRepo();
    await writeFile(
      join(repo, "flows/two-stage.json"),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "two-stage" },
        spec: {
          stages: [
            { id: "draft", type: "command", command: "true", inputs: ["brief"], outputs: ["plan"] },
            { id: "build", type: "command", command: "true", inputs: ["plan"], outputs: ["patch"] },
          ],
        },
      }),
      "utf8",
    );
    const server = await start(repo);

    const response = await fetch(
      `${server.url}/api/flows/${encodeURIComponent("flows/two-stage.json")}`,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      flow: {
        artifactGraph: {
          order: string[];
          stages: Array<{ id: string; dependsOn: string[]; unblocks: string[] }>;
          edges: Array<{ from: string; to: string; artifacts: string[] }>;
          artifacts: Array<{ id: string; source: string; producer: string; consumers: string[] }>;
        };
      };
    };
    const graph = body.flow.artifactGraph;

    expect(graph.order).toEqual(["draft", "build"]);
    expect(graph.stages).toContainEqual(
      expect.objectContaining({ id: "build", dependsOn: ["draft"] }),
    );
    expect(graph.stages).toContainEqual(
      expect.objectContaining({ id: "draft", unblocks: ["build"] }),
    );
    expect(graph.edges).toContainEqual({ from: "draft", to: "build", artifacts: ["plan"] });
    expect(graph.artifacts).toContainEqual(
      expect.objectContaining({ id: "plan", source: "stage-output", producer: "draft", consumers: ["build"] }),
    );
    expect(graph.artifacts).toContainEqual(
      expect.objectContaining({ id: "brief", source: "external-input" }),
    );
  });

  it("returns an artifact graph for an unsaved draft so the editor can diagram it", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const body = (await json(
      await fetch(`${server.url}/api/flows/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: JSON.stringify({
            apiVersion: "nitely.dev/v1alpha1",
            kind: "Flow",
            metadata: { name: "draft-only" },
            spec: {
              stages: [
                { id: "draft", type: "command", command: "true", inputs: [], outputs: ["plan"] },
                { id: "build", type: "command", command: "true", inputs: ["plan"], outputs: ["patch"] },
              ],
            },
          }),
        }),
      }),
    )) as {
      report: {
        valid: boolean;
        artifactGraph?: { order: string[]; edges: Array<{ from: string; to: string; artifacts: string[] }> };
      };
    };

    expect(body.report.valid).toBe(true);
    expect(body.report.artifactGraph?.order).toEqual(["draft", "build"]);
    expect(body.report.artifactGraph?.edges).toContainEqual({
      from: "draft",
      to: "build",
      artifacts: ["plan"],
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
    )) as {
      templates: Array<{
        id: string;
        version: string;
        taskFamily: string;
        flowPath?: string;
        inputs: Array<{ id: string; required: boolean }>;
        requiredProviders: string[];
        stages: Array<{ id: string; type: string }>;
        suggestedGates: string[];
      }>;
    };
    expect(body.templates.length).toBeGreaterThan(0);
    const template = body.templates.find((item) => item.id === "pilot-approved-spec-pr");
    expect(template).toMatchObject({
      version: "1.0.0",
      taskFamily: "dev.pr",
      flowPath: "flows/pilot-approved-spec-pr.json",
      inputs: [
        { id: "spec", required: true },
        { id: "tech-design", required: true },
      ],
    });
    expect(template?.requiredProviders).toEqual(
      expect.arrayContaining(["codex", "github-cli"]),
    );
    expect(template?.stages.map((stage) => stage.id)).toContain("implement");
    expect(template?.suggestedGates).toContain("review");
  });

  it("copies a template into a customizable user flow with lineage", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const response = await fetch(`${server.url}/api/flows/from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateId: "pilot-approved-spec-pr",
        name: "team-approved-spec-pr",
        insertReviewStage: true,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await json(response)) as {
      flow: { id: string; name: string; document: string; template?: { templateId: string } };
    };
    expect(body.flow.name).toBe("team-approved-spec-pr");
    expect(body.flow.template).toMatchObject({
      templateId: "pilot-approved-spec-pr",
      templateVersion: "1.0.0",
      sourceFlowPath: "flows/pilot-approved-spec-pr.json",
    });
    expect(body.flow.document).toContain("pre-implementation-review");

    const detail = (await json(
      await fetch(`${server.url}/api/flows/${encodeURIComponent(body.flow.id)}`),
    )) as { flow: { template?: { templateId: string } } };
    expect(detail.flow.template?.templateId).toBe("pilot-approved-spec-pr");
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

  it("updates and deletes stored user flows in local mode", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const created = (await json(
      await fetch(`${server.url}/api/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: userFlow }),
      }),
    )) as { flow: { id: string } };

    const updated = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(created.flow.id)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: flowDocument("local updated") }),
      },
    );
    expect(updated.status).toBe(200);
    await expect(json(updated)).resolves.toMatchObject({
      flow: { id: created.flow.id, name: "local updated" },
    });

    const deleted = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(created.flow.id)}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    const detail = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(created.flow.id)}`,
    );
    expect(detail.status).toBe(404);
  });

  it("scopes stored user flows by organization membership and write roles", async () => {
    const repo = await createRepo();
    const owner = await createUser(repo, {
      email: "owner@example.test",
      password: "owner password passphrase",
      role: "user",
    });
    const teammate = await createUser(repo, {
      email: "teammate@example.test",
      password: "teammate password passphrase",
      role: "user",
    });
    const viewer = await createUser(repo, {
      email: "viewer@example.test",
      password: "viewer password passphrase",
      role: "user",
    });
    await createUser(repo, {
      email: "outsider@example.test",
      password: "outsider password passphrase",
      role: "user",
    });
    await createUser(repo, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    const [team] = await listPublicMemberships(repo, owner.id);
    await addOrganizationMember(repo, team.organizationId, {
      userId: owner.id,
      role: "owner",
    });
    await addOrganizationMember(repo, team.organizationId, {
      userId: teammate.id,
      role: "member",
    });
    await addOrganizationMember(repo, team.organizationId, {
      userId: viewer.id,
      role: "viewer",
    });
    const server = await start(repo, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const ownerLogin = await login(server, "owner@example.test", "owner password passphrase");
    const teammateLogin = await login(
      server,
      "teammate@example.test",
      "teammate password passphrase",
    );
    const viewerLogin = await login(server, "viewer@example.test", "viewer password passphrase");
    const outsiderLogin = await login(
      server,
      "outsider@example.test",
      "outsider password passphrase",
    );
    const adminLogin = await login(server, "admin@example.test", "admin password passphrase");

    const copied = await fetch(`${server.url}/api/flows/from-template`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerLogin.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({
        templateId: "pilot-approved-spec-pr",
        name: "team-template-copy",
      }),
    });
    expect(copied.status).toBe(201);
    const copiedBody = (await json(copied)) as {
      flow: { id: string; ownerId: string; organizationId: string };
    };
    expect(copiedBody.flow).toMatchObject({
      ownerId: owner.id,
      organizationId: team.organizationId,
    });

    const teammateFlowsAfterCopy = (await json(
      await fetch(`${server.url}/api/flows`, {
        headers: { cookie: teammateLogin.cookie },
      }),
    )) as { flows: Array<{ id: string; editable: boolean }> };
    expect(
      teammateFlowsAfterCopy.flows.find((flow) => flow.id === copiedBody.flow.id),
    ).toMatchObject({ editable: true });

    const created = await fetch(`${server.url}/api/flows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerLogin.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({ document: userFlow }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await json(created)) as {
      flow: { id: string; ownerId: string; organizationId: string };
    };
    expect(createdBody.flow).toMatchObject({
      ownerId: owner.id,
      organizationId: team.organizationId,
    });

    async function listedFlow(cookie: string) {
      const body = (await json(
        await fetch(`${server.url}/api/flows`, { headers: { cookie } }),
      )) as { flows: Array<{ id: string; editable: boolean }> };
      return body.flows.find((flow) => flow.id === createdBody.flow.id);
    }

    await expect(listedFlow(ownerLogin.cookie)).resolves.toMatchObject({
      id: createdBody.flow.id,
      editable: true,
    });
    await expect(listedFlow(teammateLogin.cookie)).resolves.toMatchObject({
      id: createdBody.flow.id,
      editable: true,
    });
    await expect(listedFlow(viewerLogin.cookie)).resolves.toMatchObject({
      id: createdBody.flow.id,
      editable: false,
    });
    await expect(listedFlow(adminLogin.cookie)).resolves.toMatchObject({
      id: createdBody.flow.id,
      editable: true,
    });
    await expect(listedFlow(outsiderLogin.cookie)).resolves.toBeUndefined();

    const viewerDetail = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      { headers: { cookie: viewerLogin.cookie } },
    );
    expect(viewerDetail.status).toBe(200);
    await expect(json(viewerDetail)).resolves.toMatchObject({
      flow: { id: createdBody.flow.id, editable: false },
    });

    const outsiderDetail = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      { headers: { cookie: outsiderLogin.cookie } },
    );
    expect(outsiderDetail.status).toBe(404);

    const viewerUpdate = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: viewerLogin.cookie,
        },
        body: JSON.stringify({ document: flowDocument("viewer update") }),
      },
    );
    expect(viewerUpdate.status).toBe(403);

    const outsiderUpdate = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: outsiderLogin.cookie,
        },
        body: JSON.stringify({ document: flowDocument("outsider update") }),
      },
    );
    expect(outsiderUpdate.status).toBe(404);

    const outsiderWorkItem = await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: outsiderLogin.cookie,
      },
      body: JSON.stringify({
        title: "Hidden flow work",
        flowId: createdBody.flow.id,
        inputs: { brief: { connector: "local-file", uri: "briefs/hidden.md" } },
      }),
    });
    expect(outsiderWorkItem.status).toBe(404);

    const teammateUpdate = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: teammateLogin.cookie,
        },
        body: JSON.stringify({ document: flowDocument("team updated") }),
      },
    );
    expect(teammateUpdate.status).toBe(200);
    await expect(json(teammateUpdate)).resolves.toMatchObject({
      flow: { id: createdBody.flow.id, name: "team updated" },
    });

    const viewerDelete = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      { method: "DELETE", headers: { cookie: viewerLogin.cookie } },
    );
    expect(viewerDelete.status).toBe(403);

    const outsiderDelete = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      { method: "DELETE", headers: { cookie: outsiderLogin.cookie } },
    );
    expect(outsiderDelete.status).toBe(404);

    const adminDelete = await fetch(
      `${server.url}/api/flows/${encodeURIComponent(createdBody.flow.id)}`,
      { method: "DELETE", headers: { cookie: adminLogin.cookie } },
    );
    expect(adminDelete.status).toBe(200);
  });

  it("runs a work item from a stored user flow without a flow file", async () => {
    const repo = await createRepo();
    const configuredFlow = JSON.parse(userFlow) as {
      metadata: Record<string, unknown>;
    };
    configuredFlow.metadata.configurables = [
      { key: "scope", type: "text", label: "Scope", required: true },
      { key: "dryRun", type: "boolean", label: "Dry run", default: true },
    ];
    const configuredUserFlow = JSON.stringify(configuredFlow);
    let runInput: RunFlowInput | undefined;
    const server = await start(repo, async (input, dependencies) => {
      runInput = input;
      const runId = dependencies?.createRunId?.() ?? "run-flow-1";
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repo, `.nitely/runs/${runId}/worktree`),
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: configuredUserFlow }),
      }),
    )) as { flow: { id: string } };
    await mkdir(join(repo, "briefs"), { recursive: true });
    await writeFile(join(repo, "briefs", "x.md"), "report brief\n", "utf8");

    const workItem = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run report",
          flowId: created.flow.id,
          inputs: { brief: { connector: "local-file", uri: "briefs/x.md" } },
          configuration: { scope: "quarterly report" },
        }),
      }),
    )) as {
      workItem: {
        id: string;
        flowId: string;
        configuration?: Record<string, unknown>;
      };
    };
    expect(workItem.workItem.flowId).toBe(created.flow.id);
    expect(workItem.workItem.configuration).toEqual({
      scope: "quarterly report",
      dryRun: true,
    });

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.workItem.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runInput?.flowDocument).toBe(configuredUserFlow);
    expect(runInput?.configuration).toEqual({
      scope: "quarterly report",
      dryRun: true,
    });
  });

  it("creates and runs a work item from a named flow template", async () => {
    const repo = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await start(
      repo,
      async (input, dependencies) => {
        runInput = input;
        const runId = dependencies?.createRunId?.() ?? "run-template-1";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repo, `.nitely/runs/${runId}/worktree`),
        };
      },
      { providerCommandStatus: async (command) => command === "codex" },
    );

    const missing = await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Fix bug",
        templateId: "pilot-bug-ticket-fix-pr",
        inputs: {
          "bug-ticket": { connector: "local-file", uri: "bug.md" },
        },
      }),
    });
    expect(missing.status).toBe(400);
    await expect(json(missing)).resolves.toMatchObject({
      error: { message: "missing required template inputs: repo-notes" },
    });

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Fix bug",
          templateId: "pilot-bug-ticket-fix-pr",
          inputs: {
            "bug-ticket": { connector: "local-file", uri: "bug.md" },
            "repo-notes": { connector: "local-file", uri: "notes.md" },
          },
        }),
      }),
    )) as {
      workItem: {
        id: string;
        flowPath: string;
        template?: { templateId: string; templateVersion: string };
      };
    };
    expect(created.workItem.flowPath).toBe("template:pilot-bug-ticket-fix-pr");
    expect(created.workItem.template).toMatchObject({
      templateId: "pilot-bug-ticket-fix-pr",
      templateVersion: "1.0.0",
    });
    await writeFile(join(repo, "bug.md"), "bug report\n", "utf8");
    await writeFile(join(repo, "notes.md"), "repo notes\n", "utf8");

    const runResponse = await fetch(
      `${server.url}/api/work-items/${created.workItem.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runInput?.flowPath).toBe("template:pilot-bug-ticket-fix-pr");
    expect(runInput?.flowDocument).toContain("pilot-bug-ticket-fix-pr");
  });

  it("creates a legacy dev task from a named compatible template", async () => {
    const repo = await createRepo();
    const server = await start(repo);

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Template task",
        spec: "Spec body",
        techDesign: "Design body",
        templateId: "dev-pr",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await json(response)) as {
      task: {
        flowPath: string;
        template?: { templateId: string; sourceFlowPath?: string };
      };
    };
    expect(body.task.flowPath).toBe("flows/implement-spec-bootstrap.json");
    expect(body.task.template).toMatchObject({
      templateId: "dev-pr",
      sourceFlowPath: "flows/implement-spec-bootstrap.json",
    });
  });
});
