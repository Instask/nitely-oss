import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { startWebServer } from "../../src/web/server.js";
import { createUser, createSession } from "../../src/web/users.js";
import { addOrganizationMember, listPublicMemberships } from "../../src/web/organizations.js";
import { appendSecurityAuditEvent, queryOrganizationAudit, securityAuditPath, pruneOrganizationAudit } from "../../src/web/security-audit.js";

it("isolates organization audit query, stable pagination/export and explicit retention through authenticated APIs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-org-audit-"));
  const owner = await createUser(repo, { email: "audit-owner@example.test", password: "owner-password-passphrase", role: "user" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  await addOrganizationMember(repo, org, { userId: owner.id, role: "owner" });
  const outsider = await createUser(repo, { email: "audit-other@example.test", password: "outsider-password-passphrase", role: "admin" });
  const foreignOrg = (await listPublicMemberships(repo, outsider.id))[0].organizationId;
  const auditor = await createUser(repo, { email: "audit-maintainer@example.test", password: "auditor-password-passphrase", role: "user" });
  await addOrganizationMember(repo, org, { userId: auditor.id, role: "maintainer" });
  const ownerCookie = "nitely_session=" + (await createSession(repo, owner.id)).id;
  const auditorCookie = "nitely_session=" + (await createSession(repo, auditor.id)).id;
  const outsiderCookie = "nitely_session=" + (await createSession(repo, outsider.id)).id;
  const append = async (id: string, organizationId: string, date: Date, extra = false) => await appendSecurityAuditEvent(repo, {
    action: "runs.execute", decision: "allow", outcome: "success", httpStatus: 200, reasonCode: "ok", source: "runtime",
    actor: { type: "user", id: owner.id, organizationId, ...(extra ? { password: "never-store-this" } : {}) },
    target: { type: "run", id: "run-one" }, context: { repositoryId: "repo-one", taskId: "task-one", runId: "run-one", providerId: "github", ...(extra ? { secret: "never-store-this" } : {}) },
    now: () => date, createEventId: () => id,
  });
  const old = new Date(Date.now() - 3 * 86_400_000);
  const recent = new Date();
  await append("own-old", org, old);
  const foreign = await append("foreign-old", foreignOrg, old);
  await append("own-new-1", org, recent, true);
  await append("own-new-2", org, recent);
  const server = await startWebServer({ repoPath: repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: {}, providerEnv: {}, providerCommandStatus: async () => false });
  const root = `/api/organizations/${org}/audit`;
  const request = (suffix = "", method = "GET", body?: unknown, cookie = ownerCookie) => fetch(server.url + root + suffix, { method, headers: { cookie, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    expect((await request("", "GET", undefined, outsiderCookie)).status).toBe(404);
    expect((await queryOrganizationAudit(repo, { organizationId: org, action: "runs.execute", from: recent.toISOString(), until: recent.toISOString() })).events.map((event) => event.eventId)).toEqual(["own-new-2", "own-new-1"]);
    expect((await request("", "GET", undefined, auditorCookie)).status).toBe(200);
    expect((await request("/retention", "PUT", { version: 1, retentionDays: 1 }, auditorCookie)).status).toBe(403);
    expect((await request("/retention")).status).toBe(200);
    expect((await (await request("/retention")).json()).policy).toEqual({ version: 1, retentionDays: null });
    const filter = `action=runs.execute&actorId=${owner.id}&source=runtime&repositoryId=repo-one&taskId=task-one&runId=run-one&providerId=github&result=success&limit=1`;
    const first = await (await request("?" + filter)).json();
    expect(first.events.map((event: { eventId: string }) => event.eventId)).toEqual(["own-new-2"]);
    expect(first.nextCursor).toBe("own-new-2");
    await append("own-later", org, recent); // Appends after a page do not shift its cursor.
    const second = await (await request("?" + filter + "&cursor=" + first.nextCursor)).json();
    expect(second.events.map((event: { eventId: string }) => event.eventId)).toEqual(["own-new-1"]);
    expect((await request("/events/foreign-old")).status).toBe(404);
    expect((await request("?cursor=foreign-old")).status).toBe(404);
    expect((await request("?limit=501")).status).toBe(400);
    expect((await request("?from=bad")).status).toBe(400);
    expect((await request("?result=unknown")).status).toBe(400);
    const exported = await request("/export?" + filter + "&format=jsonl");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("application/x-ndjson");
    expect(exported.headers.get("x-nitely-next-cursor")).toBe("own-later");
    const row = JSON.parse((await exported.text()).trim());
    expect(row.eventId).toBe("own-later"); expect(row.createdAt).toBe(recent.toISOString());
    expect((await queryOrganizationAudit(repo, { organizationId: org, action: "audit.export" })).events).toHaveLength(1);
    expect((await request("/export?format=csv")).status).toBe(400);
    expect((await request("/retention", "PUT", { version: 1, retentionDays: 0 })).status).toBe(400);
    expect((await request("/retention", "PUT", { version: 1, retentionDays: 1 })).status).toBe(200);
    const deletion = await request("/prune", "POST", {});
    expect(deletion.status).toBe(200); expect((await deletion.json()).deleted).toBe(1);
    const own = await queryOrganizationAudit(repo, { organizationId: org });
    expect(own.events.some((event) => event.eventId === "own-old")).toBe(false);
    expect((await queryOrganizationAudit(repo, { organizationId: foreignOrg })).events).toEqual([foreign]);
    expect(own.events.some((event) => event.action === "audit.retention.update")).toBe(true);
    expect(own.events.some((event) => event.action === "audit.retention.prune")).toBe(true);
    const requestEvent = own.events.find((event) => event.action === "audit.organization.view");
    expect(requestEvent?.context?.requestId).toBeDefined();
    expect(requestEvent?.context?.sessionHash).toMatch(/^[a-f0-9]{64}$/);
    const raw = await readFile(securityAuditPath(repo), "utf8");
    expect(raw).not.toContain("never-store-this"); expect(raw).not.toContain(ownerCookie.split("=")[1]);
    // Appends and an explicit prune share the same file lease; neither loses the other's records.
    await Promise.all([pruneOrganizationAudit(repo, org, { type: "user", id: owner.id, organizationId: org }), ...Array.from({ length: 8 }, (_, index) => append("concurrent-" + index, org, recent))]);
    expect((await queryOrganizationAudit(repo, { organizationId: org })).events.filter((event) => event.eventId.startsWith("concurrent-"))).toHaveLength(8);
  } finally { await server.close(); await rm(repo, { recursive: true, force: true }); }
});
