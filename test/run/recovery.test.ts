import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  readRecoverySnapshot,
  writeRecoverySnapshot,
} from "../../src/run/recovery.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepo(): Promise<{ repo: string; baseSha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-recovery-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Nitely Test");
  await git(repo, "config", "user.email", "nitely@example.test");
  await writeFile(join(repo, "tracked.txt"), "before\n", "utf8");
  await git(repo, "add", "tracked.txt");
  await git(repo, "commit", "-m", "base");
  return { repo, baseSha: await git(repo, "rev-parse", "HEAD") };
}

describe("recovery snapshots", () => {
  it("writes a valid bounded patch for tracked, staged, committed, and untracked work", async () => {
    const { repo, baseSha } = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-recovery");
    await writeFile(join(repo, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(repo, "staged.txt"), "staged\n", "utf8");
    await git(repo, "add", "staged.txt");
    await git(repo, "commit", "-m", "partial commit");
    await writeFile(join(repo, "index-only.txt"), "staged only\n", "utf8");
    await git(repo, "add", "index-only.txt");
    await writeFile(join(repo, "untracked.txt"), "untracked\n", "utf8");

    const snapshot = await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-recovery",
      stageId: "implement",
      attempt: 2,
      baseSha,
      now: () => new Date("2026-07-14T10:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      version: 1,
      runId: "run-recovery",
      stageId: "implement",
      attempt: 2,
      baseSha,
      status: "available",
      capturedAt: "2026-07-14T10:00:00.000Z",
      patchPath: "recovery.patch",
      changedPaths: ["index-only.txt", "staged.txt", "tracked.txt", "untracked.txt"],
      untrackedPaths: ["untracked.txt"],
      omitted: [],
    });
    expect(snapshot.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.patchBytes).toBeGreaterThan(0);
    expect(snapshot.patchSha256).toMatch(/^[0-9a-f]{64}$/);

    const patch = await readFile(join(runDirectory, "recovery.patch"), "utf8");
    expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch).toContain("diff --git a/index-only.txt b/index-only.txt");
    expect(patch).toContain("diff --git a/staged.txt b/staged.txt");
    expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt");
    expect(patch).toContain("+untracked");
    await expect(
      git(repo, "apply", "--check", "--reverse", join(runDirectory, "recovery.patch")),
    ).resolves.toBe("");
    await expect(readRecoverySnapshot({ runDirectory })).resolves.toEqual(snapshot);
    expect((await readdir(runDirectory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("does not follow untracked symlinks outside the worktree", async () => {
    const { repo, baseSha } = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-symlink");
    const outside = join(await mkdtemp(join(tmpdir(), "nitely-recovery-outside-")), "secret.txt");
    await writeFile(outside, "outside-secret-sentinel\n", "utf8");
    await symlink(outside, join(repo, "outside-link"));

    const snapshot = await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-symlink",
      stageId: "implement",
      attempt: 1,
      baseSha,
    });

    expect(snapshot.status).toBe("available");
    const patch = await readFile(join(runDirectory, "recovery.patch"), "utf8");
    expect(patch).toContain("120000");
    expect(patch).toContain(outside);
    expect(patch).not.toContain("outside-secret-sentinel");
  });

  it("omits oversized untracked files without byte-truncating a valid patch", async () => {
    const { repo, baseSha } = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-bounded");
    await writeFile(join(repo, "small.txt"), "small\n", "utf8");
    await writeFile(join(repo, "large.txt"), "x".repeat(2_000), "utf8");

    const snapshot = await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-bounded",
      stageId: "implement",
      attempt: 1,
      baseSha,
      maxPatchBytes: 4_096,
      maxUntrackedFileBytes: 100,
    });

    expect(snapshot).toMatchObject({
      status: "partial",
      patchPath: "recovery.patch",
      untrackedPaths: ["large.txt", "small.txt"],
      omitted: [{ path: "large.txt", reason: "file exceeds 100 byte limit" }],
    });
    const patch = await readFile(join(runDirectory, "recovery.patch"), "utf8");
    expect(patch).toContain("diff --git a/small.txt b/small.txt");
    expect(patch).not.toContain("diff --git a/large.txt b/large.txt");
    expect(Buffer.byteLength(patch, "utf8")).toBe(snapshot.patchBytes);
  });

  it("records a clean checkpoint and removes an obsolete patch", async () => {
    const { repo, baseSha } = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-clean");
    await writeFile(join(repo, "tracked.txt"), "after\n", "utf8");
    await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-clean",
      stageId: "implement",
      attempt: 1,
      baseSha,
    });
    await git(repo, "reset", "--hard", baseSha);

    const snapshot = await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-clean",
      stageId: "verify",
      attempt: 1,
      baseSha,
    });

    expect(snapshot).toMatchObject({
      status: "clean",
      changedPaths: [],
      untrackedPaths: [],
      omitted: [],
    });
    expect(snapshot.patchPath).toBeUndefined();
    await expect(readFile(join(runDirectory, "recovery.patch"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an unavailable checkpoint without throwing or retaining a stale patch", async () => {
    const { repo, baseSha } = await createRepo();
    const runDirectory = join(repo, ".nitely", "runs", "run-unavailable");
    await writeFile(join(repo, "tracked.txt"), "after\n", "utf8");
    await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-unavailable",
      stageId: "implement",
      attempt: 1,
      baseSha,
    });

    const snapshot = await writeRecoverySnapshot({
      runDirectory,
      worktreePath: repo,
      runId: "run-unavailable",
      stageId: "implement",
      attempt: 2,
      baseSha: "not-a-commit",
    });

    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toContain("not-a-commit");
    await expect(readRecoverySnapshot({ runDirectory })).resolves.toEqual(snapshot);
    await expect(readFile(join(runDirectory, "recovery.patch"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
