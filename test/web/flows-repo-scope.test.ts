import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { openFlowStore } from "../../src/flows/store.js";
import { addOrganizationMember, listPublicMemberships } from "../../src/web/organizations.js";
import { createUser } from "../../src/web/users.js";
import { startWebServer, type StartWebServerInput, type WebServer } from "../../src/web/server.js";

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function flow(metadata: Record<string, unknown>, inputs: string[] = []): string {
  return JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata,
    spec: { stages: [{ id: "build", type: "command", command: "true", inputs, outputs: ["out"] }] },
  });
}

async function createRepo(label: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `nitely-flow-scope-${label}-`));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(join(repo, "flows/shipped.json"), flow({ name: "shipped" }), "utf8");
  return repo;
}

async function start(
  home: string,
  b: string,
  options: Partial<StartWebServerInput> = {},
  bOrganizationId?: string,
) {
  const server = await startWebServer({
    repoPath: home,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    ...options,
    repositories: [
      { id: "home", name: "home", path: home },
      { id: "repo-b", name: "repo-b", path: b, ...(bOrganizationId ? { organizationId: bOrganizationId } : {}) },
    ],
  });
  servers.push(server);
  return server;
}

async function call(
  server: WebServer,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
  organizationId?: string,
) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(organizationId ? { "x-nitely-organization-id": organizationId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

async function login(server: WebServer, email: string, password: string): Promise<string> {
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const research = encodeURIComponent("flows/research-pipeline.json");

describe("repository-scoped Flow templates", () => {
  it("lists and copies templates from the selected repository's catalog only", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const server = await start(home, b);

    const ids = async (query: string) =>
      ((await call(server, "GET", `/api/flows/templates${query}`)).body.templates as Array<{ id: string }>)
        .map((template) => template.id);

    expect(await ids("?repoId=repo-b")).toContain("research-pipeline");
    expect((await call(server, "PUT", `/api/flows/${research}?repoId=repo-b`, { enabled: false })).status).toBe(200);
    expect(await ids("?repoId=repo-b")).not.toContain("research-pipeline");
    expect(await ids("")).toContain("research-pipeline");
    expect(await ids("?repoId=home")).toContain("research-pipeline");
    expect((await call(server, "POST", "/api/flows/from-template?repoId=repo-b", { templateId: "research-pipeline" })).status)
      .toBe(400);

    // Edit the built-in Flow in B: B's template copies the edit, home's does not.
    await call(server, "PUT", `/api/flows/${research}?repoId=repo-b`, { enabled: true });
    const shown = await call(server, "GET", `/api/flows/${research}?repoId=repo-b`);
    const edited = (shown.body.flow.document as string).replace(
      "Research the task and cite evidence.",
      "Research in repo B.",
    );
    expect(edited).not.toBe(shown.body.flow.document);
    expect((await call(server, "PUT", `/api/flows/${research}?repoId=repo-b`, { document: edited })).status).toBe(200);

    const copiedB = await call(server, "POST", "/api/flows/from-template", {
      repoId: "repo-b",
      templateId: "research-pipeline",
      name: "b-copy",
    });
    expect(copiedB.status).toBe(201);
    expect(copiedB.body.flow.document).toContain("Research in repo B.");
    const copiedHome = await call(server, "POST", "/api/flows/from-template", {
      templateId: "research-pipeline",
      name: "home-copy",
    });
    expect(copiedHome.status).toBe(201);
    expect(copiedHome.body.flow.document).not.toContain("Research in repo B.");

    const names = async (query: string) =>
      ((await call(server, "GET", `/api/flows${query}`)).body.flows as Array<{ name: string }>).map((f) => f.name);
    expect(await names("?repoId=repo-b")).toContain("b-copy");
    expect(await names("?repoId=repo-b")).not.toContain("home-copy");
    expect(await names("")).toContain("home-copy");
    expect(await names("")).not.toContain("b-copy");
    expect((await call(server, "GET", "/api/flows/templates?repoId=nope")).status).toBe(404);
  });
});

describe("repository-scoped flowId for work items", () => {
  it("uses a user Flow that exists only in the target repository", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const server = await start(home, b);
    const created = await call(server, "POST", "/api/flows?repoId=repo-b", { document: flow({ name: "only-b" }) });
    expect(created.status).toBe(201);
    const flowId = created.body.flow.id as string;

    const inB = await call(server, "POST", "/api/work-items", { title: "b", repoId: "repo-b", flowId });
    expect(inB.status).toBe(201);
    expect(inB.body.workItem).toMatchObject({ flowId, repoId: "repo-b" });
    expect((await call(server, "POST", "/api/work-items", { title: "home", flowId })).status).toBe(404);
  });

  it("authorizes the same Flow id against the target repository's record", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const alice = await createUser(home, { email: "alice@example.test", password: "alice password passphrase", role: "user" });
    const bob = await createUser(home, { email: "bob@example.test", password: "bob password passphrase", role: "user" });
    for (const [repo, owner] of [[home, alice.id], [b, bob.id]] as const) {
      const store = openFlowStore(repo);
      store.createFlow({ name: `owned-${owner}`, document: flow({ name: "same" }), ownerId: owner }, { createId: () => "flow-same" });
      store.close();
    }
    const [team] = await listPublicMemberships(home, alice.id);
    await addOrganizationMember(home, team!.organizationId, { userId: bob.id, role: "member" });
    const org = team!.organizationId;
    const server = await start(home, b, { authMode: "required", providerEnv: {} }, org);
    const bobCookie = await login(server, "bob@example.test", "bob password passphrase");
    const aliceCookie = await login(server, "alice@example.test", "alice password passphrase");
    const create = (repoId: string, cookie: string) =>
      call(server, "POST", "/api/work-items", { title: repoId, repoId, flowId: "flow-same" }, cookie, org);

    // Both users can see both repositories; only the Flow record differs.
    expect((await create("repo-b", bobCookie)).status).toBe(201);
    expect((await create("home", bobCookie)).status).toBe(404);
    expect((await create("repo-b", aliceCookie)).status).toBe(404);
    expect((await create("home", aliceCookie)).status).toBe(201);
    expect((await call(server, "GET", "/api/flows/flow-same?repoId=repo-b", undefined, aliceCookie, org)).status).toBe(404);
    expect((await call(server, "GET", "/api/flows/flow-same?repoId=repo-b", undefined, bobCookie, org)).status).toBe(200);
  });
});

describe("Web task creation from a catalog user Flow", () => {
  const taskBody = (flowPath: string, extra: Record<string, unknown> = {}) => ({
    title: "catalog task",
    spec: "# Spec\n\nDo it.\n",
    techDesign: "# Design\n\nPlan.\n",
    flowPath,
    ...extra,
  });

  it("accepts a stored Flow id and runs preflight against the stored document", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const store = openFlowStore(home);
    store.createFlow(
      { name: "catalog-only", document: flow({ name: "catalog-only" }, ["spec", "tech-design"]) },
      { createId: () => "flow-catalog-only" },
    );
    store.close();
    const server = await start(home, b);

    const created = await call(server, "POST", "/api/tasks", taskBody("flow-catalog-only"));
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ flowPath: "flow-catalog-only", flowId: "flow-catalog-only" });

    const preflight = await call(server, "GET", `/api/tasks/${created.body.task.id}/preflight`);
    expect(preflight.status).toBe(200);
    expect(preflight.body.preflight).toMatchObject({ flowPath: "flow-catalog-only", flowName: "catalog-only" });
  });

  it("refuses unknown, disabled, and other users' stored Flows like a missing path", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const alice = await createUser(home, { email: "alice@example.test", password: "alice password passphrase", role: "user" });
    await createUser(home, { email: "bob@example.test", password: "bob password passphrase", role: "user" });
    const store = openFlowStore(home);
    store.createFlow({ name: "alice-only", document: flow({ name: "alice-only" }), ownerId: alice.id }, { createId: () => "flow-alice" });
    store.close();
    const server = await start(home, b, { authMode: "required", providerEnv: {} });
    const bobCookie = await login(server, "bob@example.test", "bob password passphrase");
    const aliceCookie = await login(server, "alice@example.test", "alice password passphrase");

    const missing = await call(server, "POST", "/api/tasks", taskBody("flow-nope"), aliceCookie);
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/flow path must exist inside the repository/);
    const foreign = await call(server, "POST", "/api/tasks", taskBody("flow-alice"), bobCookie);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toMatch(/flow path must exist inside the repository/);
    expect((await call(server, "POST", "/api/tasks", taskBody("flow-alice"), aliceCookie)).status).toBe(201);

    expect((await call(server, "PUT", "/api/flows/flow-alice", { enabled: false }, aliceCookie)).status).toBe(200);
    const disabled = await call(server, "POST", "/api/tasks", taskBody("flow-alice"), aliceCookie);
    expect(disabled.status).toBe(400);
    expect(disabled.body.error.message).toMatch(/flow is disabled/);
  });
});

describe("Web Flow document replacement", () => {
  it("clears workItemType removed from the document, consistently with the runtime", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const server = await start(home, b);
    const created = await call(server, "POST", "/api/flows", {
      document: flow({ name: "typed", workItemType: "report.generation" }),
    });
    const id = created.body.flow.id as string;
    expect(created.body.flow.workItemType).toBe("report.generation");

    const replaced = await call(server, "PUT", `/api/flows/${id}`, { document: flow({ name: "untyped" }) });
    expect(replaced.status).toBe(200);
    expect(replaced.body.flow).toMatchObject({ name: "untyped" });
    expect(replaced.body.flow.workItemType).toBeUndefined();

    const toggled = await call(server, "PUT", `/api/flows/${id}`, { enabled: false });
    expect(toggled.body.flow).toMatchObject({ name: "untyped", enabled: false });
    expect(toggled.body.flow.workItemType).toBeUndefined();
    await call(server, "PUT", `/api/flows/${id}`, { enabled: true });

    expect((await call(server, "GET", `/api/flows/${id}`)).body.flow.workItemType).toBe("dev.pr");
    const item = await call(server, "POST", "/api/work-items", { title: "x", flowId: id });
    expect(item.status).toBe(201);
    expect(item.body.workItem.workItemType).toBe("dev.pr");
    const listed = await runCli(["flow", "show", id, "--repo", home, "--json"], { stdout: () => {}, stderr: () => {} }, { env: {} });
    expect(listed).toBe(0);
  });
});

describe("remote nitely flow against a non-home repository", () => {
  it("targets every subcommand at --repo-id", async () => {
    const home = await createRepo("home");
    const b = await createRepo("b");
    const server = await start(home, b);
    const out: string[] = [];
    const err: string[] = [];
    const cli = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      return await runCli(["flow", ...argv, "--server", server.url, "--repo-id", "repo-b"], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      }, { env: {}, fetch });
    };

    expect(await cli("disable", "flows/shipped.json")).toBe(0);
    const homeShipped = (await call(server, "GET", `/api/flows/${encodeURIComponent("flows/shipped.json")}`)).body.flow;
    const bShipped = (await call(server, "GET", `/api/flows/${encodeURIComponent("flows/shipped.json")}?repoId=repo-b`)).body.flow;
    expect(homeShipped.enabled).toBe(true);
    expect(bShipped.enabled).toBe(false);
    expect(await cli("enable", "flows/shipped.json")).toBe(0);

    const file = join(b, "update.json");
    await writeFile(file, flow({ name: "b-updated" }), "utf8");
    expect(await cli("update", "flows/shipped.json", "--file", file)).toBe(0);
    expect(await cli("show", "flows/shipped.json")).toBe(0);
    expect(JSON.parse(out.join("\n")).metadata.name).toBe("b-updated");
    expect((await call(server, "GET", `/api/flows/${encodeURIComponent("flows/shipped.json")}`)).body.flow.name)
      .toBe("shipped");

    expect(await cli("list", "--json")).toBe(0);
    expect((JSON.parse(out[0]!).flows as Array<{ name: string }>).map((f) => f.name)).toContain("b-updated");

    expect(await cli("reset", "flows/shipped.json")).toBe(0);
    expect(await cli("show", "flows/shipped.json")).toBe(0);
    expect(JSON.parse(out.join("\n")).metadata.name).toBe("shipped");

    const created = await call(server, "POST", "/api/flows?repoId=repo-b", { document: flow({ name: "b-user" }) });
    const userId = created.body.flow.id as string;
    expect(await cli("delete", userId)).toBe(0);
    expect((await call(server, "GET", `/api/flows/${userId}?repoId=repo-b`)).status).toBe(404);
    expect(await cli("delete", "flows/shipped.json")).toBe(1);

    expect(await runCli(["flow", "list", "--repo", b, "--repo-id", "repo-b"], {
      stdout: () => {},
      stderr: (line) => err.push(line),
    }, { env: {} })).toBe(1);
  });
});

describe("repository-scoped Flow reset", () => {
  const foo = encodeURIComponent("flows/foo.json");
  async function setup() {
    const home = await createRepo("home");
    const b = await createRepo("b");
    for (const repo of [home, b]) {
      await writeFile(join(repo, "flows/foo.json"), flow({ name: "foo", description: "shipped" }), "utf8");
    }
    const server = await start(home, b);
    const customize = async (query: string, description: string) =>
      expect((await call(server, "PUT", `/api/flows/${foo}${query}`, {
        document: flow({ name: "foo", description }),
      })).status).toBe(200);
    await customize("", "home custom");
    await customize("?repoId=repo-b", "repo-b custom");
    const doc = async (query: string) =>
      (await call(server, "GET", `/api/flows/${foo}${query}`)).body.flow.document as string;
    return { server, doc };
  }

  it("resets only the repository named by repoId in the JSON body", async () => {
    const { server, doc } = await setup();
    const reset = await call(server, "POST", `/api/flows/${foo}/reset`, { repoId: "repo-b" });
    expect(reset.status).toBe(200);
    expect(await doc("?repoId=repo-b")).toContain("\"shipped\"");
    expect(await doc("?repoId=repo-b")).not.toContain("repo-b custom");
    expect(await doc("")).toContain("home custom");
  });

  it("still resolves repoId from the query string", async () => {
    const { server, doc } = await setup();
    expect((await call(server, "POST", `/api/flows/${foo}/reset?repoId=repo-b`)).status).toBe(200);
    expect(await doc("?repoId=repo-b")).not.toContain("repo-b custom");
    expect(await doc("")).toContain("home custom");
    expect((await call(server, "POST", `/api/flows/${foo}/reset`, { repoId: "nope" })).status).toBe(404);
  });
});
