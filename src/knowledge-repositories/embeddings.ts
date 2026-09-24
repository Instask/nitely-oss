import { createHash } from "node:crypto";

import { tokenizeKnowledgeText } from "./tokenize.js";

export const KNOWLEDGE_EMBEDDING_PROVIDER_VERSION = "nitely.knowledge-embeddings.v1";

const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_EMBEDDING_DIMENSIONS = 8_192;

export interface KnowledgeEmbeddingProviderIdentity {
  id: string;
  model: string;
  version: string;
  /** Non-secret identity of the endpoint/configuration that defines the vector space. */
  configurationDigest: string;
  dimensions?: number;
  /** False means vector similarity is lexical feature hashing, not semantics. */
  semantic: boolean;
}

export interface KnowledgeEmbeddingProvider {
  readonly identity: KnowledgeEmbeddingProviderIdentity;
  embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface EmbeddingRequestLimits {
  maxBatchSize?: number;
  maxTextBytes?: number;
  maxBatchBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

interface ResolvedEmbeddingRequestLimits {
  maxBatchSize: number;
  maxTextBytes: number;
  maxBatchBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function configurationDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error(`invalid knowledge embedding ${field}`);
  }
  return selected;
}

function resolveLimits(input: EmbeddingRequestLimits): ResolvedEmbeddingRequestLimits {
  return {
    maxBatchSize: boundedInteger(input.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, "maxBatchSize", 1_024),
    maxTextBytes: boundedInteger(input.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, "maxTextBytes", 8 * 1024 * 1024),
    maxBatchBytes: boundedInteger(input.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES, "maxBatchBytes", 64 * 1024 * 1024),
    maxResponseBytes: boundedInteger(input.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes", 64 * 1024 * 1024),
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 5 * 60_000),
  };
}

function assertTexts(
  texts: readonly string[],
  limits: ResolvedEmbeddingRequestLimits,
): void {
  if (texts.length === 0) {
    throw new Error("knowledge embedding request requires at least one text");
  }
  if (texts.length > limits.maxBatchSize) {
    throw new Error("knowledge embedding request exceeds the batch-size limit");
  }
  let total = 0;
  for (const text of texts) {
    if (typeof text !== "string") {
      throw new Error("knowledge embedding input must be text");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limits.maxTextBytes) {
      throw new Error("knowledge embedding input exceeds the per-text byte limit");
    }
    total += bytes;
    if (total > limits.maxBatchBytes) {
      throw new Error("knowledge embedding request exceeds the batch byte limit");
    }
  }
}

function normalizedVector(value: unknown, expectedDimensions?: number): Float32Array {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error("knowledge embedding vector must be an array of finite numbers");
  }
  const numbers = Array.from(value as ArrayLike<unknown>);
  if (
    numbers.length === 0 ||
    numbers.length > MAX_EMBEDDING_DIMENSIONS ||
    (expectedDimensions !== undefined && numbers.length !== expectedDimensions)
  ) {
    throw new Error("knowledge embedding response has inconsistent dimensions");
  }
  let magnitudeSquared = 0;
  const vector = new Float32Array(numbers.length);
  for (let index = 0; index < numbers.length; index += 1) {
    const item = numbers[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error("knowledge embedding response must contain finite numbers");
    }
    vector[index] = item;
    magnitudeSquared += item * item;
  }
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
    throw new Error("knowledge embedding response contains a zero or invalid vector");
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! / magnitude;
  }
  return vector;
}

function normalizeVectors(values: unknown, expectedCount: number): Float32Array[] {
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw new Error("knowledge embedding response count does not match the request");
  }
  const vectors: Float32Array[] = [];
  let dimensions: number | undefined;
  for (const value of values) {
    const vector = normalizedVector(value, dimensions);
    dimensions = vector.length;
    vectors.push(vector);
  }
  return vectors;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new Error("knowledge embedding provider returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("knowledge embedding response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("byte limit")) throw error;
    throw new Error("knowledge embedding provider returned invalid JSON");
  }
}

async function postJson(input: {
  fetch: Fetch;
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  limits: ResolvedEmbeddingRequestLimits;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.limits.timeoutMs);
  try {
    const response = await input.fetch(input.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...input.headers,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`knowledge embedding provider request failed with status ${response.status}`);
    }
    return await readBoundedJson(response, input.limits.maxResponseBytes);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("knowledge embedding provider request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function providerModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || /\p{Cc}/u.test(model)) {
    throw new Error("invalid knowledge embedding model");
  }
  return model;
}

export interface LocalHashEmbeddingProviderOptions {
  dimensions?: number;
  model?: string;
}

/** Deterministic feature hashing. This is explicitly not a semantic model. */
export class LocalHashEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly identity: KnowledgeEmbeddingProviderIdentity;

  constructor(options: LocalHashEmbeddingProviderOptions = {}) {
    const dimensions = boundedInteger(options.dimensions, 384, "dimensions", MAX_EMBEDDING_DIMENSIONS);
    this.identity = {
      id: "local-hash",
      model: providerModel(options.model ?? "unicode-hash-v1"),
      version: KNOWLEDGE_EMBEDDING_PROVIDER_VERSION,
      configurationDigest: configurationDigest(
        `local-hash\0${options.model ?? "unicode-hash-v1"}\0${dimensions}`,
      ),
      dimensions,
      semantic: false,
    };
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  private embed(text: string): Float32Array {
    const dimensions = this.identity.dimensions!;
    const vector = new Float32Array(dimensions);
    for (const token of tokenizeKnowledgeText(text)) {
      const digest = createHash("sha256").update(token, "utf8").digest();
      const bucket = digest.readUInt32BE(0) % dimensions;
      const sign = (digest[4]! & 1) === 0 ? 1 : -1;
      vector[bucket] = vector[bucket]! + sign;
    }
    let magnitudeSquared = 0;
    for (const value of vector) magnitudeSquared += value * value;
    if (magnitudeSquared === 0) return vector;
    const magnitude = Math.sqrt(magnitudeSquared);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = vector[index]! / magnitude;
    }
    return vector;
  }
}

export interface OllamaEmbeddingProviderOptions extends EmbeddingRequestLimits {
  /** Dependency/env-resolved endpoint. Attachment documents must not supply it. */
  baseUrl: string;
  model: string;
  fetch?: Fetch;
}

function ollamaBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid Ollama embedding base URL");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" ||
    host === "[::1]" || host === "::1";
  if (
    !loopback ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Ollama embedding base URL must be a credential-free loopback URL");
  }
  return url.toString().replace(/\/$/u, "");
}

export class OllamaEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly identity: KnowledgeEmbeddingProviderIdentity;
  readonly #url: string;
  readonly #fetch: Fetch;
  readonly #limits: ResolvedEmbeddingRequestLimits;

  constructor(options: OllamaEmbeddingProviderOptions) {
    const baseUrl = ollamaBaseUrl(options.baseUrl);
    const model = providerModel(options.model);
    this.#url = `${baseUrl}/api/embed`;
    this.#fetch = options.fetch ?? fetch;
    this.#limits = resolveLimits(options);
    this.identity = {
      id: "ollama",
      model,
      version: KNOWLEDGE_EMBEDDING_PROVIDER_VERSION,
      configurationDigest: configurationDigest(`ollama\0${baseUrl}\0${model}`),
      semantic: true,
    };
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return await this.embed(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.embed([text]))[0]!;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    assertTexts(texts, this.#limits);
    const payload = await postJson({
      fetch: this.#fetch,
      url: this.#url,
      body: { model: this.identity.model, input: [...texts] },
      limits: this.#limits,
    }) as { embeddings?: unknown };
    return normalizeVectors(payload?.embeddings, texts.length);
  }
}

export interface OpenAICompatibleEmbeddingProviderOptions extends EmbeddingRequestLimits {
  model: string;
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
}

function openAICompatibleUrl(env: Record<string, string | undefined>): string {
  const raw = env.NITELY_EMBEDDINGS_BASE_URL?.trim();
  if (!raw) {
    throw new Error("NITELY_EMBEDDINGS_BASE_URL is required for OpenAI-compatible embeddings");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid OpenAI-compatible embedding base URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("OpenAI-compatible embedding base URL must use credential-free HTTPS");
  }
  const allowedHosts = new Set(
    (env.NITELY_EMBEDDINGS_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error("OpenAI-compatible embedding host is not in NITELY_EMBEDDINGS_ALLOWED_HOSTS allowlist");
  }
  const base = url.toString().replace(/\/$/u, "");
  return `${base}/embeddings`;
}

export class OpenAICompatibleEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly identity: KnowledgeEmbeddingProviderIdentity;
  readonly #url: string;
  readonly #apiKey?: string;
  readonly #fetch: Fetch;
  readonly #limits: ResolvedEmbeddingRequestLimits;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
    const env = options.env ?? process.env;
    const model = providerModel(options.model);
    this.#url = openAICompatibleUrl(env);
    this.#apiKey = env.NITELY_EMBEDDINGS_API_KEY;
    this.#fetch = options.fetch ?? fetch;
    this.#limits = resolveLimits(options);
    this.identity = {
      id: "openai-compatible",
      model,
      version: KNOWLEDGE_EMBEDDING_PROVIDER_VERSION,
      configurationDigest: configurationDigest(
        `openai-compatible\0${this.#url}\0${model}`,
      ),
      semantic: true,
    };
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return await this.embed(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.embed([text]))[0]!;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    assertTexts(texts, this.#limits);
    const payload = await postJson({
      fetch: this.#fetch,
      url: this.#url,
      body: { model: this.identity.model, input: [...texts] },
      ...(this.#apiKey
        ? { headers: { authorization: `Bearer ${this.#apiKey}` } }
        : {}),
      limits: this.#limits,
    }) as { data?: unknown };
    if (!Array.isArray(payload?.data) || payload.data.length !== texts.length) {
      throw new Error("knowledge embedding response count does not match the request");
    }
    const ordered: unknown[] = new Array(texts.length);
    for (const entry of payload.data) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("knowledge embedding response contains an invalid data entry");
      }
      const index = (entry as { index?: unknown }).index;
      const embedding = (entry as { embedding?: unknown }).embedding;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= texts.length) {
        throw new Error("knowledge embedding response contains an invalid index");
      }
      if (ordered[index as number] !== undefined) {
        throw new Error("knowledge embedding response contains a duplicate index");
      }
      ordered[index as number] = embedding;
    }
    if (ordered.some((entry) => entry === undefined)) {
      throw new Error("knowledge embedding response is missing an index");
    }
    return normalizeVectors(ordered, texts.length);
  }
}

export function knowledgeEmbeddingProviderKey(
  identity: KnowledgeEmbeddingProviderIdentity,
): string {
  return [
    identity.id,
    identity.model,
    identity.version,
    identity.configurationDigest,
    identity.dimensions ?? "unknown",
    identity.semantic ? "semantic" : "non-semantic",
  ].join("\0");
}
