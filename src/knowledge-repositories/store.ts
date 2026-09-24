import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import { withKnowledgeLease } from "./lock.js";
import {
  KNOWLEDGE_REPOSITORY_REGISTRY_VERSION,
  normalizeCreateKnowledgeAttachment,
  normalizeKnowledgeAttachmentId,
  type KnowledgeRepositoryAttachment,
  type KnowledgeRepositoryRegistry,
  type KnowledgeRepositoryStatus,
} from "./schema.js";
import {
  knowledgeAttachmentStatusPath,
  type KnowledgeRepositoryPaths,
} from "./paths.js";

export class KnowledgeRepositoryNotFoundError extends Error {
  constructor(id: string) {
    super(`knowledge repository attachment not found: ${id}`);
    this.name = "KnowledgeRepositoryNotFoundError";
  }
}

export class KnowledgeRefreshFencedError extends Error {
  constructor(id: string) {
    super(`knowledge repository refresh was superseded: ${id}`);
    this.name = "KnowledgeRefreshFencedError";
  }
}

export class KnowledgeRegistryConflictError extends Error {
  constructor() {
    super("knowledge repository registry changed during mutation");
    this.name = "KnowledgeRegistryConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeKnowledgeJsonAtomic(
  path: string,
  value: unknown,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await beforeCommit?.();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function parseAttachment(value: unknown): KnowledgeRepositoryAttachment {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.ref)) {
    throw new Error("invalid knowledge repository attachment");
  }
  const paths = isRecord(value.paths) ? value.paths : {};
  const budgets = isRecord(value.budgets) ? value.budgets : {};
  const retrieval = isRecord(value.retrieval) ? value.retrieval : {};
  const refreshPolicy = isRecord(value.refreshPolicy) ? value.refreshPolicy : {};
  const source = value.source.type === "remote"
    ? {
        type: "remote" as const,
        providerId: value.source.providerId as "github",
        url: stringValue(value.source, "url") ?? "",
      }
    : {
        type: "local" as const,
        path: stringValue(value.source, "path") ?? "",
      };
  const refType = value.ref.type;
  if (refType !== "branch" && refType !== "tag" && refType !== "commit") {
    throw new Error("invalid knowledge repository attachment ref");
  }
  if (!Array.isArray(paths.include) || !paths.include.every((entry) => typeof entry === "string")) {
    throw new Error("invalid knowledge repository include paths");
  }
  if (!Array.isArray(paths.exclude) || !paths.exclude.every((entry) => typeof entry === "string")) {
    throw new Error("invalid knowledge repository exclude paths");
  }
  if (
    refreshPolicy.mode !== "manual" &&
    refreshPolicy.mode !== "on-admission"
  ) {
    throw new Error("invalid knowledge repository refresh policy");
  }
  const createdAt = stringValue(value, "createdAt") ?? "";
  const updatedAt = stringValue(value, "updatedAt") ?? "";
  const normalized = normalizeCreateKnowledgeAttachment(
    {
      id: stringValue(value, "id") ?? "",
      name: stringValue(value, "name") ?? "",
      source,
      ref: { type: refType, value: stringValue(value.ref, "value") ?? "" },
      paths: {
        include: paths.include as string[],
        exclude: paths.exclude as string[],
      },
      enabled: value.enabled === true,
      required: value.required === true,
      refreshPolicy:
        refreshPolicy.mode === "manual"
          ? { mode: "manual" }
          : {
              mode: "on-admission",
              maxAgeSeconds: Number(refreshPolicy.maxAgeSeconds),
            },
      budgets: {
        maxFiles: Number(budgets.maxFiles),
        maxFileBytes: Number(budgets.maxFileBytes),
        maxTotalBytes: Number(budgets.maxTotalBytes),
        maxChunks: Number(budgets.maxChunks),
        chunkTokens: Number(budgets.chunkTokens),
        chunkOverlapTokens: Number(budgets.chunkOverlapTokens),
        topK: Number(budgets.topK),
        maxPromptTokens: Number(budgets.maxPromptTokens),
      },
      retrieval: {
        mode: "hybrid",
        providerId: retrieval.providerId as KnowledgeRepositoryAttachment["retrieval"]["providerId"],
        model: stringValue(retrieval, "model") ?? "",
      },
      ...(stringValue(value, "ownerId") ? { ownerId: stringValue(value, "ownerId") } : {}),
      ...(stringValue(value, "organizationId")
        ? { organizationId: stringValue(value, "organizationId") }
        : {}),
      ...(stringValue(value, "createdBy") ? { createdBy: stringValue(value, "createdBy") } : {}),
    },
    {
      now: createdAt,
      ...(source.type === "local" ? { canonicalLocalPath: source.path } : {}),
    },
  );
  const generation = Number(value.generation);
  const refreshGeneration = Number(value.refreshGeneration);
  if (
    !createdAt ||
    !updatedAt ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(refreshGeneration) ||
    refreshGeneration < 0
  ) {
    throw new Error("invalid knowledge repository attachment metadata");
  }
  return {
    ...normalized,
    createdAt,
    updatedAt,
    generation,
    refreshGeneration,
  };
}

function parseRegistry(value: unknown): KnowledgeRepositoryRegistry {
  if (
    !isRecord(value) ||
    value.version !== KNOWLEDGE_REPOSITORY_REGISTRY_VERSION ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !Array.isArray(value.attachments)
  ) {
    throw new Error("invalid knowledge repository registry");
  }
  const attachments = value.attachments.map(parseAttachment);
  const ids = new Set<string>();
  for (const attachment of attachments) {
    if (ids.has(attachment.id)) {
      throw new Error(`duplicate knowledge repository attachment: ${attachment.id}`);
    }
    ids.add(attachment.id);
  }
  return {
    version: 1,
    generation: Number(value.generation),
    attachments,
  };
}

export async function readKnowledgeRepositoryRegistry(
  paths: KnowledgeRepositoryPaths,
): Promise<KnowledgeRepositoryRegistry> {
  try {
    return parseRegistry(JSON.parse(await readFile(paths.registryPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, generation: 0, attachments: [] };
    }
    throw error;
  }
}

async function mutateRegistry<T>(
  paths: KnowledgeRepositoryPaths,
  operation: (registry: KnowledgeRepositoryRegistry) => Promise<T> | T,
): Promise<T> {
  return await withKnowledgeLease(
    { path: paths.registryLockPath, waitMs: 15_000 },
    async (lease) => {
      const registry = await readKnowledgeRepositoryRegistry(paths);
      const expectedGeneration = registry.generation;
      const result = await operation(registry);
      registry.generation = expectedGeneration + 1;
      await writeKnowledgeJsonAtomic(paths.registryPath, registry, async () => {
        await lease.assertOwned();
        const current = await readKnowledgeRepositoryRegistry(paths);
        if (current.generation !== expectedGeneration) {
          throw new KnowledgeRegistryConflictError();
        }
      });
      return result;
    },
  );
}

export async function listStoredKnowledgeRepositories(
  paths: KnowledgeRepositoryPaths,
): Promise<KnowledgeRepositoryAttachment[]> {
  return (await readKnowledgeRepositoryRegistry(paths)).attachments
    .map((attachment) => structuredClone(attachment))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function getStoredKnowledgeRepository(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): Promise<KnowledgeRepositoryAttachment> {
  const id = normalizeKnowledgeAttachmentId(attachmentId);
  const attachment = (await readKnowledgeRepositoryRegistry(paths)).attachments.find(
    (candidate) => candidate.id === id,
  );
  if (!attachment) throw new KnowledgeRepositoryNotFoundError(id);
  return structuredClone(attachment);
}

export async function createStoredKnowledgeRepository(
  paths: KnowledgeRepositoryPaths,
  attachment: KnowledgeRepositoryAttachment,
): Promise<KnowledgeRepositoryAttachment> {
  return await mutateRegistry(paths, async (registry) => {
    if (registry.attachments.some((candidate) => candidate.id === attachment.id)) {
      throw new Error(`knowledge repository attachment already exists: ${attachment.id}`);
    }
    // Replace the status tombstone retained by a completed detach. A new
    // attachment must never inherit an older attachment generation's snapshot.
    await writeKnowledgeJsonAtomic(
      knowledgeAttachmentStatusPath(paths, attachment.id),
      {
        version: 1,
        attachmentId: attachment.id,
        state: attachment.enabled ? "never-refreshed" : "disabled",
        retrievalMode: "hybrid",
        staleReasons: [],
        refreshGeneration: attachment.refreshGeneration,
      } satisfies KnowledgeRepositoryStatus,
    );
    registry.attachments.push(structuredClone(attachment));
    return structuredClone(attachment);
  });
}

export async function beginStoredKnowledgeRefresh(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
  attemptedAt: string,
): Promise<KnowledgeRepositoryAttachment> {
  const id = normalizeKnowledgeAttachmentId(attachmentId);
  return await mutateRegistry(paths, async (registry) => {
    const attachment = registry.attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new KnowledgeRepositoryNotFoundError(id);
    attachment.refreshGeneration += 1;
    const status: KnowledgeRepositoryStatus = {
      version: 1,
      attachmentId: id,
      state: attachment.enabled ? "refreshing" : "disabled",
      retrievalMode: "hybrid",
      lastAttemptAt: attemptedAt,
      staleReasons: [],
      refreshGeneration: attachment.refreshGeneration,
    };
    const previous = await readKnowledgeRepositoryStatus(paths, id);
    if (previous.currentSnapshot) status.currentSnapshot = previous.currentSnapshot;
    if (previous.lastSuccessfulRefreshAt) {
      status.lastSuccessfulRefreshAt = previous.lastSuccessfulRefreshAt;
    }
    await writeKnowledgeJsonAtomic(knowledgeAttachmentStatusPath(paths, id), status);
    return structuredClone(attachment);
  });
}

export async function publishStoredKnowledgeStatus(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
  refreshGeneration: number,
  status: KnowledgeRepositoryStatus,
): Promise<void> {
  const id = normalizeKnowledgeAttachmentId(attachmentId);
  await mutateRegistry(paths, async (registry) => {
    const attachment = registry.attachments.find((candidate) => candidate.id === id);
    if (!attachment || attachment.refreshGeneration !== refreshGeneration) {
      throw new KnowledgeRefreshFencedError(id);
    }
    if (
      status.attachmentId !== id ||
      status.refreshGeneration !== refreshGeneration
    ) {
      throw new Error("knowledge status does not match refresh fencing token");
    }
    await writeKnowledgeJsonAtomic(knowledgeAttachmentStatusPath(paths, id), status);
  });
}

function parseStatus(value: unknown, attachmentId: string): KnowledgeRepositoryStatus {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.attachmentId !== attachmentId ||
    typeof value.state !== "string" ||
    value.retrievalMode !== "hybrid" ||
    !Array.isArray(value.staleReasons) ||
    !value.staleReasons.every((entry) => typeof entry === "string") ||
    !Number.isSafeInteger(value.refreshGeneration)
  ) {
    throw new Error("invalid knowledge repository status");
  }
  return value as unknown as KnowledgeRepositoryStatus;
}

export async function readKnowledgeRepositoryStatus(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): Promise<KnowledgeRepositoryStatus> {
  const id = normalizeKnowledgeAttachmentId(attachmentId);
  try {
    return parseStatus(
      JSON.parse(await readFile(knowledgeAttachmentStatusPath(paths, id), "utf8")),
      id,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 1,
        attachmentId: id,
        state: "never-refreshed",
        retrievalMode: "hybrid",
        staleReasons: [],
        refreshGeneration: 0,
      };
    }
    throw error;
  }
}

export async function detachStoredKnowledgeRepository(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
): Promise<KnowledgeRepositoryAttachment> {
  const id = normalizeKnowledgeAttachmentId(attachmentId);
  const removed = await mutateRegistry(paths, (registry) => {
    const index = registry.attachments.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new KnowledgeRepositoryNotFoundError(id);
    const [removed] = registry.attachments.splice(index, 1);
    return structuredClone(removed!);
  });
  // Keep the now-unreferenced status as a tombstone. Removing it after releasing
  // the registry lease could race a same-id reattach and delete the new status;
  // createStoredKnowledgeRepository atomically replaces tombstones instead.
  return removed;
}
