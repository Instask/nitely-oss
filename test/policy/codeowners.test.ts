import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codeOwnersForPath,
  codeOwnersForPaths,
  loadCodeOwners,
  parseCodeOwners,
} from "../../src/policy/codeowners.js";

const owners = {
  rules: parseCodeOwners(
    [
      "# Default owners",
      "*       @org/everyone",
      "/src/auth/  @org/security @alice",
      "docs/       @org/docs",
      "*.sql       @org/data",
      "",
    ].join("\n"),
  ),
};

describe("CODEOWNERS", () => {
  it("skips comments and ownerless patterns", () => {
    expect(parseCodeOwners("# nothing\n\nsrc/orphan.ts\n")).toEqual([]);
  });

  it("gives the last matching rule precedence, as GitHub does", () => {
    expect(codeOwnersForPath(owners, "src/auth/session.ts")?.owners).toEqual([
      "@org/security",
      "@alice",
    ]);
    expect(codeOwnersForPath(owners, "src/web/server.ts")?.owners).toEqual([
      "@org/everyone",
    ]);
    expect(codeOwnersForPath(owners, "db/migrate/001.sql")?.owners).toEqual([
      "@org/data",
    ]);
  });

  it("treats a directory pattern as everything beneath it", () => {
    expect(codeOwnersForPath(owners, "docs/plans/design.md")?.owners).toEqual([
      "@org/docs",
    ]);
  });

  it("collects the deduplicated owners of a change", () => {
    expect(
      codeOwnersForPaths(owners, [
        "src/auth/session.ts",
        "src/auth/token.ts",
        "README.md",
      ]),
    ).toEqual({
      owners: ["@alice", "@org/everyone", "@org/security"],
      paths: ["src/auth/session.ts", "src/auth/token.ts", "README.md"],
    });
  });

  it("reads the first CODEOWNERS file GitHub would read", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-codeowners-"));
    await mkdir(join(repo, ".github"), { recursive: true });
    await writeFile(join(repo, "CODEOWNERS"), "* @root\n", "utf8");
    await writeFile(join(repo, ".github/CODEOWNERS"), "* @github\n", "utf8");

    const loaded = await loadCodeOwners(repo);
    expect(loaded.sourcePath).toBe(".github/CODEOWNERS");
    expect(loaded.rules[0]?.owners).toEqual(["@github"]);
  });

  it("returns no rules when the repository has no CODEOWNERS", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-codeowners-empty-"));
    expect(await loadCodeOwners(repo)).toEqual({ rules: [] });
  });
});
