import { describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_CODE_TTL_MS,
  claimDeviceAuthorization,
  createDeviceAuthorization,
  decideDeviceAuthorization,
  deleteDeviceAuthorization,
  deviceAuthorizationPath,
  deviceAuthorizationsRoot,
  formatUserCode,
  normalizeUserCode,
  readDeviceAuthorization,
  recordDevicePoll,
  resolveDeviceAuthorization,
  sweepExpiredDeviceAuthorizations,
} from "../../src/web/device-authorizations.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-device-auth-"));
}

describe("device authorizations", () => {
  it("issues a user code drawn from the unambiguous alphabet", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      clientName: "cli@dev-box",
    });

    expect(record.userCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(deviceCode.startsWith(`${record.userCode}.`)).toBe(true);
    expect(record.status).toBe("pending");
    expect(formatUserCode(record.userCode)).toBe(
      `${record.userCode.slice(0, 4)}-${record.userCode.slice(4)}`,
    );
  });

  it("stores only a hash, never the device code itself", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    const raw = await readFile(
      deviceAuthorizationPath(repoPath, record.userCode),
      "utf8",
    );
    expect(raw).not.toContain(deviceCode);
    expect(raw).not.toContain(deviceCode.split(".")[1]);
    expect(JSON.parse(raw).deviceCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes user codes typed with separators and lower case", () => {
    expect(normalizeUserCode("bdfh-jkmn")).toBe("BDFHJKMN");
    expect(normalizeUserCode("  BDFH JKMN ")).toBe("BDFHJKMN");
    expect(normalizeUserCode("BDFHJKM")).toBeUndefined();
    expect(normalizeUserCode("BDFHJKM0")).toBeUndefined();
    expect(normalizeUserCode("../../etc/passwd")).toBeUndefined();
  });

  it("resolves a device code only when the secret half matches", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    await expect(
      resolveDeviceAuthorization(repoPath, deviceCode),
    ).resolves.toMatchObject({ userCode: record.userCode });
    await expect(
      resolveDeviceAuthorization(repoPath, `${record.userCode}.wrong-secret`),
    ).resolves.toBeNull();
    await expect(
      resolveDeviceAuthorization(repoPath, "nonsense"),
    ).resolves.toBeNull();
  });

  it("records an approval with the approving user", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read", "runs:start"],
      allowHighImpact: true,
    });

    const decided = await decideDeviceAuthorization(repoPath, record.userCode, {
      decision: "approve",
      userId: "user_1",
    });

    expect(decided.status).toBe("approved");
    expect(decided.approvedByUserId).toBe("user_1");
    await expect(
      readDeviceAuthorization(repoPath, record.userCode),
    ).resolves.toMatchObject({ status: "approved", approvedByUserId: "user_1" });
  });

  it("treats an expired record as absent and deletes it", async () => {
    const repoPath = await createRepo();
    const start = new Date("2026-09-07T00:00:00.000Z");
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      now: () => start,
    });

    const afterExpiry = new Date(start.getTime() + DEVICE_CODE_TTL_MS + 1);
    await expect(
      readDeviceAuthorization(repoPath, record.userCode, { now: () => afterExpiry }),
    ).resolves.toBeNull();
    await expect(
      resolveDeviceAuthorization(repoPath, deviceCode, { now: () => afterExpiry }),
    ).resolves.toBeNull();
    // "Reads as absent" is not the same as "gone": the storage cost is the
    // file, so assert the file itself left the disk.
    await expect(
      fileExists(deviceAuthorizationPath(repoPath, record.userCode)),
    ).resolves.toBe(false);
  });

  it("sweeps expired records nobody will ever read again", async () => {
    const repoPath = await createRepo();
    const start = new Date("2026-09-07T00:00:00.000Z");
    const abandoned = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      now: () => start,
    });

    // Nothing reads an abandoned code by its own user code, so the lazy
    // deletion in readDeviceAuthorization never fires for it.
    const afterExpiry = new Date(start.getTime() + DEVICE_CODE_TTL_MS + 1);
    const live = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
      now: () => afterExpiry,
    });

    // Creating the live record already swept the abandoned one.
    await expect(
      fileExists(deviceAuthorizationPath(repoPath, abandoned.record.userCode)),
    ).resolves.toBe(false);
    await expect(
      fileExists(deviceAuthorizationPath(repoPath, live.record.userCode)),
    ).resolves.toBe(true);
    await expect(readdir(deviceAuthorizationsRoot(repoPath))).resolves.toEqual([
      `${live.record.userCode}.json`,
    ]);

    // And the sweep leaves a still-live record alone when called directly.
    await expect(
      sweepExpiredDeviceAuthorizations(repoPath, { now: () => afterExpiry }),
    ).resolves.toBe(0);
    await expect(
      sweepExpiredDeviceAuthorizations(repoPath, {
        now: () => new Date(afterExpiry.getTime() + DEVICE_CODE_TTL_MS + 1),
      }),
    ).resolves.toBe(1);
    await expect(readdir(deviceAuthorizationsRoot(repoPath))).resolves.toEqual([]);
  });

  it("claims a record for exactly one caller", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    // This is what stops two concurrent exchanges of one approved code from
    // minting two tokens: whoever loses the claim has nothing to mint from.
    const [first, second] = await Promise.all([
      claimDeviceAuthorization(repoPath, record.userCode),
      claimDeviceAuthorization(repoPath, record.userCode),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    await expect(
      claimDeviceAuthorization(repoPath, record.userCode),
    ).resolves.toBe(false);
    await expect(
      fileExists(deviceAuthorizationPath(repoPath, record.userCode)),
    ).resolves.toBe(false);
  });

  it("never lets a poll resurrect a decided request", async () => {
    for (const decision of ["deny", "approve"] as const) {
      const repoPath = await createRepo();
      const { record } = await createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:read"],
      });

      // A poll that read a pending record and wrote the whole record back
      // after the decision landed would revert status to "pending". In the
      // deny direction that is a fail-open: a refused request would become
      // approvable again.
      await decideDeviceAuthorization(repoPath, record.userCode, {
        decision,
        userId: "user_1",
      });
      await recordDevicePoll(repoPath, record.userCode, new Date());

      await expect(
        readDeviceAuthorization(repoPath, record.userCode),
      ).resolves.toMatchObject({
        status: decision === "deny" ? "denied" : "approved",
        approvedByUserId: "user_1",
      });
    }
  });

  it("keeps a decision final when a poll and a decision overlap", async () => {
    for (const pollFirst of [true, false]) {
      const repoPath = await createRepo();
      const { record } = await createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:read"],
      });

      const poll = () => recordDevicePoll(repoPath, record.userCode, new Date());
      const deny = () =>
        decideDeviceAuthorization(repoPath, record.userCode, {
          decision: "deny",
          userId: "user_1",
        });
      await Promise.all(pollFirst ? [poll(), deny()] : [deny(), poll()]);

      await expect(
        readDeviceAuthorization(repoPath, record.userCode),
      ).resolves.toMatchObject({ status: "denied" });
    }
  });

  it("rejects a second decision instead of overwriting the first", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    const decisions = await Promise.allSettled([
      decideDeviceAuthorization(repoPath, record.userCode, {
        decision: "deny",
        userId: "user_1",
      }),
      decideDeviceAuthorization(repoPath, record.userCode, {
        decision: "approve",
        userId: "user_2",
      }),
    ]);

    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = decisions.find((result) => result.status === "rejected");
    // A bare Error here would surface as an opaque 500; this maps to a 400.
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      status: 400,
      code: "invalid_input",
    });
  });

  it("remembers the last poll so the caller can throttle", async () => {
    const repoPath = await createRepo();
    const { record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });
    const polledAt = new Date("2026-09-07T00:00:03.000Z");

    await recordDevicePoll(repoPath, record.userCode, polledAt);

    await expect(
      readDeviceAuthorization(repoPath, record.userCode),
    ).resolves.toMatchObject({ lastPolledAt: polledAt.toISOString() });
  });

  it("deletes a record so a device code is single-use", async () => {
    const repoPath = await createRepo();
    const { deviceCode, record } = await createDeviceAuthorization(repoPath, {
      capabilities: ["tasks:read"],
    });

    await deleteDeviceAuthorization(repoPath, record.userCode);

    await expect(resolveDeviceAuthorization(repoPath, deviceCode)).resolves.toBeNull();
  });

  it("rejects a client name carrying invisible or direction-changing characters", async () => {
    const repoPath = await createRepo();
    // U+202E renders the rest of the name right-to-left, so a name can be made
    // to display as something other than what it is on the consent screen.
    await expect(
      createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:read"],
        clientName: "cli@dev-\u202Ebox",
      }),
    ).rejects.toThrow("client name must be 1-80 printable characters");
    await expect(
      createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:read"],
        clientName: "cli@dev\u200Bbox",
      }),
    ).rejects.toThrow("client name must be 1-80 printable characters");
    await expect(
      createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:read"],
        clientName: "cli@dev-box",
      }),
    ).resolves.toMatchObject({ record: { clientName: "cli@dev-box" } });
  });

  it("rejects unknown capabilities and empty capability lists", async () => {
    const repoPath = await createRepo();
    await expect(
      createDeviceAuthorization(repoPath, { capabilities: [] }),
    ).rejects.toThrow("at least one capability is required");
    await expect(
      createDeviceAuthorization(repoPath, {
        capabilities: ["tasks:destroy" as never],
      }),
    ).rejects.toThrow("unknown API token capability: tasks:destroy");
  });
});
