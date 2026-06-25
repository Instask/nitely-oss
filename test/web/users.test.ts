import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bootstrapInitialAdmin,
  createSession,
  createUser,
  getPublicUser,
  hasAnyUsers,
  publicUser,
  readSessionUser,
  verifyUserPassword,
} from "../../src/web/users.js";
import {
  addOrganizationMember,
  listPublicMemberships,
} from "../../src/web/organizations.js";

async function createRepo() {
  return await mkdtemp(join(tmpdir(), "nitely-web-users-"));
}

describe("web user store", () => {
  it("reports whether the repository has any users", async () => {
    const repoPath = await createRepo();

    await expect(hasAnyUsers(repoPath)).resolves.toBe(false);

    await createUser(repoPath, {
      email: "user@example.test",
      password: "top secret",
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
  });

  it("creates a default organization membership for new users", async () => {
    const repoPath = await createRepo();

    const user = await createUser(repoPath, {
      email: "member@example.test",
      password: "top secret",
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
      password: "top secret",
      role: "admin",
    });
    const viewer = await createUser(repoPath, {
      email: "viewer@example.test",
      password: "top secret",
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
      password: "top secret",
      role: "user",
    });

    await expect(
      verifyUserPassword(repoPath, "user@example.test", "top secret"),
    ).resolves.toMatchObject({
      email: "user@example.test",
      role: "user",
    });
    await expect(
      verifyUserPassword(repoPath, "user@example.test", "wrong"),
    ).resolves.toBeNull();
    await expect(
      verifyUserPassword(repoPath, "missing@example.test", "top secret"),
    ).resolves.toBeNull();
  });

  it("does not expose password verifier data in the public user shape", async () => {
    const repoPath = await createRepo();
    const user = await createUser(repoPath, {
      email: "private@example.test",
      password: "top secret",
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
      password: "top secret",
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
});
