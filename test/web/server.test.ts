import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type {
  RunFlowDependencies,
  RunFlowInput,
  RunFlowResult,
} from "../../src/run/run-flow.js";
import type {
  ProviderConnectionStore,
  ProviderId,
  SetConnectionInput,
} from "../../src/providers/types.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { createTask } from "../../src/web/tasks.js";
import { createUser } from "../../src/web/users.js";
import {
  addOrganizationMember,
  listPublicMemberships,
} from "../../src/web/organizations.js";
import { createWorkItem } from "../../src/work-items/store.js";

const servers: WebServer[] = [];

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-server-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  return repoPath;
}

async function startTestServer(
  repoPath: string,
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>,
  providerStore?: ProviderConnectionStore,
  options: Partial<Parameters<typeof startWebServer>[0]> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    runFlow,
    providerCommandStatus: async () => false,
    providerStore,
    ...options,
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as unknown;
}

async function expectWebInputError(response: Response, message: string) {
  expect(response.status).toBe(400);
  await expect(json(response)).resolves.toMatchObject({
    error: { message },
  });
}

function nonDevFlow(secretMarker?: string) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: {
      name: "autofarm-site",
      workItemType: "autofarm.site",
      inputs: [{ id: "seed", type: "keyword-seed" }],
      ...(secretMarker ? { secretMarker } : {}),
    },
    spec: {
      stages: [
        { id: "discover", type: "command", command: "true", inputs: ["seed"], outputs: ["keyword-set"] },
        { id: "approve-plan", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
        { id: "approve-preview", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
        { id: "deploy", type: "command", command: "true", inputs: [], outputs: ["deployment"] },
      ],
    },
  };
}

async function allowAutofarmWorkItems(repoPath: string) {
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(
    join(repoPath, ".nitely/work-item-policy.json"),
    JSON.stringify({ allowedTypes: ["autofarm.site"] }),
    "utf8",
  );
}

async function writeNonDevFlow(path: string, secretMarker?: string) {
  await writeFile(path, JSON.stringify(nonDevFlow(secretMarker)), "utf8");
}

async function workItemDirectoryEntries(repoPath: string): Promise<string[]> {
  try {
    return await readdir(join(repoPath, ".nitely/work-items"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
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

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  return latest;
}

describe("web server API and HTML", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("reports a local admin session and preserves unauthenticated local API compatibility", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const session = await json(await fetch(`${server.url}/api/session`));
    expect(session).toEqual({
      authRequired: false,
      user: { id: "local", email: "local", role: "admin" },
    });

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Local task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      task: { title: "Local task" },
    });
  });

  it("requires authentication for protected APIs in required auth mode", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password",
      },
    });

    const session = await json(await fetch(`${server.url}/api/session`));
    expect(session).toEqual({ authRequired: true, user: null });

    for (const request of [
      fetch(`${server.url}/api/tasks`),
      fetch(`${server.url}/api/tasks`, { method: "POST" }),
      fetch(`${server.url}/api/runs`),
      fetch(`${server.url}/api/providers`),
    ]) {
      const response = await request;
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({
        error: {
          code: "unauthorized",
          message: "authentication required",
        },
      });
    }
  });

  it("returns a setup-specific login error when required auth has no initial admin", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });

    await expect(json(await fetch(`${server.url}/api/session`))).resolves.toEqual({
      authRequired: true,
      user: null,
    });

    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "admin password",
      }),
    });

    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "setup_required",
        message: expect.stringContaining("NITELY_ADMIN_EMAIL"),
      },
    });
    expect(JSON.stringify(body)).toContain("NITELY_ADMIN_PASSWORD");
  });

  it("keeps invalid login generic once required auth has users", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password",
      },
    });

    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "wrong password",
      }),
    });

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({
      error: {
        code: "unauthorized",
        message: "invalid email or password",
      },
    });
  });

  it("treats malformed session cookies as unauthenticated required auth requests", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password",
      },
    });

    const tasks = await fetch(`${server.url}/api/tasks`, {
      headers: { cookie: "nitely_session=%" },
    });
    expect(tasks.status).toBe(401);
    expect(await json(tasks)).toEqual({
      error: {
        code: "unauthorized",
        message: "authentication required",
      },
    });

    await expect(
      json(
        await fetch(`${server.url}/api/session`, {
          headers: { cookie: "nitely_session=%" },
        }),
      ),
    ).resolves.toEqual({
      authRequired: true,
      user: null,
    });
  });

  it("signs in with an HTTP-only cookie and signs out by clearing the session", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password",
      },
    });

    const signedIn = await login(server, "admin@example.test", "admin password");

    expect(signedIn.response.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      authRequired: true,
      user: { email: "admin@example.test", role: "admin" },
    });
    expect(signedIn.cookie).toMatch(/^nitely_session=sess_/);
    expect(signedIn.response.headers.get("set-cookie")).toContain("HttpOnly");

    await expect(
      json(
        await fetch(`${server.url}/api/session`, {
          headers: { cookie: signedIn.cookie },
        }),
      ),
    ).resolves.toMatchObject({
      authRequired: true,
      user: { email: "admin@example.test", role: "admin" },
    });

    const logout = await fetch(`${server.url}/api/session`, {
      method: "DELETE",
      headers: { cookie: signedIn.cookie },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("nitely_session=;");
    expect(await json(logout)).toEqual({ ok: true });
  });

  it("isolates tasks and task-started runs between signed-in users", async () => {
    const repoPath = await createRepo();
    const userA = await createUser(repoPath, {
      email: "a@example.test",
      password: "password a",
      role: "user",
    });
    await createUser(repoPath, {
      email: "b@example.test",
      password: "password b",
      role: "user",
    });
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        const runDirectory = join(repoPath, ".nitely/runs/run-user-a");
        await mkdir(runDirectory, { recursive: true });
        await writeFile(
          join(runDirectory, "run.json"),
          JSON.stringify(
            {
              runId: "run-user-a",
              status: "completed",
              ownerId: input.ownerId,
              completedStages: [],
              inputs: input.inputs,
            },
            null,
            2,
          ),
          "utf8",
        );
        return {
          runId: "run-user-a",
          branchName: "nitely/run-user-a",
          worktreePath: join(runDirectory, "worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const a = await login(server, "a@example.test", "password a");
    const b = await login(server, "b@example.test", "password b");

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: a.cookie,
        },
        body: JSON.stringify({
          title: "A task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; ownerId: string } };

    expect(created.task.ownerId).toBe(userA.id);
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({ tasks: [{ id: created.task.id }] });
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: b.cookie } })),
    ).resolves.toEqual({ tasks: [] });

    const bDetail = await fetch(`${server.url}/api/tasks/${created.task.id}`, {
      headers: { cookie: b.cookie },
    });
    expect(bDetail.status).toBe(404);
    const bStart = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: b.cookie },
    });
    expect(bStart.status).toBe(404);

    const aStart = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: a.cookie },
    });
    expect(aStart.status).toBe(200);
    expect(runInput?.ownerId).toBe(userA.id);

    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({ runs: [{ runId: "run-user-a", ownerId: userA.id }] });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: b.cookie } })),
    ).resolves.toEqual({ runs: [] });
    const bRun = await fetch(`${server.url}/api/runs/run-user-a`, {
      headers: { cookie: b.cookie },
    });
    expect(bRun.status).toBe(404);
  });

  it("shares team-scoped tasks with organization members and hides them from other teams", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password",
      role: "user",
    });
    const teammate = await createUser(repoPath, {
      email: "teammate@example.test",
      password: "teammate password",
      role: "user",
    });
    await createUser(repoPath, {
      email: "outsider@example.test",
      password: "outsider password",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, owner.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: teammate.id,
      role: "member",
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const ownerLogin = await login(server, "owner@example.test", "owner password");
    const teammateLogin = await login(
      server,
      "teammate@example.test",
      "teammate password",
    );
    const outsiderLogin = await login(
      server,
      "outsider@example.test",
      "outsider password",
    );

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerLogin.cookie,
          "x-nitely-organization-id": team.organizationId,
        },
        body: JSON.stringify({
          title: "Team task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; organizationId: string; ownerId: string } };

    expect(created.task.organizationId).toBe(team.organizationId);
    await expect(
      json(
        await fetch(`${server.url}/api/tasks`, {
          headers: { cookie: teammateLogin.cookie },
        }),
      ),
    ).resolves.toMatchObject({ tasks: [{ id: created.task.id }] });
    await expect(
      json(
        await fetch(`${server.url}/api/tasks`, {
          headers: { cookie: outsiderLogin.cookie },
        }),
      ),
    ).resolves.toEqual({ tasks: [] });
  });

  it("allows team members to run work and denies viewer mutations", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password",
      role: "user",
    });
    const member = await createUser(repoPath, {
      email: "member@example.test",
      password: "member password",
      role: "user",
    });
    const viewer = await createUser(repoPath, {
      email: "viewer@example.test",
      password: "viewer password",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, owner.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: member.id,
      role: "member",
    });
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: viewer.id,
      role: "viewer",
    });
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-team",
          branchName: "nitely/run-team",
          worktreePath: join(repoPath, ".nitely/runs/run-team/worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const ownerLogin = await login(server, "owner@example.test", "owner password");
    const memberLogin = await login(server, "member@example.test", "member password");
    const viewerLogin = await login(server, "viewer@example.test", "viewer password");

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerLogin.cookie,
          "x-nitely-organization-id": team.organizationId,
        },
        body: JSON.stringify({
          title: "Runnable team task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; organizationId: string } };

    const viewerCreate = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerLogin.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({
        title: "Viewer task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(viewerCreate.status).toBe(403);

    const viewerRun = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: viewerLogin.cookie },
    });
    expect(viewerRun.status).toBe(403);
    expect(runInput).toBeUndefined();

    const memberRun = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: memberLogin.cookie },
    });
    expect(memberRun.status).toBe(200);
    expect(runInput).toMatchObject({
      ownerId: owner.id,
      organizationId: team.organizationId,
    });
  });

  it("keeps legacy owner-scoped records writable by their owner", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password",
      role: "user",
    });
    const task = await createTask(
      repoPath,
      {
        title: "Legacy owner task",
        spec: "Spec body",
        techDesign: "Design body",
      },
      { ownerId: owner.id, createId: () => "legacy-owner-task" },
    );
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-legacy-owner",
          branchName: "nitely/run-legacy-owner",
          worktreePath: join(repoPath, ".nitely/runs/run-legacy-owner/worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const signedIn = await login(server, "owner@example.test", "owner password");

    const response = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
      headers: { cookie: signedIn.cookie },
    });

    expect(response.status).toBe(200);
    expect(runInput).toMatchObject({ ownerId: owner.id });
    expect(runInput?.organizationId).toBeUndefined();
  });

  it("keeps web-saved provider credentials scoped to the signed-in user", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "a@example.test",
      password: "password a",
      role: "user",
    });
    await createUser(repoPath, {
      email: "b@example.test",
      password: "password b",
      role: "user",
    });
    let resolvedEnv: Record<string, string | undefined> | undefined;
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        resolvedEnv = await dependencies?.providerStore?.resolveEnv();
        return {
          runId: "run-provider-a",
          branchName: "nitely/run-provider-a",
          worktreePath: join(repoPath, ".nitely/runs/run-provider-a/worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const a = await login(server, "a@example.test", "password a");
    const b = await login(server, "b@example.test", "password b");

    const save = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: a.cookie,
      },
      body: JSON.stringify({ value: "glm-user-a-secret" }),
    });
    expect(save.status).toBe(200);

    await expect(
      json(await fetch(`${server.url}/api/providers`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "glm", configured: true }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/providers`, { headers: { cookie: b.cookie } })),
    ).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "glm", configured: false }),
      ]),
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: a.cookie,
        },
        body: JSON.stringify({
          title: "Provider scoped run",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: a.cookie },
    });

    expect(resolvedEnv?.NITELY_GLM_API_KEY).toBe("glm-user-a-secret");
  });

  it("lets admins inspect legacy unowned tasks and runs while hiding them from normal users", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password",
      role: "admin",
    });
    await createUser(repoPath, {
      email: "user@example.test",
      password: "user password",
      role: "user",
    });
    const localServer = await startTestServer(repoPath);
    const legacy = (await json(
      await fetch(`${localServer.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Legacy task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    await localServer.close();
    servers.splice(servers.indexOf(localServer), 1);
    const runDirectory = join(repoPath, ".nitely/runs/run-legacy");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-legacy",
        status: "completed",
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
    });
    const admin = await login(server, "admin@example.test", "admin password");
    const user = await login(server, "user@example.test", "user password");

    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: admin.cookie } })),
    ).resolves.toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: legacy.task.id }),
        expect.objectContaining({ id: "inferred-run-run-legacy" }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: admin.cookie } })),
    ).resolves.toMatchObject({ runs: [{ runId: "run-legacy" }] });
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: user.cookie } })),
    ).resolves.toEqual({ tasks: [] });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: user.cookie } })),
    ).resolves.toEqual({ runs: [] });
  });

  it("returns enriched session fields from the backward-compatible run APIs", async () => {
    const repoPath = await createRepo();
    const runDirectory = join(repoPath, ".nitely/runs/run-session-api");
    await mkdir(join(runDirectory, "stages/review/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-session-api",
        status: "completed",
        ownerId: "local",
        flowName: "implement-spec-bootstrap",
        completedStages: ["review"],
        inputs: {
          spec: {
            sourceUri: ".nitely/tasks/task-api/spec.md",
            mediaType: "text/markdown",
          },
        },
        changeRequestUrl: "https://github.com/example/repo/pull/22",
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/review/1/review.md"),
      "No issues\n",
      "utf8",
    );
    const server = await startTestServer(repoPath);

    await expect(json(await fetch(`${server.url}/api/runs`))).resolves.toMatchObject({
      runs: [
        {
          runId: "run-session-api",
          sessionId: "run-session-api",
          taskId: "task-api",
          prNumber: 22,
          prUrl: "https://github.com/example/repo/pull/22",
        },
      ],
    });
    await expect(
      json(await fetch(`${server.url}/api/runs/run-session-api`)),
    ).resolves.toMatchObject({
      run: {
        runId: "run-session-api",
        sessionId: "run-session-api",
        contextManifest: [
          {
            id: "spec",
            sourceUri: ".nitely/tasks/task-api/spec.md",
            mediaType: "text/markdown",
          },
        ],
        timeline: [
          {
            stageId: "review",
            status: "completed",
          },
        ],
        reviewFindings: [
          {
            stageId: "review",
            severities: { none: 1 },
          },
        ],
        childRuns: [],
      },
    });
  });

  it("redacts provider-store-only secrets from durable context manifests in run detail", async () => {
    const repoPath = await createRepo();
    const user = await createUser(repoPath, {
      email: "provider@example.test",
      password: "provider password",
      role: "user",
    });
    const providerOnlySecret = "provider-only-manifest-secret";
    expect(Object.values(process.env)).not.toContain(providerOnlySecret);
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const signedIn = await login(server, "provider@example.test", "provider password");
    const save = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signedIn.cookie,
      },
      body: JSON.stringify({ value: providerOnlySecret }),
    });
    expect(save.status).toBe(200);

    const runDirectory = join(repoPath, ".nitely/runs/run-provider-manifest");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-provider-manifest",
        status: "completed",
        ownerId: user.id,
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "context-manifest.json"),
      JSON.stringify(
        {
          version: 1,
          runId: "run-provider-manifest",
          generatedAt: "2026-06-20T00:00:00.000Z",
          entries: [
            {
              id: "provider",
              kind: "external-input",
              connector: "local-file",
              sourceUri: `secrets/${providerOnlySecret}.txt`,
              mediaType: "text/plain",
              filename: `${providerOnlySecret}.txt`,
              revision: `rev-${providerOnlySecret}`,
              policy: {
                decision: "warned",
                reason: `matched ${providerOnlySecret}`,
                matchedPattern: `secrets/*${providerOnlySecret}*`,
              },
              nested: { label: providerOnlySecret },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(`${server.url}/api/runs/run-provider-manifest`, {
      headers: { cookie: signedIn.cookie },
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(providerOnlySecret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("returns stable JSON validation errors", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", spec: "", techDesign: "" }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: {
        code: "invalid_input",
        message: "title is required",
      },
    });
  });

  it("redacts unknown internal error messages from generic JSON errors", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, async () => {
      throw new Error("command failed: stderr contains secret-token");
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Redaction task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(500);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "internal server error",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("stderr");
  });

  it("creates tasks through the API and serves the Design Component frontend", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Browser task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; title: string } };

    expect(created.task.title).toBe("Browser task");
    await expect(
      readFile(join(repoPath, ".nitely/tasks", created.task.id, "spec.md"), "utf8"),
    ).resolves.toBe("Spec body");

    const html = await (await fetch(server.url)).text();
    expect(html).toContain("<x-dc>");
    expect(html).toContain("DCLogic");
    expect(html).toContain("class Component extends");
  });

  it("returns a manager dashboard across configured repositories", async () => {
    const homeRepo = await createRepo();
    const otherRepo = await createRepo();
    await createTask(
      homeRepo,
      {
        title: "Blocked home task",
        spec: "Spec",
        techDesign: "Design",
      },
      {
        createId: () => "task-home",
        initialStatus: "failed",
        now: () => new Date("2026-06-22T12:00:00.000Z"),
      },
    );
    await createTask(
      otherRepo,
      {
        title: "Ready other task",
        spec: "Spec",
        techDesign: "Design",
      },
      {
        createId: () => "task-other",
        repoId: "other",
        initialStatus: "ready",
        now: () => new Date("2026-06-23T12:00:00.000Z"),
      },
    );
    await mkdir(join(otherRepo, ".nitely"), { recursive: true });
    const store = new EventStore(join(otherRepo, ".nitely/events.db"));
    try {
      store.append({
        runId: "run-other",
        type: "run.created",
        createdAt: "2026-06-23T10:00:00.000Z",
        payload: {
          flowName: "implement",
          workItemId: "task-other",
          workItemType: "dev.pr",
          repoId: "other",
          repoName: "Other",
          branchName: "nitely/run-other",
          inputs: {},
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.started",
        createdAt: "2026-06-23T10:00:01.000Z",
        payload: { type: "agent", runtime: "codex" },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.context.usage",
        createdAt: "2026-06-23T10:00:02.000Z",
        payload: {
          promptBytes: 1200,
          approxTokens: 300,
          inputBytesInlined: 800,
          inputBytesSaved: 400,
          inputCount: 2,
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.runtime.usage",
        createdAt: "2026-06-23T10:00:03.000Z",
        payload: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.02,
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.completed",
        createdAt: "2026-06-23T10:01:00.000Z",
        payload: {},
      });
      store.append({
        runId: "run-other",
        type: "run.completed",
        createdAt: "2026-06-23T10:01:01.000Z",
        payload: {},
      });
    } finally {
      store.close();
    }
    const server = await startTestServer(homeRepo, undefined, undefined, {
      repositories: [
        { id: "other", name: "Other", path: otherRepo },
      ],
    });

    const body = (await json(
      await fetch(`${server.url}/api/dashboard`),
    )) as {
      dashboard: {
        taskCount: number;
        runCount: number;
        repositoryCount: number;
        throughput: { blockedItems: number };
        cost: { runtimeTokens?: number; contextTokens?: number; estimatedCostUsd?: number };
        repositories: Array<{ repoId: string; taskCount: number; runCount: number }>;
      };
    };

    expect(body.dashboard).toMatchObject({
      taskCount: 2,
      runCount: 1,
      repositoryCount: 2,
      throughput: { blockedItems: 1 },
      cost: {
        runtimeTokens: 150,
        contextTokens: 300,
        estimatedCostUsd: 0.02,
      },
    });
    expect(body.dashboard.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: "default", taskCount: 1 }),
        expect.objectContaining({ repoId: "other", taskCount: 1, runCount: 1 }),
      ]),
    );
  });

  it("returns task detail data through the API and serves the Design Component for task routes", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Detail task",
          spec: "Spec <body>",
          techDesign: "Design body",
          issueUrl: "https://github.com/Instask/nitely/issues/12",
        }),
      }),
    )) as { task: { id: string; specPath: string; techDesignPath: string } };

    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as {
      task: { id: string; specPath: string; techDesignPath: string };
      spec: string;
      techDesign: string;
    };
    expect(detail).toMatchObject({
      task: {
        id: created.task.id,
        specPath: created.task.specPath,
        techDesignPath: created.task.techDesignPath,
      },
      spec: "Spec <body>",
      techDesign: "Design body",
    });

    const html = await (
      await fetch(`${server.url}/tasks/${created.task.id}`)
    ).text();
    expect(html).toContain("<x-dc>");
    expect(html).toContain("DCLogic");
  });

  it("serves JavaScript assets correctly from nested task and run route reloads", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Nested route asset task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-direct-route");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-direct-route",
        status: "completed",
        completedStages: ["implement"],
        inputs: {},
      }),
      "utf8",
    );

    for (const route of [
      `/tasks/${created.task.id}`,
      "/runs/run-direct-route",
    ]) {
      const pageResponse = await fetch(`${server.url}${route}`);
      expect(pageResponse.status).toBe(200);
      expect(pageResponse.headers.get("content-type")).toContain("text/html");
      const html = await pageResponse.text();
      expect(html).toContain('src="/support.js"');
      const scriptSources = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g))
        .map((match) => match[1]);
      expect(scriptSources).toContain("/support.js");

      for (const scriptSource of scriptSources) {
        const scriptUrl = new URL(scriptSource, pageResponse.url);
        const scriptResponse = await fetch(scriptUrl);
        expect(scriptResponse.status).toBe(200);
        expect(scriptResponse.headers.get("content-type")).toContain(
          "application/javascript",
        );
        const scriptBody = await scriptResponse.text();
        expect(scriptBody).toContain("DCLogic");
        expect(scriptBody).not.toContain("<!DOCTYPE html>");
      }
    }
  });

  it("serves the Design Component shell for shipped Web Console routes", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Console route task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    for (const route of [
      "/",
      "/tasks",
      `/tasks/${created.task.id}`,
      "/runs/run-debug-route",
      "/providers",
    ]) {
      const response = await fetch(`${server.url}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<x-dc>");
      expect(html).toContain("DCLogic");
      expect(html).not.toContain("Nitely Console</div>");
    }
  });

  it("enriches task APIs with additive work-item run fields", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Enriched API task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; specPath: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-api-1");
    await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify(
        {
          runId: "run-api-1",
          status: "completed",
          completedStages: ["implement"],
          inputs: { spec: { sourceUri: created.task.specPath } },
          changeRequestUrl: "https://github.com/example/repo/pull/12",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      "installing\nchecks passed\n",
      "utf8",
    );

    const tasksBody = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{
        id: string;
        title: string;
        latestRun?: { runId: string; recentLogSummary?: string };
        runCount?: number;
        currentStage?: string;
        latestChangeRequestUrl?: string;
      }>;
    };
    expect(tasksBody.tasks[0]).toMatchObject({
      id: created.task.id,
      title: "Enriched API task",
      latestRun: {
        runId: "run-api-1",
        recentLogSummary: "checks passed",
      },
      runCount: 1,
      currentStage: "implement",
      latestChangeRequestUrl: "https://github.com/example/repo/pull/12",
    });

    const detailBody = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as {
      task: { id: string };
      spec: string;
      techDesign: string;
      runs?: Array<{ runId: string; recentLogSummary?: string }>;
    };
    expect(detailBody).toMatchObject({
      task: { id: created.task.id },
      spec: "Spec body",
      techDesign: "Design body",
      runs: [{ runId: "run-api-1", recentLogSummary: "checks passed" }],
    });
  });

  it("starts a task run with materialized local-file inputs", async () => {
    const repoPath = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(repoPath, async (input) => {
      runInput = input;
      return {
        runId: "run-web",
        branchName: "nitely/run-web",
        worktreePath: join(repoPath, ".nitely/runs/run-web/worktree"),
        changeRequestUrl: "https://github.com/example/repo/pull/2",
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run from browser",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      run: {
        runId: "run-web",
        branchName: "nitely/run-web",
        worktreePath: join(repoPath, ".nitely/runs/run-web/worktree"),
        changeRequestUrl: "https://github.com/example/repo/pull/2",
      },
    });
    expect(runInput).toEqual({
      flowPath: join(repoPath, "flows/implement-spec-bootstrap.json"),
      repoPath,
      inputs: {
        spec: {
          connector: "local-file",
          uri: `.nitely/tasks/${created.task.id}/spec.md`,
        },
        "tech-design": {
          connector: "local-file",
          uri: `.nitely/tasks/${created.task.id}/tech-design.md`,
        },
      },
      repoId: "default",
      repoName: expect.any(String),
      workItemId: created.task.id,
      workItemType: "dev.pr",
    });
  });

  it("creates a draft spec task from prompt intake and blocks implementation runs", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("draft tasks must not start");
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        prompt: "Add repository import from a pasted GitHub URL.",
        title: "Repository import",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        id: string;
        status: string;
        specStatus?: string;
        source?: { type: string };
        specPath: string;
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      source: { type: "prompt" },
    });
    expect(created.spec).toContain("Status: draft");
    await expect(readFile(join(repoPath, created.task.specPath), "utf8")).resolves.toBe(
      created.spec,
    );

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      runResponse,
      "draft spec must be approved before starting a run",
    );
    expect(runStarted).toBe(false);
  });

  it("creates a draft spec task from GitHub issue intake", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => {
        expect(reference).toMatchObject({
          owner: "Instask",
          repo: "nitely",
          number: 111,
        });
        return {
          title: "Generate draft specs",
          body: "Convert messy intake into a structured draft spec.",
          url: reference.url,
        };
      },
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/111",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        title: string;
        status: string;
        issueUrl?: string;
        source?: { type: string; uri?: string; title?: string };
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      title: "Generate draft specs",
      status: "draft",
      issueUrl: "https://github.com/Instask/nitely/issues/111",
      source: {
        type: "github-issue",
        uri: "https://github.com/Instask/nitely/issues/111",
        title: "Generate draft specs",
      },
    });
    expect(created.spec).toContain("Source: github-issue https://github.com/Instask/nitely/issues/111");
  });

  it("approves planner drafts before allowing implementation runs", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      return {
        runId: "run-planner-approved",
        branchName: "nitely/run-planner-approved",
        worktreePath: join(repoPath, ".nitely/runs/run-planner-approved/worktree"),
        completedStages: ["implement"],
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
          title: "Planner approval workflow",
        }),
      }),
    )) as { task: { id: string; status: string; specStatus?: string } };

    const approvedSpecResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );
    expect(approvedSpecResponse.status).toBe(200);
    const approvedSpec = (await json(approvedSpecResponse)) as {
      task: { status: string; specStatus?: string };
    };
    expect(approvedSpec.task).toMatchObject({
      status: "draft",
      specStatus: "approved",
    });

    const blockedBeforeDraftResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeDraftResponse,
      "draft technical design is required before starting a run",
    );
    expect(runStarted).toBe(false);

    const draftDesignResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );
    expect(draftDesignResponse.status).toBe(200);
    const draftDesign = (await json(draftDesignResponse)) as {
      task: {
        status: string;
        techDesignStatus?: string;
        planningNotes?: { openQuestions?: string[] };
      };
      openQuestions: string[];
    };
    expect(draftDesign.task.status).toBe("draft");
    expect(draftDesign.task.techDesignStatus).toBe("draft");
    expect(draftDesign.openQuestions.length).toBeGreaterThan(0);
    expect(draftDesign.task.planningNotes?.openQuestions).toEqual(
      draftDesign.openQuestions,
    );

    const blockedRunResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedRunResponse,
      "draft technical design must be approved before starting a run",
    );
    expect(runStarted).toBe(false);

    const approvedDesignResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    expect(approvedDesignResponse.status).toBe(200);
    const approvedDesign = (await json(approvedDesignResponse)) as {
      task: {
        status: string;
        techDesignStatus?: string;
        planningNotes?: { openQuestions?: string[] };
      };
    };
    expect(approvedDesign.task).toMatchObject({
      status: "ready",
      techDesignStatus: "approved",
    });
    expect(approvedDesign.task.planningNotes?.openQuestions).toEqual(
      draftDesign.openQuestions,
    );

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runStarted).toBe(true);
  });

  it("rejects technical design approval until a draft design has been generated", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
        }),
      }),
    )) as { task: { id: string } };

    const blockedBeforeSpecApproval = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeSpecApproval,
      "approved spec is required before approving a technical design",
    );

    await fetch(`${server.url}/api/tasks/${created.task.id}/approve-spec`, {
      method: "POST",
    });
    const blockedBeforeDraft = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeDraft,
      "draft technical design is required before approval",
    );
  });

  it("rejects implementation runs after spec approval until a technical design is drafted", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("runs must not start before a technical design draft");
    });
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
        }),
      }),
    )) as { task: { id: string } };

    await fetch(`${server.url}/api/tasks/${created.task.id}/approve-spec`, {
      method: "POST",
    });

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      response,
      "draft technical design is required before starting a run",
    );
    expect(runStarted).toBe(false);
  });

  it("creates a draft technical design from an approved structured spec and blocks runs", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(repoPath, "test"), { recursive: true });
    await writeFile(
      join(repoPath, "package.json"),
      JSON.stringify({ scripts: { "test:run": "vitest run" } }),
      "utf8",
    );
    await writeFile(join(repoPath, "src/repositories.ts"), "", "utf8");
    await writeFile(join(repoPath, "test/repositories.test.ts"), "", "utf8");
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("draft technical designs must not start");
    });
    const spec = `# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** As an operator, I can import repositories.

## Acceptance Scenarios
- **US-001 / SC-001:** Import succeeds.

## Functional Requirements
- **FR-001:** Import repositories from URLs.

## Success Criteria
- **SC-001:** Import is verified by a test.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`;
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Approved spec task",
          spec,
          techDesign: "Technical design pending",
        }),
      }),
    )) as { task: { id: string; techDesignPath: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const result = (await json(response)) as {
      task: { techDesignStatus?: string };
      techDesign: string;
      openQuestions: string[];
    };
    expect(result.task.techDesignStatus).toBe("draft");
    expect(result.techDesign).toContain("Status: draft");
    expect(result.techDesign).toContain("src/repositories.ts");
    expect(result.techDesign).toContain("pnpm test:run");
    await expect(
      readFile(join(repoPath, created.task.techDesignPath), "utf8"),
    ).resolves.toBe(result.techDesign);

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(400);
    expect(runStarted).toBe(false);
  });

  it("rejects draft technical design generation from an unapproved draft spec", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add import support.",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({
      error: {
        message: "approved spec is required before drafting a technical design",
      },
    });
  });

  it("lists configured repositories and routes task creation and runs by repository", async () => {
    const defaultRepo = await createRepo();
    const docsRepo = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(defaultRepo, async (input) => {
      runInput = input;
      return {
        runId: "run-docs",
        branchName: "nitely/run-docs",
        worktreePath: join(docsRepo, ".nitely/runs/run-docs/worktree"),
      };
    }, undefined, {
      repositories: [{ id: "docs", name: "Docs repo", path: docsRepo }],
    });

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        expect.objectContaining({ id: "default", name: expect.any(String), path: resolve(defaultRepo) }),
        expect.objectContaining({ id: "docs", name: "Docs repo", path: resolve(docsRepo) }),
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "docs",
          title: "Docs task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; repoId?: string; repoName?: string; repoPath?: string } };

    expect(created.task).toMatchObject({
      title: "Docs task",
      repoId: "docs",
      repoName: "Docs repo",
      repoPath: resolve(docsRepo),
    });
    await expect(readFile(join(docsRepo, ".nitely/tasks", created.task.id, "task.json"), "utf8"))
      .resolves.toContain('"repoId": "docs"');

    const list = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string; repoId?: string; repoName?: string; repoPath?: string }>;
    };
    expect(list.tasks.find((task) => task.id === created.task.id)).toMatchObject({
      repoId: "docs",
      repoName: "Docs repo",
      repoPath: resolve(docsRepo),
    });

    await mkdir(join(docsRepo, ".nitely/runs/run-doc-history"), { recursive: true });
    await writeFile(
      join(docsRepo, ".nitely/runs/run-doc-history/run.json"),
      JSON.stringify({
        runId: "run-doc-history",
        status: "completed",
        flowName: "docs-flow",
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    await expect(json(await fetch(`${server.url}/api/runs`))).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          runId: "run-doc-history",
          repoId: "docs",
          repoName: "Docs repo",
          repoPath: resolve(docsRepo),
        }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/runs/run-doc-history`)),
    ).resolves.toMatchObject({
      run: {
        runId: "run-doc-history",
        repoId: "docs",
        repoName: "Docs repo",
        repoPath: resolve(docsRepo),
      },
    });

    const runResponse = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
    });
    expect(runResponse.status).toBe(200);
    expect(runInput).toMatchObject({
      repoId: "docs",
      repoPath: resolve(docsRepo),
      workItemId: created.task.id,
    });
    expect(runInput?.flowPath).toBe(join(resolve(docsRepo), "flows/implement-spec-bootstrap.json"));
  });

  it("persists repositories added through the Web API and routes tasks to them", async () => {
    const defaultRepo = await createRepo();
    const appRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "app",
        name: "App repo",
        path: appRepo,
        defaultBranch: "main",
      }),
    });
    expect(addResponse.status).toBe(201);
    await expect(json(addResponse)).resolves.toMatchObject({
      repository: {
        id: "app",
        name: "App repo",
        path: resolve(appRepo),
        defaultBranch: "main",
      },
    });
    await expect(
      readFile(join(defaultRepo, ".nitely", "repositories.json"), "utf8"),
    ).resolves.toContain('"id": "app"');

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        expect.objectContaining({ id: "default", path: resolve(defaultRepo) }),
        expect.objectContaining({ id: "app", name: "App repo", path: resolve(appRepo) }),
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "app",
          title: "App task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; repoId?: string; repoName?: string; repoPath?: string } };
    expect(created.task).toMatchObject({
      repoId: "app",
      repoName: "App repo",
      repoPath: resolve(appRepo),
    });
    await expect(
      readFile(join(appRepo, ".nitely", "tasks", created.task.id, "task.json"), "utf8"),
    ).resolves.toContain('"repoId": "app"');
  });

  it("clones GitHub repositories from URL input before registering them", async () => {
    const defaultRepo = await createRepo();
    const clonedTargets: Array<{ url: string; targetPath: string }> = [];
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      cloneRepository: async ({ url, targetPath }) => {
        clonedTargets.push({ url, targetPath });
        await mkdir(join(targetPath, "flows"), { recursive: true });
        await writeFile(
          join(targetPath, "flows/implement-spec-bootstrap.json"),
          "{}",
          "utf8",
        );
      },
    });

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        githubUrl: "https://github.com/Instask/nitely/issues/79",
      }),
    });
    expect(addResponse.status).toBe(201);
    const expectedPath = join(resolve(defaultRepo), ".nitely", "repositories", "instask-nitely");
    await expect(json(addResponse)).resolves.toMatchObject({
      repository: {
        id: "instask-nitely",
        name: "Instask/nitely",
        path: expectedPath,
        sourceUrl: "https://github.com/Instask/nitely.git",
      },
    });
    expect(clonedTargets).toEqual([
      {
        url: "https://github.com/Instask/nitely.git",
        targetPath: expectedPath,
      },
    ]);
    await expect(
      readFile(join(defaultRepo, ".nitely", "repositories.json"), "utf8"),
    ).resolves.toContain('"sourceUrl": "https://github.com/Instask/nitely.git"');

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "instask-nitely",
          title: "Cloned repo task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { repoId?: string; repoName?: string; repoPath?: string } };
    expect(created.task).toMatchObject({
      repoId: "instask-nitely",
      repoName: "Instask/nitely",
      repoPath: expectedPath,
    });
  });

  it("rejects added repositories whose path does not exist", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing",
        path: join(defaultRepo, "missing-repo"),
      }),
    });

    expect(addResponse.status).toBe(400);
    await expect(json(addResponse)).resolves.toMatchObject({
      error: { message: "repository path must exist" },
    });
  });

  it("lists dev tasks as dev.pr work items through the generic work item API", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Dev item",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });

    const body = (await json(
      await fetch(`${server.url}/api/work-items`),
    )) as { workItems: { workItemType: string; inputs: Record<string, unknown> }[] };

    expect(body.workItems).toHaveLength(1);
    expect(body.workItems[0]?.workItemType).toBe("dev.pr");
    expect(body.workItems[0]?.inputs.spec).toBeDefined();
  });

  it("lists legacy tasks, generic work items, and inferred historical work items through the task API", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const server = await startTestServer(repoPath);

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Legacy task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const createdWorkItem = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic task",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "inputs/seed.json" } },
        }),
      }),
    )) as { workItem: { id: string } };
    await mkdir(join(repoPath, ".nitely/runs/run-historical"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/runs/run-historical/run.json"),
      JSON.stringify(
        {
          runId: "run-historical",
          status: "completed",
          flowName: "Historical flow",
          flowPath: "flows/autofarm-site.json",
          workItemId: "historical-task",
          workItemType: "autofarm.site",
          completedStages: ["discover"],
          inputs: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const body = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string; title: string; workItemType?: string; runCount?: number }>;
    };

    expect(body.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([
        createdTask.task.id,
        createdWorkItem.workItem.id,
        "historical-task",
      ]),
    );
    expect(body.tasks.find((task) => task.id === "historical-task")).toMatchObject({
      title: "Historical flow",
      workItemType: "autofarm.site",
      runCount: 1,
    });
  });

  it("returns generic task detail with input content, runs, and artifacts", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "inputs"), { recursive: true });
    await writeFile(join(repoPath, "inputs/spec.md"), "Generic spec", "utf8");
    await writeFile(join(repoPath, "inputs/tech.md"), "Generic design", "utf8");
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic detail",
          flowPath: "flows/autofarm-site.json",
          inputs: {
            seed: { connector: "local-file", uri: "inputs/seed.json" },
            spec: { connector: "local-file", uri: "inputs/spec.md" },
            "tech-design": { connector: "local-file", uri: "inputs/tech.md" },
          },
        }),
      }),
    )) as { workItem: { id: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-generic-detail");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify(
        {
          runId: "run-generic-detail",
          status: "completed",
          workItemId: created.workItem.id,
          workItemType: "autofarm.site",
          completedStages: ["discover", "deploy"],
          inputs: {},
          changeRequestUrl: "https://github.com/example/repo/pull/44",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "artifacts.json"),
      JSON.stringify(
        {
          runId: "run-generic-detail",
          artifacts: [
            {
              id: "site-plan",
              type: "autofarm.site-plan",
              producer: "discover",
              mediaType: "application/json",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(`${server.url}/api/tasks/${created.workItem.id}`);
    expect(response.status).toBe(200);
    const detail = (await json(response)) as {
      task: { id: string; workItemType: string };
      spec?: string;
      techDesign?: string;
      inputContents?: Record<string, string>;
      runs?: Array<{ runId: string; changeRequestUrl?: string }>;
      artifactsByType?: Array<{ type: string }>;
    };

    expect(detail).toMatchObject({
      task: { id: created.workItem.id, workItemType: "autofarm.site" },
      spec: "Generic spec",
      techDesign: "Generic design",
      inputContents: {
        spec: "Generic spec",
        "tech-design": "Generic design",
      },
      runs: [
        {
          runId: "run-generic-detail",
          changeRequestUrl: "https://github.com/example/repo/pull/44",
        },
      ],
      artifactsByType: [{ type: "autofarm.site-plan" }],
    });
  });

  it("returns inferred historical task detail as read-only with preserved latest run status", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await mkdir(join(repoPath, ".nitely/runs/run-historical-blocked"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/runs/run-historical-blocked/run.json"),
      JSON.stringify(
        {
          runId: "run-historical-blocked",
          status: "blocked",
          flowName: "Historical blocked flow",
          flowPath: "flows/implement-spec-bootstrap.json",
          workItemId: "historical-blocked-task",
          workItemType: "autofarm.site",
          completedStages: ["discover"],
          inputs: { seed: { sourceUri: "inputs/seed.json" } },
          blocker: { reason: "approval-required", stageId: "approve-plan" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(
      `${server.url}/api/tasks/historical-blocked-task`,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      readOnly: boolean;
      task: {
        id: string;
        status: string;
        displayStatus?: string;
        latestRunStatus?: string;
        readOnly?: boolean;
      };
      runs: Array<{ runId: string; status: string }>;
    };
    expect(body.readOnly).toBe(true);
    expect(body.task).toMatchObject({
      id: "historical-blocked-task",
      status: "failed",
      displayStatus: "blocked",
      latestRunStatus: "blocked",
      readOnly: true,
    });
    expect(body.runs).toEqual([
      expect.objectContaining({
        runId: "run-historical-blocked",
        status: "blocked",
      }),
    ]);
  });

  it("starts a generic stored work item through the unified task run route", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(repoPath, async (input) => {
      runInput = input;
      return {
        runId: "run-generic-task-route",
        branchName: "nitely/run-generic-task-route",
        worktreePath: join(repoPath, ".nitely/runs/run-generic-task-route/worktree"),
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic via task route",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      }),
    )) as { workItem: { id: string; workItemType: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.workItem.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      run: { runId: "run-generic-task-route" },
    });
    expect(runInput).toMatchObject({
      flowPath: join(repoPath, "flows/autofarm-site.json"),
      repoPath,
      inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      workItemId: created.workItem.id,
      workItemType: "autofarm.site",
    });
    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${created.workItem.id}`),
    )) as { task: { status: string; latestRunId?: string } };
    expect(detail.task).toMatchObject({
      status: "completed",
      latestRunId: "run-generic-task-route",
    });
  });

  it("accepts task runs before a delayed runner resolves and keeps final run detail observable", async () => {
    const repoPath = await createRepo();
    let releaseRunner!: () => void;
    let runnerStarted!: () => void;
    const runnerStartedPromise = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const releaseRunnerPromise = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-delayed";
      runnerStarted();
      await releaseRunnerPromise;
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
        changeRequestUrl: "https://github.com/example/repo/pull/149",
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Async task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const runResponsePromise = fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await runnerStartedPromise;
    const responseState = await Promise.race([
      runResponsePromise.then(() => "responded"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    let acceptedRunId = "";
    try {
      expect(responseState).toBe("responded");
      const runResponse = await runResponsePromise;
      expect(runResponse.status).toBe(200);
      const accepted = (await json(runResponse)) as {
        run: { runId: string; status: string; taskId?: string; branchName?: string };
      };
      acceptedRunId = accepted.run.runId;
      expect(accepted.run).toMatchObject({
        status: "running",
        taskId: created.task.id,
        branchName: `nitely/${accepted.run.runId}`,
      });

      const promptTaskDetail = (await json(
        await fetch(`${server.url}/api/tasks/${created.task.id}`),
      )) as { task: { status: string; latestRunId?: string } };
      expect(promptTaskDetail.task).toMatchObject({
        status: "running",
        latestRunId: acceptedRunId,
      });
    } finally {
      releaseRunner();
    }

    const finalTaskDetail = await waitFor(
      async () =>
        (await json(
          await fetch(`${server.url}/api/tasks/${created.task.id}`),
        )) as { task: { status: string; latestRunId?: string; changeRequestUrl?: string } },
      (body) => body.task.status === "completed",
    );
    expect(finalTaskDetail.task).toMatchObject({
      status: "completed",
      latestRunId: acceptedRunId,
      changeRequestUrl: "https://github.com/example/repo/pull/149",
    });

    const runDetail = (await json(
      await fetch(`${server.url}/api/runs/${acceptedRunId}`),
    )) as { run: { status: string; changeRequestUrl?: string } };
    expect(runDetail.run).toMatchObject({
      status: "completed",
      changeRequestUrl: "https://github.com/example/repo/pull/149",
    });
  });

  it("serves the tasks console at the legacy /work-items page route", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/work-items`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('data-screen-label="Tasks"');
    expect(html).toContain('path === "/work-items"');
  });

  it("creates and runs a non-dev work item without spec or tech-design inputs", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);

    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(repoPath, async (input) => {
      runInput = input;
      return {
        runId: "run-autofarm",
        branchName: "nitely/run-autofarm",
        worktreePath: join(repoPath, ".nitely/runs/run-autofarm/worktree"),
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      }),
    )) as { workItem: { id: string; workItemType: string } };
    expect(created.workItem.workItemType).toBe("autofarm.site");

    const runResponse = await fetch(
      `${server.url}/api/work-items/${created.workItem.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runInput?.workItemId).toBe(created.workItem.id);
    expect(runInput?.inputs.spec).toBeUndefined();
    expect(runInput?.inputs.seed).toEqual({
      connector: "local-file",
      uri: "seeds/k.json",
    });
  });

  it("blocks unapproved planning artifacts before running a work item", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const workItem = await createWorkItem(
      repoPath,
      {
        title: "Launch site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        planning: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
            techDesign: { path: "tech-design.md", state: "draft_tech_design" },
          },
          events: [],
        },
      },
      { createId: () => "wi-unapproved" },
    );

    let called = false;
    const server = await startTestServer(repoPath, async () => {
      called = true;
      throw new Error("runner must not be called");
    });

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST" },
    );

    expect(runResponse.status).toBe(400);
    expect(await json(runResponse)).toEqual({
      error: {
        code: "invalid_input",
        message: expect.stringMatching(/tech design must be approved/i),
      },
    });
    expect(called).toBe(false);
  });

  it("blocks work item runs after spec approval until technical design exists", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const workItem = await createWorkItem(
      repoPath,
      {
        title: "Launch site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        planning: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
          },
          events: [],
        },
      },
      { createId: () => "wi-missing-tech-design" },
    );

    let called = false;
    const server = await startTestServer(repoPath, async () => {
      called = true;
      throw new Error("runner must not be called");
    });

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      runResponse,
      "draft technical design is required before starting a run",
    );
    expect(called).toBe(false);
  });

  it("passes task scope from work item run API requests to the runner", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);

    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(repoPath, async (input) => {
      runInput = input;
      return {
        runId: "run-scoped-api",
        branchName: "nitely/run-scoped-api",
        worktreePath: join(repoPath, ".nitely/runs/run-scoped-api/worktree"),
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: "flows/autofarm-site.json",
          inputs: {
            seed: { connector: "local-file", uri: "seeds/k.json" },
            tasks: { connector: "local-file", uri: "docs/tasks.md" },
          },
        }),
      }),
    )) as { workItem: { id: string } };

    const runResponse = await fetch(
      `${server.url}/api/work-items/${created.workItem.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskScope: { inputId: "tasks", expression: "T001-T003" },
        }),
      },
    );

    expect(runResponse.status).toBe(200);
    expect(runInput?.taskScope).toEqual({
      inputId: "tasks",
      expression: "T001-T003",
    });
  });

  it.each([
    {
      name: "traverses outside flows",
      flowPath: "flows/../outside.json",
      prepare: async (repoPath: string, secretMarker: string) => {
        await writeNonDevFlow(join(repoPath, "outside.json"), secretMarker);
      },
    },
    {
      name: "uses an absolute path",
      flowPath: (repoPath: string) => resolve(repoPath, "flows/absolute.json"),
      prepare: async (repoPath: string, secretMarker: string) => {
        await writeNonDevFlow(
          join(repoPath, "flows/absolute.json"),
          secretMarker,
        );
      },
    },
    {
      name: "uses a symlink that escapes flows",
      flowPath: "flows/escape.json",
      prepare: async (repoPath: string, secretMarker: string) => {
        const outside = await mkdtemp(join(tmpdir(), "nitely-web-server-flow-"));
        await writeNonDevFlow(join(outside, "escape.json"), secretMarker);
        await symlink(join(outside, "escape.json"), join(repoPath, "flows/escape.json"));
      },
    },
  ])(
    "rejects POST /api/work-items when flowPath $name",
    async ({ flowPath, prepare }) => {
      const repoPath = await createRepo();
      const secretMarker = `escaped-flow-secret-${randomUUID()}`;
      await allowAutofarmWorkItems(repoPath);
      await prepare(repoPath, secretMarker);
      const server = await startTestServer(repoPath);

      const response = await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: typeof flowPath === "function" ? flowPath(repoPath) : flowPath,
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(JSON.stringify(body)).not.toContain(secretMarker);
      expect(await workItemDirectoryEntries(repoPath)).toEqual([]);
    },
  );

  it("returns a client error when a work item flow fails validation", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "flows/broken.json"),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "broken", workItemType: "some.experimental" },
        spec: {
          stages: [
            { id: "build", type: "command", command: "true", inputs: ["missing"], outputs: ["out"] },
          ],
        },
      }),
      "utf8",
    );
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Broken",
        flowPath: "flows/broken.json",
        inputs: {},
      }),
    });

    expect(response.status).toBe(400);
  });

  it("allows starting another run after a task already has a completed run", async () => {
    const repoPath = await createRepo();
    const runIds = ["run-first", "run-second"];
    const server = await startTestServer(repoPath, async () => {
      const runId = runIds.shift() ?? "run-extra";
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Repeatable run task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    expect(
      (await json(
        await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
          method: "POST",
        }),
      )) as unknown,
    ).toMatchObject({ run: { runId: "run-first" } });

    const secondResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(secondResponse.status).toBe(200);
    expect(await json(secondResponse)).toMatchObject({
      run: { runId: "run-second" },
    });
    const detailBody = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as { task: { latestRunId?: string } };
    expect(detailBody.task.latestRunId).toBe("run-second");
  });

  it("uses an injected provider store for provider statuses and writes without echoing secrets", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const clears: ProviderId[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [
        {
          id: "glm",
          name: "GLM / Zhipu",
          configured: true,
          message: "Configured in injected test store.",
          hints: ["NITELY_GLM_API_KEY"],
        },
      ],
      setConnection: async (input) => {
        writes.push(input);
      },
      clearConnection: async (providerId) => {
        clears.push(providerId);
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);

    const statuses = await json(await fetch(`${server.url}/api/providers`));
    expect(statuses).toEqual({
      providers: [
        {
          id: "glm",
          name: "GLM / Zhipu",
          configured: true,
          message: "Configured in injected test store.",
          hints: ["NITELY_GLM_API_KEY"],
        },
      ],
    });

    const secret = "sk-injected-secret";
    const postResponse = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });
    expect(postResponse.status).toBe(200);
    const postBody = await json(postResponse);
    expect(postBody).toEqual({ ok: true });
    expect(JSON.stringify(postBody)).not.toContain(secret);
    expect(writes).toEqual([{ providerId: "glm", value: secret }]);

    const deleteResponse = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await json(deleteResponse)).toEqual({ ok: true });
    expect(clears).toEqual(["glm"]);
  });

  it("rejects unknown provider connection writes with a JSON 404 error", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
      setConnection: async (input) => {
        writes.push(input);
      },
      clearConnection: async () => {
        throw new Error("unused");
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-unknown-provider";

    const response = await fetch(`${server.url}/api/providers/unknown/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "provider not found",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(writes).toEqual([]);
  });

  it("rejects non-writable provider connection writes with a JSON 400 error", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
      setConnection: async (input) => {
        writes.push(input);
      },
      clearConnection: async () => {
        throw new Error("unused");
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-codex-provider";

    const response = await fetch(`${server.url}/api/providers/codex/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "invalid_input",
        message: "provider does not support Web Console connection writes",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(writes).toEqual([]);
  });

  it("rejects provider connection writes when the store is read-only", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-read-only-store";

    const response = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "invalid_input",
        message: "provider connection store is read-only",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("passes the injected provider store into task runs", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({ NITELY_GLM_API_KEY: "stored-glm" }),
      listStatuses: async () => [],
    };
    let runDependencies: RunFlowDependencies | undefined;
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        runDependencies = dependencies;
        return {
          runId: "run-web-provider-store",
          branchName: "nitely/run-web-provider-store",
          worktreePath: join(repoPath, ".nitely/runs/run-web-provider-store/worktree"),
        };
      },
      providerStore,
    );
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run with provider store",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(runDependencies?.providerStore).toBe(providerStore);
  });
});
