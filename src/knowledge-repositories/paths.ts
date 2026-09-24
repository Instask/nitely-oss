import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { KnowledgeRepositorySource } from "./schema.js";
import { normalizeKnowledgeAttachmentId } from "./schema.js";

export interface KnowledgeRepositoryPaths {
  runtimeRoot: string;
  queryHmacKeyPath: string;
  targetRepoPath: string;
  targetKey: string;
  targetRoot: string;
  registryPath: string;
  registryLockPath: string;
  statusRoot: string;
  attachmentsRoot: string;
  mirrorsRoot: string;
  gitHooksRoot: string;
  gitTemplateRoot: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" ||
    (!fromParent.startsWith(`..${sep}`) && fromParent !== ".." && !isAbsolute(fromParent));
}

function defaultRuntimeRoot(env: Record<string, string | undefined>): string {
  const configured = env.NITELY_KNOWLEDGE_STATE_DIR?.trim() ||
    env.NITELY_KNOWLEDGE_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const stateHome = env.XDG_STATE_HOME?.trim();
  return resolve(
    stateHome || join(homedir(), ".local", "state"),
    "nitely",
    "knowledge-repositories",
  );
}

/** Read-only discovery used by dormant integrations; it never creates state. */
export async function knowledgeRepositoryRegistryExists(input: {
  targetRepoPath: string;
  runtimeRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const targetRepoPath = await realpath(resolve(input.targetRepoPath));
  const runtimeRoot = input.runtimeRoot
    ? resolve(input.runtimeRoot)
    : defaultRuntimeRoot(input.env ?? process.env);
  if (pathInside(targetRepoPath, runtimeRoot)) {
    throw new Error("knowledge runtime root must be outside the target repository");
  }
  const registryPath = join(
    runtimeRoot,
    "targets",
    sha256(targetRepoPath),
    "registry.json",
  );
  try {
    const stats = await lstat(registryPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("knowledge repository registry path is unsafe");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureOwnedDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("knowledge runtime path must be a real directory");
  }
  await chmod(path, 0o700);
  return await realpath(path);
}

async function ensureManagedDirectory(root: string, path: string): Promise<string> {
  if (!pathInside(root, resolve(path)) || resolve(path) === root) {
    throw new Error("knowledge runtime child path escapes the managed root");
  }
  const resolved = await ensureOwnedDirectory(path);
  if (!pathInside(root, resolved) || resolved === root) {
    throw new Error("knowledge runtime child path resolves outside the managed root");
  }
  return resolved;
}

export async function resolveKnowledgeRepositoryPaths(input: {
  targetRepoPath: string;
  runtimeRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<KnowledgeRepositoryPaths> {
  const targetRepoPath = await realpath(resolve(input.targetRepoPath));
  const requestedRuntimeRoot = input.runtimeRoot
    ? resolve(input.runtimeRoot)
    : defaultRuntimeRoot(input.env ?? process.env);
  if (pathInside(targetRepoPath, requestedRuntimeRoot)) {
    throw new Error("knowledge runtime root must be outside the target repository");
  }
  const runtimeRoot = await ensureOwnedDirectory(requestedRuntimeRoot);
  if (pathInside(targetRepoPath, runtimeRoot)) {
    throw new Error("knowledge runtime root resolves inside the target repository");
  }
  const targetKey = sha256(targetRepoPath);
  const targetsRoot = await ensureManagedDirectory(runtimeRoot, join(runtimeRoot, "targets"));
  const targetRoot = await ensureManagedDirectory(targetsRoot, join(targetsRoot, targetKey));
  const statusRoot = await ensureManagedDirectory(targetRoot, join(targetRoot, "status"));
  const attachmentsRoot = await ensureManagedDirectory(targetRoot, join(targetRoot, "attachments"));
  const mirrorsRoot = await ensureManagedDirectory(targetRoot, join(targetRoot, "mirrors"));
  const gitSecurityRoot = await ensureManagedDirectory(runtimeRoot, join(runtimeRoot, "git-security"));
  const gitHooksRoot = await ensureManagedDirectory(gitSecurityRoot, join(gitSecurityRoot, "hooks"));
  const gitTemplateRoot = await ensureManagedDirectory(gitSecurityRoot, join(gitSecurityRoot, "template"));
  return {
    runtimeRoot,
    queryHmacKeyPath: join(runtimeRoot, "query-hmac-key.json"),
    targetRepoPath,
    targetKey,
    targetRoot,
    registryPath: join(targetRoot, "registry.json"),
    registryLockPath: join(targetRoot, "registry.lock"),
    statusRoot,
    attachmentsRoot,
    mirrorsRoot,
    gitHooksRoot,
    gitTemplateRoot,
  };
}

export function knowledgeSourceKey(source: KnowledgeRepositorySource): string {
  const identity = source.type === "local"
    ? `local\0${resolve(source.path)}`
    : `remote\0${source.providerId}\0${source.url}`;
  return sha256(identity);
}

export function knowledgeMirrorPath(
  paths: KnowledgeRepositoryPaths,
  source: KnowledgeRepositorySource,
): string {
  return join(paths.mirrorsRoot, `${knowledgeSourceKey(source)}.git`);
}

export function knowledgeAttachmentRoot(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): string {
  return join(paths.attachmentsRoot, normalizeKnowledgeAttachmentId(attachmentId));
}

export function knowledgeAttachmentLockPath(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): string {
  return join(knowledgeAttachmentRoot(paths, attachmentId), "refresh.lock");
}

export function knowledgeAttachmentStatusPath(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): string {
  return join(paths.statusRoot, `${normalizeKnowledgeAttachmentId(attachmentId)}.json`);
}

export function knowledgeAttachmentIndexesRoot(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): string {
  return join(knowledgeAttachmentRoot(paths, attachmentId), "indexes");
}

export function knowledgeImmutableIndexPath(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
  snapshotId: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(snapshotId)) {
    throw new Error("invalid knowledge snapshot id");
  }
  return join(knowledgeAttachmentIndexesRoot(paths, attachmentId), `${snapshotId}.json`);
}

export function requireManagedKnowledgePath(
  paths: KnowledgeRepositoryPaths,
  candidate: string,
): string {
  const normalized = resolve(candidate);
  if (!pathInside(paths.runtimeRoot, normalized) || normalized === paths.runtimeRoot) {
    throw new Error("knowledge path escapes the managed runtime root");
  }
  return normalized;
}

export async function ensureKnowledgeParent(path: string): Promise<void> {
  await ensureOwnedDirectory(dirname(path));
}
