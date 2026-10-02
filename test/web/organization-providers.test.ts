import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startWebServer } from "../../src/web/server.js";
import { createSession, createUser } from "../../src/web/users.js";
import { addOrganizationMember, listPublicMemberships } from "../../src/web/organizations.js";
import { createTask } from "../../src/web/tasks.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import { EventStore } from "../../src/events/store.js";
import { eventStorePath } from "../../src/run/project.js";
import { listSecurityAuditEvents, queryOrganizationAudit } from "../../src/web/security-audit.js";

const repos: string[] = [];
afterEach(async () => { await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))); });

it("shares organization connections through real APIs and resolves actual task scope with explicit binding, isolated management and immutable evidence", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-org-providers-")); repos.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  await mkdir(join(repo, "flows"));
  await writeFile(join(repo, "flows/implement-spec-bootstrap.json"), JSON.stringify({ apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "implement-spec-bootstrap" }, spec: { stages: [{ id: "implement", type: "agent", runtime: "mock", prompt: "Implement", inputs: ["spec", "tech-design"], outputs: ["implementation"] }] } }));
  const owner = await createUser(repo, { email: "owner@example.test", password: "owner-password-passphrase", role: "admin" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  const member = await createUser(repo, { email: "member@example.test", password: "member-password-passphrase", role: "user" });
  const personalOrg = (await listPublicMemberships(repo, member.id))[0].organizationId;
  await addOrganizationMember(repo, org, { userId: member.id, role: "member" });
  const outsider = await createUser(repo, { email: "outsider@example.test", password: "outsider-password-passphrase", role: "admin" });
  const ownerCookie = "nitely_session=" + (await createSession(repo, owner.id)).id;
  const memberCookie = "nitely_session=" + (await createSession(repo, member.id)).id;
  const outsiderCookie = "nitely_session=" + (await createSession(repo, outsider.id)).id;
  const personal = new FileProviderConnectionStore({ path: join(repo, ".nitely", "users", member.id, "connections.json"), env: {} });
  const personalConnection = await personal.setConnection({ providerId: "github", value: "personal-secret", metadata: { scope: "user", ownerId: member.id } });
  const seen: Array<{ id?: string; value: string }> = [];
  const server = await startWebServer({ repoPath: repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: {},
    repositories: [{ id: "home", path: repo, synthetic: true, organizationId: org }],
    providerEnv: { NITELY_EXECUTION_BACKEND: "local", NITELY_ALLOW_UNSAFE_LOCAL_EXECUTION: "true", GITHUB_TOKEN: "env-secret" }, providerCommandStatus: async () => false,
    runFlow: async (_input, dependencies) => {
      const connection = await dependencies!.providerStore!.getConnection("github");
      seen.push({ id: connection.connectionId, value: await connection.getAccessToken() });
      const runId = dependencies!.createRunId!();
      return { runId, branchName: "nitely/" + runId, worktreePath: join(repo, ".nitely/worktrees", runId) };
    },
  });
  try {
    const root = `/api/organizations/${org}/providers/github/connections`;
    const request = (path: string, method = "GET", body?: unknown, cookie = ownerCookie, headers: Record<string, string> = {}) => fetch(server.url + path, { method, headers: { cookie, "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    expect((await request(root, "POST", { value: "denied" }, memberCookie)).status).toBe(403);
    expect((await request(root, "GET", undefined, outsiderCookie)).status).toBe(404);
    expect((await request(root, "POST", { value: "denied", repositoryId: "missing" })).status).toBe(404);
    const outsiderOrg = (await listPublicMemberships(repo, outsider.id))[0].organizationId;
    const foreignResponse = await request(`/api/organizations/${outsiderOrg}/providers/github/connections`, "POST", { value: "foreign-secret" }, outsiderCookie);
    expect(foreignResponse.status).toBe(201); const foreign = (await foreignResponse.json()).connection;
    expect((await request(root + "/" + foreign.id)).status).toBe(404);
    const deniedTask = await createTask(repo, { title: "Denied binding", spec: "Spec body", techDesign: "Design body" }, { ownerId: member.id, organizationId: org });
    expect((await request(`/api/tasks/${deniedTask.id}/runs`, "POST", { providerConnections: { github: foreign.id } }, memberCookie)).status).toBe(404);
    expect(seen).toHaveLength(0);
    const created = await request(root, "POST", { value: "org-secret" }); expect(created.status).toBe(201);
    const shared = (await created.json()).connection;
    expect(JSON.stringify(shared)).not.toContain("org-secret"); expect(shared).not.toHaveProperty("credentialRef");
    const boundResponse = await request(root, "POST", { value: "repo-secret", repositoryId: "home", authMethod: "pat" });
    expect(boundResponse.status).toBe(201); const bound = (await boundResponse.json()).connection;
    const visible = await request(root, "GET", undefined, memberCookie); expect(visible.status).toBe(200);
    expect((await visible.json()).connections).toHaveLength(2);
    expect((await request("/api/providers/github/connection", "POST", { value: "personal-secret", connectionId: personalConnection.id }, memberCookie)).status).toBe(200);
    await addOrganizationMember(repo, org, { userId: outsider.id, role: "member" });
    expect((await request("/api/providers/github/connections/" + shared.id + "/disconnect", "POST", {}, outsiderCookie, { "x-nitely-organization-id": org })).status).toBe(403);
    expect((await request(root + "/" + shared.id + "/revoke", "POST", {}, outsiderCookie)).status).toBe(403);
    const start = async (binding?: string) => {
      const task = await createTask(repo, { title: "Credential scope", spec: "Spec body", techDesign: "Design body" }, { ownerId: member.id, organizationId: org });
      const response = await request(`/api/tasks/${task.id}/runs`, "POST", binding ? { providerConnections: { github: binding } } : {}, memberCookie, { "x-nitely-organization-id": personalOrg });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200); const result = await response.json();
      await vi.waitFor(() => expect(seen).toHaveLength(started + 1), { timeout: 5000 }); started++;
      return result.run.runId as string;
    };
    let started = 0;
    await start(); expect(seen[0]).toEqual({ id: bound.id, value: "repo-secret" });
    const runId = await start(personalConnection.id); expect(seen[1]).toEqual({ id: personalConnection.id, value: "personal-secret" });
    await vi.waitFor(() => {
      const completed = new EventStore(eventStorePath(repo));
      try { expect(completed.list(runId).some((event) => event.type === "run.completed")).toBe(true); } finally { completed.close(); }
    }, { timeout: 5000 });
    const events = new EventStore(eventStorePath(repo));
    const historical = JSON.stringify(events.list(runId)); events.close();
    expect(historical).toContain(personalConnection.id); expect(historical).not.toContain("personal-secret");
    expect((await request(root + "/" + bound.id, "PATCH", { repositoryId: null })).status).toBe(200);
    expect((await request(root + "/" + shared.id + "/rotate", "POST", { value: "rotated-org-secret" })).status).toBe(200);
    expect((await request(root + "/" + shared.id + "/default", "POST", {})).status).toBe(200);
    await start(); expect(seen[2]).toEqual({ id: shared.id, value: "rotated-org-secret" });
    expect((await request(root + "/" + shared.id + "/revoke", "POST", {})).status).toBe(200);
    const revokedTask = await createTask(repo, { title: "Revoked binding", spec: "Spec body", techDesign: "Design body" }, { ownerId: member.id, organizationId: org });
    expect((await request(`/api/tasks/${revokedTask.id}/runs`, "POST", { providerConnections: { github: shared.id } }, memberCookie)).status).toBe(400);
    expect(seen).toHaveLength(3);
    expect((await request(root + "/" + bound.id, "DELETE")).status).toBe(200);
    const after = new EventStore(eventStorePath(repo)); expect(JSON.stringify(after.list(runId))).toBe(historical); after.close();
    const audit = await listSecurityAuditEvents(repo, { limit: 100 });
    expect(audit).toContainEqual(expect.objectContaining({ action: "providers.connection.use", actor: expect.objectContaining({ id: member.id, organizationId: org }), target: { type: "provider", id: shared.id } }));
    expect(audit).toContainEqual(expect.objectContaining({ action: "providers.connection.revoke", actor: expect.objectContaining({ id: owner.id, organizationId: org }) }));
    expect(JSON.stringify(audit)).not.toContain("rotated-org-secret");
    const executions = await queryOrganizationAudit(repo, { organizationId: org, source: "runtime", runId });
    expect(executions.events).toContainEqual(expect.objectContaining({ action: "runs.execute", actor: expect.objectContaining({ id: member.id, organizationId: org }), context: expect.objectContaining({ repositoryId: "home", runId }) }));
    const stored = await readFile(join(repo, ".nitely/organizations", createHash("sha256").update(org).digest("hex"), "connections.json"), "utf8");
    expect(stored).not.toContain("rotated-org-secret");
  } finally { await server.close(); }
});
