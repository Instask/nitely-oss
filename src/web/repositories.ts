import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { WebInputError, WebNotFoundError } from "./errors.js";

export interface WebRepositoryInput {
  id?: string;
  name?: string;
  path: string;
  defaultBranch?: string;
  sourceUrl?: string;
}

export interface WebRepository {
  id: string;
  name: string;
  path: string;
  defaultBranch?: string;
  sourceUrl?: string;
}

export interface AddWebRepositoryInput {
  id?: string;
  name?: string;
  path?: string;
  githubUrl?: string;
  defaultBranch?: string;
}

export type CloneRepository = (input: {
  url: string;
  targetPath: string;
}) => Promise<void>;

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  cloneUrl: string;
}

const repoIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface WebRepositoriesFile {
  version: 1;
  repositories: WebRepositoryInput[];
}

function validateRepoId(id: string): void {
  if (!repoIdPattern.test(id)) {
    throw new WebInputError("invalid repository id");
  }
}

function displayNameForPath(path: string): string {
  return basename(path) || path;
}

function normalizeRepository(input: WebRepositoryInput): WebRepository {
  const id = input.id?.trim() || "default";
  validateRepoId(id);
  const path = resolve(input.path);
  const name = input.name?.trim() || displayNameForPath(path);
  return {
    id,
    name,
    path,
    ...(input.defaultBranch?.trim()
      ? { defaultBranch: input.defaultBranch.trim() }
      : {}),
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
  };
}

function repositoriesPath(homeRepoPath: string): string {
  return join(resolve(homeRepoPath), ".nitely", "repositories.json");
}

function parseRepositoriesFile(value: unknown): WebRepositoriesFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebInputError("invalid repositories file");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.repositories)) {
    throw new WebInputError("invalid repositories file");
  }
  return {
    version: 1,
    repositories: record.repositories.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new WebInputError("invalid repository entry");
      }
      const item = entry as Record<string, unknown>;
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        path: typeof item.path === "string" ? item.path : "",
        defaultBranch:
          typeof item.defaultBranch === "string" ? item.defaultBranch : undefined,
        sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : undefined,
      };
    }),
  };
}

async function readStoredRepositories(
  homeRepoPath: string,
): Promise<WebRepositoryInput[]> {
  try {
    return parseRepositoriesFile(
      JSON.parse(await readFile(repositoriesPath(homeRepoPath), "utf8")),
    ).repositories;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertRepositoryPath(path: string): Promise<void> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebInputError("repository path must exist");
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new WebInputError("repository path must be a directory");
  }
}

function sanitizeRepoId(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 64) || "repository";
}

function stripDotGit(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

export function parseGitHubRepositoryUrl(value: string): ParsedGitHubUrl {
  const raw = value.trim();
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = stripDotGit(sshMatch[2].split("/")[0]);
    if (!owner || !repo) {
      throw new WebInputError("invalid GitHub repository URL");
    }
    return {
      owner,
      repo,
      cloneUrl: `git@github.com:${owner}/${repo}.git`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebInputError("invalid GitHub repository URL");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new WebInputError("repository URL must be on github.com");
  }
  const [owner, repoSegment] = url.pathname.split("/").filter(Boolean);
  const repo = repoSegment ? stripDotGit(repoSegment) : "";
  if (!owner || !repo) {
    throw new WebInputError("invalid GitHub repository URL");
  }
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function checkoutPath(defaultRepoPath: string, id: string): string {
  return join(resolve(defaultRepoPath), ".nitely", "repositories", id);
}

async function defaultCloneRepository(input: {
  url: string;
  targetPath: string;
}): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      "git",
      ["clone", "--depth", "1", input.url, input.targetPath],
      { timeout: 120_000 },
      (error) => {
        if (error) {
          reject(new WebInputError("failed to clone repository"));
          return;
        }
        resolvePromise();
      },
    );
  });
}

export function resolveWebRepositories(
  defaultRepoPath: string,
  repositories: WebRepositoryInput[] = [],
): WebRepository[] {
  const byId = new Map<string, WebRepository>();
  byId.set("default", normalizeRepository({
    id: "default",
    path: defaultRepoPath,
  }));
  for (const repository of repositories) {
    const normalized = normalizeRepository(repository);
    if (normalized.id === "default") {
      throw new WebInputError("additional repository id cannot be default");
    }
    if (byId.has(normalized.id)) {
      throw new WebInputError(`duplicate repository id: ${normalized.id}`);
    }
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()];
}

export async function loadWebRepositories(
  defaultRepoPath: string,
  repositories: WebRepositoryInput[] = [],
): Promise<WebRepository[]> {
  return resolveWebRepositories(defaultRepoPath, [
    ...repositories,
    ...(await readStoredRepositories(defaultRepoPath)),
  ]);
}

export async function addStoredWebRepository(
  defaultRepoPath: string,
  runtimeRepositories: WebRepositoryInput[] = [],
  input: AddWebRepositoryInput,
  cloneRepository: CloneRepository = defaultCloneRepository,
): Promise<WebRepository> {
  const githubUrl = input.githubUrl?.trim();
  const parsedUrl = githubUrl ? parseGitHubRepositoryUrl(githubUrl) : undefined;
  const id = input.id?.trim() || (parsedUrl ? sanitizeRepoId(`${parsedUrl.owner}-${parsedUrl.repo}`) : "");
  if (!id) {
    throw new WebInputError("repository id is required");
  }
  const repositoryPath = input.path?.trim() || (parsedUrl ? checkoutPath(defaultRepoPath, id) : "");
  if (!repositoryPath) {
    throw new WebInputError("repository path is required");
  }
  const repository = normalizeRepository({
    id,
    name: input.name?.trim() || (parsedUrl ? `${parsedUrl.owner}/${parsedUrl.repo}` : undefined),
    path: repositoryPath,
    defaultBranch: input.defaultBranch,
    sourceUrl: parsedUrl?.cloneUrl,
  });
  if (repository.id === "default") {
    throw new WebInputError("additional repository id cannot be default");
  }
  const stored = await readStoredRepositories(defaultRepoPath);
  const existing = resolveWebRepositories(defaultRepoPath, [
    ...runtimeRepositories,
    ...stored,
  ]);
  if (existing.some((candidate) => candidate.id === repository.id)) {
    throw new WebInputError(`duplicate repository id: ${repository.id}`);
  }
  if (parsedUrl && !input.path?.trim()) {
    try {
      await mkdir(dirname(repository.path), { recursive: true });
      await cloneRepository({
        url: parsedUrl.cloneUrl,
        targetPath: repository.path,
      });
    } catch (error) {
      await rm(repository.path, { force: true, recursive: true }).catch(() => {});
      throw error;
    }
  }
  await assertRepositoryPath(repository.path);
  const nextStored: WebRepositoryInput[] = [
    ...stored,
    {
      id: repository.id,
      name: repository.name,
      path: repository.path,
      ...(repository.defaultBranch
        ? { defaultBranch: repository.defaultBranch }
        : {}),
      ...(repository.sourceUrl ? { sourceUrl: repository.sourceUrl } : {}),
    },
  ];
  await writeJsonAtomic(repositoriesPath(defaultRepoPath), {
    version: 1,
    repositories: nextStored,
  });
  return repository;
}

export function repositoryById(
  repositories: WebRepository[],
  id: string | undefined,
): WebRepository {
  const repository = repositories.find((candidate) => candidate.id === (id || "default"));
  if (!repository) {
    throw new WebNotFoundError("repository not found");
  }
  return repository;
}
