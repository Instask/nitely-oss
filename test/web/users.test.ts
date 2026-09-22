import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bootstrapInitialAdmin,
  createSession,
  createUser,
  findUserByIdOrEmail,
  getPublicUser,
  hasAnyUsers,
  invalidateUserSessions,
  LOCAL_PASSWORD_MIN_CODE_POINTS,
  publicUser,
  readSessionUser,
  validateLocalPassword,
  verifyUserPassword,
} from "../../src/web/users.js";
import {
  addOrganizationMember,
  listPublicMemberships,
} from "../../src/web/organizations.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";

async function createRepo() {
  return await mkdtemp(join(tmpdir(), "nitely-web-users-"));
}

describe("web user store", () => {
  it("enforces a length-first local password policy without composition rules", async () => {
    const repoPath = await createRepo();

    expect(LOCAL_PASSWORD_MIN_CODE_POINTS).toBe(15);
    expect(() => validateLocalPassword("thirteen chars"))
      .toThrow("password must be at least 15 characters");
    expect(() => validateLocalPassword("   a long passphrase with spaces   "))
      .not.toThrow();
    expect(() => validateLocalPassword("密碼管理器產生的安全長密碼片語範例"))
      .not.toThrow();
    expect(() => validateLocalPassword("x".repeat(128))).not.toThrow();
    expect(() => validateLocalPassword("x".repeat(129)))
      .toThrow("password must be at most 128 characters");
    expect(() => validateLocalPassword("passwordpassword"))
      .toThrow("password is blocked");

    await expect(
      createUser(repoPath, {
        email: "short@example.test",
        password: "too short",
        role: "user",
      }),
    ).rejects.toThrow("password must be at least 15 characters");
  });

  it("honors an operator-supplied local password blocklist", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely/users"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/users/password-blocklist.txt"),
      "pilot compromised passphrase\n",
      "utf8",
    );

    await expect(
      createUser(repoPath, {
        email: "blocked@example.test",
        password: "pilot compromised passphrase",
        role: "user",
      }),
    ).rejects.toThrow("password is blocked");
  });

  it("reports whether the repository has any users", async () => {
    const repoPath = await createRepo();

    await expect(hasAnyUsers(repoPath)).resolves.toBe(false);

    await createUser(repoPath, {
      email: "user@example.test",
      password: "top secret passphrase",
      role: "user",
    });

    await expect(hasAnyUsers(repoPath)).resolves.toBe(true);
  });

  it("bootstraps the first admin from explicit environment values", async () => {
    const repoPath = await createRepo();

    const user = await bootstrapInitialAdmin(repoPath, {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "correct horse battery staple",
    });

    expect(user).toMatchObject({
      email: "admin@example.test",
      role: "admin",
    });
    if (!user) {
      throw new Error("expected initial admin to be bootstrapped");
    }
    expect(user.id).toMatch(/^usr_/);
    await expect(getPublicUser(repoPath, user.id)).resolves.toMatchObject({
      id: user.id,
      email: "admin@example.test",
      role: "admin",
      currentOrganizationRole: "owner",
      memberships: [
        expect.objectContaining({
          role: "owner",
          organizationName: "Default Team",
        }),
      ],
    });
    const completedJournal = await readFile(
      join(repoPath, ".nitely/users/initial-admin-bootstrap.json"),
      "utf8",
    );
    expect(completedJournal).not.toContain("passwordHash");
    expect(completedJournal).not.toContain("passwordSalt");
  });

  it("does not pin mutable administrator fields after bootstrap completes", async () => {
    const repoPath = await createRepo();
    const user = await bootstrapInitialAdmin(repoPath, {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "correct horse battery staple",
    });
    if (!user) throw new Error("expected initial admin");
    const path = join(repoPath, ".nitely/users/users.json");
    const users = JSON.parse(await readFile(path, "utf8")) as {
      users: Record<string, { email: string }>;
    };
    users.users[user.id].email = "renamed@example.test";
    await writeFile(path, JSON.stringify(users, null, 2), "utf8");

    await expect(bootstrapInitialAdmin(repoPath, {})).resolves.toMatchObject({
      id: user.id,
      email: "renamed@example.test",
      role: "admin",
    });
  });

  for (const crashAfter of [
    "intent-persisted",
    "user-persisted",
    "organization-persisted",
    "audit-persisted",
  ] as const) {
    it(`recovers an interrupted first-admin bootstrap after ${crashAfter}`, async () => {
      const repoPath = await createRepo();
      let interrupted = false;

      await expect(
        bootstrapInitialAdmin(
          repoPath,
          {
            NITELY_ADMIN_EMAIL: "admin@example.test",
            NITELY_ADMIN_PASSWORD: "correct horse battery staple",
          },
          {
            afterStep: async (step) => {
              if (!interrupted && step === crashAfter) {
                interrupted = true;
                throw new Error(`simulated crash after ${step}`);
              }
            },
          },
        ),
      ).rejects.toThrow(`simulated crash after ${crashAfter}`);

      const recovered = await bootstrapInitialAdmin(repoPath, {});

      expect(recovered).toMatchObject({
        email: "admin@example.test",
        role: "admin",
      });
      if (!recovered) throw new Error("expected bootstrap recovery to finish");
      await expect(getPublicUser(repoPath, recovered.id)).resolves.toMatchObject({
        currentOrganizationRole: "owner",
      });
      await expect(listSecurityAuditEvents(repoPath, {
        action: "auth.bootstrap",
      })).resolves.toEqual([
        expect.objectContaining({
          action: "auth.bootstrap",
          reasonCode: "explicit_initial_admin",
          target: { type: "user", id: recovered.id },
        }),
      ]);
    });
  }

  it("serializes concurrent first-admin bootstraps into one user and one audit event", async () => {
    const repoPath = await createRepo();
    const env = {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "correct horse battery staple",
    };

    const admins = await Promise.all(
      Array.from({ length: 4 }, async () =>
        await bootstrapInitialAdmin(repoPath, env)),
    );

    expect(new Set(admins.map((admin) => admin?.id)).size).toBe(1);
    await expect(listSecurityAuditEvents(repoPath, {
      action: "auth.bootstrap",
    })).resolves.toHaveLength(1);
  });

  it("recovers the bootstrap lock left by a terminated process", async () => {
    const repoPath = await createRepo();
    const lockPath = join(
      repoPath,
      ".nitely/users/initial-admin-bootstrap.lock",
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      version: 1,
      ownerId: "terminated-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-07-16T00:00:00.000Z",
    }));

    await expect(bootstrapInitialAdmin(repoPath, {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "correct horse battery staple",
    })).resolves.toMatchObject({ role: "admin" });
    await expect(listSecurityAuditEvents(repoPath, {
      action: "auth.bootstrap",
    })).resolves.toHaveLength(1);
  });

  it("rejects a shallow administrator record instead of treating it as configured", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely/users"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/users/users.json"),
      JSON.stringify({
        version: 1,
        users: {
          fake: { role: "admin" },
        },
      }),
      "utf8",
    );

    await expect(hasAnyUsers(repoPath)).rejects.toThrow(/invalid users\.json/i);
    await expect(bootstrapInitialAdmin(repoPath, {})).rejects.toThrow(
      /invalid users\.json/i,
    );
  });

  it("creates a default organization membership for new users", async () => {
    const repoPath = await createRepo();

    const user = await createUser(repoPath, {
      email: "member@example.test",
      password: "top secret passphrase",
      role: "user",
    });

    await expect(listPublicMemberships(repoPath, user.id)).resolves.toEqual([
      expect.objectContaining({
        role: "member",
        organizationName: "Default Team",
      }),
    ]);
    await expect(getPublicUser(repoPath, user.id)).resolves.toMatchObject({
      currentOrganizationRole: "member",
      memberships: [
        expect.objectContaining({
          role: "member",
          organizationName: "Default Team",
        }),
      ],
    });
  });

  it("projects explicit team memberships without exposing password verifier data", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "top secret passphrase",
      role: "admin",
    });
    const viewer = await createUser(repoPath, {
      email: "viewer@example.test",
      password: "top secret passphrase",
      role: "user",
    });
    const [ownerTeam] = await listPublicMemberships(repoPath, owner.id);

    await addOrganizationMember(repoPath, ownerTeam.organizationId, {
      userId: viewer.id,
      role: "viewer",
    });

    const exposed = await getPublicUser(repoPath, viewer.id);

    expect(exposed).toMatchObject({
      id: viewer.id,
      email: "viewer@example.test",
      memberships: expect.arrayContaining([
        expect.objectContaining({
          organizationId: ownerTeam.organizationId,
          role: "viewer",
        }),
      ]),
    });
    expect(JSON.stringify(exposed)).not.toContain("password");
    expect(JSON.stringify(exposed)).not.toContain(viewer.passwordHash);
    expect(JSON.stringify(exposed)).not.toContain(viewer.passwordSalt);
  });

  it("verifies correct passwords and rejects wrong passwords", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "user@example.test",
      password: "top secret passphrase",
      role: "user",
    });

    await expect(
      verifyUserPassword(repoPath, "user@example.test", "top secret passphrase"),
    ).resolves.toMatchObject({
      email: "user@example.test",
      role: "user",
    });
    await expect(
      verifyUserPassword(repoPath, "user@example.test", "wrong"),
    ).resolves.toBeNull();
    await expect(
      verifyUserPassword(repoPath, "missing@example.test", "top secret passphrase"),
    ).resolves.toBeNull();
  });

  it("performs password derivation for an unknown account", async () => {
    const repoPath = await createRepo();
    let derivations = 0;

    await expect(
      verifyUserPassword(repoPath, "missing@example.test", "any submitted password", {
        derivePasswordKey: async (_password, _salt, keyLength) => {
          derivations += 1;
          return Buffer.alloc(keyLength);
        },
      }),
    ).resolves.toBeNull();
    expect(derivations).toBe(1);
  });

  it("does not expose password verifier data in the public user shape", async () => {
    const repoPath = await createRepo();
    const user = await createUser(repoPath, {
      email: "private@example.test",
      password: "top secret passphrase",
      role: "user",
    });

    const exposed = publicUser(user);

    expect(exposed).toEqual({
      id: user.id,
      email: "private@example.test",
      role: "user",
    });
    expect(JSON.stringify(exposed)).not.toContain("password");
    expect(JSON.stringify(exposed)).not.toContain(user.passwordHash);
    expect(JSON.stringify(exposed)).not.toContain(user.passwordSalt);
  });

  it("creates expiring sessions that resolve back to public users", async () => {
    const repoPath = await createRepo();
    const user = await createUser(repoPath, {
      email: "session@example.test",
      password: "top secret passphrase",
      role: "user",
    });

    const session = await createSession(repoPath, user.id, {
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      createId: () => "sess_test",
    });

    expect(session).toMatchObject({
      id: "sess_test",
      userId: user.id,
      expiresAt: "2026-06-27T00:00:00.000Z",
    });
    await expect(
      readSessionUser(repoPath, "sess_test", {
        now: () => new Date("2026-06-21T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: user.id,
      email: "session@example.test",
      role: "user",
      currentOrganizationRole: "member",
    });
    await expect(
      readSessionUser(repoPath, "sess_test", {
        now: () => new Date("2026-06-28T00:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("invalidates every session for one user without affecting another user", async () => {
    const repoPath = await createRepo();
    const target = await createUser(repoPath, {
      email: "target@example.test",
      password: "target user long password",
      role: "user",
    });
    const other = await createUser(repoPath, {
      email: "other@example.test",
      password: "other user long password",
      role: "user",
    });
    await createSession(repoPath, target.id, { createId: () => "sess_target_one" });
    await createSession(repoPath, target.id, { createId: () => "sess_target_two" });
    await createSession(repoPath, other.id, { createId: () => "sess_other" });

    await expect(invalidateUserSessions(repoPath, target.id)).resolves.toBe(2);
    await expect(readSessionUser(repoPath, "sess_target_one")).resolves.toBeNull();
    await expect(readSessionUser(repoPath, "sess_target_two")).resolves.toBeNull();
    await expect(readSessionUser(repoPath, "sess_other")).resolves.toMatchObject({
      id: other.id,
    });
  });

  it("finds a user by exact id or case-insensitive email", async () => {
    const repoPath = await createRepo();
    const created = await createUser(repoPath, {
      email: "Owner@Example.test",
      password: "owner password passphrase",
      role: "user",
    });

    expect((await findUserByIdOrEmail(repoPath, created.id))?.id).toBe(created.id);
    expect((await findUserByIdOrEmail(repoPath, "OWNER@example.TEST"))?.id).toBe(created.id);
    expect(await findUserByIdOrEmail(repoPath, "nobody@example.test")).toBeNull();
    expect(await findUserByIdOrEmail(repoPath, "  ")).toBeNull();
    // "constructor" and other Object.prototype keys must never resolve as a
    // stored user id.
    expect(await findUserByIdOrEmail(repoPath, "constructor")).toBeNull();
  });
});
