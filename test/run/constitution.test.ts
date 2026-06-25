import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConstitution } from "../../src/run/constitution.js";

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-constitution-"));
}

describe("loadConstitution", () => {
  it("returns unloaded metadata when no constitution file exists", async () => {
    const repoPath = await createRepo();

    await expect(loadConstitution(repoPath)).resolves.toEqual({
      loaded: false,
      path: ".nitely/constitution.md",
    });
  });

  it("treats an empty constitution as unloaded", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(join(repoPath, ".nitely", "constitution.md"), "  \n", "utf8");

    await expect(loadConstitution(repoPath)).resolves.toEqual({
      loaded: false,
      path: ".nitely/constitution.md",
    });
  });

  it("loads content with a deterministic sha256 hash", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely", "constitution.md"),
      "# Constitution\n\n- Keep evidence durable.\n",
      "utf8",
    );

    await expect(loadConstitution(repoPath)).resolves.toEqual({
      loaded: true,
      path: ".nitely/constitution.md",
      hash:
        "sha256:7b7ea312dadda779b586c030a7b63186a2408fd4965abf63e40d9e660223053d",
      content: "# Constitution\n\n- Keep evidence durable.\n",
    });
  });
});
