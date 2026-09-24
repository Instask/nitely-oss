import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importLocalSkill } from "../../src/skills/import.js";
import { validateSkillDirectory } from "../../src/skills/load.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillDirectory = join(repoRoot, "skills", "nitely");
const installerPath = join(repoRoot, "scripts", "install-nitely-skill");

async function listSkillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(entry.parentPath, entry.name);
    files.push(relative(directory, absolutePath).split(sep).join("/"));
  }
  return files.sort();
}

function parseInstallerFiles(script: string): string[] {
  const match = /SKILL_FILES=\(\n([\s\S]*?)\n\)/.exec(script);
  if (!match) throw new Error("SKILL_FILES array not found in installer");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^"|"$/g, ""))
    .sort();
}

describe("bundled nitely skill", () => {
  it("passes the same validation used for imported and run-time skills", async () => {
    const validated = await validateSkillDirectory({ skillDirectory });

    expect(validated.id).toBe("nitely");
    expect(validated.name).toBe("nitely");
    expect(validated.description.trim()).not.toBe("");
    expect(validated.body.trim()).not.toBe("");
    expect(validated.resources.map((resource) => resource.relativePath)).toEqual([
      "references/cli.md",
      "references/flows.md",
      "references/install.md",
      "references/troubleshooting.md",
      "references/web-operations.md",
    ]);
  });

  it("imports into a repository as a run-time skill", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-bundled-skill-"));

    const imported = await importLocalSkill({ sourcePath: skillDirectory, repoPath: repo });

    expect(imported.id).toBe("nitely");
    expect(imported.targetPath).toBe(".nitely/skills/nitely");
    expect(imported.resourceCount).toBe(5);
    expect(await listSkillFiles(join(repo, ".nitely", "skills", "nitely"))).toEqual(
      await listSkillFiles(skillDirectory),
    );
  });

  it("keeps the installer file list in sync with the skill directory", async () => {
    const script = await readFile(installerPath, "utf8");

    expect(parseInstallerFiles(script)).toEqual(await listSkillFiles(skillDirectory));
  });

  it("ships an executable installer", async () => {
    const details = await stat(installerPath);

    expect(details.mode & 0o111).not.toBe(0);
  });
});
