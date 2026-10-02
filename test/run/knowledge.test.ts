import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  computeStructuralFingerprint,
  injectAgentMemoryFiles,
  prepareAgentMemory,
  removeGeneratedAgentMemoryFilesFromGit,
  removeInjectedAgentMemoryFiles,
} from "../../src/run/knowledge.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

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

  it("uses the run HEAD and excludes untracked operator files", async () => {
    const repo = await createRepoFixture();
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "nitely@example.test"]);
    await git(repo, ["config", "user.name", "Nitely Test"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const { stdout: base } = await git(repo, ["rev-parse", "HEAD"]);
    const old = await prepareAgentMemory({ repoPath: repo, runtime: "claude" });
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "new-build" } }));
    await mkdir(join(repo, "specs"));
    await writeFile(join(repo, "specs", "host.md"), "host-only");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "host changes"]);
    const newer = await prepareAgentMemory({ repoPath: repo, runtime: "claude" });
    expect(newer.generated).toBe(true);
    expect(newer.metadata.fingerprint).not.toBe(old.metadata.fingerprint);
    expect(newer.content).toContain("new-build");

    const worktree = join(repo, ".nitely", "runs", "fixture", "worktree");
    await git(repo, ["worktree", "add", "--detach", worktree, base.trim()]);
    await writeFile(join(worktree, "server.log"), "operator data");
    await mkdir(join(worktree, ".gstack"));
    // An uncommitted manifest must not override the selected commit's commands.
    await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { test: "wrong" } }));
    const memory = await prepareAgentMemory({ repoPath: repo, sourceRepoPath: worktree, runtime: "claude" });
    expect(memory.content).toContain("- src/");
    expect(memory.content).toContain("- test: `vitest`");
    expect(memory.content).not.toContain("- - ");
    for (const hostOnly of ["server.log", ".gstack", "specs/", "new-build", "wrong"]) {
      expect(memory.content).not.toContain(hostOnly);
    }
    expect(memory.metadata.fingerprint).toBe(old.metadata.fingerprint);
    expect((await prepareAgentMemory({ repoPath: repo, sourceRepoPath: worktree, runtime: "claude" })).generated).toBe(false);
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

  it("removes staged generated memory files that are not tracked in HEAD", async () => {
    const repo = await createRepoFixture();
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "nitely@example.test"]);
    await git(repo, ["config", "user.name", "Nitely Test"]);
    await git(repo, ["add", "package.json", "src/index.ts"]);
    await git(repo, ["commit", "-m", "initial"]);

    await writeFile(
      join(repo, "CLAUDE.md"),
      [
        "# Repository Memory",
        "",
        "## Notes",
        "",
        "- This file is generated by Nitely from deterministic repository structure.",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(repo, ["add", "CLAUDE.md"]);

    await removeGeneratedAgentMemoryFilesFromGit(repo);

    const { stdout } = await git(repo, ["status", "--short"]);
    expect(stdout).not.toContain("CLAUDE.md");
    await expect(stat(join(repo, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
