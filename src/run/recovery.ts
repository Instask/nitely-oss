import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RECOVERY_PATCH_FILENAME = "recovery.patch";
export const RECOVERY_METADATA_FILENAME = "recovery.json";

const DEFAULT_MAX_PATCH_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_UNTRACKED_FILES = 100;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

export type RecoverySnapshotStatus =
  | "available"
  | "partial"
  | "clean"
  | "unavailable";

export interface RecoverySnapshotOmission {
  path: string;
  reason: string;
}

export interface RecoverySnapshot {
  version: 1;
  runId: string;
  stageId: string;
  attempt: number;
  capturedAt: string;
  baseSha: string;
  headSha?: string;
  status: RecoverySnapshotStatus;
  patchPath?: typeof RECOVERY_PATCH_FILENAME;
  patchBytes?: number;
  patchSha256?: string;
  changedPaths: string[];
  untrackedPaths: string[];
  omitted: RecoverySnapshotOmission[];
  message?: string;
}

export interface WriteRecoverySnapshotInput {
  runDirectory: string;
  worktreePath: string;
  runId: string;
  stageId: string;
  attempt: number;
  baseSha: string;
  now?: () => Date;
  maxPatchBytes?: number;
  maxUntrackedFiles?: number;
  maxUntrackedFileBytes?: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nulPaths(value: string): string[] {
  return value
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer: number,
  acceptedExitCodes: number[] = [0],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    if (exitCode !== undefined && acceptedExitCodes.includes(exitCode)) {
      return failure.stdout ?? "";
    }
    const detail = (failure.stderr ?? failure.message ?? String(error)).trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function safeWorktreePath(worktreePath: string, candidate: string): string | undefined {
  if (!candidate || isAbsolute(candidate)) return undefined;
  const root = resolve(worktreePath);
  const absolute = resolve(root, candidate);
  const fromRoot = relative(root, absolute);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return undefined;
  }
  return absolute;
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot));
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await removeIfPresent(temporary);
    throw error;
  }
}

async function persistSnapshot(
  runDirectory: string,
  snapshot: RecoverySnapshot,
  patch: string | undefined,
): Promise<RecoverySnapshot> {
  const patchPath = join(runDirectory, RECOVERY_PATCH_FILENAME);
  if (patch === undefined) {
    await removeIfPresent(patchPath);
  } else {
    await atomicWrite(patchPath, patch);
  }
  await atomicWrite(
    join(runDirectory, RECOVERY_METADATA_FILENAME),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  return snapshot;
}

function unavailableSnapshot(
  input: WriteRecoverySnapshotInput,
  message: string,
): RecoverySnapshot {
  return {
    version: 1,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
    baseSha: input.baseSha,
    status: "unavailable",
    changedPaths: [],
    untrackedPaths: [],
    omitted: [],
    message,
  };
}

export async function writeRecoverySnapshot(
  input: WriteRecoverySnapshotInput,
): Promise<RecoverySnapshot> {
  await mkdir(input.runDirectory, { recursive: true });
  if (!/^[0-9a-f]{40,64}$/i.test(input.baseSha)) {
    return await persistSnapshot(
      input.runDirectory,
      unavailableSnapshot(input, `invalid recovery base commit: ${input.baseSha}`),
      undefined,
    );
  }
  const maxPatchBytes = positiveLimit(input.maxPatchBytes, DEFAULT_MAX_PATCH_BYTES);
  const maxUntrackedFiles = positiveLimit(
    input.maxUntrackedFiles,
    DEFAULT_MAX_UNTRACKED_FILES,
  );
  const maxUntrackedFileBytes = positiveLimit(
    input.maxUntrackedFileBytes,
    DEFAULT_MAX_UNTRACKED_FILE_BYTES,
  );
  const gitBuffer = Math.max(maxPatchBytes * 2, 1024 * 1024);

  try {
    const [headSha, trackedPathOutput, untrackedPathOutput, trackedPatch] =
      await Promise.all([
        git(input.worktreePath, ["rev-parse", "HEAD"], gitBuffer),
        git(
          input.worktreePath,
          ["diff", "--name-only", "-z", input.baseSha, "--"],
          gitBuffer,
        ),
        git(
          input.worktreePath,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          gitBuffer,
        ),
        git(
          input.worktreePath,
          [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            input.baseSha,
            "--",
          ],
          gitBuffer,
        ),
      ]);
    const trackedPaths = nulPaths(trackedPathOutput);
    const runDirectoryIsInsideWorktree = pathIsInside(
      input.worktreePath,
      input.runDirectory,
    );
    const untrackedPaths = nulPaths(untrackedPathOutput).filter((path) => {
      const absolutePath = safeWorktreePath(input.worktreePath, path);
      return absolutePath !== undefined &&
        !(runDirectoryIsInsideWorktree && pathIsInside(input.runDirectory, absolutePath));
    });
    const omitted: RecoverySnapshotOmission[] = [];
    const sections: string[] = [];
    let patchBytes = 0;

    const addSection = (section: string, paths: string[], reason: string): void => {
      if (!section) return;
      const separator = sections.length > 0 ? "\n" : "";
      const sectionBytes = Buffer.byteLength(`${separator}${section}`, "utf8");
      if (patchBytes + sectionBytes > maxPatchBytes) {
        for (const path of paths) omitted.push({ path, reason });
        return;
      }
      sections.push(`${separator}${section}`);
      patchBytes += sectionBytes;
    };

    addSection(
      trackedPatch,
      trackedPaths,
      `tracked patch exceeds ${maxPatchBytes} byte total limit`,
    );

    for (const [index, path] of untrackedPaths.entries()) {
      if (index >= maxUntrackedFiles) {
        omitted.push({
          path,
          reason: `untracked file count exceeds ${maxUntrackedFiles} file limit`,
        });
        continue;
      }
      const absolutePath = safeWorktreePath(input.worktreePath, path);
      if (!absolutePath) {
        omitted.push({ path, reason: "path escapes worktree" });
        continue;
      }
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        omitted.push({
          path,
          reason: `unable to inspect path: ${(error as Error).message}`,
        });
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) {
        omitted.push({ path, reason: "path is not a regular file or symlink" });
        continue;
      }
      if (info.isFile() && info.size > maxUntrackedFileBytes) {
        omitted.push({
          path,
          reason: `file exceeds ${maxUntrackedFileBytes} byte limit`,
        });
        continue;
      }
      let section: string;
      try {
        section = await git(
          input.worktreePath,
          [
            "diff",
            "--no-index",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            "/dev/null",
            path,
          ],
          Math.max(maxUntrackedFileBytes * 4, 1024 * 1024),
          [0, 1],
        );
      } catch (error) {
        omitted.push({ path, reason: (error as Error).message });
        continue;
      }
      addSection(
        section,
        [path],
        `patch exceeds ${maxPatchBytes} byte total limit`,
      );
    }

    const patch = sections.join("");
    const changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort(
      (left, right) => left.localeCompare(right),
    );
    const capturedAt = (input.now ?? (() => new Date()))().toISOString();
    const status: RecoverySnapshotStatus =
      changedPaths.length === 0
        ? "clean"
        : omitted.length > 0
          ? "partial"
          : "available";
    const snapshot: RecoverySnapshot = {
      version: 1,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      capturedAt,
      baseSha: input.baseSha,
      headSha: headSha.trim(),
      status,
      ...(patch
        ? {
            patchPath: RECOVERY_PATCH_FILENAME,
            patchBytes: Buffer.byteLength(patch, "utf8"),
            patchSha256: sha256(patch),
          }
        : {}),
      changedPaths,
      untrackedPaths,
      omitted,
    };
    return await persistSnapshot(input.runDirectory, snapshot, patch || undefined);
  } catch (error) {
    const snapshot = unavailableSnapshot(
      input,
      error instanceof Error ? error.message : String(error),
    );
    return await persistSnapshot(input.runDirectory, snapshot, undefined);
  }
}

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.runId === "string" &&
    typeof record.stageId === "string" &&
    typeof record.attempt === "number" &&
    Number.isSafeInteger(record.attempt) &&
    record.attempt > 0 &&
    typeof record.capturedAt === "string" &&
    Number.isFinite(Date.parse(record.capturedAt)) &&
    typeof record.baseSha === "string" &&
    (record.status === "unavailable" || /^[0-9a-f]{40,64}$/i.test(record.baseSha)) &&
    (record.status === "available" ||
      record.status === "partial" ||
      record.status === "clean" ||
      record.status === "unavailable") &&
    Array.isArray(record.changedPaths) &&
    record.changedPaths.every((path) => typeof path === "string") &&
    Array.isArray(record.untrackedPaths) &&
    record.untrackedPaths.every((path) => typeof path === "string") &&
    Array.isArray(record.omitted) &&
    record.omitted.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const omission = entry as Record<string, unknown>;
      return typeof omission.path === "string" && typeof omission.reason === "string";
    }) &&
    (record.patchPath === undefined || record.patchPath === RECOVERY_PATCH_FILENAME) &&
    (record.headSha === undefined ||
      (typeof record.headSha === "string" && /^[0-9a-f]{40,64}$/i.test(record.headSha))) &&
    (record.patchBytes === undefined ||
      (typeof record.patchBytes === "number" && Number.isSafeInteger(record.patchBytes))) &&
    (record.patchSha256 === undefined ||
      (typeof record.patchSha256 === "string" && /^[0-9a-f]{64}$/i.test(record.patchSha256))) &&
    (record.message === undefined || typeof record.message === "string")
  );
}

export async function readRecoverySnapshot(input: {
  runDirectory: string;
}): Promise<RecoverySnapshot | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(input.runDirectory, RECOVERY_METADATA_FILENAME), "utf8"),
    );
    return isRecoverySnapshot(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
