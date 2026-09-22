import {
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateSkillDirectory } from "./load.js";

export interface ImportLocalSkillInput {
  sourcePath: string;
  repoPath: string;
  overwrite?: boolean;
}

export interface ImportedSkill {
  id: string;
  targetPath: string;
  contentHash: string;
  resourceCount: number;
}

export interface LocalSkillImportPreview extends ImportedSkill {
  name: string;
  description: string;
  sourcePath: string;
  targetExists: boolean;
  overwriteRequired: boolean;
}

interface ResolvedLocalSkillImport {
  sourceSkillPath: string;
  targetDirectory: string;
  preview: LocalSkillImportPreview;
  resources: Array<{ relativePath: string; absolutePath: string }>;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyValidatedSkill(input: {
  sourceSkillPath: string;
  targetDirectory: string;
  resources: Array<{ relativePath: string; absolutePath: string }>;
}): Promise<void> {
  await mkdir(input.targetDirectory, { recursive: true });
  await copyFile(input.sourceSkillPath, join(input.targetDirectory, "SKILL.md"));
  for (const resource of input.resources) {
    const targetPath = join(input.targetDirectory, resource.relativePath);
    requirePathInside(input.targetDirectory, targetPath, "skill import target");
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resource.absolutePath, targetPath);
  }
}

async function resolveLocalSkillImport(
  input: ImportLocalSkillInput,
): Promise<ResolvedLocalSkillImport> {
  const repoPath = resolve(input.repoPath);
  const sourcePath = resolve(input.sourcePath);
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`skill import: source is a symlink: ${input.sourcePath}`);
  }

  const sourceIsFile = sourceStat.isFile();
  const sourceIsDirectory = sourceStat.isDirectory();
  if (!sourceIsFile && !sourceIsDirectory) {
    throw new Error(`skill import: source must be a SKILL.md file or skill directory: ${input.sourcePath}`);
  }
  if (sourceIsFile && basename(sourcePath) !== "SKILL.md") {
    throw new Error("skill import: file source must be named SKILL.md");
  }

  const skillDirectory = sourceIsFile ? dirname(sourcePath) : sourcePath;
  const sourceSkillPath = join(skillDirectory, "SKILL.md");
  requirePathInside(skillDirectory, sourceSkillPath, "skill import source");
  if (!(await pathExists(sourceSkillPath))) {
    throw new Error(`skill import: missing SKILL.md in ${input.sourcePath}`);
  }
  const sourceSkillStat = await lstat(sourceSkillPath);
  if (sourceSkillStat.isSymbolicLink()) {
    throw new Error(`skill import: source SKILL.md is a symlink: ${input.sourcePath}`);
  }

  const validated = await validateSkillDirectory({
    skillDirectory,
    includeResources: sourceIsDirectory,
    errorRoot: skillDirectory,
  });

  const skillsRoot = join(repoPath, ".nitely", "skills");
  const targetDirectory = join(skillsRoot, validated.id);
  requirePathInside(skillsRoot, targetDirectory, "skill import target");
  const targetExists = await pathExists(targetDirectory);

  return {
    sourceSkillPath,
    targetDirectory,
    preview: {
      id: validated.id,
      name: validated.name,
      description: validated.description,
      sourcePath: toPosixPath(sourcePath),
      targetPath: toPosixPath(relative(repoPath, targetDirectory)),
      contentHash: validated.contentHash,
      resourceCount: validated.resources.length,
      targetExists,
      overwriteRequired: targetExists && !input.overwrite,
    },
    resources: validated.resources,
  };
}

export async function previewLocalSkillImport(
  input: ImportLocalSkillInput,
): Promise<LocalSkillImportPreview> {
  return (await resolveLocalSkillImport(input)).preview;
}

export async function importLocalSkill(
  input: ImportLocalSkillInput,
): Promise<ImportedSkill> {
  const resolved = await resolveLocalSkillImport(input);

  if (resolved.preview.targetExists && !input.overwrite) {
    throw new Error(
      `skill import: target already exists: .nitely/skills/${resolved.preview.id} (use --overwrite)`,
    );
  }

  const tempDirectory = join(
    dirname(resolved.targetDirectory),
    `.import-${resolved.preview.id}-${process.pid}-${Date.now()}`,
  );
  requirePathInside(dirname(resolved.targetDirectory), tempDirectory, "skill import temp");
  await rm(tempDirectory, { recursive: true, force: true });

  try {
    await copyValidatedSkill({
      sourceSkillPath: resolved.sourceSkillPath,
      targetDirectory: tempDirectory,
      resources: resolved.resources,
    });

    if (input.overwrite) {
      await rm(resolved.targetDirectory, { recursive: true, force: true });
    }
    await mkdir(dirname(resolved.targetDirectory), { recursive: true });
    await rename(tempDirectory, resolved.targetDirectory);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    id: resolved.preview.id,
    targetPath: resolved.preview.targetPath,
    contentHash: resolved.preview.contentHash,
    resourceCount: resolved.preview.resourceCount,
  };
}
