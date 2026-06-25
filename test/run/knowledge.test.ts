import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeStructuralFingerprint,
  injectAgentMemoryFiles,
  prepareAgentMemory,
  removeInjectedAgentMemoryFiles,
} from "../../src/run/knowledge.js";

async function createRepoFixture(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-knowledge-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "vitest" } }, null, 2),
    "utf8",
  );
  await writeFile(join(repo, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return repo;
}

describe("agent knowledge cache", () => {
  it("fingerprints structural inputs but ignores ordinary source edits", async () => {
    const repo = await createRepoFixture();

    const initial = await computeStructuralFingerprint(repo);
    await writeFile(join(repo, "src", "index.ts"), "export const value = 2;\n", "utf8");
    await expect(computeStructuralFingerprint(repo)).resolves.toBe(initial);

    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "vitest", build: "tsc" } }, null, 2),
      "utf8",
    );
    await expect(computeStructuralFingerprint(repo)).resolves.not.toBe(initial);
  });

  it("generates and reuses cached memory content for the same fingerprint", async () => {
    const repo = await createRepoFixture();

    const first = await prepareAgentMemory({
      repoPath: repo,
      runtime: "codex",
      model: "gpt-5",
      now: () => "2026-06-21T00:00:00.000Z",
    });
    expect(first.generated).toBe(true);
    expect(first.metadata.runtime).toBe("codex");
    expect(first.metadata.model).toBe("gpt-5");
    expect(first.metadata.generatedAt).toBe("2026-06-21T00:00:00.000Z");
    await expect(readFile(first.contentPath, "utf8")).resolves.toContain(
      "# Repository Memory",
    );
    await expect(
      readFile(join(repo, ".nitely", "knowledge", "agent-memory.json"), "utf8"),
    ).resolves.toContain(first.metadata.fingerprint);

    const second = await prepareAgentMemory({
      repoPath: repo,
      runtime: "claude",
      model: "claude-sonnet",
      now: () => "2026-06-21T00:10:00.000Z",
    });
    expect(second.generated).toBe(false);
    expect(second.metadata.generatedAt).toBe("2026-06-21T00:00:00.000Z");
    expect(second.contentPath).toBe(first.contentPath);
  });

  it("injects both memory filenames without overwriting user files", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "nitely-memory-wt-"));
    await writeFile(join(worktree, "AGENTS.md"), "# User Agents\n", "utf8");

    const injected = await injectAgentMemoryFiles({
      worktreePath: worktree,
      content: "# Generated Memory\n",
    });

    expect(injected.map((file) => file.filename)).toEqual(["CLAUDE.md"]);
    await expect(readFile(join(worktree, "AGENTS.md"), "utf8")).resolves.toBe(
      "# User Agents\n",
    );
    await expect(readFile(join(worktree, "CLAUDE.md"), "utf8")).resolves.toBe(
      "# Generated Memory\n",
    );

    await removeInjectedAgentMemoryFiles(injected);
    await expect(readFile(join(worktree, "AGENTS.md"), "utf8")).resolves.toBe(
      "# User Agents\n",
    );
    await expect(stat(join(worktree, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
