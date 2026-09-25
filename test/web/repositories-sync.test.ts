import { describe, expect, it } from "vitest";

import { syncStoredWebRepository } from "../../src/web/repositories.js";

describe("syncStoredWebRepository", () => {
  it("refreshes a checkout Nitely cloned itself", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const synced = await syncStoredWebRepository(
      {
        id: "owner-repo",
        name: "owner/repo",
        path: "/checkouts/owner-repo",
        defaultBranch: "master",
        sourceUrl: "https://github.com/owner/repo.git",
        managed: true,
      },
      async (args, cwd) => {
        calls.push({ args, cwd });
      },
    );

    expect(synced).toBe(true);
    expect(calls).toEqual([
      {
        args: ["fetch", "--depth", "1", "origin", "master"],
        cwd: "/checkouts/owner-repo",
      },
      { args: ["reset", "--hard", "FETCH_HEAD"], cwd: "/checkouts/owner-repo" },
    ]);
  });

  it("never touches a repository registered by path", async () => {
    const calls: string[][] = [];
    const synced = await syncStoredWebRepository(
      {
        id: "working-tree",
        name: "working-tree",
        path: "/home/someone/project",
      },
      async (args) => {
        calls.push(args);
      },
    );

    expect(synced).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never resets a checkout that merely records a source URL", async () => {
    const calls: string[][] = [];
    const synced = await syncStoredWebRepository(
      {
        id: "acme-nitely",
        name: "acme/nitely",
        path: "/srv/acme/nitely",
        sourceUrl: "https://github.com/acme/nitely.git",
        home: true,
      },
      async (args) => {
        calls.push(args);
      },
    );

    expect(synced).toBe(false);
    expect(calls).toEqual([]);
  });

  it("falls back to HEAD when no default branch is recorded", async () => {
    const calls: string[][] = [];
    await syncStoredWebRepository(
      {
        id: "owner-repo",
        name: "owner/repo",
        path: "/checkouts/owner-repo",
        sourceUrl: "https://github.com/owner/repo.git",
        managed: true,
      },
      async (args) => {
        calls.push(args);
      },
    );

    expect(calls[0]).toEqual(["fetch", "--depth", "1", "origin", "HEAD"]);
  });
});
