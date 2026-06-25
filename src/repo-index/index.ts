import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { evaluateLocalPath, loadContextPolicy } from "../context/policy.js";
import { EventStore } from "../events/store.js";
import { eventStorePath, projectRun } from "../run/project.js";

export const REPO_INDEX_VERSION = 1;
export const REPO_INDEX_RELATIVE_PATH = ".nitely/repo-index.json";
const MAX_INDEXED_FILE_BYTES = 512 * 1024;

export type RepoSymbolKind =
  | "class"
  | "function"
  | "interface"
  | "type"
  | "const"
  | "export";

export interface RepoIndexSymbol {
  name: string;
  kind: RepoSymbolKind;
  path: string;
  exported: boolean;
}

export interface RepoIndexHistoricalRun {
  runId: string;
  stageId?: string;
  artifactId?: string;
  changeRequestUrl?: string;
}

export interface RepoIndexFile {
  path: string;
  directory: string;
  size: number;
  mtimeMs: number;
  language?: string;
  imports: string[];
  importedBy: string[];
  symbols: RepoIndexSymbol[];
  historicalRuns: RepoIndexHistoricalRun[];
}

export interface RepoIndex {
  schemaVersion: 1;
  builtAt: string;
  repoRoot: string;
  directories: string[];
  files: RepoIndexFile[];
  symbols: RepoIndexSymbol[];
}

export type RepoIndexQueryReason =
  | "path"
  | "symbol"
  | "import"
  | "imported-by"
  | "history";

export interface RepoIndexQueryMatch {
  path: string;
  reasons: RepoIndexQueryReason[];
  symbols: RepoIndexSymbol[];
  imports: string[];
  importedBy: string[];
  historicalRuns: RepoIndexHistoricalRun[];
}

export interface RepoIndexStaleStatus {
  stale: boolean;
  reasons: string[];
}

export interface RepoIndexQueryResult {
  query: string;
  indexPath: string;
  stale: RepoIndexStaleStatus;
  matches: RepoIndexQueryMatch[];
}

export interface BuildRepoIndexResult {
  index: RepoIndex;
  indexPath: string;
}

const skippedDirectories = new Set([
  ".git",
  ".nitely",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

const skippedFiles = new Set([
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function repoRelative(repoPath: string, path: string): string {
  return relative(repoPath, path).replaceAll("\\", "/");
}

function normalizeRepoPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\/+/, "");
}

function languageForPath(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts") {
    return "typescript";
  }
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }
  if (extension === ".md") return "markdown";
  if (extension === ".json") return "json";
  if (extension === ".yml" || extension === ".yaml") return "yaml";
  if (extension === ".css") return "css";
  return undefined;
}

async function walkFiles(repoPath: string, directory = repoPath): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    if (entry.isFile() && skippedFiles.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(repoPath, path));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function symbolKey(symbol: Pick<RepoIndexSymbol, "path" | "name" | "kind">): string {
  return `${symbol.path}\0${symbol.name}\0${symbol.kind}`;
}

function importSpecifiers(content: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) imports.push(specifier);
    }
  }
  return uniqueSorted(imports);
}

function extractSymbols(path: string, content: string): RepoIndexSymbol[] {
  const symbols: RepoIndexSymbol[] = [];
  const seen = new Set<string>();
  const push = (symbol: RepoIndexSymbol) => {
    const key = symbolKey(symbol);
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push(symbol);
  };

  const declarationPattern =
    /(^|\n)\s*(export\s+)?(?:async\s+)?(class|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(declarationPattern)) {
    const rawKind = match[3];
    const name = match[4];
    if (!rawKind || !name) continue;
    const kind: RepoSymbolKind =
      rawKind === "let" || rawKind === "var" ? "const" : rawKind as RepoSymbolKind;
    push({
      path,
      name,
      kind,
      exported: Boolean(match[2]),
    });
  }

  const namedExportPattern = /\bexport\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(namedExportPattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter((entry): entry is string => Boolean(entry));
    for (const name of names) {
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        push({ path, name, kind: "export", exported: true });
      }
    }
  }

  return symbols.sort((left, right) => left.name.localeCompare(right.name));
}

function candidateImportPaths(sourcePath: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const sourceDirectory = dirname(sourcePath);
  const base = normalizeRepoPath(posix.join(sourceDirectory, specifier));
  const extension = posix.extname(base);
  const baseWithoutExtension = extension ? base.slice(0, -extension.length) : base;
  const candidates = [
    base,
    baseWithoutExtension,
    `${baseWithoutExtension}.ts`,
    `${baseWithoutExtension}.tsx`,
    `${baseWithoutExtension}.mts`,
    `${baseWithoutExtension}.cts`,
    `${baseWithoutExtension}.js`,
    `${baseWithoutExtension}.jsx`,
    `${baseWithoutExtension}.mjs`,
    `${baseWithoutExtension}.cjs`,
    `${baseWithoutExtension}.json`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.tsx"),
    posix.join(base, "index.js"),
    posix.join(base, "index.jsx"),
  ];
  return uniqueSorted(candidates);
}

function resolveImports(
  path: string,
  specifiers: string[],
  availableFiles: ReadonlySet<string>,
): string[] {
  const imports: string[] = [];
  for (const specifier of specifiers) {
    const match = candidateImportPaths(path, specifier).find((candidate) =>
      availableFiles.has(candidate),
    );
    if (match) imports.push(match);
  }
  return uniqueSorted(imports);
}

async function historicalRunLinks(repoPath: string): Promise<Map<string, RepoIndexHistoricalRun[]>> {
  const links = new Map<string, RepoIndexHistoricalRun[]>();
  try {
    await stat(eventStorePath(repoPath));
  } catch {
    return links;
  }

  const store = new EventStore(eventStorePath(repoPath));
  try {
    for (const runId of store.listRunIds().slice(0, 50)) {
      const projection = projectRun(store.list(runId));
      const changeRequestUrl =
        typeof projection.changeRequestUrl === "string"
          ? projection.changeRequestUrl
          : undefined;
      for (const artifact of projection.artifacts) {
        if (!artifact.path) continue;
        const match = artifact.path.match(/^stages\/[^/]+\/[^/]+\/(.+)$/);
        const candidate = normalizeRepoPath(match?.[1] ?? artifact.path);
        if (!candidate || candidate.startsWith(".nitely/")) continue;
        const entry: RepoIndexHistoricalRun = {
          runId,
          ...(artifact.stageId ? { stageId: artifact.stageId } : {}),
          artifactId: artifact.id,
          ...(changeRequestUrl ? { changeRequestUrl } : {}),
        };
        const existing = links.get(candidate) ?? [];
        existing.push(entry);
        links.set(candidate, existing);
      }
    }
  } finally {
    store.close();
  }
  return links;
}

export async function buildRepoIndex(repoPath: string): Promise<BuildRepoIndexResult> {
  const root = resolve(repoPath);
  const policy = await loadContextPolicy(root);
  const paths = await walkFiles(root);
  const fileStats = await Promise.all(
    paths.map(async (path) => ({ path, stats: await stat(path) })),
  );
  const allowed = fileStats
    .map(({ path, stats }) => ({ path, stats, relativePath: repoRelative(root, path) }))
    .filter(({ relativePath }) => {
      if (relativePath === REPO_INDEX_RELATIVE_PATH) return false;
      const decision = evaluateLocalPath(policy, relativePath);
      return decision.decision === "allowed";
    })
    .filter(({ relativePath }) => textExtensions.has(extname(relativePath).toLowerCase()))
    .filter(({ stats }) => stats.size <= MAX_INDEXED_FILE_BYTES)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const availableFiles = new Set(allowed.map((entry) => entry.relativePath));
  const historicalLinks = await historicalRunLinks(root);
  const files: RepoIndexFile[] = [];
  const directories = new Set<string>();

  for (const entry of allowed) {
    const content = await readFile(entry.path, "utf8");
    const specifiers = sourceExtensions.has(extname(entry.relativePath).toLowerCase())
      ? importSpecifiers(content)
      : [];
    const imports = resolveImports(entry.relativePath, specifiers, availableFiles);
    const directory = dirname(entry.relativePath).replaceAll("\\", "/");
    if (directory && directory !== ".") directories.add(directory);
    files.push({
      path: entry.relativePath,
      directory: directory === "." ? "" : directory,
      size: entry.stats.size,
      mtimeMs: entry.stats.mtimeMs,
      ...(languageForPath(entry.relativePath)
        ? { language: languageForPath(entry.relativePath) }
        : {}),
      imports,
      importedBy: [],
      symbols: sourceExtensions.has(extname(entry.relativePath).toLowerCase())
        ? extractSymbols(entry.relativePath, content)
        : [],
      historicalRuns: historicalLinks.get(entry.relativePath) ?? [],
    });
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    for (const imported of file.imports) {
      const target = byPath.get(imported);
      if (target) {
        target.importedBy = uniqueSorted([...target.importedBy, file.path]);
      }
    }
  }

  const symbols = files
    .flatMap((file) => file.symbols)
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  const index: RepoIndex = {
    schemaVersion: REPO_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    repoRoot: root,
    directories: uniqueSorted(directories),
    files,
    symbols,
  };
  const indexPath = join(root, REPO_INDEX_RELATIVE_PATH);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { index, indexPath };
}

export async function readRepoIndex(repoPath: string): Promise<RepoIndex> {
  const root = resolve(repoPath);
  const index = JSON.parse(
    await readFile(join(root, REPO_INDEX_RELATIVE_PATH), "utf8"),
  ) as RepoIndex;
  if (index.schemaVersion !== REPO_INDEX_VERSION) {
    throw new Error(`unsupported repo index version: ${String(index.schemaVersion)}`);
  }
  return index;
}

export async function staleStatus(
  repoPath: string,
  index: RepoIndex,
): Promise<RepoIndexStaleStatus> {
  const root = resolve(repoPath);
  const reasons: string[] = [];
  for (const file of index.files) {
    const absolutePath = join(root, file.path);
    try {
      const current = await stat(absolutePath);
      if (current.mtimeMs > file.mtimeMs + 1) {
        reasons.push(`${file.path} modified since index build`);
      }
    } catch {
      reasons.push(`${file.path} missing since index build`);
    }
    if (reasons.length >= 10) break;
  }
  return { stale: reasons.length > 0, reasons };
}

function isPathLikeQuery(query: string): boolean {
  return query.includes("/") || query.includes("\\") || query.includes(".");
}

function addReason(
  reasons: Map<string, Set<RepoIndexQueryReason>>,
  path: string,
  reason: RepoIndexQueryReason,
): void {
  const existing = reasons.get(path) ?? new Set<RepoIndexQueryReason>();
  existing.add(reason);
  reasons.set(path, existing);
}

export async function queryRepoIndex(input: {
  repoPath: string;
  query: string;
  limit?: number;
}): Promise<RepoIndexQueryResult> {
  const root = resolve(input.repoPath);
  const index = await readRepoIndex(root);
  const normalizedQuery = normalizeRepoPath(input.query.trim());
  if (!normalizedQuery) {
    return {
      query: "",
      indexPath: join(root, REPO_INDEX_RELATIVE_PATH),
      stale: await staleStatus(root, index),
      matches: [],
    };
  }
  const loweredQuery = normalizedQuery.toLowerCase();
  const byPath = new Map(index.files.map((file) => [file.path, file]));
  const reasons = new Map<string, Set<RepoIndexQueryReason>>();

  if (isPathLikeQuery(normalizedQuery)) {
    for (const file of index.files) {
      const loweredPath = file.path.toLowerCase();
      if (loweredPath === loweredQuery || loweredPath.includes(loweredQuery)) {
        addReason(reasons, file.path, "path");
        for (const imported of file.imports) addReason(reasons, imported, "import");
        for (const importedBy of file.importedBy) addReason(reasons, importedBy, "imported-by");
      }
    }
  }

  for (const symbol of index.symbols) {
    if (symbol.name.toLowerCase().includes(loweredQuery)) {
      addReason(reasons, symbol.path, "symbol");
      const file = byPath.get(symbol.path);
      for (const imported of file?.imports ?? []) addReason(reasons, imported, "import");
      for (const importedBy of file?.importedBy ?? []) addReason(reasons, importedBy, "imported-by");
    }
  }

  for (const file of index.files) {
    if (file.historicalRuns.some((run) => run.runId.includes(normalizedQuery))) {
      addReason(reasons, file.path, "history");
    }
  }

  const matches = [...reasons.entries()]
    .map(([path, pathReasons]) => {
      const file = byPath.get(path);
      if (!file) return undefined;
      return {
        path,
        reasons: [...pathReasons].sort(),
        symbols: file.symbols,
        imports: file.imports,
        importedBy: file.importedBy,
        historicalRuns: file.historicalRuns,
      } satisfies RepoIndexQueryMatch;
    })
    .filter((match): match is RepoIndexQueryMatch => match !== undefined)
    .sort(
      (left, right) =>
        scoreMatch(right) - scoreMatch(left) || left.path.localeCompare(right.path),
    )
    .slice(0, input.limit ?? 10);

  return {
    query: normalizedQuery,
    indexPath: join(root, REPO_INDEX_RELATIVE_PATH),
    stale: await staleStatus(root, index),
    matches,
  };
}

function scoreMatch(match: RepoIndexQueryMatch): number {
  const weights: Record<RepoIndexQueryReason, number> = {
    path: 100,
    symbol: 90,
    "imported-by": 40,
    import: 35,
    history: 20,
  };
  return match.reasons.reduce((score, reason) => score + weights[reason], 0);
}

export function recordRepoIndexQuery(input: {
  repoPath: string;
  runId: string;
  stageId: string;
  attempt: number;
  result: RepoIndexQueryResult;
}): void {
  const store = new EventStore(eventStorePath(resolve(input.repoPath)));
  try {
    store.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "repo.index.queried",
      payload: {
        query: input.result.query,
        indexPath: input.result.indexPath,
        stale: input.result.stale,
        matchCount: input.result.matches.length,
        matches: input.result.matches.map((match) => ({
          path: match.path,
          reasons: match.reasons,
        })),
      },
    });
  } finally {
    store.close();
  }
}

export function resolveRepoIndexPath(repoPath: string): string {
  const root = isAbsolute(repoPath) ? repoPath : resolve(repoPath);
  return join(root, REPO_INDEX_RELATIVE_PATH);
}
