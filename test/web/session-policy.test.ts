import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSession, createUser, deleteSession, readSessionUser } from "../../src/web/users.js";
import { addOrganizationMember, changeOrganizationMember, createOrganization, DEFAULT_ORGANIZATION_SECURITY_POLICY as defaults, listPublicMemberships, revokeOrganizationSessions, updateOrganizationSecurityPolicy } from "../../src/web/organizations.js";
import { startWebServer } from "../../src/web/server.js";
import { listSecurityAuditEvents, securityAuditPath } from "../../src/web/security-audit.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import { createTask } from "../../src/web/tasks.js";

const repos: string[] = [];
afterEach(async () => { await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))); });
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-session-policy-")); repos.push(repo);
  const owner = await createUser(repo, { email: "owner@example.test", password: "owner-password-passphrase", role: "admin" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  return { repo, owner, org };
}

it("enforces idle/lifetime on the server clock, without inspection extending idle, and serializes logout with touches", async () => {
  const f = await fixture(); const start = Date.now();
  const now = (delta: number) => () => new Date(start + delta);
  await updateOrganizationSecurityPolicy(f.repo, f.org, f.owner, { ...defaults, idleTimeoutSeconds: 1, maxSessionLifetimeSeconds: 3 });
  const session = await createSession(f.repo, f.owner.id, { now: now(0) });
  expect(await readSessionUser(f.repo, session.id, { now: now(500) })).not.toBeNull();
  expect(await readSessionUser(f.repo, session.id, { now: now(1400) })).not.toBeNull();
  expect(await readSessionUser(f.repo, session.id, { now: now(2399), touch: false })).not.toBeNull();
  expect(await readSessionUser(f.repo, session.id, { now: now(2400) })).toBeNull();
  const fresh = await createSession(f.repo, f.owner.id, { now: now(0) });
  for (const delta of [900, 1800, 2700]) expect(await readSessionUser(f.repo, fresh.id, { now: now(delta) })).not.toBeNull();
  expect(await readSessionUser(f.repo, fresh.id, { now: now(3000) })).toBeNull();
  const logout = await createSession(f.repo, f.owner.id);
  await Promise.all([readSessionUser(f.repo, logout.id), deleteSession(f.repo, logout.id)]);
  expect(await readSessionUser(f.repo, logout.id)).toBeNull();
});

it("revokes only the selected organization/user and keeps old sessions revoked after removal/rejoin", async () => {
  const f = await fixture();
  const member = await createUser(f.repo, { email: "member@example.test", password: "member-password-passphrase", role: "user" });
  await addOrganizationMember(f.repo, f.org, { userId: member.id, role: "member" });
  const other = (await listPublicMemberships(f.repo, member.id)).find((membership) => membership.organizationId !== f.org)!.organizationId;
  const session = await createSession(f.repo, member.id);
  const ownerSession = await createSession(f.repo, f.owner.id);
  await revokeOrganizationSessions(f.repo, f.org, f.owner, member.id);
  expect(await readSessionUser(f.repo, session.id, { organizationId: f.org })).toBeNull();
  expect(await readSessionUser(f.repo, session.id, { organizationId: other })).not.toBeNull();
  expect(await readSessionUser(f.repo, ownerSession.id, { organizationId: f.org })).not.toBeNull();
  const fresh = await createSession(f.repo, member.id);
  expect(await readSessionUser(f.repo, fresh.id, { organizationId: f.org })).not.toBeNull();
  await changeOrganizationMember(f.repo, f.org, f.owner, member.id);
  await addOrganizationMember(f.repo, f.org, { userId: member.id, role: "member" });
  expect(await readSessionUser(f.repo, fresh.id, { organizationId: f.org })).toBeNull();
  await revokeOrganizationSessions(f.repo, f.org, f.owner);
  expect(await readSessionUser(f.repo, ownerSession.id, { organizationId: f.org })).toBeNull();
});

it("enforces SSO scope on real APIs, blocks workspace-switch bypass, and audits explicit policy-only admin recovery", async () => {
  const f = await fixture(); execFileSync("git", ["init", "-q", f.repo]);
  const other = await createOrganization(f.repo, { name: "Other", members: { [f.owner.id]: "owner" } });
  const outsider = await createUser(f.repo, { email: "outsider@example.test", password: "outsider-password-passphrase", role: "admin" });
  const member = await createUser(f.repo, { email: "member@example.test", password: "member-password-passphrase", role: "user" });
  await addOrganizationMember(f.repo, f.org, { userId: member.id, role: "member" });
  const task = await createTask(f.repo, { title: "Protected", spec: "Spec", techDesign: "Design" }, { ownerId: f.owner.id, organizationId: f.org });
  const providerStore = new FileProviderConnectionStore({ path: join(f.repo, ".nitely", "connections.json"), env: {} });
  const shared = await providerStore.setConnection({ providerId: "github", value: "secret-protected-token", metadata: { scope: "org", organizationId: f.org } });
  const authEnv = { NITELY_WEB_BREAK_GLASS: "true" };
  const server = await startWebServer({ repoPath: f.repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv, providerEnv: {} });
  try {
    const session = await createSession(f.repo, f.owner.id);
    const cookie = "nitely_session=" + session.id;
    const path = `/api/organizations/${f.org}/security-policy`;
    const request = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) => fetch(server.url + path, { method, headers: { cookie, "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const foreignCookie = "nitely_session=" + (await createSession(f.repo, outsider.id)).id;
    expect((await request(path, { cookie: foreignCookie })).status).toBe(404);
    const memberCookie = "nitely_session=" + (await createSession(f.repo, member.id)).id;
    expect((await request(path, { cookie: memberCookie })).status).toBe(403);
    expect((await request(path, {}, "PUT", { ...defaults, unknown: true })).status).toBe(400);
    expect((await request(path, {}, "PUT", { ...defaults, ssoRequired: true })).status).toBe(200);
    expect((await request(path)).status).toBe(401);
    expect((await request(`/api/tasks/${task.id}`, { "x-nitely-organization-id": other.id })).status).toBe(404);
    const tasks = await request("/api/tasks", { "x-nitely-organization-id": other.id });
    expect(tasks.status).toBe(200); expect(JSON.stringify(await tasks.json())).not.toContain(task.id);
    const providers = await request("/api/providers", { "x-nitely-organization-id": other.id });
    expect(providers.status).toBe(200); expect(JSON.stringify(await providers.json())).not.toContain(shared.id);
    expect((await request("/api/device-authorizations/approve", { "x-nitely-organization-id": other.id }, "POST", { decision: "approve", userCode: "AAAA-BBBB" })).status).toBe(403);
    expect((await request(path, { "x-nitely-break-glass": "true" })).status).toBe(200);
    const disabled = await startWebServer({ repoPath: f.repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: {}, providerEnv: {} });
    try {
      expect((await fetch(disabled.url + path, { headers: { cookie, "x-nitely-break-glass": "true" } })).status).toBe(401);
    } finally { await disabled.close(); }
    expect((await request(`/api/tasks/${task.id}`, { "x-nitely-break-glass": "true", "x-nitely-organization-id": f.org })).status).toBe(401);
    expect((await request(path, { cookie: memberCookie, "x-nitely-break-glass": "true" })).status).toBe(401);
    const wrongSso = await createSession(f.repo, f.owner.id, { authenticationMethod: "oidc", organizationId: other.id });
    expect((await request(path, { cookie: "nitely_session=" + wrongSso.id })).status).toBe(401);
    const sso = await createSession(f.repo, f.owner.id, { authenticationMethod: "oidc", organizationId: f.org });
    const ssoCookie = "nitely_session=" + sso.id;
    expect((await request(path, { cookie: ssoCookie })).status).toBe(200);
    expect((await request(path + "/revoke-sessions", { cookie: ssoCookie }, "POST", {})).status).toBe(200);
    expect((await request(path, { cookie: ssoCookie })).status).toBe(401);
    expect((await request(path, { "x-nitely-break-glass": "true" })).status).toBe(401);
    const recovery = await createSession(f.repo, f.owner.id);
    expect((await request(path, { cookie: "nitely_session=" + recovery.id, "x-nitely-break-glass": "true" }, "PUT", defaults)).status).toBe(200);
    const events = await listSecurityAuditEvents(f.repo, { limit: 100 });
    expect(events).toContainEqual(expect.objectContaining({ action: "auth.break-glass", target: { type: "organization", id: f.org }, outcome: "success" }));
    expect(events).toContainEqual(expect.objectContaining({ action: "organizations.policy.update", outcome: "success" }));
    expect(events).toContainEqual(expect.objectContaining({ action: "organizations.policy.revoke-sessions", outcome: "success" }));
  } finally { await server.close(); }
});

it("rejects an idle session on the next HTTP request without relying on the Console", async () => {
  const f = await fixture(); execFileSync("git", ["init", "-q", f.repo]);
  await updateOrganizationSecurityPolicy(f.repo, f.org, f.owner, { ...defaults, idleTimeoutSeconds: 1 });
  const session = await createSession(f.repo, f.owner.id, { now: () => new Date(Date.now() - 2000) });
  const server = await startWebServer({ repoPath: f.repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: {}, providerEnv: {} });
  try {
    expect((await fetch(server.url + "/api/runs", { headers: { cookie: "nitely_session=" + session.id } })).status).toBe(401);
  } finally { await server.close(); }
});


it("does not revive an idle-expired organization by refreshing another permitted organization", async () => {
  const f = await fixture();
  const other = await createOrganization(f.repo, { name: "Longer idle", members: { [f.owner.id]: "owner" } });
  await updateOrganizationSecurityPolicy(f.repo, f.org, f.owner, { ...defaults, idleTimeoutSeconds: 1 });
  await updateOrganizationSecurityPolicy(f.repo, other.id, f.owner, { ...defaults, idleTimeoutSeconds: 10 });
  const start = Date.now();
  const session = await createSession(f.repo, f.owner.id, { now: () => new Date(start) });
  expect(await readSessionUser(f.repo, session.id, { organizationId: other.id, now: () => new Date(start + 2000) })).not.toBeNull();
  expect(await readSessionUser(f.repo, session.id, { organizationId: f.org, now: () => new Date(start + 2100) })).toBeNull();
});


it("fails recovery closed when audit cannot be persisted and hides blocked connection identifiers from read/use/mutation", async () => {
  const f = await fixture();
  await updateOrganizationSecurityPolicy(f.repo, f.org, f.owner, { ...defaults, ssoRequired: true });
  const session = await createSession(f.repo, f.owner.id);
  const path = securityAuditPath(f.repo);
  await mkdir(path, { recursive: true });
  await expect(readSessionUser(f.repo, session.id, { organizationId: f.org, breakGlass: true })).rejects.toThrow();
  const storePath = join(f.repo, ".nitely", "connections.json");
  const store = new FileProviderConnectionStore({ path: storePath, env: {} });
  const connection = await store.setConnection({ providerId: "github", value: "protected-secret", metadata: { scope: "org", organizationId: f.org } });
  let allowed = true;
  const changing = new FileProviderConnectionStore({ path: storePath, env: {}, connectionAllowed: () => allowed });
  const handle = await changing.getConnection("github", { connectionId: connection.id });
  allowed = false;
  await expect(handle.getAccessToken()).rejects.toThrow();
  const scoped = new FileProviderConnectionStore({ path: storePath, env: {}, connectionAllowed: (record) => record.credential.organizationId !== f.org });
  expect(await scoped.listConnections()).toEqual([]);
  await expect(scoped.getConnection("github", { connectionId: connection.id })).rejects.toThrow();
  await expect(scoped.setConnection({ providerId: "github", value: "replacement", connectionId: connection.id })).rejects.toThrow();
  await expect(scoped.setDefaultConnection("github", connection.id)).rejects.toThrow();
  await scoped.clearConnection("github", { connectionId: connection.id });
  expect(await (await store.getConnection("github", { connectionId: connection.id })).getAccessToken()).toBe("protected-secret");
});
