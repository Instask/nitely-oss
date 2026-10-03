import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listRunOwnedDirectory, readRunOwnedFile } from "../run/owned-file.js";
import { skillRelativePathSchema } from "./manifest.js";
import { validateSkillDirectory, type ValidatedSkillDirectory } from "./load.js";

/** Destination is a private controller-owned directory, never supplied by a tool. */
export async function snapshotSkillPackage(input: { rootDirectory: string; sourcePath: string; destination: string;
  skillId?: string; includeResources?: boolean }): Promise<ValidatedSkillDirectory> {
  let entriesCount = 0;
  let totalBytes = 0;
  const copyFile = async (path: string) => {
    const file = await readRunOwnedFile({ runDirectory: input.rootDirectory, path: join(input.sourcePath, path), subject: "Skill package", maximumBytes: 4 * 1024 * 1024 });
    totalBytes += file.content.byteLength;
    if (totalBytes > 8 * 1024 * 1024) throw new Error("Skill package exceeds 8 MiB");
    await writeFile(join(input.destination, path), file.content, { flag: "wx", mode: 0o644 });
  };
  const copyDirectory = async (path: string): Promise<void> => {
    const entries = await listRunOwnedDirectory({ runDirectory: input.rootDirectory, path: join(input.sourcePath, path), subject: "Skill package" });
    for (const entry of entries) {
      const relative = path ? `${path}/${entry.name}` : entry.name;
      skillRelativePathSchema.parse(relative);
      if (++entriesCount > 128) throw new Error("Skill package exceeds 128 entries");
      if (entry.isSymbolicLink()) throw new Error(`skill import: resource is a symlink: ${relative}`);
      if (entry.isDirectory()) {
        await mkdir(join(input.destination, relative), { mode: 0o755 });
        await copyDirectory(relative);
      } else await copyFile(relative);
    }
  };
  if (input.includeResources === false) await copyFile("SKILL.md");
  else await copyDirectory("");
  return await validateSkillDirectory({ skillDirectory: input.destination, skillId: input.skillId });
}
