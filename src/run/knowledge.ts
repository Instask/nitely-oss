import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const KNOWLEDGE_DIRECTORY = ".nitely/knowledge";
const CACHE_METADATA_FILENAME = "agent-memory.json";
const CACHE_CONTENT_FILENAME = "agent-memory.md";
const MEMORY_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

const STRUCTURAL_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "next.config.js",
  "next.config.mjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "biome.json",
]);

const STRUCTURE_EXCLUDE = new Set([
  ".git",
  ".nitely",
  ".nightly",
  "node_modules",
  "dist",
  "coverage",
  ".worktrees",
]);

export interface AgentMemoryMetadata {
  fingerprint: string;
  generatedAt: string;
  runtime: string;
  model?: string;
  contentPath: string;
  generator: "deterministic-skeleton";
}

export interface PreparedAgentMemory {
  generated: boolean;
  metadata: AgentMemoryMetadata;
  contentPath: string;
  content: string;
}

export interface InjectedAgentMemoryFile {
  filename: (typeof MEMORY_FILENAMES)[number];
  path: string;
}

function repoRelativePath(repoPath: string, path: string): string {
  return relative(repoPath, path).split(sep).join("/");
}

function knowledgeDirectory(repoPath: string): string {
  return join(repoPath, KNOWLEDGE_DIRECTORY);
}

function metadataPath(repoPath: string): string {
  return join(knowledgeDirectory(repoPath), CACHE_METADATA_FILENAME);
}

function contentPath(repoPath: string): string {
  return join(knowledgeDirectory(repoPath), CACHE_CONTENT_FILENAME);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectShallowStructure(input: {
  repoPath: string;
  directory: string;
  depth: number;
  maxDepth: number;
  out: string[];
}): Promise<void> {
  let entries;
  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (input.depth === 0 && STRUCTURE_EXCLUDE.has(entry.name)) {
      continue;
    }
    const absolutePath = join(input.directory, entry.name);
    const relativePath = repoRelativePath(input.repoPath, absolutePath);
    input.out.push(`${entry.isDirectory() ? "dir" : "file"}:${relativePath}`);
    if (entry.isDirectory() && input.depth + 1 < input.maxDepth) {
      await collectShallowStructure({
        ...input,
        directory: absolutePath,
        depth: input.depth + 1,
      });
    }
  }
}

export async function computeStructuralFingerprint(
  repoPath: string,
): Promise<string> {
  const hash = createHash("sha256");
  const structure: string[] = [];
  await collectShallowStructure({
    repoPath,
    directory: repoPath,
    depth: 0,
    maxDepth: 2,
    out: structure,
  });
  for (const entry of structure) {
    hash.update(`structure\0${entry}\0`);
  }

  const topLevel = await readdir(repoPath, { withFileTypes: true });
  topLevel.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of topLevel) {
    if (!entry.isFile() || !STRUCTURAL_FILENAMES.has(entry.name)) {
      continue;
    }
    const path = join(repoPath, entry.name);
    const content = await readFile(path);
    hash.update(`file\0${entry.name}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readPackageJson(repoPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function recordField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markdownList(values: string[]): string {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- none detected";
}

export async function generateAgentMemorySkeleton(
  repoPath: string,
): Promise<string> {
  const packageJson = await readPackageJson(repoPath);
  const scripts = recordField(packageJson?.scripts);
  const dependencies = [
    ...Object.keys(recordField(packageJson?.dependencies)).map((name) => `${name} (dependency)`),
    ...Object.keys(recordField(packageJson?.devDependencies)).map((name) => `${name} (devDependency)`),
  ].sort();
  const commands = Object.entries(scripts)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => `- ${name}: \`${value}\``);
  const entries = (
    await readdir(repoPath, { withFileTypes: true })
  )
    .filter((entry) => !STRUCTURE_EXCLUDE.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`);
  const configs = (
    await Promise.all(
      [...STRUCTURAL_FILENAMES].map(async (name) => {
        const path = join(repoPath, name);
        try {
          const file = await stat(path);
          return file.isFile() ? name : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((name): name is string => Boolean(name))
    .sort();

  return [
    "# Repository Memory",
    "",
    `Repository: ${basename(repoPath)}`,
    "",
    "## Layout",
    "",
    markdownList(entries),
    "",
    "## Detected Dependencies",
    "",
    markdownList(dependencies),
    "",
    "## Commands",
    "",
    commands.length > 0 ? commands.join("\n") : "- none detected",
    "",
    "## Structural Config Files",
    "",
    markdownList(configs),
    "",
    "## Notes",
    "",
    "- This file is generated by Nitely from deterministic repository structure.",
    "- Treat repository source files as the source of truth when details conflict.",
    "",
  ].join("\n");
}

async function readCachedMetadata(
  repoPath: string,
): Promise<AgentMemoryMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(metadataPath(repoPath), "utf8")) as AgentMemoryMetadata;
    if (
      typeof value.fingerprint === "string" &&
      typeof value.generatedAt === "string" &&
      typeof value.runtime === "string" &&
      typeof value.contentPath === "string"
    ) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function prepareAgentMemory(input: {
  repoPath: string;
  runtime: string;
  model?: string;
  now?: () => string;
}): Promise<PreparedAgentMemory> {
  const fingerprint = await computeStructuralFingerprint(input.repoPath);
  const cacheContentPath = contentPath(input.repoPath);
  const cached = await readCachedMetadata(input.repoPath);
  if (
    cached?.fingerprint === fingerprint &&
    (await pathExists(cacheContentPath))
  ) {
    return {
      generated: false,
      metadata: cached,
      contentPath: cacheContentPath,
      content: await readFile(cacheContentPath, "utf8"),
    };
  }

  const content = await generateAgentMemorySkeleton(input.repoPath);
  await mkdir(knowledgeDirectory(input.repoPath), { recursive: true });
  await writeFile(cacheContentPath, content, "utf8");
  const metadata: AgentMemoryMetadata = {
    fingerprint,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    runtime: input.runtime,
    ...(input.model ? { model: input.model } : {}),
    contentPath: `${KNOWLEDGE_DIRECTORY}/${CACHE_CONTENT_FILENAME}`,
    generator: "deterministic-skeleton",
  };
  await writeFile(metadataPath(input.repoPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return {
    generated: true,
    metadata,
    contentPath: cacheContentPath,
    content,
  };
}

export async function injectAgentMemoryFiles(input: {
  worktreePath: string;
  content: string;
}): Promise<InjectedAgentMemoryFile[]> {
  const injected: InjectedAgentMemoryFile[] = [];
  try {
    for (const filename of MEMORY_FILENAMES) {
      const path = join(input.worktreePath, filename);
      if (await pathExists(path)) {
        continue;
      }
      await writeFile(path, input.content, { encoding: "utf8", flag: "wx" });
      injected.push({ filename, path });
    }
  } catch (error) {
    await removeInjectedAgentMemoryFiles(injected);
    throw error;
  }
  return injected;
}

export async function removeInjectedAgentMemoryFiles(
  files: InjectedAgentMemoryFile[],
): Promise<void> {
  for (const file of files) {
    try {
      await unlink(file.path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}
