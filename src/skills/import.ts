import {
  mkdtemp,
  lstat,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { ensureRunOwnedDirectory } from "../run/owned-file.js";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { snapshotSkillPackage } from "./package.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ValidatedSkillDirectory } from "./load.js";

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
  includeResources: boolean;
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

async function snapshotImportSource(sourceSkillPath: string, destination: string, includeResources: boolean): Promise<ValidatedSkillDirectory> {
  const directory = dirname(sourceSkillPath);
  await mkdir(destination, { mode: 0o700 });
  return await snapshotSkillPackage({ rootDirectory: dirname(directory), sourcePath: basename(directory), destination, includeResources });
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

  const inspection = await mkdtemp(join(tmpdir(), "nitely-skill-import-"));
  let validated: ValidatedSkillDirectory;
  try { validated = await snapshotImportSource(sourceSkillPath, join(inspection, "code"), sourceIsDirectory); }
  finally { await rm(inspection, { recursive: true, force: true }); }

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
    includeResources: sourceIsDirectory,
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

  await ensureRunOwnedDirectory({ runDirectory: input.repoPath, path: ".nitely/skills", subject: "Skill installation directory" });
  return await withKnowledgeLease({ path: join(resolve(input.repoPath), ".nitely/skills-install.lock"), waitMs: 10_000 }, async () => {
    if (!input.overwrite && await pathExists(resolved.targetDirectory)) throw new Error(`skill import: target already exists: .nitely/skills/${resolved.preview.id} (use --overwrite)`);
    const suffix = randomUUID();
    const tempDirectory = join(dirname(resolved.targetDirectory), `.import-${suffix}`);
    const backupDirectory = join(dirname(resolved.targetDirectory), `.backup-${suffix}`);
    let backedUp = false;
    let installed = false;
    try {
      const snapshot = await snapshotImportSource(resolved.sourceSkillPath, tempDirectory, resolved.includeResources);
      if (snapshot.contentHash !== resolved.preview.contentHash) throw new Error("skill import: package changed after validation; retry the import");
      if (input.overwrite && await pathExists(resolved.targetDirectory)) {
        const current = await lstat(resolved.targetDirectory);
        if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("skill import: unsafe existing target");
        await rename(resolved.targetDirectory, backupDirectory);
        backedUp = true;
      }
      await rename(tempDirectory, resolved.targetDirectory);
      installed = true;
      if (backedUp) await rm(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      if (backedUp && !installed) await rename(backupDirectory, resolved.targetDirectory);
      throw error;
    } finally { await rm(tempDirectory, { recursive: true, force: true }); }
    return { id: resolved.preview.id, targetPath: resolved.preview.targetPath, contentHash: resolved.preview.contentHash, resourceCount: resolved.preview.resourceCount };
  });
}
