import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CONTEXT_KNOWLEDGE_CATEGORIES = [
  "pitfalls",
  "conventions",
  "modules",
  "domains",
  "decisions",
  "feedback",
] as const;

export type ContextKnowledgeCategory =
  (typeof CONTEXT_KNOWLEDGE_CATEGORIES)[number];

export type ContextKnowledgeStatus = "approved" | "proposed" | "rejected";

export interface ContextKnowledgeSource {
  type: "operator" | "reflection" | "review" | "run" | "import";
  uri?: string;
  runId?: string;
  taskId?: string;
}

export interface ContextKnowledgeEntry {
  id: string;
  category: ContextKnowledgeCategory;
  title: string;
  body: string;
  status: ContextKnowledgeStatus;
  tags: string[];
  keywords: string[];
  source?: ContextKnowledgeSource;
  linkedRunIds: string[];
  linkedTaskIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContextKnowledgeEntryInput {
  category: ContextKnowledgeCategory;
  title: string;
  body: string;
  status?: ContextKnowledgeStatus;
  tags?: string[];
  keywords?: string[];
  source?: ContextKnowledgeSource;
}

export interface UpdateContextKnowledgeEntryInput {
  category?: ContextKnowledgeCategory;
  title?: string;
  body?: string;
  status?: ContextKnowledgeStatus;
  tags?: string[];
  keywords?: string[];
  source?: ContextKnowledgeSource;
}

export interface ContextKnowledgeSelectionInput {
  repoPath: string;
  query: string[];
  maxEntries?: number;
}

interface ContextKnowledgeFile {
  version: 1;
  entries: ContextKnowledgeEntry[];
}

interface StoreOptions {
  createId?: () => string;
  now?: () => string;
}

function contextKnowledgePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "context-kg", "entries.json");
}

function now(options?: Pick<StoreOptions, "now">): string {
  return options?.now?.() ?? new Date().toISOString();
}

function normalizeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`context-kg ${field} is required`);
  }
  return normalized;
}

function normalizeStringArray(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function isCategory(value: string): value is ContextKnowledgeCategory {
  return CONTEXT_KNOWLEDGE_CATEGORIES.includes(
    value as ContextKnowledgeCategory,
  );
}

function normalizeCategory(value: string): ContextKnowledgeCategory {
  if (isCategory(value)) return value;
  throw new Error(`invalid context-kg category: ${value}`);
}

function normalizeStatus(value: string | undefined): ContextKnowledgeStatus {
  if (value === undefined) return "approved";
  if (value === "approved" || value === "proposed" || value === "rejected") {
    return value;
  }
  throw new Error(`invalid context-kg status: ${value}`);
}

function normalizeSource(
  source: ContextKnowledgeSource | undefined,
): ContextKnowledgeSource | undefined {
  if (!source) return undefined;
  if (
    source.type !== "operator" &&
    source.type !== "reflection" &&
    source.type !== "review" &&
    source.type !== "run" &&
    source.type !== "import"
  ) {
    throw new Error(`invalid context-kg source type: ${source.type}`);
  }
  return {
    type: source.type,
    ...(source.uri ? { uri: source.uri.trim() } : {}),
    ...(source.runId ? { runId: source.runId.trim() } : {}),
    ...(source.taskId ? { taskId: source.taskId.trim() } : {}),
  };
}

function normalizeEntry(value: ContextKnowledgeEntry): ContextKnowledgeEntry {
  return {
    id: normalizeText(value.id, "id"),
    category: normalizeCategory(value.category),
    title: normalizeText(value.title, "title"),
    body: normalizeText(value.body, "body"),
    status: normalizeStatus(value.status),
    tags: normalizeStringArray(value.tags),
    keywords: normalizeStringArray(value.keywords),
    ...(value.source ? { source: normalizeSource(value.source) } : {}),
    linkedRunIds: normalizeStringArray(value.linkedRunIds),
    linkedTaskIds: normalizeStringArray(value.linkedTaskIds),
    version:
      Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
    createdAt: normalizeText(value.createdAt, "createdAt"),
    updatedAt: normalizeText(value.updatedAt, "updatedAt"),
  };
}

function parseContextKnowledgeFile(value: unknown): ContextKnowledgeFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid context-kg entries file: root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("invalid context-kg entries file: version must be 1");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("invalid context-kg entries file: entries must be an array");
  }
  return {
    version: 1,
    entries: record.entries.map((entry) =>
      normalizeEntry(entry as ContextKnowledgeEntry),
    ),
  };
}

async function readStore(repoPath: string): Promise<ContextKnowledgeFile> {
  try {
    return parseContextKnowledgeFile(
      JSON.parse(await readFile(contextKnowledgePath(repoPath), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

async function writeStore(repoPath: string, store: ContextKnowledgeFile): Promise<void> {
  const path = contextKnowledgePath(repoPath);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function listContextKnowledgeEntries(
  repoPath: string,
): Promise<ContextKnowledgeEntry[]> {
  const store = await readStore(repoPath);
  return store.entries
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
    );
}

export async function createContextKnowledgeEntry(
  repoPath: string,
  input: CreateContextKnowledgeEntryInput,
  options: StoreOptions = {},
): Promise<ContextKnowledgeEntry> {
  const store = await readStore(repoPath);
  const timestamp = now(options);
  const entry = normalizeEntry({
    id: options.createId?.() ?? `ctx-${randomUUID()}`,
    category: input.category,
    title: input.title,
    body: input.body,
    status: normalizeStatus(input.status),
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    ...(input.source ? { source: input.source } : {}),
    linkedRunIds: [],
    linkedTaskIds: [],
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (store.entries.some((candidate) => candidate.id === entry.id)) {
    throw new Error(`context-kg entry already exists: ${entry.id}`);
  }
  store.entries.push(entry);
  await writeStore(repoPath, store);
  return entry;
}

export async function updateContextKnowledgeEntry(
  repoPath: string,
  id: string,
  patch: UpdateContextKnowledgeEntryInput,
  options: Pick<StoreOptions, "now"> = {},
): Promise<ContextKnowledgeEntry> {
  const store = await readStore(repoPath);
  const index = store.entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new Error(`context-kg entry not found: ${id}`);
  }
  const current = store.entries[index]!;
  const updated = normalizeEntry({
    ...current,
    ...(patch.category ? { category: patch.category } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    version: current.version + 1,
    updatedAt: now(options),
  });
  store.entries[index] = updated;
  await writeStore(repoPath, store);
  return updated;
}

function addUnique(values: string[], value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized || values.includes(normalized)) return false;
  values.push(normalized);
  return true;
}

export async function linkContextKnowledgeEntries(
  repoPath: string,
  entryIds: string[],
  input: { runId?: string; taskId?: string; now?: () => string },
): Promise<ContextKnowledgeEntry[]> {
  const store = await readStore(repoPath);
  const linked: ContextKnowledgeEntry[] = [];
  let changed = false;
  for (const id of [...new Set(entryIds)]) {
    const entry = store.entries.find((candidate) => candidate.id === id);
    if (!entry) continue;
    const linkedRun = addUnique(entry.linkedRunIds, input.runId);
    const linkedTask = addUnique(entry.linkedTaskIds, input.taskId);
    const entryChanged = linkedRun || linkedTask;
    if (entryChanged) {
      entry.updatedAt = now(input);
      changed = true;
    }
    linked.push({ ...entry });
  }
  if (changed) {
    await writeStore(repoPath, store);
  }
  return linked;
}

function searchableText(entry: ContextKnowledgeEntry): string {
  return normalizeSearchText(
    [
      entry.category,
      entry.title,
      entry.body,
      ...entry.tags,
      ...entry.keywords,
    ].join(" "),
  );
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreEntry(entry: ContextKnowledgeEntry, query: string[]): number {
  const haystack = searchableText(entry);
  const queryText = normalizeSearchText(query.join(" "));
  if (!queryText) return 0;
  let score = 0;
  for (const keyword of entry.keywords) {
    const normalized = normalizeSearchText(keyword);
    if (normalized && queryText.includes(normalized)) {
      score += 4;
    }
  }
  for (const token of queryText.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export async function selectContextKnowledgeEntries(
  input: ContextKnowledgeSelectionInput,
): Promise<ContextKnowledgeEntry[]> {
  const store = await readStore(input.repoPath);
  return store.entries
    .filter((entry) => entry.status === "approved")
    .map((entry) => ({ entry, score: scoreEntry(entry, input.query) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
        left.entry.id.localeCompare(right.entry.id),
    )
    .slice(0, input.maxEntries ?? 5)
    .map((item) => ({ ...item.entry }));
}
