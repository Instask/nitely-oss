import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import { extname, posix } from "node:path";
import { TextDecoder } from "node:util";

import { evaluateLocalPath, loadContextPolicy, type ContextPolicy } from "../context/policy.js";
import {
  collectEnvSecretValues,
  containsSensitiveText,
  isSensitiveKey,
  redactText,
} from "../context/redaction.js";
import type { ProviderConnectionStore } from "../providers/types.js";
import { chunkKnowledgeDocument, KNOWLEDGE_CHUNKER_VERSION } from "./chunker.js";
import {
  LocalHashEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  type KnowledgeEmbeddingProvider,
} from "./embeddings.js";
import {
  listKnowledgeGitTree,
  readKnowledgeGitBlob,
  refreshKnowledgeGitSnapshot,
  resolveLocalKnowledgeGitRoot,
  type KnowledgeGitCommandRunner,
  KnowledgeGitError,
} from "./git.js";
import {
  assertKnowledgeIndexIntegrity,
  buildKnowledgeIndex,
  type BuildKnowledgeIndexInput,
  type KnowledgeIndexArtifact,
} from "./index.js";
import { withKnowledgeLease } from "./lock.js";
import {
  knowledgeAttachmentLockPath,
  knowledgeImmutableIndexPath,
  resolveKnowledgeRepositoryPaths,
  type KnowledgeRepositoryPaths,
} from "./paths.js";
import {
  packKnowledgeRetrievalMatches,
  queryKnowledgeIndexes,
  type KnowledgeRetrievalResult,
  type QueryKnowledgeIndexesInput,
} from "./retrieval.js";
import {
  beginStoredKnowledgeRefresh,
  createStoredKnowledgeRepository,
  detachStoredKnowledgeRepository,
  getStoredKnowledgeRepository,
  listStoredKnowledgeRepositories,
  publishStoredKnowledgeStatus,
  readKnowledgeRepositoryStatus,
  writeKnowledgeJsonAtomic,
} from "./store.js";
import {
  normalizeCreateKnowledgeAttachment,
  normalizeKnowledgeAttachmentId,
  type CreateKnowledgeRepositoryAttachmentInput,
  type KnowledgeChunk,
  type KnowledgeRepositoryAttachment,
  type KnowledgeRepositoryStatus,
  type KnowledgeRetrievalConfiguration,
  type KnowledgeSnapshotIdentity,
  type KnowledgeSnapshotPin,
  type KnowledgeSnapshotSet,
} from "./schema.js";
import {
  estimateKnowledgeTokens,
  normalizeKnowledgeText,
} from "./tokenize.js";

export interface KnowledgeRepositoryBaseInput {
  targetRepoPath: string;
  runtimeRoot?: string;
  env?: Record<string, string | undefined>;
}

export interface KnowledgeRepositoryItemInput extends KnowledgeRepositoryBaseInput {
  attachmentId: string;
}

export interface KnowledgeRepositoryView {
  attachment: KnowledgeRepositoryAttachment;
  status: KnowledgeRepositoryStatus;
}

export interface KnowledgeIndexBuildInput extends BuildKnowledgeIndexInput {
  targetRepoPath: string;
  mirrorPath: string;
  attachment: KnowledgeRepositoryAttachment;
}

/** Compatibility alias for embedders that inject the retrieval implementation. */
export type KnowledgeIndexQueryInput = QueryKnowledgeIndexesInput;

export interface KnowledgeRepositoryServiceDependencies {
  gitRunner?: KnowledgeGitCommandRunner;
  providerStore?: ProviderConnectionStore;
  embeddingProviderResolver?: (
    attachment: KnowledgeRepositoryAttachment,
    env: Record<string, string | undefined>,
  ) => Promise<KnowledgeEmbeddingProvider | undefined> | KnowledgeEmbeddingProvider | undefined;
  buildIndex?: (input: KnowledgeIndexBuildInput) => Promise<KnowledgeIndexArtifact>;
  queryIndexes?: (input: KnowledgeIndexQueryInput) => Promise<KnowledgeRetrievalResult>;
  now?: () => Date;
  redactionSecrets?: readonly string[];
}

export class KnowledgeRepositoryUnavailableError extends Error {
  constructor(
    public readonly attachmentId: string,
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeRepositoryUnavailableError";
  }
}

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".graphql", ".h", ".hpp",
  ".html", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".md", ".mdx",
  ".mjs", ".mts", ".php", ".properties", ".py", ".rb", ".rs", ".rst",
  ".scala", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".xml", ".yaml", ".yml",
]);
const TEXT_BASENAMES = new Set([
  "readme", "license", "notice", "dockerfile", "makefile", "gemfile",
]);
const HARD_SECRET_PATH_PATTERNS = [
  ".git/**",
  ".nitely/**",
  "**/.git/**",
  "**/.nitely/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials.json",
  "**/secrets.*",
] as const;
const KNOWLEDGE_POLICY_VERSION = "nitely.knowledge-policy.v1";
const NONE_PROVIDER_CONFIGURATION_DIGEST = `sha256:${sha256("none")}`;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function segmentMatches(pattern: string, segment: string): boolean {
  let source = "";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "u").test(segment);
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...tail] = pattern;
  if (head === "**") {
    return matchSegments(tail, path) ||
      (path.length > 0 && matchSegments(pattern, path.slice(1)));
  }
  return path.length > 0 && segmentMatches(head ?? "", path[0] ?? "") &&
    matchSegments(tail, path.slice(1));
}

function globMatches(pattern: string, path: string): boolean {
  const normalizedPattern = posix.normalize(pattern).split("/").filter(Boolean);
  const normalizedPath = posix.normalize(path).split("/").filter(Boolean);
  return matchSegments(normalizedPattern, normalizedPath);
}

export function knowledgePathAllowed(input: {
  targetPolicy: ContextPolicy;
  attachment: KnowledgeRepositoryAttachment;
  path: string;
}): boolean {
  // External-provider disclosure is fail closed: warned is denied too.
  if (evaluateLocalPath(input.targetPolicy, input.path).decision !== "allowed") return false;
  if (HARD_SECRET_PATH_PATTERNS.some((pattern) => globMatches(pattern, input.path))) {
    return false;
  }
  if (input.attachment.paths.exclude.some((pattern) => globMatches(pattern, input.path))) {
    return false;
  }
  return input.attachment.paths.include.some((pattern) => globMatches(pattern, input.path));
}

function structuredObjectHasSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(structuredObjectHasSecret);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) return true;
    if (structuredObjectHasSecret(entry)) return true;
  }
  return false;
}

export function containsStructuredKnowledgeSecret(
  text: string,
  knownSecrets: readonly string[] = [],
): boolean {
  if (containsSensitiveText(text)) return true;
  if (
    knownSecrets.some((secret) => secret.length >= 8 && text.includes(secret)) ||
    /<\/?(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|authorization|credential)\b/iu.test(text)
  ) {
    return true;
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(.+?)\s*$/u.exec(line);
    if (match && isSensitiveKey(match[1] ?? "") && (match[2] ?? "").length > 0) {
      return true;
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      if (structuredObjectHasSecret(JSON.parse(trimmed))) return true;
    } catch {
      // Malformed JSON is still covered by line/key and generic scanners.
    }
  }
  return false;
}

function textCandidate(path: string): boolean {
  const base = posix.basename(path).toLocaleLowerCase("en-US");
  return TEXT_EXTENSIONS.has(extname(base).toLocaleLowerCase("en-US")) ||
    TEXT_BASENAMES.has(base);
}

function attachmentFingerprint(attachment: KnowledgeRepositoryAttachment): string {
  return `sha256:${sha256(canonicalJson({
    source: attachment.source,
    ref: attachment.ref,
    paths: attachment.paths,
    budgets: attachment.budgets,
    retrieval: attachment.retrieval,
  }))}`;
}

function policyFingerprint(
  policy: ContextPolicy,
  attachment: KnowledgeRepositoryAttachment,
): string {
  return `sha256:${sha256(canonicalJson({
    version: KNOWLEDGE_POLICY_VERSION,
    target: policy,
    include: attachment.paths.include,
    exclude: attachment.paths.exclude,
    hardExcludes: HARD_SECRET_PATH_PATTERNS,
  }))}`;
}

async function defaultEmbeddingProviderForConfiguration(
  retrieval: Pick<KnowledgeRetrievalConfiguration, "providerId" | "model">,
  env: Record<string, string | undefined>,
): Promise<KnowledgeEmbeddingProvider | undefined> {
  switch (retrieval.providerId) {
    case "local-hash":
      return new LocalHashEmbeddingProvider({ model: retrieval.model });
    case "ollama":
      return new OllamaEmbeddingProvider({
        baseUrl: env.NITELY_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
        model: retrieval.model,
      });
    case "openai-compatible":
      return new OpenAICompatibleEmbeddingProvider({
        model: retrieval.model,
        env,
      });
  }
}

async function defaultEmbeddingProvider(
  attachment: KnowledgeRepositoryAttachment,
  env: Record<string, string | undefined>,
): Promise<KnowledgeEmbeddingProvider | undefined> {
  return await defaultEmbeddingProviderForConfiguration(attachment.retrieval, env);
}

interface QueryHmacKeyDocument {
  version: 1;
  key: string;
}

async function readOrCreateQueryHmacKey(paths: KnowledgeRepositoryPaths): Promise<Buffer> {
  return await withKnowledgeLease(
    { path: `${paths.queryHmacKeyPath}.lock`, waitMs: 15_000 },
    async () => {
      try {
        const stats = await lstat(paths.queryHmacKeyPath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error("knowledge query fingerprint key path is unsafe");
        }
        await chmod(paths.queryHmacKeyPath, 0o600);
        const value = JSON.parse(await readFile(paths.queryHmacKeyPath, "utf8")) as Partial<QueryHmacKeyDocument>;
        if (
          value.version !== 1 ||
          typeof value.key !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(value.key)
        ) {
          throw new Error("invalid knowledge query fingerprint key");
        }
        const key = Buffer.from(value.key, "base64url");
        if (key.byteLength !== 32) throw new Error("invalid knowledge query fingerprint key");
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const key = randomBytes(32);
        await writeKnowledgeJsonAtomic(paths.queryHmacKeyPath, {
          version: 1,
          key: key.toString("base64url"),
        } satisfies QueryHmacKeyDocument);
        return key;
      }
    },
  );
}

async function queryFingerprint(
  paths: KnowledgeRepositoryPaths,
  query: string,
): Promise<string> {
  const key = await readOrCreateQueryHmacKey(paths);
  return `hmac-sha256:${createHmac("sha256", key)
    .update(normalizeKnowledgeText(query), "utf8")
    .digest("hex")}`;
}

async function extractKnowledgeChunks(input: {
  paths: KnowledgeRepositoryPaths;
  targetPolicy: ContextPolicy;
  attachment: KnowledgeRepositoryAttachment;
  mirrorPath: string;
  commitSha: string;
  gitRunner?: KnowledgeGitCommandRunner;
  env: Record<string, string | undefined>;
  knownSecrets: readonly string[];
}): Promise<{
  chunks: KnowledgeChunk[];
  acceptedFiles: number;
  skippedByPolicy: number;
  skippedSensitive: number;
  skippedUnsupported: number;
}> {
  const tree = await listKnowledgeGitTree({
    paths: input.paths,
    mirrorPath: input.mirrorPath,
    commitSha: input.commitSha,
    runner: input.gitRunner,
    sourceEnv: input.env,
    maxEntries: Math.max(input.attachment.budgets.maxFiles * 20, 10_000),
  });
  const chunks: KnowledgeChunk[] = [];
  let acceptedFiles = 0;
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  let skippedByPolicy = tree.skipped;
  let skippedSensitive = 0;
  let skippedUnsupported = 0;
  for (const entry of tree.entries) {
    if (!knowledgePathAllowed({
      targetPolicy: input.targetPolicy,
      attachment: input.attachment,
      path: entry.path,
    })) {
      skippedByPolicy += 1;
      continue;
    }
    if (!textCandidate(entry.path) || entry.size > input.attachment.budgets.maxFileBytes) {
      skippedUnsupported += 1;
      continue;
    }
    if (inspectedFiles >= input.attachment.budgets.maxFiles) {
      throw new KnowledgeRepositoryUnavailableError(
        input.attachment.id,
        "file-limit",
        "knowledge source exceeds the configured file-count limit",
      );
    }
    if (inspectedBytes + entry.size > input.attachment.budgets.maxTotalBytes) {
      throw new KnowledgeRepositoryUnavailableError(
        input.attachment.id,
        "byte-limit",
        "knowledge source exceeds the configured total-byte limit",
      );
    }
    inspectedFiles += 1;
    inspectedBytes += entry.size;
    const bytes = await readKnowledgeGitBlob({
      paths: input.paths,
      mirrorPath: input.mirrorPath,
      objectId: entry.objectId,
      expectedSize: entry.size,
      maximumBytes: input.attachment.budgets.maxFileBytes,
      runner: input.gitRunner,
      sourceEnv: input.env,
    });
    let text: string;
    try {
      if (bytes.includes(0)) throw new Error("binary");
      text = utf8Decoder.decode(bytes);
    } catch {
      skippedUnsupported += 1;
      continue;
    }
    if (containsStructuredKnowledgeSecret(text, input.knownSecrets)) {
      skippedSensitive += 1;
      continue;
    }
    const documentChunks = chunkKnowledgeDocument(
      {
        attachmentId: input.attachment.id,
        commitSha: input.commitSha,
        path: entry.path,
        text,
      },
      {
        maxTokens: input.attachment.budgets.chunkTokens,
        overlapTokens: input.attachment.budgets.chunkOverlapTokens,
      },
    );
    if (chunks.length + documentChunks.length > input.attachment.budgets.maxChunks) {
      throw new KnowledgeRepositoryUnavailableError(
        input.attachment.id,
        "chunk-limit",
        "knowledge source exceeds the configured chunk-count limit",
      );
    }
    chunks.push(...documentChunks);
    acceptedFiles += 1;
  }
  return {
    chunks,
    acceptedFiles,
    skippedByPolicy,
    skippedSensitive,
    skippedUnsupported,
  };
}

async function servicePaths(input: KnowledgeRepositoryBaseInput): Promise<KnowledgeRepositoryPaths> {
  return await resolveKnowledgeRepositoryPaths({
    targetRepoPath: input.targetRepoPath,
    runtimeRoot: input.runtimeRoot,
    env: input.env,
  });
}

function nowIso(dependencies: KnowledgeRepositoryServiceDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

async function knowledgeRedactionSecrets(
  env: Record<string, string | undefined>,
  dependencies: KnowledgeRepositoryServiceDependencies,
): Promise<string[]> {
  const providerEnv = dependencies.providerStore
    ? await dependencies.providerStore.resolveEnv()
    : {};
  return [...new Set([
    ...collectEnvSecretValues(env),
    ...collectEnvSecretValues(providerEnv),
    ...(dependencies.redactionSecrets ?? []),
  ])];
}

export async function fingerprintKnowledgeRepositoryQuery(
  input: KnowledgeRepositoryBaseInput & { query: string },
  dependencies: KnowledgeRepositoryServiceDependencies = {},
): Promise<string> {
  const paths = await servicePaths(input);
  const knownSecrets = await knowledgeRedactionSecrets(
    input.env ?? process.env,
    dependencies,
  );
  const safeQuery = redactText(input.query, knownSecrets) ?? "";
  if (!safeQuery.trim() || containsStructuredKnowledgeSecret(safeQuery, knownSecrets)) {
    throw new Error("knowledge retrieval query contains sensitive content");
  }
  return await queryFingerprint(paths, safeQuery);
}

export async function attachKnowledgeRepository(
  input: KnowledgeRepositoryBaseInput & {
    attachment: CreateKnowledgeRepositoryAttachmentInput;
    refresh?: boolean;
  },
  dependencies: KnowledgeRepositoryServiceDependencies = {},
): Promise<KnowledgeRepositoryView> {
  const paths = await servicePaths(input);
  let canonicalLocalPath: string | undefined;
  if (input.attachment.source.type === "local") {
    canonicalLocalPath = await resolveLocalKnowledgeGitRoot({
      path: input.attachment.source.path,
      paths,
      runner: dependencies.gitRunner,
      sourceEnv: input.env,
    });
  }
  const attachment = normalizeCreateKnowledgeAttachment(input.attachment, {
    now: nowIso(dependencies),
    ...(canonicalLocalPath ? { canonicalLocalPath } : {}),
  });
  await createStoredKnowledgeRepository(paths, attachment);
  if (input.refresh !== false && attachment.enabled) {
    const status = await refreshKnowledgeRepository(
      { ...input, attachmentId: attachment.id },
      dependencies,
    );
    return { attachment: await getStoredKnowledgeRepository(paths, attachment.id), status };
  }
  return {
    attachment,
    status: await readKnowledgeRepositoryStatus(paths, attachment.id),
  };
}

async function observedKnowledgeRepositoryStatus(
  paths: KnowledgeRepositoryPaths,
  attachment: KnowledgeRepositoryAttachment,
): Promise<KnowledgeRepositoryStatus> {
  const status = await readKnowledgeRepositoryStatus(paths, attachment.id);
  if (!attachment.enabled) {
    return { ...status, state: "disabled" };
  }
  const snapshot = status.currentSnapshot;
  if (!snapshot) return status;
  const reasons = new Set(status.staleReasons);
  if (snapshot.attachmentFingerprint !== attachmentFingerprint(attachment)) {
    reasons.add("attachment-changed");
  }
  const currentPolicy = await loadContextPolicy(paths.targetRepoPath);
  if (snapshot.policyFingerprint !== policyFingerprint(currentPolicy, attachment)) {
    reasons.add("policy-changed");
  }
  if (!await validPinnedIndex(paths, attachment.id, snapshot)) {
    reasons.add("snapshot-unavailable");
  }
  if (attachment.refreshPolicy.mode === "on-admission") {
    const refreshedAt = status.lastSuccessfulRefreshAt
      ? new Date(status.lastSuccessfulRefreshAt).getTime()
      : Number.NaN;
    const ageSeconds = (Date.now() - refreshedAt) / 1_000;
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds < 0 ||
      ageSeconds > attachment.refreshPolicy.maxAgeSeconds
    ) {
      reasons.add("refresh-overdue");
    }
  }
  const staleReasons = [...reasons].sort();
  return {
    ...status,
    ...(status.state === "ready" && staleReasons.length > 0
      ? { state: "stale" as const }
      : {}),
    staleReasons,
  };
}

export async function listKnowledgeRepositories(
  input: KnowledgeRepositoryBaseInput,
): Promise<KnowledgeRepositoryView[]> {
  const paths = await servicePaths(input);
  const attachments = await listStoredKnowledgeRepositories(paths);
  return await Promise.all(
    attachments.map(async (attachment) => ({
      attachment,
      status: await observedKnowledgeRepositoryStatus(paths, attachment),
    })),
  );
}

export async function getKnowledgeRepositoryStatus(
  input: KnowledgeRepositoryItemInput,
): Promise<KnowledgeRepositoryView> {
  const paths = await servicePaths(input);
  const attachment = await getStoredKnowledgeRepository(paths, input.attachmentId);
  return {
    attachment,
    status: await observedKnowledgeRepositoryStatus(paths, attachment),
  };
}

function refreshFailure(error: unknown, knownSecrets: readonly string[]): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const code = error instanceof KnowledgeGitError
    ? error.code
    : error instanceof KnowledgeRepositoryUnavailableError
      ? error.reasonCode
      : "refresh-failed";
  const generic = error instanceof KnowledgeGitError || error instanceof KnowledgeRepositoryUnavailableError
    ? error.message
    : "knowledge repository refresh failed";
  return {
    code,
    message: redactText(generic, knownSecrets) ?? "knowledge repository refresh failed",
    retryable: code !== "invalid-source" && code !== "unsafe-tree",
  };
}

export async function refreshKnowledgeRepository(
  input: KnowledgeRepositoryItemInput,
  dependencies: KnowledgeRepositoryServiceDependencies = {},
): Promise<KnowledgeRepositoryStatus> {
  const paths = await servicePaths(input);
  const attachmentId = normalizeKnowledgeAttachmentId(input.attachmentId);
  return await withKnowledgeLease(
    { path: knowledgeAttachmentLockPath(paths, attachmentId), waitMs: 0 },
    async () => {
      const attemptedAt = nowIso(dependencies);
      const attachment = await beginStoredKnowledgeRefresh(paths, attachmentId, attemptedAt);
      if (!attachment.enabled) {
        return await readKnowledgeRepositoryStatus(paths, attachmentId);
      }
      const previous = await readKnowledgeRepositoryStatus(paths, attachmentId);
      const env = input.env ?? process.env;
      const knownSecrets = await knowledgeRedactionSecrets(env, dependencies);
      try {
        const snapshot = await refreshKnowledgeGitSnapshot({
          paths,
          source: attachment.source,
          ref: attachment.ref,
          providerStore: dependencies.providerStore,
          runner: dependencies.gitRunner,
          sourceEnv: env,
        });
        const targetPolicy = await loadContextPolicy(paths.targetRepoPath);
        const extracted = await extractKnowledgeChunks({
          paths,
          targetPolicy,
          attachment,
          mirrorPath: snapshot.mirrorPath,
          commitSha: snapshot.commitSha,
          gitRunner: dependencies.gitRunner,
          env,
          knownSecrets,
        });
        if (extracted.chunks.length === 0) {
          throw new KnowledgeRepositoryUnavailableError(
            attachment.id,
            "policy-blocked",
            "knowledge source produced no policy-approved, secret-free text chunks",
          );
        }
        const fingerprint = policyFingerprint(targetPolicy, attachment);
        const embeddingProvider = dependencies.embeddingProviderResolver
          ? await dependencies.embeddingProviderResolver(attachment, env)
          : await defaultEmbeddingProvider(attachment, env);
        const buildInput: KnowledgeIndexBuildInput = {
          targetRepoPath: paths.targetRepoPath,
          mirrorPath: snapshot.mirrorPath,
          attachment,
          attachmentId: attachment.id,
          attachmentName: attachment.name,
          commitSha: snapshot.commitSha,
          policyFingerprint: fingerprint,
          chunks: extracted.chunks,
          embeddingProvider,
          createdAt: attemptedAt,
        };
        const index = dependencies.buildIndex
          ? await dependencies.buildIndex(buildInput)
          : await buildKnowledgeIndex(buildInput);
        const indexDigest = index.indexDigest;
        const snapshotId = sha256(canonicalJson({
          attachmentId: attachment.id,
          commitSha: snapshot.commitSha,
          attachmentFingerprint: attachmentFingerprint(attachment),
          policyFingerprint: fingerprint,
          chunkerVersion: KNOWLEDGE_CHUNKER_VERSION,
          providerId: index.providerId,
          model: index.model,
          indexDigest,
        }));
        const indexPath = knowledgeImmutableIndexPath(paths, attachment.id, snapshotId);
        try {
          const existing = JSON.parse(await readFile(indexPath, "utf8")) as KnowledgeIndexArtifact;
          assertKnowledgeIndexIntegrity(existing);
          if (existing.indexDigest !== indexDigest) {
            throw new Error("knowledge immutable index identity collision");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await writeKnowledgeJsonAtomic(indexPath, index);
        }
        const completedAt = nowIso(dependencies);
        const identity: KnowledgeSnapshotIdentity = {
          snapshotId,
          commitSha: snapshot.commitSha,
          indexDigest,
          indexPath,
          attachmentFingerprint: attachmentFingerprint(attachment),
          policyFingerprint: fingerprint,
          chunkerVersion: KNOWLEDGE_CHUNKER_VERSION,
          providerId: index.providerId,
          model: index.model,
          providerConfigurationDigest:
            index.embedding?.configurationDigest ?? NONE_PROVIDER_CONFIGURATION_DIGEST,
          fileCount: extracted.acceptedFiles,
          chunkCount: index.chunks.length,
          skippedFileCounts: {
            policy: extracted.skippedByPolicy,
            sensitive: extracted.skippedSensitive,
            unsupported: extracted.skippedUnsupported,
          },
          completedAt,
          refreshGeneration: attachment.refreshGeneration,
        };
        const status: KnowledgeRepositoryStatus = {
          version: 1,
          attachmentId,
          state: "ready",
          retrievalMode: "hybrid",
          currentSnapshot: identity,
          lastAttemptAt: attemptedAt,
          lastSuccessfulRefreshAt: completedAt,
          staleReasons: [],
          refreshGeneration: attachment.refreshGeneration,
        };
        await publishStoredKnowledgeStatus(
          paths,
          attachmentId,
          attachment.refreshGeneration,
          status,
        );
        return status;
      } catch (error) {
        const status: KnowledgeRepositoryStatus = {
          version: 1,
          attachmentId,
          state: "failed",
          retrievalMode: "hybrid",
          ...(previous.currentSnapshot ? { currentSnapshot: previous.currentSnapshot } : {}),
          lastAttemptAt: attemptedAt,
          ...(previous.lastSuccessfulRefreshAt
            ? { lastSuccessfulRefreshAt: previous.lastSuccessfulRefreshAt }
            : {}),
          failure: refreshFailure(error, knownSecrets),
          staleReasons: [],
          refreshGeneration: attachment.refreshGeneration,
        };
        await publishStoredKnowledgeStatus(
          paths,
          attachmentId,
          attachment.refreshGeneration,
          status,
        ).catch(() => {});
        throw error;
      }
    },
  );
}

async function validPinnedIndex(
  paths: KnowledgeRepositoryPaths,
  attachmentId: string,
  snapshot: KnowledgeSnapshotIdentity,
): Promise<boolean> {
  try {
    const expectedPath = knowledgeImmutableIndexPath(paths, attachmentId, snapshot.snapshotId);
    const parsed = JSON.parse(await readFile(expectedPath, "utf8")) as KnowledgeIndexArtifact;
    assertKnowledgeIndexIntegrity(parsed);
    return parsed.indexDigest === snapshot.indexDigest &&
      parsed.commitSha === snapshot.commitSha &&
      parsed.attachmentId === attachmentId;
  } catch {
    return false;
  }
}

export async function pinKnowledgeRepositorySnapshots(
  input: KnowledgeRepositoryBaseInput & {
    ids?: string[];
    requiredIds?: string[];
    availability?: "require-all" | "allow-degraded";
  },
  dependencies: KnowledgeRepositoryServiceDependencies = {},
): Promise<KnowledgeSnapshotSet> {
  const paths = await servicePaths(input);
  const requested = input.ids?.map(normalizeKnowledgeAttachmentId);
  const requestedSet = requested ? new Set(requested) : undefined;
  const requiredIds = input.requiredIds?.map(normalizeKnowledgeAttachmentId) ?? [];
  const requiredSet = new Set(requiredIds);
  if (input.requiredIds !== undefined && input.requiredIds.length === 0) {
    throw new KnowledgeRepositoryUnavailableError(
      "selection",
      "not-found",
      "required external knowledge selection is empty",
    );
  }
  const attachments = (await listStoredKnowledgeRepositories(paths)).filter(
    (attachment) => !requestedSet || requestedSet.has(attachment.id),
  );
  const degradedAttachmentIds: string[] = [];
  if (requestedSet) {
    for (const id of requestedSet) {
      if (!attachments.some((attachment) => attachment.id === id)) {
        if (input.availability === "require-all" || requiredSet.has(id)) {
          throw new KnowledgeRepositoryUnavailableError(
            id,
            "not-found",
            "required knowledge repository is not attached",
          );
        }
        degradedAttachmentIds.push(id);
      }
    }
  }
  for (const id of requiredSet) {
    if (!attachments.some((attachment) => attachment.id === id)) {
      throw new KnowledgeRepositoryUnavailableError(
        id,
        "not-found",
        "required knowledge repository is not attached",
      );
    }
  }
  if (input.availability === "require-all" && attachments.length === 0) {
    throw new KnowledgeRepositoryUnavailableError(
      "all",
      "not-found",
      "required external knowledge selection is empty",
    );
  }
  const pins: KnowledgeSnapshotPin[] = [];
  const currentTime = dependencies.now?.() ?? new Date();
  for (const attachment of attachments) {
    const required = attachment.required ||
      input.availability === "require-all" ||
      requiredSet.has(attachment.id);
    if (!attachment.enabled) {
      if (required) {
        throw new KnowledgeRepositoryUnavailableError(
          attachment.id,
          "disabled",
          "required knowledge repository is disabled",
        );
      }
      degradedAttachmentIds.push(attachment.id);
      continue;
    }
    let status = await readKnowledgeRepositoryStatus(paths, attachment.id);
    let snapshot = status.currentSnapshot;
    const snapshotUsable = async (
      candidate: KnowledgeSnapshotIdentity | undefined,
    ): Promise<boolean> => {
      if (!candidate || !await validPinnedIndex(paths, attachment.id, candidate)) return false;
      const currentPolicy = await loadContextPolicy(paths.targetRepoPath);
      return candidate.policyFingerprint === policyFingerprint(currentPolicy, attachment) &&
        candidate.attachmentFingerprint === attachmentFingerprint(attachment);
    };
    let usable = await snapshotUsable(snapshot);
    let admissionRefreshFailed = false;
    if (attachment.refreshPolicy.mode === "on-admission") {
      const successfulAt = status.lastSuccessfulRefreshAt
        ? new Date(status.lastSuccessfulRefreshAt).getTime()
        : Number.NaN;
      const ageSeconds = (currentTime.getTime() - successfulAt) / 1_000;
      const stale = !usable ||
        !Number.isFinite(ageSeconds) ||
        ageSeconds < 0 ||
        ageSeconds > attachment.refreshPolicy.maxAgeSeconds;
      if (stale) {
        try {
          status = await refreshKnowledgeRepository(
            {
              targetRepoPath: input.targetRepoPath,
              ...(input.runtimeRoot ? { runtimeRoot: input.runtimeRoot } : {}),
              ...(input.env ? { env: input.env } : {}),
              attachmentId: attachment.id,
            },
            dependencies,
          );
          snapshot = status.currentSnapshot;
          usable = await snapshotUsable(snapshot);
        } catch {
          // Optional repositories may retain their last immutable snapshot as
          // degraded evidence; required admission remains fail closed below.
          admissionRefreshFailed = true;
          status = await readKnowledgeRepositoryStatus(paths, attachment.id);
          snapshot = status.currentSnapshot;
          usable = await snapshotUsable(snapshot);
        }
      }
    }
    if (
      admissionRefreshFailed &&
      required
    ) {
      throw new KnowledgeRepositoryUnavailableError(
        attachment.id,
        "admission-refresh-failed",
        "required knowledge repository could not refresh its stale snapshot",
      );
    }
    if (!usable || !snapshot) {
      if (required) {
        throw new KnowledgeRepositoryUnavailableError(
          attachment.id,
          "snapshot-unavailable",
          "required knowledge repository has no fresh immutable snapshot",
        );
      }
      degradedAttachmentIds.push(attachment.id);
      continue;
    }
    if (status.state !== "ready" || admissionRefreshFailed) {
      degradedAttachmentIds.push(attachment.id);
    }
    pins.push({
      attachmentId: attachment.id,
      snapshotId: snapshot.snapshotId,
      commitSha: snapshot.commitSha,
      indexDigest: snapshot.indexDigest,
      policyFingerprint: snapshot.policyFingerprint,
      providerId: snapshot.providerId,
      model: snapshot.model,
      providerConfigurationDigest: snapshot.providerConfigurationDigest,
      topK: attachment.budgets.topK,
      maxPromptTokens: attachment.budgets.maxPromptTokens,
      attachmentRequired: attachment.required,
      required,
    });
  }
  return {
    version: 1,
    pinnedAt: currentTime.toISOString(),
    attachments: pins.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId)),
    degradedAttachmentIds: [...new Set(degradedAttachmentIds)].sort(),
  };
}

export async function queryKnowledgeRepositories(
  input: KnowledgeRepositoryBaseInput & {
    query: string;
    attachmentIds?: string[];
    topK?: number;
    maxPromptTokens?: number;
    pins?: KnowledgeSnapshotSet;
    allowDegraded?: boolean;
    /** Operation-local required scope; an empty list keeps this stage optional. */
    requiredAttachmentIds?: string[];
  },
  dependencies: KnowledgeRepositoryServiceDependencies = {},
): Promise<KnowledgeRetrievalResult> {
  const paths = await servicePaths(input);
  const knownSecrets = await knowledgeRedactionSecrets(
    input.env ?? process.env,
    dependencies,
  );
  const safeQuery = redactText(input.query, knownSecrets) ?? "";
  if (!safeQuery.trim() || containsStructuredKnowledgeSecret(safeQuery, knownSecrets)) {
    throw new Error("knowledge retrieval query contains sensitive content");
  }
  const pins = input.pins ?? await pinKnowledgeRepositorySnapshots(
    {
      ...input,
      ids: input.attachmentIds,
      availability: input.allowDegraded === false ? "require-all" : "allow-degraded",
    },
    dependencies,
  );
  const selected = input.attachmentIds
    ? new Set(input.attachmentIds.map(normalizeKnowledgeAttachmentId))
    : undefined;
  const selectedPins = pins.attachments.filter(
    (pin) => !selected || selected.has(pin.attachmentId),
  );
  const operationRequired = input.requiredAttachmentIds
    ? new Set(input.requiredAttachmentIds.map(normalizeKnowledgeAttachmentId))
    : undefined;
  const requiredForOperation = (pin: KnowledgeSnapshotPin): boolean =>
    pin.attachmentRequired ||
    input.allowDegraded === false ||
    (operationRequired ? operationRequired.has(pin.attachmentId) : pin.required);
  if (selected) {
    for (const attachmentId of selected) {
      if (!selectedPins.some((pin) => pin.attachmentId === attachmentId)) {
        if (
          input.allowDegraded !== false &&
          pins.degradedAttachmentIds.includes(attachmentId)
        ) {
          continue;
        }
        throw new KnowledgeRepositoryUnavailableError(
          attachmentId,
          "snapshot-unavailable",
          "requested knowledge repository has no pinned snapshot",
        );
      }
    }
  }
  const indexes: KnowledgeIndexArtifact[] = [];
  const indexByAttachment = new Map<string, KnowledgeIndexArtifact>();
  const providers: KnowledgeEmbeddingProvider[] = [];
  const attachments = new Map(
    (await listStoredKnowledgeRepositories(paths)).map((attachment) => [attachment.id, attachment]),
  );
  for (const pin of selectedPins) {
    const indexPath = knowledgeImmutableIndexPath(paths, pin.attachmentId, pin.snapshotId);
    let index: KnowledgeIndexArtifact;
    try {
      index = JSON.parse(await readFile(indexPath, "utf8")) as KnowledgeIndexArtifact;
    } catch {
      throw new KnowledgeRepositoryUnavailableError(
        pin.attachmentId,
        "snapshot-unavailable",
        "pinned knowledge index is unavailable",
      );
    }
    assertKnowledgeIndexIntegrity(index);
    if (
      index.indexDigest !== pin.indexDigest ||
      index.commitSha !== pin.commitSha ||
      index.policyFingerprint !== pin.policyFingerprint ||
      index.providerId !== pin.providerId ||
      index.model !== pin.model ||
      (index.embedding?.configurationDigest ?? NONE_PROVIDER_CONFIGURATION_DIGEST) !==
        pin.providerConfigurationDigest
    ) {
      throw new KnowledgeRepositoryUnavailableError(
        pin.attachmentId,
        "snapshot-mismatch",
        "pinned knowledge index does not match its immutable identity",
      );
    }
    indexes.push(index);
    indexByAttachment.set(pin.attachmentId, index);
    const attachment = attachments.get(pin.attachmentId);
    const attachmentMatchesPin = attachment?.retrieval.providerId === pin.providerId &&
      attachment.retrieval.model === pin.model;
    let provider: KnowledgeEmbeddingProvider | undefined;
    try {
      provider = attachment && attachmentMatchesPin && dependencies.embeddingProviderResolver
        ? await dependencies.embeddingProviderResolver(attachment, input.env ?? process.env)
        : pin.providerId === "local-hash" ||
            pin.providerId === "ollama" ||
            pin.providerId === "openai-compatible"
          ? await defaultEmbeddingProviderForConfiguration(
              { providerId: pin.providerId, model: pin.model },
              input.env ?? process.env,
            )
          : undefined;
    } catch (error) {
      if (requiredForOperation(pin)) throw error;
      provider = undefined;
    }
    if (
      provider &&
      !providers.some((candidate) =>
        candidate.identity.id === provider.identity.id &&
        candidate.identity.model === provider.identity.model &&
        candidate.identity.version === provider.identity.version &&
        candidate.identity.configurationDigest === provider.identity.configurationDigest &&
        candidate.identity.dimensions === provider.identity.dimensions &&
        candidate.identity.semantic === provider.identity.semantic
      )
    ) {
      providers.push(provider);
    }
  }
  const effectiveTopK = selectedPins.length > 0
    ? Math.min(input.topK ?? Number.POSITIVE_INFINITY, ...selectedPins.map((pin) => pin.topK))
    : input.topK;
  const effectiveMaxPromptTokens = selectedPins.length > 0
    ? Math.min(
        input.maxPromptTokens ?? Number.POSITIVE_INFINITY,
        ...selectedPins.map((pin) => pin.maxPromptTokens),
      )
    : input.maxPromptTokens;
  const result = await (dependencies.queryIndexes ?? queryKnowledgeIndexes)({
    indexes,
    query: safeQuery,
    ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
    ...(effectiveTopK !== undefined ? { topK: effectiveTopK } : {}),
    ...(effectiveMaxPromptTokens !== undefined
      ? { maxPromptTokens: effectiveMaxPromptTokens }
      : {}),
    embeddingProviders: providers,
    allowDegraded: input.allowDegraded ?? true,
  });
  const pinnedDegradedAttachmentIds = pins.degradedAttachmentIds.filter(
    (attachmentId) => !selected || selected.has(attachmentId),
  );
  const degradedAttachmentIds = [...new Set([
    ...pinnedDegradedAttachmentIds,
    ...result.degradedAttachmentIds,
  ])].sort();
  const requiredDegraded = selectedPins.find(
    (pin) =>
      requiredForOperation(pin) &&
      result.degradedAttachmentIds.includes(pin.attachmentId),
  );
  if (requiredDegraded) {
    throw new KnowledgeRepositoryUnavailableError(
      requiredDegraded.attachmentId,
      "embedding-degraded",
      "required knowledge repository retrieval provider is unavailable",
    );
  }
  let omittedSensitiveMatches = 0;
  const redactedMatches = result.matches.flatMap((match) => {
    const redacted = redactText(match.text, knownSecrets) ?? "";
    if (!redacted.trim() || containsStructuredKnowledgeSecret(redacted, knownSecrets)) {
      omittedSensitiveMatches += 1;
      return [];
    }
    const pin = selectedPins.find((candidate) => candidate.attachmentId === match.attachmentId);
    const index = indexByAttachment.get(match.attachmentId);
    if (!pin || !index) return [];
    return [{
      ...match,
      rank: 0,
      text: redacted,
      approxTokens: estimateKnowledgeTokens(redacted),
      attachmentName: index.attachmentName,
      snapshotId: pin.snapshotId,
      indexDigest: pin.indexDigest,
      providerId: pin.providerId,
      model: pin.model,
      providerConfigurationDigest: pin.providerConfigurationDigest,
    }];
  }).map((match, index) => ({ ...match, rank: index + 1 }));
  const finalPack = packKnowledgeRetrievalMatches({
    matches: redactedMatches,
    ...(effectiveTopK !== undefined ? { topK: effectiveTopK } : {}),
    ...(effectiveMaxPromptTokens !== undefined
      ? { maxPromptTokens: effectiveMaxPromptTokens }
      : {}),
  });
  return {
    ...result,
    matches: finalPack.matches,
    selectedCount: finalPack.matches.length,
    truncatedCount:
      result.truncatedCount + omittedSensitiveMatches + finalPack.truncatedCount,
    approxTokens: finalPack.approxTokens,
    queryDigest: await queryFingerprint(paths, safeQuery),
    degradedAttachmentIds,
  };
}

export async function detachKnowledgeRepository(
  input: KnowledgeRepositoryItemInput,
): Promise<KnowledgeRepositoryAttachment> {
  const paths = await servicePaths(input);
  // Registry/status relation is removed. Immutable indexes and mirrors are retained
  // so in-flight snapshot pins remain readable; later GC may reclaim unreferenced data.
  return await detachStoredKnowledgeRepository(paths, input.attachmentId);
}
