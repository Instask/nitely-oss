import { join } from "node:path";

import { redactText } from "../context/redaction.js";
import { resolveProviderStore } from "../providers/index.js";
import type {
  CreateKnowledgeRepositoryAttachmentInput,
  KnowledgeRepositoryRef,
  KnowledgeRepositorySource,
  KnowledgeRetrievalConfiguration,
} from "./schema.js";
import {
  attachKnowledgeRepository,
  detachKnowledgeRepository,
  getKnowledgeRepositoryStatus,
  listKnowledgeRepositories,
  queryKnowledgeRepositories,
  refreshKnowledgeRepository,
} from "./service.js";

export interface KnowledgeRepositoryCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface KnowledgeRepositoryCliBaseInput {
  targetRepoPath: string;
  runtimeRoot?: string;
}

export interface KnowledgeRepositoryCliAttachmentInput
  extends KnowledgeRepositoryCliBaseInput {
  attachment: CreateKnowledgeRepositoryAttachmentInput;
}

export interface KnowledgeRepositoryCliItemInput
  extends KnowledgeRepositoryCliBaseInput {
  attachmentId: string;
}

export interface KnowledgeRepositoryCliQueryInput
  extends KnowledgeRepositoryCliBaseInput {
  query: string;
  attachmentIds?: string[];
  topK?: number;
  maxPromptTokens?: number;
}

export interface KnowledgeRepositoryCliService {
  attach(input: KnowledgeRepositoryCliAttachmentInput): Promise<unknown>;
  list(input: KnowledgeRepositoryCliBaseInput): Promise<unknown>;
  status(input: KnowledgeRepositoryCliItemInput): Promise<unknown>;
  refresh(input: KnowledgeRepositoryCliItemInput): Promise<unknown>;
  query(input: KnowledgeRepositoryCliQueryInput): Promise<unknown>;
  detach(input: KnowledgeRepositoryCliItemInput): Promise<unknown>;
}

function productionServiceDependencies(
  input: KnowledgeRepositoryCliBaseInput,
) {
  return {
    providerStore: resolveProviderStore(
      join(input.targetRepoPath, ".nitely"),
      process.env,
    ),
  };
}

/** Production adapter. Tests and embedders can override it through CliDependencies. */
export const defaultKnowledgeRepositoryCliService: KnowledgeRepositoryCliService = {
  attach: async (input) =>
    await attachKnowledgeRepository(input, productionServiceDependencies(input)),
  list: async (input) => await listKnowledgeRepositories(input),
  status: async (input) => await getKnowledgeRepositoryStatus(input),
  refresh: async (input) =>
    await refreshKnowledgeRepository(input, productionServiceDependencies(input)),
  query: async (input) =>
    await queryKnowledgeRepositories(input, productionServiceDependencies(input)),
  detach: async (input) => await detachKnowledgeRepository(input),
};

type KnowledgeRepositoryAction =
  | "attach"
  | "list"
  | "status"
  | "refresh"
  | "query"
  | "detach";

interface CommonOptions {
  targetRepoPath: string;
  runtimeRoot?: string;
  json: boolean;
}

const KNOWLEDGE_REPOSITORY_USAGE =
  "Usage: nitely knowledge-repo attach|list|status|refresh|query|detach [options]";
const ATTACH_OPTIONS_WITH_VALUES = new Set([
  "--repo",
  "--runtime-root",
  "--id",
  "--name",
  "--source",
  "--ref",
  "--ref-type",
  "--include",
  "--exclude",
  "--embedding-provider",
  "--embedding-model",
]);

function optionValue(
  argv: string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return { value, nextIndex: index + 1 };
}

function positiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function baseInput(options: CommonOptions): KnowledgeRepositoryCliBaseInput {
  return {
    targetRepoPath: options.targetRepoPath,
    ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
  };
}

function parseSource(value: string): KnowledgeRepositorySource {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { type: "remote", providerId: "github", url: value };
  }
  return { type: "local", path: value };
}

function parseRef(
  value: string,
  explicitType?: KnowledgeRepositoryRef["type"],
): KnowledgeRepositoryRef {
  if (explicitType) return { type: explicitType, value };
  const prefixed = /^(branch|tag|commit):(.*)$/.exec(value);
  if (prefixed) {
    return {
      type: prefixed[1] as KnowledgeRepositoryRef["type"],
      value: prefixed[2] ?? "",
    };
  }
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    return { type: "commit", value };
  }
  return { type: "branch", value };
}

function parseEmbeddingProvider(
  value: string,
): KnowledgeRetrievalConfiguration["providerId"] {
  if (
    value !== "local-hash" &&
    value !== "ollama" &&
    value !== "openai-compatible"
  ) {
    throw new Error(
      "--embedding-provider must be local-hash, ollama, or openai-compatible",
    );
  }
  return value;
}

function requireService(
  service: KnowledgeRepositoryCliService | undefined,
): KnowledgeRepositoryCliService {
  if (!service) {
    throw new Error("Knowledge repository service is unavailable");
  }
  return service;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resultAttachmentId(result: unknown, fallback: string): string {
  const record = recordValue(result);
  const attachment = recordValue(record?.attachment);
  return stringValue(record?.attachmentId) ??
    stringValue(record?.id) ??
    stringValue(attachment?.id) ??
    fallback;
}

function resultState(result: unknown): string | undefined {
  const record = recordValue(result);
  const status = recordValue(record?.status);
  return stringValue(record?.state) ?? stringValue(status?.state);
}

function listItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = recordValue(result);
  return Array.isArray(record?.attachments) ? record.attachments : [];
}

function queryMatches(result: unknown): unknown[] {
  const record = recordValue(result);
  return Array.isArray(record?.matches) ? record.matches : [];
}

function publicCliJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicCliJson);
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "indexPath" && key !== "mirrorPath")
      .filter(
        ([key]) =>
          !(record.type === "local" && key === "path"),
      )
      .map(([key, entry]) => [key, publicCliJson(entry)]),
  );
}

function printJson(io: KnowledgeRepositoryCliIo, result: unknown): void {
  io.stdout(JSON.stringify(publicCliJson(result), null, 2) ?? "null");
}

function printHumanResult(
  io: KnowledgeRepositoryCliIo,
  action: KnowledgeRepositoryAction,
  result: unknown,
  fallbackAttachmentId = "",
): void {
  if (action === "attach") {
    io.stdout(
      `KNOWLEDGE REPOSITORY ATTACHED: ${resultAttachmentId(result, fallbackAttachmentId)}`,
    );
    return;
  }
  if (action === "list") {
    const items = listItems(result);
    io.stdout(`KNOWLEDGE REPOSITORIES: ${items.length}`);
    for (const item of items) {
      const record = recordValue(item);
      const attachment = recordValue(record?.attachment) ?? record;
      const status = recordValue(record?.status);
      const id = stringValue(attachment?.id) ?? "unknown";
      const name = stringValue(attachment?.name);
      const state = stringValue(status?.state);
      io.stdout(
        `- ${id}${name ? `: ${name}` : ""}${state ? ` [${state}]` : ""}`,
      );
    }
    return;
  }
  if (action === "status") {
    const id = resultAttachmentId(result, fallbackAttachmentId);
    io.stdout(`KNOWLEDGE REPOSITORY STATUS: ${id} ${resultState(result) ?? "unknown"}`);
    return;
  }
  if (action === "refresh") {
    const id = resultAttachmentId(result, fallbackAttachmentId);
    io.stdout(`KNOWLEDGE REPOSITORY REFRESHED: ${id} ${resultState(result) ?? "ready"}`);
    return;
  }
  if (action === "query") {
    const matches = queryMatches(result);
    io.stdout(`KNOWLEDGE QUERY: ${matches.length} match(es)`);
    for (const match of matches) {
      const citation = stringValue(recordValue(match)?.citation);
      if (citation) io.stdout(`- ${citation}`);
    }
    return;
  }
  io.stdout(
    `KNOWLEDGE REPOSITORY DETACHED: ${resultAttachmentId(result, fallbackAttachmentId)}`,
  );
}

function ensureRepoPath(options: CommonOptions): void {
  if (!options.targetRepoPath) throw new Error("Missing value for --repo");
}

async function runAttach(
  argv: string[],
  io: KnowledgeRepositoryCliIo,
  service: KnowledgeRepositoryCliService | undefined,
): Promise<number> {
  const common: CommonOptions = { targetRepoPath: ".", json: false };
  let id = "";
  let name = "";
  let source = "";
  let ref = "";
  let refType: KnowledgeRepositoryRef["type"] | undefined;
  const include: string[] = [];
  const exclude: string[] = [];
  let required = false;
  let embeddingProvider: KnowledgeRetrievalConfiguration["providerId"] | undefined;
  let embeddingModel = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      common.json = true;
      continue;
    }
    if (arg === "--required") {
      required = true;
      continue;
    }
    if (!arg || !ATTACH_OPTIONS_WITH_VALUES.has(arg)) {
      throw new Error(`Unknown knowledge-repo attach option: ${arg ?? ""}`);
    }
    const parsed = optionValue(argv, index, arg);
    index = parsed.nextIndex;
    if (arg === "--repo") common.targetRepoPath = parsed.value;
    else if (arg === "--runtime-root") common.runtimeRoot = parsed.value;
    else if (arg === "--id") id = parsed.value;
    else if (arg === "--name") name = parsed.value;
    else if (arg === "--source") source = parsed.value;
    else if (arg === "--ref") ref = parsed.value;
    else if (arg === "--include") include.push(parsed.value);
    else if (arg === "--exclude") exclude.push(parsed.value);
    else if (arg === "--embedding-provider") {
      embeddingProvider = parseEmbeddingProvider(parsed.value);
    } else if (arg === "--embedding-model") embeddingModel = parsed.value;
    else if (arg === "--ref-type") {
      if (
        parsed.value !== "branch" &&
        parsed.value !== "tag" &&
        parsed.value !== "commit"
      ) {
        throw new Error("--ref-type must be branch, tag, or commit");
      }
      refType = parsed.value;
    }
  }

  ensureRepoPath(common);
  if (!id) throw new Error("Missing --id");
  if (!name) throw new Error("Missing --name");
  if (!source) throw new Error("Missing --source");
  if (!ref) throw new Error("Missing --ref");

  const attachment: CreateKnowledgeRepositoryAttachmentInput = {
    id,
    name,
    source: parseSource(source),
    ref: parseRef(ref, refType),
    ...(include.length > 0 || exclude.length > 0
      ? { paths: { include, exclude } }
      : {}),
    ...(required ? { required: true } : {}),
    ...(embeddingProvider || embeddingModel
      ? {
          retrieval: {
            ...(embeddingProvider ? { providerId: embeddingProvider } : {}),
            ...(embeddingModel ? { model: embeddingModel } : {}),
          },
        }
      : {}),
  };
  const result = await requireService(service).attach({
    ...baseInput(common),
    attachment,
  });
  if (common.json) printJson(io, result);
  else printHumanResult(io, "attach", result, id);
  return 0;
}

function parseItemOptions(argv: string[], action: "status" | "refresh" | "detach") {
  const common: CommonOptions = { targetRepoPath: ".", json: false };
  let id = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      common.json = true;
      continue;
    }
    if (arg === "--repo" || arg === "--runtime-root" || arg === "--id") {
      const parsed = optionValue(argv, index, arg);
      index = parsed.nextIndex;
      if (arg === "--repo") common.targetRepoPath = parsed.value;
      else if (arg === "--runtime-root") common.runtimeRoot = parsed.value;
      else id = parsed.value;
      continue;
    }
    if (arg && !arg.startsWith("--") && !id) {
      id = arg;
      continue;
    }
    throw new Error(`Unknown knowledge-repo ${action} option: ${arg ?? ""}`);
  }
  ensureRepoPath(common);
  if (!id) throw new Error("Missing --id");
  return { common, id };
}

async function runItemAction(
  action: "status" | "refresh" | "detach",
  argv: string[],
  io: KnowledgeRepositoryCliIo,
  service: KnowledgeRepositoryCliService | undefined,
): Promise<number> {
  const { common, id } = parseItemOptions(argv, action);
  const input = { ...baseInput(common), attachmentId: id };
  const target = requireService(service);
  const result = action === "status"
    ? await target.status(input)
    : action === "refresh"
      ? await target.refresh(input)
      : await target.detach(input);
  if (common.json) printJson(io, result);
  else printHumanResult(io, action, result, id);
  return 0;
}

async function runList(
  argv: string[],
  io: KnowledgeRepositoryCliIo,
  service: KnowledgeRepositoryCliService | undefined,
): Promise<number> {
  const common: CommonOptions = { targetRepoPath: ".", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      common.json = true;
      continue;
    }
    if (arg === "--repo" || arg === "--runtime-root") {
      const parsed = optionValue(argv, index, arg);
      index = parsed.nextIndex;
      if (arg === "--repo") common.targetRepoPath = parsed.value;
      else common.runtimeRoot = parsed.value;
      continue;
    }
    throw new Error(`Unknown knowledge-repo list option: ${arg ?? ""}`);
  }
  ensureRepoPath(common);
  const result = await requireService(service).list(baseInput(common));
  if (common.json) printJson(io, result);
  else printHumanResult(io, "list", result);
  return 0;
}

async function runQuery(
  argv: string[],
  io: KnowledgeRepositoryCliIo,
  service: KnowledgeRepositoryCliService | undefined,
): Promise<number> {
  const common: CommonOptions = { targetRepoPath: ".", json: false };
  let query = "";
  const attachmentIds: string[] = [];
  let topK: number | undefined;
  let maxPromptTokens: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      common.json = true;
      continue;
    }
    if (
      arg === "--repo" ||
      arg === "--runtime-root" ||
      arg === "--query" ||
      arg === "--attachment" ||
      arg === "--id" ||
      arg === "--limit" ||
      arg === "--max-prompt-tokens"
    ) {
      const parsed = optionValue(argv, index, arg);
      index = parsed.nextIndex;
      if (arg === "--repo") common.targetRepoPath = parsed.value;
      else if (arg === "--runtime-root") common.runtimeRoot = parsed.value;
      else if (arg === "--query") query = parsed.value;
      else if (arg === "--attachment" || arg === "--id") {
        attachmentIds.push(parsed.value);
      } else if (arg === "--limit") {
        topK = positiveInteger("--limit", parsed.value);
      } else {
        maxPromptTokens = positiveInteger("--max-prompt-tokens", parsed.value);
      }
      continue;
    }
    if (arg && !arg.startsWith("--") && !query) {
      query = arg;
      continue;
    }
    throw new Error(`Unknown knowledge-repo query option: ${arg ?? ""}`);
  }
  ensureRepoPath(common);
  if (!query) throw new Error("Missing --query");
  const result = await requireService(service).query({
    ...baseInput(common),
    query,
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(topK ? { topK } : {}),
    ...(maxPromptTokens ? { maxPromptTokens } : {}),
  });
  if (common.json) printJson(io, result);
  else printHumanResult(io, "query", result);
  return 0;
}

export async function runKnowledgeRepositoryCli(
  argv: string[],
  io: KnowledgeRepositoryCliIo,
  service?: KnowledgeRepositoryCliService,
): Promise<number> {
  service ??= defaultKnowledgeRepositoryCliService;
  const action = argv[0];
  if (
    action !== "attach" &&
    action !== "list" &&
    action !== "status" &&
    action !== "refresh" &&
    action !== "query" &&
    action !== "detach"
  ) {
    io.stderr(KNOWLEDGE_REPOSITORY_USAGE);
    return 1;
  }

  try {
    if (action === "attach") {
      return await runAttach(argv.slice(1), io, service);
    }
    if (action === "list") {
      return await runList(argv.slice(1), io, service);
    }
    if (action === "query") {
      return await runQuery(argv.slice(1), io, service);
    }
    return await runItemAction(action, argv.slice(1), io, service);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(redactText(message) ?? "Knowledge repository command failed");
    return 1;
  }
}
