import { access, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireKnowledgeLease,
  KnowledgeLeaseBusyError,
  KnowledgeLeaseLostError,
} from "../../src/knowledge-repositories/lock.js";
import { resolveKnowledgeRepositoryPaths } from "../../src/knowledge-repositories/paths.js";
import { normalizeCreateKnowledgeAttachment } from "../../src/knowledge-repositories/schema.js";
import {
  beginStoredKnowledgeRefresh,
  createStoredKnowledgeRepository,
  KnowledgeRefreshFencedError,
  publishStoredKnowledgeStatus,
  readKnowledgeRepositoryRegistry,
  writeKnowledgeJsonAtomic,
} from "../../src/knowledge-repositories/store.js";

async function fixturePaths() {
  const root = await mkdtemp(join(tmpdir(), "nitely-kb-store-"));
  const targetRepoPath = await mkdtemp(join(root, "target-"));
  const runtimeRoot = join(root, "runtime");
  return {
    root,
    paths: await resolveKnowledgeRepositoryPaths({ targetRepoPath, runtimeRoot }),
  };
}

describe("knowledge repository paths and atomic store", () => {
  it("keeps runtime state outside the target and writes atomic JSON as mode 0600", async () => {
    const { paths } = await fixturePaths();
    const documentPath = join(paths.targetRoot, "atomic.json");

    await writeKnowledgeJsonAtomic(documentPath, { generation: 1 });
    await writeKnowledgeJsonAtomic(documentPath, { generation: 2 });

    expect(JSON.parse(await readFile(documentPath, "utf8"))).toEqual({ generation: 2 });
    expect((await stat(documentPath)).mode & 0o777).toBe(0o600);
    expect(paths.runtimeRoot.startsWith(paths.targetRepoPath)).toBe(false);
  });

  it("prefers the injectable state directory and rejects state inside the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-kb-paths-"));
    const targetRepoPath = await mkdtemp(join(root, "target-"));
    const configured = join(root, "configured-state");
    const paths = await resolveKnowledgeRepositoryPaths({
      targetRepoPath,
      env: {
        NITELY_KNOWLEDGE_STATE_DIR: configured,
        NITELY_KNOWLEDGE_RUNTIME_ROOT: join(root, "legacy-state"),
      },
    });

    expect(paths.runtimeRoot).toBe(configured);
    await expect(resolveKnowledgeRepositoryPaths({
      targetRepoPath,
      runtimeRoot: join(targetRepoPath, ".nitely", "knowledge"),
    })).rejects.toThrow(/outside the target repository/);
  });

  it("uses monotonic refresh generations to fence stale status publishers", async () => {
    const { paths } = await fixturePaths();
    const attachment = normalizeCreateKnowledgeAttachment({
      id: "standards",
      name: "Engineering standards",
      source: { type: "local", path: paths.targetRepoPath },
      ref: { type: "branch", value: "main" },
    }, { now: "2026-07-21T00:00:00.000Z", canonicalLocalPath: paths.targetRepoPath });
    await createStoredKnowledgeRepository(paths, attachment);

    const first = await beginStoredKnowledgeRefresh(
      paths,
      attachment.id,
      "2026-07-21T00:01:00.000Z",
    );
    const second = await beginStoredKnowledgeRefresh(
      paths,
      attachment.id,
      "2026-07-21T00:02:00.000Z",
    );

    await expect(publishStoredKnowledgeStatus(paths, attachment.id, first.refreshGeneration, {
      version: 1,
      attachmentId: attachment.id,
      state: "failed",
      retrievalMode: "hybrid",
      staleReasons: [],
      refreshGeneration: first.refreshGeneration,
    })).rejects.toBeInstanceOf(KnowledgeRefreshFencedError);

    await publishStoredKnowledgeStatus(paths, attachment.id, second.refreshGeneration, {
      version: 1,
      attachmentId: attachment.id,
      state: "failed",
      retrievalMode: "hybrid",
      staleReasons: [],
      refreshGeneration: second.refreshGeneration,
    });
    const registry = await readKnowledgeRepositoryRegistry(paths);
    expect(registry.attachments[0]!.refreshGeneration).toBe(2);
    expect(registry.generation).toBeGreaterThanOrEqual(4);
    expect((await stat(paths.registryPath)).mode & 0o777).toBe(0o600);
  });
});

describe("knowledge repository leases", () => {
  it("can reclaim an abandoned ownerless acquisition directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-kb-ownerless-"));
    const leasePath = join(root, "refresh.lock");
    await mkdir(leasePath);
    const old = new Date(Date.now() - 120_000);
    await utimes(leasePath, old, old);

    const lease = await acquireKnowledgeLease({
      path: leasePath,
      staleMs: 10,
      heartbeatMs: 60_000,
    });
    await expect(lease.assertOwned()).resolves.toBeUndefined();
    await lease.release();
  });

  it("rejects concurrent owners and does not let a reclaimed owner remove its successor", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-kb-lease-"));
    const leasePath = join(root, "refresh.lock");
    const first = await acquireKnowledgeLease({
      path: leasePath,
      staleMs: 60_000,
      heartbeatMs: 60_000,
    });
    expect((await stat(join(leasePath, "owner.json"))).mode & 0o777).toBe(0o600);
    await expect(acquireKnowledgeLease({ path: leasePath, waitMs: 0 }))
      .rejects.toBeInstanceOf(KnowledgeLeaseBusyError);

    const ownerPath = join(leasePath, "owner.json");
    const old = new Date(Date.now() - 120_000);
    await utimes(ownerPath, old, old);
    await expect(acquireKnowledgeLease({
      path: leasePath,
      staleMs: 10,
      heartbeatMs: 60_000,
    })).rejects.toBeInstanceOf(KnowledgeLeaseBusyError);

    await writeFile(ownerPath, `${JSON.stringify({
      version: 1,
      token: first.token,
      pid: 2_147_483_647,
      acquiredAt: old.toISOString(),
    })}\n`);
    await utimes(ownerPath, old, old);
    const successor = await acquireKnowledgeLease({
      path: leasePath,
      staleMs: 10,
      heartbeatMs: 60_000,
    });
    expect(successor.token).not.toBe(first.token);
    await expect(first.assertOwned()).rejects.toBeInstanceOf(
      KnowledgeLeaseLostError,
    );
    await expect(successor.assertOwned()).resolves.toBeUndefined();

    await first.release();
    await expect(access(join(leasePath, "owner.json"))).resolves.toBeUndefined();
    await successor.release();
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
