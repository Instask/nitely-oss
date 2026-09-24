import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WebInputError, WebNotFoundError } from "../web/errors.js";
import type {
  PreviewSessionRecord,
  PreviewSessionStatus,
} from "./types.js";

const sessionIdPattern = /^pvs_[a-f0-9]{16}$/;
const activeStatuses = new Set<PreviewSessionStatus>([
  "starting",
  "ready",
  "stopping",
]);

export function createPreviewSessionId(): string {
  return `pvs_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function validatePreviewSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) {
    throw new WebInputError("invalid preview session id");
  }
}

function previewSessionsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "preview-sessions");
}

function previewSessionPath(repoPath: string, sessionId: string): string {
  validatePreviewSessionId(sessionId);
  return join(previewSessionsRoot(repoPath), `${sessionId}.json`);
}

export function previewSessionDirectory(
  repoPath: string,
  sessionId: string,
): string {
  validatePreviewSessionId(sessionId);
  return join(previewSessionsRoot(repoPath), sessionId);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writePreviewSessionRecord(
  repoPath: string,
  record: PreviewSessionRecord,
): Promise<PreviewSessionRecord> {
  await writeJsonAtomic(previewSessionPath(repoPath, record.id), record);
  return record;
}

export async function getPreviewSessionRecord(
  repoPath: string,
  sessionId: string,
): Promise<PreviewSessionRecord> {
  try {
    const record = JSON.parse(
      await readFile(previewSessionPath(repoPath, sessionId), "utf8"),
    ) as PreviewSessionRecord;
    if (record.schemaVersion !== "nitely.preview-session.v1") {
      throw new WebNotFoundError("preview session not found");
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebNotFoundError("preview session not found");
    }
    throw error;
  }
}

export async function listPreviewSessionRecords(
  repoPath: string,
): Promise<PreviewSessionRecord[]> {
  const root = previewSessionsRoot(repoPath);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const record = JSON.parse(
            await readFile(join(root, entry), "utf8"),
          ) as PreviewSessionRecord;
          return record.schemaVersion === "nitely.preview-session.v1"
            ? record
            : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return records
    .filter((record): record is PreviewSessionRecord => record !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updatePreviewSessionRecord(
  repoPath: string,
  sessionId: string,
  update: (record: PreviewSessionRecord) => PreviewSessionRecord,
): Promise<PreviewSessionRecord> {
  const current = await getPreviewSessionRecord(repoPath, sessionId);
  const updated = update(current);
  await writePreviewSessionRecord(repoPath, updated);
  return updated;
}

export async function markStalePreviewSessions(
  repoPath: string,
  now = new Date(),
): Promise<PreviewSessionRecord[]> {
  const records = await listPreviewSessionRecords(repoPath);
  const staleAt = now.toISOString();
  const updated: PreviewSessionRecord[] = [];
  for (const record of records) {
    if (!activeStatuses.has(record.status)) continue;
    const stale: PreviewSessionRecord = {
      ...record,
      status: "stale",
      updatedAt: staleAt,
      staleAt,
      failure: "preview session was active when Nitely restarted",
    };
    await writePreviewSessionRecord(repoPath, stale);
    updated.push(stale);
  }
  return updated;
}
