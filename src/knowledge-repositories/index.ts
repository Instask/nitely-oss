import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingProviderIdentity,
} from "./embeddings.js";
import {
  KNOWLEDGE_INDEX_VERSION,
  normalizeKnowledgeAttachmentId,
  type KnowledgeChunk,
  type KnowledgeIndex,
} from "./schema.js";
import {
  KNOWLEDGE_TOKENIZER_VERSION,
  normalizeKnowledgeText,
  tokenizeKnowledgeText,
} from "./tokenize.js";

const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const CONTENT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_EMBEDDING_DIMENSIONS = 8_192;
const EMBEDDING_BATCH_SIZE = 64;

export const KNOWLEDGE_INDEX_FORMAT_VERSION = "nitely.knowledge-index.v1";

export interface KnowledgeLexicalDocument {
  length: number;
  termFrequency: Record<string, number>;
}

export interface KnowledgeLexicalIndex {
  tokenizerVersion: string;
  documentCount: number;
  averageDocumentLength: number;
  documentFrequency: Record<string, number>;
  documents: Record<string, KnowledgeLexicalDocument>;
}

export interface KnowledgeIndexEmbedding extends KnowledgeEmbeddingProviderIdentity {
  dimensions: number;
}

export interface KnowledgeIndexedChunk extends KnowledgeChunk {
  tokenCount: number;
  termFrequency: Record<string, number>;
  vector?: number[];
}

/**
 * JSON-serializable immutable index artifact. The top-level lexical fields are
 * retained as convenient summaries while `lexical` is the canonical persisted
 * representation understood by retrieval.
 */
export interface KnowledgeIndexArtifact extends Omit<KnowledgeIndex, "chunks" | "lexical"> {
  chunks: KnowledgeIndexedChunk[];
  lexical: KnowledgeLexicalIndex;
  embedding?: KnowledgeIndexEmbedding;
  indexDigest: string;
  documentCount: number;
  averageDocumentLength: number;
  documentFrequency: Record<string, number>;
}

export interface BuildKnowledgeIndexInput {
  attachmentId: string;
  attachmentName?: string;
  commitSha: string;
  policyFingerprint: string;
  chunks: readonly KnowledgeChunk[];
  embeddingProvider?: KnowledgeEmbeddingProvider;
  createdAt?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCommitSha(value: string): string {
  const commitSha = value.toLowerCase();
  if (!GIT_OBJECT_ID_PATTERN.test(commitSha)) {
    throw new Error("knowledge index commit must be a full Git object id");
  }
  return commitSha;
}

function safeRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new Error("knowledge index chunk path must be repository-relative");
  }
  const normalized = posix.normalize(value.replace(/^\.\//u, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("knowledge index chunk path escapes the repository");
  }
  return normalized;
}

function validTimestamp(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error("knowledge index createdAt must be a canonical ISO timestamp");
  }
  return value;
}

function sortedRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...values].sort(([left], [right]) => compareText(left, right)));
}

function lexicalDocument(text: string): KnowledgeLexicalDocument {
  const tokens = tokenizeKnowledgeText(text);
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return {
    length: tokens.length,
    termFrequency: sortedRecord(frequencies),
  };
}

function compareChunks(left: KnowledgeChunk, right: KnowledgeChunk): number {
  return compareText(left.path, right.path) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    compareText(left.id, right.id);
}

function validateChunk(
  chunk: KnowledgeChunk,
  attachmentId: string,
  commitSha: string,
): KnowledgeChunk {
  if (!/^kbc-[a-f0-9]{64}$/u.test(chunk.id)) {
    throw new Error("knowledge index contains an invalid chunk id");
  }
  if (chunk.attachmentId !== attachmentId || chunk.commitSha.toLowerCase() !== commitSha) {
    throw new Error("knowledge index chunk identity does not match the index snapshot");
  }
  const path = safeRelativePath(chunk.path);
  if (
    !Number.isSafeInteger(chunk.startLine) ||
    !Number.isSafeInteger(chunk.endLine) ||
    chunk.startLine < 1 ||
    chunk.endLine < chunk.startLine
  ) {
    throw new Error("knowledge index contains invalid chunk line bounds");
  }
  if (!chunk.text.trim()) {
    throw new Error("knowledge index cannot contain an empty chunk");
  }
  const contentDigest = `sha256:${sha256(chunk.text)}`;
  if (!CONTENT_DIGEST_PATTERN.test(chunk.contentDigest) || chunk.contentDigest !== contentDigest) {
    throw new Error("knowledge index chunk content digest is invalid");
  }
  if (!Number.isSafeInteger(chunk.approxTokens) || chunk.approxTokens < 1) {
    throw new Error("knowledge index chunk token estimate is invalid");
  }
  return {
    ...chunk,
    commitSha,
    path,
  };
}

function normalizeEmbeddingVector(
  value: Float32Array,
  expectedDimensions: number | undefined,
  semantic: boolean,
): number[] {
  if (
    !(value instanceof Float32Array) ||
    value.length === 0 ||
    value.length > MAX_EMBEDDING_DIMENSIONS ||
    (expectedDimensions !== undefined && value.length !== expectedDimensions)
  ) {
    throw new Error("knowledge index embedding dimensions are inconsistent");
  }
  let magnitudeSquared = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) {
      throw new Error("knowledge index embeddings must contain finite numbers");
    }
    magnitudeSquared += component * component;
  }
  if (!Number.isFinite(magnitudeSquared) || (semantic && magnitudeSquared <= 0)) {
    throw new Error("knowledge index embedding vector is invalid");
  }
  if (magnitudeSquared === 0) return Array.from(value);
  const magnitude = Math.sqrt(magnitudeSquared);
  return Array.from(value, (component) => component / magnitude);
}

function validateProviderIdentity(
  identity: KnowledgeEmbeddingProviderIdentity,
): KnowledgeEmbeddingProviderIdentity {
  if (
    !identity.id.trim() ||
    !identity.model.trim() ||
    !identity.version.trim() ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.configurationDigest) ||
    /\p{Cc}/u.test(identity.id + identity.model + identity.version)
  ) {
    throw new Error("knowledge index embedding provider identity is invalid");
  }
  if (
    identity.dimensions !== undefined &&
    (!Number.isSafeInteger(identity.dimensions) ||
      identity.dimensions < 1 ||
      identity.dimensions > MAX_EMBEDDING_DIMENSIONS)
  ) {
    throw new Error("knowledge index embedding provider dimensions are invalid");
  }
  return identity;
}

function indexDigestDocument(index: Omit<
  KnowledgeIndexArtifact,
  "createdAt" | "indexDigest" | "documentCount" | "averageDocumentLength" |
    "documentFrequency"
>): unknown {
  return {
    format: KNOWLEDGE_INDEX_FORMAT_VERSION,
    version: index.version,
    attachmentId: index.attachmentId,
    ...(index.attachmentName ? { attachmentName: index.attachmentName } : {}),
    commitSha: index.commitSha,
    policyFingerprint: index.policyFingerprint,
    providerId: index.providerId,
    model: index.model,
    dimension: index.dimension,
    chunks: index.chunks,
    lexical: index.lexical,
    ...(index.vectors ? { vectors: index.vectors } : {}),
    ...(index.embedding ? { embedding: index.embedding } : {}),
  };
}

/** Recompute the content-addressed identity of a serialized index artifact. */
export function knowledgeIndexDigest(index: KnowledgeIndexArtifact): string {
  return `sha256:${sha256(canonicalJson(indexDigestDocument(index)))}`;
}

/** Fail closed when an immutable index body no longer matches its identity. */
export function assertKnowledgeIndexIntegrity(index: KnowledgeIndexArtifact): void {
  if (
    index.version !== KNOWLEDGE_INDEX_VERSION ||
    !CONTENT_DIGEST_PATTERN.test(index.indexDigest) ||
    knowledgeIndexDigest(index) !== index.indexDigest
  ) {
    throw new Error("knowledge index digest does not match its immutable contents");
  }
}

/** Build deterministic lexical metadata and optional provider-backed vectors. */
export async function buildKnowledgeIndex(
  input: BuildKnowledgeIndexInput,
): Promise<KnowledgeIndexArtifact> {
  const attachmentId = normalizeKnowledgeAttachmentId(input.attachmentId);
  const commitSha = normalizeCommitSha(input.commitSha);
  const policyFingerprint = input.policyFingerprint.trim();
  if (!policyFingerprint || policyFingerprint.length > 256 || /\p{Cc}/u.test(policyFingerprint)) {
    throw new Error("knowledge index policy fingerprint is invalid");
  }
  const createdAt = validTimestamp(input.createdAt);
  const seenChunkIds = new Set<string>();
  const orderedChunks = input.chunks
    .map((chunk) => validateChunk(chunk, attachmentId, commitSha))
    .sort(compareChunks);
  for (const chunk of orderedChunks) {
    if (seenChunkIds.has(chunk.id)) {
      throw new Error("knowledge index contains a duplicate chunk id");
    }
    seenChunkIds.add(chunk.id);
  }

  const documents = new Map<string, KnowledgeLexicalDocument>();
  const documentFrequency = new Map<string, number>();
  let totalDocumentLength = 0;
  for (const chunk of orderedChunks) {
    const document = lexicalDocument(chunk.text);
    documents.set(chunk.id, document);
    totalDocumentLength += document.length;
    for (const term of Object.keys(document.termFrequency)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const documentCount = orderedChunks.length;
  const averageDocumentLength = documentCount === 0
    ? 0
    : totalDocumentLength / documentCount;
  const lexical: KnowledgeLexicalIndex = {
    tokenizerVersion: KNOWLEDGE_TOKENIZER_VERSION,
    documentCount,
    averageDocumentLength,
    documentFrequency: sortedRecord(documentFrequency),
    documents: Object.fromEntries(
      [...documents]
        .sort(([left], [right]) => compareText(left, right))
        .map(([id, document]) => [id, document]),
    ),
  };

  const provider = input.embeddingProvider;
  let vectors: number[][] | undefined;
  let embedding: KnowledgeIndexEmbedding | undefined;
  if (provider && orderedChunks.length > 0) {
    const identity = validateProviderIdentity(provider.identity);
    const generated: Float32Array[] = [];
    for (let start = 0; start < orderedChunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = orderedChunks
        .slice(start, start + EMBEDDING_BATCH_SIZE)
        .map((chunk) => normalizeKnowledgeText(chunk.text));
      generated.push(...await provider.embedDocuments(batch));
    }
    if (generated.length !== orderedChunks.length) {
      throw new Error("knowledge index embedding count does not match its chunks");
    }
    let dimensions = identity.dimensions;
    vectors = generated.map((vector) => {
      const normalized = normalizeEmbeddingVector(vector, dimensions, identity.semantic);
      dimensions ??= normalized.length;
      return normalized;
    });
    embedding = {
      ...identity,
      dimensions: dimensions!,
    };
  } else if (provider) {
    const identity = validateProviderIdentity(provider.identity);
    if (identity.dimensions !== undefined) {
      embedding = { ...identity, dimensions: identity.dimensions };
    }
  }

  const indexedChunks: KnowledgeIndexedChunk[] = orderedChunks.map((chunk, index) => {
    const document = documents.get(chunk.id)!;
    const vector = vectors?.[index];
    return {
      ...chunk,
      tokenCount: document.length,
      termFrequency: document.termFrequency,
      ...(vector ? { vector } : {}),
    };
  });
  const providerId = provider?.identity.id ?? "none";
  const model = provider?.identity.model ?? "none";
  const dimension = embedding?.dimensions ?? 0;
  const artifactWithoutDigest = {
    version: KNOWLEDGE_INDEX_VERSION,
    attachmentId,
    ...(input.attachmentName ? { attachmentName: input.attachmentName } : {}),
    commitSha,
    policyFingerprint,
    providerId,
    model,
    dimension,
    chunks: indexedChunks,
    lexical,
    ...(vectors ? { vectors } : {}),
    ...(embedding ? { embedding } : {}),
  } satisfies Omit<
    KnowledgeIndexArtifact,
    "createdAt" | "indexDigest" | "documentCount" | "averageDocumentLength" |
      "documentFrequency"
  >;
  const indexDigest = `sha256:${sha256(canonicalJson(indexDigestDocument(artifactWithoutDigest)))}`;

  return {
    ...artifactWithoutDigest,
    createdAt,
    indexDigest,
    documentCount,
    averageDocumentLength,
    documentFrequency: lexical.documentFrequency,
  };
}
