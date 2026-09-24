import { isAbsolute, posix } from "node:path";

export const KNOWLEDGE_REPOSITORY_REGISTRY_VERSION = 1 as const;
export const KNOWLEDGE_INDEX_VERSION = 1 as const;

export const DEFAULT_KNOWLEDGE_BUDGETS = {
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxChunks: 50_000,
  chunkTokens: 600,
  chunkOverlapTokens: 80,
  topK: 6,
  maxPromptTokens: 2_000,
} as const;

export type KnowledgeRepositoryRef =
  | { type: "branch"; value: string }
  | { type: "tag"; value: string }
  | { type: "commit"; value: string };

export type KnowledgeRepositorySource =
  | { type: "local"; path: string }
  | { type: "remote"; providerId: "github"; url: string };

export type KnowledgeRefreshPolicy =
  | { mode: "manual" }
  | { mode: "on-admission"; maxAgeSeconds: number };

export interface KnowledgeRepositoryBudgets {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxChunks: number;
  chunkTokens: number;
  chunkOverlapTokens: number;
  topK: number;
  maxPromptTokens: number;
}

export interface KnowledgeRetrievalConfiguration {
  mode: "hybrid";
  providerId: "local-hash" | "ollama" | "openai-compatible";
  model: string;
}

export interface KnowledgeRepositoryAttachment {
  id: string;
  name: string;
  source: KnowledgeRepositorySource;
  ref: KnowledgeRepositoryRef;
  paths: { include: string[]; exclude: string[] };
  enabled: boolean;
  required: boolean;
  refreshPolicy: KnowledgeRefreshPolicy;
  budgets: KnowledgeRepositoryBudgets;
  retrieval: KnowledgeRetrievalConfiguration;
  ownerId?: string;
  organizationId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Changes whenever configuration changes. */
  generation: number;
  /** Monotonic fencing token allocated before each refresh. */
  refreshGeneration: number;
}

export interface KnowledgeRepositoryRegistry {
  version: 1;
  /** Monotonic generation for registry read/modify/write operations. */
  generation: number;
  attachments: KnowledgeRepositoryAttachment[];
}

export interface KnowledgeSnapshotIdentity {
  snapshotId: string;
  commitSha: string;
  indexDigest: string;
  indexPath: string;
  attachmentFingerprint: string;
  policyFingerprint: string;
  chunkerVersion: string;
  providerId: string;
  model: string;
  providerConfigurationDigest: string;
  fileCount: number;
  chunkCount: number;
  skippedFileCounts?: {
    policy: number;
    sensitive: number;
    unsupported: number;
  };
  completedAt: string;
  refreshGeneration: number;
}

/** Public, immutable run binding. Internal cache paths are deliberately absent. */
export interface KnowledgeSnapshotPin {
  attachmentId: string;
  snapshotId: string;
  commitSha: string;
  indexDigest: string;
  policyFingerprint: string;
  providerId: string;
  model: string;
  providerConfigurationDigest: string;
  topK: number;
  maxPromptTokens: number;
  /** Required by attachment configuration, independent of Flow stage scopes. */
  attachmentRequired: boolean;
  /** Required by attachment configuration or at least one admitted stage. */
  required: boolean;
}

export interface KnowledgeSnapshotSet {
  version: 1;
  pinnedAt: string;
  attachments: KnowledgeSnapshotPin[];
  degradedAttachmentIds: string[];
}

export type KnowledgeRepositoryStatusState =
  | "never-refreshed"
  | "refreshing"
  | "ready"
  | "stale"
  | "failed"
  | "disabled";

export interface KnowledgeRepositoryStatus {
  version: 1;
  attachmentId: string;
  state: KnowledgeRepositoryStatusState;
  retrievalMode: "hybrid";
  currentSnapshot?: KnowledgeSnapshotIdentity;
  lastAttemptAt?: string;
  lastSuccessfulRefreshAt?: string;
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  staleReasons: string[];
  refreshGeneration: number;
}

export interface CreateKnowledgeRepositoryAttachmentInput {
  id: string;
  name: string;
  source: KnowledgeRepositorySource;
  ref: KnowledgeRepositoryRef;
  paths?: { include?: string[]; exclude?: string[] };
  enabled?: boolean;
  required?: boolean;
  refreshPolicy?: KnowledgeRefreshPolicy;
  budgets?: Partial<KnowledgeRepositoryBudgets>;
  retrieval?: Partial<KnowledgeRetrievalConfiguration> & {
    providerId?: KnowledgeRetrievalConfiguration["providerId"];
  };
  ownerId?: string;
  organizationId?: string;
  createdBy?: string;
}

export interface KnowledgeChunk {
  id: string;
  attachmentId: string;
  commitSha: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  contentDigest: string;
  approxTokens: number;
}

export interface KnowledgeIndex {
  version: 1;
  attachmentId: string;
  attachmentName?: string;
  commitSha: string;
  policyFingerprint: string;
  providerId: string;
  model: string;
  dimension: number;
  createdAt: string;
  chunks: KnowledgeChunk[];
  lexical?: unknown;
  vectors?: number[][];
}

export interface KnowledgeIndexBuildResult {
  index: KnowledgeIndex;
  indexDigest: string;
  policyFingerprint: string;
  chunkerVersion: string;
  providerId: string;
  model: string;
  fileCount: number;
  warnings?: string[];
}

export interface KnowledgeQueryMatch {
  chunk: KnowledgeChunk;
  citation: string;
  rank: number;
  lexicalScore: number;
  semanticScore: number;
  combinedScore: number;
}

export interface KnowledgeQueryResult {
  queryDigest: string;
  matches: KnowledgeQueryMatch[];
  degradedAttachmentIds: string[];
}

const attachmentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const gitObjectIdPattern = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/;

function requireNonEmpty(value: string, field: string, maximum = 256): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${field} contains control characters`);
  return normalized;
}

export function normalizeKnowledgeAttachmentId(value: string): string {
  const id = requireNonEmpty(value, "knowledge repository id", 64);
  if (!attachmentIdPattern.test(id)) {
    throw new Error("invalid knowledge repository id");
  }
  return id;
}

export function normalizeKnowledgeGitRef(
  input: KnowledgeRepositoryRef,
): KnowledgeRepositoryRef {
  const value = requireNonEmpty(input.value, "knowledge repository ref", 240);
  if (input.type === "commit") {
    if (!gitObjectIdPattern.test(value)) {
      throw new Error("knowledge repository commit ref must be a full Git object id");
    }
    return { type: "commit", value: value.toLowerCase() };
  }
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[\s~^:?*[\]\\]/u.test(value) ||
    value.split("/").some((segment) => !segment || segment.endsWith(".lock"))
  ) {
    throw new Error(`invalid knowledge repository ${input.type} ref`);
  }
  return { type: input.type, value };
}

export function normalizeGitHubKnowledgeUrl(value: string): string {
  const raw = requireNonEmpty(value, "knowledge repository URL", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid knowledge repository URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("knowledge repository remote must be a credential-free GitHub HTTPS URL");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("knowledge repository URL must identify one GitHub repository");
  }
  const owner = segments[0] ?? "";
  const repository = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!githubOwnerPattern.test(owner) || !githubRepositoryPattern.test(repository)) {
    throw new Error("invalid GitHub knowledge repository URL");
  }
  return `https://github.com/${owner}/${repository}.git`;
}

export function normalizeKnowledgeGlob(value: string): string {
  const raw = requireNonEmpty(value, "knowledge path pattern", 256);
  if (raw.startsWith("!") || raw.includes("\\") || isAbsolute(raw)) {
    throw new Error("knowledge path pattern must be a relative positive glob");
  }
  const normalized = posix.normalize(raw.replace(/^\.\/+/, ""));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("knowledge path pattern escapes the repository");
  }
  return normalized;
}

function normalizeUniqueGlobs(values: string[] | undefined, fallback: string[]): string[] {
  return [...new Set((values ?? fallback).map(normalizeKnowledgeGlob))];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`invalid knowledge ${field}`);
  }
  return selected;
}

export function normalizeKnowledgeBudgets(
  input: Partial<KnowledgeRepositoryBudgets> | undefined,
): KnowledgeRepositoryBudgets {
  const budgets: KnowledgeRepositoryBudgets = {
    maxFiles: boundedInteger(input?.maxFiles, DEFAULT_KNOWLEDGE_BUDGETS.maxFiles, "maxFiles", 1, 100_000),
    maxFileBytes: boundedInteger(input?.maxFileBytes, DEFAULT_KNOWLEDGE_BUDGETS.maxFileBytes, "maxFileBytes", 1_024, 8 * 1024 * 1024),
    maxTotalBytes: boundedInteger(input?.maxTotalBytes, DEFAULT_KNOWLEDGE_BUDGETS.maxTotalBytes, "maxTotalBytes", 1_024, 1024 * 1024 * 1024),
    maxChunks: boundedInteger(input?.maxChunks, DEFAULT_KNOWLEDGE_BUDGETS.maxChunks, "maxChunks", 1, 1_000_000),
    chunkTokens: boundedInteger(input?.chunkTokens, DEFAULT_KNOWLEDGE_BUDGETS.chunkTokens, "chunkTokens", 32, 8_192),
    chunkOverlapTokens: boundedInteger(input?.chunkOverlapTokens, DEFAULT_KNOWLEDGE_BUDGETS.chunkOverlapTokens, "chunkOverlapTokens", 0, 2_048),
    topK: boundedInteger(input?.topK, DEFAULT_KNOWLEDGE_BUDGETS.topK, "topK", 1, 100),
    maxPromptTokens: boundedInteger(input?.maxPromptTokens, DEFAULT_KNOWLEDGE_BUDGETS.maxPromptTokens, "maxPromptTokens", 64, 32_768),
  };
  if (budgets.chunkOverlapTokens >= budgets.chunkTokens) {
    throw new Error("knowledge chunkOverlapTokens must be smaller than chunkTokens");
  }
  if (budgets.maxFileBytes > budgets.maxTotalBytes) {
    throw new Error("knowledge maxFileBytes must not exceed maxTotalBytes");
  }
  return budgets;
}

function normalizeRefreshPolicy(
  input: KnowledgeRefreshPolicy | undefined,
): KnowledgeRefreshPolicy {
  if (!input || input.mode === "manual") return { mode: "manual" };
  return {
    mode: "on-admission",
    maxAgeSeconds: boundedInteger(
      input.maxAgeSeconds,
      86_400,
      "refresh maxAgeSeconds",
      60,
      365 * 24 * 60 * 60,
    ),
  };
}

function normalizeRetrieval(
  input: CreateKnowledgeRepositoryAttachmentInput["retrieval"],
): KnowledgeRetrievalConfiguration {
  const providerId = input?.providerId ?? "local-hash";
  if (
    providerId !== "local-hash" &&
    providerId !== "ollama" &&
    providerId !== "openai-compatible"
  ) {
    throw new Error("unsupported knowledge retrieval provider");
  }
  const model = requireNonEmpty(
    input?.model ??
      (providerId === "local-hash"
        ? "unicode-hash-v1"
        : providerId === "ollama"
          ? "nomic-embed-text"
          : "text-embedding-3-small"),
    "knowledge retrieval model",
    200,
  );
  return {
    mode: "hybrid",
    providerId,
    model,
  };
}

export function normalizeKnowledgeAttachmentSource(
  input: KnowledgeRepositorySource,
): KnowledgeRepositorySource {
  if (input.type === "remote") {
    if (input.providerId !== "github") {
      throw new Error("unsupported knowledge repository provider");
    }
    return {
      type: "remote",
      providerId: "github",
      url: normalizeGitHubKnowledgeUrl(input.url),
    };
  }
  return {
    type: "local",
    path: requireNonEmpty(input.path, "knowledge repository local path", 4_096),
  };
}

export function normalizeCreateKnowledgeAttachment(
  input: CreateKnowledgeRepositoryAttachmentInput,
  options: { now: string; canonicalLocalPath?: string },
): KnowledgeRepositoryAttachment {
  const source = normalizeKnowledgeAttachmentSource(input.source);
  return {
    id: normalizeKnowledgeAttachmentId(input.id),
    name: requireNonEmpty(input.name, "knowledge repository name", 200),
    source:
      source.type === "local" && options.canonicalLocalPath
        ? { type: "local", path: options.canonicalLocalPath }
        : source,
    ref: normalizeKnowledgeGitRef(input.ref),
    paths: {
      include: normalizeUniqueGlobs(input.paths?.include, ["**/*"]),
      exclude: normalizeUniqueGlobs(input.paths?.exclude, []),
    },
    enabled: input.enabled ?? true,
    required: input.required ?? false,
    refreshPolicy: normalizeRefreshPolicy(input.refreshPolicy),
    budgets: normalizeKnowledgeBudgets(input.budgets),
    retrieval: normalizeRetrieval(input.retrieval),
    ...(input.ownerId ? { ownerId: requireNonEmpty(input.ownerId, "knowledge owner id", 160) } : {}),
    ...(input.organizationId
      ? { organizationId: requireNonEmpty(input.organizationId, "knowledge organization id", 160) }
      : {}),
    ...(input.createdBy
      ? { createdBy: requireNonEmpty(input.createdBy, "knowledge creator id", 160) }
      : {}),
    createdAt: options.now,
    updatedAt: options.now,
    generation: 1,
    refreshGeneration: 0,
  };
}
