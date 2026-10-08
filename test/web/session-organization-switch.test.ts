import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSession, createUser } from "../../src/web/users.js";
import {
  changeOrganizationMember,
  createOrganization,
  DEFAULT_ORGANIZATION_SECURITY_POLICY as defaults,
  listPublicMemberships,
  updateOrganizationSecurityPolicy,
} from "../../src/web/organizations.js";
import { startWebServer } from "../../src/web/server.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { createTask } from "../../src/web/tasks.js";

const repos: string[] = [];
afterEach(async () => { await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))); });

async function gitRepo(prefix: string) {
  const repo = await mkdtemp(join(tmpdir(), prefix)); repos.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  await mkdir(join(repo, "flows"));
  await writeFile(join(repo, "flows/implement-spec-bootstrap.json"), JSON.stringify({ apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "implement-spec-bootstrap" }, spec: { stages: [{ id: "implement", type: "agent", runtime: "mock", prompt: "Implement", inputs: ["spec", "tech-design"], outputs: ["implementation"] }] } }));
  return repo;
}

/**
 * A member of two organizations: their own default workspace (A) and a shared
 * one (B) owned by someone else, each with its own repository and task.
 */
async function fixture(memberRole: "user" | "admin" = "user") {
  const repo = await gitRepo("nitely-session-org-switch-");
  const repoA = await gitRepo("nitely-session-org-switch-a-");
  const repoB = await gitRepo("nitely-session-org-switch-b-");
  const owner = await createUser(repo, { email: "owner@example.test", password: "owner-password-passphrase", role: "admin" });
  const member = await createUser(repo, { email: "member@example.test", password: "member-password-passphrase", role: memberRole });
  const orgA = (await listPublicMemberships(repo, member.id))[0].organizationId;
  const orgB = (await createOrganization(repo, { name: "Shared B", members: { [owner.id]: "owner", [member.id]: "member" } })).id;
  const taskA = await createTask(repoA, { title: "Task in A", spec: "Spec", techDesign: "Design" }, { ownerId: member.id, organizationId: orgA });
  const taskB = await createTask(repoB, { title: "Task in B", spec: "Spec", techDesign: "Design" }, { ownerId: owner.id, organizationId: orgB });
  return { repo, repoA, repoB, owner, member, orgA, orgB, taskA, taskB };
}

async function serve(f: Awaited<ReturnType<typeof fixture>>, authMode: "required" | "local" = "required") {
  return await startWebServer({
    repoPath: f.repo, host: "127.0.0.1", port: 0, authMode, authEnv: {}, providerEnv: {},
    repositories: [
      { id: "repo-a", path: f.repoA, organizationId: f.orgA },
      { id: "repo-b", path: f.repoB, organizationId: f.orgB },
    ],
  });
}

function client(url: string, cookie: string) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { cookie, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json };
  };
}

async function sessionFile(repo: string, sessionId: string) {
  return JSON.parse(await readFile(join(repo, ".nitely", "users", "sessions", `${sessionId}.json`), "utf8"));
}

it("A1: a password session switches workspace, and task creation then uses it without a header", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    const repoOf = { [f.orgA]: "repo-a", [f.orgB]: "repo-b" };
    const roleOf = Object.fromEntries((await listPublicMemberships(f.repo, f.member.id)).map((m) => [m.organizationId, m.role]));
    const createIn = (organizationId: string) =>
      call("POST", "/api/tasks", { repoId: repoOf[organizationId], title: "Created", spec: "s", techDesign: "d" });
    // Switch away from whatever the implicit default is, then back.
    const initial: string = (await call("GET", "/api/session")).json.user.currentOrganizationId;
    for (const target of [initial === f.orgA ? f.orgB : f.orgA, initial]) {
      const other = target === f.orgA ? f.orgB : f.orgA;
      const switched = await call("PUT", "/api/session/organization", { organizationId: target });
      expect(switched.status).toBe(200);
      expect(switched.json.currentOrganizationId).toBe(target);

      const me = (await call("GET", "/api/session")).json.user;
      expect(me.currentOrganizationId).toBe(target);
      expect(me.currentOrganizationRole).toBe(roleOf[target]);
      expect((await sessionFile(f.repo, session.id)).selectedOrganizationId).toBe(target);

      // Writes follow the selected workspace: its repository accepts the
      // task, the other workspace's repository is out of scope.
      const created = await createIn(target);
      expect(created.status).toBe(201);
      expect(created.json.task.organizationId).toBe(target);
      expect((await createIn(other)).status).toBe(404);
    }
  } finally { await server.close(); }
});

it("A2: after removal from the selected organization the session falls back, loses access, and forgets the selection", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    expect((await call("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(200);
    expect((await call("GET", `/api/tasks/${f.taskB.id}`)).status).toBe(200);

    await changeOrganizationMember(f.repo, f.orgB, f.owner, f.member.id);

    expect((await call("GET", "/api/session")).json.user.currentOrganizationId).toBe(f.orgA);
    expect((await call("GET", `/api/tasks/${f.taskB.id}`)).status).toBe(404);
    expect((await sessionFile(f.repo, session.id)).selectedOrganizationId).toBeUndefined();
    const orgs = (await call("GET", "/api/session/organizations")).json;
    expect(orgs.organizations.map((o: { organizationId: string }) => o.organizationId)).toEqual([f.orgA]);
  } finally { await server.close(); }
});

it("A2: removal revokes a global admin's selection too, even though admin scopes span every organization", async () => {
  const f = await fixture("admin");
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    expect((await call("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(200);
    await changeOrganizationMember(f.repo, f.orgB, f.owner, f.member.id);
    expect((await call("GET", "/api/session")).json.user.currentOrganizationId).toBe(f.orgA);
    expect((await sessionFile(f.repo, session.id)).selectedOrganizationId).toBeUndefined();
  } finally { await server.close(); }
});

it("A3: switching to an organization the user does not belong to is forbidden and keeps the current one", async () => {
  const f = await fixture();
  const stranger = await createOrganization(f.repo, { name: "Stranger", members: { [f.owner.id]: "owner" } });
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    const denied = await call("PUT", "/api/session/organization", { organizationId: stranger.id });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("forbidden");
    expect((await call("PUT", "/api/session/organization", { organizationId: "org_does_not_exist" })).status).toBe(403);
    expect((await call("GET", "/api/session")).json.user.currentOrganizationId).toBe(f.orgA);
    expect((await sessionFile(f.repo, session.id)).selectedOrganizationId).toBeUndefined();
  } finally { await server.close(); }
});

it("A4: an SSO session stays bound to its organization", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    for (const authenticationMethod of ["oidc", "saml"] as const) {
      const session = await createSession(f.repo, f.member.id, { authenticationMethod, organizationId: f.orgA });
      const call = client(server.url, "nitely_session=" + session.id);
      const denied = await call("PUT", "/api/session/organization", { organizationId: f.orgB });
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe("sso_session_bound");
      expect((await call("GET", "/api/session")).json.user.currentOrganizationId).toBe(f.orgA);
      const same = await call("PUT", "/api/session/organization", { organizationId: f.orgA });
      expect(same.status).toBe(200);
      expect(same.json.currentOrganizationId).toBe(f.orgA);
    }
  } finally { await server.close(); }
});

it("A5: the organization list holds exactly one current entry and omits organizations whose policy denies the session", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    const listed = await call("GET", "/api/session/organizations");
    expect(listed.status).toBe(200);
    const current: string = (await call("GET", "/api/session")).json.user.currentOrganizationId;
    expect(listed.json.currentOrganizationId).toBe(current);
    const memberships = await listPublicMemberships(f.repo, f.member.id);
    expect(listed.json.organizations).toHaveLength(2);
    expect(listed.json.organizations).toEqual(expect.arrayContaining(memberships.map((m) => ({
      organizationId: m.organizationId, organizationName: m.organizationName, role: m.role, current: m.organizationId === current,
    }))));
    expect(listed.json.organizations.filter((o: { current: boolean }) => o.current)).toHaveLength(1);
    expect(listed.json.organizations.find((o: { organizationId: string }) => o.organizationId === f.orgB).role).toBe("member");

    // B now requires SSO, which a password session cannot satisfy.
    await updateOrganizationSecurityPolicy(f.repo, f.orgB, f.owner, { ...defaults, ssoRequired: true });
    const after = (await call("GET", "/api/session/organizations")).json;
    expect(after.organizations.map((o: { organizationId: string }) => o.organizationId)).toEqual([f.orgA]);
    expect((await call("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(403);
  } finally { await server.close(); }
});

it("A6: local auth mode does not expose the endpoints", async () => {
  const f = await fixture();
  const server = await serve(f, "local");
  try {
    const call = client(server.url, "");
    expect((await call("GET", "/api/session/organizations")).status).toBe(404);
    expect((await call("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(404);
  } finally { await server.close(); }
});

it("rejects a missing session with 401 and a malformed body with 400", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const anonymous = client(server.url, "");
    expect((await anonymous("GET", "/api/session/organizations")).status).toBe(401);
    expect((await anonymous("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(401);
    const call = client(server.url, "nitely_session=" + (await createSession(f.repo, f.member.id)).id);
    expect((await call("PUT", "/api/session/organization", {})).status).toBe(400);
    expect((await call("PUT", "/api/session/organization", { organizationId: "  " })).status).toBe(400);
    expect((await call("PUT", "/api/session/organization", { organizationId: 7 })).status).toBe(400);
  } finally { await server.close(); }
});

it("audits allowed and denied switches", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const call = client(server.url, "nitely_session=" + (await createSession(f.repo, f.member.id)).id);
    await call("PUT", "/api/session/organization", { organizationId: f.orgB });
    await call("PUT", "/api/session/organization", { organizationId: "org_does_not_exist" });
    const switches = (await listSecurityAuditEvents(f.repo, { limit: 100 })).filter((e) => e.action === "auth.organization.switch");
    expect(switches).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "allow", outcome: "success", httpStatus: 200, target: { type: "organization", id: f.orgB } }),
      expect.objectContaining({ decision: "deny", httpStatus: 403, reasonCode: "forbidden", target: { type: "organization", id: "org_does_not_exist" } }),
    ]));
    // Listing organizations is not a switch.
    await call("GET", "/api/session/organizations");
    expect((await listSecurityAuditEvents(f.repo, { limit: 100 })).filter((e) => e.action === "auth.organization.switch")).toHaveLength(2);
  } finally { await server.close(); }
});

it("a per-request organization header overrides one request without replacing or clearing the persisted selection", async () => {
  const f = await fixture();
  const server = await serve(f);
  try {
    const session = await createSession(f.repo, f.member.id);
    const call = client(server.url, "nitely_session=" + session.id);
    const newTask = { repoId: "repo-a", title: "Header scoped", spec: "s", techDesign: "d" };
    expect((await call("PUT", "/api/session/organization", { organizationId: f.orgB })).status).toBe(200);
    expect((await call("POST", "/api/tasks", newTask)).status).toBe(404);
    const scoped = await call("POST", "/api/tasks", newTask, { "x-nitely-organization-id": f.orgA });
    expect(scoped.status).toBe(201);
    expect(scoped.json.task.organizationId).toBe(f.orgA);
    expect((await call("GET", "/api/session")).json.user.currentOrganizationId).toBe(f.orgB);
    expect((await sessionFile(f.repo, session.id)).selectedOrganizationId).toBe(f.orgB);
  } finally { await server.close(); }
});
