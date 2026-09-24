import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  migrateHomeRepository,
  publicRepository,
  readGitOriginUrl,
  repositoryById,
  resolveWebRepositories,
} from "../../src/web/repositories.js";
import {
  WebInputError,
  WebNotFoundError,
} from "../../src/web/errors.js";

describe("resolveWebRepositories", () => {
  it("derives home and managed flags from each entry's path", () => {
    const repositories = resolveWebRepositories("/srv/nitely", [
      { id: "home", name: "Home", path: "/srv/nitely" },
      {
        id: "app",
        name: "App",
        path: "/srv/nitely/.nitely/repositories/app",
        sourceUrl: "https://github.com/acme/app.git",
      },
      { id: "tree", name: "Tree", path: "/home/someone/tree" },
    ]);

    const home = repositories.find((repository) => repository.id === "home");
    const app = repositories.find((repository) => repository.id === "app");
    const tree = repositories.find((repository) => repository.id === "tree");

    expect(home).toMatchObject({ home: true });
    expect(home).not.toHaveProperty("managed");
    expect(app).toMatchObject({ managed: true });
    expect(app).not.toHaveProperty("home");
    expect(tree).not.toHaveProperty("home");
    expect(tree).not.toHaveProperty("managed");
  });

  it("does not treat a sibling of the managed root as managed", () => {
    const [repository] = resolveWebRepositories("/srv/nitely", [
      { id: "sib", name: "Sib", path: "/srv/nitely/.nitely/repositories-old/sib" },
    ]).filter((candidate) => candidate.id === "sib");

    expect(repository).not.toHaveProperty("managed");
  });

  it("registers nothing for the home directory by itself", () => {
    expect(resolveWebRepositories("/srv/nitely", [])).toEqual([]);
  });

  it("requires an id and reserves the legacy default id", () => {
    expect(() =>
      resolveWebRepositories("/srv/nitely", [{ path: "/srv/nitely" }]),
    ).toThrow("repository id is required");
    expect(() =>
      resolveWebRepositories("/srv/nitely", [{ id: "default", path: "/srv/nitely" }]),
    ).toThrow("repository id default is reserved");
  });
});

describe("publicRepository", () => {
  it("drops the server path and the derived flags", () => {
    expect(
      publicRepository({
        id: "app",
        name: "App",
        path: "/srv/nitely/.nitely/repositories/app",
        defaultBranch: "main",
        sourceUrl: "https://github.com/acme/app.git",
        organizationId: "org-1",
        home: true,
        managed: true,
      }),
    ).toEqual({
      id: "app",
      name: "App",
      defaultBranch: "main",
      sourceUrl: "https://github.com/acme/app.git",
      organizationId: "org-1",
    });
  });
});

describe("repositoryById", () => {
  const home = { id: "home", name: "Home", path: "/srv/nitely", home: true as const };
  const app = { id: "app", name: "App", path: "/srv/nitely/.nitely/repositories/app" };

  it("returns the entry with the requested id", () => {
    expect(repositoryById([home, app], "app")).toBe(app);
  });

  it("resolves an omitted id to the home entry", () => {
    expect(repositoryById([app, home], undefined)).toBe(home);
    expect(repositoryById([app, home], "")).toBe(home);
  });

  it("resolves the legacy default id to the home entry", () => {
    expect(repositoryById([app, home], "default")).toBe(home);
  });

  it("requires an id when no entry is the home checkout", () => {
    expect(() => repositoryById([app], undefined)).toThrow(WebInputError);
    expect(() => repositoryById([app], "default")).toThrow("repoId is required");
  });

  it("reports unknown ids as not found", () => {
    expect(() => repositoryById([home, app], "nope")).toThrow(WebNotFoundError);
  });
});

const execFileAsync = promisify(execFile);

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-repositories-"));
}

async function storedRepositories(home: string) {
  const file = JSON.parse(
    await readFile(join(home, ".nitely", "repositories.json"), "utf8"),
  ) as { repositories: Array<Record<string, unknown>> };
  return file.repositories;
}

describe("migrateHomeRepository", () => {
  it("registers the home checkout from its GitHub origin exactly once", async () => {
    const home = await tempHome();
    const readOriginUrl = async () => "git@github.com:acme/nitely.git";

    const first = await migrateHomeRepository(home, readOriginUrl);
    expect(first).toEqual({
      status: "registered",
      repository: expect.objectContaining({
        id: "acme-nitely",
        name: "acme/nitely",
        path: resolve(home),
        sourceUrl: "git@github.com:acme/nitely.git",
        home: true,
      }),
    });

    const second = await migrateHomeRepository(home, readOriginUrl);
    expect(second).toEqual({ status: "skipped", reason: "already-registered" });
    expect(await storedRepositories(home)).toEqual([
      {
        id: "acme-nitely",
        name: "acme/nitely",
        path: resolve(home),
        sourceUrl: "git@github.com:acme/nitely.git",
      },
    ]);
  });

  it("registers nothing when home has no origin", async () => {
    const home = await tempHome();
    expect(await migrateHomeRepository(home, async () => undefined)).toEqual({
      status: "skipped",
      reason: "no-origin",
    });
    await expect(
      readFile(join(home, ".nitely", "repositories.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers nothing when the origin is not on github.com", async () => {
    const home = await tempHome();
    expect(
      await migrateHomeRepository(home, async () => "https://gitlab.com/acme/nitely.git"),
    ).toEqual({
      status: "skipped",
      reason: "origin-not-github",
      originUrl: "https://gitlab.com/acme/nitely.git",
    });
  });

  it("skips when a stored entry already covers the same source or the home path", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".nitely"), { recursive: true });
    await writeFile(
      join(home, ".nitely", "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [
          {
            id: "already",
            name: "Already",
            path: join(home, ".nitely", "repositories", "already"),
            sourceUrl: "https://github.com/ACME/Nitely.git",
          },
        ],
      }),
      "utf8",
    );
    expect(
      await migrateHomeRepository(home, async () => "git@github.com:acme/nitely.git"),
    ).toEqual({
      status: "skipped",
      reason: "source-already-registered",
      originUrl: "git@github.com:acme/nitely.git",
    });

    await writeFile(
      join(home, ".nitely", "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [{ id: "tree", name: "Tree", path: home }],
      }),
      "utf8",
    );
    expect(
      await migrateHomeRepository(home, async () => "git@github.com:other/repo.git"),
    ).toEqual({ status: "skipped", reason: "already-registered" });
    expect(await storedRepositories(home)).toHaveLength(1);
  });

  it("skips with id-collision when a differently-sourced entry already holds the derived id", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".nitely"), { recursive: true });
    await writeFile(
      join(home, ".nitely", "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [
          {
            id: "acme-nitely",
            name: "Unrelated",
            path: join(home, ".nitely", "repositories", "acme-nitely"),
            sourceUrl: "https://github.com/acme/other-nitely.git",
          },
        ],
      }),
      "utf8",
    );
    expect(
      await migrateHomeRepository(home, async () => "git@github.com:acme/nitely.git"),
    ).toEqual({
      status: "skipped",
      reason: "id-collision",
      originUrl: "git@github.com:acme/nitely.git",
    });
    expect(await storedRepositories(home)).toHaveLength(1);
  });
});

describe("readGitOriginUrl", () => {
  it("reads origin only when the directory is the repository top level", async () => {
    const root = await tempHome();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await execFileAsync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    const nested = join(root, "nested");
    await mkdir(nested);

    expect(await readGitOriginUrl(root)).toBe("https://github.com/acme/app.git");
    expect(await readGitOriginUrl(nested)).toBeUndefined();
  });

  it("returns undefined outside any repository", async () => {
    expect(await readGitOriginUrl(await tempHome())).toBeUndefined();
  });
});
