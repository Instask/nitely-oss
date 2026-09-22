import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { IDENTIFIER_PATTERN } from "../flow/schema.js";

export interface SkillResource {
  path: string;
  snapshotPath: string;
  mediaType?: string;
  sizeBytes: number;
}

export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string;
  body: string;
  resources: SkillResource[];
}

interface ResourceFile {
  relativePath: string;
  absolutePath: string;
  bytes: Buffer;
  sizeBytes: number;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
}

export interface ValidatedSkillResource {
  relativePath: string;
  absolutePath: string;
  mediaType?: string;
  sizeBytes: number;
}

export interface ValidatedSkillDirectory {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string;
  body: string;
  resources: ValidatedSkillResource[];
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

function requirePathInside(parent: string, candidate: string, label: string): void {
  if (!isPathInside(resolve(parent), resolve(candidate))) {
    throw new Error(`${label} escapes ${parent}: ${candidate}`);
  }
}

function mediaTypeForPath(path: string): string | undefined {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".json")) return "application/json";
  return undefined;
}

function skillError(stageId: string, skillId: string, message: string): Error {
  return new Error(`stage "${stageId}" skill "${skillId}": ${message}`);
}

function parseSkillDocument(input: {
  content: string;
  error: (message: string) => Error;
}): ParsedSkillFile {
  const lines = input.content.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw input.error("has malformed frontmatter");
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex < 0) {
    throw input.error("has malformed frontmatter");
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === "") continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) {
      throw input.error("has malformed frontmatter");
    }
    fields.set(match[1], match[2].trim());
  }

  const name = fields.get("name") ?? "";
  if (!name) {
    throw input.error("missing required frontmatter field: name");
  }
  const description = fields.get("description") ?? "";
  if (!description) {
    throw input.error("missing required frontmatter field: description");
  }

  const bodyLines = lines.slice(endIndex + 1);
  if (bodyLines[0] === "") {
    bodyLines.shift();
  }
  const body = bodyLines.join("\n");
  if (body.trim() === "") {
    throw input.error("body must not be empty");
  }

  return { name, description, body };
}

function parseFrontmatter(input: {
  skillId: string;
  stageId: string;
  content: string;
}): ParsedSkillFile {
  const parsed = parseSkillDocument({
    content: input.content,
    error: (message) => skillError(input.stageId, input.skillId, message),
  });
  if (parsed.name !== input.skillId) {
    throw skillError(
      input.stageId,
      input.skillId,
      `name mismatch: expected "${input.skillId}", found "${parsed.name}"`,
    );
  }
  return parsed;
}

async function collectResourceFiles(input: {
  stageId: string;
  skillId: string;
  skillDirectory: string;
  directory: string;
  errorRoot?: string;
}): Promise<ResourceFile[]> {
  requirePathInside(input.skillDirectory, input.directory, "skill resource path");
  const entries = await readdir(input.directory, { withFileTypes: true });
  const resources: ResourceFile[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (input.directory === input.skillDirectory && entry.name === "SKILL.md") {
      continue;
    }
    const absolutePath = join(input.directory, entry.name);
    requirePathInside(input.skillDirectory, absolutePath, "skill resource path");
    const details = await lstat(absolutePath);
    const pathForError = repoRelativePath(
      input.errorRoot ?? resolve(input.skillDirectory, "..", "..", ".."),
      absolutePath,
    );
    if (details.isSymbolicLink()) {
      throw skillError(
        input.stageId,
        input.skillId,
        `resource is a symlink: ${pathForError}`,
      );
    }
    if (details.isDirectory()) {
      resources.push(
        ...(await collectResourceFiles({
          ...input,
          directory: absolutePath,
        })),
      );
      continue;
    }
    if (!details.isFile()) {
      continue;
    }
    const bytes = await readFile(absolutePath);
    resources.push({
      absolutePath,
      relativePath: toPosixPath(relative(input.skillDirectory, absolutePath)),
      bytes,
      sizeBytes: details.size,
    });
  }

  return resources;
}

function hashSkill(skillBytes: Buffer, resources: ResourceFile[]): string {
  const hash = createHash("sha256");
  hash.update(skillBytes);
  for (const resource of [...resources].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update("\0");
    hash.update(resource.relativePath);
    hash.update("\0");
    hash.update(resource.bytes);
  }
  return hash.digest("hex");
}

export async function validateSkillDirectory(input: {
  skillDirectory: string;
  skillId?: string;
  stageId?: string;
  includeResources?: boolean;
  errorRoot?: string;
}): Promise<ValidatedSkillDirectory> {
  const skillDirectory = resolve(input.skillDirectory);
  const sourcePath = join(skillDirectory, "SKILL.md");
  const skillBytes = await readFile(sourcePath);
  const parsed = parseSkillDocument({
    content: skillBytes.toString("utf8"),
    error: (message) => new Error(`skill import: ${message}`),
  });
  const skillId = input.skillId ?? parsed.name;
  const stageId = input.stageId ?? "import";
  if (!IDENTIFIER_PATTERN.test(skillId)) {
    throw new Error(`skill import: invalid skill id "${skillId}"`);
  }
  if (parsed.name !== skillId) {
    throw new Error(`skill import: name mismatch: expected "${skillId}", found "${parsed.name}"`);
  }
  const resources = input.includeResources === false
    ? []
    : await collectResourceFiles({
      stageId,
      skillId,
      skillDirectory,
      directory: skillDirectory,
      errorRoot: input.errorRoot,
    });

  return {
    id: skillId,
    name: parsed.name,
    description: parsed.description,
    sourcePath,
    contentHash: hashSkill(skillBytes, resources),
    body: parsed.body,
    resources: resources.map((resource) => ({
      relativePath: resource.relativePath,
      absolutePath: resource.absolutePath,
      mediaType: mediaTypeForPath(resource.relativePath),
      sizeBytes: resource.sizeBytes,
    })),
  };
}

async function loadSkill(input: {
  repoPath: string;
  runDirectory: string;
  stageId: string;
  skillId: string;
}): Promise<LoadedSkill> {
  if (!IDENTIFIER_PATTERN.test(input.skillId)) {
    throw skillError(input.stageId, input.skillId, `invalid skill id "${input.skillId}"`);
  }

  const repoPath = resolve(input.repoPath);
  const runDirectory = resolve(input.runDirectory);
  const skillDirectory = join(repoPath, ".nitely", "skills", input.skillId);
  requirePathInside(
    join(repoPath, ".nitely", "skills"),
    skillDirectory,
    "skill directory",
  );
  const sourcePath = join(skillDirectory, "SKILL.md");
  let skillBytes: Buffer;
  try {
    skillBytes = await readFile(sourcePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw skillError(
        input.stageId,
        input.skillId,
        `unknown skill "${input.skillId}": expected .nitely/skills/${input.skillId}/SKILL.md`,
      );
    }
    throw error;
  }

  const parsed = parseFrontmatter({
    stageId: input.stageId,
    skillId: input.skillId,
    content: skillBytes.toString("utf8"),
  });
  const resources = await collectResourceFiles({
    stageId: input.stageId,
    skillId: input.skillId,
    skillDirectory,
    directory: skillDirectory,
  });

  const snapshotRoot = join(runDirectory, "skills", input.skillId);
  requirePathInside(join(runDirectory, "skills"), snapshotRoot, "skill snapshot");
  const loadedResources: SkillResource[] = [];
  for (const resource of resources) {
    const snapshotAbsolutePath = join(snapshotRoot, resource.relativePath);
    requirePathInside(snapshotRoot, snapshotAbsolutePath, "skill snapshot");
    await mkdir(dirname(snapshotAbsolutePath), { recursive: true });
    await copyFile(resource.absolutePath, snapshotAbsolutePath);
    loadedResources.push({
      path: repoRelativePath(repoPath, resource.absolutePath),
      snapshotPath: repoRelativePath(repoPath, snapshotAbsolutePath),
      mediaType: mediaTypeForPath(resource.relativePath),
      sizeBytes: resource.sizeBytes,
    });
  }

  return {
    id: input.skillId,
    name: parsed.name,
    description: parsed.description,
    sourcePath: repoRelativePath(repoPath, sourcePath),
    contentHash: hashSkill(skillBytes, resources),
    body: parsed.body,
    resources: loadedResources,
  };
}

export async function loadStageSkills(input: {
  repoPath: string;
  runDirectory: string;
  stageId: string;
  skillIds: string[];
}): Promise<LoadedSkill[]> {
  const seen = new Set<string>();
  for (const skillId of input.skillIds) {
    if (seen.has(skillId)) {
      throw skillError(
        input.stageId,
        skillId,
        `duplicate skill id on stage ${input.stageId}: ${skillId}`,
      );
    }
    seen.add(skillId);
  }

  const skills: LoadedSkill[] = [];
  for (const skillId of input.skillIds) {
    skills.push(await loadSkill({ ...input, skillId }));
  }
  return skills;
}
