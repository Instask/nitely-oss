import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { IDENTIFIER_PATTERN } from "../flow/schema.js";
import type { WebRepository } from "./repositories.js";

export interface WebSkillView {
  id: string;
  name: string;
  description: string;
  version: string;
  source: "repository";
  runtimeCompatibility: string[];
  requiredMcpServers: string[];
  requiredProviders: string[];
  expectedOutputs: string[];
  repoId: string;
  repoName: string;
  repoPath: string;
  sourcePath: string;
  resourceCount: number;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function repoRelativePath(repoPath: string, path: string): string {
  return toPosixPath(relative(repoPath, path));
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseFrontmatter(content: string): {
  name: string;
  description: string;
  version: string;
  runtimeCompatibility: string[];
  requiredMcpServers: string[];
  requiredProviders: string[];
  expectedOutputs: string[];
} | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex < 0) return undefined;

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === "") continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) return undefined;
    fields.set(match[1], match[2].trim());
  }

  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!name || !description) return undefined;
  return {
    name,
    description,
    version: fields.get("version") || "unversioned",
    runtimeCompatibility: parseList(
      fields.get("runtime_compatibility") ?? fields.get("runtimeCompatibility"),
    ),
    requiredMcpServers: parseList(
      fields.get("required_mcp_servers") ?? fields.get("requiredMcpServers"),
    ),
    requiredProviders: parseList(
      fields.get("required_providers") ?? fields.get("requiredProviders"),
    ),
    expectedOutputs: parseList(
      fields.get("expected_outputs") ?? fields.get("expectedOutputs"),
    ),
  };
}

async function countResourceFiles(skillDirectory: string, directory = skillDirectory): Promise<number> {
  if (!isPathInside(resolve(skillDirectory), resolve(directory))) return 0;
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (directory === skillDirectory && entry.name === "SKILL.md") continue;
    const absolutePath = join(directory, entry.name);
    if (!isPathInside(resolve(skillDirectory), resolve(absolutePath))) continue;
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) continue;
    if (details.isDirectory()) {
      count += await countResourceFiles(skillDirectory, absolutePath);
    } else if (details.isFile()) {
      count += 1;
    }
  }
  return count;
}

export async function listRepositorySkills(
  repositories: WebRepository[],
): Promise<WebSkillView[]> {
  const skills: WebSkillView[] = [];

  for (const repository of repositories) {
    const skillsRoot = join(resolve(repository.path), ".nitely", "skills");
    let entries;
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory() || !IDENTIFIER_PATTERN.test(entry.name)) continue;
      const skillDirectory = join(skillsRoot, entry.name);
      if (!isPathInside(skillsRoot, skillDirectory)) continue;
      const sourcePath = join(skillDirectory, "SKILL.md");
      let parsed;
      try {
        parsed = parseFrontmatter(await readFile(sourcePath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!parsed || parsed.name !== entry.name) continue;
      skills.push({
        id: entry.name,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        source: "repository",
        runtimeCompatibility: parsed.runtimeCompatibility,
        requiredMcpServers: parsed.requiredMcpServers,
        requiredProviders: parsed.requiredProviders,
        expectedOutputs: parsed.expectedOutputs,
        repoId: repository.id,
        repoName: repository.name,
        repoPath: repository.path,
        sourcePath: repoRelativePath(repository.path, sourcePath),
        resourceCount: await countResourceFiles(skillDirectory),
      });
    }
  }

  return skills;
}
