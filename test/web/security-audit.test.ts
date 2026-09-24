import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendSecurityAuditEvent,
  listSecurityAuditEvents,
  securityAuditPath,
  securityAuditSubjectFingerprint,
} from "../../src/web/security-audit.js";

async function createRepo() {
  return await mkdtemp(join(tmpdir(), "nitely-security-audit-"));
}

describe("Web security audit", () => {
  it("writes bounded metadata to owner-only state", async () => {
    const repoPath = await createRepo();
    const event = await appendSecurityAuditEvent(repoPath, {
      action: "planning.approve-spec",
      permission: "planning:approve",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: {
        type: "user",
        id: "usr_reviewer",
        globalRole: "user",
        organizationId: "org_team",
        organizationRole: "member",
      },
      target: { type: "task", id: "task-123" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createEventId: () => "audit-event-1",
    });

    expect(event).toEqual({
      version: 1,
      event: "security.action",
      eventId: "audit-event-1",
      createdAt: "2026-07-14T00:00:00.000Z",
      action: "planning.approve-spec",
      permission: "planning:approve",
      decision: "allow",
      outcome: "success",
      httpStatus: 200,
      reasonCode: "ok",
      actor: {
        type: "user",
        id: "usr_reviewer",
        globalRole: "user",
        organizationId: "org_team",
        organizationRole: "member",
      },
      target: { type: "task", id: "task-123" },
    });
    const path = securityAuditPath(repoPath);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  it("filters newest events without exposing unrelated audit rows", async () => {
    const repoPath = await createRepo();
    for (const [index, action, decision, actorId] of [
      [1, "auth.login", "deny", undefined],
      [2, "tasks.create", "allow", "usr_a"],
      [3, "tasks.create", "deny", "usr_b"],
      [4, "tasks.create", "allow", "usr_a"],
    ] as const) {
      await appendSecurityAuditEvent(repoPath, {
        action,
        decision,
        outcome: decision === "allow" ? "success" : "error",
        httpStatus: decision === "allow" ? 200 : 403,
        reasonCode: decision === "allow" ? "ok" : "forbidden",
        actor: actorId
          ? { type: "user", id: actorId, globalRole: "user" }
          : { type: "anonymous", subjectHash: "sha256:" + "a".repeat(64) },
        now: () => new Date(`2026-07-14T00:00:0${index}.000Z`),
        createEventId: () => `event-${index}`,
      });
    }

    await expect(
      listSecurityAuditEvents(repoPath, {
        action: "tasks.create",
        decision: "allow",
        actorId: "usr_a",
        limit: 1,
      }),
    ).resolves.toMatchObject([{ eventId: "event-4" }]);
  });

  it("uses a normalized one-way login subject fingerprint", () => {
    const first = securityAuditSubjectFingerprint(" User@Example.Test ");
    const second = securityAuditSubjectFingerprint("user@example.test");

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain("user@example.test");
  });

  it("rejects unbounded or unsafe metadata", async () => {
    const repoPath = await createRepo();

    await expect(
      appendSecurityAuditEvent(repoPath, {
        action: "tasks.create\npassword=secret",
        decision: "deny",
        outcome: "error",
        httpStatus: 403,
        reasonCode: "forbidden",
        actor: { type: "anonymous" },
      }),
    ).rejects.toThrow("invalid security audit action");

    await expect(
      appendSecurityAuditEvent(repoPath, {
        action: "tasks.create",
        decision: "allow",
        outcome: "success",
        httpStatus: 201,
        reasonCode: "ok",
        actor: {
          type: "user",
          globalRole: "super-admin" as "admin",
        },
      }),
    ).rejects.toThrow("invalid security audit global role");
  });
});
