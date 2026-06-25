import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NitelyCommentAction } from "./commands.js";

export type CommentProcessStatus =
  | "skipped"
  | "processed"
  | "triggered"
  | "failed";

export interface CommentProcessRecord {
  commentId: string;
  commentUrl: string;
  bodyHash: string;
  action?: NitelyCommentAction;
  status: CommentProcessStatus;
  runId?: string;
  reason?: string;
  processedAt: string;
}

export interface CommentLoopStateFile {
  version: 1;
  comments: Record<string, CommentProcessRecord>;
}

export interface CommentStateLocation {
  repoPath: string;
  owner: string;
  repository: string;
  prNumber: number;
}

export function commentBodyHash(body: string, updatedAt?: string): string {
  return createHash("sha256")
    .update(body)
    .update("\0")
    .update(updatedAt ?? "")
    .digest("hex");
}

export function commentTriggerRoot(location: CommentStateLocation): string {
  return join(
    location.repoPath,
    ".nitely",
    "comment-triggers",
    "github",
    location.owner,
    location.repository,
    String(location.prNumber),
  );
}

export function commentStatePath(location: CommentStateLocation): string {
  return join(commentTriggerRoot(location), "state.json");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600).catch(() => {});
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadCommentLoopState(
  location: CommentStateLocation,
): Promise<CommentLoopStateFile> {
  try {
    const parsed = JSON.parse(await readFile(commentStatePath(location), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      parsed.version === 1 &&
      typeof parsed.comments === "object" &&
      parsed.comments !== null &&
      !Array.isArray(parsed.comments)
    ) {
      return parsed as CommentLoopStateFile;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { version: 1, comments: {} };
}

export async function saveCommentLoopState(
  location: CommentStateLocation,
  state: CommentLoopStateFile,
): Promise<void> {
  await writeJsonAtomic(commentStatePath(location), state);
}

export async function recordCommentProcess(
  location: CommentStateLocation,
  record: CommentProcessRecord,
): Promise<void> {
  const state = await loadCommentLoopState(location);
  state.comments[record.commentId] = record;
  await saveCommentLoopState(location, state);
}
