import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changeMutationDomains,
  claimWorkWake,
  collectCoordinationEvidence,
  coordinationLines,
  finishWorkWake,
  openCoordinationStore,
  recordWorkWake,
  releaseWorkWake,
  runGuardedMutation,
} from "../../src/coordination/claims.js";

const domain = "action:publish:nitely/run-1";
const head = "abc1234def5678abc1234def5678abc1234def56";

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nitely-coordination-"));
}

describe("work coordination claims", () => {
  it("accepts GitHub owners and keeps conflict domains distinct", () => {
    expect(changeMutationDomains({
      action: "update",
      branch: "nitely/pr-22",
      worktreePath: "/tmp/worktree",
      pull: { owner: "Instask", repository: "nitely", number: 22 },
      issue: { owner: "Instask", repository: "nitely", number: 7 },
      artifactIds: ["implementation", "not a valid id"],
    })).toEqual([
      "action:update:Instask/nitely#22",
      "branch:nitely/pr-22",
      expect.stringMatching(/^worktree:[0-9a-f]{16}$/),
      "github-issue:Instask/nitely#7",
      "github-pr:Instask/nitely#22",
      "artifact:implementation",
    ]);
  });

  it("lets one claim win and holds a stale cursor without repeating the effect", async () => {
    const repoPath = await repo();
    let releaseFirst: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const first = runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-a",
      idempotencyKey: "publish-a",
      effect: async () => {
        calls += 1;
        entered();
        await release;
        return { url: "https://github.com/acme/widgets/pull/1" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/1", head }),
    });
    await started;
    const overlapping = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-b",
      idempotencyKey: "publish-b",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/2" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/2", head }),
    });
    expect(overlapping).toMatchObject({ decision: "conflict", ownerRunId: "run-a" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({
      decision: "proceed",
      replayed: false,
      result: { url: "https://github.com/acme/widgets/pull/1" },
    });
    expect(calls).toBe(1);

    const held = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-c",
      idempotencyKey: "publish-c",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/3" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/3", head: "bbbbbbb" }),
    });
    expect(held).toMatchObject({
      decision: "hold",
      reason: "stale-cursor",
      delta: [`${domain} head ${head}`],
    });
    const limited = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-c",
      idempotencyKey: "publish-d",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/4" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/4", head: "ccccccc" }),
    });
    expect(limited.decision).toBe("reevaluation-limit");
    expect(calls).toBe(1);

    const reread = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: head,
      runId: "run-d",
      idempotencyKey: "publish-e",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/5" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/5", head: "ddddddd" }),
    });
    expect(reread.decision).toBe("proceed");
    expect(calls).toBe(2);
  });

  it("replays a completed key and refuses to replay an unknown effect", async () => {
    const repoPath = await repo();
    let calls = 0;
    const effect = async () => {
      calls += 1;
      return { url: "https://github.com/acme/widgets/pull/9" };
    };
    const first = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-a",
      idempotencyKey: "same",
      effect,
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/9", head }),
    });
    const replay = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: "none",
      runId: "run-a",
      idempotencyKey: "same",
      effect,
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/9", head: "eeeeeee" }),
    });
    expect(first.decision).toBe("proceed");
    expect(replay).toEqual({
      decision: "replay",
      replayed: true,
      record: { url: "https://github.com/acme/widgets/pull/9", head },
    });
    expect(calls).toBe(1);

    await expect(runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: head,
      runId: "run-b",
      idempotencyKey: "partial",
      effect: async () => {
        throw new Error("worker crashed");
      },
      resultOf: () => ({ head: "fffffff" }),
    })).rejects.toThrow("worker crashed");
    const unknown = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedHead: head,
      runId: "run-b",
      idempotencyKey: "partial",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/10" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/10", head: "fffffff" }),
    });
    expect(unknown).toEqual({ decision: "unknown", reason: "effect-started" });
    expect(calls).toBe(1);
  });

  it("releases a claim that has not started the effect", () => {
    const store = openCoordinationStore(join(tmpdir(), `nitely-coordination-abort-${Date.now()}`));
    try {
      const domains = [domain];
      const seen = store.snapshot(domains, "none");
      expect(store.propose({
        domains,
        seen,
        runId: "run-a",
        idempotencyKey: "claim",
      }).decision).toBe("proceed");
      store.abort({ domains, idempotencyKey: "claim", runId: "run-a" });
      expect(store.propose({
        domains,
        seen,
        runId: "run-b",
        idempotencyKey: "other",
      }).decision).toBe("proceed");
    } finally {
      store.close();
    }
  });

  it("coalesces duplicate and out-of-order wakes and retries the lead", () => {
    const repoPath = join(tmpdir(), `nitely-coordination-wake-${Date.now()}`);
    const wakeDomain = "github-issue:acme/widgets#7";
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:40.000Z",
      deliveryId: "newer",
    })).toBe("lead");
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:10.000Z",
      deliveryId: "older",
    })).toBe("stale");
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:40.000Z",
      deliveryId: "newer",
    })).toBe("lead");
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:40.000Z",
      deliveryId: "same-cursor",
    })).toBe("coalesced");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:00:00.000Z",
      leaseMs: 120_000,
    })).toBe("skip");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:00:00.000Z",
      leaseMs: 120_000,
    })).toBe("process");
    releaseWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
    });
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:02:00.000Z",
      leaseMs: 120_000,
    })).toBe("process");
    finishWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
    });
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:03:00.000Z",
      leaseMs: 120_000,
    })).toBe("skip");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:03:00.000Z",
      leaseMs: 120_000,
    })).toBe("process");
    expect(claimWorkWake(repoPath, {
      domain: "github-pr:acme/widgets#9",
      deliveryId: "missing",
      owner: "delivery:missing",
      now: "2026-07-16T04:03:00.000Z",
      leaseMs: 120_000,
    })).toBe("absent");
  });

  it("keeps a newer lead claimable while an older lease is still held", () => {
    const repoPath = join(tmpdir(), `nitely-coordination-wake-blocked-${Date.now()}`);
    const wakeDomain = "github-issue:acme/widgets#7";
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:10.000Z",
      deliveryId: "older",
    })).toBe("lead");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:00:00.000Z",
      leaseMs: 120_000,
    })).toBe("process");
    expect(recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:50.000Z",
      deliveryId: "newer",
    })).toBe("lead");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:00:01.000Z",
      leaseMs: 120_000,
    })).toBe("blocked");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:00:01.000Z",
      leaseMs: 120_000,
    })).toBe("skip");
    expect(finishWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:00:02.000Z",
    })).toBe("released");
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:00:03.000Z",
      leaseMs: 120_000,
    })).toBe("process");
  });

  it("does not let an older worker release a newer wake lease", () => {
    const repoPath = join(tmpdir(), `nitely-coordination-wake-owner-${Date.now()}`);
    const wakeDomain = "github-issue:acme/widgets#7";
    recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:10.000Z",
      deliveryId: "older",
    });
    claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:00:00.000Z",
      leaseMs: 120_000,
    });
    recordWorkWake(repoPath, {
      domain: wakeDomain,
      cursor: "2026-07-16T03:59:50.000Z",
      deliveryId: "newer",
    });
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:03:00.000Z",
      leaseMs: 120_000,
    })).toBe("process");
    expect(finishWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:03:01.000Z",
    })).toBe("ignored");
    expect(releaseWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "older",
      owner: "delivery:older",
      now: "2026-07-16T04:03:01.000Z",
    })).toBeUndefined();
    expect(claimWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:other",
      now: "2026-07-16T04:03:02.000Z",
      leaseMs: 120_000,
    })).toBe("blocked");
    expect(finishWorkWake(repoPath, {
      domain: wakeDomain,
      deliveryId: "newer",
      owner: "delivery:newer",
      now: "2026-07-16T04:03:03.000Z",
    })).toBe("done");
  });

  it("drops coordination records that carry undeclared fields", async () => {
    const directory = await repo();
    await mkdir(join(directory, "stages", "publish", "1"), { recursive: true });
    await writeFile(
      join(directory, "stages", "publish", "1", "coordination.jsonl"),
      [
        JSON.stringify({
          decision: "hold",
          reason: "stale-cursor",
          delta: [`${domain} head ${head}`],
        }),
        JSON.stringify({
          decision: "hold",
          reason: "stale-cursor",
          argv: "super-secret-value",
        }),
      ].join("\n"),
      "utf8",
    );
    const text = await collectCoordinationEvidence(directory);
    expect(text).toContain("HOLD stale-cursor");
    expect(text).toContain(`delta ${domain} head ${head}`);
    expect(text).not.toContain("super-secret-value");
    expect(coordinationLines(JSON.stringify({
      decision: "proceed",
      head,
      command: "curl",
    }))).toEqual([]);
  });
});
