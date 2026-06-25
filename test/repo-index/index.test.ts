import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRepoIndex,
  queryRepoIndex,
  readRepoIndex,
} from "../../src/repo-index/index.js";

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-repo-index-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(
    join(repo, "src", "helper.ts"),
    "export function helper() { return 'ok'; }\n",
    "utf8",
  );
  await writeFile(
    join(repo, "src", "main.ts"),
    "import { helper } from './helper.js';\nexport class MainService { run() { return helper(); } }\n",
    "utf8",
  );
  await writeFile(
    join(repo, "test", "main.test.ts"),
    "import { MainService } from '../src/main';\nnew MainService().run();\n",
    "utf8",
  );
  return repo;
}

describe("repository index", () => {
  it("builds an index with files, symbols, imports, and imported-by edges", async () => {
    const repo = await createRepo();

    const { index, indexPath } = await buildRepoIndex(repo);

    expect(indexPath).toBe(join(repo, ".nitely", "repo-index.json"));
    expect(index.files.map((file) => file.path)).toEqual([
      "src/helper.ts",
      "src/main.ts",
      "test/main.test.ts",
    ]);
    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "helper", path: "src/helper.ts", exported: true }),
        expect.objectContaining({ name: "MainService", path: "src/main.ts", exported: true }),
      ]),
    );
    expect(index.files.find((file) => file.path === "src/main.ts")?.imports).toEqual([
      "src/helper.ts",
    ]);
    expect(index.files.find((file) => file.path === "src/main.ts")?.importedBy).toEqual([
      "test/main.test.ts",
    ]);
    await expect(readFile(indexPath, "utf8")).resolves.toContain("MainService");
  });

  it("queries related files by symbol and path", async () => {
    const repo = await createRepo();
    await buildRepoIndex(repo);

    const symbolResult = await queryRepoIndex({
      repoPath: repo,
      query: "MainService",
    });

    expect(symbolResult.matches.map((match) => match.path)).toEqual([
      "src/main.ts",
      "test/main.test.ts",
      "src/helper.ts",
    ]);
    expect(symbolResult.matches[0]?.reasons).toContain("symbol");
    expect(symbolResult.matches[1]?.reasons).toContain("imported-by");

    const pathResult = await queryRepoIndex({
      repoPath: repo,
      query: "src/main.ts",
    });

    expect(pathResult.matches.map((match) => match.path)).toEqual([
      "src/main.ts",
      "test/main.test.ts",
      "src/helper.ts",
    ]);
    expect(pathResult.matches[0]?.reasons).toContain("path");
  });

  it("respects context policy exclusions and warn-only omissions", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "secrets"), { recursive: true });
    await writeFile(
      join(repo, "nitely.context.json"),
      JSON.stringify({
        version: 1,
        exclude: ["secrets/**", "src/helper.ts"],
        warnOnly: true,
      }),
      "utf8",
    );
    await writeFile(
      join(repo, "secrets", "token.ts"),
      "export const token = 'secret';\n",
      "utf8",
    );

    const { index } = await buildRepoIndex(repo);

    expect(index.files.map((file) => file.path)).toEqual([
      "nitely.context.json",
      "src/main.ts",
      "test/main.test.ts",
    ]);
    expect(index.symbols.map((symbol) => symbol.name)).not.toContain("token");
    expect(index.symbols.map((symbol) => symbol.name)).not.toContain("helper");
  });

  it("reports stale indexes when indexed files change", async () => {
    const repo = await createRepo();
    await buildRepoIndex(repo);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(repo, "src", "main.ts"),
      "export class MainService { changed() { return true; } }\n",
      "utf8",
    );

    const result = await queryRepoIndex({ repoPath: repo, query: "MainService" });

    expect(result.stale.stale).toBe(true);
    expect(result.stale.reasons.join("\n")).toContain("src/main.ts");
  });

  it("can read the persisted index", async () => {
    const repo = await createRepo();
    const { index } = await buildRepoIndex(repo);

    await expect(readRepoIndex(repo)).resolves.toMatchObject({
      schemaVersion: index.schemaVersion,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "src/main.ts" }),
      ]),
    });
  });
});
