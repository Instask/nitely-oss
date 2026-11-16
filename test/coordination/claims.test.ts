import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  changeMutationDomains,
  claimWorkWake,
  collectCoordinationEvidence,
  coordinationLines,
  finishWorkWake,
  listUnknownWorkClaims,
  openCoordinationStore,
  recordWorkWake,
  releaseWorkWake,
  resolveUnknownWorkClaim,
  runGuardedMutation,
} from "../../src/coordination/claims.js";

const domain = "action:publish:nitely/run-1";
const head = "abc1234def5678abc1234def5678abc1234def56";
// Before any mutation these tests complete with the real clock.
const early = "2026-01-01T00:00:00.000Z";
const later = () => new Date(Date.now() + 1).toISOString();

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
      observedAt: early,
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
      observedAt: early,
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
      observedAt: early,
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
      observedAt: early,
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
      observedAt: later(),
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
      observedAt: early,
      runId: "run-a",
      idempotencyKey: "same",
      effect,
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/9", head }),
    });
    const replay = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedAt: early,
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
      observedAt: later(),
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
      observedAt: later(),
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

    // Another run is told which key blocks it, and still does not run.
    const blocked = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedAt: later(),
      runId: "run-c",
      idempotencyKey: "after-partial",
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/11" };
      },
      resultOf: () => ({ url: "https://github.com/acme/widgets/pull/11", head: "1111111" }),
    });
    expect(blocked).toEqual({ decision: "conflict", ownerRunId: "run-b", ownerKey: "partial" });
    expect(calls).toBe(1);
  });

  it("frees an unknown claim only on an operator's answer", async () => {
    const repoPath = await repo();
    const domains = [domain, "github-issue:acme/widgets#7"];
    const crash = (key: string, runId: string) => runGuardedMutation({
      repoPath,
      domains,
      observedAt: later(),
      runId,
      idempotencyKey: key,
      effect: async () => {
        throw new Error("push rejected");
      },
      resultOf: () => ({ head: "fffffff" }),
    });
    await expect(crash("lost", "run-a")).rejects.toThrow("push rejected");
    expect(listUnknownWorkClaims(repoPath)).toEqual([
      expect.objectContaining({ idempotencyKey: "lost", runId: "run-a", domains: expect.arrayContaining(domains) }),
    ]);

    expect(resolveUnknownWorkClaim(repoPath, { idempotencyKey: "lost", outcome: "not-applied" }))
      .toEqual({ runId: "run-a", domains: expect.arrayContaining(domains) });
    expect(listUnknownWorkClaims(repoPath)).toEqual([]);
    expect(() => resolveUnknownWorkClaim(repoPath, { idempotencyKey: "lost", outcome: "not-applied" }))
      .toThrow(/no unknown work claim/);

    // Not applied leaves the world as it was, so nothing is newer.
    const observedBefore = later();
    await expect(crash("lost-again", "run-b")).rejects.toThrow("push rejected");
    resolveUnknownWorkClaim(repoPath, {
      idempotencyKey: "lost-again",
      outcome: "applied",
      head: "abcdef1",
      url: "https://github.com/acme/widgets/pull/12",
    });
    // Applied is a completed mutation: a run that observed before it is
    // held, and the same key replays the operator's record.
    const held = await runGuardedMutation({
      repoPath,
      domains,
      observedAt: observedBefore,
      runId: "run-c",
      idempotencyKey: "after-applied",
      effect: async () => ({ url: "https://github.com/acme/widgets/pull/13" }),
      resultOf: () => ({ head: "1234567" }),
    });
    expect(held).toMatchObject({ decision: "hold", reason: "stale-cursor" });
    const replay = await runGuardedMutation({
      repoPath,
      domains,
      observedAt: later(),
      runId: "run-b",
      idempotencyKey: "lost-again",
      effect: async () => ({ url: "https://github.com/acme/widgets/pull/14" }),
      resultOf: () => ({ head: "7654321" }),
    });
    expect(replay).toEqual({
      decision: "replay",
      replayed: true,
      record: { url: "https://github.com/acme/widgets/pull/12", head: "abcdef1" },
    });
  });

  it("does not hold a run on mutations it already observed or made itself", async () => {
    const repoPath = await repo();
    const issue = "github-issue:acme/widgets#7";
    const pull = "github-pr:acme/widgets#22";
    let calls = 0;
    const mutate = (input: {
      action: string;
      runId: string;
      key: string;
      observedAt: string;
      head: string;
    }) => runGuardedMutation({
      repoPath,
      domains: [`action:${input.action}:acme/widgets#7`, issue, pull],
      observedAt: input.observedAt,
      runId: input.runId,
      idempotencyKey: input.key,
      effect: async () => {
        calls += 1;
        return { url: "https://github.com/acme/widgets/pull/22" };
      },
      resultOf: (result) => ({ url: result.url, head: input.head }),
    });

    const runACreated = later();
    await expect(mutate({ action: "publish", runId: "run-a", key: "a-publish", observedAt: runACreated, head: "aaaaaaa" }))
      .resolves.toMatchObject({ decision: "proceed" });
    // Its own publish does not hold run A's later update of the same work.
    await expect(mutate({ action: "update", runId: "run-a", key: "a-update", observedAt: runACreated, head: "bbbbbbb" }))
      .resolves.toMatchObject({ decision: "proceed" });

    // Run B starts after that. It observed head bbbbbbb plus a human push
    // Nitely never recorded. Neither is newer than what it read.
    const runBCreated = later();
    await expect(mutate({ action: "update", runId: "run-b", key: "b-update", observedAt: runBCreated, head: "ccccccc" }))
      .resolves.toMatchObject({ decision: "proceed" });
    // A run of the same issue created before run B's update is held once,
    // then stops at the re-evaluation limit.
    await expect(mutate({ action: "publish", runId: "run-c", key: "c-1", observedAt: runACreated, head: "ddddddd" }))
      .resolves.toMatchObject({
        decision: "hold",
        delta: expect.arrayContaining([`${issue} head ccccccc`]),
      });
    await expect(mutate({ action: "publish", runId: "run-c", key: "c-2", observedAt: runACreated, head: "ddddddd" }))
      .resolves.toMatchObject({ decision: "reevaluation-limit" });
    expect(calls).toBe(3);
  });

  it("opens a store written before mutations recorded their run", async () => {
    const repoPath = await repo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const legacy = new DatabaseSync(join(repoPath, ".nitely", "coordination.db"));
    legacy.exec(`
      CREATE TABLE world (
        domain TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        head TEXT NOT NULL,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    legacy.prepare("INSERT INTO world VALUES (?, 1, ?, ?, ?)").run(domain, head, `head ${head}`, "2026-06-01T00:00:00.000Z");
    legacy.close();

    // A legacy row has no owner, so it is never "this run": an observer from
    // before it is held, one from after proceeds.
    const before = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedAt: "2026-05-01T00:00:00.000Z",
      runId: "run-a",
      idempotencyKey: "legacy-before",
      effect: async () => ({ url: "https://github.com/acme/widgets/pull/1" }),
      resultOf: () => ({ head }),
    });
    expect(before.decision).toBe("hold");
    const after = await runGuardedMutation({
      repoPath,
      domains: [domain],
      observedAt: later(),
      runId: "run-b",
      idempotencyKey: "legacy-after",
      effect: async () => ({ url: "https://github.com/acme/widgets/pull/1" }),
      resultOf: () => ({ head }),
    });
    expect(after.decision).toBe("proceed");
  });

  it("releases a claim that has not started the effect", () => {
    const store = openCoordinationStore(join(tmpdir(), `nitely-coordination-abort-${Date.now()}`));
    try {
      const domains = [domain];
      expect(store.propose({
        domains,
        observedAt: early,
        runId: "run-a",
        idempotencyKey: "claim",
      }).decision).toBe("proceed");
      store.abort({ domains, idempotencyKey: "claim", runId: "run-a" });
      expect(store.propose({
        domains,
        observedAt: early,
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
