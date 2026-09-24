import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importLocalSkill,
  previewLocalSkillImport,
} from "../../src/skills/import.js";
import { loadStageSkills } from "../../src/skills/load.js";
import { listRepositorySkills } from "../../src/web/skills.js";

async function createDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeSourceSkill(
  root: string,
  id: string,
  body = "Follow the local checklist.\n",
): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${id}`,
      "description: Local imported skill",
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
  return directory;
}

describe("importLocalSkill", () => {
  it("previews a local skill without creating the target directory", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const sourceRoot = await createDirectory("nitely-skill-import-source-");
    const source = await writeSourceSkill(sourceRoot, "preview");
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "docs", "guide.md"), "Use the preview.\n", "utf8");

    const preview = await previewLocalSkillImport({ sourcePath: source, repoPath: repo });

    expect(preview).toMatchObject({
      id: "preview",
      name: "preview",
      description: "Local imported skill",
      sourcePath: source,
      targetPath: ".nitely/skills/preview",
      resourceCount: 1,
      targetExists: false,
      overwriteRequired: false,
    });
    expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readFile(join(repo, ".nitely", "skills", "preview", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("marks existing preview targets as requiring overwrite unless requested", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const source = await writeSourceSkill(
      await createDirectory("nitely-skill-import-source-"),
      "existing",
    );
    await importLocalSkill({ sourcePath: source, repoPath: repo });

    await expect(
      previewLocalSkillImport({ sourcePath: source, repoPath: repo }),
    ).resolves.toMatchObject({
      id: "existing",
      targetExists: true,
      overwriteRequired: true,
    });
    await expect(
      previewLocalSkillImport({ sourcePath: source, repoPath: repo, overwrite: true }),
    ).resolves.toMatchObject({
      id: "existing",
      targetExists: true,
      overwriteRequired: false,
    });
  });

  it("imports a skill directory with resources and remains loadable at run time", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const sourceRoot = await createDirectory("nitely-skill-import-source-");
    const source = await writeSourceSkill(sourceRoot, "review");
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "docs", "checklist.md"), "Check tests\n", "utf8");

    const imported = await importLocalSkill({ sourcePath: source, repoPath: repo });

    expect(imported).toMatchObject({
      id: "review",
      targetPath: ".nitely/skills/review",
      resourceCount: 1,
    });
    expect(imported.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readFile(join(repo, ".nitely", "skills", "review", "docs", "checklist.md"), "utf8"),
    ).resolves.toBe("Check tests\n");

    const [loaded] = await loadStageSkills({
      repoPath: repo,
      runDirectory: join(repo, ".nitely", "runs", "run-imported-skill"),
      stageId: "implement",
      skillIds: ["review"],
    });
    expect(loaded.contentHash).toBe(imported.contentHash);
    expect(loaded.resources).toHaveLength(1);
  });

  it("imports a single SKILL.md file without neighboring resource files", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const source = await writeSourceSkill(
      await createDirectory("nitely-skill-import-source-"),
      "solo",
    );
    await writeFile(join(source, "notes.md"), "do not copy\n", "utf8");

    const imported = await importLocalSkill({
      sourcePath: join(source, "SKILL.md"),
      repoPath: repo,
    });

    expect(imported).toMatchObject({
      id: "solo",
      resourceCount: 0,
    });
    await expect(
      readFile(join(repo, ".nitely", "skills", "solo", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: solo");
    await expect(
      readFile(join(repo, ".nitely", "skills", "solo", "notes.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("protects existing target skills unless overwrite is requested", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const sourceRoot = await createDirectory("nitely-skill-import-source-");
    const source = await writeSourceSkill(sourceRoot, "safe", "First body.\n");
    await importLocalSkill({ sourcePath: source, repoPath: repo });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: safe\ndescription: Local imported skill\n---\n\nSecond body.\n",
      "utf8",
    );

    await expect(importLocalSkill({ sourcePath: source, repoPath: repo })).rejects.toThrow(
      /target already exists: \.nitely\/skills\/safe/,
    );

    const overwritten = await importLocalSkill({
      sourcePath: source,
      repoPath: repo,
      overwrite: true,
    });

    expect(overwritten.id).toBe("safe");
    await expect(
      readFile(join(repo, ".nitely", "skills", "safe", "SKILL.md"), "utf8"),
    ).resolves.toContain("Second body.");
  });

  it("rejects malformed skills before creating a target directory", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const source = await createDirectory("nitely-skill-import-source-");
    await writeFile(join(source, "SKILL.md"), "name: bad\n---\nBody\n", "utf8");

    await expect(importLocalSkill({ sourcePath: source, repoPath: repo })).rejects.toThrow(
      /has malformed frontmatter/,
    );
    await expect(readFile(join(repo, ".nitely", "skills", "bad", "SKILL.md"), "utf8"))
      .rejects.toThrow();
  });

  it("rejects symlinked resources", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const sourceRoot = await createDirectory("nitely-skill-import-source-");
    const source = await writeSourceSkill(sourceRoot, "unsafe");
    await writeFile(join(sourceRoot, "outside.txt"), "outside", "utf8");
    await symlink(join(sourceRoot, "outside.txt"), join(source, "outside-link.txt"));

    await expect(importLocalSkill({ sourcePath: source, repoPath: repo })).rejects.toThrow(
      /resource is a symlink: outside-link\.txt/,
    );
  });

  it("rejects a symlinked SKILL.md inside a source directory", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const sourceRoot = await createDirectory("nitely-skill-import-source-");
    const source = join(sourceRoot, "linked");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(sourceRoot, "SKILL.md"),
      "---\nname: linked\ndescription: Linked skill\n---\n\nBody.\n",
      "utf8",
    );
    await symlink(join(sourceRoot, "SKILL.md"), join(source, "SKILL.md"));

    await expect(importLocalSkill({ sourcePath: source, repoPath: repo })).rejects.toThrow(
      /source SKILL\.md is a symlink/,
    );
  });

  it("appears in the existing Web skill listing after import", async () => {
    const repo = await createDirectory("nitely-skill-import-repo-");
    const source = await writeSourceSkill(
      await createDirectory("nitely-skill-import-source-"),
      "visible",
    );
    await importLocalSkill({ sourcePath: source, repoPath: repo });

    await expect(
      listRepositorySkills([{ id: "repo", name: "Repo", path: repo }]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "visible",
        description: "Local imported skill",
        version: "unversioned",
        source: "repository",
        runtimeCompatibility: [],
        repoId: "repo",
        sourcePath: ".nitely/skills/visible/SKILL.md",
      }),
    ]);
  });

  it("exposes optional catalog metadata from skill frontmatter", async () => {
    const repo = await createDirectory("nitely-skill-catalog-repo-");
    await mkdir(join(repo, ".nitely", "skills", "review"), { recursive: true });
    await writeFile(
      join(repo, ".nitely", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Review implementation evidence",
        "version: 2.1.0",
        "runtime_compatibility: codex, claude",
        "required_mcp_servers: github, linear",
        "required_providers: github-cli",
        "expected_outputs: review, findings",
        "---",
        "",
        "Review the implementation.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      listRepositorySkills([{ id: "repo", name: "Repo", path: repo }]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "review",
        version: "2.1.0",
        source: "repository",
        runtimeCompatibility: ["codex", "claude"],
        requiredMcpServers: ["github", "linear"],
        requiredProviders: ["github-cli"],
        expectedOutputs: ["review", "findings"],
      }),
    ]);
  });
});
