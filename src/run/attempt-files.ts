import { lstat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  requireRunOwnedDirectory,
  writeRunOwnedFileAtomically,
} from "./owned-file.js";

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export async function requireContainedAttemptDirectory(input: {
  runDirectory: string;
  attemptDirectory: string;
}): Promise<string> {
  const resolvedRunDirectory = resolve(input.runDirectory);
  const resolvedAttemptDirectory = resolve(input.attemptDirectory);
  if (!isPathInside(resolvedRunDirectory, resolvedAttemptDirectory)) {
    throw new Error(
      `attempt directory escapes run directory: ${input.attemptDirectory}`,
    );
  }
  await requireRunOwnedDirectory({
    runDirectory: resolvedRunDirectory,
    path: relative(resolvedRunDirectory, resolvedAttemptDirectory),
    subject: "attempt directory",
  });
  return resolvedAttemptDirectory;
}

export async function requireRegularFile(
  path: string,
  label: string,
  options: { allowMissing?: boolean } = {},
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (
      options.allowMissing &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function writeAttemptOwnedFile(input: {
  runDirectory: string;
  attemptDirectory: string;
  filename: string;
  content: string;
}): Promise<string> {
  if (
    input.filename.length === 0 ||
    input.filename === "." ||
    input.filename === ".." ||
    basename(input.filename) !== input.filename
  ) {
    throw new Error(`invalid attempt filename: ${input.filename}`);
  }
  const attemptDirectory = await requireContainedAttemptDirectory(input);
  const targetPath = resolve(attemptDirectory, input.filename);
  if (!isPathInside(attemptDirectory, targetPath)) {
    throw new Error(`attempt file escapes attempt directory: ${input.filename}`);
  }
  await requireRegularFile(targetPath, input.filename, { allowMissing: true });

  await writeRunOwnedFileAtomically({
    runDirectory: input.runDirectory,
    path: targetPath,
    subject: input.filename,
    content: input.content,
  });
  return targetPath;
}
